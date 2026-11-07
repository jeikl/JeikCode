/**
 * 画布唯一收敛点（Canvas Store）。
 *
 * 设计目标只有一个：**任何路径写入画布后，同一条消息都不能出现两份，
 * 并且每条记录都必须带有 `kind` 与 `seq`。**
 *
 * 判重身份严格按优先级取，绝不做文本推断：
 *   1. `id`（内核/前端铸造的终身身份）
 *   2. 无 `id` 的行原样保留（旧 daemon / 旧缓存），由历史兼容层负责补齐
 *
 * 归并语义：
 *   - 同 `id` 只保留一条；
 *   - **位置取首次出现**（先到的位置就是因果位置，后到帧不得把消息挪走）；
 *   - **内容取最后出现**（后到的帧承载更新的 parts / 状态）；
 *   - `kind` 由 `role` 派生，`seq` 由 `sourceIndex` 派生或取「当前最大 seq + 1」。
 *
 * 这个函数必须是纯函数、幂等、无副作用；返回原数组引用表示「没有变化」，
 * 让上层可以直接用它做 React 的 bail-out。
 */

import { recordKind } from './records.ts';

export interface CanvasRowLike {
  id?: string;
  kind?: string;
  seq?: number;
  role?: string;
  sourceIndex?: number;
}

/**
 * 按 `id` 归一化画布行，并补齐 `kind` / `seq`。
 *
 * - 无重复 id 且字段齐全 → 返回原数组（引用相等，触发 React bail-out）；
 * - 有重复 id → 位置 = 首次出现、内容 = 最后一次出现；
 * - 无 id 的行不合并、不删除（旧数据兼容），但仍会补齐 kind/seq；
 * - 无 `sourceIndex` 的直播行按数组顺序取得单调递增的 `seq`（排在磁盘行之后）。
 *
 * **不重排数组**：数组顺序即 seq 顺序——磁盘切片已由服务端按 sourceIndex 升序
 * 给出，直播行取「当前最大 seq + 1」，更早历史由 `mergeOlderMessages` 按 seq
 * 插入。在这里重排会把「猜出来的下标」当成权威顺序，反而制造错位。
 */
export function normalizeCanvas<T extends CanvasRowLike>(rows: T[]): T[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const firstIndexById = new Map<string, number>();
  let duplicate = false;
  let allComplete = true;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const id = row?.id;
    if (id) {
      if (firstIndexById.has(id)) duplicate = true;
      else firstIndexById.set(id, index);
    }
    const expectedKind = row?.kind ?? recordKind(row?.role);
    if (
      row?.kind !== expectedKind ||
      typeof row?.seq !== 'number' ||
      !Number.isFinite(row.seq)
    ) {
      allComplete = false;
    }
  }

  if (!duplicate && allComplete) {
    return rows;
  }

  let working: T[];
  let changed = false;

  if (!duplicate) {
    working = rows.slice();
  } else {
    changed = true;
    const lastRowById = new Map<string, T>();
    for (const row of rows) {
      if (row?.id) lastRowById.set(row.id, row);
    }
    working = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const id = row.id;
      if (!id) {
        working.push(row);
        continue;
      }
      const firstIndex = firstIndexById.get(id);
      if (firstIndex !== index) continue;
      const first = rows[firstIndex!]!;
      const latest = lastRowById.get(id) ?? row;
      // 位置沿用首次出现，seq 也必须沿用首次的（否则排序键与数组位置打架）。
      // 若首次出现尚无 seq，而后续同 id 副本带有过大的 seq，不得直接继承，
      // 交由下方按数组因果位置插值补齐，防止用户气泡被 projectCanvas 排到回答下方。
      const firstSeq =
        typeof first.seq === 'number' && Number.isFinite(first.seq) ? first.seq : undefined;
      if (firstSeq !== undefined) {
        working.push(latest.seq === firstSeq ? latest : ({ ...latest, seq: firstSeq } as T));
      } else if (typeof latest.seq === 'number' && Number.isFinite(latest.seq)) {
        const hasSmallerAhead = rows
          .slice(firstIndex! + 1)
          .some((r) => r?.id !== id && typeof r?.seq === 'number' && Number.isFinite(r.seq) && r.seq <= latest.seq!);
        working.push(hasSmallerAhead ? ({ ...latest, seq: undefined } as T) : latest);
      } else {
        working.push(latest);
      }
    }
  }

  // 按数组因果位置补齐缺失的 kind 与 seq：
  // - 尾部无 seq 行（常规直播追加）：顺延前驱最大整数 seq + 1；
  // - 头部或中间无 seq 行（例如回放补回的提问插在已有回答前面、或加载的无 seq 旧页）：
  //   严格在前驱与后继 seq 之间单调插值（或排在后继 seq 之前），绝不能盲取全局 maxSeq + 1
  //   导致 projectCanvas 把前插的用户气泡重排到助手回答下方！
  let prevSeq: number | undefined;
  let i = 0;
  while (i < working.length) {
    const row = working[i]!;
    const hasSeq = typeof row.seq === 'number' && Number.isFinite(row.seq);
    if (hasSeq) {
      const kind = row.kind ?? recordKind(row.role);
      if (kind !== row.kind) {
        changed = true;
        working[i] = { ...row, kind } as T;
      }
      prevSeq = row.seq!;
      i += 1;
      continue;
    }

    let end = i + 1;
    while (
      end < working.length &&
      (typeof working[end]?.seq !== 'number' || !Number.isFinite(working[end]!.seq))
    ) {
      end += 1;
    }
    const count = end - i;
    if (end >= working.length) {
      // 尾部连续无 seq 段：顺延整数递增
      let nextVal =
        prevSeq !== undefined
          ? Math.floor(prevSeq) + 1
          : 0;
      if (prevSeq !== undefined && nextVal <= prevSeq) {
        nextVal = prevSeq + 1;
      }
      for (let k = 0; k < count; k += 1) {
        const target = working[i + k]!;
        const kind = target.kind ?? recordKind(target.role);
        const seq = nextVal + k;
        changed = true;
        working[i + k] = { ...target, kind, seq } as T;
        prevSeq = seq;
      }
    } else {
      // 头部或夹心连续无 seq 段：锚定在 working[end].seq 之前
      const nextSeq = working[end]!.seq!;
      for (let k = 0; k < count; k += 1) {
        const step = k + 1;
        let seq: number;
        if (prevSeq === undefined) {
          seq = nextSeq - (count - step + 1) * 0.001;
        } else if (prevSeq < nextSeq) {
          seq = prevSeq + ((nextSeq - prevSeq) * step) / (count + 1);
        } else {
          seq = prevSeq + step * 0.0001;
        }
        const target = working[i + k]!;
        const kind = target.kind ?? recordKind(target.role);
        changed = true;
        working[i + k] = { ...target, kind, seq } as T;
        prevSeq = seq;
      }
    }
    i = end;
  }

  // 数组就是因果顺序；`seq` 只作分页元数据，不参与排序（见 projectCanvas）。
  return changed ? working : rows;
}

