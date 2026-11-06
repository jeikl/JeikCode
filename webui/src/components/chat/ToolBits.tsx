import { colorizeInlineJson } from '../../lib/toolDisplay';
import { highlightText } from './highlight';

export function ToolArgPreview({ text, search }: { text: string; search?: string }) {
  // 搜索命中时走纯文本高亮分支：JSON 着色是「一段一个 span」的结构化输出，
  // 在里面插 <mark> 会把 token 切断。命中优先于配色（和浏览器 Ctrl+F 一致）。
  const query = (search ?? '').trim().toLowerCase();
  if (query && text.toLowerCase().includes(query)) {
    return (
      <span class="tool-name-secondary notranslate" translate={false} title={text}>
        {highlightText(text, search ?? '')}
      </span>
    );
  }
  // The text is never shortened; only skip JSON span coloring for pathological
  // payloads so a huge write/edit argument cannot explode the header DOM.
  const spans = text.length <= 20_000 ? colorizeInlineJson(text) : null;
  if (!spans) {
    return <span class="tool-name-secondary notranslate" translate={false} title={text}>{text}</span>;
  }
  return (
    <span class="tool-name-secondary notranslate" translate={false} title={text}>
      {spans.map((span, i) => (
        <span key={i} class={'json-tok json-tok-' + span.tone + ' notranslate'} translate={false}>{span.text}</span>
      ))}
    </span>
  );
}

export function ToolStatusIcon({ cls }: { cls: string }) {
  const spin = cls === 'pending' || cls === 'waiting';
  return (
    <svg
      class={'tool-status-icon' + (spin ? ' spin' : '')}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {cls === 'success' ? (
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      ) : cls === 'error' ? (
        <path d="M4 4l8 8M12 4l-8 8" />
      ) : cls === 'warning' ? (
        <path d="M8 2.5 14 13H2L8 2.5ZM8 6v3.5M8 11.5h.01" />
      ) : (
        <path d="M8 2.5a5.5 5.5 0 1 1-5.18 3.65" />
      )}
    </svg>
  );
}

export function DiffStatBadge({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span class="diff-stat-badge" aria-label={`+${additions} -${deletions}`}>
      {additions > 0 && <span class="diff-stat-add">+{additions}</span>}
      {deletions > 0 && <span class="diff-stat-del">-{deletions}</span>}
    </span>
  );
}
