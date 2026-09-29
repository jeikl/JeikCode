import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolTouchesWorktree } from './gitRefresh.ts';

test('toolTouchesWorktree refreshes after edits and shell commands', () => {
  assert.equal(toolTouchesWorktree('run_command'), true);
  assert.equal(toolTouchesWorktree('bash'), true);
  assert.equal(toolTouchesWorktree('edit_file'), true);
  assert.equal(toolTouchesWorktree('write_file'), true);
  assert.equal(toolTouchesWorktree('read_file'), false);
  assert.equal(toolTouchesWorktree('grep'), false);
  assert.equal(toolTouchesWorktree('code_explore'), false);
});
