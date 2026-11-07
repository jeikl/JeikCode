import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStore } from './sessionStore.ts';

type Row = {
  id?: string;
  role: string;
  parts: Array<{ kind: string; text?: string }>;
  seq?: number;
};

test('SessionStore mirrors replace + typed dispatch and returns the new rows', () => {
  const store = new SessionStore<Row>();
  store.replace([{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], seq: 1 }]);
  const next = store.dispatch({ type: 'text', content: 'ok', messageId: 'm1' });
  assert.equal(store.current, next);
  assert.equal(store.current.length, 2);
  assert.equal(store.current[1]!.role, 'assistant');
  assert.equal(store.current[1]!.parts[0]!.text, 'ok');
});

test('authoritative display notice keeps the canvas an iterable array', () => {
  const store = new SessionStore<Row>();
  store.replace([{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], seq: 1 }]);

  // Compaction completes -> DisplayNotice -> setMessages({type:'authoritative_notice'}).
  // This action must be recognized by reduceCanvasEvent, not fall through the base
  // reducer (which used to return undefined and poison React state).
  const next = store.dispatch({
    type: 'authoritative_notice',
    id: 'notice-compact-1',
    seq: 2,
    text: '已压缩 · 摘要 3 条',
  });

  assert.ok(Array.isArray(next), 'dispatch must return rows');
  assert.equal(next.length, 2);
  assert.equal(next[1]!.role, 'system');
  assert.equal(next[1]!.id, 'notice-compact-1');
  assert.equal(store.current, next);
});

test('unknown canvas actions keep the previous rows instead of undefined', () => {
  const store = new SessionStore<Row>();
  const rows: Row[] = [{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], seq: 1 }];
  store.replace(rows);

  const next = store.dispatch({ type: 'future_unknown_action' } as never);

  assert.equal(next, rows);
  assert.equal(store.current, rows);
});
