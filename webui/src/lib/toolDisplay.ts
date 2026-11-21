/** OpenCode-style tool chrome shared by the chat tool rows. */

import { taskArgsSummary } from './subtasks.ts';

export type ToolCategory =
  | 'file'
  | 'edit'
  | 'search'
  | 'terminal'
  | 'globe'
  | 'folder'
  | 'skill'
  | 'todo'
  | 'mcp'
  | 'default';

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  const norm = name.trim().toLowerCase().replace(/[-_]/g, '');
  if (norm === 'todowrite' || norm === 'todo') return 'todo';
  switch (name.trim().toLowerCase()) {
    case 'read':
    case 'read_file':
      return 'file';
    case 'edit':
    case 'edit_file':
    case 'write':
    case 'write_file':
    case 'create_file':
    case 'search_replace':
    case 'parallel_edit_files':
      return 'edit';
    case 'grep':
    case 'glob':
    case 'code_explore':
      return 'search';
    case 'bash':
    case 'run_command':
      return 'terminal';
    case 'web_fetch':
    case 'web_search':
      return 'globe';
    case 'use_skill':
      return 'skill';
    default:
      return 'default';
  }
}

/** OpenCode inline-tool glyphs: `$` bash, `←` edit, `→` read, `✱` search, `◈` web. */
export function toolGlyph(name: string): string {
  switch (toolCategory(name)) {
    case 'terminal':
      return '$';
    case 'edit':
      return '←';
    case 'file':
      return '→';
    case 'search':
      return '✱';
    case 'globe':
      return '◈';
    default:
      return '⚙';
  }
}

export function jsonArgString(argsJson: string, key: string): string {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed === null || typeof parsed !== 'object') return '';
    const v = (parsed as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

export type DiffPreviewLine = {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
};

/** Tools whose payload is actually a code change (edit/write/git). Bullet lists
 *  in `code_explore` / skills / grep must never go through the diff highlighter. */
export function toolRendersAsDiff(name: string): boolean {
  switch (name) {
    case 'edit':
    case 'edit_file':
    case 'write':
    case 'write_file':
    case 'create_file':
    case 'search_replace':
    case 'parallel_edit_files':
    case 'bash':
    case 'run_command':
      return true;
    default:
      return false;
  }
}

/** True only for a real unified diff (`diff --git` or `@@ -n,n +n,n @@`).
 *  A leading `-` bullet (`- F3 'memory/…'`) is not a deletion. */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false;
  return text.includes('diff --git ') || /(?:^|\n)@@ -\d+/.test(text);
}

function parseHunkStarts(header: string): { oldStart: number; newStart: number } | null {
  let oldStart: number | undefined;
  let newStart: number | undefined;
  for (const tok of header.split(/\s+/)) {
    if (tok.startsWith('-')) {
      const n = Number.parseInt(tok.slice(1).split(',')[0] ?? '', 10);
      if (Number.isFinite(n)) oldStart = n;
    } else if (tok.startsWith('+')) {
      const n = Number.parseInt(tok.slice(1).split(',')[0] ?? '', 10);
      if (Number.isFinite(n)) newStart = n;
    }
  }
  return oldStart != null && newStart != null ? { oldStart, newStart } : null;
}

/** Build a synthetic unified-diff preview from edit args when tool output
 *  has no `@@` hunk (failed edits, write_file stats, etc.). */
export function buildEditArgsDiff(oldStr: string, newStr: string): DiffPreviewLine[] {
  const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
  const newLines = newStr.replace(/\r\n/g, '\n').split('\n');
  if (oldLines.length === 0 && newLines.length === 0) return [];
  const header = `@@ -1,${Math.max(oldLines.length, 1)} +1,${Math.max(newLines.length, 1)} @@`;
  const body: string[] = [header];
  for (const line of oldLines) body.push(`-${line}`);
  for (const line of newLines) body.push(`+${line}`);
  return parseDiffPreview(body.join('\n'));
}

/** Format synthetic diff as copyable unified-diff text. */
export function formatEditArgsDiffRaw(oldStr: string, newStr: string): string {
  const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
  const newLines = newStr.replace(/\r\n/g, '\n').split('\n');
  const header = `@@ -1,${Math.max(oldLines.length, 1)} +1,${Math.max(newLines.length, 1)} @@`;
  const body: string[] = [header];
  for (const line of oldLines) body.push(`-${line}`);
  for (const line of newLines) body.push(`+${line}`);
  return body.join('\n');
}

export function normalizeToolOutputText(raw: string): string {
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
}

