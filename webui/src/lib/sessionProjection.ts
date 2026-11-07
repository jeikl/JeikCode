/**
 * Session canvas projection.
 *
 * OpenCode stores each message and part by id, and keeps todos as their own
 * document (`todo.updated`). This daemon's SSE stream has call ids and text
 * deltas, not part ids, so copying that store would invent a second identity
 * the server does not send.
 *
 * Cold start, incognito, another browser, `/chat/watch`, the primary `/chat`
 * stream, and the disk poll all update the canvas through this module:
 * disk is the settled transcript, the server todo list is the checklist,
 * and a live event may only extend what is not already painted.
 */

import { appendReasoningPart, type MsgPart, type PartSegment } from './toolRows.ts';
import { normalizeCanvas } from './canvas/canvasStore.ts';
import { isSteerUserMessage } from './turnTimer.ts';
import {
  DISPLAY_TRUNCATION_MARK,
  transcriptHasOpenUserTurn,
  unpaintedReplaySuffix,
  visibleUserText,
  withoutDisplayTruncation,
} from './chatTerminal.ts';
import {
  applyLiveTodoToolCall,
  restoreStickyTodos,
  todoBaselineForLiveApply,
  todoCallIdsFromMessages,
  type TodoItem,
} from './todos.ts';

export interface ProjectionMessage {
  role: string;
  parts: MsgPart[];
  ts?: number;
  /** 管线身份（kernel message id）。增量事件按此定向落笔，而非盲写“最后一条”。 */
  id?: string;
  /** 客户端关联键（`client_input_id`）：乐观气泡的幂等身份。随缓存/IDB 持久化，
   *  重放/刷新/异地端都能据此判定“这条提问已经在画布上”，无需猜文本。 */
  clientInputId?: string;
  /** 绝对转录下标：旧 daemon 的分页游标；新路径只读 `seq`。 */
  sourceIndex?: number;
  /** 服务端 display order。通知按它定位，不再使用 anchorId。 */
  seq?: number;
}

/**
 * 归属消息定位：`messageId` 命中画布上的 assistant 消息时返回其下标，否则 -1。
 * 1. 优先按 message.id 直接比对；
 * 2. 兼容一轮多 round：若某个部件（part）由该 round 生成（part.id 以 `${messageId}:` 开头），
 *    同样精确归属于包含该部件的 assistant 消息，彻底根治多轮工具后正文重放找不到宿主的隐患！
 */
export function identifiedAssistantIndex(
  messages: Array<{ role: string; id?: string; parts?: MsgPart[] }>,
  messageId?: string,
): number {
  if (!messageId) return -1;
  const prefix = `${messageId}:`;
  const index = messages.findIndex((message) => {
    if (message.role !== 'assistant') return false;
    if (message.id === messageId) return true;
    return message.parts?.some((p) =>
      ('id' in p && typeof p.id === 'string' && (p.id === messageId || p.id.startsWith(prefix)))
    );
  });
  return index >= 0 ? index : -1;
}

/**
 * Assistant row that still belongs to the CURRENT turn: the last assistant
 * after the last user prompt. System notices / diagnostics can sit after it;
 * appending to the literal last row would open a second bubble for the same
 * answer whenever such a row lands mid-stream.
 */
export function sameTurnAssistantIndex(messages: Array<{ role: string }>): number {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') {
      lastUser = i;
      break;
    }
  }
  for (let i = messages.length - 1; i > lastUser; i -= 1) {
    if (messages[i]!.role === 'assistant') return i;
  }
  return -1;
}

/**
 * 一行 assistant 消息的 round 归属。
 *
 * 优先用行上的 `id`；行没有 id（占位行 / 旧缓存 / 重连重建）时，
 * 从行内部件的身份反推 —— part id 的形态是 `{message_id}:{seq}:{kind}`，
 * 首段就是它所属的 round。
 *
 * 为什么必须推断：`assistantIdentityConflict` 旧实现只看行上的 `id`，
 * 行没有 id 时永远返回“不冲突”，后续任何一轮的帧都会被折进这一行，
 * 反过来行被重建带上了新 id，同一轮的后半段又被当成新 round 另起一行。
 * 两者都会让“一轮回答”在弱端被拆成两个气泡（两块 Thinking 夹一段正文）。
 */
export function assistantRowOwner(message: { id?: string; parts?: MsgPart[] }): string | undefined {
  if (message.id) return message.id;
  for (const part of message.parts ?? []) {
    for (const id of partKnownIds(part)) {
      const parsed = parsePartId(id);
      if (parsed?.owner) return parsed.owner;
    }
  }
  return undefined;
}

/**
 * A frame carrying a NEW `message_id` must open a NEW assistant row, even
 * inside the same turn. `sameTurnAssistantIndex` is only a positional fallback
 * for identity-less legacy frames; it must not fold a new round into the
 * previous round's row.
 *
 * Folding used to make the live watcher paint every round of a turn into one
 * bubble (several `reasoning-block`s separated by tool cards), while a disk
 * reload kept one row per round — the “thinking/body fork” visible only in the
 * watching tab. Absolute ids are the boundary; the disk projection is the
 * reference. When the row itself has no id, its parts still carry the owner.
 */
function assistantIdentityConflict<T extends ProjectionMessage>(
  messages: T[],
  owner: number,
  messageId?: string,
): boolean {
  if (!messageId || owner < 0) return false;
  const ownerId = assistantRowOwner(messages[owner] as { id?: string; parts?: MsgPart[] });
  return !!ownerId && ownerId !== messageId;
}

/** Tool calls, notices and checklists keep the chronological order. */
const PART_MERGE_BARRIER = new Set(['tool', 'notice', 'rate_limited', 'todo_list']);

/** All wire part ids a logical part answers to (primary + absorbed aliases). */
function partKnownIds(part: MsgPart): string[] {
  const p = part as { id?: string; ids?: string[] };
  return [...(p.id ? [p.id] : []), ...(p.ids ?? [])];
}

function partMatchesPartId(part: MsgPart, partId: string): boolean {
  return partKnownIds(part).includes(partId);
}

/**
 * Merge two same-kind chunks. A replay/reconnect can deliver the SAME long
 * blob under a second part id; blind concatenation painted it twice in the
 * live bubble (disk reload was fine). Exact duplicates and full containment
 * collapse to the richer copy; short token-level repeats are left alone.
 */
function mergePartText(previous: string, incoming: string): string {
  if (!previous) return incoming;
  if (!incoming) return previous;
  if (previous === incoming) return previous;
  // A part split at a token boundary can deliver only the tail of the body as
  // a second part (e.g. "长会话刷新。" / "3 条，还是..."). If that exact tail is
  // already present, appending it again is a replay, not new prose. Short
  // tokens (<= 3 chars) still append so legitimate repeats are preserved.
  if (incoming.length >= 4 && previous.endsWith(incoming)) return previous;
  if (previous.length >= 4 && incoming.endsWith(previous)) return incoming;
  if (incoming.length >= 40 && previous.includes(incoming)) return previous;
  if (previous.length >= 40 && incoming.includes(previous)) return incoming;
  return previous + incoming;
}

/** Merge two identities without losing the primary id or any absorbed alias. */
function mergePartIdentity(
  target: { id?: string; ids?: string[] },
  incoming: { id?: string; ids?: string[] },
): { id?: string; ids?: string[] } {
  const all = Array.from(new Set([
    ...(target.id ? [target.id] : []),
    ...(target.ids ?? []),
    ...(incoming.id ? [incoming.id] : []),
    ...(incoming.ids ?? []),
  ]));
  const id = target.id ?? incoming.id;
  const aliases = all.filter((value) => value !== id);
  return {
    ...(id ? { id } : {}),
    ...(aliases.length > 0 ? { ids: aliases } : {}),
  };
}

/**
 * 同一回合内被切开的同种部件续上，避免正文被思考块劈成两半。
 *
 * 合并规则：**同一 round（同一个 `message_id`）内的同种部件合并为一块**。
 * 模型在一轮里交替吐 `思考→正文→思考→正文` 时，显示上收敛为「一块思考 + 一段正文」；
 * 正文不得被后面的思考块从中间劈开。
 *
 * 但**不同 round 绝不能合并**：弱端 / 回放会把多轮并进同一条 assistant 行，
 * 按旧规则压平会把后一轮的正文搬到前一轮思考之前（R1 T1 R2 T2 → (R1+R2)(T1+T2)）。
 * part id 的形态是 `{message_id}:{seq}:{kind}`，首段就是 round 归属。
 *
 * 工具 / 通知是硬边界，永不跨过；无 `partId` 的旧数据无法判定归属，
 * 保留按段合并的历史语义。
 */
export function coalesceRoundParts(parts: MsgPart[]): MsgPart[] {
  let changed = false;
  const out: MsgPart[] = [];
  /** 段身份里的 round 归属（`{message_id}:{seq}:{kind}` 的首段）。 */
  const roundOwner = (part: MsgPart): string | undefined => {
    for (const id of partKnownIds(part)) {
      const parsed = parsePartId(id);
      if (parsed?.owner) return parsed.owner;
    }
    return undefined;
  };
  for (const part of parts) {
    if (part.kind === 'text' || part.kind === 'reasoning') {
      // 按段回扫，跳过其他类型去找同类段。
      let target = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const previous = out[i]!;
        if (previous.kind === part.kind) {
          target = i;
          break;
        }
        if (PART_MERGE_BARRIER.has(previous.kind)) break;
      }
      if (target >= 0) {
        const previous = out[target] as { kind: 'text' | 'reasoning'; text: string; id?: string; ids?: string[]; rev?: number; segments?: PartSegment[] };
        const prevOwner = roundOwner(previous);
        const nextOwner = roundOwner(part);
        if (prevOwner && nextOwner && prevOwner !== nextOwner) {
          // 两个不同 round 的段：各自成块，绝不跨轮合并。
          out.push(part);
          continue;
        }
        const incoming = part as { text: string; id?: string; ids?: string[]; rev?: number; segments?: PartSegment[] };
        const rev = Math.max(previous.rev ?? 0, incoming.rev ?? 0);
        // 带 wire 身份（rev / segments）的段：按 wire part 账本合并，保住每段的累积文本；
        // 旧数据（无 rev 无 segments）才用文本层合并的兼容逻辑。
        const useSegments = !!previous.segments?.length || previous.rev != null
          || !!incoming.segments?.length || incoming.rev != null;
        const segments = useSegments
          ? mergeSegments(
              partSegments(previous as RevPart, previous.id),
              partSegments(incoming as RevPart, incoming.id),
            )
          : undefined;
        // New wire parts have already been applied exactly once by part_rev.
        // A same-kind run between hard barriers is ONE display block: concatenate
        // in arrival order, do not inspect/guess at the text. Content overlap
        // dedupe remains only for legacy parts (no revision).
        const text = segments
          ? joinSegments(segments)
          : (previous.rev != null && incoming.rev != null
              ? (previous.text || '') + (incoming.text || '')
              : mergePartText(previous.text || '', incoming.text || ''));
        out[target] = {
          ...previous,
          ...mergePartIdentity(previous, incoming),
          text,
          ...(segments ? { segments } : {}),
          ...(rev > 0 ? { rev } : {}),
        } as MsgPart;
        changed = true;
        continue;
      }
    }
    out.push(part);
  }
  return changed ? out : parts;
}

/**
 * Bind the STORED identity of the user prompt to its optimistic bubble.
 *
 * A refresh/switch/replay must keep the bubble on the same id the transcript
 * carries; the live `user` echo cannot carry it (the kernel assigns the id when
 * it pushes the message), so the identity arrives as its own boundary event.
 *
 * Targets the newest user row (a turned-in steer takes its id from the steer
 * payload instead). Never reuses an id that already exists, and returns the
 * same array when there is nothing to bind.
 */
