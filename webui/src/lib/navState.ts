/**
 * 浏览器本地的导航记忆（非跨设备同步）。
 *
 * 跨设备 / 无痕冷启动时 localStorage 为空：此时才走 daemon 的默认行为
 * （自动展开忙碌项目、展开当前会话所属项目）。但同一浏览器刷新绝不能被当成
 * 冷启动 —— 必须原样恢复「展开了哪些项目分组」和「当前选中哪个会话」，
 * 否则每次刷新左侧都会合并、选中会话消失，用户被踢回落地页。
 */

import type { ProjectInfo, SessionMetaWithProject } from '../api';

const REMEMBERED_SESSION_KEY = 'jeikcode:remembered-session';
const SIDEBAR_EXPANDED_PROJECTS_KEY = 'jeikcode:sidebar:expanded-projects';
const SIDEBAR_COLLAPSED_PROJECTS_KEY = 'jeikcode:sidebar:manually-collapsed-projects';

/** 刷新后恢复选中会话所需的最小元数据（完整 id，不是 URL 里的 8 位短 id）。 */
export interface RememberedSession {
  id: string;
  project_hash?: string;
  working_dir?: string;
  name?: string;
  message_count?: number;
  updated_at?: number;
}

/** 仅在浏览器可用时取 localStorage；隐私模式/禁用存储时静默降级。 */
function localStore(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage ?? null : null;
  } catch {
    return null;
  }
}

/** 校验并白名单化从 localStorage 读出的会话记忆。 */
export function parseRememberedSession(raw: string | null): RememberedSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RememberedSession> | null;
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) return null;
    const remembered: RememberedSession = { id: parsed.id };
    if (typeof parsed.project_hash === 'string' && parsed.project_hash) {
      remembered.project_hash = parsed.project_hash;
    }
    if (typeof parsed.working_dir === 'string' && parsed.working_dir) {
      remembered.working_dir = parsed.working_dir;
    }
    if (typeof parsed.name === 'string' && parsed.name) remembered.name = parsed.name;
    if (typeof parsed.message_count === 'number' && Number.isFinite(parsed.message_count)) {
      remembered.message_count = parsed.message_count;
    }
    if (typeof parsed.updated_at === 'number' && Number.isFinite(parsed.updated_at)) {
      remembered.updated_at = parsed.updated_at;
    }
    return remembered;
  } catch {
    return null;
  }
}

export function serializeRememberedSession(meta: RememberedSession | null): string | null {
  if (!meta?.id) return null;
  const minimal: RememberedSession = { id: meta.id };
  if (meta.project_hash) minimal.project_hash = meta.project_hash;
  if (meta.working_dir) minimal.working_dir = meta.working_dir;
  if (meta.name) minimal.name = meta.name;
  if (typeof meta.message_count === 'number') minimal.message_count = meta.message_count;
  if (typeof meta.updated_at === 'number') minimal.updated_at = meta.updated_at;
  return JSON.stringify(minimal);
}

export function readRememberedSession(): RememberedSession | null {
  try {
    return parseRememberedSession(localStore()?.getItem(REMEMBERED_SESSION_KEY) ?? null);
  } catch {
    return null;
  }
}

export function rememberSession(meta: RememberedSession | null): void {
  const store = localStore();
  if (!store) return;
  try {
    const next = serializeRememberedSession(meta);
    if (!next) {
      store.removeItem(REMEMBERED_SESSION_KEY);
      return;
    }
    if (store.getItem(REMEMBERED_SESSION_KEY) !== next) {
      store.setItem(REMEMBERED_SESSION_KEY, next);
    }
  } catch {
    /* 存储配额/权限异常不影响导航 */
  }
}

