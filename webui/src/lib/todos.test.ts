import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLiveTodoToolCall,
  applyTodoAction,
  foldTodoToolCall,
  isTodoTool,
  parseTodoPlan,
  parseTodosFromOutput,
  placeArchivedTodos,
  reduceLiveTodo,
  reduceTodosFromCalls,
  restoreStickyTodos,
  settleLiveTodo,
  stickyFromDiskCatchUp,
  stickyTodosAfterTerminal,
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

test('add on a finished list appends smoothly without breaking chain', () => {
  const list = applyTodoAction(
    [
      { content: 'done-1', status: 'completed' },
      { content: 'done-2', status: 'completed' },
    ],
    JSON.stringify({
      actions: [
        { action: 'add', content: 'next-1' },
        { action: 'add', content: 'next-2' },
        { action: 'update', id: 3, status: 'in_progress' },
      ],
    }),
  );
  assert.deepEqual(list, [
    { content: 'done-1', status: 'completed' },
    { content: 'done-2', status: 'completed' },
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
  assert.deepEqual(list, [
    { content: '查询沉睡资源客户列表', status: 'completed' },
    { content: '导出Excel', status: 'in_progress' },
  ]);
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

test('stickyTodosAfterTerminal keeps the full list when partially complete', () => {
  const items = [
    ...Array.from({ length: 8 }, (_, index): { content: string; status: 'completed' } => ({
      content: `done ${index}`,
      status: 'completed',
    })),
    { content: 'left 1', status: 'in_progress' as const },
    { content: 'left 2', status: 'pending' as const },
  ];

  const panel = stickyTodosAfterTerminal(items);
  assert.equal(panel?.length, 10, 'Stop 时 sticky 面板必须保留完整 10 项');
  assert.equal(
    panel?.filter((item) => item.status === 'completed').length,
    8,
    '已完成项不能被裁掉',
  );

  assert.equal(
    stickyTodosAfterTerminal(items.map((item) => ({ ...item, status: 'completed' as const }))),
    null,
    '全部完成 = 已归档，不再粘回输入区',
  );
  assert.equal(stickyTodosAfterTerminal([]), null);
  assert.equal(stickyTodosAfterTerminal(null), null);
});

test('restoreStickyTodos does not resurrect a checklist from archived tool rows', () => {
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
  assert.equal(restoreStickyTodos({ messages }), null);
  const fromServer = restoreStickyTodos({
    messages,
    authoritativeTodos: [
      { content: 'task 1', status: 'completed' },
      { content: 'task 2', status: 'in_progress' },
      { content: 'task 3', status: 'pending' },
    ],
  });
  assert.equal(fromServer?.length, 3);
  assert.equal(fromServer?.[1]?.status, 'in_progress');
  assert.equal(
    restoreStickyTodos({
      messages: [],
      authoritativeTodos: [],
    }),
    null,
  );
  assert.equal(
    restoreStickyTodos({
      messages: [],
      authoritativeTodos: [{ content: 'done', status: 'completed' }],
    })?.length,
    1,
  );
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

test('server snapshot replaces a stale in-memory list', () => {
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
  assert.equal(
    restoreStickyTodos({
      messages,
      stashed: [{ content: 'stale', status: 'pending' }],
      authoritativeTodos: [],
    }),
    null,
  );
  assert.equal(
    restoreStickyTodos({
      messages,
      stashed: [{ content: 'stale', status: 'pending' }],
      authoritativeTodos: [{ content: 'live', status: 'in_progress' }],
    })?.[0]?.content,
    'live',
  );
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

test('restoreStickyTodos ignores a frozen todo_list part', () => {
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
  assert.equal(restored, null);
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
  assert.equal(settled, null);
  const fromServer = stickyFromDiskCatchUp({
    running: false,
    messages,
    authoritativeTodos: [{ content: 'disk', status: 'pending' }],
  });
  assert.equal(fromServer?.[0]?.content, 'disk');
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

test('a replayed plan call never reverts a completed list once its call id is applied', () => {
  const planArgs = JSON.stringify({
    todos: [
      { content: '任务一', status: 'pending' },
      { content: '任务二', status: 'pending' },
    ],
  });
  const doneArgs = JSON.stringify({
    actions: [
      { action: 'update', id: 1, status: 'completed' },
      { action: 'update', id: 2, status: 'completed' },
    ],
  });

  // 直播：plan（全 pending）→ 全完成。幂等键随折叠记下两个 callId
  // （持久化与"全完成不清空"由 Chat.tsx + todoAppliedIds 负责）。
  const appliedIds = new Set<string>();
  const planned = applyLiveTodoToolCall({
    current: null,
    name: 'todowrite',
    args: planArgs,
    callId: 'call-plan',
    appliedIds,
  });
  const completed = applyLiveTodoToolCall({
    current: planned,
    name: 'todowrite',
    args: doneArgs,
    callId: 'call-upd',
    appliedIds,
  });
  assert.ok(completed && completed.every((t) => t.status === 'completed'));

  // 刷新后的 watch 整轮重放：plan 帧必须被幂等键拦住，
  // 否则 todo 会定格在"模型之前某一次打钩状态"。
  const replayedPlan = applyLiveTodoToolCall({
    current: completed,
    name: 'todowrite',
    args: planArgs,
    callId: 'call-plan',
    appliedIds,
  });
  assert.deepEqual(replayedPlan, completed, '已完成的清单不得被重放回退');
  const replayedUpdate = applyLiveTodoToolCall({
    current: replayedPlan,
    name: 'todowrite',
    args: doneArgs,
    callId: 'call-upd',
    appliedIds,
  });
  assert.deepEqual(replayedUpdate, completed, '整轮重放后状态一字不变（幂等）');
});

test('applyTodoAction preserves in-progress list when batch adds multiple items', () => {
  const initialList: TodoItem[] = [
    { content: 'task-1', status: 'completed' },
    { content: 'task-2', status: 'completed' },
    { content: 'task-3', status: 'in_progress' },
  ];

  const followUpArgs = JSON.stringify({
    actions: [
      { action: 'update', id: 3, status: 'completed' },
      { action: 'add', content: 'task-4' },
      { action: 'add', content: 'task-5' },
      { action: 'add', content: 'task-6' },
    ],
  });

  const next = applyTodoAction(initialList, followUpArgs);
  assert.equal(next.length, 6, '进行中的任务列表在追加多个任务时绝不能被清空');
  assert.equal(next[0]?.content, 'task-1');
  assert.equal(next[2]?.content, 'task-3');
  assert.equal(next[2]?.status, 'completed');
  assert.equal(next[3]?.content, 'task-4');
  assert.equal(next[5]?.content, 'task-6');
});

test('reduceTodosFromCalls preserves in-progress list across mid-turn multi-add batches', () => {
  const calls = [
    {
      name: 'todo_write',
      args: JSON.stringify({
        actions: [
          { action: 'add', content: 'task-1', status: 'completed' },
          { action: 'add', content: 'task-2', status: 'completed' },
          { action: 'add', content: 'task-3', status: 'in_progress' },
        ],
      }),
    },
    {
      name: 'todo_write',
      args: JSON.stringify({
        actions: [
          { action: 'update', id: 3, status: 'completed' },
          { action: 'add', content: 'task-4' },
          { action: 'add', content: 'task-5' },
          { action: 'add', content: 'task-6' },
        ],
      }),
    },
  ];

  const reduced = reduceTodosFromCalls(calls);
  assert.equal(reduced.length, 6, 'reduceTodosFromCalls 遇到多项追加批次不得作为 baseline 抹除既有任务');
  assert.equal(reduced[0]?.content, 'task-1');
  assert.equal(reduced[2]?.content, 'task-3');
  assert.equal(reduced[2]?.status, 'completed');
  assert.equal(reduced[3]?.content, 'task-4');
  assert.equal(reduced[5]?.content, 'task-6');
});

test('applyTodoAction preserves completed list when new batch adds multiple items', () => {
  const finishedList: TodoItem[] = [
    { content: 'old-1', status: 'completed' },
    { content: 'old-2', status: 'completed' },
  ];

  const newPlanArgs = JSON.stringify({
    actions: [
      { action: 'add', content: 'new-1' },
      { action: 'add', content: 'new-2' },
    ],
  });

  const next = applyTodoAction(finishedList, newPlanArgs);
  assert.equal(next.length, 4, '全部已完成的旧列表在追加新任务时应平滑追加，绝不断链');
  assert.equal(next[0]?.content, 'old-1');
  assert.equal(next[1]?.content, 'old-2');
  assert.equal(next[2]?.content, 'new-1');
  assert.equal(next[3]?.content, 'new-2');
});

test('restoreStickyTodos respects empty authoritativeTodos array and does not fall back to stashed', () => {
  const stashed: TodoItem[] = [
    { content: 'stale task 1', status: 'pending' },
    { content: 'stale task 2', status: 'in_progress' },
  ];
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            name: 'todo_write',
            args: JSON.stringify({
              actions: [{ action: 'add', content: 'stale task 1' }],
            }),
          },
        },
      ],
    },
  ];

  // 服务端返回权威空清单 []
  const restored = restoreStickyTodos({
    messages,
    stashed,
    authoritativeTodos: [],
  });
  assert.equal(restored, null, '服务端权威清单为空数组时代表无活跃待办，严禁回退 stashed 脏缓存');
});

test('reduceTodosFromCalls ignores stashed fallback when calls define add actions to prevent replay duplication', () => {
  // Stashed state where titles were updated to "修复"
  const stashed: TodoItem[] = [
    { content: 'Bug 1: 修复', status: 'completed' },
    { content: 'Bug 2: 修复', status: 'completed' },
    { content: 'Bug 3: 修复', status: 'in_progress' },
    { content: 'Bug 4: 排查', status: 'pending' },
    { content: '系统测试', status: 'pending' },
  ];

  // Calls from the session transcript (starting with initial "排查" add actions)
  const calls = [
    {
      name: 'todo_write',
      args: JSON.stringify({
        actions: [
          { action: 'add', content: 'Bug 1: 排查', status: 'in_progress' },
          { action: 'add', content: 'Bug 2: 排查', status: 'pending' },
          { action: 'add', content: 'Bug 3: 排查', status: 'pending' },
          { action: 'add', content: 'Bug 4: 排查', status: 'pending' },
          { action: 'add', content: '系统测试', status: 'pending' },
        ],
      }),
    },
    {
      name: 'todo_write',
      args: JSON.stringify({
        actions: [{ id: 1, action: 'update', content: 'Bug 1: 修复', status: 'completed' }],
      }),
    },
    {
      name: 'todo_write',
      args: JSON.stringify({
        actions: [{ id: 2, action: 'update', content: 'Bug 2: 修复', status: 'completed' }],
      }),
    },
    {
      name: 'todo_write',
      args: JSON.stringify({
        actions: [{ id: 3, action: 'update', content: 'Bug 3: 修复', status: 'in_progress' }],
      }),
    },
  ];

  const folded = reduceTodosFromCalls(calls, stashed);
  assert.equal(
    folded.length,
    5,
    '当调用流自带完整 add 起点时，严禁叠加在 stashed 垫底列表上导致 A B C D E A B C D 重复重放',
  );
  assert.equal(folded[0]?.content, 'Bug 1: 修复');
  assert.equal(folded[0]?.status, 'completed');
  assert.equal(folded[1]?.content, 'Bug 2: 修复');
  assert.equal(folded[1]?.status, 'completed');
  assert.equal(folded[2]?.content, 'Bug 3: 修复');
  assert.equal(folded[2]?.status, 'in_progress');
  assert.equal(folded[3]?.content, 'Bug 4: 排查');
  assert.equal(folded[4]?.content, '系统测试');
});

test('parseTodosFromOutput extracts authoritative numbered list across various glyphs', () => {
  const sample = `#4 -> completed
#5 -> completed

[ ] 1. 任务一：待办事项
[~] 2. 任务二：正在进行
[•] 3. 任务三：符号进行
[√] 4. 任务四：打钩完成
[x] 5. 任务五：字母完成
[v] 6. 任务六：小写完成`;

  const parsed = parseTodosFromOutput(sample);
  assert.equal(parsed?.length, 6);
  assert.equal(parsed?.[0]?.status, 'pending');
  assert.equal(parsed?.[0]?.content, '任务一：待办事项');
  assert.equal(parsed?.[1]?.status, 'in_progress');
  assert.equal(parsed?.[2]?.status, 'in_progress');
  assert.equal(parsed?.[3]?.status, 'completed');
  assert.equal(parsed?.[4]?.status, 'completed');
  assert.equal(parsed?.[5]?.status, 'completed');
});

test('archived tool output does not resurrect the live panel', () => {
  const messages = [
    {
      role: 'assistant',
      parts: [
        {
          kind: 'tool',
          tool: {
            id: 'call_1',
            name: 'todo_write',
            args: JSON.stringify({ actions: [{ action: 'add', content: '旧规划' }] }),
            output: `[ ] 1. 真实后端清单 A
[~] 2. 真实后端清单 B`,
          },
        },
      ],
    },
  ];

  assert.equal(restoreStickyTodos({ messages }), null);
  const preview = reduceLiveTodo(null, {
    type: 'preview',
    callId: 'call_1',
    items: [
      { content: '真实后端清单 A', status: 'pending' },
      { content: '真实后端清单 B', status: 'in_progress' },
    ],
  });
  const replayedPreview = reduceLiveTodo(preview, {
    type: 'preview',
    callId: 'call_1',
    items: [{ content: 'ghost', status: 'pending' }],
  });
  assert.equal(replayedPreview, preview);
  const result = reduceLiveTodo(preview, {
    type: 'result',
    callId: 'call_1',
    items: [
      { content: '真实后端清单 A', status: 'completed' },
      { content: '真实后端清单 B', status: 'completed' },
    ],
  });
  assert.equal(result?.resultApplied, true);
  assert.equal(reduceLiveTodo(result, {
    type: 'result',
    callId: 'call_1',
    items: [{ content: 'ghost', status: 'pending' }],
  }), result);
  const settled = settleLiveTodo(result);
  assert.equal(settled.next, null);
  assert.equal(settled.archive?.length, 2);
  assert.equal(settleLiveTodo(reduceLiveTodo(null, {
    type: 'result',
    callId: 'open',
    items: [{ content: 'still', status: 'in_progress' }],
  })).archive, null);
  const placed = placeArchivedTodos(
    [
      { role: 'assistant', parts: [{ kind: 'tool', tool: { id: 'call_1' } }] },
      { role: 'user', parts: [{ kind: 'text' }] },
      { role: 'assistant', parts: [{ kind: 'text' }] },
    ],
    settled.archive ?? [],
    'call_1',
  );
  assert.equal(placed[0]!.parts.some((part) => part.kind === 'todo_list'), false);
  assert.equal(placed[2]!.parts.some((part) => part.kind === 'todo_list'), true);

  // A natural steer can append an EMPTY assistant placeholder before the old
  // terminal commits its todo archive. The completed plan belongs to the
  // previous answer, NOT the new loop's placeholder.
  const steerPlaced = placeArchivedTodos(
    [
      { role: 'user', parts: [{ kind: 'text', text: '上一问' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: '上一答' }] },
      { role: 'user', parts: [{ kind: 'text', text: 'steer 自然发出' }] },
      { role: 'assistant', parts: [] },
    ],
    settled.archive ?? [],
    'call_1',
  );
  assert.equal(
    steerPlaced[1]!.parts.some((part) => part.kind === 'todo_list'),
    true,
    'archive must land on the previous answer',
  );
  assert.equal(
    steerPlaced[3]!.parts.some((part) => part.kind === 'todo_list'),
    false,
    'an empty next-loop placeholder must never receive the old todo list',
  );
  assert.equal(placed[2]!.parts.filter((part) => part.kind === 'todo_list').length, 1);
});







