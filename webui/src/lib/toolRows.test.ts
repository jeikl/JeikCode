import { test } from 'node:test';
import assert from 'node:assert';
import {
  appendToolOutput,
  finalizeToolsAfterTurn,
  MAX_LIVE_TOOL_OUTPUT,
  settleToolRow,
  toolResultStatus,
  updateToolProgress,
  upsertToolPart,
  withTrailingTodoList,
  type MsgPart,
  type ToolRow,
} from './toolRows.ts';

const tool = (id: string, over: Partial<ToolRow> = {}): ToolRow => ({
  id,
  name: 'grep',
  args: '"foo"',
  status: 'pending',
  ...over,
});

test('a new tool id is appended as a tool part', () => {
  const parts: MsgPart[] = [{ kind: 'text', text: 'hi' }];
  const next = upsertToolPart(parts, tool('a'));
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { kind: 'tool', tool: tool('a') });
});

test('replaying the SAME tool id updates in place — no duplicate row', () => {
  // The webui bug: a duplicate /live subscription re-delivers the same
  // tool_start, which must NOT create a second row.
  const parts: MsgPart[] = [{ kind: 'tool', tool: tool('a') }];
  const again = upsertToolPart(parts, tool('a', { status: 'done', duration_ms: 12 }));
  assert.equal(again.length, 1, 'same id must not append a second row');
  assert.equal(again[0].kind, 'tool');
  const t = (again[0] as { kind: 'tool'; tool: ToolRow }).tool;
  assert.equal(t.status, 'done');
  assert.equal(t.duration_ms, 12);
  assert.equal(t.name, 'grep'); // prior fields preserved via merge
});

test('distinct tool ids each keep their own row (genuine repeat calls)', () => {
  // Different call_ids = different logical calls (e.g. across goal rounds) and
  // must stay as separate rows — dedup is by id, never by name+args.
  let parts: MsgPart[] = [];
  parts = upsertToolPart(parts, tool('a'));
  parts = upsertToolPart(parts, tool('b'));
  assert.equal(parts.length, 2);
});

test('appendToolOutput writes to the matching call id, not the latest row', () => {
  let parts: MsgPart[] = [
    { kind: 'tool', tool: tool('a', { name: 'bash' }) },
    { kind: 'tool', tool: tool('b', { name: 'bash' }) },
  ];
  parts = appendToolOutput(parts, 'a', 'hello');
  parts = appendToolOutput(parts, 'b', 'world');
  const a = parts[0]!.kind === 'tool' ? parts[0].tool : undefined;
  const b = parts[1]!.kind === 'tool' ? parts[1].tool : undefined;
  assert.equal(a?.output, 'hello');
  assert.equal(b?.output, 'world');
});

test('appendToolOutput falls back to the most recent tool when id is missing', () => {
  const parts = appendToolOutput(
    [
      { kind: 'text', text: 'hi' },
      { kind: 'tool', tool: tool('a') },
    ],
    undefined,
    'out',
  );
  assert.equal(parts[1]!.kind === 'tool' ? parts[1].tool.output : undefined, 'out');
});

test('appendToolOutput normalizes isolated carriage returns into newlines', () => {
  let parts: MsgPart[] = [{ kind: 'tool', tool: tool('a', { name: 'run_command' }) }];
  parts = appendToolOutput(parts, 'a', 'Downloading A (38 kB)\r');
  parts = appendToolOutput(parts, 'a', 'Downloading B (7.0 kB)\r');
  const a = parts[0]!.kind === 'tool' ? parts[0].tool : undefined;
  assert.equal(a?.output, 'Downloading A (38 kB)\nDownloading B (7.0 kB)\n');
});

test('appendToolOutput keeps a bounded tail on huge streams', () => {
  const huge = 'x'.repeat(MAX_LIVE_TOOL_OUTPUT + 50);
  const parts = appendToolOutput([{ kind: 'tool', tool: tool('a') }], 'a', huge);
  const output = parts[0]!.kind === 'tool' ? parts[0].tool.output ?? '' : '';
  assert.equal(output.length, MAX_LIVE_TOOL_OUTPUT);
  assert.equal(output, 'x'.repeat(MAX_LIVE_TOOL_OUTPUT));
});

