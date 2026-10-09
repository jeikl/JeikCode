/**
 * 大模型 Markdown 预处理器。
 *
 * marked 的 GFM 表格要求「表头列数 === 分隔行列数」。模型经常写出：
 *   | 目标 | 协议 |
 *   |---|
 * 这种 2 列表头 + 1 列分隔行，整张表会退化成一段 raw `|...|` 文本。
 * 这里在送进 marked 之前把常见瑕疵修掉，并补齐若干聊天场景常用语法。
 */

export interface FenceState {
  marker: '`' | '~';
  length: number;
  lang?: string;
  matchingCloseIdx?: number;
}

export const MARKDOWN_LANGS = new Set(['markdown', 'md', 'mdx', 'mkd']);

function stripLineBreak(line: string): string {
  return line.replace(/[\r\n]+$/, '');
}

export function fenceOpen(line: string): FenceState | null {
  const raw = stripLineBreak(line);
  let index = 0;
  let indent = 0;
  while (index < raw.length && (raw[index] === ' ' || raw[index] === '\t')) {
    indent += 1;
    index += 1;
  }
  // 容错列表项内的嵌套代码块（多级缩进常达到 4-8 空格）
  if (indent > 8) return null;

  const marker = raw[index];
  if (marker !== '`' && marker !== '~') return null;

  let markerEnd = index;
  while (markerEnd < raw.length && raw[markerEnd] === marker) markerEnd += 1;
  const length = markerEnd - index;
  if (length < 3) return null;

  const info = raw.slice(markerEnd).trim();
  if (marker === '`' && info.includes('`')) return null;
  const lang = info.split(/\s+/)[0]?.toLowerCase() ?? '';
  return { marker, length, lang };
}

export function fenceClose(line: string, state: FenceState): boolean {
  const raw = stripLineBreak(line);
  let index = 0;
  let indent = 0;
  while (index < raw.length && (raw[index] === ' ' || raw[index] === '\t')) {
    indent += 1;
    index += 1;
  }
  if (indent > 8) return false;

  let markerEnd = index;
  while (markerEnd < raw.length && raw[markerEnd] === state.marker) markerEnd += 1;
  const matchLen = markerEnd - index;
  if (matchLen < 3) return false;

  const rest = raw.slice(markerEnd).trim();
  // 闭合围栏必须只有反引号/波浪号（数量足够），严禁带有语言等 info 字符串，杜绝将嵌套代码块开启行误判为闭合
  if (matchLen >= state.length && rest === '') return true;
  return false;
}

/**
 * 探测从 start 行开始，是否存在匹配当前围栏的合法闭合标记。
 * 如果在遇到匹配的闭合标记之前，遇到了另一个明确带语言的新代码块开启：
 * - 对于非 Markdown 容器语言：说明前一个代码块未闭合即断裂，返回 -1 触发自愈；
 * - 对于 Markdown 容器语言：支持嵌套子代码块栈深度，避免内层闭合误伤外层。
 */
export function findMatchingFenceClose(
  lines: string[],
  start: number,
  fence: FenceState,
): number {
  const isMdContainer = MARKDOWN_LANGS.has(fence.lang?.toLowerCase() ?? '');
  let depth = 1;

  for (let k = start; k < lines.length; k++) {
    const raw = stripLineBreak(lines[k]);
    const trimmed = raw.trim();

    // 遇到带语言标签的代码块开启行
    const nextOpen = fenceOpen(lines[k]);
    if (nextOpen && trimmed.length > nextOpen.length) {
      if (isMdContainer) {
        depth += 1;
        continue;
      }
      return -1;
    }

    // 遇到合法的纯闭合围栏
    if (fenceClose(lines[k], fence)) {
      if (depth > 1) {
        depth -= 1;
        continue;
      }
      return k;
    }
  }
  return -1;
}

/**
 * 提升嵌套代码块的外层围栏长度：
 * 当外层代码块（特别是 markdown/md 文档容器）内部包含了子围栏（如内部有 ```markdown 或 ```bash），
 * 若外层反引号数量小于等于内部子围栏，marked 解析器在遇到内部第一个闭合 ``` 时就会错误截断外层代码块，
 * 导致后续内容变成散落富文本并在尾部触发二次反相开启。
 * 本函数自动将外层开启与闭合围栏的反引号长度提升为 `maxInnerLen + 1`（如 4 个反引号），
 * 使得内部所有 3 个反引号的子围栏被完全作为普通代码内容保留，杜绝渲染断裂。
 */
