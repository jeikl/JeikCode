//! `jeikcode_config_guide` — Progressive and interactive configuration guide tool for JeikCode / JeikCode.
//!
//! Exposes modular, on-demand configuration teachings for:
//! - Prompts hot reloading (`init.yaml`, `rules.yaml` vs seed `root_docs_*`)
//! - Models, providers, thinking gears, reasoning trace back-transmission, token limits
//! - MCP servers, skills structure, plugins ecosystem
//! - Cilin thesaurus (`thesaurus/*.txt`), bilingual code search relevance
//! - Tool execution timeouts (shared command max_timeout_secs, max_rounds, first_token_timeout, output folding)
//! - Complete `~/.jeikcode` directory layout and file catalog

use super::ok;
use crate::tool_feedback::parse_tool_args;
use async_trait::async_trait;
use jeikcode_kernel::tool::{Tool, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;

const DOC_OVERVIEW: &str = include_str!("../../assets/teaches/00_overview_index.md");
const DOC_PROMPTS: &str = include_str!("../../assets/teaches/01_prompts_and_context.md");
const DOC_MODELS: &str = include_str!("../../assets/teaches/02_models_and_providers.md");
const DOC_MCP_SKILLS: &str = include_str!("../../assets/teaches/03_mcp_and_skills.md");
const DOC_THESAURUS: &str = include_str!("../../assets/teaches/04_thesaurus_and_retrieval.md");
const DOC_TOOLS: &str = include_str!("../../assets/teaches/05_tools_and_timeouts.md");
const DOC_DIRECTORIES: &str = include_str!("../../assets/teaches/06_directories_and_system.md");
const DOC_PROJECT: &str = include_str!("../../assets/teaches/07_project_constraints_and_rules.md");
const DOC_UPDATES: &str = include_str!("../../assets/teaches/08_updates_and_releases.md");

#[derive(Default)]
pub struct JeikcodeConfigTool;

pub type JeikcodeConfigGuideTool = JeikcodeConfigTool;

impl JeikcodeConfigTool {
    pub fn new() -> Self {
        Self
    }

    /// Load guide document content, prioritizing `$JEIKCODE_HOME/teaches/`
    /// (else `~/.jeikcode/teaches/`) when present. Packaging and `/upgrade`
    /// overwrite those host files with the bundled copy.
    fn load_document(&self, filename: &str, embedded: &'static str) -> String {
        if let Some(home) = jeikcode_home() {
            let p = home.join("teaches").join(filename);
            if p.is_file() {
                if let Ok(s) = std::fs::read_to_string(&p) {
                    let s = s.trim();
                    if !s.is_empty() {
                        return s.to_string();
                    }
                }
            }
        }
        embedded.to_string()
    }

    fn get_topic_map(&self) -> HashMap<&'static str, String> {
        let mut map = HashMap::new();
        map.insert(
            "overview",
            self.load_document("00_overview_index.md", DOC_OVERVIEW),
        );
        map.insert(
            "prompts",
            self.load_document("01_prompts_and_context.md", DOC_PROMPTS),
        );
        map.insert(
            "models",
            self.load_document("02_models_and_providers.md", DOC_MODELS),
        );
        map.insert(
            "mcp_skills",
            self.load_document("03_mcp_and_skills.md", DOC_MCP_SKILLS),
        );
        map.insert(
            "thesaurus",
            self.load_document("04_thesaurus_and_retrieval.md", DOC_THESAURUS),
        );
        map.insert(
            "tools",
            self.load_document("05_tools_and_timeouts.md", DOC_TOOLS),
        );
        map.insert(
            "directories",
            self.load_document("06_directories_and_system.md", DOC_DIRECTORIES),
        );
        map.insert(
            "project",
            self.load_document("07_project_constraints_and_rules.md", DOC_PROJECT),
        );
        map.insert(
            "updates",
            self.load_document("08_updates_and_releases.md", DOC_UPDATES),
        );
        map
    }
}

#[derive(Deserialize, Default)]
struct Args {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    topic: Option<String>,
}

#[async_trait]
impl Tool for JeikcodeConfigTool {
    fn name(&self) -> &str {
        "jeikcode_config"
    }

