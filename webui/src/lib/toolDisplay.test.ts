import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonArgString,
  looksLikeUnifiedDiff,
  parseDiffPreview,
  buildEditArgsDiff,
  resolveToolDiffPreview,
  formatToolPayload,
  prettyToolText,
  structuredToolFields,
  toolCategory,
  toolGlyph,
  toolRendersAsDiff,
  isWritingTool,
  computeToolDiffStats,
  collectTurnDiffSummary,
  isViewOnlyShellDiff,
  formatToolCompactJson,
  formatToolDetail,
  colorizeInlineJson,
} from './toolDisplay.ts';

test('tool glyphs match OpenCode classes', () => {
  assert.equal(toolGlyph('bash'), '$');
  assert.equal(toolGlyph('edit_file'), '←');
  assert.equal(toolGlyph('write_file'), '←');
  assert.equal(toolGlyph('read_file'), '→');
  assert.equal(toolGlyph('grep'), '✱');
  assert.equal(toolGlyph('code_explore'), '✱');
  assert.equal(toolGlyph('web_search'), '◈');
  assert.equal(toolCategory('bash'), 'terminal');
  assert.equal(toolCategory('mcp__srv__tool'), 'mcp');
});

test('jsonArgString reads a string field', () => {
  assert.equal(jsonArgString('{"command":"ls -la"}', 'command'), 'ls -la');
  assert.equal(jsonArgString('not-json', 'command'), '');
});

test('formatToolDetail puts summary then command ahead of shell', () => {
  assert.equal(
    formatToolDetail(
      'run_command',
      '{"shell":"default","command":"cargo check","summary":"confirm the build"}',
    ),
    '{"summary": "confirm the build", "command": "cargo check", "shell": "default"}',
  );
});

test('parseDiffPreview colors add/del and ignores non-diff output', () => {
  const lines = parseDiffPreview(
    [
      'diff --git a/foo.rs b/foo.rs',
      '--- a/foo.rs',
      '+++ b/foo.rs',
      '@@ -1,2 +1,2 @@',
      ' fn main() {',
      '-    let x = 1;',
      '+    let x = 2;',
      ' }',
    ].join('\n'),
  );
  assert.equal(lines[0].kind, 'meta');
  const del = lines.find((l) => l.kind === 'del');
  const add = lines.find((l) => l.kind === 'add');
  assert.ok(del && del.text.includes('let x = 1') && del.oldLine === 2);
  assert.ok(add && add.text.includes('let x = 2') && add.newLine === 2);
  assert.deepEqual(parseDiffPreview('Created new file foo.rs (12 bytes)'), []);
  assert.ok(
    looksLikeUnifiedDiff(
      [
        'diff --git a/foo.rs b/foo.rs',
        '--- a/foo.rs',
        '+++ b/foo.rs',
        '@@ -1,2 +1,2 @@',
        ' fn main() {',
        '-    let x = 1;',
        '+    let x = 2;',
        ' }',
      ].join('\n'),
    ),
  );
  assert.equal(looksLikeUnifiedDiff('Created new file foo.rs (12 bytes)'), false);
});

test('bullet lists and code_explore output are not treated as diffs', () => {
  const explore = [
    "- F3 'memory/黄金sql案例/foo.sql'",
    "- F16 'memory/bar.md'",
    '> 📂 **Directory Panorama**',
    '- more/files',
  ].join('\n');
  assert.equal(looksLikeUnifiedDiff(explore), false);
  assert.deepEqual(parseDiffPreview(explore), []);
  assert.equal(toolRendersAsDiff('code_explore'), false);
  assert.equal(toolRendersAsDiff('edit_file'), true);
  assert.equal(toolRendersAsDiff('bash'), true);
});

