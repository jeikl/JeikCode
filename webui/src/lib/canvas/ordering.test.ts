import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceCanvasEvent } from './actions.ts';

/**
 * Regression matrix for “later round usurps the earlier round while streaming”.
 *
 * A late `/chat/watch` subscriber can resume from a cursor inside the current
 * turn, so it may paint round N+1 before replay delivers round N. New assistant
 * rows must be inserted by the stream seq of their first frame, not appended.
 * The same rule applies to reasoning, ordinary text, and tool-only rounds.
 */

type Row = {
  id?: string;
  role: string;
  sourceIndex?: number;
  seq?: number;
  parts: Array<{ kind: string; text?: string; tool?: { id: string } }>;
};

const user = (): Row => ({
  role: 'user',
  id: 'u1',
  parts: [{ kind: 'text', text: 'q1' }],
});

const reasoning = (id: string, content: string, seq: number, rev = 1) => ({
  type: 'reasoning' as const,
  content,
  messageId: id,
  partId: `${id}:1:reasoning`,
  partRev: rev,
  recordSeq: seq,
});

const text = (id: string, content: string, seq: number, rev = 1) => ({
  type: 'text' as const,
  content,
  messageId: id,
  partId: `${id}:2:text`,
  partRev: rev,
  recordSeq: seq,
});

const tool = (id: string, callId: string, seq: number) => ({
  type: 'tool_start' as const,
  messageId: id,
  tool: { id: callId, name: 'read', args: '{}', status: 'pending' as const },
  recordSeq: seq,
});

const toolResult = (id: string, callId: string) => ({
  type: 'tool_result' as const,
  id: callId,
  name: 'read',
  output: 'ok',
  success: true,
});

const ids = (rows: Row[]) => rows.map((row) => row.id);
const parts = (rows: Row[], id: string) => {
  const row = rows.find((candidate) => candidate.id === id);
  return (row?.parts ?? []).map((part) => (
    part.kind === 'tool' ? `tool:${part.tool?.id}` : `${part.kind}:${part.text}`
  ));
};
const fold = (rows: Row[], events: Array<{ type: string }>) => (
  events.reduce((acc, event) => reduceCanvasEvent(acc as any, event as any) as Row[], rows)
);

