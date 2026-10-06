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

/** True when a finished tool call may have changed what the Git panel shows. */
export function toolTouchesWorktree(name: string): boolean {
  return WORKTREE_TOOLS.has(name);
}
