use std::path::{Path, PathBuf};

fn main() {
    emit_build_info();

    // Embed icon when targeting Windows.
    let bin_name = std::env::var("CARGO_BIN_NAME").unwrap_or_default();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && (bin_name.is_empty() || bin_name == "jeikcode" || bin_name == "atomcode")
    {
        let icon = "assets/jeikcode.ico";
        println!("cargo:rerun-if-changed={}", icon);
        let mut res = winresource::WindowsResource::new();
        res.set_icon(icon);

        // Embed the UTF-8 activeCodePage manifest so the process runs with
        // UTF-8 as its ANSI code page from the moment the loader creates it.
        // This is more reliable than SetConsoleCP(CP_UTF8) alone, which is a
        // best-effort console-level setting that some IMEs ignore. Supported
        // on Windows 10 1903+; silently ignored on older builds.
        //
        // The manifest also includes standard DPI awareness and supportedOS
        // declarations so we don't lose the defaults that the MSVC CRT would
        // otherwise embed. For mingw targets (which this project uses), these
        // are not provided by the toolchain, so we supply them ourselves.
        res.set_manifest(
            r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application>
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/>
    </application>
  </compatibility>
</assembly>"#,
        );
        // FILETYPE must be set for winresource to write the manifest block
        // into the .rc file (it gates on this key at line 578 of lib.rs).
        res.set_version_info(winresource::VersionInfo::FILETYPE, 1);

        if let Err(e) = res.compile() {
            println!("cargo:warning=winresource compile failed: {}", e);
        }
    }
}

fn emit_build_info() {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let source_root = manifest_dir.join("../..");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PATH");

    // An exported source archive nested in an unrelated repository must not
    // accidentally inherit that outer repository's identity.
    let repository_root = git_text(&source_root, &["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok());
    let is_source_repository =
        repository_root.is_some() && repository_root == source_root.canonicalize().ok();

    let (commit, tree, dirty) = if is_source_repository {
        watch_repository(&source_root);
        let commit = git_object_id(&source_root, "HEAD^{commit}");
        let tree = commit
            .as_ref()
            .and_then(|commit| git_object_id(&source_root, &format!("{commit}^{{tree}}")));
        let dirty = git_bytes(
            &source_root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        )
        .map(|output| !output.is_empty());
        if commit == git_object_id(&source_root, "HEAD^{commit}") {
            (commit, tree, dirty)
        } else {
            // A concurrent checkout moved HEAD while metadata was being read.
            (None, None, None)
        }
    } else {
        // A later `git init` or worktree attachment should refresh metadata.
        watch_path(&source_root.join(".git"));
        (None, None, None)
    };

    let short_hash = commit
        .as_deref()
        .map(|value| &value[..12])
        .unwrap_or("unknown");
    println!("cargo:rustc-env=JEIKCODE_BUILD_ID={short_hash}");
    println!(
        "cargo:rustc-env=JEIKCODE_BUILD_DIRTY={}",
        match dirty {
            Some(true) => "+dirty",
            Some(false) => "",
            None => "+unknown",
        }
    );
    println!(
        "cargo:rustc-env=JEIKCODE_SOURCE_COMMIT={}",
        commit.as_deref().unwrap_or("unknown")
    );
    println!(
        "cargo:rustc-env=JEIKCODE_SOURCE_TREE={}",
        tree.as_deref().unwrap_or("unknown")
    );
    println!(
        "cargo:rustc-env=JEIKCODE_SOURCE_DIRTY={}",
        match dirty {
            Some(true) => "true",
            Some(false) => "false",
            None => "unknown",
        }
    );
    println!(
        "cargo:rustc-env=JEIKCODE_BUILD_TARGET={}",
        std::env::var("TARGET").unwrap_or_else(|_| "unknown".into())
    );
}

fn git_bytes(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    std::process::Command::new("git")
        .current_dir(root)
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false"])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output.stdout)
}

fn git_text(root: &Path, args: &[&str]) -> Option<String> {
    String::from_utf8(git_bytes(root, args)?)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn git_object_id(root: &Path, revision: &str) -> Option<String> {
    git_text(root, &["rev-parse", "--verify", revision]).filter(|value| {
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn watch_repository(root: &Path) {
    // Resolve metadata through Git so ordinary checkouts and linked worktrees
    // both watch the actual HEAD, index, branch ref, and packed refs.
    let mut paths = vec![
        "HEAD".to_owned(),
        "index".to_owned(),
        "packed-refs".to_owned(),
    ];
    if let Some(git_ref) = git_text(root, &["symbolic-ref", "--quiet", "HEAD"]) {
        paths.push(git_ref);
    }
    for path in paths {
        if let Some(path) = git_text(root, &["rev-parse", "--git-path", &path]) {
            let path = root.join(path);
            if path.exists() {
                watch_path(&path);
            }
        }
    }
    if root.join(".git").is_file() {
        watch_path(&root.join(".git"));
    }

    // Index watches alone miss unstaged edits. Watch tracked inputs explicitly
    // without recursively scanning ignored build outputs or node_modules.
    if let Some(files) = git_bytes(root, &["ls-files", "--cached", "-z"]) {
        for file in files
            .split(|byte| *byte == 0)
            .filter(|file| !file.is_empty())
        {
            if let Ok(file) = std::str::from_utf8(file) {
                watch_path(&root.join(file));
            }
        }
    }
}

fn watch_path(path: &Path) {
    if let Some(path) = path.to_str().filter(|path| !path.contains(['\r', '\n'])) {
        println!("cargo:rerun-if-changed={path}");
    }
}