/** Resolve diff lines: prefer real unified diff in output, else old/new args. */
export function resolveToolDiffPreview(
  name: string,
  output: string | undefined,
  args: string | undefined,
  status?: string,
): { lines: DiffPreviewLine[]; raw: string; source: 'output' | 'args' | 'diagnostic' } | null {
  if (!toolRendersAsDiff(name)) return null;
  const normalized = output ? normalizeToolOutputText(output) : '';
  // 关键防御：当工具执行成功（status === 'done' 或输出包含明确成功标记 "Edited ... replacements"）时，
  // 哪怕编辑的文件源码中恰好包含字面量字符串 "[Content Mismatch]"（如正在编辑 edit 工具本身），
  // 也绝对不允许将其误判为未写入的失败诊断！
  const isSuccessfulEdit =
    status === 'done' ||
    normalized.includes('> ⏱️ **Cost Time**:') ||
    normalized.includes('Edited ') ||
    /\b\d+\s+replacements?\b/i.test(normalized);
  const isMismatchDiagnostic =
    !isSuccessfulEdit &&
    (normalized.includes('[Content Mismatch]') ||
      normalized.includes('failed. The file was NOT modified'));
  if (normalized && looksLikeUnifiedDiff(normalized)) {
    const lines = parseDiffPreview(normalized);
    if (lines.some((l) => l.kind === 'add' || l.kind === 'del')) {
      return { lines, raw: normalized, source: isMismatchDiagnostic ? 'diagnostic' : 'output' };
    }
  }
  if (!args) return null;
  let oldStr = jsonArgString(args, 'old_string');
  let newStr = jsonArgString(args, 'new_string');
  if (!oldStr && !newStr) {
    // 兼容 `edits` 数组结构（新版 edit 工具支持多处编辑原子提交）
    try {
      const parsed = JSON.parse(args);
      if (Array.isArray(parsed?.edits) && parsed.edits.length > 0) {
        const allOld: string[] = [];
        const allNew: string[] = [];
        for (const e of parsed.edits) {
          if (e && typeof e === 'object') {
            if (typeof e.old_string === 'string') allOld.push(e.old_string);
            if (typeof e.new_string === 'string') allNew.push(e.new_string);
          }
        }
        oldStr = allOld.join('\n');
        newStr = allNew.join('\n');
      }
    } catch {}
  }
  if (!oldStr && !newStr) return null;
  const lines = buildEditArgsDiff(oldStr, newStr);
  if (!lines.some((l) => l.kind === 'add' || l.kind === 'del')) return null;
  return { lines, raw: formatEditArgsDiffRaw(oldStr, newStr), source: isSuccessfulEdit ? 'output' : 'args' };
}

export type ToolDiffStats = {
  additions: number;
  deletions: number;
};

/** Compute additions and deletions (+N -M) for a tool call. */
export function computeToolDiffStats(
  name: string,
  output?: string,
  args?: string,
): ToolDiffStats | null {
  const diff = resolveToolDiffPreview(name, output, args);
  if (diff && diff.lines.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.lines) {
      if (line.kind === 'add') additions++;
      else if (line.kind === 'del') deletions++;
    }
    if (additions > 0 || deletions > 0) {
      return { additions, deletions };
    }
  }

  // 关键防线 1：对于终端命令（bash / run_command），只有真正产生文件修改的写工具（isWritingTool）
  // 或明确的只读 diff 命令（isViewOnlyShellDiff）才允许计算 diff 统计；
  // 任何只读查询命令（如 gh pr view、cat、grep、curl、npm test 等）坚决不允许虚假推断出代码变更！
  if ((name === 'bash' || name === 'run_command') && !isWritingTool(name, args) && !isViewOnlyShellDiff(name, output, args)) {
    return null;
  }

  if (output) {
    // 关键防线 2：匹配标准的单行 git diffstat 摘要格式（如 "3 files changed, 15 insertions(+), 2 deletions(-)"）
    // 严禁使用跨换行的 \s+ 导致前一行末尾数字（如 url: .../pull/15）与下一行开头的单词（additions: 3684）发生灾难性跨行拼接！
    const addMatch = /(?:^|[^\w/.-])(\d+)[^\S\r\n]+(?:insertions?|additions?|\(\+\))/im.exec(output);
    const delMatch = /(?:^|[^\w/.-])(\d+)[^\S\r\n]+(?:deletions?|\(-\))/im.exec(output);
    if (addMatch || delMatch) {
      const additions = addMatch ? Number.parseInt(addMatch[1]!, 10) : 0;
      const deletions = delMatch ? Number.parseInt(delMatch[1]!, 10) : 0;
      if (additions > 0 || deletions > 0) {
        return { additions, deletions };
      }
    }
  }

  if (name === 'write' || name === 'write_file' || name === 'create_file') {
    if (args) {
      const content = jsonArgString(args, 'content') || jsonArgString(args, 'code_content');
      if (content) {
        const lineCount = content.replace(/\r\n/g, '\n').split('\n').length;
        return { additions: lineCount, deletions: 0 };
      }
    }
  }

  return null;
}

