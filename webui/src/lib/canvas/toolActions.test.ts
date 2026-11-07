import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceCanvasEvent } from './actions.ts';

type Row = {
  role: string;
  parts: Array<{ kind: string; tool?: Record<string, unknown> }>;
  seq?: number;
};

function toolOf(rows: Row[], id: string) {
  for (const row of rows) {
    for (const part of row.parts ?? []) {
      if (part.kind === 'tool' && part.tool?.id === id) return part.tool;
    }
  }
  return undefined;
}

test('tool typed actions: start, live append, replay replace, finish', () => {
  let rows: Row[] = [{ role: 'assistant', parts: [], seq: 1 }];
  rows = reduceCanvasEvent(rows, {
    type: 'tool_start',
    tool: { id: 't1', name: 'bash', args: '{}', status: 'pending' },
  });
  assert.equal(toolOf(rows, 't1')?.status, 'pending');

  rows = reduceCanvasEvent(rows, { type: 'tool_output', id: 't1', chunk: 'a' });
  rows = reduceCanvasEvent(rows, { type: 'tool_output', id: 't1', chunk: 'b' });
  assert.equal(toolOf(rows, 't1')?.output, 'ab');

  rows = reduceCanvasEvent(rows, {
    type: 'tool_output',
    id: 't1',
    chunk: 'AB',
    replay: true,
  });
  assert.equal(toolOf(rows, 't1')?.output, 'AB', 'replay replaces the accumulated output');

  rows = reduceCanvasEvent(rows, { type: 'tool_finished', id: 't1', success: true });
  assert.equal(toolOf(rows, 't1')?.status, 'done');
});

test('tool_start on an empty canvas creates an assistant row', () => {
  const rows = reduceCanvasEvent([] as Row[], {
    type: 'tool_start',
    tool: { id: 't-empty', name: 'bash', args: '{}', status: 'pending' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.role, 'assistant');
  assert.equal(toolOf(rows, 't-empty')?.status, 'pending');
});

test('tool_result rebuilds a missing tool card from the authoritative result', () => {
  const rows = reduceCanvasEvent(
    [{ role: 'assistant', parts: [], seq: 1 }],
    { type: 'tool_result', id: 'lost-start', name: 'bash', output: 'ok', success: true },
  );
  const tool = toolOf(rows, 'lost-start');
  assert.ok(tool, 'missing tool_start must not drop the result');
  assert.equal(tool?.status, 'done');
  assert.equal(tool?.output, 'ok');
});
