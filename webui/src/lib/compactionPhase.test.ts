import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLiveElapsedAnchor, standaloneStatusMode } from './compactionPhase.ts';
import {
  drainPendingAnchoredNotices,
  enqueuePendingAnchoredNotice,
  reduceCanvasEvent,
  type SystemNoticeWire,
} from './canvas/actions.ts';
import type { ProjectionMessage } from './sessionProjection.ts';

test('压缩计时以压缩起点为准，绝不回退到上一轮提问时间', () => {
  assert.equal(
    resolveLiveElapsedAnchor({
      compacting: true,
      compactionStartedAt: 2_000,
      turnStartedAt: 1_000,
      userTs: 500,
    }),
    2_000,
  );
  // 刷新后没有 compactionStartedAt 时才退回回合/提问时间。
  assert.equal(
    resolveLiveElapsedAnchor({ compacting: true, turnStartedAt: 1_000, userTs: 500 }),
    1_000,
  );
});

test('普通回合仍然以用户提问时刻为计时锚点', () => {
  assert.equal(
    resolveLiveElapsedAnchor({
      compacting: false,
      compactionStartedAt: 2_000,
      turnStartedAt: 1_000,
      userTs: 500,
    }),
    500,
  );
});

test('服务端时钟略快时锚点夹到当前时刻，计时器不会凭空消失', () => {
  assert.equal(
    resolveLiveElapsedAnchor({
      compacting: true,
      compactionStartedAt: 5_000,
      now: 4_000,
    }),
    4_000,
  );
});

test('流式 assistant 气泡拥有压缩标记，独立状态行不得重复', () => {
  assert.equal(
    standaloneStatusMode({
      compacting: true,
      busy: true,
      lastVisibleRole: 'assistant',
      lastRole: 'assistant',
    }),
    null,
  );
});

test('压缩且没有流式 assistant 气泡时由独立状态行兜底', () => {
  assert.equal(
    standaloneStatusMode({
      compacting: true,
      busy: true,
      lastVisibleRole: 'user',
      lastRole: 'user',
    }),
    'compacting',
  );
  // 刷新后只恢复了压缩阶段（busy 尚未点亮）也必须显示标记。
  assert.equal(
    standaloneStatusMode({
      compacting: true,
      busy: false,
      lastVisibleRole: 'assistant',
      lastRole: 'assistant',
    }),
    'compacting',
  );
  // 末尾有 system 通知时 assistant 不再是最后一行，气泡不渲染 shimmer。
  assert.equal(
    standaloneStatusMode({
      compacting: true,
      busy: true,
      lastVisibleRole: 'system',
      lastRole: 'assistant',
    }),
    'compacting',
  );
});

test('普通工作状态行只在最后一条有效消息是用户提问时出现', () => {
  assert.equal(
    standaloneStatusMode({
      compacting: false,
      busy: true,
      lastVisibleRole: 'user',
      lastRole: 'user',
    }),
    'working',
  );
  assert.equal(
    standaloneStatusMode({
      compacting: false,
      busy: true,
      lastVisibleRole: 'assistant',
      lastRole: 'assistant',
    }),
    null,
  );
  assert.equal(
    standaloneStatusMode({
      compacting: false,
      busy: true,
      lastVisibleRole: undefined,
      lastRole: undefined,
    }),
    null,
  );
  assert.equal(
    standaloneStatusMode({
      compacting: false,
      busy: false,
      lastVisibleRole: 'user',
      lastRole: 'user',
    }),
    null,
  );
});

test('权威显示通知按 display_seq 摆位并按 id 幂等去重', () => {
  const initial: ProjectionMessage[] = [
    { role: 'user', id: 'u1', seq: 1, parts: [{ kind: 'text', text: 'q1' }] },
    { role: 'assistant', id: 'a1', seq: 2, parts: [{ kind: 'text', text: 'r1' }] },
    { role: 'user', id: 'u2', seq: 4, parts: [{ kind: 'text', text: 'q2' }] },
  ];
  const inserted = reduceCanvasEvent(initial, {
    type: 'authoritative_notice',
    id: 'notice-compact-1',
    seq: 3,
    text: '已压缩 4 条消息（12,000 → 2,400 tokens）',
    ts: 1_700,
  });
  assert.deepEqual(
    inserted.map((r) => [r.role, r.id, r.seq]),
    [
      ['user', 'u1', 1],
      ['assistant', 'a1', 2],
      ['system', 'notice-compact-1', 3],
      ['user', 'u2', 4],
    ],
  );
  // 重放或磁盘重拉再次投递同一 id，不得产生第二条。
  const replayed = reduceCanvasEvent(inserted, {
    type: 'authoritative_notice',
    id: 'notice-compact-1',
    seq: 3,
    text: '已压缩 4 条消息（12,000 → 2,400 tokens）',
    ts: 1_700,
  });
  assert.equal(replayed, inserted);

  // 同 id 新内容（例如重试 1/9 → 2/9 → 终态详情）：必须原地覆写并保留位置与部件身份。
  const retryInitial = reduceCanvasEvent(initial, {
    type: 'authoritative_notice',
    id: 'm1:retry',
    seq: 3,
    text: '连接中断,已保留当前输出,重试 1/9 次',
    ts: 1_800,
  });
  const retryUpdated = reduceCanvasEvent(retryInitial, {
    type: 'authoritative_notice',
    id: 'm1:retry',
    seq: 5,
    text: '连接中断,已保留当前输出,重试 2/9 次',
    ts: 1_900,
  });
  assert.notEqual(retryUpdated, retryInitial);
  assert.equal(retryUpdated.length, retryInitial.length);
  const updatedRow = retryUpdated.find((r) => r.id === 'm1:retry')!;
  assert.equal(updatedRow.parts[0]!.kind, 'notice');
  assert.equal((updatedRow.parts[0] as { text?: string }).text, '连接中断,已保留当前输出,重试 2/9 次');
  assert.equal((updatedRow.parts[0] as { id?: string }).id, 'm1:retry:1:notice');
});

