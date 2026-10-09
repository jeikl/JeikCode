/**
 * sessionStore.ts
 *
 * 全面对齐 OpenCode 架构的纯函数式单状态容器。
 *
 * 核心特性：
 * 1. 唯一实体准星制导 (MessageID, PartID, QueueID)；
 * 2. 待发/转向队列卡片 4 状态机 (queued -> steering -> steer_pending -> promoted/cancelled)；
 * 3. 思考块拓扑定序不变量 (ReasoningPart 永远位于首个 TextPart 之前，绝对不撕裂正文)；
 * 4. 纯函数确定性派生右侧提问大纲 (deriveTurnNavItems)。
 */

import {
  turnNavId,
  compactTurnNavText,
  truncateTurnNavLabel,
  type TurnNavItem,
} from './turnNav.ts';
import {
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
} from './historyMessages.ts';
import { userTextsMatch } from './chatTerminal.ts';

export type PartKind = 'text' | 'reasoning' | 'tool' | 'artifact' | 'notice' | 'compaction';

export interface BasePart {
  id: string;
  message_id: string;
  kind: PartKind;
}

export interface TextPartEntity extends BasePart {
  kind: 'text';
  text: string;
  state?: 'streaming' | 'completed';
}

export interface ReasoningPartEntity extends BasePart {
  kind: 'reasoning';
  text: string;
  duration_ms?: number;
  state?: 'streaming' | 'completed';
}

export interface ToolPartEntity extends BasePart {
  kind: 'tool';
  call_id: string;
  name: string;
  arguments: string;
  output?: string;
  progress?: string;
  status: 'pending' | 'running' | 'waiting_approval' | 'done' | 'error' | 'incomplete';
  duration_ms?: number;
}

export interface ArtifactPartEntity extends BasePart {
  kind: 'artifact';
  artifact_type: 'code' | 'html' | 'markdown';
  language?: string;
  title?: string;
  content: string;
  state?: 'open' | 'closed';
}

export interface NoticePartEntity extends BasePart {
  kind: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
  retry_after?: number;
}

export interface CompactionPartEntity extends BasePart {
  kind: 'compaction';
  removed_turns: number;
  token_savings: number;
  summary?: string;
}

export type PartEntity =
  | TextPartEntity
  | ReasoningPartEntity
  | ToolPartEntity
  | ArtifactPartEntity
  | NoticePartEntity
  | CompactionPartEntity;

export interface MessageEntity {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  turn_ordinal?: number;
  order: number;
  created_at: number;
  text?: string;
  parts: PartEntity[];
  images?: Array<{ mime?: string; data: string; url?: string }>;
}

export type QueueState = 'queued' | 'steering' | 'steer_pending' | 'promoted' | 'cancelled';

export interface QueueItem {
  id: string;
  session_id: string;
  queue_index: number;
  state: QueueState;
  text: string;
  images?: Array<{ mime?: string; data: string; url?: string }>;
  approval_mode?: 'Build' | 'AcceptEdits' | 'Plan' | 'Auto';
  created_at: number;
}

export interface PermissionDoc {
  request_id: string;
  session_id: string;
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  reason?: string;
  status: 'asked' | 'approved' | 'rejected';
  created_at: number;
}

export interface QuestionDoc {
  request_id: string | number;
  session_id: string;
  question: string;
  options: string[];
  is_multi_select: boolean;
  status: 'asked' | 'replied';
}

export interface TodoItemDoc {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoDoc {
  session_id: string;
  items: TodoItemDoc[];
  updated_at: number;
}

export interface SessionState {
  sessionId: string;
  status: 'idle' | 'running' | 'compacting' | 'aborted';
  messages: MessageEntity[];
  queue: QueueItem[];
  permissions: PermissionDoc[];
  todos: TodoDoc | null;
  question: QuestionDoc | null;
}

/** 创建初始状态容器 */
export function createInitialSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    status: 'idle',
    messages: [],
    queue: [],
    permissions: [],
    todos: null,
    question: null,
  };
}


