import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildTurnNavItems,
  buildTurnNavItemsFromOutline,
  canvasHistoryHead,
  dedupeTurnOutline,
  filterTurnNavItems,
  fullerOutline,
  hasOlderVisibleMessages,
  historyCursorFor,
  mergeServerWithLocalOutline,
  removeOutlineRowsById,
  remainingUnloadedTurns,
  canvasAtVeryBeginning,
  resolveActiveTurnId,
  turnNavId,
  turnNavScrollTop,
  visibleOlderRemainingCount,
} from './turnNav.ts';

test('turnNavId prefers the persisted message id and falls back to index', () => {
  assert.equal(turnNavId(undefined, 3), 'turn-nav-3');
  assert.equal(turnNavId('m-abc', 3), 'turn-nav-m-abc');
});

test('persisted outline index wins over a provisional pending index', () => {
  const serverFirst = dedupeTurnOutline([
    { index: 10, id: 'm1', label: 'Q', pending: false },
    { index: 9, id: 'm1', label: 'Q', pending: true },
  ]);
  assert.equal(serverFirst.length, 1);
  assert.equal(serverFirst[0]!.index, 10);
  assert.equal(serverFirst[0]!.pending, false);

  const pendingFirst = dedupeTurnOutline([
    { index: 9, id: 'm1', label: 'Q', pending: true },
    { index: 10, id: 'm1', label: 'Q', pending: false },
  ]);
  assert.equal(pendingFirst.length, 1);
  assert.equal(pendingFirst[0]!.index, 10);
  assert.equal(pendingFirst[0]!.pending, false);
});


// 右栏死链的根因回归：画布被权威尾部对账裁回窗口后，分页游标必须跟着画布头部走。
// 真实会话（1918 行 / 110 个提问）：用户点开过更早历史（游标=6），随后一次终态
// 对账把画布换成 [1864..1917] 的 54 行尾部。旧实现游标仍为 6，于是 index 在
// [6,1864) 的每一条提问都被判成“已加载”→ 不发请求 → 点上去毫无反应。
test('画布裁剪后游标按画布头部重算，更早的提问重新可点（不留死链）', () => {
  const tail = [
    { role: 'user', sourceIndex: 1864 },
    { role: 'assistant', sourceIndex: 1865 },
    { role: 'assistant', sourceIndex: 1917 },
  ];
  assert.equal(canvasHistoryHead(tail), 1864);
  const cursor = historyCursorFor(tail, [{ index: 6 }, { index: 1864 }]);
  assert.deepEqual(cursor, { offset: 1864, hasOlder: true });

  // 旧游标（6）会把 427 这条提问当成“已加载”；重算后必须判为需要拉取。
  assert.equal(427 < 6, false);
  assert.equal(427 < cursor!.offset, true);

  // 画布已经包含首问时没有任何更早历史，绝不能一直显示“加载更早消息”。
  const full = [{ sourceIndex: 6 }, { sourceIndex: 15 }, { sourceIndex: 1917 }];
  assert.deepEqual(historyCursorFor(full, [{ index: 6 }]), { offset: 6, hasOlder: false });

  // 没有任何绝对下标（旧缓存/直播尾巴）时不得凭空发明游标。
  assert.equal(historyCursorFor([{ role: 'user' }, { role: 'assistant' }], [{ index: 0 }]), null);
});

// The rail is user-resizable: the visual ellipsis belongs to CSS at the real
// available width, not to a fixed character count baked into the label.
test('outline labels are not hard-truncated at the old fixed width', () => {
  const long = '这是一个很长很长的提问'.repeat(10);
  const fromMessages = buildTurnNavItems([{ role: 'user', text: long, sourceIndex: 0 }]);
  assert.equal(fromMessages[0].label, long);
  assert.equal(fromMessages[0].text, long);

  const fromOutline = buildTurnNavItemsFromOutline([{ index: 0, label: long }]);
  assert.equal(fromOutline[0].label, long);
});

test('outline labels keep pathological prompts intact', () => {
  const huge = 'z'.repeat(540);
  const items = buildTurnNavItems([{ role: 'user', text: huge }]);
  assert.equal(items[0].label, huge);
  assert.equal(items[0].text, huge);
});

test('capped outline labels keep distinct long questions', () => {
  const capped = 'x'.repeat(119) + '…';
  const out = dedupeTurnOutline([
    { index: 0, text: capped },
    { index: 1, text: capped },
  ]);
  assert.equal(out.length, 2);

  // Full (uncapped) same-text questions with distinct indices are two real turns.
  const full = dedupeTurnOutline([
    { index: 0, text: 'same question' },
    { index: 1, text: 'same question' },
  ]);
  assert.equal(full.length, 2);
});

