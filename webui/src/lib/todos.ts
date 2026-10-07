/**
 * Session todo list — TUI `active_todos` panel parity for WebUI.
 *
 * The `todowrite` / `todo` tools are stateless: the model either sends a full
 * plan (`{"todos":[…]}`), an incremental batch (`{"actions":[…]}`), or a single
 * incremental action (`{"action":"add|update|...",…}`).
 * Current list is folded over the transcript the same way as
 * `jeikcode_capabilities::tools::todo::reduce_todos`.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

type ActionKind = 'add' | 'insert' | 'update' | 'delete' | 'clear';

export function isTodoTool(name: string): boolean {
  return name === 'todo_write' || name === 'todowrite' || name === 'todo';
}

function parseStatus(s: string): TodoStatus | null {
  if (s === 'pending' || s === 'in_progress' || s === 'completed') return s;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actionKind(value: Record<string, unknown>): ActionKind | null {
  const action = typeof value.action === 'string' ? value.action : null;
  if (action === 'add' || action === 'insert' || action === 'update' || action === 'clear') {
    return action;
  }
  if (action === 'delete' || action === 'remove') return 'delete';
  if (action) return null;
  const hasId = jsonId(value) !== null;
  const content =
    typeof value.content === 'string' ? value.content.split(/\s+/).filter(Boolean).join(' ') : '';
  const hasContent = content.length > 0;
  const hasStatus = typeof value.status === 'string' && parseStatus(value.status) !== null;
  const hasPosition =
    value.position !== undefined || value.after !== undefined || value.after_id !== undefined;
  if (!hasId && hasContent && hasPosition) return 'insert';
  if (!hasId && hasContent) return 'add';
  if (hasId && (hasContent || hasStatus) && !hasPosition) return 'update';
  if (hasId && !hasContent && !hasStatus && !hasPosition) return 'delete';
  return null;
}

function parseNonNegInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function jsonId(value: Record<string, unknown>): number | null {
  const id = parseNonNegInt(value.id);
  return id !== null && id >= 1 ? id : null;
}

function insertPosition(value: Record<string, unknown>): number | null {
  const direct = parseNonNegInt(value.position !== undefined ? value.position : value.id);
  if (direct !== null) return direct;
  const after = parseNonNegInt(value.after !== undefined ? value.after : value.after_id);
  return after === null ? null : after + 1;
}

function validateActionsMix(actions: Record<string, unknown>[]): boolean {
  const kinds = new Set<ActionKind>();
  for (const item of actions) {
    const kind = actionKind(item);
    if (!kind) return false;
    kinds.add(kind);
  }
  if (kinds.has('delete') && [...kinds].some((kind) => kind !== 'delete')) return false;
  if (kinds.has('insert') && [...kinds].some((kind) => kind !== 'insert' && kind !== 'update')) {
    return false;
  }
  if (kinds.has('clear') && [...kinds].some((kind) => kind !== 'clear' && kind !== 'add' && kind !== 'update')) {
    return false;
  }
  return true;
}

function maybeAutoClearFinished(list: TodoItem[]): TodoItem[] {
  if (list.length > 0 && list.every((item) => item.status === 'completed')) return [];
  return list;
}

function normalizeTodoContent(content: string): string {
  return content.split(/\s+/).filter(Boolean).join(' ');
}

function findTodoIndex(list: TodoItem[], content: string): number {
  return list.findIndex((item) => item.content === content);
}

function destinationIndex(position: number | null, len: number): number {
  if (position === null) return len;
  if (position <= 1) return 0;
  if (position - 1 <= len) return position - 1;
  return len;
}

function ensureSingleInProgress(list: TodoItem[], idx: number): TodoItem[] {
  return list.map((item, i) => {
    if (i === idx) return item;
    if (item.status === 'in_progress') return { ...item, status: 'pending' as const };
    return item;
  });
}

/** Same title never appears twice. `position` is 1-based rank; omit to keep/append. */
function upsertTodo(
  list: TodoItem[],
  content: string,
  status: TodoStatus | null,
  position: number | null,
): { list: TodoItem[]; landing: number } {
  const existing = findTodoIndex(list, content);
  if (existing >= 0 && position === null) {
    const next = list.map((item, i) => (
      i === existing && status ? { ...item, status } : item
    ));
    const ranked = status === 'in_progress' ? ensureSingleInProgress(next, existing) : next;
    return { list: ranked, landing: existing + 1 };
  }
  let working = list.map((item) => ({ ...item }));
  let item: TodoItem;
  if (existing >= 0) {
    item = working.splice(existing, 1)[0]!;
    if (status) item = { ...item, status };
  } else {
    item = { content, status: status ?? 'pending' };
  }
  const idx = destinationIndex(position, working.length);
  working.splice(idx, 0, item);
  if (working[idx]!.status === 'in_progress') working = ensureSingleInProgress(working, idx);
  return { list: working, landing: idx + 1 };
}