test('buildEditArgsDiff colors old/new args when output has no unified diff', () => {
  const oldStr = '| **常规查询** | `sql-server-company` |\n| **通话相关** | `sql-server-company` |';
  const newStr = '| **常规查询** | `sql-server-company` |\n| **微信相关** | `pgsql-company` |';
  const lines = buildEditArgsDiff(oldStr, newStr);
  assert.ok(lines.some((l) => l.kind === 'del'));
  assert.ok(lines.some((l) => l.kind === 'add'));
  const resolved = resolveToolDiffPreview(
    'edit_file',
    'edit_file: hunk 1/1 failed. old_string not found.',
    JSON.stringify({ old_string: oldStr, new_string: newStr }),
  );
  assert.ok(resolved);
  assert.ok(resolved!.lines.some((l) => l.kind === 'del'));
  assert.ok(resolved!.lines.some((l) => l.kind === 'add'));
  assert.equal(resolved!.source, 'args');
});

test('resolveToolDiffPreview prefers output unified diff over args', () => {
  const output = [
    'Edited foo.md (1 replacement)',
    '@@ -1,2 +1,2 @@',
    ' ctx',
    '- old',
    '+ new',
  ].join('\n');
  const args = JSON.stringify({ old_string: 'other', new_string: 'ignored' });
  const resolved = resolveToolDiffPreview('edit_file', output, args);
  assert.ok(resolved);
  assert.equal(resolved!.source, 'output');
  assert.ok(resolved!.raw.includes('@@ -1,2'));
});

test('resolveToolDiffPreview tags content mismatch diagnosis as diagnostic instead of output', () => {
  const output = [
    'edit_file: hunk 1/3 failed. The file was NOT modified. old_string not found in file.',
    '[Content Mismatch]: Closest matching block found around lines 10-10 (similarity 95%):',
    '```diff',
    '@@ -1 +1 @@',
    '- expected',
    '+ actual',
    '```',
  ].join('\n');
  const args = JSON.stringify({ old_string: 'expected', new_string: 'changed' });
  const resolved = resolveToolDiffPreview('edit_file', output, args);
  assert.ok(resolved);
  assert.equal(resolved!.source, 'diagnostic');
});

test('formatToolPayload pretty-prints JSON for copyable code blocks', () => {
  const raw = JSON.stringify({
    file_path: 'test_demo_3.json',
    content: '{\n  "name": "tui-test"\n}\n',
  });
  const formatted = formatToolPayload(raw);
  assert.ok(formatted.includes('"file_path": "test_demo_3.json"'));
  assert.ok(formatted.includes('tui-test'));
  const pretty = prettyToolText(raw);
  assert.equal(pretty.lang, 'json');
  const fields = structuredToolFields(raw);
  assert.equal(fields?.[0]?.key, 'file_path');
  assert.ok(fields?.some((f) => f.key === 'content' && f.multiline));
  assert.equal(prettyToolText('- F3 memory/foo').lang, 'text');
});