/** 画布唯一写入口接受的变更动作。调用点不再各自拼数组：
 *  - `replace`：整段替换（冷启动 / 权威切片）
 *  - `upsert`：按 id 合并（位置取首次、内容取最后）
 *  - `patch`：按 id 局部更新
 *  - `remove` / `removeWhere`：按 id 或谓词删除
 */
export type CanvasAction<T extends CanvasRowLike> =
  | { type: 'replace'; rows: T[] }
  | { type: 'upsert'; rows: T[] }
  | { type: 'patch'; id: string; patch: Partial<T> }
  | { type: 'remove'; id: string }
  | { type: 'removeWhere'; predicate: (row: T) => boolean }
  /** Transitional typed action: a pure row transform that still funnels through
   *  `normalizeCanvas`. Call sites migrate to the specific actions above one by
   *  one; no component writes the array directly. */
  | { type: 'apply'; updater: (rows: T[]) => T[] };

/** 纯函数 reducer：所有画布变更都从这里出，返回原引用表示无变化。 */
export function reduceCanvas<T extends CanvasRowLike>(
  rows: T[],
  action: CanvasAction<T>,
): T[] {
  switch (action.type) {
    case 'replace':
      return normalizeCanvas(action.rows);
    case 'upsert':
      return normalizeCanvas([...rows, ...action.rows]);
    case 'patch': {
      let changed = false;
      const next = rows.map((row) => {
        if (row.id !== action.id) return row;
        changed = true;
        return { ...row, ...action.patch };
      });
      return changed ? normalizeCanvas(next) : rows;
    }
    case 'remove': {
      const next = rows.filter((row) => row.id !== action.id);
      return next.length === rows.length ? rows : next;
    }
    case 'removeWhere': {
      const next = rows.filter((row) => !action.predicate(row));
      return next.length === rows.length ? rows : next;
    }
    case 'apply':
      return normalizeCanvas(action.updater(rows));
    default:
      // Unknown/future action types must never fall through to `undefined`:
      // `setMessages` feeds the result straight into React state, and a
      // non-array state crashes every render that iterates the canvas.
      return rows;
  }
}

/** 建立 `id → 下标` 索引（只对带 id 的行）。供需要 O(1) 定位的纯函数使用。 */
export function indexCanvasById<T extends CanvasRowLike>(rows: T[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const id = rows[i]?.id;
    if (id && !index.has(id)) index.set(id, i);
  }
  return index;
}

/** 画布中是否已有该身份（O(1) 判重的唯一正确写法）。 */
export function canvasHasId<T extends CanvasRowLike>(rows: T[], id: string | undefined): boolean {
  if (!id) return false;
  for (const row of rows) {
    if (row.id === id) return true;
  }
  return false;
}
