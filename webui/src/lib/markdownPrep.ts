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
  quotePrefix?: string;
  matchingCloseIdx?: number;
}

export const MARKDOWN_LANGS = new Set(['markdown', 'md', 'mdx', 'mkd']);

export const TEXT_CONTAINER_LANGS = new Set([
  '',
  'text',
  'plain',
  'plaintext',
  'txt',
  'prompt',
  'prompts',
  'rules',
  'guide',
  'instructions',
  'chat',
  'chatml',
  'system',
  'user',
  'assistant',
  'doc',
  'docs',
  'documentation',
  'output',
  'console',
  'log',
  'logs',
  'terminal',
  'shell-session',
  'error',
  'err',
  'markdown',
  'md',
  'mdx',
  'mkd',
]);

function stripLineBreak(line: string): string {
  return line.replace(/[\r\n]+$/, '');
}

function parseFenceLeading(raw: string): { index: number; quotePrefix: string; indent: number } {
  let idx = 0;
  let indent = 0;
  let quotePrefix = '';
  while (idx < raw.length) {
    const ch = raw[idx];
    if (ch === ' ' || ch === '\t') {
      indent += 1;
      idx += 1;
    } else if (ch === '>') {
      quotePrefix = raw.slice(0, idx + 1);
      idx += 1;
      indent = 0;
      while (idx < raw.length && (raw[idx] === ' ' || raw[idx] === '\t')) {
        quotePrefix += raw[idx];
        idx += 1;
      }
    } else {
      break;
    }
  }
  return { index: idx, quotePrefix, indent };
}

export function fenceOpen(line: string): FenceState | null {
  const raw = stripLineBreak(line);
  const { index, quotePrefix, indent } = parseFenceLeading(raw);
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
  return { marker, length, lang, quotePrefix };
}

