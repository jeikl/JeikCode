import assert from 'node:assert/strict';
import test from 'node:test';

import { arbitrateRevisionStamp, latestRevision, shouldApplyRevision } from './stateRevision.ts';

test('a newer revision may replace the local document', () => {
  assert.equal(shouldApplyRevision(3, 4), true);
});

test('an older revision never replaces the local document', () => {
  assert.equal(shouldApplyRevision(4, 3), false);
});

test('an equal revision is idempotent', () => {
  assert.equal(shouldApplyRevision(4, 4), true);
});

test('a missing local revision starts at zero', () => {
  assert.equal(shouldApplyRevision(undefined, 1), true);
  assert.equal(shouldApplyRevision(undefined, 0), true);
});

test('a missing or non-finite remote revision is rejected', () => {
  assert.equal(shouldApplyRevision(1, undefined), false);
  assert.equal(shouldApplyRevision(1, Number.NaN), false);
  assert.equal(shouldApplyRevision(1, Number.POSITIVE_INFINITY), false);
});

test('a daemon restart starts a new revision epoch and accepts the empty snapshot', () => {
  const local = { instance: 'old-instance', revision: 12 };
  const decision = arbitrateRevisionStamp(local, { instance: 'new-instance', revision: 1 });
  assert.equal(decision.accept, true);
  assert.deepEqual(decision.stamp, { instance: 'new-instance', revision: 1 });
});

test('the same instance still rejects a lower revision', () => {
  const local = { instance: 'daemon-a', revision: 12 };
  const decision = arbitrateRevisionStamp(local, { instance: 'daemon-a', revision: 1 });
  assert.equal(decision.accept, false);
  assert.deepEqual(decision.stamp, { instance: 'daemon-a', revision: 12 });
});

test('a legacy daemon without an instance still uses revision-only arbitration', () => {
  const local = { revision: 12 };
  assert.equal(arbitrateRevisionStamp(local, { revision: 11 }).accept, false);
  assert.equal(arbitrateRevisionStamp(local, { revision: 12 }).accept, true);
});

test('out-of-order arrivals converge to the maximum revision', () => {
  const arrivals = [2, 9, 4, 9, 1, 7];
  const applied: number[] = [];
  let local = 0;
  for (const revision of arrivals) {
    if (!shouldApplyRevision(local, revision)) continue;
    // Equal revisions are idempotent: they may be re-applied but must not
    // change the document or count as a distinct state transition.
    if (revision > local) applied.push(revision);
    local = revision;
  }
  // 9 arrives once (the duplicate is idempotent but does not change the value),
  // and every later lower revision is dropped.
  assert.deepEqual(applied, [2, 9]);
  assert.equal(latestRevision(arrivals), 9);
});
