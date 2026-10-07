//! Platform-specific process utilities (console-window suppression, shell-command
//! construction, UTF-8 locale, admin check). Consumed here plus by the CLI/TUI drivers.
//!
//! On Windows, a GUI / **console-less** parent (the jeikcode-daemon behind
//! clawbot/OpenClaw) that spawns a console program (cmd.exe, git, ast-grep, a
//! language server, …) makes Windows allocate a *fresh* console window for the
//! child — it flashes on the desktop every turn. A TUI parent does NOT show
//! this because the child inherits the TUI's existing console. `CREATE_NO_WINDOW`
//! tells Windows not to allocate one at all, fixing the daemon case without
//! affecting the TUI.
//!
//! NOTE: `creation_flags` is set-only — std cannot read it back — so this flag
//! is not unit-testable off Windows; coverage here is structural (the spawn path
//! routes through this helper) and the behavior must be verified on a Windows build.

/// Apply `CREATE_NO_WINDOW` to a `tokio::process::Command` on Windows; no-op
/// elsewhere. `tokio`'s `creation_flags` is an inherent method on Windows, so
/// (unlike the `_sync` std variant) no `CommandExt` import is needed.
#[cfg(target_os = "windows")]
pub fn suppress_console_window(cmd: &mut tokio::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Unix `setsid` + `TIOCNOTTY` equivalent: the child must not inherit or allocate
/// an interactive console window. On Windows 11, `CREATE_NEW_CONSOLE` forces
/// the OS console host (Windows Terminal / conhost) to spawn a visible console window,
/// flashing black CMD boxes every turn.
///
/// Using `CREATE_NO_WINDOW` ensures no console window is created, while standard
/// handles are safely redirected through piped/null stdio.
#[cfg(target_os = "windows")]
pub fn detach_from_console(cmd: &mut tokio::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub fn detach_from_console(_cmd: &mut tokio::process::Command) {}

#[cfg(not(target_os = "windows"))]
pub fn suppress_console_window(_cmd: &mut tokio::process::Command) {}

/// Apply `CREATE_NO_WINDOW` to a `std::process::Command` on Windows; no-op
/// elsewhere. The std `creation_flags` requires `CommandExt` in scope.
#[cfg(target_os = "windows")]
pub fn suppress_console_window_sync(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub fn suppress_console_window_sync(_cmd: &mut std::process::Command) {}

/// RAII owner of a Windows Job Object configured with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every process assigned to the job —
/// and every process THOSE spawn — dies when either [`JobHandle::terminate`]
/// runs or the last handle to the job closes (this guard dropping, INCLUDING
/// when the jeikcode process itself is killed and the OS closes its handles).
///
/// Why: on Windows the Bash tool's only cleanup is `kill_on_drop`, which
/// terminates the direct child (`cmd.exe` / Git Bash) but NOT its descendants.
/// A timed-out `mvn compile` orphans the `java` compiler JVM (and pipeline
/// sub-shells / busybox applets); the JVM keeps burning CPU and holds `target/`
/// locks, so the next compile is slower and also times out → a runaway that
/// pins the machine. The job makes the whole tree reapable in one call and,
/// via kill-on-close, guarantees nothing survives jeikcode itself.
#[cfg(target_os = "windows")]
pub struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

// The HANDLE is an opaque kernel handle; safe to move/share across the threads
// of tokio's multithreaded runtime.
#[cfg(target_os = "windows")]
unsafe impl Send for JobHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for JobHandle {}

#[cfg(target_os = "windows")]
impl JobHandle {
    /// Terminate every process in the job (children and grandchildren).
    /// Idempotent — a job whose processes already exited terminates to a no-op.
    pub fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if !self.0.is_null() {
            // Exit code 1: the tree was force-killed, not a clean exit.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        if !self.0.is_null() {
            // KILL_ON_JOB_CLOSE: closing the last handle terminates whatever is
            // still in the job — reaping the tree on cancel (the wait future is
            // dropped) or on an jeikcode crash/kill.
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Assign `child` (and everything it later spawns) to a fresh kill-on-close Job
/// Object; return the guard to hold for the child's lifetime. `None` if any
/// Win32 call fails — the caller then relies on the pre-existing direct-child
/// `kill_on_drop`, which is no worse than before.
///
/// Tiny race: a grandchild spawned in the microseconds between `CreateProcess`
/// (inside `spawn`) and `AssignProcessToJobObject` here escapes the job. In
/// practice the shell takes milliseconds to initialise before it spawns
/// `mvn`/pipeline children, so assigning immediately after spawn captures them.
/// Fully closing the window would need `CREATE_SUSPENDED` + `ResumeThread`,
/// which tokio's `Child` doesn't expose.
#[cfg(target_os = "windows")]
pub fn assign_child_to_kill_on_close_job(child: &tokio::process::Child) -> Option<JobHandle> {
    assign_child_to_job(child, true)
}

/// Assign `child` to a Job Object so [`JobHandle::terminate`] can reap the tree.
/// MCP stdio always uses `kill_on_close` so the tree dies with JeikCode.
#[cfg(target_os = "windows")]
pub fn assign_child_to_job(
    child: &tokio::process::Child,
    kill_on_close: bool,
) -> Option<JobHandle> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let proc_handle = child.raw_handle()? as HANDLE;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        if kill_on_close {
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set_ok == 0 || AssignProcessToJobObject(job, proc_handle) == 0 {
            CloseHandle(job);
            return None;
        }
        Some(JobHandle(job))
    }
}

/// Sum of user+kernel time in 100ns units for every process in the job, or
/// `None` if the query fails (caller treats that as unknown busy).
#[cfg(target_os = "windows")]
impl JobHandle {
    pub fn cpu_100ns(&self) -> Option<u64> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let mut ret = 0u32;
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                &mut ret,
            )
        };
        if ok == 0 {
            return None;
        }
        Some((info.TotalUserTime as u64).saturating_add(info.TotalKernelTime as u64))
    }

    /// `(cpu_100ns, read+write transfer bytes)` for the whole job.
    pub fn cpu_and_io(&self) -> Option<(u64, u64)> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAndIoAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION,
        };
        let mut info: JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let mut ret = 0u32;
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAndIoAccountingInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION>() as u32,
                &mut ret,
            )
        };
        if ok == 0 {
            return self.cpu_100ns().map(|c| (c, 0));
        }
        let cpu = (info.BasicInfo.TotalUserTime as u64)
            .saturating_add(info.BasicInfo.TotalKernelTime as u64);
        let io = info
            .IoInfo
            .ReadTransferCount
            .saturating_add(info.IoInfo.WriteTransferCount)
            .saturating_add(info.IoInfo.OtherTransferCount);
        Some((cpu, io))
    }
}

