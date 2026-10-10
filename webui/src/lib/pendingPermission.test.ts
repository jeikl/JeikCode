import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceChatPendingRestoreEpoch,
  beginChatIdleWatchAttempt,
  reconcileWarmChatApproval,
  reconcileDisconnectedChatPending,
  recordBackgroundChatApprovalEvent,
  completedReplayChatApproval,
  createChatApprovalReplayCursor,
  isChatPendingRestoreEpochCurrent,
  markChatApprovalReplayTerminal,
  observeReplayChatApproval,
  rememberRestoredChatApproval,
  resolveChatApprovalAfterResult,
  resolvePendingAfterDecision,
  scheduleChatPendingRestoreRetry,
  clearChatPendingRestoreRetry,
  shouldRecheckChatPendingAfterPermissionAdvance,
} from './pendingPermission.ts';

test('old live decision cannot clear a replacement runtime permission card', () => {
  const current = {
    call_id: 'call-reused',
    runtime_instance_id: 'runtime-new',
    generation: 0,
    request_id: 1,
  };

  assert.equal(
    resolvePendingAfterDecision(current, 'call-reused', 'runtime-old', 1, 0),
    current,
  );
});

test('strong live permission requires the complete runtime identity to clear', () => {
  const current = {
    call_id: 'call-reused',
    runtime_instance_id: 'runtime-new',
    generation: 0,
    request_id: 1,
  };

  assert.equal(resolvePendingAfterDecision(current, 'call-reused', undefined, 1, 0), current);
  assert.equal(resolvePendingAfterDecision(current, 'call-reused', 'runtime-new', 1, undefined), current);
  assert.equal(resolvePendingAfterDecision(current, 'call-reused', 'runtime-new', undefined, 0), current);
  assert.equal(resolvePendingAfterDecision(current, 'call-reused', 'runtime-new', 1, 0), null);
});

test('a restored new approval survives historical same-call replay until its own result', () => {
  const cursor = createChatApprovalReplayCursor();
  const latest = { call_id: 'c1', approval_id: 'approval-new' };
  let displayed: typeof latest | null = latest;
  assert.equal(rememberRestoredChatApproval(cursor, latest.approval_id), true);

  // GET /chat/pending returned P2 before the watch replayed P1 and Result1.
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'approval-old'), false);
  const oldResultId = completedReplayChatApproval(cursor, 'c1');
  displayed = resolveChatApprovalAfterResult(displayed, 'c1', oldResultId);
  assert.equal(displayed, latest, 'old result cannot dismiss the current card');

  assert.equal(observeReplayChatApproval(cursor, 'c1', 'approval-new'), true);
  const newResultId = completedReplayChatApproval(cursor, 'c1');
  displayed = resolveChatApprovalAfterResult(displayed, 'c1', newResultId);
  assert.equal(displayed, null, 'matching result clears the current card');
});

test('GET pending after replayed resolution never restores a stale approval', () => {
  const cursor = createChatApprovalReplayCursor();
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'approval-old'), true);
  assert.equal(completedReplayChatApproval(cursor, 'c1'), 'approval-old');
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-old'), false);
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-new'), true);
  assert.equal(completedReplayChatApproval(cursor, 'c1'), undefined);
  const current = { call_id: 'c1', approval_id: 'approval-new' };
  assert.equal(resolveChatApprovalAfterResult(current, 'c1'), current);
  assert.equal(resolveChatApprovalAfterResult(current, 'other', 'approval-new'), current);
  assert.equal(resolveChatApprovalAfterResult(current, null), null);
});

test('late GET or repeated approval cannot resurrect a terminal or completed request', () => {
  const cursor = createChatApprovalReplayCursor();
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'a1'), true);
  assert.equal(completedReplayChatApproval(cursor, 'c1'), 'a1');
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'a1'), false);
  markChatApprovalReplayTerminal(cursor);
  assert.equal(rememberRestoredChatApproval(cursor, 'a2'), false);
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'a3'), false);
});

