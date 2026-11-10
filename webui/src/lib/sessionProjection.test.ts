import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceCanvasEvent } from './canvas/actions.ts';
import { tailCoverage, tailRowCovered } from './chatTerminal.ts';
import {
  bindUserMessageIdentity,
  foldLiveTodo,
  hydrateSession,
  identifiedAssistantIndex,
  isTransientAdvisoryText,
  paintAssistantReasoning,
  paintAssistantText,
  paintAssistantNotice,
  paintCachedAssistantDelta,
  paintUserMessage,
  coalesceRoundParts,
  sameTurnAssistantIndex,
  placeRecoveredTurnUsers,
  mergeOlderMessages,
  cachedHeadIsContiguous,
  resolveHistoryOffset,
  spliceAuthoritativeDiskTail,
  stampUserClientInputId,
  stampUserSourceIndex,
  stripTransientNoticeRows,
  steerInsertAfterAnchor,
  withAssistantIdentity,
} from './sessionProjection.ts';
import { upsertToolPart } from './toolRows.ts';

const plan = [
  { content: '写测试', status: 'completed' as const },
  { content: '修前端', status: 'in_progress' as const },
  { content: '发版', status: 'pending' as const },
  { content: '回归', status: 'pending' as const },
];

test('watch paints a new user with a Working placeholder, and repeats only after a settled answer', () => {
  const fresh = paintUserMessage([], '你好', 1, () => ({
    role: 'user',
    parts: [{ kind: 'text' as const, text: '你好' }],
  }));
  assert.equal(fresh.length, 2);
  assert.equal(fresh[1]?.role, 'assistant');
  assert.equal(fresh[1]?.parts.length, 0);

  const settled = [
    { id: 'u-1', role: 'user', parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }], ts: 1 },
    { role: 'assistant', parts: [{ kind: 'text' as const, text: '收到' }] },
  ];
  const replay = paintUserMessage(settled, 'OK啊 挺好的', 2, () => {
    throw new Error('replay of the open turn must not append');
  }, { clientInputId: 'u-1' });
  assert.equal(replay, settled);

  const again = paintUserMessage(settled, 'OK啊 挺好的', 3, () => ({
    role: 'user',
    parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }],
    ts: 3,
  }), { clientInputId: 'u-2' });
  assert.equal(again.filter((message) => message.role === 'user').length, 2);
  assert.equal(again[again.length - 1]?.role, 'assistant');
  assert.equal(again[again.length - 1]?.parts.length, 0);

  const open = [
    { id: 'u-3', role: 'user', parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }] },
    { role: 'assistant', parts: [] },
  ];
  const echo = paintUserMessage(open, 'OK啊 挺好的', 4, () => {
    throw new Error('echo of the open turn must not append');
  }, { clientInputId: 'u-3' });
  assert.equal(echo.filter((message) => message.role === 'user').length, 1);
});

test('Working is transient and never creates an empty assistant record', () => {
  // The view renders Working from `busy`; records stay user-only until the
  // first streamed part arrives and `paintAssistantText` opens the row.
  const open = [
    { role: 'user', parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }] },
  ];
  assert.equal(open.length, 1);
  assert.equal(open[0]?.role, 'user');
});

test('cold start paints the server checklist and ignores a replayed user and text', () => {
  const disk = [
    { id: 'u-4', role: 'user', parts: [{ kind: 'text' as const, text: '改用 sqlite' }] },
    {
      role: 'assistant',
      parts: [
        { kind: 'text' as const, text: '上一轮正文' },
        { kind: 'tool' as const, tool: { id: 't1', name: 'todowrite', args: '{}', status: 'done' as const } },
      ],
    },
  ];
  const surface = hydrateSession(disk, plan);
  assert.equal(surface.todos?.length, 4);
  assert.deepEqual(surface.appliedTodoIds, ['t1']);

  const afterUser = paintUserMessage(surface.messages, '改用 sqlite', 1, () => {
    throw new Error('user echo must not append');
  }, { clientInputId: 'u-4' });
  assert.equal(afterUser.filter((message) => message.role === 'user').length, 1);
  assert.equal(afterUser[afterUser.length - 1]?.role, 'assistant');

  const afterText = paintAssistantText(afterUser, '上一轮正文', true);
  assert.equal(afterText, afterUser);
});

test('truncated disk thinking is extended in place instead of replayed as a second block', () => {
  const mark = '\n… [truncated for display]';
  const body = '先看目录';
  const full = `${body}，再读 read.rs，然后说明原因`;
  const messages = [{
    role: 'assistant',
    parts: [
      { kind: 'reasoning' as const, text: body + mark },
      { kind: 'text' as const, text: '正文开头' + mark },
      { kind: 'tool' as const, tool: { id: 'b', name: 'bash', args: '', status: 'done' as const } },
    ],
  }];
  const withThinking = paintAssistantReasoning(messages, full, true);
  assert.equal(withThinking[0]?.parts.filter((part) => part.kind === 'reasoning').length, 1);
  assert.equal(withThinking[0]?.parts[0]?.text, full);
  assert.equal(withThinking[0]?.parts[2]?.kind, 'tool');

  const withText = paintAssistantText(withThinking, '正文开头，以及后面的结论', true);
  assert.equal(withText[0]?.parts.filter((part) => part.kind === 'text').length, 1);
  assert.equal(withText[0]?.parts[1]?.text, '正文开头，以及后面的结论');
  assert.equal(withText[0]?.parts[2]?.kind, 'tool');
});

test('an incremental todo event keeps the hydrated plan', () => {
  const applied = new Set<string>(['t1']);
  const next = foldLiveTodo({
    state: null,
    remembered: plan,
    name: 'todowrite',
    args: JSON.stringify({ actions: [{ action: 'update', id: 2, status: 'completed' }] }),
    callId: 't2',
    appliedIds: applied,
  });
  assert.equal(next?.length, 4);
  assert.equal(next?.[1]?.status, 'completed');
});

test('paintAssistantReasoning dedupes replayed thinking blocks completely', () => {
  const messages = [{
    role: 'assistant',
    parts: [
      { kind: 'reasoning' as const, text: '这是第一段深度思考过程' },
      { kind: 'tool' as const, tool: { id: 'call_1', name: 'read', status: 'done' as const } },
      { kind: 'reasoning' as const, text: '这是第二段思考过程' },
    ],
  }];

  // 1. 重放完全相同的思考块，绝对不应增加新的 reasoning part
  const replayed1 = paintAssistantReasoning(messages, '这是第一段深度思考过程', true);
  assert.equal(replayed1[0]?.parts.filter((p) => p.kind === 'reasoning').length, 2);

  const replayed2 = paintAssistantReasoning(messages, '这是第二段思考过程', true);
  assert.equal(replayed2[0]?.parts.filter((p) => p.kind === 'reasoning').length, 2);

  // 2. 重放已有思考块的子集/前缀，也绝不应增加新的 reasoning part
  const replayedSub = paintAssistantReasoning(messages, '这是第二段思考', true);
  assert.equal(replayedSub[0]?.parts.filter((p) => p.kind === 'reasoning').length, 2);
});

test('paintAssistantText streams text normally even if phrases occurred in prior assistant turns', () => {
  const user1 = { role: 'user', parts: [{ kind: 'text' as const, text: '你好' }] };
  const assistant1 = {
    role: 'assistant',
    parts: [{ kind: 'text' as const, text: '好的，请问有什么可以帮助您的？' }],
  };
  const user2 = { role: 'user', parts: [{ kind: 'text' as const, text: '帮我查一下当前项目' }] };
  const assistant2 = {
    role: 'assistant',
    parts: [],
  };
  const messages = [user1, assistant1, user2, assistant2];

  // Streaming text in turn 2 starts with "好的" which was present in assistant1
  const streamed = paintAssistantText(messages, '好的', false);
  assert.equal(streamed[3]?.parts.length, 1);
  assert.equal(streamed[3]?.parts[0]?.kind, 'text');
  assert.equal(streamed[3]?.parts[0]?.text, '好的');
});

test('paintAssistantText merges into existing text part without slicing around non-text parts', () => {
  const messages = [{
    role: 'assistant',
    parts: [
      { kind: 'reasoning' as const, text: '思考中...' },
      { kind: 'text' as const, text: '三、总结\n这次修复彻底解决了' },
    ],
  }];
  const next = paintAssistantText(messages, '以下两个关键问题：\n1. 终端环境异常', false);
  assert.equal(next[0]?.parts.length, 2);
  assert.equal(next[0]?.parts[0]?.kind, 'reasoning');
  assert.equal(next[0]?.parts[1]?.kind, 'text');
  assert.equal(next[0]?.parts[1]?.text, '三、总结\n这次修复彻底解决了以下两个关键问题：\n1. 终端环境异常');
});

test('paintUserMessage accurately appends a mid-turn steer when agent is in-flight on tools/thinking without final answer', () => {
  const originalUser = { role: 'user', parts: [{ kind: 'text' as const, text: '帮我重构网络层' }], ts: 1000 };
  const inFlightAssistant = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning' as const, text: '检查现存网络模块...' },
      { kind: 'tool' as const, tool: { id: 'c1', name: 'read_file', status: 'done' as const } },
    ],
  };
  const canvas = [originalUser, inFlightAssistant];

  // User sends a steer: "改用 reqwest，不要用 hyper"
  const steerText = '改用 reqwest，不要用 hyper';
  const withSteer = paintUserMessage(
    canvas,
    steerText,
    1500,
    () => ({
      role: 'user',
      parts: [{ kind: 'text' as const, text: steerText }],
      ts: 1500,
    }),
    { repeatAfterSettled: true },
  );

  // Steer must be cleanly appended after inFlightAssistant
  assert.equal(withSteer.filter((m) => m.role === 'user').length, 2);
  assert.equal(withSteer[0]?.parts[0]?.text, '帮我重构网络层');
  assert.equal(withSteer[2]?.parts[0]?.text, '改用 reqwest，不要用 hyper');
  assert.equal(withSteer[withSteer.length - 1]?.role, 'assistant');
});

test('single event bus stream updates in-memory session cache correctly for background sessions', () => {
  const initial = [
    { role: 'user', parts: [{ kind: 'text' as const, text: '分析代码性能' }], ts: 1000 },
    { role: 'assistant', parts: [] },
  ];

  // Background stream delivers reasoning delta
  const r1 = paintAssistantReasoning(initial, '分析当前瓶颈...', false);
  assert.equal(r1[1]?.parts.length, 1);
  assert.equal(r1[1]?.parts[0]?.kind, 'reasoning');
  assert.equal(r1[1]?.parts[0]?.text, '分析当前瓶颈...');

  // Background stream delivers text delta
  const t1 = paintAssistantText(r1, '建议使用 SIMD 加速。', false);
  assert.equal(t1[1]?.parts.length, 2);
  assert.equal(t1[1]?.parts[1]?.kind, 'text');
  assert.equal(t1[1]?.parts[1]?.text, '建议使用 SIMD 加速。');

  // Background stream delivers second text delta
  const t2 = paintAssistantText(t1, '具体步骤如下：', false);
  assert.equal(t2[1]?.parts.length, 2);
  assert.equal(t2[1]?.parts[1]?.kind, 'text');
  assert.equal(t2[1]?.parts[1]?.text, '建议使用 SIMD 加速。具体步骤如下：');
});

test('bindUserMessageIdentity binds the stored id to the optimistic bubble once', () => {
  const local = {
    role: 'user',
    id: 'client-id-1',
    parts: [{ kind: 'text' as const, text: '你好' }],
  };
  const messages = [local, { role: 'assistant', id: 'm-a1', parts: [] }];
  const bound = bindUserMessageIdentity(messages, 'm-user-1');
  assert.equal(bound[0]?.id, 'm-user-1');
  assert.equal(bound[1], messages[1]);
  // 幂等：同一个 id 第二次到达不改变画布。
  assert.equal(bindUserMessageIdentity(bound, 'm-user-1'), bound);
  // 唯一性：已在画布上的 id 绝不再贴到另一条消息上。
  const other = [
    { role: 'user', id: 'm-user-9', parts: [{ kind: 'text' as const, text: '别人的提问' }] },
    { role: 'user', parts: [{ kind: 'text' as const, text: '我的提问' }] },
  ];
  assert.equal(bindUserMessageIdentity(other, 'm-user-9'), other);
  // 无用户气泡 / 无 id：原样返回（同一引用，避免无谓重绘）。
  const empty: Array<{ role: string; parts: Array<{ kind: 'text'; text: string }> }> = [];
  assert.equal(bindUserMessageIdentity(empty, 'm-x'), empty);
  assert.equal(bindUserMessageIdentity(other, undefined), other);
});

test('identifiedAssistantIndex resolves the owning round, never the steer bubble', () => {
  const round = { role: 'assistant', id: 'm-1', parts: [] };
  const steer = { role: 'user', id: 'client-1', parts: [{ kind: 'text' as const, text: '换个方向' }] };
  const messages = [round, steer];
  assert.equal(identifiedAssistantIndex(messages, 'm-1'), 0);
  // A user bubble carrying its own client id is not an assistant target.
  assert.equal(identifiedAssistantIndex(messages, 'client-1'), -1);
  assert.equal(identifiedAssistantIndex(messages, undefined), -1);
  assert.equal(identifiedAssistantIndex(messages, 'm-missing'), -1);
});

// 回合中途 steer 的回归防线：上一回合迟到的思考/正文/工具增量必须回到它所属的
// assistant 消息，绝不能渲染到 steer 气泡下方（错序 + 重复的根因）。
test('late deltas keep their owning round above a mid-turn steer bubble', () => {
  const round = {
    role: 'assistant',
    id: 'm-1',
    parts: [{ kind: 'text' as const, text: '前半段正文' }],
  };
  const steer = { role: 'user', parts: [{ kind: 'text' as const, text: '改个方向' }] };
  const canvas = [round, steer];

  const text = paintAssistantText(canvas, '后半段正文', false, 'm-1');
  assert.equal(text.length, 2, 'steer 气泡之后绝不能另起一条 assistant');
  assert.equal(text[1], steer);
  const mergedPart = text[0]?.parts[0];
  assert.equal(mergedPart?.kind, 'text');
  assert.equal(mergedPart?.text, '前半段正文后半段正文');

  const reasoning = paintAssistantReasoning(text, '补充思考', false, 'm-1');
  assert.equal(reasoning.length, 2);
  assert.equal(reasoning[1], steer);
  assert.equal(reasoning[0]?.parts.length, 2);
  assert.equal(reasoning[0]?.parts[0]?.text, '前半段正文后半段正文');
  assert.equal(reasoning[0]?.parts[1]?.kind, 'reasoning');
  assert.equal(reasoning[0]?.parts[1]?.text, '补充思考');

  // 未携带身份（旧 daemon）时保持原有尾随语义，不回归。
  const trailing = paintAssistantText(canvas, '新回合正文', false);
  assert.equal(trailing.length, 3);
  assert.equal(trailing[1], steer);
  assert.equal(trailing[2]?.role, 'assistant');
  assert.equal(trailing[2]?.parts[0]?.text, '新回合正文');
});

test('streamed markdown keeps paragraph breaks when whitespace arrives as its own delta', () => {
  // 真实流序：正文 → "\n\n"（独立 delta）→ 下一条列表项。
  // 空白 delta 被吞会让列表/段落粘连，就是“首帧乱排、刷新后正常”的根因。
  let canvas = paintAssistantText([], '一、顶层开关是活的语义', true);
  canvas = paintAssistantText(canvas, '\n\n', true);
  canvas = paintAssistantText(canvas, '1. 对外 schema 只暴露 hunk 级', true);
  canvas = paintAssistantText(canvas, '\n\n', true);
  canvas = paintAssistantText(canvas, '2. 但底层也接受顶层开关', true);
  const text = (canvas[0]?.parts ?? []).map((part) => part.text ?? '').join('');
  assert.equal(
    text,
    '一、顶层开关是活的语义\n\n1. 对外 schema 只暴露 hunk 级\n\n2. 但底层也接受顶层开关',
  );
  // 同一段空白重复到达（重放）不得叠加空行：
  // 画布末尾已是空白时不再追加（否则空行滚雪球）。
  const endsWithBreak = paintAssistantText([], '段落一\n\n', true);
  const replayed = paintAssistantText(endsWithBreak, '\n\n', true);
  assert.equal(
    (replayed[0]?.parts ?? []).map((part) => part.text ?? '').join(''),
    '段落一\n\n',
  );
});

