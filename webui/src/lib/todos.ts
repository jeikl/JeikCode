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

export function isTodoTool(name?: string | null): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase().replace(/[-_]/g, '');
  return n === 'todowrite' || n === 'todo';
}

function parseStatus(s: string): TodoStatus | null {
  const norm = s.trim().toLowerCase().replace(/[-_]/g, '');
  if (norm === 'pending') return 'pending';
  if (norm === 'inprogress') return 'in_progress';
  if (norm === 'completed' || norm === 'done') return 'completed';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actionKind(value: Record<string, unknown>): ActionKind | null {
  const rawAction = typeof value.action === 'string' ? value.action.trim().toLowerCase() : null;
  if (rawAction === 'add' || rawAction === 'insert' || rawAction === 'update' || rawAction === 'clear') {
    return rawAction;
  }
  if (rawAction === 'delete' || rawAction === 'remove') return 'delete';
  if (rawAction) return null;
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

/**
 * 从后端 todo_write 执行返回的文本中提取权威任务清单。
 * 后端 TodoTool 执行完毕后始终会打印出权威的编号清单（`render_todos_numbered`）：
 * 如 `[ ] 1. xxx`（pending）、`[~] 2. xxx`（in_progress）、`[√] 3. xxx`（completed）。
 * 直接解析这一真源，能彻底杜绝前端因本地折叠逻辑与后端分歧导致的任何状态错位与数量偏差。
 */
export function parseTodosFromOutput(output?: string | null): TodoItem[] | null {
  if (!output || typeof output !== 'string') return null;
  const lines = output.split('\n');
  const items: TodoItem[] = [];
  const regex = /^\s*\[([ ~•√xXvV])\]\s*(\d+)\.\s*(.+)$/;
  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const glyph = match[1];
      const content = normalizeTodoContent(match[3]!);
      if (!content) continue;
      let status: TodoStatus = 'pending';
      if (glyph === '~' || glyph === '•') status = 'in_progress';
      else if (glyph === '√' || glyph === 'x' || glyph === 'X' || glyph === 'v' || glyph === 'V') status = 'completed';
      items.push({ content, status });
    }
  }
  return items.length > 0 ? items : null;
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
    return upsertTodo(list, content, parseActionStatus(v), null).list;
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
  const addActions = actions.filter((action) => actionKind(action) === 'add');
  if (addActions.length > 0) {
    // 关键修复：中间状态打完所有勾时，todolist 必须完整保留；
    // 若后续追加新任务（add），严格在既有清单末尾平滑追加，绝不断链清空！
    // 只有显式 action="clear" 才会清空清单。
    for (const action of addActions) {
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
 * Whether a todo call establishes a new batch plan (e.g. 2 or more adds in a single batch).
 */
export function isBatchPlanEstablishment(args: string): boolean {
  try {
    const v = JSON.parse(args);
    if (!isRecord(v)) return false;
    if (Array.isArray(v.actions)) {
      const adds = v.actions.filter((a) => isRecord(a) && actionKind(a) === 'add');
      return adds.length >= 2;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether a todo call initializes or establishes a plan/tasks.
 * Supports both the full-list plan shape (`{"todos":[...]}`) and modern actions (`{"actions":[{"action":"add",...}]}`).
 */
export function isTodoPlanCall(args: string): boolean {
  if (parseTodoPlan(args) !== null) return true;
  try {
    const v = JSON.parse(args);
    if (!isRecord(v)) return false;
    if (Array.isArray(v.actions)) {
      return v.actions.some((a) => isRecord(a) && (actionKind(a) === 'add' || actionKind(a) === 'clear' || actionKind(a) === 'insert'));
    }
    const kind = actionKind(v);
    return kind === 'add' || kind === 'clear' || kind === 'insert';
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
      // It's a clear-action call: apply it to an empty list
      list = applyTodoAction([], baselineArgs);
    }
    start = baselineIdx + 1;
  } else {
    // 关键防线：检查当前调用窗口内是否自带创建/增加任务的 add 动作。
    // 如果窗口内自带有 add，说明调用流具备自闭合的任务定义起点，必须从空数组 [] 起步纯净折叠（与 Rust 后端对齐），
    // 坚决不能以传入的 baselineFallback/stashed（可能已被 update 改写过标题）作为底座再去叠加 add，
    // 否则标题不一致时会被判定为新任务追加在末尾，造成 A B C D E A B C D 的重放灾难！
    // 仅当当前调用窗口纯属分页截断的 update 碎片且无任何 add 时，才采纳 baselineFallback 垫底！
    const hasAdd = filtered.some((c) => {
      try {
        const v = JSON.parse(c.args);
        if (!isRecord(v)) return false;
        if (Array.isArray(v.actions)) {
          return v.actions.some((a) => isRecord(a) && actionKind(a) === 'add');
        }
        return actionKind(v) === 'add';
      } catch {
        return false;
      }
    });
    if (!hasAdd && baselineFallback && baselineFallback.length > 0) {
      list = baselineFallback.map((item) => ({ ...item }));
    }
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
    tool?: { id?: string; name: string; args: string; output?: string };
    items?: TodoItem[];
  }>;
}

function cloneTodos(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

/**
 * The one live checklist for a session.
 *
 * `revision` is the todo tool call the bus last applied. A replay of that
 * same call does not change the document. `resultApplied` is the authoritative
 * tool_result; an earlier tool_start is only a preview of the same revision.
 */
export interface LiveTodoDocument {
  items: TodoItem[];
  revision: string | null;
  resultApplied: boolean;
}

export type LiveTodoEvent =
  | { type: 'preview'; callId?: string; items: TodoItem[] }
  | { type: 'result'; callId?: string; items: TodoItem[] }
  | { type: 'hydrate'; items: TodoItem[] }
  | { type: 'clear' };

/** Bus/hydrate transition. Returns the same document when the event is a replay. */
export function reduceLiveTodo(
  doc: LiveTodoDocument | null,
  event: LiveTodoEvent,
): LiveTodoDocument | null {
  if (event.type === 'clear') return null;
  if (event.type === 'hydrate') {
    return event.items.length > 0
      ? { items: cloneTodos(event.items), revision: null, resultApplied: false }
      : null;
  }
  if (event.items.length === 0) return null;
  if (
    event.callId &&
    doc &&
    doc.revision === event.callId &&
    (event.type === 'preview' || doc.resultApplied)
  ) {
    return doc;
  }
  return {
    items: cloneTodos(event.items),
    revision: event.callId ?? null,
    resultApplied: event.type === 'result',
  };
}

export function liveTodoPanelItems(
  items: TodoItem[] | null | undefined,
): TodoItem[] | null {
  return Array.isArray(items) && items.length > 0 ? items : null;
}

/**
 * Turn reply has stopped (not an in-flight SSE delta).
 * A fully checked list leaves the live document and is archived once.
 * Open items stay live for the next step.
 */
export function settleLiveTodo(doc: LiveTodoDocument | null): {
  archive: TodoItem[] | null;
  next: LiveTodoDocument | null;
} {
  if (!doc || doc.items.length === 0) return { archive: null, next: doc };
  if (!doc.items.every((item) => item.status === 'completed')) {
    return { archive: null, next: doc };
  }
  return { archive: cloneTodos(doc.items), next: null };
}

/**
 * Live panel after a switch or reload.
 * The server list replaces the document. Message parts are history and are
 * not folded back into the live document.
 */
export function restoreStickyTodos(input: {
  messages: StickyTodoMessage[];
  stashed?: TodoItem[] | null;
  authoritativeTodos?: TodoItem[] | null;
}): TodoItem[] | null {
  if (Array.isArray(input.authoritativeTodos)) {
    return input.authoritativeTodos.length > 0 ? cloneTodos(input.authoritativeTodos) : null;
  }
  return input.stashed && input.stashed.length > 0 ? cloneTodos(input.stashed) : null;
}

/**
 * 回合结束后，输入框上方 sticky 面板应该展示哪份清单。
 *
 * 规则：**部分完成必须保留全量**（含已完成项），否则用户 Stop 时 10 项会
 * 突然缩成 2 项未完成；只有「全部完成」才代表本回合已归档、不应再挂回输入区。
 * 空清单返回 null（不要用空数组覆盖仍在途的面板）。
 */
export function stickyTodosAfterTerminal(
  items: TodoItem[] | null | undefined,
): TodoItem[] | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  if (items.every((item) => item.status === 'completed')) return null;
  return cloneTodos(items);
}

/**
 * 全部完成后，贴到这次停止时的最后一条助手消息尾部，且只有一份。
 * 不按最早的 todo 调用回贴，避免下一轮中途停止时把上一份完成清单画到新消息上。
 */
export function placeArchivedTodos<T extends {
  role: string;
  isSteer?: boolean;
  parts: Array<{ kind: string; text?: string; tool?: { id?: string }; items?: TodoItem[] }>;
}>(
  messages: T[],
  items: TodoItem[],
  _revision: string | null,
): T[] {
  if (items.length === 0 || !items.every((item) => item.status === 'completed')) return messages;
  // A steer/new turn can already have an EMPTY assistant placeholder when the
  // previous turn's terminal arrives. Attaching the completed plan to that
  // placeholder makes it look glued to the top of the next loop. Prefer the
  // latest assistant that actually owns content (final text first, then
  // reasoning/tools), and fall back to a bare assistant only when nothing else
  // exists.
  const hasText = (index: number): boolean =>
    messages[index]!.parts.some(
      (part) => part.kind === 'text' && (part.text || '').trim().length > 0,
    );
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUser = i;
      break;
    }
  }
  let withText = -1;
  let withContent = -1;
  let lastAssistant = -1;
  let afterLastUser = -1;
  let beforeLastUserWithText = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    if (lastAssistant < 0) lastAssistant = i;
    const meaningful = message.parts.filter((part) => part.kind !== 'todo_list');
    const text = hasText(i);
    if (withText < 0 && text) withText = i;
    if (
      withContent < 0 &&
      (text || meaningful.some((part) => part.kind === 'tool' || part.kind === 'reasoning'))
    ) {
      withContent = i;
    }
    if (lastUser >= 0) {
      if (i > lastUser) {
        if (afterLastUser < 0) afterLastUser = i;
      } else if (i < lastUser && text && beforeLastUserWithText < 0) {
        beforeLastUserWithText = i;
      }
    }
  }
  // Normal completion: the assistant after the last user owns the answer.
  // A steer/new turn may already have an EMPTY placeholder after that user;
  // in that case the plan belongs to the previous answer instead.
  const lastUserIsSteer =
    lastUser >= 0 && (messages[lastUser] as { isSteer?: boolean }).isSteer === true;
  let index = -1;
  if (afterLastUser >= 0) {
    index =
      beforeLastUserWithText >= 0 && (lastUserIsSteer || !hasText(afterLastUser))
        ? beforeLastUserWithText
        : afterLastUser;
  } else {
    index = withText >= 0 ? withText : withContent >= 0 ? withContent : lastAssistant;
  }
  if (index < 0) return messages;
  const current = messages[index]!;
  const parts = current.parts.filter((part) => part.kind !== 'todo_list');
  parts.push({ kind: 'todo_list', items: cloneTodos(items) });
  const next = messages.slice();
  next[index] = { ...current, parts };
  return next;
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
function isTodoActionValid(args: string): boolean {
  try {
    const v = JSON.parse(args);
    if (!isRecord(v)) return false;
    if (Array.isArray(v.actions)) {
      return v.actions.length > 0 && v.actions.every((a) => isRecord(a) && actionKind(a) !== null);
    }
    return actionKind(v) !== null;
  } catch {
    return false;
  }
}

export function applyLiveTodoToolCall(input: {
  current: TodoItem[] | null;
  name: string;
  args: string;
  callId?: string;
  appliedIds: Set<string>;
}): TodoItem[] | null {
  if (input.callId && input.appliedIds.has(input.callId)) return input.current;
  if (!isTodoTool(input.name)) return input.current;
  const plan = parseTodoPlan(input.args);
  const actionValid = !plan && isTodoActionValid(input.args);
  if (!plan && !actionValid) {
    // 参数尚不完整或无效（例如 tool_start 阶段 arguments 尚未生成完毕），暂不标记已消费 callId
    return input.current;
  }
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