test('computeToolDiffStats calculates additions and deletions from diff and write_file', () => {
  const diffOutput = [
    'diff --git a/foo.rs b/foo.rs',
    '--- a/foo.rs',
    '+++ b/foo.rs',
    '@@ -1,3 +1,4 @@',
    ' unchanged',
    '-deleted line 1',
    '-deleted line 2',
    '+added line 1',
    '+added line 2',
    '+added line 3',
  ].join('\n');
  const stats = computeToolDiffStats('edit_file', diffOutput, undefined);
  assert.deepEqual(stats, { additions: 3, deletions: 2 });

  const writeStats = computeToolDiffStats(
    'write_file',
    'Wrote 2 lines',
    JSON.stringify({ file_path: 'foo.txt', content: 'line 1\nline 2\nline 3' }),
  );
  assert.deepEqual(writeStats, { additions: 3, deletions: 0 });

  const noDiff = computeToolDiffStats('read_file', 'some text', JSON.stringify({ file_path: 'foo.txt' }));
  assert.equal(noDiff, null);

  // 回归测试：严禁将 gh pr view 等只读命令的跨行 YAML 输出误解析为 diff 变更 (+15 -3684)
  const ghPrViewOutput = [
    'title:   feat(i18n): English Vietnamese Chinese locales with English default',
    'state:   OPEN',
    'number:  15',
    'url:     https://github.com/jeikl/JeikCode/pull/15',
    'additions: 3684',
    'deletions: 340',
  ].join('\n');
  const ghStats = computeToolDiffStats(
    'run_command',
    ghPrViewOutput,
    JSON.stringify({ command: 'gh pr view 15' }),
  );
  assert.equal(ghStats, null, 'Read-only gh pr view must not produce diff stats');

  // 回归测试：单行合法 git diffstat 能够在有效场景下正确解析
  const gitStatOutput = ' 2 files changed, 10 insertions(+), 5 deletions(-)';
  const validGitStats = computeToolDiffStats(
    'bash',
    gitStatOutput,
    JSON.stringify({ command: 'git apply patch.diff' }),
  );
  assert.deepEqual(validGitStats, { additions: 10, deletions: 5 });

  // 关键场景：gh diff / gh pr diff 正常展示代码变更差异 (+N -M 和 diff 视图)，但不计入已修改文件计数
  const ghPrDiffUnified = [
    'diff --git a/src/lib.rs b/src/lib.rs',
    '--- a/src/lib.rs',
    '+++ b/src/lib.rs',
    '@@ -1,2 +1,3 @@',
    ' pub fn run() {',
    '-    old();',
    '+    new_one();',
    '+    new_two();',
    ' }',
  ].join('\n');
  const ghDiffStats = computeToolDiffStats(
    'run_command',
    ghPrDiffUnified,
    JSON.stringify({ command: 'gh pr diff 15' }),
  );
  // 1. 单卡片能正常解析出变更行数 (+2 -1)
  assert.deepEqual(ghDiffStats, { additions: 2, deletions: 1 });
  // 2. 属于只读查看面板 (isViewOnlyShellDiff 为 true)
  assert.equal(
    isViewOnlyShellDiff('run_command', ghPrDiffUnified, JSON.stringify({ command: 'gh pr diff 15' })),
    true,
  );
  // 3. 绝不计入修改文件数 (isWritingTool 为 false，collectTurnDiffSummary 结果为 null)
  assert.equal(
    isWritingTool('run_command', JSON.stringify({ command: 'gh pr diff 15' })),
    false,
  );
  assert.equal(
    collectTurnDiffSummary([
      {
        kind: 'tool',
        tool: {
          name: 'run_command',
          args: JSON.stringify({ command: 'gh pr diff 15' }),
          output: ghPrDiffUnified,
        },
      },
    ] as any),
    null,
  );
});

test('collectTurnDiffSummary aggregates files across separate assistant rounds', () => {
  const firstRound = [
    {
      kind: 'tool',
      tool: {
        id: 'c1',
        name: 'edit_file',
        args: JSON.stringify({ file_path: 'a.rs' }),
        output: '@@ -1,1 +1,2 @@\n ctx\n+add',
      },
    },
  ];
  const secondRound = [
    { kind: 'text', text: 'done' },
    {
      kind: 'tool',
      tool: {
        id: 'c2',
        name: 'write_file',
        args: JSON.stringify({ file_path: 'b.rs', content: 'x' }),
        output: 'created b.rs',
      },
    },
  ];
  const summary = collectTurnDiffSummary([...firstRound, ...secondRound] as any);
  assert.equal(summary?.fileCount, 2);
  assert.ok((summary?.additions ?? 0) > 0);
});

