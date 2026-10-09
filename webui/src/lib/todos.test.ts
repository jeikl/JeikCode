import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLiveTodoToolCall,
  applyTodoAction,
  foldTodoToolCall,
  isTodoTool,
  parseTodoPlan,
  reduceTodosFromCalls,
  restoreStickyTodos,
  stickyFromDiskCatchUp,
  todoBaselineForLiveApply,
  todoCallIdsFromMessages,
  todoCounts,
} from './todos.ts';

test('parseTodoPlan accepts full list shape', () => {
  const items = parseTodoPlan(
    JSON.stringify({
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    }),
  );
  assert.equal(items?.length, 3);
  assert.equal(items?.[1]?.status, 'in_progress');
});

test('applyTodoAction handles batch actions[] payload', () => {
  let list = applyTodoAction([], JSON.stringify({
    actions: [
      { action: 'add', content: 'task 1' },
      { action: 'add', content: 'task 2' },
      { action: 'update', id: 1, status: 'in_progress' },
    ],
  }));
  assert.equal(list.length, 2);
  assert.equal(list[0]?.content, 'task 1');
  assert.equal(list[0]?.status, 'in_progress');
  assert.equal(list[1]?.content, 'task 2');
  assert.equal(list[1]?.status, 'pending');

  list = applyTodoAction(list, JSON.stringify({
    actions: [
      { action: 'update', id: 1, status: 'completed' },
      { action: 'update', id: 2, status: 'in_progress' },
    ],
  }));
  assert.equal(list[0]?.status, 'completed');
  assert.equal(list[1]?.status, 'in_progress');
});

test('foldTodoToolCall handles actions batch updates in live stream', () => {
  let cur = foldTodoToolCall(
    null,
    'todowrite',
    JSON.stringify({
      actions: [
        { action: 'add', content: 'Step 1' },
        { action: 'add', content: 'Step 2' },
        { action: 'update', id: 1, status: 'in_progress' },
      ],
    }),
  );
  assert.equal(cur?.length, 2);
  assert.equal(cur?.[0]?.status, 'in_progress');

  cur = foldTodoToolCall(
    cur,
    'todowrite',
    JSON.stringify({
      actions: [
        { action: 'update', id: 1, status: 'completed' },
        { action: 'update', id: 2, status: 'in_progress' },
      ],
    }),
  );
  assert.equal(cur?.length, 2);
  assert.equal(cur?.[0]?.status, 'completed');
  assert.equal(cur?.[1]?.status, 'in_progress');
});

test('foldTodoToolCall infers omitted action from fields', () => {
  let cur = foldTodoToolCall(
    null,
    'todo_write',
    JSON.stringify({
      actions: [{ content: 'Step 1' }, { content: 'Step 2' }, { id: 1, status: 'in_progress' }],
    }),
  );
  assert.equal(cur?.length, 2);
  assert.equal(cur?.[0]?.status, 'in_progress');

  cur = foldTodoToolCall(
    cur,
    'todo_write',
    JSON.stringify({
      actions: [
        { id: 1, status: 'completed' },
        { id: 2, status: 'in_progress' },
      ],
    }),
  );
  assert.equal(cur?.[0]?.status, 'completed');
  assert.equal(cur?.[1]?.status, 'in_progress');
});

test('reduceTodosFromCalls uses last plan then actions', () => {
  const list = reduceTodosFromCalls([
    {
      name: 'todowrite',
      args: JSON.stringify({
        todos: [
          { content: 'one', status: 'pending' },
          { content: 'two', status: 'pending' },
        ],
      }),
    },
    {
      name: 'todowrite',
      args: JSON.stringify({ action: 'update', id: 1, status: 'in_progress' }),
    },
    {
      name: 'todowrite',
      args: JSON.stringify({ action: 'update', id: 1, status: 'completed' }),
    },
  ]);
  assert.equal(list[0]?.status, 'completed');
  assert.equal(list[1]?.status, 'pending');
  assert.deepEqual(todoCounts(list), { completed: 1, inProgress: 0, total: 2 });
});

