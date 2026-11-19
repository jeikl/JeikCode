/**
 * Typed streaming actions (L2-lite).
 *
 * The event path must not use the generic `apply` escape hatch: each wire event
 * has a stable shape and a single pure reducer. UI-only mutations (optimistic
 * send, cache hydration, edit/rewind) may still use base `CanvasAction`s.
 */
import type { ImageData, NoticeKind, NoticeSeverity, NoticeStatus } from '../../api.ts';
import {
  normalizeCanvas,
  type CanvasRowLike,
} from './canvasStore.ts';
import {
  assistantRowOwner,
  bindUserMessageIdentity,
  identifiedAssistantIndex,
  insertAssistantRowInCausalOrder,
  mergeOlderMessages,
  moveAssistantRowBefore,
  paintAssistantNotice,
  paintAssistantReasoning,
  paintAssistantText,
  paintUserMessage,
  sameTurnAssistantIndex,
  stampAssistantRowSeq,
  stampUserClientInputId,
  stampUserSourceIndex,
  visibleToolChunk,
  withAssistantIdentity,
  type ProjectionMessage,
} from '../sessionProjection.ts';
import { applySubtaskProgress, settleSubtasksFromOutput } from '../subtasks.ts';
import {
  appendToolOutput,
  finalizeToolsAfterTurn,
  replaceToolOutput,
  settleToolRow,
  shouldAcceptNoticeUpdate,
  toolResultStatus,
  updateToolProgress,
  upsertToolPart,
  type MsgPart,
  type ToolRow,
} from '../toolRows.ts';

export type CanvasEventAction =
  | {
      type: 'user';
      text: string;
      ts: number;
      row?: Partial<ProjectionMessage> & { images?: ImageData[]; readOnly?: boolean; isSteer?: boolean };
      clientInputId?: string;
      repeatAfterSettled?: boolean;
      /** True when replaying the active turn's opening user prompt on reattach. */
      replay?: boolean;
      /** Persisted/client id that supersedes a pending-input projection. */
      promoteId?: string;
    }
  | {
      type: 'text';
      content: string;
      replay?: boolean;
      messageId?: string;
      partId?: string;
      partRev?: number;
      /** First live frame's session seq; used when the row is first created. */
      recordSeq?: number;
      /** Replay of the previous turn: insert the new row before this user id. */
      beforeMessageId?: string;
    }
  | {
      type: 'reasoning';
      content: string;
      replay?: boolean;
      messageId?: string;
      partId?: string;
      partRev?: number;
      recordSeq?: number;
      beforeMessageId?: string;
    }
  | {
      type: 'text_batch';
      items: Array<{
        content: string;
        messageId?: string;
        partId?: string;
        partRev?: number;
        recordSeq?: number;
        beforeMessageId?: string;
      }>;
    }
  | { type: 'notice'; text: string; targetId?: string; id?: string }
  | {
      type: 'system';
      text: string;
      id?: string;
      ts?: number;
      /** Insert before a streaming assistant tail instead of after it. */
      beforeLastAssistant?: boolean;
    }
  | {
      /** 已落盘的显示通知（如压缩边界）：带显示日志分配的权威 `id`/`seq`，
       *  按 `seq` 插入转录并按 `id` 幂等去重。 */
      type: 'authoritative_notice';
      id: string;
      seq: number;
      text: string;
      ts?: number;
      anchorMessageId?: string;
    }
  | {
      /** Unified structured v5 system notice (`SystemNotice`). Updated in place by
       *  `eventId` with monotonic status/revision rules and causal anchoring. */
      type: 'system_notice';
      eventId: string;
      partId?: string;
      kind: NoticeKind;
      severity: NoticeSeverity;
      status: NoticeStatus;
      revision: number;
      text: string;
      anchorMessageId?: string;
      anchorPartId?: string;
      ts?: number;
    }
  | { type: 'settle_active_notices' }
  | {
      type: 'tool_start';
      tool: ToolRow;
      messageId?: string;
      recordSeq?: number;
      beforeMessageId?: string;
    }
  | {
      type: 'tool_update';
      id: string;
      update: Partial<ToolRow>;
      derive?: (tool: ToolRow) => Partial<ToolRow> | undefined;
    }
  | { type: 'tool_finished'; id: string; success: boolean }
  /** Display-only runtime model-switch marker bound to the assistant round. */
  | { type: 'model_switch'; messageId: string; model: string }
  | {
      type: 'tool_output';
      id: string;
      chunk: string;
      replay?: boolean;
      /** Legacy daemon replay: extract the visible suffix from the chunk. */
      legacyReplay?: boolean;
    }
  | { type: 'tool_progress'; id: string; progress: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      output: string;
      success: boolean;
      durationMs?: number;
    }
  | { type: 'older'; rows: ProjectionMessage[] }
  | { type: 'assistant_placeholder'; messageId?: string }
  | {
      type: 'bind_user';
      messageId?: string;
      clientInputId?: string;
      clearPendingId?: string;
    }
  | { type: 'stamp_user_source'; messageId: string; sourceIndex?: number; allowMove?: boolean }
  | {
      type: 'stamp_user_identity';
      match: (row: any) => boolean;
      requestId: string;
    }
  | { type: 'notice_row'; row: ProjectionMessage }
  | { type: 'rate_limited'; text: string; targetId?: string; id?: string; eventId?: string }
  | {
      type: 'replace_match';
      match: (row: any) => boolean;
      update: (row: any) => any;
    }
  | {
      type: 'truncate_match';
      match: (row: any) => boolean;
      inclusive?: boolean;
    }
  | { type: 'optimistic_user'; row: ProjectionMessage & { images?: ImageData[] }; requestId?: string }
  | { type: 'finalize_tools' };