export type TurnDiffSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
  toolCount: number;
};

/** Shell output that is a unified diff for display only.
 *  `git diff` / `git show` / `git log -p` reuse the edit red/green panel and
 *  must not be counted as files changed. */
export function isViewOnlyShellDiff(
  name: string,
  output?: string,
  args?: string,
): boolean {
  if (name !== 'bash' && name !== 'run_command') return false;
  if (isWritingTool(name, args)) return false;
  if (!output) return false;
  return looksLikeUnifiedDiff(normalizeToolOutputText(output));
}

/** True only for tools or shell commands that actually mutate/write to the filesystem.
 *  Read-only inspectors like `git diff`, `git log`, `grep`, `read_file` are strictly excluded. */
export function isWritingTool(name: string, args?: string): boolean {
  switch (name) {
    case 'edit':
    case 'edit_file':
    case 'write':
    case 'write_file':
    case 'create_file':
    case 'global_search_replace':
    case 'search_replace':
    case 'parallel_edit_files':
      return true;
    case 'bash':
    case 'run_command': {
      if (!args) return false;
      const cmd = (jsonArgString(args, 'command') || jsonArgString(args, 'cmd') || '').trim();
      if (!cmd) return false;
      // 明确过滤只读 git 与 GitHub CLI 命令（尤其是 git diff/log/status/show、gh diff、gh pr/issue/run/repo 查看命令等）
      if (/^\s*(?:git\s+(?:diff|log|status|show|branch|tag|rev-parse|remote)|gh\s+(?:diff|pr|issue|run|repo|workflow|api)\s*(?:view|list|status|diff)?)\b/.test(cmd)) {
        return false;
      }
      // 过滤只读文件查看与检索命令
      if (/^\s*(cat|grep|rg|find|ls|head|tail|less|more|which|where)\b/.test(cmd)) {
        return false;
      }
      // 重定向输出到文件 (> 或 >>)
      if (/(?:>|>>)\s*\S+/.test(cmd)) {
        return true;
      }
      // 常见写/编辑类命令（如 sed -i、patch、git apply、git checkout --、git restore 等）
      if (/\b(?:sed\s+-[a-zA-Z]*i|patch|git\s+(?:apply|restore|checkout\s+--)|touch|cp|mv|rm|mkdir)\b/.test(cmd)) {
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Collect aggregated diff metrics (total files changed, +N -M) across turn message parts. */
export function collectTurnDiffSummary(
  parts: Array<{ kind: string; tool?: { name: string; output?: string; args?: string; id?: string } }>,
): TurnDiffSummary | null {
  const toolParts = parts.filter((p) => p.kind === 'tool' && p.tool);
  if (toolParts.length === 0) return null;

  let totalAdditions = 0;
  let totalDeletions = 0;
  let hasDiff = false;
  const editedFiles = new Set<string>();

  for (const p of toolParts) {
    const tool = p.tool!;
    // 只有真正的写/编辑类工具才计入修改文件数与修改行数统计；git diff 等只读检查绝不计入
    if (!isWritingTool(tool.name, tool.args)) {
      continue;
    }
    const stats = computeToolDiffStats(tool.name, tool.output, tool.args);
    if (stats && (stats.additions > 0 || stats.deletions > 0)) {
      totalAdditions += stats.additions;
      totalDeletions += stats.deletions;
      hasDiff = true;
    }
    const filePath = tool.args
      ? jsonArgString(tool.args, 'file_path') || jsonArgString(tool.args, 'path')
      : '';
    if (filePath) {
      editedFiles.add(filePath);
    } else if (tool.id) {
      editedFiles.add(tool.id);
    }
  }

  if (editedFiles.size === 0) return null;

  return {
    fileCount: editedFiles.size,
    additions: totalAdditions,
    deletions: totalDeletions,
    toolCount: toolParts.length,
  };
}

/** Best-effort unified-diff preview with per-line numbers from `@@` hunks.
 *  `+/-` lines are only colored after a real diff header — never on first sight. */
export function parseDiffPreview(output: string, maxLines = 2000): DiffPreviewLine[] {
  const raw = output.replace(/\r\n/g, '\n').split('\n');
  const out: DiffPreviewLine[] = [];
  let sawDiff = false;
  let oldLn = 0;
  let newLn = 0;
  let inHunk = false;
  for (const line of raw) {
    if (out.length >= maxLines) break;
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@')
    ) {
      sawDiff = true;
      if (line.startsWith('@@')) {
        const starts = parseHunkStarts(line);
        if (starts) {
          oldLn = starts.oldStart;
          newLn = starts.newStart;
          inHunk = true;
        }
      } else {
        inHunk = false;
      }
      out.push({ kind: 'meta', text: line });
      continue;
    }
    if (!sawDiff) continue;
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      out.push({
        kind: 'add',
        text: line,
        newLine: inHunk ? newLn : undefined,
      });
      if (inHunk) newLn += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('--- ')) {
      out.push({
        kind: 'del',
        text: line,
        oldLine: inHunk ? oldLn : undefined,
      });
      if (inHunk) oldLn += 1;
      continue;
    }
    const isCtx = line.startsWith(' ') || line === '';
    out.push({
      kind: 'ctx',
      text: line,
      oldLine: inHunk && isCtx ? oldLn : undefined,
      newLine: inHunk && isCtx ? newLn : undefined,
    });
    if (inHunk && isCtx) {
      oldLn += 1;
      newLn += 1;
    }
  }
  return sawDiff ? out : [];
}

export type StructuredField = {
  key: string;
  value: string;
  multiline: boolean;
};

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const starts = trimmed[0];
  if (starts !== '{' && starts !== '[' && starts !== '"') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function prettyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    const nested = tryParseJson(value);
    if (nested !== undefined && typeof nested !== 'string') {
      return JSON.stringify(nested, null, 2);
    }
    return value;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** Turn a raw tool-args JSON blob into readable key/value fields.
 * Nested JSON strings and `\n` escapes become real formatted text. */
export function structuredToolFields(raw: string): StructuredField[] | null {
  const parsed = tryParseJson(raw);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return Object.entries(parsed as Record<string, unknown>).map(([key, val]) => {
    const value = prettyUnknown(val);
    return { key, value, multiline: value.includes('\n') };
  });
}

/** Pretty-print tool args/output: unescape JSON, expand nested strings. */
export function formatToolPayload(raw: string): string {
  if (!raw) return raw;
  const pretty = prettyToolText(raw);
  return pretty.text;
}

/** Copyable code-block body: pretty JSON when the payload parses, else unescaped text. */
export function prettyToolText(raw: string): { text: string; lang: 'json' | 'text' } {
  if (!raw) return { text: '', lang: 'text' };
  const parsed = tryParseJson(raw);
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    const copy = { ...(parsed as Record<string, unknown>) };
    if (
      typeof copy.description === 'string' &&
      typeof copy.command === 'string' &&
      copy.description.trim() === copy.command.trim()
    ) {
      delete copy.description;
    }
    return { text: JSON.stringify(copy, null, 2), lang: 'json' };
  }
  if (parsed !== undefined) {
    return { text: JSON.stringify(parsed, null, 2), lang: 'json' };
  }
  return {
    text: raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"'),
    lang: 'text',
  };
}

/** Lower rank is shown first. Unknown keys keep their original order after these. */
const KEY_RANK: Record<string, number> = {
  summary: 0,
  command: 1,
  query: 3,
  pattern: 4,
  file_path: 5,
  path: 6,
  target_directory: 7,
  url: 8,
  name: 9,
  symbol: 10,
  action: 11,
  glob: 12,
  lang: 13,
  offset: 20,
  limit: 21,
  shell: 30,
  background: 31,
  settle_secs: 32,
  old_string: 70,
  new_string: 71,
  content: 72,
  prompt: 73,
  instruction: 74,
  code_content: 75,
  replacement: 76,
  patch: 77,
  diff: 78,
};

const UNKNOWN_KEY_RANK = 40;

function stringifyCompactJson(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) {
    return '[' + val.map(stringifyCompactJson).join(', ') + ']';
  }
  if (typeof val === 'object') {
    const rawEntries = Object.entries(val as Record<string, unknown>);
    const formatted = rawEntries.map(([k, v], idx) => ({
      fieldStr: `${JSON.stringify(k)}: ${stringifyCompactJson(v)}`,
      idx,
      rank: KEY_RANK[k] ?? UNKNOWN_KEY_RANK,
    }));
    formatted.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    return '{' + formatted.map((f) => f.fieldStr).join(', ') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Format a tool argument JSON blob into a single-line, key-sorted JSON string.
 * Values are never shortened: the collapsed header relies on CSS ellipsis, and
 * the expanded body shows the same full payload.
 */
export function formatToolCompactJson(argsJson: string): string {
  const trimmed = argsJson.trim();
  if (!trimmed) return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.replace(/\s+/g, ' ');
  }

  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed !== 'object') return String(parsed);

  if (Array.isArray(parsed) && parsed.length === 0) return '';
  if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) return '';

  return stringifyCompactJson(parsed);
}

