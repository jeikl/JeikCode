import type { CanvasRecord as Message } from '../../lib/canvas/records';
import { formatToolDetail, formatToolPayload } from '../../lib/toolDisplay';
import { displayToolName } from './toolName';

export function messageText(m: Message): string {
  return m.parts.reduce((acc, p) => {
    if (p.kind === 'text' || p.kind === 'reasoning') return acc + p.text;
    return acc;
  }, '');
}

export function messageHasTools(m: Message): boolean {
  return m.parts.some((p) => p.kind === 'tool');
}

export function messageFullText(m: Message): string {
  const lines: string[] = [];
  for (const p of m.parts) {
    if (p.kind === 'text') {
      lines.push(p.text);
    } else if (p.kind === 'tool') {
      const tool = p.tool;
      lines.push(`🔧 ${displayToolName(tool.name)}`);
      const detail = formatToolDetail(tool.name, tool.args);
      if (detail) lines.push(`   ${detail}`);
      if (tool.args) lines.push(`   参数: ${formatToolPayload(tool.args)}`);
      if (tool.output) lines.push(`   输出: ${tool.output}`);
    } else if (p.kind === 'notice') {
      lines.push(p.text);
    } else if (p.kind === 'rate_limited') {
      lines.push(p.text);
    }
  }
  return lines.join('\n');
}
