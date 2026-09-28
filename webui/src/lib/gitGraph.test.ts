import { test } from 'node:test';
import assert from 'node:assert';
import { buildGitGraph, formatRelativeTime } from './gitGraph.ts';
import type { GitCommitItem } from '../api.ts';

test('buildGitGraph handles empty commit list', () => {
  assert.deepEqual(buildGitGraph([]), []);
});

test('buildGitGraph assigns lanes and connects linear commits', () => {
  const commits: GitCommitItem[] = [
    {
      hash: 'commit-2',
      short_hash: 'c2',
      parents: ['commit-1'],
      author_name: 'Alice',
      author_email: 'a@example.com',
      timestamp: 1700000000,
      message: 'feat: add something',
      refs: ['HEAD -> main', 'main'],
    },
    {
      hash: 'commit-1',
      short_hash: 'c1',
      parents: [],
      author_name: 'Alice',
      author_email: 'a@example.com',
      timestamp: 1699990000,
      message: 'initial commit',
      refs: [],
    },
  ];

  const rows = buildGitGraph(commits);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.lane, 0);
  assert.equal(rows[1]!.lane, 0);
  assert.ok(rows[0]!.paths.length > 0);
});

test('buildGitGraph handles branch merge commits', () => {
  const commits: GitCommitItem[] = [
    {
      hash: 'merge-3',
      short_hash: 'm3',
      parents: ['main-2', 'feature-2'],
      author_name: 'Bob',
      author_email: 'b@example.com',
      timestamp: 1700003000,
      message: 'Merge branch feature into main',
      refs: ['HEAD -> main'],
    },
    {
      hash: 'feature-2',
      short_hash: 'f2',
      parents: ['base-1'],
      author_name: 'Bob',
      author_email: 'b@example.com',
      timestamp: 1700002000,
      message: 'feat: feature work',
      refs: ['feature'],
    },
    {
      hash: 'main-2',
      short_hash: 'm2',
      parents: ['base-1'],
      author_name: 'Alice',
      author_email: 'a@example.com',
      timestamp: 1700001000,
      message: 'fix: main fix',
      refs: [],
    },
    {
      hash: 'base-1',
      short_hash: 'b1',
      parents: [],
      author_name: 'Alice',
      author_email: 'a@example.com',
      timestamp: 1700000000,
      message: 'initial',
      refs: [],
    },
  ];

  const rows = buildGitGraph(commits);
  assert.equal(rows.length, 4);
  assert.ok(rows[0]!.maxLanes >= 2);
});

test('formatRelativeTime formats durations sensibly', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(formatRelativeTime(now - 10), 'just now');
  assert.equal(formatRelativeTime(now - 120), '2m ago');
  assert.equal(formatRelativeTime(now - 7200), '2h ago');
  assert.equal(formatRelativeTime(now - 86400 * 3), '3d ago');
});
