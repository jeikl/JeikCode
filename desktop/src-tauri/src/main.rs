// Prevents additional console window on Windows
#![windows_subsystem = "windows"]

//! 薄桌面壳：拉起同一个 `jeikcode webui`，窗口只打开它。
//! 直接就地（In-Place）执行安装目录下的 `jeikcode`，单一来源运行，消除运行期文件释放与杀毒误报。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Listener, Manager};
#[cfg(not(target_os = "windows"))]
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

static DESKTOP_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// 与 `jeikcode_updater::RESTART_REQUESTED_EXIT_CODE` 对齐的显式重启退出码。
/// 仅当子进程因「软件更新」或「小地球更换端口/地址立即重启」主动以该退出码退出时，
/// 桌面壳才重新拉起新实例，避免异常崩溃时陷入无条件死循环。
const RESTART_REQUESTED_EXIT_CODE: i32 = 75;

/// 这次桌面壳拉起的 WebUI。端口可能因占用从 13457 顺延。
#[derive(Clone, Debug, PartialEq, Eq)]
struct WebuiOrigin {
    host: String,
    port: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinkAction {
    StayInWebview,
    OpenExternal,
}

/// Tauri 自己的页面。交给系统浏览器会去连一个不存在的 `tauri.localhost`。
fn is_shell_internal_url(url: &tauri::Url) -> bool {
    let scheme = url.scheme();
    if matches!(scheme, "tauri" | "about" | "data" | "ipc" | "asset") {
        return true;
    }
    if scheme == "http" || scheme == "https" {
        if let Some(host) = url.host_str() {
            return host.eq_ignore_ascii_case("tauri.localhost");
        }
    }
    false
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']');
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn is_launched_webui(url: &tauri::Url, origin: &WebuiOrigin) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let Some(port) = url.port() else {
        return false;
    };
    if port != origin.port {
        return false;
    }
    host.eq_ignore_ascii_case(&origin.host)
        || (is_loopback_host(host) && is_loopback_host(&origin.host))
}

/// 顶层导航：只有壳页面和这次的 WebUI 留在窗口里。
/// `http://localhost:3000` 这类本机开发服务改由系统浏览器打开，避免盖掉当前界面。
fn navigation_action(url: &tauri::Url, origin: Option<&WebuiOrigin>) -> LinkAction {
    if is_shell_internal_url(url) {
        return LinkAction::StayInWebview;
    }
    // 回环地址上的内部重载、端口变更或携带 desktop=1 标志的均保留在窗口内，绝不弹出到系统浏览器
    if let Some(host) = url.host_str() {
        if is_loopback_host(host) {
            if url.query().is_some_and(|q| q.contains("desktop=")) {
                return LinkAction::StayInWebview;
            }
            if origin.is_some() {
                let (_h, saved_port, _t) = saved_webui_listen();
                if url.port() == Some(saved_port) {
                    return LinkAction::StayInWebview;
                }
            }
        }
    }
    if origin.is_some_and(|origin| is_launched_webui(url, origin)) {
        return LinkAction::StayInWebview;
    }
    LinkAction::OpenExternal
}

/// Markdown 链接带 `target="_blank"`，走新窗口而不是顶层导航。
/// 除 Tauri 虚拟地址外一律交给系统浏览器，包括本机其它端口。
fn new_window_action(url: &tauri::Url) -> LinkAction {
    if is_shell_internal_url(url) {
        LinkAction::StayInWebview
    } else {
        LinkAction::OpenExternal
    }
}

fn remember_webui_origin(slot: &Mutex<Option<WebuiOrigin>>, url: &str) {
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        return;
    };
    let (Some(host), Some(port)) = (parsed.host_str(), parsed.port()) else {
        return;
    };
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(WebuiOrigin {
        host: host.to_string(),
        port,
    });
}

/// Quiet only while the native window is in front. Minimized stays away even
/// if the webview still reports itself focused.
fn host_window_away(minimized: bool, focused: bool) -> bool {
    minimized || !focused
}

fn read_host_away(window: &tauri::WebviewWindow) -> Option<bool> {
    let minimized = window.is_minimized().ok()?;
    let focused = window.is_focused().ok()?;
    Some(host_window_away(minimized, focused))
}

fn publish_host_away(window: &tauri::WebviewWindow, away: bool) {
    let _ = window.eval(format!("window.__jeikcodeHostAway={away};"));
}

fn show_main_window(window: &tauri::WebviewWindow) {
    let was_minimized = window.is_minimized().unwrap_or(false);
    if was_minimized {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        #[link(name = "user32")]
        extern "system" {
            fn IsIconic(hWnd: *mut std::ffi::c_void) -> i32;
            fn ShowWindow(hWnd: *mut std::ffi::c_void, nCmdShow: i32) -> i32;
            fn GetForegroundWindow() -> *mut std::ffi::c_void;
            fn GetWindowThreadProcessId(
                hWnd: *mut std::ffi::c_void,
                lpdwProcessId: *mut u32,
            ) -> u32;
            fn AttachThreadInput(idAttach: u32, idAttachTo: u32, fAttach: i32) -> i32;
            fn BringWindowToTop(hWnd: *mut std::ffi::c_void) -> i32;
            fn SetForegroundWindow(hWnd: *mut std::ffi::c_void) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThreadId() -> u32;
        }
        unsafe {
            let h = hwnd.0 as *mut std::ffi::c_void;
            // 仅在真正最小化时使用 SW_RESTORE (9)，避免把原本最大化的窗口还原成小窗口。
            let cmd = if IsIconic(h) != 0 || was_minimized {
                9
            } else {
                5
            };
            ShowWindow(h, cmd);
            let fg = GetForegroundWindow();
            let fg_tid = if fg.is_null() {
                0
            } else {
                GetWindowThreadProcessId(fg, std::ptr::null_mut())
            };
            let cur_tid = GetCurrentThreadId();
            let attached =
                fg_tid != 0 && fg_tid != cur_tid && AttachThreadInput(cur_tid, fg_tid, 1) != 0;
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if attached {
                AttachThreadInput(cur_tid, fg_tid, 0);
            }
        }
    }
    publish_host_away(window, false);
}

fn hide_window_to_tray(window: &tauri::WebviewWindow) {
    let _ = window.hide();
    // 兜底直接调用 Win32 ShowWindow(SW_HIDE)：防止外部快捷方式曾直接操作 HWND 导致
    // tao 内部 WindowFlags::VISIBLE 标志位与真实窗口显隐状态失步而忽略 hide()。
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        #[link(name = "user32")]
        extern "system" {
            fn ShowWindow(hWnd: *mut std::ffi::c_void, nCmdShow: i32) -> i32;
        }
        unsafe {
            ShowWindow(hwnd.0 as *mut std::ffi::c_void, 0);
        }
    }
    publish_host_away(window, true);
}

/// Tray click / global shortcut: hide when already visible+focused, otherwise
/// warm-show the existing window (never rebuild the WebView).
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let is_visible = window.is_visible().unwrap_or(false);
    let is_minimized = window.is_minimized().unwrap_or(false);
    let is_focused = window.is_focused().unwrap_or(false);
    if is_visible && !is_minimized && is_focused {
        hide_window_to_tray(&window);
    } else {
        show_main_window(&window);
    }
}

fn send_desktop_shutdown(port: u16, token: Option<&str>) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    let auth_header = match token {
        Some(t) if !t.is_empty() => format!("Authorization: Bearer {t}\r\n"),
        _ => String::new(),
    };
    let req = format!(
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth_header}Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(req.as_bytes());
}