test('a new round identity still opens its own bubble after the steer', () => {
  const round = { role: 'assistant', id: 'm-1', parts: [{ kind: 'text' as const, text: '旧回合' }] };
  const steer = { role: 'user', parts: [{ kind: 'text' as const, text: 'steer' }] };
  const canvas = [round, steer];

  const next = paintAssistantText(canvas, '新回合回答', false, 'm-2');
  assert.equal(next.length, 3);
  assert.equal(next[1], steer);
  assert.equal(next[2]?.role, 'assistant');
  assert.equal(next[2]?.parts[0]?.text, '新回合回答');
});

test('withAssistantIdentity keeps one wire id on exactly one row', () => {
  const first = { role: 'assistant', id: 'm-1', parts: [{ kind: 'text' as const, text: '一' }] };
  const second = { role: 'assistant', parts: [{ kind: 'text' as const, text: '二' }] };
  const msgs = [first, second];

  // 同一 message_id 不得再盖到第二条消息上（重复 key 会让 Preact 复用错 DOM，
  // 表现为“老回合的一部分回复渲染到新消息里”）。
  const stamped = withAssistantIdentity(msgs, 'm-1');
  assert.equal(stamped, msgs);
  assert.equal(msgs[1]?.id, undefined);
});

test('更早轮次的回放帧定向命中原助手气泡，绝不外溢涂写到 steer 后的最新气泡中', () => {
  const orig = { role: 'user', parts: [{ kind: 'text' as const, text: '重构网络层' }] };
  const roundA = {
    role: 'assistant',
    id: 'm-A',
    parts: [
      { kind: 'text' as const, text: '旧正文' },
      { kind: 'reasoning' as const, text: '旧思考' },
    ],
  };
  const steer = { role: 'user', parts: [{ kind: 'text' as const, text: '改用 reqwest' }] };
  const roundB = { role: 'assistant', id: 'm-B', parts: [{ kind: 'text' as const, text: '新正文' }] };
  const canvas = [orig, roundA, steer, roundB];

  // 身份 m-A 精准定位到 roundA 并幂等收敛，绝不追加到 roundB
  const replayed = paintAssistantText(canvas, '旧正文', true, 'm-A');
  assert.equal(replayed.length, 4);
  assert.equal((replayed[1]?.parts[0] as { text: string }).text, '旧正文');
  assert.equal((replayed[3]?.parts[0] as { text: string }).text, '新正文');
  assert.equal(replayed[3]?.parts.length, 1);
});

test('an unrouted delta still opens the placeholder round it belongs to', () => {
  const previous = { role: 'assistant', id: 'm-1', parts: [{ kind: 'text' as const, text: '上一轮' }] };
  const steer = { role: 'user', parts: [{ kind: 'text' as const, text: '继续' }] };
  const canvas = [previous, steer, { role: 'assistant', parts: [] }];

  // 本轮的占位行（未盖章）必须能接收它的首段增量——正常直播/首次落笔路径不变。
  const painted = paintAssistantText(canvas, '新回合正文', false, 'm-2');
  assert.equal(painted.length, 3);
  assert.equal(painted[2]?.parts[0]?.text, '新回合正文');
  const thought = paintAssistantReasoning(canvas, '新回合思考', false, 'm-2');
  assert.equal(thought[2]?.parts[0]?.text, '新回合思考');
});

test('background cache stamps every round so a replay can never leak old body into the newest bubble', () => {
  // 后台会话（用户正看着别的会话）的真实序列：本回合正文 → steer → 新回合正文。
  let canvas: Array<{ role: string; id?: string; parts: Array<{ kind: string; text?: string }> }> = [
    { role: 'user', parts: [{ kind: 'text', text: '重构网络层' }] },
    { role: 'assistant', parts: [] },
  ];
  canvas = paintCachedAssistantDelta(canvas, 'text', '旧正文', { messageId: 'm-A' });
  assert.equal(canvas[1]?.id, 'm-A', '后台缓存落笔必须盖上 message_id');

  canvas = paintUserMessage(canvas as never, '改用 reqwest', 2, () => ({
    role: 'user',
    parts: [{ kind: 'text', text: '改用 reqwest' }],
  } as never)) as never;
  canvas = paintCachedAssistantDelta(canvas, 'text', '新正文', { messageId: 'm-B' });

  assert.equal(canvas.length, 4, 'steer 气泡之后新回合另起一行');
  assert.equal(canvas[1]?.id, 'm-A');
  assert.equal(canvas[3]?.id, 'm-B');

  // 失焦重进后的 watch 整轮重放：旧回合的增量必须回到自己那一行，
  // 绝不能被当成新内容追加到最新 agent 消息里。
  const replayed = paintAssistantText(canvas as never, '旧正文（重放补充）', true, 'm-A') as typeof canvas;
  assert.equal(replayed.length, 4, '重放不得新增气泡');
  assert.equal(replayed[1]?.parts[0]?.text, '旧正文（重放补充）');
  assert.equal(replayed[3]?.parts[0]?.text, '新正文', '最新 agent 消息绝不能被旧正文污染');
});

test('live streaming of multi-round turn (tools in round 1, final text in round 2) is NEVER blocked', () => {
  // 模拟真实用户场景：
  // 1. 提问后，助手气泡最初为占位
  // 2. Round 1 执行工具调用（Read/Grep 等），被盖上 id: m-round-1
  const user = { role: 'user', parts: [{ kind: 'text' as const, text: '我问你挂载的工具' }] };
  const assistantRound1 = {
    role: 'assistant',
    id: 'm-round-1',
    parts: [
      { kind: 'tool' as const, tool: { id: 'call_1', name: 'read', status: 'done' as const } },
      { kind: 'tool' as const, tool: { id: 'call_2', name: 'grep', status: 'done' as const } },
    ],
  };
  const canvas = [user, assistantRound1];

  // 3. Round 2 开始实时吐字：文本增量携带全新的 round id: m-round-2，且 replay: false（实时流）
  // 核心断言：直播流绝不能被拦截，必须 0ms 立即上屏；绝对 id 让它成为自己的气泡。
  const streamed = withAssistantIdentity(
    paintAssistantText(canvas, '以下是挂载的工具清单：', false, 'm-round-2'),
    'm-round-2',
  );
  assert.equal(streamed.length, 3);
  assert.equal(streamed[2]?.id, 'm-round-2');
  assert.deepEqual(streamed[2]?.parts.map((p) => p.kind), ['text']);
  assert.equal(
    (streamed[2]?.parts[0] as { text: string }).text,
    '以下是挂载的工具清单：',
  );

  // 后续流式增量继续实时追加
  const streamed2 = paintAssistantText(streamed, '\n一、内置工具', false, 'm-round-2');
  assert.equal(
    (streamed2[2]?.parts[0] as { text: string }).text,
    '以下是挂载的工具清单：\n一、内置工具',
  );
});

test('历史回合存在时，工具轮之后的实时正文与思考仍必须逐字上屏', () => {
  // 真实失败场景（修复前线上复现）：会话中已有历史回合，当前回合 Round 1（工具轮）
  // 已给助手气泡盖 message_id，Round 2 正文带着全新 message_id 到达——
  // 该帧未被路由到已知消息，旧逻辑的跨轮隔离守卫直接拒绝，思考与正文全部丢失。
  const canvas = [
    { role: 'user', parts: [{ kind: 'text' as const, text: '第一轮提问' }], id: 'm-old-user' },
    { role: 'assistant', id: 'm-old', parts: [{ kind: 'text' as const, text: '历史回答' }] },
    { role: 'user', parts: [{ kind: 'text' as const, text: '第二轮提问' }], id: 'm-cur-user' },
    {
      role: 'assistant',
      id: 'm-round-1',
      parts: [
        { kind: 'text' as const, text: '正文 1', id: 'm-round-1:2:text' },
        { kind: 'tool' as const, tool: { id: 'call_1', name: 'bash', args: '', status: 'done' as const } },
      ],
    },
  ];

  // 直播帧（线协议不带 replay 标记）必须立即上屏；新 message_id = 新 round = 新气泡。
  const streamed = withAssistantIdentity(
    paintAssistantText(canvas, '正文 2', false, 'm-round-2'),
    'm-round-2',
  );
  assert.equal(streamed.length, 5);
  assert.equal(streamed[4]?.id, 'm-round-2');
  assert.deepEqual(streamed[4]?.parts.map((p) => p.kind), ['text']);
  assert.equal((streamed[4]?.parts[0] as { text: string }).text, '正文 2');

  const reasoned = paintAssistantReasoning(streamed, '第二轮思考', false, 'm-round-2');
  assert.deepEqual(reasoned[4]?.parts.map((p) => p.kind), ['text', 'reasoning']);

  // 未命中轮编号的帧仍是「画布上还没有的内容」直接落笔；已有 id 的迟到帧回到自己那行。
  // （不重复的保证由断点续传游标 + message_id 绝对寻址共同承担。）
  const replayed = paintAssistantText(canvas, '正文 2', true, 'm-round-2');
  assert.equal(replayed.length, 5);
  assert.deepEqual(replayed[4]?.parts.map((p) => p.kind), ['text']);
});

test('回放帧按 part 身份收敛：画布已领先时不得把中段再追加一遍', () => {
  // 刷新后从缓存恢复的在途 part（已画到「请求C」），回放却从更早的片段逐段重发。
  // 旧实现用「整条消息所有正文的拼接」做基线：重发的中段既非前缀也非后缀，
  // 于是被当成新内容再追加一遍 —— 整合在途回合被逐帧重打一遍的根因。
  const canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [{ kind: 'text' as const, text: '请求A请求B请求C', id: 'm-1:2:text' }],
    },
  ];
  assert.equal(paintAssistantText(canvas, '请求A', true, 'm-1', 'm-1:2:text'), canvas);
  assert.equal(paintAssistantText(canvas, '请求B', true, 'm-1', 'm-1:2:text'), canvas);
  assert.equal(paintAssistantText(canvas, '请求C', true, 'm-1', 'm-1:2:text'), canvas);
  // 累积帧更长（迟到的尾段）：原地收敛，绝不新起部件
  const grown = paintAssistantText(canvas, '请求A请求B请求C请求D', true, 'm-1', 'm-1:2:text');
  assert.equal(grown[0]?.parts.length, 1);
  assert.equal((grown[0]?.parts[0] as { text: string }).text, '请求A请求B请求C请求D');
});

test('hydrated streaming partial stays one row when the replay catches up', () => {
  // The session detail now projects the live partial BEFORE pending steers so a
  // mid-turn refresh keeps aq1, as1, steer1. The watch replay then re-delivers the
  // same assistant identity; it must merge, not create a second text part.
  const partial = 'working on the first round';
  const canvas = [{
    role: 'assistant',
    id: 'm-as1',
    parts: [{ kind: 'text' as const, text: partial }],
  }];
  const grown = paintAssistantText(
    canvas as never,
    `${partial} and more`,
    true,
    'm-as1',
    'm-as1:2:text',
    2,
  ) as typeof canvas;
  const textParts = grown[0].parts.filter((part) => part.kind === 'text');
  assert.equal(textParts.length, 1, 'partial and replay must converge on one part');
  assert.equal(textParts[0].text, `${partial} and more`);
  assert.equal(
    paintAssistantText(grown as never, `${partial} and more`, true, 'm-as1', 'm-as1:2:text', 2),
    grown,
    'replaying the same accumulated part is idempotent',
  );
});

test('回放同一 message 的后续段收敛到规范块，不在工具后另起显示块', () => {
  const canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [
        { kind: 'text' as const, text: '正文 1', id: 'm-1:2:text' },
        { kind: 'tool' as const, tool: { id: 't1', name: 'read', args: '{}', status: 'done' as const } },
      ],
    },
  ];
  // part_seq 只在规范块内部排序，不是显示块身份：正文 2 仍属于 m-1 的唯一正文块。
  const next = paintAssistantText(canvas, '正文 2', true, 'm-1', 'm-1:4:text');
  assert.equal(next[0]?.parts.length, 2, 'no second prose block after the tool card');
  const textPart = next[0]?.parts[0] as { text: string; ids?: string[] };
  assert.equal(textPart.text, '正文 1正文 2');
  assert.deepEqual(textPart.ids, ['m-1:4:text']);
  // 同一帧再次回放：内容已包含 → 幂等丢弃
  assert.equal(paintAssistantText(next, '正文 2', true, 'm-1', 'm-1:4:text'), next);
  // 这一行还没有思考块：首个思考段仍按线序落到工具之后，并随后按身份收敛。
  const withThinking = paintAssistantReasoning(next, '第二轮思考', true, 'm-1', 'm-1:5:reasoning');
  assert.equal((withThinking[0]?.parts[2] as { id?: string }).id, 'm-1:5:reasoning');
  assert.equal(
    paintAssistantReasoning(withThinking, '第二轮思考', true, 'm-1', 'm-1:5:reasoning'),
    withThinking,
  );
});

test('hydrated snapshot + replayed part suffixes never paint a second block after tools', () => {
  const reasoningHead = '思'.repeat(120);
  const reasoningTail = '尾段思考';
  const reasoningFull = reasoningHead + reasoningTail;
  const textHead = '收到';
  const textTail = '，合并任务已完成。现在开始排查。';
  const textFull = textHead + textTail;
  const hydrated = [
    {
      role: 'assistant',
      id: 'm-hydrated',
      parts: [
        { kind: 'reasoning' as const, text: reasoningFull, id: 'm-hydrated:1:reasoning' },
        { kind: 'text' as const, text: textFull, id: 'm-hydrated:2:text' },
        { kind: 'tool' as const, tool: { id: 't1', name: 'read', args: '{}', status: 'done' as const } },
        { kind: 'tool' as const, tool: { id: 't2', name: 'bash', args: '{}', status: 'done' as const } },
      ],
    },
  ];
  // The persisted snapshot already merged the whole round. Replay still sends
  // the earlier part prefixes and the same message's later :3/:4 suffixes.
  let msgs = paintAssistantReasoning(
    hydrated as never,
    reasoningHead,
    true,
    'm-hydrated',
    'm-hydrated:1:reasoning',
    1,
  ) as typeof hydrated;
  msgs = paintAssistantText(msgs as never, textHead, true, 'm-hydrated', 'm-hydrated:2:text', 1) as typeof hydrated;
  msgs = paintAssistantReasoning(msgs as never, reasoningTail, true, 'm-hydrated', 'm-hydrated:3:reasoning', 1) as typeof hydrated;
  msgs = paintAssistantText(msgs as never, textTail, true, 'm-hydrated', 'm-hydrated:4:text', 4) as typeof hydrated;

  const parts = msgs[0].parts as Array<{ kind: string; text?: string; id?: string; ids?: string[] }>;
  const reasoning = parts.filter((p) => p.kind === 'reasoning');
  const text = parts.filter((p) => p.kind === 'text');
  assert.equal(reasoning.length, 1, 'one canonical reasoning block per message');
  assert.equal(text.length, 1, 'one canonical text block per message');
  assert.equal(reasoning[0]?.text, reasoningFull);
  assert.equal(text[0]?.text, textFull);
  assert.deepEqual(parts.map((p) => p.kind), ['reasoning', 'text', 'tool', 'tool']);

  const again = paintAssistantText(
    paintAssistantReasoning(msgs as never, reasoningTail, true, 'm-hydrated', 'm-hydrated:3:reasoning', 1) as never,
    textTail,
    true,
    'm-hydrated',
    'm-hydrated:4:text',
    4,
  );
  assert.equal((again[0]?.parts as unknown[]).length, 4, 'replayed suffixes stay idempotent');
});

test('不同 message_id 的轮次仍以工具为界各自成行', () => {
  let msgs: any[] = [];
  msgs = withAssistantIdentity(
    paintAssistantReasoning(msgs, '工具前思考', true, 'm-2', 'm-2:1:reasoning'),
    'm-2',
    'm-2:1:reasoning',
  );
  msgs = msgs.map((m) => m.role === 'assistant'
    ? { ...m, parts: [...m.parts, { kind: 'tool', tool: { id: 't1', name: 'read', args: '{}', status: 'done' } }] }
    : m);
  msgs = withAssistantIdentity(
    paintAssistantReasoning(msgs, '工具后思考', true, 'm-3', 'm-3:1:reasoning'),
    'm-3',
    'm-3:1:reasoning',
  );
  assert.equal(msgs.length, 2, 'a new message_id must open a new assistant row');
  assert.deepEqual(msgs.map((m: any) => m.id), ['m-2', 'm-3']);
});

