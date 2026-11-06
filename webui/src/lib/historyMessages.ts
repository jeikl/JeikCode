import type { SessionMessage } from '../api';
import {
  isInternalHistoryUserMessage,
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
} from './wire/legacy.ts';

export {
  isInternalHistoryUserMessage,
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
} from './wire/legacy.ts';

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