#[cfg(target_os = "windows")]
fn cleanup_desktop_owned_children_windows() {
    #[allow(non_snake_case)]
    #[repr(C)]
    struct ProcessEntry32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> *mut std::ffi::c_void;
        fn Process32FirstW(hSnapshot: *mut std::ffi::c_void, lppe: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(hSnapshot: *mut std::ffi::c_void, lppe: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            dwProcessId: u32,
        ) -> *mut std::ffi::c_void;
        fn TerminateProcess(hProcess: *mut std::ffi::c_void, uExitCode: u32) -> i32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
    }

    let my_pid = std::process::id();
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_TERMINATE: u32 = 0x0001;

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot == -1isize as *mut std::ffi::c_void {
        return;
    }

    let mut entry = ProcessEntry32W {
        dwSize: std::mem::size_of::<ProcessEntry32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };

    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            if entry.th32ParentProcessID == my_pid && entry.th32ProcessID != my_pid {
                let name = String::from_utf16_lossy(&entry.szExeFile)
                    .trim_matches('\0')
                    .to_ascii_lowercase();
                if name.starts_with("jeikcode") || name.starts_with("cli-bin") {
                    let h_proc = unsafe { OpenProcess(PROCESS_TERMINATE, 0, entry.th32ProcessID) };
                    if !h_proc.is_null() {
                        unsafe {
                            TerminateProcess(h_proc, 1);
                            CloseHandle(h_proc);
                        }
                    }
                }
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe {
        CloseHandle(snapshot);
    }
}

fn terminate_managed_child(app: &tauri::AppHandle) {
    DESKTOP_SHUTTING_DOWN.store(true, Ordering::SeqCst);
    if let Some(slot) = app.try_state::<ChildSlot>() {
        let taken = slot.0.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut child) = taken {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // 兜底 1：读取当前配置端口，向 /shutdown 发送优雅关停请求（即使子进程句柄丢失也能通知关停）
    let (_host, port, token) = saved_webui_listen();
    if port > 0 {
        send_desktop_shutdown(port, token.as_deref());
    }
    // 兜底 2：在 Windows 上，强力清理属于本桌面壳 PID 的后台子进程，彻底消除改参数重启后脱离的孤儿子进程
    #[cfg(target_os = "windows")]
    cleanup_desktop_owned_children_windows();
}

fn handle_desktop_shell_action(url: &tauri::Url, app: &tauri::AppHandle) -> bool {
    match url.path() {
        "/__desktop_action/hide_to_tray" => {
            if let Some(window) = app.get_webview_window("main") {
                hide_window_to_tray(&window);
            }
            true
        }
        "/__desktop_action/quit_app" => {
            terminate_managed_child(app);
            app.exit(0);
            true
        }
        "/__desktop_action/set_close_action" => {
            let action = url
                .query_pairs()
                .find(|(k, _)| k == "action")
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| "ask".to_string());
            save_close_action(&action);
            true
        }
        // The shortcut recorder must be able to capture the currently registered
        // combo (and combos that collide with it). Suspend globally while the
        // field is recording; resume from the persisted value afterwards.
        "/__desktop_action/suspend_shortcut" => {
            let _ = app.global_shortcut().unregister_all();
            true
        }
        "/__desktop_action/resume_shortcut" => {
            let settings = load_shell_settings();
            apply_toggle_shortcut(app, &settings.toggle_shortcut);
            true
        }
        _ => false,
    }
}

/// The page's document.hidden / hasFocus miss a minimized WebView. Push the
/// native state so a selected session still notifies after minimize.
fn watch_host_presence(window: tauri::WebviewWindow) {
    let listener = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Focused(_)) {
            return;
        }
        if let Some(away) = read_host_away(&listener) {
            publish_host_away(&listener, away);
        }
    });

    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let Some(away) = read_host_away(&window) else {
                break;
            };
            if last != Some(away) {
                publish_host_away(&window, away);
                last = Some(away);
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    });
}

/// `0.0.0.0` / `::` 是监听地址，浏览器打不开。打开前改成回环。
fn external_browser_url(url: &tauri::Url) -> String {
    let bare = url
        .host_str()
        .unwrap_or("")
        .trim_matches(|c| c == '[' || c == ']');
    if bare == "0.0.0.0" || bare == "::" {
        let mut rewritten = url.clone();
        if rewritten.set_host(Some("127.0.0.1")).is_ok() {
            return rewritten.to_string();
        }
    }
    url.to_string()
}

fn open_in_external_browser(url: &str) {
    if url.contains("tauri.localhost")
        || url.starts_with("tauri://")
        || url.starts_with("about:")
        || url.starts_with("data:")
    {
        return;
    }
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

#[cfg(target_os = "windows")]
fn ensure_single_instance_windows() -> bool {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *mut std::ffi::c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn CreateEventW(
            lpEventAttributes: *mut std::ffi::c_void,
            bManualReset: i32,
            bInitialState: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn SetEvent(hEvent: *mut std::ffi::c_void) -> i32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
        fn GetLastError() -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn AllowSetForegroundWindow(dwProcessId: u32) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let mutex_name = wide("Local\\JeikCode_Desktop_SingleInstance_Mutex");
    let event_name = wide("Local\\JeikCode_Desktop_Activate_Event");
    const ERROR_ALREADY_EXISTS: u32 = 183;
    const ASFW_ANY: u32 = 0xFFFF_FFFF;

    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, mutex_name.as_ptr()) };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
            // 触发激活命名事件，由主实例主线程规范执行窗口还原与激活，
            // 绝不在外部进程跨进程直接调用 ShowWindow 篡改 HWND 导致 tao 内部 WindowFlags 失步。
            let ev = CreateEventW(std::ptr::null_mut(), 0, 0, event_name.as_ptr());
            if !ev.is_null() {
                SetEvent(ev);
                CloseHandle(ev);
            }
        }
        return true;
    }
    let _ = handle;
    false
}

#[cfg(target_os = "windows")]
fn spawn_single_instance_activation_listener(window: tauri::WebviewWindow) {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateEventW(
            lpEventAttributes: *mut std::ffi::c_void,
            bManualReset: i32,
            bInitialState: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(hHandle: *mut std::ffi::c_void, dwMilliseconds: u32) -> u32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
    }

    let event_name: Vec<u16> = std::ffi::OsStr::new("Local\\JeikCode_Desktop_Activate_Event")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ev = unsafe { CreateEventW(std::ptr::null_mut(), 0, 0, event_name.as_ptr()) };
    if ev.is_null() {
        return;
    }
    let ev_addr = ev as usize;
    let window_for_thread = window.clone();
    std::thread::spawn(move || {
        let handle = ev_addr as *mut std::ffi::c_void;
        const WAIT_OBJECT_0: u32 = 0;
        loop {
            if DESKTOP_SHUTTING_DOWN.load(Ordering::SeqCst) {
                break;
            }
            let rc = unsafe { WaitForSingleObject(handle, 400) };
            if rc == WAIT_OBJECT_0 {
                // 必须调度到主事件循环线程执行还原与聚焦，确保 tao 内部 WindowFlags::VISIBLE 100% 同步恢复
                let win = window_for_thread.clone();
                let _ = window_for_thread.run_on_main_thread(move || {
                    show_main_window(&win);
                });
            }
        }
        unsafe {
            CloseHandle(handle);
        }
    });
}

fn desktop_settings_path() -> PathBuf {
    jeikcode_dir().join("desktop-settings.json")
}

/// Persist ONE field without clobbering the rest of `desktop-settings.json`.
///
/// The daemon owns `agent_mode_policy` / `agent_global_mode` in the same file.
/// The old native handler rewrote the whole document with only `close_action`,
/// so choosing "remember my choice" on the close prompt silently erased the
/// global Agent mode policy — the setting then snapped back after a refresh or
/// restart. Read-modify-write keeps native and daemon writers convergent.
fn save_close_action(action: &str) {
    let path = desktop_settings_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    root.insert(
        "close_action".to_string(),
        serde_json::Value::String(action.to_string()),
    );
    let body = serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .unwrap_or_else(|_| "{}".to_string());
    // Atomic replace so the daemon never reads a half-written document.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn load_close_action() -> String {
    let Ok(text) = std::fs::read_to_string(desktop_settings_path()) else {
        return "ask".to_string();
    };
    #[derive(serde::Deserialize)]
    struct Settings {
        #[serde(default)]
        close_action: Option<String>,
    }
    serde_json::from_str::<Settings>(&text)
        .ok()
        .and_then(|s| s.close_action)
        .unwrap_or_else(|| "ask".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellSettings {
    autostart: bool,
    toggle_shortcut: String,
    hide_taskbar_icon: bool,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            autostart: false,
            toggle_shortcut: "Ctrl+Alt+J".to_string(),
            hide_taskbar_icon: false,
        }
    }
}

