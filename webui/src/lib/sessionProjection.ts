/**
 * Session canvas projection.
 *
 * Stable message/part ids from the daemon select streamed segments. Older
 * snapshots without those ids retain the existing positional replay path.
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
  id?: string;
  ts?: number;
  /** Raw history index is authoritative only until another live round folds in. */
  sourceIndex?: number;
}

export interface SessionSurface<T> {
  messages: T[];
  todos: TodoItem[] | null;
  appliedTodoIds: string[];
}

/** Canonical GET/snapshot shape: aggregated reasoning/text precede tool rows.
 * Part identities are learned from exact wire replay, not invented from fields. */
export function hydrateCanonicalAssistantParts(
  message: { id?: string; reasoning?: string; content?: string },
  trailingParts?: readonly MsgPart[],
): MsgPart[] {
  const parts: MsgPart[] = [];
  if (message.reasoning) parts.push({ kind: 'reasoning', text: message.reasoning });
  if (message.content) parts.push({ kind: 'text', text: message.content });
  if (message.id) {
    for (const part of parts) {
      if (part.kind === 'text' || part.kind === 'reasoning') part.messageId = message.id;
    }
  }
  if (trailingParts) {
    for (const part of trailingParts) parts.push(part);
  }
  return parts;
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
function lastAssistantHasAnswer<T extends ProjectionMessage>(messages: T[]): boolean {
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
  opts?: { repeatAfterSettled?: boolean; messageId?: string },
): T[] {
  const userText = visibleUserText(rawText);
  const echoed = opts?.messageId
    ? messages.some((message) => message.role === 'user' && message.id === opts.messageId)
    : userMessageAlreadyOnCanvas(messages, userText, userTs);
  const hasAnswer = lastAssistantHasAnswer(messages);
  if (echoed && (opts?.messageId || !opts?.repeatAfterSettled || !hasAnswer)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== 'user') continue;
      const curText = visibleUserText(
        message.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join(''),
      );
      if (opts?.messageId ? message.id === opts.messageId : userTextsMatch(curText, userText)) {
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
    parts.push({ kind: 'text', text: delta });
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

/** Keep wire parts distinct across model rounds while retaining folded bubbles.
 * Replay updates exact parts; an absent historical target never borrows a tail.
 * Admission is explicit producer authority, independent of suffix deduplication. */
export function paintAssistantDelta<T extends ProjectionMessage>(
  messages: T[],
  kind: 'text' | 'reasoning',
  content: string,
  replay: boolean,
  identity?: {
    messageId?: string;
    partId?: string;
    partSeq?: number;
    /** True only for a newly admitted live round, never inferred from replay. */
    allowNewRound?: boolean;
    /** Exact replay user cursor may claim its own empty, unowned placeholder. */
    admitToUserMessageId?: string;
  },
): T[] {
  if (!identity?.messageId && !identity?.partId) {
    return kind === 'text'
      ? paintAssistantText(messages, content, replay)
      : paintAssistantReasoning(messages, content, replay);
  }
  if (!content) return messages;
  let index = messages.findIndex((message) => message.role === 'assistant' && (
    (identity.partId && message.parts.some((part) =>
      part.kind === kind && part.id === identity.partId))
    || (identity.messageId && (message.id === identity.messageId || message.parts.some((part) =>
      (part.kind === 'text' || part.kind === 'reasoning') && part.messageId === identity.messageId)))));
  const admitting = index < 0;
  let base = messages;
  if (admitting) {
    if (identity.allowNewRound === true) {
      index = messages.length - 1;
      if (index < 0 || messages[index].role !== 'assistant') {
        index = messages.length;
        base = [...messages, { role: 'assistant', parts: [] } as unknown as T];
      }
    } else if (identity.admitToUserMessageId) {
      const userIndex = messages.findIndex((message) =>
        message.role === 'user' && message.id === identity.admitToUserMessageId);
      const placeholder = userIndex >= 0 ? messages[userIndex + 1] : undefined;
      if (!placeholder || placeholder.role !== 'assistant' || placeholder.id || placeholder.parts.length) {
        return messages;
      }
      index = userIndex + 1;
    } else {
      return messages;
    }
  }
  const message = base[index];
  const exactMessage = !!identity.messageId && (message.id === identity.messageId || message.parts.some((part) =>
    (part.kind === 'text' || part.kind === 'reasoning') && part.messageId === identity.messageId));
  let partIndex = identity.partId ? message.parts.findIndex((part) =>
    part.kind === kind && part.id === identity.partId) : -1;
  if (partIndex < 0 && exactMessage) {
    // Canonical fields have no wire ids. Only one same-kind candidate is
    // unambiguous, even when a text/tool tail follows the earlier reasoning.
    let candidate = -1;
    let count = 0;
    let hasAnonymous = false;
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (part.kind !== kind || (part.messageId && part.messageId !== identity.messageId)) continue;
      count++;
      candidate = i;
      if (!part.id) hasAnonymous = true;
    }
    const canonical = candidate >= 0 ? message.parts[candidate] : undefined;
    if (count === 1 && canonical?.kind === kind && !canonical.id) {
      partIndex = candidate;
    } else if (replay && hasAnonymous) {
      return messages;
    } else if (!identity.partId) {
      const tail = message.parts[message.parts.length - 1];
      if (tail?.kind === kind && (!tail.messageId || tail.messageId === identity.messageId)) {
        partIndex = message.parts.length - 1;
      }
    }
  }
  const part = partIndex >= 0 ? message.parts[partIndex] : undefined;
  const previous = part?.kind === kind ? part.text : '';
  const delta = replay ? unpaintedReplaySuffix(withoutDisplayTruncation(previous), content) : content;
  const text = replay && previous.endsWith(DISPLAY_TRUNCATION_MARK) && content.startsWith(withoutDisplayTruncation(previous))
    ? content : previous + delta;
  const stamped: Extract<MsgPart, { kind: 'text' | 'reasoning' }> = { kind, text,
    id: identity.partId ?? (part?.kind === kind ? part.id : undefined),
    seq: identity.partSeq ?? (part?.kind === kind ? part.seq : undefined) };
  if (identity.messageId) stamped.messageId = identity.messageId;
  // Exact-part reconciliation cannot retarget final-round actions, even if
  // that earlier round owns the last visible text part in a folded bubble.
  const id = admitting ? identity.messageId ?? message.id : message.id;
  if (part?.kind === kind && part.text === text && part.id === stamped.id
    && part.seq === stamped.seq && part.messageId === stamped.messageId && id === message.id) return messages;
  if (partIndex < 0 && !text) return messages;
  const parts = message.parts.slice();
  if (partIndex >= 0) parts[partIndex] = stamped;
  else parts.push(stamped);
  const next = base.slice();
  next[index] = { ...message, id, parts,
    sourceIndex: admitting ? undefined : message.sourceIndex };
  return next;
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