/// Best-effort fallback tree-kill for the rare case the Job Object couldn't be
/// created/assigned (so [`assign_child_to_kill_on_close_job`] returned `None`).
/// `taskkill /T` walks the live parent→child tree and force-kills all of it —
/// a defense-in-depth net so a job-setup failure still doesn't orphan a runaway
/// `mvn`/`java`. Fire-and-forget: spawned console-suppressed and not awaited (on
/// Windows a dropped `Child` handle leaves no zombie).
#[cfg(target_os = "windows")]
pub fn taskkill_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    suppress_console_window_sync(&mut cmd);
    let _ = cmd.spawn();
}

/// Force-kill a shell's whole descendant tree on Windows: terminate the Job
/// Object if it was set up, else fall back to `taskkill /T` rooted at `pid`
/// (the direct child). The single entry point every Bash spawn path calls, so
/// their Windows cleanup can't drift apart. `pid` is `None` only if the child
/// was already reaped (nothing to kill).
#[cfg(target_os = "windows")]
pub fn kill_windows_tree(job: &Option<JobHandle>, pid: Option<u32>) {
    match job {
        Some(job) => job.terminate(),
        None => {
            if let Some(pid) = pid {
                taskkill_tree(pid);
            }
        }
    }
}

/// Build a shell command that runs `command` through the platform shell.
///
/// - Windows: `cmd.exe /C <command>` — the command string is passed via
///   `raw_arg` so cmd.exe receives it **verbatim**. Using the normal `.arg()`
///   would apply std's `CommandLineToArgvW` quoting, which cmd.exe does NOT
///   follow — embedded quotes / `%VAR%` / `^` etc. would be mangled. This
///   mirrors the spawn in `tool/bash.rs` (and `auth/oauth.rs`).
/// - Other: `sh -c <command>`.
///
/// Caller still chains env/stdio/`kill_on_drop` and `suppress_console_window`
/// as needed; this only fixes the program + command-string wiring.
#[cfg(target_os = "windows")]
pub fn shell_command(command: &str) -> tokio::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = tokio::process::Command::new("cmd.exe");
    cmd.arg("/C");
    cmd.as_std_mut().raw_arg(command);
    cmd
}

/// See the Windows variant above.
#[cfg(not(target_os = "windows"))]
pub fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command);
    #[cfg(unix)]
    apply_utf8_locale_env(&mut cmd);
    cmd
}

/// Detect whether the current process is running with administrator/root
/// privileges.
///
/// - Windows: calls `CheckTokenMembership(NULL, BUILTIN\Administrators)`
///   which correctly handles UAC split-token (returns `false` when NOT
///   elevated). This is the recommended replacement for the deprecated
///   `IsUserAnAdmin()`.
/// - Unix: checks `geteuid() == 0` (root).
/// - Other platforms: returns `false` (safe default — a missed warning is
///   preferable to a false alarm).
#[cfg(target_os = "windows")]
pub fn is_running_as_admin() -> bool {
    use windows_sys::Win32::Security::{
        AllocateAndInitializeSid, CheckTokenMembership, FreeSid, PSID, SECURITY_NT_AUTHORITY,
        SID_IDENTIFIER_AUTHORITY,
    };

    unsafe {
        let mut sid: PSID = std::ptr::null_mut();
        let authority: SID_IDENTIFIER_AUTHORITY = SECURITY_NT_AUTHORITY;

        // S-1-5-32-544: BUILTIN\Administrators group.
        // Uses literal RIDs 32 (SECURITY_BUILTIN_DOMAIN_RID) and 544
        // (DOMAIN_ALIAS_RID_ADMINS) to avoid pulling in the
        // Win32_System_SystemServices feature flag.
        let result = AllocateAndInitializeSid(
            &authority, 2,   // nSubAuthorityCount
            32,  // SECURITY_BUILTIN_DOMAIN_RID
            544, // DOMAIN_ALIAS_RID_ADMINS
            0, 0, 0, 0, 0, 0, &mut sid,
        );

        if result == 0 {
            return false;
        }

        let mut is_member: i32 = 0;
        // NULL token handle = current thread's effective token
        if CheckTokenMembership(std::ptr::null_mut(), sid, &mut is_member) == 0 {
            FreeSid(sid);
            return false;
        }

        FreeSid(sid);

        is_member != 0
    }
}

#[cfg(unix)]
pub fn is_running_as_admin() -> bool {
    unsafe { libc::geteuid() == 0 }
}

#[cfg(not(any(target_os = "windows", unix)))]
pub fn is_running_as_admin() -> bool {
    false
}