function parseActionStatus(value: Record<string, unknown>): TodoStatus | null {
  return typeof value.status === 'string' ? parseStatus(value.status) : null;
}

function resolveUpdateId(
  id: number,
  visibleLen: number,
  addLandings: number[],
  newLen: number,
): number | null {
  if (id < 1) return null;
  if (addLandings.length > 0 && id > visibleLen) {
    const k = id - visibleLen;
    if (k >= 1 && k <= addLandings.length) return addLandings[k - 1]!;
  }
  return id <= newLen ? id : null;
}

/** Full-list plan shape. Returns null when args are not a valid plan. */
export function parseTodoPlan(args: string): TodoItem[] | null {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  // `actions` takes precedence over leftover `todos` field (same as Rust backend).
  if (Array.isArray(value.actions)) return null;

  let todos = value.todos;
  // Tolerate a single-layer stringified array (same as Rust parse_todos).
  if (typeof todos === 'string') {
    try {
      const decoded = JSON.parse(todos);
      if (Array.isArray(decoded)) todos = decoded;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(todos)) return null;
  const out: TodoItem[] = [];
  for (const raw of todos) {
    if (!isRecord(raw)) return null;
    const content = typeof raw.content === 'string' ? normalizeTodoContent(raw.content) : '';
    const status = typeof raw.status === 'string' ? parseStatus(raw.status) : null;
    if (!content || !status) return null;
    const next = upsertTodo(out, content, status, null);
    out.length = 0;
    out.push(...next.list);
  }
  return out;
}

function applyOne(list: TodoItem[], v: Record<string, unknown>): TodoItem[] {
  const kind = actionKind(v);
  if (kind === 'add') {
    const content = typeof v.content === 'string' ? normalizeTodoContent(v.content) : '';
    if (!content) return list;
    return upsertTodo(maybeAutoClearFinished(list), content, parseActionStatus(v), null).list;
  }
  if (kind === 'insert') {
    const content = typeof v.content === 'string' ? normalizeTodoContent(v.content) : '';
    if (!content) return list;
    return upsertTodo(list, content, parseActionStatus(v), insertPosition(v)).list;
  }
  if (kind === 'update') {
    const id = jsonId(v);
    const status = parseActionStatus(v);
    const content = typeof v.content === 'string' ? normalizeTodoContent(v.content) : '';
    if (id === null || id < 1 || id > list.length || (!status && !content)) return list;
    return applyUpdateAt(list, id, status, content || null);
  }
  if (kind === 'delete') {
    const id = jsonId(v);
    if (id === null || id < 1 || id > list.length) return list;
    const next = list.map((item) => ({ ...item }));
    next.splice(id - 1, 1);
    return next;
  }
  if (kind === 'clear') {
    return [];
  }
  return list;
}

function applyUpdateAt(
  list: TodoItem[],
  id: number,
  status: TodoStatus | null,
  content: string | null,
): TodoItem[] {
  const idx = id - 1;
  let next = list.map((item) => ({ ...item }));
  if (content) {
    const other = findTodoIndex(next, content);
    if (other >= 0 && other !== idx) {
      if (status) next[other] = { ...next[other]!, status };
      next.splice(idx, 1);
      const kept = other > idx ? other - 1 : other;
      return status === 'in_progress' ? ensureSingleInProgress(next, kept) : next;
    }
    next[idx] = { ...next[idx]!, content };
  }
  if (status) {
    next[idx] = { ...next[idx]!, status };
    if (status === 'in_progress') next = ensureSingleInProgress(next, idx);
  }
  return next;
}

function applyBatch(list: TodoItem[], actions: Record<string, unknown>[]): TodoItem[] {
  if (!validateActionsMix(actions)) return list;
  const kinds = new Set(actions.map(actionKind));
  let next = kinds.has('clear') ? [] : list;

  if (kinds.has('delete')) {
    const ids: number[] = [];
    for (const action of actions) {
      const id = jsonId(action);
      if (id !== null && id <= list.length && !ids.includes(id)) {
        ids.push(id);
      }
    }
    ids.sort((a, b) => b - a);
    const deleted = next.slice();
    for (const id of ids) deleted.splice(id - 1, 1);
    return deleted;
  }

  const visibleLen = next.length;
  const addLandings: number[] = [];
  if (actions.some((action) => actionKind(action) === 'add')) {
    next = maybeAutoClearFinished(next);
    for (const action of actions) {
      if (actionKind(action) !== 'add') continue;
      const content = typeof action.content === 'string' ? normalizeTodoContent(action.content) : '';
      if (!content) continue;
      const added = upsertTodo(next, content, parseActionStatus(action), null);
      next = added.list;
      addLandings.push(added.landing);
    }
  }

  const inserts = actions
    .filter((action) => actionKind(action) === 'insert')
    .sort((a, b) => (insertPosition(b) ?? Number.POSITIVE_INFINITY) - (insertPosition(a) ?? Number.POSITIVE_INFINITY));
  for (const action of inserts) {
    next = applyOne(next, action);
  }

  for (const action of actions) {
    if (actionKind(action) !== 'update') continue;
    const id = jsonId(action);
    if (id === null) continue;
    const resolved = resolveUpdateId(id, visibleLen, addLandings, next.length);
    if (resolved === null) continue;
    const status = parseActionStatus(action);
    const content = typeof action.content === 'string' ? normalizeTodoContent(action.content) : '';
    if (!status && !content) continue;
    next = applyUpdateAt(next, resolved, status, content || null);
  }
  return next;
}

/** Apply one incremental action or actions batch; returns a new array (or same ref if no-op). */
export function applyTodoAction(list: TodoItem[], args: string): TodoItem[] {
  let v: Record<string, unknown>;
  try {
    const parsed = JSON.parse(args);
    if (!isRecord(parsed)) return list;
    v = parsed;
  } catch {
    return list;
  }

  if (Array.isArray(v.actions)) {
    const actions = v.actions.filter(isRecord);
    if (actions.length !== v.actions.length || actions.length === 0) return list;
    return applyBatch(list, actions);
  }

  return applyOne(list, v);
}

function isClearActionCall(args: string): boolean {
  try {
    const v = JSON.parse(args);
    if (!isRecord(v)) return false;
    if (Array.isArray(v.actions)) {
      return v.actions.some((a) => isRecord(a) && actionKind(a) === 'clear');
    }
    return actionKind(v) === 'clear';
  } catch {
    return false;
  }
}

/**
 * Fold ordered todo-affecting tool calls into the current list.
 * Last full plan or clear action is the baseline; later action calls patch it.
 * If no full plan or clear exists in the current calls window, fallback to `baselineFallback`.
 */
export function reduceTodosFromCalls(
  calls: Iterable<{ name: string; args: string }>,
  baselineFallback?: TodoItem[] | null,
): TodoItem[] {
  const filtered = Array.from(calls).filter((c) => isTodoTool(c.name));
  let baselineIdx = -1;
  for (let i = filtered.length - 1; i >= 0; i--) {
    const args = filtered[i]!.args;
    if (parseTodoPlan(args) || isClearActionCall(args)) {
      baselineIdx = i;
      break;
    }
  }
  let list: TodoItem[] = [];
  let start = 0;
  if (baselineIdx >= 0) {
    const baselineArgs = filtered[baselineIdx]!.args;
    const fullPlan = parseTodoPlan(baselineArgs);
    if (fullPlan) {
      list = fullPlan;
    } else {
      // It's a clear-action call: apply it to an empty list to capture any trailing adds/inserts in the same batch
      list = applyTodoAction([], baselineArgs);
    }
    start = baselineIdx + 1;
  } else if (baselineFallback && baselineFallback.length > 0) {
    // 关键防线：若在当前调用窗口内未找到全量 plan 或 clear（例如全量计划发生在历史分页之外），
    // 坚决以传入的 baselineFallback（上一轮留存或服务端权威清单）为底座应用增量 actions，
    // 绝不允许从空数组 [] 开始导致前面的全部任务离奇蒸发！
    list = baselineFallback.map((item) => ({ ...item }));
    start = 0;
  }
  for (let i = start; i < filtered.length; i++) {
    list = applyTodoAction(list, filtered[i]!.args);
  }
  return list;
}

/** Apply one live tool call onto the current panel list. */
export function foldTodoToolCall(
  current: TodoItem[] | null,
  name: string,
  args: string,
): TodoItem[] | null {
  if (!isTodoTool(name)) return current;
  const plan = parseTodoPlan(args);
  if (plan) return plan.length > 0 ? plan : null;
  const base = current ?? [];
  const next = applyTodoAction(base, args);
  return next.length > 0 ? next : null;
}

export function todoCounts(items: TodoItem[]): {
  completed: number;
  inProgress: number;
  total: number;
} {
  let completed = 0;
  let inProgress = 0;
  for (const t of items) {
    if (t.status === 'completed') completed += 1;
    else if (t.status === 'in_progress') inProgress += 1;
  }
  return { completed, inProgress, total: items.length };
}

/** Display-message shape used to rebuild the sticky panel after a session switch. */
export interface StickyTodoMessage {
  role: string;
  parts?: Array<{
    kind: string;
    tool?: { id?: string; name: string; args: string };
    items?: TodoItem[];
  }>;
}

function unfinishedTodos(items: TodoItem[] | null | undefined): TodoItem[] | null {
  if (!items || items.length === 0) return null;
  if (items.every((item) => item.status === 'completed')) return null;
  return items;
}

function collectTodoCalls(messages: StickyTodoMessage[]): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.parts) continue;
    for (const part of message.parts) {
      if (part.kind === 'tool' && part.tool && isTodoTool(part.tool.name)) {
        calls.push({ name: part.tool.name, args: part.tool.args });
      }
    }
  }
  return calls;
}

