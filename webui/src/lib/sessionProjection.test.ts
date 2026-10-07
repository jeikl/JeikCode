import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catchUpSession,
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