test('foldTodoToolCall replaces on re-plan and patches on action', () => {
  let cur = foldTodoToolCall(
    null,
    'todowrite',
    JSON.stringify({ todos: [{ content: 'x', status: 'pending' }] }),
  );
  assert.equal(cur?.length, 1);
  cur = foldTodoToolCall(
    cur,
    'todowrite',
    JSON.stringify({ action: 'update', id: 1, status: 'in_progress' }),
  );
  assert.equal(cur?.[0]?.status, 'in_progress');
  cur = foldTodoToolCall(
    cur,
    'todowrite',
    JSON.stringify({ todos: [{ content: 'y', status: 'pending' }] }),
  );
  assert.equal(cur?.[0]?.content, 'y');
});

test('applyTodoAction add appends', () => {
  const next = applyTodoAction(
    [{ content: 'a', status: 'pending' }],
    JSON.stringify({ action: 'add', content: 'b' }),
  );
  assert.equal(next.length, 2);
  assert.equal(next[1]?.content, 'b');
});

test('applyTodoAction insert places item between elements', () => {
  const list = [
    { content: 'a', status: 'pending' as const },
    { content: 'c', status: 'pending' as const },
  ];
  const next = applyTodoAction(
    list,
    JSON.stringify({ action: 'insert', position: 2, content: 'b' }),
  );
  assert.equal(next.length, 3);
  assert.equal(next[0]?.content, 'a');
  assert.equal(next[1]?.content, 'b');
  assert.equal(next[2]?.content, 'c');
});

test('applyTodoAction delete, remove, clear', () => {
  const list = [
    { content: 'a', status: 'pending' as const },
    { content: 'b', status: 'in_progress' as const },
    { content: 'c', status: 'completed' as const },
  ];
  const afterDel = applyTodoAction(list, JSON.stringify({ action: 'delete', id: 2 }));
  assert.equal(afterDel.length, 2);
  assert.equal(afterDel[0]?.content, 'a');
  assert.equal(afterDel[1]?.content, 'c');

  const afterRm = applyTodoAction(afterDel, JSON.stringify({ action: 'remove', id: 1 }));
  assert.equal(afterRm.length, 1);
  assert.equal(afterRm[0]?.content, 'c');

  const afterClear = applyTodoAction(afterRm, JSON.stringify({ action: 'clear' }));
  assert.equal(afterClear.length, 0);
});

test('foldTodoToolCall handles clear and delete', () => {
  let cur = foldTodoToolCall(
    null,
    'todowrite',
    JSON.stringify({ todos: [{ content: 'x', status: 'pending' }] }),
  );
  assert.equal(cur?.length, 1);
  cur = foldTodoToolCall(cur, 'todowrite', JSON.stringify({ action: 'clear' }));
  assert.equal(cur, null);
});

test('clear + add + update in one batch replaces the plan', () => {
  const list = applyTodoAction(
    [
      { content: 'old-1', status: 'completed' },
      { content: 'old-2', status: 'in_progress' },
    ],
    JSON.stringify({
      actions: [
        { action: 'clear' },
        { action: 'add', content: 'new-1' },
        { action: 'add', content: 'new-2' },
        { action: 'update', id: 1, status: 'in_progress' },
      ],
    }),
  );
  assert.deepEqual(list, [
    { content: 'new-1', status: 'in_progress' },
    { content: 'new-2', status: 'pending' },
  ]);
});

test('add on a finished list auto-clears so ids restart at 1', () => {
  const list = applyTodoAction(
    [
      { content: 'done-1', status: 'completed' },
      { content: 'done-2', status: 'completed' },
    ],
    JSON.stringify({
      actions: [
        { action: 'add', content: 'next-1' },
        { action: 'add', content: 'next-2' },
        { action: 'update', id: 1, status: 'in_progress' },
      ],
    }),
  );
  assert.deepEqual(list, [
    { content: 'next-1', status: 'in_progress' },
    { content: 'next-2', status: 'pending' },
  ]);
});