#[cfg(test)]
pub(crate) struct EnvVarGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl EnvVarGuard {
    pub(crate) fn new(keys: &[&'static str]) -> Self {
        use std::sync::{Mutex, OnceLock};

        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let lock = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let saved = keys
            .iter()
            .map(|&key| (key, std::env::var_os(key)))
            .collect();
        Self { saved, _lock: lock }
    }
}

#[cfg(test)]
impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[cfg(target_os = "macos")]
const UTF8_CTYPE_FALLBACK: &str = "UTF-8";
#[cfg(target_os = "macos")]
const UTF8_LANG_FALLBACK: &str = "en_US.UTF-8";
#[cfg(target_os = "macos")]
const ALLOW_BARE_UTF8_CTYPE: bool = true;
#[cfg(all(unix, not(target_os = "macos")))]
const UTF8_CTYPE_FALLBACK: &str = "C.UTF-8";
#[cfg(all(unix, not(target_os = "macos")))]
const UTF8_LANG_FALLBACK: &str = "C.UTF-8";
#[cfg(all(unix, not(target_os = "macos")))]
const ALLOW_BARE_UTF8_CTYPE: bool = false;

#[cfg(unix)]
fn is_c_locale(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case("C") || trimmed.eq_ignore_ascii_case("POSIX")
}

#[cfg(unix)]
fn is_utf8_locale(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.contains("utf-8") || lower.contains("utf8")
}

#[cfg(unix)]
fn is_bare_utf8_locale(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower == "utf-8" || lower == "utf8"
}

#[cfg(unix)]
pub(crate) fn normalize_utf8_locale_env(env: &mut std::collections::BTreeMap<String, String>) {
    let lc_all = env.get("LC_ALL").map(String::as_str);
    if lc_all.is_some_and(|value| is_utf8_locale(value) && !is_bare_utf8_locale(value)) {
        return;
    }
    if lc_all.is_some_and(|value| is_c_locale(value) || is_bare_utf8_locale(value)) {
        env.remove("LC_ALL");
    }

    let has_utf8_ctype = env.get("LC_CTYPE").is_some_and(|value| {
        is_utf8_locale(value) && (ALLOW_BARE_UTF8_CTYPE || !is_bare_utf8_locale(value))
    });
    if !has_utf8_ctype {
        env.insert("LC_CTYPE".to_string(), UTF8_CTYPE_FALLBACK.to_string());
    }

    let should_patch_lang = env
        .get("LANG")
        .map(|value| is_c_locale(value) || is_bare_utf8_locale(value))
        .unwrap_or(true);
    if should_patch_lang {
        env.insert("LANG".to_string(), UTF8_LANG_FALLBACK.to_string());
    }
}

#[cfg(unix)]
fn normalized_locale_env_from_process() -> std::collections::BTreeMap<String, String> {
    let mut env = std::collections::BTreeMap::new();
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Some(value) = std::env::var_os(key) {
            env.insert(key.to_string(), value.into_string().unwrap_or_default());
        }
    }
    normalize_utf8_locale_env(&mut env);
    env
}

/// Dynamically captures the complete login/interactive shell environment on Unix systems.
/// This behaves identically to logging in via SSH, automatically evaluating:
/// - /etc/profile
/// - ~/.profile
/// - ~/.bash_profile / ~/.zprofile
/// - ~/.bashrc / ~/.zshrc
/// - Any custom CLI installers, conda, pyenv, cargo, or custom virtualenv paths.
#[cfg(unix)]
pub(crate) fn capture_login_shell_env() -> Option<std::collections::HashMap<String, String>> {
    use std::collections::HashMap;
    use std::process::Command;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let output = Command::new(&shell)
        .args(["-l", "-i", "-c", "env"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();
    for line in stdout.lines() {
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            if !k.is_empty() && !k.starts_with('_') {
                map.insert(k.to_string(), v.to_string());
            }
        }
    }

    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

/// Global lazy-cached login shell environment snapshot.
#[cfg(unix)]
static LOGIN_SHELL_ENV: std::sync::OnceLock<Option<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

#[cfg(unix)]
pub(crate) fn get_login_shell_env() -> Option<&'static std::collections::HashMap<String, String>> {
    LOGIN_SHELL_ENV
        .get_or_init(capture_login_shell_env)
        .as_ref()
}

/// Windows App Execution Alias stubs (`%LOCALAPPDATA%\Microsoft\WindowsApps\*.exe`).
/// `python3.exe` here is a 0-byte reparse point that opens the Store (exit 49)
/// instead of a real interpreter — same class of trap as `WindowsApps\bash.exe`.
pub(crate) fn is_windows_apps_alias(path: &std::path::Path) -> bool {
    let s = path
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('/', "\\");
    s.contains(r"\windowsapps\")
}

/// Locate a real CPython `python.exe` on Windows, skipping Store aliases.
/// Cached per-process (a few `where` + `stat`s).
#[cfg(windows)]
pub(crate) fn detect_windows_python() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    use std::sync::OnceLock;
    static CACHED: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHED.get_or_init(detect_windows_python_uncached).clone()
}

#[cfg(windows)]
fn detect_windows_python_uncached() -> Option<std::path::PathBuf> {
    use std::path::Path;

    for name in ["python", "python3"] {
        for p in where_exes(name) {
            if p.is_file() && !is_windows_apps_alias(&p) {
                return Some(p);
            }
        }
    }
    for p in where_exes("py") {
        if is_windows_apps_alias(&p) {
            continue;
        }
        if let Some(real) = py_launcher_executable(&p) {
            return Some(real);
        }
    }
    scan_common_python_installs()
        .into_iter()
        .find(|p| p.is_file() && !is_windows_apps_alias(Path::new(p)))
}

#[cfg(windows)]
fn where_exes(name: &str) -> Vec<std::path::PathBuf> {
    let mut cmd = std::process::Command::new("where");
    cmd.arg(name);
    suppress_console_window_sync(&mut cmd);
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| std::path::PathBuf::from(l.trim()))
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

#[cfg(windows)]
fn py_launcher_executable(py_exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut cmd = std::process::Command::new(py_exe);
    cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
    suppress_console_window_sync(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let exe = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if exe.is_empty() {
        return None;
    }
    let p = std::path::PathBuf::from(exe);
    if p.is_file() && !is_windows_apps_alias(&p) {
        Some(p)
    } else {
        None
    }
}

#[cfg(windows)]
fn scan_common_python_installs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut found = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("Programs").join("Python"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        roots.push(PathBuf::from(pf).join("Python"));
    }
    for letter in b'C'..=b'G' {
        let drive = format!("{}:", letter as char);
        roots.push(PathBuf::from(format!(r"{drive}\Python")));
        roots.push(PathBuf::from(format!(r"{drive}\Program Files\Python")));
    }
    for root in roots {
        let direct = root.join("python.exe");
        if direct.is_file() {
            found.push(direct);
        }
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut vers: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        vers.sort();
        vers.reverse();
        for v in vers {
            let exe = v.join("python.exe");
            if exe.is_file() {
                found.push(exe);
            }
        }
    }
    found
}

/// Cung cấp `python3` cho Git Bash/CMD mà không di chuyển executable Python.
/// Launcher của venv phải ở cạnh metadata; không copy, hardlink hay symlink
/// sang thư mục tạm. Caller native vẫn gọi executable thật qua head rewrite.
/// Bash: `"$@"` giữ nguyên argv sau khi shell phân tích cú pháp.
/// cmd: chỉ hỗ trợ quoting chuẩn của cmd với delayed expansion tắt ở caller;
/// `%VAR%` vẫn được caller mở rộng, không dùng CALL (phân tích lại lần hai).
/// Dấu quote nhúng tuân theo quy tắc argv của Python/Windows; ký tự điều khiển
/// shell phải nằm trong quote. Không bảo đảm argv tùy ý qua PowerShell -> .cmd;
/// PowerShell phải gọi đường dẫn Python thật qua cơ chế rewrite đầu lệnh.
#[cfg(windows)]
fn python3_shim_dir(real_python: &std::path::Path) -> Option<std::path::PathBuf> {
    let name = real_python
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name.eq_ignore_ascii_case("python3.exe") {
        return real_python.parent().map(|p| p.to_path_buf());
    }
    let bash_path = real_python
        .to_str()?
        .replace('\\', "/")
        .replace('\'', "'\\''");
    let bash = format!("#!/bin/sh\nexec '{bash_path}' \"$@\"\n");
    // Nhân đôi % trong đường dẫn literal; tắt delayed expansion trong wrapper.
    // Caller cũng phải tắt nó để ! không bị mất trước khi wrapper chạy.
    let cmd_path = real_python.to_str()?.replace('%', "%%");
    let batch = format!(
        "@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"{cmd_path}\" %*\r\nexit /b %errorlevel%\r\n"
    );
    // Phiên bản và nội dung tách biệt wrapper cũ từng được ghi trực tiếp.
    // Không xóa/thay file sai nội dung: từ chối để tránh đua với reader/writer.
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    ("atomic-v2", real_python, &bash, &batch).hash(&mut hash);
    let dir = std::env::temp_dir()
        .join("jeikcode-python-forwarders")
        .join(format!("v2-{:016x}", hash.finish()));
    std::fs::create_dir_all(&dir).ok()?;
    for (name, contents) in [("python3", bash), ("python3.cmd", batch)] {
        publish_python_wrapper(&dir.join(name), contents.as_bytes()).ok()?;
    }
    Some(dir)
}

// Tempfile cùng thư mục, ghi và flush hoàn chỉnh trước khi công bố không ghi đè.
// Windows không rename đè target đang tồn tại; writer thua chỉ xác nhận nội dung.
#[cfg(any(windows, test))]
fn publish_python_wrapper(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind, Write};
    let verify = || {
        if std::fs::read(path)? == contents {
            Ok(())
        } else {
            Err(Error::new(
                ErrorKind::InvalidData,
                "unexpected Python wrapper contents",
            ))
        }
    };
    match std::fs::read(path) {
        Ok(existing) if existing == contents => return Ok(()),
        Ok(_) => {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "unexpected Python wrapper contents",
            ))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| {
            Error::new(ErrorKind::InvalidInput, "wrapper has no parent directory")
        })?)?;
    temporary.write_all(contents)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == ErrorKind::AlreadyExists => verify(),
        Err(e) => Err(e.error),
    }
}

