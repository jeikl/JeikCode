import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTurnAssistantEnds,
  composeSteerWireText,
  formatTurnElapsed,
  isSteerUserMessage,
  resolveDoneTurnElapsedMs,
  resumeTurnClockEpoch,
  rootTurnUserTs,
  stampLastAssistantElapsed,
  turnDurationMs,
  turnTotalElapsedMs,
} from './turnTimer.ts';

test('formatTurnElapsed stays in seconds until 60, then rolls to m:ss', () => {
  assert.equal(formatTurnElapsed(0), '0s');
  assert.equal(formatTurnElapsed(999), '0s');
  assert.equal(formatTurnElapsed(1000), '1s');
  assert.equal(formatTurnElapsed(59_000), '59s');
  assert.equal(formatTurnElapsed(60_000), '1:00');
  assert.equal(formatTurnElapsed(61_500), '1:01');
  assert.equal(formatTurnElapsed(12 * 60_000 + 3_000), '12:03');
  assert.equal(formatTurnElapsed(3600_000), '1:00:00');
  assert.equal(formatTurnElapsed(3600_000 + 65_000), '1:01:05');
});

test('stampLastAssistantElapsed writes the latest unstamped assistant only', () => {
  const msgs = [
    { role: 'user' as const },
    { role: 'assistant' as const },
    { role: 'system' as const },
  ];
  const next = stampLastAssistantElapsed(msgs, 4200, 1_700_000_000_000);
  assert.equal(next[1]!.elapsedMs, 4200);
  assert.equal(next[1]!.ts, 1_700_000_000_000);
  assert.equal(next[0]!.elapsedMs, undefined);
  const again = stampLastAssistantElapsed(next, 9999);
  assert.equal(again[1]!.elapsedMs, 4200);
  assert.equal(again, next);
});

test('stampLastAssistantElapsed is a no-op when there is no assistant', () => {
  const msgs = [{ role: 'user' as const }];
  assert.equal(stampLastAssistantElapsed(msgs, 1000), msgs);
});

test('resumeTurnClockEpoch keeps the original user-send time across refresh', () => {
  assert.equal(resumeTurnClockEpoch(1_000_000, 995_000), 995_000);
  assert.equal(resumeTurnClockEpoch(1_000_000, undefined), 1_000_000);
  assert.equal(resumeTurnClockEpoch(1_000_000, 0), 1_000_000);
  assert.equal(resumeTurnClockEpoch(1_000_000, 1_000_500), 1_000_000);
});

test('turnDurationMs is user-bubble to end, not per-agent-round', () => {
  assert.equal(turnDurationMs(1000, 46000), 45000);
  assert.equal(turnDurationMs(undefined, 46000), undefined);
  assert.equal(turnDurationMs(5000, 4000), undefined);
});

test('turnTotalElapsedMs prefers the user-bubble span, else stamped full-turn elapsed', () => {
  assert.equal(turnTotalElapsedMs(1000, 1_201_000, 18_000), 1_200_000);
  assert.equal(turnTotalElapsedMs(undefined, undefined, 1_200_000), 1_200_000);
  assert.equal(turnTotalElapsedMs(5000, 5000, 1_200_000), 1_200_000);
  assert.equal(turnTotalElapsedMs(undefined, 9, undefined), undefined);
});

test('isSteerUserMessage detects explicit tags, pending steer IDs, and steer markers', () => {
  // 普通用户提问
  assert.equal(isSteerUserMessage({ role: 'user', content: '帮我重构代码' }), false);
  assert.equal(
    isSteerUserMessage({ role: 'user', parts: [{ kind: 'text', text: '正常问题' }] }),
    false,
  );

  // 显式标记
  assert.equal(isSteerUserMessage({ role: 'user', isSteer: true }), true);
  assert.equal(isSteerUserMessage({ role: 'user', pendingSteerId: 'steer-123' }), true);

  // 包含 [jeikcode-steer] 或信封
  assert.equal(
    isSteerUserMessage({
      role: 'user',
      content: '<user-query>\n启动服务器\n</user-query>\n\n[jeikcode-steer]\n',
    }),
    true,
  );
  assert.equal(
    isSteerUserMessage({
      role: 'user',
      parts: [{ kind: 'text', text: '换用 sqlite [jeikcode-steer]' }],
    }),
    true,
  );

  // 非 user 角色绝不误判
  assert.equal(isSteerUserMessage({ role: 'assistant', isSteer: true }), false);
});