export function bindUserMessageIdentity<T extends ProjectionMessage>(
  messages: T[],
  messageId?: string,
): T[] {
  if (!messageId) return messages;
  if (messages.some((message) => message.id === messageId)) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const next = messages.slice();
    next[i] = { ...message, id: messageId };
    return next;
  }
  return messages;
}

export interface SessionSurface<T> {
  messages: T[];
  todos: TodoItem[] | null;
  appliedTodoIds: string[];
}

/** First paint for a browser with no memory: incognito, restart, another machine. */
export function hydrateSession<T>(
  messages: T[],
  serverTodos: TodoItem[] | null | undefined,
  stashedTodos?: TodoItem[] | null,
): SessionSurface<T> {
  return {
    messages,
    todos: restoreStickyTodos({
      messages: messages as Parameters<typeof restoreStickyTodos>[0]['messages'],
      stashed: stashedTodos,
      authoritativeTodos: serverTodos ?? null,
    }),
    appliedTodoIds: todoCallIdsFromMessages(
      messages as Parameters<typeof todoCallIdsFromMessages>[0],
    ),
  };
}

/**
 * Stamp the streaming assistant message + its trailing text/reasoning part with
 * the wire identity (message_id / part_id), so render keys and cache merges are
 * id-based for LIVE output too (not only after a disk reload). Pure; returns the
 * same array when nothing changed.
 */
export function withAssistantIdentity<T extends ProjectionMessage>(
  msgs: T[],
  messageId?: string,
  partId?: string,
): T[] {
  if (!messageId && !partId) return msgs;
  if (msgs.length === 0) return msgs;
  let idx = messageId
    ? msgs.findIndex((m) => m.role === 'assistant' && m.id === messageId)
    : -1;
  if (idx < 0) {
    idx = sameTurnAssistantIndex(msgs);
    if (idx < 0) return msgs;
    const last = msgs[idx];
    // 行上没有 id 但部件已经写明归属时，绝不能把另一个 round 的 id 盖上去。
    const rowOwner = assistantRowOwner(last as { id?: string; parts?: MsgPart[] });
    if (messageId && rowOwner && rowOwner !== messageId) return msgs;
  }
  // 同一 message_id 绝不能在两条消息上共存：重复 key 会让 Preact 复用错 DOM，
  // 表现为“老回合的一部分回复渲染到新消息里”。
  if (messageId && msgs.some((m, i) => i !== idx && m.id === messageId)) return msgs;
  const message = msgs[idx]!;
  let changed = false;
  let id = message.id;
  if (messageId && !id) {
    id = messageId;
    changed = true;
  }
  let parts = message.parts;
  if (partId && parts.length > 0) {
    const pi = parts.length - 1;
    const p = parts[pi];
    if (p && (p.kind === 'text' || p.kind === 'reasoning')) {
      const known = [...(p.id ? [p.id] : []), ...(p.ids ?? [])];
      if (!known.includes(partId)) {
        parts = parts.slice();
        parts[pi] = p.id
          ? { ...p, ids: [...(p.ids ?? []), partId] }
          : { ...p, id: partId };
        changed = true;
      }
    }
  }
  if (!changed) return msgs;
  const next = msgs.slice();
  next[idx] = { ...message, id, parts } as T;
  return next;
}

/**
 * Background-session cache delta (the user is viewing another session).
 *
 * Uses the SAME identity contract as the live canvas path: the row that receives
 * the delta is stamped with the wire `message_id`. Without the stamp a later
 * `/chat/watch` replay of that round cannot be routed back to its own bubble and
 * the projection appends it to the newest assistant message instead — the
 * "old body / reasoning repainted into the latest agent reply" bug after a
 * refocus or a switch-back (a turn with a steer has more than one assistant row,
 * so "the last assistant" is a different round).
 */
export function paintCachedAssistantDelta<T extends ProjectionMessage>(
  messages: T[],
  part: 'text' | 'reasoning',
  content: string,
  identity?: { messageId?: string; partId?: string; partRev?: number; replay?: boolean },
): T[] {
  const replay = identity?.replay === true;
  const painted = part === 'text'
    ? paintAssistantText(messages, content, replay, identity?.messageId, identity?.partId, identity?.partRev)
    : paintAssistantReasoning(messages, content, replay, identity?.messageId, identity?.partId, identity?.partRev);
  return withAssistantIdentity(painted, identity?.messageId, identity?.partId);
}

/** `/chat/watch` is the only canvas stream. Working is a transient view state; a
 *  new user row does NOT create an empty assistant record. `repeatAfterSettled`
 *  appends the same words again after the previous turn already has an answer —
 *  an observer's next send, not a replay of the open turn. */
export function lastAssistantHasAnswer<T extends ProjectionMessage>(messages: T[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant') {
      return m.parts.some((p) => p.kind === 'text' && (p.text || '').trim().length > 0);
    }
    if (m?.role === 'user') {
      break;
    }
  }
  return false;
}

export function paintUserMessage<T extends ProjectionMessage>(
  messages: T[],
  rawText: string,
  userTs: number,
  create: (base: T[]) => T,
  opts?: { repeatAfterSettled?: boolean; clientInputId?: string; replay?: boolean },
): T[] {
  const clientInputId = opts?.clientInputId;
  if (clientInputId) {
    // 身份幂等：同一条关联键已经在画布/缓存的行上（随缓存持久化）。
    // 新后端把关联键直接作为落盘消息 id，因此 `id === clientInputId` 同样命中。
    if (
      messages.some(
        (message) => message.clientInputId === clientInputId || message.id === clientInputId,
      )
    ) {
      return messages;
    }
    const appended = paintUserMessageInner(messages, rawText, userTs, create, opts?.replay === true);
    return stampUserClientInputId(appended, clientInputId);
  }
  return paintUserMessageInner(messages, rawText, userTs, create, opts?.replay === true);
}

/** 给画布上某一或最新一条 user 行盖上客户端关联键（幂等；行已被别的发送占用则不动）。 */
export function stampUserClientInputId<T extends ProjectionMessage>(
  messages: T[],
  clientInputId?: string,
): T[] {
  if (!clientInputId) return messages;
  if (messages.some((m) => m.role === 'user' && m.clientInputId === clientInputId)) {
    return messages;
  }
  const byId = messages.findIndex((m) => m.role === 'user' && m.id === clientInputId);
  if (byId >= 0) {
    const next = messages.slice();
    next[byId] = { ...messages[byId]!, clientInputId } as T;
    return next;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    if (message.clientInputId === clientInputId) return messages;
    if (message.clientInputId) return messages;
    const next = messages.slice();
    next[i] = { ...message, clientInputId } as T;
    return next;
  }
  return messages;
}

/**
 * 给回放补回的提问行回填**显示列表下标**（`sourceIndex`），并按该下标把这一行
 * 插回正确位置（数组 splice，不是按键重排）。
 *
 * 调用方传入的是右栏大纲的 `turns[].index`（display 下标，与磁盘行的 `sourceIndex`
 * 同一坐标）。内核快照下标（压缩前缀 / 过滤掉的 system-reminder 会让它与 display
 * 下标相差几十到几百）与此坐标不兼容，wire 上也不再下发，禁止引入。
 *
 * 只处理“还没有下标”的行：磁盘投影行已有权威下标，绝不动。
 */
export function stampUserSourceIndex<T extends ProjectionMessage>(
  messages: T[],
  messageId: string | undefined,
  sourceIndex: number | undefined,
): T[] {
  if (
    !messageId ||
    typeof sourceIndex !== 'number' ||
    !Number.isFinite(sourceIndex) ||
    sourceIndex < 0
  ) {
    return messages;
  }
  const index = messages.findIndex((message) => message.role === 'user' && message.id === messageId);
  if (index < 0) return messages;
  const row = messages[index]!;
  if (typeof row.sourceIndex === 'number') return messages;

  // 若画布上没有任何“绝对下标比它更大”且排在它前面的行，说明它原本就处在正确的因果位置
  // （例如当前回合末尾的 user 后紧跟着无 sourceIndex 的直播 assistant 占位行）。
  // 原地盖章即可，绝不能把它抽出来再插到数组末尾（跳到直播 assistant 后面会导致双 Working 与正文倒挂）。
  const firstGreater = messages.findIndex(
    (message) => typeof message.sourceIndex === 'number' && message.sourceIndex > sourceIndex,
  );
  if (firstGreater < 0 || firstGreater > index) {
    const next = messages.slice();
    next[index] = { ...row, sourceIndex } as T;
    return next;
  }

  const rest = messages.slice(0, index).concat(messages.slice(index + 1));
  // 插到“第一个绝对下标更大”的行之前；没有则放末尾（在途新行）。
  let insertAt = rest.findIndex(
    (message) => typeof message.sourceIndex === 'number' && message.sourceIndex > sourceIndex,
  );
  if (insertAt < 0) insertAt = rest.length;
  const nextSeq = rest[insertAt]?.seq;
  const prevSeq = insertAt > 0 ? rest[insertAt - 1]?.seq : undefined;
  let adjustedSeq = row.seq;
  if (typeof nextSeq === 'number' && (typeof adjustedSeq !== 'number' || adjustedSeq >= nextSeq)) {
    adjustedSeq = typeof prevSeq === 'number' && prevSeq < nextSeq
      ? prevSeq + (nextSeq - prevSeq) / 2
      : nextSeq - 0.001;
  }
  const stamped = {
    ...row,
    sourceIndex,
    ...(adjustedSeq !== row.seq ? { seq: adjustedSeq } : {}),
  } as T;
  const next = rest.slice();
  next.splice(insertAt, 0, stamped);
  return next;
}

function findInFlightAssistantHeadForReplayUser<T extends ProjectionMessage>(
  messages: T[],
): number {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) {
    // 画布尚无任何 user 行，但已有当前回合未落盘的直播 assistant 行 → 开场提问必须插在它前面。
    const firstAsst = messages.findIndex(
      (m) => m.role === 'assistant' && m.sourceIndex == null && (m as { elapsedMs?: number }).elapsedMs == null,
    );
    return firstAsst >= 0 ? firstAsst : -1;
  }
  const lastUser = messages[lastUserIdx]!;
  // 若最后一条 user 已是历史落盘提问（带 sourceIndex），或它紧邻的上一轮回答已落定（带 sourceIndex 或 elapsedMs），
  // 则尾部出现的无 sourceIndex / 无 elapsedMs 的直播 assistant 行属于本轮新回答，补发的开场提问必须插在它前面！
  const prevTurnSettled =
    typeof lastUser.sourceIndex === 'number' ||
    (lastUserIdx + 1 < messages.length &&
      messages[lastUserIdx + 1]!.role === 'assistant' &&
      (typeof messages[lastUserIdx + 1]!.sourceIndex === 'number' ||
        typeof (messages[lastUserIdx + 1] as { elapsedMs?: number }).elapsedMs === 'number'));
  if (!prevTurnSettled) return -1;
  for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (
      m.role === 'assistant' &&
      m.sourceIndex == null &&
      (m as { elapsedMs?: number }).elapsedMs == null
    ) {
      return i;
    }
  }
  return -1;
}

function paintUserMessageInner<T extends ProjectionMessage>(
  messages: T[],
  rawText: string,
  userTs: number,
  create: (base: T[]) => T,
  replay = false,
): T[] {
  if (replay) {
    const insertBefore = findInFlightAssistantHeadForReplayUser(messages);
    if (insertBefore >= 0) {
      const prefix = messages.slice(0, insertBefore);
      const userRow = create(prefix);
      const next = messages.slice();
      next.splice(insertBefore, 0, userRow);
      return next;
    }
  }
  let base = messages;
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && (!last.parts || last.parts.length === 0)) {
    base = messages.slice(0, -1);
  }
  return [
    ...base,
    create(base),
    { role: 'assistant', parts: [] } as unknown as T,
  ];
}