export function fenceClose(line: string, state: FenceState): boolean {
  const raw = stripLineBreak(line);
  const { index, indent } = parseFenceLeading(raw);
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
 * info 串是否是一个「像语言标签」的 token（rust / diff / json / c++ / c# / mermaid-streaming / toml / rust,no_run …）。
 *
 * ★ 关键防御：围栏正文里经常出现以 ``` 开头的散文行（如 ` ``` + 【执行铁律】… `、` ``` 这是示例 `）。
 * 按 CommonMark 它们确实是「带 info 串的开围栏」，但在一个已开启的围栏内部属于普通内容。
 * 若不加甄别而把这行当成「嵌套子围栏」，promoteNestedCodeFences 会错误提升外层围栏长度、
 * 并把错误的行改写为闭合，导致围栏长度 desync → 后续正文被吞进代码块（渲染成一片乱码画布）。
 * ★ 输入形态：调用方传入的是 `fenceOpen` 已按空白切分后的**首个 token**（`rust,no_run` 整体、
 * `js title="x"` 只取 `js`），并非整条多词 info 串。因此判定只需满足「以 ASCII 字母开头」，
 * 其后允许字母数字与常见语言/属性符号（`+ # . , : @ / = _ -`）；中文、空白、反引号等散文特征
 * 一律排除（`+ ...`、`这是示例` 被拒，`rust,no_run` 放行）。
 */
const LANGUAGE_INFO_RE = /^[a-z][a-z0-9_+.#,\-:/@=]*$/;
export function isLanguageLikeInfo(lang: string | undefined): boolean {
  return LANGUAGE_INFO_RE.test((lang ?? '').trim().toLowerCase());
}

/**
 * 探测从 start 行开始，是否存在匹配当前围栏的合法闭合标记。
 * 如果在遇到匹配的闭合标记之前，遇到了另一个明确带语言的新代码块开启：
 * - 对于 Markdown 容器或文本/提示词语言：支持嵌套子代码块栈深度，避免内层闭合误伤外层。
 * - 对于明确的代码语言：说明前一个代码块未闭合即断裂，返回 -1 触发自愈；
 */
export function findMatchingFenceClose(
  lines: string[],
  start: number,
  fence: FenceState,
): number {
  const isContainer = MARKDOWN_LANGS.has(fence.lang?.toLowerCase() ?? '') || TEXT_CONTAINER_LANGS.has(fence.lang?.toLowerCase() ?? '');
  let depth = 1;

  for (let k = start; k < lines.length; k++) {
    const raw = stripLineBreak(lines[k]);
    const trimmed = raw.trim();

    // 遇到带语言标签的代码块开启行（★ 必须是「像语言标签」的 info 串，散文行不算，否则会误判嵌套）
    const nextOpen = fenceOpen(lines[k]);
    if (
      nextOpen &&
      nextOpen.marker === fence.marker &&
      isLanguageLikeInfo(nextOpen.lang) &&
      trimmed.length > nextOpen.length
    ) {
      // 关键防御：如果内部围栏长度严格小于外层围栏长度（例如 4 反引号包裹 3 反引号），
      // 内部围栏在 CommonMark 规范下纯属普通内容，绝不构成断裂！放行继续查找！
      if (nextOpen.length < fence.length) {
        continue;
      }
      if (isContainer) {
        depth += 1;
        continue;
      } else {
        // 对于明确的代码语言（非容器）：若尚未闭合就遇到了另一个明确带语言的新代码块开启，
        // 说明当前代码块未闭合即断裂，返回 -1 触发自愈，绝不能跨越新代码块去贪婪匹配
        return -1;
      }
    }

    // 遇到合法的纯闭合围栏（必须大于等于外层长度）
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
 * 当代码块内部包含了子围栏（无论外层是 Markdown 容器还是嵌入文档代码块），
 * 若外层反引号数量小于等于内部子围栏，marked 解析器在遇到内部第一个闭合 ``` 时就会错误截断外层代码块，
 * 导致后续内容变成散落富文本并在尾部触发二次反相开启。
 * 本函数自动将外层开启与闭合围栏的反引号长度提升为 `maxInnerLen + 1`（如 4 个反引号），
 * 使得内部所有 3 个反引号的子围栏被完全作为普通代码内容保留，彻底杜绝渲染断裂与正文被吞。
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

    const lang = open.lang?.toLowerCase() ?? '';
    const isMarkdownContainer = MARKDOWN_LANGS.has(lang);
    const isDiff = lang === 'diff' || lang === 'patch';

    let depth = 1;
    let maxInnerLen = 0;
    let closeIdx = -1;
    let foundSubFence = false;

    for (let k = i + 1; k < lines.length; k++) {
      const line = lines[k];
      const nextOpen = fenceOpen(line);

      // 若内部出现「像语言标签」的代码块开启（通用支持所有编程语言与 diff 内部的嵌套保护）
      // ★ 关键防御：围栏正文里的散文行（如 ` ``` + 【执行铁律】… `）info 串不是语言，
      // 绝不能当作子围栏，否则会错误提升外层围栏长度并错位改写闭合行，导致围栏 desync。
      if (nextOpen && nextOpen.marker === open.marker && isLanguageLikeInfo(nextOpen.lang)) {
        foundSubFence = true;
        maxInnerLen = Math.max(maxInnerLen, nextOpen.length);
        depth += 1;
        continue;
      }

      // 检查纯闭合围栏（支持可选引用前缀）
      const rawLine = stripLineBreak(line);
      const lead = parseFenceLeading(rawLine);
      let mEnd = lead.index;
      while (mEnd < rawLine.length && rawLine[mEnd] === open.marker) mEnd += 1;
      const curMarkerLen = mEnd - lead.index;
      const isPureClose = curMarkerLen >= 3 && rawLine.slice(mEnd).trim() === '';

      // ★ 核心修复：在 diff / patch 代码块内部，带有 diff 行前缀（如 `+``` ` 或 `-``` `）的行，
      // 属于被对比代码在 diff 上下文中的内部闭合行，必须消费内部嵌套 depth，
      // 绝不能让其遗留 depth 导致末尾真正的纯闭合围栏被误吞！
      const isDiffInnerClose = isDiff && /^[\+\-]\s*`{3,}/.test(rawLine);

      if (isPureClose || isDiffInnerClose) {
        if (depth > 1) {
          foundSubFence = true;
          maxInnerLen = Math.max(maxInnerLen, curMarkerLen >= 3 ? curMarkerLen : open.length);
          depth -= 1;
        } else if (depth === 1 && isPureClose) {
          closeIdx = k;
          break;
        }
      }
    }

    // 关键黄金防线：
    // 1. 如果成功找到外层闭合 closeIdx，且内部有子围栏，成对提升开启与闭合围栏；
    // 2. 对于 Markdown 容器语言，若处于流式生成中（closeIdx === -1），提升开启以便 repairUnclosedFences 在末尾对齐补全；
    // 3. 对于普通代码块（如 diff, rust 等），若找不到闭合（closeIdx === -1），绝对不能单方面提升开启，避免破坏 3 字符闭合导致吞噬正文！
    const canPromote = foundSubFence && maxInnerLen >= open.length && (closeIdx !== -1 || isMarkdownContainer);
    if (canPromote) {
      const newLen = Math.max(open.length + 1, maxInnerLen + 1);
      const openMarker = open.marker.repeat(newLen);

      const rawOpen = lines[i];
      const firstMarker = rawOpen.indexOf(open.marker);
      const indent = rawOpen.slice(0, firstMarker);
      const afterMarker = rawOpen.slice(firstMarker + open.length);
      result[i] = `${indent}${openMarker}${afterMarker}`;

      if (closeIdx !== -1) {
        const closeMarker = open.marker.repeat(newLen);
        const rawClose = lines[closeIdx];
        const firstCloseMarker = rawClose.indexOf(open.marker);
        const closeIndent = rawClose.slice(0, firstCloseMarker);
        result[closeIdx] = `${closeIndent}${closeMarker}`;
        i = closeIdx + 1;
      } else {
        i += 1;
      }
    } else if (closeIdx !== -1) {
      i = closeIdx + 1;
    } else {
      i += 1;
    }
  }

  return result.join('\n');
}

/**
 * 语言别名规范化映射表：将各种变体或不规范输入归一化为标准的 Prism 语言标识符
 */
export function normalizeCodeLanguage(raw: string): string {
  const l = (raw ?? '').trim().toLowerCase();
  switch (l) {
    case 'c#':
    case 'cs':
      return 'csharp';
    case 'c++':
    case 'cxx':
      return 'cpp';
    case 'py':
    case 'python3':
      return 'python';
    case 'rs':
      return 'rust';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'sh':
    case 'zsh':
    case 'shell':
      return 'bash';
    case 'ps':
    case 'ps1':
      return 'powershell';
    case 'golang':
      return 'go';
    case 'yml':
      return 'yaml';
    case 'md':
    case 'mkd':
      return 'markdown';
    default:
      return l;
  }
}

export const HASH_COMMENT_LANGS = new Set([
  'python',
  'py',
  'python3',
  'bash',
  'sh',
  'zsh',
  'shell',
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
  'ps',
  'ps1',
  'make',
  'makefile',
  // C / C++ 预处理指令 (#include, #define, #ifdef)
  'c',
  'cpp',
  'c++',
  'cxx',
  'h',
  'hpp',
  // C# 预处理指令 (#region, #endregion, #if, #define)
  'c#',
  'cs',
  'csharp',
  'dotnet',
  // 其它包含 # 语法的前置脚本/配置
  'elixir',
  'ex',
  'exs',
  'julia',
  'jl',
  'graphql',
  'gql',
  'nginx',
  'conf',
  'properties',
  'env',
  'nim',
  'tcl',
  'awk',
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

  // 2. 如果当前代码块是 Markdown 容器、纯文本、提示词容器或未指定语言（流式推流中/通用代码块），里面的任何 Markdown 语法与标题均属合法内容，绝不提前腰斩
  const lang = currentFence.lang?.toLowerCase() ?? '';
  if (MARKDOWN_LANGS.has(lang) || TEXT_CONTAINER_LANGS.has(lang)) {
    return false;
  }

  // 3. 遇到另一个明确开启新语言代码块的行（例如上一块漏闭合，直接开启新的 ```rust）
  // 核心原则：只有当新代码块的围栏长度大于等于当前代码块时，才构成外部代码块的断裂开启！
  // 若新代码块围栏长度小于外层（如 4 反引号代码块内部包含了 3 反引号的示例文档），内部围栏纯属合法内容，绝不提前腰斩
  const opening = fenceOpen(line);
  if (
    opening &&
    isLanguageLikeInfo(opening.lang) &&
    opening.length >= currentFence.length &&
    trimmed.length > opening.length
  ) {
    return true;
  }

  // 4. 代码块内以 `#` 开头的内容绝大多数是注释。
  //
  // 但模型确实会“漏写闭合围栏、直接接大纲标题”，所以保留一个**极窄**的自愈。
  // 关键区分不是标题文案（`# 1. xxx` 与 `#### 3. xxx` 完全同构），而是**级别**：
  // - 语言注释普遍是**单个** `#`（python/bash/ruby/yaml/toml，C 的 `#include`）；
  // - 大纲标题才是 `##`/`###`/`####` 多级。
  // 因此 `##` 及以上的 ATX 标题在代码块内才算结构性终结；单个 `#` 一律当注释。
  // 这条同时修掉了两个真实误伤：
  //   `# 1. 底层数字串运算工具`（编号注释）
  //   `# 从最低位 (bit 0) 逐级…`（带括号注释）
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const indent = line.length - line.trimStart().length;
    // 单个 `#` 或缩进行：注释 / 代码体，不中断。
    if (level >= 2 && indent === 0) return true;
    return false;
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

function escapeHtmlPreservingBreaks(text: string): string {
  return escapeHtml(text).replace(/&lt;(\s*br\s*\/?\s*)&gt;/gi, '<$1>');
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
        out.push(`<strong>${escapeHtmlPreservingBreaks(inner)}</strong>`);
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
        return `<mark class="md-highlight">${escapeHtmlPreservingBreaks(inner)}</mark>`;
      });
      // 中文弯引号等标点紧贴 **…** 时 CommonMark 不认强调，预转成 <strong>。
      text = repairCjkPunctuationEmphasis(text);
      return text;
    });
  }).join('\n');
}

