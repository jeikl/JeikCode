// A tool-approval card owns exactly one pending permission request at a time.
//
// When the user decides, the card clears that slot. But approvals are submitted
// via a fire-and-return POST (/chat/permission, /live/permission); the backend
// then runs the approved tool and, if the *next* tool also needs approval, pushes
// a new `permission_request` down the still-open SSE stream. When the approved
// tool is instant (e.g. Read_file, 0.00s), that next request can arrive WHILE the
// decision POST is still in flight — repopulating the slot with the new request
// before the card's onDone runs. Clearing unconditionally then drops that newer
// request, leaving its tool stuck at "等待批准…" with no card: the consecutive-
// approval stall bug.
//
// Fix: only clear when the slot still holds the exact request this card decided
// (matched by call_id). If a newer request already replaced it, keep the new one
// so its card renders.

export interface PendingLike {
  call_id: string;
  runtime_instance_id?: string;
  request_id?: number;
  generation?: number;
}

export function resolvePendingAfterDecision<T extends PendingLike>(
  current: T | null,
  decidedCallId: string,
  decidedRuntimeInstanceId?: string,
  decidedRequestId?: number,
  decidedGeneration?: number,
): T | null {
  if (current?.runtime_instance_id !== undefined) {
    if (
      decidedRuntimeInstanceId === undefined
      || decidedRequestId === undefined
      || decidedGeneration === undefined
      || current.request_id === undefined
      || current.generation === undefined
    ) {
      return current;
    }
    return current.runtime_instance_id === decidedRuntimeInstanceId
      && current.generation === decidedGeneration
      && current.request_id === decidedRequestId
      ? null
      : current;
  }
  if (
    current
    && decidedRequestId !== undefined
    && current.request_id !== undefined
  ) {
    if (
      decidedGeneration !== undefined
      && current.generation !== undefined
      && current.generation !== decidedGeneration
    ) {
      return current;
    }
    return current.request_id === decidedRequestId ? null : current;
  }
  return current && current.call_id === decidedCallId ? null : current;
}

/** Ordered events within a single /chat or /chat/watch stream. A concurrent
 * /chat/pending response can be newer than the replay prefix being consumed. */
export interface ChatApprovalReplayCursor {
  observedByCall: Map<string, string>;
  observedApprovals: Set<string>;
  completedApprovals: Set<string>;
  restoredApprovalId: string | null;
  // The replay barrier may still refer to an older GET approval after a
  // newer, actually surfaced SSE permission replaces its card.
  surfacedApprovalId: string | null;
  surfacedCallId: string | null;
  reachedRestoredApproval: boolean;
  terminalSeen: boolean;
  restoreRequestSequence: number;
  permissionRevision: number;
  latestObservedApprovalId: string | null;
  restoreRetryTimer: number | null;
  restoreRetryFailures: number;
}

export function createChatApprovalReplayCursor(): ChatApprovalReplayCursor {
  return {
    observedByCall: new Map(),
    observedApprovals: new Set(),
    completedApprovals: new Set(),
    restoredApprovalId: null,
    surfacedApprovalId: null,
    surfacedCallId: null,
    reachedRestoredApproval: true,
    terminalSeen: false,
    restoreRequestSequence: 0,
    permissionRevision: 0,
    latestObservedApprovalId: null,
    restoreRetryTimer: null,
    restoreRetryFailures: 0,
  };
}

/** A missing replay edge cannot be accepted without GET authority. If that
 * GET fails transiently, recheck with bounded backoff even when SSE goes quiet.
 * One timer per watcher prevents request storms. The caller gates its retry
 * against current session/generation/epoch before issuing another request. */
export function scheduleChatPendingRestoreRetry(
  cursor: ChatApprovalReplayCursor,
  retry: () => void,
  schedule: (callback: () => void, delayMs: number) => number,
): boolean {
  if (cursor.terminalSeen || cursor.restoreRetryTimer !== null) return false;
  const delayMs = 1000 * (2 ** Math.min(cursor.restoreRetryFailures, 3));
  cursor.restoreRetryFailures = Math.min(cursor.restoreRetryFailures + 1, 4);
  cursor.restoreRetryTimer = schedule(() => {
    cursor.restoreRetryTimer = null;
    if (!cursor.terminalSeen) retry();
  }, delayMs);
  return true;
}