test('system_notice 按因果 anchorMessageId 就地插入，绝不因直播 seq 混比倒插到正文之上', () => {
  const initial: ProjectionMessage[] = [
    { role: 'user', id: 'u-1', parts: [{ kind: 'text', text: '提问' }] },
    { role: 'assistant', id: 'a-1', parts: [{ kind: 'text', text: '部分正文' }] },
    { role: 'user', id: 'u-2', parts: [{ kind: 'text', text: '下一轮' }] },
  ];
  // 锚定到 a-1 后：即使没有 seq 或 seq 小于直播行，也必须紧随 a-1、在 u-2 之前。
  const withRetry = reduceCanvasEvent(initial, {
    type: 'system_notice',
    eventId: 'retry-inc-1',
    partId: 'retry-inc-1:1:notice',
    kind: 'retry',
    severity: 'warning',
    status: 'active',
    revision: 1,
    text: '流中断，正在重试 (1/9)',
    anchorMessageId: 'a-1',
  });
  assert.deepEqual(
    withRetry.map((r) => [r.role, r.id]),
    [
      ['user', 'u-1'],
      ['assistant', 'a-1'],
      ['system', 'retry-inc-1'],
      ['user', 'u-2'],
    ],
  );

  // 终态耗尽覆盖同一 eventId：保持单卡原位更新，且随后乱序的 active 旧帧无法反向降级。
  const settled = reduceCanvasEvent(withRetry, {
    type: 'system_notice',
    eventId: 'retry-inc-1',
    kind: 'timeout',
    severity: 'error',
    status: 'settled',
    revision: 9,
    text: '重试已耗尽（9/9）',
    anchorMessageId: 'a-1',
  });
  const staleActive = reduceCanvasEvent(settled, {
    type: 'system_notice',
    eventId: 'retry-inc-1',
    kind: 'retry',
    severity: 'warning',
    status: 'active',
    revision: 10,
    text: '迟到的重试帧',
    anchorMessageId: 'a-1',
  });
  assert.equal(staleActive, settled);
  const card = staleActive[2]!.parts[0] as { text?: string; status?: string; severity?: string; kind?: string };
  assert.equal(card.text, '重试已耗尽（9/9）');
  assert.equal(card.status, 'settled');
  assert.equal(card.severity, 'error');
});

test('system_notice 缺席锚点在 pendingAnchoredNotices 队列暂存与合并，补页加载后归位', () => {
  let queue: SystemNoticeWire[] = [];
  const ev1: SystemNoticeWire = {
    event_id: 'compact-old-1',
    kind: 'compaction',
    severity: 'info',
    status: 'settled',
    revision: 1,
    text: '已压缩 · 12K → 3K tokens',
    anchor_message_id: 'a-old',
  };
  queue = enqueuePendingAnchoredNotice(queue, ev1);

  const liveCanvas: ProjectionMessage[] = [
    { role: 'user', id: 'u-live', seq: 10, sourceIndex: 10, parts: [{ kind: 'text', text: '当前提问' }] },
  ];
  const beforeLoad = drainPendingAnchoredNotices(queue, liveCanvas);
  assert.equal(beforeLoad.ready.length, 0);
  assert.equal(beforeLoad.remaining.length, 1);

  // 上滑加载旧页把 a-old 带进画布后，待挂载队列自动释放并精确落在 a-old 之后。
  let withOlder = reduceCanvasEvent(liveCanvas, {
    type: 'older',
    rows: [
      { role: 'user', id: 'u-old', seq: 1, sourceIndex: 1, parts: [{ kind: 'text', text: '旧提问' }] },
      { role: 'assistant', id: 'a-old', seq: 2, sourceIndex: 2, parts: [{ kind: 'text', text: '旧回答' }] },
    ],
  });
  const afterLoad = drainPendingAnchoredNotices(beforeLoad.remaining, withOlder);
  assert.equal(afterLoad.ready.length, 1);
  assert.equal(afterLoad.remaining.length, 0);
  for (const act of afterLoad.ready) {
    withOlder = reduceCanvasEvent(withOlder, act);
  }
  assert.deepEqual(
    withOlder.map((r) => r.id),
    ['u-old', 'a-old', 'compact-old-1', 'u-live'],
  );
});

test('settle_active_notices 在回合终止时把残留 active 通知全部收敛为 settled', () => {
  const activeCanvas = reduceCanvasEvent(
    [{ role: 'user', id: 'u-1', parts: [{ kind: 'text', text: 'hi' }] }],
    {
      type: 'system_notice',
      eventId: 'retry-live',
      kind: 'retry',
      severity: 'warning',
      status: 'active',
      revision: 1,
      text: 'retrying 1/9',
      anchorMessageId: 'u-1',
    },
  );
  const settled = reduceCanvasEvent(activeCanvas, { type: 'settle_active_notices' });
  const part = settled[1]!.parts[0] as { status?: string };
  assert.equal(part.status, 'settled');
});