test('only a start or output following its own replayed approval can dismiss a card', () => {
  const cursor = createChatApprovalReplayCursor();
  const newCard = { call_id: 'c1', approval_id: 'current' };
  assert.equal(completedReplayChatApproval(cursor, 'c1'), undefined, 'pre-approval start');
  assert.equal(rememberRestoredChatApproval(cursor, newCard.approval_id), true);
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'old'), false);
  const oldStart = completedReplayChatApproval(cursor, 'c1');
  assert.equal(resolveChatApprovalAfterResult(newCard, 'c1', oldStart), newCard);
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'current'), true);
  const newOutput = completedReplayChatApproval(cursor, 'c1');
  assert.equal(resolveChatApprovalAfterResult(newCard, 'c1', newOutput), null);
});

test('a missing replay edge can advance to a newer GET-authoritative permission', () => {
  const cursor = createChatApprovalReplayCursor();
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-missing-edge'), true);
  assert.equal(observeReplayChatApproval(cursor, 'c2', 'approval-next'), false);
  // The caller rechecks GET /chat/pending and it confirms the newer approval.
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-next'), true);
  assert.equal(cursor.reachedRestoredApproval, true);
  assert.equal(completedReplayChatApproval(cursor, 'c2'), 'approval-next');
  assert.equal(++cursor.restoreRequestSequence, 1);
  assert.equal(++cursor.restoreRequestSequence, 2);
});

test('a slow GET from watch A cannot resurrect a permission after watch B terminal', () => {
  const epochs = new Map<string, number>();
  const sessionId = 'active-session';
  const cursorA = createChatApprovalReplayCursor();
  const watchAEpoch = advanceChatPendingRestoreEpoch(epochs, sessionId);
  const watchAHasStartedGet = isChatPendingRestoreEpochCurrent(epochs, sessionId, watchAEpoch);
  assert.equal(watchAHasStartedGet, true);

  // Watch A disconnects without an authoritative terminal; B replaces it.
  const watchBEpoch = advanceChatPendingRestoreEpoch(epochs, sessionId);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, watchAEpoch), false);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, watchBEpoch), true);

  // B observes the terminal and clears the app modal while A's GET is slow.
  const cursorB = createChatApprovalReplayCursor();
  markChatApprovalReplayTerminal(cursorB);
  advanceChatPendingRestoreEpoch(epochs, sessionId);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, watchAEpoch), false);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, watchBEpoch), false);

  // This is the gate used before calling onPermission from an async GET.
  const staleGetCanRestore = isChatPendingRestoreEpochCurrent(epochs, sessionId, watchAEpoch)
    && rememberRestoredChatApproval(cursorA, 'approval-P2');
  assert.equal(staleGetCanRestore, false);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, 'unrelated-session', 0), true);
});

test('stale same-watcher GET P2 cannot overwrite newer SSE P3; recheck confirms P3', () => {
  const cursor = createChatApprovalReplayCursor();
  const issuedG1 = cursor.permissionRevision;
  // G1 was formed when P2 was active; a different client approves P2 and
  // watcher SSE shows P3 before that older HTTP response reaches the browser.
  assert.equal(observeReplayChatApproval(cursor, 'c3', 'approval-P3'), true);
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(
    cursor, issuedG1, 'approval-P2',
  ), true);
  // The actual caller rejects G1 without touching the P3 modal, starts G2,
  // and accepts the exact current approval returned by the new GET.
  const issuedG2 = cursor.permissionRevision;
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(
    cursor, issuedG2, 'approval-P3',
  ), false);
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-P3'), true);
  assert.equal(cursor.reachedRestoredApproval, true);
});

test('historical SSE P1 while GET fetches P2 causes reconciliation, not a lost card', () => {
  const cursor = createChatApprovalReplayCursor();
  const issuedG1 = cursor.permissionRevision;
  assert.equal(observeReplayChatApproval(cursor, 'c1', 'approval-old-P1'), true);
  assert.equal(completedReplayChatApproval(cursor, 'c1'), 'approval-old-P1');
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(
    cursor, issuedG1, 'approval-current-P2',
  ), true);
  const issuedG2 = cursor.permissionRevision;
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(
    cursor, issuedG2, 'approval-current-P2',
  ), false);
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-current-P2'), true);
});