test('buildTurnNavItems keeps user questions in order and skips empty/system', () => {
  const items = buildTurnNavItems([
    { role: 'user', text: '你好 今天天气' },
    { role: 'assistant', text: '晴' },
    { role: 'system', text: 'notice' },
    { role: 'user', text: '' },
    { role: 'user', text: '第二问' },
  ]);
  assert.deepEqual(
    items.map((i) => ({ id: i.id, ordinal: i.ordinal, index: i.index, label: i.label, text: i.text, fullText: i.fullText })),
    [
      { id: 'turn-nav-0', ordinal: 0, index: 0, label: '你好 今天天气', text: '你好 今天天气', fullText: '你好 今天天气' },
      { id: 'turn-nav-4', ordinal: 1, index: 4, label: '第二问', text: '第二问', fullText: '第二问' },
    ],
  );
});

test('buildTurnNavItems preserves raw transcript indexes after display filtering', () => {
  const items = buildTurnNavItems([
    { role: 'assistant', text: '', sourceIndex: 80 },
    { role: 'user', text: '工具调用后的问题', sourceIndex: 87 },
  ], 80);
  assert.deepEqual(
    items.map((i) => ({ id: i.id, index: i.index })),
    [{ id: 'turn-nav-87', index: 87 }],
  );
});

test('buildTurnNavItems falls back to the history window offset', () => {
  const items = buildTurnNavItems([
    { role: 'assistant', text: '' },
    { role: 'user', text: '窗口内问题' },
  ], 40);
  assert.equal(items[0]?.index, 41);
});

test('turnNavScrollTop targets the chat container and clamps above its start', () => {
  assert.equal(turnNavScrollTop(600, 100, 240), 740);
  assert.equal(turnNavScrollTop(20, 100, 40), 0);
});

test('buildTurnNavItemsFromOutline uses absolute transcript indexes', () => {
  const items = buildTurnNavItemsFromOutline([
    { ordinal: 0, index: 0, label: '第一问' },
    { ordinal: 1, index: 25, label: '<system-reminder>internal</system-reminder>' },
    { ordinal: 2, index: 80, label: '很后面的提问' },
  ]);
  assert.deepEqual(
    items.map((i) => ({ id: i.id, index: i.index, label: i.label })),
    [
      { id: 'turn-nav-0', index: 0, label: '第一问' },
      { id: 'turn-nav-80', index: 80, label: '很后面的提问' },
    ],
  );
});

