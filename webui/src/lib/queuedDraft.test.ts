import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendRejectedChatRetry,
  dispatchRejectedChatRetryAfterQueueClear,
  isUnacceptedChatRetry,
  mergeQueuedIntoDraft,
  queueAfterSessionActiveCheck,
  queuedItemAlreadyDelivered,
  queuedPayloadHasContent,
  rejectedChatRetryId,
  restoreRejectedChatRetry,
  shouldHydrateServerQueuedItem,
  queuedSendStillOwnsView,
  restoreQueuedFromServer,
  serializeQueuedForServer,
  serializeSessionQueueWrite,
  stashSessionQueued,
  restoreSessionQueued,
} from './queuedDraft.ts';

test('409 retry retains distinct repeated prompts, images and approval modes until submitted', () => {
  const olderUserText = (text: string) => text === 'continue';
  const first = {
    id: rejectedChatRetryId('request-a'),
    text: 'continue',
    kind: 'queue' as const,
    images: [{ media_type: 'image/png', data: 'image-a' }],
    approvalMode: 'build',
  };
  const second = {
    id: rejectedChatRetryId('request-b'),
    text: 'continue',
    kind: 'queue' as const,
    images: [{ media_type: 'image/png', data: 'image-b' }],
    approvalMode: 'plan',
  };
  const queuedOnce = appendRejectedChatRetry([], first);
  assert.equal(appendRejectedChatRetry(queuedOnce, first), queuedOnce,
    'the same rejected request may only be queued once');
  const queuedTwice = appendRejectedChatRetry(queuedOnce, second);
  assert.equal(queuedTwice.length, 2, 'distinct submissions do not dedupe by text');
  const restoredFirst = restoreRejectedChatRetry([second], first);
  assert.deepEqual(restoredFirst.map((item) => item.id), [first.id, second.id]);
  assert.strictEqual(restoreRejectedChatRetry(restoredFirst, first), restoredFirst);
  assert.deepEqual(queuedTwice.map((q) => q.images[0].data), ['image-a', 'image-b']);
  assert.deepEqual(queuedTwice.map((q) => q.approvalMode), ['build', 'plan']);
  assert.equal(queuedItemAlreadyDelivered(first, olderUserText), false);
  assert.equal(queuedItemAlreadyDelivered(second, olderUserText), false);
  assert.equal(queuedItemAlreadyDelivered({ id: 1, text: 'continue', kind: 'queue' }, olderUserText), true,
    'ordinary historical replay dedup remains unchanged');
  assert.equal(isUnacceptedChatRetry({ ...first, kind: 'steer' }), false,
    'an explicitly steered retry is no longer an unsubmitted queue item');
  assert.equal(isUnacceptedChatRetry({ ...first, kind: 'steering' }), true,
    'a pending HTTP steer has not yet been accepted and cannot be history-deduped');
  assert.equal(queuedItemAlreadyDelivered({ ...first, kind: 'steering' }, olderUserText), false,
    'A→B→A while postChatSteer is pending must preserve the retry for a possible failure');
});

test('409 retry identity survives existing local/server queue JSON shape', () => {
  const original = [{ id: rejectedChatRetryId('request-c'), text: 'repeat', kind: 'queue' as const }];
  const stored = JSON.parse(JSON.stringify(original));
  assert.equal(stored[0].id, original[0].id);
  assert.equal(queuedItemAlreadyDelivered(stored[0], () => true), false,
    'an old transcript cannot erase the unaccepted retry after refresh');
});

test('accepted rejected-chat retry is not sent before acknowledged server queue removal', async () => {
  let acceptClear: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { acceptClear = resolve; });
  let sends = 0;
  let restored = 0;
  const dispatch = dispatchRejectedChatRetryAfterQueueClear(
    () => waiting, () => true, () => { sends++; }, () => { restored++; },
  );
  assert.equal(sends, 0, 'admission must not race queue-clear receipt');
  acceptClear?.();
  assert.equal(await dispatch, true);
  assert.equal(sends, 1);
  assert.equal(restored, 0);

  const failed = await dispatchRejectedChatRetryAfterQueueClear(
    async () => { throw new Error('server unavailable'); },
    () => true, () => { sends++; }, () => { restored++; },
  );
  assert.equal(failed, false);
  assert.equal(sends, 1, 'failed queue removal cannot produce an accepted/stale retry');
  assert.equal(restored, 1);
  const switched = await dispatchRejectedChatRetryAfterQueueClear(
    async () => {}, () => false, () => { sends++; }, () => { restored++; },
  );
  assert.equal(switched, false, 'a queued retry cannot submit into another viewed session');
  assert.equal(sends, 1);
  assert.equal(restored, 2);
});

