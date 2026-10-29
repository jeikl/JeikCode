import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildTurnNavItems,
  buildTurnNavItemsFromOutline,
  canvasHistoryHead,
  dedupeTurnOutline,
  filterTurnNavItems,
  hasOlderVisibleMessages,
  historyCursorFor,
  remainingUnloadedTurns,
  resolveActiveTurnId,
  turnNavId,
  turnNavScrollTop,
  visibleOlderRemainingCount,
} from './turnNav.ts';

test('turnNavId is stable per user-turn ordinal', () => {
  assert.equal(turnNavId(3), 'turn-nav-3');
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

  // Full (uncapped) duplicates still fold as before.
  const full = dedupeTurnOutline([
    { index: 0, text: 'same question' },
    { index: 1, text: 'same question' },
  ]);
  assert.equal(full.length, 1);
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

test('dedupeTurnOutline cleans duplicate trailing questions from optimistic echo races', () => {
  // 真实复现截图中的大纲末尾重复条目：
  const dirtyTurns = [
    { ordinal: 42, index: 1179, text: '现在还有个问题 就是点击会话的时候 会话比较长的时候速度很慢' },
    { ordinal: 43, index: 1198, text: '<user-query> 要对比延迟数据测试方案对比 看看怎' },
    { ordinal: 44, index: 1211, text: '<user-query> 直接找几个大历史列表的sessio' },
    { ordinal: 45, index: 1217, text: '现在还有个问题 就是点击会话的时候 会话比较长的时候速度很慢' },
    { ordinal: 46, index: 1218, text: '要对比延迟数据测试方案对比 看看怎么保证我们状态一致性的情况' },
    { ordinal: 47, index: 1220, text: '直接找几个大历史列表的session之间的来回切换 对照试验' },
  ];

  const deduped = dedupeTurnOutline(dirtyTurns);
  assert.equal(deduped.length, 3, '重复条目必须被彻底去重，由 6 条变为 3 条');
  assert.equal(deduped[0].index, 1179);
  assert.equal(deduped[1].index, 1198);
  assert.equal(deduped[2].index, 1211);
  assert.ok(deduped[1].text.includes('状态一致性'), '被截断的 steer 提问应自动升级为完整文本');
});
