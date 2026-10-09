import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gitPanelFingerprint,
  toolTouchesWorktree,
  getGitCachedSnapshot,
  setGitCachedSnapshot,
  clearGitCachedSnapshot,
  type GitCachedSnapshot,
} from './gitRefresh.ts';

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

test('getGitCachedSnapshot and setGitCachedSnapshot provide fast memory warm recovery', () => {
  const cwd = '/test/repo';
  clearGitCachedSnapshot(cwd);
  assert.equal(getGitCachedSnapshot(cwd), null);

  const mockSnapshot: GitCachedSnapshot = {
    branches: { is_repo: true, current: 'main', local: ['main'], remote: [] },
    commits: [{ hash: '123', short_hash: '123', parents: [], author_name: 'test', author_email: 't@t.com', timestamp: 1000, message: 'm', refs: [] }],
    gitStatus: { is_repo: true, staged: [], unstaged: [], untracked: [], ahead: 0, behind: 0 },
    fingerprint: 'test-fingerprint',
    timestamp: Date.now(),
  };

  setGitCachedSnapshot(cwd, mockSnapshot);
  const recovered = getGitCachedSnapshot(cwd);
  assert.ok(recovered);
  assert.equal(recovered?.branches.current, 'main');
  assert.equal(recovered?.fingerprint, 'test-fingerprint');

  clearGitCachedSnapshot(cwd);
  assert.equal(getGitCachedSnapshot(cwd), null);
});
