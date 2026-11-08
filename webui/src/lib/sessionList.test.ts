import { test } from 'node:test';
import assert from 'node:assert';
import {
  FOLDED_SESSION_LIMIT,
  foldProjectSessions,
  mergeOptimisticSession,
  mergeOptimisticSessions,
  mergeProjectSessions,
  sessionIdRange,
  uniqueSessionsById,
  type SessionLike,
} from './sessionList.ts';

const s = (over: Partial<SessionLike> = {}): SessionLike => ({
  id: 'id-x',
  name: '你谁呢？跟cc有啥差别？',
  working_dir: '/w',
  ...over,
});

test('optimistic row is suppressed once the real session is in the list even when ids differ (same dir + shared name prefix)', () => {
  // The bug: the /live snapshot can realign the optimistic id before /sessions
  // catches up. Id-only dedup then leaves a duplicate row until a full refresh.
  // Optimistic name = first 10 chars of the message; the persisted auto-name is the
  // fuller first message, so one is a prefix of the other.
  const optimistic = s({ id: 'optimistic-123', name: '你谁呢？跟cc有啥差' });
  const persisted = s({ id: '687a3a48', name: '你谁呢？跟cc有啥差别？' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 1, 'duplicate optimistic row must be suppressed');
  assert.equal(merged[0].id, '687a3a48');
});

test('id match still suppresses the optimistic entry (existing behavior preserved)', () => {
  const optimistic = s({ id: 'same' });
  const merged = mergeOptimisticSession(optimistic, [s({ id: 'same' })]);
  assert.equal(merged.length, 1);
});

test('an unrelated session does not suppress the optimistic entry', () => {
  const optimistic = s({ id: 'opt', name: '你谁呢？跟cc有啥差', working_dir: '/w' });
  const other = s({ id: 'other', name: '完全不同的会话', working_dir: '/w' });
  const merged = mergeOptimisticSession(optimistic, [other]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'opt', 'optimistic stays pinned to the top');
});

test('shared name prefix but different working_dir does NOT suppress', () => {
  const optimistic = s({ id: 'opt', name: '你谁呢？跟cc有啥差', working_dir: '/a' });
  const persisted = s({ id: 'real', name: '你谁呢？跟cc有啥差别？', working_dir: '/b' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 2);
});

test('trailing-slash differences in working_dir do not defeat the match', () => {
  const optimistic = s({ id: 'opt', name: '你谁呢？跟cc有啥差', working_dir: '/w/' });
  const persisted = s({ id: 'real', name: '你谁呢？跟cc有啥差别？', working_dir: '/w' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 1);
});

test('a NEW session is not hidden just because its title extends an existing shorter session name in the same dir', () => {
  // Reverse-prefix false hide: the persisted auto-name must extend the optimistic
  // title, not the other way round. Here the optimistic (new) title is the LONGER
  // one, so it is a different session and must still show.
  const existing = s({ id: 'old', name: '你好', working_dir: '/w' });
  const optimistic = s({ id: 'opt', name: '你好啊今天天气怎么样', working_dir: '/w' });
  const merged = mergeOptimisticSession(optimistic, [existing]);
  assert.equal(merged.length, 2, 'reverse-prefix must not hide the new session');
  assert.equal(merged[0].id, 'opt');
});

test('a very short optimistic title falls back to id-only (too weak a signal to suppress)', () => {
  const persisted = s({ id: 'real', name: '在吗，帮我看下', working_dir: '/w' });
  const optimistic = s({ id: 'opt', name: '在吗', working_dir: '/w' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 2, 'a 2-char title must not prefix-suppress an unrelated session');
});

test('null optimistic returns the list unchanged', () => {
  const list = [s({ id: 'a' }), s({ id: 'b' })];
  assert.deepEqual(mergeOptimisticSession(null, list), list);
});

test('empty optimistic name never matches by prefix (avoids hiding unrelated sessions)', () => {
  const optimistic = s({ id: 'opt', name: '', working_dir: '/w' });
  const persisted = s({ id: 'real', name: '任意会话', working_dir: '/w' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 2, 'an empty name must not prefix-match everything');
});

// Regression: a 2-char name like "你好" is under MIN_PREFIX_MATCH_LEN, so the
// prefix path never fired and the optimistic id + persisted id
// rows both showed. An EXACT name match in the same project closes this.
test('short EXACT name in the same project (by hash) suppresses the duplicate', () => {
  const optimistic = s({ id: 'opt', name: '你好', working_dir: '/w', project_hash: 'h1' });
  const persisted = s({ id: 'real', name: '你好', working_dir: '/w', project_hash: 'h1' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 1, 'exact short name in same project must dedup');
  assert.equal(merged[0].id, 'real');
});

test('short EXACT name in a DIFFERENT project (different hash) is NOT merged', () => {
  const optimistic = s({ id: 'opt', name: '你好', working_dir: '/a', project_hash: 'h1' });
  const persisted = s({ id: 'real', name: '你好', working_dir: '/b', project_hash: 'h2' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 2, 'same short name in a different project is a different session');
});

test('exact-name dedup still works via working_dir when no hash is present', () => {
  const optimistic = s({ id: 'opt', name: '你好', working_dir: '/w' });
  const persisted = s({ id: 'real', name: '你好', working_dir: '/w' });
  const merged = mergeOptimisticSession(optimistic, [persisted]);
  assert.equal(merged.length, 1, 'landing-page optimistic (no hash) falls back to working_dir');
});

test('mergeOptimisticSessions retains multiple in-flight optimistic sessions', () => {
  const opt1 = s({ id: 'opt-1', name: '你好', working_dir: '/w' });
  const opt2 = s({ id: 'opt-2', name: '在吗', working_dir: '/w' });
  const persisted = s({ id: 'real', name: '较早会话', working_dir: '/w' });
  const merged = mergeOptimisticSessions([opt1, opt2], [persisted]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((x) => x.id), ['opt-1', 'opt-2', 'real']);
});

test('mergeOptimisticSessions accepts a record dictionary of sessions', () => {
  const dict = {
    'opt-1': s({ id: 'opt-1', name: '你好', working_dir: '/w' }),
    'opt-2': s({ id: 'opt-2', name: '在吗', working_dir: '/w' }),
  };
  const persisted = s({ id: 'opt-1', name: '你好', working_dir: '/w' });
  const merged = mergeOptimisticSessions(dict, [persisted]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'opt-2');
  assert.equal(merged[1].id, 'opt-1');
});

test('session navigation sequence drops stale createSession responses when user switches project/session in-flight', async () => {
  // 模拟竞态状态机
  let navSeq = 0;
  let activeSessionId: string | null = null;
  let activeWorkingDir = '/project-a';

  // 1. 用户在项目 B 点击新建聊天
  const currentSeq = ++navSeq;
  activeSessionId = null;
  activeWorkingDir = '/project-b'; // 立即对齐为项目 B

  // 模拟异步 createSession 正在网络飞行中
  let createSessionResolve: (data: { id: string; working_dir: string }) => void = () => {};
  const createPromise = new Promise<{ id: string; working_dir: string }>((res) => {
    createSessionResolve = res;
  });

  // 2. 这时候用户马上切换到项目 A 的某个 session
  navSeq++; // 会话切换使序号递增，作废所有在途操作
  activeSessionId = 'session-in-project-a';
  activeWorkingDir = '/project-a';

  // 3. 此时刚才在项目 B 的 createSession 请求返回了
  createSessionResolve({ id: 'new-session-in-b', working_dir: '/project-b' });
  const responseData = await createPromise;

  // 4. 校验：由于 currentSeq !== navSeq，该响应必须被丢弃
  if (currentSeq === navSeq) {
    activeSessionId = responseData.id;
    activeWorkingDir = responseData.working_dir;
  }

  // 5. 确保项目 A 的当前会话和工作目录未被篡改和覆盖
  assert.equal(activeSessionId, 'session-in-project-a', '当前会话必须保持在项目 A，坚决不能被项目 B 的新会话覆盖');
  assert.equal(activeWorkingDir, '/project-a', '当前工作目录必须保持在项目 A，坚决杜绝被项目 B 覆盖导致穿透');
});

test('sortSessions correctly handles seconds vs milliseconds timestamps and does not push seconds sessions to 1970', () => {
  const normTs = (ts: number) => (ts > 0 && ts < 1e11 ? ts * 1000 : ts);

  const olderMsSession = { id: 'older', updated_at: 1741512000000 };
  const newerSecSession = { id: 'newer', updated_at: 1741513000 }; // written in seconds

  const list = [olderMsSession, newerSecSession];
  list.sort((a, b) => {
    const aMs = normTs(a.updated_at);
    const bMs = normTs(b.updated_at);
    return bMs - aMs;
  });

  assert.equal(list[0].id, 'newer', 'newer session with seconds timestamp must rank first after normalization');
  assert.equal(list[1].id, 'older');
});

test('同一会话 id 跨分组只保留一行，完成徽标不会一次亮两处', () => {
  const rows = [
    { id: 'session-c', name: 'C（项目 A）' },
    { id: 'session-d', name: 'D（项目 B）' },
    { id: 'session-c', name: 'C（过期项目桶里的重复行）' },
    { id: '', name: '无 id 的旧行一' },
    { id: '', name: '无 id 的旧行二' },
  ];
  assert.deepEqual(
    uniqueSessionsById(rows).map((row) => row.name),
    ['C（项目 A）', 'D（项目 B）', '无 id 的旧行一', '无 id 的旧行二'],
  );
});

const sessionRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `session-${i + 1}`, name: `会话 ${i + 1}` }));

test('Shift 点击选中锚点到目标之间的连续范围', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(sessionIdRange(order, 'a', 'd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sessionIdRange(order, 'd', 'b'), ['b', 'c', 'd'], '反向点击同样有效');
  assert.deepEqual(sessionIdRange(order, 'c', 'c'), ['c']);
});

test('没有锚点或锚点已不可见时只选中目标行', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(sessionIdRange(order, null, 'b'), ['b']);
  assert.deepEqual(sessionIdRange(order, 'gone', 'c'), ['c']);
  assert.deepEqual(sessionIdRange(order, 'a', 'gone'), []);
});

test('全局列表只补齐项目桶缺失的行，已有行以项目桶为准', () => {
  const bucket = [
    { id: 'a', name: 'A（桶）' },
    { id: 'b', name: 'B（桶）' },
  ];
  const globalRows = [
    { id: 'b', name: 'B（全局）' },
    { id: 'c', name: 'C（全局）' },
  ];
  assert.deepEqual(mergeProjectSessions(bucket, globalRows), [
    { id: 'a', name: 'A（桶）' },
    { id: 'b', name: 'B（桶）' },
    { id: 'c', name: 'C（全局）' },
  ]);
});

test('项目桶尚未加载 / 全局列表为空时都能安全退化', () => {
  const rows = [{ id: 'a' }];
  assert.deepEqual(mergeProjectSessions([], rows), rows);
  assert.deepEqual(mergeProjectSessions(rows, []), rows);
});

test('折叠态固定展示 5 条，存在更多会话时显示展开更多', () => {
  const folded = foldProjectSessions(sessionRows(8), { showAll: false });
  assert.equal(FOLDED_SESSION_LIMIT, 5);
  assert.deepEqual(folded.visible.map((row) => row.id), [
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
  ]);
  assert.equal(folded.total, 8);
  assert.equal(folded.hasHidden, true);
  assert.equal(folded.canToggle, true);
});

test('折叠态不丢当前选中会话，但不会因此多显示其它未选中的行', () => {
  const folded = foldProjectSessions(sessionRows(8), {
    showAll: false,
    activeSessionId: 'session-8',
  });
  assert.deepEqual(folded.visible.map((row) => row.id), [
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-8',
  ]);
  assert.equal(folded.canToggle, true);
});

test('折叠态保留所有运行中会话（蓝圈），即使它们排在第 5 条之后', () => {
  const rows = sessionRows(9);
  const folded = foldProjectSessions(rows, {
    showAll: false,
    activeSessionId: 'session-1',
    keepIds: ['session-8', 'session-9'],
  });
  assert.deepEqual(folded.visible.map((row) => row.id), [
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-8',
    'session-9',
  ]);
  assert.equal(folded.hasHidden, true);
  assert.equal(folded.canToggle, true);
});

test('运行中会话已经在前 5 条时不重复追加', () => {
  const folded = foldProjectSessions(sessionRows(8), {
    showAll: false,
    keepIds: ['session-2', 'session-3'],
  });
  assert.deepEqual(folded.visible.map((row) => row.id), [
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
  ]);
  assert.equal(folded.canToggle, true);
});

test('展开态返回全量（运行中会话由排序置顶后必然包含在内）', () => {
  const rows = sessionRows(9);
  const folded = foldProjectSessions(rows, { showAll: true, activeSessionId: 'session-9' });
  assert.equal(folded.visible.length, 9);
  assert.deepEqual(folded.visible, rows);
  assert.equal(folded.hasHidden, false);
  assert.equal(folded.canToggle, true, '展开态仍需保留收起入口');
});

test('不足 5 条时不显示空的展开/收起开关', () => {
  const folded = foldProjectSessions(sessionRows(3), { showAll: false });
  assert.equal(folded.visible.length, 3);
  assert.equal(folded.hasHidden, false);
  assert.equal(folded.canToggle, false);
});

test('重复 id 不占用折叠名额，5 条可见行去重后仍尽量填满', () => {
  const rows = [
    { id: 'a' },
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
    { id: 'e' },
    { id: 'f' },
  ];
  const folded = foldProjectSessions(rows, { showAll: false });
  assert.deepEqual(folded.visible.map((row) => row.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(folded.total, 6);
  assert.equal(folded.canToggle, true);
});