/// Read the OS-level fields; a missing/blank shortcut means "disabled".
///
/// A missing file is a meaningful "defaults" state, but a transient read or
/// parse failure is not: the watcher must keep the last applied snapshot
/// instead of flapping autostart/shortcut/taskbar on one bad tick.
fn load_shell_settings_opt() -> Option<ShellSettings> {
    let text = match std::fs::read_to_string(desktop_settings_path()) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Some(ShellSettings::default());
        }
        Err(_) => return None,
    };
    let root = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let defaults = ShellSettings::default();
    Some(ShellSettings {
        autostart: root
            .get("autostart")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(defaults.autostart),
        toggle_shortcut: root
            .get("toggle_shortcut")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or(defaults.toggle_shortcut.as_str())
            .to_string(),
        hide_taskbar_icon: root
            .get("hide_taskbar_icon")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(defaults.hide_taskbar_icon),
    })
}

fn load_shell_settings() -> ShellSettings {
    load_shell_settings_opt().unwrap_or_default()
}

/// 生成 Windows 注册表自启命令行：可执行文件路径加双引号并固定附带 `--minimized`。
fn windows_autostart_command_line(exe_path: &Path) -> String {
    let raw = exe_path.to_string_lossy();
    let clean = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    format!("\"{clean}\" --minimized")
}

#[cfg(target_os = "windows")]
fn apply_autostart_windows(enabled: bool) -> Result<(), String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const HKEY_CURRENT_USER: isize = -2147483647i32 as isize;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegCreateKeyExW(
            hKey: isize,
            lpSubKey: *const u16,
            Reserved: u32,
            lpClass: *const u16,
            dwOptions: u32,
            samDesired: u32,
            lpSecurityAttributes: *const std::ffi::c_void,
            phkResult: *mut isize,
            lpdwDisposition: *mut u32,
        ) -> i32;
        fn RegOpenKeyExW(
            hKey: isize,
            lpSubKey: *const u16,
            ulOptions: u32,
            samDesired: u32,
            phkResult: *mut isize,
        ) -> i32;
        fn RegQueryValueExW(
            hKey: isize,
            lpValueName: *const u16,
            lpReserved: *mut u32,
            lpType: *mut u32,
            lpData: *mut u8,
            lpcbData: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            hKey: isize,
            lpValueName: *const u16,
            Reserved: u32,
            dwType: u32,
            lpData: *const u8,
            cbData: u32,
        ) -> i32;
        fn RegDeleteValueW(hKey: isize, lpValueName: *const u16) -> i32;
        fn RegCloseKey(hKey: isize) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let value_name = wide("JeikCode Desktop");

    if !enabled {
        let mut hkey: isize = 0;
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            )
        };
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if rc != ERROR_SUCCESS {
            return Err(format!("RegOpenKeyExW failed ({rc})"));
        }
        let del_rc = unsafe { RegDeleteValueW(hkey, value_name.as_ptr()) };
        unsafe {
            RegCloseKey(hkey);
        }
        if del_rc != ERROR_SUCCESS && del_rc != ERROR_FILE_NOT_FOUND {
            return Err(format!("RegDeleteValueW failed ({del_rc})"));
        }
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let expected = windows_autostart_command_line(&exe);

    let mut hkey: isize = 0;
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyExW failed ({rc})"));
    }

    let mut reg_type: u32 = 0;
    let mut byte_len: u32 = 0;
    let q_rc = unsafe {
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut reg_type,
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    let already_matches = if q_rc == ERROR_SUCCESS && reg_type == REG_SZ && byte_len >= 2 {
        let mut buf = vec![0u8; byte_len as usize];
        let q2_rc = unsafe {
            RegQueryValueExW(
                hkey,
                value_name.as_ptr(),
                std::ptr::null_mut(),
                &mut reg_type,
                buf.as_mut_ptr(),
                &mut byte_len,
            )
        };
        if q2_rc == ERROR_SUCCESS {
            let u16s: Vec<u16> = buf[..byte_len as usize]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&v| v != 0)
                .collect();
            let current = std::ffi::OsString::from_wide(&u16s)
                .to_string_lossy()
                .into_owned();
            current == expected
        } else {
            false
        }
    } else {
        false
    };

    if already_matches {
        unsafe {
            RegCloseKey(hkey);
        }
        return Ok(());
    }

    let data = wide(&expected);
    let data_bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let s_rc = unsafe {
        RegSetValueExW(
            hkey,
            value_name.as_ptr(),
            0,
            REG_SZ,
            data_bytes.as_ptr(),
            data_bytes.len() as u32,
        )
    };
    unsafe {
        RegCloseKey(hkey);
    }
    if s_rc != ERROR_SUCCESS {
        return Err(format!("RegSetValueExW failed ({s_rc})"));
    }
    Ok(())
}

fn apply_autostart(app: &tauri::AppHandle, enabled: bool) {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        if let Err(error) = apply_autostart_windows(enabled) {
            eprintln!("[desktop] autostart apply failed: {error}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let autolaunch = app.autolaunch();
        let current = autolaunch.is_enabled().unwrap_or(false);
        let result = if enabled && !current {
            autolaunch.enable()
        } else if !enabled && current {
            autolaunch.disable()
        } else {
            Ok(())
        };
        if let Err(error) = result {
            eprintln!("[desktop] autostart apply failed: {error}");
        }
    }
}

fn apply_toggle_shortcut(app: &tauri::AppHandle, accelerator: &str) {
    let manager = app.global_shortcut();
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        let _ = manager.unregister_all();
        return;
    }
    match trimmed.parse::<Shortcut>() {
        Ok(shortcut) => {
            // Parse first: an invalid edit must not tear down the working shortcut.
            let _ = manager.unregister_all();
            if let Err(error) = manager.register(shortcut) {
                eprintln!("[desktop] global shortcut registration failed ({trimmed}): {error}");
            }
        }
        Err(error) => {
            eprintln!("[desktop] invalid global shortcut `{trimmed}`: {error}");
        }
    }
}

/// Poll the shared settings file (saved by ANY WebUI instance via the daemon)
/// and apply OS-level changes on the UI thread. One-second cadence, one small
/// file — no busy loop and no cross-instance event plumbing needed.
fn watch_desktop_shell_settings(app: tauri::AppHandle, mut applied: ShellSettings) {
    std::thread::spawn(move || {
        let path = desktop_settings_path();
        // Skip the JSON read unless the watcher actually saw a write. The
        // daemon replaces the file atomically, so a changed mtime is a
        // reliable trigger and an idle app stays off the disk.
        let mut last = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let current = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok();
            if current == last {
                continue;
            }
            last = current;
            let Some(settings) = load_shell_settings_opt() else {
                // Transient read/parse failure: keep the last applied snapshot.
                continue;
            };
            if settings == applied {
                continue;
            }
            let previous = applied.clone();
            applied = settings.clone();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if settings.autostart != previous.autostart {
                    apply_autostart(&handle, settings.autostart);
                }
                if settings.toggle_shortcut != previous.toggle_shortcut {
                    apply_toggle_shortcut(&handle, &settings.toggle_shortcut);
                }
                if settings.hide_taskbar_icon != previous.hide_taskbar_icon {
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(error) = window.set_skip_taskbar(settings.hide_taskbar_icon) {
                            eprintln!("[desktop] skip taskbar update failed: {error}");
                        }
                    }
                }
            });
        }
    });
}