export interface TurnUserAnchor {
  messageId?: string;
  toolId?: string;
}

/**
 * 回放补回的中途转向（`steered`）的落位：紧跟在「被 steer 打断的那一轮」助手行之后。
 *
 * 刷新后画布又回到了这一轮的旧快照，steer 的气泡要么丢了、要么根本没落盘；
 * 它的后续正文（新一轮 loop）却已经在画布上。若直接追加，追问就会倒插到回答下面。
 * 回放是严格有序的：`anchor` 就是它前面最后一帧落到的助手行。
 *
 * 返回 -1 表示定位不到那一行（整段还没画上 / 本帧前面没有助手内容），
 * 调用方按「新回合追加到尾部」兜底。
 */
export function steerInsertAfterAnchor(
  messages: Array<{ role: string; id?: string; parts?: MsgPart[] }>,
  anchor?: TurnUserAnchor,
): number {
  if (!anchor) return -1;
  if (anchor.messageId) {
    const idx = identifiedAssistantIndex(messages, anchor.messageId);
    if (idx >= 0) return idx + 1;
  }
  if (anchor.toolId) {
    const idx = messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        message.parts?.some((part) => part.kind === 'tool' && part.tool.id === anchor.toolId),
    );
    if (idx >= 0) return idx + 1;
  }
  return -1;
}

function turnAnchorIndex<T extends ProjectionMessage>(messages: T[], before?: TurnUserAnchor): number {
  if (before?.messageId) {
    const idx = identifiedAssistantIndex(messages, before.messageId);
    if (idx >= 0) return idx;
  }
  if (before?.toolId) {
    const idx = messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        message.parts.some((part) => part.kind === 'tool' && part.tool.id === before.toolId),
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * 把被首屏切掉的这一轮提问插回该轮助手内容前面。
 * 已经在画布上则不动。这一轮还不在页上时，按新回合追加到末尾。
 * 连续多条（开场提问、中途 steer）按到达顺序排在锚点前面，不能叠到回答下面。
 */
export function placeRecoveredTurnUsers<T extends ProjectionMessage>(
  messages: T[],
  events: Array<{
    type: string;
    content?: string;
    created_at?: number;
    message_id?: string;
    client_input_id?: string;
    /** 绝对转录下标（调用方按会话大纲补上）。有了它就能精确归位，不再靠“碰巧命中的锚点”。 */
    source_index?: number;
  }>,
  before?: TurnUserAnchor,
): T[] {
  let next = messages;
  let cursor: number | null = null;
  let insertedAt: number | null = null;
  for (const event of events) {
    if (event.type === 'user_identified' && event.message_id && insertedAt != null) {
      const row = next[insertedAt];
      if (
        row &&
        row.role === 'user' &&
        !row.id &&
        !next.some((message) => message.id === event.message_id)
      ) {
        const copy = next.slice();
        copy[insertedAt] = { ...row, id: event.message_id };
        next = copy;
      }
      continue;
    }
    if (event.type !== 'user' || typeof event.content !== 'string') continue;
    // 客户端关联键已在画布上 → 同一条提问已画过，绝不再补一份。
    if (
      event.client_input_id &&
      next.some((message) => message.clientInputId === event.client_input_id)
    ) {
      continue;
    }
    // 落盘身份已在画布上 → 同一条提问已画过（新后端 id 与关联键同值）。
    if (event.message_id && next.some((message) => message.id === event.message_id)) {
      continue;
    }
    const userTs = event.created_at && event.created_at > 0 ? event.created_at : Date.now();
    // 绝对下标是唯一身份：画布上（pinned 主机键/磁盘行）已经有这一行就说明这条提问
    // 已画过，绝不能再补一份。
    if (
      typeof event.source_index === 'number' &&
      next.some((message) => message.sourceIndex === event.source_index)
    ) {
      continue;
    }
    // 身份优先：关联键 / 消息 id / 绝对下标已在上面判过；不再用文本兜底。
    const isSteer = isSteerUserMessage({ role: 'user', content: event.content });
    const userText = visibleUserText(event.content);
    const eventImages = Array.isArray((event as any).images) && (event as any).images.length > 0 ? (event as any).images : undefined;
    // 关键防呆：若既无可见文本也无图片附件，绝不能生成空用户气泡！
    if (!userText && !eventImages) continue;
    const row = {
      role: 'user',
      parts: [{ kind: 'text', text: userText }],
      ts: userTs,
      ...(eventImages ? { images: eventImages } : {}),
      ...(isSteer ? { isSteer: true } : {}),
      ...(typeof event.source_index === 'number' ? { sourceIndex: event.source_index } : {}),
      // New daemons echo the persisted id; `clientInputId` is only the legacy
      // alias when the frame has no `message_id` at all.
      ...(event.message_id
        ? { id: event.message_id }
        : event.client_input_id
          ? { clientInputId: event.client_input_id }
          : {}),
    } as T;
    if (typeof event.source_index === 'number') {
      // 有绝对下标就按序插入，而不是看“碰巧命中的锚点”：被折叠线切掉的开场提问
      // 必须回到它在窗口里的真实顺序位置（通常就是窗口最前面），否则它会落在
      // 48 行折叠线附近，随后又被 mergeOlderMessages 排到末尾。
      const target = next.findIndex(
        (message) =>
          typeof message.sourceIndex === 'number' && message.sourceIndex > event.source_index!,
      );
      const pos = target >= 0 ? target : next.length;
      const copy = next.slice();
      copy.splice(pos, 0, row);
      insertedAt = pos;
      cursor = pos + 1;
      next = copy;
      continue;
    }
    if (cursor == null) cursor = turnAnchorIndex(next, before);
    if (cursor < 0) {
      // 关键防倒挂：若该提问的时间戳明显早于画布上已存在的其他用户消息，
      // 按时间戳找到它的真实时序位置前插，绝不能盲目 append 到最末尾（导致 14:27 倒插在 14:58 下面）！
      let insertAt = next.length;
      if (userTs > 0) {
        for (let i = 0; i < next.length; i++) {
          const m = next[i] as { role?: string; ts?: number };
          if (m.role === 'user' && typeof m.ts === 'number' && m.ts > userTs + 5000) {
            insertAt = i;
            break;
          }
        }
      }
      if (insertAt < next.length) {
        const copy = next.slice();
        copy.splice(insertAt, 0, row);
        insertedAt = insertAt;
        cursor = insertAt + 1;
        next = copy;
        continue;
      }
      const painted = paintUserMessage(next, event.content, userTs, () => row);
      insertedAt = Math.max(0, painted.length - 2);
      cursor = painted.length - 1;
      next = painted;
      continue;
    }
    const copy = next.slice();
    copy.splice(cursor, 0, row);
    insertedAt = cursor;
    cursor += 1;
    next = copy;
  }
  return next;
}

export function paintAssistantText<T extends ProjectionMessage>(
  messages: T[],
  content: string,
  replay: boolean,
  /** 管线身份：命中则把增量落回该消息（迟到尾流必须回到原回合）。 */
  targetId?: string,
  /** 部件身份：回放帧的累积文本按 part 定向合并，不能拿整条消息的正文拼接做基线。 */
  partId?: string,
  /** Wire part revision: with a stable id, apply each part event exactly once. */
  partRev?: number,
): T[] {
  const target = identifiedAssistantIndex(messages, targetId);
  if (target >= 0) {
    const merged = mergeTextIntoParts(messages[target]!.parts, content, replay, partId, partRev);
    if (!merged) return messages;
    const parts = coalesceRoundParts(merged);
    const next = messages.slice();
    next[target] = { ...messages[target]!, parts };
    return next;
  }
  // 身份未命中：这帧属于画布上还没有的轮（新一轮 / 迟到尾流）→ 直接落到当前气泡。
  // 不再用「跨轮隔离」猜测拦截：帧身份由线协议（轮编号 + 游标）给出，未命中就是新的。
  if (messages.length === 0) {
    if (!content) return messages;
    return [{
      role: 'assistant',
      ...(targetId ? { id: targetId } : {}),
      parts: [{
        kind: 'text',
        text: content,
        ...(partId ? { id: partId } : {}),
        ...(partRev != null ? { rev: partRev } : {}),
      }],
    } as unknown as T];
  }
  // 同一回合里可能有系统通知插在 assistant 之后；此时「最后一条」不是 assistant，
  // 但续写仍属于本轮回答，必须落回本轮气泡，绝不能新开一条（否则正文被劈成两半）。
  // 唯一的例外：帧带着另一个 message_id —— 那是 NEW round，必须按绝对 id 新开行。
  const owner = sameTurnAssistantIndex(messages);
  const conflict = assistantIdentityConflict(messages, owner, targetId);
  const base: T[] = owner >= 0 && !conflict
    ? messages
    : [...messages, { role: 'assistant', parts: [] } as unknown as T];
  const idx = owner >= 0 && !conflict ? owner : base.length - 1;
  const merged = mergeTextIntoParts(base[idx]!.parts, content, replay, partId, partRev);
  if (!merged) return messages;
  const parts = coalesceRoundParts(merged);
  const next = base.slice();
  next[idx] = { ...base[idx]!, parts };
  return next;
}

/** 解析线协议段身份 `{message_id}:{seq}:{kind}`（message_id 自身可能含 `:`）。 */
function parsePartId(id?: string): { owner: string; seq: number; kind: string } | null {
  if (!id) return null;
  const segments = id.split(':');
  if (segments.length < 3) return null;
  const seq = Number(segments[segments.length - 2]);
  if (!Number.isFinite(seq)) return null;
  return {
    // 段序在每个 message 内部重置：必须带上 owner（message_id）才能唯一识别。
    owner: segments.slice(0, -2).join(':'),
    seq,
    kind: segments[segments.length - 1]!,
  };
}

/**
 * 当前流式段的起点：最后一个硬边界（工具 / 通知）之后。
 *
 * 工具调用把一条助手消息切成时间上不可跨越的几段：跨过工具的思考/正文
 * 必须各自成段，否则“工具前的结论”和“工具后的结论”会粘成一团，工具卡片
 * 也会跑到文字前面。
 */
function currentSegmentStart(parts: MsgPart[]): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (PART_MERGE_BARRIER.has(parts[i]!.kind)) return i + 1;
  }
  return 0;
}

/**
 * 增量落点：先按 `part_id` 在**整行**里找同一个部件，找不到才退回当前段推断。
 *
 * 为什么必须全行搜索：一轮对话的所有 round 会聚在同一条 assistant 行里
 * （reasoning → tool → reasoning → text …）。刷新后的回放在按时间重播**更早 round**
 * 的帧时，`currentSegmentStart` 会停在最后一个工具之后，只看当前段就永远找不到
 * 前面那个部件 → 每次都开一个新部件，于是正文/思考被重复画一遍。
 * 段边界只用于「开新部件」的启发式，不能用来限制身份匹配。
 *
 * 优先级：全行 part_id 精确命中 → 全行同段序同类（磁盘投影与线协议编号可能不同）
 * → 当前段内唯一的同类未盖戳部件。
 */
