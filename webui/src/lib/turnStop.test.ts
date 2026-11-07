import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bumpSessionSendNowEpoch,
  consumesProgrammaticStopMark,
  isCurrentSessionSendNowEpoch,
  isStaleProgrammaticStopFrame,
  isStaleTerminalForArmedTurn,
  isTurnHandoverProtected,
  runningTurnStopAliases,
  stopAliasAllowsNextTurn,
} from './turnStop.ts';

test('runningTurnStopAliases falls back to the session id after requestIdRef was cleared', () => {
  // 回归防线：本端回合被 /chat admit 之后 requestIdRef 已清空（null），
  // 此时仍必须能停止运行中的回合——否则「立即发送」会整体跳过停止并撞上 409 session_busy。
  assert.deepEqual(
    runningTurnStopAliases({ requestAlias: null, sessionId: 'session-1' }),
    ['session-1'],
  );
});

test('runningTurnStopAliases sends request alias first and dedupes a bound session', () => {
  assert.deepEqual(
    runningTurnStopAliases({ requestAlias: 'req-1', sessionId: 'session-1' }),
    ['req-1', 'session-1'],
  );
  assert.deepEqual(
    runningTurnStopAliases({ requestAlias: 'session-1', sessionId: 'session-1' }),
    ['session-1'],
  );
});

test('runningTurnStopAliases ignores blanks and stays empty when idle', () => {
  assert.deepEqual(runningTurnStopAliases({}), []);
  assert.deepEqual(runningTurnStopAliases({ requestAlias: '  ', sessionId: null }), []);
  assert.deepEqual(
    runningTurnStopAliases({ requestAlias: ' req-1 ', sessionId: undefined }),
    ['req-1'],
  );
});

test('consumesProgrammaticStopMark only matches the same session inside the window', () => {
  const mark = { sessionId: 'session-1', expiresAt: 1000 };
  assert.equal(consumesProgrammaticStopMark(mark, 'session-1', 999), true);
  assert.equal(consumesProgrammaticStopMark(mark, 'session-1', 1000), true);
  assert.equal(consumesProgrammaticStopMark(mark, 'session-1', 1001), false);
  assert.equal(consumesProgrammaticStopMark(mark, 'session-2', 500), false);
  assert.equal(consumesProgrammaticStopMark(mark, null, 500), false);
  assert.equal(consumesProgrammaticStopMark(null, 'session-1', 500), false);
});

test('programmatic stop with an operation id only swallows the displaced turn', () => {
  const mark = { sessionId: 'session-1', expiresAt: 10_000, operationId: 'old-op' };
  assert.equal(consumesProgrammaticStopMark(mark, 'session-1', 9_000, 'old-op'), true);
  assert.equal(consumesProgrammaticStopMark(mark, 'session-1', 9_000, 'new-op'), false);
  // Older daemons omit operation_id: the session-scoped compatibility window
  // still applies, so their legacy terminal pair remains suppressed.
  assert.equal(consumesProgrammaticStopMark(mark, 'session-1', 9_000, undefined), true);
});

test('stopAliasAllowsNextTurn treats an idle alias as free and a live turn as busy', () => {
  assert.equal(stopAliasAllowsNextTurn({ released: true, message: 'stopped' }), true);
  assert.equal(stopAliasAllowsNextTurn({ released: true }), true);
  assert.equal(
    stopAliasAllowsNextTurn({ released: false, message: 'Chat session req-1 was not running' }),
    true,
  );
  assert.equal(
    stopAliasAllowsNextTurn({ released: false, message: 'Chat session s1 stopped' }),
    false,
  );
  assert.equal(stopAliasAllowsNextTurn({ released: false }), false);
});

test('isStaleTerminalForArmedTurn 只吞“新回合尚未吐帧”窗口内的终态', () => {
  // 刚投递、还没吐帧：这就是上一回合的缓存终态（自动 drain 后的假停止根因）。
  assert.equal(isStaleTerminalForArmedTurn({ armedAt: 1_000, frameSeen: false, now: 1_500 }), true);
  // 已吐过帧：这条终态属于本轮，必须照常收尾。
  assert.equal(isStaleTerminalForArmedTurn({ armedAt: 1_000, frameSeen: true, now: 1_500 }), false);
  // 没投递过新回合：不干预。
  assert.equal(isStaleTerminalForArmedTurn({ frameSeen: false, now: 1_500 }), false);
  // 窗口过期（真失败永远收不到帧）：交回正常终态处理，避免 bus 永久卡住。
  assert.equal(isStaleTerminalForArmedTurn({ armedAt: 1_000, frameSeen: false, now: 20_000 }), false);
  assert.equal(
    isStaleTerminalForArmedTurn({ armedAt: 1_000, frameSeen: false, now: 5_000, ttlMs: 2_000 }),
    false,
  );
});

