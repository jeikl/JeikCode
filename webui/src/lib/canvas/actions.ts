/**
 * Typed streaming actions (L2-lite).
 *
 * The event path must not use the generic `apply` escape hatch: each wire event
 * has a stable shape and a single pure reducer. UI-only mutations (optimistic
 * send, cache hydration, edit/rewind) may still use base `CanvasAction`s.
 */
import type { ImageData } from '../../api.ts';
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
    }
  | {
      type: 'reasoning';
      content: string;
      replay?: boolean;
      messageId?: string;
      partId?: string;
      partRev?: number;
      recordSeq?: number;
    }
  | {
      type: 'text_batch';
      items: Array<{
        content: string;
        messageId?: string;
        partId?: string;
        partRev?: number;
        recordSeq?: number;
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
    }
  | { type: 'tool_start'; tool: ToolRow; messageId?: string; recordSeq?: number }
  | {
      type: 'tool_update';
      id: string;
      update: Partial<ToolRow>;
      derive?: (tool: ToolRow) => Partial<ToolRow> | undefined;
    }
  | { type: 'tool_finished'; id: string; success: boolean }
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
  | { type: 'stamp_user_source'; messageId: string; sourceIndex?: number }
  | {
      type: 'stamp_user_identity';
      match: (row: any) => boolean;
      requestId: string;
    }
  | { type: 'notice_row'; row: ProjectionMessage }
  | { type: 'rate_limited'; text: string; targetId?: string; id?: string }
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
    || action.type === 'tool_start'
    || action.type === 'tool_update'
    || action.type === 'tool_finished'
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
      const text = action.text.trim();
      if (!text) break;
      const noticeId = action.id || ('notice-' + action.seq);
      // 同一条显示记录可能先由 `display_notice` 实时送达、再由磁盘重拉返回：按 id 去重。
      if (rows.some((row) => row.id === noticeId)) break;
      const note = {
        role: 'system',
        id: noticeId,
        // Authoritative display-log notice (e.g. compaction boundary): durable.
        persistent: true,
        parts: [{ kind: 'notice', text }],
        ts: action.ts ?? Date.now(),
        seq: action.seq,
      } as unknown as T;
      // 按权威 `seq` 摆放：找到第一条 `seq > action.seq` 的已编号行插到它前面，
      // 保证实时送达与冷启动重放落在同一个位置；未编号或都在它之前则排在末尾。
      const insertAt = rows.findIndex(
        (row) => typeof row.seq === 'number' && row.seq > action.seq,
      );
      next =
        insertAt >= 0
          ? [...rows.slice(0, insertAt), note, ...rows.slice(insertAt)]
          : [...rows, note];
      break;
    }
    case 'tool_start':
      next = upsertToolRow(rows, action.tool, action.messageId, action.recordSeq);
      break;
    case 'tool_update':
      next = updateToolRow(rows, action.id, action.update, action.derive);
      break;
    case 'tool_finished':
      next = updateToolRow(rows, action.id, {}, (tool) => settleToolRow(tool, action.success));
      break;
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
      next = stampUserSourceIndex(rows, action.messageId, action.sourceIndex);
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
          (part) => part.kind === 'rate_limited' && part.text === action.text,
        );
        if (!already) {
          next = rows.slice();
          next[target] = {
            ...row,
            parts: [...(row.parts ?? []), { kind: 'rate_limited', text: action.text }],
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
            id: action.id ?? ('rl-' + Date.now()),
            parts: [{ kind: 'rate_limited', text: action.text }],
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
