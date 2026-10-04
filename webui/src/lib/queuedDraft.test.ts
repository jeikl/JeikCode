import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mergeQueuedIntoDraft,
  queueAfterSessionActiveCheck,
  stashSessionQueued,
  restoreSessionQueued,
} from './queuedDraft.ts';

test('mergeQueuedIntoDraft keeps queue order ahead of the current draft', () => {
  const merged = mergeQueuedIntoDraft(
    [
      { text: 'first', images: [{ media_type: 'image/png', data: 'a' }] },
      { text: 'second', images: [{ media_type: 'image/png', data: 'b' }] },
    ],
    'draft',
    [{ media_type: 'image/jpeg', data: 'd' }],
  );
  assert.equal(merged.text, 'first\nsecond\ndraft');
  assert.deepEqual(merged.images.map((image) => image.data), ['d', 'a', 'b']);
});

test('mergeQueuedIntoDraft ignores blank queued text but keeps its images', () => {
  const merged = mergeQueuedIntoDraft(
    [{ text: '   ', images: [{ media_type: 'image/png', data: 'only' }] }],
    '',
    [],
  );
  assert.equal(merged.text, '');
  assert.equal(merged.images.length, 1);
});

test('stashSessionQueued and restoreSessionQueued isolate and restore queues across sessions', () => {
  const map = new Map<string, Array<{ text: string; kind: string }>>();

  // Session A has queued messages
  const queueA = [
    { text: 'session A message 1', kind: 'queue' },
    { text: 'session A steer message', kind: 'steer' },
  ];
  stashSessionQueued(map, 'session-A', queueA);

  // Switching to Session B: initially empty
  const restoredB = restoreSessionQueued(map, 'session-B');
  assert.deepEqual(restoredB, []);

  // Session B queues its own message
  const queueB = [{ text: 'session B follow-up', kind: 'queue' }];
  stashSessionQueued(map, 'session-B', queueB);

  // Switching back to Session A: Session A's queue and steer state are fully intact
  const restoredA = restoreSessionQueued(map, 'session-A');
  assert.equal(restoredA.length, 2);
  assert.equal(restoredA[0].text, 'session A message 1');
  assert.equal(restoredA[0].kind, 'queue');
  assert.equal(restoredA[1].text, 'session A steer message');
  assert.equal(restoredA[1].kind, 'steer');

  // Empty queue removes entry from map
  stashSessionQueued(map, 'session-A', []);
  assert.equal(map.has('session-A'), false);
  assert.deepEqual(restoreSessionQueued(map, 'session-A'), []);
});

test('loadQueuedFromStorage and saveQueuedToStorage round-trip across simulated refreshes', async () => {
  const store = new Map<string, string>();
  const mockSessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = { sessionStorage: mockSessionStorage };

  try {
    const stash = new Map<string, Array<{ text: string; kind: string }>>();
    stash.set('session-1', [
      { text: 'queued 1', kind: 'queue' },
      { text: 'steered 1', kind: 'steer' },
    ]);
    const { saveQueuedToStorage, loadQueuedFromStorage, restoreSessionQueued } = await import('./queuedDraft.ts');
    saveQueuedToStorage(stash);

    // Simulate page refresh: memory map cleared
    const freshMemoryMap = new Map<string, Array<{ text: string; kind: string }>>();
    const loadedFromStorage = loadQueuedFromStorage();
    assert.equal(loadedFromStorage.has('session-1'), true);
    assert.equal(loadedFromStorage.get('session-1')?.length, 2);

    // restoreSessionQueued falls back to storage if fresh map was empty
    const restored = restoreSessionQueued(freshMemoryMap, 'session-1');
    assert.equal(restored.length, 2);
    assert.equal(restored[0].text, 'queued 1');
    assert.equal(restored[1].text, 'steered 1');
    assert.equal(restored[1].kind, 'steer');
  } finally {
    (globalThis as any).window = original;
  }
});


