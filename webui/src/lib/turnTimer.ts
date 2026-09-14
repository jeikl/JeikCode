/** Live turn elapsed-time helpers for the WebUI chat timeline. */

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * Format a duration for the in-turn stopwatch.
 * Seconds stay in seconds until 60, then the unit rolls to m:ss (and h:mm:ss).
 */
export function formatTurnElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  if (m > 0) return `${m}:${pad2(s)}`;
  return `${s}s`;
}

/** Wall-clock from the user bubble to `endTs` (final answer or now). */
export function turnDurationMs(userTs?: number, endTs?: number): number | undefined {
  if (userTs == null || endTs == null) return undefined;
  if (!Number.isFinite(userTs) || !Number.isFinite(endTs)) return undefined;
  if (endTs < userTs) return undefined;
  return endTs - userTs;
}

/** Done-turn "用时": prefer user-bubble → final answer, else the stamped
 *  full-turn elapsed (never a lone last-round kernel duration when a span exists). */
export function turnTotalElapsedMs(
  userTs?: number,
  endTs?: number,
  elapsedMs?: number,
): number | undefined {
  const fromUser = turnDurationMs(userTs, endTs);
  if (fromUser && fromUser > 0) return fromUser;
  return elapsedMs;
}

/** Stamp `elapsedMs` (and optional completion time) onto the latest assistant
 *  message that does not already have a duration. */
export function stampLastAssistantElapsed<T extends { role: string; elapsedMs?: number; ts?: number }>(
  msgs: T[],
  elapsedMs: number,
  finishedAt?: number,
): T[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    if (msgs[i]!.elapsedMs != null) return msgs;
    const next = msgs.slice();
    next[i] = {
      ...msgs[i]!,
      elapsedMs,
      ts: finishedAt ?? Date.now(),
    };
    return next;
  }
  return msgs;
}

/**
 * Sum stamped turn durations on assistant messages.
 * When `liveCurrentMs` is set (turn in progress), skip provisional stamps on
 * assistants after the last user bubble so they are not double-counted with the
 * live stopwatch.
 */
export function sessionElapsedMs(
  messages: Array<{ role: string; elapsedMs?: number }>,
  liveCurrentMs?: number,
): number {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user') lastUserIdx = i;
  }
  let sum = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || m.elapsedMs == null) continue;
    if (!Number.isFinite(m.elapsedMs)) continue;
    if (liveCurrentMs != null && i > lastUserIdx) continue;
    sum += Math.max(0, m.elapsedMs);
  }
  if (liveCurrentMs != null && Number.isFinite(liveCurrentMs)) {
    sum += Math.max(0, liveCurrentMs);
  }
  return sum;
}
