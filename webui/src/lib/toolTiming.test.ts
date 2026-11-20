import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolTiming, resolveToolCostMs } from './toolTiming.ts';
import {
  observeServerTime,
  resetServerClockForTest,
  serverNowMs,
} from './serverClock.ts';

test('tool timing formats compactly across magnitudes', () => {
  assert.equal(formatToolTiming(undefined), '—');
  assert.equal(formatToolTiming(0), '0ms');
  assert.equal(formatToolTiming(420), '420ms');
  assert.equal(formatToolTiming(1_240), '1.2s');
  assert.equal(formatToolTiming(12_600), '12s');
  assert.equal(formatToolTiming(65_000), '1:05');
  assert.equal(formatToolTiming(3_725_000), '1:02:05');
});

test('settled cost never grows; only a running row uses the clock', () => {
  const settled = {
    status: 'done',
    started_at: 1_000,
    finished_at: 2_000,
    duration_ms: 900,
  };
  assert.equal(resolveToolCostMs(settled, 99_999), 900, 'daemon duration wins');

  const anchored = { status: 'done', started_at: 1_000, finished_at: 2_500 };
  assert.equal(
    resolveToolCostMs(anchored, 99_999),
    1_500,
    'missing duration falls back to persisted anchors, frozen',
  );

  const running = { status: 'pending', started_at: 1_000 };
  assert.equal(resolveToolCostMs(running, 4_000), 3_000, 'running cost grows');
  assert.equal(
    resolveToolCostMs({ status: 'incomplete', started_at: 1_000 }, 4_000),
    undefined,
    'unknown terminal cost is honestly blank',
  );
});

test('server clock offset keeps persisted anchors stable on a skewed client', () => {
  resetServerClockForTest();
  assert.equal(serverNowMs(1_000), 1_000, 'no observation falls back to local');

  // Server is 5s behind this client's local clock.
  observeServerTime(95_000, 100_000);
  assert.equal(serverNowMs(100_500), 95_500);
  assert.equal(
    resolveToolCostMs({ status: 'pending', started_at: 90_000 }, serverNowMs(100_500)),
    5_500,
  );
  resetServerClockForTest();
});
