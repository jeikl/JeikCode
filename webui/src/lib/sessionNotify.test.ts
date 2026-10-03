import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchSystemNotification,
  sessionNoticeLabel,
  shouldEmitNotice,
  shouldOsNotifyReview,
  shouldOsNotifyTerminal,
  shouldToastTerminal,
  showPermissionNotice,
  windowAwayFrom,
  takeTerminalEdges,
  terminalKindFromDone,
} from './sessionNotify.ts';

test('build and plan notify on each review; auto does not', () => {
  assert.equal(showPermissionNotice('build'), true);
  assert.equal(showPermissionNotice('plan'), true);
  assert.equal(showPermissionNotice('accept_edits'), true);
  assert.equal(showPermissionNotice('bypass'), false);
  assert.equal(shouldOsNotifyReview('build', true), true);
  assert.equal(shouldOsNotifyReview('build', false), false);
  assert.equal(shouldOsNotifyReview('bypass', true), false);
});

test('kernel stopped wire is a completed task', () => {
  assert.equal(terminalKindFromDone(undefined), 'completed');
  assert.equal(terminalKindFromDone('stopped'), 'completed');
  assert.equal(terminalKindFromDone('cancelled'), 'stopped');
  assert.equal(terminalKindFromDone('provider_error'), 'failed');
  assert.equal(terminalKindFromDone('max_rounds'), 'stopped');
});

test('terminal edges fire once per seq increase and ignore the baseline', () => {
  const seen = new Map<string, number>();
  assert.deepEqual(
    takeTerminalEdges(seen, [{ sessionId: 'a', seq: 2, kind: 'completed' }], { baseline: true }),
    [],
  );
  assert.deepEqual(
    takeTerminalEdges(seen, [{ sessionId: 'a', seq: 3, kind: 'stopped' }]),
    [{ sessionId: 'a', seq: 3, kind: 'stopped' }],
  );
  assert.deepEqual(
    takeTerminalEdges(seen, [
      { sessionId: 'a', seq: 3, kind: 'stopped' },
      { sessionId: 'b', seq: 1, kind: 'completed' },
    ]),
    [{ sessionId: 'b', seq: 1, kind: 'completed' }],
  );
  assert.deepEqual(
    takeTerminalEdges(seen, [
      { sessionId: 'a', seq: 3, kind: 'stopped' },
      { sessionId: 'b', seq: 1, kind: 'completed' },
    ]),
    [],
  );
  takeTerminalEdges(seen, []);
  assert.equal(seen.has('a'), false);
  assert.equal(seen.has('b'), false);
});

test('duplicate notices inside the window collapse', () => {
  const recent = new Map<string, number>();
  assert.equal(shouldEmitNotice(recent, 'a:completed', 1_000, 2_000), true);
  assert.equal(shouldEmitNotice(recent, 'a:completed', 1_500, 2_000), false);
  assert.equal(shouldEmitNotice(recent, 'a:stopped', 1_500, 2_000), true);
  assert.equal(shouldEmitNotice(recent, 'a:completed', 3_500, 2_000), true);
});

test('session label prefers a real title, then the folder', () => {
  assert.equal(
    sessionNoticeLabel({ id: 'abcdef123456', name: 'Fix parser', workingDir: 'E:\\code\\jeikcode' }),
    'Fix parser',
  );
  assert.equal(
    sessionNoticeLabel({ id: 'abcdef123456', name: 'session-1', workingDir: 'E:\\code\\jeikcode' }),
    'jeikcode · abcdef12',
  );
});

test('terminal toast stays quiet only for the foreground session', () => {
  // Foreground and this session is open: do not disturb.
  assert.equal(
    shouldToastTerminal({ sessionId: 'sess-1', activeSessionId: 'sess-1', windowAway: false }),
    false,
  );
  assert.equal(
    shouldOsNotifyTerminal({ sessionId: 'sess-1', activeSessionId: 'sess-1', windowAway: false }),
    false,
  );

  // Minimized or otherwise away, even if this session stays selected.
  assert.equal(
    shouldToastTerminal({ sessionId: 'sess-1', activeSessionId: 'sess-1', windowAway: true }),
    true,
  );
  assert.equal(
    shouldOsNotifyTerminal({ sessionId: 'sess-1', activeSessionId: 'sess-1', windowAway: true }),
    true,
  );

  // Another session finished while this window is in front.
  assert.equal(
    shouldToastTerminal({ sessionId: 'sess-2', activeSessionId: 'sess-1', windowAway: false }),
    true,
  );
  assert.equal(
    shouldOsNotifyTerminal({ sessionId: 'sess-2', activeSessionId: 'sess-1', windowAway: false }),
    true,
  );
});

test('minimized desktop window counts as away even if the page still looks focused', () => {
  assert.equal(windowAwayFrom({ pageHidden: false, pageFocused: true, hostAway: false }), false);
  assert.equal(windowAwayFrom({ pageHidden: false, pageFocused: true, hostAway: true }), true);
  assert.equal(windowAwayFrom({ pageHidden: true, pageFocused: true, hostAway: false }), true);
  assert.equal(windowAwayFrom({ pageHidden: false, pageFocused: false, hostAway: false }), true);
});

test('dispatchSystemNotification calls backend post function with expected payload', async () => {
  let calledWith: unknown = null;
  dispatchSystemNotification({
    title: 'Test Title',
    body: 'Test Body',
    sessionId: 'sess-123',
    tag: 'sess-123:done',
    postSystemNotifyFn: async (payload) => {
      calledWith = payload;
    },
  });
  assert.deepEqual(calledWith, {
    title: 'Test Title',
    body: 'Test Body',
    tag: 'sess-123:done',
    sessionId: 'sess-123',
  });
});
