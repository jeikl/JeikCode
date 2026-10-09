import type { GitBranchesResponse, GitCommitItem, GitStatusResponse, GitRepoInfo } from '../api';

/** @deprecated 定时轮询已被彻底拔除，Git 面板完全采用事件驱动与窗口焦点驱动刷新。保留此常量仅供向前兼容。 */
export const GIT_PANEL_POLL_MS = 3500;

/** Tools whose result can change the worktree or the git index. */
const WORKTREE_TOOLS = new Set([
  'edit',
  'edit_file',
  'write',
  'write_file',
  'create_file',
  'search_replace',
  'global_search_replace',
  'parallel_edit_files',
  'bash',
  'run_command',
]);

export interface GitPanelSnapshot {
  branch?: string | null;
  ahead?: number;
  behind?: number;
  staged: { path: string; status: string }[];
  unstaged: { path: string; status: string }[];
  untracked: { path: string }[];
  commits: { hash: string; message: string; refs: string[] }[];
}

/** Stable key for "did the changes list or the commit history move?". */
export function gitPanelFingerprint(snap: GitPanelSnapshot): string {
  const files = (items: { path: string; status?: string }[]) =>
    items
      .map((item) => `${item.status ?? ''}\t${item.path}`)
      .sort()
      .join('\n');
  const commits = snap.commits
    .map((commit) => `${commit.hash}\t${commit.refs.join(',')}\t${commit.message}`)
    .join('\n');
  return [
    snap.branch ?? '',
    String(snap.ahead ?? 0),
    String(snap.behind ?? 0),
    files(snap.staged),
    files(snap.unstaged),
    files(snap.untracked.map((item) => ({ path: item.path, status: '?' }))),
    commits,
  ].join('\n--\n');
}

/** True when a finished tool call may have changed what the Git panel shows. */
export function toolTouchesWorktree(name: string): boolean {
  return WORKTREE_TOOLS.has(name);
}

export interface GitCachedSnapshot {
  branches: GitBranchesResponse;
  commits: GitCommitItem[];
  gitStatus: GitStatusResponse;
  repos?: GitRepoInfo[];
  activeRepoRoot?: string | null;
  fingerprint: string;
  timestamp: number;
}

// 模块级内存热缓存（按 cwd / repoRoot 索引，提供 0ms 瞬间秒开）
const gitMemoryCache = new Map<string, GitCachedSnapshot>();

const STORAGE_PREFIX = 'jeikcode:git_cache:';

/**
 * 获取 Git 面板热缓存：优先从内存 Map 获取，其次从 sessionStorage 恢复。
 * 即使浏览器硬刷新 (F5) 或手机重新切入，也能在 0ms 内恢复上一次状态，彻底消除白屏与“正在加载中”。
 */
export function getGitCachedSnapshot(cwd?: string): GitCachedSnapshot | null {
  const key = cwd || '';
  const mem = gitMemoryCache.get(key);
  if (mem) return mem;

  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw) as GitCachedSnapshot;
        if (parsed && parsed.branches && parsed.gitStatus) {
          gitMemoryCache.set(key, parsed);
          return parsed;
        }
      }
    }
  } catch {
    // 忽略 sessionStorage 异常
  }
  return null;
}

/**
 * 写入 Git 面板热缓存：同步写入内存 Map 并持久化至 sessionStorage。
 */
export function setGitCachedSnapshot(cwd: string | undefined, snapshot: GitCachedSnapshot): void {
  const key = cwd || '';
  gitMemoryCache.set(key, snapshot);
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(snapshot));
    }
  } catch {
    // 忽略配额超限或跨域异常
  }
}

/**
 * 清除 Git 面板热缓存（用于手动强制清空或切换重大上下文）
 */
export function clearGitCachedSnapshot(cwd?: string): void {
  if (cwd !== undefined) {
    gitMemoryCache.delete(cwd);
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.removeItem(STORAGE_PREFIX + cwd);
      }
    } catch {}
  } else {
    gitMemoryCache.clear();
  }
}
