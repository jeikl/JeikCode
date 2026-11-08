import type { SSEEvent } from '../api.ts';
import type { TurnUserAnchor } from './sessionProjection.ts';
import { replayFrameAnchor } from './replayFold.ts';
import { steerInsertAfterAnchor } from './sessionProjection.ts';

/** 回放帧落到的助手行（轮编号优先，其次工具 call id）。
 *  空锚点（`{}`，无任何身份）与未命中一样交给上一条帧，保持“最近的助手行”。 */
export function anchorForSteer(event: SSEEvent): TurnUserAnchor | undefined {
  if (event.type === 'steered' && event.anchor_message_id) {
    return { messageId: event.anchor_message_id, authoritative: true };
  }
  const anchor = replayFrameAnchor(event);
  return anchor.messageId || anchor.toolId ? anchor : undefined;
}

/**
 * 回放 / 跨流广播补回的转向气泡该插在哪里。
 *
 * 铁律：**绝不把一段连续的助手内容劈开**。转向帧自身不带线序锚点（`steered` 只有
 * 文本 / 消息 id / 时间戳），客户端只能靠“上一条真正上屏的帧”推断位置。一旦锚点
 * 没命中，或命中了一条后面还跟着助手行（同一批工具卡、同一轮回答），插进去就会
 * 把本该连在一起的 `Read / Read` 劈成两段——实测两台端会因此渲染出不同顺序。
 *
 * 因此：只有「锚点之后没有任何助手行或用户行」时才插回中间（系统通知不受影响）；
 * 其余情况一律返回 -1，交由调用方追加到时间线尾部。晚一位用户能接受，
 * 插到中间是直接可见的错误。
 *
 * 注意：这里只决定**数组位置**。转向行不再自造 `seq` —— 画布的渲染顺序只认数组
 * 因果序（见 `canvas/project.ts`），捏造排序键正是历史上一段内容被搬到开头的根源。
 */
export function steerInsertPosition(
  rows: ReadonlyArray<{ role: string }>,
  anchor: TurnUserAnchor | undefined,
  replay: boolean,
): number {
  if (!replay && !anchor?.authoritative) return -1;
  const at = steerInsertAfterAnchor(rows as Parameters<typeof steerInsertAfterAnchor>[0], anchor);
  if (at < 0) return -1;
  if (anchor?.authoritative) return at;
  for (let i = at; i < rows.length; i += 1) {
    if (rows[i]?.role === 'assistant' || rows[i]?.role === 'user') return -1;
  }
  return at;
}

/**
 * 画布落笔决策。`steerInsertPosition` 的 -1 同时表示「定位不到」与「应追加到尾部」；
 * 但对服务端权威锚点两者必须分开：锚点不在当前窗口里时，这条转向属于已加载切片
 * 之上，绝不能追加到尾部，否则刷新/中途进入后会掉到用户消息下面，直到回合结束
 * 磁盘转录重排才恢复。此时只消费队列卡，画布位置交给磁盘/服务端大纲。
 */
export function decideSteerPaint(
  rows: ReadonlyArray<{ role: string }>,
  anchor: TurnUserAnchor | undefined,
  replay: boolean,
): { at: number; defer: boolean } {
  const at = steerInsertPosition(rows, anchor, replay);
  return { at, defer: at < 0 && anchor?.authoritative === true };
}
