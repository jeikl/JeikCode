import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRestoreCandidates,
  parseIdSet,
  parseRememberedSession,
  parseSidebarSnapshot,
  serializeIdSet,
  serializeRememberedSession,
  serializeSidebarSnapshot,
} from './navState.ts';

test('remembered session round-trips the fields needed to restore selection', () => {
  const raw = serializeRememberedSession({
    id: '11111111-1111-4111-8111-111111111111',
    project_hash: 'abcdef0123456789',
    working_dir: 'E:/code/jeikcode',
    name: 'canvas overhaul',
    message_count: 42,
    updated_at: 1700000000,
  });
  const parsed = parseRememberedSession(raw);
  assert.deepEqual(parsed, {
    id: '11111111-1111-4111-8111-111111111111',
    project_hash: 'abcdef0123456789',
    working_dir: 'E:/code/jeikcode',
    name: 'canvas overhaul',
    message_count: 42,
    updated_at: 1700000000,
  });
});

test('remembered session rejects corrupt payloads and empty ids', () => {
  assert.equal(parseRememberedSession(null), null);
  assert.equal(parseRememberedSession('{'), null);
  assert.equal(parseRememberedSession('null'), null);
  assert.equal(parseRememberedSession('{"id":""}'), null);
  assert.equal(parseRememberedSession('{"id":12}'), null);
  assert.equal(serializeRememberedSession({ id: '' }), null);
});

test('project id sets are de-duplicated, sorted and resilient to corruption', () => {
  assert.equal(serializeIdSet(['b', 'a', 'b', '']), '["a","b"]');
  assert.deepEqual([...parseIdSet('["a","a","b",1,null]')], ['a', 'b']);
  assert.deepEqual([...parseIdSet('not-json')], []);
  assert.deepEqual([...parseIdSet('{"a":1}')], []);
  assert.deepEqual([...parseIdSet(null)], []);
});

test('restore candidates prefer the URL session and never resolve the same id twice', () => {
  const full = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(buildRestoreCandidates(null, null), []);
  assert.deepEqual(buildRestoreCandidates(full, null), [full]);
  assert.deepEqual(buildRestoreCandidates('11111111', full), ['11111111']);
  assert.deepEqual(buildRestoreCandidates(null, full), [full]);
  assert.deepEqual(buildRestoreCandidates('22222222', full), ['22222222', full]);
});

test('sidebar snapshot restores the exact first paint and rejects corrupt rows', () => {
  const project = {
    hash: 'abcdef0123456789',
    name: 'jeikcode',
    working_dir: 'E:/code/jeikcode',
    session_count: 2,
    created_at: 1,
    last_updated: 2,
  };
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'canvas overhaul',
    working_dir: 'E:/code/jeikcode',
    project_hash: project.hash,
    created_at: 1,
    updated_at: 2,
    message_count: 42,
  };
  const raw = serializeSidebarSnapshot({
    projects: [project, { bad: true } as never],
    pinned: [project],
    sessions: [session, { id: 'broken' } as never],
    projectSessions: { [project.hash]: [session] },
    hidden: ['deadbeefdeadbeef', 1 as never],
    scrollTop: 137,
  });

  const parsed = parseSidebarSnapshot(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.projects, [project]);
  assert.deepEqual(parsed.pinned, [project]);
  assert.deepEqual(parsed.sessions, [session]);
  assert.deepEqual(parsed.projectSessions[project.hash], [session]);
  assert.deepEqual(parsed.hidden, ['deadbeefdeadbeef']);
  assert.equal(parsed.scrollTop, 137);
  assert.equal(parseSidebarSnapshot('{'), null);
  assert.equal(parseSidebarSnapshot('{"version":999}'), null);
});