test('buildTurnNavItemsFromOutline strips steer envelope and keeps clean query', () => {
  const items = buildTurnNavItemsFromOutline([
    {
      ordinal: 0,
      index: 0,
      label: '<user-query>\n跨平台都只需要声音通知就可以\n</user-query>\n\n[jeikcode-steer]\nYou are currently in the middle of executing a task...',
    },
    {
      ordinal: 1,
      index: 1,
      label: '<user-query>不用引入播放器 直接调用系统原生的就可以了</user-query>\n\n[jeikcode-steer]\nnotes',
    },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, '跨平台都只需要声音通知就可以');
  assert.equal(items[0].text, '跨平台都只需要声音通知就可以');
  assert.equal(items[1].label, '不用引入播放器 直接调用系统原生的就可以了');
  assert.equal(items[1].text, '不用引入播放器 直接调用系统原生的就可以了');
});

test('buildTurnNavItems strips steer envelope from user messages', () => {
  const items = buildTurnNavItems([
    {
      role: 'user',
      text: '<user-query>\n我只需要响一声就行了\n</user-query>\n\n[jeikcode-steer]\nguidelines',
    },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, '我只需要响一声就行了');
  assert.equal(items[0].text, '我只需要响一声就行了');
});

test('outline ids do not shift when failed turns insert diagnostic rows', () => {
  const items = buildTurnNavItemsFromOutline([
    { ordinal: 4, index: 10, label: '第一次继续' },
    { ordinal: 5, index: 12, label: '第二次继续' },
    { ordinal: 6, index: 15, label: '服务恢复后继续' },
  ]);
  assert.deepEqual(
    items.map((i) => ({ id: i.id, ordinal: i.ordinal, index: i.index })),
    [
      { id: 'turn-nav-10', ordinal: 4, index: 10 },
      { id: 'turn-nav-12', ordinal: 5, index: 12 },
      { id: 'turn-nav-15', ordinal: 6, index: 15 },
    ],
  );
});

test('fullerOutline never lets a tail-window cache replace a complete rail', () => {
  const complete = Array.from({ length: 30 }, (_, i) => ({
    index: i * 10,
    label: `q${i}`,
    ordinal: i,
  }));
  const tail = complete.slice(-2);
  assert.equal(fullerOutline(tail, complete), complete);
  assert.equal(fullerOutline(complete, tail), complete);
  assert.deepEqual(fullerOutline([], complete), complete);
  assert.deepEqual(fullerOutline(complete, []), complete);
});

test('outline and message fallback agree on the anchor id for the same absolute index', () => {
  // 右栏大纲与画布必须用同一套身份：绝对转录下标。否则分页加载后同一个
  // “窗口内序号”会指向不同提问（或产生重复 DOM id），跳转/高亮就会错位。
  const fromOutline = buildTurnNavItemsFromOutline([{ ordinal: 7, index: 42, label: '同一问' }]);
  const fromMessages = buildTurnNavItems([
    { role: 'user', text: '同一问', sourceIndex: 42, turnNavOrdinal: 0 },
  ]);
  assert.equal(fromOutline[0]?.id, 'turn-nav-42');
  assert.equal(fromMessages[0]?.id, fromOutline[0]?.id);
});

test('paged windows never collide: same window ordinal, different absolute index', () => {
  // 旧实现把“窗口内 ordinal”当 DOM id，第二页从 0 重新计数就会与首屏重复。
  const tailPage = buildTurnNavItems([
    { role: 'user', text: '首屏提问 A', sourceIndex: 60, turnNavOrdinal: 0 },
    { role: 'user', text: '首屏提问 B', sourceIndex: 70, turnNavOrdinal: 1 },
  ]);
  const olderPage = buildTurnNavItems(
    [
      { role: 'user', text: '更早提问 X', turnNavOrdinal: 0 },
      { role: 'user', text: '更早提问 Y', turnNavOrdinal: 1 },
    ],
    10,
  );
  const ids = [...olderPage, ...tailPage].map((item) => item.id);
  assert.deepEqual(ids, ['turn-nav-10', 'turn-nav-11', 'turn-nav-60', 'turn-nav-70']);
  assert.equal(new Set(ids).size, ids.length, 'anchor ids must stay unique across pages');
});

test('filterTurnNavItems matches the full question text', () => {
  const items = buildTurnNavItems([
    { role: 'user', text: '请根据用户需求配置 MCP 服务器' },
    { role: 'user', text: '现在搜索试一下' },
  ]);
  const hit = filterTurnNavItems(items, 'mcp');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].index, 0);
  assert.deepEqual(filterTurnNavItems(items, '没有这句'), []);
  assert.equal(filterTurnNavItems(items, '  ').length, 2);
});

test('resolveActiveTurnId is monotonic and pins the last item at the bottom', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const tops: Record<string, number> = { a: 0, b: 400, c: 800 };
  const topOf = (id: string) => tops[id];
  const metrics = (scrollTop: number) => ({
    scrollTop,
    clientHeight: 400,
    scrollHeight: 1200,
  });

  assert.equal(resolveActiveTurnId(items, topOf, metrics(0)), 'a');
  assert.equal(resolveActiveTurnId(items, topOf, metrics(390)), 'b');
  // Near the bottom of the thread: last question, even if the marker sits on a neighbour.
  assert.equal(resolveActiveTurnId(items, topOf, metrics(780)), 'c');
  assert.equal(resolveActiveTurnId(items, topOf, metrics(800)), 'c');
});

test('resolveActiveTurnId does not skip a short question just below the marker', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const tops: Record<string, number> = { a: 8, b: 80 };
  const topOf = (id: string) => tops[id];
  // Clicking A scrolls it to the top; a 24px marker must not jump to B at 80px.
  assert.equal(
    resolveActiveTurnId(items, topOf, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 }),
    'a',
  );
});

