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

/** Last applied snapshot stamp for a server-owned session document. */
export interface RevisionStamp {
  /** Daemon instance that produced the revision (absent on legacy daemons). */
  instance?: string;
  /** Monotonic revision inside that daemon instance. */
  revision: number;
}

/**
 * Arbitrate a snapshot against the last applied stamp.
 *
 * Revision is monotonic only inside one daemon process. When the instance
 * changes (daemon restart), the per-session watermark resets and the first
 * snapshot from the new instance — including an authoritative empty one — must
 * be accepted instead of being rejected as a lower revision.
 *
 * Returns the stamp to store even when the snapshot is rejected, so an instance
 * change can still advance the epoch for a later valid snapshot.
 */
export function arbitrateRevisionStamp(
  local: RevisionStamp | undefined,
  remote: { instance?: string; revision?: number },
): { accept: boolean; stamp: RevisionStamp } {
  let instance = local?.instance;
  let revision = local?.revision ?? 0;
  if (remote.instance) {
    if (instance !== undefined && instance !== remote.instance) revision = 0;
    instance = remote.instance;
  }
  if (typeof remote.revision === 'number') {
    if (!shouldApplyRevision(revision, remote.revision)) {
      return { accept: false, stamp: { instance, revision } };
    }
    revision = remote.revision;
  }
  return { accept: true, stamp: { instance, revision } };
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