function unfinishedTodoListFromParts(messages: StickyTodoMessage[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.kind !== 'todo_list' || !part.items?.length) continue;
      return unfinishedTodos(part.items);
    }
  }
  return null;
}

/**
 * Rebuild the composer sticky todo panel from a transcript window.
 *
 * Unfinished plans are intentionally not frozen onto assistant bubbles, so
 * looking for a trailing `todo_list` part after a sidebar switch always
 * missed the live panel. Fold `todowrite` tool rows instead (TUI
 * `todo_progress_from_messages` parity). Keep `stashed` when the visible
 * window only has incremental updates — the original plan may sit outside
 * the history tail.
 */
export function restoreStickyTodos(input: {
  messages: StickyTodoMessage[];
  stashed?: TodoItem[] | null;
  authoritativeTodos?: TodoItem[] | null;
}): TodoItem[] | null {
  if (input.authoritativeTodos && input.authoritativeTodos.length > 0) {
    return unfinishedTodos(input.authoritativeTodos);
  }
  const calls = collectTodoCalls(input.messages);
  if (calls.length > 0) {
    const rawFolded = reduceTodosFromCalls(calls, input.stashed);
    // 若历史调用折叠出的清单全部已完成，代表该轮计划已全部结算，严禁回退 stashed 招魂复活！
    if (rawFolded.length > 0 && rawFolded.every((item) => item.status === 'completed')) {
      return null;
    }
    const folded = unfinishedTodos(rawFolded);
    if (folded) return folded;
    if (calls.some((call) => parseTodoPlan(call.args) || isClearActionCall(call.args))) return null;
    return unfinishedTodos(input.stashed);
  }
  return unfinishedTodoListFromParts(input.messages) ?? unfinishedTodos(input.stashed);
}

