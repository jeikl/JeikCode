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
