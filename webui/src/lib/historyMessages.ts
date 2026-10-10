import type { ImageData, SessionMessage, SessionMutationEvent, SessionTurnOutline } from '../api';
import type { MsgPart } from './toolRows';

const INTERNAL_USER_PREFIXES = [
  '<system-reminder>',
  'You made code edits but have not verified them.',
  'Output limit hit — your last response was cut off',
  'Output limit hit. If the task is already complete',
  '[PLAN MODE',
  '[Context was compressed',
  '[Additional context from user]:',
  '[SYNTAX CHECK:',
  '[DEV SERVER ERROR',
  '[Auto-read from error:',
  '[Images returned by the tool calls above',
];

export function isInternalHistoryUserMessage(text: string, synthetic?: boolean): boolean {
  if (synthetic === true) return true;
  const trimmed = text.trimStart();
  return INTERNAL_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Marker written by the daemon ahead of a mid-turn steer note. */
const STEER_MARKER = '[jeikcode-steer]';

/** UI-only: the steer note is for the model. The bubble keeps the user's words. */
export function stripSteerEnvelopeForDisplay(text: string): string {
  const match = text.match(/<user-query>\s*([\s\S]*?)\s*<\/user-query>/i);
  if (match) {
    const inner = match[1].trim();
    if (inner === '(The user attached image(s))' || inner === '（用户附加了新的图片）') {
      return '';
    }
    return inner;
  }
  let clean = text;
  const idx = clean.indexOf(STEER_MARKER);
  if (idx >= 0) {
    clean = clean.slice(0, idx).trim();
  }
  clean = clean.replace(/<\/?user-query>/gi, '').trim();
  if (clean === '(The user attached image(s))' || clean === '（用户附加了新的图片）') {
    return '';
  }
  return clean;
}

/** UI-only: drop appended `<system-reminder>` tails. Protocol context keeps them. */
export function stripInjectedRemindersForDisplay(text: string): string {
  const open = '<system-reminder>';
  const close = '</system-reminder>';
  let rest = text;
  let out = '';
  while (true) {
    const start = rest.indexOf(open);
    if (start < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const end = rest.indexOf(close, start + open.length);
    if (end < 0) {
      out += rest.slice(start);
      break;
    }
    rest = rest.slice(end + close.length);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function isInternalHistoryAssistantMessage(msg: SessionMessage): boolean {
  const internalOrigin = msg.internal_origin ?? msg.internalOrigin;
  return msg.role === 'assistant'
    && internalOrigin === 'verify_cadence'
    && !(msg.tool_calls?.length);
}

export function sessionMessagesToMarkdownLines(
  messages: SessionMessage[],
  title: string,
): string[] {
  const lines: string[] = [`# ${title}`, ''];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      if (isInternalHistoryUserMessage(msg.content || '', msg.synthetic)) continue;
      const visible = stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(msg.content || ''));
      if (!visible) continue;
      lines.push('## User', '', visible, '');
    } else if (msg.role === 'assistant') {
      if (isInternalHistoryAssistantMessage(msg)) continue;
      lines.push('## Assistant', '');
      if (msg.content) {
        lines.push(msg.content, '');
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          lines.push(`### Tool: ${tc.name}`, '');
          if (tc.arguments) {
            lines.push('```json', tc.arguments, '```', '');
          }
        }
      }
    } else if (msg.role === 'tool' && msg.tool_result) {
      const tr = msg.tool_result;
      lines.push(`### Tool Result (${tr.success ? '✓' : '✗'})`, '');
      if (tr.summary) {
        lines.push(tr.summary, '');
      }
    }
  }
  return lines;
}

export type HistoryMutation = Pick<SessionMutationEvent,
  'action' | 'source_index' | 'target_index' | 'text' | 'images' | 'delete_turn'> & { revision?: number };

interface HistoryMutationMessage {
  role: string;
  parts: MsgPart[];
  images?: ImageData[];
  sourceIndex?: number;
}

interface HistoryMutationSurface<T> {
  sessionId: string | null;
  messages: T[];
  turns: SessionTurnOutline[];
  revision?: number;
}

/** Reconcile only the origin session, including a replacement view after A -> B -> A. */
export function reduceSessionHistoryMutation<T extends HistoryMutationMessage>(
  origin: HistoryMutationSurface<T>,
  mutation: HistoryMutation,
  viewed: HistoryMutationSurface<T>,
  target?: T,
): { messages: T[]; turns: SessionTurnOutline[]; reconcileView: boolean; applied: boolean } {
  const reconcileView = origin.sessionId != null && origin.sessionId === viewed.sessionId;
  const surface = reconcileView ? viewed : origin;
  if (mutation.revision != null && origin.revision != null && mutation.revision <= origin.revision) {
    return { messages: surface.messages, turns: surface.turns, reconcileView, applied: false };
  }
  // An ACK's canonical index may now name a different row in an older cached window.
  // Captured identity wins; the caller reloads canonically when that identity is gone.
  const targetPosition = target ? surface.messages.indexOf(target) : -1;
  if (target && targetPosition === -1) {
    return { messages: surface.messages, turns: surface.turns, reconcileView, applied: false };
  }
  let messages = surface.messages;
  let turns = surface.turns;

  if (mutation.action === 'truncate' && mutation.target_index != null) {
    const targetIndex = target?.sourceIndex ?? mutation.target_index;
    const index = target ? targetPosition : messages.findIndex((message) =>
      message.sourceIndex != null && message.sourceIndex >= targetIndex);
    if (index !== -1) messages = messages.slice(0, index);
    turns = turns.filter((turn) => turn.index < targetIndex);
  } else if (mutation.source_index != null) {
    const sourceIndex = target?.sourceIndex ?? mutation.source_index;
    const index = target ? targetPosition
      : messages.findIndex((message) => message.sourceIndex === sourceIndex);
    if (mutation.action === 'patch') {
      if (index !== -1) {
        messages = messages.slice();
        messages[index] = {
          ...messages[index],
          parts: [{ kind: 'text', text: mutation.text ?? '' }],
          images: mutation.images?.length ? mutation.images : undefined,
        };
      }
      turns = turns.map((turn) => turn.index === sourceIndex
        ? { ...turn, text: mutation.text ?? '' } : turn);
    } else if (mutation.action === 'delete') {
      if (index !== -1) {
        let end = index + 1;
        if (mutation.delete_turn) {
          while (end < messages.length && messages[end].role !== 'user') end += 1;
        }
        messages = [...messages.slice(0, index), ...messages.slice(end)];
      }
      if (mutation.delete_turn) {
        turns = turns.filter((turn) => turn.index !== sourceIndex);
      }
    }
  }

  return { messages, turns, reconcileView, applied: true };
}