export function isCanvasEventAction(
  action: { type: string },
): action is CanvasEventAction {
  return action.type === 'user'
    || action.type === 'text'
    || action.type === 'text_batch'
    || action.type === 'reasoning'
    || action.type === 'notice'
    || action.type === 'system'
    || action.type === 'authoritative_notice'
    || action.type === 'system_notice'
    || action.type === 'settle_active_notices'
    || action.type === 'tool_start'
    || action.type === 'tool_update'
    || action.type === 'tool_finished'
    || action.type === 'model_switch'
    || action.type === 'tool_output'
    || action.type === 'tool_progress'
    || action.type === 'tool_result'
    || action.type === 'older'
    || action.type === 'assistant_placeholder'
    || action.type === 'bind_user'
    || action.type === 'stamp_user_source'
    || action.type === 'stamp_user_identity'
    || action.type === 'notice_row'
    || action.type === 'rate_limited'
    || action.type === 'replace_match'
    || action.type === 'truncate_match'
    || action.type === 'optimistic_user'
    || action.type === 'finalize_tools';
}

export function clearPendingInput<
  T extends { role: string; id?: string; clientInputId?: string; pendingInput?: boolean },
>(rows: T[], id?: string | null): T[] {
  if (!id) return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (row.role === 'user' && row.pendingInput && (row.id === id || row.clientInputId === id)) {
      changed = true;
      return { ...row, pendingInput: undefined };
    }
    return row;
  });
  return changed ? next : rows;
}

/** Update an existing tool row by stable call id. */
function updateToolRow<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  id: string,
  update: Partial<ToolRow>,
  derive?: (tool: ToolRow) => Partial<ToolRow> | undefined,
): T[] {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const message = rows[i]!;
    if (message.role !== 'assistant') continue;
    if (!(message.parts ?? []).some((part) => part.kind === 'tool' && part.tool?.id === id)) continue;
    const parts = (message.parts ?? []).map((part) => {
      if (part.kind !== 'tool' || part.tool?.id !== id) return part;
      return {
        kind: 'tool' as const,
        tool: { ...part.tool, ...update, ...(derive?.(part.tool) ?? {}) },
      };
    });
    const next = rows.slice();
    next[i] = { ...message, parts };
    return next;
  }
  return rows;
}

