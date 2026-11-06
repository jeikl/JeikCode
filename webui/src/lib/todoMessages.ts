import type { CanvasRecord as Message } from './canvas/records';
import type { TodoItem } from './todos';
import { withTrailingTodoList } from './toolRows';

/**
 * Freeze a todo snapshot onto the last assistant message's trailing `todo_list`
 * part. Used when the user starts the next turn (sticky → history) and when
 * caching a session that still has a live sticky panel.
 */
export function freezeTodosIntoLastAssistant(msgs: Message[], items: TodoItem[]): Message[] {
  if (!items.length) return msgs;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    const next = msgs.slice();
    next[i] = {
      ...msgs[i]!,
      parts: withTrailingTodoList(msgs[i]!.parts, items),
    };
    return next;
  }
  return msgs;
}

/** Drop an unfinished todo list glued onto the latest assistant bubble.
 *  Completed plans stay in history. A live plan belongs in the sticky panel,
 *  not squeezed against the newest message after a session switch. */
export function detachUnfinishedTodoFromLatestAssistant(msgs: Message[]): Message[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    const parts = msgs[i]!.parts;
    let unfinished = false;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.kind !== 'todo_list' || !part.items?.length) continue;
      unfinished = part.items.some((item) => item.status !== 'completed');
      break;
    }
    if (!unfinished) return msgs;
    const next = msgs.slice();
    next[i] = {
      ...msgs[i]!,
      parts: parts.filter((part) => part.kind !== 'todo_list'),
    };
    return next;
  }
  return msgs;
}