/// Replace command-position `python3` / `python3.exe` with the real interpreter
/// path. Windows App Execution Aliases (`python3` → Store stub) take precedence
/// over PATH for `CreateProcess`, so PATH-prepending alone is not enough.
pub(crate) fn rewrite_python3_heads(command: &str, real_python: &std::path::Path) -> String {
    let quoted = {
        let s = real_python.to_string_lossy().replace('\\', "/");
        if s.chars()
            .any(|c| c.is_whitespace() || matches!(c, '"' | '\''))
        {
            format!("\"{}\"", s.replace('"', "\\\""))
        } else {
            s
        }
    };
    let mut out = String::with_capacity(command.len() + quoted.len());
    let mut i = 0usize;
    let n = command.len();
    let mut cmd_start = true;
    let mut in_single = false;
    let mut in_double = false;
    while i < n {
        let c = command[i..].chars().next().unwrap();
        let clen = c.len_utf8();
        if in_single {
            out.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += clen;
            continue;
        }
        if in_double {
            out.push(c);
            if c == '"' {
                in_double = false;
            }
            i += clen;
            continue;
        }
        match c {
            '\'' => {
                in_single = true;
                out.push(c);
                cmd_start = false;
            }
            '"' => {
                in_double = true;
                out.push(c);
                cmd_start = false;
            }
            ';' | '\n' | '(' | '{' => {
                out.push(c);
                cmd_start = true;
            }
            '|' | '&' => {
                out.push(c);
                cmd_start = true;
            }
            _ if c.is_whitespace() => out.push(c),
            _ => {
                if cmd_start {
                    if let Some(consumed) = match_python3_head(&command[i..]) {
                        out.push_str(&quoted);
                        i += consumed;
                        cmd_start = false;
                        continue;
                    }
                }
                out.push(c);
                cmd_start = false;
            }
        }
        i += clen;
    }
    out
}

#[cfg(windows)]
pub(crate) fn rewrite_python3_for_windows_shell(command: &str) -> String {
    match detect_windows_python() {
        Some(py) => rewrite_python3_heads(command, &py),
        None => command.to_string(),
    }
}

fn match_tool_head(s: &str, names: &[&str]) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    for cand in names {
        if lower.starts_with(cand) {
            let after = &s[cand.len()..];
            if after.is_empty()
                || after.starts_with(|c: char| {
                    c.is_whitespace() || matches!(c, ';' | '|' | '&' | ')' | '}' | '`')
                })
            {
                return Some(cand.len());
            }
        }
    }
    None
}

fn match_python3_head(s: &str) -> Option<usize> {
    match_tool_head(s, &["python3.exe", "python3"])
}

/// Linux models emit `rg`; Windows Git Bash ships GNU grep, not ripgrep.
/// When `rg` is absent, rewrite command-position `rg` to `grep -E` so pipes like
/// `git diff | rg -n pat` still work. `rg-only` flags (`--glob`) may still fail;
/// the cwd/platform hint on error covers that residual.
pub(crate) fn rewrite_rg_if_missing(command: &str) -> String {
    if rg_on_path() {
        return command.to_string();
    }
    rewrite_tool_heads(command, &["rg.exe", "rg"], "grep -E")
}

