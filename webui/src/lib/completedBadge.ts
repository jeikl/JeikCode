/**
 * 侧栏「刚完成」绿色对勾的状态机。
 *
 * 与运行中的蓝圈圈同源：都由全局 `activity` 广播驱动，因此多端 / 多标签页同步。
 * 只有内核权威终态 `terminal === 'completed'`（回合真正跑完、计时器停止）才点亮；
 * 用户停止、失败、以及中途临时空闲（没有 terminal）一律不点亮。
 * 会话再次开跑或用户点进去即熄灭 —— 只提示一次，不做持久化。
 */

/** 一条全局 activity 边沿：running 为运行态，terminal 只在终态帧上出现。 */
export interface ActivityEdge {
  sessionId: string;
  running: boolean;
  terminal?: string;
}

/**
 * 根据 activity 边沿推进「刚完成」集合。
 *
 * 返回原引用表示状态未变，避免无意义的重渲染。
 */
export function nextCompletedBadgeIds(prev: Set<string>, edge: ActivityEdge): Set<string> {
  // 没有会话 id 的坏帧 / 旧帧一律忽略：绝不能让它点亮任何一行。
  const sessionId = (edge.sessionId ?? '').trim();
  if (!sessionId) return prev;
  const had = prev.has(sessionId);
  // 会话又跑起来了（新回合 / steer 续轮 / loop 唤醒）：对勾让位给圈圈。
  if (edge.running) {
    if (!had) return prev;
    const next = new Set(prev);
    next.delete(sessionId);
    return next;
  }
  // 只认「真正完成」；用户停止 / 失败 / 中途空闲都不点亮。
  if (edge.terminal !== 'completed' || had) return prev;
  const next = new Set(prev);
  next.add(sessionId);
  return next;
}

/** 进入 / 删除会话：该会话的完成徽标立即熄灭（一次性提示）。 */
export function clearCompletedBadgeIds(prev: Set<string>, sessionId: string): Set<string> {
  if (!prev.has(sessionId)) return prev;
  const next = new Set(prev);
  next.delete(sessionId);
  return next;
}

/**
 * 滚动事件是不是「用户真的动了」？
 *
 * 正在观察的会话完成时会亮勾，但回合收尾自身也可能把时间线跟随到底 ——
 * 那种程序化滚动绝不能把刚亮起的勾瞬间吞掉。只有紧跟在滚轮 / 触摸 /
 * 拖动滚动条 / 键盘之后的滚动才算「看过了」。
 */
export function isUserDrivenScroll(input: {
  now: number;
  lastUserInputAt: number;
  pointerDown: boolean;
  windowMs?: number;
}): boolean {
  if (input.pointerDown) return true;
  return input.now - input.lastUserInputAt <= (input.windowMs ?? 800);
}