/**
 * 规范化各类变体换行标签为标准 HTML `<br>`：
 * 针对模型常在表格单元格或正文中输出的转义/实体变体（如 `&lt;br&gt;`、`\<br>`、`\\<br>`、全角 `＜br＞` 等），
 * 统一在代码围栏和行内代码反引号之外将其规范化为标准 `<br>`，
 * 使得 marked 与 WebUI 能够正确将其渲染为真实折行，避免向用户暴露裸露字符。
 */
export function normalizeBreakTags(line: string): string {
  if (!line) return '';
  const lower = line.toLowerCase();
  if (
    !lower.includes('<br') &&
    !lower.includes('&lt;br') &&
    !lower.includes('＜br')
  ) {
    return line;
  }
  return mapInlineOutsideBackticks(line, (chunk) => {
    return chunk
      .replace(/\\*&lt;\s*br\s*\/?\s*&gt;/gi, '<br>')
      .replace(/\\+<\s*br\s*\/?\s*>/gi, '<br>')
      .replace(/＜\s*br\s*\/?\s*＞/gi, '<br>');
  });
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
/**
 * 规范化任务列表复选框标记：
 * 将常见变体（如 `- [√]`、`- [✔]`、`- [✓]`、`- [v]`、`- [V]`）自动转换为标准 GFM `- [x]`，
 * 使得 marked 能够将其识别为 task list checkbox 并渲染为高品质精美勾选框。
 */
export function normalizeTaskCheckboxes(line: string): string {
  return line.replace(
    /^(\s*(?:>\s*)*(?:[-*+]|\d+[\.\)]))\s*\[\s*([√✔✓vVxX]|\s*)\s*\](\s+|$)/,
    (_, prefix, mark, space) => {
      const isChecked = /[√✔✓vVxX]/.test(mark);
      return `${prefix} [${isChecked ? 'x' : ' '}]${space || ' '}`;
    },
  );
}

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
/**
 * 智能折叠或清洗上游代理/模型意外在正文输出的加密思考签名块（Anthropic Redacted Thinking）。
 * 形如：
 * [Redacted Thinking: EoMCCpEBAWkUfRPz9IZ4N1V3yQ73tqP8z2BskF2Qz82N5f0Y4e5q7z0f9qQz/g8w2k7E4w1+...]
 * 或被网页自动翻译插件翻出的：
 * [已遮挡思考：EoMCCpEBAWkUfRPz9IZ4N1V3yQ73tqP8z2BskF2Qz82N5f0Y4e5q7z0f9qQz/g8w2k7E4w1+...】
 */