test('upsertToolPart replaces live progress instead of accumulating it', () => {
  const first = updateToolProgress([{ kind: 'tool', tool: tool('a') }], 'a', 'round 1 · thinking');
  const second = updateToolProgress(first, 'a', 'round 2 · read_file');
  const current = second[0].kind === 'tool' ? second[0].tool : undefined;

  assert.equal(current?.progress, 'round 2 · read_file');
});

test('non-tool parts and ordering are preserved', () => {
  const parts: MsgPart[] = [
    { kind: 'text', text: 'before' },
    { kind: 'tool', tool: tool('a') },
  ];
  const next = upsertToolPart(parts, tool('a', { status: 'done' }));
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { kind: 'text', text: 'before' });
});

test('partial review result is incomplete rather than a clean success or generic failure', () => {
  assert.equal(toolResultStatus(false, 'Code review incomplete (MaxRounds)'), 'incomplete');
});

test('bash await-decision keeps the original row pending', () => {
  assert.equal(
    toolResultStatus(true, '[bash-await-decision]\nPID: 1001\n', 'bash'),
    'pending',
  );
  // Canonical tool name is run_command; `bash` is only an alias. A long
  // foreground command (for example sleep) yields this marker while the
  // process is still alive, so the canonical name must stay pending too.
  assert.equal(
    toolResultStatus(true, '[bash-await-decision]\nPID: 1001\n', 'run_command'),
    'pending',
  );
});

test('quoting [bash-await-decision] in a non-bash tool does not keep it running', () => {
  const guide = [
    '# tools',
    'idle → `[bash-await-decision]`, then the model decides',
  ].join('\n');
  assert.equal(toolResultStatus(true, guide, 'jeikcode_config_guide'), 'done');
  assert.equal(toolResultStatus(true, guide), 'done');
});

test('replaying tool_start after tool_result does not regress status or drop output', () => {
  const parts: MsgPart[] = [
    {
      kind: 'tool',
      tool: tool('a', {
        name: 'jeikcode_config_guide',
        status: 'done',
        output: 'full guide',
        duration_ms: 8,
      }),
    },
  ];
  const next = upsertToolPart(
    parts,
    tool('a', { name: 'jeikcode_config_guide', status: 'pending' }),
  );
  const row = next[0]!.kind === 'tool' ? next[0].tool : undefined;
  assert.equal(row?.status, 'done');
  assert.equal(row?.output, 'full guide');
  assert.equal(row?.duration_ms, 8);
});

test('redirected shell heartbeat stays pending until the result arrives', () => {
  let parts: MsgPart[] = upsertToolPart([], tool('shell-redirect', { name: 'run_command' }));
  parts = updateToolProgress(
    parts,
    'shell-redirect',
    '[note: stdout is redirected to `probe.log`; live output stays empty until the command exits.]',
  );
  parts = updateToolProgress(
    parts,
    'shell-redirect',
    '[still running: 40s total, 40s without output (pid 1234); stdout is redirected to a file]',
  );
  const pending = parts[0]!.kind === 'tool' ? parts[0].tool : undefined;
  assert.equal(pending?.status, 'pending');
  assert.match(pending?.progress ?? '', /still running/);

  parts = upsertToolPart(
    parts,
    tool('shell-redirect', {
      name: 'run_command',
      status: toolResultStatus(true, 'done [exit code 0]', 'run_command'),
      output: 'done [exit code 0]',
    }),
  );
  const settled = parts[0]!.kind === 'tool' ? parts[0].tool : undefined;
  assert.equal(settled?.status, 'done');
});

test('finalizeToolsAfterTurn 不把无结果的僵尸工具行假完成（有输出也不行）', () => {
  // 有输出但从来没收到 tool_result：进程可能是被停掉/杀掉的，不能声称「完成」。
  const withOutput = finalizeToolsAfterTurn([
    { kind: 'tool', tool: tool('zombie-with-output', { name: 'run_command', output: '[still running: 80s total (pid 9527)]' }) },
  ]);
  assert.equal(
    withOutput[0]!.kind === 'tool' ? withOutput[0].tool.status : '',
    'incomplete',
    '有输出但无结果 ≠ 成功，必须落成未完成',
  );

  const withoutOutput = finalizeToolsAfterTurn([
    {
      kind: 'tool',
      tool: tool('redirect-no-result', {
        name: 'run_command',
        progress: '[note: stdout is redirected to `probe.log`]',
      }),
    },
  ]);
  assert.equal(withoutOutput[0]!.kind === 'tool' ? withoutOutput[0].tool.status : '', 'incomplete');
});

