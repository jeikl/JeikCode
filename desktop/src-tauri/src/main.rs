// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 薄桌面壳：拉起同一个 `jeikcode webui`，窗口只打开它。
//! 不另写 Agent。CLI 从安装包资源拷到 `~/.local/bin`，TUI 和 WebUI 用这一份。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

fn is_local_app_url(url: &tauri::Url) -> bool {
    let scheme = url.scheme();
    if scheme == "tauri" || scheme == "about" || scheme == "data" {
        return true;
    }
    if scheme == "http" {
        if let Some(host) = url.host_str() {
            if host == "127.0.0.1" || host == "localhost" {
                return true;
            }
        }
    }
    false
}

fn open_in_external_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: *mut std::ffi::c_void,
                lpOperation: *const u16,
                lpFile: *const u16,
                lpParameters: *const u16,
                lpDirectory: *const u16,
                nShowCmd: i32,
            ) -> isize;
        }

        fn wide(s: &str) -> Vec<u16> {
            OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }

        let verb = wide("open");
        let file = wide(url);
        // SW_SHOWNORMAL = 1
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if rc > 32 {
            return;
        }
        // Fallback
        let _ = Command::new("explorer").arg(url).spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = url;
    }
}

fn main() {
    let child = Mutex::new(None);
    tauri::Builder::default()
        .manage(ChildSlot(child))
        .setup(|app| {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("JeikCode Desktop")
            .inner_size(1280.0, 800.0)
            .resizable(true)
            .on_navigation(|url| {
                if is_local_app_url(url) {
                    return true;
                }
                open_in_external_browser(url.as_str());
                false
            })
            .on_new_window(|url, _features| {
                if !is_local_app_url(&url) {
                    open_in_external_browser(url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .build()?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match start_webui(&handle) {
                    Ok((url, child)) => {
                        if let Some(slot) = handle.try_state::<ChildSlot>() {
                            *slot.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
                        }
                        let _ = window.navigate(url.parse().unwrap_or_else(|_| {
                            "about:blank".parse().expect("about:blank")
                        }));
                        let _ = window.eval(&format!(
                            "location.replace({})",
                            serde_json::to_string(&url).unwrap_or_else(|_| "\"about:blank\"".into())
                        ));
                    }
                    Err(err) => {
                        let text = serde_json::to_string(&err).unwrap_or_else(|_| "\"启动失败\"".into());
                        let _ = window.eval(&format!(
                            "document.getElementById('status').textContent = {text}"
                        ));
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 JeikCode Desktop 失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(slot) = app.try_state::<ChildSlot>() {
                    if let Some(child) = slot.0.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

struct ChildSlot(Mutex<Option<std::process::Child>>);

fn start_webui(app: &tauri::AppHandle) -> Result<(String, std::process::Child), String> {
    let bundled = bundled_cli(app);
    let bin = publish_cli(bundled.as_deref()).map_err(|e| format!("安装命令行失败：{e}"))?;
    let home = home_dir();
    let mut cmd = Command::new(&bin);
    cmd.arg("webui")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("13457")
        .arg("--no-open")
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    suppress_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 {}：{e}", bin.display()))?;
    let stderr = child.stderr.take();
    let url = stderr
        .map(|pipe| read_url(pipe))
        .transpose()?
        .flatten()
        .ok_or_else(|| "jeikcode webui 没有打印出地址".to_string())?;
    Ok((url, child))
}

fn bundled_cli(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let path = dir.join("cli-bin");
    path.is_file().then_some(path)
}

fn read_url(pipe: impl std::io::Read + Send + 'static) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);
        let mut pending = String::new();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            pending.push_str(&line);
            pending.push('\n');
            if let Some(url) = extract_webui_url(&pending) {
                let _ = tx.send(url);
                break;
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(90)) {
        Ok(url) => Ok(Some(url)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err("等待 WebUI 启动超时".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(None),
    }
}

pub fn extract_webui_url(text: &str) -> Option<String> {
    let start = text.find("http://").or_else(|| text.find("https://"))?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(|c: char| matches!(c, ')' | '。' | '，' | '"' | '\''));
    url.contains("token=").then(|| url.to_string())
}

fn publish_cli(bundled: Option<&Path>) -> std::io::Result<PathBuf> {
    let dest_dir = cli_dest_dir();
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(cli_file_name());
    if let Some(src) = bundled.filter(|p| looks_like_binary(p)) {
        let same = dest.is_file()
            && std::fs::metadata(src).ok().map(|m| m.len())
                == std::fs::metadata(&dest).ok().map(|m| m.len());
        if !same {
            let _ = std::fs::copy(src, &dest);
        }
        set_executable(&dest);
        ensure_on_path(&dest_dir);
        if dest.is_file() {
            return Ok(dest);
        }
    }
    if dest.is_file() {
        return Ok(dest);
    }
    Ok(PathBuf::from(cli_file_name()))
}

fn cli_dest_dir() -> PathBuf {
    home_dir().join(".local").join("bin")
}

fn cli_file_name() -> &'static str {
    if cfg!(windows) { "jeikcode.exe" } else { "jeikcode" }
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn looks_like_binary(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(n) = file.read(&mut magic) else {
        return false;
    };
    n >= 2
        && (magic.starts_with(b"MZ")
            || magic.starts_with(b"\x7fELF")
            || magic.starts_with(&[0xfe, 0xed, 0xfa])
            || magic.starts_with(b"#!")
            || magic.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
            || magic.starts_with(&[0xca, 0xfe, 0xba, 0xbe]))
}

fn set_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    let _ = path;
}

fn ensure_on_path(dir: &Path) {
    #[cfg(windows)]
    ensure_windows_path(dir);
    #[cfg(not(windows))]
    ensure_shell_path(dir);
}

#[cfg(windows)]
fn ensure_windows_path(dir: &Path) {
    use winreg::enums::*;
    use winreg::RegKey;
    let Ok(env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE) else {
        return;
    };
    let current: String = env.get_value("Path").unwrap_or_default();
    let dir_text = dir.display().to_string();
    let already = current.split(';').any(|p| p.trim().eq_ignore_ascii_case(&dir_text));
    if already {
        return;
    }
    let next = if current.trim().is_empty() {
        dir_text
    } else {
        format!("{dir_text};{current}")
    };
    let _ = env.set_value("Path", &next);
}

#[cfg(not(windows))]
fn ensure_shell_path(dir: &Path) {
    let line = format!("export PATH=\"{}:$PATH\"", dir.display());
    for name in [".zshrc", ".bashrc"] {
        let path = home_dir().join(name);
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        if existing.lines().any(|l| l.trim() == line) {
            continue;
        }
        let mut next = existing;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str("\n# Added by JeikCode Desktop\n");
        next.push_str(&line);
        next.push('\n');
        let _ = std::fs::write(path, next);
    }
}

#[cfg(windows)]
fn suppress_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console(_cmd: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::extract_webui_url;

    #[test]
    fn reads_token_url_from_webui_line() {
        let line = "webui 已启动：http://127.0.0.1:13457/?token=abc&sync=0\n";
        assert_eq!(
            extract_webui_url(line).as_deref(),
            Some("http://127.0.0.1:13457/?token=abc&sync=0")
        );
    }

    #[test]
    fn ignores_text_without_token() {
        assert!(extract_webui_url("listen http://127.0.0.1:13457/").is_none());
    }
}