test('hasOlderVisibleMessages and visibleOlderRemainingCount exclude invisible system prefix', () => {
  // 场景：首个用户提问在 index=8，前 8 条（0..7）为不可见 System/synthetic 指令
  const firstTurnIndex = 8;

  // 1. 冷启动打开时 offset=745 (远大于 8)
  assert.equal(hasOlderVisibleMessages({ offset: 745, firstTurnIndex }), true);
  assert.equal(visibleOlderRemainingCount(745, firstTurnIndex), 737);

  // 2. 点击第二问 (index=32)，offset=32，上面还包含第一问
  assert.equal(hasOlderVisibleMessages({ offset: 32, firstTurnIndex }), true);
  assert.equal(visibleOlderRemainingCount(32, firstTurnIndex), 24);

  // 3. 点击第一问 (index=8)，offset=8，上面全为系统指令，无任何可见消息
  assert.equal(hasOlderVisibleMessages({ offset: 8, firstTurnIndex }), false);
  assert.equal(visibleOlderRemainingCount(8, firstTurnIndex), 0);

  // 4. 画布已包含首个提问（canvasHasFirstTurn: true）时，绝不渲染气泡
  assert.equal(hasOlderVisibleMessages({ offset: 32, firstTurnIndex, canvasHasFirstTurn: true }), false);

  // 5. 新建会话（offset=0）
  assert.equal(hasOlderVisibleMessages({ offset: 0, firstTurnIndex }), false);
  assert.equal(visibleOlderRemainingCount(0, firstTurnIndex), 0);
});

test('remainingUnloadedTurns counts questions, not raw tool rows', () => {
  const turns = [{ index: 8 }, { index: 40 }, { index: 120 }];
  const messages = [
    { role: 'user', sourceIndex: 8 },
    { role: 'assistant', sourceIndex: 9 },
    { role: 'user', sourceIndex: 40 },
    { role: 'assistant', sourceIndex: 41 },
  ];
  assert.equal(remainingUnloadedTurns(turns, messages), 1);
  assert.equal(remainingUnloadedTurns([], messages), 0);
});

test('buildTurnNavItemsFromOutline keeps pending input rows with their seq', () => {
  const items = buildTurnNavItemsFromOutline([
    { index: 10, id: 'i-1', label: '中途转向', pending: true, seq: 7 },
    { index: 11, id: 'm-1', label: '已落盘提问' },
  ]);
  assert.equal(items[0]?.pending, true);
  assert.equal(items[0]?.seq, 7);
  assert.equal(items[1]?.pending, undefined);
});

test('dedupeTurnOutline never merges two different ids that share a provisional index', () => {
  // A provisional/outline index is a coordinate, not an identity. Two real
  // questions can collide on an index while a page is being reconciled.
  const out = dedupeTurnOutline([
    { index: 69, id: 'u-provisional', label: '最新提问' },
    { index: 69, id: 'u-old', label: '第 69 行的旧提问' },
  ]);
  assert.equal(out.length, 2, 'different ids are different questions even at the same index');
  assert.deepEqual(out.map((t) => t.id).sort(), ['u-old', 'u-provisional']);
});