test('server queue writes stay ordered per session and clear follows a delayed enqueue', async () => {
  const tails = new Map<string, Promise<void>>();
  const timeline: string[] = [];
  let completeEnqueue: (() => void) | undefined;
  const waitEnqueue = new Promise<void>((resolve) => { completeEnqueue = resolve; });
  const first = serializeSessionQueueWrite(tails, 'A', async () => {
    timeline.push('enqueue:start');
    await waitEnqueue;
    timeline.push('enqueue:ack');
  });
  const clear = serializeSessionQueueWrite(tails, 'A', async () => { timeline.push('clear:ack'); });
  // Allow the promise-chained first writer to actually enter its async body.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(timeline, ['enqueue:start']);
  completeEnqueue?.();
  await Promise.all([first, clear]);
  assert.deepEqual(timeline, ['enqueue:start', 'enqueue:ack', 'clear:ack']);
  await serializeSessionQueueWrite(tails, 'B', async () => { throw new Error('offline'); }).catch(() => {});
  await serializeSessionQueueWrite(tails, 'B', async () => { timeline.push('B:recovered'); });
  assert.equal(timeline.at(-1), 'B:recovered');
});

test('GET snapshot formed before confirmed queue-clear cannot resurrect that request ID', () => {
  const cleared = new Set([rejectedChatRetryId('request-a')]);
  assert.equal(shouldHydrateServerQueuedItem({ id: rejectedChatRetryId('request-a') }, cleared), false);
  assert.equal(shouldHydrateServerQueuedItem({ id: rejectedChatRetryId('request-b') }, cleared), true);
  cleared.delete(rejectedChatRetryId('request-a'));
  assert.equal(shouldHydrateServerQueuedItem({ id: rejectedChatRetryId('request-a') }, cleared), true,
    'a deferred retry may be explicitly restored after view switch');
});

test('Send Now cannot submit an A closure after A→B or an A generation rollover', () => {
  const original = {
    mounted: true, intendedSession: 'A', viewedSession: 'A',
    startingGeneration: 10, currentGeneration: 10,
  };
  assert.equal(queuedSendStillOwnsView(original), true);
  assert.equal(queuedSendStillOwnsView({ ...original, viewedSession: 'B' }), false);
  assert.equal(queuedSendStillOwnsView({ ...original, currentGeneration: 12 }), false);
  assert.equal(queuedSendStillOwnsView({ ...original, mounted: false }), false);
  assert.equal(queuedSendStillOwnsView({ ...original, intendedSession: null, viewedSession: null }), true,
    'an unsaved draft session with no assigned id may still send while its view is unchanged');
});

test('rejected retries preserve mode, images, and string id using existing server fields', () => {
  const original = {
    id: rejectedChatRetryId('request-d'),
    text: 'continue',
    images: [{ media_type: 'image/png', data: 'different-image' }],
    kind: 'queue' as const,
    approvalMode: 'plan' as const,
  };
  const wire = serializeQueuedForServer([original]);
  assert.equal(wire[0].id, original.id);
  assert.equal(wire[0].approval_mode, 'plan');
  assert.equal(wire[0].images?.[0].data, 'different-image');
  const fromServer = restoreQueuedFromServer(JSON.parse(JSON.stringify(wire))[0], 'build');
  assert.equal(fromServer.approvalMode, 'plan');
  assert.equal(fromServer.id, original.id);
  assert.equal(queuedItemAlreadyDelivered(fromServer, () => true), false);
  const imageOnlyWire = serializeQueuedForServer([{
    ...original,
    id: rejectedChatRetryId('request-image-only'),
    text: '',
  }]);
  const imageOnlyRestored = restoreQueuedFromServer(imageOnlyWire[0], 'build');
  assert.equal(imageOnlyRestored.text, '');
  assert.equal(imageOnlyRestored.images?.[0].data, 'different-image');
  assert.equal(queuedPayloadHasContent(imageOnlyRestored.text, imageOnlyRestored.images), true);
  assert.equal(queuedPayloadHasContent('', undefined), false);
  assert.equal(queuedItemAlreadyDelivered(imageOnlyRestored, () => true), false);
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