test('isStaleProgrammaticStopFrame swallows only the displaced turn terminal pair', () => {
  const mark = { sessionId: 's1', expiresAt: 10_000, operationId: 'old-op' };
  const at = 9_000;

  // 取消会先发 done(cancelled)，再发 legacy stopped；两条都属于被「立即发送」换掉的那一轮。
  assert.equal(isStaleProgrammaticStopFrame(mark, { type: 'stopped', operation_id: 'old-op' }, 's1', at), true);
  assert.equal(
    isStaleProgrammaticStopFrame(
      mark,
      { type: 'done', stop_reason: 'cancelled', operation_id: 'old-op' },
      's1',
      at,
    ),
    true,
  );
  // The replacement turn starts with a different operation id: its terminal
  // must settle normally even while the displaced-turn mark is still alive.
  assert.equal(
    isStaleProgrammaticStopFrame(
      mark,
      { type: 'done', stop_reason: 'cancelled', operation_id: 'new-op' },
      's1',
      at,
    ),
    false,
  );
  assert.equal(
    isStaleProgrammaticStopFrame(mark, { type: 'stopped', operation_id: 'new-op' }, 's1', at),
    false,
  );
  assert.equal(
    isStaleProgrammaticStopFrame(mark, { type: 'done', stop_reason: 'stopped' }, 's1', at),
    true,
  );

  // 新回合的正常完成绝不能被吞（否则真实终态不弹通知/不回吐队列）。
  assert.equal(
    isStaleProgrammaticStopFrame(mark, { type: 'done', stop_reason: 'provider_error' }, 's1', at),
    false,
  );
  assert.equal(isStaleProgrammaticStopFrame(mark, { type: 'done' }, 's1', at), false);

  // 会话不匹配 / 标记过期 / 无标记：一律不算旧回合。
  assert.equal(isStaleProgrammaticStopFrame(mark, { type: 'stopped' }, 's2', at), false);
  assert.equal(isStaleProgrammaticStopFrame(mark, { type: 'stopped' }, 's1', 10_001), false);
  assert.equal(isStaleProgrammaticStopFrame(null, { type: 'stopped' }, 's1', at), false);
});

test('isTurnHandoverProtected shields send-now handover and armed pre-frame turn from stale idle signals', () => {
  // 1. 正在 stopRunningTurn -> deliver 交接中：保护生效
  assert.equal(
    isTurnHandoverProtected({
      sessionId: 's1',
      now: 1_000,
      sendNowUntil: 5_000,
      frameSeen: false,
    }),
    true,
  );
  // 2. deliver 202 已返回（sendNowUntil 已清），但新回合刚 arm 尚未收到首帧：继续保护
  assert.equal(
    isTurnHandoverProtected({
      sessionId: 's1',
      now: 1_200,
      armedAt: 1_100,
      frameSeen: false,
      mark: { sessionId: 's1', expiresAt: 10_000, operationId: 'old-op' },
    }),
    true,
  );
  // 3. 新回合已收到首帧：交接保护退场，新回合自己的正常空闲/终态必须被放行
  assert.equal(
    isTurnHandoverProtected({
      sessionId: 's1',
      now: 1_500,
      armedAt: 1_100,
      frameSeen: true,
      mark: { sessionId: 's1', expiresAt: 10_000, operationId: 'old-op' },
    }),
    false,
  );
  // 4. 窗口全部过期或会话为空：不拦截
  assert.equal(
    isTurnHandoverProtected({
      sessionId: 's1',
      now: 25_000,
      sendNowUntil: 5_000,
      armedAt: 1_100,
      frameSeen: false,
      mark: { sessionId: 's1', expiresAt: 10_000, operationId: 'old-op' },
    }),
    false,
  );
  assert.equal(
    isTurnHandoverProtected({
      sessionId: null,
      now: 1_000,
      sendNowUntil: 5_000,
      frameSeen: false,
    }),
    false,
  );
});

test('sendNowEpoch is isolated per session so stopping/sending in session B never cancels session A', () => {
  const epochs = new Map<string, number>();
  const epochA = bumpSessionSendNowEpoch(epochs, 'session-a');
  const epochB = bumpSessionSendNowEpoch(epochs, 'session-b');

  assert.equal(isCurrentSessionSendNowEpoch(epochs, 'session-a', epochA), true);
  assert.equal(isCurrentSessionSendNowEpoch(epochs, 'session-b', epochB), true);

  // 会话 B 触发手动停止或再次立即发送：只失效会话 B，会话 A 的交接继续存活
  const epochB2 = bumpSessionSendNowEpoch(epochs, 'session-b');
  assert.equal(isCurrentSessionSendNowEpoch(epochs, 'session-a', epochA), true);
  assert.equal(isCurrentSessionSendNowEpoch(epochs, 'session-b', epochB), false);
  assert.equal(isCurrentSessionSendNowEpoch(epochs, 'session-b', epochB2), true);
});
