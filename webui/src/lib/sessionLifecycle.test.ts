import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSessionLifecycle } from './sessionLifecycle.ts';

test('server active always wins over cached/idle assumptions', () => {
  assert.deepEqual(
    resolveSessionLifecycle({ serverActive: true }),
    { phase: 'live', watch: 'detached', busy: true },
  );
});

test('a local or background turn keeps the session live without server data', () => {
  assert.equal(resolveSessionLifecycle({ serverActive: false, localTurn: true }).phase, 'live');
  assert.equal(resolveSessionLifecycle({ serverActive: false, backgroundTurn: true }).phase, 'live');
});

test('idle sessions attach standby, never detached', () => {
  assert.deepEqual(
    resolveSessionLifecycle({ serverActive: false }),
    { phase: 'standby', watch: 'standby', busy: false },
  );
});

test('an authoritative terminal settles even if stale refs said live', () => {
  assert.deepEqual(
    resolveSessionLifecycle({ serverActive: true, localTurn: true, terminalSettled: true }),
    { phase: 'terminal', watch: 'none', busy: false },
  );
});
