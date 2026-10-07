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
  switch (name) {
    case 'read_file':
      return 'file';
    case 'edit_file':
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
    case 'list_directory':
    case 'change_dir':
      return 'folder';
    case 'use_skill':
      return 'skill';
    case 'todo':
    case 'todowrite':
    case 'todo_write':
      return 'todo';
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
    case 'edit_file':
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
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const n = Math.min(lines.length, 80);
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || /^@@ -\d+/.test(line)) return true;
  }
  return false;
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
): { lines: DiffPreviewLine[]; raw: string; source: 'output' | 'args' } | null {
  if (!toolRendersAsDiff(name)) return null;
  const normalized = output ? normalizeToolOutputText(output) : '';
  if (normalized && looksLikeUnifiedDiff(normalized)) {
    const lines = parseDiffPreview(normalized);
    if (lines.some((l) => l.kind === 'add' || l.kind === 'del')) {
      return { lines, raw: normalized, source: 'output' };
    }
  }
  if (!args) return null;
  const oldStr = jsonArgString(args, 'old_string');
  const newStr = jsonArgString(args, 'new_string');
  if (!oldStr && !newStr) return null;
  const lines = buildEditArgsDiff(oldStr, newStr);
  if (!lines.some((l) => l.kind === 'add' || l.kind === 'del')) return null;
  return { lines, raw: formatEditArgsDiffRaw(oldStr, newStr), source: 'args' };
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

  if (output) {
    const addMatch = /(\d+)\s+(?:insertions?|additions?|\(\+\))/i.exec(output);
    const delMatch = /(\d+)\s+(?:deletions?|\(-\))/i.exec(output);
    if (addMatch || delMatch) {
      const additions = addMatch ? Number.parseInt(addMatch[1]!, 10) : 0;
      const deletions = delMatch ? Number.parseInt(delMatch[1]!, 10) : 0;
      if (additions > 0 || deletions > 0) {
        return { additions, deletions };
      }
    }
  }

  if (name === 'write_file' || name === 'create_file') {
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

/** True only for tools or shell commands that actually mutate/write to the filesystem.
 *  Read-only inspectors like `git diff`, `git log`, `grep`, `read_file` are strictly excluded. */
export function isWritingTool(name: string, args?: string): boolean {
  switch (name) {
    case 'edit_file':
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
      // 明确过滤只读 git 命令（尤其是 git diff、git log、git status、git show 等）
      if (/^\s*git\s+(diff|log|status|show|branch|tag|rev-parse|remote)\b/.test(cmd)) {
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

const LONG_TEXT_KEYS = new Set([
  'content',
  'code_content',
  'old_string',
  'new_string',
  'replacement',
  'patch',
  'diff',
  'prompt',
  'instruction',
  'source',
  'body',
]);

const PATH_OR_IDENT_KEYS = new Set([
  'file_path',
  'path',
  'target_directory',
  'cwd',
  'url',
  'query',
  'pattern',
  'command',
  'name',
  'symbol',
  'action',
]);

export interface CompactJsonOptions {
  /** Max length for payload / big content strings (e.g. content, old_string). Default: 40 */
  maxPayloadLen?: number;
  /** Max length for identifier / path / command strings. Default: 120 */
  maxPathLen?: number;
  /** Max length for other generic strings. Default: 80 */
  maxStringLen?: number;
  /** Max elements in an array before truncating. Default: 3 */
  maxArrayElements?: number;
  /** Max total length of the resulting single-line JSON string. Default: 400 */
  maxTotalLen?: number;
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

function cleanSingleLineString(str: string, maxLen: number): string {
  const singleLine = str.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.slice(0, maxLen).trim() + '…';
}

function compactValue(
  val: unknown,
  key: string | null,
  depth: number,
  opts: Required<CompactJsonOptions>,
): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    let limit = opts.maxStringLen;
    if (key && LONG_TEXT_KEYS.has(key)) {
      limit = opts.maxPayloadLen;
    } else if (key && PATH_OR_IDENT_KEYS.has(key)) {
      limit = opts.maxPathLen;
    }
    return cleanSingleLineString(val, limit);
  }
  if (Array.isArray(val)) {
    if (depth >= 2) return '[…]';
    const items = val
      .slice(0, opts.maxArrayElements)
      .map((item) => compactValue(item, null, depth + 1, opts));
    if (val.length > opts.maxArrayElements) {
      items.push(`+${val.length - opts.maxArrayElements} more`);
    }
    return items;
  }
  if (typeof val === 'object') {
    if (depth >= 2) return '{…}';
    const entries = Object.entries(val as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (v !== undefined) {
        result[k] = compactValue(v, k, depth + 1, opts);
      }
    }
    return result;
  }
  return String(val);
}

function stringifyCompactJson(val: unknown, opts: Required<CompactJsonOptions>): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) {
    return '[' + val.map((item) => stringifyCompactJson(item, opts)).join(', ') + ']';
  }
  if (typeof val === 'object') {
    const rawEntries = Object.entries(val as Record<string, unknown>);
    const formatted = rawEntries.map(([k, v], idx) => ({
      fieldStr: `${JSON.stringify(k)}: ${stringifyCompactJson(v, opts)}`,
      idx,
      rank: KEY_RANK[k] ?? UNKNOWN_KEY_RANK,
    }));
    formatted.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    return '{' + formatted.map((f) => f.fieldStr).join(', ') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Format a tool argument JSON blob into a compact, single-line JSON string.
 * Long strings (e.g. file content, old/new diff strings) are shortened with ellipsis
 * so the collapsed tool header doesn't blow up or hide vital arguments (like offset/limit/path).
 */
export function formatToolCompactJson(
  argsJson: string,
  options?: CompactJsonOptions,
): string {
  const trimmed = argsJson.trim();
  if (!trimmed) return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Non-JSON plain text fallback
    const fallback = trimmed.replace(/\s+/g, ' ');
    return fallback.length > 120 ? fallback.slice(0, 120).trim() + '…' : fallback;
  }

  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed !== 'object') return String(parsed);

  if (Array.isArray(parsed) && parsed.length === 0) return '';
  if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) return '';

  const opts: Required<CompactJsonOptions> = {
    maxPayloadLen: options?.maxPayloadLen ?? 40,
    maxPathLen: options?.maxPathLen ?? 120,
    maxStringLen: options?.maxStringLen ?? 80,
    maxArrayElements: options?.maxArrayElements ?? 3,
    maxTotalLen: options?.maxTotalLen ?? 400,
  };

  const compacted = compactValue(parsed, null, 0, opts);
  const jsonStr = stringifyCompactJson(compacted, opts);

  if (jsonStr.length > opts.maxTotalLen) {
    return jsonStr.slice(0, opts.maxTotalLen).trim() + '…';
  }
  return jsonStr;
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

