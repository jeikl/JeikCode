use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const LAST_SEEN_VERSION_FILE: &str = ".last_seen_version";

/// 读取上一次同步或提示过的版本号
pub fn get_last_seen_version(jeikcode_home: &Path) -> Option<String> {
    let p = jeikcode_home.join(LAST_SEEN_VERSION_FILE);
    fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

/// 写入当前记录的版本号
pub fn set_last_seen_version(jeikcode_home: &Path, version: &str) -> std::io::Result<()> {
    let p = jeikcode_home.join(LAST_SEEN_VERSION_FILE);
    fs::write(p, version.trim())
}

/// 内置全量默认模板条目定义
pub struct BundledFileEntry {
    pub relative_path: &'static str,
    pub content: &'static str,
    pub description: &'static str,
}

/// 全量内置资产列表：包含 ~/.jeikcode 下的所有默认配置文件与提示词目录
pub const BUNDLED_ASSETS: &[BundledFileEntry] = &[
    BundledFileEntry {
        relative_path: "prompts/init.yaml",
        content: include_str!("../assets/prompts/init.yaml"),
        description: "提示词与身份定义 (init.yaml)",
    },
    BundledFileEntry {
        relative_path: "prompts/rules.yaml",
        content: include_str!("../assets/prompts/rules.yaml"),
        description: "工作流与执行规范 (rules.yaml)",
    },
    BundledFileEntry {
        relative_path: "prompts/root_docs_prompts.md",
        content: include_str!("../assets/prompts/root_docs_prompts.md"),
        description: "提示词指南（不加载进模型） (root_docs_prompts.md)",
    },
    BundledFileEntry {
        relative_path: "prompts/root_docs_内置工具.yaml",
        content: include_str!("../assets/prompts/root_docs_内置工具.yaml"),
        description: "内置工具说明文档（不加载进模型） (root_docs_内置工具.yaml)",
    },
    BundledFileEntry {
        relative_path: "prompts/root_docs_内置技能.yaml",
        content: include_str!("../assets/prompts/root_docs_内置技能.yaml"),
        description: "内置技能说明文档（不加载进模型） (root_docs_内置技能.yaml)",
    },
    BundledFileEntry {
        relative_path: "config.toml",
        content: include_str!("../assets/default-config.toml"),
        description: "系统与工具通用配置 (config.toml — 保留用户模型/账号)",
    },
    BundledFileEntry {
        relative_path: "config_teachs.md",
        content: include_str!("../assets/config_teachs.md"),
        description: "Agent 友好配置文件教程与配置指南 (config_teachs.md)",
    },
    BundledFileEntry {
        relative_path: "builtin-tools.txt",
        content: include_str!("../../jeikcode-capabilities/assets/builtin-tools.txt"),
        description: "内置工具清单 (builtin-tools.txt)",
    },
    BundledFileEntry {
        relative_path: "mcp.json",
        content: include_str!("../../jeikcode-capabilities/assets/mcp.json"),
        description: "默认 MCP 服务器 (mcp.json)",
    },
    BundledFileEntry {
        relative_path: "user-wrap.md",
        content: include_str!("../../jeikcode-capabilities/assets/user-wrap.md"),
        description: "用户提问包装模板 (user-wrap.md — 支持 {{input}} 动态占位符)",
    },
    BundledFileEntry {
        relative_path: ".codegraphignore",
        content: include_str!("../../jeikcode-capabilities/assets/.codegraphignore"),
        description: "代码图谱忽略规则 (.codegraphignore)",
    },
    BundledFileEntry {
        relative_path: "thesaurus/admin_system.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/admin_system.txt"),
        description: "词林 admin_system.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/agent_core.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/agent_core.txt"),
        description: "词林 agent_core.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/ai_agent.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/ai_agent.txt"),
        description: "词林 ai_agent.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/computer_science.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/computer_science.txt"),
        description: "词林 computer_science.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/ailaierp.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/ailaierp.txt"),
        description: "词林 ailaierp.txt (Ailai ERP与电商)",
    },
    BundledFileEntry {
        relative_path: "thesaurus/fullstack_dev.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/fullstack_dev.txt"),
        description: "词林 fullstack_dev.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/medical.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/medical.txt"),
        description: "词林 medical.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/robotics.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/robotics.txt"),
        description: "词林 robotics.txt",
    },
    BundledFileEntry {
        relative_path: "thesaurus/web_http.txt",
        content: include_str!("../../jeikcode-capabilities/assets/thesaurus/web_http.txt"),
        description: "词林 web_http.txt",
    },
    BundledFileEntry {
        relative_path: "teaches/00_overview_index.md",
        content: include_str!("../../jeikcode-capabilities/assets/teaches/00_overview_index.md"),
        description: "配置知识库索引 (teaches/00_overview_index.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/01_prompts_and_context.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/01_prompts_and_context.md"
        ),
        description: "提示词与上下文指南 (teaches/01_prompts_and_context.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/02_models_and_providers.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/02_models_and_providers.md"
        ),
        description: "模型与提供商指南 (teaches/02_models_and_providers.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/03_mcp_and_skills.md",
        content: include_str!("../../jeikcode-capabilities/assets/teaches/03_mcp_and_skills.md"),
        description: "MCP与Skills指南 (teaches/03_mcp_and_skills.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/04_thesaurus_and_retrieval.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/04_thesaurus_and_retrieval.md"
        ),
        description: "词林检索相关性指南 (teaches/04_thesaurus_and_retrieval.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/05_tools_and_timeouts.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/05_tools_and_timeouts.md"
        ),
        description: "工具超时与策略指南 (teaches/05_tools_and_timeouts.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/06_directories_and_system.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/06_directories_and_system.md"
        ),
        description: "系统目录与文件全景指南 (teaches/06_directories_and_system.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/07_project_constraints_and_rules.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/07_project_constraints_and_rules.md"
        ),
        description: "项目约束与业务知识包指南 (teaches/07_project_constraints_and_rules.md)",
    },
    BundledFileEntry {
        relative_path: "teaches/08_updates_and_releases.md",
        content: include_str!(
            "../../jeikcode-capabilities/assets/teaches/08_updates_and_releases.md"
        ),
        description: "升级与发版指南 (teaches/08_updates_and_releases.md)",
    },
];