/**
 * Returns a human-friendly single-line summary of a tool call's arguments
 * for the tool header row. Renders as a single-line JSON with long values
 * abbreviated, making offset, limit, and file paths immediately visible
 * across repeated calls so users don't mistake iterative reading for a loop.
 */
export type JsonTone = 'punct' | 'key' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonSpan {
  text: string;
  tone: JsonTone;
}

/** Split a single-line JSON preview into key/value spans. Non-JSON returns null. */
export function colorizeInlineJson(line: string): JsonSpan[] | null {
  const start = line.trimStart();
  if (!start.startsWith('{') && !start.startsWith('[')) return null;
  const out: JsonSpan[] = [];
  const push = (text: string, tone: JsonTone) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.tone === tone) last.text += text;
    else out.push({ text, tone });
  };
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      push(c, 'punct');
      i += 1;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ',' || c === ':') {
      push(c, 'punct');
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      let k = j;
      while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
      push(line.slice(i, j), line[k] === ':' ? 'key' : 'string');
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !' \t\n\r{}[],:'.includes(line[j]!)) j += 1;
    const word = line.slice(i, j);
    const tone: JsonTone =
      word === 'true' || word === 'false'
        ? 'boolean'
        : word === 'null'
          ? 'null'
          : /^-?\d/.test(word)
            ? 'number'
            : 'punct';
    push(word, tone);
    i = j;
  }
  return out;
}

