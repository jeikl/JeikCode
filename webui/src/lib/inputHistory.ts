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

export function inputHistoryKey(project: string, session: string | null | undefined): string {
  return JSON.stringify([project, session ?? null]);
}

/** Logical lines, not wrapped visual lines; keep native selection/IME behavior. */
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
  const ta = event.currentTarget;
  if (!ta || ta.selectionStart === null || ta.selectionStart !== ta.selectionEnd) return false;
  const pos = ta.selectionStart;
  if (event.key === 'ArrowUp') return !/[\r\n]/.test(ta.value.slice(0, pos));
  if (event.key === 'ArrowDown') return !/[\r\n]/.test(ta.value.slice(pos));
  return false;
}
