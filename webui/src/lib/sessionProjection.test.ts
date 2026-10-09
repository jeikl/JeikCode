import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catchUpSession,
  ensureWorkingAssistant,
  foldLiveTodo,
  hydrateSession,
  paintAssistantReasoning,
  paintAssistantText,
  paintUserMessage,
} from './sessionProjection.ts';

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
    { role: 'user', parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }], ts: 1 },
    { role: 'assistant', parts: [{ kind: 'text' as const, text: '收到' }] },
  ];
  const replay = paintUserMessage(settled, 'OK啊 挺好的', 2, () => {
    throw new Error('replay of the open turn must not append');
  });
  assert.equal(replay, settled);

  const again = paintUserMessage(settled, 'OK啊 挺好的', 3, () => ({
    role: 'user',
    parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }],
    ts: 3,
  }), { repeatAfterSettled: true });
  assert.equal(again.filter((message) => message.role === 'user').length, 2);
  assert.equal(again[again.length - 1]?.role, 'assistant');
  assert.equal(again[again.length - 1]?.parts.length, 0);

  const open = [
    { role: 'user', parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }] },
    { role: 'assistant', parts: [] },
  ];
  const echo = paintUserMessage(open, 'OK啊 挺好的', 4, () => {
    throw new Error('echo of the open turn must not append');
  }, { repeatAfterSettled: true });
  assert.equal(echo.filter((message) => message.role === 'user').length, 1);
});

test('an open user turn gets one Working placeholder and keeps it', () => {
  const open = [
    { role: 'user', parts: [{ kind: 'text' as const, text: 'OK啊 挺好的' }] },
  ];
  const withPlaceholder = ensureWorkingAssistant(open);
  assert.equal(withPlaceholder.length, 2);
  assert.equal(withPlaceholder[1]?.role, 'assistant');
  assert.equal(withPlaceholder[1]?.parts.length, 0);
  assert.equal(ensureWorkingAssistant(withPlaceholder), withPlaceholder);
});

test('cold start paints the server checklist and ignores a replayed user and text', () => {
  const disk = [
    { role: 'user', parts: [{ kind: 'text' as const, text: '改用 sqlite' }] },
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
  });
  assert.equal(afterUser.filter((message) => message.role === 'user').length, 1);
  assert.equal(afterUser[afterUser.length - 1]?.role, 'assistant');

  const afterText = paintAssistantText(afterUser, '上一轮正文', true);
  assert.equal(afterText, afterUser);
});

test('running disk catch-up keeps the steer tail and does not repaint an unchanged canvas', () => {
  const previous = { role: 'user', parts: [{ kind: 'text' as const, text: '上一问' }] };
  const done = {
    role: 'assistant',
    parts: [{ kind: 'text' as const, text: '上一轮正文' }],
  };
  const steer = { role: 'user', parts: [{ kind: 'text' as const, text: '继续' }] };
  const live = { role: 'assistant', parts: [{ kind: 'text' as const, text: '正在改' }] };
  const canvas = [previous, done, steer, live];
  const same = catchUpSession({
    messages: canvas,
    disk: [previous, done],
    running: true,
    adoptSettledDisk: false,
    serverTodos: plan,
  });
  assert.equal(same.messages, canvas);
  assert.equal(same.todos, undefined);

  const partial = { role: 'assistant', parts: [{ kind: 'tool' as const, tool: { id: 'b', name: 'bash', args: '', status: 'done' as const } }] };
  const behind = catchUpSession({
    messages: [previous, partial, steer, live],
    disk: [previous, done],
    running: true,
    adoptSettledDisk: false,
    serverTodos: plan,
  });
  assert.equal(behind.messages[1]?.parts.some((part) => part.kind === 'text' && part.text === '上一轮正文'), true);
  assert.equal(behind.messages[1]?.parts.some((part) => part.kind === 'tool' && part.tool?.id === 'b'), true);
  assert.equal(behind.messages[2], steer);
  assert.equal(behind.messages[3], live);
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

test('paintUserMessage skips replayed original user prompt when turn has a steer', () => {
  const originalUser = {
    role: 'user',
    parts: [{ kind: 'text' as const, text: '修复 webui ipv6 缺失' }],
    ts: 1000,
  };
  const assistantTool = {
    role: 'assistant',
    parts: [{ kind: 'tool' as const, tool: { id: 'call_1', name: 'read', status: 'done' as const } }],
  };
  const steerUser = {
    role: 'user',
    parts: [{ kind: 'text' as const, text: '不要动 api_config.rs' }],
    ts: 2000,
  };
  const assistantPending = {
    role: 'assistant',
    parts: [],
  };
  const messages = [originalUser, assistantTool, steerUser, assistantPending];

  // 收到原始提问的 replay 事件时，因原始提问已在画布上，绝不能追加在 steerUser 下方
  const updated = paintUserMessage(
    messages,
    '修复 webui ipv6 缺失',
    1000,
    () => ({ role: 'user', parts: [{ kind: 'text', text: '修复 webui ipv6 缺失' }], ts: 1000 }),
  );
  assert.equal(updated.filter((m) => m.role === 'user').length, 2);
  assert.equal(updated[0], originalUser);
  assert.equal(updated[2], steerUser);
});

test('paintUserMessage never duplicates original user prompt even with mismatched ts and settled tool step after steer', () => {
  const originalUser = {
    role: 'user',
    parts: [{ kind: 'text' as const, text: '你好 请你对比一下各项目设计' }],
    ts: 1791403200000,
  };
  const step1 = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning' as const, text: '深度思考中' },
      { kind: 'tool' as const, tool: { id: 'call_1', name: 'read', status: 'done' as const } },
      { kind: 'text' as const, text: '兄弟目录已确认' },
    ],
  };
  const steerUser = {
    role: 'user',
    parts: [{ kind: 'text' as const, text: 'OK啊' }],
    ts: 1791403260000,
  };
  const step2 = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning' as const, text: '继续执行' },
      { kind: 'tool' as const, tool: { id: 'call_2', name: 'todowrite', status: 'done' as const } },
      { kind: 'tool' as const, tool: { id: 'call_3', name: 'glob', status: 'done' as const } },
    ],
  };
  const messages = [originalUser, step1, steerUser, step2];

  // 此时时间戳偏差达到 2 分钟，且 step2 里的工具都已经 done
  const result = paintUserMessage(
    messages,
    '你好 请你对比一下各项目设计',
    1791403320000, // 2分钟后的新时间戳
    () => {
      throw new Error('must not re-append original prompt below steer!');
    },
  );
  assert.equal(result.filter((m) => m.role === 'user').length, 2);
  assert.equal(result[0]?.parts[0]?.text, '你好 请你对比一下各项目设计');
  assert.equal(result[2]?.parts[0]?.text, 'OK啊');
});