/// 官方已废弃/重命名的历史遗留文件列表（需在升级时提示清理或移除）
pub const STALE_HOME_FILES: &[&str] = &[
    "thesaurus/ecommerce.txt",
    "prompts/prompts.md",
    "prompts/内置工具.yaml",
    "prompts/内置技能.yaml",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffKind {
    /// 新增文件（内置模板存在，本地缺失）
    New,
    /// 修改文件（本地存在，与内置模板内容有差异）
    Modified,
    /// 废弃/删除文件（旧版遗留文件，已被新版淘汰重命名）
    Obsolete,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigDiffItem {
    pub relative_path: String,
    pub description: String,
    pub target_path: PathBuf,
    #[serde(skip_serializing, default)]
    pub new_content: String,
    pub kind: DiffKind,
    pub selected: bool,
}

/// Keys that stay on upgrade: the user's model/account/provider customisation.
pub const PRESERVE_CONFIG_KEYS: &[&str] = &[
    "models",
    "default_model",
    "default_provider",
    "providers",
    "provider_accounts",
    "provider",
    "model",
    "profiles",
    "reasoning_effort",
    "evaluator_provider",
    // The first-run / WebUI language switch. Upgrade must not flip it back
    // to the template default.
    "language",
];

fn ui_is_english() -> bool {
    jeikcode_config::i18n::current_locale() == jeikcode_config::locale::Locale::En
}

/// Description shown in the upgrade picker. Follows the global language switch.
pub fn localized_asset_description(relative_path: &str, zh_fallback: &str) -> String {
    if !ui_is_english() {
        return zh_fallback.to_string();
    }
    let en = match relative_path {
        "prompts/init.yaml" => "Identity and system prompt prefix (init.yaml)",
        "prompts/rules.yaml" => "Workflow and tool rules (rules.yaml)",
        "prompts/root_docs_prompts.md" => {
            "Prompt guide, not loaded into the model (root_docs_prompts.md)"
        }
        "prompts/root_docs_内置工具.yaml" => "Built-in tool notes, not loaded into the model",
        "prompts/root_docs_内置技能.yaml" => "Built-in skill notes, not loaded into the model",
        "config.toml" => "Shared settings (config.toml — your models and accounts stay)",
        "config_teachs.md" => "Config guide for agents (config_teachs.md)",
        "builtin-tools.txt" => "Built-in tool list (builtin-tools.txt)",
        "mcp.json" => "Default MCP servers (mcp.json)",
        "user-wrap.md" => "User prompt wrap template (user-wrap.md, {{input}})",
        ".codegraphignore" => "Code graph ignore rules (.codegraphignore)",
        "thesaurus/admin_system.txt" => "Thesaurus: admin systems",
        "thesaurus/agent_core.txt" => "Thesaurus: agent core",
        "thesaurus/ai_agent.txt" => "Thesaurus: AI agent",
        "thesaurus/computer_science.txt" => "Thesaurus: computer science",
        "thesaurus/ailaierp.txt" => "Thesaurus: Ailai ERP and commerce",
        "thesaurus/fullstack_dev.txt" => "Thesaurus: fullstack development",
        "thesaurus/medical.txt" => "Thesaurus: medical",
        "thesaurus/robotics.txt" => "Thesaurus: robotics",
        "thesaurus/web_http.txt" => "Thesaurus: web and HTTP",
        "teaches/00_overview_index.md" => "Guide index (teaches/00_overview_index.md)",
        "teaches/01_prompts_and_context.md" => "Prompts and context guide",
        "teaches/02_models_and_providers.md" => "Models and providers guide",
        "teaches/03_mcp_and_skills.md" => "MCP and skills guide",
        "teaches/04_thesaurus_and_retrieval.md" => "Thesaurus and retrieval guide",
        "teaches/05_tools_and_timeouts.md" => "Tools and timeouts guide",
        "teaches/06_directories_and_system.md" => "Directories and system guide",
        "teaches/07_project_constraints_and_rules.md" => "Project rules guide",
        "teaches/08_updates_and_releases.md" => "Updates and releases guide",
        _ => return zh_fallback.to_string(),
    };
    en.to_string()
}

/// New-install defaults for everything except the user's model tables.
pub fn merge_user_config_preserving_models(existing: &str, new_template: &str) -> String {
    let existing_val: toml::Value = match toml::from_str(existing) {
        Ok(v) => v,
        Err(_) => return existing.to_string(),
    };
    let mut new_val: toml::Value = match toml::from_str(new_template) {
        Ok(v) => v,
        Err(_) => return existing.to_string(),
    };

    if let (toml::Value::Table(exist_tab), toml::Value::Table(ref mut new_tab)) =
        (&existing_val, &mut new_val)
    {
        for k in PRESERVE_CONFIG_KEYS {
            if let Some(v) = exist_tab.get(*k) {
                new_tab.insert((*k).to_string(), v.clone());
            }
        }
    }

    toml::to_string_pretty(&new_val).unwrap_or_else(|_| existing.to_string())
}

/// MCP / skills 多为用户自定义接线与技能包，upgrade 交互勾选默认不覆盖。
/// `teaches/` 文档与 `prompts/root_docs_*` 说明文件不在此列。
pub fn is_user_custom_mcp_or_skill(relative_path: &str) -> bool {
    let p = relative_path.replace('\\', "/");
    if p.starts_with("teaches/") {
        return false;
    }
    if p == "mcp.json" || p.ends_with("/mcp.json") || p == ".mcp.json" {
        return true;
    }
    p == "skills" || p.starts_with("skills/") || p.contains("/skills/")
}

/// 交互式 upgrade 的默认勾选：MCP / skills 配置默认不选，废弃清理项仍默认勾选。
pub fn default_selected_for(relative_path: &str, kind: DiffKind) -> bool {
    match kind {
        DiffKind::Obsolete => true,
        DiffKind::New | DiffKind::Modified => !is_user_custom_mcp_or_skill(relative_path),
    }
}

/// 扫描 ~/.jeikcode 目录下所有涉及的内置非模型配置变更项（新增、更新修改、废弃清理）
pub fn scan_jeikcode_config_diffs(jeikcode_home: &Path) -> Vec<ConfigDiffItem> {
    let mut diffs = Vec::new();

    // 1. 扫描内置官方资产：检测新增与修改更新
    for entry in BUNDLED_ASSETS {
        let target = jeikcode_home.join(entry.relative_path);
        let bundled_content = entry.content;

        if !target.exists() {
            diffs.push(ConfigDiffItem {
                relative_path: entry.relative_path.to_string(),
                description: localized_asset_description(entry.relative_path, entry.description),
                target_path: target,
                new_content: bundled_content.to_string(),
                kind: DiffKind::New,
                selected: default_selected_for(entry.relative_path, DiffKind::New),
            });
            continue;
        }

        let existing_content = fs::read_to_string(&target).unwrap_or_default();

        if entry.relative_path == "config.toml" {
            let merged = merge_user_config_preserving_models(&existing_content, bundled_content);
            if merged.trim() != existing_content.trim() {
                diffs.push(ConfigDiffItem {
                    relative_path: entry.relative_path.to_string(),
                    description: localized_asset_description(
                        entry.relative_path,
                        entry.description,
                    ),
                    target_path: target,
                    new_content: merged,
                    kind: DiffKind::Modified,
                    selected: default_selected_for(entry.relative_path, DiffKind::Modified),
                });
            }
        } else {
            // 对 prompts/*.yaml, thesaurus/*.txt, teaches/*.md 等文件进行全文比对
            if existing_content.trim() != bundled_content.trim() {
                diffs.push(ConfigDiffItem {
                    relative_path: entry.relative_path.to_string(),
                    description: localized_asset_description(
                        entry.relative_path,
                        entry.description,
                    ),
                    target_path: target,
                    new_content: bundled_content.to_string(),
                    kind: DiffKind::Modified,
                    selected: default_selected_for(entry.relative_path, DiffKind::Modified),
                });
            }
        }
    }

    // 2. 扫描历史已知废弃或已被替换的旧文件（如 ecommerce.txt）
    for stale_rel in STALE_HOME_FILES {
        let stale_path = jeikcode_home.join(stale_rel);
        if stale_path.is_file() {
            let description = if ui_is_english() {
                format!("Obsolete leftover ({stale_rel})")
            } else {
                format!("废弃/旧版本遗留项 ({stale_rel})")
            };
            diffs.push(ConfigDiffItem {
                relative_path: stale_rel.to_string(),
                description,
                target_path: stale_path,
                new_content: String::new(),
                kind: DiffKind::Obsolete,
                selected: default_selected_for(stale_rel, DiffKind::Obsolete),
            });
        }
    }

    diffs
}

pub fn remove_stale_home_files(jeikcode_home: &Path) {
    for rel in STALE_HOME_FILES {
        let p = jeikcode_home.join(rel);
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
    }
}

/// 自动应用已选中的差异项（供 `upgrade -y` / `--auto` 以及 WebUI 批量应用使用，自动保护 MCP / skills 与用户模型）
pub fn apply_selected_diffs(items: Vec<ConfigDiffItem>) -> usize {
    let mut applied_count = 0;
    for item in items.into_iter().filter(|it| it.selected) {
        match item.kind {
            DiffKind::New | DiffKind::Modified => {
                if let Some(parent) = item.target_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if fs::write(&item.target_path, &item.new_content).is_ok() {
                    let tag = if ui_is_english() {
                        if item.kind == DiffKind::New {
                            "added"
                        } else {
                            "updated"
                        }
                    } else if item.kind == DiffKind::New {
                        "已新增"
                    } else {
                        "已更新"
                    };
                    println!("  ✔ {tag}: {}", item.relative_path);
                    applied_count += 1;
                }
            }
            DiffKind::Obsolete => {
                if fs::remove_file(&item.target_path).is_ok() {
                    if ui_is_english() {
                        println!("  ✔ removed obsolete: {}", item.relative_path);
                    } else {
                        println!("  ✔ 已清理废弃项: {}", item.relative_path);
                    }
                    applied_count += 1;
                }
            }
        }
    }

    if applied_count > 0 {
        if ui_is_english() {
            println!(
                "Synced {applied_count} config file(s). Your models, accounts, and language choice were kept."
            );
        } else {
            println!(
                "✨ 成功同步了 {applied_count} 个配置文件（已自动保护用户模型配置、语言选择与 MCP/Skills）！"
            );
        }
    }
    applied_count
}

/// 非交互式直接写入/更新全量内置资产（供 `jeikcode setup --defaults` / `jeikcode setup -y` 及自动化脚本使用）
pub fn apply_all_bundled_assets(jeikcode_home: &Path, force: bool) -> Result<usize> {
    remove_stale_home_files(jeikcode_home);
    let mut applied_count = 0;

    for entry in BUNDLED_ASSETS {
        let target = jeikcode_home.join(entry.relative_path);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }

        if !target.exists() {
            fs::write(&target, entry.content)?;
            println!("  ✔ [新增] {}", entry.relative_path);
            applied_count += 1;
        } else if entry.relative_path == "config.toml" {
            let existing_content = fs::read_to_string(&target).unwrap_or_default();
            let merged = merge_user_config_preserving_models(&existing_content, entry.content);
            if merged.trim() != existing_content.trim() || force {
                fs::write(&target, &merged)?;
                println!(
                    "  ✔ [更新] {} (已保留用户模型/账号配置)",
                    entry.relative_path
                );
                applied_count += 1;
            }
        } else if force {
            fs::write(&target, entry.content)?;
            println!("  ✔ [覆盖] {}", entry.relative_path);
            applied_count += 1;
        } else {
            let existing_content = fs::read_to_string(&target).unwrap_or_default();
            if existing_content.trim() != entry.content.trim() {
                fs::write(&target, entry.content)?;
                println!("  ✔ [同步] {}", entry.relative_path);
                applied_count += 1;
            }
        }
    }

    Ok(applied_count)
}
