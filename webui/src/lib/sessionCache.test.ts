import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMemorySession,
  getSessionCache,
  hasMemorySession,
  mergeCachePatch,
  writeSessionCache,
  shouldAcceptCacheWrite,
  stripUnbackedProvisionalTurns,
  clearAllSessionCache,
} from './sessionCache.ts';

test('sessionCache keeps the highest applied stream seq', async () => {
  const p = 'proj-seq';
  const s = 'sess-seq';
  await clearAllSessionCache();
  writeSessionCache(p, s, { messages: [{ role: 'user', content: 'one' }], lastSeq: 7 });
  assert.equal(getMemorySession(p, s)?.lastSeq, 7);
  writeSessionCache(p, s, { messages: [{ role: 'user', content: 'two' }], lastSeq: 5 });
  assert.equal(getMemorySession(p, s)?.lastSeq, 7, 'lastSeq never regresses');
});

test('sessionCache manages L1 memory LRU correctly', async () => {
  const p = 'proj-1';
  const s = 'sess-1';
  await clearAllSessionCache();
  assert.equal(hasMemorySession(p, s), false);

  writeSessionCache(p, s, { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(hasMemorySession(p, s), true);

  const mem = getMemorySession(p, s);
  assert.ok(mem);
  assert.equal(mem?.messages.length, 1);
  assert.equal(mem?.messages[0].content, 'hello');

  writeSessionCache(p, s, {
    messages: [...(mem?.messages ?? []), { role: 'assistant', content: 'world' }],
  });
  const updated = getMemorySession(p, s);
  assert.equal(updated?.messages.length, 2);

  await clearAllSessionCache();
  assert.equal(hasMemorySession(p, s), false);
});

test('provisional outline rows without a persisted user message are not cached', async () => {
  const p = 'proj-provisional';
  const s = 'sess-provisional';
  const turns = [
    { index: 0, id: 'u-1', label: 'persisted', provisional: true },
    { index: 1, id: 'steer-ghost', label: 'unsent steer', provisional: true },
  ];
  const messages = [{ role: 'user', id: 'u-1', content: 'persisted' }];
  assert.deepEqual(
    stripUnbackedProvisionalTurns(turns, messages),
    [{ index: 0, id: 'u-1', label: 'persisted', provisional: true }],
  );
  writeSessionCache(p, s, { messages, turns });
  assert.deepEqual(getMemorySession(p, s)?.turns, [turns[0]]);
  await clearAllSessionCache();
});

test('sessionCache preserves turns outline', async () => {
  const p = 'proj-2';
  const s = 'sess-2';
  const turns = [{ index: 0, ordinal: 0, label: 'Q1' }, { index: 1, ordinal: 1, label: 'Q2' }];
  writeSessionCache(p, s, { messages: [{ role: 'user', content: 'Q1' }], turns });
  const mem = getMemorySession(p, s);
  assert.ok(mem);
  assert.deepEqual(mem?.turns, turns);

  // 验证当 projectHash 为空时，按 sessionId 能够成功检索命中（冷启动离线秒出保障）
  const offline = await getSessionCache('', s);
  assert.ok(offline);
  assert.equal(offline?.sessionId, s);
  assert.equal(offline?.projectHash, p);
  assert.equal(offline?.messages.length, 1);
  assert.equal(offline?.messages[0].content, 'Q1');

  await clearAllSessionCache();
});

// ============================================================================
// 版本闸门：旧快照永远不能覆盖新快照
// ============================================================================

test('shouldAcceptCacheWrite only lets revisions move forward', () => {
  assert.equal(shouldAcceptCacheWrite(undefined, 3), true, '首次写入');
  assert.equal(shouldAcceptCacheWrite(3, 3), true, '同版本允许合并');
  assert.equal(shouldAcceptCacheWrite(3, 4), true, '新版本允许');
  assert.equal(shouldAcceptCacheWrite(4, 3), false, '旧版本必须拒绝');
  assert.equal(shouldAcceptCacheWrite(4, null), true, '未知版本按旧行为放行');
  assert.equal(shouldAcceptCacheWrite(4, undefined), true, '未提供版本放行');
});

test('writeSessionCache rejects a stale revision and keeps the newer canvas', async () => {
  const p = 'proj-3';
  const s = 'sess-3';
  await clearAllSessionCache();

  assert.equal(
    writeSessionCache(p, s, { messages: [{ role: 'user', content: 'new' }], revision: 8 }),
    true,
  );
  // 旧 revision 的写入必须被丢弃。
  assert.equal(
    writeSessionCache(p, s, { messages: [{ role: 'user', content: 'stale' }], revision: 7 }),
    false,
  );

  const mem = getMemorySession(p, s);
  assert.equal(mem?.revision, 8);
  assert.equal(mem?.messages[0].content, 'new');

  await clearAllSessionCache();
});

// ============================================================================
// 字段合并：undefined = 保留，null = 清空
// ============================================================================

test('mergeCachePatch keeps untouched fields and clears only explicit null', () => {
  const previous = {
    sessionId: 's',
    projectHash: 'p',
    messages: [{ role: 'user', content: 'Q1' }],
    revision: 5,
    todos: [{ id: '1', content: 'task', status: 'pending' as const }],
    turns: [{ index: 0, ordinal: 0, label: 'Q1' }],
    tokenUsage: { prompt: 10, completion: 2, total: 12, cached: 0 },
    historyOffset: 12,
    historyTotal: 40,
    timestamp: 1,
  };

  const kept = mergeCachePatch('p', 's', previous, { messages: previous.messages });
  assert.deepEqual(kept.todos, previous.todos, 'undefined 必须保留待办');
  assert.deepEqual(kept.turns, previous.turns, 'undefined 必须保留大纲');
  assert.deepEqual(kept.tokenUsage, previous.tokenUsage, 'undefined 必须保留 token 度量');
  assert.equal(kept.historyOffset, 12, 'undefined 必须保留游标');
  assert.equal(kept.revision, 5, 'undefined 必须保留版本');
  assert.equal(kept.todos === previous.todos, true, '保留时应是同一个引用（避免无谓拷贝）');

  const cleared = mergeCachePatch('p', 's', previous, { todos: null, tokenUsage: null });
  assert.equal(cleared.todos, undefined, 'null 必须清空待办');
  assert.equal(cleared.tokenUsage, undefined, 'null 必须清空 token 度量');
  assert.deepEqual(cleared.turns, previous.turns, '未提到的字段仍然保留');
});

test('a messages-only write never wipes the cached todo panel', async () => {
  const p = 'proj-4';
  const s = 'sess-4';
  await clearAllSessionCache();

  const todos = [{ id: '1', content: '写测试', status: 'in_progress' }];
  writeSessionCache(p, s, {
    messages: [{ role: 'user', content: 'Q1' }],
    todos,
    historyOffset: 3,
    historyTotal: 9,
  });
  // 只更新消息、不传 todos（旧实现会把它抹成 undefined）。
  writeSessionCache(p, s, { messages: [{ role: 'user', content: 'Q2' }] });

  const mem = getMemorySession(p, s);
  assert.deepEqual(mem?.todos, todos, '未传 todos 时不得清空');
  assert.equal(mem?.historyOffset, 3, '未传游标时不得清空');
  assert.equal(mem?.historyTotal, 9);

  await clearAllSessionCache();
});

test('mergeCachePatch resets inherited lastSeq when operationId changes and clears on explicit null', () => {
  const prev = {
    sessionId: 's-op',
    projectHash: 'p-op',
    messages: [{ role: 'user', content: 'old' }],
    lastSeq: 500,
    operationId: 'op-1',
    phase: 'live' as const,
    timestamp: 1,
  };
  const nextOp = mergeCachePatch('p-op', 's-op', prev, {
    messages: [{ role: 'user', content: 'new' }],
    operationId: 'op-2',
    lastSeq: 12,
  });
  assert.equal(nextOp.operationId, 'op-2');
  assert.equal(nextOp.lastSeq, 12, '新回合不能继承旧回合残留的高水位流序号');

  // 回归：旧缓存没有 operationId（undefined）但留有旧高水位 500，新回合写入 op-2 时同样绝不能继承 500
  const legacyPrev = {
    sessionId: 's-legacy',
    projectHash: 'p-op',
    messages: [{ role: 'user', content: 'legacy' }],
    lastSeq: 500,
    operationId: undefined,
    timestamp: 1,
  };
  const promotedOp = mergeCachePatch('p-op', 's-legacy', legacyPrev, {
    messages: [{ role: 'user', content: 'new-op' }],
    operationId: 'op-2',
    lastSeq: 12,
  });
  assert.equal(promotedOp.operationId, 'op-2');
  assert.equal(promotedOp.lastSeq, 12, '无 operationId 的旧缓存升级为新 operation 时不得把旧 lastSeq=500 带过来');

  // 显式清空 operationId: null 时也不继承旧 lastSeq
  const clearedOp = mergeCachePatch('p-op', 's-op', prev, {
    messages: [{ role: 'user', content: 'settled' }],
    operationId: null,
  });
  assert.equal(clearedOp.operationId, undefined);
  assert.equal(clearedOp.lastSeq, undefined);

  const clearedSeq = mergeCachePatch('p-op', 's-op', nextOp, { lastSeq: null });
  assert.equal(clearedSeq.lastSeq, undefined);
});
