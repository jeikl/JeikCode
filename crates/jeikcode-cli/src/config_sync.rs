use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use jeikcode_config::i18n::{t, ConfigSyncChange, Msg};
use std::io::{self, Write};

pub use jeikcode_coding::config_sync::*;

/// 交互式多选列表渲染与交互引擎：
/// - 空格键：勾选/取消当前项
/// - 'a' 键：全选 / 全取消
/// - 上下方向键 / j / k：移动光标
/// - 回车键 (Enter)：确认并应用所有选中更新
/// - ESC / 'q'：跳过所有配置文件更新
pub fn prompt_interactive_config_sync(mut items: Vec<ConfigDiffItem>) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }

    println!("{}", t(Msg::ConfigSyncIntroduction));

    let mut cursor = 0;
    enable_raw_mode()?;
    let mut stdout = io::stdout();

    // 核心修复 1: 清空进入交互模式前控制台缓冲区残留的按键事件（如输入 upgrade 命令时的回车残余）
    while event::poll(std::time::Duration::from_millis(20)).unwrap_or(false) {
        let _ = event::read();
    }

    let render = |stdout: &mut io::Stdout, items: &[ConfigDiffItem], cursor: usize| -> Result<()> {
        crossterm::execute!(stdout, crossterm::cursor::Hide)?;
        // 清除行并重绘选项
        for (i, item) in items.iter().enumerate() {
            let pointer = if i == cursor { "👉 " } else { "   " };
            let checkbox = if item.selected { "[✔] " } else { "[ ] " };
            let change = match item.kind {
                DiffKind::New => ConfigSyncChange::New,
                DiffKind::Modified => ConfigSyncChange::Modified,
                DiffKind::Obsolete => ConfigSyncChange::Obsolete,
            };
            let status = t(Msg::ConfigSyncStatus {
                change,
                description: &item.description,
            });
            println!("\r{}{}{}\x1b[K", pointer, checkbox, status);
        }
        stdout.flush()?;
        Ok(())
    };

    let clear_lines = |stdout: &mut io::Stdout, count: usize| -> Result<()> {
        for _ in 0..count {
            crossterm::execute!(
                stdout,
                crossterm::cursor::MoveUp(1),
                crossterm::terminal::Clear(crossterm::terminal::ClearType::CurrentLine)
            )?;
        }
        Ok(())
    };

    render(&mut stdout, &items, cursor)?;

    let mut confirmed = false;

    loop {
        if let Event::Key(key_event) = event::read()? {
            // 核心修复 2: 过滤 Windows 控制台产生的 Release 事件，防止启动命令时的回车释放事件瞬间触发确认
            if key_event.kind == crossterm::event::KeyEventKind::Release {
                continue;
            }
            match key_event.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    if cursor > 0 {
                        cursor -= 1;
                        clear_lines(&mut stdout, items.len())?;
                        render(&mut stdout, &items, cursor)?;
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if cursor + 1 < items.len() {
                        cursor += 1;
                        clear_lines(&mut stdout, items.len())?;
                        render(&mut stdout, &items, cursor)?;
                    }
                }
                KeyCode::Char(' ') => {
                    items[cursor].selected = !items[cursor].selected;
                    clear_lines(&mut stdout, items.len())?;
                    render(&mut stdout, &items, cursor)?;
                }
                KeyCode::Char('a') | KeyCode::Char('A') => {
                    let any_unselected = items.iter().any(|it| !it.selected);
                    for it in &mut items {
                        it.selected = any_unselected;
                    }
                    clear_lines(&mut stdout, items.len())?;
                    render(&mut stdout, &items, cursor)?;
                }
                KeyCode::Enter => {
                    confirmed = true;
                    break;
                }
                KeyCode::Esc | KeyCode::Char('q') => {
                    confirmed = false;
                    break;
                }
                KeyCode::Char('c') if key_event.modifiers.contains(KeyModifiers::CONTROL) => {
                    confirmed = false;
                    break;
                }
                _ => {}
            }
        }
    }

    disable_raw_mode()?;
    crossterm::execute!(stdout, crossterm::cursor::Show)?;
    println!();

    if !confirmed {
        println!("{}", t(Msg::ConfigSyncUnchanged { skipped: true }));
        return Ok(());
    }

    let applied_count = apply_selected_diffs(items);
    if applied_count == 0 {
        println!("{}", t(Msg::ConfigSyncUnchanged { skipped: false }));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn mcp_and_skills_paths_are_user_custom() {
        assert!(is_user_custom_mcp_or_skill("mcp.json"));
        assert!(is_user_custom_mcp_or_skill("skills/foo/SKILL.md"));
        assert!(is_user_custom_mcp_or_skill("skills"));
        assert!(!is_user_custom_mcp_or_skill("teaches/03_mcp_and_skills.md"));
        assert!(!is_user_custom_mcp_or_skill("prompts/init.yaml"));
        assert!(!is_user_custom_mcp_or_skill(
            "prompts/root_docs_内置技能.yaml"
        ));
        assert!(!is_user_custom_mcp_or_skill("config.toml"));
    }

    #[test]
    fn upgrade_defaults_uncheck_mcp_but_keep_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        fs::create_dir_all(home.join("prompts")).unwrap();
        fs::write(
            home.join("mcp.json"),
            "{ \"mcpServers\": { \"custom\": {} } }\n",
        )
        .unwrap();
        fs::write(home.join("prompts/init.yaml"), "user-custom-init\n").unwrap();

        let diffs = scan_jeikcode_config_diffs(home);
        let mcp = diffs
            .iter()
            .find(|d| d.relative_path == "mcp.json")
            .expect("mcp.json should appear as a diff");
        assert!(!mcp.selected, "mcp.json must default-uncheck on upgrade");
        let init = diffs
            .iter()
            .find(|d| d.relative_path == "prompts/init.yaml")
            .expect("init.yaml should appear as a diff");
        assert!(init.selected, "prompts stay selected by default");
    }
}
