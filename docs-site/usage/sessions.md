# Keybindings & Sessions

JeikCode combines a durable session store, checkpoint-based rewind and terminal keybindings so that long-running work survives restarts and bad turns.

---

## Terminal Keybindings

| Shortcut | Description |
| :--- | :--- |
| <kbd>Enter</kbd> | Send the current prompt |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> or <kbd>Alt</kbd> + <kbd>Enter</kbd> | Insert a new line |
| <kbd>Ctrl</kbd> + <kbd>C</kbd> | Interrupt streaming or cancel the running tool |
| <kbd>Ctrl</kbd> + <kbd>D</kbd> | Exit the session when the input field is empty |
| <kbd>Ctrl</kbd> + <kbd>L</kbd> | Clear the screen while keeping the conversation |
| <kbd>Up</kbd> / <kbd>Down</kbd> | Cycle through prompt history |
| <kbd>Tab</kbd> | Autocomplete slash commands and file paths |

---

## Session Lifecycle & Management

### 1. Session Commands

- **`/sessions`** (aliases `/resume`, `/continue`): open the interactive session picker and switch to any saved session, including its messages, working directory and model;
- **`/new`**: start a clean conversation in the current directory;
- **`/rename <name>`**: rename the current session in the picker and the WebUI sidebar;
- **`/cd <path>`**: change the working directory and start a new session there.

### 2. Automatic Save & Resume

Every turn, tool call and decision is persisted locally. After a crash, an accidental exit or a reboot, run `jeikcode` in the same directory (or use `/sessions`) and continue from the last committed state.

---

## KV Cache Protection (Sacred Floor)

To maximize provider prompt caching:

- the conversation prefix is append-only and byte-stable;
- environment facts and project instructions (such as `AGENTS.md`) are consolidated once at session start;
- memory entries written through `/remember` and `memory.md` are protected by `sacred_floor`, so context compaction never evicts them.

---

## Undo, Rewind & Checkpoints

### 1. Conversation-only `/undo`

`/undo` (or `/undo N`) rolls the conversation memory back by one or N turns and restores that turn's prompt to the input field. **It never modifies files on disk** — use `/rewind` when code should move too.

### 2. Terminal `/rewind` Picker

`/rewind` (or double-<kbd>Esc</kbd> while the input is idle) opens the checkpoint picker:

- browse the snapshots recorded per turn;
- **conversation restore is available today**;
- code restore is shown as unavailable with an explicit reason — the per-session shadow store has no bounded GC/quota yet, so enabling it could exhaust the disk. Conversation rewind is unaffected.

### 3. WebUI Visual Rewind

Every assistant turn card in the WebUI has a rewind action. It truncates the conversation and branch state back to that point so you can revise the prompt and continue. Code restore follows the same gate as the terminal picker (currently unavailable).