test('rootTurnUserTs penetrates mid-turn steers and preserves root start timestamp', () => {
  const t0 = 1_000_000; // 09:14 最初提问
  const tSteer1 = 1_060_000; // 09:15 第一次转向 (60s 后)
  const tSteer2 = 1_090_000; // 09:15:30 第二次转向 (90s 后)
  const tEnd = 1_120_000; // 09:16 最终完整 stop (120s 后)

  // 场景 2：中途经历两次 steer，Assistant 当前处于第 5 项
  const messagesWithSteers = [
    { role: 'user', ts: t0, parts: [{ kind: 'text', text: '帮我开发一个新功能' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '正在分析...' }] },
    {
      role: 'user',
      ts: tSteer1,
      isSteer: true,
      parts: [{ kind: 'text', text: '改用方案 B [jeikcode-steer]' }],
    },
    { role: 'assistant', parts: [{ kind: 'text', text: '收到，切换方案 B' }] },
    {
      role: 'user',
      ts: tSteer2,
      pendingSteerId: 'steer-abc',
      parts: [{ kind: 'text', text: '同时启动服务器预览' }],
    },
    { role: 'assistant', parts: [{ kind: 'text', text: '处理完成' }], ts: tEnd },
  ];

  // 为最后的 assistant (index = 5) 寻找根用户提问时间戳
  const rootTs = rootTurnUserTs(messagesWithSteers, 5);
  // 必须穿透两次 steer，精准返回 t0（最初提问时间），而不是 tSteer2 或 tSteer1
  assert.equal(rootTs, t0);

  // 计算实时计时与完成结算计时：必须是完整的 120 秒，而不是最后转向后的 30 秒！
  const fullDuration = turnDurationMs(rootTs, tEnd);
  assert.equal(fullDuration, 120_000);
  assert.equal(turnTotalElapsedMs(rootTs, tEnd, undefined), 120_000);
});

test('rootTurnUserTs starts fresh from 0 for naturally queued turn after previous stop', () => {
  const tTurn1User = 1_000_000;
  const tTurn1End = 1_050_000;
  const tTurn2User = 1_050_000; // 排队消息在上一轮 complete 后自动触发
  const tNow = 1_065_000; // 运行了 15 秒

  // 场景 1：排队自然承接，上一轮已完整结清
  const messagesQueuedHandoff = [
    { role: 'user', ts: tTurn1User, parts: [{ kind: 'text', text: '问题 1' }] },
    { role: 'assistant', ts: tTurn1End, elapsedMs: 50_000, parts: [{ kind: 'text', text: '回答 1' }] },
    { role: 'user', ts: tTurn2User, parts: [{ kind: 'text', text: '排队的第 2 个独立问题' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '正在回答问题 2...' }] },
  ];

  // 为第二轮的 assistant (index = 3) 寻找根用户提问时间戳
  const rootTs = rootTurnUserTs(messagesQueuedHandoff, 3);
  // 必须是本轮自身的提问 tTurn2User，而不是上一轮的 tTurn1User
  assert.equal(rootTs, tTurn2User);

  // 耗时只从本轮提问开始计 (15s)，绝不污染上一轮的耗时
  assert.equal(turnDurationMs(rootTs, tNow), 15_000);
});

test('rootTurnUserTs preserves continuation across disk-restored messages where text was stripped', () => {
  const t0 = 1_000_000;
  const tSteer = 1_100_000;
  const tEnd = 1_300_000;

  // 场景 3：消息从 session/detail (磁盘) 落盘拉回，文本中的 [jeikcode-steer] 已被 strip 干净，
  // 但凭借 isSteer: true 标记依然必须能够向上穿透，精准找回最初提问时间戳！
  const diskRestoredMessages = [
    { role: 'user', ts: t0, parts: [{ kind: 'text', text: '手机端机器人git设置异常 继续' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '分析代码中...' }], ts: 1_050_000 },
    {
      role: 'user',
      ts: tSteer,
      isSteer: true, // 磁盘恢复阶段识别并保留的 isSteer
      parts: [{ kind: 'text', text: '不知道这个问题好不好修' }], // 已经 strip 掉信封标记的纯净用户文本
    },
    { role: 'assistant', parts: [{ kind: 'text', text: '这个问题非常好修...' }], ts: tEnd },
  ];

  const rootTs = rootTurnUserTs(diskRestoredMessages, 3);
  assert.equal(rootTs, t0, '落盘恢复后的消息必须成功穿透中途 steer 提问，找回 t0');
  assert.equal(turnTotalElapsedMs(rootTs, tEnd, undefined), 300_000, '总用时必须是延续后的 300 秒');
});

