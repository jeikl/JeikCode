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

import { appendReasoningPart, type MsgPart } from './toolRows.ts';
import { isSteerUserMessage } from './turnTimer.ts';
import {
  DISPLAY_TRUNCATION_MARK,
  reconcileRunningTranscript,
  transcriptHasOpenUserTurn,
  unpaintedReplaySuffix,
  userMessageAlreadyOnCanvas,
  userTextsMatch,
  visibleUserText,
  withoutDisplayTruncation,
} from './chatTerminal.ts';
import {
  applyLiveTodoToolCall,
  restoreStickyTodos,
  stickyFromDiskCatchUp,
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
  /** 绝对转录下标：跨窗口/分页唯一的身份（右栏锚点、历史合并排序都用它）。 */
  sourceIndex?: number;
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

/** Tool calls, notices and checklists keep the chronological order. */
const PART_MERGE_BARRIER = new Set(['tool', 'notice', 'rate_limited', 'todo_list']);

/**
 * 同一回合内被切开的同种部件必须续上，否则画布上会出现两块 Thinking /
 * 半句正文（「思考/正文分叉」）。
 *
 * 段落身份按【类型】归一，而不是按轮编号：服务端每遇到类型切换就会 bump
 * `part_seq`，所以同一条消息里 `text → reasoning → text` 会拿到三个不同的
 * part_id（`m:2:text` / `m:3:reasoning` / `m:4:text`）。若按轮编号判断「同轮
 * 保留交替」，同一轮里被思考打断的正文就会永远分成两段。
 *
 * 只有工具调用与通知是硬边界（它们携带时间顺序），必须各自独立成段。
 */
export function coalesceRoundParts(parts: MsgPart[]): MsgPart[] {
  let changed = false;
  const out: MsgPart[] = [];
  for (const part of parts) {
    if (part.kind === 'text' || part.kind === 'reasoning') {
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
        const previous = out[target] as { kind: 'text' | 'reasoning'; text: string; id?: string };
        const incoming = part as { text: string; id?: string };
        out[target] = {
          ...previous,
          text: (previous.text || '') + (incoming.text || ''),
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
    if (messageId && last?.id && last.id !== messageId) return msgs;
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
    if (p && (p.kind === 'text' || p.kind === 'reasoning') && !p.id) {
      parts = parts.slice();
      parts[pi] = { ...p, id: partId };
      changed = true;
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
  identity?: { messageId?: string; partId?: string },
): T[] {
  const painted = part === 'text'
    ? paintAssistantText(messages, content, false, identity?.messageId, identity?.partId)
    : paintAssistantReasoning(messages, content, false, identity?.messageId, identity?.partId);
  return withAssistantIdentity(painted, identity?.messageId, identity?.partId);
}

/**
 * Disk poll. A running turn keeps the live tail. A finished turn takes the
 * file, and the checklist comes from the server list rather than a short
 * window fold. Returns the same message array when nothing changed so React
 * does not repaint the transcript.
 */
export function catchUpSession<T extends ProjectionMessage>(input: {
  messages: T[];
  disk: T[];
  running: boolean;
  adoptSettledDisk: boolean;
  serverTodos?: TodoItem[] | null;
  stashedTodos?: TodoItem[] | null;
}): { messages: T[]; todos: TodoItem[] | null | undefined } {
  const messages = input.running
    ? reconcileRunningTranscript(input.messages, input.disk)
    : input.adoptSettledDisk
      ? input.disk
      : input.messages;
  const todos = stickyFromDiskCatchUp({
    running: input.running,
    messages,
    stashed: input.stashedTodos,
    authoritativeTodos: input.serverTodos,
  });
  return { messages, todos };
}

/** Working... renders only on an empty assistant. A running turn whose last
 *  row is still the user prompt needs that placeholder or observers never
 *  show it. Returns the same array when the tail is already an assistant. */
export function ensureWorkingAssistant<T extends ProjectionMessage>(messages: T[]): T[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;
  return [...messages, { role: 'assistant', parts: [] } as unknown as T];
}

/** `/chat/watch` is the only canvas stream. A new user row needs the empty
 *  assistant behind it, or Working never renders. `repeatAfterSettled` appends
 *  the same words again after the previous turn already has an answer — an
 *  observer's next send, not a replay of the open turn. */
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
  opts?: { repeatAfterSettled?: boolean; clientInputId?: string },
): T[] {
  const clientInputId = opts?.clientInputId;
  if (clientInputId) {
    // 1. 身份幂等：同一条关联键已经在画布/缓存的行上（随缓存持久化）。
    if (messages.some((message) => message.clientInputId === clientInputId)) return messages;
    // 2. 键没见过 ≠ 新消息：磁盘投影 / 旧缓存里的同一条提问没有这个键。必须再用
    //    文本 + 时间戳判定是不是**同一次发送的重放** —— 否则回放会把用户气泡重新
    //    追加到末尾，紧随其后的正文/工具帧再落到这个新气泡里，表现为“提问错位 + 回复重复”。
    const sameSend = findSameSendUserIndex(messages, rawText, userTs);
    if (sameSend >= 0) {
      const row = messages[sameSend]!;
      if (row.clientInputId) return messages; // 已被其它发送占用
      const next = messages.slice();
      next[sameSend] = { ...row, clientInputId } as T;
      return next;
    }
    // 3. 确实是新的一次发送（可能是又发了一遍同样的内容）→ 追加，跳过模糊文本启发式。
    const appended = paintUserMessageInner(messages, rawText, userTs, create, {
      repeatAfterSettled: opts?.repeatAfterSettled,
      identityKnown: true,
    });
    return stampUserClientInputId(appended, clientInputId);
  }
  return paintUserMessageInner(messages, rawText, userTs, create, {
    repeatAfterSettled: opts?.repeatAfterSettled,
    identityKnown: false,
  });
}

/**
 * 文本命中的旧提问是不是「同一次发送」的重放（而不是用户又发了一遍相同内容）。
 *
 * - 行上有时间戳且与本次相差 ≤ 3s → 同一次发送；
 * - 行上没有时间戳（旧投影/legacy）→ 保守视为同一次发送，宁可幂等也不克隆；
 * - 时间戳明显不同 → 真的是新的发送，返回 -1 让调用方追加。
 */
function findSameSendUserIndex(
  messages: ProjectionMessage[],
  rawText: string,
  userTs: number,
): number {
  const want = visibleUserText(rawText);
  if (!want) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const text = visibleUserText(
      message.parts?.filter((part) => part.kind === 'text').map((part) => part.text || '').join('') ?? '',
    );
    if (!userTextsMatch(text, want)) continue;
    if (message.ts && userTs > 0 && Math.abs(message.ts - userTs) > 3000) return -1;
    return i;
  }
  return -1;
}

/** 给画布上最新的一条 user 行盖上客户端关联键（幂等；行已被别的发送占用则不动）。 */
export function stampUserClientInputId<T extends ProjectionMessage>(
  messages: T[],
  clientInputId?: string,
): T[] {
  if (!clientInputId) return messages;
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
 * 用回放的身份帧（`user_identified.absolute_index`）回填提问行的绝对下标，
 * 并按该下标把这一行**重排回正确位置**（渲染按数组序，光盖字段不改可见位置）。
 *
 * 回放里“被折叠线切掉的提问”由客户端重建，天然没有下标；服务端在身份帧里带上
 * 真实下标后就能直接归位。只处理“还没有下标”的行：磁盘投影行已有权威下标，绝不动。
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

  const rest = messages.slice(0, index).concat(messages.slice(index + 1));
  const stamped = { ...row, sourceIndex } as T;
  // 插到“第一个绝对下标更大”的行之前；没有则放末尾（在途新行）。
  let insertAt = rest.findIndex(
    (message) => typeof message.sourceIndex === 'number' && message.sourceIndex > sourceIndex,
  );
  if (insertAt < 0) insertAt = rest.length;
  const next = rest.slice();
  next.splice(insertAt, 0, stamped);
  return next;
}

function paintUserMessageInner<T extends ProjectionMessage>(
  messages: T[],
  rawText: string,
  userTs: number,
  create: (base: T[]) => T,
  opts?: { repeatAfterSettled?: boolean; identityKnown?: boolean },
): T[] {
  const userText = visibleUserText(rawText);
  // 身份权威（服务端回传了 client_input_id）时，全部文本启发式一律跳过：
  // 「同文不同发」是两条真实消息，文本去重会把它当回声吞掉；而真正的重放已由
  // 顶部的身份幂等 + 行上盖的关联键挡住。只有身份缺失（legacy daemon /
  // 第三方客户端）才启用下面的文本兜底。
  if (!opts?.identityKnown) {
    // 核心硬防线：若画布上最后一条用户提问文本与当前完全一致，且助手尚未产生回答，绝对禁止重复追加！
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const lastText = visibleUserText(
        lastUser.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '',
      );
      if (userTextsMatch(lastText, userText) && !lastAssistantHasAnswer(messages)) {
        return ensureWorkingAssistant(messages);
      }
    }
    const echoed = userMessageAlreadyOnCanvas(messages, userText, userTs);
    const hasAnswer = lastAssistantHasAnswer(messages);
    if (echoed && (!opts?.repeatAfterSettled || !hasAnswer)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.role !== 'user') continue;
        const curText = visibleUserText(
          message.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join(''),
        );
        if (userTextsMatch(curText, userText)) {
          if (message.ts == null || message.ts === 0) {
            const next = messages.slice();
            next[i] = { ...message, ts: userTs };
            return ensureWorkingAssistant(next);
          }
          return ensureWorkingAssistant(messages);
        }
      }
      return ensureWorkingAssistant(messages);
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
    const userTs = event.created_at && event.created_at > 0 ? event.created_at : Date.now();
    // 绝对下标是唯一身份：画布上（pinned 主机键/磁盘行）已经有这一行就说明这条提问
    // 已画过，绝不能再补一份。
    if (
      typeof event.source_index === 'number' &&
      next.some((message) => message.sourceIndex === event.source_index)
    ) {
      continue;
    }
    // 核心硬防线：若画布上最后一条用户提问文本与当前完全一致，且助手尚未产生回答，直接跳过
    const lastUser = [...next].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const lastText = visibleUserText(
        lastUser.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '',
      );
      if (userTextsMatch(lastText, visibleUserText(event.content)) && !lastAssistantHasAnswer(next)) {
        continue;
      }
    }
    if (userMessageAlreadyOnCanvas(next, event.content, userTs)) continue;
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
      ...(event.message_id ? { id: event.message_id } : {}),
      ...(event.client_input_id ? { clientInputId: event.client_input_id } : {}),
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
): T[] {
  const target = identifiedAssistantIndex(messages, targetId);
  if (target >= 0) {
    const merged = mergeTextIntoParts(messages[target]!.parts, content, replay, partId);
    if (!merged) return messages;
    const parts = replay ? merged : coalesceRoundParts(merged);
    const next = messages.slice();
    next[target] = { ...messages[target]!, parts };
    return next;
  }
  // 身份未命中：这帧属于画布上还没有的轮（新一轮 / 迟到尾流）→ 直接落到当前气泡。
  // 不再用「跨轮隔离」猜测拦截：帧身份由线协议（轮编号 + 游标）给出，未命中就是新的。
  if (messages.length === 0) {
    if (!content) return messages;
    return [{ role: 'assistant', parts: [{ kind: 'text', text: content }] } as unknown as T];
  }
  // 同一回合里可能有系统通知插在 assistant 之后；此时「最后一条」不是 assistant，
  // 但续写仍属于本轮回答，必须落回本轮气泡，绝不能新开一条（否则正文被劈成两半）。
  const owner = sameTurnAssistantIndex(messages);
  const base: T[] = owner >= 0
    ? messages
    : [...messages, { role: 'assistant', parts: [] } as unknown as T];
  const idx = owner >= 0 ? owner : base.length - 1;
  const merged = mergeTextIntoParts(base[idx]!.parts, content, replay, partId);
  if (!merged) return messages;
  const parts = replay ? merged : coalesceRoundParts(merged);
  const next = base.slice();
  next[idx] = { ...base[idx]!, parts };
  return next;
}

/** 解析线协议段身份 `{message_id}:{seq}:{kind}`（message_id 自身可能含 `:`）。 */
function parsePartId(id?: string): { seq: number; kind: string } | null {
  if (!id) return null;
  const segments = id.split(':');
  if (segments.length < 3) return null;
  const seq = Number(segments[segments.length - 2]);
  if (!Number.isFinite(seq)) return null;
  return { seq, kind: segments[segments.length - 1]! };
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
 * 增量落点：当前段内同类部件里找「同一个部件」，找不到就返回 -1（调用方开新段）。
 *
 * 绝不能用「所有同类部件拼接」当基线：跨部件基线算出的重放后缀会把别的段
 * 的字符接到这一段里，正文就会出现 jsonl 里根本不存在的拼接片段。
 *
 * 优先级：part_id 精确命中 → 同段序同类（磁盘投影与线协议的编号可能不同）→
 * 当前段内唯一的同类部件（同一个部件的两种编号形态）。
 */
function resolveDeltaPartIndex(parts: MsgPart[], kind: 'text' | 'reasoning', partId?: string): number {
  const start = currentSegmentStart(parts);
  const same: Array<{ part: MsgPart; index: number }> = [];
  for (let index = start; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.kind === kind) same.push({ part, index });
  }
  if (same.length === 0) return -1;
  // 无身份帧（legacy / 未盖戳）：沿用旧语义落到当前段内最后一条同类部件。
  if (!partId) return same[same.length - 1]!.index;
  const exact = same.find(({ part }) => (part as { id?: string }).id === partId);
  if (exact) return exact.index;
  const want = parsePartId(partId);
  if (want) {
    const bySeq = same.find(({ part }) => {
      const have = parsePartId((part as { id?: string }).id);
      return have !== null && have.seq === want.seq && have.kind === want.kind;
    });
    if (bySeq) return bySeq.index;
  }
  // 只有「尚未盖戳」的唯一同类部件才能被推断为同一段；已带别的段序就是另一段，
  // 绝不能把两个真实段落拼成一段（那正是“正文粘连/串段”的来源）。
  const only = same[0]!;
  return same.length === 1 && !(only.part as { id?: string }).id ? only.index : -1;
}

/** 合并一段正文增量；返回 null 表示重播去重后无新内容可落笔。
 *
 * 回放帧（replay=true）必须按 part 身份定向合并：
 * - 已画过的 part 再次回放（重连/刷新）：命中同一 part 后增量是既有文本的后缀 → 去重为空；
 * - 在途 part 的迟到尾段：只补上与已有部分不重叠的后缀；
 * - 帧声明了段身份但画布上没有这一段 → 它就是新的一段，直接追加；
 * - 未命中轮编号且末尾气泡属于另一轮（startNewPart）→ 另起部件，绝不跨轮粘连。
 */
function mergeTextIntoParts(parts: MsgPart[], content: string, replay: boolean, partId?: string): MsgPart[] | null {
  if (!content) return null;

  // 1. 直播流式输出（replay === false）：
  // 每一帧都是真实 LLM 实时增量 token，由后端 SSE 游标（AtomicU64 seq）保证单调性与不重发。
  // 绝对严禁执行任何子串包含去重（includes），直接就地追加！
  if (!replay) {
    const index = resolveDeltaPartIndex(parts, 'text', partId);
    if (index >= 0) {
      const next = parts.slice();
      const p = next[index] as { kind: 'text'; text: string; id?: string };
      const existing = (p.text || '').trim();
      const incoming = content.trim();
      // 关键防线：即使 replay 为 false（网络重连/未打序号），若整段长内容已完全存在，绝不重复翻倍追加
      if (incoming.length > 20 && (existing === incoming || existing.endsWith(incoming))) {
        return parts;
      }
      next[index] = { ...p, text: (p.text || '') + content, id: p.id ?? partId };
      return next;
    }
    return [...parts, { kind: 'text', text: content, ...(partId ? { id: partId } : {}) }];
  }

  // 2. 重放帧（replay === true）：
  const replaced = replaceTruncatedParts(parts, 'text', content);
  if (replaced) return replaced;

  const index = resolveDeltaPartIndex(parts, 'text', partId);
  if (index >= 0) {
    const existing = (parts[index] as { text: string }).text || '';
    const body = withoutDisplayTruncation(existing);
    // 空白增量（段落分隔的 "\n\n"）在已有正文里永远是“包含”关系，绝不能当幂等丢弃：
    // 丢了它列表/段落就会粘连（live 乱排、刷新才恢复的经典症状）。
    if (content.trim() && body.includes(content)) return null;
    if (content.startsWith(body)) {
      const next = parts.slice();
      next[index] = { kind: 'text', text: content, id: partId ?? (parts[index] as { id?: string }).id };
      return next;
    }
    const suffix = unpaintedReplaySuffix(existing, content);
    if (!suffix) return null;
    const next = parts.slice();
    next[index] = { kind: 'text', text: body + suffix, id: partId ?? (parts[index] as { id?: string }).id };
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
): T[] {
  const cleanContent = content.trim();
  if (!cleanContent) return messages;

  const target = identifiedAssistantIndex(messages, targetId);
  if (target >= 0) {
    const merged = mergeReasoningIntoParts(messages[target]!.parts, content, replay, partId);
    if (!merged) return messages;
    const parts = replay ? merged : coalesceRoundParts(merged);
    const next = messages.slice();
    next[target] = { ...messages[target]!, parts };
    return next;
  }
  // 身份未命中：同 paintAssistantText —— 未命中的帧就是画布上还没有的轮，直接落笔。
  const owner = sameTurnAssistantIndex(messages);
  const base: T[] = owner >= 0
    ? messages
    : [...messages, { role: 'assistant', parts: [] } as unknown as T];
  const idx = owner >= 0 ? owner : base.length - 1;
  const merged = mergeReasoningIntoParts(base[idx]!.parts, content, replay, partId);
  if (!merged) return messages;
  const parts = replay ? merged : coalesceRoundParts(merged);
  const next = base.slice();
  next[idx] = { ...base[idx]!, parts };
  return next;
}

/** 合并一段思考增量；返回 null 表示重播去重后无新内容可落笔。
 *
 * 落点与正文同一口径（[`resolveDeltaPartIndex`]）：只往「同一个思考部件」写，
 * 找不到就是新部件，绝不拿别的思考段当基线去算后缀。
 */
function mergeReasoningIntoParts(parts: MsgPart[], content: string, replay: boolean, partId?: string): MsgPart[] | null {
  const cleanContent = content.trim();
  if (!cleanContent) return null;

  const existingIdx = resolveDeltaPartIndex(parts, 'reasoning', partId);

  // 1. 直播流式输出（replay === false）：
  // 思考增量直接并入当前思考部件，绝不能对思考文本做子串去重！
  if (!replay) {
    if (existingIdx >= 0) {
      const next = parts.slice();
      const p = next[existingIdx] as { kind: 'reasoning'; text: string; id?: string };
      next[existingIdx] = { ...p, text: (p.text || '') + content, id: p.id ?? partId };
      return next;
    }
    return appendReasoningPart(parts, content, partId);
  }

  // 2. 重放帧（replay === true）：
  const replaced = replaceTruncatedParts(parts, 'reasoning', content);
  if (replaced) {
    return replaced === parts ? null : replaced;
  }

  if (existingIdx >= 0) {
    const p = parts[existingIdx] as { kind: 'reasoning'; text: string; id?: string };
    const existing = (p.text || '').trim();
    // 已有思考已包含该重放内容 → 幂等丢弃
    if (existing === cleanContent || existing.includes(cleanContent)) {
      return null;
    }
    // 新内容是已有思考的延伸（累积帧）→ 原地更新！
    if (cleanContent.startsWith(existing)) {
      const nextParts = parts.slice();
      nextParts[existingIdx] = { ...p, text: content, id: p.id ?? partId };
      return nextParts;
    }
    // 未画过的增量后缀 → 原地追加到该思考部件尾部！
    const suffix = unpaintedReplaySuffix(p.text || '', content);
    if (!suffix) return null;
    const nextParts = parts.slice();
    nextParts[existingIdx] = { ...p, text: (p.text || '') + suffix, id: p.id ?? partId };
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
  if (incoming === body) {
    const next = parts.slice();
    next[index] = { kind, text: body };
    return next;
  }
  const next = parts.slice();
  next[index] = { kind, text: incoming };
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
 * 将非致命黄色通知（如上下文压缩、系统提示、重连告警）作为独立的 notice 部件
 * 严格按顺序追加到当前助手的部件流中（即使末尾尚未生成 assistant，也会安全开启一个容器）。
 */
export function paintAssistantNotice<T extends ProjectionMessage>(
  messages: T[],
  text: string,
  targetId?: string,
): T[] {
  if (!text) return messages;
  if (messages.length === 0) {
    return [{ role: 'assistant', parts: [{ kind: 'notice', text }] } as unknown as T];
  }
  // 重放幂等：同一条提示已经在目标行 / 末尾行出现过 → 断线重连重发的回放帧不得再叠一份。
  // （文本/工具帧有后缀去重、用户气泡有身份去重，只有 notice 一直缺这一层，
  //   表现为同一段黄色提示被重连重发的回放帧叠成多份并落到尾部。）
  const hasNotice = (message: ProjectionMessage | undefined): boolean =>
    !!message && message.parts.some((part) => part.kind === 'notice' && part.text === text);
  if (targetId) {
    const target = messages.findIndex((m) => m.role === 'assistant' && m.id === targetId);
    if (target >= 0) {
      const existing = messages[target]!;
      if (hasNotice(existing)) return messages;
      const next = messages.slice();
      next[target] = {
        ...existing,
        parts: [...existing.parts, { kind: 'notice', text }],
      };
      return next;
    }
    // 失败回合还没有 assistant 行：提示属于它自己的提问，必须留在该提问下面，
    // 而不是挂到上一轮回答的底部或下一条 loop 下面。复用/插入一个“只装提示”的
    // assistant 行（空 Working 占位也可复用）。
    const user = messages.findIndex((m) => m.role === 'user' && m.id === targetId);
    if (user >= 0) {
      const nextRow = messages[user + 1];
      const reusable =
        !!nextRow && nextRow.role === 'assistant' && nextRow.parts.every((part) => part.kind === 'notice');
      if (reusable) {
        if (hasNotice(nextRow)) return messages;
        const next = messages.slice();
        next[user + 1] = { ...nextRow, parts: [...nextRow.parts, { kind: 'notice', text }] };
        return next;
      }
      const next = messages.slice();
      const userMsg = messages[user];
      const inheritedSrc = typeof userMsg?.sourceIndex === 'number' ? userMsg.sourceIndex + 1 : undefined;
      next.splice(user + 1, 0, {
        role: 'assistant',
        parts: [{ kind: 'notice', text }],
        sourceIndex: inheritedSrc,
      } as unknown as T);
      return next;
    }
  }
  const last = messages[messages.length - 1]!;
  if (last.role === 'assistant') {
    if (hasNotice(last)) return messages;
    const next = messages.slice();
    next[next.length - 1] = {
      ...last,
      parts: [...last.parts, { kind: 'notice', text }],
    };
    return next;
  }
  const lastMsg = messages[messages.length - 1];
  const lastSrc = typeof lastMsg?.sourceIndex === 'number' ? lastMsg.sourceIndex + 1 : undefined;
  return [
    ...messages,
    {
      role: 'assistant',
      parts: [{ kind: 'notice', text }],
      sourceIndex: lastSrc,
    } as unknown as T,
  ];
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

/** 本地通知行（命令输出 / 压缩标记）在画布中的插入位置：钉在创建时的锚点之后。 */
function localNoticeInsertIndex<T extends { id?: string; sourceIndex?: number }>(
  rows: T[],
  notice: { anchorId?: string; anchorSourceIndex?: number },
): number {
  if (notice.anchorId) {
    const anchored = rows.findIndex((row) => row.id === notice.anchorId);
    if (anchored >= 0) return anchored + 1;
  }
  if (typeof notice.anchorSourceIndex === 'number') {
    const next = rows.findIndex(
      (row) => typeof row.sourceIndex === 'number' && row.sourceIndex > notice.anchorSourceIndex!,
    );
    return next >= 0 ? next : rows.length;
  }
  return rows.length;
}

/** 权威切片里已出现过的身份（行 id / part id / 工具 call id / 内容键）。 */
interface TailIdentity {
  ids: Set<string>;
  partIds: Set<string>;
  toolIds: Set<string>;
  contentKeys: Set<string>;
}

function collectTailIdentity<T extends { sourceIndex?: number; id?: string }>(rows: T[]): TailIdentity {
  const identity: TailIdentity = {
    ids: new Set<string>(),
    partIds: new Set<string>(),
    toolIds: new Set<string>(),
    contentKeys: new Set<string>(),
  };
  for (const row of rows) {
    if (row.id) identity.ids.add(row.id);
    const parts = (row as { parts?: MsgPart[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.kind === 'tool') {
        if (part.tool?.id) {
          identity.toolIds.add(part.tool.id);
          identity.contentKeys.add(`tool:${part.tool.id}`);
        }
        continue;
      }
      if ((part.kind === 'text' || part.kind === 'reasoning')) {
        if (part.id) identity.partIds.add(part.id);
        const t = (part.text || '').trim();
        if (t.length > 0) {
          // 纯内容键：即使旧版本或直播行没盖 part id，也能按内容指纹拦截倒灌
          identity.contentKeys.add(`${part.kind}:${t.slice(0, 160)}`);
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
function pruneDuplicatedTailContent<T extends { sourceIndex?: number; id?: string }>(
  row: T,
  identity: TailIdentity,
): T | null {
  if (row.id && identity.ids.has(row.id)) return null;
  const parts = (row as { parts?: MsgPart[] }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return row;
  const kept = parts.filter((part) => {
    if (part.kind === 'tool') {
      if (part.tool?.id && (identity.toolIds.has(part.tool.id) || identity.contentKeys.has(`tool:${part.tool.id}`))) {
        return false;
      }
      return true;
    }
    if (part.kind === 'text' || part.kind === 'reasoning') {
      if (part.id && identity.partIds.has(part.id)) return false;
      const t = (part.text || '').trim();
      if (t.length > 0 && identity.contentKeys.has(`${part.kind}:${t.slice(0, 160)}`)) {
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
    isSteer?: boolean;
    role?: string;
    anchorId?: string;
    anchorSourceIndex?: number;
  },
>(
  canvas: T[],
  diskTail: T[],
  diskOffset: number,
): T[] {
  if (!canvas || canvas.length === 0) return diskTail;
  if (!diskTail || diskTail.length === 0) return canvas;
  if (diskOffset <= 0) return diskTail;

  const canvasById = new Map<string, T>();
  for (const row of canvas) {
    if (row.id) canvasById.set(row.id, row);
  }

  // 权威行替换画布行时，把本地 UI 部件（通知 / 限流）接回同一条消息。
  const withLocalParts = (row: T): T => withLocalOnlyParts(row, canvasById);

  const actualTail: T[] = [];
  const pinnedInTail: T[] = [];
  for (const message of diskTail) {
    if (typeof message.sourceIndex === 'number' && message.sourceIndex < diskOffset) {
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
  // 带锚点的本地通知行（命令输出 / 压缩标记）：它们不属于直播尾巴，创建时就钉在
  // 某一轮之后。必须按锚点归位，否则会被当成“未落盘尾巴”拖到会话末尾，
  // 表现为每一轮的尾都已带着它（与先前黄色通知堆叠同一类问题）。
  const anchoredNotices: T[] = [];
  let currentTurnSourceIndex: number | undefined = undefined;

  for (const message of canvas) {
    const anchored =
      message.role === 'system' || message.anchorId !== undefined || message.anchorSourceIndex !== undefined;
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
    }
    const insideWindow =
      typeof currentTurnSourceIndex === 'number' && currentTurnSourceIndex >= diskOffset;
    // 若整行既无 sourceIndex，也无任何前驱轮次下标支撑，跳过
    if (typeof currentTurnSourceIndex !== 'number' && typeof message.sourceIndex !== 'number') {
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
      // 没有可信下标的本地尾巴（直播行 / steer）落在了窗口之后：
      // 它们是唯一副本，保留并固定在权威尾部之后。
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

  const baseHead = olderHead.length > 0 ? olderHead : pinnedInTail;
  const combined = [...baseHead, ...actualTail];

  // 拓扑平滑时序权重：有绝对 sourceIndex 则使用其真实值；无 sourceIndex 的行
  // 继承其前驱行的时序权重（+0.01），严格保留其在原始轮次中的相对位置，
  // 杜绝因无 sourceIndex 被当作 Infinity 导致上一轮的黄色通知被无脑拖拽堆叠至全会话末尾！
  const sortWeights = new Map<T, number>();
  let runningWeight = 0;
  for (const m of combined) {
    // 同样只认真正的转录下标：steer 的本地猜值既不能参与窗口判定，也不能参与排序。
    const trusted =
      typeof m.sourceIndex === 'number' && m.isSteer !== true ? m.sourceIndex : undefined;
    if (typeof trusted === 'number') {
      runningWeight = trusted;
      sortWeights.set(m, runningWeight);
    } else {
      runningWeight += 0.01;
      sortWeights.set(m, runningWeight);
    }
  }

  combined.sort((a, b) => {
    const aW = sortWeights.get(a) ?? (typeof a.sourceIndex === 'number' ? a.sourceIndex : Infinity);
    const bW = sortWeights.get(b) ?? (typeof b.sourceIndex === 'number' ? b.sourceIndex : Infinity);
    return aW - bW;
  });

  const seenIds = new Set<string>();
  const seenSrc = new Set<number>();
  const result: T[] = [];
  for (const m of combined) {
    if (m.id && seenIds.has(m.id)) continue;
    if (typeof m.sourceIndex === 'number' && seenSrc.has(m.sourceIndex)) continue;
    if (m.id) seenIds.add(m.id);
    if (typeof m.sourceIndex === 'number') seenSrc.add(m.sourceIndex);
    result.push(m);
  }
  // 未落盘的本地尾巴固定在最后：它们是当前这一轮最新的内容。
  for (const m of overlayTail) {
    if (m.id && seenIds.has(m.id)) continue;
    if (m.id) seenIds.add(m.id);
    result.push(m);
  }
  // 本地通知行按创建时的锚点归位（压缩标记冻结在发生压缩的那一轮尾部）。
  // 同一锚点有多条时保持它们在画布上的先后顺序。
  //
  // 没有锚点的旧缓存通知行（升级前写入 IndexedDB 的“已请求停止…”等临时提示）
  // 不属于任何一轮：以前它们被当成“未落盘尾巴”逐轮拖到会话末尾。这类行是
  // 瞬态提示而非历史，直接丢弃，避免旧噪声永久贴在底部。
  const byInsertIndex = new Map<number, T[]>();
  for (const notice of anchoredNotices) {
    if (notice.anchorId === undefined && notice.anchorSourceIndex === undefined) continue;
    if (notice.id && seenIds.has(notice.id)) continue;
    if (notice.id) seenIds.add(notice.id);
    const at = localNoticeInsertIndex(result, notice);
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
 * 清理画布与缓存中的重复与脏节点：
 * 1. 过滤掉连续相邻、完全相同的 User 提问气泡；
 * 2. 如果存在连续的 User 消息（中间只有空 assistant 或无 assistant），且内容重复，折叠为单一提问；
 * 3. 清理掉夹在连续重复提问之间的无用空 assistant 占位符；
 * 4. 确保从 IndexedDB 或历史缓存加载出来的画布是纯净无污染的。
 */
export function sanitizeCanvasMessages<
  T extends {
    role: string;
    parts?: MsgPart[];
    sourceIndex?: number;
    anchorId?: string;
    anchorSourceIndex?: number;
  },
>(messages: T[]): T[] {
  if (!messages || messages.length <= 1) return messages;
  const result: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i]!;
    // 无锚点的本地通知行是升级前缓存的瞬态提示（如“已请求停止当前回合”），
    // 不属于任何一轮；新代码创建时都会盖锚点，这类残留直接丢弃，
    // 否则旧实现会把它逐轮拖到会话末尾，永不消失。
    if (
      cur.role === 'system' &&
      cur.anchorId === undefined &&
      cur.anchorSourceIndex === undefined
    ) {
      continue;
    }
    // 1. 如果当前是空助手气泡，且前一个已经是助手气泡，丢弃多余的空助手
    if (cur.role === 'assistant' && (!cur.parts || cur.parts.length === 0)) {
      const prev = result[result.length - 1];
      if (prev && prev.role === 'assistant') {
        continue;
      }
    }
    // 2. 如果当前是用户提问，检查前一个提问是否完全一样且中间无实质回复
    if (cur.role === 'user') {
      const curText = visibleUserText(
        cur.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '',
      );
      const curImages = (cur as any).images;
      const hasCurImages = Array.isArray(curImages) && curImages.length > 0;
      // 防呆：既无可见文本也无图片附件的空用户气泡直接剔除
      if (!curText && !hasCurImages) {
        continue;
      }
      let prevUser: T | null = null;
      let hasMeaningfulAssistant = false;
      for (let j = result.length - 1; j >= 0; j--) {
        const prev = result[j]!;
        if (prev.role === 'user') {
          prevUser = prev;
          break;
        }
        if (prev.role === 'assistant') {
          if (
            prev.parts &&
            prev.parts.some(
              (p) =>
                (p.kind === 'text' && (p.text || '').trim()) ||
                p.kind === 'tool' ||
                p.kind === 'reasoning' ||
                p.kind === 'notice',
            )
          ) {
            hasMeaningfulAssistant = true;
          }
        }
      }
      if (prevUser && !hasMeaningfulAssistant) {
        const prevText = visibleUserText(
          prevUser.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '',
        );
        // 两条都是落盘历史且绝对下标不同 → 用户确实连发了同一句话，必须保留。
        // 只有同一行（同下标）或身份未知的旧缓存/乐观回显才折叠。
        const sameAbsoluteRow =
          typeof prevUser.sourceIndex === 'number' &&
          typeof cur.sourceIndex === 'number' &&
          prevUser.sourceIndex === cur.sourceIndex;
        const identityUnknown =
          typeof prevUser.sourceIndex !== 'number' || typeof cur.sourceIndex !== 'number';
        if ((sameAbsoluteRow || identityUnknown) && userTextsMatch(prevText, curText)) {
          // 清除上一个重复提问留下的空助手（如果有的话）
          while (result.length > 0) {
            const tail = result[result.length - 1];
            if (tail && tail.role === 'assistant' && (!tail.parts || tail.parts.length === 0)) {
              result.pop();
            } else {
              break;
            }
          }
          continue;
        }
      }
    }
    result.push(cur);
  }
  return result;
}

function sameImages(
  a?: unknown[],
  b?: unknown[],
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((img: any, i) => img?.media_type === (right[i] as any)?.media_type && img?.data === (right[i] as any)?.data);
}

/**
 * 旧缓存 / 回放恢复出来的提问行既没有 id 也没有 sourceIndex：
 * 用「文本 + 时间戳（≤ 3s，缺失时间戳则保守视为同一行）」或「图片指纹 + 时间戳」判断是不是同一条提问。
 */
export function sameUserRow(
  a: { role?: string; parts?: MsgPart[]; ts?: number; images?: unknown[] },
  b: { role?: string; parts?: MsgPart[]; ts?: number; images?: unknown[] },
): boolean {
  if (a.role !== 'user' || b.role !== 'user') return false;
  const textOf = (message: { parts?: MsgPart[] }): string =>
    visibleUserText(
      (message.parts ?? [])
        .filter((part) => part.kind === 'text')
        .map((part) => part.text || '')
        .join(''),
    );
  const left = textOf(a);
  const right = textOf(b);
  const hasText = !!left && !!right;
  const hasImages =
    Array.isArray((a as any).images) &&
    (a as any).images.length > 0 &&
    Array.isArray((b as any).images) &&
    (b as any).images.length > 0;

  if (hasText) {
    if (!userTextsMatch(left, right)) return false;
  } else if (hasImages) {
    if (!sameImages((a as any).images, (b as any).images)) return false;
  } else {
    return false;
  }

  if (a.ts && b.ts) return Math.abs(a.ts - b.ts) <= 3000;
  return true;
}

/**
 * 往前补页时，首屏钉住的那条提问可能已经在画布上。
 * 合并更早历史与现有画布时：
 * 1. 按 id 和 sourceIndex 严格去重，避免重复渲染；
 * 2. 保证所有具备 sourceIndex 的历史消息严格按照服务端绝对索引升序排列；
 *    彻底防止因首屏 pinned 置顶提问在向前翻页拼接时被挤到后续工具调用下方的倒插 BUG！
 * 3. 无 sourceIndex 的在途实时消息保持在末尾原有相对顺序。
 */
export function mergeOlderMessages<
  T extends { id?: string; sourceIndex?: number; role?: string; parts?: MsgPart[]; ts?: number },
>(prev: T[], older: T[]): T[] {
  if (!older || older.length === 0) return prev;
  if (!prev || prev.length === 0) return older;

  const indexedPrev = prev.filter(
    (m): m is T & { sourceIndex: number } => typeof m.sourceIndex === 'number',
  );
  const prevIsSorted = indexedPrev.every(
    (m, i) => i === 0 || m.sourceIndex >= indexedPrev[i - 1]!.sourceIndex,
  );
  if (!prevIsSorted) {
    // Dirty/legacy canvas: keep the deterministic full sort. Index-less rows go
    // last here on purpose; the ordered path below is the normal case.
    return mergeOlderMessagesSorted(prev, older);
  }

  // Ordered path: INSERT older rows into prev instead of re-sorting everything.
  // Re-sorting used to move index-less rows (older L1/L2 caches written before
  // absolute indices existed) to the very end, so the first question appeared
  // below later answers. Insertion preserves every existing row's position;
  // only the newly loaded rows move into their chronological slot.
  const result = prev.slice();
  const seenIds = new Set<string>();
  const seenIndices = new Set<number>();
  for (const m of result) {
    if (m.id) seenIds.add(m.id);
    if (typeof m.sourceIndex === 'number') seenIndices.add(m.sourceIndex);
  }

  for (const m of older) {
    if (m.id && seenIds.has(m.id)) continue;
    if (typeof m.sourceIndex === 'number' && seenIndices.has(m.sourceIndex)) continue;
    // 兼容旧缓存 / 回放恢复出来的行：既无 id 又无绝对下标时，用「文本 + 时间戳」
    // 与更早历史对账。否则同一条提问会被当成新消息重复插入。
    if (m.role === 'user') {
      if (
        !m.id &&
        typeof m.sourceIndex !== 'number' &&
        result.some((candidate) => sameUserRow(candidate, m))
      ) {
        continue;
      }
      // 反向对账：画布上已有的无下标旧行若与这条权威提问是同一句，删掉旧行，
      // 让带绝对下标的版本入座（否则旧行会留在原位形成重复气泡）。
      if (m.id || typeof m.sourceIndex === 'number') {
        for (let i = result.length - 1; i >= 0; i--) {
          const candidate = result[i]!;
          if (
            candidate.role === 'user' &&
            !candidate.id &&
            typeof candidate.sourceIndex !== 'number' &&
            sameUserRow(candidate, m)
          ) {
            result.splice(i, 1);
          }
        }
      }
    }

    let insertAt: number;
    if (typeof m.sourceIndex === 'number') {
      insertAt = result.findIndex(
        (candidate) =>
          typeof candidate.sourceIndex === 'number' && candidate.sourceIndex > m.sourceIndex!,
      );
      if (insertAt < 0) {
        // No greater indexed row: insert after the last indexed row but BEFORE
        // the trailing index-less live rows (streaming assistant, optimistic user).
        insertAt = result.length;
        while (insertAt > 0 && typeof result[insertAt - 1]!.sourceIndex !== 'number') {
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
    if (typeof m.sourceIndex === 'number') seenIndices.add(m.sourceIndex);
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
  cachedMessages: Array<{ sourceIndex?: number }> | undefined,
  diskOffset: number,
): boolean {
  if (!cachedMessages || cachedMessages.length === 0) return false;
  const indices = Array.from(
    new Set(
      cachedMessages
        .map((message) => message.sourceIndex)
        .filter((index): index is number => typeof index === 'number'),
    ),
  ).sort((a, b) => a - b);
  if (indices.length === 0) return false;

  // A cached HEAD + the authoritative TAIL with a missing middle used to pass
  // the max-only check. "Load older" walks BACKWARD from the cached head, so
  // that hole would never be filled. Display lists can legitimately skip a few
  // filtered internal rows, but a missing page is tens of raw rows; reject a
  // gap larger than half a display page.
  const MAX_INTERNAL_GAP = 24;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! - indices[i - 1]! - 1 > MAX_INTERNAL_GAP) return false;
  }
  return indices[indices.length - 1]! >= diskOffset - 1;
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

/** Legacy fallback for a dirty (non-ascending) canvas: stable full sort. */
function mergeOlderMessagesSorted<
  T extends { id?: string; sourceIndex?: number; role?: string; parts?: MsgPart[]; ts?: number },
>(prev: T[], older: T[]): T[] {
  const seenIds = new Set<string>();
  const seenIndices = new Set<number>();
  const merged: T[] = [];
  for (const m of older) {
    if (m.id) seenIds.add(m.id);
    if (typeof m.sourceIndex === 'number') seenIndices.add(m.sourceIndex);
    merged.push(m);
  }
  for (const m of prev) {
    if (m.id && seenIds.has(m.id)) continue;
    if (typeof m.sourceIndex === 'number' && seenIndices.has(m.sourceIndex)) continue;
    if (
      m.role === 'user' &&
      !m.id &&
      typeof m.sourceIndex !== 'number' &&
      merged.some((candidate) => sameUserRow(candidate, m))
    ) {
      continue;
    }
    if (m.id) seenIds.add(m.id);
    if (typeof m.sourceIndex === 'number') seenIndices.add(m.sourceIndex);
    merged.push(m);
  }
  const indexed = merged.map((item, originalIdx) => ({ item, originalIdx }));
  indexed.sort((a, b) => {
    const aIdx = typeof a.item.sourceIndex === 'number' ? a.item.sourceIndex : null;
    const bIdx = typeof b.item.sourceIndex === 'number' ? b.item.sourceIndex : null;
    if (aIdx !== null && bIdx !== null) {
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.originalIdx - b.originalIdx;
    }
    if (aIdx !== null && bIdx === null) return -1;
    if (aIdx === null && bIdx !== null) return 1;
    return a.originalIdx - b.originalIdx;
  });
  return indexed.map((x) => x.item);
}