function resolveDeltaPartIndex(parts: MsgPart[], kind: 'text' | 'reasoning', partId?: string): number {
  // 1. 身份优先：part_id 在整行内唯一，跨工具边界也必须能找到原部件。
  if (partId) {
    const exact = parts.findIndex((part) => part.kind === kind && partMatchesPartId(part, partId));
    if (exact >= 0) return exact;
    const want = parsePartId(partId);
    if (want) {
      const bySeq = parts.findIndex((part) => {
        if (part.kind !== kind) return false;
        return partKnownIds(part).some((known) => {
          const have = parsePartId(known);
          return (
            have !== null &&
            have.owner === want.owner &&
            have.seq === want.seq &&
            have.kind === want.kind
          );
        });
      });
      if (bySeq >= 0) return bySeq;
    }
  }

  // 2. 无身份（或整行都没有这个身份）：只在当前段内按同类/唯一未盖戳部件推断。
  const start = currentSegmentStart(parts);
  const same: Array<{ part: MsgPart; index: number }> = [];
  for (let index = start; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.kind === kind) same.push({ part, index });
  }
  if (same.length === 0) return -1;
  // 无身份帧（legacy / 未盖戳）：沿用旧语义落到当前段内最后一条同类部件。
  if (!partId) return same[same.length - 1]!.index;
  // 只有「尚未盖戳」的唯一同类部件才能被推断为同一段；已带别的段序就是另一段。
  const only = same[0]!;
  return same.length === 1 && partKnownIds(only.part).length === 0 ? only.index : -1;
}

/**
 * 回放帧携带的是**某个 wire part 的累积正文**。展示段可能已经把多个 wire part
 * 合并成一块（`ids` 别名），所以回放不能“整段替换”，更不能因为单个 `rev` 看着旧
 * 就把内容丢掉 —— 两个都会把已并入的正文冲掉（重连后正文缺一块的根因）。
 * 这里只允许补长或幂等：任何情况下都不缩短。
 */
function mergeAccumulatedReplay(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (incoming === existing) return existing;
  if (incoming.startsWith(existing)) return incoming;   // 该段的累积更新
  if (existing.startsWith(incoming)) return existing;   // 迟到的旧累积
  if (existing.includes(incoming)) return existing;     // 幂等重复
  if (incoming.includes(existing)) return incoming;     // 更完整
  // 旧账本已经合并过多个 wire part 时，重放帧的前缀可能已经画在段尾。
  // 只能补“未画过的尾部”，否则会把重叠前缀重复追加一遍。
  const overlap = suffixPrefixOverlap(existing, incoming);
  if (overlap > 0) return existing + incoming.slice(overlap);
  const suffix = unpaintedReplaySuffix(existing, incoming);
  return suffix ? existing + suffix : existing;
}

/** `existing` 的后缀与 `incoming` 的前缀的最长重叠长度。 */
function suffixPrefixOverlap(existing: string, incoming: string): number {
  const max = Math.min(existing.length, incoming.length);
  for (let k = max; k > 0; k -= 1) {
    if (existing.endsWith(incoming.slice(0, k))) return k;
  }
  return 0;
}

type RevPart = {
  kind: 'text' | 'reasoning';
  text: string;
  id?: string;
  ids?: string[];
  rev?: number;
  segments?: PartSegment[];
};

/** 展示段内部的 wire part 账本；旧数据（没有 segments）用整段文本兜底。 */
function partSegments(part: RevPart, fallbackId?: string): PartSegment[] {
  if (part.segments && part.segments.length > 0) return part.segments;
  return [{
    ...(part.id ? { id: part.id } : fallbackId ? { id: fallbackId } : {}),
    text: part.text || '',
    ...(part.rev != null ? { rev: part.rev } : {}),
  }];
}

