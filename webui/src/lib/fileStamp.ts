/**
 * 磁盘文件戳：编辑器用它判断“磁盘版本是否真的变过”。
 *
 * 只看 mtime 不够稳妥（touch / 写回相同内容都会动 mtime），因此客户端把它当作
 * 廉价预筛，真正决定是否刷新时仍以内容比对为准；但“是否变化”的通知本身只要
 * (mtime, size) 与基线不同即可，重复通知由基线的推进来抑制。
 */

export interface FileStamp {
  exists: boolean;
  /** epoch 毫秒；拿不到 mtime 时为 null（此时仅靠 size 判断）。 */
  modifiedMs: number | null;
  size: number;
}

export interface FileStampSource {
  exists?: boolean;
  size?: number | null;
  modified_ms?: number | null;
}

export function fileStampFromStat(stat: FileStampSource): FileStamp {
  return {
    exists: stat.exists !== false,
    modifiedMs: stat.modified_ms ?? null,
    size: stat.size ?? 0,
  };
}

/** `/fs/read` 的响应可直接当作基线；老版本后端没有 size 字段时返回 null（交给首轮 stat 建立基线）。 */
export function fileStampFromRead(res: FileStampSource): FileStamp | null {
  if (typeof res.size !== 'number') return null;
  return { exists: true, modifiedMs: res.modified_ms ?? null, size: res.size };
}

export function sameFileStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (!a || !b) return a === b;
  return a.exists === b.exists && a.modifiedMs === b.modifiedMs && a.size === b.size;
}
