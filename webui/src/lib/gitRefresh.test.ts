import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitPanelFingerprint, toolTouchesWorktree } from './gitRefresh.ts';

test('toolTouchesWorktree refreshes after edits and shell commands', () => {
  assert.equal(toolTouchesWorktree('run_command'), true);
  assert.equal(toolTouchesWorktree('bash'), true);
  assert.equal(toolTouchesWorktree('edit_file'), true);
  assert.equal(toolTouchesWorktree('write_file'), true);
  assert.equal(toolTouchesWorktree('read_file'), false);
  assert.equal(toolTouchesWorktree('grep'), false);
  assert.equal(toolTouchesWorktree('code_explore'), false);
});

test('gitPanelFingerprint changes when a file or commit appears', () => {
  const base = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [] as { path: string; status: string }[],
    unstaged: [] as { path: string; status: string }[],
    untracked: [] as { path: string }[],
    commits: [{ hash: 'abc', message: 'init', refs: ['HEAD -> main'] }],
  };
  const same = gitPanelFingerprint(base);
  assert.equal(gitPanelFingerprint({ ...base, unstaged: [...base.unstaged] }), same);
  assert.notEqual(
    gitPanelFingerprint({
      ...base,
      unstaged: [{ path: 'src/a.ts', status: 'M' }],
    }),
    same,
  );
  assert.notEqual(
    gitPanelFingerprint({
      ...base,
      commits: [{ hash: 'def', message: 'next', refs: ['HEAD -> main'] }],
    }),
    same,
  );
});