test('add+update on a finished list accepts append-style ids', () => {
  const list = applyTodoAction(
    [{ content: '查询沉睡资源客户列表', status: 'completed' }],
    JSON.stringify({
      actions: [
        { action: 'add', content: '导出Excel', id: 2 },
        { action: 'update', id: 2, status: 'in_progress' },
      ],
    }),
  );
  assert.deepEqual(list, [{ content: '导出Excel', status: 'in_progress' }]);
});

test('duplicate titles upsert instead of duplicating', () => {
  const list = applyTodoAction(
    [{ content: '导出Excel', status: 'pending' }],
    JSON.stringify({ actions: [{ action: 'add', content: '  导出Excel  ', status: 'in_progress' }] }),
  );
  assert.deepEqual(list, [{ content: '导出Excel', status: 'in_progress' }]);
});

test('add on an unfinished list does not auto-clear', () => {
  const list = applyTodoAction(
    [
      { content: 'done', status: 'completed' },
      { content: 'open', status: 'pending' },
    ],
    JSON.stringify({ action: 'add', content: 'extra' }),
  );
  assert.equal(list.length, 3);
  assert.equal(list[2]?.content, 'extra');
});

test('clear + delete in one batch is rejected', () => {
  const before = [
    { content: 'a', status: 'pending' as const },
    { content: 'b', status: 'pending' as const },
  ];
  const list = applyTodoAction(
    before,
    JSON.stringify({
      actions: [
        { action: 'clear' },
        { action: 'delete', id: 1 },
      ],
    }),
  );
  assert.deepEqual(list, before);
});

test('multi-turn folding maintains running todo list and supports re-planning', () => {
  // Turn 1: Initial plan with 2 items
  let sessionTodos = foldTodoToolCall(
    null,
    'todowrite',
    JSON.stringify({
      todos: [
        { content: 'task 1', status: 'pending' },
        { content: 'task 2', status: 'pending' },
      ],
    }),
  );
  assert.equal(sessionTodos?.length, 2);
  assert.equal(sessionTodos?.[0]?.status, 'pending');

  // Turn 1 patch: task 1 completed
  sessionTodos = foldTodoToolCall(
    sessionTodos,
    'todowrite',
    JSON.stringify({ action: 'update', id: 1, status: 'completed' }),
  );
  assert.equal(sessionTodos?.[0]?.status, 'completed');
  assert.equal(sessionTodos?.[1]?.status, 'pending');

  // Turn 2: incremental action completing task 2 across turn boundary
  sessionTodos = foldTodoToolCall(
    sessionTodos,
    'todowrite',
    JSON.stringify({ action: 'update', id: 2, status: 'completed' }),
  );
  assert.equal(sessionTodos?.[0]?.status, 'completed');
  assert.equal(sessionTodos?.[1]?.status, 'completed');

  // Turn 3: New plan replaces previous completed session todos
  sessionTodos = foldTodoToolCall(
    sessionTodos,
    'todowrite',
    JSON.stringify({
      todos: [
        { content: 'round 3 task', status: 'in_progress' },
      ],
    }),
  );
  assert.equal(sessionTodos?.length, 1);
  assert.equal(sessionTodos?.[0]?.content, 'round 3 task');
  assert.equal(sessionTodos?.[0]?.status, 'in_progress');
});

test('restoreStickyTodos folds unfinished todowrite rows after a session switch', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            name: 'todowrite',
            args: JSON.stringify({
              todos: [
                { content: 'task 1', status: 'completed' },
                { content: 'task 2', status: 'in_progress' },
                { content: 'task 3', status: 'pending' },
              ],
            }),
          },
        },
      ],
    },
  ];
  const restored = restoreStickyTodos({ messages });
  assert.equal(restored?.length, 3);
  assert.equal(restored?.[1]?.status, 'in_progress');
});

