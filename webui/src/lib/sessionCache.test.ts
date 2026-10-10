import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMemorySession,
  hasMemorySession,
  saveSessionCache,
  appendMessageToSessionCache,
  clearAllSessionCache,
} from './sessionCache.ts';

test('sessionCache manages L1 memory LRU correctly', async () => {
  const p = 'proj-1';
  const s = 'sess-1';
  await clearAllSessionCache();
  assert.equal(hasMemorySession(p, s), false);

  await saveSessionCache(p, s, [{ role: 'user', content: 'hello' }]);
  assert.equal(hasMemorySession(p, s), true);

  const mem = getMemorySession(p, s);
  assert.ok(mem);
  assert.equal(mem?.messages.length, 1);
  assert.equal(mem?.messages[0].content, 'hello');

  appendMessageToSessionCache(p, s, { role: 'assistant', content: 'world' });
  const updated = getMemorySession(p, s);
  assert.equal(updated?.messages.length, 2);

  await clearAllSessionCache();
  assert.equal(hasMemorySession(p, s), false);
});

test('sessionCache preserves turns outline', async () => {
  const p = 'proj-2';
  const s = 'sess-2';
  const turns = [{ index: 0, ordinal: 0, text: 'Q1' }, { index: 1, ordinal: 1, text: 'Q2' }];
  await saveSessionCache(p, s, [{ role: 'user', content: 'Q1' }], undefined, undefined, turns);
  const mem = getMemorySession(p, s);
  assert.ok(mem);
  assert.deepEqual(mem?.turns, turns);
  await clearAllSessionCache();
});