test('missing replay edge retries a failed GET with bounded backoff, not another SSE edge', () => {
  const cursor = createChatApprovalReplayCursor();
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-P2'), true);
  assert.equal(observeReplayChatApproval(cursor, 'c3', 'approval-P3'), false);
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  let nextTimerId = 1;
  let retries = 0;
  const schedule = (callback: () => void, delayMs: number) => {
    const timerId = nextTimerId++;
    delays.push(delayMs);
    callbacks.set(timerId, callback);
    return timerId;
  };
  const cancel = (id: number) => { callbacks.delete(id); };
  const retry = () => { retries++; };

  for (let i = 0; i < 5; i++) {
    assert.equal(scheduleChatPendingRestoreRetry(cursor, retry, schedule), true);
    assert.equal(scheduleChatPendingRestoreRetry(cursor, retry, schedule), false,
      'concurrent failures coalesce to a single retry');
    const timerId = nextTimerId - 1;
    const callback = callbacks.get(timerId);
    assert.ok(callback);
    callbacks.delete(timerId);
    callback();
    assert.equal(retries, i + 1);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000]);
  assert.equal(scheduleChatPendingRestoreRetry(cursor, retry, schedule), true);
  clearChatPendingRestoreRetry(cursor, cancel);
  assert.equal(callbacks.size, 0, 'success cancels outstanding retry');
  assert.equal(cursor.restoreRetryFailures, 0, 'success resets retry backoff');
  assert.equal(rememberRestoredChatApproval(cursor, 'approval-P3'), true);
  assert.equal(cursor.reachedRestoredApproval, true);
});

test('terminal watcher cancels pending GET retry and never retries afterward', () => {
  const cursor = createChatApprovalReplayCursor();
  let callback: (() => void) | undefined;
  let cancelled: number | null = null;
  let retried = 0;
  assert.equal(scheduleChatPendingRestoreRetry(cursor, () => { retried++; }, (cb) => {
    callback = cb;
    return 42;
  }), true);
  markChatApprovalReplayTerminal(cursor, (id) => { cancelled = id; });
  assert.equal(cancelled, 42);
  callback?.();
  assert.equal(retried, 0);
  assert.equal(scheduleChatPendingRestoreRetry(cursor, () => { retried++; }, () => 43), false);
});

test('an empty authoritative GET settles only the exact restored approval', () => {
  const cursor = createChatApprovalReplayCursor();
  const previousCard = { call_id: 'reused-call', approval_id: 'P2' };
  const newerCard = { call_id: 'reused-call', approval_id: 'P3' };
  assert.equal(rememberRestoredChatApproval(cursor, previousCard.approval_id, previousCard.call_id), true);
  assert.equal(cursor.surfacedCallId, 'reused-call');
  assert.equal(
    resolveChatApprovalAfterResult(previousCard, cursor.surfacedCallId, cursor.surfacedApprovalId!),
    null,
    'empty GET removes the old restored card',
  );
  assert.equal(
    resolveChatApprovalAfterResult(newerCard, cursor.surfacedCallId, cursor.surfacedApprovalId!),
    newerCard,
    'empty GET cannot remove a newer approval with a reused call id',
  );
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(
    cursor, cursor.permissionRevision, null,
  ), false);
  const issuedBeforeNewSse = cursor.permissionRevision;
  assert.equal(observeReplayChatApproval(cursor, 'reused-call', 'P3'), false);
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(
    cursor, issuedBeforeNewSse, null,
  ), true, 'an older empty GET must recheck when a newer SSE approval appears');
  assert.equal(cursor.surfacedApprovalId, 'P2', 'suppressed P3 must not replace an actual P2 card');
});

test('fresh empty GET clears SSE P3 after a prior GET restored P2 and watch loses terminal', () => {
  const cursor = createChatApprovalReplayCursor();
  const previous = { call_id: 'reused-call', approval_id: 'P2' };
  const current = { call_id: 'reused-call', approval_id: 'P3' };
  let displayed: typeof current | null = previous;

  assert.equal(rememberRestoredChatApproval(cursor, 'P2', previous.call_id), true);
  assert.equal(observeReplayChatApproval(cursor, previous.call_id, 'P2'), true);
  const resolvedP2 = completedReplayChatApproval(cursor, previous.call_id);
  displayed = resolveChatApprovalAfterResult(displayed, previous.call_id, resolvedP2);
  assert.equal(displayed, null);

  assert.equal(observeReplayChatApproval(cursor, current.call_id, current.approval_id), true);
  displayed = current;
  assert.equal(cursor.restoredApprovalId, 'P2', 'barrier remains replay identity');
  assert.equal(cursor.surfacedApprovalId, 'P3', 'active SSE card is tracked separately');
  const issuedAtRevision = cursor.permissionRevision;
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(cursor, issuedAtRevision, null), false);
  displayed = resolveChatApprovalAfterResult(
    displayed, cursor.surfacedCallId, cursor.surfacedApprovalId ?? undefined,
  );
  assert.equal(displayed, null, 'fresh GET null clears precisely the surfaced P3');
});

