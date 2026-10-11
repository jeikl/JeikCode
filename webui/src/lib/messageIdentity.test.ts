import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSnapshotDuplicates } from './chatTerminal.ts';

test('dropSnapshotDuplicates removes tail messages already present by id', () => {
  const snapshot = [{ id: 'a' }, { id: 'b' }];
  const tail = [{ id: 'b' }, { id: 'c' }];
  assert.deepEqual(dropSnapshotDuplicates(snapshot, tail), [{ id: 'c' }]);
});

test('dropSnapshotDuplicates keeps id-less messages unchanged (legacy path)', () => {
  const snapshot = [{ id: 'a' }];
  const tail = [{} as { id?: string }, { id: 'a' }];
  // id-less tail entries are always kept; only exact id collisions are dropped.
  assert.deepEqual(dropSnapshotDuplicates(snapshot, tail) as Array<{ id?: string }>, [{}]);
});

test('dropSnapshotDuplicates is a no-op when neither side carries ids', () => {
  const snapshot = [{} as { id?: string }];
  const tail = [{} as { id?: string }];
  assert.deepEqual(dropSnapshotDuplicates(snapshot, tail), tail);
});