fn main() {
    #[cfg(target_os = "windows")]
    if ensure_single_instance_windows() {
        return;
    }

    let child = Mutex::new(None);
    let webui_origin_slot = Arc::new(Mutex::new(None));
    let start_minimized = std::env::args().any(|arg| arg == "--minimized");
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(ChildSlot(child))
        .manage(WebuiOriginSlot(Arc::clone(&webui_origin_slot)))
        .manage(PendingDesktopUpdate(tokio::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            desktop_shell_info,
            start_desktop_shell_update,
            install_desktop_shell_update,
        ])
        .setup(move |app| {
            let settings = load_shell_settings();
            let webui_origin = Arc::clone(&webui_origin_slot);
            let nav_origin = Arc::clone(&webui_origin);
            let nav_app_handle = app.handle().clone();
            let new_win_app_handle = app.handle().clone();
            let window_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("JeikCode Desktop")
            .initialization_script(r#"
                (() => {
                    const start = () => {
                        const root = document.documentElement;
                        if (!root) return;
                        let last;
                        const sync = () => {
                            // No persisted choice yet => follow the OS. An explicit
                            // light/dark/system preference always wins.
                            const preference = root.getAttribute('data-theme-preference');
                            const theme = ['light', 'dark', 'system'].includes(preference)
                                ? preference : 'system';
                            if (theme === last) return;
                            last = theme;
                            // The WebUI (webui/src/settings.tsx) owns the `data-theme-preference`
                            // contract. Use the built-in window command so the capability's
                            // `core:window:allow-set-theme` permission covers remote origins too.
                            const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
                            if (!invoke) return;
                            invoke('plugin:window|set_theme', { value: theme === 'system' ? null : theme }).catch(() => {
                                if (last === theme) last = undefined;
                            });
                        };
                        new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme-preference'] });
                        sync();
                    };
                    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
                    else start();
                })();
            "#)
            .inner_size(1280.0, 800.0)
            .resizable(true)
            .skip_taskbar(settings.hide_taskbar_icon)
            // Autostart must never flash: the window is created hidden and only
            // shown for a normal (non `--minimized`) launch or a tray/shortcut
            // warm-open. The WebView still loads in the background either way.
            .visible(false)
            .on_navigation(move |url| {
                if handle_desktop_shell_action(url, &nav_app_handle) {
                    return false;
                }
                let action = {
                    let guard = nav_origin.lock().unwrap_or_else(|e| e.into_inner());
                    navigation_action(url, guard.as_ref())
                };
                match action {
                    LinkAction::StayInWebview => {
                        if !is_shell_internal_url(url) {
                            remember_webui_origin(&nav_origin, url.as_str());
                        }
                        true
                    }
                    LinkAction::OpenExternal => {
                        open_in_external_browser(&external_browser_url(url));
                        false
                    }
                }
            })
            .on_new_window(move |url, _features| {
                if handle_desktop_shell_action(&url, &new_win_app_handle) {
                    return tauri::webview::NewWindowResponse::Deny;
                }
                if new_window_action(&url) == LinkAction::OpenExternal {
                    open_in_external_browser(&external_browser_url(&url));
                }
                tauri::webview::NewWindowResponse::Deny
            });
            // Windows 上有两套原生放置目标，都会把「不是系统文件」的拖放写成 DROPEFFECT_NONE，
            // 光标就是禁止。disable_drag_drop_handler / tauri.conf.json 的 dragDropEnabled
            // 只卸 WebView2 那一套；窗口自己的 FileDropHandler 还在，应用内拖文件树、标签照样被禁。
            // 两套都关掉，拖放才进页面里的 HTML5。
            #[cfg(target_os = "windows")]
            let window_builder = window_builder.disable_drag_drop_handler().drag_and_drop(false);
            let window = window_builder.build()?;
            if !start_minimized {
                let _ = window.show();
            }

            #[cfg(target_os = "windows")]
            spawn_single_instance_activation_listener(window.clone());

            watch_host_presence(window.clone());
            let drop_window = window.clone();
            let close_window = window.clone();
            let hide_window = window.clone();
            let app_handle_for_event = app.handle().clone();
            let app_handle_for_close = app.handle().clone();

            let _ = window.listen("jeikcode:desktop:hide_to_tray", move |_| {
                hide_window_to_tray(&hide_window);
            });

            let _ = window.listen("jeikcode:desktop:quit_app", move |_| {
                terminate_managed_child(&app_handle_for_event);
                app_handle_for_event.exit(0);
            });

            let last_close_time = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));
            let last_close_for_event = Arc::clone(&last_close_time);

            // 窗口关闭拦截与 HTML5 拖放事件处理
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let action = load_close_action();
                    match action.as_str() {
                        "tray" => {
                            api.prevent_close();
                            hide_window_to_tray(&close_window);
                        }
                        "quit" => {
                            terminate_managed_child(&app_handle_for_close);
                        }
                        _ => {
                            api.prevent_close();
                            // 连点容错兜底：若 1.2 秒内再次点击 X，说明弹窗未能正常捕获或用户强行关闭，立即最小化到托盘
                            let mut last = last_close_for_event
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            let now = Instant::now();
                            if now.duration_since(*last) < Duration::from_millis(1200) {
                                *last = now - Duration::from_secs(10);
                                hide_window_to_tray(&close_window);
                            } else {
                                *last = now;
                                let _ = close_window.eval(
                                    "window.dispatchEvent(new CustomEvent('jeikcode:desktop:close_prompt'));",
                                );
                            }
                        }
                    }
                }
                if let tauri::WindowEvent::DragDrop(drop_event) = event {
                    if let tauri::DragDropEvent::Drop { paths, .. } = drop_event {
                        for path in paths {
                            let p_str = path.to_string_lossy().replace('\\', "/");
                            let json_path = serde_json::to_string(&p_str).unwrap_or_default();
                            let script = format!(
                                "window.dispatchEvent(new CustomEvent('jeikcode:switch_right_tab', {{ detail: 'preview' }}));\
                                 window.dispatchEvent(new CustomEvent('jeikcode:preview:open_file', {{ detail: {{ filePath: {json_path} }} }}));\
                                 window.dispatchEvent(new CustomEvent('jeikcode:open_file', {{ detail: {{ path: {json_path} }} }}));"
                            );
                            let _ = drop_window.eval(&script);
                        }
                    }
                }
            });
            setup_system_tray(app).expect("初始化系统托盘图标失败");
            apply_autostart(app.handle(), settings.autostart);
            apply_toggle_shortcut(app.handle(), &settings.toggle_shortcut);
            watch_desktop_shell_settings(app.handle().clone(), settings);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match start_webui(&handle) {
                    Ok((url, child, eof_rx, launch)) => {
                        if let Some(slot) = handle.try_state::<ChildSlot>() {
                            *slot.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
                        }
                        // 必须先记下地址再导航，否则这次 WebUI 会被当成外链弹出浏览器。
                        remember_webui_origin(&webui_origin, &url);
                        let _ = window.navigate(
                            url.parse()
                                .unwrap_or_else(|_| "about:blank".parse().expect("about:blank")),
                        );
                        supervise_webui(
                            handle.clone(),
                            window.clone(),
                            webui_origin.clone(),
                            eof_rx,
                            launch,
                        );
                    }
                    Err(err) => {
                        let text =
                            serde_json::to_string(&err).unwrap_or_else(|_| "\"启动失败\"".into());
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
                terminate_managed_child(app);
            }
        });
}

struct TrayTexts {
    tooltip: &'static str,
    show_window: &'static str,
    quit: &'static str,
}

fn resolve_tray_texts() -> TrayTexts {
    let lang = detect_user_language();
    if lang.starts_with("zh") {
        TrayTexts {
            tooltip: "JeikCode Desktop - AI 编程助手",
            show_window: "显示主界面",
            quit: "退出",
        }
    } else if lang.starts_with("vi") {
        TrayTexts {
            tooltip: "JeikCode Desktop - Trợ lý lập trình AI",
            show_window: "Hiển thị giao diện",
            quit: "Thoát",
        }
    } else {
        TrayTexts {
            tooltip: "JeikCode Desktop - AI Coding Agent",
            show_window: "Show Window",
            quit: "Quit",
        }
    }
}

fn detect_user_language() -> String {
    let config_path = jeikcode_dir().join("config.toml");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("language") {
                let rest = rest.trim_start();
                if let Some(val) = rest.strip_prefix('=') {
                    let clean = val
                        .trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .trim()
                        .to_lowercase();
                    if !clean.is_empty() {
                        return clean;
                    }
                }
            }
        }
    }

    for var in ["JEIKCODE_LANGUAGE", "JEIKCODE_LANG", "LANG", "LC_ALL"] {
        if let Ok(val) = std::env::var(var) {
            let val = val.trim().to_lowercase();
            if !val.is_empty() {
                return val;
            }
        }
    }

    #[cfg(windows)]
    {
        if let Ok(hkcu) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey("Control Panel\\International")
        {
            if let Ok(locale_name) = hkcu.get_value::<String, _>("LocaleName") {
                return locale_name.to_lowercase();
            }
        }
    }

    "en".to_string()
}