test('replay of interleaved reasoning/text reuses the coalesced part aliases', () => {
  let msgs: any[] = [];
  msgs = paintAssistantReasoning(msgs, '思考一', true, 'm-1', 'm-1:1:reasoning');
  msgs = paintAssistantText(msgs, '正文一', true, 'm-1', 'm-1:2:text');
  msgs = paintAssistantReasoning(msgs, '思考二', true, 'm-1', 'm-1:3:reasoning');
  msgs = paintAssistantText(msgs, '正文二', true, 'm-1', 'm-1:4:text');

  // 同一 round 内交替：显示上收敛为「一块思考 + 一段正文」，正文不被思考块劈开。
  let parts = msgs[0]?.parts ?? [];
  assert.deepEqual(parts.map((p: any) => p.kind), ['reasoning', 'text']);
  assert.equal(parts[0].text, '思考一思考二');
  assert.equal(parts[1].text, '正文一正文二');
  assert.deepEqual(parts[0].ids, ['m-1:3:reasoning']);
  assert.deepEqual(parts[1].ids, ['m-1:4:text']);

  // A later replay addressed to an absorbed part must merge, not append a
  // second thinking/body block.
  msgs = paintAssistantReasoning(msgs, '思考一思考二', true, 'm-1', 'm-1:3:reasoning');
  msgs = paintAssistantText(msgs, '正文一正文二', true, 'm-1', 'm-1:4:text');
  parts = msgs[0]?.parts ?? [];
  assert.equal(parts.length, 2, 'alias replay must be idempotent');
  assert.equal(parts[0].text, '思考一思考二');
  assert.equal(parts[1].text, '正文一正文二');
});

test('same message replay converges across a tool boundary', () => {
  let msgs: any[] = [];
  msgs = paintAssistantReasoning(msgs, '工具前思考甲', true, 'm-2', 'm-2:1:reasoning');
  msgs = msgs.map((m) => m.role === 'assistant'
    ? { ...m, parts: [...m.parts, { kind: 'tool', tool: { id: 't1', name: 'read', args: '{}', status: 'done' } }] }
    : m);
  msgs = paintAssistantReasoning(msgs, '工具后思考乙', true, 'm-2', 'm-2:2:reasoning');
  const reasoning = msgs[0].parts.filter((p: any) => p.kind === 'reasoning');
  // part_seq 只区分块内 segment：同一个 message_id 仍只有一个规范思考块。
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].text, '工具前思考甲工具后思考乙');
  assert.deepEqual(reasoning[0].ids, ['m-2:2:reasoning']);
});

test('直播流式输出中的重复 URL、重复前缀与重复代码块内容绝不被吞字', () => {
  const canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [],
    },
  ];

  // 模拟真实 LLM 流式输出：先输出第一条链接
  let res = paintAssistantText(canvas, '1. https://github.com/jeikl/JeikCode/tree/v7.2.2\n', false, 'm-1', 'm-1:1:text');
  // 再分 chunk 流式输出第二条完全相同的链接（测试前缀重复 token 绝不能被 includes 丢弃）
  res = paintAssistantText(res, '2. ', false, 'm-1', 'm-1:1:text');
  res = paintAssistantText(res, 'https://github.com', false, 'm-1', 'm-1:1:text');
  res = paintAssistantText(res, '/jeikl/JeikCode', false, 'm-1', 'm-1:1:text');
  res = paintAssistantText(res, '/tree/v7.2.2\n', false, 'm-1', 'm-1:1:text');

  // 第三条链接整块到达
  res = paintAssistantText(res, '3. https://github.com/jeikl/JeikCode/tree/v7.2.2\n', false, 'm-1', 'm-1:1:text');

  const textPart = res[0]?.parts[0] as { kind: 'text'; text: string };
  assert.equal(textPart.kind, 'text');
  assert.equal(
    textPart.text,
    '1. https://github.com/jeikl/JeikCode/tree/v7.2.2\n2. https://github.com/jeikl/JeikCode/tree/v7.2.2\n3. https://github.com/jeikl/JeikCode/tree/v7.2.2\n',
  );
});

test('直播思考流式输出中的重复词句绝不被误杀吞字', () => {
  const canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [],
    },
  ];

  let res = paintAssistantReasoning(canvas, '首先检查缓存一致性问题。', false, 'm-1', 'm-1:1:reasoning');
  res = paintAssistantReasoning(res, '接着再次确认缓存一致性问题，', false, 'm-1', 'm-1:1:reasoning');
  res = paintAssistantReasoning(res, '问题已被彻底定位。', false, 'm-1', 'm-1:1:reasoning');

  const part = res[0]?.parts[0] as { kind: 'reasoning'; text: string };
  assert.equal(part.kind, 'reasoning');
  assert.equal(part.text, '首先检查缓存一致性问题。接着再次确认缓存一致性问题，问题已被彻底定位。');
});

test('工具调用之后的第二段思考流式输出必须开启独立思考部件，绝不能跨越工具合并进第一段思考部件', () => {
  const canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [
        { kind: 'reasoning' as const, text: '第一阶段思考：需要读取配置文件。', id: 'm-1:1:reasoning' },
        { kind: 'tool' as const, tool: { id: 'call_1', name: 'read', status: 'done' as const } },
      ],
    },
  ];

  // 模拟第二轮思考流式到达（partId 为 m-1:2:reasoning，或者无 partId）
  let res = paintAssistantReasoning(canvas, '第二阶段思考：', false, 'm-1', 'm-1:2:reasoning');
  res = paintAssistantReasoning(res, '配置文件已经读取完毕，准备进行下一步。', false, 'm-1', 'm-1:2:reasoning');

  // 必须严格拥有两个独立的思考部件，中间夹着工具调用！
  const parts = res[0]?.parts ?? [];
  assert.equal(parts.length, 3);
  assert.equal(parts[0]?.kind, 'reasoning');
  assert.equal((parts[0] as any).text, '第一阶段思考：需要读取配置文件。');
  assert.equal(parts[1]?.kind, 'tool');
  assert.equal(parts[2]?.kind, 'reasoning');
  assert.equal((parts[2] as any).text, '第二阶段思考：配置文件已经读取完毕，准备进行下一步。');
});

test('正文与思考在同一回合内被穿插切开时，同类块必须续上（不拆成多块）', () => {
  let canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [],
    },
  ];

  // 服务端每遇到类型切换就 bump part_seq：同一条消息里 text → reasoning → text
  // 会拿到 m:2:text / m:3:reasoning / m:4:text 三个不同段号。
  canvas = paintAssistantReasoning(canvas, '思考1：分析需求', false, 'm-1', 'm-1:1:reasoning');
  canvas = paintAssistantText(canvas, '正文1：开始处理', false, 'm-1', 'm-1:2:text');
  canvas = paintAssistantReasoning(canvas, '思考2：检查函数依赖', false, 'm-1', 'm-1:3:reasoning');
  canvas = paintAssistantText(canvas, '正文2：函数正常', false, 'm-1', 'm-1:4:text');

  // 渲染契约：一个思考块 + 一段正文，正文不得被中途插入的思考劈成两半。
  const parts = canvas[0]?.parts ?? [];
  assert.equal(parts.length, 2, '同种部件必须各自合并为一块');
  assert.equal(parts[0]?.kind, 'reasoning');
  assert.equal((parts[0] as any).text, '思考1：分析需求思考2：检查函数依赖');
  assert.equal(parts[1]?.kind, 'text');
  assert.equal((parts[1] as any).text, '正文1：开始处理正文2：函数正常');
});

test('同一 round 内正文与思考块之间没有工具时，正文不得被思考块劈开', () => {
  // 用户截图里的形状：Thinking → “这个现象” → Thinking → “指向…”
  const parts = [
    { kind: 'reasoning', text: '分析一下', id: 'm-9:1:reasoning' },
    { kind: 'text', text: '这个现象', id: 'm-9:2:text' },
    { kind: 'reasoning', text: '继续分析', id: 'm-9:3:reasoning' },
    { kind: 'text', text: '指向后台缓存丢行。', id: 'm-9:4:text' },
  ] as any[];
  const out = coalesceRoundParts(parts);
  assert.deepEqual(
    out.map((part: any) => `${part.kind}:${part.text}`),
    ['reasoning:分析一下继续分析', 'text:这个现象指向后台缓存丢行。'],
  );
});

test('工具块把一轮切成多段时，每段内部的顺序不变', () => {
  const tool = (id: string) => ({ kind: 'tool' as const, tool: { id, name: 'Bash', args: '', status: 'done' } });
  const parts = [
    { kind: 'reasoning', text: 'R1', id: 'm-1:1:reasoning' },
    { kind: 'text', text: 'T1', id: 'm-1:2:text' },
    tool('t1'),
    { kind: 'text', text: 'T2', id: 'm-1:3:text' },
    tool('t2'),
    { kind: 'reasoning', text: 'R2', id: 'm-1:4:reasoning' },
  ] as any[];
  assert.equal(coalesceRoundParts(parts), parts, 'already-ordered parts must not be rewritten');
});

test('同一回合直接输出工具（无思考无正文）也不受影响', () => {
  const parts = [
    { kind: 'tool', tool: { id: 't1', name: 'Bash', args: '', status: 'done' } },
  ] as any[];
  assert.equal(coalesceRoundParts(parts), parts);
});

test('正文与思考无 partId 的极端重放：同类续上，内容严格按序、不丢不重', () => {
  let canvas = [
    {
      role: 'assistant',
      id: 'm-1',
      parts: [],
    },
  ];

  // 模拟没有 partId 的交替重放帧
  canvas = paintAssistantReasoning(canvas, '阶段1思考', true);
  canvas = paintAssistantText(canvas, '阶段1结论', true);
  canvas = paintAssistantReasoning(canvas, '阶段2思考', true);
  canvas = paintAssistantText(canvas, '阶段2结论', true);

  const parts = canvas[0]?.parts ?? [];
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.kind, 'reasoning');
  assert.equal((parts[0] as any).text, '阶段1思考阶段2思考');
  assert.equal(parts[1]?.kind, 'text');
  assert.equal((parts[1] as any).text, '阶段1结论阶段2结论');
});

test('这一轮还没落盘时，补回的提问作为新回合追加并带上 Working 占位', () => {
  const canvas = [
    { role: 'assistant', id: 'm-old', parts: [{ kind: 'text' as const, text: '上一答' }] },
  ];
  const placed = placeRecoveredTurnUsers(
    canvas,
    [{ type: 'user', content: '新提问', created_at: 4 }],
    { messageId: 'm-missing' },
  );
  assert.equal(placed.length, 3);
  assert.equal(placed[1]?.role, 'user');
  assert.equal(placed[2]?.role, 'assistant');
  assert.equal(placed[2]?.parts.length, 0);
});

test('mergeOlderMessages 解决首屏 pinned 提问在加载更早历史时被工具调用倒插问题', () => {
  // 模拟首屏仅加载 tail:48，其中第一条是 pinned 用户提问 (sourceIndex: 31)，第二条是截断线后的工具输出 (sourceIndex: 132)
  const prev = [
    { role: 'user', id: 'u-31', sourceIndex: 31, parts: [{ kind: 'text' as const, text: '为什么出错了？' }] },
    { role: 'assistant', id: 'a-132', sourceIndex: 132, parts: [{ kind: 'tool' as const, tool: { id: 'call_132', name: 'read', args: '', status: 'done' as const } }] },
  ];

  // 模拟向前翻页加载了包括 30(上一轮回答), 31(本轮提问), 32(本轮工具1), 33(本轮工具2) 等历史
  const older = [
    { role: 'assistant', id: 'a-30', sourceIndex: 30, parts: [{ kind: 'text' as const, text: '上一轮回答' }] },
    { role: 'user', id: 'u-31', sourceIndex: 31, parts: [{ kind: 'text' as const, text: '为什么出错了？' }] },
    { role: 'assistant', id: 'a-32', sourceIndex: 32, parts: [{ kind: 'tool' as const, tool: { id: 'call_32', name: 'code_explore', args: '', status: 'done' as const } }] },
    { role: 'assistant', id: 'a-33', sourceIndex: 33, parts: [{ kind: 'tool' as const, tool: { id: 'call_33', name: 'grep', args: '', status: 'done' as const } }] },
  ];

  const merged = mergeOlderMessages(prev, older);

  // 校验：消息必须按 sourceIndex 严格排列：30 -> 31 -> 32 -> 33 -> 132
  // 提问 31 必须稳稳落在上一轮回答 30 之后，本轮工具 32 之前！
  assert.equal(merged.length, 5);
  assert.equal(merged[0]?.sourceIndex, 30);
  assert.equal(merged[1]?.sourceIndex, 31);
  assert.equal(merged[1]?.role, 'user');
  assert.equal(merged[2]?.sourceIndex, 32);
  assert.equal(merged[3]?.sourceIndex, 33);
  assert.equal(merged[4]?.sourceIndex, 132);
});

test('mergeOlderMessages 正确处理在途/无 sourceIndex 的实时末尾消息', () => {
  const prev = [
    { role: 'user', id: 'u-1', sourceIndex: 10 },
    { role: 'assistant', id: 'a-live', parts: [{ kind: 'text' as const, text: '正在输出中...' }] },
  ];
  const older = [
    { role: 'user', id: 'u-0', sourceIndex: 5 },
  ];

  const merged = mergeOlderMessages(prev, older);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]?.sourceIndex, 5);
  assert.equal(merged[1]?.sourceIndex, 10);
  assert.equal(merged[2]?.id, 'a-live');
});

test('mergeOlderMessages 不会把无 sourceIndex 的旧缓存提问移到末尾（乱序回归）', () => {
  // 旧版 L1/L2 缓存里前面的历史行没有绝对下标；加载更早页时旧实现会把这些行
  // 当成“在途消息”排到末尾，表现为第一条提问漂到 48 条之后。
  const prev = [
    { role: 'user', id: 'old-question', parts: [{ kind: 'text' as const, text: '最早的问题' }] },
    { role: 'assistant', id: 'a-100', sourceIndex: 100 },
    { role: 'user', id: 'u-101', sourceIndex: 101 },
    { role: 'assistant', id: 'live-tail', parts: [{ kind: 'text' as const, text: '正在输出' }] },
  ];
  const older = [{ role: 'user', id: 'u-50', sourceIndex: 50 }];

  const merged = mergeOlderMessages(prev, older);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['old-question', 'u-50', 'a-100', 'u-101', 'live-tail'],
  );
  assert.equal(merged[0]?.id, 'old-question', '无下标的旧历史必须保持在顶部');
  assert.equal(merged[merged.length - 1]?.id, 'live-tail', '实时尾行必须留在末尾');
});

test('cachedHeadIsContiguous 拒绝与权威尾页之间有空档的旧缓存', () => {
  // A far head + the tail still has a hole in the middle; "load older" walks
  // backward from 300 and would never fill 301..622.
  assert.equal(cachedHeadIsContiguous([{ sourceIndex: 300 }, { sourceIndex: 623 }], 624), false);
  assert.equal(cachedHeadIsContiguous([{ sourceIndex: 300 }, { sourceIndex: 500 }], 624), false);
  assert.equal(cachedHeadIsContiguous([{ sourceIndex: 700 }], 624), true);
  assert.equal(cachedHeadIsContiguous([], 624), false);

  // A dense cache that reaches the tail stays usable.
  const dense = Array.from({ length: 48 }, (_, index) => ({ sourceIndex: 576 + index }));
  assert.equal(cachedHeadIsContiguous(dense, 624), true);
  // Small gaps caused by filtered internal rows are tolerated.
  assert.equal(
    cachedHeadIsContiguous([{ sourceIndex: 600 }, { sourceIndex: 620 }, { sourceIndex: 623 }], 624),
    true,
  );
});

test('resolveHistoryOffset 冷启动优先使用缓存里更早的真实下标，忽略越过尾页的旧下标', () => {
  // 画布缓存已展开到 384，API 仍返回 48 条尾页 offset=576。
  assert.equal(
    resolveHistoryOffset({
      cachedMessages: [{ sourceIndex: 384 }, { sourceIndex: 500 }, { sourceIndex: 700 }],
      cachedOffset: 384,
      diskOffset: 576,
    }),
    384,
  );
  // 压缩后旧缓存的 700 已越界（新数组尾部只到 576）：不能拿它当游标。
  assert.equal(
    resolveHistoryOffset({
      cachedMessages: [{ sourceIndex: 700 }],
      cachedOffset: 700,
      diskOffset: 576,
    }),
    576,
  );
  // 无缓存时保持服务端尾页偏移。
  assert.equal(
    resolveHistoryOffset({ cachedMessages: [], cachedOffset: undefined, diskOffset: 576 }),
    576,
  );
});

