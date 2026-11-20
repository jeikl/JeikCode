/**
 * Server-clock alignment for persisted tool timers.
 *
 * Tool metrics are stored with the daemon's epoch-ms timestamps so every
 * instance and every cold start reads the same anchor. Browsers/devices may
 * have skewed clocks, so every SSE frame (and every session-detail response)
 * carries the server clock; we keep one offset and paint elapsed time against
 * `serverNowMs()` instead of the raw local `Date.now()`.
 */

let offsetMs = 0;
let observed = false;

/** Feed one server timestamp (epoch ms). Invalid/absent values are ignored. */
export function observeServerTime(serverMs?: number | null, localMs: number = Date.now()): void {
  if (serverMs == null || !Number.isFinite(serverMs) || serverMs <= 0) return;
  offsetMs = serverMs - localMs;
  observed = true;
}

/** Current time on the daemon clock (falls back to the local clock). */
export function serverNowMs(localMs: number = Date.now()): number {
  return observed ? localMs + offsetMs : localMs;
}

/** Current server-minus-local offset in ms (diagnostics / tests). */
export function serverClockOffsetMs(): number {
  return offsetMs;
}

/** Test hook: forget the last observation. */
export function resetServerClockForTest(): void {
  offsetMs = 0;
  observed = false;
}
