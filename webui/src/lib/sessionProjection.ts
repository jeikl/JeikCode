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
import {
  DISPLAY_TRUNCATION_MARK,
  reconcileRunningTranscript,
  transcriptHasOpenUserTurn,
  unpaintedReplaySuffix,
  userMessageAlreadyOnCanvas,
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
export function paintUserMessage<T extends ProjectionMessage>(
  messages: T[],
  rawText: string,
  userTs: number,
  create: (base: T[]) => T,
  opts?: { repeatAfterSettled?: boolean },
): T[] {
  const userText = visibleUserText(rawText);
  const echoed = userMessageAlreadyOnCanvas(messages, userText, userTs);
  const open = transcriptHasOpenUserTurn(messages);
  // 关键防线：若非明确声明 repeatAfterSettled（如跨标签页/observer 看到完全结算后的新输入），
  // 当画布上已经拥有完全相同内容的 user 消息时（无论处于第一轮还是中途 steer 轮次），
  // 绝对坚决不再追加任何新气泡！
  const alreadyHasUserText = messages.some((m) => {
    if (m.role !== 'user') return false;
    const t = visibleUserText(
      m.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join(''),
    );
    const cleanT = t.trim();
    const cleanUser = userText.trim();
    return cleanT === cleanUser || cleanUser.startsWith(cleanT) || cleanT.startsWith(cleanUser);
  });
  if ((echoed || alreadyHasUserText) && (open || !opts?.repeatAfterSettled)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== 'user') continue;
      const curText = visibleUserText(
        message.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join(''),
      );
      const cleanCur = curText.trim();
      const cleanUser = userText.trim();
      if (cleanCur === cleanUser || cleanUser.startsWith(cleanCur) || cleanCur.startsWith(cleanUser)) {
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

export function paintAssistantText<T extends ProjectionMessage>(
  messages: T[],
  content: string,
  replay: boolean,
): T[] {
  if (messages.length === 0) {
    if (!content) return messages;
    return [{ role: 'assistant', parts: [{ kind: 'text', text: content }] } as unknown as T];
  }
  let last = messages[messages.length - 1]!;
  let base = messages;
  if (last.role !== 'assistant') {
    last = { role: 'assistant', parts: [] } as unknown as T;
    base = [...messages, last];
  }
  let delta = content;
  if (replay) {
    const replaced = replaceTruncatedParts(last.parts, 'text', content);
    if (replaced) {
      return [...base.slice(0, -1), { ...last, parts: replaced }];
    }
    // 全局正文去重：若画布上已有任意 assistant 完整包含该正文，回放中直接忽略
    const cleanContent = content.trim();
    if (cleanContent) {
      for (const m of messages) {
        if (m.role !== 'assistant' || !m.parts) continue;
        const full = m.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join('').trim();
        if (full === cleanContent || (full.length >= cleanContent.length && full.includes(cleanContent))) {
          return messages;
        }
      }
    }
    const painted = last.parts.map((part) => (part.kind === 'text' ? part.text || '' : '')).join('');
    delta = unpaintedReplaySuffix(painted, content);
    if (!delta) return messages;
  }
  const parts = last.parts.slice();
  const tail = parts[parts.length - 1];
  if (tail && tail.kind === 'text') {
    let next = tail.text + delta;
    if (
      tail.text &&
      content &&
      !tail.text.endsWith('\n') &&
      /(?:\.\.\.|…|。)\s*$/.test(tail.text) &&
      /^(正在|Currently |Now )/.test(delta)
    ) {
      next = `${tail.text}\n${delta}`;
    }
    parts[parts.length - 1] = { kind: 'text', text: next };
  } else {
    // 关键防线：若当前 assistant 内部已经有 text part，合入到最后一个 text part，
    // 坚决杜绝因中间插入思考块或工具导致正文被拆成碎片！
    const lastTextIdx = parts.map((p) => p.kind).lastIndexOf('text');
    if (lastTextIdx >= 0) {
      const p = parts[lastTextIdx]!;
      const prevText = p.kind === 'text' ? p.text : '';
      parts[lastTextIdx] = { kind: 'text', text: prevText + delta };
    } else {
      parts.push({ kind: 'text', text: delta });
    }
  }
  return [...base.slice(0, -1), { ...last, parts }];
}

export function paintAssistantReasoning<T extends ProjectionMessage>(
  messages: T[],
  content: string,
  replay: boolean,
): T[] {
  const cleanContent = content.trim();
  if (!cleanContent) return messages;

  // 关键防线 1（全局思考去重）：如果画布上任意一个 assistant 已经包含该思考文本，
  // 无论是来自当前轮次的前半段（Steer 前）还是之前的回放，绝对不重复追加！
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi]!;
    if (m.role !== 'assistant' || !m.parts) continue;
    for (let pi = 0; pi < m.parts.length; pi++) {
      const p = m.parts[pi]!;
      if (p.kind === 'reasoning' && p.text) {
        const cleanExisting = p.text.trim();
        if (cleanExisting === cleanContent || cleanExisting.includes(cleanContent)) {
          return messages;
        }
        if (replay && cleanContent.startsWith(cleanExisting)) {
          const nextParts = m.parts.slice();
          nextParts[pi] = { ...p, text: content };
          const nextMessages = messages.slice();
          nextMessages[mi] = { ...m, parts: nextParts };
          return nextMessages;
        }
      }
    }
  }

  let last = messages[messages.length - 1];
  let base = messages;
  if (!last || last.role !== 'assistant') {
    last = { role: 'assistant', parts: [] } as unknown as T;
    base = [...messages, last];
  }
  if (replay) {
    const replaced = replaceTruncatedParts(last.parts, 'reasoning', content);
    if (replaced) {
      if (replaced === last.parts) return messages;
      return [...base.slice(0, -1), { ...last, parts: replaced }];
    }
    for (let i = 0; i < last.parts.length; i++) {
      const p = last.parts[i];
      if (p.kind === 'reasoning' && p.text) {
        const cleanExisting = p.text.trim();
        if (cleanExisting === cleanContent || cleanExisting.includes(cleanContent)) {
          return messages;
        }
        if (cleanContent.startsWith(cleanExisting)) {
          const nextParts = last.parts.slice();
          nextParts[i] = { ...p, text: content };
          return [...base.slice(0, -1), { ...last, parts: nextParts }];
        }
      }
    }
  }
  const painted = last.parts.map((part) => (part.kind === 'reasoning' ? part.text || '' : '')).join('');
  const delta = replay ? unpaintedReplaySuffix(painted, content) : content;
  if (!delta) return messages;
  return [...base.slice(0, -1), { ...last, parts: appendReasoningPart(last.parts, delta) }];
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