    fn aliases(&self) -> &'static [&'static str] {
        &["jeikcode_config_guide", "jeikcode_config_reload"]
    }

    fn description(&self) -> &str {
        "Manage JeikCode configuration: query guide documents or hot-reload all configurations in the active session. Querying currently mounted MCP servers or skills is not supported as they are already available in the context."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["guide", "reload"],
                    "default": "guide",
                    "description": "Action to perform: 'guide' to query configuration documents, or 'reload' to hot-reload all configurations in the active session."
                },
                "topic": {
                    "type": "string",
                    "enum": [
                        "overview",
                        "prompts",
                        "models",
                        "providers",
                        "mcp",
                        "skills",
                        "thesaurus",
                        "cilin",
                        "tools",
                        "timeouts",
                        "directories",
                        "files",
                        "project",
                        "constraints",
                        "rules",
                        "updates",
                        "upgrade",
                        "release",
                        "all"
                    ],
                    "default": "overview",
                    "description": "Category of configuration guide to retrieve (for action='guide'): 'overview', 'prompts', 'models', 'providers', 'mcp', 'skills', 'thesaurus', 'tools', 'directories', 'project', 'updates', or 'all'."
                }
            }
        })
    }

    fn read_only_hint(&self) -> bool {
        true
    }

    fn never_truncate_result(&self) -> bool {
        true
    }

    async fn execute(&self, args: &str, _ctx: &ToolContext) -> ToolResult {
        let args = if args.trim().is_empty() { "{}" } else { args };
        let parsed: Args = match parse_tool_args("jeikcode_config", args, r#"{"action":"guide"}"#)
            .or_else(|_| parse_tool_args("jeikcode_config_guide", args, r#"{"topic":"overview"}"#))
            .or_else(|_| parse_tool_args("jeikcode_config_reload", args, r#"{}"#))
        {
            Ok(a) => a,
            Err(e) => return e.into_tool_result(),
        };

        let action = parsed
            .action
            .as_deref()
            .unwrap_or("guide")
            .trim()
            .to_ascii_lowercase();

        if action == "reload" {
            crate::config_reload::request_config_reload();
            return ok(
                "Configuration reload requested. All configurations (`config.toml`, MCP servers, and skills) \
                 will remount after this turn completes. Newly connected tools become available on the next turn."
                    .to_string(),
            );
        }

        let topic_map = self.get_topic_map();
        let topic_req = parsed
            .topic
            .as_deref()
            .unwrap_or("overview")
            .to_ascii_lowercase();

        // Return by topic
        let content = match topic_req.as_str() {
            "overview" => topic_map.get("overview").cloned().unwrap_or_default(),
            "prompts" => topic_map.get("prompts").cloned().unwrap_or_default(),
            "models" | "providers" => topic_map.get("models").cloned().unwrap_or_default(),
            "mcp" | "skills" => topic_map.get("mcp_skills").cloned().unwrap_or_default(),
            "thesaurus" | "cilin" => topic_map.get("thesaurus").cloned().unwrap_or_default(),
            "tools" | "timeouts" => topic_map.get("tools").cloned().unwrap_or_default(),
            "directories" | "files" => topic_map.get("directories").cloned().unwrap_or_default(),
            "project" | "constraints" | "rules" => {
                topic_map.get("project").cloned().unwrap_or_default()
            }
            "updates" | "upgrade" | "release" => {
                topic_map.get("updates").cloned().unwrap_or_default()
            }
            "all" => {
                let mut combined = String::new();
                for (doc_name, filename, embedded) in [
                    ("00_overview_index.md", "00_overview_index.md", DOC_OVERVIEW),
                    (
                        "01_prompts_and_context.md",
                        "01_prompts_and_context.md",
                        DOC_PROMPTS,
                    ),
                    (
                        "02_models_and_providers.md",
                        "02_models_and_providers.md",
                        DOC_MODELS,
                    ),
                    (
                        "03_mcp_and_skills.md",
                        "03_mcp_and_skills.md",
                        DOC_MCP_SKILLS,
                    ),
                    (
                        "04_thesaurus_and_retrieval.md",
                        "04_thesaurus_and_retrieval.md",
                        DOC_THESAURUS,
                    ),
                    (
                        "05_tools_and_timeouts.md",
                        "05_tools_and_timeouts.md",
                        DOC_TOOLS,
                    ),
                    (
                        "06_directories_and_system.md",
                        "06_directories_and_system.md",
                        DOC_DIRECTORIES,
                    ),
                    (
                        "07_project_constraints_and_rules.md",
                        "07_project_constraints_and_rules.md",
                        DOC_PROJECT,
                    ),
                    (
                        "08_updates_and_releases.md",
                        "08_updates_and_releases.md",
                        DOC_UPDATES,
                    ),
                ] {
                    combined.push_str(&format!("<!-- START {} -->\n", doc_name));
                    combined.push_str(&self.load_document(filename, embedded));
                    combined.push_str("\n\n---\n\n");
                }
                combined
            }
            _ => {
                format!(
                    "Unknown topic `{topic_req}`. Available topics:\n\
                     - `overview`: Navigation index and topic taxonomy\n\
                     - `prompts`: `init.yaml` & `rules.yaml` hot reloading and seed doc distinction\n\
                     - `models`: `config.toml` accounts, models, reasoning effort/history, tokens\n\
                     - `mcp` / `skills`: MCP servers, Skills structure, plugin market\n\
                     - `thesaurus`: 词林 bilingual code search dictionaries and accuracy tuning\n\
                     - `tools`: Bash timeouts, output fold preview, coding round caps\n\
                     - `directories`: Full directory and file layout of `~/.jeikcode`\n\
                     - `project`: Project constraints (AGENTS.md, JEIKCODE.md, rules.md, glossary.md, dbwords.md)\n\
                     - `updates` / `upgrade`: Default update endpoints, manifest schema, self-update and cross-compilation release workflow\n\
                     - `all`: Complete comprehensive guide."
                )
            }
        };

        ok(content)
    }
}

fn jeikcode_home() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("JEIKCODE_HOME") {
        let p = p.trim();
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".jeikcode"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::tool::{ProgressSink, Tool};
    use std::path::PathBuf;

    #[tokio::test]
    async fn guide_tool_overview_returns_index() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"overview"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("JeikCode 配置知识库导航索引"));
        assert!(res.content.contains("prompts"));
        assert!(res.content.contains("models"));
    }

    #[tokio::test]
    async fn guide_tool_prompts_topic_returns_hot_reload_details() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"prompts"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("init.yaml"));
        assert!(res.content.contains("rules.yaml"));
        assert!(res.content.contains("root_docs_"));
        assert!(res.content.contains("动态热重载"));
    }

    #[tokio::test]
    async fn guide_tool_models_topic_returns_reasoning_and_provider_info() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"models"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("provider_accounts"));
        assert!(res.content.contains("reasoning_history"));
        assert!(res.content.contains("reasoning_effort"));
        assert!(res.content.contains("context_window"));
    }

    #[tokio::test]
    async fn guide_tool_tools_topic_returns_timeouts_and_policies() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"tools"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("silent_kill_secs"));
        assert!(res.content.contains("default_timeout_secs"));
        assert!(res.content.contains("skill_cmd_secs"));
        assert!(res.content.contains("tool_output"));
    }

    #[tokio::test]
    async fn guide_tool_directories_topic_returns_folder_map() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"directories"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("prompts/"));
        assert!(res.content.contains("thesaurus/"));
        assert!(res.content.contains("config.toml"));
    }

    #[tokio::test]
    async fn guide_tool_project_topic_returns_constraints_and_packs() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"project"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("AGENTS.md"));
        assert!(res.content.contains("JEIKCODE.md"));
        assert!(res.content.contains("dbwords.md"));
        assert!(res.content.contains("glossary.md"));
    }

    #[tokio::test]
    async fn guide_tool_updates_topic_returns_sources_and_workflow() {
        let tool = JeikcodeConfigGuideTool::new();
        let ctx = ToolContext {
            working_dir: PathBuf::from("."),
            cancel: tokio_util::sync::CancellationToken::new(),
            progress: ProgressSink::noop(),
            requester: None,
        };
        let res = tool.execute(r#"{"topic":"updates"}"#, &ctx).await;
        assert!(!res.is_error);
        assert!(res.content.contains("github.com/jeikl/JeikCode"));
        assert!(res.content.contains("JEIKCODE_UPDATE_MANIFEST_URL"));
        assert!(res.content.contains("JEIKCODE_UPDATE_DOWNLOAD_BASE"));
        assert!(res.content.contains("/upgrade"));
    }

    #[test]
    fn embedded_mcp_guide_documents_reload_tool_and_webui() {
        // Host `~/.jeikcode/teaches/` can override execute(); pin the shipped asset.
        assert!(DOC_MCP_SKILLS.contains("jeikcode_config_reload"));
        assert!(DOC_MCP_SKILLS.contains("/mcp reload"));
        assert!(DOC_MCP_SKILLS.contains("刷新按钮"));
        assert!(DOC_MCP_SKILLS.contains("jeikcode mcp add"));
        assert!(DOC_MCP_SKILLS.contains("/skills"));
        assert!(DOC_OVERVIEW.contains("jeikcode_config_reload"));
        assert!(DOC_OVERVIEW.contains("jeikcode mcp add"));
    }
}
