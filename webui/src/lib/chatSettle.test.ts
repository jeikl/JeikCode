import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lastAssistantTextLen,
  ownsRunningLocalSend,
  shouldAdoptAuthoritativeTail,
  tailAssistantHasUnresolvedTools,
} from './chatSettle.ts';
import {
  mergeDiskWithUnpersistedTail,
  transcriptHasInFlightAssistant,
} from './chatTerminal.ts';
import { spliceAuthoritativeDiskTail } from './sessionProjection.ts';

type Part = {
  kind: string;
  text?: string;
  tool?: { id?: string; name?: string; status?: string; output?: string };
};
type Row = {
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Part[];
  sourceIndex?: number;
};

/** 手机画布：断网前只画到 RunCommand 的实时输出，之后一帧都没收到。 */
const phoneCanvas = (): Row[] => [
  { id: 'u1', role: 'user', sourceIndex: 0, parts: [{ kind: 'text', text: '运行 sleep120s 后输出 helloworld' }] },
  {
    id: 'a1',
    role: 'assistant',
    sourceIndex: 1,
    parts: [
      { kind: 'text', text: '好的，我开始尝试写脚本' },
      { kind: 'tool', tool: { id: 'call_write', name: 'Write', status: 'done' } },
      { kind: 'reasoning', text: 'Thinking' },
      {
        kind: 'tool',
        tool: {
          id: 'call_bash',
          name: 'RunCommand',
          status: 'pending',
          output: '[still running: 20s total, 20s without output (pid 8268)]',
        },
      },
    ],
  },
];

/** 服务端磁盘：回合已结算（sleep 结束、helloworld 已输出、loop 已停）。 */
const settledDisk = (): Row[] => {
  const canvas = phoneCanvas();
  return [
    canvas[0]!,
    {
      ...canvas[1]!,
      parts: [
        { kind: 'text', text: '好的，我开始尝试写脚本' },
        { kind: 'tool', tool: { id: 'call_write', name: 'Write', status: 'done' } },
        { kind: 'reasoning', text: 'Thinking' },
        { kind: 'tool', tool: { id: 'call_bash', name: 'RunCommand', status: 'done', output: 'helloworld' } },
        { kind: 'text', text: 'helloworld 已输出，任务完成。' },
      ],
    },
  ];
};

test('BUG1: 非空画布断流后必须采用磁盘权威尾部（僵尸工具行 + 缺失尾段）', () => {
  const canvas = phoneCanvas();
  const disk = settledDisk();
  assert.equal(transcriptHasInFlightAssistant(canvas), true);
  assert.equal(transcriptHasInFlightAssistant(disk), false);

  const adopt = shouldAdoptAuthoritativeTail({
    running: false,
    diskHasUser: true,
    diskSettled: true,
    canvasInFlight: transcriptHasInFlightAssistant(canvas),
    diskLastTextLen: lastAssistantTextLen(disk),
    canvasLastTextLen: lastAssistantTextLen(canvas),
  });
  assert.equal(adopt, true, '非空画布也必须对账，否则僵尸工具行永久保留');

  const spliced = spliceAuthoritativeDiskTail(canvas, disk, 0);
  const repaired = mergeDiskWithUnpersistedTail(spliced, canvas);
  assert.equal(
    repaired.some((m) => m.parts.some((p) => p.kind === 'tool' && p.tool?.status === 'pending')),
    false,
    'RunCommand 必须回到完成态',
  );
  assert.equal(
    repaired.some((m) => m.parts.some((p) => p.kind === 'text' && (p.text ?? '').includes('任务完成'))),
    true,
    '断流期间错过的最终回答必须回补',
  );
});

test('会话仍在跑 / 磁盘还停在上一轮时绝不对账', () => {
  const base = {
    running: false,
    diskHasUser: true,
    diskSettled: true,
    canvasInFlight: true,
    diskLastTextLen: 50,
    canvasLastTextLen: 10,
  };
  assert.equal(shouldAdoptAuthoritativeTail({ ...base, running: true }), false);
  assert.equal(shouldAdoptAuthoritativeTail({ ...base, diskHasUser: false }), false);
  assert.equal(shouldAdoptAuthoritativeTail({ ...base, diskSettled: false }), false);
});

test('磁盘尚未回落盘（更短的旧尾部）不得覆盖画布刚流出的正文', () => {
  assert.equal(
    shouldAdoptAuthoritativeTail({
      running: false,
      diskHasUser: true,
      diskSettled: true,
      canvasInFlight: false,
      diskLastTextLen: 20,
      canvasLastTextLen: 120,
    }),
    false,
  );
});

test('画布尾部完整但磁盘有更新的一段回答时才补尾', () => {
  assert.equal(
    shouldAdoptAuthoritativeTail({
      running: false,
      diskHasUser: true,
      diskSettled: true,
      canvasInFlight: false,
      diskLastTextLen: 120,
      canvasLastTextLen: 20,
    }),
    true,
  );
});

test('观察流条目不得被当作本端回合（否则收尾永久被拦）', () => {
  const open = { signal: { aborted: false } };
  assert.equal(ownsRunningLocalSend({ watchOnly: true, abortController: open }), false);
  assert.equal(ownsRunningLocalSend({ abortController: open }), true);
  assert.equal(
    ownsRunningLocalSend({ abortController: { signal: { aborted: true } } }),
    false,
  );
  assert.equal(ownsRunningLocalSend(undefined), false);
});

test('收尾成 incomplete 的僵尸工具行也要允许磁盘权威结果覆盖', () => {
  // 正文长度一模一样，只能靠「尾部有未完成工具行」触发对账，否则没结果的假完成/未完成会永久留着。
  assert.equal(
    shouldAdoptAuthoritativeTail({
      running: false,
      diskHasUser: true,
      diskSettled: true,
      canvasInFlight: false,
      canvasUnresolvedTools: true,
      diskLastTextLen: 20,
      canvasLastTextLen: 20,
    }),
    true,
  );
  // 会话仍在跑时依旧一律不对账。
  assert.equal(
    shouldAdoptAuthoritativeTail({
      running: true,
      diskHasUser: true,
      diskSettled: true,
      canvasInFlight: false,
      canvasUnresolvedTools: true,
      diskLastTextLen: 20,
      canvasLastTextLen: 20,
    }),
    false,
  );
});

test('tailAssistantHasUnresolvedTools 只看尾部助手行，历史中断行不干扰', () => {
  const history = [
    { role: 'assistant', parts: [{ kind: 'tool', tool: { status: 'incomplete' } }] },
    { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: 'done' }] },
  ];
  assert.equal(tailAssistantHasUnresolvedTools(history), false);
  assert.equal(
    tailAssistantHasUnresolvedTools([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
      { role: 'assistant', parts: [{ kind: 'tool', tool: { status: 'incomplete' } }] },
    ]),
    true,
  );
});

test('lastAssistantTextLen 只看最后一条助手正文/思考', () => {  const rows: Row[] = [
    { role: 'assistant', parts: [{ kind: 'text', text: '12345' }] },
    { role: 'user', parts: [{ kind: 'text', text: 'ignored' }] },
    { role: 'assistant', parts: [{ kind: 'reasoning', text: 'abc' }, { kind: 'text', text: 'de' }] },
  ];
  assert.equal(lastAssistantTextLen(rows), 5);
  assert.equal(lastAssistantTextLen([]), 0);
});
