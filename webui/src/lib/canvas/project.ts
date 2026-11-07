/**
 * Pure canvas projection (L3-lite).
 *
 * `records` is the only source of truth; the view consumes this function's
 * output without reordering it. See {@link projectCanvas}.
 */
import type { CanvasRowLike } from './canvasStore.ts';

/**
 * Pure canvas projection (L3-lite).
 *
 * `records` is the only source of truth and **数组顺序就是因果顺序**：所有 reducer
 * 都按线序 append / insert，渲染层绝不能再按任何键重排。
 *
 * 历史上这里会在发现 `seq` 逆序时整表排序，而画布上的 `seq` 来自两套坐标系
 * （磁盘 `DisplayRecord.seq` 可能是上千，本地直播/转向行是从 0 开始的自增值）。
 * 一旦断线重连 / 切会话把两者拼到同一个数组，排序就把中间一段正文和 steer 卡
 * 搬到会话最前面——这正是用户看到的“内容消失 / 转向卡跑到开头”。
 *
 * `seq` 从此只是元数据：定位持久化行（`before_seq` 分页）、把直播行对齐到磁盘副本。
 * 它不参与渲染顺序。
 */
export function projectCanvas<T extends CanvasRowLike>(records: T[]): T[] {
  return records;
}