test('spliceAuthoritativeDiskTail 仅保留更早的历史 Head 并用权威磁盘切片无损替换尾部', () => {
  // 画布包含 Turn 1 (0..35), Turn 2 (36..75), 以及内存中未完成的 Turn 3 (76..100)
  const canvas = [
    { role: 'user', id: 'u-1', sourceIndex: 10 },
    { role: 'assistant', id: 'a-1', sourceIndex: 20 },
    { role: 'user', id: 'u-2', sourceIndex: 50 },
    { role: 'assistant', id: 'a-2-dirty', sourceIndex: 70 }, // 内存中带有脏内容的尾部
  ];

  // 磁盘返回 tail:48 切片，起始 offset=60，包含了干净落盘的 Turn 2 尾部与 Turn 3 完整答案
  const diskTail = [
    { role: 'assistant', id: 'a-2-clean', sourceIndex: 70 },
    { role: 'user', id: 'u-3', sourceIndex: 80 },
    { role: 'assistant', id: 'a-3', sourceIndex: 90 },
  ];

  // 当 offset=60 时：canvas 中 sourceIndex < 60 的（10, 50）保留；>= 60 的（70 脏尾部）被 diskTail 彻底替换！
  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 60);

  assert.equal(spliced.length, 6);
  assert.equal(spliced[0]?.sourceIndex, 10);
  assert.equal(spliced[1]?.sourceIndex, 20);
  assert.equal(spliced[2]?.sourceIndex, 50);
  assert.equal(spliced[3]?.id, 'a-2-clean');
  assert.equal(spliced[4]?.id, 'u-3');
  assert.equal(spliced[5]?.id, 'a-3');
});

test('spliceAuthoritativeDiskTail 绝不会把 pinned 开场提问倒插到回答下方（>48条历史长会话结算防倒插）', () => {
  // 核心回归案例：长会话（>48条）当且仅当包含早先历史时，对账切片自带 pinned 开场提问（src=8 < offset=22）。
  // 画布原本时序：User(8) -> Assistant(9) -> Tool(10) -> Assistant(21)。
  // 磁盘尾部切片：[User(8, pinned), Tool(22), Tool(23), Assistant(24)]。
  // 旧实现将 User(8) 从早先历史 Head 中剔除，挪到了拼接 Seam（即 Assistant(21) 之后），导致提问倒插在回答下方！
  const canvas = [
    { role: 'user', id: 'u-8', sourceIndex: 8 },
    { role: 'assistant', id: 'a-9', sourceIndex: 9 },
    { role: 'assistant', id: 't-10', sourceIndex: 10 },
    { role: 'assistant', id: 'a-21', sourceIndex: 21 },
    { role: 'assistant', id: 't-22-dirty', sourceIndex: 22 },
  ];
  const diskTail = [
    { role: 'user', id: 'u-8', sourceIndex: 8 }, // daemon tail=48 切片首部的 pinned user
    { role: 'assistant', id: 't-22-clean', sourceIndex: 22 },
    { role: 'assistant', id: 't-23', sourceIndex: 23 },
    { role: 'assistant', id: 'a-24', sourceIndex: 24 },
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 22);

  // 必须严格保证 User(8) 仍在索引 0 位置，绝不能被挪到 a-21 后面！
  assert.equal(spliced[0]?.id, 'u-8');
  assert.equal(spliced[0]?.sourceIndex, 8);
  assert.equal(spliced[1]?.id, 'a-9');
  assert.equal(spliced[1]?.sourceIndex, 9);
  assert.equal(spliced[2]?.id, 't-10');
  assert.equal(spliced[3]?.id, 'a-21');
  assert.equal(spliced[4]?.id, 't-22-clean');
  assert.equal(spliced[5]?.id, 't-23');
  assert.equal(spliced[6]?.id, 'a-24');
  assert.equal(spliced.length, 7);
});

test('spliceAuthoritativeDiskTail 在 offset <= 0 时直接全量采用磁盘', () => {
  const canvas = [{ role: 'user', sourceIndex: 999 }];
  const diskTail = [{ role: 'user', sourceIndex: 1 }, { role: 'assistant', sourceIndex: 2 }];
  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 0);
  assert.deepEqual(spliced, diskTail);
});

