import { test } from 'node:test';
import assert from 'node:assert';
import { buildGitGraph, formatRelativeTime, formatRelativeTimeI18n, formatCommitDateTime } from './gitGraph.ts';
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

test('formatRelativeTimeI18n formats zh and en durations', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(formatRelativeTimeI18n(now - 10, true), '刚刚');
  assert.equal(formatRelativeTimeI18n(now - 240, true), '4 分钟前');
  assert.equal(formatRelativeTimeI18n(now - 7200, true), '2 小时前');
  assert.equal(formatRelativeTimeI18n(now - 86400 * 3, true), '3 天前');
  assert.equal(formatRelativeTimeI18n(now - 240, false), '4m ago');
});

test('formatCommitDateTime formats timestamps', () => {
  // 2026-10-05 20:00:00 UTC = 1791230400 (or predictable epoch)
  const epoch = 1700000000;
  const strZh = formatCommitDateTime(epoch, true);
  const strEn = formatCommitDateTime(epoch, false);
  assert.ok(strZh.includes('年') && strZh.includes('月') && strZh.includes('日'));
  assert.ok(strEn.includes('/'));
});
