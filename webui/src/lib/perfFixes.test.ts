import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLoadOlder } from './turnNav.ts';
import { pullSession } from './sessionPull.ts';
import {
  dispatchOrQueueTerminalCommand,
  drainPendingTerminalCommands,
  getSavedTerminalCount,
  markAllTerminalsClosed,
  registerTerminalRunHandler,
} from './terminalStorage.ts';

test('canLoadOlder rejects synthetic fractional headSeq like 0.953 when offset is 0', () => {
  assert.equal(canLoadOlder({ hasOlder: true, offset: 0, headSeq: 0.953 }), false);
  assert.equal(canLoadOlder({ hasOlder: true, offset: 0, headSeq: 12 }), true);
  assert.equal(canLoadOlder({ hasOlder: true, offset: 24, headSeq: 0.953 }), true);
});

test('pullSession falls back to offset instead of sending fractional before_seq=0.953', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({ id: 's1', name: 'n', working_dir: '/w', messages: [], turns: [], message_count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    await pullSession({
      projectHash: 'h1',
      sessionId: 's1',
      mode: 'older',
      beforeSeq: 0.953,
      offset: 12,
      limit: 48,
    });
    assert.ok(!capturedUrl.includes('before_seq='), `unexpected before_seq in ${capturedUrl}`);
    assert.ok(capturedUrl.includes('offset=12'), `expected offset=12 in ${capturedUrl}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('terminalStorage defaults to 0 saved terminals and buffers commands until handler mounts', () => {
  markAllTerminalsClosed(false, '/repo/a');
  assert.equal(getSavedTerminalCount('/repo/a'), 0);

  dispatchOrQueueTerminalCommand('jeikcode init --force');
  const received: string[] = [];
  const unregister = registerTerminalRunHandler((cmd) => {
    received.push(cmd);
  });
  assert.deepEqual(received, ['jeikcode init --force']);
  assert.deepEqual(drainPendingTerminalCommands(), []);

  dispatchOrQueueTerminalCommand('echo live');
  assert.deepEqual(received, ['jeikcode init --force', 'echo live']);
  unregister();
});