test('incognito restore of completed items 1 and 2 hides the sticky panel', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            id: 'plan',
            name: 'todowrite',
            args: JSON.stringify({
              todos: [
                { content: '任务1', status: 'pending' },
                { content: '任务2', status: 'pending' },
              ],
            }),
          },
        },
        {
          kind: 'tool',
          tool: {
            id: 'done',
            name: 'todowrite',
            args: JSON.stringify({
              actions: [
                { action: 'update', id: 1, status: 'completed' },
                { action: 'update', id: 2, status: 'completed' },
              ],
            }),
          },
        },
      ],
    },
  ];
  assert.equal(restoreStickyTodos({ messages }), null);
  assert.equal(restoreStickyTodos({ messages, stashed: null }), null);
});

test('restoreStickyTodos hides a fully completed plan even if a stash remains', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            name: 'todowrite',
            args: JSON.stringify({
              todos: [{ content: 'done', status: 'completed' }],
            }),
          },
        },
      ],
    },
  ];
  const restored = restoreStickyTodos({
    messages,
    stashed: [{ content: 'stale', status: 'pending' }],
  });
  assert.equal(restored, null);
});

test('restoreStickyTodos keeps the live stash when the tail only has incremental updates', () => {
  const stash = [
    { content: 'task 1', status: 'completed' as const },
    { content: 'task 2', status: 'in_progress' as const },
  ];
  const restored = restoreStickyTodos({
    messages: [
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            tool: {
              name: 'todowrite',
              args: JSON.stringify({ action: 'update', id: 2, status: 'in_progress' }),
            },
          },
        ],
      },
    ],
    stashed: stash,
  });
  assert.deepEqual(restored, stash);
});

test('restoreStickyTodos falls back to an unfinished frozen todo_list part', () => {
  const items = [
    { content: 'open', status: 'pending' as const },
  ];
  const restored = restoreStickyTodos({
    messages: [
      {
        role: 'assistant',
        parts: [{ kind: 'todo_list', items }],
      },
    ],
  });
  assert.deepEqual(restored, items);
});

test('applyLiveTodoToolCall ignores a replayed call id and replaces on a new full plan', () => {
  const plan = JSON.stringify({
    todos: [
      { content: 'old', status: 'pending' },
      { content: 'keep', status: 'pending' },
    ],
  });
  const appliedIds = new Set<string>();
  let cur = applyLiveTodoToolCall({
    current: null,
    name: 'todowrite',
    args: plan,
    callId: 'plan-1',
    appliedIds,
  });
  cur = applyLiveTodoToolCall({
    current: cur,
    name: 'todowrite',
    args: JSON.stringify({ action: 'add', content: 'ghost' }),
    callId: 'plan-1',
    appliedIds,
  });
  assert.equal(cur?.length, 2);
  assert.equal(cur?.some((item) => item.content === 'ghost'), false);

  cur = applyLiveTodoToolCall({
    current: cur,
    name: 'todowrite',
    args: JSON.stringify({
      todos: [{ content: 'fresh', status: 'in_progress' }],
    }),
    callId: 'plan-2',
    appliedIds,
  });
  assert.deepEqual(cur, [{ content: 'fresh', status: 'in_progress' }]);
});

test('stickyFromDiskCatchUp leaves the live panel alone while the turn is running', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            id: 'plan',
            name: 'todowrite',
            args: JSON.stringify({
              todos: [{ content: 'disk', status: 'pending' }],
            }),
          },
        },
      ],
    },
  ];
  assert.equal(
    stickyFromDiskCatchUp({
      running: true,
      messages,
      stashed: [{ content: 'stale', status: 'pending' }],
    }),
    undefined,
  );
  const settled = stickyFromDiskCatchUp({ running: false, messages });
  assert.equal(settled?.[0]?.content, 'disk');
});

test('todoCallIdsFromMessages collects todowrite call ids', () => {
  assert.deepEqual(
    todoCallIdsFromMessages([
      {
        role: 'assistant',
        parts: [
          { kind: 'tool', tool: { id: 'a', name: 'todowrite', args: '{}' } },
          { kind: 'tool', tool: { id: 'b', name: 'bash', args: '{}' } },
        ],
      },
    ]),
    ['a'],
  );
});

