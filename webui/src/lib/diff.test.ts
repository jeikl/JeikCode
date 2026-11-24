import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairDiffLines, parseUnifiedDiff } from './diff.ts';

test('parses and pairs multiple hunks with additions and deletions', () => {
  const diff = '--- a/x\n+++ b/x\n@@ -2,3 +2,2 @@ section\n same\n--- old\n-delete\n+++ new\n\\ No newline at end of file\n@@ -9,0 +10,1 @@\n+last\n';
  const rows = pairDiffLines(parseUnifiedDiff(diff));
  assert.equal(rows.length, 8);
  assert.equal(rows[2]?.full?.type, 'hunk');
  assert.equal(rows[3]?.old?.oldLineNumber, 2);
  assert.equal(rows[3]?.new?.newLineNumber, 2);
  assert.equal(rows[4]?.old?.text, '-- old');
  assert.equal(rows[4]?.new?.text, '++ new');
  assert.equal(rows[5]?.old?.text, 'delete');
  assert.equal(rows[5]?.new, undefined);
  assert.equal(rows[6]?.full?.type, 'hunk');
  assert.equal(rows[7]?.new?.newLineNumber, 10);
  assert.equal(rows[7]?.old, undefined);
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('parses a diff without a trailing newline and ignores no-newline markers', () => {
  const rows = pairDiffLines(parseUnifiedDiff('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    old: { type: 'del', text: 'old', oldLineNumber: 1 },
    new: { type: 'add', text: 'new', newLineNumber: 1 },
  });
  assert.equal(parseUnifiedDiff('@@ -0,0 +1 @@\n+last').at(-1)?.text, 'last');
});