export function formatToolDetail(name: string, argsJson: string): string {
  if (name === 'task') {
    const summary = taskArgsSummary(argsJson);
    if (summary) {
      try {
        const v = JSON.parse(argsJson) as Record<string, unknown>;
        const n = (v.tasks as unknown[])?.length ?? 0;
        return n > 0 ? `${n} subagents` : summary;
      } catch {
        return summary;
      }
    }
  }
  return formatToolCompactJson(argsJson);
}

function basenameOfPath(value: string): string {
  // Normalize both separators, then keep the rightmost non-empty segment.
  // Works for directories, file paths and slash/backslash-shaped artifact ids.
  const clean = value.trim().replace(/[\\/]+$/, '');
  if (!clean) return '';
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || clean;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Mobile / compact tool-row summary: only the parameter a developer needs at a glance.
 * - Read: `app.css 123-567` (file name + requested line range)
 * - Edit / Write: `app.css` (last path segment)
 * - Shell: the first command line
 * - Other tools: path/query/url if present, else a short compact JSON preview.
 * The expanded body still renders the complete argument payload.
 */
export function compactToolDetail(name: string, argsJson: string): string {
  const trimmed = argsJson.trim();
  if (!trimmed) return '';
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return trimmed.replace(/\s+/g, ' ').slice(0, 80);
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return trimmed.replace(/\s+/g, ' ').slice(0, 80);
  }

  const norm = name.trim().toLowerCase().replace(/[-_]/g, '');
  const pathKeys = [
    'path', 'file_path', 'filepath', 'filePath', 'file', 'target_file', 'targetFile',
    'filename', 'fileName', 'dir', 'directory', 'cwd', 'artifact_id', 'artifactid', 'artifact',
  ];
  let path = '';
  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) { path = value; break; }
  }
  // Some edit tools only put the path inside the edits array.
  if (!path && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === 'object') {
        const row = edit as Record<string, unknown>;
        const value = row.path ?? row.file_path ?? row.filePath ?? row.file;
        if (typeof value === 'string' && value.trim()) { path = value; break; }
      }
    }
  }
  const base = path ? basenameOfPath(path) : '';

  if (norm === 'read' || norm === 'readfile') {
    const offset =
      finiteNumber(args.offset) ?? finiteNumber(args.start_line) ?? finiteNumber(args.start) ?? finiteNumber(args.line_start);
    const limit = finiteNumber(args.limit);
    const end =
      finiteNumber(args.end_line) ?? finiteNumber(args.end) ?? finiteNumber(args.line_end) ??
      (offset != null && limit != null ? offset + limit - 1 : null);
    if (base) {
      if (offset != null && end != null) return `${base} ${offset}-${end}`;
      if (offset != null) return `${base} ${offset}+`;
      if (limit != null) return `${base} 1-${limit}`;
      return base;
    }
  }

  if (base && [
    'edit', 'editfile', 'write', 'writefile', 'createfile',
    'searchreplace', 'paralleleditfiles',
  ].includes(norm)) {
    return base;
  }

  // Search tools: the pair that matters is the scanned directory and the matcher.
  if (['grep', 'glob', 'codeexplore', 'codesearch', 'search'].includes(norm)) {
    const matcher = args.pattern ?? args.query ?? args.glob ?? args.expression;
    const matcherText = typeof matcher === 'string' ? matcher.trim().split(/\r?\n/)[0].slice(0, 80) : '';
    if (base && matcherText) return `${base} · ${matcherText}`;
    if (matcherText) return matcherText;
    if (base) return base;
  }

  const command = args.command ?? args.cmd ?? args.script;
  if (typeof command === 'string' && command.trim()) {
    return command.trim().split(/\r?\n/)[0].slice(0, 80);
  }

  const query = args.query ?? args.pattern ?? args.url ?? args.expression;
  if (typeof query === 'string' && query.trim()) {
    return `${base ? base + ' · ' : ''}${query.trim().split(/\r?\n/)[0].slice(0, 80)}`;
  }

  if (base) return base;
  return formatToolDetail(name, argsJson).slice(0, 100);
}

