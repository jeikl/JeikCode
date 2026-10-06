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