test('finalizeToolsAfterTurn settles leftover pending rows except live bash await', () => {
  const parts: MsgPart[] = [
    { kind: 'tool', tool: tool('guide', { name: 'jeikcode_config_guide', output: 'docs' }) },
    {
      kind: 'tool',
      tool: tool('bash', {
        name: 'bash',
        output: '[bash-await-decision]\nPID: 1001\n',
      }),
    },
    { kind: 'tool', tool: tool('empty', { name: 'grep' }) },
  ];
  const next = finalizeToolsAfterTurn(parts);
  assert.equal(next[0]!.kind === 'tool' ? next[0].tool.status : '', 'incomplete');
  assert.equal(next[1]!.kind === 'tool' ? next[1].tool.status : '', 'pending');
  assert.equal(next[2]!.kind === 'tool' ? next[2].tool.status : '', 'incomplete');
});

test('finalizeToolsAfterTurn keeps canonical run_command await-decision pending', () => {
  const next = finalizeToolsAfterTurn([
    {
      kind: 'tool',
      tool: tool('run-command', {
        name: 'run_command',
        output: '[bash-await-decision]\nPID: 1002\n',
      }),
    },
  ]);
  assert.equal(next[0]!.kind === 'tool' ? next[0].tool.status : '', 'pending');
});


test('settleToolRow 让短工具在长工具未完成时先落 √（不动 output/duration）', () => {
  // tool_finished 只负责状态：权威 tool_result 仍按整批发射顺序到达，
  // 它才带 output 与 duration_ms。
  assert.deepEqual(
    settleToolRow(tool('fast', { output: 'partial', progress: 'working' }), true),
    { status: 'done', progress: undefined },
  );
  assert.deepEqual(
    settleToolRow(tool('boom', { name: 'bash' }), false),
    { status: 'error', progress: undefined },
  );
});

test('settleToolRow 不把还在等用户决定的 bash 行落成完成', () => {
  // 进程还活着、在执行里等决定：执行返回 ≠ 完成，交给权威结果帧判定。
  for (const name of ['bash', 'run_command']) {
    assert.equal(
      settleToolRow(tool('await', { name, output: '[bash-await-decision]\nPID: 1001\n' }), true),
      undefined,
    );
  }
});

test('settleToolRow 幂等：已终态的行不因迟到帧回退', () => {
  for (const status of ['done', 'error', 'incomplete'] as const) {
    assert.equal(settleToolRow(tool('t', { status }), false), undefined);
  }
});

test('withTrailingTodoList appends or replaces a trailing todo_list part', () => {
  const items = [
    { content: 'a', status: 'completed' as const },
    { content: 'b', status: 'pending' as const },
  ];
  const base: MsgPart[] = [
    { kind: 'text', text: 'done' },
    { kind: 'tool', tool: tool('t1', { name: 'todowrite' }) },
  ];
  const once = withTrailingTodoList(base, items);
  assert.equal(once.length, 3);
  assert.equal(once[2]!.kind, 'todo_list');
  if (once[2]!.kind === 'todo_list') {
    assert.equal(once[2].items.length, 2);
    assert.equal(once[2].items[0]!.content, 'a');
  }
  const twice = withTrailingTodoList(once, [{ content: 'only', status: 'in_progress' }]);
  assert.equal(twice.filter((p) => p.kind === 'todo_list').length, 1);
  assert.equal(twice[twice.length - 1]!.kind, 'todo_list');
  if (twice[twice.length - 1]!.kind === 'todo_list') {
    assert.equal(twice[twice.length - 1].items[0]!.content, 'only');
  }
  assert.deepEqual(withTrailingTodoList(once, []), base);
});
