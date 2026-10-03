# Agent Skills Ecosystem

JeikCode supports modular Agent Skills. Skills package specialized domain instructions, automated workflows, API conventions, and prompt templates into reusable bundles that can be invoked on demand or discovered semantically.

---

## 1. What is an Agent Skill?

Unlike simple one-line prompts, a Skill is an independent operational module with **trigger specifications, execution rules, and prompt templating**.
When a user's prompt matches the description of an available skill, the agent autonomously activates that workflow; users can also explicitly invoke skills directly in the prompt or slash command menu.

---

## 2. Directory Hierarchy & Priority

JeikCode scans and loads skills in the following order:

1. **Workspace Project-Level**: `<workspace>/.skills/<skill-name>/SKILL.md` (highest priority, version-controlled with the repository);
2. **Global User-Level**: `~/.jeikcode/skills/<skill-name>/SKILL.md` (shared across all projects).

Project-level skills override global skills with matching names.

---

## 3. WebUI Visual Management & Quick Insertion

In the browser WebUI, discovering and using skills is seamless:

- **Sidebar Skills Panel**: Click the **Skills** icon in the sidebar to browse all loaded skills and view their purpose;
- **Quick Attachment Menu (`+` Button)**: Click the `+` button beside the input box and choose "Insert Skill" to automatically format and insert `/<skill-name>` into your prompt;
- **Terminal Inspection**: In the TUI terminal, type `/skills` to list all currently loaded capabilities.

---

## 4. `SKILL.md` Standard Format & Guidelines

Each skill is a self-contained directory whose entrypoint must be named `SKILL.md`, containing YAML frontmatter metadata at the top:

```markdown
---
name: code-review-expert
description: Deep code security and performance audit checking for null pointers, race conditions, and resource leaks.
---

# Code Review Expert Guide

You are an expert systems architect. Review the provided code against these criteria:

1. **Concurrency & Race Conditions**: Are locks held properly? Is there any risk of deadlocks?
2. **Resource Leaks**: Are open file descriptors, connections, and streams cleanly disposed of?
3. **Security Vulnerabilities**: SQL injection, unvalidated deserialization, or plaintext secrets.
4. **Performance Bottlenecks**: Expensive object cloning or unintentional O(N^2) loops.

## Guidelines
- Highlight the highest severity issues first;
- Provide exact line references and before/after diff recommendations.
```

---

## 5. Recommended Best Practice: Progressive Subdirectory Structure

To prevent a single `SKILL.md` file from overwhelming the model context window during cold starts, adopt a tiered directory layout:

```text
.skills/my-feature-expert/
├── SKILL.md            # Core workflow and trigger description (compact, ~100-300 tokens)
├── references/         # In-depth technical docs and API schemas, read on-demand via read_file
│   └── api-spec.md
└── scripts/            # Helper scripts, fixtures, or verification templates
    └── verify.sh
```

---

## 6. Dynamic Arguments & Instant Reload

- **Parameter Interpolation**: Use `$ARGUMENTS` or `$0` inside the skill template to receive user-supplied arguments;
- **Instant Hot-Reload on Save**: After creating or updating `SKILL.md`, click the **Refresh button** in the WebUI sidebar or execute `/reload` in the terminal. The runtime reloads immediately, and the skill becomes active in your next turn without restarting.