test('an unmounted watcher cannot start a pending retry with unchanged session generation', () => {
  const epochs = new Map<string, number>();
  const sessionId = 'active-session';
  const issuedEpoch = advanceChatPendingRestoreEpoch(epochs, sessionId);
  const cursor = createChatApprovalReplayCursor();
  let callback: (() => void) | undefined;
  let retries = 0;
  assert.equal(scheduleChatPendingRestoreRetry(cursor, () => {
    if (isChatPendingRestoreEpochCurrent(epochs, sessionId, issuedEpoch)) retries++;
  }, (cb) => {
    callback = cb;
    return 42;
  }), true);

  // Chat cleanup invalidates every outstanding session epoch on unmount.
  for (const id of epochs.keys()) advanceChatPendingRestoreEpoch(epochs, id);
  callback?.();
  assert.equal(retries, 0);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, issuedEpoch), false);
});

test('idle-watch flash breaker invalidates an old pending GET even when reconnect is suppressed', () => {
  const epochs = new Map<string, number>();
  const sessionId = 'session-with-flash-disconnects';
  const anotherEpoch = advanceChatPendingRestoreEpoch(epochs, 'unrelated');
  const formerWatchEpoch = advanceChatPendingRestoreEpoch(epochs, sessionId);
  const formerCursor = createChatApprovalReplayCursor();
  const flashed = { count: 3, lastFailedAt: 10_000 };
  let retryCallback: (() => void) | undefined;
  let obsoleteRestores = 0;

  // An old GET retry is already queued when the old watch closes.
  assert.equal(scheduleChatPendingRestoreRetry(formerCursor, () => {
    if (isChatPendingRestoreEpochCurrent(epochs, sessionId, formerWatchEpoch)) {
      obsoleteRestores++;
    }
  }, (callback) => {
    retryCallback = callback;
    return 5;
  }), true);

  // startIdleWatch enters after its existing-watch guards; the new beta
  // circuit breaker refuses the connection but must invalidate the old epoch.
  assert.equal(beginChatIdleWatchAttempt(epochs, sessionId, flashed, 10_500), false);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, formerWatchEpoch), false);
  retryCallback?.();
  assert.equal(obsoleteRestores, 0);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, 'unrelated', anotherEpoch), true);

  // Once cooldown passes, the same helper admits a new watch and continues
  // to reject responses issued by its predecessor.
  assert.equal(beginChatIdleWatchAttempt(epochs, sessionId, flashed, 40_001), true);
  assert.equal(isChatPendingRestoreEpochCurrent(epochs, sessionId, formerWatchEpoch), false);
  assert.equal(beginChatIdleWatchAttempt(epochs, sessionId, { count: 2, lastFailedAt: 40_001 }, 40_002), true);
});