/// Rewrite unquoted Windows drive/UNC tokens `C:\foo` / `\\server\share` to
/// forward slashes so Git Bash does not eat `\U`/`\t` as escapes.
/// Quoted strings, regex `\n`, and `origin\main` are left alone.
pub(crate) fn rewrite_unquoted_windows_paths(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let mut i = 0usize;
    let n = command.len();
    let mut in_single = false;
    let mut in_double = false;
    let mut token_start = true;
    while i < n {
        let c = command[i..].chars().next().unwrap();
        let clen = c.len_utf8();
        if in_single {
            out.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += clen;
            continue;
        }
        if in_double {
            out.push(c);
            if c == '"' {
                in_double = false;
            }
            i += clen;
            continue;
        }
        match c {
            '\'' => {
                in_single = true;
                token_start = false;
                out.push(c);
                i += clen;
            }
            '"' => {
                in_double = true;
                token_start = false;
                out.push(c);
                i += clen;
            }
            _ if c.is_whitespace()
                || matches!(
                    c,
                    ';' | '|' | '&' | '(' | ')' | '{' | '}' | '<' | '>' | '\n'
                ) =>
            {
                out.push(c);
                token_start = true;
                i += clen;
            }
            _ if token_start => {
                if let Some((token, consumed)) = take_windows_path_token(&command[i..]) {
                    out.push_str(&token.replace('\\', "/"));
                    i += consumed;
                    token_start = false;
                } else {
                    out.push(c);
                    token_start = false;
                    i += clen;
                }
            }
            _ => {
                out.push(c);
                token_start = false;
                i += clen;
            }
        }
    }
    out
}

fn take_windows_path_token(s: &str) -> Option<(String, usize)> {
    let drive = {
        let mut ch = s.chars();
        let letter = ch.next()?;
        letter.is_ascii_alphabetic() && ch.next() == Some(':') && ch.next() == Some('\\')
    };
    let unc = {
        let b = s.as_bytes();
        b.len() >= 3
            && b[0] == b'\\'
            && b[1] == b'\\'
            && (b[2].is_ascii_alphanumeric() || b[2] == b'.' || b[2] == b'-')
    };
    if !drive && !unc {
        return None;
    }
    let mut end = 0usize;
    for (idx, c) in s.char_indices() {
        if c.is_whitespace()
            || matches!(
                c,
                ';' | '|' | '&' | '(' | ')' | '{' | '}' | '<' | '>' | '\'' | '"'
            )
        {
            break;
        }
        end = idx + c.len_utf8();
    }
    if end == 0 {
        return None;
    }
    Some((s[..end].to_string(), end))
}

pub(crate) fn rewrite_tool_heads(command: &str, names: &[&str], replacement: &str) -> String {
    let mut out = String::with_capacity(command.len() + replacement.len());
    let mut i = 0usize;
    let n = command.len();
    let mut cmd_start = true;
    let mut in_single = false;
    let mut in_double = false;
    while i < n {
        let c = command[i..].chars().next().unwrap();
        let clen = c.len_utf8();
        if in_single {
            out.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += clen;
            continue;
        }
        if in_double {
            out.push(c);
            if c == '"' {
                in_double = false;
            }
            i += clen;
            continue;
        }
        match c {
            '\'' => {
                in_single = true;
                out.push(c);
                cmd_start = false;
            }
            '"' => {
                in_double = true;
                out.push(c);
                cmd_start = false;
            }
            ';' | '\n' | '(' | '{' => {
                out.push(c);
                cmd_start = true;
            }
            '|' | '&' => {
                out.push(c);
                cmd_start = true;
            }
            _ if c.is_whitespace() => out.push(c),
            _ => {
                if cmd_start {
                    if let Some(consumed) = match_tool_head(&command[i..], names) {
                        out.push_str(replacement);
                        i += consumed;
                        cmd_start = false;
                        continue;
                    }
                }
                out.push(c);
                cmd_start = false;
            }
        }
        i += clen;
    }
    out
}

