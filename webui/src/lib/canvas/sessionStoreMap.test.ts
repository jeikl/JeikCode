import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStoreMap } from './sessionStoreMap.ts';

type Row = {
  id?: string;
  role: string;
  parts: Array<{ kind: string; text?: string }>;
  seq?: number;
};

test('SessionStoreMap keeps Map-like get/set/has/delete semantics', () => {
  const map = new SessionStoreMap<Row>();
  assert.equal(map.get('s1'), undefined);
  assert.equal(map.has('s1'), false);

  const rows: Row[] = [{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], seq: 1 }];
  map.set('s1', rows);
  assert.equal(map.has('s1'), true);
  assert.equal(map.get('s1'), rows);

  map.delete('s1');
  assert.equal(map.get('s1'), undefined);
  map.set('s2', rows);
  map.clear();
  assert.equal(map.has('s2'), false);
});
