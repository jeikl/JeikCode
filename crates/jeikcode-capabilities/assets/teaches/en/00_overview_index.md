# JeikCode Configuration Knowledge Base Overview Index (Overview Index)

This directory serves as the progressive guide to the JeikCode global and workspace configuration architecture, allowing agents and developers to look up configuration syntax, parameters, and reload semantics.

## 1. Core Module Quick Reference

| No. | Module Category (`topic`) | File Path | Core Coverage |
| :--- | :--- | :--- | :--- |
| **01** | `prompts` | `teaches/01_prompts_and_context.md` | `prompts/init.yaml` & `rules.yaml` schema, dynamic hot-reload, active vs reference doc distinction, `user-wrap.md` |
| **02** | `models` / `providers` | `teaches/02_models_and_providers.md` | `config.toml` top-level scalar layout, decoupled accounts & models, reasoning gears, reasoning history back-transmission, token limits |
| **03** | `mcp` / `skills` | `teaches/03_mcp_and_skills.md` | `jeikcode mcp add` CLI, `mcp.json`, WebUI/TUI `/mcp` & reload, `SKILL.md` authoring & `/skills`, plugin management |
| **04** | `thesaurus` / `cilin` | `teaches/04_thesaurus_and_retrieval.md` | Cilin `thesaurus/*.txt` mappings, bilingual code search relevance, domain dictionary tuning |
| **05** | `tools` / `timeouts` | `teaches/05_tools_and_timeouts.md` | `[tools.bash]` hard limits, `[tools.timeouts]` short budgets, `[tools.tool_output]` 64KB/24KB folding, background daemon tasks, proxy |
| **06** | `directories` / `files` | `teaches/06_directories_and_system.md` | `~/.jeikcode/` directory layout & file catalog, maintenance and cleanup |
| **07** | `project` / `rules` | `teaches/07_project_constraints_and_rules.md` | Three-tier project instructions (AGENTS.md, JEIKCODE.md, .jeikcode.user.md), domain knowledge packs (rules.md, glossary.md, dbwords.md) |
| **08** | `updates` / `upgrade` | `teaches/08_updates_and_releases.md` | Update endpoints (github.com/jeikl/JeikCode / latest.json), self-update commands (/upgrade), environment variable overrides |

---

## 2. Configuration Reload & Effective Semantics

Modifying configuration **never requires restarting the JeikCode process**. Reload semantics by file type:

| Configuration Type | Target File | Reload Semantics |
| :--- | :--- | :--- |
| **Prompts & Rules** | `prompts/init.yaml`<br>`prompts/rules.yaml`<br>`user-wrap.md` | **Dynamic hot-reload**: Automatically reloaded based on file mtime; takes effect on the next turn immediately. |
| **Search Thesaurus** | `thesaurus/*.txt` | **Dynamic hot-reload**: Automatically reloaded upon save; takes effect on next code search. |
| **Project Instructions & Knowledge Packs** | `AGENTS.md`<br>`rules.md`, `glossary.md`, `dbwords.md` | **Dynamic hot-reload**: Read fresh at the start of every turn. |
| **Main Configuration** | `~/.jeikcode/config.toml` | **Active reload**:<br>• Agent invokes tool `jeikcode_config(action="reload")` (takes effect next turn);<br>• WebUI / TUI enter `/reload`. |
| **MCP External Tools** | `mcp.json` / `.mcp.json`<br>CLI `jeikcode mcp add` | **Active reload**:<br>• Agent invokes tool `jeikcode_config(action="reload")`;<br>• WebUI / TUI enter `/mcp reload`;<br>• WebUI sidebar MCP menu click "Refresh button". |
| **Skills** | `skills/<name>/SKILL.md` | **Active reload**: Invoke `jeikcode_config(action="reload")` or enter `/reload`. |