test('collectTurnDiffSummary aggregates files and lines across turn parts', () => {
  const parts = [
    { kind: 'text', text: 'starting edits' },
    {
      kind: 'tool',
      tool: {
        id: 'c1',
        name: 'edit_file',
        args: JSON.stringify({ file_path: 'a.rs' }),
        output: '@@ -1,2 +1,3 @@\n ctx\n-del\n+add1\n+add2',
      },
    },
    {
      kind: 'tool',
      tool: {
        id: 'c2',
        name: 'write_file',
        args: JSON.stringify({ file_path: 'b.rs', content: 'x\ny\nz' }),
        output: 'created b.rs',
      },
    },
    { kind: 'text', text: 'finished' },
  ];

  const summary = collectTurnDiffSummary(parts as any);
  assert.deepEqual(summary, {
    fileCount: 2,
    additions: 5, // 2 from a.rs + 3 from b.rs
    deletions: 1, // 1 from a.rs
    toolCount: 2,
  });
});

test('isWritingTool identifies filesystem mutations and filters out git diff read-only checks', () => {
  // True for writing / editing tools
  assert.equal(isWritingTool('edit_file'), true);
  assert.equal(isWritingTool('write_file'), true);
  assert.equal(isWritingTool('global_search_replace'), true);
  assert.equal(isWritingTool('create_file'), true);

  // False for git diff and other inspection commands
  assert.equal(isWritingTool('run_command', JSON.stringify({ command: 'git diff HEAD~1' })), false);
  assert.equal(isWritingTool('bash', JSON.stringify({ command: 'git diff' })), false);
  assert.equal(isWritingTool('run_command', JSON.stringify({ command: 'git log -n 5' })), false);
  assert.equal(isWritingTool('run_command', JSON.stringify({ command: 'cat main.rs' })), false);
  assert.equal(isWritingTool('read_file'), false);

  // True for mutation shell commands
  assert.equal(isWritingTool('run_command', JSON.stringify({ command: 'echo "hello" > foo.txt' })), true);
  assert.equal(isWritingTool('run_command', JSON.stringify({ command: 'sed -i s/a/b/g file.rs' })), true);
});

test('collectTurnDiffSummary ignores git diff when counting changed files', () => {
  const parts = [
    {
      kind: 'tool',
      tool: {
        id: 'c1',
        name: 'run_command',
        args: JSON.stringify({ command: 'git diff' }),
        output: 'diff --git a/a.rs b/a.rs\n@@ -1,1 +1,2 @@\n ctx\n+add',
      },
    },
  ];
  // git diff by itself does NOT count as a changed file
  const summary = collectTurnDiffSummary(parts as any);
  assert.equal(summary, null);

  const preview = resolveToolDiffPreview(
    'run_command',
    parts[0]!.tool.output,
    parts[0]!.tool.args,
  );
  assert.equal(preview?.source, 'output');
  assert.ok(preview?.lines.some((line) => line.kind === 'add'));
  assert.equal(
    isViewOnlyShellDiff('run_command', parts[0]!.tool.output, parts[0]!.tool.args),
    true,
  );
  assert.equal(
    isViewOnlyShellDiff(
      'run_command',
      'diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-a\n+b',
      JSON.stringify({ command: 'echo x > a.rs' }),
    ),
    false,
  );
});

test('formatToolCompactJson formats multi-param read_file as single-line JSON', () => {
  const args = JSON.stringify({
    offset: 1,
    limit: 30,
    file_path: 'crates/jeikcode-config/src/endpoints.rs',
  });
  const detail = formatToolDetail('read_file', args);
  assert.equal(
    detail,
    '{"file_path": "crates/jeikcode-config/src/endpoints.rs", "offset": 1, "limit": 30}',
  );

  // Consecutive calls with different offsets produce distinct header summaries
  const nextArgs = JSON.stringify({
    offset: 31,
    limit: 30,
    file_path: 'crates/jeikcode-config/src/endpoints.rs',
  });
  const nextDetail = formatToolDetail('read_file', nextArgs);
  assert.notEqual(detail, nextDetail);
  assert.equal(
    nextDetail,
    '{"file_path": "crates/jeikcode-config/src/endpoints.rs", "offset": 31, "limit": 30}',
  );
});

