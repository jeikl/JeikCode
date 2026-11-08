/**
 * Wire normalization for the session checklist.
 *
 * The daemon owns a single `TodoBoard` per session. A completed board is closed
 * on stop, so the authoritative snapshot is "no items". Historically the API
 * omitted the `todos` field when it was empty, which is indistinguishable from
 * "this daemon has no todo support". The WebUI then fell back to the stashed /
 * IndexedDB list and resurrected the old plan after a reconnect or switch.
 *
 * A daemon that knows about checklist revisions always emits `todos_revision`.
 * Therefore: missing `todos` + present `todos_revision` means an explicit empty
 * snapshot, and must be normalized to `[]` at the one wire boundary.
 */

export type TodoWireStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoWireSnapshot {
  todos?: Array<{ id?: string; content: string; status: TodoWireStatus }>;
  todos_revision?: number;
}

export function normalizeSessionTodoSnapshot<T extends TodoWireSnapshot>(detail: T): T {
  if (detail.todos === undefined && typeof detail.todos_revision === 'number') {
    return { ...detail, todos: [] };
  }
  return detail;
}
