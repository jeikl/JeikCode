# Keybindings & Sessions

JeikCode provides a robust session management system with automated state persistence, turn rollbacks, and intuitive keyboard shortcuts.

---

## Terminal Keybindings

| Shortcut | Description |
| :--- | :--- |
| <kbd>Enter</kbd> | Send current prompt in the input field |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> or <kbd>Alt</kbd> + <kbd>Enter</kbd> | Insert a new line in the input field |
| <kbd>Ctrl</kbd> + <kbd>C</kbd> | Interrupt active streaming generation or cancel running tool command |
| <kbd>Ctrl</kbd> + <kbd>D</kbd> | Exit session when the input field is empty |
| <kbd>Ctrl</kbd> + <kbd>L</kbd> | Clear terminal screen (preserves conversation context) |
| <kbd>Up</kbd> / <kbd>Down</kbd> | Cycle through prompt history |
| <kbd>Tab</kbd> | Autocomplete slash commands and file paths |

---

## Session Lifecycle & Persistence

### 1. Automatic Save & Resume
Every turn, tool invocation, and decision is written to local durable storage. If you exit or your terminal closes unexpectedly, relaunching `jeikcode` in the same directory allows you to resume your previous workspace context with zero data loss.

### 2. KV Cache Protection (Sacred Floor)
To maximize **Prompt Caching** benefits across modern LLM providers:
- JeikCode enforces an **Append-only** prefix immutability contract;
- Environment facts and project instructions (such as `AGENTS.md`) are consolidated once at session boot;
- Persistent memory items are safeguarded by the `sacred_floor` guarantee so they are never evicted during context summarization.

---

## Rewind & Checkpoints

When an agent explores an unhelpful direction during complex refactoring:

### 1. Terminal `/undo`
Executing `/undo` compares Git working tree states, reverts all uncommitted file changes made in the last turn, and steps conversation history back by one turn.

### 2. WebUI Turn Rewind
In the WebUI, every assistant turn card contains a "Rewind" button. Clicking it safely truncates the conversation and associated branch state back to that point, letting you refine your prompt and try a different approach.
