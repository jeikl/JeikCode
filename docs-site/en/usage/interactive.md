# Interactive Questions & Approvals

To prevent models from making arbitrary destructive changes or guessing when multiple architectural paths exist, JeikCode integrates **interactive user clarification** and **action approval gates**.

---

## Interactive Clarification (`request_user_input`)

When task requirements are ambiguous, multiple viable alternatives exist, or specific secrets/credentials are missing, JeikCode actively prompts for input:

```text
? Please select the migration strategy:
  ❯ 1. Strategy A: Smooth migration with backward-compatible deprecation
    2. Strategy B: Breaking refactor directly to the new architecture
    3. Strategy C: Custom user approach
```

### Supported Question Formats
1. **Single Choice**: Select one option among mutually exclusive architectural or configuration options;
2. **Multiple Choice**: Check multiple components, flags, or test suites to include;
3. **Text Input**: Securely prompt for unconfigured API tokens, custom port numbers, or file paths.

Use arrow keys, space, and enter in the terminal, or click directly on interactive card buttons in the WebUI.

---

## Action Approval Gates

JeikCode categorizes operations by risk level to provide strict safety boundaries:

### 1. Auto-Approved Read Actions
- Inspecting files (`read_file`), searching patterns (`grep`), directory listings (`list_directory`);
- Symbol tracing via AST code graphs (`code_explore`, `repo_map`);
- Safe read-only shell commands (e.g. `git status`, `cargo check`).

### 2. Guarded Destructive Actions
- Large-scale directory deletions or bulk file rewrites;
- Dangerous shell invocations (`rm -rf`, process killing, privilege escalations);
- Outbound network requests sending unverified payloads to untrusted endpoints.

When a guarded action is triggered, both the terminal and WebUI highlight the diff or command, pausing execution until you grant explicit approval.
