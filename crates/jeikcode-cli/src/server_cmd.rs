//! `jeikcode server` subcommand — list and manage host services.
//!
//! Provides `jeikcode server list` and `jeikcode server uninstall <id>` to
//! inspect and remove JeikCode host services across all platforms.

use anyhow::Result;
use clap::Subcommand;
use jeikcode_config::i18n::{t, Msg};

use jeikcode::host_service;

// ── CLI enum ──────────────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum ServerCli {
    /// List all installed JeikCode host services.
    List,

    /// Uninstall one or more host services by ID (from `server list`).
    Uninstall {
        /// Service IDs to uninstall (space-separated, from `server list`).
        #[arg(required = true, num_args = 1..)]
        ids: Vec<u32>,
    },
}

// ── Handler ───────────────────────────────────────────────────────────────────

pub fn handle_server(cmd: &ServerCli) -> Result<()> {
    match cmd {
        ServerCli::List => handle_list(),
        ServerCli::Uninstall { ids } => handle_uninstall(ids),
    }
}

fn handle_list() -> Result<()> {
    let entries = host_service::list_services();

    if entries.is_empty() {
        println!("{}", t(Msg::ServerNoServices));
        println!();
        println!(
            "{}",
            host_service::host_msg(
                "Tip: `jeikcode --host` asks whether to start the server at login.",
                "提示: 使用 `jeikcode --host` 启动服务时，会自动提示是否配置为登录自启。",
                "Mẹo: `jeikcode --host` sẽ hỏi có tự động khởi động máy chủ khi đăng nhập hay không.",
            )
        );
        return Ok(());
    }

    // Print table header
    println!("{}", t(Msg::ServerServiceTableHeader));
    println!("{}", "-".repeat(100));

    for entry in &entries {
        let path_str = entry.path.as_deref().unwrap_or("-");
        println!(
            "{:<4} {:<30} {:<6} {:<10} {:<10} {}",
            entry.id, entry.service_name, entry.port, entry.status, entry.platform, path_str,
        );
    }

    println!();
    println!("使用 `jeikcode server uninstall <ID>` 卸载指定服务。");

    Ok(())
}

fn handle_uninstall(ids: &[u32]) -> Result<()> {
    let entries = host_service::list_services();

    if entries.is_empty() {
        println!("{}", t(Msg::ServerNoServices));
        return Ok(());
    }

    let mut success_count = 0u32;
    let mut fail_count = 0u32;

    for &id in ids {
        let entry = match entries.iter().find(|e| e.id == id) {
            Some(e) => e,
            None => {
                eprintln!(
                    "❌ 未找到 ID 为 {id} 的服务（有效范围: 1-{}）",
                    entries.len()
                );
                fail_count += 1;
                continue;
            }
        };

        print!(
            "正在卸载 {} (ID: {}, 端口: {}, 平台: {})...",
            entry.service_name, entry.id, entry.port, entry.platform,
        );

        match host_service::uninstall_service(entry) {
            Ok(()) => {
                println!(" ✓");
                success_count += 1;
            }
            Err(e) => {
                println!(" ✗");
                eprintln!("  错误: {e:#}");
                fail_count += 1;
            }
        }
    }

    // Summary
    if ids.len() > 1 {
        println!();
        if success_count > 0 {
            println!("✓ 成功卸载 {success_count} 个服务");
        }
        if fail_count > 0 {
            eprintln!("✗ {fail_count} 个服务卸载失败");
        }
    }

    Ok(())
}