export function promoteNestedCodeFences(raw: string): string {
  if (!raw) return '';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const result = [...lines];

  let i = 0;
  while (i < lines.length) {
    const open = fenceOpen(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }

    const isMdContainer = MARKDOWN_LANGS.has(open.lang?.toLowerCase() ?? '');
    let depth = 1;
    let maxInnerLen = 0;
    let closeIdx = -1;
    let foundSubFence = false;

    for (let k = i + 1; k < lines.length; k++) {
      const line = lines[k];
      const nextOpen = fenceOpen(line);

      // 若内部出现带语言的代码块开启
      if (nextOpen && nextOpen.marker === open.marker && nextOpen.lang) {
        if (isMdContainer) {
          foundSubFence = true;
          maxInnerLen = Math.max(maxInnerLen, nextOpen.length);
          depth += 1;
          continue;
        }
      }

      // 检查纯闭合围栏
      const trimmed = line.trim();
      let mEnd = 0;
      while (mEnd < trimmed.length && trimmed[mEnd] === open.marker) mEnd += 1;
      const isPureClose = mEnd >= 3 && mEnd === trimmed.length;

      if (isPureClose) {
        if (depth > 1) {
          foundSubFence = true;
          maxInnerLen = Math.max(maxInnerLen, mEnd);
          depth -= 1;
        } else if (depth === 1) {
          closeIdx = k;
          break;
        }
      }
    }

    if (foundSubFence && closeIdx !== -1 && maxInnerLen >= open.length) {
      const newLen = Math.max(open.length + 1, maxInnerLen + 1);
      const openMarker = open.marker.repeat(newLen);
      const closeMarker = open.marker.repeat(newLen);

      const rawOpen = lines[i];
      const firstMarker = rawOpen.indexOf(open.marker);
      const indent = rawOpen.slice(0, firstMarker);
      const afterMarker = rawOpen.slice(firstMarker + open.length);
      result[i] = `${indent}${openMarker}${afterMarker}`;

      const rawClose = lines[closeIdx];
      const firstCloseMarker = rawClose.indexOf(open.marker);
      const closeIndent = rawClose.slice(0, firstCloseMarker);
      result[closeIdx] = `${closeIndent}${closeMarker}`;

      i = closeIdx + 1;
    } else if (closeIdx !== -1) {
      i = closeIdx + 1;
    } else {
      i += 1;
    }
  }

  return result.join('\n');
}

const HASH_COMMENT_LANGS = new Set([
  'python',
  'py',
  'bash',
  'sh',
  'zsh',
  'yaml',
  'yml',
  'dockerfile',
  'ruby',
  'rb',
  'r',
  'toml',
  'ini',
  'perl',
  'pl',
  'powershell',
  'ps1',
  'make',
  'makefile',
]);

/**
 * 结构性终结判定：判断当前行是否为明确的外部顶层块级元素
 * 当处于未闭合代码块内部时，若出现明确的外部顶层标题或新的代码块开启，说明模型遗漏了闭合 ```，必须强制自愈闭合上一个代码块。
 * 严禁将数字序号列表 (1. 2.) 或横线分割线 (---) 作为终结符，否则会导致包含测试日志、终端输出的代码块被腰斩破坏！
 */
export function isStructuralTerminator(line: string, currentFence: FenceState): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 1. 如果当前代码块前瞻已知在后续有合法闭合标记，绝对不提前腰斩中断
  if (currentFence.matchingCloseIdx != null && currentFence.matchingCloseIdx >= 0) {
    return false;
  }

  // 2. 如果当前代码块是 Markdown 语言本身，里面的任何 Markdown 语法均属合法代码，绝不中断
  const lang = currentFence.lang?.toLowerCase() ?? '';
  if (MARKDOWN_LANGS.has(lang)) {
    return false;
  }

  // 3. 遇到另一个明确开启新语言代码块的行（例如上一块漏闭合，直接开启新的 ```rust）
  const opening = fenceOpen(line);
  if (opening && trimmed.length > opening.length) {
    return true;
  }

  // 4. 对于以 # 作为注释的语言，普通注释绝对不能当作 ATX 标题中断代码块
  if (HASH_COMMENT_LANGS.has(lang)) {
    return false;
  }

  // 5. 其他非 # 注释语言，若遇到明确的外部顶层大纲标题（如 # 标题、#### 2. 标题）且前面未闭合
  if (/^#{1,6}\s+\S+/.test(trimmed)) {
    return true;
  }

  return false;
}