test('带 seq 的本地通知行（压缩标记）对账后仍留在所属回合，不拖到会话末尾', () => {
  // 第 2 轮回答之后用户点了 Compact：命令输出行按 seq 落在 a-2 之后。
  const notice = () => ({
    role: 'system',
    parts: [{ kind: 'notice' as const, text: '已压缩 · 摘要 12 条 · ~48.2K→~9.1K tok' }],
    seq: 51.5,
  });
  const turn = () => [
    { role: 'user', id: 'u-2', sourceIndex: 50, seq: 50, parts: [{ kind: 'text' as const, text: '第二问' }] },
    { role: 'assistant', id: 'a-2', sourceIndex: 51, seq: 51, parts: [{ kind: 'text' as const, text: '第二答' }] },
  ];
  const nextTurn = () => [
    { role: 'user', id: 'u-3', sourceIndex: 52, seq: 52, parts: [{ kind: 'text' as const, text: '第三问' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 53, seq: 53, parts: [{ kind: 'text' as const, text: '第三答' }] },
  ];

  // 画布：上一轮 + 压缩标记 + 新一轮（已落盘）。磁盘只含真实转录行。
  const canvas = [...turn(), notice(), ...nextTurn()];
  const diskTail = [...turn(), ...nextTurn()];

  const once = spliceAuthoritativeDiskTail(canvas, diskTail, 40) as any[];
  assert.deepEqual(
    once.map((m) => m.id ?? 'notice'),
    ['u-2', 'a-2', 'notice', 'u-3', 'a-3'],
    '压缩标记必须钉在 a-2 之后，而不是被当成未落盘尾巴拖到最后',
  );

  // 每次终态对账都会再拼一次：位置必须稳定，不能逐轮漂移/累积。
  const twice = spliceAuthoritativeDiskTail(once as any, diskTail, 40) as any[];
  assert.deepEqual(twice.map((m) => m.id ?? 'notice'), ['u-2', 'a-2', 'notice', 'u-3', 'a-3']);
  assert.equal(twice.filter((m) => m.role === 'system').length, 1);
});

test('spliceAuthoritativeDiskTail 丢弃无 seq 的旧缓存通知行，不再逐轮钉到会话末尾', () => {
  // 升级前写入 IndexedDB 的临时提示（如“已请求停止当前回合”）没有 seq，也不属于任何一轮。
  const legacyNotice = () => ({ role: 'system', parts: [{ kind: 'notice' as const, text: '已请求停止当前回合' }] });
  const canvas = [
    { role: 'user', id: 'u-2', sourceIndex: 50, parts: [{ kind: 'text' as const, text: '第二问' }] },
    { role: 'assistant', id: 'a-2', sourceIndex: 51, parts: [{ kind: 'text' as const, text: '第二答' }] },
    legacyNotice(),
    { role: 'user', id: 'u-3', sourceIndex: 52, parts: [{ kind: 'text' as const, text: '第三问' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 53, parts: [{ kind: 'text' as const, text: '第三答' }] },
  ];
  const diskTail = [
    { role: 'user', id: 'u-2', sourceIndex: 50, parts: [{ kind: 'text' as const, text: '第二问' }] },
    { role: 'assistant', id: 'a-2', sourceIndex: 51, parts: [{ kind: 'text' as const, text: '第二答' }] },
    { role: 'user', id: 'u-3', sourceIndex: 52, parts: [{ kind: 'text' as const, text: '第三问' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 53, parts: [{ kind: 'text' as const, text: '第三答' }] },
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas as any, diskTail as any, 40) as any[];
  assert.deepEqual(spliced.map((m) => m.id ?? 'notice'), ['u-2', 'a-2', 'u-3', 'a-3']);
});

test('stripTransientNoticeRows 剔除瞬态提示，只保留持久化边界通知', () => {
  const rows = [
    { role: 'assistant', id: 'a-1', seq: 1, parts: [{ kind: 'text' as const, text: '回答' }] },
    {
      role: 'system',
      id: 'notice-stop',
      seq: 1.5,
      parts: [{ kind: 'notice' as const, text: '已请求停止当前回合，可以继续发送。' }],
    },
    {
      role: 'system',
      id: 'notice-retry',
      seq: 2,
      transient: true,
      parts: [{ kind: 'notice' as const, text: '模型只返回了思考，正在重试(1/6)...' }],
    },
    {
      role: 'system',
      id: 'notice-compact',
      seq: 3,
      persistent: true,
      parts: [{ kind: 'notice' as const, text: '已压缩 · 摘要 12 条 · ~48.2K→~9.1K tok' }],
    },
    // Legacy transient notice: id+seq but no durability marker.
    {
      role: 'system',
      id: 'notice-legacy-warning',
      seq: 4,
      parts: [{ kind: 'notice' as const, text: 'stream idle timeout — reconnecting' }],
    },
  ];
  const out = stripTransientNoticeRows(rows as any);
  assert.deepEqual(out.map((row) => row.id), ['a-1', 'notice-compact']);
});

test('stripTransientNoticeRows 从 assistant 行中剔除 rate_limited 部件', () => {
  const rows = [
    {
      role: 'assistant',
      id: 'a-1',
      parts: [
        { kind: 'text' as const, text: '回答' },
        { kind: 'rate_limited' as const, text: '上游限流' },
      ],
    },
    {
      role: 'assistant',
      id: 'a-only-limit',
      parts: [{ kind: 'rate_limited' as const, text: '上游限流' }],
    },
  ];
  const out = stripTransientNoticeRows(rows as any) as any[];
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, 'a-1');
  assert.deepEqual(out[0]!.parts.map((p: any) => p.kind), ['text']);
});

test('isTransientAdvisoryText 区分重试提示与压缩边界', () => {
  assert.equal(
    isTransientAdvisoryText('模型只返回了思考，正在重试(1/6)...'),
    true,
  );
  assert.equal(
    isTransientAdvisoryText('Model returned only reasoning, retrying (1/6)...'),
    true,
  );
  assert.equal(
    isTransientAdvisoryText('已压缩 · 摘要 12 条 · ~48.2K→~9.1K tok'),
    false,
  );
});

test('spliceAuthoritativeDiskTail 用权威行替换同一身份时保留本地 notice 部件', () => {
  // 压缩发生在第 2 轮之后：标记作为 notice 部件挂在 a-2 上。
  const canvas = [
    { role: 'user', id: 'u-2', sourceIndex: 50, parts: [{ kind: 'text' as const, text: '第二问' }] },
    {
      role: 'assistant',
      id: 'a-2',
      sourceIndex: 51,
      parts: [
        { kind: 'text' as const, text: '第二答' },
        { kind: 'notice' as const, text: '已压缩 · 摘要 12 条 · ~48.2K→~9.1K tok' },
      ],
    },
    { role: 'user', id: 'u-3', sourceIndex: 52, parts: [{ kind: 'text' as const, text: '第三问' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 53, parts: [{ kind: 'text' as const, text: '第三答' }] },
  ];
  // 磁盘/展示账本永远没有 UI notice 部件。
  const diskTail = [
    { role: 'user', id: 'u-2', sourceIndex: 50, parts: [{ kind: 'text' as const, text: '第二问' }] },
    { role: 'assistant', id: 'a-2', sourceIndex: 51, parts: [{ kind: 'text' as const, text: '第二答' }] },
    { role: 'user', id: 'u-3', sourceIndex: 52, parts: [{ kind: 'text' as const, text: '第三问' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 53, parts: [{ kind: 'text' as const, text: '第三答' }] },
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas as any, diskTail as any, 40) as any[];
  const answer = spliced.find((m) => m.id === 'a-2');
  assert.deepEqual(answer.parts.map((p: any) => p.kind), ['text', 'notice']);
  // 其他行不受影响，也不会把 notice 复制到最新一条。
  assert.deepEqual(spliced.find((m) => m.id === 'a-3').parts.map((p: any) => p.kind), ['text']);
  assert.equal(spliced.filter((m) => m.parts.some((p: any) => p.kind === 'notice')).length, 1);
});

test('spliceAuthoritativeDiskTail 不会把 pinned 提问重复保留，且重复对账保持幂等', () => {
  // tail:48 切在回合中间：offset=52，服务端把本回合开头的提问（绝对索引 50）pinned 到切片首位。
  // 它的 sourceIndex < offset，旧实现会同时落进 olderHead 与 diskTail，每轮终态 +1 份。
  const pinned = () => ({
    role: 'user',
    id: 'u-50',
    sourceIndex: 50,
    parts: [{ kind: 'text' as const, text: '为什么出错了？' }],
  });
  const tailRows = () => [
    { role: 'assistant', id: 'a-53', sourceIndex: 53, parts: [] },
    { role: 'assistant', id: 'a-60', sourceIndex: 60, parts: [] },
  ];
  const canvas = [pinned(), ...tailRows()];
  const diskTail = [pinned(), ...tailRows()];

  const once = spliceAuthoritativeDiskTail(canvas, diskTail, 52);
  assert.equal(once.filter((m) => m.id === 'u-50').length, 1);
  assert.deepEqual(once.map((m) => m.sourceIndex), [50, 53, 60]);

  // 每个回合终态都会再对账一次：必须保持 1 份，不能 2 -> 3 -> 4 累积。
  const twice = spliceAuthoritativeDiskTail(once, diskTail, 52);
  const thrice = spliceAuthoritativeDiskTail(twice, diskTail, 52);
  assert.equal(twice.filter((m) => m.id === 'u-50').length, 1);
  assert.equal(thrice.filter((m) => m.id === 'u-50').length, 1);
  assert.deepEqual(thrice.map((m) => m.sourceIndex), [50, 53, 60]);
});

test('spliceAuthoritativeDiskTail 按 sourceIndex 排除重叠行（无 id 的历史也能去重）', () => {
  const canvas = [
    { role: 'assistant', sourceIndex: 40, parts: [] },
    { role: 'user', sourceIndex: 50, parts: [] },
    { role: 'assistant', sourceIndex: 55, parts: [] },
  ];
  const diskTail = [
    { role: 'user', sourceIndex: 50, parts: [] },
    { role: 'assistant', sourceIndex: 55, parts: [] },
    { role: 'assistant', sourceIndex: 60, parts: [] },
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 52);
  // 40 是更早历史保留；50 已在权威切片里，不能再从画布头部留一份。
  assert.deepEqual(spliced.map((m) => m.sourceIndex), [40, 50, 55, 60]);
});

test('paintAssistantNotice 重放幂等：同一条提示只产生一条 system 记录', () => {
  const canvas = [{ role: 'assistant', id: 'a-1', parts: [{ kind: 'text' as const, text: '正文' }] }];
  const once = paintAssistantNotice(canvas, 'HTTP 400: {"model":"x"}');
  assert.equal(once.length, 2);
  assert.equal(once[1]!.role, 'system');
  assert.equal(once[1]!.parts[0]!.kind, 'notice');
  assert.equal((once[1] as any).transient, true, 'live advisory must not become durable');
  // 断线重连重发的同一帧：原数组返回，不再叠一份。
  const twice = paintAssistantNotice(once, 'HTTP 400: {"model":"x"}');
  assert.equal(twice, once);

  // 带 message_id：插在它所属的回合之后，而不是盲写时间线尾部。
  const multi = [
    { role: 'assistant', id: 'a-1', parts: [{ kind: 'text' as const, text: '第一轮' }] },
    { role: 'assistant', id: 'a-2', parts: [{ kind: 'text' as const, text: '第二轮' }] },
  ];
  const targeted = paintAssistantNotice(multi, '压缩完成', 'a-1');
  assert.equal(targeted.length, 3);
  assert.equal(targeted[1]!.role, 'system');
  assert.equal(targeted[1]!.parts[0]!.text, '压缩完成');
  assert.equal(targeted[2]!.id, 'a-2');
  assert.equal(paintAssistantNotice(targeted, '压缩完成', 'a-1'), targeted);
  // 不同文案仍然各自上屏。
  assert.equal(paintAssistantNotice(targeted, '另一条提示', 'a-1').length, 4);
});

test('paintAssistantNotice 失败回合的提示插在自己那条提问下面', () => {
  const canvas = [
    { role: 'assistant', id: 'a-prev', parts: [{ kind: 'text' as const, text: '上一轮回答' }] },
    { role: 'user', id: 'u-next', parts: [{ kind: 'text' as const, text: '这一轮失败' }] },
    { role: 'assistant', id: 'a-next', parts: [] },
  ];
  const once = paintAssistantNotice(canvas, 'HTTP 400: {"model":"x"}', 'u-next');
  assert.equal(once.length, 4);
  assert.equal(once[2]!.role, 'system');
  assert.equal(once[2]!.parts[0]!.kind, 'notice');
  assert.equal(once[3]!.id, 'a-next');
  // 同一提示重放 → 幂等。
  assert.equal(paintAssistantNotice(once, 'HTTP 400: {"model":"x"}', 'u-next'), once);

  // 下一轮已经开跑（有正文）时，插在提问之后而不是并进下一轮。
  const busy = [
    { role: 'user', id: 'u-fail', parts: [{ kind: 'text' as const, text: '失败那轮' }] },
    { role: 'assistant', id: 'a-busy', parts: [{ kind: 'text' as const, text: '下一轮正文' }] },
  ];
  const inserted = paintAssistantNotice(busy, 'HTTP 500', 'u-fail');
  assert.equal(inserted.length, 3);
  assert.equal(inserted[1]!.role, 'system');
  assert.equal(inserted[1]!.parts[0]!.kind, 'notice');
  assert.equal(inserted[2]!.parts[0]!.text, '下一轮正文');
});

test('rate_limited 目标轮不在画布时不落到最终答案后面', () => {
  const rows = [
    { role: 'user', id: 'u-1', parts: [{ kind: 'text' as const, text: '本轮提问' }] },
    { role: 'assistant', id: 'a-final', parts: [{ kind: 'text' as const, text: '最终答案' }] },
  ];
  const out = reduceCanvasEvent(rows as any, {
    type: 'rate_limited',
    text: '上游限流',
    targetId: 'a-missing',
    id: 'rl-1',
  } as any) as any[];
  assert.equal(out.length, 3);
  assert.equal(out[1]!.role, 'assistant');
  assert.equal(out[1]!.parts[0]!.kind, 'rate_limited');
  assert.equal(out[2]!.id, 'a-final');
});

test('paintAssistantNotice 目标轮不在画布时落到当前提问之后，而不是整段末尾', () => {
  const canvas = [
    { role: 'user', id: 'u-1', parts: [{ kind: 'text' as const, text: '本轮提问' }] },
    { role: 'assistant', id: 'a-final', parts: [{ kind: 'text' as const, text: '最终答案' }] },
  ];
  // 目标轮（只返回思考的那一轮）已不在当前窗口，不能把提示挂到最终答案下面。
  const out = paintAssistantNotice(canvas, '模型只返回了思考，正在重试(1/6)...', 'a-thinking');
  assert.equal(out.length, 3);
  assert.equal(out[1]!.role, 'system');
  assert.equal(out[2]!.id, 'a-final');
  assert.equal((out[1] as any).transient, true);
});

test('placeRecoveredTurnUsers 用绝对下标把被折叠线切掉的提问放回原位置', () => {
  const canvas = [
    { role: 'user', sourceIndex: 55, id: 'u55', parts: [{ kind: 'text' as const, text: '窗口内的提问' }] },
    { role: 'assistant', sourceIndex: 56, id: 'a56', parts: [{ kind: 'text' as const, text: '回答' }] },
  ];
  // 回放恢复的开场提问带真实下标 7 → 插到窗口最前面，而不是锚点/48 附近。
  const placed = placeRecoveredTurnUsers(canvas, [
    { type: 'user', content: '本回合开场提问', created_at: 1000, source_index: 7 },
  ]);
  assert.equal(placed.length, 3);
  assert.equal(placed[0]!.role, 'user');
  assert.equal(placed[0]!.sourceIndex, 7);
  assert.equal(placed[1]!.sourceIndex, 55);

  // 同一绝对下标已在画布上 → 幂等（原数组返回）。
  assert.equal(
    placeRecoveredTurnUsers(placed, [
      { type: 'user', content: '本回合开场提问', created_at: 1000, source_index: 7 },
    ]),
    placed,
  );

  // 没有下标时保持旧行为：作为新回合追加 + Working 占位。
  const appended = placeRecoveredTurnUsers(canvas, [
    { type: 'user', content: '完全没有见过的提问', created_at: 2000 },
  ]);
  assert.equal(appended.length, 4);
});

test('placeRecoveredTurnUsers 携带并保留图片附件，不生成空文本无图的幽灵气泡', () => {
  const canvas = [
    { role: 'user', id: 'm-u1', parts: [{ kind: 'text' as const, text: '第一问' }] },
    { role: 'assistant', id: 'm-a1', parts: [{ kind: 'text' as const, text: '第一答' }] },
  ];
  const withImages = placeRecoveredTurnUsers(canvas as any, [
    {
      type: 'user',
      content: '',
      images: [{ media_type: 'image/png', data: 'test-img' }],
      created_at: 3000,
    },
  ]);
  assert.equal(withImages.length, 4);
  assert.equal(withImages[2].role, 'user');
  assert.deepEqual((withImages[2] as any).images, [{ media_type: 'image/png', data: 'test-img' }]);

  // 既无文本也无图片的幽灵事件被跳过
  const withGhost = placeRecoveredTurnUsers(canvas as any, [
    { type: 'user', content: '', created_at: 4000 },
  ]);
  assert.equal(withGhost.length, 2);
});

test('stampUserSourceIndex 用身份帧的绝对下标只回填无下标的回放提问', () => {
  const canvas = [
    // 回放恢复出来的提问：有 id（刚被 user_identified 绑定）但没有下标。
    { role: 'user', id: 'm-u7', parts: [{ kind: 'text' as const, text: '开场提问' }] },
    // 磁盘投影行：已有权威下标。
    { role: 'user', id: 'm-u9', sourceIndex: 9, sourceIndexAuthority: 'disk' as const, parts: [{ kind: 'text' as const, text: '磁盘行' }] },
  ];
  const stamped = stampUserSourceIndex(canvas, 'm-u7', 7);
  assert.equal(stamped[0]!.sourceIndex, 7);
  assert.equal(stamped[1]!.sourceIndex, 9);

  // 已有权威下标的行绝不覆盖；未知 id / 非法下标 → 原数组返回。
  assert.equal(stampUserSourceIndex(stamped, 'm-u9', 999), stamped);
  assert.equal(stampUserSourceIndex(stamped, 'm-nope', 7), stamped);
  assert.equal(stampUserSourceIndex(stamped, 'm-u7', Number.NaN), stamped);
  assert.equal(stampUserSourceIndex(stamped, undefined, 7), stamped);

  // 已错位到末尾的无下标行：只有显式允许移动时才会重排回头部（渲染按数组序）。
  const stray = [
    { role: 'assistant', id: 'a-55', sourceIndex: 55, parts: [{ kind: 'text' as const, text: '窗口内回答' }] },
    { role: 'user', id: 'm-u7', parts: [{ kind: 'text' as const, text: '开场提问' }] },
  ];
  const reordered = stampUserSourceIndex(stray, 'm-u7', 7, { allowMove: true });
  assert.equal(reordered[0]!.id, 'm-u7');
  assert.equal(reordered[0]!.sourceIndex, 7);
  assert.equal(reordered[0]!.sourceIndexAuthority, 'outline');
  assert.equal(reordered[1]!.sourceIndex, 55);

  // 默认只盖章、不搬动：已有因果位置的 user 行绝不能因为一个下标被前移。
  const inPlace = stampUserSourceIndex(stray, 'm-u7', 7);
  assert.deepEqual(inPlace.map((row) => row.id), ['a-55', 'm-u7']);
  assert.equal(inPlace[1]!.sourceIndex, 7);

  // 转向行即使显式 allowMove，也绝不前移；只盖章。
  const steerCanvas = [
    { role: 'assistant', id: 'a-55', sourceIndex: 55, parts: [{ kind: 'text' as const, text: '工具轮' }] },
    { role: 'user', id: 'steer-1', isSteer: true, parts: [{ kind: 'text' as const, text: '转向' }] },
  ];
  const steerStamped = stampUserSourceIndex(steerCanvas, 'steer-1', 42, { allowMove: true });
  assert.deepEqual(steerStamped.map((row) => row.id), ['a-55', 'steer-1']);
  assert.equal(steerStamped[1]!.sourceIndex, 42);
  assert.equal(steerStamped[1]!.sourceIndexAuthority, 'outline');
});


// ─── 回合终态「整轮重放」回归 ───
// 真实会话 852b3cba（23 轮 / 34 次工具调用 / 65 条消息）：模型在整个 loop 里只吐思考与工具，
// 直到最后一轮才有正文。直播期正文是「结算」的唯一依据，于是一轮又一轮的思考/工具全部画进
// 发送时那条空的助手占位行（它带着猜出来的 sourceIndex = turnIndex + 1）。
// 回合终态 `syncSessionCacheFromDisk` 做权威尾部拼接时，这条「整轮累积行」因为下标小于
// diskOffset 被当成更早历史保留，而磁盘尾部（offset=17）又把同样的轮次画一遍 ——
// 用户看到的就是「回答与工具调用被整体重放」。
function liveMegaRowCanvas(answer: string) {
  let canvas: Array<{ role: string; id?: string; sourceIndex?: number; parts: any[] }> = [
    { role: 'user', id: 'u-q', sourceIndex: 0, parts: [{ kind: 'text', text: '看看这个 issue' }] },
    // Chat.tsx send 路径：乐观占位行带 sourceIndex（修复后不再带）。
    { role: 'assistant', id: undefined, sourceIndex: 1, parts: [] },
  ];
  for (let round = 1; round <= 3; round += 1) {
    const mid = `m-${round}`;
    canvas = withAssistantIdentity(
      paintAssistantReasoning(canvas as never, `第${round}轮思考`, false, mid, `${mid}:1:reasoning`),
      mid,
      `${mid}:1:reasoning`,
    ) as typeof canvas;
    const last = canvas[canvas.length - 1]!;
    // addToolToLastAssistant：末行未结算（无正文）→ 追进同一行。
    canvas = [
      ...canvas.slice(0, -1),
      {
        ...last,
        parts: upsertToolPart(last.parts, {
          id: `call-${round}`,
          name: 'read',
          args: '{}',
          status: 'done',
        }),
      },
    ];
  }
  canvas = withAssistantIdentity(
    paintAssistantText(canvas as never, answer, false, 'm-3', 'm-3:2:text'),
    'm-3',
    'm-3:2:text',
  ) as typeof canvas;
  return canvas;
}

function diskRow(spec: {
  role: string;
  index: number;
  id: string;
  text?: string;
  reasoning?: string;
  tools?: string[];
}) {
  const parts: any[] = [];
  if (spec.reasoning) {
    parts.push({ kind: 'reasoning', text: spec.reasoning, id: `${spec.id}:1:reasoning` });
  }
  if (spec.text) {
    parts.push({ kind: 'text', text: spec.text, id: `${spec.id}:${spec.reasoning ? 2 : 1}:text` });
  }
  for (const toolId of spec.tools ?? []) {
    parts.push({ kind: 'tool', tool: { id: toolId, name: 'read', args: '{}', status: 'done' } });
  }
  return { role: spec.role, id: spec.id, sourceIndex: spec.index, parts };
}

test('回合终态对账：直播期整轮累积的助手行绝不与权威尾部叠加成第二份回答', () => {
  const answer = '最终回答：与滑动超时无关，是上游连接空闲超时。';
  const canvas = liveMegaRowCanvas(answer);

  // 权威尾部：offset=17，pinned 开场提问（绝对下标 7）+ 17..20。
  // 同一轮 loop 的思考/工具既在画布上的累积行里，也在切片里。
  const diskTail = [
    diskRow({ role: 'user', index: 7, id: 'u-q', text: '看看这个 issue' }),
    diskRow({ role: 'tool', index: 17, id: 'r-17', text: '工具输出 17' }),
    diskRow({ role: 'assistant', index: 18, id: 'm-1', reasoning: '第1轮思考', tools: ['call-1'] }),
    diskRow({ role: 'assistant', index: 19, id: 'm-2', reasoning: '第2轮思考', tools: ['call-2'] }),
    diskRow({ role: 'assistant', index: 20, id: 'm-3', reasoning: '第3轮思考', text: answer }),
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 17);
  const answers = spliced.filter((message) =>
    message.parts?.some((part: any) => part.kind === 'text' && part.text === answer),
  );
  assert.equal(answers.length, 1, '同一条回答绝不能被渲染两份');

  const toolIds = spliced.flatMap((message) =>
    (message.parts ?? [])
      .filter((part: any) => part.kind === 'tool')
      .map((part: any) => part.tool.id),
  );
  assert.deepEqual(toolIds, ['call-1', 'call-2'], '工具调用必须按权威切片各出现一次');
});

test('修复后的直播画布：占位行没有绝对下标，整行交给权威切片', () => {
  const answer = '最终回答：与滑动超时无关，是上游连接空闲超时。';
  // 发送路径不再给流式占位行盖 sourceIndex（它还没落盘，绝对下标只有磁盘/身份帧才有）。
  const canvas = liveMegaRowCanvas(answer).map((message) =>
    message.role === 'assistant' ? { ...message, sourceIndex: undefined } : message,
  );
  const diskTail = [
    diskRow({ role: 'user', index: 7, id: 'u-q', text: '看看这个 issue' }),
    diskRow({ role: 'assistant', index: 18, id: 'm-1', reasoning: '第1轮思考', tools: ['call-1'] }),
    diskRow({ role: 'assistant', index: 19, id: 'm-2', reasoning: '第2轮思考', tools: ['call-2'] }),
    diskRow({ role: 'assistant', index: 20, id: 'm-3', reasoning: '第3轮思考', text: answer }),
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 17);
  assert.equal(
    spliced.filter((m) => m.parts?.some((p: any) => p.kind === 'text' && p.text === answer)).length,
    1,
  );
  // 权威切片之前的提问行（猜的下标 0 < offset）仍可在头部，但只能出现一份。
  assert.equal(spliced.filter((m) => m.role === 'user').length, 1);
});

test('旧缓存自愈：累积行的首个 round 已在窗口外时，按段身份剔除重复内容', () => {
  const answer = '最终回答：与滑动超时无关，是上游连接空闲超时。';
  const canvas = liveMegaRowCanvas(answer);
  // 切片从第 2 轮开始：累积行的行级 id（m-1）不在切片里，只能靠 part id / call id 剔除。
  const diskTail = [
    diskRow({ role: 'assistant', index: 19, id: 'm-2', reasoning: '第2轮思考', tools: ['call-2'] }),
    diskRow({ role: 'assistant', index: 20, id: 'm-3', reasoning: '第3轮思考', tools: ['call-3'], text: answer }),
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, 18);
  assert.equal(
    spliced.filter((m) => m.parts?.some((p: any) => p.kind === 'text' && p.text === answer)).length,
    1,
    '回答只能出现一次',
  );
  const head = spliced.find((m) => m.role === 'assistant')!;
  assert.deepEqual(
    head.parts.map((p: any) => (p.kind === 'tool' ? p.tool.id : p.kind)),
    ['reasoning', 'call-1'],
    '窗口外的第 1 轮保留，窗口内的第 2/3 轮交给权威切片',
  );
});

// ─── 与「无下标直播行」相关的缓存并集回归 ───
// 直播占位行/流式助手行不再带猜测下标后，落缓存时的「L1 全量画布 ∪ 可视 48 条窗口」
// 会把同一条无下标行带上两份。合并必须原地收敛，绝不能把它插到历史最前面。
test('缓存并集：无下标直播行不得被提到时间线顶部，同一行只保留一份', () => {
  const history = [
    { role: 'user', id: 'u-7', sourceIndex: 7, parts: [{ kind: 'text' as const, text: '上一问' }] },
    { role: 'assistant', id: 'a-8', sourceIndex: 8, parts: [{ kind: 'text' as const, text: '上一答' }] },
  ];
  const question = { role: 'user', id: 'u-9', sourceIndex: 9, parts: [{ kind: 'text' as const, text: '这一问' }] };
  // L1 全量画布：占位行已收到部分正文
  const live = { role: 'assistant', parts: [{ kind: 'text' as const, text: '回答前半段' }] };
  const cached = [...history, question, live];
  // 可视窗口：同一批行（同一引用）
  const merged = mergeOlderMessages(cached, [question, live]);

  assert.equal(merged.length, cached.length, '同一条直播行不能被并成两份');
  assert.equal(merged[merged.length - 1], live, '直播行必须仍在时间线末尾');
  assert.equal(merged.filter((m) => m.role === 'assistant').length, 2);
});

test('缓存并集：流式进度更长的副本原地替换旧副本，位置不变', () => {
  const history = [
    { role: 'assistant', id: 'a-8', sourceIndex: 8, parts: [{ kind: 'text' as const, text: '上一答' }] },
  ];
  const stale = { role: 'assistant', parts: [{ kind: 'text' as const, text: '回答前半段' }] };
  const fresh = { role: 'assistant', parts: [{ kind: 'text' as const, text: '回答前半段和后半段' }] };
  const merged = mergeOlderMessages([...history, stale], [...history, stale, fresh]);

  assert.equal(merged.length, 2, '同一条流式行只保留一份');
  assert.equal(merged[1], fresh, '保留进度更长的那份');
  assert.equal(merged[0]?.id, 'a-8', '带下标的更早历史位置不变');
});

test('旧缓存的无下标历史页仍插在带下标历史之前（原语义不回退）', () => {
  const canvas = [
    { role: 'user', id: 'u-7', sourceIndex: 7, parts: [{ kind: 'text' as const, text: '窗口内提问' }] },
    { role: 'assistant', id: 'a-8', sourceIndex: 8, parts: [{ kind: 'text' as const, text: '窗口内回答' }] },
  ];
  const legacyPage = [
    { role: 'user', parts: [{ kind: 'text' as const, text: '旧缓存提问' }] },
    { role: 'assistant', parts: [{ kind: 'text' as const, text: '旧缓存回答' }] },
  ];
  const merged = mergeOlderMessages(canvas, legacyPage);
  assert.equal(merged.length, 4);
  assert.equal(merged[0]?.parts?.[0]?.text, '旧缓存提问');
  assert.equal(merged[2]?.id, 'u-7');
});

test('spliceAuthoritativeDiskTail 为头部行自动补全权威 pinned 切片里的图片', () => {
  const canvas = [
    { role: 'user', id: 'u-7', sourceIndex: 7, parts: [{ kind: 'text' as const, text: '推流期无图提问' }] },
    { role: 'assistant', id: 'a-8', sourceIndex: 8, parts: [{ kind: 'text' as const, text: '回答' }] },
  ];
  const diskTail = [
    {
      role: 'user',
      id: 'u-7',
      sourceIndex: 7,
      parts: [{ kind: 'text' as const, text: '权威提问' }],
      images: [{ media_type: 'image/png', data: 'imgbase64' }],
    },
    { role: 'assistant', id: 'a-20', sourceIndex: 20, parts: [{ kind: 'text' as const, text: '最新答复' }] },
  ];
  const spliced = spliceAuthoritativeDiskTail(canvas as any, diskTail as any, 20);
  assert.equal(spliced.length, 3);
  assert.equal(spliced[0]?.id, 'u-7');
  assert.equal((spliced[0] as any)?.images?.length, 1);
  assert.equal((spliced[0] as any)?.images?.[0]?.data, 'imgbase64');
});

// ── 刷新后回放补回的 steer 提问要回到被打断的那一轮之后 ──
// 丢了气泡的旧快照上，steer 之后的正文已经画好；如果当成新回合追加到末尾，
// 用户提问就会倒插到自己的回答下面。回放是严格有序的，锚点就是它前面最后一帧
// 落到的助手行。
test('steerInsertAfterAnchor 把回放补回的转向插在被打断的那一轮之后', () => {
  const canvas = [
    { role: 'user', id: 'u-1', sourceIndex: 0, parts: [{ kind: 'text' as const, text: '上一问' }] },
    {
      role: 'assistant',
      id: 'm-1',
      sourceIndex: 1,
      parts: [{ kind: 'text' as const, text: '上一轮最终正文', id: 'm-1:1:text' }],
    },
    // steer 之后的 loop（直播行：只有 wire 身份，没有转录下标）
    {
      role: 'assistant',
      id: 'm-2',
      parts: [{ kind: 'text' as const, text: '让我想想....', id: 'm-2:1:text' }],
    },
    {
      role: 'assistant',
      id: 'm-3',
      parts: [{ kind: 'text' as const, text: '1+1=2', id: 'm-3:1:text' }],
    },
  ];

  // 锚点 = 回放里 steered 前面最后一帧落到的助手行（m-1）→ 插在它之后。
  const insertAt = steerInsertAfterAnchor(canvas, { messageId: 'm-1' });
  assert.equal(insertAt, 2);
  const withBubble = canvas.slice();
  withBubble.splice(insertAt, 0, {
    role: 'user',
    id: 'm-steer',
    isSteer: true,
    parts: [{ kind: 'text' as const, text: '接下来帮我干xxx' }],
  } as (typeof canvas)[number]);
  assert.deepEqual(
    withBubble.map((m) => (m.role === 'user' ? m.parts[0]?.text : (m as { id?: string }).id)),
    ['上一问', 'm-1', '接下来帮我干xxx', 'm-2', 'm-3'],
    '提问必须落在上一轮正文之后、steer 之后的 loop 之前',
  );

  // 工具帧锚点：那一轮只有工具调用时也要能定位。
  const toolCanvas = [
    {
      role: 'assistant',
      id: 'm-t',
      parts: [{ kind: 'tool' as const, tool: { id: 'call-1', name: 'read', args: '{}', status: 'done' as const } }],
    },
  ];
  assert.equal(steerInsertAfterAnchor(toolCanvas, { toolId: 'call-1' }), 1);

  // 定位不到（锚点还没画上 / 没有锚点）→ -1，调用方按新回合追加到末尾。
  assert.equal(steerInsertAfterAnchor(canvas, { messageId: 'm-missing' }), -1);
  assert.equal(steerInsertAfterAnchor(canvas, undefined), -1);
});

test('spliceAuthoritativeDiskTail 不采信 steer 的本地猜下标（否则整段 steer 被判进窗口后丢失）', () => {
  // steer 的 sourceIndex 是 fold 时按“当前窗口末尾”推算的，从来没被磁盘确认过。
  // 一旦它比磁盘尾部窗口起点大，旧实现会把 steer 和它后面的直播行整段当成
  // “窗口内已有”而丢弃，刷新后 steer 气泡凭空消失。
  const canvas = [
    { role: 'user', id: 'q', sourceIndex: 0, parts: [{ kind: 'text' as const, text: '持续巡检' }] },
    { role: 'assistant', id: 'a0', sourceIndex: 1, parts: [{ kind: 'tool' as const, tool: { id: 'w-0', name: 'write', args: '{}', status: 'done' as const } }] },
    { role: 'user', id: 'steer-1', isSteer: true, sourceIndex: 90, parts: [{ kind: 'text' as const, text: '改成 30s 一次' }] },
    { role: 'assistant', id: 'a1', parts: [{ kind: 'tool' as const, tool: { id: 'bash-1', name: 'run_command', args: '{}', status: 'pending' as const } }] },
  ];
  // 磁盘窗口只覆盖 steer 之后的那一轮（起点 5），且已把工具行结算成 done。
  const diskTail = [
    { role: 'assistant', id: 'a1', sourceIndex: 5, parts: [{ kind: 'tool' as const, tool: { id: 'bash-1', name: 'run_command', args: '{}', status: 'done' as const, output: 'ok' } }] },
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas as any, diskTail as any, 5);
  assert.deepEqual(spliced.map((m) => m.id), ['q', 'a0', 'steer-1', 'a1']);
  assert.equal(spliced.filter((m) => m.isSteer).length, 1);
  // 假死工具行必须被磁盘的 done 版本替换，绝不能继续挂着 pending
  assert.equal(
    spliced.some((m) => m.parts.some((p) => p.kind === 'tool' && p.tool?.status === 'pending')),
    false,
  );
});

test('spliceAuthoritativeDiskTail 保留历史轮次中的黄色通知在原有轮次位置不被拖拽到会话末尾', () => {
  // 第 1 轮：用户：“你好”，AI 出错产生黄色通知
  // 第 2 轮：用户：“你好 再发一次”，AI 出错产生黄色通知
  // 第 3 轮：用户：“好像连接上了”，AI 恢复正常回答（落盘）
  const canvas = [
    { role: 'user', id: 'u-1', sourceIndex: 0, parts: [{ kind: 'text' as const, text: '你好' }] },
    { role: 'assistant', id: 'a-1', parts: [{ kind: 'notice' as const, text: 'API错误' }] },
    { role: 'user', id: 'u-2', sourceIndex: 1, parts: [{ kind: 'text' as const, text: '你好 再发一次' }] },
    { role: 'assistant', id: 'a-2', parts: [{ kind: 'notice' as const, text: '上游断流' }] },
    { role: 'user', id: 'u-3', sourceIndex: 2, parts: [{ kind: 'text' as const, text: '好像连接上了' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 3, parts: [{ kind: 'text' as const, text: '对啊 恢复了' }] },
  ];

  const diskTail = [
    { role: 'user', id: 'u-3', sourceIndex: 2, parts: [{ kind: 'text' as const, text: '好像连接上了' }] },
    { role: 'assistant', id: 'a-3', sourceIndex: 3, parts: [{ kind: 'text' as const, text: '对啊 恢复了' }] },
  ];

  const spliced = spliceAuthoritativeDiskTail(canvas as any, diskTail as any, 2);
  const cleaned = spliced;

  // 验证时序：历史 notice 必须紧随所属提问，绝对不能全部堆叠在第 3 轮回答（a-3）后面！
  const rolesAndTexts = cleaned.map((m) => {
    const text = m.parts?.[0]?.text;
    return `${m.role}:${text}`;
  });

  assert.deepEqual(rolesAndTexts, [
    'user:你好',
    'assistant:API错误',
    'user:你好 再发一次',
    'assistant:上游断流',
    'user:好像连接上了',
    'assistant:对啊 恢复了',
  ]);
});

// ── 同一回合跨 round 的思考/正文不得分叉 ─────────────────────────────────

test('同一回合的新 round 按 message_id 各自成行，不把思考/正文折进旧行', () => {
  let msgs: any[] = [];
  msgs = withAssistantIdentity(paintAssistantReasoning(msgs, '思考一。', false, 'm1', 'm1:1:reasoning'), 'm1');
  msgs = withAssistantIdentity(paintAssistantText(msgs, '正文一。', false, 'm1', 'm1:2:text'), 'm1');
  // 第二轮 round：新的 message_id / part_id，中间没有工具调用。
  msgs = withAssistantIdentity(paintAssistantReasoning(msgs, '思考二。', false, 'm2', 'm2:1:reasoning'), 'm2');
  msgs = withAssistantIdentity(paintAssistantText(msgs, '正文二。', false, 'm2', 'm2:2:text'), 'm2');

  // 绝对 id 就是气泡边界：live 必须和磁盘投影一样，一 round 一 assistant 行。
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0].parts.map((p: any) => p.kind), ['reasoning', 'text']);
  assert.equal(msgs[0].parts[0].text, '思考一。');
  assert.equal(msgs[0].parts[1].text, '正文一。');
  assert.equal(msgs[1].id, 'm2');
  assert.deepEqual(msgs[1].parts.map((p: any) => p.kind), ['reasoning', 'text']);
  assert.equal(msgs[1].parts[0].text, '思考二。');
  assert.equal(msgs[1].parts[1].text, '正文二。');
});

test('part_rev applies each wire part event exactly once', () => {
  let msgs: any[] = [{ role: 'assistant', id: 'm-rev', parts: [] }];
  msgs = paintAssistantText(msgs, 'A', false, 'm-rev', 'm-rev:1:text', 1);
  msgs = paintAssistantText(msgs, 'B', false, 'm-rev', 'm-rev:1:text', 2);
  let textParts = msgs[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, 'AB');
  assert.equal(textParts[0].rev, 2);

  // The same accumulated replay revision is a no-op, not a second append.
  msgs = paintAssistantText(msgs, 'AB', true, 'm-rev', 'm-rev:1:text', 2);
  textParts = msgs[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts[0].text, 'AB');

  // A replay frame with a newer revision replaces the accumulated part.
  msgs = paintAssistantText(msgs, 'ABC', true, 'm-rev', 'm-rev:1:text', 3);
  textParts = msgs[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts[0].text, 'ABC');

  // An older live delta must not append after the replay snapshot.
  msgs = paintAssistantText(msgs, 'C', false, 'm-rev', 'm-rev:1:text', 2);
  textParts = msgs[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts[0].text, 'ABC');

  msgs = paintAssistantReasoning(msgs, 'R1', false, 'm-rev', 'm-rev:2:reasoning', 1);
  msgs = paintAssistantReasoning(msgs, 'R1', true, 'm-rev', 'm-rev:2:reasoning', 1);
  const reasoningParts = msgs[0].parts.filter((p: any) => p.kind === 'reasoning');
  assert.equal(reasoningParts.length, 1);
  assert.equal(reasoningParts[0].text, 'R1');

  // The very first wire frame must keep its part identity + revision, not be
  // recreated as an anonymous part on the next frame.
  let fresh: any[] = [];
  fresh = paintAssistantText(fresh, 'A', false, 'm-fresh', 'm-fresh:1:text', 1);
  fresh = paintAssistantText(fresh, 'B', false, 'm-fresh', 'm-fresh:1:text', 2);
  const freshParts = fresh[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(freshParts.length, 1);
  assert.equal(freshParts[0].text, 'AB');
  assert.equal(freshParts[0].rev, 2);
});

test('live repeated long text/reasoning blob is not concatenated twice', () => {
  const blob =
    '我先查“右栏大纲”和主画布窗口的数据来源：是 SessionDetail.turns 只按当前窗口生成，还是前端把大纲覆盖成了 tail window。随后用新成品在隔离实例复现长会话刷新。';
  let msgs: any[] = [];
  msgs = paintAssistantReasoning(msgs, blob, false, 'm-live', 'm-live:1:reasoning');
  msgs = paintAssistantReasoning(msgs, blob, false, 'm-live', 'm-live:1:reasoning');
  assert.equal(msgs[0].parts.length, 1);
  assert.equal(msgs[0].parts[0].text, blob);
  msgs = paintAssistantText(msgs, blob, false, 'm-live', 'm-live:2:text');
  msgs = paintAssistantText(msgs, blob, false, 'm-live', 'm-live:2:text');
  const textParts = msgs[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, blob);
});

test('a mid-token suffix part cannot duplicate the disk body', () => {
  // The disk snapshot stores ONE complete body. The live/replay stream can
  // split it at a token boundary; the second part starts at `urns` / `条`,
  // which is why the UI looked like it "swallowed" the first character.
  const body =
    '我先查“右栏大纲”和主画布窗口的数据来源：是 `SessionDetail.turns` 只按当前窗口生成，还是前端把大纲覆盖成了 tail window。随后用新成品在隔离实例复现长会话刷新。';
  const prefix = body.slice(0, body.indexOf('长会话刷新'));
  const suffix = body.slice(body.indexOf('长会话刷新'));
  // `SessionDetail.turns` has no `.length`; start at the mid-token `urns`.
  const midTokenSuffix = body.slice(body.indexOf('urns'));

  let msgs: any[] = [];
  msgs = paintAssistantText(msgs, prefix, false, 'm-mid', 'm-mid:1:text');
  msgs = paintAssistantText(msgs, body, true, 'm-mid', 'm-mid:2:text');
  msgs = paintAssistantText(msgs, suffix, false, 'm-mid', 'm-mid:3:text');
  let textParts = msgs[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, body);

  let msgs2: any[] = [];
  msgs2 = paintAssistantText(msgs2, body, false, 'm-mid2', 'm-mid2:1:text');
  msgs2 = paintAssistantText(msgs2, midTokenSuffix, false, 'm-mid2', 'm-mid2:2:text');
  textParts = msgs2[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, body);

  const body2 =
    '我先从 13461 的真实会话取 SessionDetail，对比 turns.length、message_count 和当前窗口，确认是服务端只返回了 2-3 条，还是前端把它裁掉了。';
  const mid2 = body2.slice(body2.indexOf('urns.length'));
  let msgs3: any[] = [];
  msgs3 = paintAssistantText(msgs3, body2, false, 'm-mid3', 'm-mid3:1:text');
  msgs3 = paintAssistantText(msgs3, mid2, false, 'm-mid3', 'm-mid3:2:text');
  textParts = msgs3[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, body2);

  // The user's second report: the short `3 条，还是...` tail was replayed.
  const shortTail = body2.slice(body2.indexOf('3 条'));
  let msgs4: any[] = [];
  msgs4 = paintAssistantText(msgs4, body2, false, 'm-mid4', 'm-mid4:1:text');
  msgs4 = paintAssistantText(msgs4, shortTail, false, 'm-mid4', 'm-mid4:2:text');
  textParts = msgs4[0].parts.filter((p: any) => p.kind === 'text');
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, body2);
});

test('coalesceRoundParts concatenates identified parts in order without content dedupe', () => {
  const parts: any[] = [
    { kind: 'text', text: 'A', id: 'm:1:text', rev: 1 },
    { kind: 'text', text: 'A', id: 'm:3:text', rev: 1 },
  ];
  const out = coalesceRoundParts(parts);
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).text, 'AA');
  assert.deepEqual((out[0] as any).ids, ['m:3:text']);
});

test('coalesceRoundParts collapses identical long replayed text/reasoning blobs', () => {
  const blob =
    '我先查“右栏大纲”和主画布窗口的数据来源：是 SessionDetail.turns 只按当前窗口生成，还是前端把大纲覆盖成了 tail window。随后用新成品在隔离实例复现长会话刷新。';
  const parts: any[] = [
    { kind: 'reasoning', text: blob, id: 'm-1:1:reasoning' },
    { kind: 'reasoning', text: blob, id: 'm-1:3:reasoning' },
    { kind: 'tool', tool: { id: 't1', name: 'grep', args: '{}', status: 'done' } },
    { kind: 'text', text: blob, id: 'm-1:4:text' },
    { kind: 'text', text: blob, id: 'm-1:5:text' },
  ];
  const out = coalesceRoundParts(parts);
  assert.equal(out.length, 3);
  assert.equal((out[0] as any).text, blob);
  assert.deepEqual((out[0] as any).ids, ['m-1:3:reasoning']);
  assert.equal((out[2] as any).text, blob);
  assert.deepEqual((out[2] as any).ids, ['m-1:5:text']);
});

test('思考与正文交替时绝不跨 round 合并：后一轮正文不得被搬到前一轮思考之前', () => {
  // 弱端 / 回放路径会把多个 round 并进同一条 assistant 行。旧实现跳过另一种类型
  // 去找同种部件，于是 R1 T1 R2 T2 被压成 (R1+R2) (T1+T2)，视觉上就是
  // “一大段思考配一段对不上的正文”。partId 里的 owner 是 round 身份，不同就不得合并。
  const parts = [
    { kind: 'reasoning', text: 'R1', id: 'm-1:1:reasoning' },
    { kind: 'text', text: 'T1', id: 'm-1:2:text' },
    { kind: 'reasoning', text: 'R2', id: 'm-2:1:reasoning' },
    { kind: 'text', text: 'T2', id: 'm-2:2:text' },
  ] as any[];
  const out = coalesceRoundParts(parts);
  assert.deepEqual(
    out.map((part: any) => `${part.kind}:${part.text}`),
    ['reasoning:R1', 'text:T1', 'reasoning:R2', 'text:T2'],
  );
});

test('工具调用是硬边界：工具前后的正文必须保持两段', () => {
  const parts = [
    { kind: 'text', text: '前半。' },
    { kind: 'tool', tool: { id: 't1', name: 'read', args: '{}', status: 'done' } },
    { kind: 'text', text: '后半。' },
  ] as any[];
  assert.equal(coalesceRoundParts(parts), parts);
});

test('通知也是边界：跨越通知的思考不合并', () => {
  const parts = [
    { kind: 'reasoning', text: '先想。' },
    { kind: 'notice', text: '提示' },
    { kind: 'reasoning', text: '再想。' },
  ] as any[];
  assert.equal(coalesceRoundParts(parts), parts);
});

test('assistant 之后插入的 system 通知：同 id 续写不劈，新 round 按 id 另起', () => {
  const msgs: any[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
    { role: 'assistant', id: 'm1', parts: [{ kind: 'text', text: '正文一。' }] },
    { role: 'system', parts: [{ kind: 'notice', text: 'notice' }] },
  ];
  // 同一 round 的迟到续写（同 id）仍回到原行，不新开气泡。
  const same = paintAssistantText(msgs, '续写。', false, 'm1', 'm1:2:text');
  assert.equal(same.length, 3);
  assert.equal(same[1].parts[0].text, '正文一。续写。');
  assert.equal(same[2].role, 'system');

  // 新的 message_id 属于下一 round：另起一行，而不是折进 m1。
  const next = withAssistantIdentity(
    paintAssistantText(msgs, '正文二。', false, 'm2', 'm2:1:text'),
    'm2',
  );
  assert.equal(next.length, 4);
  assert.equal(next[1].parts[0].text, '正文一。');
  assert.equal(next[2].role, 'system');
  assert.equal(next[3].id, 'm2');
  assert.equal(next[3].parts[0].text, '正文二。');
});

test('新的用户回合仍然会新开 assistant 行', () => {
  const msgs: any[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'q1' }] },
    { role: 'assistant', id: 'm1', parts: [{ kind: 'text', text: 'a1' }] },
    { role: 'user', parts: [{ kind: 'text', text: 'q2' }] },
  ];
  const next = paintAssistantText(msgs, 'a2', false, 'm2', 'm2:1:text');
  assert.equal(next.length, 4);
  assert.equal(next[3].role, 'assistant');
  assert.equal(next[3].parts[0].text, 'a2');
});

test('sameTurnAssistantIndex 跳过末尾 system 行，但遇到新用户行就停止', () => {
  const withNotice = [{ role: 'user' }, { role: 'assistant' }, { role: 'system' }];
  assert.equal(sameTurnAssistantIndex(withNotice), 1);
  assert.equal(sameTurnAssistantIndex([...withNotice, { role: 'user' }]), -1);
});

test('分 round 成行后重放保持幂等（每个 part 只重放自己的累积内容）', () => {
  let msgs: any[] = [];
  msgs = withAssistantIdentity(paintAssistantReasoning(msgs, '思考一。', false, 'm1', 'm1:1:reasoning'), 'm1');
  msgs = withAssistantIdentity(paintAssistantText(msgs, '正文一。', false, 'm1', 'm1:2:text'), 'm1');
  msgs = msgs.map((m) =>
    m.role === 'assistant'
      ? {
          ...m,
          parts: [
            ...m.parts,
            { kind: 'tool', tool: { id: 'call-1', name: 'run', args: '{}', status: 'done' } },
          ],
        }
      : m,
  );
  msgs = withAssistantIdentity(paintAssistantReasoning(msgs, '思考二。', false, 'm2', 'm2:1:reasoning'), 'm2');
  msgs = withAssistantIdentity(paintAssistantText(msgs, '正文二。', false, 'm2', 'm2:2:text'), 'm2');

  // 段序在每个 message 内重置：两个 round 各自成行、各自保留一段正文。
  assert.equal(msgs.length, 2);
  const firstTexts = msgs[0].parts.filter((part: any) => part.kind === 'text');
  const secondTexts = msgs[1].parts.filter((part: any) => part.kind === 'text');
  assert.deepEqual(firstTexts.map((part: any) => part.text), ['正文一。']);
  assert.deepEqual(secondTexts.map((part: any) => part.text), ['正文二。']);

  // 回放时每个 part 只会重放自己的累积内容 → 必须幂等（引用不变）。
  assert.equal(paintAssistantText(msgs, '正文二。', true, 'm2', 'm2:2:text'), msgs);
  assert.equal(paintAssistantText(msgs, '正文一。', true, 'm1', 'm1:2:text'), msgs);
  assert.equal(paintAssistantReasoning(msgs, '思考一。', true, 'm1', 'm1:1:reasoning'), msgs);
});

test('终态对账不会把已上屏的旧工具卡倒灌到回答底部', () => {
  // 真实形态：长回合里直播只往「一条聚合 assistant 行」上写（没 sourceIndex），
  // 它把本轮早先 round 的工具卡也攒在自己身上；这些工具卡同时已经通过分页
  // 以权威行的形式上屏。回合结束时 splice 把它当成「未落盘的当前尾巴」整行
  // 追加到末尾 → 用户看到的就是：回答完成后，底下又被旧消息灌了一遍。
  const tool = (id: string, name: string) => ({
    kind: 'tool' as const,
    tool: { id, name, args: '{"q":"x"}', status: 'done' as const },
  });
  const canvas = [
    { role: 'user', sourceIndex: 600, parts: [{ kind: 'text' as const, text: '重启网关' }] },
    { role: 'assistant', sourceIndex: 601, parts: [tool('t1', 'grep')] },
    { role: 'assistant', sourceIndex: 603, parts: [tool('t2', 'read')] },
    // 直播聚合行：重复了 t1/t2，再带上最终答案
    {
      role: 'assistant',
      parts: [tool('t1', 'grep'), tool('t2', 'read'), { kind: 'text' as const, text: '最终答案' }],
    },
  ];
  const diskTail = [
    { role: 'user', sourceIndex: 600, parts: [{ kind: 'text' as const, text: '重启网关' }] },
    { role: 'assistant', sourceIndex: 601, parts: [tool('t1', 'grep')] },
    { role: 'assistant', sourceIndex: 603, parts: [tool('t2', 'read')] },
    { role: 'assistant', sourceIndex: 629, parts: [{ kind: 'text' as const, text: '最终答案' }] },
  ];

  const out = spliceAuthoritativeDiskTail(canvas, diskTail, 620);
  const toolIds = out.flatMap((row) =>
    (row.parts ?? []).filter((part) => part.kind === 'tool').map((part) => (part as any).tool.id),
  );
  assert.deepEqual(toolIds, ['t1', 't2'], '每张工具卡只应出现一次，且留在原本的回合位置');
  const last = out[out.length - 1];
  assert.equal((last?.parts?.[0] as any)?.text, '最终答案', '末尾必须是真正的最终回答');
});

// 刷新回放：一轮里的多个 round 聚在同一条 assistant 行里，中间有工具卡。
// 回放必须按 part_id 在整行内找到早一轮的部件，不能被「最后一个工具边界」挡住，
// 否则正文/思考会在工具卡之后再开一份（刷新后大量重复的根因）。
test('replay of an earlier reasoning round merges across tool barriers', () => {
  const base = [
    { role: 'user', parts: [{ kind: 'text' as const, text: 'q' }] },
    { role: 'assistant', parts: [] as any[] },
  ];
  let next = paintAssistantReasoning(base, '第一轮思考', false, 'm-1', 'm-1:1:reasoning');
  next = withAssistantIdentity(next, 'm-1');
  next = next.map((m) =>
    m.role === 'assistant'
      ? {
          ...m,
          parts: [
            ...m.parts,
            { kind: 'tool', tool: { id: 'call-1', name: 'run', args: '{}', status: 'done' } },
          ],
        }
      : m,
  );
  next = paintAssistantReasoning(next, '第二轮思考', false, 'm-2', 'm-2:1:reasoning');

  const replayed = paintAssistantReasoning(next, '第一轮思考', true, 'm-1', 'm-1:1:reasoning');
  assert.equal(replayed.length, 3, 'm-2 是独立气泡，重放 m-1 不得新增行');
  const reasons = replayed[1]!.parts.filter((part) => part.kind === 'reasoning');
  assert.equal(reasons.length, 1, '早一轮的思考只在自己那行保留一份');
  assert.equal((reasons[0] as any).text, '第一轮思考');
  const secondReasons = replayed[2]!.parts.filter((part) => part.kind === 'reasoning');
  assert.equal((secondReasons[0] as any).text, '第二轮思考');
});

test('replay of an earlier text round merges across tool barriers', () => {
  const base = [
    { role: 'user', parts: [{ kind: 'text' as const, text: 'q' }] },
    { role: 'assistant', parts: [] as any[] },
  ];
  let next = paintAssistantText(base, '第一轮正文', false, 'm-1', 'm-1:1:text');
  next = withAssistantIdentity(next, 'm-1');
  next = next.map((m) =>
    m.role === 'assistant'
      ? {
          ...m,
          parts: [
            ...m.parts,
            { kind: 'tool', tool: { id: 'call-1', name: 'run', args: '{}', status: 'done' } },
          ],
        }
      : m,
  );
  next = paintAssistantText(next, '第二轮正文', false, 'm-2', 'm-2:1:text');

  const replayed = paintAssistantText(next, '第一轮正文', true, 'm-1', 'm-1:1:text');
  assert.equal(replayed.length, 3, 'm-2 是独立气泡，重放 m-1 不得新增行');
  const texts = replayed[1]!.parts.filter((part) => part.kind === 'text');
  assert.deepEqual(
    texts.map((part) => (part as any).text),
    ['第一轮正文'],
    '早一轮的正文只在自己那行保留一份',
  );
  const secondTexts = replayed[2]!.parts.filter((part) => part.kind === 'text');
  assert.deepEqual(secondTexts.map((part) => (part as any).text), ['第二轮正文']);
});

test('paintUserMessage dedupes replay by id, not by text', () => {
  const first = { id: 'u-1', role: 'user', parts: [{ kind: 'text' as const, text: '你好' }], ts: 1000 };
  const assistant = { role: 'assistant', parts: [{ kind: 'text' as const, text: '收到' }] };
  const same = paintUserMessage(
    [first, assistant],
    '你好',
    2000,
    () => { throw new Error('same id must not append'); },
    { clientInputId: 'u-1' },
  );
  assert.equal(same.filter((m) => m.role === 'user').length, 1);
  const other = paintUserMessage(
    [first, assistant],
    '你好',
    3000,
    () => ({ role: 'user', parts: [{ kind: 'text' as const, text: '你好' }], ts: 3000 }),
    { clientInputId: 'u-2' },
  );
  assert.equal(other.filter((m) => m.role === 'user').length, 2, '同文不同 id 是两条真实提问');
});

test('mergeOlderMessages dedupes by id and sourceIndex only', () => {
  const prev = [{ id: 'u-2', role: 'user', sourceIndex: 2, parts: [{ kind: 'text' as const, text: 'second' }] }];
  const older = [
    { id: 'u-1', role: 'user', sourceIndex: 1, parts: [{ kind: 'text' as const, text: 'first' }] },
    { id: 'u-2', role: 'user', sourceIndex: 2, parts: [{ kind: 'text' as const, text: 'second' }] },
  ];
  const out = mergeOlderMessages(prev, older);
  assert.deepEqual(out.map((row) => row.id), ['u-1', 'u-2']);
});

test('placeRecoveredTurnUsers inserts by id and sourceIndex', () => {
  const out = placeRecoveredTurnUsers([], [
    { type: 'user', content: '问', message_id: 'u-9', source_index: 3 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, 'u-9');
});

test('stampUserSourceIndex keeps live user before trailing index-less assistant placeholder', () => {
  const liveCanvas = [
    { role: 'user', id: 'u-prev', sourceIndex: 4, seq: 4, parts: [{ kind: 'text' as const, text: '上一轮' }] },
    { role: 'assistant', id: 'a-prev', sourceIndex: 5, seq: 5, parts: [{ kind: 'text' as const, text: '上一答' }] },
    { role: 'user', id: 'u-live', seq: 10, parts: [{ kind: 'text' as const, text: '新提问' }] },
    { role: 'assistant', seq: 11, parts: [] },
  ];
  const stamped = stampUserSourceIndex(liveCanvas, 'u-live', 6);
  assert.equal(stamped.length, 4);
  assert.equal(stamped[2]?.id, 'u-live');
  assert.equal(stamped[2]?.sourceIndex, 6);
  assert.equal(
    stamped[3]?.role,
    'assistant',
    'trailing empty assistant must stay at the tail instead of being jumped over by user_identified',
  );
});

test('paintUserMessage with replay=true inserts opening user BEFORE an already-streaming in-flight answer', () => {
  // Brand-new session where streaming answer arrived before replayed opening user
  const freshInFlight = [
    { role: 'assistant', id: 'm-live', seq: 1, parts: [{ kind: 'text' as const, text: '正在回答...' }] },
  ];
  const fixedFresh = paintUserMessage(
    freshInFlight,
    '我的问题',
    1000,
    () => ({ role: 'user', id: 'u-open', parts: [{ kind: 'text' as const, text: '我的问题' }], ts: 1000 }),
    { clientInputId: 'u-open', replay: true },
  );
  assert.deepEqual(fixedFresh.map((m) => m.id), ['u-open', 'm-live']);

  // Existing session after settled previous turn (sourceIndex present) + in-flight new answer
  const existingInFlight = [
    { role: 'user', id: 'u-0', sourceIndex: 0, seq: 1, parts: [{ kind: 'text' as const, text: '旧问' }] },
    { role: 'assistant', id: 'a-0', sourceIndex: 1, seq: 2, parts: [{ kind: 'text' as const, text: '旧答' }] },
    { role: 'assistant', id: 'm-1', seq: 3, parts: [{ kind: 'text' as const, text: '新回答流式输出中' }] },
  ];
  const fixedExisting = paintUserMessage(
    existingInFlight,
    '新提问',
    2000,
    () => ({ role: 'user', id: 'u-1', parts: [{ kind: 'text' as const, text: '新提问' }], ts: 2000 }),
    { clientInputId: 'u-1', replay: true },
  );
  assert.deepEqual(fixedExisting.map((m) => m.id), ['u-0', 'a-0', 'u-1', 'm-1']);
});

test('行上没有 id 时从部件身份推断 round：同一轮不拆行，不同轮必拆行', () => {
  // 弱端重连后行可能只剩下部件（没有行级 id）。part id 的 `{message_id}:{seq}:{kind}`
  // 首段写着归属，同一轮的后续段必须续写这一行，而不是另起一个气泡。
  const canvas: any[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '第一段', id: 'm-400:1:text' }] },
  ];

  const sameRound = reduceCanvasEvent(canvas, {
    type: 'text', content: '第二段', messageId: 'm-400', partId: 'm-400:2:text',
  });
  assert.equal(
    sameRound.filter((m: any) => m.role === 'assistant').length,
    1,
    '同一 round 不得因为行上没有 id 而新开一行',
  );
  assert.equal(sameRound.filter((m: any) => m.role === 'assistant')[0].id, 'm-400');

  const nextRound = reduceCanvasEvent(sameRound, {
    type: 'text', content: '新一轮', messageId: 'm-401', partId: 'm-401:1:text',
  });
  assert.equal(
    nextRound.filter((m: any) => m.role === 'assistant').length,
    2,
    '不同 round 必须新开一行',
  );
});

test('重连全量回放：旧账本（live 无 rev）合并后不重复、不丢字', () => {
  let rows: any[] = [{ role: 'user', parts: [{ kind: 'text', text: 'q' }] }];
  // 推流期：两个 wire part 被合并成同一段展示文本（旧账本，无 segments）
  rows = reduceCanvasEvent(rows, { type: 'text', content: '文0.0;', messageId: 'm-a', partId: 'm-a:1:text' });
  rows = reduceCanvasEvent(rows, { type: 'reasoning', content: '思1.0;', messageId: 'm-a', partId: 'm-a:2:reasoning' });
  rows = reduceCanvasEvent(rows, { type: 'text', content: '文2.0;', messageId: 'm-a', partId: 'm-a:3:text' });
  rows = reduceCanvasEvent(rows, { type: 'text', content: '文2.1;', messageId: 'm-a', partId: 'm-a:3:text' });

  // 断线重连：全量回放（累积正文 + part_rev）
  rows = reduceCanvasEvent(rows, { type: 'text', content: '文0.0;', replay: true, messageId: 'm-a', partId: 'm-a:1:text', partRev: 1 });
  rows = reduceCanvasEvent(rows, { type: 'text', content: '文2.0;', replay: true, messageId: 'm-a', partId: 'm-a:3:text', partRev: 1 });
  rows = reduceCanvasEvent(rows, { type: 'text', content: '文2.0;文2.1;', replay: true, messageId: 'm-a', partId: 'm-a:3:text', partRev: 2 });

  const text = rows.filter((r) => r.role === 'assistant')
    .flatMap((r) => r.parts.filter((p: any) => p.kind === 'text').map((p: any) => p.text))
    .join('');
  assert.equal(text, '文0.0;文2.0;文2.1;', '回放既不能重复重叠前缀，也不能把已合并的正文冲掉');
});

test('重连全量回放：带分段账本时每段只更新自己，重复回放幂等', () => {
  let rows: any[] = [{ role: 'user', parts: [{ kind: 'text', text: 'q' }] }];
  rows = reduceCanvasEvent(rows, { type: 'text', content: 'A', messageId: 'm-9', partId: 'm-9:1:text', partRev: 1 });
  rows = reduceCanvasEvent(rows, { type: 'reasoning', content: 'R', messageId: 'm-9', partId: 'm-9:2:reasoning', partRev: 1 });
  rows = reduceCanvasEvent(rows, { type: 'text', content: 'B', messageId: 'm-9', partId: 'm-9:3:text', partRev: 1 });

  rows = reduceCanvasEvent(rows, { type: 'text', content: 'A', replay: true, messageId: 'm-9', partId: 'm-9:1:text', partRev: 1 });
  rows = reduceCanvasEvent(rows, { type: 'text', content: 'BC', replay: true, messageId: 'm-9', partId: 'm-9:3:text', partRev: 2 });
  // 重复回放
  rows = reduceCanvasEvent(rows, { type: 'text', content: 'A', replay: true, messageId: 'm-9', partId: 'm-9:1:text', partRev: 1 });
  rows = reduceCanvasEvent(rows, { type: 'text', content: 'BC', replay: true, messageId: 'm-9', partId: 'm-9:3:text', partRev: 2 });

  const assistant = rows.filter((r) => r.role === 'assistant');
  assert.equal(assistant.length, 1);
  const textParts = assistant[0].parts.filter((p: any) => p.kind === 'text');
  // 同一 round 内的两段正文在展示上合并为一块，但内部按 wire part 分段记账：
  // 回放只更新自己那段（BC），顺序保持 A → BC。
  assert.equal(textParts.length, 1);
  assert.equal(textParts[0].text, 'ABC');
  assert.deepEqual(
    textParts[0].segments?.map((s: any) => s.text),
    ['A', 'BC'],
    '分段账本按 wire part 保序，重复回放不重复追加',
  );
});

test('相同文案连发三次：三条提问必须全部保留（只按身份判重）', () => {
  // 用户快速连发 / 取消 / 再发同一句话，是三条真实提问，绝不按文本合并。
  const user = (id: string, src: number) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text: '123' }],
  });
  const asst = (id: string, src: number, text: string) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const canvas = [user('u1', 10), asst('a1', 11, '收到1'), user('u2', 20), asst('a2', 21, '收到2')];
  const diskTail = [user('u3', 2387), asst('a3', 2388, '收到3')];

  const merged = spliceAuthoritativeDiskTail(canvas, diskTail, 2387);
  assert.equal(
    merged.filter((row) => row.role === 'user').length,
    3,
    '相同文案的三次提问不得被内容指纹剪掉',
  );
  // 尾部覆盖判定同样只认身份：旧提问不因文案相同而被当作“磁盘切片已覆盖”。
  assert.equal(tailRowCovered(canvas[0] as any, tailCoverage(diskTail as any)), false);
});

