# 07 - Project Constraints and Rules Configuration Guide (Project Constraints & Rules)

---

## 1. Three-Tier Project Instruction Hierarchy

The system automatically resolves and injects project instructions in hierarchical order (higher precedence overrides lower precedence):

| Tier | File Path (First matching hit in order) | Purpose & Nuances |
| :--- | :--- | :--- |
| **1. Global Tier** | `~/.jeikcode/AGENTS.md`<br>`~/.jeikcode/JEIKCODE.md` | Universal cross-project development directives. |
| **2. Project Tier** | `1. .jeikcode.md`<br>`2. JEIKCODE.md`<br>`3. AGENTS.md`<br>`4. CLAUDE.md`<br>`5. claude.md` | **Core project standards** (architecture boundaries, coding style, commit rules). Recommended to commit to Git for team sharing. |
| **3. User Tier** | `.jeikcode.user.md` | **Personal local developer preferences**. Higher precedence than project-level `AGENTS.md`, typically git-ignored so it doesn't affect team members. |

> Note: User provisions take effect alongside system rules without conflict; when conflicting, user provisions take strict precedence (except core safety gates and destructive operation confirmation gates).

---

## 2. Three Domain Business Knowledge Packs

The system supports 3 specialized domain knowledge files within the project, checked and read at the start of every turn:

| Knowledge Pack | Candidate File Paths (First matching hit stops search) | Purpose |
| :--- | :--- | :--- |
| **Domain Glossary (`glossary.md`)** | `.jeikcode/glossary.md`<br>`docs/glossary.md`<br>`glossary.md` | Maps business jargon and domain concepts to code symbols and classes. |
| **Business Rules (`rules.md`)** | `.jeikcode/rules.md`<br>`docs/rules.md`<br>`rules.md` | Business logic, approval workflows, and state machine constraints. |
| **Database Dictionary (`dbwords.md`)** | `.jeikcode/dbwords.md`<br>`docs/dbwords.md`<br>`dbwords.md` | Table names, column definitions, and entity relationship mappings. |

- **Search Semantics**: Knowledge packs stop at the **first hit** in the candidate order. For example, finding `.jeikcode/glossary.md` immediately stops searching and does not merge with `docs/glossary.md`.

---

## 3. Project-Specific Capability Extension Paths

| Extension | Path Location |
| :--- | :--- |
| **Project Skills** | `<workspace>/.skills/<skill-name>/SKILL.md` or `<workspace>/.jeikcode/skills/<skill-name>/SKILL.md` |
| **Prompt Wrap** | `<workspace>/.jeikcode/user-wrap.md` or `<workspace>/user-wrap.md` |
| **Project MCP** | `<workspace>/.mcp.json` |
| **Project Thesaurus** | `<workspace>/.jeikcode/thesaurus/*.txt` |
| **Index Ignore** | `<workspace>/.codegraphignore` (Ignored when building code graph, even if tracked in git; noise rules also apply to glob/grep) |
| **Credential Ignore (Graph Only)** | `<workspace>/.codegraphignore.graph` (`.env`, secrets, SSH keys hidden **only from graph**; explicit glob/grep can still locate them) |

---

## 4. Recommended Project Directory Layout

```text
my-project/
├── AGENTS.md                 # Project architecture boundaries & development constraints
├── .jeikcode/
│   ├── user-wrap.md          # Project-specific prompt wrapper
│   ├── rules.md              # Business logic & state machine rules
│   ├── glossary.md           # Business terminology glossary
│   ├── dbwords.md            # Database schema dictionary
│   └── thesaurus/
│       └── biz.txt           # Project bilingual thesaurus
├── .skills/
│   └── deploy-check/
│       └── SKILL.md          # Project-specific deployment skill
└── .mcp.json                 # Project-specific MCP servers
```

---

## 5. Reload & Effective Semantics

- **Automatic Hot-Reload**: `AGENTS.md`, `JEIKCODE.md`, `rules.md`, `glossary.md`, `dbwords.md`, `user-wrap.md`, and `thesaurus/*.txt` are read fresh at the start of every turn, **never requiring a restart or reload**.
- **Active Reload Required**: Modifying project-level `.mcp.json` or `.skills/` requires calling `jeikcode_config(action="reload")` or entering `/mcp reload` or `/reload`.