test('formatToolCompactJson abbreviates long content / code strings with ellipsis', () => {
  const args = JSON.stringify({
    file_path: 'src/auth.rs',
    old_string: 'pub fn verify() {\n    let token = get_token();\n    println!("debug: {}", token);\n    return check(token);\n}',
    new_string: 'pub fn verify() {\n    return check(get_token());\n}',
  });
  const detail = formatToolDetail('edit_file', args);
  // Must be a single line without raw newlines
  assert.ok(!detail.includes('\n'), 'must not contain literal newlines');
  // Must abbreviate long payload with ellipsis
  assert.ok(detail.includes('…'), 'must abbreviate with ellipsis');
  // Must preserve key identifier file_path
  assert.ok(detail.includes('"file_path": "src/auth.rs"'));
});

test('formatToolCompactJson keeps path and query identifiers visible for search tools', () => {
  const grepArgs = JSON.stringify({
    path: 'crates/jeikcode-config',
    pattern: 'endpoints',
  });
  assert.equal(
    formatToolDetail('grep', grepArgs),
    '{"pattern": "endpoints", "path": "crates/jeikcode-config"}',
  );
});

test('formatToolCompactJson handles arrays, empty args, and non-JSON fallbacks', () => {
  // Empty arguments
  assert.equal(formatToolDetail('read_file', '{}'), '');
  assert.equal(formatToolDetail('read_file', ''), '');

  // Truncating arrays with > 3 items
  const arrayArgs = JSON.stringify({
    files: ['a.rs', 'b.rs', 'c.rs', 'd.rs', 'e.rs'],
  });
  const arrayDetail = formatToolCompactJson(arrayArgs);
  assert.equal(
    arrayDetail,
    '{"files": ["a.rs", "b.rs", "c.rs", "+2 more"]}',
  );

  // Non-JSON fallback
  assert.equal(formatToolDetail('custom', 'plain text string'), 'plain text string');
});

test('formatToolDetail preserves taskArgsSummary for task tools', () => {
  const taskArgs = JSON.stringify({
    tasks: [
      { description: 'task 1', prompt: 'do task 1', subagent_type: 'explore' },
      { description: 'task 2', prompt: 'do task 2', subagent_type: 'worker' },
    ],
  });
  assert.equal(formatToolDetail('task', taskArgs), '2 subagents');
});

test('formatToolCompactJson puts important fields before short ones', () => {
  const invertedOrderArgs = JSON.stringify({
    limit: 30,
    offset: 1,
    file_path: 'crates/jeikcode-config/src/endpoints.rs',
  });
  const detail = formatToolDetail('read_file', invertedOrderArgs);
  assert.equal(
    detail,
    '{"file_path": "crates/jeikcode-config/src/endpoints.rs", "offset": 1, "limit": 30}',
  );

  const editArgs = JSON.stringify({
    old_string: 'pub fn very_long_function_implementation() { /* code */ }',
    new_string: 'pub fn short() {}',
    file_path: 'src/lib.rs',
  });
  const editDetail = formatToolDetail('edit_file', editArgs);
  const filePathIdx = editDetail.indexOf('"file_path"');
  const oldStringIdx = editDetail.indexOf('"old_string"');
  assert.ok(filePathIdx >= 0 && oldStringIdx >= 0);
  assert.ok(filePathIdx < oldStringIdx, 'file_path should appear before old_string');
});

test('colorizeInlineJson distinguishes keys, strings, and numbers', () => {
  const spans = colorizeInlineJson('{"command": "git status", "limit": 30, "background": true}');
  assert.ok(spans);
  assert.deepEqual(
    spans!.filter((span) => span.tone !== 'punct').map((span) => [span.text, span.tone]),
    [
      ['"command"', 'key'],
      ['"git status"', 'string'],
      ['"limit"', 'key'],
      ['30', 'number'],
      ['"background"', 'key'],
      ['true', 'boolean'],
    ],
  );
  assert.equal(colorizeInlineJson('2 subagents'), null);
  assert.equal(spans!.map((span) => span.text).join(''), '{"command": "git status", "limit": 30, "background": true}');
});

