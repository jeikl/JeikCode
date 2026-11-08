import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deserializeQueuedCard,
  mergeQueuedCardState,
  mergeQueuedIntoDraft,
  serializeQueuedCard,
  stashSessionQueued,
  restoreSessionQueued,
} from './queuedDraft.ts';

test('server queue state wins after refresh, while an in-flight local transition stays visible', () => {
  const staleLocal = { id: 1, kind: 'steer' };
  const serverQueue = { id: 1, kind: 'queue' };
  assert.equal(mergeQueuedCardState(serverQueue, staleLocal, false).kind, 'queue');
  assert.equal(
    mergeQueuedCardState(serverQueue, { ...staleLocal, kind: 'steering' }, false).kind,
    'queue',
    'after refresh the server-owned card state is authoritative',
  );
  assert.equal(mergeQueuedCardState(serverQueue, { ...staleLocal, kind: 'steering' }, true).kind, 'steering');
  assert.equal(
    mergeQueuedCardState({ ...serverQueue, kind: 'steer' }, { ...serverQueue, kind: 'steering' }, true).kind,
    'steer',
  );
});

test('queued card wire serialization preserves the selected approval mode and images', () => {
  const card = {
    id: 42,
    text: 'continue',
    images: [{ media_type: 'image/png', data: 'image-a' }],
    kind: 'queue' as const,
    approvalMode: 'plan' as const,
    clientInputId: 'local-only-correlation',
  };
  const wire = serializeQueuedCard(card);
  assert.deepEqual(wire, {
    id: 42,
    text: 'continue',
    images: card.images,
    kind: 'queue',
    client_input_id: 'local-only-correlation',
    approval_mode: 'plan',
  });
  const restored = deserializeQueuedCard(wire);
  assert.equal(restored.approvalMode, 'plan');
  assert.deepEqual(restored.images, card.images);
  assert.equal(restored.id, card.id);
  assert.equal(restored.clientInputId, 'local-only-correlation');

  // Legacy wire cards without the correlation id stay valid and unclaimed.
  const legacy = deserializeQueuedCard({ id: 1, text: 'legacy', kind: 'queue' as const });
  assert.equal('clientInputId' in legacy, false);
});

test('all established approval modes survive the wire contract, while legacy missing mode stays missing', () => {
  for (const approvalMode of ['build', 'plan', 'bypass', 'accept_edits'] as const) {
    const wire = serializeQueuedCard({ id: 'wire-id', kind: 'steer' as const, text: 'same', approvalMode });
    assert.equal(wire.approval_mode, approvalMode);
    assert.equal(deserializeQueuedCard(wire).approvalMode, approvalMode);
  }
  const legacy = deserializeQueuedCard({ id: 1, text: 'legacy', kind: 'queue' as const });
  assert.equal('approvalMode' in legacy, false);
});

test('invalid or malformed approval modes cannot override the current dispatch mode', () => {
  for (const invalid of ['Build', 'auto', '', 42, null, {}, true]) {
    const loaded = deserializeQueuedCard({
      id: 9, text: 'retry', kind: 'queue' as const, approval_mode: invalid as any,
    });
    assert.equal('approvalMode' in loaded, false, `invalid: ${String(invalid)}`);
    const wire = serializeQueuedCard({
      id: 9, text: 'retry', kind: 'queue' as const, approvalMode: invalid as any,
    });
    assert.equal('approval_mode' in wire, false);
  }
});

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

test('queued restore merges by client identity, not the recycled numeric id', async () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = { localStorage: mockStorage, sessionStorage: mockStorage };
  try {
    const { saveQueuedToStorage } = await import('./queuedDraft.ts');
    const map = new Map<string, Array<{ id: number; clientInputId: string; text: string }>>();
    map.set('session-1', [
      { id: 0, clientInputId: 'cid-a', text: 'queued in memory' },
    ]);
    saveQueuedToStorage(map);

    const disk = new Map<string, Array<{ id: number; clientInputId: string; text: string }>>();
    disk.set('session-1', [
      { id: 0, clientInputId: 'cid-b', text: 'same numeric id, different card' },
      { id: 0, clientInputId: 'cid-a', text: 'same card' },
    ]);
    saveQueuedToStorage(disk);
    const fresh = new Map<string, Array<{ id: number; clientInputId: string; text: string }>>();
    fresh.set('session-1', [{ id: 0, clientInputId: 'cid-a', text: 'queued in memory' }]);
    const restored = restoreSessionQueued(fresh, 'session-1');
    assert.equal(restored.length, 2, 'different identities must both survive');
    assert.deepEqual(restored.map((item) => item.clientInputId).sort(), ['cid-a', 'cid-b']);
  } finally {
    (globalThis as any).window = original;
  }
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

