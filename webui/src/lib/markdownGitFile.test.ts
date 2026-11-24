import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findChangedFile } from './markdownGitFile.ts';
import type { GitStatusResponse } from '../api.ts';

const status: GitStatusResponse = {
  is_repo: true, ahead: 0, behind: 0,
  staged: [{ path: 'src/a.ts', status: 'M' }],
  unstaged: [{ path: 'src/a.ts', status: 'M' }],
  untracked: [{ path: 'new.ts', status: '?' }],
};

test('matches actual status and prefers working tree over index', () => {
  assert.equal(findChangedFile('/repo/src/a.ts', '/repo', status)?.staged, false);
  assert.equal(findChangedFile('/repo/new.ts', '/repo', status)?.file.status, '?');
  assert.equal(findChangedFile('/repo/other.ts', '/repo', status), null);
  assert.equal(findChangedFile('/repository/src/a.ts', '/repo', status), null);
  assert.equal(findChangedFile('/repo/src/a.ts', '/repo', { ...status, is_repo: false }), null);
  assert.equal(findChangedFile('C:\\Repo\\src\\a.ts', 'c:\\repo', status)?.staged, false);
  assert.equal(findChangedFile('/repo/src/a.ts', '/repo', { ...status, unstaged: [] })?.staged, true);
});