export function todoCallIdsFromMessages(messages: StickyTodoMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.parts) continue;
    for (const part of message.parts) {
      const id = part.tool?.id;
      if (part.kind === 'tool' && part.tool && isTodoTool(part.tool.name) && id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/** React state can still be null when the first watch event arrives, even
 *  though the session load already stored the server list on a ref. An
 *  incremental update folded onto `[]` keeps only the rows that call
 *  mentioned and drops the rest of the plan.
 */
export function todoBaselineForLiveApply(
  state: TodoItem[] | null | undefined,
  remembered: TodoItem[] | null | undefined,
): TodoItem[] | null {
  if (state && state.length > 0) return state;
  if (remembered && remembered.length > 0) return remembered;
  return null;
}

/**
 * Apply a live/watch `todowrite` once per call id. `/chat/watch` replays the
 * whole turn; folding the same start twice would stack incremental adds onto
 * the seeded panel.
 */
export function applyLiveTodoToolCall(input: {
  current: TodoItem[] | null;
  name: string;
  args: string;
  callId?: string;
  appliedIds: Set<string>;
}): TodoItem[] | null {
  if (input.callId && input.appliedIds.has(input.callId)) return input.current;
  if (input.callId) input.appliedIds.add(input.callId);
  return foldTodoToolCall(input.current, input.name, input.args);
}

/**
 * Mid-turn disk catch-up must not overlay the SSE-driven sticky panel.
 * `undefined` means leave the live panel alone; a value replaces it.
 */
export function stickyFromDiskCatchUp(input: {
  running: boolean;
  messages: StickyTodoMessage[];
  stashed?: TodoItem[] | null;
  authoritativeTodos?: TodoItem[] | null;
}): TodoItem[] | null | undefined {
  if (input.running) return undefined;
  return restoreStickyTodos({
    messages: input.messages,
    stashed: input.stashed,
    authoritativeTodos: input.authoritativeTodos,
  });
}

/**
 * Attach folded todos to the last assistant message that owns todowrite calls.
 * Used when converting session history so completed turns keep a frozen list
 * under the reply (not a sticky panel).
 */
export function attachTodosToAssistantParts(
  parts: Array<{ kind: string; tool?: { name: string; args: string }; items?: TodoItem[] }>,
  items: TodoItem[],
): void {
  if (items.length === 0) return;
  // Strip any previous frozen list then append.
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.kind === 'todo_list') parts.splice(i, 1);
  }
  parts.push({ kind: 'todo_list', items: items.map((i) => ({ ...i })) });
}