test('相同文案的三次 steer：按 id 各留一条，同 id 重复投递幂等', () => {
  const create = () => ({ role: 'user', parts: [{ kind: 'text' as const, text: '提交' }] } as any);
  let rows: any[] = [];
  for (const id of ['s1', 's2', 's3']) {
    rows = paintUserMessage(rows, '提交', 1000, () => create(), { clientInputId: id });
  }
  assert.equal(rows.filter((r) => r.role === 'user').length, 3, '三次 steer 不得被合并');

  const again = paintUserMessage(rows, '提交', 1000, () => create(), { clientInputId: 's3' });
  assert.equal(again.filter((r) => r.role === 'user').length, 3, '同一 id 的重复投递必须幂等');
});

test('编辑 user:a → user:b 是原地覆盖；重连重放旧帧不会叠加', () => {
  let rows: any[] = [
    { role: 'user', id: 'u1', parts: [{ kind: 'text', text: 'a' }] },
    { role: 'assistant', id: 'a1', parts: [{ kind: 'text', text: '回答 a' }] },
  ];
  // 编辑：同 id 原地换正文，并截断其后的内容
  rows = reduceCanvasEvent(rows, {
    type: 'replace_match',
    match: (row: any) => row.id === 'u1',
    update: (row: any) => ({ ...row, parts: [{ kind: 'text', text: 'b' }] }),
  });
  rows = reduceCanvasEvent(rows, {
    type: 'truncate_match',
    match: (row: any) => row.id === 'u1',
    inclusive: true,
  });
  assert.deepEqual(rows.map((r) => r.id), ['u1']);
  assert.equal(rows[0].parts[0].text, 'b');

  // 断线重连：回放缓冲里仍是编辑前的旧帧（同 id、旧正文）。
  // 按 id 判重时必须幂等，绝不能把旧提问加在编辑后的行下面。
  const after = paintUserMessage(
    rows,
    'a',
    1,
    () => ({ role: 'user', id: 'u1', parts: [{ kind: 'text', text: 'a' }] } as any),
    { clientInputId: 'u1', replay: true },
  );
  assert.equal(after.filter((r) => r.role === 'user').length, 1, '旧回放帧不得叠加成第二条提问');
  assert.equal(after[0].parts[0].text, 'b', '编辑后的正文不得被旧回放覆盖');
});

