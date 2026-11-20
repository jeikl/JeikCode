/**
 * scheduleChatStore.ts — 定时任务 AI 智能设置对话框的内存级多会话存储。
 *
 * 设计契约：
 * 1. 纯内存驻留（仅页面刷新 F5 / 重载时自动清空），不写入 localStorage 或磁盘；
 * 2. 关闭/重开弹窗或切换标签页时，对话上下文记忆保持完整连贯；
 * 3. 支持新建多个独立小窗口会话，每条对话独立维护上下文与已创建的定时任务卡片记录；
 * 4. 不进入主会话工具池或左侧主项目历史列表。
 */
import type { AiScheduleDialogMessage, ScheduleTask } from '../api';

export interface ScheduleAiChatMessage extends AiScheduleDialogMessage {
  id: string;
  createdAt: number;
  createdTasks?: ScheduleTask[];
  error?: boolean;
}

export interface ScheduleAiThread {
  id: string;
  seq: number;
  messages: ScheduleAiChatMessage[];
  model: string | null;
}

const threads = new Map<string, ScheduleAiThread>();
let activeThreadId: string | null = null;
let threadCounter = 0;

function ensureInitialThread(): ScheduleAiThread {
  if (activeThreadId && threads.has(activeThreadId)) {
    return threads.get(activeThreadId)!;
  }
  if (threads.size > 0) {
    const first = threads.values().next().value!;
    activeThreadId = first.id;
    return first;
  }
  return createScheduleAiThread();
}

export function createScheduleAiThread(initialModel: string | null = null): ScheduleAiThread {
  threadCounter += 1;
  const id = `sched-ai-${threadCounter}-${Math.random().toString(36).slice(2, 7)}`;
  const thread: ScheduleAiThread = {
    id,
    seq: threadCounter,
    messages: [],
    model: initialModel,
  };
  threads.set(id, thread);
  activeThreadId = id;
  return thread;
}

export function listScheduleAiThreads(): ScheduleAiThread[] {
  ensureInitialThread();
  return Array.from(threads.values());
}

export function getActiveScheduleAiThread(): ScheduleAiThread {
  return ensureInitialThread();
}

export function selectScheduleAiThread(id: string): ScheduleAiThread {
  const existing = threads.get(id);
  if (existing) {
    activeThreadId = id;
    return existing;
  }
  return ensureInitialThread();
}

export function appendScheduleAiMessage(
  threadId: string,
  msg: Omit<ScheduleAiChatMessage, 'id' | 'createdAt'>,
): ScheduleAiThread {
  const thread = threads.get(threadId) ?? ensureInitialThread();
  const next: ScheduleAiThread = {
    ...thread,
    messages: [
      ...thread.messages,
      {
        ...msg,
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: Date.now(),
      },
    ],
  };
  threads.set(next.id, next);
  return next;
}

export function setScheduleAiThreadModel(threadId: string, model: string | null): void {
  const thread = threads.get(threadId);
  if (thread) {
    threads.set(threadId, { ...thread, model });
  }
}

export function removeScheduleAiThread(threadId: string): ScheduleAiThread {
  threads.delete(threadId);
  if (activeThreadId === threadId) {
    activeThreadId = null;
  }
  return ensureInitialThread();
}
