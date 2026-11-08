/** Ephemeral composer history. Only original, accepted input belongs here. */
export class InputHistory {
  private entries = new Map<string, string[]>();
  private context = '';
  private cursor: number | null = null;
  private draft = '';
  private recalled: string | null = null;
  private browsingEntries: string[] | null = null;

  switchContext(key: string) {
    if (key === this.context) return;
    this.context = key;
    // Map insertion order is the LRU order, including context revisits.
    const entries = this.entries.get(key);
    if (entries) {
      this.entries.delete(key);
      this.entries.set(key, entries);
    }
    this.reset();
  }

  reset() {
    this.cursor = null;
    this.draft = '';
    this.recalled = null;
    this.browsingEntries = null;
  }

  edit(value: string) {
    this.reset();
    this.draft = value;
  }

  record(key: string, value: string) {
    if (!value.trim()) return;
    const entries = this.entries.get(key) ?? [];
    if (entries[entries.length - 1] !== value) entries.push(value);
    if (entries.length > 100) entries.splice(0, entries.length - 100);
    this.entries.delete(key);
    this.entries.set(key, entries);
    while (this.entries.size > 32) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    // An asynchronous acknowledgement must not discard an active draft.
  }

  navigate(direction: 'up' | 'down', value: string): string | null {
    // Programmatic composer edits also leave navigation, not just onInput.
    if (this.cursor !== null && value !== this.recalled) this.edit(value);
    const entries = this.browsingEntries ?? this.entries.get(this.context) ?? [];
    if (!entries.length) return null;
    if (this.cursor === null) {
      if (direction === 'down') return null;
      this.draft = value;
      this.browsingEntries = entries.slice();
      this.cursor = entries.length - 1;
    } else if (direction === 'up') {
      this.cursor = Math.max(0, this.cursor - 1);
    } else {
      this.cursor++;
      if (this.cursor >= entries.length) {
        const draft = this.draft;
        this.reset();
        return draft;
      }
    }
    this.recalled = entries[this.cursor];
    return this.recalled;
  }
}

/**
 * Input-history bucket key.
 *
 * A persisted session id is globally unique and remains stable while a brand-
 * new session's first prompt is accepted before its project metadata arrives.
 * Keying accepted history by session id alone keeps that first prompt in the
 * same bucket the bound session resolves to. The project only scopes the
 * unsaved composer (no session id yet), where it prevents recall from leaking
 * across projects.
 */
export function inputHistoryKey(project: string, session: string | null | undefined): string {
  return session
    ? JSON.stringify(['session', session])
    : JSON.stringify(['draft', project]);
}

/**
 * History recall is opt-in: only an empty composer or a fully selected one may
 * consume Up/Down. With a caret inside a draft, arrows keep their native
 * line/caret movement so editing a prompt never replaces the user's text with
 * a remembered command.
 *
 * Recalled entries are selected after insertion (see Chat.tsx), so consecutive
 * Up/Down still satisfies the empty-or-fully-selected contract. Clicking into
 * the recalled text collapses that selection and returns arrows to editing.
 */
export function canNavigateInputHistory(event: {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  currentTarget: { value: string; selectionStart: number | null; selectionEnd: number | null } | null;
}): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  const ta = event.currentTarget;
  if (!ta || ta.selectionStart === null || ta.selectionEnd === null) return false;
  const value = ta.value;
  if (value.length === 0) return true;
  const start = Math.min(ta.selectionStart, ta.selectionEnd);
  const end = Math.max(ta.selectionStart, ta.selectionEnd);
  return start === 0 && end === value.length;
}