test('reasoning of a later round never usurps an earlier round replayed late', () => {
  const rows = fold([user()], [
    reasoning('m2', 'r2ing', 20),
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  assert.deepEqual(parts(rows, 'm1'), ['reasoning:r1', 'tool:tool1']);
  assert.deepEqual(parts(rows, 'm2'), ['reasoning:r2ing']);
});

test('text of a later round never usurps an earlier round replayed late', () => {
  const rows = fold([user()], [
    text('m2', 't2ing', 20),
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  assert.deepEqual(parts(rows, 'm1'), ['reasoning:r1', 'tool:tool1']);
  assert.deepEqual(parts(rows, 'm2'), ['text:t2ing']);
});

test('tool-only rounds are ordered and keep their round identity', () => {
  const rows = fold([user()], [
    tool('m2', 'tool2', 20),
    tool('m1', 'tool1', 10),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  assert.deepEqual(parts(rows, 'm1'), ['tool:tool1']);
  assert.deepEqual(parts(rows, 'm2'), ['tool:tool2']);
});

test('interleaved later-round frames are repaired when the earlier round arrives', () => {
  const rows = fold([user()], [
    reasoning('m2', 'r2ing', 20),
    tool('m2', 'tool2', 21),
    text('m2', 't2ing', 22),
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
    text('m1', 't1', 12),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  assert.deepEqual(parts(rows, 'm1'), ['reasoning:r1', 'tool:tool1', 'text:t1']);
  assert.deepEqual(parts(rows, 'm2'), ['reasoning:r2ing', 'tool:tool2', 'text:t2ing']);
});

test('a normal in-order stream is unchanged', () => {
  const rows = fold([user()], [
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
    reasoning('m2', 'r2ing', 20),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
});

test('an id-less placeholder is stamped with its round seq before an earlier round arrives', () => {
  const rows = fold([user(), { role: 'assistant', parts: [] } as Row], [
    reasoning('m2', 'r2ing', 20),
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  assert.deepEqual(parts(rows, 'm2'), ['reasoning:r2ing']);
});

test('persisted disk rows use a different seq coordinate and stay ahead of live rows', () => {
  const disk: Row = {
    role: 'assistant',
    id: 'disk',
    sourceIndex: 50,
    seq: 1200,
    parts: [{ kind: 'text', text: 'old' }],
  };
  const rows = fold([user(), disk], [
    reasoning('m2', 'r2ing', 20),
    reasoning('m1', 'r1', 10),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'disk', 'm1', 'm2']);
});

test('replaying the whole unordered batch is idempotent', () => {
  const events = [
    reasoning('m2', 'r2ing', 20),
    text('m2', 't2ing', 22),
    tool('m2', 'tool2', 21),
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
    text('m1', 't1', 12),
  ];
  const once = fold([user()], events);
  const replayed = fold(once, events);
  assert.deepEqual(ids(replayed), ids(once));
  assert.deepEqual(parts(replayed, 'm1'), parts(once, 'm1'));
  assert.deepEqual(parts(replayed, 'm2'), parts(once, 'm2'));
});

test('streaming tool output of the later round stays on its own row', () => {
  let rows = fold([user()], [tool('m2', 'tool2', 20)]);
  rows = reduceCanvasEvent(rows as any, {
    type: 'tool_output',
    id: 'tool2',
    chunk: 'ing',
    replay: false,
  } as any) as Row[];
  rows = fold(rows, [tool('m1', 'tool1', 10)]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  const m2 = rows.find((row) => row.id === 'm2')!;
  assert.equal((m2.parts[0] as { tool?: { output?: string } }).tool?.output, 'ing');
});

test('later reasoning deltas keep merging into the repaired later row', () => {
  let rows = fold([user()], [
    reasoning('m2', 'r2ing', 20),
    reasoning('m1', 'r1', 10),
  ]);
  rows = fold(rows, [reasoning('m2', ' more', 22, 2)]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  assert.deepEqual(parts(rows, 'm2'), ['reasoning:r2ing more']);
});

test('settling the later round tool result does not regress the repaired order', () => {
  const rows = fold([user()], [
    reasoning('m2', 'r2ing', 20),
    tool('m1', 'tool1', 10),
    reasoning('m1', 'r1', 11),
    tool('m2', 'tool2', 21),
    toolResult('m2', 'tool2'),
  ]);
  assert.deepEqual(ids(rows), ['u1', 'm1', 'm2']);
  const m2 = rows.find((row) => row.id === 'm2')!;
  assert.equal(m2.parts[0]?.kind, 'reasoning');
  assert.equal(m2.parts[1]?.kind, 'tool');
  assert.equal((m2.parts[1] as { tool?: { status?: string } }).tool?.status, 'done');
});

test('an anchored replay row is reinserted before the opening user, not appended', () => {
  const opening = { role: 'user', id: 'q2', parts: [{ kind: 'text', text: 'q2' }] } as Row;
  const current = { role: 'assistant', id: 'm-current', parts: [{ kind: 'text', text: 'r2' }] } as Row;
  const events = [
    { ...reasoning('m-prev', 'r1', 20), beforeMessageId: 'q2' },
    { ...tool('m-prev', 'tool1', 21), beforeMessageId: 'q2' },
  ];
  let rows = fold([opening, current], events);
  assert.deepEqual(ids(rows), ['m-prev', 'q2', 'm-current']);
  assert.deepEqual(parts(rows, 'm-prev'), ['reasoning:r1', 'tool:tool1']);

  // Replaying the same anchored frames must be idempotent: no duplicate row,
  // no second copy of the tool, and the anchor position stays.
  rows = fold(rows, events);
  assert.deepEqual(ids(rows), ['m-prev', 'q2', 'm-current']);
  assert.deepEqual(parts(rows, 'm-prev'), ['reasoning:r1', 'tool:tool1']);
});

test('an anchored text replay is reinserted before the opening user too', () => {
  const opening = { role: 'user', id: 'q2', parts: [{ kind: 'text', text: 'q2' }] } as Row;
  const current = { role: 'assistant', id: 'm-current', parts: [{ kind: 'text', text: 'r2' }] } as Row;
  const rows = fold([opening, current], [
    { ...text('m-prev', 'r1stop', 20), beforeMessageId: 'q2' },
  ]);
  assert.deepEqual(ids(rows), ['m-prev', 'q2', 'm-current']);
  assert.deepEqual(parts(rows, 'm-prev'), ['text:r1stop']);
});

test('multiple held rows keep their arrival order before the opening user', () => {
  const opening = { role: 'user', id: 'q2', parts: [{ kind: 'text', text: 'q2' }] } as Row;
  const current = { role: 'assistant', id: 'm-current', parts: [{ kind: 'text', text: 'r2' }] } as Row;
  const events = [
    { ...reasoning('m-prev1', 'r1 first', 20), beforeMessageId: 'q2' },
    { ...tool('m-prev1', 'tool1', 21), beforeMessageId: 'q2' },
    { ...text('m-prev1', 'r1stop', 22), beforeMessageId: 'q2' },
    { ...reasoning('m-prev2', 'r2 first', 23), beforeMessageId: 'q2' },
  ];
  const rows = fold([opening, current], events);
  assert.deepEqual(ids(rows), ['m-prev1', 'm-prev2', 'q2', 'm-current']);
  assert.deepEqual(parts(rows, 'm-prev1'), ['reasoning:r1 first', 'tool:tool1', 'text:r1stop']);
  assert.deepEqual(parts(rows, 'm-prev2'), ['reasoning:r2 first']);
});

test('different arrival permutations converge to the same display order', () => {
  const frames = [
    reasoning('m1', 'r1', 10),
    tool('m1', 'tool1', 11),
    reasoning('m2', 'r2ing', 20),
    tool('m2', 'tool2', 21),
  ];
  const permutations = [
    [0, 1, 2, 3],
    [2, 3, 0, 1],
    [2, 0, 3, 1],
    [3, 2, 1, 0],
    [1, 3, 0, 2],
  ];
  for (const order of permutations) {
    const rows = fold([user()], order.map((index) => frames[index]!));
    assert.deepEqual(ids(rows), ['u1', 'm1', 'm2'], `permutation ${order.join('')}`);
  }
});
