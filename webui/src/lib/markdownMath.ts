import katex from 'katex';

export type MathSlot = {
  tex: string;
  display: boolean;
};

const TOKEN = (i: number) => `\uE000MATH${i}\uE001`;
const TOKEN_RE = /\uE000MATH(\d+)\uE001/g;

function findUnescaped(haystack: string, needle: string, from: number): number {
  let index = from;
  while (index < haystack.length) {
    const at = haystack.indexOf(needle, index);
    if (at === -1) return -1;
    let slashes = 0;
    for (let i = at - 1; i >= 0 && haystack[i] === '\\'; i--) slashes += 1;
    if (slashes % 2 === 0) return at;
    index = at + needle.length;
  }
  return -1;
}

function skipInlineCode(source: string, start: number): number {
  let ticks = 0;
  while (start + ticks < source.length && source[start + ticks] === '`') ticks += 1;
  if (ticks === 0) return start;
  const closer = '`'.repeat(ticks);
  const closeAt = source.indexOf(closer, start + ticks);
  return closeAt === -1 ? source.length : closeAt + ticks;
}

function fenceKind(line: string): { marker: '`' | '~'; length: number } | null {
  const match = /^( {0,3})([`~]{3,})/.exec(line);
  if (!match) return null;
  return { marker: match[2][0] as '`' | '~', length: match[2].length };
}

function isFenceClose(line: string, kind: { marker: '`' | '~'; length: number }): boolean {
  const match = /^( {0,3})([`~]{3,})\s*$/.exec(line);
  if (!match || match[2][0] !== kind.marker) return false;
  return match[2].length >= kind.length;
}

/** `$100` / `$1,299.00` are money, not TeX. */
export function looksLikeCurrency(inner: string): boolean {
  return /^\d/.test(inner.trim());
}

function extractInProse(source: string, slots: MathSlot[]): string {
  let out = '';
  let pos = 0;
  while (pos < source.length) {
    if (source[pos] === '`') {
      const next = skipInlineCode(source, pos);
      out += source.slice(pos, next);
      pos = next;
      continue;
    }
    if (source.startsWith('$$', pos)) {
      const close = findUnescaped(source, '$$', pos + 2);
      if (close !== -1) {
        out += TOKEN(slots.length);
        slots.push({ tex: source.slice(pos + 2, close), display: true });
        pos = close + 2;
        continue;
      }
    }
    if (source.startsWith('\\[', pos)) {
      const close = findUnescaped(source, '\\]', pos + 2);
      if (close !== -1) {
        out += TOKEN(slots.length);
        slots.push({ tex: source.slice(pos + 2, close), display: true });
        pos = close + 2;
        continue;
      }
    }
    if (source.startsWith('\\(', pos)) {
      const close = findUnescaped(source, '\\)', pos + 2);
      if (close !== -1) {
        out += TOKEN(slots.length);
        slots.push({ tex: source.slice(pos + 2, close), display: false });
        pos = close + 2;
        continue;
      }
    }
    if (source[pos] === '$' && source[pos + 1] !== '$') {
      const close = findUnescaped(source, '$', pos + 1);
      if (close !== -1 && source[close + 1] !== '$') {
        const inner = source.slice(pos + 1, close);
        if (
          inner &&
          !inner.includes('\n') &&
          !/^\s/.test(inner) &&
          !/\s$/.test(inner) &&
          !looksLikeCurrency(inner)
        ) {
          out += TOKEN(slots.length);
          slots.push({ tex: inner, display: false });
          pos = close + 1;
          continue;
        }
      }
    }
    out += source[pos];
    pos += 1;
  }
  return out;
}

/**
 * Pull TeX out of markdown so marked / GFM / **bold** cannot eat `$`, `~`, `_`.
 * Supports `$$ $$`, `$ $`, `\[ \]`, `\( \)` outside fences and inline code.
 */
export function extractMath(source: string): { text: string; slots: MathSlot[] } {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const slots: MathSlot[] = [];
  const out: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let fenceBuf: string[] = [];

  const flushProse = (chunk: string[]) => {
    if (!chunk.length) return;
    out.push(extractInProse(chunk.join('\n'), slots));
  };

  let prose: string[] = [];
  for (const line of lines) {
    if (fence) {
      fenceBuf.push(line);
      if (isFenceClose(line, fence)) {
        out.push(fenceBuf.join('\n'));
        fenceBuf = [];
        fence = null;
      }
      continue;
    }
    const open = fenceKind(line);
    if (open) {
      flushProse(prose);
      prose = [];
      fence = open;
      fenceBuf = [line];
      continue;
    }
    prose.push(line);
  }
  if (fence) out.push(fenceBuf.join('\n'));
  else flushProse(prose);

  return { text: out.join('\n'), slots };
}

export function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      trust: false,
      strict: 'ignore',
    });
  } catch {
    const esc = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return display
      ? `<pre class="md-math-fallback">${esc}</pre>`
      : `<code class="md-math-fallback">${esc}</code>`;
  }
}

export function restoreMath(html: string, slots: MathSlot[]): string {
  if (!slots.length) return html;
  return html.replace(TOKEN_RE, (match, n: string) => {
    const slot = slots[Number(n)];
    if (!slot) return match;
    const rendered = renderTex(slot.tex, slot.display);
    return slot.display ? `<div class="md-math-display">${rendered}</div>` : rendered;
  });
}
