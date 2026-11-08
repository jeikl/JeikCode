import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSessionTodoSnapshot } from './todoWire.ts';

test('an empty revisioned snapshot is normalized to an explicit empty list', () => {
  const detail = normalizeSessionTodoSnapshot({ todos_revision: 0 });
  assert.deepEqual(detail.todos, []);
  assert.equal(detail.todos_revision, 0);
});

test('a revisioned non-empty snapshot keeps its items untouched', () => {
  const items = [
    { content: 'done', status: 'completed' as const },
    { content: 'live', status: 'in_progress' as const },
  ];
  const detail = normalizeSessionTodoSnapshot({ todos: items, todos_revision: 7 });
  assert.equal(detail.todos, items);
  assert.equal(detail.todos_revision, 7);
});

test('a legacy daemon without revision support is not treated as empty', () => {
  const detail = normalizeSessionTodoSnapshot({});
  assert.equal(detail.todos, undefined);
});

test('a normalized empty list survives a second normalization', () => {
  const once = normalizeSessionTodoSnapshot({ todos_revision: 3 });
  const twice = normalizeSessionTodoSnapshot(once);
  assert.deepEqual(twice.todos, []);
  assert.equal(twice.todos_revision, 3);
});