test('warm return to background A rechecks P2 even if its SSE watcher stayed open', () => {
  const cursor = createChatApprovalReplayCursor();
  const oldCallId = 'provider-reused-call-id';
  let attaches = 0;
  let rechecks = 0;
  let displayed: { call_id: string; approval_id: string } | null = null;
  const restore = (sharedCursor: ChatApprovalReplayCursor) => {
    assert.strictEqual(sharedCursor, cursor, 'GET and the retained SSE must use one cursor');
    rechecks++;
    // The server-authoritative GET confirms a new P2 approval while A had
    // been viewed in the background; its ID is not inferred from call_id.
    if (rememberRestoredChatApproval(cursor, 'P2', oldCallId)) {
      displayed = { call_id: oldCallId, approval_id: 'P2' };
    }
  };

  reconcileWarmChatApproval(cursor, () => { attaches++; }, restore);
  assert.equal(rechecks, 1, 'existing watcher must not suppress GET');
  assert.equal(attaches, 0, 'cached A canvas need not be destroyed and rebound');
  assert.deepEqual(displayed, { call_id: oldCallId, approval_id: 'P2' });
  const oldP1Result = completedReplayChatApproval(cursor, oldCallId);
  assert.equal(resolveChatApprovalAfterResult(displayed, oldCallId, oldP1Result), displayed);

  // The shared replay cursor notices newer SSE P3 while the warm GET P2 is
  // in flight, and rejects P2 instead of overwriting the P3 modal.
  const issuedAtRevision = cursor.permissionRevision;
  assert.equal(observeReplayChatApproval(cursor, oldCallId, 'P3'), false,
    'unmatched replay stays behind GET authority even though revision advances');
  assert.equal(shouldRecheckChatPendingAfterPermissionAdvance(cursor, issuedAtRevision, 'P2'), true);

  reconcileWarmChatApproval(undefined, () => { attaches++; }, restore);
  assert.equal(attaches, 1, 'a missing watcher still reattaches with its own GET');
  assert.equal(rechecks, 1);
});

test('background P2 shares its approval identity with warm GET and later tool resolution', () => {
  const cursor = createChatApprovalReplayCursor();
  const callId = 'reused-call';
  // A is off-screen while another client reaches P2. The background
  // watcher must update cursor identity without displaying A's modal in B.
  recordBackgroundChatApprovalEvent(cursor, {
    type: 'permission_request', call_id: callId, approval_id: 'P2',
  });
  let seenCursor: ChatApprovalReplayCursor | undefined;
  reconcileWarmChatApproval(cursor, () => assert.fail('A watcher is retained'), (shared) => {
    seenCursor = shared;
    assert.equal(rememberRestoredChatApproval(shared, 'P2', callId), true);
  });
  assert.strictEqual(seenCursor, cursor);
  const visible = { call_id: callId, approval_id: 'P2' };
  const decidedBeforeResult = resolveChatApprovalAfterResult(visible, callId, undefined);
  assert.deepEqual(decidedBeforeResult, visible);
  // A's watcher (not a fresh, unrelated cursor) consumes the post-approval
  // tool start and resolves only its corresponding P2.
  const before = cursor.completedApprovals.size;
  recordBackgroundChatApprovalEvent(cursor, { type: 'tool_start', id: callId });
  assert.equal(cursor.completedApprovals.size, before + 1);
  assert.equal(cursor.completedApprovals.has('P2'), true);
  assert.equal(resolveChatApprovalAfterResult(visible, callId, 'P2'), null);
  assert.equal(rememberRestoredChatApproval(cursor, 'P2', callId), false,
    'a slower old GET cannot resurrect the completed P2');
});

test('detached watch transport drop still restores a later P2 via disconnected fallback', () => {
  const cursor = createChatApprovalReplayCursor();
  let p2Available = false;
  let restoreCalls = 0;
  let displayed: { approval_id: string; call_id: string } | null = null;
  const recheck = (sameCursor: ChatApprovalReplayCursor) => {
    assert.strictEqual(sameCursor, cursor);
    restoreCalls++;
    // First recovery GET sees no approval; after this connection dies, the
    // daemon can reach a new P2 before the next disconnected-only tick.
    if (p2Available && rememberRestoredChatApproval(sameCursor, 'P2', 'reused-call')) {
      displayed = { approval_id: 'P2', call_id: 'reused-call' };
    }
  };
  reconcileDisconnectedChatPending(true, cursor, recheck);
  assert.equal(displayed, null);
  p2Available = true;
  reconcileDisconnectedChatPending(true, cursor, recheck);
  assert.deepEqual(displayed, { approval_id: 'P2', call_id: 'reused-call' });
  assert.equal(restoreCalls, 2);
  markChatApprovalReplayTerminal(cursor);
  reconcileDisconnectedChatPending(true, cursor, recheck);
  reconcileDisconnectedChatPending(false, cursor, recheck);
  assert.equal(restoreCalls, 2, 'terminal/idle fallback must not poll pending');
});