export function cleanRedactedThinkingBlocks(source: string): string {
  if (!source || (!source.includes('Redacted Thinking') && !source.includes('已遮挡思考'))) {
    return source;
  }
  return source.replace(
    /\[(?:Redacted Thinking|已遮挡思考)[:：]\s*([A-Za-z0-9+/=_\-\s]{20,})\s*[\]】]/g,
    (_match, data) => {
      const cleanData = String(data).replace(/\s+/g, '');
      return `\n\n<details class="redacted-thinking-box notranslate" translate="no"><summary>💭 <i>[Redacted Thinking]</i></summary>\n\n\`\`\`text\n${cleanData}\n\`\`\`\n</details>\n\n`;
    },
  );
}

export function preprocessMarkdown(raw: string): string {
  if (!raw) return '';
  const sanitized = cleanRedactedThinkingBlocks(raw);
  const prepared = promoteNestedCodeFences(sanitized);
  const lines = prepared.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  let inFence: FenceState | null = null;
  let inTable = false;
  const footnotes: { id: string; n: number; def: string }[] = [];
  const footnoteIds = new Map<string, number>();
  let lastListIndent = -1;

  const prevBlank = (): boolean => result.length === 0 || result[result.length - 1].trim() === '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // ★ 智能解开模型误加的 4 空格缩进富文本块：
    // 在非围栏代码块外，如果一行文本缩进了 4+ 个空格，且内容是顶层结构（如标题、水平线、新的代码块），剥除前置 4 空格；
    // 对于列表项（[-*+] 或数字标号）：
    // 若前面已有父级列表项（处于列表嵌套流中，且当前行缩进大于等于已有父级缩进），代表合法的子级嵌套列表，绝不剥除缩进；
    // 仅当此列表项孤立出现（前面无父级列表）且缩进 4+ 空格时，才剥除误加的 4 空格，避免被 marked 判定为 Indented Code Block！
    if (!inFence) {
      if (!line.trim()) {
        // 空行不重置 lastListIndent，以便跨空行的紧凑/宽松子列表正常识别
      } else if (/^\s*#{1,6}\s+|^\s*[-*_]{3,}\s*$/.test(line)) {
        lastListIndent = -1;
        if (/^(?: {4}|\t)(?:#{1,6}\s+|[-*_]{3,}\s*$)/.test(line)) {
          line = line.replace(/^(?: {4}|\t)/, '');
        }
      } else if (/^(?: {4}|\t)(?:`{3,}|~{3,})/.test(line)) {
        lastListIndent = -1;
        line = line.replace(/^(?: {4}|\t)/, '');
      } else {
        const listMatch = line.match(/^(\s*)(?:[-*+]|\d+[\.\)])\s+/);
        if (listMatch) {
          const indent = listMatch[1].length;
          if (lastListIndent === -1 && indent >= 4) {
            line = line.replace(/^(?: {4}|\t)/, '');
            lastListIndent = indent - 4;
          } else {
            lastListIndent = indent;
          }
        } else if (!/^\s{2,}/.test(line)) {
          lastListIndent = -1;
        }
      }
    }

    // ★ 智能拆解与前置文本/标题/列表项粘连的围栏开启标记（如 `二、中文对照版本```markdown`、`- **代码现状**：```rust` 或 `示例：```ts`）：
    // CommonMark 规范要求代码块围栏必须独占一行，若与前置文本、标题或列表项粘连，marked 无法将其视作代码块开启；
    // 进而导致代码块容器失效，内部内容直接被外泄渲染为大号标题和普通正文，或导致闭合 ``` 反向误判吞噬后续文本！
    // 自动将其拆解为独立两行（前置文本行 + 纯净代码块开启行）。
    if (!inFence) {
      const isPureFenceLine = /^\s*(?:>{1,}\s*)*(`{3,}|~{3,})/.test(line);
      const gluedFence = !isPureFenceLine
        ? line.match(/^(\s*[^`~].*?[^`~\s])\s*((?:`{3,}|~{3,})[a-zA-Z0-9_-]*\s*)$/)
        : null;
      if (
        gluedFence &&
        gluedFence[1].trim() &&
        !gluedFence[1].includes('```') &&
        !gluedFence[1].includes('~~~')
      ) {
        // ★ 核心防御：若前置部分纯粹是 blockquote 引用标记（如 `>`、`> `、`>> ` 等），
        // 它本就是引用块内的代码块开启标记（如 `> ```bash`），绝对不能将其误拆为单独的引用行和顶格代码块！
        const nonQuoteLead = gluedFence[1].replace(/[>\s]/g, '');
        if (nonQuoteLead.length > 0) {
          lines.splice(i, 1, gluedFence[1], gluedFence[2]);
          line = lines[i];
        }
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
        // ★ 核心修复：闭合围栏规范化处理
        // 若代码块开启于 blockquote 内部（带 quotePrefix），闭合行也应规范输出带 quotePrefix 的闭合，
        // 确保 marked 将整个代码块完整包在 blockquote 内部；
        // 若代码块开启于顶格（无 quotePrefix），则规范化为纯净顶格闭合，消除模型可能误加的 `>` 前缀！
        const quotePrefix = inFence.quotePrefix ?? '';
        const cleanClose = `${quotePrefix}${inFence.marker.repeat(inFence.length)}`;
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
      // 开启围栏也规范化，保留引用前缀并消除多余的前置缩进，确保 marked 100% 识别
      const quotePrefix = opening.quotePrefix ?? '';
      const markerIdx = line.indexOf(opening.marker);
      const matchIdx = findMatchingFenceClose(lines, i + 1, opening);
      const isUnclosedMermaid = matchIdx === -1 && opening.lang?.toLowerCase() === 'mermaid';
      const cleanOpen = isUnclosedMermaid
        ? `${quotePrefix}${opening.marker.repeat(opening.length)}mermaid-streaming`
        : `${quotePrefix}${opening.marker.repeat(opening.length)}${line.slice(markerIdx + opening.length)}`;
      result.push(cleanOpen);
      inFence = { ...opening, matchingCloseIdx: matchIdx };
      continue;
    }

    line = replaceFullwidthPipes(line);
    line = fixAtxHeading(line);
    line = normalizeTaskCheckboxes(line);
    line = normalizeBreakTags(line);
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
    const isNonOneOrderedList = /^\s*([2-9]|\d{2,})[\.\)]\s+/.test(line);
    if ((isHeading || openingNow) && result.length > 0) {
      const prevLine = result[result.length - 1].trim();
      if (prevLine !== '' && !prevLine.startsWith('#')) {
        result.push('');
      }
    } else if (isNonOneOrderedList && result.length > 0) {
      const prevLine = result[result.length - 1].trim();
      const prevIsList = /^(?:[-*+]|\d+[\.\)])\s+/.test(prevLine);
      if (prevLine !== '' && !prevIsList) {
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