/** Insert or update a tool row on its owning assistant turn. */
function upsertToolRow<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  tool: ToolRow,
  messageId?: string,
  recordSeq?: number,
): T[] {
  const newToolRow = () => ({
    role: 'assistant',
    ...(messageId ? { id: messageId } : {}),
    parts: [{ kind: 'tool', tool }],
  } as unknown as T);
  if (rows.length === 0) {
    // A tool-only round may emit `tool_start` before any text/placeholder.
    // Create the owning assistant row instead of dropping the tool card.
    return withAssistantIdentity(
      insertAssistantRowInCausalOrder(rows, newToolRow(), recordSeq),
      messageId,
    );
  }
  const existing = updateToolRow(rows, tool.id, tool);
  if (existing !== rows) return existing;
  const owner = identifiedAssistantIndex(rows, messageId);
  if (owner >= 0) {
    const next = rows.slice();
    const row = rows[owner]!;
    next[owner] = { ...row, parts: upsertToolPart(row.parts ?? [], tool) };
    return stampAssistantRowSeq(next, owner, recordSeq);
  }
  const ownerIdx = sameTurnAssistantIndex(rows);
  const tail = ownerIdx >= 0 ? rows[ownerIdx] : undefined;
  const lastSettled = !!tail && (tail.parts ?? []).some(
    (part) => part.kind === 'text' && (part.text ?? '').trim().length > 0,
  );
  // 尾部行属于另一个 round 时，绝不能把工具塞进去：否则两轮会混成一行，
  // 重连后就会出现「工具挂在错误的气泡里 / 一行多个 owner」。
  const tailOwner = tail ? assistantRowOwner(tail as unknown as { id?: string; parts?: MsgPart[] }) : undefined;
  const crossOwner = !!messageId && !!tailOwner && tailOwner !== messageId;
  if (tail && !lastSettled && !crossOwner) {
    const next = rows.slice();
    const merged = { ...tail, parts: upsertToolPart(tail.parts ?? [], tool) } as T & { id?: string };
    // The receiving row may be an id-less placeholder created before the first
    // frame. Stamp the round id here: `withAssistantIdentity` only looks at the
    // LAST assistant row, and a causally-inserted earlier row is not last.
    if (messageId && !merged.id) merged.id = messageId;
    next[ownerIdx] = merged;
    return withAssistantIdentity(
      stampAssistantRowSeq(next, ownerIdx, recordSeq),
      messageId,
    );
  }
  return withAssistantIdentity(
    insertAssistantRowInCausalOrder(rows, newToolRow(), recordSeq),
    messageId,
  );
}

function updateToolOutputRow<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  id: string,
  chunk: string,
  replay: boolean,
  legacyReplay: boolean,
): T[] {
  const applyTo = (message: T): T | undefined => {
    if (message.role !== 'assistant') return undefined;
    const owns = (message.parts ?? []).some((part) => part.kind === 'tool' && part.tool?.id === id);
    if (!owns) return undefined;
    const visible = legacyReplay
      ? visibleToolChunk(message.parts ?? [], id, chunk, true)
      : chunk;
    if (!visible) return message;
    let parts = replay
      ? replaceToolOutput(message.parts ?? [], id, visible)
      : appendToolOutput(message.parts ?? [], id, visible);
    parts = parts.map((part) => {
      if (part.kind === 'tool' && part.tool.id === id && part.tool.subtasks) {
        const next = applySubtaskProgress(part.tool.subtasks, visible);
        if (next !== part.tool.subtasks) {
          return { kind: 'tool' as const, tool: { ...part.tool, subtasks: next } };
        }
      }
      return part;
    });
    return { ...message, parts };
  };
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const patched = applyTo(rows[i]!);
    if (patched) {
      if (patched === rows[i]) return rows;
      const next = rows.slice();
      next[i] = patched;
      return next;
    }
  }
  const last = rows[rows.length - 1];
  if (!last) return rows;
  const patched = applyTo(last);
  if (!patched || patched === last) return rows;
  const next = rows.slice();
  next[rows.length - 1] = patched;
  return next;
}

function updateToolProgressRow<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  id: string,
  progress: string,
): T[] {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const message = rows[i]!;
    if (message.role !== 'assistant') continue;
    if (!(message.parts ?? []).some((part) => part.kind === 'tool' && part.tool?.id === id)) continue;
    let patch: Partial<ToolRow> | undefined;
    for (const part of message.parts ?? []) {
      if (part.kind === 'tool' && part.tool.id === id && part.tool.subtasks) {
        const next = applySubtaskProgress(part.tool.subtasks, progress);
        if (next !== part.tool.subtasks) patch = { subtasks: next };
        break;
      }
    }
    const next = rows.slice();
    next[i] = {
      ...message,
      parts: updateToolProgress(message.parts ?? [], id, progress, patch),
    };
    return next;
  }
  return rows;
}

