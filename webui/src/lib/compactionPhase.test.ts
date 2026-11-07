import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLiveElapsedAnchor, standaloneStatusMode } from './compactionPhase.ts';
import { reduceCanvasEvent } from './canvas/actions.ts';
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
});