export function clearChatPendingRestoreRetry(
  cursor: ChatApprovalReplayCursor,
  cancel: (timerId: number) => void,
): void {
  if (cursor.restoreRetryTimer !== null) {
    cancel(cursor.restoreRetryTimer);
    cursor.restoreRetryTimer = null;
  }
  cursor.restoreRetryFailures = 0;
}

/** Session-scoped restore epochs outlive individual SSE watch cursors. Closing
 * one watch (or reaching a terminal) must invalidate its outstanding GET even
 * if the next watch uses the same session id and session generation. */
export function advanceChatPendingRestoreEpoch(epochs: Map<string, number>, sessionId: string): number {
  const next = (epochs.get(sessionId) ?? 0) + 1;
  epochs.set(sessionId, next);
  return next;
}

export function isChatPendingRestoreEpochCurrent(
  epochs: ReadonlyMap<string, number>,
  sessionId: string,
  expectedEpoch: number,
): boolean {
  return (epochs.get(sessionId) ?? 0) === expectedEpoch;
}

/** A GET can be formed by the server before a newer permission SSE reaches
 * this watcher, yet complete afterward. Such a response is not authoritative
 * over the newer observed approval: query the server again to reconcile. */
export function shouldRecheckChatPendingAfterPermissionAdvance(
  cursor: ChatApprovalReplayCursor,
  issuedAtRevision: number,
  returnedApprovalId: string | null,
): boolean {
  return !cursor.terminalSeen
    && cursor.permissionRevision !== issuedAtRevision
    && cursor.latestObservedApprovalId !== returnedApprovalId;
}

/** Return false if the GET snapshot was already resolved on this stream. */
export function rememberRestoredChatApproval(
  cursor: ChatApprovalReplayCursor,
  approvalId: string,
  callId?: string,
): boolean {
  if (cursor.terminalSeen || cursor.completedApprovals.has(approvalId)) return false;
  cursor.restoredApprovalId = approvalId;
  cursor.surfacedApprovalId = approvalId;
  cursor.surfacedCallId = callId ?? null;
  cursor.reachedRestoredApproval = cursor.observedApprovals.has(approvalId);
  return true;
}

/** Do not let a historical replay approval replace a newer GET card. Once the
 * stream reaches the exact GET approval, subsequent approvals are new events. */
export function observeReplayChatApproval(
  cursor: ChatApprovalReplayCursor,
  callId: string,
  approvalId: string,
): boolean {
  if (cursor.terminalSeen || cursor.completedApprovals.has(approvalId)) return false;
  cursor.permissionRevision += 1;
  cursor.latestObservedApprovalId = approvalId;
  cursor.observedByCall.set(callId, approvalId);
  cursor.observedApprovals.add(approvalId);
  if (cursor.restoredApprovalId && !cursor.reachedRestoredApproval) {
    if (cursor.restoredApprovalId !== approvalId) return false;
    cursor.reachedRestoredApproval = true;
  }
  cursor.surfacedApprovalId = approvalId;
  cursor.surfacedCallId = callId;
  return true;
}

/** A late GET response cannot restore a card after a watch terminal. */
export function markChatApprovalReplayTerminal(
  cursor: ChatApprovalReplayCursor,
  cancelRetry: (timerId: number) => void = clearTimeout,
): void {
  cursor.terminalSeen = true;
  cursor.observedByCall.clear();
  clearChatPendingRestoreRetry(cursor, cancelRetry);
}

/** Results carry only call_id, so pair them with the permission *seen earlier
 * in the same ordered stream*. Never infer identity from a GET-restored card. */
export function completedReplayChatApproval(
  cursor: ChatApprovalReplayCursor,
  callId: string,
): string | undefined {
  const approvalId = cursor.observedByCall.get(callId);
  if (approvalId) {
    cursor.observedByCall.delete(callId);
    cursor.completedApprovals.add(approvalId);
  }
  return approvalId;
}

/** The /chat card is dismissed only for its exact approval instance. */
export function resolveChatApprovalAfterResult<T extends PendingLike & { approval_id?: string }>(
  current: T | null,
  callId: string | null,
  approvalId?: string,
): T | null {
  if (callId === null) return null; // authoritative turn terminal
  return current && approvalId && current.call_id === callId && current.approval_id === approvalId
    ? null
    : current;
}