/** Semantic tones for the one-line tool header. Only the key value is tinted. */
export type ToolTone =
  | 'name'
  | 'summary'
  | 'path'
  | 'range'
  | 'pattern'
  | 'command'
  | 'url'
  | 'count'
  | 'priority'
  | 'title'
  | 'meta'
  | 'mcp'
  | 'danger'
  | 'punct';

export interface ToolTextPart {
  text: string;
  tone: ToolTone;
}

export interface ToolDisplay {
  /** Description first: front-end alias, bash summary, or first task label. */
  description: ToolTextPart[];
  /** Key parameter second; long values are ellipsized by the container. */
  params: ToolTextPart[];
}

export interface CompactToolDisplayOptions {
  /** Task rows may only have SubtaskPanel data, not the raw `tasks` args. */
  subtaskCount?: number;
  firstSubtaskDescription?: string;
}

/** Front-end-only aliases. Backend tool names are never rewritten. */
const FRONTEND_TOOL_ALIASES: Record<string, string> = {
  read: 'Read',
  read_file: 'Read',
  edit: 'Edit',
  edit_file: 'Edit',
  write: 'Write',
  write_file: 'Write',
  create_file: 'Write',
  bash: 'Bash',
  run_command: 'Bash',
  long_bash_keyword_actions: 'Keywords',
  grep: 'Grep',
  glob: 'Glob',
  code_explore: 'Explore',
  todo_write: 'Todo',
  todowrite: 'Todo',
  todo: 'Todo',
  jeikcode_config: 'Config',
  jeikcode_config_guide: 'Config',
  request_user_input: 'Ask',
  task: 'Task',
  use_skill: 'Skill',
  web_fetch: 'Fetch',
  web_search: 'Search',
  report_finding: 'Finding',
};

function pascalToolName(name: string): string {
  const trimmed = name.trim();
  return trimmed
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || trimmed;
}

/**
 * Display identity for a tool. MCP names become the real `server / tool`
 * instead of a dead "MCP" string. Unknown names fall back to PascalCase.
 */
export function frontendToolAlias(name: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mcp__')) {
    const rest = trimmed.slice('mcp__'.length);
    const parts = rest.split('__');
    if (parts.length >= 2) {
      return `${parts[0]} / ${parts.slice(1).join('__')}`;
    }
    return rest || 'MCP';
  }
  return FRONTEND_TOOL_ALIASES[lower] ?? pascalToolName(trimmed);
}

function mcpDescription(name: string): ToolTextPart[] {
  const rest = name.trim().slice('mcp__'.length);
  const parts = rest.split('__');
  if (parts.length >= 2) {
    return [
      { text: parts[0]!, tone: 'mcp' },
      { text: ' / ', tone: 'punct' },
      { text: parts.slice(1).join('__'), tone: 'mcp' },
    ];
  }
  return [{ text: rest || 'MCP', tone: 'name' }];
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function displayFetchUrl(raw: string): string {
  return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function toneForKey(key: string): ToolTone {
  switch (key) {
    case 'path':
    case 'file_path':
    case 'filepath':
    case 'filePath':
    case 'file':
    case 'target_file':
    case 'targetFile':
    case 'filename':
    case 'fileName':
    case 'dir':
    case 'directory':
      return 'path';
    case 'url':
      return 'url';
    case 'command':
    case 'cmd':
      return 'command';
    case 'query':
    case 'pattern':
    case 'glob':
    case 'expression':
    case 'name':
    case 'prompt':
      return 'pattern';
    default:
      return 'meta';
  }
}

function firstMappedString(
  args: Record<string, unknown>,
  keys: string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value };
    }
  }
  return null;
}