fn setup_system_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let texts = resolve_tray_texts();
    let show_item = MenuItemBuilder::with_id("show", texts.show_window).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", texts.quit).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("未在 tauri.conf.json 中找到应用默认图标");

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip(texts.tooltip)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(&window);
                }
            }
            "quit" => {
                terminate_managed_child(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_main_window(app);
            }
        })
        .build(app)?;

    Ok(())
}

struct ChildSlot(Mutex<Option<std::process::Child>>);

struct WebuiOriginSlot(Arc<Mutex<Option<WebuiOrigin>>>);

struct PendingDesktopUpdate(tokio::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellInfo {
    shell_version: String,
    bundle_type: String,
    updater_supported: bool,
    signed_updater_ready: bool,
}

fn detect_bundle_type() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "nsis"
    }
    #[cfg(target_os = "macos")]
    {
        "app"
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else {
            "deb"
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

fn configured_updater_pubkey(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn authorized_webview_url(url: &tauri::Url, origin: Option<&WebuiOrigin>) -> bool {
    is_shell_internal_url(url) || origin.is_some_and(|o| is_launched_webui(url, o))
}

fn ensure_authorized_webview(
    webview: &tauri::Webview,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|e| format!("无法获取当前窗口地址: {e}"))?;
    let slot = app.state::<WebuiOriginSlot>();
    let guard = slot.0.lock().unwrap_or_else(|e| e.into_inner());
    if authorized_webview_url(&url, guard.as_ref()) {
        Ok(())
    } else {
        Err("仅允许当前托管的本地 WebUI 窗口调用桌面更新命令".to_string())
    }
}

fn compare_shell_versions(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> (Vec<u64>, Option<Vec<String>>) {
        let clean = v.trim().trim_start_matches('v').trim_start_matches('V');
        if let Some((main_part, pre_part)) = clean.split_once('-') {
            let nums: Vec<u64> = main_part
                .split('.')
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            let pre = pre_part
                .split('.')
                .map(|s| s.to_ascii_lowercase())
                .collect();
            (nums, Some(pre))
        } else {
            let nums: Vec<u64> = clean
                .split('.')
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            (nums, None)
        }
    };
    let (l_nums, l_pre) = parse(latest);
    let (c_nums, c_pre) = parse(current);
    for i in 0..l_nums.len().max(c_nums.len()) {
        let l = l_nums.get(i).copied().unwrap_or(0);
        let c = c_nums.get(i).copied().unwrap_or(0);
        if l != c {
            return l > c;
        }
    }
    match (l_pre, c_pre) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => false,
        (Some(lp), Some(cp)) => {
            for i in 0..lp.len().max(cp.len()) {
                match (lp.get(i), cp.get(i)) {
                    (None, Some(_)) => return false,
                    (Some(_), None) => return true,
                    (Some(a), Some(b)) if a != b => {
                        return match (a.parse::<u64>(), b.parse::<u64>()) {
                            (Ok(na), Ok(nb)) => na > nb,
                            (Ok(_), Err(_)) => false,
                            (Err(_), Ok(_)) => true,
                            (Err(_), Err(_)) => a > b,
                        };
                    }
                    _ => {}
                }
            }
            false
        }
    }
}

fn resolve_proxy_url(explicit: Option<String>) -> Option<url::Url> {
    let candidate = explicit
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            for key in [
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "HTTP_PROXY",
                "http_proxy",
            ] {
                if let Ok(val) = std::env::var(key) {
                    let trimmed = val.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
            None
        })?;
    let normalized = if candidate.contains("://") {
        candidate
    } else {
        format!("http://{candidate}")
    };
    url::Url::parse(&normalized).ok()
}

fn emit_desktop_update_event(app: &tauri::AppHandle, payload: serde_json::Value) {
    if let Some(window) = app.get_webview_window("main") {
        let json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('jeikcode:desktop:update_progress', {{ detail: {json} }}));"
        ));
    }
}