test('rootTurnUserTs can start a NEW turn at a steer delivered after a real terminal', () => {
  const tRoot = 1_000_000;
  const tStop = 1_120_000;
  const tSteer = 1_150_000;
  const messages = [
    { role: 'user', ts: tRoot, parts: [{ kind: 'text', text: '最初任务' }] },
    { role: 'assistant', ts: tStop, parts: [{ kind: 'text', text: '上一轮最终回答' }] },
    {
      role: 'user',
      ts: tSteer,
      isSteer: true,
      parts: [{ kind: 'text', text: '转向后的新任务' }],
    },
    { role: 'assistant', parts: [] },
  ];

  // Mid-turn semantics (default): a steer continues the continuous work timer.
  assert.equal(rootTurnUserTs(messages, 4), tRoot);
  // The previous turn already stopped: the steer is a NEW root, not a continuation.
  assert.equal(rootTurnUserTs(messages, 4, { penetrateSteers: false }), tSteer);
});

test('durable turnId separates a post-stop steer turn from a mid-turn steer', () => {
  const tRoot = 1_000_000;
  const tStop = 1_100_000;
  const tSteer = 1_150_000;
  const base = [
    { role: 'user', ts: tRoot, turnId: 10, parts: [{ kind: 'text', text: '最初任务' }] },
    { role: 'assistant', ts: tStop, turnId: 10, parts: [{ kind: 'text', text: '上一轮回答' }] },
  ];
  const newTurn = [
    ...base,
    { role: 'user', ts: tSteer, turnId: 11, isSteer: true, parts: [{ kind: 'text', text: 'stop 后转向' }] },
    { role: 'assistant', turnId: 11, parts: [] },
  ];
  assert.equal(rootTurnUserTs(newTurn, 4), tSteer, 'new turn id is a new root');

  const midTurn = [
    ...base,
    { role: 'user', ts: tSteer, turnId: 10, isSteer: true, parts: [{ kind: 'text', text: '运行中转向' }] },
    { role: 'assistant', turnId: 10, parts: [] },
  ];
  assert.equal(rootTurnUserTs(midTurn, 4), tRoot, 'same turn id keeps the continuous timer');
});

test('stampLastAssistantElapsed with overwrite updates cumulative duration at final stop', () => {
  const msgs = [
    { role: 'user' as const, ts: 1_000_000 },
    { role: 'assistant' as const, elapsedMs: 15_000, ts: 1_015_000 },
  ];
  const updated = stampLastAssistantElapsed(msgs, 120_000, 1_120_000, { overwrite: true });
  assert.equal(updated[1]!.elapsedMs, 120_000);
  assert.equal(updated[1]!.ts, 1_120_000);
  assert.equal(turnTotalElapsedMs(1_000_000, updated[1]!.ts, updated[1]!.elapsedMs), 120_000);
});

test('composeSteerWireText attaches steer marker idempotently for send-immediately steer cards', () => {
  const wire = composeSteerWireText('立即发送的转向卡片');
  assert.equal(isSteerUserMessage({ role: 'user', content: wire }), true);
  assert.equal(composeSteerWireText(wire), wire);
});

test('rootTurnUserTs stops penetrating across an intervening assistant with a different turnId', () => {
  const tRoot = 1_000_000;
  const tStop = 1_100_000;
  const tSteerStart = 1_150_000;
  const tSteerMid = 1_180_000;
  const tEnd = 1_210_000;

  // Even when user/steer rows themselves have turnId: undefined (e.g. legacy rows),
  // an intervening assistant carrying turnId: 10 proves Turn 10 finished before Turn 11.
  const msgs = [
    { role: 'user', ts: tRoot, parts: [{ kind: 'text', text: '旧回合提问' }] },
    { role: 'assistant', ts: tStop, turnId: 10, parts: [{ kind: 'text', text: '旧回合完成' }] },
    { role: 'user', ts: tSteerStart, isSteer: true, parts: [{ kind: 'text', text: 'stop 后新回合 steer 1' }] },
    { role: 'assistant', ts: 1_175_000, turnId: 11, parts: [{ kind: 'text', text: 'Turn 11 第一轮' }] },
    { role: 'user', ts: tSteerMid, isSteer: true, parts: [{ kind: 'text', text: 'Turn 11 中途续追问' }] },
    { role: 'assistant', ts: tEnd, turnId: 11, parts: [{ kind: 'text', text: 'Turn 11 完成' }] },
  ];

  // Must penetrate Turn 11's mid-turn steer back to tSteerStart, and stop at asst(turnId=10).
  assert.equal(rootTurnUserTs(msgs, 5), tSteerStart);
});

