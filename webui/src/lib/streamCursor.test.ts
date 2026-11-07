import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adoptedCanvasCoversCachedSnapshot,
  clearStreamCursor,
  readStreamCursor,
  resolveAfterSeq,
  resolveHydratedStreamCursor,
  setStreamEpoch,
  writeStreamCursor,
  type CursorStorage,
} from './streamCursor.ts';

/** 所有用例默认处在同一个 daemon 纪元里。 */
const EPOCH = 'daemon-epoch-1';
setStreamEpoch(EPOCH);

function fakeStorage(): CursorStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

test('游标只前进：重放/乱序帧不会把它往回拨', () => {
  const storage = fakeStorage();
  writeStreamCursor('s-1', 7, 'watch', storage);
  assert.deepEqual(readStreamCursor('s-1', 'watch', storage), { seq: 7 });
  writeStreamCursor('s-1', 5, 'watch', storage);
  assert.deepEqual(readStreamCursor('s-1', 'watch', storage), { seq: 7 });
  writeStreamCursor('s-1', 9, 'watch', storage);
  assert.deepEqual(readStreamCursor('s-1', 'watch', storage), { seq: 9 });
});

test('两条流各有自己的游标空间，互不覆盖', () => {
  const storage = fakeStorage();
  writeStreamCursor('s-1', 3, 'watch', storage);
  writeStreamCursor('s-1', 11, 'sync', storage);
  assert.deepEqual(readStreamCursor('s-1', 'watch', storage), { seq: 3 });
  assert.deepEqual(readStreamCursor('s-1', 'sync', storage), { seq: 11 });
});

test('回合结束清游标：旧序号不再有意义', () => {
  const storage = fakeStorage();
  writeStreamCursor('s-1', 4, 'watch', storage);
  clearStreamCursor('s-1', 'watch', storage);
  assert.equal(readStreamCursor('s-1', 'watch', storage), null);
});

test('daemon 重启（纪元变化）后旧游标作废：不得跳过新回合前半段', () => {
  const storage = fakeStorage();
  writeStreamCursor('s-restart', 4000, 'watch', storage);
  assert.deepEqual(readStreamCursor('s-restart', 'watch', storage), { seq: 4000 });

  // 重启：session_seq 从 0 重新计数，旧游标 4000 会落在新回合区间里，必须作废。
  setStreamEpoch('daemon-epoch-2');
  assert.equal(readStreamCursor('s-restart', 'watch', storage), null);
  assert.equal(
    resolveAfterSeq(readStreamCursor('s-restart', 'watch', storage), false),
    undefined,
    '旧纪元游标必须退化为全量补发',
  );

  // 新纪元重新记账（旧记录会被新值覆盖）。
  writeStreamCursor('s-restart', 10, 'watch', storage);
  assert.deepEqual(readStreamCursor('s-restart', 'watch', storage), { seq: 10 });
  setStreamEpoch(EPOCH);
});

test('纪元未知（health 未返回）时一律视为无游标', () => {
  const storage = fakeStorage();
  writeStreamCursor('s-unknown', 5, 'watch', storage);
  setStreamEpoch(null);
  assert.equal(readStreamCursor('s-unknown', 'watch', storage), null);
  setStreamEpoch(EPOCH);
  assert.deepEqual(readStreamCursor('s-unknown', 'watch', storage), { seq: 5 });
});

test('连接游标：有游标就续传；新会话（空画布）带 -1；有历史无游标才请求全量', () => {
  // 有游标 → 续传（收到的全是新的）
  assert.equal(resolveAfterSeq({ seq: 12 }, false), 12);
  assert.equal(resolveAfterSeq({ seq: 12 }, true), 12);
  // 新会话（无游标 + 空画布）→ -1：服务器跳过补发，直接转实时
  assert.equal(resolveAfterSeq(null, true), -1);
  // 无游标但画布有历史（换设备/清缓存）→ 全量补发（幂等收敛兜底）
  assert.equal(resolveAfterSeq(null, false), undefined);
});

test('存储不可用（隐私模式）时退化为无游标，不抛异常', () => {
  assert.equal(readStreamCursor('s-1', 'watch', null), null);
  writeStreamCursor('s-1', 5, 'watch', null);
  clearStreamCursor('s-1', 'watch', null);
  assert.equal(readStreamCursor('s-1', 'watch', null), null);
});

test('游标不跨页面文档：刷新后一律视为无游标，走全量补发', () => {
  const storage = fakeStorage();
  writeStreamCursor('s-1', 9, 'watch', storage, 'doc-a');
  assert.deepEqual(readStreamCursor('s-1', 'watch', storage, 'doc-a'), { seq: 9 });

  // 刷新（新文档）后画布来自防抖的 L2 缓存，可能落后于游标：
  // 此时绝不续传，否则服务器会跳过 `steered` 这类从未画上的边界帧。
  assert.equal(readStreamCursor('s-1', 'watch', storage, 'doc-b'), null);
  assert.equal(
    resolveAfterSeq(readStreamCursor('s-1', 'watch', storage, 'doc-b'), false),
    undefined,
    '有历史但无（有效）游标 → 全量补发',
  );

  // 旧文档的记录不能阻碍新文档重新记账（同一键只保留当前文档的游标）。
  writeStreamCursor('s-1', 3, 'watch', storage, 'doc-b');
  assert.deepEqual(readStreamCursor('s-1', 'watch', storage, 'doc-b'), { seq: 3 });
  assert.equal(
    readStreamCursor('s-1', 'watch', storage, 'doc-a'),
    null,
    '被新文档覆盖后，旧文档也不能再续传',
  );
});