export function hasUnescapedPipe(line: string): boolean {
  let escaped = false;
  for (const ch of line) {
    if (ch === '\\') {
      escaped = !escaped;
      continue;
    }
    if (ch === '|' && !escaped) return true;
    escaped = false;
  }
  return false;
}

/** 与 marked.splitCells 对齐：按未转义 `|` 切单元格。 */
export function splitTableCells(line: string): string[] {
  const row = line.replace(/\|/g, (match, offset, str: string) => {
    let escaped = false;
    let curr = offset as number;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isDelimiterCell(cell: string): boolean {
  return /^\s*:?-+:?\s*$/.test(cell) && cell.includes('-');
}

export function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const cells = splitTableCells(trimmed);
  return cells.length >= 1 && cells.every(isDelimiterCell);
}

function isStrictPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && splitTableCells(trimmed).length >= 2;
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return (
    /^#{1,6}\s/.test(trimmed) ||
    /^>/.test(trimmed) ||
    /^([-+*]|\d+[.)])\s/.test(trimmed) ||
    /^(```|~~~)/.test(trimmed) ||
    /^([-*_]\s*){3,}$/.test(trimmed)
  );
}

function parseAligns(cells: string[]): Array<'left' | 'right' | 'center' | null> {
  return cells.map((cell) => {
    const raw = cell.trim();
    const left = raw.startsWith(':');
    const right = raw.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

export function buildTableDelimiter(
  columns: number,
  existingCells: string[] = [],
): string {
  const aligns = parseAligns(existingCells);
  const parts: string[] = [];
  for (let i = 0; i < columns; i++) {
    const align = aligns[i];
    if (align === 'left') parts.push(':---');
    else if (align === 'right') parts.push('---:');
    else if (align === 'center') parts.push(':---:');
    else parts.push('---');
  }
  return `| ${parts.join(' | ')} |`;
}

function replaceFullwidthPipes(line: string): string {
  if (!line.includes('｜')) return line;
  let escaped = false;
  let out = '';
  for (const ch of line) {
    if (ch === '\\') {
      escaped = !escaped;
      out += ch;
      continue;
    }
    out += ch === '｜' && !escaped ? '|' : ch;
    escaped = false;
  }
  return out;
}

function fixAtxHeading(line: string): string {
  const headingMatch = line.match(/^(\s*)(#{1,6})([^\s#].*)$/);
  if (!headingMatch) return line;
  return `${headingMatch[1]}${headingMatch[2]} ${headingMatch[3]}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Unicode punctuation — CommonMark flanking rules treat these like ASCII punct. */
function isUnicodePunctuation(ch: string): boolean {
  return /\p{P}/u.test(ch);
}

function isUnicodeWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

/**
 * CommonMark will not open/close `**…**` when the run sits against punctuation
 * without a whitespace/punct neighbor (e.g. `的**“标题”**以及`). Chinese curly
 * quotes therefore leave literal `**` in the HTML. Convert those spans to
 * `<strong>` before marked runs.
 */
export function repairCjkPunctuationEmphasis(text: string): string {
  if (!text.includes('**') && !text.includes('__')) return text;

  const replaceStrong = (source: string, marker: '**' | '__'): string => {
    const out: string[] = [];
    let index = 0;
    while (index < source.length) {
      const start = source.indexOf(marker, index);
      if (start === -1) {
        out.push(source.slice(index));
        break;
      }
      out.push(source.slice(index, start));
      if (start > 0 && source[start - 1] === marker[0]) {
        // Part of a longer run (*** / ___); leave literal.
        out.push(marker);
        index = start + marker.length;
        continue;
      }
      const innerStart = start + marker.length;
      const end = source.indexOf(marker, innerStart);
      if (end === -1) {
        out.push(source.slice(start));
        break;
      }
      if (end + marker.length < source.length && source[end + marker.length] === marker[0]) {
        out.push(source.slice(start, end + marker.length));
        index = end + marker.length;
        continue;
      }
      const inner = source.slice(innerStart, end);
      if (!inner || inner.includes('\n')) {
        out.push(source.slice(start, end + marker.length));
        index = end + marker.length;
        continue;
      }
      const chars = Array.from(inner);
      const first = chars[0];
      const last = chars[chars.length - 1];
      const prev = start > 0 ? source[start - 1] : ' ';
      const next =
        end + marker.length < source.length ? source[end + marker.length] : ' ';
      const openBroken =
        isUnicodePunctuation(first) &&
        !isUnicodeWhitespace(prev) &&
        !isUnicodePunctuation(prev);
      const closeBroken =
        isUnicodePunctuation(last) &&
        !isUnicodeWhitespace(next) &&
        !isUnicodePunctuation(next);
      if (openBroken || closeBroken) {
        out.push(`<strong>${escapeHtml(inner)}</strong>`);
      } else {
        out.push(source.slice(start, end + marker.length));
      }
      index = end + marker.length;
    }
    return out.join('');
  };

  return replaceStrong(replaceStrong(text, '**'), '__');
}

function footnoteSlug(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'fn';
}

function mapInlineOutsideBackticks(line: string, fn: (chunk: string) => string): string {
  let result = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`') {
      const next = line.indexOf('`', index);
      const chunk = next === -1 ? line.slice(index) : line.slice(index, next);
      result += fn(chunk);
      index = next === -1 ? line.length : next;
      continue;
    }
    let ticksEnd = index;
    while (ticksEnd < line.length && line[ticksEnd] === '`') ticksEnd += 1;
    const ticks = ticksEnd - index;
    const closer = '`'.repeat(ticks);
    const closeAt = line.indexOf(closer, ticksEnd);
    if (closeAt === -1) {
      result += fn(line.slice(index));
      break;
    }
    result += line.slice(index, closeAt + ticks);
    index = closeAt + ticks;
  }
  return result;
}

function applyInlineMarkdown(source: string, footnoteIds: Map<string, number>): string {
  const lines = source.split('\n');
  let openFence: FenceState | null = null;
  return lines.map((line) => {
    if (openFence) {
      if (fenceClose(line, openFence)) openFence = null;
      return line;
    }
    const opening = fenceOpen(line);
    if (opening) {
      openFence = opening;
      return line;
    }
    return mapInlineOutsideBackticks(line, (chunk) => {
      let text = chunk;
      if (footnoteIds.size) {
        text = text.replace(/\[\^([^\]]+)\]/g, (match, id: string) => {
          const n = footnoteIds.get(id);
          if (!n) return match;
          const slug = footnoteSlug(id);
          return `<sup class="md-footnote-ref"><a href="#md-fn-${slug}" id="md-fnref-${slug}">${n}</a></sup>`;
        });
      }
      // ==高亮==：GFM 没有，但模型经常输出。避开 === 标题线。
      text = text.replace(/==([^=\n]+?)==/g, (_m, inner: string) => {
        return `<mark class="md-highlight">${escapeHtml(inner)}</mark>`;
      });
      // 中文弯引号等标点紧贴 **…** 时 CommonMark 不认强调，预转成 <strong>。
      text = repairCjkPunctuationEmphasis(text);
      return text;
    });
  }).join('\n');
}