test('paintUserMessage never duplicates original prompt on detached watch / live replay when no steer occurred and tools are done', () => {
  const originalUser = {
    role: 'user',
    parts: [{ kind: 'text' as const, text: '请你扫描我的setup命令 setup命令是啥？' }],
    ts: 1791423600000,
  };
  const assistant = {
    role: 'assistant',
    parts: [
      { kind: 'tool' as const, tool: { id: 'call_1', name: 'grep', status: 'done' as const } },
      { kind: 'tool' as const, tool: { id: 'call_2', name: 'grep', status: 'done' as const } },
    ],
  };
  const messages = [originalUser, assistant];

  // Replay of original prompt with slightly different timestamp or trailing newline
  const result = paintUserMessage(
    messages,
    '请你扫描我的setup命令 setup命令是啥？\n',
    1791423780000,
    () => {
      throw new Error('must not re-append prompt on detached replay!');
    },
  );
  assert.equal(result.filter((m) => m.role === 'user').length, 1);
  assert.equal(result[0]?.parts[0]?.text, '请你扫描我的setup命令 setup命令是啥？');
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

test('paintUserMessage never duplicates multiline user prompt with Windows CRLF vs LF', () => {
  const multilineCRLF = '第一段：不要这个\r\n\r\n第二段：免建清单去掉\r\n- 条目1\r\n- 条目2';
  const multilineLF = '第一段：不要这个\n\n第二段：免建清单去掉\n- 条目1\n- 条目2';

  // Canvas has CRLF from Windows input
  const initial = [
    { role: 'user', parts: [{ kind: 'text' as const, text: multilineCRLF }], ts: 1000 },
    { role: 'assistant', parts: [] },
  ];

  // Incoming SSE echo has normalized LF from daemon
  const result = paintUserMessage(
    initial,
    multilineLF,
    2000,
    () => {
      throw new Error('Should not append duplicate user message');
    },
    { repeatAfterSettled: true },
  );

  assert.equal(result.filter((m) => m.role === 'user').length, 1);
});

test('paintUserMessage never duplicates user prompt while assistant is still reasoning or running tools without text answer', () => {
  const userText = '请帮我实现一个新功能';
  // Assistant is currently reasoning or running tools (turn in flight, no settled text answer)
  const inFlightMessages = [
    { role: 'user', parts: [{ kind: 'text' as const, text: userText }], ts: 1000 },
    {
      role: 'assistant',
      parts: [
        { kind: 'reasoning' as const, text: 'Thinking about the architecture...' },
        { kind: 'tool' as const, tool: { id: 'call_1', name: 'read_file', status: 'pending' as const } },
      ],
    },
  ];

  const result = paintUserMessage(
    inFlightMessages,
    userText,
    1500,
    () => {
      throw new Error('Should not append duplicate user prompt during in-flight reasoning/tools');
    },
    { repeatAfterSettled: true },
  );

  assert.equal(result.filter((m) => m.role === 'user').length, 1);
});