test('collectTurnAssistantEnds 与 resolveDoneTurnElapsedMs 在新回合运行期间保留所有历史回合耗时', () => {
  // 场景 1：已有两轮已完成的对话，用户刚发出第 3 轮提问（尚未吐出第 3 轮 assistant），此时 busy=true
  const waitingFirstFrame = [
    { role: 'user', ts: 1_000_000 },
    { role: 'assistant', ts: 1_012_000, elapsedMs: 12_000 },
    { role: 'system' }, // 例如压缩分割线或命令通知
    { role: 'user', ts: 2_000_000 },
    { role: 'assistant', ts: 2_035_000, elapsedMs: 35_000 },
    { role: 'user', ts: 3_000_000 },
  ];
  const ends1 = collectTurnAssistantEnds(waitingFirstFrame);
  assert.deepEqual([...ends1.lastInTurnSet].sort((a, b) => a - b), [1, 4]);
  assert.equal(ends1.lastNonSystemIdx, 5);
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends1.lastInTurnSet.has(1),
      isTailNonSystem: 1 === ends1.lastNonSystemIdx,
      busy: true,
      userTs: 1_000_000,
      endTs: 1_012_000,
      elapsedMs: 12_000,
    }),
    12_000,
  );
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends1.lastInTurnSet.has(4),
      isTailNonSystem: 4 === ends1.lastNonSystemIdx,
      busy: true,
      userTs: 2_000_000,
      endTs: 2_035_000,
      elapsedMs: 35_000,
    }),
    35_000,
  );

  // 场景 2：第 3 轮有多段助手输出（工具轮 + 正在流式输出的末尾气泡），且末尾伴随一条 system 通知
  const streamingWithTrailingNotice = [
    { role: 'user', ts: 1_000_000 },
    { role: 'assistant', ts: 1_012_000, elapsedMs: 12_000 },
    { role: 'user', ts: 2_000_000 },
    { role: 'assistant', ts: 2_035_000, elapsedMs: 35_000 },
    { role: 'user', ts: 3_000_000 },
    { role: 'assistant', ts: 3_005_000 },
    { role: 'assistant', ts: 3_010_000 },
    { role: 'system' },
  ];
  const ends2 = collectTurnAssistantEnds(streamingWithTrailingNotice);
  assert.deepEqual([...ends2.lastInTurnSet].sort((a, b) => a - b), [1, 3, 6]);
  assert.equal(ends2.lastNonSystemIdx, 6);
  // 历史回合仍然保留
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends2.lastInTurnSet.has(1),
      isTailNonSystem: 1 === ends2.lastNonSystemIdx,
      busy: true,
      userTs: 1_000_000,
      endTs: 1_012_000,
      elapsedMs: 12_000,
    }),
    12_000,
  );
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends2.lastInTurnSet.has(3),
      isTailNonSystem: 3 === ends2.lastNonSystemIdx,
      busy: true,
      userTs: 2_000_000,
      endTs: 2_035_000,
      elapsedMs: 35_000,
    }),
    35_000,
  );
  // 当前回合的中间助手轮不显示耗时
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends2.lastInTurnSet.has(5),
      isTailNonSystem: 5 === ends2.lastNonSystemIdx,
      busy: true,
      userTs: 3_000_000,
      endTs: 3_005_000,
    }),
    undefined,
  );
  // 当前活跃尾部回合在 busy=true 时不显示完成态耗时（即使末尾有 system 通知）
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends2.lastInTurnSet.has(6),
      isTailNonSystem: 6 === ends2.lastNonSystemIdx,
      busy: true,
      userTs: 3_000_000,
      endTs: 3_010_000,
    }),
    undefined,
  );
  // stop / 完成后（busy=false），尾部回合立即算出完成态耗时
  assert.equal(
    resolveDoneTurnElapsedMs({
      isLastInTurn: ends2.lastInTurnSet.has(6),
      isTailNonSystem: 6 === ends2.lastNonSystemIdx,
      busy: false,
      userTs: 3_000_000,
      endTs: 3_025_000,
      elapsedMs: 25_000,
    }),
    25_000,
  );
});



