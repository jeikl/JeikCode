/**
 * Revision arbitration for server-owned session documents (todo / queue).
 *
 * The server is the only writer and assigns a monotonically increasing
 * revision. A client may apply a snapshot only when its revision is not older
 * than the one already applied; equal revisions are idempotent. Anything else
 * (a late response, a stale cache, a duplicated broadcast) must be dropped.
 */
export function shouldApplyRevision(
  local: number | undefined,
  remote: number | undefined,
): boolean {
  if (typeof remote !== 'number' || !Number.isFinite(remote)) return false;
  const current = typeof local === 'number' && Number.isFinite(local) ? local : 0;
  return remote >= current;
}

/**
 * Fold an out-of-order revision sequence down to the maximum revision.
 * Used by tests and by cold-start cache selection: the winner is the highest
 * revision, never the last arrival.
 */
export function latestRevision(values: ReadonlyArray<number>): number {
  let latest = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  return latest;
}
