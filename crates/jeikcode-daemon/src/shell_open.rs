//! 系统文件管理器 / 默认应用的外壳调用。
//!
//! 统一走进程内 Shell API（Windows）或系统命令（macOS/Linux），不再让 daemon
//! 直接 `CreateProcess("explorer.exe /select,...")` / `cmd /c start`。这样既不会
//! 产生杀软重点监控的“未知进程拉起 explorer.exe/cmd.exe”父子链，也能保持与
//! VS Code / Electron 相同的系统集成方式。
//!
//! 所有实际操作都在一次性后台线程中执行：HTTP 接口只做路径校验并立即返回，
//! 外壳调用本身失败时仅写日志，由前端静默忽略。

use std::io;
use std::path::Path;

/// 外壳调用无法派发（线程创建失败 / 平台不支持）。
pub const SHELL_OPEN_FAILED: &str = "shell_open_failed";
/// 请求路径不存在。
pub const PATH_NOT_FOUND: &str = "path_not_found";

/// 在系统文件管理器中定位文件/目录。
pub fn reveal(path: &Path) -> io::Result<()> {
    spawn("jeikcode-reveal", path, imp::reveal)
}

/// 用系统默认关联应用打开文件/目录。
pub fn open(path: &Path) -> io::Result<()> {
    spawn("jeikcode-open", path, imp::open)
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn spawn(name: &str, path: &Path, action: fn(&Path)) -> io::Result<()> {
    let path = path.to_path_buf();
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || action(&path))
        .map(|_| ())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn spawn(_name: &str, _path: &Path, _action: fn(&Path)) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "shell open is not supported on this platform",
    ))
}

#[cfg(target_os = "windows")]
mod imp {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        IShellFolder, SHGetDesktopFolder, SHOpenFolderAndSelectItems, ShellExecuteW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// 一次性线程保证 COM 处于 STA；线程复用的 Tokio blocking 池做不到这一点。
    struct ComApartment;

    impl ComApartment {
        fn init() -> Option<Self> {
            // S_FALSE（已初始化）也视为成功；RPC_E_CHANGED_MODE 则由调用方放弃。
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok()? };
            Some(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub(super) fn reveal(path: &Path) {
        if !path.exists() {
            return;
        }
        let Some(_com) = ComApartment::init() else {
            tracing::warn!(
                path = %path.display(),
                "shell_open: COM STA init failed for reveal"
            );
            return;
        };
        unsafe {
            let desktop = match SHGetDesktopFolder() {
                Ok(desktop) => desktop,
                Err(err) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %err,
                        "shell_open: SHGetDesktopFolder failed"
                    );
                    return;
                }
            };

            let dir = if path.is_dir() {
                path
            } else {
                path.parent().unwrap_or(path)
            };
            let Some(dir_pidl) = parse_display_name(&desktop, dir) else {
                tracing::warn!(
                    path = %dir.display(),
                    "shell_open: ParseDisplayName failed for parent directory"
                );
                return;
            };

            if path.is_dir() {
                // cidl = 0 时直接打开 pidlFolder 指向的目录。
                let result = SHOpenFolderAndSelectItems(dir_pidl, None, 0);
                free_pidl(dir_pidl);
                if let Err(err) = result {
                    tracing::warn!(
                        path = %path.display(),
                        error = %err,
                        "shell_open: SHOpenFolderAndSelectItems failed for directory"
                    );
                }
                return;
            }

            let Some(file_pidl) = parse_display_name(&desktop, path) else {
                free_pidl(dir_pidl);
                tracing::warn!(
                    path = %path.display(),
                    "shell_open: ParseDisplayName failed for file"
                );
                return;
            };

            let items = [file_pidl as *const ITEMIDLIST];
            let result = SHOpenFolderAndSelectItems(dir_pidl, Some(items.as_slice()), 0);
            free_pidl(file_pidl);
            free_pidl(dir_pidl);

            if let Err(err) = result {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "shell_open: SHOpenFolderAndSelectItems failed; opening parent folder"
                );
                // 与 Electron 一致：定位失败时退化为打开父目录（不选中文件）。
                open_path(dir);
            }
        }
    }

    pub(super) fn open(path: &Path) {
        let Some(_com) = ComApartment::init() else {
            tracing::warn!(
                path = %path.display(),
                "shell_open: COM STA init failed for open"
            );
            return;
        };
        open_path(path);
    }

    fn open_path(path: &Path) {
        let file = wide_path(path);
        let dir = path.parent().map(wide_path);
        let dir_ptr = dir
            .as_deref()
            .map_or(PCWSTR::null(), |dir| PCWSTR(dir.as_ptr()));

        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                PCWSTR(file.as_ptr()),
                PCWSTR::null(),
                dir_ptr,
                SW_SHOWNORMAL,
            )
        };
        // ShellExecuteW 返回值 <= 32 表示失败。
        if result.0 <= 32 {
            tracing::warn!(
                path = %path.display(),
                code = result.0,
                "shell_open: ShellExecuteW failed"
            );
        }
    }

    unsafe fn parse_display_name(desktop: &IShellFolder, path: &Path) -> Option<*mut ITEMIDLIST> {
        let wide = wide_path(path);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        let result = desktop.ParseDisplayName(
            HWND::default(),
            None::<&IBindCtx>,
            PCWSTR(wide.as_ptr()),
            None,
            &mut pidl,
            std::ptr::null_mut(),
        );
        (result.is_ok() && !pidl.is_null()).then_some(pidl)
    }

    unsafe fn free_pidl(pidl: *mut ITEMIDLIST) {
        CoTaskMemFree(Some(pidl as *const c_void));
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub(super) fn reveal(path: &Path) {
        let mut cmd = Command::new("open");
        // -R 让 Finder 定位并选中文件；目录直接打开即可。
        if path.is_file() {
            cmd.arg("-R");
        }
        cmd.arg(path);
        if let Err(err) = cmd.spawn() {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "shell_open: failed to spawn open"
            );
        }
    }

    pub(super) fn open(path: &Path) {
        if let Err(err) = Command::new("open").arg(path).spawn() {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "shell_open: failed to spawn open"
            );
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    fn has_desktop() -> bool {
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    pub(super) fn reveal(path: &Path) {
        if !has_desktop() {
            return;
        }
        let target = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        if let Err(err) = Command::new("xdg-open").arg(target).spawn() {
            tracing::warn!(
                path = %target.display(),
                error = %err,
                "shell_open: failed to spawn xdg-open"
            );
        }
    }

    pub(super) fn open(path: &Path) {
        if !has_desktop() {
            return;
        }
        if let Err(err) = Command::new("xdg-open").arg(path).spawn() {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "shell_open: failed to spawn xdg-open"
            );
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod imp {
    use std::path::Path;

    pub(super) fn reveal(_path: &Path) {}

    pub(super) fn open(_path: &Path) {}
}