test('live todo apply keeps the remembered plan when react state is still empty', () => {
  const plan = [
    { content: '写测试', status: 'completed' as const },
    { content: '修前端', status: 'in_progress' as const },
    { content: '发版', status: 'pending' as const },
    { content: '回归', status: 'pending' as const },
  ];
  const base = todoBaselineForLiveApply(null, plan);
  const applied = new Set<string>();
  const next = applyLiveTodoToolCall({
    current: base,
    name: 'todowrite',
    args: JSON.stringify({
      actions: [{ action: 'update', id: 2, status: 'completed' }, { action: 'update', id: 3, status: 'in_progress' }],
    }),
    callId: 'todo-2',
    appliedIds: applied,
  });
  assert.equal(next?.length, 4);
  assert.equal(next?.[1]?.status, 'completed');
  assert.equal(next?.[2]?.status, 'in_progress');
});

test('settled disk catch-up prefers the server todo list over a short window fold', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            id: 'patch',
            name: 'todowrite',
            args: JSON.stringify({
              actions: [{ action: 'add', content: '只剩这一条', status: 'in_progress' }],
            }),
          },
        },
      ],
    },
  ];
  const server = [
    { content: '一', status: 'completed' as const },
    { content: '二', status: 'completed' as const },
    { content: '三', status: 'in_progress' as const },
    { content: '四', status: 'pending' as const },
  ];
  const settled = stickyFromDiskCatchUp({
    running: false,
    messages,
    authoritativeTodos: server,
  });
  assert.equal(settled?.length, 4);
});

test('isTodoTool correctly recognizes PascalCase TodoWrite and other casing variants', () => {
  assert.equal(isTodoTool('TodoWrite'), true);
  assert.equal(isTodoTool('todowrite'), true);
  assert.equal(isTodoTool('TODO_WRITE'), true);
  assert.equal(isTodoTool('Todo_Write'), true);
  assert.equal(isTodoTool('todo_write'), true);
  assert.equal(isTodoTool('Todo'), true);
  assert.equal(isTodoTool('TODO'), true);
  assert.equal(isTodoTool('todo'), true);
  assert.equal(isTodoTool('bash'), false);
  assert.equal(isTodoTool('read_file'), false);
  assert.equal(isTodoTool(null), false);
  assert.equal(isTodoTool(undefined), false);
});

test('foldTodoToolCall clears active todos on PascalCase TodoWrite with actions clear', () => {
  const initial = [
    { content: '任务1', status: 'completed' as const },
    { content: '任务2', status: 'in_progress' as const },
    { content: '任务3', status: 'pending' as const },
    { content: '任务4', status: 'pending' as const },
    { content: '任务5', status: 'pending' as const },
  ];
  const cleared = foldTodoToolCall(
    initial,
    'TodoWrite',
    JSON.stringify({ actions: [{ action: 'clear' }] }),
  );
  assert.equal(cleared, null);

  // Upper-case CLEAR
  const clearedUpper = foldTodoToolCall(
    initial,
    'TodoWrite',
    JSON.stringify({ actions: [{ action: 'CLEAR' }] }),
  );
  assert.equal(clearedUpper, null);
});

test('applyLiveTodoToolCall does not consume callId when live args are empty, allowing tool_result to apply', () => {
  const appliedIds = new Set<string>();
  const initial = [{ content: '任务1', status: 'pending' as const }];

  // tool_start arrives with empty or incomplete args
  const res1 = applyLiveTodoToolCall({
    current: initial,
    name: 'TodoWrite',
    args: '',
    callId: 'call_clear_1',
    appliedIds,
  });
  assert.deepEqual(res1, initial);
  assert.equal(appliedIds.has('call_clear_1'), false); // not consumed

  // tool_result arrives with final complete clear args
  const res2 = applyLiveTodoToolCall({
    current: res1,
    name: 'TodoWrite',
    args: JSON.stringify({ actions: [{ action: 'clear' }] }),
    callId: 'call_clear_1',
    appliedIds,
  });
  assert.equal(res2, null);
  assert.equal(appliedIds.has('call_clear_1'), true); // now consumed
});