#[tauri::command]
fn desktop_shell_info(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<DesktopShellInfo, String> {
    ensure_authorized_webview(&webview, &app)?;
    let bundle = detect_bundle_type();
    Ok(DesktopShellInfo {
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
        bundle_type: bundle.to_string(),
        updater_supported: bundle != "deb" && bundle != "unknown",
        signed_updater_ready: configured_updater_pubkey(&app).is_some(),
    })
}

#[tauri::command]
async fn start_desktop_shell_update(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    endpoint: String,
    proxy: Option<String>,
) -> Result<String, String> {
    ensure_authorized_webview(&webview, &app)?;
    let Some(pubkey) = configured_updater_pubkey(&app) else {
        return Err("updater_unsigned".to_string());
    };
    let url = url::Url::parse(endpoint.trim())
        .map_err(|e| format!("无效的桌面更新清单地址 '{}': {e}", endpoint))?;

    let mut builder = webview
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?;
    if let Some(proxy_url) = resolve_proxy_url(proxy) {
        builder = builder.proxy(proxy_url);
    }

    let app_for_exit = app.clone();
    builder = builder
        .version_comparator(|current, release| {
            compare_shell_versions(&release.version.to_string(), &current.to_string())
        })
        .on_before_exit(move || {
            // 安装器接管前优雅停掉托管的 jeikcode 子进程并释放端口，避免阻塞或误触发崩溃自愈
            terminate_managed_child(&app_for_exit);
            app_for_exit.cleanup_before_exit();
        });

    let updater = builder
        .build()
        .map_err(|e| format!("构建桌面更新器失败: {e}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("检查桌面端更新失败: {e}"))?
    else {
        return Err("already_latest".to_string());
    };

    let target_version = update.version.clone();
    emit_desktop_update_event(
        &app,
        serde_json::json!({
            "status": "downloading",
            "progress": 0,
            "bytes": 0,
            "total": 0,
            "version": target_version,
        }),
    );

    let app_progress = app.clone();
    let app_finish = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_pct: i32 = -1;
    let bytes = update
        .download(
            move |chunk_len, content_len| {
                downloaded = downloaded.saturating_add(chunk_len as u64);
                let total = content_len.unwrap_or(0);
                let pct = if total > 0 {
                    ((downloaded * 100) / total).min(100) as i32
                } else {
                    0
                };
                if pct != last_pct {
                    last_pct = pct;
                    emit_desktop_update_event(
                        &app_progress,
                        serde_json::json!({
                            "status": "downloading",
                            "progress": pct,
                            "bytes": downloaded,
                            "total": total,
                        }),
                    );
                }
            },
            move || {
                emit_desktop_update_event(
                    &app_finish,
                    serde_json::json!({
                        "status": "installing",
                        "progress": 100,
                    }),
                );
            },
        )
        .await
        .map_err(|e| {
            let msg = format!("下载或校验桌面端安装包失败: {e}");
            emit_desktop_update_event(
                &app,
                serde_json::json!({
                    "status": "error",
                    "progress": 0,
                    "error": msg,
                }),
            );
            msg
        })?;

    let pending = app.state::<PendingDesktopUpdate>();
    *pending.0.lock().await = Some((update, bytes));

    emit_desktop_update_event(
        &app,
        serde_json::json!({
            "status": "ready",
            "progress": 100,
            "version": target_version,
        }),
    );

    Ok(target_version)
}

#[tauri::command]
async fn install_desktop_shell_update(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<(), String> {
    ensure_authorized_webview(&webview, &app)?;
    let pending = app.state::<PendingDesktopUpdate>();
    let taken = pending.0.lock().await.take();
    let Some((update, bytes)) = taken else {
        return Err("没有已就绪的桌面端更新包".to_string());
    };

    // 先标记关停并退出托管子进程，确保安装器覆盖文件时不锁句柄、不触发 supervise_webui 重拉
    terminate_managed_child(&app);

    update
        .install(&bytes)
        .map_err(|e| format!("安装桌面端更新失败: {e}"))?;

    #[cfg(not(windows))]
    app.restart();

    #[cfg(windows)]
    Ok(())
}

struct WebuiLaunch {
    bin: PathBuf,
    host: String,
    port: u16,
    token: String,
    home: PathBuf,
    bundled: Option<PathBuf>,
    signed_updater_ready: bool,
}

fn start_webui(
    app: &tauri::AppHandle,
) -> Result<
    (
        String,
        std::process::Child,
        std::sync::mpsc::Receiver<()>,
        WebuiLaunch,
    ),
    String,
> {
    let bundled = bundled_cli(app);
    let bin = resolve_desktop_cli(bundled.as_deref());
    let home = home_dir();
    let (host, port, saved_token) = saved_webui_listen();
    let token = saved_token.unwrap_or_else(|| mint_desktop_token(&host, port));
    let mut launch = WebuiLaunch {
        bin,
        host,
        port,
        token,
        home,
        bundled,
        signed_updater_ready: configured_updater_pubkey(app).is_some(),
    };
    let (url, child, eof_rx) = spawn_desktop_server(&launch, false, Duration::from_secs(90))?;
    let probe_port = url
        .parse::<tauri::Url>()
        .ok()
        .and_then(|parsed| parsed.port())
        .unwrap_or(launch.port);
    if probe_port != launch.port {
        launch.port = probe_port;
        let dir = jeikcode_dir();
        let _ = std::fs::create_dir_all(&dir);
        let body = format!(
            "{{\n  \"host\": \"{}\",\n  \"port\": {probe_port},\n  \"token\": \"{}\"\n}}\n",
            launch.host, launch.token
        );
        let _ = std::fs::write(dir.join("webui-listen.json"), body);
    }
    Ok((url, child, eof_rx, launch))
}

#[cfg(windows)]
fn assign_child_to_desktop_job(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(
            lpJobAttributes: *mut std::ffi::c_void,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn SetInformationJobObject(
            hJob: *mut std::ffi::c_void,
            JobObjectInfoClass: u32,
            lpJobObjectInfo: *const std::ffi::c_void,
            cbJobObjectInfoLength: u32,
        ) -> i32;
        fn AssignProcessToJobObject(
            hJob: *mut std::ffi::c_void,
            hProcess: *mut std::ffi::c_void,
        ) -> i32;
    }

    static JOB_HANDLE: OnceLock<usize> = OnceLock::new();
    let job_ptr = *JOB_HANDLE.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
        const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x0000_0800;

        let mut info = JobObjectExtendedLimitInformation::default();
        info.basic_limit_information.limit_flags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let _ = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        );
        job as usize
    });

    if job_ptr != 0 {
        unsafe {
            let _ = AssignProcessToJobObject(
                job_ptr as *mut std::ffi::c_void,
                child.as_raw_handle() as *mut std::ffi::c_void,
            );
        }
    }
}

#[cfg(not(windows))]
fn assign_child_to_desktop_job(_child: &std::process::Child) {}

fn spawn_desktop_server(
    launch: &WebuiLaunch,
    exact_port: bool,
    url_timeout: Duration,
) -> Result<(String, std::process::Child, std::sync::mpsc::Receiver<()>), String> {
    let mut cmd = Command::new(&launch.bin);
    cmd.arg("webui")
        .arg("--host")
        .arg(&launch.host)
        .arg("--port")
        .arg(launch.port.to_string())
        .arg("--no-open")
        .arg("--token")
        .arg(&launch.token);
    cmd.env("JEIKCODE_DESKTOP", "1");
    cmd.env("JEIKCODE_DESKTOP_MANAGED", "1");
    cmd.env("JEIKCODE_DESKTOP_PID", std::process::id().to_string());
    cmd.env("JEIKCODE_DESKTOP_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env("JEIKCODE_DESKTOP_BUNDLE", detect_bundle_type());
    cmd.env("JEIKCODE_DESKTOP_UPDATER", "1");
    cmd.env(
        "JEIKCODE_DESKTOP_UPDATER_SIGNED",
        if launch.signed_updater_ready {
            "1"
        } else {
            "0"
        },
    );
    if exact_port {
        // 与 jeikcode-updater 的同名变量一致：只绑定这个端口，不顺延，也不关闭别的进程。
        cmd.env("JEIKCODE_RESTART_EXACT_PORT", "1");
        cmd.env("JEIKCODE_RESTART_LISTEN_PORT", launch.port.to_string());
    }
    if let Some(ref bundled) = launch.bundled {
        cmd.env("JEIKCODE_DESKTOP_CLI_BIN", bundled);
    }
    // 开启 stdin 管道作为跨平台生命线（ChildSlot 持有 ChildStdin 写端；一旦桌面壳退出，
    // OS 内核立即关闭管道，子进程阻塞 read 瞬间收到 EOF 退出，0 轮询）。
    cmd.current_dir(&launch.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    suppress_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {}：{e}", launch.bin.display()))?;
    assign_child_to_desktop_job(&child);
    let stderr = child.stderr.take();
    let (url_result, eof_rx) = match stderr {
        Some(pipe) => read_url(pipe, url_timeout),
        None => {
            let (_tx, rx) = std::sync::mpsc::channel();
            (Ok(None), rx)
        }
    };
    let mut url = match url_result {
        Ok(Some(url)) => url,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("jeikcode webui 没有打印出地址".to_string());
        }
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };
    if !url.contains("desktop=") {
        let separator = if url.contains('?') { "&" } else { "?" };
        url.push_str(&format!("{separator}desktop=1"));
    }
    // The process listens on 0.0.0.0. This window is on this computer, so it
    // opens 127.0.0.1. Other devices use the LAN addresses in the panel.
    url = window_url(&url);
    let probe_port = url
        .parse::<tauri::Url>()
        .ok()
        .and_then(|parsed| parsed.port())
        .unwrap_or(launch.port);
    let ready_deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < ready_deadline && !health_ready(probe_port) {
        std::thread::sleep(Duration::from_millis(40));
    }
    Ok((url, child, eof_rx))
}

/// 纯事件驱动的子进程监管（0 轮询、0 死循环）：
/// 线程平时完全阻塞在子进程 `stderr` 管道的内核 EOF 信号（`eof_rx.recv()`）上，0% CPU 占用；
/// 仅当子进程因「自更新升级」或「小地球修改端口/地址立即重启」以显式退出码 `75` 退出（或首次闪退自愈）时，
/// 才由桌面壳读取最新配置重新拉起并写回 `ChildSlot`，彻底消除状态失步与无限重启死循环。
fn supervise_webui(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    origin: Arc<Mutex<Option<WebuiOrigin>>>,
    mut eof_rx: std::sync::mpsc::Receiver<()>,
    mut launch: WebuiLaunch,
) {
    std::thread::spawn(move || {
        let mut crash_recovered = false;
        loop {
            // 阻塞等待当前子进程退出导致的管道 EOF 事件（0 轮询）
            let _ = eof_rx.recv();
            if DESKTOP_SHUTTING_DOWN.load(Ordering::SeqCst) {
                return;
            }
            let Some(exit_code) = reap_exited_child(&app) else {
                return;
            };
            if DESKTOP_SHUTTING_DOWN.load(Ordering::SeqCst) {
                return;
            }

            let intentional_restart = exit_code == Some(RESTART_REQUESTED_EXIT_CODE);
            if !intentional_restart {
                // 非主动请求重启的异常退出：仅允许最多一次自愈拉起，绝不陷入死循环
                if crash_recovered {
                    return;
                }
                crash_recovered = true;
            } else {
                // 主动重启成功后重置自愈计数
                crash_recovered = false;
            }

            // 动态读取最新配置与二进制路径，由桌面壳直接重新拉起并存入 ChildSlot
            let (latest_host, latest_port, latest_token) = saved_webui_listen();
            let effective_port = if latest_port != 0 {
                latest_port
            } else {
                launch.port
            };
            let effective_token = latest_token.unwrap_or_else(|| launch.token.clone());
            launch.bin = resolve_desktop_cli(launch.bundled.as_deref());
            launch.host = latest_host;
            launch.port = effective_port;
            launch.token = effective_token;

            let spawned = if intentional_restart {
                // 原地重启交接：锁定原端口并支持退避重试，绝不随意误判漂移端口导致异地失联
                let mut res = spawn_desktop_server(&launch, true, Duration::from_secs(30));
                for _ in 0..3 {
                    if res.is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(400));
                    res = spawn_desktop_server(&launch, true, Duration::from_secs(30));
                }
                res
            } else {
                spawn_desktop_server(&launch, true, Duration::from_secs(30))
                    .or_else(|_| spawn_desktop_server(&launch, false, Duration::from_secs(30)))
            };

            match spawned {
                Ok((next_url, child, next_eof_rx)) => {
                    let probe_port = next_url
                        .parse::<tauri::Url>()
                        .ok()
                        .and_then(|parsed| parsed.port())
                        .unwrap_or(launch.port);
                    if probe_port != launch.port {
                        launch.port = probe_port;
                        let dir = jeikcode_dir();
                        let _ = std::fs::create_dir_all(&dir);
                        let body = format!(
                            "{{\n  \"host\": \"{}\",\n  \"port\": {probe_port},\n  \"token\": \"{}\"\n}}\n",
                            launch.host,
                            launch.token
                        );
                        let _ = std::fs::write(dir.join("webui-listen.json"), body);
                    }
                    if let Some(slot) = app.try_state::<ChildSlot>() {
                        *slot.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
                    }
                    eof_rx = next_eof_rx;
                    open_webui_in_shell(&window, &origin, &next_url);
                }
                Err(err) => {
                    let text =
                        serde_json::to_string(&err).unwrap_or_else(|_| "\"重启失败\"".into());
                    let _ = window.eval(&format!(
                        "var status = document.getElementById('status'); if (status) status.textContent = {text};"
                    ));
                    return;
                }
            }
        }
    });
}

fn reap_exited_child(app: &tauri::AppHandle) -> Option<Option<i32>> {
    let slot = app.try_state::<ChildSlot>()?;
    let mut child = slot
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take()?;
    match child.wait() {
        Ok(status) => Some(status.code()),
        Err(_) => Some(None),
    }
}

#[allow(dead_code)]
fn wait_until_health(port: u16, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if DESKTOP_SHUTTING_DOWN.load(Ordering::SeqCst) {
            return false;
        }
        if health_ready(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn open_webui_in_shell(
    window: &tauri::WebviewWindow,
    origin: &Mutex<Option<WebuiOrigin>>,
    url: &str,
) {
    remember_webui_origin(origin, url);
    if let Ok(parsed) = url.parse() {
        let _ = window.navigate(parsed);
    }
}

/// Keep the printed launch address, but open this computer through loopback.
fn window_url(url: &str) -> String {
    let Ok(mut parsed) = url.parse::<tauri::Url>() else {
        return url.to_string();
    };
    let Some(host) = parsed.host_str() else {
        return url.to_string();
    };
    if is_loopback_host(host) {
        return parsed.to_string();
    }
    if parsed.set_host(Some("127.0.0.1")).is_ok() {
        parsed.to_string()
    } else {
        url.to_string()
    }
}

fn bundled_cli(app: &tauri::AppHandle) -> Option<PathBuf> {
    let exe_name = cli_file_name();
    // 1. app.path().resource_dir() 及其 resources 子目录
    if let Ok(dir) = app.path().resource_dir() {
        for candidate in [
            dir.join(exe_name),
            dir.join("resources").join(exe_name),
            dir.join("cli-bin"),
            dir.join("resources").join("cli-bin"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // 2. 当前运行 exe (jeikcode-desktop.exe) 自身所在目录及其 resources 子目录
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            for candidate in [
                parent.join(exe_name),
                parent.join("resources").join(exe_name),
                parent.join("cli-bin"),
                parent.join("resources").join("cli-bin"),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn read_url(
    pipe: impl std::io::Read + Send + 'static,
    timeout: Duration,
) -> (
    Result<Option<String>, String>,
    std::sync::mpsc::Receiver<()>,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    let (eof_tx, eof_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut pending = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    pending.push_str(&line);
                    if let Some(url) = extract_webui_url(&pending) {
                        let _ = tx.send(url);
                        // Dropping stderr here closes the pipe. A later write
                        // then panics twice and aborts the child, so the
                        // window sees connection refused. Drain until exit.
                        let mut extra = String::new();
                        loop {
                            extra.clear();
                            match reader.read_line(&mut extra) {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {}
                            }
                        }
                        break;
                    }
                }
            }
        }
        // 子进程已退出，stderr 管道关闭（EOF），立即事件通知 supervise_webui
        let _ = eof_tx.send(());
    });
    let res = match rx.recv_timeout(timeout) {
        Ok(url) => Ok(Some(url)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("等待 WebUI 启动超时".into()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(None),
    };
    (res, eof_rx)
}

pub fn extract_webui_url(text: &str) -> Option<String> {
    let start = text.find("http://").or_else(|| text.find("https://"))?;
    let rest = &text[start..];
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(|c: char| matches!(c, ')' | '。' | '，' | '"' | '\''));
    url.contains("token=").then(|| url.to_string())
}

fn health_ready(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 80];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

fn mint_desktop_token(host: &str, port: u16) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let token = format!("sk-{:x}-{:x}", std::process::id(), nanos);
    let dir = jeikcode_dir();
    let _ = std::fs::create_dir_all(&dir);
    let body =
        format!("{{\n  \"host\": \"{host}\",\n  \"port\": {port},\n  \"token\": \"{token}\"\n}}\n");
    let _ = std::fs::write(dir.join("webui-listen.json"), body);
    token
}

fn resolve_desktop_cli(bundled: Option<&Path>) -> PathBuf {
    // 同步执行老版本残留迁移清理（立即清理 ~/.local/bin 并注册当前安装目录到 PATH）
    cleanup_legacy_dropper_install();

    if let Some(src) = bundled {
        set_executable(src);
        return src.to_path_buf();
    }

    // 开发环境或 fallback：尝试同级可执行文件、resources 子目录或 PATH
    let name = cli_file_name();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for candidate in [
                parent.join(name),
                parent.join("resources").join(name),
                parent.join("cli-bin"),
                parent.join("resources").join("cli-bin"),
            ] {
                if candidate.is_file() {
                    set_executable(&candidate);
                    return candidate;
                }
            }
        }
    }
    PathBuf::from(name)
}

#[cfg(windows)]
fn cleanup_legacy_dropper_install() {
    let local_bin = home_dir().join(".local").join("bin");
    if let Ok(entries) = std::fs::read_dir(&local_bin) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if name.starts_with("jeikcode") || name.starts_with("atomcode") {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
    let _ = std::fs::remove_dir(&local_bin);

    use winreg::enums::*;
    use winreg::RegKey;
    let Ok(env) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
    else {
        return;
    };
    let current: String = env.get_value("Path").unwrap_or_default();
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let mut parts: Vec<String> = current
        .split(';')
        .filter(|p| {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                return false;
            }
            let lower = trimmed.to_ascii_lowercase();
            if lower.contains(".local\\bin")
                || lower.contains(".local/bin")
                || lower.contains("atomcode")
            {
                return false;
            }
            true
        })
        .map(|s| s.to_string())
        .collect();

    if let Some(dir) = install_dir {
        let dir_str = dir.display().to_string();
        let res_dir = dir.join("resources");
        if res_dir.is_dir() {
            let res_str = res_dir.display().to_string();
            if !parts
                .iter()
                .any(|p| p.trim().eq_ignore_ascii_case(&res_str))
            {
                parts.insert(0, res_str);
            }
        }
        if !parts
            .iter()
            .any(|p| p.trim().eq_ignore_ascii_case(&dir_str))
        {
            parts.insert(0, dir_str);
        }
    }

    let new_path = parts.join(";");
    if new_path != current {
        let _ = env.set_value("Path", &new_path);
        broadcast_env_change();
    }
}

#[cfg(windows)]
fn broadcast_env_change() {
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: *mut std::ffi::c_void,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }
    use std::os::windows::ffi::OsStrExt;
    let env_wide: Vec<u16> = std::ffi::OsStr::new("Environment")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let hwnd_broadcast = 0xffff as *mut std::ffi::c_void;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    let mut res = 0;
    unsafe {
        SendMessageTimeoutW(
            hwnd_broadcast,
            WM_SETTINGCHANGE,
            0,
            env_wide.as_ptr(),
            SMTO_ABORTIFHUNG,
            5000,
            &mut res,
        );
    }
}

#[cfg(not(windows))]
fn cleanup_legacy_dropper_install() {
    let legacy_bin = home_dir().join(".local").join("bin").join("jeikcode");
    if legacy_bin.is_file() {
        // 如果是孤儿残留且非当前运行程序，移除避免旧版本优先命中
        let _ = std::fs::remove_file(&legacy_bin);
    }
}

fn cli_file_name() -> &'static str {
    if cfg!(windows) {
        "jeikcode.exe"
    } else {
        "jeikcode"
    }
}

const DEFAULT_LISTEN_HOST: &str = "127.0.0.1";
const WEBUI_DEFAULT_PORT: u16 = 13457;

/// `~/.jeikcode/webui-listen.json` written by the remote-access panel.
/// Defaults to 127.0.0.1 and port 13457; supports user customized host (e.g. 0.0.0.0).
fn saved_webui_listen() -> (String, u16, Option<String>) {
    let path = jeikcode_dir().join("webui-listen.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return (DEFAULT_LISTEN_HOST.to_string(), WEBUI_DEFAULT_PORT, None);
    };
    parse_webui_listen(&text)
}

fn parse_webui_listen(text: &str) -> (String, u16, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return (DEFAULT_LISTEN_HOST.to_string(), WEBUI_DEFAULT_PORT, None);
    };
    let host = value
        .get("host")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_LISTEN_HOST.to_string());
    let port = value
        .get("port")
        .and_then(|item| item.as_u64())
        .and_then(|item| u16::try_from(item).ok())
        .filter(|item| *item != 0)
        .unwrap_or(WEBUI_DEFAULT_PORT);
    let token = value
        .get("token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    (host, port, token)
}

