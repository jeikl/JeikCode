import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceChatPendingRestoreEpoch,
  completedReplayChatApproval,
  createChatApprovalReplayCursor,
  isChatPendingRestoreEpochCurrent,
  markChatApprovalReplayTerminal,
  observeReplayChatApproval,
  rememberRestoredChatApproval,
  resolveChatApprovalAfterResult,
  resolvePendingAfterDecision,
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