export interface SystemNoticeWire {
  event_id: string;
  part_id?: string;
  kind: NoticeKind;
  severity: NoticeSeverity;
  status: NoticeStatus;
  revision: number;
  text: string;
  anchor_message_id?: string;
  anchor_part_id?: string;
  created_at?: number;
}

export type SystemNoticeAction = Extract<CanvasEventAction, { type: 'system_notice' }>;

export function systemNoticeActionFromWire(event: SystemNoticeWire): SystemNoticeAction {
  return {
    type: 'system_notice',
    eventId: event.event_id,
    partId: event.part_id,
    kind: event.kind,
    severity: event.severity,
    status: event.status,
    revision: event.revision,
    text: event.text,
    anchorMessageId: event.anchor_message_id,
    anchorPartId: event.anchor_part_id,
    ts: event.created_at,
  };
}

function rowMatchesAnchorId<T extends CanvasRowLike & ProjectionMessage>(
  row: T,
  anchorId: string,
): boolean {
  if (row.id === anchorId || row.clientInputId === anchorId) return true;
  if (row.role !== 'assistant') return false;
  return (row.parts ?? []).some(
    (p) => 'id' in p && typeof p.id === 'string' && p.id.startsWith(`${anchorId}:`),
  );
}

/** Whether `anchorMessageId` already exists on canvas (or no anchor is needed). */
export function hasNoticeAnchorInRows<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  anchorMessageId?: string,
): boolean {
  if (!anchorMessageId) return true;
  return rows.some((row) => rowMatchesAnchorId(row, anchorMessageId));
}

function findAnchorInsertionIndex<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  anchorMessageId: string,
): number {
  const anchorIdx = rows.findIndex((row) => rowMatchesAnchorId(row, anchorMessageId));
  if (anchorIdx < 0) return -1;
  let at = anchorIdx + 1;
  while (
    at < rows.length &&
    rows[at]?.role === 'system' &&
    (rows[at]?.parts ?? []).some(
      (p) => p.kind === 'notice' && p.anchorMessageId === anchorMessageId,
    )
  ) {
    at += 1;
  }
  return at;
}

/** Coalesce a delayed system_notice event into `queue` keyed by `event_id` while
 *  its anchor is outside the loaded window (respecting settled/revision order). */
export function enqueuePendingAnchoredNotice(
  queue: SystemNoticeWire[],
  incoming: SystemNoticeWire,
): SystemNoticeWire[] {
  const idx = queue.findIndex((item) => item.event_id === incoming.event_id);
  if (idx < 0) return [...queue, incoming];
  const prev = queue[idx]!;
  if (!shouldAcceptNoticeUpdate({ status: prev.status, revision: prev.revision }, incoming)) {
    return queue;
  }
  const next = queue.slice();
  next[idx] = {
    ...incoming,
    anchor_message_id: incoming.anchor_message_id ?? prev.anchor_message_id,
    anchor_part_id: incoming.anchor_part_id ?? prev.anchor_part_id,
    created_at: prev.created_at ?? incoming.created_at,
  };
  return next;
}

/** Partition queued notices into those whose anchor now exists on `rows` and
 *  the ones still waiting for an older page or message identity. */
export function drainPendingAnchoredNotices<T extends CanvasRowLike & ProjectionMessage>(
  queue: SystemNoticeWire[],
  rows: T[],
): { ready: SystemNoticeAction[]; remaining: SystemNoticeWire[] } {
  if (queue.length === 0) return { ready: [], remaining: queue };
  const ready: SystemNoticeAction[] = [];
  const remaining: SystemNoticeWire[] = [];
  for (const item of queue) {
    const alreadyOnCanvas = rows.some(
      (row) =>
        row.role === 'system' &&
        (row.id === item.event_id ||
          (row.parts ?? []).some((p) => p.kind === 'notice' && p.eventId === item.event_id)),
    );
    if (alreadyOnCanvas || hasNoticeAnchorInRows(rows, item.anchor_message_id)) {
      ready.push(systemNoticeActionFromWire(item));
    } else {
      remaining.push(item);
    }
  }
  return { ready, remaining };
}