test('resolveHydratedStreamCursor 只在 serverRunning 且上屏画布覆盖 live 快照并与当前运行 turn_id 完全匹配时恢复流空间游标', () => {
  const snapshotMsgs = [
    { id: 'u-1', role: 'user' },
    { id: 'a-1', role: 'assistant' },
  ];
  const adoptedSameOrNewer = [
    { id: 'u-1', role: 'user' },
    { id: 'a-1', role: 'assistant' },
    { id: 'steer-1', role: 'user' },
  ];
  // 1. 同一活跃回合 + serverRunning:true + 上屏画布覆盖快照：返回快照绑定的流空间 lastSeq
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: true,
      serverRunning: true,
      cachedPhase: 'live',
      cachedOperationId: 'op-current',
      cachedLastSeq: 349,
      activeTurnId: 'op-current',
      adoptedMessages: adoptedSameOrNewer,
      cachedMessages: snapshotMsgs,
    }),
    349,
  );
  // 2. serverRunning 为 false（终态附近残留 turn_id）：绝不恢复旧流游标
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: true,
      serverRunning: false,
      cachedPhase: 'live',
      cachedOperationId: 'op-current',
      cachedLastSeq: 349,
      activeTurnId: 'op-current',
      adoptedMessages: snapshotMsgs,
      cachedMessages: snapshotMsgs,
    }),
    undefined,
  );
  // 3. 上屏画布（SessionStoreMap）落后于或不同于缓存快照（memoryCache）：拒绝复用超前的 lastSeq
  assert.equal(
    adoptedCanvasCoversCachedSnapshot([{ id: 'u-1', role: 'user' }], snapshotMsgs),
    false,
  );
  assert.equal(
    adoptedCanvasCoversCachedSnapshot(
      [
        { id: 'u-1', role: 'user' },
        { id: 'a-other', role: 'assistant' },
      ],
      snapshotMsgs,
    ),
    false,
  );
  // 末条 id 命中但中间行缺失（旧实现的 some(id) 会误判为覆盖）
  assert.equal(
    adoptedCanvasCoversCachedSnapshot(
      [
        { id: 'x-0', role: 'user' },
        { id: 'a-1', role: 'assistant' },
      ],
      snapshotMsgs,
    ),
    false,
  );
  // 顺序颠倒
  assert.equal(
    adoptedCanvasCoversCachedSnapshot(
      [
        { id: 'a-1', role: 'assistant' },
        { id: 'u-1', role: 'user' },
      ],
      snapshotMsgs,
    ),
    false,
  );
  // 快照作为连续前缀出现，尾部允许有更新的实时行
  assert.equal(
    adoptedCanvasCoversCachedSnapshot(
      [...snapshotMsgs, { id: 'steer-1', role: 'user' }],
      snapshotMsgs,
    ),
    true,
  );
  // 无 id 的旧快照只有引用相同时才可证明覆盖
  const noIds = [{ role: 'user' }, { role: 'assistant' }];
  assert.equal(adoptedCanvasCoversCachedSnapshot(noIds, noIds), true);
  assert.equal(adoptedCanvasCoversCachedSnapshot([...noIds], noIds), false);
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: true,
      serverRunning: true,
      cachedPhase: 'live',
      cachedOperationId: 'op-current',
      cachedLastSeq: 349,
      activeTurnId: 'op-current',
      adoptedMessages: [{ id: 'u-1', role: 'user' }],
      cachedMessages: snapshotMsgs,
    }),
    undefined,
  );
  // 4. operationId 不匹配（上一回合残留或 daemon 重启换了新回合）：绝不复用旧流游标
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: true,
      serverRunning: true,
      cachedPhase: 'live',
      cachedOperationId: 'op-old',
      cachedLastSeq: 349,
      activeTurnId: 'op-new',
      adoptedMessages: snapshotMsgs,
      cachedMessages: snapshotMsgs,
    }),
    undefined,
  );
  // 5. 未采用缓存上屏（退回磁盘切片）或快照为 terminal / 缺 operationId：一律走全量幂等补发
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: false,
      serverRunning: true,
      cachedPhase: 'live',
      cachedOperationId: 'op-current',
      cachedLastSeq: 349,
      activeTurnId: 'op-current',
      adoptedMessages: snapshotMsgs,
      cachedMessages: snapshotMsgs,
    }),
    undefined,
  );
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: true,
      serverRunning: true,
      cachedPhase: 'terminal',
      cachedOperationId: 'op-current',
      cachedLastSeq: 349,
      activeTurnId: 'op-current',
      adoptedMessages: snapshotMsgs,
      cachedMessages: snapshotMsgs,
    }),
    undefined,
  );
  assert.equal(
    resolveHydratedStreamCursor({
      cacheAdopted: true,
      serverRunning: true,
      cachedPhase: 'live',
      cachedOperationId: null,
      cachedLastSeq: 349,
      activeTurnId: 'op-current',
      adoptedMessages: snapshotMsgs,
      cachedMessages: snapshotMsgs,
    }),
    undefined,
  );
});