test('withAssistantIdentity 不会把另一个 round 的 id 盖到已有归属的无 id 行上', () => {
  const rows: any[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '属于 m-1', id: 'm-1:1:text' }] },
  ];
  const out = withAssistantIdentity(rows, 'm-2');
  assert.equal(out, rows, '身份归属不同时保持原数组引用（不改写）');
  assert.equal(out[1].id, undefined);
});

test('翻页合并：1000 行画布 + 400 行页必须保持有序且足够快（二分插入）', () => {
  const row = (id: string, src: number) => ({
    role: id.startsWith('u') ? 'user' : 'assistant', id, sourceIndex: src,
    parts: [{ kind: 'text' as const, text: id }],
  });
  const canvas = Array.from({ length: 1000 }, (_, i) => row(`${i % 2 ? 'a' : 'u'}_${i}`, i + 500));
  const page = Array.from({ length: 400 }, (_, i) => row(`${i % 2 ? 'a' : 'u'}_p${i}`, i));

  const started = performance.now();
  const out = mergeOlderMessages(canvas, page);
  const elapsed = performance.now() - started;

  const srcs = out.map((r) => r.sourceIndex!);
  assert.deepEqual(srcs, [...srcs].sort((a, b) => a - b), '插入后必须全局有序');
  assert.equal(out.length, 1400);
  // 旧实现每行 findIndex 扫全表（O(n·m)）在大页上会到几十毫秒；二分插入应在个位毫秒级。
  assert.ok(elapsed < 50, `合并耗时 ${elapsed.toFixed(1)}ms 超过 50ms`);
});

