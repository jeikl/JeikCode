import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunningProofFrame,
  resolveRuntimeBusyAction,
  serverRuntimeRunning,
} from './serverRuntime.ts';

test('直播内容帧是运行证据；回放帧与终态帧不是', () => {
  assert.equal(isRunningProofFrame('text', false), true);
  assert.equal(isRunningProofFrame('tool_start', false), true);
  assert.equal(isRunningProofFrame('steered', false), true);
  // 回放只是补历史，不代表此刻还在跑（否则用户刚停止就会被回放点亮回去）。
  assert.equal(isRunningProofFrame('text', true), false);
  // 终态帧永远不是运行证据。
  assert.equal(isRunningProofFrame('done', false), false);
  assert.equal(isRunningProofFrame('stopped', false), false);
  assert.equal(isRunningProofFrame('error', false), false);
  // 与回合执行无关的帧不得点亮。
  assert.equal(isRunningProofFrame('tokens', false), false);
  assert.equal(isRunningProofFrame('session_start', false), false);
});

test('服务端说在跑：熄灭的一端点亮点亮（含 /loop 等待唤醒）', () => {
  assert.equal(
    resolveRuntimeBusyAction({
      serverRunning: true,
      busy: false,
      hasForegroundSend: false,
      inManualStopGuard: false,
    }),
    'arm',
  );
  // 已经亮着不必重复。
  assert.equal(
    resolveRuntimeBusyAction({
      serverRunning: true,
      busy: true,
      hasForegroundSend: false,
      inManualStopGuard: false,
    }),
    'none',
  );
  // 用户刚点停止：2.5s 防抖窗口内不弹回。
  assert.equal(
    resolveRuntimeBusyAction({
      serverRunning: true,
      busy: false,
      hasForegroundSend: false,
      inManualStopGuard: true,
    }),
    'none',
  );
});

test('服务端说空闲：只有在途 POST / 防抖窗口都不成立时才熄灭', () => {
  const idle = { serverRunning: false, busy: true, hasForegroundSend: false, inManualStopGuard: false };
  assert.equal(resolveRuntimeBusyAction(idle), 'settle');
  // 本端 POST 还在飞（admission 未落定）：服务端可能还没登记，不能熄灭。
  assert.equal(resolveRuntimeBusyAction({ ...idle, hasForegroundSend: true }), 'none');
  // 立即发送交接期 / 新回合刚投递尚未吐帧：旧回合退场的滞后空闲广播不得把新回合误熄。
  assert.equal(resolveRuntimeBusyAction({ ...idle, hasPendingTurnHandover: true }), 'none');
  // 手动停止防抖窗口内保持现状。
  assert.equal(resolveRuntimeBusyAction({ ...idle, inManualStopGuard: true }), 'none');
  // 本来就空闲：无事可做。
  assert.equal(resolveRuntimeBusyAction({ ...idle, busy: false }), 'none');
});

test('serverRuntimeRunning 只认显式 true，缺失即空闲', () => {
  assert.equal(serverRuntimeRunning({ running: true }), true);
  assert.equal(serverRuntimeRunning({ running: false }), false);
  assert.equal(serverRuntimeRunning({}), false);
  assert.equal(serverRuntimeRunning(null), false);
  assert.equal(serverRuntimeRunning(undefined), false);
  // 非布尔真值不算（避免老 daemon / 异常负载误点火）。
  assert.equal(serverRuntimeRunning({ running: 1 as unknown as boolean }), false);
});