function upsertSystemNoticeRow<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  spec: {
    eventId: string;
    partId?: string;
    kind?: NoticeKind;
    severity?: NoticeSeverity;
    status?: NoticeStatus;
    revision?: number;
    text: string;
    anchorMessageId?: string;
    anchorPartId?: string;
    ts?: number;
    seq?: number;
  },
): T[] {
  const text = spec.text.trim();
  if (!text) return rows;
  const noticeId = spec.eventId;
  const existingAt = rows.findIndex(
    (row) =>
      row.id === noticeId ||
      (row.role === 'system' &&
        (row.parts ?? []).some((p) => p.kind === 'notice' && p.eventId === noticeId)),
  );
  if (existingAt >= 0) {
    const existing = rows[existingAt]!;
    const existingPart = (existing.parts ?? []).find(
      (part): part is Extract<MsgPart, { kind: 'notice' }> => part.kind === 'notice',
    );
    if (
      spec.status &&
      !shouldAcceptNoticeUpdate(existingPart, { status: spec.status, revision: spec.revision })
    ) {
      return rows;
    }
    const resolvedPartId = spec.partId || existingPart?.partId || existingPart?.id || `${noticeId}:1:notice`;
    const nextPart: MsgPart = {
      kind: 'notice',
      text,
      id: resolvedPartId,
      ...(spec.eventId ? { eventId: spec.eventId } : existingPart?.eventId ? { eventId: existingPart.eventId } : {}),
      partId: resolvedPartId,
      ...(spec.kind ?? existingPart?.noticeKind ? { noticeKind: spec.kind ?? existingPart?.noticeKind } : {}),
      ...(spec.severity ?? existingPart?.severity ? { severity: spec.severity ?? existingPart?.severity } : {}),
      ...(spec.status ?? existingPart?.status ? { status: spec.status ?? existingPart?.status } : {}),
      ...(typeof (spec.revision ?? existingPart?.revision) === 'number'
        ? { revision: spec.revision ?? existingPart?.revision }
        : {}),
      ...(spec.anchorMessageId ?? existingPart?.anchorMessageId
        ? { anchorMessageId: spec.anchorMessageId ?? existingPart?.anchorMessageId }
        : {}),
      ...(spec.anchorPartId ?? existingPart?.anchorPartId
        ? { anchorPartId: spec.anchorPartId ?? existingPart?.anchorPartId }
        : {}),
    };
    const unchanged =
      (existing as { persistent?: boolean }).persistent === true &&
      existingPart?.text === nextPart.text &&
      existingPart?.noticeKind === nextPart.noticeKind &&
      existingPart?.severity === nextPart.severity &&
      existingPart?.status === nextPart.status &&
      existingPart?.revision === nextPart.revision &&
      existingPart?.anchorMessageId === nextPart.anchorMessageId;
    if (unchanged) return rows;
    const next = rows.slice();
    const updated: Record<string, unknown> = {
      ...(existing as unknown as Record<string, unknown>),
      persistent: true,
      parts: [nextPart],
      ...(typeof spec.seq === 'number' && typeof existing.seq !== 'number' ? { seq: spec.seq } : {}),
    };
    delete updated.transient;
    next[existingAt] = updated as unknown as T;
    return next;
  }

  const partId = spec.partId || `${noticeId}:1:notice`;
  const notePart: MsgPart = {
    kind: 'notice',
    text,
    id: partId,
    eventId: noticeId,
    partId,
    ...(spec.kind ? { noticeKind: spec.kind } : {}),
    ...(spec.severity ? { severity: spec.severity } : {}),
    ...(spec.status ? { status: spec.status } : {}),
    ...(typeof spec.revision === 'number' ? { revision: spec.revision } : {}),
    ...(spec.anchorMessageId ? { anchorMessageId: spec.anchorMessageId } : {}),
    ...(spec.anchorPartId ? { anchorPartId: spec.anchorPartId } : {}),
  };
  const note = {
    role: 'system',
    id: noticeId,
    persistent: true,
    parts: [notePart],
    ts: spec.ts ?? Date.now(),
    ...(typeof spec.seq === 'number' ? { seq: spec.seq } : {}),
  } as unknown as T;

  if (spec.anchorMessageId) {
    const anchorAt = findAnchorInsertionIndex(rows, spec.anchorMessageId);
    if (anchorAt >= 0) {
      return [...rows.slice(0, anchorAt), note, ...rows.slice(anchorAt)];
    }
  }
  if (typeof spec.seq === 'number') {
    const insertAt = rows.findIndex(
      (row) => typeof row.seq === 'number' && row.seq > spec.seq!,
    );
    return insertAt >= 0
      ? [...rows.slice(0, insertAt), note, ...rows.slice(insertAt)]
      : [...rows, note];
  }
  return [...rows, note];
}

