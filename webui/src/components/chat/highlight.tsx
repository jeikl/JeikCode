import type { VNode } from 'preact';

export function highlightText(text: string, search: string): string | Array<string | VNode> {
  if (!search.trim()) return text;
  const searchLower = search.toLowerCase();
  const index = text.toLowerCase().indexOf(searchLower);
  if (index === -1) return text;

  const parts: (string | VNode)[] = [];
  let lastIndex = 0;
  let idx = index;
  let key = 0;
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(text.substring(lastIndex, idx));
    }
    parts.push(
      <mark key={key++} class="msg-search-highlight">
        {text.substring(idx, idx + search.length)}
      </mark>,
    );
    lastIndex = idx + search.length;
    idx = text.toLowerCase().indexOf(searchLower, lastIndex);
  }
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  return parts;
}
