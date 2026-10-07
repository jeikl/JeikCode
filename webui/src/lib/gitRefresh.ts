/** How often the open Git panel re-reads status and history. */
export const GIT_PANEL_POLL_MS = 1000;

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