export function forgetRememberedSession(): void {
  try {
    localStore()?.removeItem(REMEMBERED_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 刷新恢复的候选顺序：URL 短 id 优先（地址栏可分享/可直达），
 * 其次才是本浏览器上次选中的完整 id。短前缀与完整 id 是同一目标，不重复解析。
 */
export function buildRestoreCandidates(
  urlId: string | null,
  rememberedId: string | null,
): string[] {
  const candidates: string[] = [];
  if (urlId) candidates.push(urlId);
  if (
    rememberedId &&
    !candidates.some((id) => id === rememberedId || rememberedId.startsWith(id))
  ) {
    candidates.push(rememberedId);
  }
  return candidates;
}

/** 解析项目 hash 集合；任何损坏内容都退化为空集合，绝不阻塞侧栏渲染。 */
export function parseIdSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
  } catch {
    return new Set();
  }
}

/** 稳定序列化（去重 + 排序），便于比较且避免无意义的重复写入。 */
export function serializeIdSet(ids: Iterable<string>): string {
  return JSON.stringify(
    [...new Set([...ids].filter((id) => typeof id === 'string' && id.length > 0))].sort(),
  );
}

function readStoredIdSet(key: string): Set<string> {
  try {
    return parseIdSet(localStore()?.getItem(key) ?? null);
  } catch {
    return new Set();
  }
}

function writeStoredIdSet(key: string, ids: Iterable<string>): void {
  const store = localStore();
  if (!store) return;
  try {
    const serialized = serializeIdSet(ids);
    if (serialized === '[]') {
      store.removeItem(key);
      return;
    }
    if (store.getItem(key) !== serialized) store.setItem(key, serialized);
  } catch {
    /* ignore */
  }
}

export interface SidebarMemory {
  /** 恢复后应保持展开的项目分组。 */
  expanded: Set<string>;
  /** 用户主动折叠、且自动展开不得覆盖的项目分组。 */
  collapsed: Set<string>;
}

/**
 * 读取侧栏记忆。同一项目不可能同时处于「展开」和「手动折叠」，
 * 真出现冲突时以展开为准（用户最近一次可见状态）。
 */
export function loadSidebarMemory(): SidebarMemory {
  const expanded = readStoredIdSet(SIDEBAR_EXPANDED_PROJECTS_KEY);
  const collapsed = readStoredIdSet(SIDEBAR_COLLAPSED_PROJECTS_KEY);
  for (const hash of expanded) collapsed.delete(hash);
  return { expanded, collapsed };
}

export function saveExpandedProjects(ids: Iterable<string>): void {
  writeStoredIdSet(SIDEBAR_EXPANDED_PROJECTS_KEY, ids);
}

export function saveManuallyCollapsedProjects(ids: Iterable<string>): void {
  writeStoredIdSet(SIDEBAR_COLLAPSED_PROJECTS_KEY, ids);
}

/**
 * 侧栏首屏快照。
 *
 * 仅恢复展开集合还不够：如果项目列表与会话行仍然等网络回来才填充，刷新时就会
 * 先看到“展开的空分组”，再被重排/合并成最终状态 —— 视觉上就是一次假刷新。
 * 这里把上次真正渲染过的项目顺序、会话行与隐藏/固定状态一起缓存，首帧直接
 * 画出同一份列表，随后再用服务端权威数据就地校准。
 */
const SIDEBAR_SNAPSHOT_KEY = 'jeikcode:sidebar:snapshot:v1';
const SIDEBAR_SNAPSHOT_VERSION = 1;

export interface SidebarSnapshot {
  projects: ProjectInfo[];
  pinned: ProjectInfo[];
  sessions: SessionMetaWithProject[];
  projectSessions: Record<string, SessionMetaWithProject[]>;
  hidden: string[];
  /** 上次会话列表的滚动位置；缺省表示旧版快照，退回“居中选中行”。 */
  scrollTop?: number;
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  const project = value as Partial<ProjectInfo> | null;
  return !!project
    && typeof project.hash === 'string'
    && typeof project.name === 'string'
    && typeof project.working_dir === 'string'
    && typeof project.session_count === 'number'
    && typeof project.created_at === 'number'
    && typeof project.last_updated === 'number';
}

function isSessionRow(value: unknown): value is SessionMetaWithProject {
  const session = value as Partial<SessionMetaWithProject> | null;
  return !!session
    && typeof session.id === 'string'
    && typeof session.name === 'string'
    && typeof session.working_dir === 'string'
    && typeof session.project_hash === 'string'
    && typeof session.created_at === 'number'
    && typeof session.updated_at === 'number'
    && typeof session.message_count === 'number';
}

export function parseSidebarSnapshot(raw: string | null): SidebarSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      projects?: unknown;
      pinned?: unknown;
      sessions?: unknown;
      projectSessions?: unknown;
      hidden?: unknown;
      scrollTop?: unknown;
    } | null;
    if (!parsed || parsed.version !== SIDEBAR_SNAPSHOT_VERSION) return null;
    const projectSessions: Record<string, SessionMetaWithProject[]> = {};
    if (parsed.projectSessions && typeof parsed.projectSessions === 'object') {
      for (const [hash, rows] of Object.entries(parsed.projectSessions as Record<string, unknown>)) {
        if (!hash || !Array.isArray(rows)) continue;
        projectSessions[hash] = rows.filter(isSessionRow);
      }
    }
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects.filter(isProjectInfo) : [],
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter(isProjectInfo) : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSessionRow) : [],
      projectSessions,
      hidden: Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0)
        : [],
      ...(typeof parsed.scrollTop === 'number' && Number.isFinite(parsed.scrollTop)
        ? { scrollTop: Math.max(0, parsed.scrollTop) }
        : {}),
    };
  } catch {
    return null;
  }
}

/** 限制快照规模，避免长历史/多项目把 localStorage 配额写满。 */
export function serializeSidebarSnapshot(snapshot: SidebarSnapshot): string {
  const capProjectSessions = Object.fromEntries(
    Object.entries(snapshot.projectSessions)
      .slice(0, 40)
      .map(([hash, rows]) => [hash, rows.slice(0, 40)]),
  );
  return JSON.stringify({
    version: SIDEBAR_SNAPSHOT_VERSION,
    projects: snapshot.projects.slice(0, 80),
    pinned: snapshot.pinned.slice(0, 40),
    sessions: snapshot.sessions.slice(0, 80),
    projectSessions: capProjectSessions,
    hidden: snapshot.hidden.slice(0, 100),
    ...(typeof snapshot.scrollTop === 'number' && Number.isFinite(snapshot.scrollTop)
      ? { scrollTop: Math.max(0, snapshot.scrollTop) }
      : {}),
  });
}

export function loadSidebarSnapshot(): SidebarSnapshot | null {
  try {
    return parseSidebarSnapshot(localStore()?.getItem(SIDEBAR_SNAPSHOT_KEY) ?? null);
  } catch {
    return null;
  }
}

export function saveSidebarSnapshot(snapshot: SidebarSnapshot): void {
  const store = localStore();
  if (!store) return;
  try {
    const next = serializeSidebarSnapshot(snapshot);
    if (store.getItem(SIDEBAR_SNAPSHOT_KEY) !== next) {
      store.setItem(SIDEBAR_SNAPSHOT_KEY, next);
    }
  } catch {
    /* 配额/权限异常：首屏退回服务端数据，不影响功能 */
  }
}
