/**
 * L5-lite: replay / refresh / switch matrix.
 *
 * These are the invariants the canvas must satisfy before any legacy heuristic
 * is deleted. Everything here runs against the pure projection functions — no
 * DOM, no daemon.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCanvas } from './canvas/canvasStore.ts';
import {
  paintAssistantNotice,
  paintAssistantText,
  paintUserMessage,
  spliceAuthoritativeDiskTail,
} from './sessionProjection.ts';

type Row = {
  id?: string;
  seq?: number;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ kind: 'text' | 'notice' | 'tool'; text?: string; tool?: { id: string; name: string; status: string } }>;
  clientInputId?: string;
  sourceIndex?: number;
};

const user = (id: string, text: string, seq: number): Row => ({
  id,
  seq,
  role: 'user',
  parts: [{ kind: 'text', text }],
});

const answer = (id: string, text: string, seq: number): Row => ({
  id,
  seq,
  role: 'assistant',
  parts: [{ kind: 'text', text }],
});

function replayUser(canvas: Row[], id: string, text: string): Row[] {
  return paintUserMessage(canvas as any, text, 1000, () => user(id, text, 99) as any, {
    clientInputId: id,
  }) as unknown as Row[];
}

test('replaying the same user event 10 times never duplicates', () => {
  let canvas: Row[] = [];
  for (let i = 0; i < 10; i += 1) canvas = replayUser(canvas, 'u-1', '同一句提问');
  assert.equal(canvas.filter((row) => row.role === 'user').length, 1);
  assert.equal(canvas[0]!.id, 'u-1');
});

test('replaying the same assistant delta 10 times is idempotent by part revision', () => {
  let canvas: Row[] = [user('u-1', '问', 1)];
  for (let i = 0; i < 10; i += 1) {
    canvas = paintAssistantText(
      canvas as any,
      i === 0 ? '回答' : '回答',
      i > 0,
      'm-1',
      'm-1:1:text',
      1,
    ) as unknown as Row[];
  }
  assert.equal(canvas.filter((row) => row.role === 'assistant').length, 1);
  assert.equal(canvas[1]!.parts.map((part) => part.text).join(''), '回答');
});

test('cache + authoritative tail + replay keeps one copy of each row', () => {
  const cached = [user('u-1', '第一问', 1), answer('a-1', '第一答', 2)];
  const disk = [user('u-1', '第一问', 1), answer('a-1', '第一答', 2), user('u-2', '第二问', 3)];
  const spliced = spliceAuthoritativeDiskTail(cached as any, disk as any, 2) as unknown as Row[];
  const merged = replayUser(spliced, 'u-2', '第二问');
  const once = normalizeCanvas(merged as any) as unknown as Row[];
  const twice = normalizeCanvas(once as any) as unknown as Row[];
  assert.equal(once.filter((row) => row.id === 'u-2').length, 1);
  assert.equal(twice.length, once.length);
  assert.deepEqual(twice.map((row) => row.id), ['u-1', 'a-1', 'u-2']);
});

test('two same-text sends with different ids remain two user rows', () => {
  let canvas: Row[] = [];
  canvas = replayUser(canvas, 'u-a', '重复内容');
  canvas = replayUser(canvas, 'u-b', '重复内容');
  assert.equal(canvas.filter((row) => row.role === 'user').length, 2);
  assert.deepEqual(
    canvas.filter((row) => row.role === 'user').map((row) => row.id),
    ['u-a', 'u-b'],
  );
});

test('notice is a top-level system record placed by seq, not an assistant part', () => {
  const canvas: Row[] = [user('u-1', '问', 1), answer('a-1', '答', 2)];
  const withNotice = paintAssistantNotice(canvas as any, '已压缩', 'a-1') as unknown as Row[];
  assert.equal(withNotice.length, 3);
  assert.equal(withNotice[2]!.role, 'system');
  assert.equal(withNotice[2]!.parts[0]!.kind, 'notice');
  assert.equal(withNotice[2]!.seq, 2.5);
  // Replaying the notice must not add a second row.
  assert.equal(paintAssistantNotice(withNotice as any, '已压缩', 'a-1'), withNotice);
});

test('session switch never mixes rows from another session', () => {
  const a = normalizeCanvas([user('a-u', 'A 问', 1)] as any) as unknown as Row[];
  const b = normalizeCanvas([user('b-u', 'B 问', 1)] as any) as unknown as Row[];
  assert.deepEqual(a.map((row) => row.id), ['a-u']);
  assert.deepEqual(b.map((row) => row.id), ['b-u']);
  assert.notEqual(a, b);
});