fn rg_on_path() -> bool {
    #[cfg(windows)]
    {
        where_exes("rg")
            .into_iter()
            .any(|p| p.is_file() && !is_windows_apps_alias(&p))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .args(["-c", "command -v rg >/dev/null 2>&1"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

#[cfg(windows)]
fn prepend_windows_python(all_paths: &mut Vec<std::path::PathBuf>) {
    let Some(py) = detect_windows_python() else {
        return;
    };
    if let Some(parent) = py.parent() {
        let parent = parent.to_path_buf();
        if parent.is_dir() && !all_paths.contains(&parent) {
            all_paths.insert(0, parent);
        }
    }
    if let Some(shim) = python3_shim_dir(&py) {
        if shim.is_dir() {
            all_paths.retain(|p| p != &shim);
            all_paths.insert(0, shim);
        }
    }
}

/// Build an enriched PATH environment variable that combines:
/// 1. The full PATH dynamically resolved from the user's interactive login shell (.bashrc/.profile)
/// 2. Current process PATH
/// 3. Static fallback candidate paths.
pub(crate) fn enriched_path_env() -> Option<std::ffi::OsString> {
    use std::path::PathBuf;

    #[cfg(unix)]
    {
        if let Some(env_map) = get_login_shell_env() {
            if let Some(login_path) = env_map.get("PATH") {
                return Some(std::ffi::OsString::from(login_path));
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin"));
        candidates.push(home.join("bin"));
        candidates.push(home.join(".cargo").join("bin"));
        candidates.push(home.join(".grok").join("bin"));
        candidates.push(home.join(".bun").join("bin"));
        candidates.push(home.join("go").join("bin"));

        let nvm_node = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_node) {
            for entry in entries.flatten() {
                let bin_dir = entry.path().join("bin");
                if bin_dir.is_dir() {
                    candidates.push(bin_dir);
                }
            }
        }
        candidates.push(home.join(".nvm").join("current").join("bin"));
        candidates.push(home.join(".fnm").join("current").join("bin"));
        candidates.push(home.join(".volta").join("bin"));
    }

    #[cfg(unix)]
    {
        candidates.push(PathBuf::from("/usr/local/bin"));
        candidates.push(PathBuf::from("/usr/local/sbin"));
        candidates.push(PathBuf::from("/usr/bin"));
        candidates.push(PathBuf::from("/bin"));
        candidates.push(PathBuf::from("/usr/sbin"));
        candidates.push(PathBuf::from("/sbin"));
    }

    let existing_path = std::env::var_os("PATH");
    let mut all_paths: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    prepend_windows_python(&mut all_paths);

    for path in candidates {
        if path.is_dir() && !all_paths.contains(&path) {
            all_paths.push(path);
        }
    }

    if let Some(ref path_str) = existing_path {
        for path in std::env::split_paths(path_str) {
            if !all_paths.contains(&path) {
                all_paths.push(path);
            }
        }
    }

    if all_paths.is_empty() {
        existing_path
    } else {
        std::env::join_paths(all_paths).ok()
    }
}

/// Apply enriched PATH and login shell environment variables to an async tokio::process::Command.
pub(crate) fn apply_enriched_path_env(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        if let Some(env_map) = get_login_shell_env() {
            for (k, v) in env_map {
                if k != "PWD" && k != "OLDPWD" && k != "SHLVL" {
                    cmd.env(k, v);
                }
            }
        }
    }

    if let Some(path) = enriched_path_env() {
        cmd.env("PATH", path);
    }
}

/// Apply enriched PATH and login shell environment variables to a sync std::process::Command.
pub(crate) fn apply_enriched_path_env_sync(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        if let Some(env_map) = get_login_shell_env() {
            for (k, v) in env_map {
                if k != "PWD" && k != "OLDPWD" && k != "SHLVL" {
                    cmd.env(k, v);
                }
            }
        }
    }

    if let Some(path) = enriched_path_env() {
        cmd.env("PATH", path);
    }
}

/// Force non-interactive CLI defaults so pagers and credential prompts cannot
/// steal the TUI. Applied AFTER [`apply_enriched_path_env`] so a login-shell
/// `PAGER=less` / `SYSTEMD_PAGER` snapshot cannot win.
///
/// Do NOT set `CI=1`: that changes build/test behavior. Askpass env is applied
/// later and still wins for `sudo`/`ssh` password prompts.
pub(crate) fn apply_noninteractive_cli_env(cmd: &mut tokio::process::Command) {
    for (k, v) in NONINTERACTIVE_CLI_ENV {
        cmd.env(k, v);
    }
}

const NONINTERACTIVE_CLI_ENV: &[(&str, &str)] = &[
    ("PAGER", "cat"),
    ("GIT_PAGER", "cat"),
    ("GH_PAGER", "cat"),
    ("SYSTEMD_PAGER", "cat"),
    ("LESS", "FRX"),
    ("GIT_TERMINAL_PROMPT", "0"),
    // Git Credential Manager (Windows/macOS) otherwise opens a GUI or
    // console prompt that steals the TUI. Fail closed instead of hanging.
    ("GCM_INTERACTIVE", "never"),
    ("DEBIAN_FRONTEND", "noninteractive"),
    ("AWS_PAGER", ""),
    ("COMPOSER_NO_INTERACTION", "1"),
];

/// Apply a UTF-8-capable locale to async subprocesses spawned from v2 capabilities.
#[cfg(unix)]
pub(crate) fn apply_utf8_locale_env(cmd: &mut tokio::process::Command) {
    let env = normalized_locale_env_from_process();
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        match env.get(key) {
            Some(value) => {
                cmd.env(key, value);
            }
            None => {
                cmd.env_remove(key);
            }
        }
    }
}

/// Apply a UTF-8-capable locale to sync subprocesses spawned from v2 capabilities.
#[cfg(unix)]
#[cfg_attr(not(feature = "skills"), allow(dead_code))]
pub(crate) fn apply_utf8_locale_env_sync(cmd: &mut std::process::Command) {
    let env = normalized_locale_env_from_process();
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        match env.get(key) {
            Some(value) => {
                cmd.env(key, value);
            }
            None => {
                cmd.env_remove(key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    // STRUCTURAL ONLY: `creation_flags` is set-only (std can't read it back), so the
    // actual CREATE_NO_WINDOW behavior is unverifiable off Windows and must be checked
    // on a Windows build. These tests only assert the helpers leave a command spawnable
    // (i.e. the spawn path can route through them without breaking).
    #[tokio::test]
    async fn tokio_helper_keeps_command_spawnable() {
        let prog = if cfg!(windows) { "cmd" } else { "true" };
        let mut cmd = tokio::process::Command::new(prog);
        if cfg!(windows) {
            cmd.args(["/C", "exit 0"]);
        }
        suppress_console_window(&mut cmd);
        let status = cmd.status().await.expect("spawn after suppress");
        assert!(status.success());
    }

    #[tokio::test]
    async fn detach_from_console_keeps_command_spawnable() {
        let prog = if cfg!(windows) { "cmd" } else { "true" };
        let mut cmd = tokio::process::Command::new(prog);
        if cfg!(windows) {
            cmd.args(["/C", "exit 0"]);
        }
        detach_from_console(&mut cmd);
        let status = cmd.status().await.expect("spawn after detach");
        assert!(status.success());
    }

    #[test]
    fn enriched_path_env_returns_valid_paths() {
        let env_path = enriched_path_env();
        assert!(env_path.is_some());
    }

    #[test]
    fn windows_apps_python_stub_is_alias_real_install_is_not() {
        use std::path::Path;
        assert!(is_windows_apps_alias(Path::new(
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\python3.exe"
        )));
        assert!(is_windows_apps_alias(Path::new(
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\python.exe"
        )));
        assert!(!is_windows_apps_alias(Path::new(
            r"F:\Python\Python312\python.exe"
        )));
        assert!(!is_windows_apps_alias(Path::new(
            r"C:\Program Files\Python312\python.exe"
        )));
        assert!(is_windows_apps_alias(Path::new(
            "/c/Users/me/AppData/Local/Microsoft/WindowsApps/python3"
        )));
    }

    #[test]
    #[cfg(windows)]
    fn detect_windows_python_skips_store_stub() {
        if let Some(py) = detect_windows_python() {
            assert!(
                !is_windows_apps_alias(&py),
                "must not pick the Store stub: {}",
                py.display()
            );
            assert!(
                py.file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case("python.exe")
                        || n.eq_ignore_ascii_case("python3.exe")),
                "unexpected interpreter name: {}",
                py.display()
            );
        }
    }

    #[test]
    fn rewrite_python3_heads_only_command_position() {
        use std::path::Path;
        let real = Path::new(r"F:/Python/Python312/python.exe");
        assert_eq!(
            rewrite_python3_heads("python3 --version", real),
            "F:/Python/Python312/python.exe --version"
        );
        assert_eq!(
            rewrite_python3_heads("python3 --version || python --version", real),
            "F:/Python/Python312/python.exe --version || python --version"
        );
        assert_eq!(
            rewrite_python3_heads("echo python3; python3 -c 'print(1)'", real),
            "echo python3; F:/Python/Python312/python.exe -c 'print(1)'"
        );
        assert_eq!(
            rewrite_python3_heads("python3-config --includes", real),
            "python3-config --includes"
        );
    }

    #[test]
    fn rewrite_rg_pipeline_to_grep_e() {
        assert_eq!(
            rewrite_tool_heads(
                r#"git diff -U3 a.rs | rg -n "truncated" || true"#,
                &["rg.exe", "rg"],
                "grep -E",
            ),
            r#"git diff -U3 a.rs | grep -E -n "truncated" || true"#,
        );
        assert_eq!(
            rewrite_tool_heads("rga foo", &["rg.exe", "rg"], "grep -E"),
            "rga foo",
        );
    }

    #[test]
    fn rewrite_unquoted_drive_and_unc_paths() {
        assert_eq!(
            rewrite_unquoted_windows_paths(r"rustfmt C:\foo\bar.rs"),
            "rustfmt C:/foo/bar.rs",
        );
        assert_eq!(
            rewrite_unquoted_windows_paths(r"cd E:\code\jeikcode && cargo test"),
            "cd E:/code/jeikcode && cargo test",
        );
        assert_eq!(
            rewrite_unquoted_windows_paths(r"ls \\server\share\dir"),
            "ls //server/share/dir",
        );
        assert_eq!(
            rewrite_unquoted_windows_paths(r"echo 'C:\foo\bar'"),
            r"echo 'C:\foo\bar'",
        );
        assert_eq!(
            rewrite_unquoted_windows_paths(r#"echo "C:\foo""#),
            r#"echo "C:\foo""#,
        );
        assert_eq!(
            rewrite_unquoted_windows_paths(r"git log origin\main"),
            r"git log origin\main",
        );
        assert_eq!(
            rewrite_unquoted_windows_paths("printf 'a\\n'"),
            "printf 'a\\n'",
        );
        assert_eq!(
            rewrite_unquoted_windows_paths("ls C:/already/forward"),
            "ls C:/already/forward",
        );
    }

    #[test]
    fn python_wrapper_publication_is_atomic_under_concurrency() {
        use std::sync::{Arc, Barrier};
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("python3");
        // Tất cả writer cùng interpreter/nội dung; file lớn phơi bày ghi dở.
        let contents = Arc::new(
            format!(
                "#!/bin/sh\n# {}\nexec '/same/python.exe' \"$@\"\n",
                "x".repeat(1 << 20)
            )
            .into_bytes(),
        );
        let barrier = Arc::new(Barrier::new(9));
        std::thread::scope(|scope| {
            let mut writers = Vec::new();
            for _ in 0..8 {
                let barrier = barrier.clone();
                let contents = contents.clone();
                let path = &path;
                writers.push(scope.spawn(move || {
                    barrier.wait();
                    publish_python_wrapper(path, &contents).unwrap();
                }));
            }
            barrier.wait();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            // Reader chỉ chấp nhận chưa công bố hoặc toàn bộ wrapper, không prefix.
            loop {
                match std::fs::read(&path) {
                    Ok(bytes) => assert_eq!(bytes, *contents),
                    Err(e) => assert_eq!(e.kind(), std::io::ErrorKind::NotFound),
                }
                if writers.iter().all(|writer| writer.is_finished()) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "publication exceeded deadline"
                );
                std::thread::yield_now();
            }
            for writer in writers {
                writer.join().unwrap();
            }
        });
        assert_eq!(std::fs::read(&path).unwrap(), *contents);
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        publish_python_wrapper(&path, &contents).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
        assert_eq!(
            publish_python_wrapper(&path, b"wrong").unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(std::fs::read(&path).unwrap(), *contents);
    }

    #[test]
    #[cfg(windows)]
    fn python3_shim_concurrent_same_interpreter() {
        let fixture = tempfile::tempdir().unwrap();
        let py = fixture.path().join("python.exe");
        let barrier = std::sync::Barrier::new(8);
        let directories = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        let dir = python3_shim_dir(&py).unwrap();
                        for name in ["python3", "python3.cmd"] {
                            assert!(std::fs::read_to_string(dir.join(name))
                                .unwrap()
                                .contains("python.exe"));
                        }
                        dir
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(directories.iter().all(|d| d == &directories[0]));
        std::fs::remove_dir_all(&directories[0]).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn python3_shim_preserves_native_python3_directory() {
        let dir = tempfile::tempdir().unwrap();
        let py = dir.path().join("python3.exe");
        std::fs::write(&py, b"deterministic fixture").unwrap();
        let shim_dir = python3_shim_dir(&py).unwrap();
        assert_eq!(shim_dir, dir.path());
        // Tiền tố công cụ khác không thay đổi danh tính shim cần kiểm tra.
        let prefix = dir.path().join("poetry");
        let path = std::env::join_paths([prefix.clone(), shim_dir.clone()]).unwrap();
        assert_eq!(std::env::split_paths(&path).next().unwrap(), prefix);
        assert!(std::env::split_paths(&path).any(|d| d == shim_dir));
        assert_eq!(
            std::fs::read(shim_dir.join("python3.exe")).unwrap(),
            b"deterministic fixture"
        );
    }

    #[cfg(windows)]
    async fn assert_python3_shell_contract(py: &std::path::Path, path: &std::ffi::OsStr) {
        let mut shells = vec![(std::path::PathBuf::from("cmd.exe"), "/C", false)];

        if let Some(bash) = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
        ]
        .into_iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.is_file())
        {
            shells.push((bash, "-c", true));
        }
        let fixture = tempfile::tempdir().unwrap();
        let script = fixture.path().join("argv.json.py");
        std::fs::write(
            &script,
            "import json,sys\nprint(json.dumps(sys.argv[1:]))\n",
        )
        .unwrap();
        let expected = [
            "with spaces",
            "bang!value",
            "percent%value",
            "amp&value",
            "pipe|value",
            "less<value",
            "more>value",
            "caret^value",
            "quote\"value",
        ];
        for (shell, flag, nested) in shells {
            // Fixture chỉ in JSON; không chứa lệnh shell phụ hay payload thực thi.
            let command = if nested {
                let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
                format!(
                    "sh -c {}",
                    quote(&format!(
                        "python3 {} {}",
                        quote(&script.to_string_lossy().replace('\\', "/")),
                        expected
                            .iter()
                            .map(|s| quote(s))
                            .collect::<Vec<_>>()
                            .join(" ")
                    ))
                )
            } else {
                format!(
                    "python3 \"{}\" {}",
                    script.display(),
                    expected
                        .iter()
                        .map(|s| format!("\"{}\"", s.replace('"', "\\\"")))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            };
            let mut cmd = tokio::process::Command::new(&shell);
            if nested {
                cmd.arg(flag).arg(&command);
            } else {
                use std::os::windows::process::CommandExt;
                cmd.args(["/D", "/V:OFF", flag]);
                cmd.as_std_mut().raw_arg(&command);
            }
            cmd.env("PATH", path);
            suppress_console_window(&mut cmd);
            let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
                .await
                .expect("Python fixture timed out")
                .unwrap();
            assert!(
                out.status.success(),
                "{}: {}",
                shell.display(),
                String::from_utf8_lossy(&out.stderr)
            );
            let argv: Vec<String> = serde_json::from_slice(&out.stdout).expect("Python argv JSON");
            assert_eq!(argv, expected, "{}", shell.display());
            // Lệnh lồng nhau không thể sửa bằng rewrite đầu lệnh.
            let command = r#"python3 -c "import sys,json,ssl; print(sys.executable); print(sys.argv[1]); print(sys.prefix); print(sys.base_prefix)" "argument with spaces""#;
            let command = if nested {
                format!("sh -c '{command}'")
            } else {
                command.to_string()
            };
            let mut cmd = tokio::process::Command::new(&shell);
            cmd.arg(flag);
            if shell == std::path::Path::new("cmd.exe") {
                use std::os::windows::process::CommandExt;
                cmd.as_std_mut().raw_arg(&command);
            } else {
                cmd.arg(&command);
            }
            cmd.env("PATH", path);
            suppress_console_window(&mut cmd);
            let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
                .await
                .expect("Python fixture timed out")
                .expect("spawn shell");
            assert!(
                out.status.success(),
                "{} shim failed: {}",
                shell.display(),
                String::from_utf8_lossy(&out.stderr)
            );
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut lines = stdout.lines();
            let exe = std::path::PathBuf::from(lines.next().expect("sys.executable"));
            assert!(!is_windows_apps_alias(&exe));
            assert_eq!(exe.canonicalize().unwrap(), py.canonicalize().unwrap());
            assert_eq!(lines.next(), Some("argument with spaces"));
            let prefix = std::path::PathBuf::from(lines.next().expect("sys.prefix"));
            let base_prefix = std::path::PathBuf::from(lines.next().expect("sys.base_prefix"));
            let root = py.parent().unwrap().parent().unwrap();
            // Kiểm tra CPython thật đọc cấu hình venv, không chỉ executable đúng.
            if root.join("pyvenv.cfg").is_file() {
                assert_eq!(prefix.canonicalize().unwrap(), root.canonicalize().unwrap());
                assert_ne!(
                    prefix.canonicalize().unwrap(),
                    base_prefix.canonicalize().unwrap()
                );
            }

            let command = if nested {
                "sh -c 'python3 -c \"import sys; sys.exit(37)\"'"
            } else {
                "python3 -c \"import sys; sys.exit(37)\""
            };
            let mut cmd = tokio::process::Command::new(&shell);
            cmd.arg(flag);
            if shell == std::path::Path::new("cmd.exe") {
                use std::os::windows::process::CommandExt;
                cmd.as_std_mut().raw_arg(command);
            } else {
                cmd.arg(command);
            }
            cmd.env("PATH", path);
            suppress_console_window(&mut cmd);
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
                    .await
                    .expect("Python fixture timed out")
                    .unwrap()
                    .status
                    .code(),
                Some(37)
            );
        }
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn python3_shim_runs_real_cpython() {
        let Some(py) = detect_windows_python() else {
            return;
        };
        let path = enriched_path_env().expect("PATH");
        let shim_dir = python3_shim_dir(&py).expect("shim dir");
        assert!(std::env::split_paths(&path).any(|d| d == shim_dir));
        assert_python3_shell_contract(&py, &path).await;
        let rewritten = rewrite_python3_heads("python3 --version", &py);
        assert!(!rewritten.starts_with("python3 "), "{rewritten}");
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn python3_shim_runs_venv_in_place() {
        let Some(py) = detect_windows_python() else {
            return;
        };
        let fixture = tempfile::tempdir().unwrap();
        let venv = fixture.path().join("venv with spaces and 'quote");
        let mut cmd = tokio::process::Command::new(&py);
        cmd.args(["-m", "venv", "--without-pip"]).arg(&venv);
        suppress_console_window(&mut cmd);
        let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
            .await
            .expect("Python fixture timed out")
            .expect("create actual venv");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let venv_py = venv.join("Scripts").join("python.exe");
        assert!(venv.join("pyvenv.cfg").is_file());
        let shim_dir = python3_shim_dir(&venv_py).expect("venv shim dir");
        assert_ne!(shim_dir, python3_shim_dir(&py).unwrap());
        assert!(shim_dir.join("python3").is_file());
        assert!(shim_dir.join("python3.cmd").is_file());
        assert!(!shim_dir.join("python3.exe").exists());
        let base_path = enriched_path_env().unwrap();
        let path = std::env::join_paths(
            std::iter::once(shim_dir).chain(std::env::split_paths(&base_path)),
        )
        .unwrap();
        assert_python3_shell_contract(&venv_py, &path).await;
    }

    #[test]
    #[cfg(unix)]
    fn normalize_utf8_locale_env_replaces_c_locale() {
        let mut env = BTreeMap::from([
            ("LC_ALL".to_string(), "C".to_string()),
            ("LANG".to_string(), "C".to_string()),
        ]);

        normalize_utf8_locale_env(&mut env);

        assert!(env
            .values()
            .any(|value| value.to_ascii_lowercase().contains("utf")));
    }

    #[test]
    #[cfg(unix)]
    fn normalize_utf8_locale_env_preserves_existing_utf8_locale() {
        let mut env = BTreeMap::from([
            ("LC_ALL".to_string(), "zh_CN.UTF-8".to_string()),
            ("LANG".to_string(), "zh_CN.UTF-8".to_string()),
        ]);

        normalize_utf8_locale_env(&mut env);

        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("zh_CN.UTF-8"));
    }
}