export function repairUnclosedFences(source: string): string {
  const text = String(source ?? '');
  let open: FenceState | null = null;
  for (const line of text.split('\n')) {
    if (!open) open = fenceOpen(line);
    else if (fenceClose(line, open)) open = null;
  }
  if (!open) return text;
  const fence = open.marker.repeat(open.length);
  return `${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
}

const GENERIC_LANG = new Set(['', 'text', 'plain', 'plaintext', 'txt', 'output', 'console']);

/** 去掉代码块正文里重复的语言行，例如 ```text 下面第一行又是 text。 */
export function stripLanguageSentinel(code: string, lang: string): string {
  const trailingNl = code.endsWith('\n');
  const text = trailingNl ? code.slice(0, -1) : code;
  const nl = text.indexOf('\n');
  if (nl <= 0) return code;
  const first = text.slice(0, nl).trim().toLowerCase();
  if (!first) return code;
  const langNorm = (lang ?? '').trim().toLowerCase();
  const matchesLang = !!langNorm && first === langNorm;
  const genericLoose = !langNorm && GENERIC_LANG.has(first);
  if (!matchesLang && !genericLoose) return code;
  const rest = text.slice(nl + 1);
  return trailingNl ? `${rest}\n` : rest;
}

export function shouldShowCodeLanguage(lang: string): boolean {
  const normalized = (lang ?? '').trim().toLowerCase();
  return !!normalized && !GENERIC_LANG.has(normalized);
}

/**
 * 鲁棒性 Markdown 预处理器：
 * 1. 保护围栏代码块；
 * 2. 补全 ATX 标题 `#` 后空格；
 * 3. 修复 GFM 表格分隔行列数、缺分隔行、全角竖线；
 * 4. 表格前后补空行，避免后续正文被吞进表格；
 * 5. 未闭合围栏自动补闭合；
 * 6. 脚注、==高亮==。
 */
export function preprocessMarkdown(raw: string): string {
  if (!raw) return '';
  const prepared = promoteNestedCodeFences(raw);
  const lines = prepared.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  let inFence: FenceState | null = null;
  let inTable = false;
  const footnotes: { id: string; n: number; def: string }[] = [];
  const footnoteIds = new Map<string, number>();

  const prevBlank = (): boolean => result.length === 0 || result[result.length - 1].trim() === '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // ★ 智能解开模型误加的 4 空格缩进富文本块：
    // 在非围栏代码块外，如果一行文本缩进了 4+ 个空格，但其内容明显是 Markdown 块级结构（如标题、水平线、新的围栏代码块、列表项），
    // 将其多余的前置 4 空格缩进剥除，彻底避免 marked 误将其判定为 Indented Code Block 导致富文本降级为纯文本或灰色框！
    if (!inFence && /^(?: {4}|\t)(?:#{1,6}\s+|[-*_]{3,}\s*$|(?:```|~~~)|[-*+]\s+|\d+\.\s+)/.test(line)) {
      line = line.replace(/^(?: {4}|\t)/, '');
    }

    // ★ 智能拆解与前置文本/列表项粘连的围栏开启标记（如 `- **代码现状**：```rust` 或 `示例：```ts`）：
    // CommonMark 规范要求代码块围栏必须独占一行，若与列表项前缀或冒号粘连，marked 无法将其视作代码块开启；
    // 进而导致随后的正常闭合 ``` 被反向误判为开启，将其后的全部列表与正文吞噬为灰色代码框！
    // 自动将其拆解为独立两行（前置文本行 + 纯净代码块开启行）。
    if (!inFence) {
      const gluedFence = line.match(/^(\s*(?:[-*+]|\d+\.|\S.*?[：:])\s*)((?:```|~~~)[a-zA-Z0-9_-]*\s*)$/);
      if (gluedFence && gluedFence[1].trim()) {
        lines.splice(i, 1, gluedFence[1], gluedFence[2]);
        line = lines[i];
      }
    }

    if (inFence) {
      if (fenceClose(line, inFence)) {
        // 若代码块内最后一行以奇数个反斜杠 `\` 结尾（如 Windows 路径 C:\foo\），
        // marked 会把 `\` + `\n` 当作换行转义，导致闭合围栏 ``` 被粘进上一行而无法闭合代码块，
        // 进而把整篇后续文本全吞进一个未闭合代码块。追加空格消除转义，确保围栏正常闭合。
        if (result.length > 0) {
          const prev = result[result.length - 1];
          let slashes = 0;
          for (let k = prev.length - 1; k >= 0 && prev[k] === '\\'; k--) {
            slashes++;
          }
          if (slashes % 2 === 1) {
            result[result.length - 1] = prev + ' ';
          }
        }
        // ★ 核心修复：闭合围栏必须规范化为顶格纯净闭合标记，消除前置 4+ 空格缩进！
        // 杜绝 CommonMark 规范因缩进 >= 4 空格而拒绝将其当成闭合标记，导致代码块持续吞噬正文！
        const cleanClose = inFence.marker.repeat(inFence.length);
        inFence = null;
        result.push(cleanClose);
        continue;
      }

      // ★ 结构性终结自愈：代码块内部若遇到明确的外部顶层块级元素
      // （如明确的 ATX 标题 ^#{1,6}\s+、新的围栏代码块开启），
      // 说明上一个代码块模型漏打了闭合 ```！
      // 必须立刻在 result 中补上闭合围栏，强制终结代码块，并将本行正常放行到后续流程解析！
      if (isStructuralTerminator(line, inFence)) {
        const fence = inFence.marker.repeat(inFence.length);
        result.push(fence);
        inFence = null;
        // 不 continue，让本行（标题/新代码块）正常流向下方的块级处理！
      } else {
        result.push(line);
        continue;
      }
    }

    const opening = fenceOpen(line);
    if (opening) {
      if (inTable) {
        if (!prevBlank()) result.push('');
        inTable = false;
      }
      // 开启围栏也规范化消除多余的前置缩进，确保 marked 100% 识别
      const markerIdx = line.indexOf(opening.marker);
      const matchIdx = findMatchingFenceClose(lines, i + 1, opening);
      const isUnclosedMermaid = matchIdx === -1 && opening.lang?.toLowerCase() === 'mermaid';
      const cleanOpen = isUnclosedMermaid
        ? `${opening.marker.repeat(opening.length)}mermaid-streaming`
        : `${opening.marker.repeat(opening.length)}${line.slice(markerIdx + opening.length)}`;
      result.push(cleanOpen);
      inFence = { ...opening, matchingCloseIdx: matchIdx };
      continue;
    }

    line = replaceFullwidthPipes(line);
    line = fixAtxHeading(line);
    const trimmed = line.trim();

    const footnoteDef = trimmed.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (footnoteDef) {
      const id = footnoteDef[1];
      if (!footnoteIds.has(id)) {
        footnoteIds.set(id, footnotes.length + 1);
        footnotes.push({ id, n: footnotes.length + 1, def: footnoteDef[2] });
      }
      continue;
    }

    if (inTable) {
      if (!trimmed || (isMarkdownBlockStart(line) && !hasUnescapedPipe(line))) {
        inTable = false;
      } else if (hasUnescapedPipe(line) || isTableDelimiterLine(line)) {
        result.push(line);
        const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
        if (nextLine != null) {
          const nextTrimmed = nextLine.trim();
          if (
            nextTrimmed !== '' &&
            !hasUnescapedPipe(nextLine) &&
            !isTableDelimiterLine(nextLine) &&
            !isMarkdownBlockStart(nextLine)
          ) {
            result.push('');
            inTable = false;
          } else if (!nextTrimmed || (isMarkdownBlockStart(nextLine) && !hasUnescapedPipe(nextLine))) {
            inTable = false;
          }
        }
        continue;
      } else {
        if (!prevBlank()) result.push('');
        inTable = false;
      }
    }

    const isHeading = /^\s*#{1,6}\s+/.test(line);
    const openingNow = fenceOpen(line);
    if ((isHeading || openingNow) && result.length > 0) {
      const prevLine = result[result.length - 1].trim();
      if (prevLine !== '' && !prevLine.startsWith('#')) {
        result.push('');
      }
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
    const nextIsDelim = nextLine != null && isTableDelimiterLine(nextLine);

    if (hasUnescapedPipe(line) && nextIsDelim) {
      const columns = splitTableCells(line).length;
      const delimRaw = nextLine!.trim();
      // 裸 `---` 是 setext/hr；只有表头已经以 | 开头、或分隔行自带 |/: 时才当成表格。
      if (columns >= 1 && (delimRaw.includes('|') || delimRaw.includes(':') || line.trim().startsWith('|'))) {
        if (!prevBlank()) result.push('');
        result.push(line);
        const delimCells = splitTableCells(nextLine!);
        if (delimCells.length !== columns || !/[:|]/.test(delimRaw)) {
          result.push(buildTableDelimiter(columns, delimCells));
          i += 1;
        }
        inTable = true;
        continue;
      }
    }

    // 模型常省略分隔行：两行都是 | a | b | 形态时补一行 ---。
    if (
      isStrictPipeRow(line) &&
      nextLine != null &&
      isStrictPipeRow(nextLine) &&
      !isTableDelimiterLine(nextLine)
    ) {
      const columns = splitTableCells(line).length;
      if (columns >= 2) {
        if (!prevBlank()) result.push('');
        result.push(line);
        result.push(buildTableDelimiter(columns));
        inTable = true;
        continue;
      }
    }

    result.push(line);
  }

  if (inFence) {
    const fence = inFence.marker.repeat(inFence.length);
    if (result.length === 0 || result[result.length - 1] !== fence) result.push(fence);
  }

  let text = result.join('\n');
  text = applyInlineMarkdown(text, footnoteIds);
  if (footnotes.length) {
    const items = footnotes
      .map((fn) => {
        const slug = footnoteSlug(fn.id);
        return `<li id="md-fn-${slug}">${escapeHtml(fn.def)} <a href="#md-fnref-${slug}" class="md-footnote-back">↩</a></li>`;
      })
      .join('\n');
    text += `\n\n<div class="md-footnotes"><hr>\n<ol>\n${items}\n</ol></div>\n`;
  }
  return text;
}