fn jeikcode_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("JEIKCODE_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    home_dir().join(".jeikcode")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn set_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    let _ = path;
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
    use std::path::Path;
    use std::sync::Mutex;

    use super::{
        external_browser_url, extract_webui_url, host_window_away, navigation_action,
        new_window_action, parse_webui_listen, remember_webui_origin, resolve_desktop_cli,
        window_url, windows_autostart_command_line, LinkAction, WebuiOrigin,
    };

    fn parse_url(raw: &str) -> tauri::Url {
        raw.parse().unwrap()
    }

    #[test]
    fn resolve_desktop_cli_prefers_bundled() {
        let dummy = std::path::Path::new("dummy-bundled-path");
        let resolved = resolve_desktop_cli(Some(dummy));
        assert_eq!(resolved, dummy);
    }

    fn origin(host: &str, port: u16) -> WebuiOrigin {
        WebuiOrigin {
            host: host.to_string(),
            port,
        }
    }

    #[test]
    fn minimized_window_is_away_even_if_the_page_keeps_focus() {
        assert!(!host_window_away(false, true));
        assert!(host_window_away(true, true));
        assert!(host_window_away(true, false));
        assert!(host_window_away(false, false));
    }

    #[test]
    fn window_opens_loopback_when_the_launch_url_uses_a_lan_address() {
        assert_eq!(
            window_url("http://192.168.123.20:13457/?token=abc&desktop=1"),
            "http://127.0.0.1:13457/?token=abc&desktop=1"
        );
        assert_eq!(
            window_url("http://127.0.0.1:13457/?token=abc"),
            "http://127.0.0.1:13457/?token=abc"
        );
    }

    #[test]
    fn saved_listen_uses_the_port_and_token_and_ignores_a_blank_token() {
        assert_eq!(
            parse_webui_listen(r#"{"host":"0.0.0.0","port":4096,"token":"desk-token"}"#),
            ("0.0.0.0".to_string(), 4096, Some("desk-token".to_string()))
        );
        assert_eq!(
            parse_webui_listen(r#"{"port":0,"token":"  "}"#),
            ("127.0.0.1".to_string(), 13457, None)
        );
        assert_eq!(
            parse_webui_listen("not json"),
            ("127.0.0.1".to_string(), 13457, None)
        );
    }

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

    #[test]
    fn shell_pages_stay_in_the_window() {
        for raw in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "tauri://localhost",
            "about:blank",
        ] {
            let parsed = parse_url(raw);
            assert_eq!(
                navigation_action(&parsed, None),
                LinkAction::StayInWebview,
                "{raw}"
            );
            assert_eq!(
                new_window_action(&parsed),
                LinkAction::StayInWebview,
                "{raw}"
            );
        }
    }

    #[test]
    fn launched_webui_stays_in_the_window() {
        let launched = origin("127.0.0.1", 13457);
        assert_eq!(
            navigation_action(
                &parse_url("http://127.0.0.1:13457/?token=abc"),
                Some(&launched)
            ),
            LinkAction::StayInWebview
        );
        assert_eq!(
            navigation_action(
                &parse_url("http://localhost:13457/?token=abc&desktop=1"),
                Some(&launched)
            ),
            LinkAction::StayInWebview
        );
        let shifted = origin("127.0.0.1", 13458);
        assert_eq!(
            navigation_action(
                &parse_url("http://127.0.0.1:13458/?token=abc"),
                Some(&shifted)
            ),
            LinkAction::StayInWebview
        );
        // 地址还没记下来时不能把 WebUI 留在窗口里，调用方必须先 remember 再导航。
        assert_eq!(
            navigation_action(&parse_url("http://127.0.0.1:13457/?token=abc"), None),
            LinkAction::OpenExternal
        );
    }

    #[test]
    fn localhost_dev_servers_open_in_the_browser() {
        let launched = origin("127.0.0.1", 13457);
        for raw in [
            "http://localhost:3000/",
            "http://127.0.0.1:5173/",
            "http://[::1]:8080/",
            "http://0.0.0.0:3000/",
            "http://app.localhost:3000/",
            "https://github.com/jeikl/JeikCode",
            "https://google.com",
        ] {
            let parsed = parse_url(raw);
            assert_eq!(
                navigation_action(&parsed, Some(&launched)),
                LinkAction::OpenExternal,
                "{raw}"
            );
            assert_eq!(
                new_window_action(&parsed),
                LinkAction::OpenExternal,
                "{raw}"
            );
        }
        let webui = parse_url("http://127.0.0.1:13457/?token=abc");
        assert_eq!(new_window_action(&webui), LinkAction::OpenExternal);
    }

    #[test]
    fn wildcard_bind_urls_open_on_loopback() {
        assert_eq!(
            external_browser_url(&parse_url("http://0.0.0.0:3000/")),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            external_browser_url(&parse_url("http://[::]:8080/docs")),
            "http://127.0.0.1:8080/docs"
        );
        assert_eq!(
            external_browser_url(&parse_url("http://localhost:5173/")),
            "http://localhost:5173/"
        );
    }

    #[test]
    fn remembers_launched_origin() {
        let slot = Mutex::new(None);
        remember_webui_origin(&slot, "http://127.0.0.1:13480/?token=abc&desktop=1");
        let stored = slot.lock().unwrap().clone().unwrap();
        assert_eq!(stored, origin("127.0.0.1", 13480));
    }

    #[test]
    fn formats_quoted_windows_autostart_command_with_minimized_flag() {
        assert_eq!(
            windows_autostart_command_line(Path::new(
                r"\\?\D:\EngSofeware\JeikCode Desktop\jeikcode-desktop.exe"
            )),
            r#""D:\EngSofeware\JeikCode Desktop\jeikcode-desktop.exe" --minimized"#
        );
    }

    #[test]
    fn compare_shell_versions_handles_prerelease_ordinals() {
        use super::compare_shell_versions;
        assert!(compare_shell_versions("7.5.2-beta.10", "7.5.2-beta.2"));
        assert!(!compare_shell_versions("7.5.2-beta.2", "7.5.2-beta.10"));
        assert!(compare_shell_versions("7.5.2", "7.5.2-beta.10"));
        assert!(!compare_shell_versions("7.5.2-beta.10", "7.5.2"));
        assert!(!compare_shell_versions("7.5.2", "7.5.2"));
    }

    #[test]
    fn authorized_webview_url_restricts_to_shell_or_launched_origin() {
        use super::authorized_webview_url;
        let launched = origin("127.0.0.1", 13457);
        assert!(authorized_webview_url(
            &parse_url("http://127.0.0.1:13457/?token=abc&desktop=1"),
            Some(&launched)
        ));
        assert!(authorized_webview_url(
            &parse_url("http://tauri.localhost/"),
            Some(&launched)
        ));
        assert!(!authorized_webview_url(
            &parse_url("http://localhost:3000/"),
            Some(&launched)
        ));
    }
}