function settleActiveNoticeRows<T extends CanvasRowLike & ProjectionMessage>(rows: T[]): T[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.role !== 'system') return row;
    let rowChanged = false;
    const nextParts = (row.parts ?? []).map((part) => {
      if (part.kind === 'notice' && part.status === 'active') {
        rowChanged = true;
        return { ...part, status: 'settled' as const };
      }
      return part;
    });
    if (!rowChanged) return row;
    changed = true;
    return { ...row, persistent: true, parts: nextParts } as unknown as T;
  });
  return changed ? next : rows;
}

export function reduceCanvasEvent<T extends CanvasRowLike & ProjectionMessage>(
  rows: T[],
  action: CanvasEventAction,
): T[] {
  let next = rows;
  switch (action.type) {
    case 'user':
      next = paintUserMessage(
        rows,
        action.text,
        action.ts,
        () => ({
          role: 'user',
          parts: [{ kind: 'text', text: action.text }],
          ...action.row,
        } as unknown as T),
        {
          repeatAfterSettled: action.repeatAfterSettled,
          clientInputId: action.clientInputId,
          replay: action.replay,
        },
      );
      if (action.promoteId) next = clearPendingInput(next, action.promoteId);
      break;
    case 'text':
      next = withAssistantIdentity(
        paintAssistantText(
          rows,
          action.content,
          action.replay === true,
          action.messageId,
          action.partId,
          action.partRev,
          action.recordSeq,
        ),
        action.messageId,
        action.partId,
      );
      next = moveAssistantRowBefore(next, action.messageId, action.beforeMessageId);
      break;
    case 'text_batch': {
      let acc = rows;
      for (const item of action.items) {
        acc = withAssistantIdentity(
          paintAssistantText(
            acc,
            item.content,
            false,
            item.messageId,
            item.partId,
            item.partRev,
            item.recordSeq ?? action.items[0]?.recordSeq,
          ),
          item.messageId,
          item.partId,
        );
        acc = moveAssistantRowBefore(acc, item.messageId, item.beforeMessageId);
      }
      next = acc;
      break;
    }
    case 'reasoning':
      next = withAssistantIdentity(
        paintAssistantReasoning(
          rows,
          action.content,
          action.replay === true,
          action.messageId,
          action.partId,
          action.partRev,
          action.recordSeq,
        ),
        action.messageId,
        action.partId,
      );
      next = moveAssistantRowBefore(next, action.messageId, action.beforeMessageId);
      break;
    case 'notice':
      next = paintAssistantNotice(rows, action.text, action.targetId, action.id);
      break;
    case 'system': {
      let maxSeq = -1;
      for (const row of rows) {
        if (typeof row.seq === 'number' && row.seq > maxSeq) maxSeq = row.seq;
      }
      const note = {
        role: 'system',
        id: (action as { id?: string }).id ?? ('sys-' + Date.now()),
        // Command output / local boundary marker: durable across cache reads.
        persistent: true,
        parts: [{ kind: 'notice', text: action.text }],
        ts: action.ts ?? Date.now(),
        seq: maxSeq >= 0 ? maxSeq + 0.5 : rows.length,
      } as unknown as T;
      if (action.beforeLastAssistant && rows.length > 0 && rows[rows.length - 1]!.role === 'assistant') {
        next = [...rows.slice(0, -1), note, rows[rows.length - 1]!];
      } else {
        next = [...rows, note];
      }
      break;
    }
    case 'authoritative_notice': {
      next = upsertSystemNoticeRow(rows, {
        eventId: action.id || ('notice-' + action.seq),
        text: action.text,
        anchorMessageId: action.anchorMessageId,
        ts: action.ts,
        seq: action.seq,
      });
      break;
    }
    case 'system_notice': {
      next = upsertSystemNoticeRow(rows, {
        eventId: action.eventId,
        partId: action.partId,
        kind: action.kind,
        severity: action.severity,
        status: action.status,
        revision: action.revision,
        text: action.text,
        anchorMessageId: action.anchorMessageId,
        anchorPartId: action.anchorPartId,
        ts: action.ts,
      });
      break;
    }
    case 'settle_active_notices': {
      next = settleActiveNoticeRows(rows);
      break;
    }
    case 'tool_start':
      next = upsertToolRow(rows, action.tool, action.messageId, action.recordSeq);
      next = moveAssistantRowBefore(next, action.messageId, action.beforeMessageId);
      break;
    case 'tool_update':
      next = updateToolRow(rows, action.id, action.update, action.derive);
      break;
    case 'tool_finished':
      next = updateToolRow(rows, action.id, {}, (tool) => settleToolRow(tool, action.success));
      break;
    case 'model_switch': {
      let target = -1;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row.role !== 'assistant') continue;
        const owned = row.id === action.messageId
          || (row.parts ?? []).some(
            (part) =>
              'id' in part
              && typeof part.id === 'string'
              && part.id.startsWith(`${action.messageId}:`),
          );
        if (owned) {
          target = i;
          break;
        }
      }
      // Artifact-first rounds may create the row before the message identity is
      // stamped; only then fall back to the newest assistant row. A different
      // concrete id means this marker belongs to a row that has not arrived yet —
      // never mislabel the previous round.
      if (target < 0) {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i];
          if (row.role !== 'assistant') continue;
          if (!row.id || row.id === action.messageId) target = i;
          break;
        }
      }
      if (target < 0) {
        next = rows;
      } else {
        next = rows.slice();
        next[target] = { ...next[target], switchTo: action.model } as T;
      }
      break;
    }
    case 'tool_output':
      next = updateToolOutputRow(
        rows,
        action.id,
        action.chunk,
        action.replay === true,
        action.legacyReplay === true,
      );
      break;
    case 'tool_progress':
      next = updateToolProgressRow(rows, action.id, action.progress);
      break;
    case 'tool_result': {
      const status = toolResultStatus(action.success, action.output, action.name);
      next = updateToolRow(
        rows,
        action.id,
        { status, duration_ms: action.durationMs, output: action.output, progress: undefined },
        (tool) => settleSubtasksFromOutput(tool, action.output),
      );
      if (next === rows) {
        next = upsertToolRow(rows, {
          id: action.id,
          name: action.name,
          args: '',
          status,
          duration_ms: action.durationMs,
          output: action.output,
        });
      }
      break;
    }
    case 'finalize_tools': {
      let changed = false;
      next = rows.map((row) => {
        if (row.role !== 'assistant') return row;
        const parts = finalizeToolsAfterTurn(row.parts ?? []);
        if (parts === row.parts) return row;
        changed = true;
        return { ...row, parts };
      });
      if (!changed) next = rows;
      break;
    }
    case 'older':
      next = mergeOlderMessages(rows, action.rows) as T[];
      break;
    case 'assistant_placeholder': {
      if (action.messageId && rows.some((row) => row.role === 'assistant' && row.id === action.messageId)) {
        break;
      }
      const last = rows[rows.length - 1];
      if (!last || last.role === 'user') {
        next = [...rows, { role: 'assistant', parts: [] } as unknown as T];
      }
      break;
    }
    case 'bind_user':
      next = bindUserMessageIdentity(rows, action.messageId);
      next = stampUserClientInputId(next, action.clientInputId);
      if (action.clearPendingId) next = clearPendingInput(next, action.clearPendingId);
      break;
    case 'stamp_user_source':
      next = stampUserSourceIndex(rows, action.messageId, action.sourceIndex, {
        allowMove: action.allowMove === true,
      });
      break;
    case 'stamp_user_identity': {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]!;
        if (row.role !== 'user' || !action.match(row)) continue;
        if (row.id !== action.requestId || row.clientInputId !== action.requestId) {
          next = rows.slice();
          next[i] = { ...row, id: action.requestId, clientInputId: action.requestId } as T;
        }
        break;
      }
      break;
    }
    case 'notice_row':
      next = [...rows, action.row as unknown as T];
      break;
    case 'rate_limited': {
      if (action.eventId) {
        const existingAt = rows.findIndex(
          (row) =>
            row.id === action.eventId ||
            (row.parts ?? []).some((p) => p.kind === 'rate_limited' && p.eventId === action.eventId),
        );
        if (existingAt >= 0) {
          const row = rows[existingAt]!;
          const already = (row.parts ?? []).some(
            (part) => part.kind === 'rate_limited' && part.text === action.text && part.eventId === action.eventId,
          );
          if (!already) {
            next = rows.slice();
            next[existingAt] = {
              ...row,
              parts: (row.parts ?? []).map((part) =>
                part.kind === 'rate_limited'
                  ? { kind: 'rate_limited' as const, text: action.text, eventId: action.eventId }
                  : part,
              ),
            };
          }
          break;
        }
      }
      const target = action.targetId
        ? identifiedAssistantIndex(rows, action.targetId)
        : (() => {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i]!.role === 'assistant') return i;
            }
            return -1;
          })();
      if (target >= 0) {
        const row = rows[target]!;
        const already = (row.parts ?? []).some(
          (part) =>
            part.kind === 'rate_limited' &&
            ((action.eventId && part.eventId === action.eventId) || part.text === action.text),
        );
        if (!already) {
          next = rows.slice();
          next[target] = {
            ...row,
            parts: [
              ...(row.parts ?? []),
              {
                kind: 'rate_limited',
                text: action.text,
                ...(action.eventId ? { eventId: action.eventId } : {}),
              },
            ],
          };
        }
      } else {
        // The anchored round is not on canvas. Put the transient card after the
        // current user prompt, not at the absolute tail after the final answer.
        let insertAt = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]!.role === 'user') {
            insertAt = i + 1;
            break;
          }
        }
        next = [
          ...rows.slice(0, insertAt),
          {
            role: 'assistant',
            id: action.eventId ?? action.id ?? ('rl-' + Date.now()),
            parts: [
              {
                kind: 'rate_limited',
                text: action.text,
                ...(action.eventId ? { eventId: action.eventId } : {}),
              },
            ],
          } as unknown as T,
          ...rows.slice(insertAt),
        ];
      }
      break;
    }
    case 'replace_match': {
      const index = rows.findIndex((row) => action.match(row));
      if (index < 0) break;
      next = rows.slice();
      next[index] = action.update(rows[index]!) as T;
      break;
    }
    case 'truncate_match': {
      const index = rows.findIndex((row) => action.match(row));
      if (index < 0) break;
      next = rows.slice(0, action.inclusive === true ? index + 1 : index);
      break;
    }
    case 'optimistic_user': {
      const exists = action.requestId
        ? rows.some(
            (row) => row.role === 'user'
              && (row.id === action.requestId || row.clientInputId === action.requestId),
          )
        : false;
      if (!exists) {
        const last = rows[rows.length - 1];
        const base =
          last && last.role === 'assistant' && (!last.parts || last.parts.length === 0)
            ? rows.slice(0, -1)
            : rows;
        const userRow = {
          ...action.row,
          ...(action.requestId && !action.row.clientInputId
            ? { clientInputId: action.requestId }
            : {}),
        };
        next = [...base, userRow as unknown as T];
      }
      break;
    }
  }
  // Identity/order are already guaranteed by the paint helpers for
  // text/reasoning updates on an existing row. Re-normalizing the whole canvas
  // per token is O(n); only new rows (or user/notice identity changes) need it.
  return (action.type === 'user'
    || action.type === 'optimistic_user'
    || action.type === 'older'
    || action.type === 'bind_user'
    || action.type === 'stamp_user_source'
    || action.type === 'stamp_user_identity'
    || action.type === 'notice'
    || action.type === 'system'
    || next.length !== rows.length)
    ? normalizeCanvas(next) as T[]
    : next;
}
