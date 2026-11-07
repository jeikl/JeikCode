import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCompletedBadgeIds,
  isUserDrivenScroll,
  nextCompletedBadgeIds,
} from './completedBadge.ts';

const edge = (sessionId: string, running: boolean, terminal?: string) => ({
  sessionId,
  running,
  terminal,
});

test('只有内核权威 completed 终态才点亮完成对勾', () => {
  let ids = new Set<string>();
  ids = nextCompletedBadgeIds(ids, edge('s1', false, 'completed'));
  assert.deepEqual([...ids], ['s1']);

  // 用户停止 / 失败 / 中途临时空闲：一律不点亮。
  for (const [id, terminal] of [
    ['s2', 'stopped'],
    ['s3', 'failed'],
    ['s4', undefined],
  ] as const) {
    const next = nextCompletedBadgeIds(ids, edge(id, false, terminal));
    assert.equal(next, ids, `${terminal ?? 'no-terminal'} must not light a badge`);
  }
});

test('会话再次开跑时对勾让位给圈圈', () => {
  let ids = nextCompletedBadgeIds(new Set(), edge('s1', false, 'completed'));
  ids = nextCompletedBadgeIds(ids, edge('s1', true));
  assert.equal(ids.size, 0);

  // 本来就没有徽标：返回原引用，不触发重渲染。
  const idle = new Set<string>();
  assert.equal(nextCompletedBadgeIds(idle, edge('s9', true)), idle);
});

test('重复的完成帧只点亮一次（幂等）', () => {
  const first = nextCompletedBadgeIds(new Set(), edge('s1', false, 'completed'));
  const second = nextCompletedBadgeIds(first, edge('s1', false, 'completed'));
  assert.equal(second, first);
  assert.deepEqual([...second], ['s1']);
});

test('没有会话 id 的 activity 帧不点亮任何徽标', () => {
  const ids = new Set<string>();
  for (const sessionId of ['', '   ']) {
    assert.equal(
      nextCompletedBadgeIds(ids, edge(sessionId, false, 'completed')),
      ids,
      'empty session id must be ignored',
    );
  }
});

test('多个会话各自独立提示，点进去只熄灭自己那一个', () => {
  let ids = new Set<string>();
  ids = nextCompletedBadgeIds(ids, edge('a', false, 'completed'));
  ids = nextCompletedBadgeIds(ids, edge('b', false, 'completed'));
  assert.deepEqual([...ids].sort(), ['a', 'b']);

  ids = clearCompletedBadgeIds(ids, 'a');
  assert.deepEqual([...ids], ['b']);

  // 已熄灭的会话再点一次：保持原引用。
  assert.equal(clearCompletedBadgeIds(ids, 'a'), ids);
});

test('只有用户手势后的滚动才算看过，程序化的跟随滚动不算', () => {
  // 回合收尾自动“跟随到底”：没有用户输入 → 不得吞掉刚亮起的勾。
  assert.equal(isUserDrivenScroll({ now: 1000, lastUserInputAt: 0, pointerDown: false }), false);
  // 刚滚过滚轮 / 触摸 / 键盘：算看过。
  assert.equal(isUserDrivenScroll({ now: 1000, lastUserInputAt: 900, pointerDown: false }), true);
  // 太久之前的手势不生效。
  assert.equal(isUserDrivenScroll({ now: 1000, lastUserInputAt: 100, pointerDown: false }), false);
  // 正拖着滚动条：不管多久都算用户滚动。
  assert.equal(isUserDrivenScroll({ now: 1000, lastUserInputAt: 0, pointerDown: true }), true);
  // 可自定义判定窗口。
  assert.equal(
    isUserDrivenScroll({ now: 1000, lastUserInputAt: 100, pointerDown: false, windowMs: 2000 }),
    true,
  );
});
