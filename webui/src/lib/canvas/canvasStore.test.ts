import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasHasId,
  indexCanvasById,
  normalizeCanvas,
  reduceCanvas,
} from './canvasStore.ts';
import { projectCanvas } from './project.ts';

test('normalizeCanvas is a no-op (same reference) when ids and fields are complete', () => {
  const rows = [
    { id: 'a', role: 'user', kind: 'user', seq: 1 },
    { id: 'b', role: 'assistant', kind: 'model', seq: 2 },
  ];
  assert.equal(normalizeCanvas(rows), rows);
});

test('normalizeCanvas derives kind and a monotonic seq for legacy rows', () => {
  const rows = [
    { id: 'a', role: 'user', text: 'first' },
    { id: 'b', role: 'assistant', text: 'b' },
  ];
  const out = normalizeCanvas(rows);
  assert.equal(out[0]!.kind, 'user');
  assert.equal(out[1]!.kind, 'model');
  assert.equal(out[0]!.seq, 0);
  assert.equal(out[1]!.seq, 1);
  // 已经补齐后再次归一化必须返回同一引用（不再复制行）。
  assert.equal(normalizeCanvas(out), out);
});

test('normalizeCanvas keeps the server seq instead of positional sourceIndex', () => {
  // P0: display rows carry the daemon's session-global seq. `sourceIndex` is a
  // pagination cursor and must never override it (a pinned/older page can have
  // an offset that differs from the display order).
  const out = normalizeCanvas([
    { id: 'a', role: 'user', seq: 900, sourceIndex: 42 },
    { id: 'b', role: 'assistant', seq: 901, sourceIndex: 43 },
  ]);
  assert.equal(out[0]!.seq, 900);
  assert.equal(out[1]!.seq, 901);
});

test('normalizeCanvas ignores sourceIndex for seq order', () => {
  const out = normalizeCanvas([
    { id: 'a', role: 'user', sourceIndex: 42 },
    { id: 'b', role: 'assistant' },
  ]);
  assert.equal(out[0]!.seq, 0, 'sourceIndex is a page cursor, not a seq');
  assert.equal(out[1]!.seq, 1, 'keyless rows continue in array order');
});

test('normalizeCanvas collapses duplicate ids: first position, latest content', () => {
  const out = normalizeCanvas([
    { id: 'a', role: 'user', text: 'first', sourceIndex: 3 },
    { id: 'b', role: 'assistant', text: 'b', sourceIndex: 4 },
    { id: 'a', role: 'user', text: 'latest', sourceIndex: 9 },
  ]);
  assert.deepEqual(
    out.map((row) => [row.id, row.text]),
    [
      ['a', 'latest'],
      ['b', 'b'],
    ],
  );
  assert.equal(out[0]!.seq, 0, 'position and seq both come from array order');
});

test('normalizeCanvas keeps id-less legacy rows (no text merging)', () => {
  const out = normalizeCanvas([{ role: 'user', text: 'same' }, { role: 'user', text: 'same' }]);
  assert.equal(out.length, 2);
});

test('normalizeCanvas is idempotent', () => {
  const once = normalizeCanvas([
    { id: 'a', role: 'user', v: 1 },
    { id: 'a', role: 'user', v: 2 },
    { id: 'b', role: 'assistant', v: 3 },
  ]);
  assert.equal(normalizeCanvas(once), once);
});

test('reduceCanvas upsert keeps first position and latest content', () => {
  const rows = [
    { id: 'a', role: 'user', text: 'first', seq: 1 },
    { id: 'b', role: 'assistant', text: 'b', seq: 2 },
  ];
  const out = reduceCanvas(rows, {
    type: 'upsert',
    rows: [
      { id: 'a', role: 'user', text: 'latest', seq: 1 },
      { id: 'c', role: 'user', text: 'new', seq: 3 },
    ],
  });
  assert.deepEqual(out.map((row) => [row.id, row.text]), [
    ['a', 'latest'],
    ['b', 'b'],
    ['c', 'new'],
  ]);
});

test('reduceCanvas patch and remove address rows by id only', () => {
  const rows = [
    { id: 'a', role: 'user', text: 'first', seq: 1 },
    { id: 'b', role: 'assistant', text: 'b', seq: 2 },
  ];
  const patched = reduceCanvas(rows, { type: 'patch', id: 'b', patch: { text: 'patched' } });
  assert.equal(patched[1]!.text, 'patched');
  const removed = reduceCanvas(patched, { type: 'remove', id: 'a' });
  assert.deepEqual(removed.map((row) => row.id), ['b']);
  assert.equal(reduceCanvas(removed, { type: 'remove', id: 'missing' }), removed);
});

test('indexCanvasById points at the first occurrence', () => {
  const index = indexCanvasById([{ id: 'a' }, { id: 'b' }, { id: 'a' }]);
  assert.equal(index.get('a'), 0);
  assert.equal(index.get('b'), 1);
});

test('canvasHasId matches exact identity only', () => {
  const rows = [{ id: 'u-1' }, { id: 'u-2' }];
  assert.equal(canvasHasId(rows, 'u-2'), true);
  assert.equal(canvasHasId(rows, 'u-3'), false);
  assert.equal(canvasHasId(rows, undefined), false);
});

test('sourceIndex is a pagination cursor, never a seq fallback', () => {
  const rows = [
    { id: 'old-a', role: 'assistant', seq: 1569, sourceIndex: 1346 },
    { id: 'old-b', role: 'assistant', seq: 1601, sourceIndex: 1378 },
    { id: 'current', role: 'user', sourceIndex: 1496 },
  ];
  const next = normalizeCanvas(rows);
  assert.equal(next[2]!.seq, 1602, 'keyless tail row continues after display seq');
  assert.deepEqual(next.map((row) => row.id), ['old-a', 'old-b', 'current']);
});

test('normalizeCanvas interpolates keyless head/middle rows before keyed rows so projectCanvas never sorts user below answer', () => {
  // 1) Head insertion (e.g. placeRecoveredTurnUsers placing opening user before answer seq=50)
  const headPlaced = normalizeCanvas([
    { id: 'u-open', role: 'user' },
    { id: 'a-ans', role: 'assistant', seq: 50 },
  ]);
  assert.ok(headPlaced[0]!.seq! < headPlaced[1]!.seq!);
  assert.deepEqual(projectCanvas(headPlaced).map((r) => r.id), ['u-open', 'a-ans']);

  // 2) Sandwich insertion between seq=40 and seq=42
  const midPlaced = normalizeCanvas([
    { id: 'a-prev', role: 'assistant', seq: 40 },
    { id: 'u-cur', role: 'user' },
    { id: 'a-live', role: 'assistant', seq: 42 },
  ]);
  assert.ok(midPlaced[0]!.seq! < midPlaced[1]!.seq! && midPlaced[1]!.seq! < midPlaced[2]!.seq!);
  assert.deepEqual(projectCanvas(midPlaced).map((r) => r.id), ['a-prev', 'u-cur', 'a-live']);

  // 3) Duplicate id where first occurrence had no seq and duplicate had seq > intermediate assistant
  const dup = normalizeCanvas([
    { id: 'u-1', role: 'user' },
    { id: 'a-1', role: 'assistant', seq: 11 },
    { id: 'u-1', role: 'user', seq: 99 },
  ]);
  assert.deepEqual(projectCanvas(dup).map((r) => r.id), ['u-1', 'a-1']);
});