function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
}

/** Todo payloads may arrive as arrays or as one stringified array layer. */
function todoArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return [];
}

function todoItemLabel(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const row = item as Record<string, unknown>;
  for (const key of ['content', 'title', 'task', 'new_content', 'new_title', 'add']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function separator(text = ' · '): ToolTextPart {
  return { text, tone: 'punct' };
}

/**
 * Collapsed-row display: description first, key parameter second. The returned
 * parts carry semantic tones; CSS ellipsizes the parameter container as a whole,
 * so the right-side status/time never wrap to another line.
 */
export function compactToolDisplay(
  name: string,
  argsJson: string,
  opts: CompactToolDisplayOptions = {},
): ToolDisplay {
  const description: ToolTextPart[] = [{ text: frontendToolAlias(name), tone: 'name' }];
  const params: ToolTextPart[] = [];
  const trimmed = (argsJson ?? '').trim();
  if (!trimmed) {
    // Task rows can be rendered from SubtaskPanel data alone (no raw args).
    if (name.trim().toLowerCase() === 'task') {
      if (opts.firstSubtaskDescription) {
        description.push(separator());
        description.push({ text: opts.firstSubtaskDescription, tone: 'summary' });
      }
      if ((opts.subtaskCount ?? 0) > 1) {
        params.push({ text: `×${opts.subtaskCount}`, tone: 'count' });
      }
    }
    return { description, params };
  }

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { description, params };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return { description, params };
  }

  const norm = name.trim().toLowerCase().replace(/[-_]/g, '');
  if (name.trim().toLowerCase().startsWith('mcp__')) {
    description.splice(0, description.length, ...mcpDescription(name));
    const arg = firstMappedString(args, [
      'query', 'pattern', 'url', 'path', 'file_path', 'file', 'name', 'prompt', 'command',
    ]);
    if (arg) {
      params.push({
        text: arg.key === 'url' ? displayFetchUrl(arg.value) : arg.value,
        tone: toneForKey(arg.key),
      });
    }
    return { description, params };
  }

  const pathKeys = [
    'path', 'file_path', 'filepath', 'filePath', 'file', 'target_file', 'targetFile',
    'filename', 'fileName', 'dir', 'directory', 'cwd', 'artifact_id', 'artifactid', 'artifact',
  ];
  let path = '';
  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) { path = value; break; }
  }
  if (!path && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === 'object') {
        const row = edit as Record<string, unknown>;
        const value = row.path ?? row.file_path ?? row.filePath ?? row.file;
        if (typeof value === 'string' && value.trim()) { path = value; break; }
      }
    }
  }
  const base = path ? basenameOfPath(path) : '';

  if (norm === 'bash' || norm === 'runcommand') {
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (summary) {
      description.push(separator());
      description.push({ text: summary, tone: 'summary' });
    }
    const command = args.command ?? args.cmd ?? args.script;
    if (typeof command === 'string' && command.trim()) {
      params.push({ text: firstLine(command), tone: 'command' });
    }
    return { description, params };
  }

  if (norm === 'longbashkeywordactions') {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
    const keyword = args.keyword;
    const mark = action === 'delete' ? '−' : action === 'add' ? '+' : (action || '');
    if (mark) params.push({ text: mark, tone: action === 'delete' ? 'danger' : 'command' });
    if (typeof keyword === 'string' && keyword.trim()) {
      if (params.length) params.push({ text: ' ', tone: 'punct' });
      params.push({ text: keyword.trim(), tone: 'pattern' });
    }
    if (args.global === true) {
      params.push(separator());
      params.push({ text: 'global', tone: 'meta' });
    }
    return { description, params };
  }

  if (norm === 'read' || norm === 'readfile') {
    if (base) params.push({ text: base, tone: 'path' });
    const offset =
      finiteNumber(args.offset) ?? finiteNumber(args.start_line) ?? finiteNumber(args.start) ?? finiteNumber(args.line_start);
    const limit = finiteNumber(args.limit);
    const end =
      finiteNumber(args.end_line) ?? finiteNumber(args.end) ?? finiteNumber(args.line_end) ??
      (offset != null && limit != null ? offset + limit - 1 : null);
    const range = offset != null && end != null ? `${offset}-${end}` : offset != null ? `${offset}+` : limit != null ? `1-${limit}` : '';
    if (range) {
      if (params.length) params.push({ text: ' ', tone: 'punct' });
      params.push({ text: range, tone: 'range' });
    }
    return { description, params };
  }

  if (['edit', 'editfile', 'write', 'writefile', 'createfile', 'searchreplace', 'paralleleditfiles'].includes(norm)) {
    if (base) params.push({ text: base, tone: 'path' });
    const edits = objectArray(args.edits);
    if (edits.length > 1) {
      if (params.length) params.push({ text: ' ', tone: 'punct' });
      params.push({ text: `×${edits.length}`, tone: 'count' });
    }
    return { description, params };
  }

  if (['grep', 'glob', 'codeexplore', 'codesearch', 'search'].includes(norm)) {
    const matcher = args.pattern ?? args.query ?? args.glob ?? args.expression;
    const matcherText = typeof matcher === 'string' ? firstLine(matcher.trim(), 160) : '';
    const showPath = base && path.trim() !== '.' && path.trim() !== './';
    if (showPath) params.push({ text: base, tone: 'path' });
    if (matcherText) {
      if (params.length) params.push(separator());
      params.push({ text: matcherText, tone: 'pattern' });
    }
    return { description, params };
  }

  if (norm === 'todo' || norm === 'todowrite') {
    const plan = todoArray(args.plan);
    const todos = todoArray(args.todos);
    const update = todoArray(args.update).length ? todoArray(args.update) : todoArray(args.updates);
    const actions = todoArray(args.actions);
    const rows = plan.length ? plan : todos.length ? todos : update.length ? update : actions;
    const labels = rows.map(todoItemLabel).filter(Boolean);
    if (labels[0]) {
      params.push({ text: firstLine(labels[0], 90), tone: 'title' });
    } else if (args.list === true || args.action === 'list') {
      params.push({ text: 'list', tone: 'command' });
    } else if (args.clear === true || args.action === 'clear') {
      params.push({ text: 'clear', tone: 'danger' });
    } else if (typeof args.action === 'string' && args.action.trim()) {
      params.push({ text: args.action.trim(), tone: 'command' });
    } else if (typeof args.content === 'string' && args.content.trim()) {
      params.push({ text: firstLine(args.content.trim(), 90), tone: 'title' });
    }
    if (rows.length > 1) {
      if (params.length) params.push(separator());
      params.push({ text: `×${rows.length}`, tone: 'count' });
    }
    return { description, params };
  }

  if (norm === 'jeikcodeconfig' || norm === 'jeikcodeconfigguide') {
    const action = typeof args.action === 'string' ? args.action.trim() : args.topic ? 'guide' : '';
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (action) params.push({ text: action, tone: 'command' });
    if (topic) {
      if (params.length) params.push({ text: ' ', tone: 'punct' });
      params.push({ text: topic, tone: 'meta' });
    }
    return { description, params };
  }

  if (norm === 'requestuserinput') {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    if (questions.length) params.push({ text: `×${questions.length}`, tone: 'count' });
    return { description, params };
  }

  if (norm === 'task') {
    const tasks = objectArray(args.tasks);
    const firstDescription = tasks[0]?.description;
    const taskDescription = typeof firstDescription === 'string' && firstDescription.trim()
      ? firstDescription.trim()
      : (opts.firstSubtaskDescription || '').trim();
    if (taskDescription) {
      description.push(separator());
      description.push({ text: taskDescription, tone: 'summary' });
    }
    const count = tasks.length || opts.subtaskCount || 0;
    if (count > 1) params.push({ text: `×${count}`, tone: 'count' });
    return { description, params };
  }

  if (norm === 'useskill') {
    const skill = args.name;
    if (typeof skill === 'string' && skill.trim()) params.push({ text: skill.trim(), tone: 'pattern' });
    return { description, params };
  }

  if (norm === 'webfetch') {
    const url = args.url;
    if (typeof url === 'string' && url.trim()) params.push({ text: displayFetchUrl(url.trim()), tone: 'url' });
    return { description, params };
  }

  if (norm === 'websearch') {
    const query = args.query;
    if (typeof query === 'string' && query.trim()) params.push({ text: firstLine(query.trim(), 120), tone: 'pattern' });
    return { description, params };
  }

  if (norm === 'reportfinding') {
    const priority = typeof args.priority === 'string' ? args.priority.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (priority) params.push({ text: priority, tone: 'priority' });
    if (title) {
      if (params.length) params.push(separator());
      params.push({ text: title, tone: 'title' });
    }
    return { description, params };
  }

  const fallback = firstMappedString(args, [
    'query', 'pattern', 'url', 'command', 'path', 'file_path', 'name',
  ]);
  if (fallback) {
    params.push({
      text: fallback.key === 'url' ? displayFetchUrl(fallback.value) : firstLine(fallback.value),
      tone: toneForKey(fallback.key),
    });
  }
  return { description, params };
}

