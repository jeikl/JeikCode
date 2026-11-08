// Compose the sidebar session list from the optimistic (client-only) entry and
// the server-fetched list. See sessionList.test.ts for the bug this guards.

export interface SessionLike {
  id: string;
  name: string;
  working_dir: string;
  // Physical session-bucket hash. Preferred over `working_dir` for the
  // same-project check: `working_dir` is a mutable field the daemon can
  // restamp, whereas the bucket a session lives in is fixed.
  project_hash?: string;
}

const normDir = (p: string): string => (p || '').replace(/\/+$/, '');

// Below this an INEXACT (prefix) title match is too weak a signal (short common
// openers like "你好"/"在吗" would prefix-suppress unrelated sessions in the same
// project). Short titles must match EXACTLY instead; see isSameSession.
const MIN_PREFIX_MATCH_LEN = 4;

// Two entries belong to the same project when their physical buckets match. Fall
// back to comparing `working_dir` only when a hash is missing (e.g. a transitional
// optimistic entry created before the project hash was known).
function sameProject(a: SessionLike, b: SessionLike): boolean {
  if (a.project_hash && b.project_hash) return a.project_hash === b.project_hash;
  return normDir(a.working_dir) === normDir(b.working_dir);
}

// Does the persisted session `s` represent the same conversation as the
// `optimistic` entry? The two can carry DIFFERENT ids: the /live snapshot
// can realign the optimistic id before the persisted session list catches up,
// so id-only dedup can leave a duplicate row. Fall back to a content match
// within the SAME project:
//   - exact name → same session (this is what closes the short-name dup, e.g.
//     "你好", which was never merged before because it is under MIN_PREFIX_MATCH_LEN);
//   - otherwise the persisted auto-name must EXTEND the optimistic title (its
//     first ~10 chars). The prefix check is ONE-DIRECTIONAL (persisted starts
//     with optimistic) so a genuinely new session whose short title merely
//     prefixes an existing longer name is not wrongly hidden, and only applies
//     to titles long enough to be a distinctive signal.
function isSameSession(s: SessionLike, optimistic: SessionLike): boolean {
  if (s.id === optimistic.id) return true;
  if (!sameProject(s, optimistic)) return false;
  if (s.name === optimistic.name) return true;
  if (optimistic.name.length < MIN_PREFIX_MATCH_LEN) return false;
  return s.name.startsWith(optimistic.name);
}

// Merge optimistic (client-only) entries into the server list: pin them to the
// top only while no persisted session already represents them.
export function mergeOptimisticSessions<T extends SessionLike>(
  optimistics: T[] | Record<string, T> | null | undefined,
  sessions: T[],
): T[] {
  if (!optimistics) return sessions;
  const list = Array.isArray(optimistics) ? optimistics : Object.values(optimistics);
  if (list.length === 0) return sessions;
  const unrepresented = list.filter((opt) => !sessions.some((s) => isSameSession(s, opt)));
  if (unrepresented.length === 0) return sessions;
  return [...unrepresented, ...sessions];
}

// Merge the optimistic (client-only) entry into the server list: pin it to the
// top only while no persisted session already represents it.
export function mergeOptimisticSession<T extends SessionLike>(
  optimistic: T | null | undefined,
  sessions: T[],
): T[] {
  if (!optimistic) return sessions;
  return mergeOptimisticSessions([optimistic], sessions);
}

/**
 * 同一会话 id 只保留第一次出现的行。
 *
 * 侧栏把「最近」、项目分组与乐观条目拼在同一屏：同一条会话可能因为项目桶缓存
 * 过期、或乐观条目同时命中两个分组而出现两次。完成徽标就会一次亮两处、点一次
 * 消两处。渲染前按 id 去重，保证「一个会话 = 一行 = 一个徽标」。
 * 没有 id 的行（老数据）保留原样，不参与去重。
 */
export function uniqueSessionsById<T extends { id?: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of list) {
    const id = row.id?.trim();
    if (!id) {
      out.push(row);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * 按可见顺序计算 Shift 点击的连续范围。
 *
 * 与 Windows 资源管理器 / Excel 的列多选一致：先在某一行落下锚点，
 * 再按住 Shift 点击另一行，两行之间的所有行（含两端）都会被选中。
 * 目标/锚点已不在当前可见列表中时，退化为只选中目标行，避免跨项目误选。
 */
export function sessionIdRange(
  orderedIds: string[],
  anchorId: string | null | undefined,
  targetId: string,
): string[] {
  const targetIdx = orderedIds.indexOf(targetId);
  if (targetIdx < 0) return [];
  if (!anchorId) return [targetId];
  const anchorIdx = orderedIds.indexOf(anchorId);
  if (anchorIdx < 0) return [targetId];
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  return orderedIds.slice(start, end + 1);
}

/** 项目分组折叠时固定展示的会话条数。 */
export const FOLDED_SESSION_LIMIT = 5;

export interface FoldedSessionList<T> {
  visible: T[];
  /** 去重后的项目会话总数。 */
  total: number;
  /** 折叠态下是否还有未渲染的会话。 */
  hasHidden: boolean;
  /** 是否渲染「展开更多 / 收起」开关。 */
  canToggle: boolean;
}

/**
 * 合并项目桶（权威、未截断）与全局 /sessions（仅最近 50 条）。
 *
 * 以项目桶为优先：刷新时不会因为全局列表先到而改写已有行的元数据；
 * 全局列表只用来补齐桶缓存尚未加载到的新会话（尤其是刚启动的运行中会话）。
 */
export function mergeProjectSessions<T extends { id?: string }>(
  bucket: T[],
  globalRows: T[],
): T[] {
  if (bucket.length === 0) return globalRows;
  if (globalRows.length === 0) return bucket;
  return uniqueSessionsById([...bucket, ...globalRows]);
}

/**
 * 计算项目分组实际渲染的会话行。
 *
 * - 折叠态：固定展示前 limit 条（运行中会话由调用方排序置顶），
 *   并额外保留当前选中会话与 keepIds（运行中会话），避免它们因折叠消失；
 * - 展开态：返回全量，因此该项目的所有运行中会话都会被渲染。
 *
 * 展开态只要总数超过 limit 就保留「收起」入口；折叠态只有确实存在
 * 未渲染的会话时才显示「展开更多」，不会出现点了没有变化的空开关。
 */
export function foldProjectSessions<T extends { id?: string }>(
  sorted: T[],
  options: {
    showAll: boolean;
    activeSessionId?: string | null;
    /** 折叠态也必须保留的行（例如运行中的会话），保证蓝圈不会因折叠消失。 */
    keepIds?: Iterable<string>;
    limit?: number;
  },
): FoldedSessionList<T> {
  const unique = uniqueSessionsById(sorted);
  const limit = Math.max(1, options.limit ?? FOLDED_SESSION_LIMIT);
  if (options.showAll) {
    return {
      visible: unique,
      total: unique.length,
      hasHidden: false,
      canToggle: unique.length > limit,
    };
  }
  const top = unique.slice(0, limit);
  const keep = new Set(options.keepIds ?? []);
  if (options.activeSessionId) keep.add(options.activeSessionId);
  const pinned = unique.filter(
    (session) => session.id && keep.has(session.id) && !top.some((row) => row.id === session.id),
  );
  const visible = pinned.length > 0 ? [...top, ...pinned] : top;
  const shown = new Set(visible.map((session) => session.id));
  const hasHidden = unique.some((session) => !shown.has(session.id));
  return { visible, total: unique.length, hasHidden, canToggle: hasHidden };
}
