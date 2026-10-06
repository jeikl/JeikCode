import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePendingAfterDecision } from './pendingPermission.ts';

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