test('dedupeTurnOutline folds the same id even when provisional and flushed indexes differ', () => {
  const out = dedupeTurnOutline([
    { index: 69, id: 'u-1', label: '最新提问' },
    { index: 1857, id: 'u-1', label: '最新提问（完整版）' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, 'u-1');
  assert.ok(out[0]?.label.includes('完整版'), 'the richer label wins');
});

test('dedupeTurnOutline folds duplicate ids and keeps the richer label', () => {
  const dirtyTurns = [
    { id: 'q1', ordinal: 42, index: 1179, label: '现在还有个问题 就是点击会话的时候 会话比较长的时候速度很慢' },
    { id: 'q2', ordinal: 43, index: 1198, label: '<user-query> 要对比延迟数据测试方案对比 看看怎' },
    { id: 'q3', ordinal: 44, index: 1211, label: '<user-query> 直接找几个大历史列表的sessio' },
    { id: 'q1', ordinal: 45, index: 1217, label: '现在还有个问题 就是点击会话的时候 会话比较长的时候速度很慢' },
    { id: 'q2', ordinal: 46, index: 1218, label: '要对比延迟数据测试方案对比 看看怎么保证我们状态一致性的情况' },
    { id: 'q3', ordinal: 47, index: 1220, label: '直接找几个大历史列表的session之间的来回切换 对照试验' },
  ];

  const deduped = dedupeTurnOutline(dirtyTurns);
  assert.equal(deduped.length, 3, '同一 id 必须去重，由 6 条变为 3 条');
  assert.equal(deduped[0].index, 1179);
  assert.equal(deduped[1].index, 1198);
  assert.equal(deduped[2].index, 1211);
  assert.ok(deduped[1].label.includes('状态一致性'), '被截断的 steer 提问应自动升级为完整文本');
});

test('mergeServerWithLocalOutline 保护在途/尚未落盘的最新用户提问不被覆盖丢失', () => {
  const server = [
    { index: 0, label: '第一问' },
    { index: 15, label: '第二问' },
  ];
  const local = [
    { index: 0, label: '第一问' },
    { index: 15, label: '第二问' },
    // 正在运行、尚未写入磁盘的最新提问
    { index: 32, label: '你重启了网关jeikclaw吗' },
  ];
  const merged = mergeServerWithLocalOutline(server, local);
  assert.equal(merged.length, 3, '最新提问必须保留');
  assert.equal(merged[2]?.label, '你重启了网关jeikclaw吗');
  assert.equal(merged[2]?.index, 32);
});

test('mergeServerWithLocalOutline 按 id 合并错位下标，避免同一提问双写', () => {
  // 运行中服务端注入的临时大纲下标可能还没对齐；只要 id 相同就是同一条。
  const server = [{ index: 81, id: 'u-1', label: '第一问' }];
  const local = [{ index: 82, id: 'u-1', label: '第一问' }];
  const merged = mergeServerWithLocalOutline(server, local);
  assert.equal(merged.length, 1, '同一 id 不得因为 index 不同而保留两份');
  assert.equal(merged[0]?.index, 81, '保留服务端的权威下标');
});

test('mergeServerWithLocalOutline 不把同文案的不同 id 误并', () => {
  const server = [{ index: 81, id: 'u-1', label: '继续' }];
  const local = [{ index: 90, id: 'u-2', label: '继续' }];
  const merged = mergeServerWithLocalOutline(server, local);
  assert.equal(merged.length, 2, '两次真实的「继续」是两个提问');
});

test('removeOutlineRowsById drops a cancelled steer but keeps other questions', () => {
  const turns = [
    { index: 0, id: 'u-1', label: 'main' },
    { index: 1, id: 'steer-cancelled', label: 'cancelled steer' },
    { index: 2, id: 'u-2', label: 'next' },
  ];
  const out = removeOutlineRowsById(turns, new Set(['steer-cancelled']));
  assert.deepEqual(out.map((turn) => turn.id), ['u-1', 'u-2']);
  assert.equal(removeOutlineRowsById(turns, new Set()), turns, 'no ids is a no-op');
});

test('mergeServerWithLocalOutline preserves a provisional steer when its index collides', () => {
  const server = [
    { index: 42, id: 'older-question', label: '较早的问题' },
    { index: 80, id: 'latest-question', label: '较新的问题' },
  ];
  const steer = {
    index: 42,
    id: 'steer-1',
    label: '转向后的用户消息',
    provisional: true,
  };
  const merged = mergeServerWithLocalOutline(server, [...server, steer]);
  assert.equal(merged.length, 3);
  assert.ok(merged.some((turn) => turn.id === 'steer-1'));
});

test('a server row with the same id supersedes the provisional local outline', () => {
  const server = [{ index: 84, id: 'steer-1', label: '转向后的用户消息' }];
  const local = [{
    index: 42,
    id: 'steer-1',
    label: '转向后的用户消息',
    provisional: true,
  }];
  const merged = mergeServerWithLocalOutline(server, local);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.index, 84);
  assert.equal(merged[0]?.provisional, undefined);
});

test('刷新后本地大纲为空时，服务端 pending steer 仍必须保留', () => {
  // /sessions 会把 durable admitted/promoted steer 作为 pending 大纲行返回；
  // 缓存丢失/版本变化时，冷启动绝不能把它整份替换掉。
  const server = [
    { index: 10, id: 'u-open', label: '主提问' },
    { index: 12, id: 'steer-1', label: '中途转向', pending: true, seq: 7 },
  ];
  const merged = mergeServerWithLocalOutline(server, []);
  assert.equal(merged.length, 2);
  assert.equal(merged[1]?.id, 'steer-1');
  assert.equal(merged[1]?.pending, true);
  assert.equal(merged[1]?.index, 12);
});

test('画布已到会开头：offset 仍声称有更早时也不得留下“向上展开”幽灵入口', () => {
  // 同步异常后画布被回灌了全量历史：首行 seq 就是会话最小 seq。
  // 此时分页只会返回重复行（合并不增长），入口必须收起。
  assert.equal(canvasAtVeryBeginning({ offset: 0 }), true);
  assert.equal(canvasAtVeryBeginning({ offset: 658, canvasHeadSeq: 1, pageHeadSeq: 602 }), true);
  assert.equal(canvasAtVeryBeginning({ offset: 658, canvasHeadSeq: 1, firstTurnSeq: 1 }), true);
  // 画布真的缺更早历史时，入口必须保留
  assert.equal(canvasAtVeryBeginning({ offset: 658, canvasHeadSeq: 651, pageHeadSeq: 602 }), false);
  assert.equal(canvasAtVeryBeginning({ offset: 658 }), false, '没有身份时不做猜测');
});