/**
 * 将待发草稿压入队列（形态 A: queued）
 */
export function enqueueDraft(
  state: SessionState,
  draft: {
    id?: string;
    text: string;
    images?: Array<{ mime?: string; data: string; url?: string }>;
    approval_mode?: 'Build' | 'AcceptEdits' | 'Plan' | 'Auto';
  },
): SessionState {
  const id = draft.id || `queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const nextItem: QueueItem = {
    id,
    session_id: state.sessionId,
    queue_index: state.queue.length,
    state: 'queued',
    text: draft.text,
    images: draft.images,
    approval_mode: draft.approval_mode,
    created_at: Date.now(),
  };

  return {
    ...state,
    queue: [...state.queue, nextItem],
  };
}

/**
 * 标记卡片为待发转向状态（形态 C: steer_pending）
 * 此时网络请求已确认，无论刷新还是切会话，卡片都保持待发。
 */
export function markSteerPending(state: SessionState, id: string): SessionState {
  const nextQueue = state.queue.map((item) =>
    item.id === id ? { ...item, state: 'steer_pending' as const } : item,
  );
  return {
    ...state,
    queue: nextQueue,
  };
}

/**
 * 取消队列中的某条卡片并销毁，返回被取消的元素供前端回填输入框
 */
export function cancelQueueItem(
  state: SessionState,
  id: string,
): { nextState: SessionState; cancelledItem?: QueueItem } {
  const cancelledItem = state.queue.find((q) => q.id === id);
  const nextQueue = state.queue
    .filter((q) => q.id !== id)
    .map((q, idx) => ({ ...q, queue_index: idx }));

  return {
    nextState: {
      ...state,
      queue: nextQueue,
    },
    cancelledItem,
  };
}

/**
 * 计算下一个全局提问序号 (turn_ordinal)
 */
export function nextTurnOrdinal(messages: MessageEntity[]): number {
  let maxOrd = -1;
  for (const m of messages) {
    if (m.role === 'user' && typeof m.turn_ordinal === 'number') {
      if (m.turn_ordinal > maxOrd) maxOrd = m.turn_ordinal;
    }
  }
  return maxOrd + 1;
}

/**
 * 内核吸收 Steer 提问：卡片升级为正文 (promoted)，并从队列自然销毁 (形态 D)
 */
export function reconcileSteerPromotion(
  state: SessionState,
  steeredInputs: Array<{
    text: string;
    images?: Array<{ mime?: string; data: string; url?: string }>;
  }>,
): SessionState {
  if (!steeredInputs || steeredInputs.length === 0) return state;

  let nextQueue = state.queue.slice();
  let nextMessages = state.messages.slice();
  const now = Date.now();

  for (const input of steeredInputs) {
    const cleanText = stripSteerEnvelopeForDisplay(input.text || '').trim();
    if (!cleanText && (!input.images || input.images.length === 0)) continue;

    // 1. 寻找匹配的待发卡片（优先 steer_pending / queued，匹配文本或任意待发卡片）
    let matchIdx = nextQueue.findIndex(
      (q) => (q.state === 'steer_pending' || q.state === 'queued') && q.text.trim() === cleanText,
    );
    if (matchIdx < 0) {
      matchIdx = nextQueue.findIndex((q) => q.state === 'steer_pending' || q.state === 'steering');
    }

    let preservedImages = input.images;
    if (matchIdx >= 0) {
      const matched = nextQueue[matchIdx];
      if ((!preservedImages || preservedImages.length === 0) && matched.images) {
        preservedImages = matched.images;
      }
      // 从队列移除（自然销毁）
      nextQueue.splice(matchIdx, 1);
    }

    // 2. 检查是否已经在 messages 中去重
    const alreadyPresent = nextMessages.some(
      (m) =>
        m.role === 'user' &&
        (m.text?.trim() === cleanText ||
          (cleanText && userTextsMatch(m.text || '', cleanText)) ||
          m.parts.some((p) => p.kind === 'text' && (p.text.trim() === cleanText || userTextsMatch(p.text, cleanText)))),
    );

    if (!alreadyPresent) {
      const turnOrd = nextTurnOrdinal(nextMessages);
      const userMsgId = `user-msg-${now}-${turnOrd}`;
      const newUserMsg: MessageEntity = {
        id: userMsgId,
        session_id: state.sessionId,
        role: 'user',
        turn_ordinal: turnOrd,
        order: nextMessages.length,
        created_at: now,
        text: cleanText,
        parts: [{ id: `${userMsgId}-p0`, message_id: userMsgId, kind: 'text', text: cleanText, state: 'completed' }],
        images: preservedImages,
      };

      const asstMsgId = `asst-msg-${now}-${turnOrd}`;
      const newAsstMsg: MessageEntity = {
        id: asstMsgId,
        session_id: state.sessionId,
        role: 'assistant',
        order: nextMessages.length + 1,
        created_at: now,
        parts: [],
      };

      nextMessages.push(newUserMsg, newAsstMsg);
    }
  }

  // 重新对齐 queue_index
  nextQueue = nextQueue.map((q, idx) => ({ ...q, queue_index: idx }));

  return {
    ...state,
    queue: nextQueue,
    messages: nextMessages,
  };
}

/**
 * 纯函数：直接从 messages 权威派生右侧提问大纲，绝对单调、锚点精准、0 维护成本
 */
export function deriveTurnNavItems(messages: MessageEntity[]): TurnNavItem[] {
  const items: TurnNavItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    const rawText = msg.text || (msg.parts.find((p) => p.kind === 'text') as TextPartEntity)?.text || '';
    if (stripInjectedRemindersForDisplay(rawText).trim() === '') continue;

    const cleaned = compactTurnNavText(
      stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(rawText)),
    );
    const label = truncateTurnNavLabel(cleaned);
    if (!label) continue;

    const ordinal = typeof msg.turn_ordinal === 'number' ? msg.turn_ordinal : items.length;
    items.push({
      id: turnNavId(ordinal),
      ordinal,
      index: msg.order ?? i,
      label,
      text: cleaned,
    });
  }
  return items;
}

/**
 * 纯函数更新器：处理来自单事件总线的 SSE 事件
 */
export function applySSEEvent(state: SessionState, event: any): SessionState {
  if (!event || !event.type) return state;

  switch (event.type) {
    case 'session_status': {
      return {
        ...state,
        status: event.status ?? state.status,
      };
    }

    case 'steered': {
      return reconcileSteerPromotion(state, event.inputs ?? []);
    }

    case 'user': {
      const cleanContent = stripSteerEnvelopeForDisplay(event.content || '').trim();
      if (!cleanContent) return state;

      // 幂等去重
      const alreadyIdx = state.messages.findIndex(
        (m) =>
          m.role === 'user' &&
          (m.text?.trim() === cleanContent || userTextsMatch(m.text || '', cleanContent)),
      );
      if (alreadyIdx >= 0) {
        return state;
      }

      const turnOrd = typeof event.turn_ordinal === 'number' ? event.turn_ordinal : nextTurnOrdinal(state.messages);
      const msgId = event.message_id || `user-msg-${event.created_at || Date.now()}-${turnOrd}`;
      const newUser: MessageEntity = {
        id: msgId,
        session_id: state.sessionId,
        role: 'user',
        turn_ordinal: turnOrd,
        order: typeof event.order === 'number' ? event.order : state.messages.length,
        created_at: event.created_at || Date.now(),
        text: cleanContent,
        parts: [{ id: `${msgId}-p0`, message_id: msgId, kind: 'text', text: cleanContent, state: 'completed' }],
      };

      const asstId = `asst-msg-${Date.now()}-${turnOrd}`;
      const newAsst: MessageEntity = {
        id: asstId,
        session_id: state.sessionId,
        role: 'assistant',
        order: newUser.order + 1,
        created_at: Date.now(),
        parts: [],
      };

      return {
        ...state,
        status: 'running',
        messages: [...state.messages, newUser, newAsst],
      };
    }

    case 'text': {
      const delta = event.content || '';
      if (!delta) return state;

      const msgs = state.messages.slice();
      let lastAsst = msgs[msgs.length - 1];
      if (!lastAsst || lastAsst.role !== 'assistant') {
        const asstId = `asst-msg-${Date.now()}`;
        lastAsst = {
          id: asstId,
          session_id: state.sessionId,
          role: 'assistant',
          order: msgs.length,
          created_at: Date.now(),
          parts: [],
        };
        msgs.push(lastAsst);
      }

      const parts = lastAsst.parts.slice();
      const targetPartId = event.part_id;
      let targetIdx = targetPartId ? parts.findIndex((p) => p.id === targetPartId && p.kind === 'text') : -1;

      if (targetIdx < 0) {
        // 追加到最后一个 TextPart，或者新建
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.kind === 'text') {
          targetIdx = parts.length - 1;
        }
      }

      if (targetIdx >= 0 && parts[targetIdx].kind === 'text') {
        const prev = parts[targetIdx] as TextPartEntity;
        parts[targetIdx] = {
          ...prev,
          text: prev.text + delta,
          state: 'streaming',
        };
      } else {
        const pId = targetPartId || `text-${lastAsst.id}-${parts.length}`;
        parts.push({
          id: pId,
          message_id: lastAsst.id,
          kind: 'text',
          text: delta,
          state: 'streaming',
        });
      }

      msgs[msgs.length - 1] = {
        ...lastAsst,
        parts,
      };

      return {
        ...state,
        messages: msgs,
      };
    }

    case 'reasoning': {
      const delta = event.content || '';
      if (!delta) return state;

      const msgs = state.messages.slice();
      let lastAsst = msgs[msgs.length - 1];
      if (!lastAsst || lastAsst.role !== 'assistant') {
        const asstId = `asst-msg-${Date.now()}`;
        lastAsst = {
          id: asstId,
          session_id: state.sessionId,
          role: 'assistant',
          order: msgs.length,
          created_at: Date.now(),
          parts: [],
        };
        msgs.push(lastAsst);
      }

      const parts = lastAsst.parts.slice();
      const targetPartId = event.part_id;
      let targetIdx = targetPartId ? parts.findIndex((p) => p.id === targetPartId && p.kind === 'reasoning') : -1;

      if (targetIdx < 0) {
        // 优先检查末尾是否正在流式接收 reasoning
        const lastIdx = parts.length - 1;
        if (lastIdx >= 0 && parts[lastIdx]?.kind === 'reasoning') {
          targetIdx = lastIdx;
        }
      }

      if (targetIdx >= 0 && parts[targetIdx].kind === 'reasoning') {
        const prev = parts[targetIdx] as ReasoningPartEntity;
        parts[targetIdx] = {
          ...prev,
          text: prev.text + delta,
          state: 'streaming',
        };
      } else {
        const rId = targetPartId || `reasoning-${lastAsst.id}-${parts.length}`;
        const newR: ReasoningPartEntity = {
          id: rId,
          message_id: lastAsst.id,
          kind: 'reasoning',
          text: delta,
          state: 'streaming',
        };
        parts.push(newR);
      }

      msgs[msgs.length - 1] = {
        ...lastAsst,
        parts,
      };

      return {
        ...state,
        messages: msgs,
      };
    }

    case 'tool_start': {
      const msgs = state.messages.slice();
      let lastAsst = msgs[msgs.length - 1];
      if (!lastAsst || lastAsst.role !== 'assistant') {
        const asstId = `asst-msg-${Date.now()}`;
        lastAsst = {
          id: asstId,
          session_id: state.sessionId,
          role: 'assistant',
          order: msgs.length,
          created_at: Date.now(),
          parts: [],
        };
        msgs.push(lastAsst);
      }

      const parts = lastAsst.parts.slice();
      const callId = event.id;
      const existingIdx = parts.findIndex((p) => p.kind === 'tool' && (p as ToolPartEntity).call_id === callId);

      const toolPart: ToolPartEntity = {
        id: event.part_id || `tool-${callId}`,
        message_id: lastAsst.id,
        kind: 'tool',
        call_id: callId,
        name: event.name || 'tool',
        arguments: event.arguments || '',
        status: 'pending',
      };

      if (existingIdx >= 0) {
        parts[existingIdx] = {
          ...(parts[existingIdx] as ToolPartEntity),
          ...toolPart,
          // 保留已有的 output
          output: (parts[existingIdx] as ToolPartEntity).output,
        };
      } else {
        parts.push(toolPart);
      }

      msgs[msgs.length - 1] = {
        ...lastAsst,
        parts,
      };

      return {
        ...state,
        messages: msgs,
      };
    }

    case 'tool_progress': {
      const msgs = state.messages.slice();
      const lastAsst = msgs[msgs.length - 1];
      if (!lastAsst || lastAsst.role !== 'assistant') return state;

      const parts = lastAsst.parts.slice();
      const callId = event.id;
      const idx = parts.findIndex((p) => p.kind === 'tool' && (p as ToolPartEntity).call_id === callId);
      if (idx >= 0) {
        const tp = parts[idx] as ToolPartEntity;
        parts[idx] = {
          ...tp,
          progress: event.progress,
          status: 'running',
        };
        msgs[msgs.length - 1] = { ...lastAsst, parts };
        return { ...state, messages: msgs };
      }
      return state;
    }

    case 'tool_result': {
      const msgs = state.messages.slice();
      const lastAsst = msgs[msgs.length - 1];
      if (!lastAsst || lastAsst.role !== 'assistant') return state;

      const parts = lastAsst.parts.slice();
      const callId = event.id;
      const idx = parts.findIndex((p) => p.kind === 'tool' && (p as ToolPartEntity).call_id === callId);
      if (idx >= 0) {
        const tp = parts[idx] as ToolPartEntity;
        parts[idx] = {
          ...tp,
          output: event.output,
          status: event.success ? 'done' : 'error',
          duration_ms: event.duration_ms,
          progress: undefined,
        };
        msgs[msgs.length - 1] = { ...lastAsst, parts };
        return { ...state, messages: msgs };
      }
      return state;
    }

    case 'permission_request': {
      const perm: PermissionDoc = {
        request_id: event.approval_id,
        session_id: event.session_id,
        call_id: event.call_id,
        tool_name: event.tool_name,
        arguments: typeof event.arguments === 'string' ? JSON.parse(event.arguments || '{}') : (event.arguments || {}),
        reason: event.reason,
        status: 'asked',
        created_at: Date.now(),
      };
      return {
        ...state,
        permissions: [...state.permissions.filter((p) => p.request_id !== perm.request_id), perm],
      };
    }

    case 'user_input_request': {
      const q: QuestionDoc = {
        request_id: event.request_id,
        session_id: event.session_id,
        question: event.payload?.question || event.question || '',
        options: event.payload?.options || event.options || [],
        is_multi_select: !!(event.payload?.is_multi_select ?? event.is_multi),
        status: 'asked',
      };
      return {
        ...state,
        question: q,
      };
    }

    case 'done':
    case 'stopped':
    case 'error': {
      // 固化流式状态
      const msgs = state.messages.map((m) => {
        if (m.role !== 'assistant') return m;
        return {
          ...m,
          parts: m.parts.map((p) => {
            if (p.kind === 'text' || p.kind === 'reasoning') {
              return { ...p, state: 'completed' as const };
            }
            if (p.kind === 'tool' && p.status === 'pending') {
              return { ...p, status: 'error' as const };
            }
            return p;
          }),
        };
      });

      return {
        ...state,
        status: 'idle',
        messages: msgs,
      };
    }

    default:
      return state;
  }
}