function joinSegments(segments: PartSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** 按 wire part id 合并两份账本（同一 id 取更完整的累积文本）。 */
function mergeSegments(a: PartSegment[], b: PartSegment[]): PartSegment[] {
  const out = a.map((segment) => ({ ...segment }));
  for (const segment of b) {
    const index = segment.id ? out.findIndex((existing) => existing.id === segment.id) : -1;
    if (index < 0) {
      out.push({ ...segment });
      continue;
    }
    const previous = out[index]!;
    out[index] = {
      ...previous,
      text: mergeAccumulatedReplay(previous.text || '', segment.text || ''),
      rev: Math.max(previous.rev ?? 0, segment.rev ?? 0),
    };
  }
  return out;
}

/**
 * Wire-identity path: one part_id, one monotonic part_rev. No text heuristics.
 * Replay carries the accumulated part; live carries a delta (append).
 *
 * 展示段可能已经把多个 wire part 合并成一块（`segments` 账本），所以回放/增量
 * 必须在**自己那一段**上落笔：整段替换会把并进来的其他段冲掉，单看合并后的 `rev`
 * 又会把另一段的回放当成旧帧丢掉 —— 两者都是重连后正文缺块的根因。
 */
function applyPartRevision(
  parts: MsgPart[],
  kind: 'text' | 'reasoning',
  content: string,
  replay: boolean,
  partId: string | undefined,
  rev: number,
): MsgPart[] | null {
  const index = resolveDeltaPartIndex(parts, kind, partId);
  if (index < 0) {
    return [
      ...parts,
      {
        kind,
        text: content,
        ...(partId ? { id: partId } : {}),
        rev,
        // 新段从第一帧起就带 wire 账本：后续回放只更新它自己那一段。
        ...(partId ? { segments: [{ id: partId, text: content, rev }] } : {}),
      } as MsgPart,
    ];
  }
  const previous = parts[index] as RevPart;
  const next = parts.slice();
  if (previous.segments?.length) {
    const segments = previous.segments;
    const segIndex = partId ? segments.findIndex((segment) => segment.id === partId) : -1;
    let nextSegments: PartSegment[];
    if (segIndex >= 0) {
      const segment = segments[segIndex]!;
      let text: string;
      if (replay) {
        if (segment.rev != null && rev < segment.rev) return null; // 更旧的累积
        text = mergeAccumulatedReplay(segment.text || '', content);
      } else {
        if (segment.rev != null && rev <= segment.rev) return null; // 重复/乱序增量
        text = (segment.text || '') + content;
      }
      const nextRev = Math.max(segment.rev ?? 0, rev);
      if (text === (segment.text || '') && nextRev === (segment.rev ?? 0)) return null;
      nextSegments = segments.slice();
      nextSegments[segIndex] = { ...segment, text, rev: nextRev };
    } else {
      nextSegments = [...segments, { ...(partId ? { id: partId } : {}), text: content, rev }];
    }
    next[index] = {
      ...previous,
      ...mergePartIdentity(previous, { id: partId }),
      segments: nextSegments,
      text: joinSegments(nextSegments),
      rev: Math.max(previous.rev ?? 0, rev),
    } as MsgPart;
    return next;
  }
  // 旧账本（无 segments）：整段合并，**绝不建立分段账本**。
  // 这时展示段可能已经合并了多个 wire part，建一个“以首段 id 命名”的分段
  // 会把整段文本都算到那一段上，后续另一段的回放就会重复追加它自己。
  const existing = previous.text || '';
  if (replay) {
    const text = mergeAccumulatedReplay(existing, content);
    const nextRev = Math.max(previous.rev ?? 0, rev);
    if (text === existing && nextRev === (previous.rev ?? 0)) return null;
    next[index] = {
      ...previous,
      ...mergePartIdentity(previous, { id: partId }),
      text,
      rev: nextRev,
    } as MsgPart;
    return next;
  }
  if (previous.rev != null && rev <= previous.rev) return null;
  next[index] = {
    ...previous,
    ...mergePartIdentity(previous, { id: partId }),
    text: existing + content,
    rev,
  } as MsgPart;
  return next;
}

/** 合并一段正文增量；返回 null 表示重播去重后无新内容可落笔。
 *
 * 回放帧（replay=true）必须按 part 身份定向合并：
 * - 已画过的 part 再次回放（重连/刷新）：命中同一 part 后增量是既有文本的后缀 → 去重为空；
 * - 在途 part 的迟到尾段：只补上与已有部分不重叠的后缀；
 * - 帧声明了段身份但画布上没有这一段 → 它就是新的一段，直接追加；
 * - 未命中轮编号且末尾气泡属于另一轮（startNewPart）→ 另起部件，绝不跨轮粘连。
 */
function mergeTextIntoParts(parts: MsgPart[], content: string, replay: boolean, partId?: string, partRev?: number): MsgPart[] | null {
  if (!content) return null;

  // Pure wire path: a stable part_id + monotonic part_rev means we never need
  // to compare text. Replay is the accumulated part (replace); live is a delta
  // (append). A repeated/older revision is idempotently ignored.
  if (partRev != null) {
    return applyPartRevision(parts, 'text', content, replay, partId, partRev);
  }

  // 1. 直播流式输出（replay === false）：
  // 每一帧都是真实 LLM 实时增量 token，由后端 SSE 游标（AtomicU64 seq）保证单调性与不重发。
  // 绝对严禁执行任何子串包含去重（includes），直接就地追加！
  if (!replay) {
    const index = resolveDeltaPartIndex(parts, 'text', partId);
    if (index >= 0) {
      const next = parts.slice();
      const p = next[index] as { kind: 'text'; text: string; id?: string; ids?: string[]; segments?: PartSegment[] };
      // 落在 wire 账本段上的无身份增量（daemon ArtifactDetector 拆出的代码块围栏 /
      // 正文，由 Chat.tsx 重建后追加）：它与当前流式段同序到达，必须写进账本（带 part_id 写自己那段，
      // 否则写末段）。
      // 只改 `text` 不改 `segments` 的话，下一帧带 part_rev 的正文会按账本重算
      // `text`，把整块代码连同围栏冲掉（“代码块一闭合就变正文 / 消失，stop 后
      // 磁盘重载才恢复”的根因）。这类帧走 SSE 游标保序，不做文本去重：
      // 去重会误吞代码里合法重复的短行（如连续的 `pass`）。
      if (p.segments?.length) {
        const segments = p.segments.slice();
        const own = partId ? segments.findIndex((segment) => segment.id === partId) : -1;
        const target = own >= 0 ? own : segments.length - 1;
        const segment = segments[target]!;
        segments[target] = { ...segment, text: (segment.text || '') + content };
        next[index] = {
          ...p,
          ...mergePartIdentity(p, { id: partId }),
          segments,
          text: joinSegments(segments),
        } as MsgPart;
        return next;
      }
      const existing = (p.text || '').trim();
      const incoming = content.trim();
      // 关键防线：即使 replay 为 false（网络重连/未打序号），若该段已经是
      // 画布尾部，就不再追加。这里不能要求 >20：body 在 token 边界被切成
      // "长会话刷新。" / "3 条，还是..." 这类短后缀时，>20 的守卫会漏掉，
      // 结果就是正文尾部又叠一份。<=3 字的正常 token 重复仍然追加。
      if (incoming.length >= 4 && (existing === incoming || existing.endsWith(incoming))) {
        return parts;
      }
      const text = mergePartText(p.text || '', content);
      if (text === (p.text || '')) return parts;
      next[index] = {
        ...p,
        ...mergePartIdentity(p, { id: partId }),
        text,
      };
      return next;
    }
    return [...parts, { kind: 'text', text: content, ...(partId ? { id: partId } : {}) }];
  }

  // 2. 重放帧（replay === true）：
  const replaced = replaceTruncatedParts(parts, 'text', content, partId);
  if (replaced) return replaced;

  const index = resolveDeltaPartIndex(parts, 'text', partId);
  if (index >= 0) {
    const previous = parts[index] as { kind: 'text'; text: string; id?: string; ids?: string[] };
    const existing = previous.text || '';
    const body = withoutDisplayTruncation(existing);
    // 空白增量（段落分隔的 "\n\n"）在已有正文里永远是“包含”关系，绝不能当幂等丢弃：
    // 丢了它列表/段落就会粘连（live 乱排、刷新才恢复的经典症状）。
    if (content.trim() && body.includes(content)) return null;
    if (content.startsWith(body)) {
      const next = parts.slice();
      next[index] = {
        ...previous,
        ...mergePartIdentity(previous, { id: partId }),
        text: content,
      };
      return next;
    }
    const suffix = unpaintedReplaySuffix(existing, content);
    if (!suffix) return null;
    const next = parts.slice();
    next[index] = {
      ...previous,
      ...mergePartIdentity(previous, { id: partId }),
      text: body + suffix,
    };
    return next;
  }

  // 画布上还没有这一段：它就是一整段新内容，原样落笔（不做跨部件后缀推算）。
  // 唯一的例外是“已经完整画过的旧段迟到重放”——此时拿整条消息的已绘内容做
  // 包含判定只是幂等去重，不会产生任何新字符。
  if (!partId) {
    const paintedTail = parts
      .map((part) => (part.kind === 'text' ? part.text || '' : ''))
      .join('')
      .trimEnd();
    const incoming = content.trim();
    if (incoming && (paintedTail.endsWith(incoming) || paintedTail.includes(incoming))) {
      return null;
    }
  }
  return [...parts, { kind: 'text', text: content, ...(partId ? { id: partId } : {}) }];
}

export function paintAssistantReasoning<T extends ProjectionMessage>(
  messages: T[],
  content: string,
  replay: boolean,
  /** 管线身份：命中则把思考增量落回该消息（迟到尾流必须回到原回合）。 */
  targetId?: string,
  /** 部件身份：回放帧按 part 定向合并，避免整段思考被重打。 */
  partId?: string,
  /** Wire part revision: with a stable id, apply each part event exactly once. */
  partRev?: number,
): T[] {
  const cleanContent = content.trim();
  if (!cleanContent) return messages;

  const target = identifiedAssistantIndex(messages, targetId);
  if (target >= 0) {
    const merged = mergeReasoningIntoParts(messages[target]!.parts, content, replay, partId, partRev);
    if (!merged) return messages;
    const parts = coalesceRoundParts(merged);
    const next = messages.slice();
    next[target] = { ...messages[target]!, parts };
    return next;
  }
  // 身份未命中：同 paintAssistantText —— 新 message_id 必须新开一行，
  // 否则 live 会把多个 round 折进同一个气泡（多个思考块），与磁盘投影不一致。
  const owner = sameTurnAssistantIndex(messages);
  const conflict = assistantIdentityConflict(messages, owner, targetId);
  const base: T[] = owner >= 0 && !conflict
    ? messages
    : [...messages, { role: 'assistant', parts: [] } as unknown as T];
  const idx = owner >= 0 && !conflict ? owner : base.length - 1;
  const merged = mergeReasoningIntoParts(base[idx]!.parts, content, replay, partId, partRev);
  if (!merged) return messages;
  const parts = coalesceRoundParts(merged);
  const next = base.slice();
  next[idx] = { ...base[idx]!, parts };
  return next;
}

/** 合并一段思考增量；返回 null 表示重播去重后无新内容可落笔。
 *
 * 落点与正文同一口径（[`resolveDeltaPartIndex`]）：只往「同一个思考部件」写，
 * 找不到就是新部件，绝不拿别的思考段当基线去算后缀。
 */
function mergeReasoningIntoParts(parts: MsgPart[], content: string, replay: boolean, partId?: string, partRev?: number): MsgPart[] | null {
  const cleanContent = content.trim();
  if (!cleanContent) return null;

  if (partRev != null) {
    return applyPartRevision(parts, 'reasoning', content, replay, partId, partRev);
  }

  const existingIdx = resolveDeltaPartIndex(parts, 'reasoning', partId);

  // 1. 直播流式输出（replay === false）：
  // 思考增量直接并入当前思考部件，绝不能对思考文本做子串去重！
  if (!replay) {
    if (existingIdx >= 0) {
      const next = parts.slice();
      const p = next[existingIdx] as { kind: 'reasoning'; text: string; id?: string; ids?: string[] };
      const text = mergePartText(p.text || '', content);
      if (text === (p.text || '')) return parts;
      next[existingIdx] = {
        ...p,
        ...mergePartIdentity(p, { id: partId }),
        text,
      };
      return next;
    }
    return appendReasoningPart(parts, content, partId);
  }

  // 2. 重放帧（replay === true）：
  const replaced = replaceTruncatedParts(parts, 'reasoning', content, partId);
  if (replaced) {
    return replaced === parts ? null : replaced;
  }

  if (existingIdx >= 0) {
    const p = parts[existingIdx] as { kind: 'reasoning'; text: string; id?: string; ids?: string[] };
    const existing = (p.text || '').trim();
    // 已有思考已包含该重放内容 → 幂等丢弃
    if (existing === cleanContent || existing.includes(cleanContent)) {
      return null;
    }
    // 新内容是已有思考的延伸（累积帧）→ 原地更新！
    if (cleanContent.startsWith(existing)) {
      const nextParts = parts.slice();
      nextParts[existingIdx] = {
        ...p,
        ...mergePartIdentity(p, { id: partId }),
        text: content,
      };
      return nextParts;
    }
    // 未画过的增量后缀 → 原地追加到该思考部件尾部！
    const suffix = unpaintedReplaySuffix(p.text || '', content);
    if (!suffix) return null;
    const nextParts = parts.slice();
    nextParts[existingIdx] = {
      ...p,
      ...mergePartIdentity(p, { id: partId }),
      text: (p.text || '') + suffix,
    };
    return nextParts;
  }

  // 画布上尚无这一段思考 → 原样开启新的思考部件
  return appendReasoningPart(parts, content, partId);
}

/** Disk stored a capped field. The replay is the same text plus what was cut
 *  off. Replace that part in place so the cut-off tail is not painted again
 *  as a second Thinking block, and later prose still follows the original part. */
function replaceTruncatedParts(
  parts: MsgPart[],
  kind: 'text' | 'reasoning',
  incoming: string,
  partId?: string,
): MsgPart[] | null {
  if (!incoming) return null;
  const index = parts.findIndex((part) =>
    (part.kind === kind) && (part.text || '').endsWith(DISPLAY_TRUNCATION_MARK),
  );
  if (index < 0) return null;
  const part = parts[index]!;
  if (part.kind !== kind) return null;
  const body = withoutDisplayTruncation(part.text || '');
  if (!body || !incoming.startsWith(body)) return null;
  const identity = mergePartIdentity(part, { id: partId });
  if (incoming === body) {
    const next = parts.slice();
    next[index] = { ...part, ...identity, text: body };
    return next;
  }
  const next = parts.slice();
  next[index] = { ...part, ...identity, text: incoming };
  return next;
}

/** Chunk still worth appending. Empty means the replay is already on the row. */
export function visibleToolChunk(
  parts: MsgPart[],
  callId: string | undefined,
  chunk: string,
  replay: boolean,
): string {
  if (!replay) return chunk;
  const row = callId
    ? parts.find((part) => part.kind === 'tool' && part.tool.id === callId)
    : [...parts].reverse().find((part) => part.kind === 'tool');
  const painted = row && row.kind === 'tool' ? row.tool.output ?? '' : '';
  return unpaintedReplaySuffix(painted, chunk);
}

export function foldLiveTodo(input: {
  state: TodoItem[] | null | undefined;
  remembered: TodoItem[] | null | undefined;
  name: string;
  args: string;
  callId?: string;
  appliedIds: Set<string>;
}): TodoItem[] | null {
  return applyLiveTodoToolCall({
    current: todoBaselineForLiveApply(input.state, input.remembered),
    name: input.name,
    args: input.args,
    callId: input.callId,
    appliedIds: input.appliedIds,
  });
}

/**
 * 将非致命通知（压缩 / 告警 / 重连）作为顶层 `SystemRecord` 插入：
 * `role:'system'` + notice part + `seq`。不再伪造 assistant 行，也不使用 anchorId。
 */
export function paintAssistantNotice<T extends ProjectionMessage>(
  messages: T[],
  text: string,
  targetId?: string,
  id?: string,
): T[] {
  if (!text) return messages;
  // 只在**末尾连续区域**去重，不能全局去重：
  // 全局 `some` 会让一条历史 notice 永远占着画布（它已被写进缓存），
  // 而它的 seq 落在当时那一轮之后、后续每一轮之前 —— 视觉上就是
  // “这条提示粘在之后所有模型回答的下面”。
  // 只检查尾部（同一轮的重复帧），跨轮的不再复用。
  const hasNotice = (message: ProjectionMessage): boolean =>
    message.role === 'system'
    && message.parts.some((part) => part.kind === 'notice' && part.text === text);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'assistant') continue; // 跳过本轮助手行，只看本轮的提示
    if (hasNotice(m)) return messages;
    break;
  }

  const seqOf = (message: ProjectionMessage | undefined): number | undefined =>
    typeof message?.seq === 'number' ? message.seq : undefined;

  let at = messages.length;
  let anchorSeq: number | undefined;
  let targetFound = false;
  if (targetId) {
    const target = messages.findIndex(
      (message) => message.id === targetId || message.clientInputId === targetId,
    );
    if (target >= 0) {
      at = target + 1;
      anchorSeq = seqOf(messages[target]);
      targetFound = true;
    }
  }
  if (!targetFound) {
    // The exact assistant round may be above the current canvas window or may
    // not have painted yet. Falling back to the absolute tail makes the notice
    // permanently stick below the final answer. The current turn's user prompt
    // is the nearest stable boundary: place the transient advisory right after
    // it, before the answer rows.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === 'user') {
        at = i + 1;
        anchorSeq = seqOf(messages[i]);
        break;
      }
    }
  }
  if (anchorSeq == null) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const seq = seqOf(messages[i]);
      if (seq != null) {
        anchorSeq = seq;
        break;
      }
    }
  }

  const noticeId = id ?? (targetId ? `notice-${targetId}` : `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const row = {
    role: 'system',
    id: noticeId,
    // Live advisory only. `stripTransientNoticeRows` removes it before it can
    // become a durable canvas row; durable boundaries use `authoritative_notice`.
    transient: true,
    parts: [{ kind: 'notice', text }],
    ...(anchorSeq != null ? { seq: anchorSeq + 0.5 } : {}),
  } as unknown as T;
  const next = messages.slice();
  next.splice(at, 0, row);
  return next;
}

/**
 * 从画布数组中剔掉「不应跨轮存活」的纯本地通知行。
 *
 * `notice` / `rate_limited` 是瞬时反馈（“该消息已被压缩”“上游限流”），
 * 它们被插到某一轮之后。一旦原样写进画布缓存，下一轮及之后所有回答都会
 * 继续排在它后面 —— 用户看到的就是「这条提示带到以后所有模型回答的下面」。
 * 所以落缓存前统一剥掉；需要时由当前轮自己的事件重新生成。
 */
/** 旧版本曾把“停止确认 / 发送被阻止”等输入态提示写进系统行。
 *  它们不是历史：即使后来补上了 id + seq，也必须在缓存读写时剥掉，
 *  否则会永远粘在最新回答下面。
 *
 *  只匹配旧版已经落缓存的文案前缀（当前版本已改为 toast，不再产生新行），
 *  不参与任何实时路由判定。 */
const TRANSIENT_ADVISORY_MARKERS = [
  '正在重试',
  '秒后重试',
  '正在重连',
  '只返回了思考',
  '空响应',
  '响应格式异常',
  '上下文水位',
  '上下文已溢出',
  'retrying',
  'only reasoning',
  'empty response',
  'malformed response',
  'stream idle timeout',
  'context watermark',
  'context overflow',
] as const;

/** True for legacy persisted retry/liveness advisories that must never be
 *  re-projected as transcript rows after a reload. New advisories are live-only. */
export function isTransientAdvisoryText(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (!value) return false;
  return TRANSIENT_ADVISORY_MARKERS.some((marker) => value.includes(marker));
}

const EPHEMERAL_ADVISORY_PREFIXES = [
  '已请求停止当前回合',
  'The current turn was asked to stop',
  'Đã yêu cầu dừng lượt hiện tại',
  '正在观察此会话。发送会打断当前回合',
  'Watching this session. Sending interrupts',
  'Đang theo dõi phiên này. Gửi tin sẽ ngắt',
  '实时连接中断。发送会打断当前回合',
  'The live connection dropped',
  'Kết nối trực tiếp đã mất',
  '当前回合在插话确认前结束',
  'The turn ended before the steer was confirmed',
  'Lượt hiện tại đã kết thúc trước khi xác nhận',
  '请先停止当前回合',
  'Stop the current turn before running this command',
] as const;

function isEphemeralAdvisoryText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && EPHEMERAL_ADVISORY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function stripTransientNoticeRows<
  T extends {
    id?: string;
    seq?: number;
    role?: string;
    parts?: MsgPart[];
    /** Authoritative display-log notice; safe to keep across cache reads. */
    persistent?: boolean;
    /** Live advisory (retry / liveness); must never enter the durable canvas. */
    transient?: boolean;
  },
>(rows: T[]): T[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let changed = false;
  const out: T[] = [];
  for (const row of rows) {
    if (!row) {
      out.push(row);
      continue;
    }
    const parts = row.parts ?? [];
    // Rate-limit cards and retry/liveness advisories are live-turn feedback;
    // they must never survive a cache round-trip. This also cleans legacy
    // notice/rate_limited parts that were attached to assistant rows.
    const cleanedParts = parts.filter((part) => {
      if (part.kind === 'rate_limited') return false;
      if (
        part.kind === 'notice'
        && (isEphemeralAdvisoryText(part.text ?? '') || isTransientAdvisoryText(part.text ?? ''))
      ) {
        return false;
      }
      return true;
    });
    if (cleanedParts.length !== parts.length) {
      changed = true;
    }
    const nextRow = cleanedParts.length === parts.length
      ? row
      : ({ ...row, parts: cleanedParts } as T);
    if (nextRow.role !== 'system') {
      // An assistant row that only carried a transient advisory is not an answer.
      if (cleanedParts.length === 0 && parts.length > 0) continue;
      out.push(nextRow);
      continue;
    }
    if (cleanedParts.length === 0) continue;
    if (nextRow.persistent === true) {
      out.push(nextRow);
      continue;
    }
    if (nextRow.transient === true) continue;
    // Legacy rows had id+seq but no durability marker. A notice-only system
    // row is an advisory, not a transcript record: drop it. Authoritative
    // boundaries are reloaded from display.jsonl and carry `persistent`.
    const onlyTransient = cleanedParts.every(
      (part) => part.kind === 'notice' || part.kind === 'rate_limited',
    );
    if (onlyTransient) continue;
    out.push(nextRow);
  }
  return changed ? out : rows;
}

/** 展示账本/磁盘快照里永远不会存在的“本地 UI 部件”。权威切片按行身份替换画布行时
 *  必须把它们接回同一条消息，否则一次终态对账就会把压缩标记/通知冲掉
 *  （todolist 另有 placeArchivedTodos 回贴，不在此列，避免复活旧清单）。 */
const LOCAL_ONLY_PART_KINDS = new Set(['notice', 'rate_limited']);

/** 把画布上同一条消息的本地部件补回权威行（保持原有相对顺序，磁盘行不动）。 */
function withLocalOnlyParts<T extends { id?: string }>(row: T, canvasById: Map<string, T>): T {
  if (!row.id) return row;
  const local = canvasById.get(row.id);
  if (!local || local === row) return row;
  const localParts = ((local as { parts?: MsgPart[] }).parts ?? []).filter((part) =>
    LOCAL_ONLY_PART_KINDS.has(part.kind),
  );
  if (localParts.length === 0) return row;
  const diskParts = ((row as { parts?: MsgPart[] }).parts ?? []) as MsgPart[];
  const alreadyThere = (part: MsgPart): boolean =>
    diskParts.some(
      (existing) =>
        existing.kind === part.kind &&
        // 同一段文本算同一条；限流卡只看是否已有同类提示。
        (existing as { text?: string }).text === (part as { text?: string }).text,
    );
  const missing = localParts.filter((part) => !alreadyThere(part));
  if (missing.length === 0) return row;
  return { ...row, parts: [...diskParts, ...missing] };
}

/** 本地通知行（命令输出 / 压缩标记）在画布中的插入位置：钉在创建时的锚点之后，绝不越过未落盘的新轮次。 */
function localNoticeInsertIndex<T extends { id?: string; sourceIndex?: number }>(
  rows: T[],
  notice: { seq?: number },
  maxIndex: number,
): number {
  if (typeof notice.seq !== 'number') return maxIndex;
  const next = rows.findIndex(
    (row) => typeof (row as { seq?: number }).seq === 'number'
      && (row as { seq?: number }).seq! > notice.seq!,
  );
  return next >= 0 ? Math.min(next, maxIndex) : maxIndex;
}

/** 权威切片里已出现过的身份（行 id / part id / 工具 call id / 内容键）。 */
interface TailIdentity {
  ids: Set<string>;
  partIds: Set<string>;
  toolIds: Set<string>;
  contentKeys: Set<string>;
}

/**
 * 一行携带的全部身份别名：内核 id + 落盘前的客户端关联键。
 *
 * 同一条提问在生命周期里先后拥有这两个键（乐观气泡只有 `clientInputId`，落盘后
 * 才拿到 `id`）。权威切片去重必须同时认两者，否则「服务端钉住的提问」与「画布上的
 * 本地副本」会各留一份：切会话回来后，旧副本被当成未落盘尾巴追加到时间线最底部。
 */
function rowIdentityIds(row: { id?: string; clientInputId?: string }): string[] {
  const ids: string[] = [];
  if (row.id) ids.push(row.id);
  if (row.clientInputId) ids.push(row.clientInputId);
  return ids;
}

function collectTailIdentity<T extends { sourceIndex?: number; id?: string; clientInputId?: string }>(rows: T[]): TailIdentity {
  const identity: TailIdentity = {
    ids: new Set<string>(),
    partIds: new Set<string>(),
    toolIds: new Set<string>(),
    contentKeys: new Set<string>(),
  };
  for (const row of rows) {
    for (const id of rowIdentityIds(row)) identity.ids.add(id);
    const isUserRow = (row as { role?: string }).role === 'user';
    const parts = (row as { parts?: MsgPart[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.kind === 'tool') {
        if (part.tool?.id) {
          identity.toolIds.add(part.tool.id);
        }
        continue;
      }
      if ((part.kind === 'text' || part.kind === 'reasoning')) {
        if (part.id) identity.partIds.add(part.id);
        // 用户提问只按身份判重：相同文案的多次发送是**多条真实提问**，
        // 绝不能因为内容和窗口里的某条旧提问一样就被当成重复剪掉。
        if (isUserRow) continue;
        const t = (part.text || '').trim();
        if (t.length > 0) {
          // 纯内容键：即使旧版本或直播行没盖 part id，也能按完整内容指纹拦截倒灌
          identity.contentKeys.add(`${part.kind}:${t}`);
        }
      }
    }
  }
  return identity;
}

/**
 * 剔除头部行里已经由权威切片渲染的段；整行都被切片覆盖时返回 null。
 *
 * 行级 id 命中 → 整行丢弃；否则只丢掉「同一 part id / 同一工具 call id / 同一内容键」的段。
 * 共存只能说明这行是在途聚合行（例如模型连续 20 多轮只吐思考与工具时，全部段都落在
 * 发送时那条占位行上），保留它就会让整轮回答在权威尾部之后再渲染一遍。
 */
function pruneDuplicatedTailContent<T extends { sourceIndex?: number; id?: string; clientInputId?: string }>(
  row: T,
  identity: TailIdentity,
): T | null {
  if (rowIdentityIds(row).some((id) => identity.ids.has(id))) return null;
  // 用户提问只按身份判重：重复发同一句话是多次真实提问，不能按文本剪枝。
  if ((row as { role?: string }).role === 'user') return row;
  const parts = (row as { parts?: MsgPart[] }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return row;
  const kept = parts.filter((part) => {
    if (part.kind === 'tool') {
      return !(part.tool?.id && identity.toolIds.has(part.tool.id));
    }
    if (part.kind === 'text' || part.kind === 'reasoning') {
      if (part.id && identity.partIds.has(part.id)) return false;
      const t = (part.text || '').trim();
      if (t.length > 0 && identity.contentKeys.has(`${part.kind}:${t}`)) {
        return false;
      }
    }
    return true;
  });
  if (kept.length === parts.length) return row;
  if (kept.length === 0) return null;
  return { ...row, parts: kept } as T;
}

/**
 * 用磁盘返回的权威尾部切片（diskTail）安全替换画布/缓存的尾部，同时严格保留
 * 画布中早于该切片起始偏移（sourceIndex < diskOffset）的更早历史头部（olderHead）。
 * 既不丢失用户向上翻看过的更早历史，又彻底杜绝内存旧尾部与磁盘新尾部杂交双重渲染！
 *
 * 核心架构铁律：
 * diskTail 包含两部分：
 * 1. pinned 行：sourceIndex < diskOffset（daemon 为首屏展示钉住的开场提问）；
 * 2. actualTail：sourceIndex >= diskOffset（真正的尾部权威数据）。
 * 若画布本身已具有早先历史（olderHead.length > 0），早先提问已处于其天然时序位置（在回答
 * 之前），绝不能从 olderHead 中剔除挪到 diskTail 头部（否则造成提问倒插到回答下方！）。
 * 只有画布无早先历史时，才采用 pinnedInTail。拼接后严格按 sourceIndex 升序对齐与去重。
 *
 * 第三个铁律：头部行不能夹带权威切片里已有的内容。推流期一条助手行可能聚了整轮多个
 * round（模型连续只吐思考与工具时不会结算），这种行一旦因为早期猜出来的下标被当成
 * 「更早历史」保留，整轮回答就会在权威尾部之后重放一遍。因此先按行 id / part id /
 * 工具 call id 把切片已渲染的部分从头部剔除，再拼接。
 */
export function spliceAuthoritativeDiskTail<
  T extends {
    sourceIndex?: number;
    id?: string;
    clientInputId?: string;
    isSteer?: boolean;
    role?: string;
    seq?: number;
  },
>(
  canvas: T[],
  diskTail: T[],
  diskOffset: number,
): T[] {
  if (!canvas || canvas.length === 0) return diskTail;
  if (!diskTail || diskTail.length === 0) return canvas;

  const canvasById = new Map<string, T>();
  for (const row of canvas) {
    if (row.id) canvasById.set(row.id, row);
  }

  // 权威行替换画布行时，把本地 UI 部件（通知 / 限流）接回同一条消息。
  const withLocalParts = (row: T): T => withLocalOnlyParts(row, canvasById);

  const actualTail: T[] = [];
  const pinnedInTail: T[] = [];
  for (const message of diskTail) {
    if (diskOffset > 0 && typeof message.sourceIndex === 'number' && message.sourceIndex < diskOffset) {
      pinnedInTail.push(withLocalParts(message));
    } else {
      actualTail.push(withLocalParts(message));
    }
  }

  // 权威切片已经渲染过的身份。头部行只是「切片之前的更早历史」，一旦它身上带着
  // 切片里的同一份内容，就说明这行是推流期拼出来的在途行（一轮多 round 时思考/工具
  // 全堆在同一条助手消息里），绝不能连同权威副本再渲染一遍。
  //
  // 只按 actualTail 建身份集：pinned 行（sourceIndex < diskOffset）在头部存在时会被
  // 丢弃，不能因为它把画布上同一条提问的本地行（可能带附件）也一起排除。
  const tailIdentity = collectTailIdentity(actualTail);

  if (diskOffset <= 0) {
    // 当 diskOffset <= 0 且画布与磁盘没有任何共享身份、也不含未落盘转向/无下标直播行时，
    // 直接采用磁盘切片（保持旧纯无 id 测试语义）。
    const hasSharedOrLiveRows = canvas.some((row) => {
      if (row.role === 'system') return typeof row.seq === 'number';
      if (rowIdentityIds(row).some((id) => tailIdentity.ids.has(id))) return true;
      return row.isSteer === true || typeof row.sourceIndex !== 'number';
    });
    if (!hasSharedOrLiveRows) return diskTail;
  }

  // 定位画布行在 actualTail 中的对应槽位（用于因果夹心保护：绝不允许把已经在
  // 后续权威行之前的 user/steer 气泡丢进 overlayTail 重排到时间线最末尾！）。
  const findActualTailSlot = (row: T): number => {
    const ids = rowIdentityIds(row);
    if (ids.length > 0) {
      const byId = actualTail.findIndex((a) =>
        rowIdentityIds(a).some((aid) => ids.includes(aid)),
      );
      if (byId >= 0) return byId;
    }
    if (row.role !== 'user') {
      const parts = (row as { parts?: MsgPart[] }).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part.kind === 'tool' && part.tool?.id) {
            const tid = part.tool.id;
            const byTool = actualTail.findIndex(
              (a) =>
                a.role !== 'user' &&
                ((a as { parts?: MsgPart[] }).parts ?? []).some(
                  (p) => p.kind === 'tool' && p.tool?.id === tid,
                ),
            );
            if (byTool >= 0) return byTool;
          } else if ((part.kind === 'text' || part.kind === 'reasoning') && part.id) {
            const pid = part.id;
            const byPart = actualTail.findIndex(
              (a) =>
                a.role !== 'user' &&
                ((a as { parts?: MsgPart[] }).parts ?? []).some(
                  (p) => (p.kind === 'text' || p.kind === 'reasoning') && p.id === pid,
                ),
            );
            if (byPart >= 0) return byPart;
          }
        }
      }
    }
    const trusted =
      typeof row.sourceIndex === 'number' && row.isSteer !== true
        ? row.sourceIndex
        : undefined;
    if (typeof trusted === 'number' && trusted >= diskOffset) {
      const bySrc = actualTail.findIndex((a) => a.sourceIndex === trusted);
      if (bySrc >= 0) return bySrc;
    }
    return -1;
  };

  const matchedActualSlots = canvas.map(findActualTailSlot);
  let lastWindowCanvasIdx = -1;
  for (let i = 0; i < canvas.length; i += 1) {
    const row = canvas[i]!;
    if (row.role === 'system') continue;
    const trusted =
      typeof row.sourceIndex === 'number' && row.isSteer !== true
        ? row.sourceIndex
        : undefined;
    if (
      matchedActualSlots[i]! >= 0 ||
      (diskOffset > 0 && typeof trusted === 'number' && trusted >= diskOffset)
    ) {
      lastWindowCanvasIdx = i;
    }
  }

  // 已经上屏的权威行身份（仅段/工具 id，不含行 id）。
  //
  // 直播期间一条聚合 assistant 行会把本轮更早 round 的工具卡/正文也攒在身上，
  // 而那些 round 早已以权威行的形式上屏。只拿切片建身份集时它们对不上号，
  // 整行就被当成「尚未落盘的当前尾巴」追加到末尾——回答完成后底部又被之前
  // 的工具卡/思考灌一遍。这里只对**没有可信下标**的直播行做第二道剔除。
  const paintedParts = collectTailIdentity(
    canvas.filter(
      (message) =>
        message.role !== 'user' &&
        typeof message.sourceIndex === 'number' &&
        message.sourceIndex < diskOffset,
    ),
  );
  // 行 id 会命中这些行本身（它们还要留在头部），只保留段 / 工具身份。
  paintedParts.ids.clear();
  const olderHead: T[] = [];
  // 已越过权威窗口、但磁盘切片里没有的本地直播行（还没落盘的这一轮）。
  // 绝不能因为「下标落在窗口内」就把它们丢掉：那正是断网重连/刷新后 steer 段
  // 凭空消失、只剩工具行的根因。保留原顺序、排在权威尾部之后再按身份去重。
  const overlayTail: T[] = [];
  // 落在权威窗口内部（后面还有已落盘的 actualTail 行）但尚未出现在磁盘切片中的 user / steer 行：
  // 必须锚定在紧随其后的 actualTail 行之前，绝不能丢进 overlayTail 挪到整段回答末尾！
  const midWindowInserts = new Map<number, T[]>();
  // 带锚点的本地通知行（命令输出 / 压缩标记）：它们不属于直播尾巴，创建时就钉在
  // 某一轮之后。必须按锚点归位，否则会被当成“未落盘尾巴”拖到会话末尾，
  // 表现为每一轮的尾都已带着它（与先前黄色通知堆叠同一类问题）。
  const anchoredNotices: T[] = [];
  let currentTurnSourceIndex: number | undefined = undefined;
  // 一旦画布扫描命中了 `diskTail` 里的任意一行（按行身份或 `trustedIndex >= diskOffset`），
  // 说明画布已经跨入权威尾窗区间：此后出现的任何无下标直播行 / 转向行都只可能属于尾窗内或尾窗之后
  // 的 `overlayTail`，绝不能再因为早期缓存留下的 `currentTurnSourceIndex < diskOffset` 被塞进 `olderHead`。
  let enteredWindow = diskOffset <= 0;

  for (let i = 0; i < canvas.length; i += 1) {
    const message = canvas[i]!;
    const anchored = message.role === 'system';
    if (anchored) {
      anchoredNotices.push(message);
      continue;
    }
    // steer 行的绝对下标是 fold 时按当前窗口末尾推算出来的，从来没被磁盘确认过；
    // 拿它当排序依据会把整段 steer 判成「窗口内」而丢弃或重排。只认真正的转录下标。
    const trustedIndex =
      typeof message.sourceIndex === 'number' && message.isSteer !== true
        ? message.sourceIndex
        : undefined;
    if (typeof trustedIndex === 'number') {
      currentTurnSourceIndex = trustedIndex;
      if (trustedIndex >= diskOffset) enteredWindow = true;
    }
    if (matchedActualSlots[i]! >= 0 || rowIdentityIds(message).some((id) => tailIdentity.ids.has(id))) {
      enteredWindow = true;
      if (typeof currentTurnSourceIndex !== 'number' || currentTurnSourceIndex < diskOffset) {
        currentTurnSourceIndex = diskOffset;
      }
    }
    const insideWindow =
      enteredWindow ||
      (typeof currentTurnSourceIndex === 'number' && currentTurnSourceIndex >= diskOffset);
    // 若整行既无 sourceIndex，也无任何前驱轮次下标支撑，跳过
    if (!insideWindow && typeof currentTurnSourceIndex !== 'number' && typeof message.sourceIndex !== 'number') {
      continue;
    }

    let pruned = pruneDuplicatedTailContent(message, tailIdentity);
    if (pruned && typeof trustedIndex !== 'number') {
      // 没有可信下标的直播行：再按“已经上屏的权威行”剔除一遍重复段。
      pruned = pruneDuplicatedTailContent(pruned, paintedParts);
    }
    if (!pruned) continue;
    if (typeof trustedIndex === 'number' && trustedIndex >= diskOffset) {
      // 有自己的转录下标且落在窗口内：这一段由磁盘切片负责，画布副本直接丢弃。
      continue;
    }
    if (insideWindow) {
      // 因果铁律：如果画布上这一行后面还有已经命中 actualTail 的行（i < lastWindowCanvasIdx），
      // 说明这一行发生在那些权威输出之前（如中途转向 asteer1 或上一轮提问 aq2）！
      // 绝不能把它塞进 overlayTail 搬到整段会话最末尾（导致 asteer1 / aq2 + Working... 幽灵重发）。
      if (lastWindowCanvasIdx >= 0 && i < lastWindowCanvasIdx) {
        if (pruned.role === 'user') {
          let targetSlot = -1;
          for (let j = i + 1; j < canvas.length; j += 1) {
            if (matchedActualSlots[j]! >= 0) {
              targetSlot = matchedActualSlots[j]!;
              break;
            }
          }
          if (targetSlot >= 0) {
            const bucket = midWindowInserts.get(targetSlot);
            if (bucket) bucket.push(pruned);
            else midWindowInserts.set(targetSlot, [pruned]);
          }
        }
        continue;
      }
      // 真正位于权威窗口最后一帧之后的本地尾巴（尚未落盘的最新一轮）：保留在权威尾部之后。
      overlayTail.push(pruned);
      continue;
    }
    // 若画布行缺失图片（如推流期从无图广播事件生成），而权威磁盘 pinned 提问带图，自动补全图片
    const pinnedMatch = pinnedInTail.find(
      (p) =>
        typeof p.sourceIndex === 'number' &&
        p.sourceIndex === (pruned as any).sourceIndex &&
        Array.isArray((p as any).images) &&
        (p as any).images.length > 0,
    );
    if (pinnedMatch && (!(pruned as any).images || (pruned as any).images.length === 0)) {
      pruned = { ...pruned, images: (pinnedMatch as any).images };
    }
    olderHead.push(pruned);
  }

  // 权威身份集（含 pinned 行）：钉住的提问只会在头部出现一次。
  const authoritativeIds = new Set<string>();
  for (const row of [...actualTail, ...pinnedInTail]) {
    for (const id of rowIdentityIds(row)) authoritativeIds.add(id);
  }

  let effectiveActualTail = actualTail;
  if (midWindowInserts.size > 0) {
    effectiveActualTail = [];
    for (let k = 0; k < actualTail.length; k += 1) {
      const inserts = midWindowInserts.get(k);
      if (inserts) {
        for (const ins of inserts) {
          const ids = rowIdentityIds(ins);
          if (ids.some((id) => authoritativeIds.has(id))) continue;
          for (const id of ids) authoritativeIds.add(id);
          effectiveActualTail.push(ins);
        }
      }
      effectiveActualTail.push(actualTail[k]!);
    }
  }

  const baseHead = diskOffset > 0 ? (olderHead.length > 0 ? olderHead : pinnedInTail) : [];
  // 数组顺序就是因果顺序：画布头部（更早的历史）在前，权威切片在后。
  // 这里曾按 seq/sourceIndex 再排一次，而直播行 / 转向行的 seq 是本地坐标系的小值，
  // 一排序就把它们连同后面的正文端到会话最前面。渲染层已不再重排，这里同样不能重排。
  const combined = [...baseHead, ...effectiveActualTail];

  const seenIds = new Set<string>();
  const seenSrc = new Set<number>();
  const result: T[] = [];
  for (const m of combined) {
    const ids = rowIdentityIds(m);
    if (ids.some((id) => seenIds.has(id))) continue;
    // sourceIndex is only a legacy cursor. New rows share the same positional
    // page offset across windows; deduping them by it would drop real rows.
    if (m.seq == null && typeof m.sourceIndex === 'number' && seenSrc.has(m.sourceIndex)) continue;
    for (const id of ids) seenIds.add(id);
    if (m.seq == null && typeof m.sourceIndex === 'number') seenSrc.add(m.sourceIndex);
    result.push(m);
  }
  // 未落盘的本地尾巴固定在最后：它们是当前这一轮最新的内容。
  const actualTailLastUserTs = (() => {
    for (let i = effectiveActualTail.length - 1; i >= 0; i--) {
      const row = effectiveActualTail[i];
      if (row?.role === 'user' && typeof (row as { ts?: number }).ts === 'number') {
        return (row as { ts?: number }).ts!;
      }
    }
    return 0;
  })();

  const overlayStartIndex = result.length;
  for (const m of overlayTail) {
    const ids = rowIdentityIds(m);
    if (ids.some((id) => authoritativeIds.has(id) || seenIds.has(id))) continue;
    // 关键防线：如果未落盘尾巴的时间戳明显早于磁盘最新用户提问，说明是更早的孤儿提问，绝不能倒挂在最新回答末尾！
    const mTs = (m as { ts?: number }).ts;
    if (actualTailLastUserTs > 0 && typeof mTs === 'number' && mTs < actualTailLastUserTs - 5000) {
      continue;
    }
    for (const id of ids) seenIds.add(id);
    result.push(m);
  }
  // 本地通知行按创建时的 `seq` 归位（压缩标记冻结在发生压缩的那一轮尾部）。
  // 铁律：它属于历史已落盘/已结算轮次，其插入位置绝不能越过 overlayTail（当前未落盘的新轮次）！
  const byInsertIndex = new Map<number, T[]>();
  for (const notice of anchoredNotices) {
    if (typeof notice.seq !== 'number') continue;
    if (notice.id && seenIds.has(notice.id)) continue;
    const noticeText = (notice as { parts?: MsgPart[] }).parts?.find((p) => p.kind === 'notice')?.text?.trim();
    if (
      noticeText &&
      result.some((r) =>
        ((r as { parts?: MsgPart[] }).parts ?? []).some(
          (p) => p.kind === 'notice' && p.text?.trim() === noticeText,
        ),
      )
    ) {
      continue;
    }
    if (notice.id) seenIds.add(notice.id);
    const at = localNoticeInsertIndex(result, notice, overlayStartIndex);
    const bucket = byInsertIndex.get(at);
    if (bucket) bucket.push(notice);
    else byInsertIndex.set(at, [notice]);
  }
  for (const [at, rows] of [...byInsertIndex.entries()].sort((a, b) => b[0] - a[0])) {
    result.splice(at, 0, ...rows);
  }
  return result;
}

/**
 * 往前补页时，首屏钉住的那条提问可能已经在画布上。
 * 合并更早历史与现有画布时：
 * 1. 按 id 和 sourceIndex 严格去重，避免重复渲染；
 * 2. 只把**新加载的更早行插入**到它的时序位置，绝不重排已有画布；
 * 3. 无 sourceIndex / seq 的在途实时消息保持在末尾原有相对顺序。
 *
 * 旧实现在“画布里的键不是严格递增”时会整表重排（决策依赖 seq/sourceIndex，
 * 而两者分属不同坐标系），一次向上翻页就能把直播行 / 转向卡端到最前面。
 * 现在顺序权威只有数组因果序：插入新页，原地保留旧行。
 */
export function mergeOlderMessages<
  T extends { id?: string; sourceIndex?: number; seq?: number; role?: string; parts?: MsgPart[]; ts?: number },
>(prev: T[], older: T[]): T[] {
  if (!older || older.length === 0) return prev;
  if (!prev || prev.length === 0) return older;

  const orderKey = (m: T): number | undefined => (
    typeof m.seq === 'number'
      ? m.seq
      : typeof m.sourceIndex === 'number'
        ? m.sourceIndex
        : undefined
  );
  // INSERT older rows into prev instead of re-sorting everything.
  // Re-sorting used to move index-less rows (older L1/L2 caches written before
  // absolute indices existed) to the very end, so the first question appeared
  // below later answers. Insertion preserves every existing row's position;
  // only the newly loaded rows move into their chronological slot.
  const result = prev.slice();
  const seenIds = new Set<string>();
  const seenKeys = new Set<number>();
  for (const m of result) {
    if (m.id) seenIds.add(m.id);
    const key = orderKey(m);
    if (key != null) seenKeys.add(key);
  }
  // 插入位置：**线性查找第一个更大的键**。
  //
  // 不能二分：画布尾部会混着“本地坐标系”的直播行（seq 个位数）与磁盘行
  // （seq 1200+），整个数组并非有序，二分落点会错 → 把旧历史追加到末尾
  // （用户看到的“相邻两条 user / 消息篡位”）。
  // 也不能用单调游标：大纲跳转（jump/around）的输入是乱序的，游标只会前进
  // 会插错。分页场景下插入点就在头部，线性扫描实际只走几步，开销可忽略。
  const insertionPoint = (target: number): number => {
    for (let i = 0; i < result.length; i += 1) {
      const key = orderKey(result[i]!);
      if (key != null && key > target) return i;
    }
    return result.length;
  };

  for (const m of older) {
    if (m.id && seenIds.has(m.id)) continue;
    const incomingKey = orderKey(m);
    if (incomingKey != null && seenKeys.has(incomingKey)) continue;

    let insertAt: number;
    if (incomingKey != null) {
      insertAt = insertionPoint(incomingKey);
      // 没有更大的 keyed 行时，插到尾部“无下标行”之前（流式助手 / 乐观提问）。
      if (insertAt >= result.length) {
        insertAt = result.length;
        while (insertAt > 0 && orderKey(result[insertAt - 1]!) == null) {
          insertAt -= 1;
        }
      }
    } else {
      // 无下标行的两种来源：尚未落盘的直播行（流式助手气泡 / 乐观提问），或整页
      // 都没有绝对下标的旧缓存历史。同一条直播行会同时出现在 L1 全量画布和可视
      // 窗口里（落缓存时取并集），且两份进度可能不同 —— 先按「角色 + 工具调用序列」
      // 对账，文本互为前缀即同一行，保留更新（更长）的那份，绝不能在时间线顶部
      // 多出一条空气泡。提问行走上面的 sameUserRow（文本 + 时间戳），不能被这里
      // 按纯文本吞掉——同文不同发是两条真消息。
      const liveMatch = m.role === 'user' ? null : findIndexLessRow(result, m);
      if (liveMatch) {
        if (liveMatch.disposition === 'skip') continue;
        result[liveMatch.index] = m;
        if (m.id) seenIds.add(m.id);
        continue;
      }
      // 位置：画布尾部本身是无下标行时，它属于正在进行的回合 → 接在末尾；
      // 否则按旧缓存语义插到带下标历史之前。
      const tailIsIndexLess =
        result.length > 0 && typeof result[result.length - 1]!.sourceIndex !== 'number';
      if (tailIsIndexLess) {
        insertAt = result.length;
      } else {
        insertAt = result.findIndex((candidate) => typeof candidate.sourceIndex === 'number');
        if (insertAt < 0) insertAt = result.length;
      }
    }

    result.splice(insertAt, 0, m);
    if (m.id) seenIds.add(m.id);
    const key = orderKey(m);
    if (key != null) seenKeys.add(key);
  }

  return result;
}

/**
 * 无下标行的流式身份：角色 + 工具调用序列 + 文本/思考拼接。
 *
 * 没有 `id`、也没有绝对下标的行只可能是「尚未落盘」或「旧缓存」。同一条直播行在
 * L1 全量画布与可视窗口里各有一份，且两份的流式进度可能不同，所以文本用前缀关系
 * 判定同一行：短的是长的前缀 → 同一行，保留更长的那份。
 */
function indexLessRowShape(row: { parts?: MsgPart[] }): { tools: string; text: string } {
  const tools: string[] = [];
  let text = '';
  for (const part of row.parts ?? []) {
    if (part.kind === 'tool') tools.push(part.tool?.id ?? '');
    else if (part.kind === 'text' || part.kind === 'reasoning') text += part.text || '';
  }
  return { tools: tools.join('\u0000'), text };
}

function findIndexLessRow<T extends { role?: string; parts?: MsgPart[] }>(
  rows: T[],
  incoming: T,
): { index: number; disposition: 'skip' | 'replace' } | null {
  const want = indexLessRowShape(incoming);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.role !== incoming.role) continue;
    const have = indexLessRowShape(row);
    if (have.tools !== want.tools) continue;
    if (have.text === want.text) return { index: i, disposition: 'skip' };
    if (want.text.startsWith(have.text)) return { index: i, disposition: 'replace' };
    if (have.text.startsWith(want.text)) return { index: i, disposition: 'skip' };
  }
  return null;
}

/**
 * Does the cached canvas actually reach the authoritative tail?
 *
 * Splicing a cached head that ends hundreds of rows before `diskOffset` leaves
 * a hole between the two windows: the page is rendered, but everything between
 * the cache head and the disk tail is missing. Such a cache must be discarded
 * in favour of the tail (a contiguous cache ends at `diskOffset - 1` or overlaps
 * the tail with newer rows).
 */
export function cachedHeadIsContiguous(
  cachedMessages: Array<{ sourceIndex?: number; role?: string; parts?: MsgPart[] }> | undefined,
  diskOffset: number,
): boolean {
  if (!cachedMessages || cachedMessages.length === 0) return false;
  if (diskOffset <= 0) return true;

  // A cached HEAD + the authoritative TAIL with a missing middle used to pass
  // the max-only check. "Load older" walks BACKWARD from the cached head, so
  // that hole would never be filled. Display lists can legitimately skip a few
  // filtered internal rows, but a missing page is tens of raw rows; reject a
  // gap larger than half a display page.
  // 同时：直播流式追加的 assistant / steer 行没有 sourceIndex，而磁盘上每次工具调用
  // 会占用 2 条原始记录（assistant + tool_result）。沿画布累加这些在途行的原始跨度，
  // 避免长回合连续几十次工具调用后被误判为“缓存断层”而整表丢弃画布！
  const MAX_INTERNAL_GAP = 24;
  let prevEnd: number | null = null;
  let sawExplicitIndex = false;
  for (const message of cachedMessages) {
    const toolsCount = Array.isArray(message.parts)
      ? message.parts.filter((p) => p.kind === 'tool').length
      : 0;
    const rawSpan = 1 + toolsCount;
    if (typeof message.sourceIndex === 'number' && Number.isFinite(message.sourceIndex)) {
      sawExplicitIndex = true;
      if (prevEnd !== null && message.sourceIndex - prevEnd - 1 > MAX_INTERNAL_GAP) {
        return false;
      }
      prevEnd = Math.max(prevEnd ?? message.sourceIndex, message.sourceIndex + toolsCount);
    } else if (prevEnd !== null && (message.role === 'user' || message.role === 'assistant')) {
      prevEnd += rawSpan;
    }
  }
  if (!sawExplicitIndex || prevEnd === null) return false;
  return prevEnd >= diskOffset - 1;
}

/**
 * Resolve the paging cursor for a cold start that already has an L1/L2 canvas.
 *
 * The API always answers with a 48-row tail offset. If the cache holds earlier
 * pages, that offset is AHEAD of the canvas head: the next "load earlier"
 * fetches rows already rendered, adds nothing, and only walks the cursor back
 * after several dead clicks. Use the earliest index actually present on the
 * canvas, but never a stale index beyond the authoritative tail offset (old
 * array indices after compaction).
 */
export function resolveHistoryOffset(input: {
  cachedMessages?: Array<{ sourceIndex?: number }>;
  cachedOffset?: number;
  diskOffset: number;
}): number {
  const candidates: number[] = [];
  for (const message of input.cachedMessages ?? []) {
    if (typeof message.sourceIndex === 'number') {
      if (Number.isFinite(message.sourceIndex) && message.sourceIndex >= 0) {
        candidates.push(message.sourceIndex);
      }
    }
  }
  if (
    typeof input.cachedOffset === 'number' &&
    Number.isFinite(input.cachedOffset) &&
    input.cachedOffset >= 0
  ) {
    candidates.push(input.cachedOffset);
  }
  const valid = candidates.filter((index) => index <= input.diskOffset);
  return valid.length > 0 ? Math.min(...valid) : input.diskOffset;
}


