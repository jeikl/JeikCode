import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sessionNoticeLabel,
  shouldEmitNotice,
  shouldOsNotifyReview,
  showPermissionNotice,
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