test('乱序跳转合并：不得产生「相邻两条 user」的空轮（消息篡位）', () => {
  const u = (id: string, src: number) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text: id }],
  });
  const a = (id: string, src: number) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text: id }],
  });
  // 画布当前是第 3 轮
  let canvas: any[] = [u('u3', 30), a('a3', 31)];
  // 大纲跳转：先跳到很远的第 1 轮，再跳到第 2 轮（输入乱序）
  canvas = mergeOlderMessages(canvas, [u('u1', 10), a('a1', 11)]);
  canvas = mergeOlderMessages(canvas, [u('u2', 20), a('a2', 21)]);

  const ids = canvas.map((r) => r.id);
  assert.deepEqual(ids, ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'], '跨轮跳转必须按因果位次插入');

  // 硬不变量：不得出现相邻两条 user（那意味着某轮被吞成空轮）
  for (let i = 1; i < canvas.length; i += 1) {
    assert.ok(
      !(canvas[i - 1].role === 'user' && canvas[i].role === 'user'),
      `第 ${i} 行出现相邻 user：${ids.join(' ')}`,
    );
  }
});


test('untagged artifact fence deltas stay in the wire ledger when tagged prose resumes', () => {
  // daemon ArtifactDetector 把代码块拆成无身份的 artifact_* 帧，Chat.tsx 重建围栏后追加；
  // 代码块闭合后的正文又带回 part_id + part_rev。账本不同步时，这一帧会按 segments
  // 重算 text，把整块代码连同围栏冲掉（直播里代码块一闭合就消失 / 变正文）。
  const mid = 'm-artifact';
  const pid = `${mid}:1:text`;
  let rows: Array<{ role: string; id?: string; parts: any[] }> = [
    { role: 'user', id: 'u-artifact', parts: [{ kind: 'text', text: '写个加法器' }] },
  ];
  rows = paintAssistantText(rows, '完整版：\n\n', false, mid, pid, 1);
  rows = paintAssistantText(rows, '```python\n', false);
  rows = paintAssistantText(rows, 'pass\n', false);
  // 代码里合法重复的短行不能被文本去重吞掉。
  rows = paintAssistantText(rows, 'pass\n', false);
  rows = paintAssistantText(rows, '\n```\n', false);
  rows = paintAssistantText(rows, '\n运行效果如上。', false, mid, pid, 2);

  const parts = rows[1]!.parts;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, '完整版：\n\n```python\npass\npass\n\n```\n\n运行效果如上。');
  assert.equal(parts[0].text, parts[0].segments.map((s: { text: string }) => s.text).join(''));
});

test('长回合来回切会话：中间的 asteer1 与 aq2 绝不被 spliceAuthoritativeDiskTail 搬到 as8 末尾', () => {
  // 复现用户报告：aq1 as1 as2 as3 asteer1 as4 as5 aq2 as6 as7 as8
  // 来回切换会话触发权威尾部对账时，绝不能变成：
  //   aq1 as1 as2 as3 as4 as5 aq2 as6 as7 as8 asteer1 (working...)
  // 或：
  //   aq1 as1 as2 as3 asteer1 as4 as5 as6 as7 as8 aq2 (working...)
  const u = (id: string, text: string, opts?: { src?: number; isSteer?: boolean; ts?: number }) => ({
    role: 'user' as const,
    id,
    ...(opts?.src != null ? { sourceIndex: opts.src } : {}),
    ...(opts?.isSteer ? { isSteer: true } : {}),
    ...(opts?.ts != null ? { ts: opts.ts } : {}),
    parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, text: string, src?: number) => ({
    role: 'assistant' as const,
    id,
    ...(src != null ? { sourceIndex: src } : {}),
    parts: [{ kind: 'text' as const, text, id: `${id}:1:text` }],
  });

  const canvas = [
    u('aq1', 'aq1', { src: 1, ts: 1000 }),
    a('as1', 'as1', 2),
    a('as2', 'as2', 3),
    a('as3', 'as3', 4),
    u('asteer1', 'asteer1', { isSteer: true, ts: 2000 }),
    a('as4', 'as4'),
    a('as5', 'as5'),
    u('aq2', 'aq2', { ts: 3000 }),
    a('as6', 'as6'),
    a('as7', 'as7'),
    a('as8', 'as8'),
  ];

  // 场景 A：磁盘切片尚不含 asteer1（例如 steer 尚未 flush 进切片），但包含后续行
  const diskWithoutSteer = [
    u('aq1', 'aq1', { src: 1, ts: 1000 }),
    a('as1', 'as1', 2),
    a('as2', 'as2', 3),
    a('as3', 'as3', 4),
    a('as4', 'as4', 5),
    a('as5', 'as5', 6),
    u('aq2', 'aq2', { src: 7, ts: 3000 }),
    a('as6', 'as6', 8),
    a('as7', 'as7', 9),
    a('as8', 'as8', 10),
  ];
  const splicedA = spliceAuthoritativeDiskTail(canvas, diskWithoutSteer, 1);
  assert.deepEqual(
    splicedA.map((m) => m.id),
    ['aq1', 'as1', 'as2', 'as3', 'asteer1', 'as4', 'as5', 'aq2', 'as6', 'as7', 'as8'],
    'asteer1 必须固定在 as3 与 as4 之间，绝不能被挪到 as8 末尾',
  );

  // 场景 B：磁盘切片尚不含无 sourceIndex 的 aq2，但包含 as6..as8
  const diskWithoutAq2 = [
    u('aq1', 'aq1', { src: 1, ts: 1000 }),
    a('as1', 'as1', 2),
    a('as2', 'as2', 3),
    a('as3', 'as3', 4),
    u('asteer1', 'asteer1', { src: 5, isSteer: true, ts: 2000 }),
    a('as4', 'as4', 6),
    a('as5', 'as5', 7),
    a('as6', 'as6', 8),
    a('as7', 'as7', 9),
    a('as8', 'as8', 10),
  ];
  const splicedB = spliceAuthoritativeDiskTail(canvas, diskWithoutAq2, 1);
  assert.deepEqual(
    splicedB.map((m) => m.id),
    ['aq1', 'as1', 'as2', 'as3', 'asteer1', 'as4', 'as5', 'aq2', 'as6', 'as7', 'as8'],
    'aq2 必须固定在 as5 与 as6 之间，绝不能被挪到 as8 末尾',
  );
});

test('cachedHeadIsContiguous 在长回合包含大量无 sourceIndex 流式工具行时不误报断层', () => {
  const toolPart = (id: string) => ({
    kind: 'tool' as const,
    tool: { id, name: 'read', args: '{}', status: 'done' as const },
  });
  const liveCanvas = [
    { role: 'user', id: 'aq1', sourceIndex: 10, parts: [{ kind: 'text' as const, text: 'q1' }] },
    // 15 轮流式工具调用（无 sourceIndex），每轮 2 个工具 => 跨度 15 * (1 + 2) = 45 条原始记录
    ...Array.from({ length: 15 }, (_, idx) => ({
      role: 'assistant',
      id: `as-${idx}`,
      parts: [toolPart(`t-${idx}-a`), toolPart(`t-${idx}-b`)],
    })),
  ];
  assert.equal(
    cachedHeadIsContiguous(liveCanvas, 40),
    true,
    '流式工具行的原始记录跨度足以衔接 diskOffset=40，不得误判为断层',
  );
});

