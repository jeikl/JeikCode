import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatRecoveryPolicy,
  classifyChatDone,
  createLiveLifecycleState,
  isCurrentChatStream,
  liveDetachDisposition,
  liveSessionSwitchDisposition,
  reduceChatRecovery,
  resolveUserInputRequest,
  resolveTokenCache,
  formatCacheHitRate,
  estimatePrefixCached,
  estimateLocalCached,
  estimateCacheFromHistoryPrompt,
  createTokenCacheState,
  resetTokenCacheState,
  clampCachedToPrompt,
  isStackedTurnBillingUsage,
  userMessageAlreadyOnCanvas,
  visibleUserText,
  findPaintedUserRow,
  queueCardAlreadyDelivered,
  queueCardAlreadyOnCanvas,
  queueCardPresentInOutline,
  steerCardBubbleOnCanvas,
  unpaintedReplaySuffix,
  mergeDiskWithUnpersistedTail,
  mergeAuthoritativeTail,
  findCausalGap,
  shouldClearCanvasOnSwitch,
  diskCoversCanvasTail,
  stayOnNewSessionLanding,
  resumeTurnStartedAt,
  transcriptHasInFlightAssistant,
  shouldKeepCachedTranscript,
  thisTabOwnsTurn,
  shouldLockSendAsDetached,
  isWatchTurnActivationEvent,
  transcriptHasOpenUserTurn,
  sessionAssignedClaimsLocalTurn,
  toolResultClearsUserInput,
  transcriptLatestUserInputIsResolved,
  transcriptToolCallIsResolved,
  dropSnapshotDuplicates,
  userTextsMatch,
  findPendingSelfEchoIndex,
} from './chatTerminal.ts';
import { spliceAuthoritativeDiskTail } from './sessionProjection.ts';

test('pending or local-only steer outline does not consume its queue card', () => {
  const pending = [{ id: 'steer-1', pending: true }];
  const provisional = [{ id: 'steer-1', provisional: true }];
  const folded = [{ id: 'steer-1', pending: false }];
  const legacySettled = [{ id: 'steer-1' }];
  assert.equal(queueCardPresentInOutline(pending, 'steer-1'), false);
  assert.equal(queueCardPresentInOutline(provisional, 'steer-1'), false);
  assert.equal(queueCardPresentInOutline(folded, 'steer-1'), true);
  assert.equal(queueCardPresentInOutline(legacySettled, 'steer-1'), true);
});

test('legacy done and stopped are natural completions that preserve queued messages', () => {
  assert.deepEqual(classifyChatDone({}), {
    kind: 'completed',
    discardQueued: false,
  });
  assert.deepEqual(classifyChatDone({ stopReason: 'stopped' }), {
    kind: 'completed',
    discardQueued: false,
  });
});

test('budget and loop-guard terminals are incomplete and discard queued messages', () => {
  assert.deepEqual(
    classifyChatDone({
      stopReason: 'max_rounds',
      message: 'Turn reached its round budget',
    }),
    {
      kind: 'incomplete',
      discardQueued: true,
      detail: 'Turn reached its round budget',
    },
  );

  for (const stopReason of ['max_continuations', 'repeat_loop', 'tool_loop_detected']) {
    assert.deepEqual(classifyChatDone({ stopReason }), {
      kind: 'incomplete',
      discardQueued: true,
      detail: stopReason,
    });
  }
});

test('user cancellation settles the turn without the incomplete notice', () => {
  for (const reason of ['cancelled', 'manual_stop', 'interrupted_by_user']) {
    assert.deepEqual(classifyChatDone({ stopReason: reason }), {
      kind: 'cancelled',
      discardQueued: true,
      detail: reason,
    });
  }
  // A diagnostic message rides along as detail only: the terminal stays a
  // user-driven cancel, so no yellow "turn incomplete" banner is painted.
  assert.deepEqual(
    classifyChatDone({ stopReason: 'cancelled', message: 'stopped by user' }),
    {
      kind: 'cancelled',
      discardQueued: true,
      detail: 'stopped by user',
    },
  );
});

test('agent stop 终态对账回归矩阵：历史回答绝不被灌到对话底部', () => {
  const u = (id: string, src: number, text = id) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, src: number, text = id) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const t = (id: string, src: number, call: string) => ({
    role: 'tool', id, sourceIndex: src,
    parts: [{ kind: 'tool' as const, tool: { id: call, name: 'RunCommand', args: '{}', status: 'done' as const } }],
  });
  const finalTurn = [u('u1', 0), a('a1', 1), u('u2', 2), a('a2', 3)];

  // 写盘落后 / 当前回合未写全 / 旧副本 / 重复对账幂等
  assert.deepEqual(mergeAuthoritativeTail(finalTurn.slice(0, 2) as any, finalTurn as any, 0).map((r: any) => r.id), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(mergeAuthoritativeTail(finalTurn.slice(0, 3) as any, finalTurn as any, 0).map((r: any) => r.id), ['u1', 'a1', 'u2', 'a2']);
  const withDup = [...finalTurn.map((r) => ({ ...r })), a('a1', 1, '旧副本')];
  assert.deepEqual(mergeAuthoritativeTail(finalTurn as any, withDup as any, 0).map((r: any) => r.id), ['u1', 'a1', 'u2', 'a2']);
  const once = mergeAuthoritativeTail(finalTurn.slice(0, 3) as any, finalTurn as any, 0);
  assert.deepEqual(mergeAuthoritativeTail(finalTurn.slice(0, 3) as any, once as any, 0).map((r: any) => r.id), once.map((r: any) => r.id));

  // 带更早下标的旧回答：绝不能落到末尾
  const withEarlier = [...finalTurn.map((r) => ({ ...r })), a('a0', 0, '很早的回答')];
  const earlierOut = mergeAuthoritativeTail(finalTurn as any, withEarlier as any, 0).map((r: any) => r.id);
  assert.notEqual(earlierOut[earlierOut.length - 1], 'a0', '更早的行不得落在最新消息之后');

  // 长回合：磁盘只到中间，画布尾部不能被灌入历史
  const longCanvas: any[] = [u('u1', 0)];
  for (let i = 0; i < 30; i += 1) longCanvas.push(t(`t${i}`, i + 1, `call${i}`));
  longCanvas.push(u('u2', 40), a('a2', 41));
  const longOut = mergeAuthoritativeTail([u('u1', 0), t('t0', 1, 'call0')] as any, longCanvas as any, 0);
  assert.equal(longOut[longOut.length - 1]?.id, 'a2');
  assert.equal(new Set(longOut.map((r: any) => r.id)).size, longOut.length);

  // steer（无下标）保留在尾部
  const steer = { role: 'user', id: 'steer1', parts: [{ kind: 'text' as const, text: '转向' }] };
  const steerOut = mergeAuthoritativeTail(finalTurn as any, [...finalTurn.map((r) => ({ ...r })), steer] as any, 0)
    .map((r: any) => r.id);
  assert.equal(steerOut[steerOut.length - 1], 'steer1');
});

test('unknown explicit stop reasons fail closed instead of being reported as success', () => {
  assert.deepEqual(classifyChatDone({ stopReason: 'future_terminal' }), {
    kind: 'incomplete',
    discardQueued: true,
    detail: 'future_terminal',
  });
});




test('disk catch-up keeps a send-now user bubble that is not on disk yet', () => {
  const disk = [
    { role: 'user', parts: [{ kind: 'text', text: '上一句' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '已停' }] },
  ];
  const canvas = [
    ...disk,
    { role: 'user', parts: [{ kind: 'text', text: '立刻发出去' }] },
    { role: 'assistant', parts: [] },
  ];
  const merged = mergeDiskWithUnpersistedTail(disk, canvas);
  assert.equal(merged.length, 4);
  assert.equal(merged[2]?.parts[0]?.text, '立刻发出去');
  assert.equal(mergeDiskWithUnpersistedTail(canvas, canvas).length, canvas.length);

  // 当画布末尾已经是结算完成的回复（例如分页截断了中途 steer，导致 disk 钉住的是根提问而 canvas 末尾是 steer + 最终回复），
  // 绝不能把已结算的 steer 尾巴重复拼接到 disk 后面（否则 keptUnpersistedTail 为 true 会锁死 busy 状态）
  const settledCanvasWithSteer = [
    ...disk,
    { role: 'user', parts: [{ kind: 'text', text: '中途转向' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '最终回复正文' }] },
  ];
  assert.deepEqual(mergeDiskWithUnpersistedTail(disk, settledCanvasWithSteer), disk);
});

test('mergeDiskWithUnpersistedTail：磁盘停在上一轮时不得抹掉画布已结算的 steer 尾巴', () => {
  const disk = [
    { role: 'user', id: 'q0', parts: [{ kind: 'text' as const, text: '上一问' }] },
    { role: 'assistant', id: 'a0', parts: [{ kind: 'text' as const, text: '上一答' }] },
  ];
  const canvas = [
    ...disk,
    { role: 'user', id: 'steer-1', isSteer: true, parts: [{ kind: 'text' as const, text: '改成 30s 一次' }] },
    { role: 'assistant', id: 'live-1', parts: [{ kind: 'text' as const, text: '巡检完成' }] },
  ];
  // 磁盘已覆盖这一轮：保持旧行为（采用磁盘，避免重复拼接锁死 busy）。
  assert.deepEqual(mergeDiskWithUnpersistedTail(disk, canvas), disk);
  // 磁盘还停在上一轮（daemon 收尾/重启）：steer 与最终回答是唯一副本，必须整段接回。
  const kept = mergeDiskWithUnpersistedTail(disk, canvas, { diskCoversTail: false });
  assert.deepEqual(kept.map((m) => m.id), ['q0', 'a0', 'steer-1', 'live-1']);
});

test('diskCoversCanvasTail：磁盘只有当前提问、还没有当前回答时不算覆盖尾部', () => {
  const disk = [
    { role: 'user', id: 'q0', parts: [{ kind: 'text' as const, text: '上一问' }] },
    { role: 'assistant', id: 'a0', parts: [{ kind: 'text' as const, text: '上一答' }] },
    { role: 'user', id: 'q1', parts: [{ kind: 'text' as const, text: '当前提问' }] },
  ];
  const canvas = [
    ...disk,
    { role: 'assistant', id: 'a1', parts: [{ kind: 'text' as const, text: '当前已结算回答' }] },
  ];
  assert.equal(diskCoversCanvasTail(disk, canvas), false);

  const full = [...disk, { role: 'assistant', id: 'a1', parts: [{ kind: 'text' as const, text: '当前已结算回答' }] }];
  assert.equal(diskCoversCanvasTail(full, canvas), true);

  // 画布比磁盘更长 = 还有未落盘正文，绝不能被旧磁盘覆盖。
  const longer = [
    ...disk,
    { role: 'assistant', parts: [{ kind: 'text' as const, text: '当前已结算回答，还有一段刚流出但尚未落盘' }] },
  ];
  assert.equal(diskCoversCanvasTail(full, longer), false);
});

test('before/after：旧 adopt 路径会丢当前提问并留下错位回答，新 helper 保留完整当前轮', () => {
  const disk = [
    { role: 'user', id: 'q0', parts: [{ kind: 'text' as const, text: '上一问' }] },
    { role: 'assistant', id: 'a0', parts: [{ kind: 'text' as const, text: '上一答' }] },
  ];
  const canvas = [
    ...disk,
    { role: 'user', id: 'q1', sourceIndex: 2, parts: [{ kind: 'text' as const, text: '当前提问' }] },
    { role: 'assistant', id: 'a1', parts: [{ kind: 'text' as const, text: '当前已结算回答' }] },
  ];
  // 旧实现：splice 丢掉窗口外的 q1 后，merge 默认 diskCoversTail=true，直接采用旧磁盘。
  const oldMerged = mergeDiskWithUnpersistedTail(
    spliceAuthoritativeDiskTail(canvas, disk, 2),
    canvas,
  );
  // 复现旧路径：q1 被窗口判断丢弃，a1 被当作 overlay 留在尾部，
  // 于是上一轮内容和一条失去提问的回答混在尾部。
  assert.deepEqual(oldMerged.map((m) => m.id), ['q0', 'a0', 'a1']);

  const fixed = mergeAuthoritativeTail(disk, canvas, 2);
  assert.deepEqual(fixed.map((m) => m.id), ['q0', 'a0', 'q1', 'a1']);
});

test('mergeDiskWithUnpersistedTail：停止对账磁盘停在上一轮时必须保留已结算的当前轮', () => {
  const disk = [
    { role: 'user', id: 'q0', parts: [{ kind: 'text' as const, text: '上一问' }] },
    { role: 'assistant', id: 'a0', parts: [{ kind: 'text' as const, text: '上一答' }] },
  ];
  const canvas = [
    ...disk,
    { role: 'user', id: 'q1', parts: [{ kind: 'text' as const, text: '当前提问' }] },
    { role: 'assistant', id: 'a1', parts: [{ kind: 'text' as const, text: '当前已结算回答' }] },
  ];
  // 默认 true 会让画布被旧磁盘整表替换；停止/断网对账必须显式传 false，
  // 否则当前轮消失，看起来就像是上一轮内容又“复活”到了尾部。
  assert.deepEqual(mergeDiskWithUnpersistedTail(disk, canvas).map((m) => m.id), ['q0', 'a0']);
  assert.deepEqual(
    mergeDiskWithUnpersistedTail(disk, canvas, { diskCoversTail: false }).map((m) => m.id),
    ['q0', 'a0', 'q1', 'a1'],
  );
});

test('mergeDiskWithUnpersistedTail：多条未落盘 steer 按身份整段接回', () => {
  const disk = [
    { role: 'user', id: 'q0', parts: [{ kind: 'text' as const, text: '上一问' }] },
    { role: 'assistant', id: 'a0', parts: [{ kind: 'text' as const, text: '上一答' }] },
    { role: 'user', id: 'steer-1', isSteer: true, parts: [{ kind: 'text' as const, text: '第一次转向' }] },
  ];
  const canvas = [
    ...disk,
    {
      role: 'assistant',
      id: 'live-1',
      parts: [{ kind: 'tool' as const, tool: { id: 'b1', name: 'run_command', status: 'pending' } }],
    },
    { role: 'user', id: 'steer-2', isSteer: true, parts: [{ kind: 'text' as const, text: '第二次转向' }] },
    {
      role: 'assistant',
      id: 'live-2',
      parts: [{ kind: 'tool' as const, tool: { id: 'b2', name: 'run_command', status: 'pending' } }],
    },
  ];
  // 只认最后一条 user 时，第一次转向之后的 live-1 会被丢掉。
  const merged = mergeDiskWithUnpersistedTail(disk, canvas);
  assert.deepEqual(merged.map((m) => m.id), ['q0', 'a0', 'steer-1', 'live-1', 'steer-2', 'live-2']);
});

test('mergeDiskWithUnpersistedTail keeps an in-flight steer turn', () => {  const previous = { role: 'user', parts: [{ kind: 'text', text: '上一问' }] };
  const previousDone = { role: 'assistant', parts: [{ kind: 'text', text: '上一答' }] };
  const disk = [previous, previousDone];
  const steer = { role: 'user', parts: [{ kind: 'text', text: 'steer 自然发出' }] };
  const live = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '新 loop 思考' },
      { kind: 'tool', tool: { id: 'call-new', name: 'run_command', status: 'pending' } },
    ],
  };
  const merged = mergeDiskWithUnpersistedTail(disk, [...disk, steer, live]);
  assert.equal(merged.length, 4);
  assert.equal(merged[2], steer);
  assert.equal(merged[3], live);
});

test('mergeDiskWithUnpersistedTail keeps an in-flight image-only user or steer turn without text', () => {
  const previous = { id: 'u-1', role: 'user', parts: [{ kind: 'text', text: '上一问' }] };
  const previousDone = { id: 'a-1', role: 'assistant', parts: [{ kind: 'text', text: '上一答' }] };
  const disk = [previous, previousDone];
  const imageOnlySteer = {
    id: 'u-2',
    role: 'user',
    parts: [{ kind: 'text', text: '' }],
    images: [{ media_type: 'image/png', data: 'base64-image-data' }],
  };
  const live = {
    role: 'assistant',
    parts: [],
  };
  const canvas = [...disk, imageOnlySteer, live];
  const merged = mergeDiskWithUnpersistedTail(disk, canvas);
  assert.equal(merged.length, 4);
  assert.equal(merged[2], imageOnlySteer);
  assert.equal(merged[3], live);
});

test('send-now request identity never claims an earlier same-text prompt', () => {
  const rows = [
    { role: 'user', id: 'old', parts: [{ kind: 'text', text: '同一句' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '旧回答' }] },
  ];
  // 新的 requestId 还没上屏：绝不能按文本认领上一轮的同一句话。
  assert.equal(findPaintedUserRow(rows, 'new', '同一句'), undefined);
  const painted = [
    ...rows,
    { role: 'user', id: 'new', clientInputId: 'new', parts: [{ kind: 'text', text: '同一句' }] },
  ];
  assert.equal(findPaintedUserRow(painted, 'new', '同一句')?.id, 'new');
  // legacy 调用（没有 requestId）仍保留文本兜底。
  assert.equal(findPaintedUserRow(rows, undefined, '同一句')?.id, 'old');
});

test('a queue card already auto-drained into the running turn is retired', () => {
  assert.equal(
    queueCardAlreadyDelivered({ running: true, latestUserTs: 200, cardCreatedAt: 100, sameText: true }),
    true,
  );
  assert.equal(
    queueCardAlreadyDelivered({ running: false, latestUserTs: 200, cardCreatedAt: 100, sameText: true }),
    false,
  );
  assert.equal(
    queueCardAlreadyDelivered({ running: true, latestUserTs: 50, cardCreatedAt: 100, sameText: true }),
    false,
    'the turn prompt that existed before the card is not the drained copy',
  );
  assert.equal(
    queueCardAlreadyDelivered({ running: true, latestUserTs: 200, cardCreatedAt: 100, sameText: false }),
    false,
  );
});

test('a repeated prompt text never swallows a newer steer/queue card', () => {
  const oldPrompt = {
    role: 'user',
    id: 'u-old',
    ts: 100,
    parts: [{ kind: 'text', text: '你好' }],
  };
  // The new steer has its own client identity: the old same-text prompt is a
  // different message and must not mark this card as already delivered.
  assert.equal(
    queueCardAlreadyOnCanvas([oldPrompt], {
      text: '你好',
      clientInputId: 'steer-new',
      createdAt: 200,
    }),
    false,
  );
  assert.equal(
    queueCardAlreadyOnCanvas(
      [oldPrompt, { role: 'user', id: 'steer-new', ts: 250, parts: [{ kind: 'text', text: '你好' }] }],
      { text: '你好', clientInputId: 'steer-new' },
    ),
    true,
  );
  // Legacy cards have no id: only a row at/after the card's creation counts.
  assert.equal(
    queueCardAlreadyOnCanvas([oldPrompt], { text: '你好', createdAt: 200 }),
    false,
  );
  assert.equal(
    queueCardAlreadyOnCanvas(
      [oldPrompt, { role: 'user', id: 'u-new', ts: 250, parts: [{ kind: 'text', text: '你好' }] }],
      { text: '你好', createdAt: 200 },
    ),
    true,
  );
  // Missing timestamps: keep the card rather than silently dropping user input.
  assert.equal(queueCardAlreadyOnCanvas([oldPrompt], { text: '你好' }), false);
});

test('steer card text fallback removes a ghost when the client/kernel id mapping was lost', () => {
  const steerTs = 1_700_000_000_000;
  const bubble = {
    role: 'user',
    id: 'm-kernel-steer',
    ts: steerTs + 50,
    parts: [{ kind: 'text', text: '<user-query>\n继续修复\n</user-query>\n[jeikcode-steer]' }],
  };
  // The card carries the client-minted id; the reloaded bubble only has the
  // kernel id. Exact-id matching misses, but the exact text + near timestamp
  // proves it is the same already-folded steer.
  assert.equal(
    steerCardBubbleOnCanvas([bubble], {
      clientInputId: 'client-steer-1',
      text: '继续修复',
      createdAt: steerTs,
    }),
    true,
  );
  // An old same-text prompt far away in time must not swallow a new card.
  assert.equal(
    steerCardBubbleOnCanvas([bubble], {
      clientInputId: 'client-steer-2',
      text: '继续修复',
      createdAt: steerTs + 60 * 60_000,
    }),
    false,
  );
  assert.equal(
    steerCardBubbleOnCanvas([bubble], {
      clientInputId: 'client-steer-3',
      text: '另一条转向',
      createdAt: steerTs,
    }),
    false,
  );
  // No timestamps: text alone is not enough to risk swallowing a real prompt.
  assert.equal(
    steerCardBubbleOnCanvas([bubble], {
      clientInputId: 'client-steer-4',
      text: '继续修复',
    }),
    false,
  );
});

test('user echo identity is the only dedupe signal', () => {
  const user = { role: 'user', id: 'u-1', parts: [{ kind: 'text', text: '你好啊' }] };
  assert.equal(userMessageAlreadyOnCanvas([user], '你好啊', undefined, 'u-1'), true);
  assert.equal(userMessageAlreadyOnCanvas([user], '你好啊', undefined, 'u-2'), false);
  assert.equal(userMessageAlreadyOnCanvas([], '你好啊', undefined, 'u-1'), false);
  // 同文不同 id：两条真实提问，不得按文本合并。
  const other = { role: 'user', id: 'u-2', parts: [{ kind: 'text', text: '你好啊' }] };
  assert.equal(userMessageAlreadyOnCanvas([user, other], '你好啊', undefined, 'u-3'), false);
});

test('in-flight cache is kept over stale disk history while a turn is active', () => {
  const cache = [
    { role: 'user', parts: [{ kind: 'text', text: '分析 C 盘' }] },
    {
      role: 'assistant',
      parts: [
        { kind: 'text', text: '正在扫描…' },
        { kind: 'tool', tool: { status: 'pending' } },
      ],
    },
  ];
  assert.equal(transcriptHasInFlightAssistant(cache), true);
  assert.equal(
    transcriptHasInFlightAssistant([
      { role: 'assistant', parts: [{ kind: 'text', text: '已经结束的回复' }] },
    ]),
    false,
    'completed assistant text is not in-flight',
  );
  assert.equal(
    transcriptHasInFlightAssistant([{ role: 'assistant', parts: [] }]),
    true,
    'empty assistant shell is still waiting for tokens',
  );
  assert.equal(
    shouldKeepCachedTranscript({
      cacheLen: 2,
      diskLen: 1,
      cacheInFlight: true,
      turnActive: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepCachedTranscript({
      cacheLen: 2,
      diskLen: 2,
      cacheInFlight: true,
      turnActive: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepCachedTranscript({
      cacheLen: 0,
      diskLen: 2,
      cacheInFlight: false,
      turnActive: true,
    }),
    false,
  );
  assert.equal(
    shouldKeepCachedTranscript({
      cacheLen: 2,
      diskLen: 2,
      cacheInFlight: true,
      turnActive: false,
    }),
    false,
    'inactive turn with equal disk messages should discard stale in-flight cache',
  );
  assert.equal(
    shouldKeepCachedTranscript({
      cacheLen: 2,
      diskLen: 3,
      cacheInFlight: true,
      turnActive: false,
    }),
    false,
    'inactive turn with more disk messages should discard stale in-flight cache',
  );
  assert.equal(
    shouldKeepCachedTranscript({
      cacheLen: 6,
      diskLen: 4,
      cacheInFlight: true,
      turnActive: false,
    }),
    false,
    'a finished turn must not keep a longer partial cache over disk',
  );
  assert.equal(thisTabOwnsTurn({ isLiveSession: false, isLocalTurn: true }), true);
  assert.equal(
    shouldLockSendAsDetached({ turnActive: true, thisTabOwnsTurn: true }),
    false,
  );
  assert.equal(
    shouldLockSendAsDetached({ turnActive: true, thisTabOwnsTurn: false }),
    false,
    'observers are never occupancy-locked from sending',
  );
});

test('legacy done and stopped are natural completions that preserve queued messages', () => {
  assert.equal(isWatchTurnActivationEvent('text'), true);
  assert.equal(isWatchTurnActivationEvent('tool_start'), true);
  assert.equal(isWatchTurnActivationEvent('permission_request'), true);
  assert.equal(isWatchTurnActivationEvent('artifact_start'), true);
  assert.equal(isWatchTurnActivationEvent('user'), false);
  assert.equal(isWatchTurnActivationEvent('runtime_info'), false);
  assert.equal(isWatchTurnActivationEvent('tokens'), false);
  assert.equal(isWatchTurnActivationEvent('done'), false);
  assert.equal(isWatchTurnActivationEvent('watch_closed'), false);
});


test('an active live turn cannot be detached locally without a recoverable protocol', () => {
  assert.deepEqual(liveDetachDisposition(true), {
    allowed: false,
    reason: 'active_turn',
  });
  assert.deepEqual(liveDetachDisposition(false), { allowed: true });
});

test('switching the viewed session is always allowed; live tasks stay in the background', () => {
  assert.deepEqual(liveSessionSwitchDisposition(true), { allowed: true });
  assert.deepEqual(liveSessionSwitchDisposition(false), { allowed: true });
});


test('viewing a session never occupancy-locks send or stop', () => {
  let state = reduceChatRecovery('ready', {
    type: 'session_switch',
    hasSession: true,
  });
  assert.equal(state, 'ready');
  assert.equal(chatRecoveryPolicy(state).allowSend, true);

  state = reduceChatRecovery(state, { type: 'active_check_failed' });
  assert.equal(state, 'ready');
  assert.equal(chatRecoveryPolicy(state).allowSend, true);

  state = reduceChatRecovery(state, { type: 'stop_failed' });
  assert.equal(state, 'terminal_unknown');
  assert.equal(chatRecoveryPolicy(state).allowSend, true);
  assert.equal(chatRecoveryPolicy(state).allowStop, true);
  state = reduceChatRecovery(state, { type: 'stop_succeeded' });
  assert.equal(state, 'ready');
});

test('observing a live turn still allows send (interrupt) and stop', () => {
  let state = reduceChatRecovery('checking', {
    type: 'active_check_succeeded',
    active: true,
  });
  assert.equal(state, 'detached_active');
  assert.equal(chatRecoveryPolicy(state).allowSend, true);
  assert.equal(chatRecoveryPolicy(state).allowStop, true);
  assert.equal(chatRecoveryPolicy(state).allowQueueDrain, true);

  state = reduceChatRecovery(state, { type: 'authoritative_terminal' });
  assert.equal(state, 'ready');
  assert.deepEqual(chatRecoveryPolicy(state), {
    allowSend: true,
    allowQueueDrain: true,
    allowStop: false,
  });
});

test('late chat events are rejected by request and session generation', () => {
  assert.equal(isCurrentChatStream('request-a', 3, 'request-a', 3, false), true);
  assert.equal(isCurrentChatStream('request-a', 3, 'request-b', 3, false), false);
  assert.equal(isCurrentChatStream('request-a', 3, 'request-a', 4, false), false);
  assert.equal(isCurrentChatStream('request-a', 3, 'request-a', 3, true), false);
});

test('a live user-input terminal clears only its matching prompt', () => {
  const current = { request_id: 42, question: 'Pick one' };
  assert.equal(resolveUserInputRequest(current, 42), null);
  assert.equal(resolveUserInputRequest(current, 41), current);
  assert.equal(resolveUserInputRequest(null, 42), null);
  assert.equal(toolResultClearsUserInput('request_user_input'), true);
  assert.equal(toolResultClearsUserInput('bash'), false);
  assert.equal(
    transcriptToolCallIsResolved(
      [{
        role: 'assistant',
        parts: [{ kind: 'tool', tool: { id: 'c1', name: 'edit_file', status: 'done' } }],
      }],
      'c1',
    ),
    true,
  );
  assert.equal(
    transcriptToolCallIsResolved(
      [{
        role: 'assistant',
        parts: [{ kind: 'tool', tool: { id: 'c1', name: 'edit_file', status: 'pending' } }],
      }],
      'c1',
    ),
    true,
  );
  assert.equal(
    transcriptToolCallIsResolved(
      [{
        role: 'assistant',
        parts: [{ kind: 'tool', tool: { id: 'c1', name: 'edit_file', status: 'waiting_approval' } }],
      }],
      'c1',
    ),
    false,
  );
  assert.equal(
    transcriptLatestUserInputIsResolved([
      {
        role: 'assistant',
        parts: [{
          kind: 'tool',
          tool: { name: 'request_user_input', status: 'completed' },
        }],
      },
    ]),
    true,
  );
  assert.equal(
    transcriptLatestUserInputIsResolved([
      {
        role: 'assistant',
        parts: [{
          kind: 'tool',
          tool: { name: 'request_user_input', status: 'pending' },
        }],
      },
    ]),
    false,
  );
});

test('prefix cache estimate reuses prior request prompt on warm paths', () => {
  assert.equal(estimatePrefixCached(0, 10_000), 0);
  assert.equal(estimatePrefixCached(38_555, 0), 0);
  assert.equal(estimatePrefixCached(6_000, 5_000), 4_992); // 5000 floored to 64-token blocks
  assert.equal(estimatePrefixCached(9_000, 8_000), 8_000); // 8000 is already block-aligned
  // Compaction / rewrite invalidates cache key.
  assert.equal(estimatePrefixCached(5_000, 38_555), 0);
  // Near-equal prompts must not paint a fake 100%.
  const near = estimatePrefixCached(200_000, 200_000);
  assert.ok(near > 0 && near < 200_000);
});

test('resolveTokenCache prefers provider telemetry, otherwise estimates prefix', () => {
  let state = createTokenCacheState();
  let r = resolveTokenCache({ prompt: 10_000, cached: 0 }, state);
  assert.equal(r.cached, 0);
  assert.equal(r.cached_estimated, false);
  state = r.nextState;

  r = resolveTokenCache({ prompt: 38_555, cached: 0 }, state);
  assert.equal(r.cached, estimatePrefixCached(38_555, 10_000));
  assert.equal(r.cached_estimated, true);
  state = r.nextState;

  r = resolveTokenCache({ prompt: 38_555, cached: 32_540 }, state);
  assert.equal(r.cached, 32_540);
  assert.equal(r.cached_estimated, false);
  state = r.nextState;

  r = resolveTokenCache({ prompt: 40_000, cached: 0 }, state);
  assert.equal(r.cached, estimatePrefixCached(40_000, 38_555));
  assert.equal(r.cached_estimated, true);
});

test('empty usage events do not wipe the prefix baseline', () => {
  let state = createTokenCacheState();
  state = resolveTokenCache({ prompt: 200_000, cached: 180_000 }, state).nextState;
  const wiped = resolveTokenCache({ prompt: 0, cached: 0 }, state);
  assert.equal(wiped.nextState.lastPrompt, 200_000);
  const firstRound = resolveTokenCache({ prompt: 201_000, cached: 0 }, wiped.nextState);
  assert.ok(firstRound.cached > 0, 'first round after send must estimate prefix cache');
  assert.equal(firstRound.cached_estimated, true);
});

test('local prompt bumps keep estimated cache aligned with prior usage', () => {
  const state = { lastPrompt: 32_540, providerReportsCache: false };
  const prev = { cached: 32_540, cached_estimated: true };
  const local = estimateLocalCached(state, 35_000, prev);
  assert.equal(local.cached, 32_540);
  assert.equal(local.cached_estimated, true);
});

test('history prompt estimate uses prefix before last user turn', () => {
  const cache = estimateCacheFromHistoryPrompt(38_555, 10_000);
  assert.equal(cache.cached, estimatePrefixCached(38_555, 10_000));
  assert.equal(cache.cached_estimated, true);
});

test('cache hit rate follows provider cached over total prompt tokens', () => {
  assert.equal(formatCacheHitRate(0, 10_000), null);
  assert.equal(formatCacheHitRate(6200, 10_000), '62%');
  assert.equal(formatCacheHitRate(9_996, 10_000), '99%');
  assert.equal(formatCacheHitRate(10_000, 10_000), '100%');
  assert.equal(formatCacheHitRate(10_000, 10_000, true), '99%');
  assert.equal(formatCacheHitRate(199_000, 200_000), '99%');
});

test('clampCachedToPrompt never exceeds occupancy', () => {
  assert.equal(clampCachedToPrompt(1_721_920, 50_000), 50_000);
  assert.equal(clampCachedToPrompt(8_000, 10_000), 8_000);
  assert.equal(clampCachedToPrompt(10, 0), 0);
});

test('stacked turn billing is occupancy over the window with ~100% cache', () => {
  assert.equal(
    isStackedTurnBillingUsage(
      { prompt: 1_724_257, cached: 1_721_920 },
      1_000_000,
    ),
    true,
  );
  assert.equal(
    isStackedTurnBillingUsage({ prompt: 50_000, cached: 48_000 }, 1_000_000),
    false,
  );
  assert.equal(
    isStackedTurnBillingUsage({ prompt: 1_100_000, cached: 10_000 }, 1_000_000),
    false,
  );
  assert.equal(
    isStackedTurnBillingUsage({ prompt: 1_724_257, cached: 1_721_920 }, null),
    false,
  );
});


test('resumeTurnStartedAt calculates correct offset', () => {
  assert.equal(resumeTurnStartedAt(1_000_000, 5_000), 995_000);
  assert.equal(resumeTurnStartedAt(1_000_000, undefined), 1_000_000);
});

test('new/draft sessions stay on the landing page instead of continue-session chrome', () => {
  assert.equal(stayOnNewSessionLanding({ sessionId: null }), true);
  assert.equal(
    stayOnNewSessionLanding({ sessionId: 'abc', activeSession: null }),
    true,
  );
  assert.equal(
    stayOnNewSessionLanding({
      sessionId: 'abc',
      activeSession: { id: 'abc', project_hash: 'h', message_count: 0 },
    }),
    true,
  );
  assert.equal(
    stayOnNewSessionLanding({
      sessionId: 'abc',
      activeSession: { id: 'abc', project_hash: 'h', message_count: 4 },
    }),
    false,
  );
});

test('coalesced replay appends only the unpainted suffix', () => {
  assert.equal(unpaintedReplaySuffix('hello', 'hello world'), ' world');
  assert.equal(unpaintedReplaySuffix('hello world', 'hello'), '');
  assert.equal(unpaintedReplaySuffix('hello world', 'hello world'), '');
  assert.equal(unpaintedReplaySuffix('', 'fresh'), 'fresh');
  assert.equal(unpaintedReplaySuffix('上一轮', '这一轮才开始'), '这一轮才开始');

  // 弱网重连的真实形态：磁盘里是换行，重放帧里是空格（空白几何不同，正文相同）。
  // 旧实现按 painted.length（折叠后仍含空格）去数 incoming 的非空白字符，
  // 多吃了空格数那么多个字，重放尾巴被切成残缺半句。
  assert.equal(
    unpaintedReplaySuffix('第一段\n第二段 第三段 第四段', '第一段 第二段 第三段 第四段 第五段 第六段 第七段'),
    ' 第五段 第六段 第七段',
  );
  assert.equal(
    unpaintedReplaySuffix('A B C D E F', 'A B C D E F GH IJKLMN'),
    ' GH IJKLMN',
  );
});

test('a whitespace-only live delta keeps its newlines (never swallowed by replay dedup)', () => {
  // provider 常把 "\n\n" 作为独立 delta 发出：画布末尾已有正文，但这段空白尚未画过。
  // 旧实现 collapseWs 后 chunk 为空 → 被当成“已画过”丢弃 → 行/列表粘连（刷新才恢复）。
  assert.equal(unpaintedReplaySuffix('不是死字段', '\n\n'), '\n\n');
  assert.equal(unpaintedReplaySuffix('2. 但底层 Args', '\n'), '\n');
  // 确已画过的同一段空白仍要去重（重放/重复帧不得叠空行）。
  assert.equal(unpaintedReplaySuffix('第一点\n\n', '\n\n'), '');
  assert.equal(unpaintedReplaySuffix('第一点\n', '\n'), '');
  // 空白 + 正文：换行必须保留，不能折叠成 "2. 但底层"。
  assert.equal(unpaintedReplaySuffix('第一点', '\n\n2. 但底层 Args'), '\n\n2. 但底层 Args');
});

test('a replayed chunk repairs a glued canvas by restoring only its layout whitespace', () => {
  // 旧版本丢过换行导致的粘连画布：非空白内容已画过，重放帧只应补回换行，
  // 不得重复正文，也不得永远粘着。
  assert.equal(
    unpaintedReplaySuffix('一、不是死字段2. 但底层也接受顶层开关', '\n\n2. 但底层也接受顶层开关'),
    '\n\n',
  );
  // 同形重放（骨架一致）仍去重，不叠空行。
  assert.equal(
    unpaintedReplaySuffix('一、不是死字段\n\n2. 但底层也接受顶层开关', '\n\n2. 但底层也接受顶层开关'),
    '',
  );
});

test('userTextsMatch tolerates trailing whitespace and newline variations', () => {
  assert.equal(userTextsMatch('请你扫描我的setup命令 setup命令是啥？\n', '请你扫描我的setup命令 setup命令是啥？'), true);
  assert.equal(userTextsMatch('请你扫描我的setup命令 setup命令是啥？  ', '请你扫描我的setup命令 setup命令是啥？'), true);
  assert.equal(userTextsMatch('第一行\r\n第二行\r\n- 列表项', '第一行\n第二行\n- 列表项'), true);
  assert.equal(userTextsMatch('完全不同的提问', '请你扫描我的setup命令 setup命令是啥？'), false);
});

test('userTextsMatch 不把前缀相同、尾部不同的长提问误判为同一条', () => {
  // 公共前缀超过 40 字符、只改末尾（追问常见形态）：旧的「前 40 字符一致」兜底规则会
  // 在这里返回 true，把真实的新提问当成重放吞掉。
  const shared =
    '请你在当前仓库里帮我仔细排查这个模块的边界条件与错误处理是否完整可靠，并且给出最小改动方案，先不要动测试代码，';
  assert.equal(userTextsMatch(`${shared}重点看登录路径。`, `${shared}重点看注册路径。`), false);

  // 真正的重放形态必须继续收敛（磁盘干净文本 vs 直播带注文本）：
  assert.equal(userTextsMatch(shared, shared), true);
  assert.equal(userTextsMatch(shared, `${shared}   \n`), true);
  assert.equal(userTextsMatch(shared, `${shared}\n\n[图片识别失败]`), true);
});

test('findPendingSelfEchoIndex 只按客户端关联键认领', () => {
  const pending = [
    { id: 'req-1', text: '同样的提问' },
    { id: 'req-2', text: '同样的提问' },
  ];

  // 1. 关联键命中：即使文本对不上，也精确消费自己的那一条。
  assert.equal(
    findPendingSelfEchoIndex(pending, { client_input_id: 'req-2', content: '完全不同的文本' }),
    1,
  );
  // 2. 无关联键 → 不认领（无 id 的旧端不再支持）。
  assert.equal(findPendingSelfEchoIndex(pending, { content: '同样的提问' }), -1);
  // 3. 关联键给了但命中不了 → -1，不得拿文本误伤。
  assert.equal(
    findPendingSelfEchoIndex(pending, { client_input_id: 'req-9', content: '同样的提问' }),
    -1,
  );
  // 4. 不是本端发出的 → -1，正常入画布。
  assert.equal(
    findPendingSelfEchoIndex(pending, { client_input_id: 'req-9', content: '别人的提问' }),
    -1,
  );

  const rewritten = [{ id: 'req-5', text: '修一下这个报错' }];
  const echoed = {
    client_input_id: 'req-5',
    content: '修一下这个报错\n\n[Additional context from user]: 附上日志',
  };
  assert.equal(findPendingSelfEchoIndex(rewritten, echoed), 0);
  assert.equal(findPendingSelfEchoIndex(rewritten, { content: echoed.content }), -1);
});

test('快照合并：无落盘 id 的乐观提问也去重，不得在底部出现两次', () => {
  const snapshot = [
    { role: 'user', id: 'm-user-9', parts: [{ kind: 'text', text: '我是大王' }] },
    { role: 'assistant', id: 'm-asst-9', parts: [{ kind: 'text', text: '收到' }] },
  ];
  // 本端刚发出、乐观尾部已带同一身份：不得再追加一遍
  const tail = [
    { id: 'm-user-9', role: 'user', parts: [{ kind: 'text', text: '我是大王' }] },
    { role: 'assistant', parts: [] },
  ];
  assert.deepEqual(
    dropSnapshotDuplicates(snapshot, tail).map((m: { role?: string }) => m.role),
    ['assistant'],
  );

  // 真正的新提问绝不能被吃掉（快照里没有它，必须保留）
  const fresh = dropSnapshotDuplicates(snapshot, [
    { role: 'user', parts: [{ kind: 'text', text: '全新提问' }] },
  ]);
  assert.equal(fresh.length, 1);

  // id 命中依旧优先去重（历史重载路径不变）
  const byId = dropSnapshotDuplicates(snapshot, [
    { role: 'user', id: 'm-user-9', parts: [{ kind: 'text', text: '别的内容' }] },
  ]);
  assert.equal(byId.length, 0);
});



test('回合收尾：缺 id 的直播行已被磁盘覆盖时不得重复接回，同时保留真正未落盘的尾部', () => {
  // 直播行的 message id 是内核入会话时才分配的，画布上往往还没有；
  // 旧实现只按行 id 对账 → 要么整轮接回（底部倒灌），要么整轮丢弃（答案丢失）。
  const tool = { kind: 'tool' as const, tool: { id: 't1', name: 'grep', status: 'done' as const } };
  const disk = [
    { role: 'user', id: 'u1', parts: [{ kind: 'text' as const, text: '重启网关' }] },
    { role: 'assistant', id: 'a1', parts: [tool] },
    { role: 'assistant', id: 'a2', parts: [{ kind: 'text' as const, text: '最终答案' }] },
  ];
  const canvas = [
    { role: 'user', parts: [{ kind: 'text' as const, text: '重启网关' }] },
    { role: 'assistant', parts: [tool] },
    // 在途尾段：磁盘只写到了「最终答案」，这条是还没落盘的续写
    { role: 'assistant', parts: [{ kind: 'text' as const, text: '最终答案 已生效' }] },
  ];

  const out = mergeDiskWithUnpersistedTail(disk, canvas, { diskCoversTail: false });
  const toolIds = out.flatMap((row) =>
    (row.parts ?? []).filter((part) => part.kind === 'tool').map((part) => (part as any).tool.id),
  );
  assert.deepEqual(toolIds, ['t1'], '已落盘的工具轮只能出现一次');
  assert.equal((out[out.length - 1]?.parts?.[0] as any)?.text, '最终答案 已生效', '未落盘的尾段必须保留');
});

test('长期离开后返回运行中会话：陈旧缓存不得压掉离开期间跑完的回合', () => {
  // 真实场景：A 停在 c 的最终回答；期间 B 经历限流/重连、用户重试 f→g，
  // 最后 h 正在持续渲染。返回时如果“只用缓存”，f/g/h 会整段丢失。
  const u = (id: string, src: number, text: string) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, src: number, text: string) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const cache = [u('u-a', 0, 'a?'), a('a-a', 1, 'a'), u('u-c', 4, 'c?'), a('a-c', 5, 'c')];
  const disk = [
    a('a-c', 5, 'c'),
    u('u-f', 21, 'f?'), a('a-f', 22, 'f'),
    u('u-g', 23, 'g?'), a('a-g', 24, 'g'),
    u('u-h', 25, 'h?'), a('a-h', 26, 'h…'),
  ];
  const merged = mergeAuthoritativeTail(disk as any, cache as any, 20);
  const ids = merged.map((row: any) => row.id);
  assert.deepEqual(ids, ['u-a', 'a-a', 'u-c', 'a-c', 'u-f', 'a-f', 'u-g', 'a-g', 'u-h', 'a-h']);
  assert.equal(new Set(ids).size, ids.length, '合并不得重复');
});

test('agent stop 写盘对账：写盘落后 / 画布重复身份 / 缓存陈旧都不能把旧消息倒灌到底部', () => {
  const u = (id: string, src: number, text = id) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, src: number, text = id) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const finalTurn = [u('u1', 0), a('a1', 1), u('u2', 2), a('a2', 3)];

  // 1) stop 瞬间：磁盘只写到 a1，画布已有 a2
  assert.deepEqual(
    mergeAuthoritativeTail(finalTurn.slice(0, 2) as any, finalTurn as any, 0).map((r: any) => r.id),
    ['u1', 'a1', 'u2', 'a2'],
  );

  // 2) 画布尾部残留同一身份的旧副本：不得变成 a b c d b
  const withDup = [...finalTurn, a('a1', 1, '旧副本')];
  assert.deepEqual(
    mergeAuthoritativeTail(finalTurn as any, withDup as any, 0).map((r: any) => r.id),
    ['u1', 'a1', 'u2', 'a2'],
  );

  // 3) 缓存停在 a1，磁盘已经跑完新回合
  assert.deepEqual(
    mergeAuthoritativeTail(finalTurn as any, finalTurn.slice(0, 2) as any, 0).map((r: any) => r.id),
    ['u1', 'a1', 'u2', 'a2'],
  );
});

test('写盘结算时：尾部旧副本 / 更早下标的行都不能被灌到最新消息底部', () => {
  const u = (id: string, src: number, text = id) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, src: number, text = id) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const disk = [u('u1', 0), a('a1', 1), u('u2', 2), a('a2', 3)];
  const clone = () => disk.map((r) => ({ ...r }));

  // 1) 尾部残留同一身份的旧副本 → 丢弃（不得变成 a b c d b）
  assert.deepEqual(
    mergeDiskWithUnpersistedTail(disk as any, [...clone(), a('a1', 1, '旧副本')] as any, { diskCoversTail: false })
      .map((r: any) => r.id),
    ['u1', 'a1', 'u2', 'a2'],
  );

  // 2) 带更早 sourceIndex 的行不能倒灌到底部：要么丢弃、要么插回自己的位次。
  //    （现在的规则是按因果位次插回，保证后台期间缺失的工具行不会丢。）
  const earlier = mergeDiskWithUnpersistedTail(
    disk as any,
    [...clone(), a('a0', 0, '更早的回答')] as any,
    { diskCoversTail: false },
  ).map((r: any) => r.id);
  const last = earlier[earlier.length - 1];
  assert.notEqual(last, 'a0', '更早的行绝不能落在最新消息之后');
  assert.ok(
    earlier.indexOf('a0') < earlier.indexOf('u2'),
    '更早的行必须回到它自己的因果位次，而不是拼到窗口尾部',
  );

  // 3) 本地尚未落盘的行（没有 sourceIndex）仍要保留在底部
  const local = { role: 'user', parts: [{ kind: 'text' as const, text: '本地未落盘' }] };
  assert.deepEqual(
    mergeDiskWithUnpersistedTail(disk as any, [...clone(), local] as any, { diskCoversTail: false })
      .map((r: any) => r.id ?? r.parts[0].text),
    ['u1', 'a1', 'u2', 'a2', '本地未落盘'],
  );
});

test('断网重连回到 busy 会话：c 的提问在窗口里但回答不在，不得算“已覆盖”', () => {
  const u = (id: string, src: number, text = id) => ({
    role: 'user', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, src: number, text = id) => ({
    role: 'assistant', id, sourceIndex: src, parts: [{ kind: 'text' as const, text }],
  });
  const cache = [u('u-a', 0), a('a-a', 1), u('u-b', 2), a('a-b', 3), u('u-c', 4)];

  // c 被取消/限流收尾：磁盘只有提问行，没有回答 → 不能算覆盖
  const cancelled = [u('u-c', 4), u('u-f', 6), a('a-f', 7)];
  assert.equal(diskCoversCanvasTail(cancelled as any, cache as any), false);
  const merged = mergeAuthoritativeTail(cancelled as any, cache as any, 4);
  assert.deepEqual(merged.map((r: any) => r.id), ['u-a', 'a-a', 'u-b', 'a-b', 'u-c', 'u-f', 'a-f']);

  // 窗口从 a-c 开始（c 的提问在窗口外）：旧历史必须保留，不能只剩窗口
  const midWindow = [a('a-c', 5), u('u-f', 6), a('a-f', 7)];
  assert.deepEqual(
    mergeAuthoritativeTail(midWindow as any, cache as any, 5).map((r: any) => r.id),
    ['u-a', 'a-a', 'u-b', 'a-b', 'u-c', 'a-c', 'u-f', 'a-f'],
  );

  // 缺口如实报告（调用方据此补一页）
  assert.deepEqual(findCausalGap(merged as any), { before: 4, after: 6 });
});

test('发完消息瞬间新建会话：新会话必须是空白 landing，旧会话靠自身缓存保留', () => {
  const base = { targetSessionId: null, sourceSessionId: 's-old', canvasLen: 12 };
  // 新建会话永远是空 blank（landing 判定是 messages.length === 0）：
  // 否则新会话会直接显示上一会话的记录。
  assert.equal(shouldClearCanvasOnSwitch({ ...base, sourceActive: true }), true);
  assert.equal(shouldClearCanvasOnSwitch({ ...base, sourceActive: false }), true);
  // 空画布不需要清
  assert.equal(
    shouldClearCanvasOnSwitch({ targetSessionId: null, sourceSessionId: 's-old', canvasLen: 0, sourceActive: false }),
    false,
  );
  // 切到具体的历史会话：无论来源是否在跑都先清，随后由缓存/磁盘恢复
  assert.equal(
    shouldClearCanvasOnSwitch({ targetSessionId: 's-new', sourceSessionId: 's-old', canvasLen: 12, sourceActive: false }),
    true,
  );
  assert.equal(
    shouldClearCanvasOnSwitch({ targetSessionId: 's-new', sourceSessionId: 's-old', canvasLen: 12, sourceActive: true }),
    false,
  );
});

test('长会话切换回来：缓存尾部的无下标 steer 与流式工具行绝不能被塞进 olderHead / earlierCanvasHead 倒挂到磁盘窗口上方', () => {
  const u = (id: string, src: number | undefined, text: string, ts: number, isSteer = false) => ({
    role: 'user',
    id,
    ...(src !== undefined ? { sourceIndex: src } : {}),
    ...(isSteer ? { isSteer: true } : {}),
    ts,
    parts: [{ kind: 'text' as const, text }],
  });
  const a = (id: string, src: number | undefined, text: string, ts: number) => ({
    role: 'assistant',
    id,
    ...(src !== undefined ? { sourceIndex: src } : {}),
    ts,
    parts: [{ kind: 'text' as const, text }],
  });

  // 缓存里有窗口前的旧轮次 (0..1)，随后是直播期间尚未带 sourceIndex 的 16:45 提问与 16:56 转向 + 新工具
  const canvas = [
    u('u-0', 0, '首问', 1_000),
    a('a-0', 1, '首答', 2_000),
    u('u-1645', undefined, '继续思考', 10_000),
    a('a-1645', undefined, '中间工具', 15_000),
    u('u-1656', undefined, '而且他那个封号的申诉链接也复制不全', 20_000, true),
    a('a-1656-live', undefined, '新流式思考', 21_000),
  ];
  // 磁盘返回的窗口从 sourceIndex=20 开始，包含已落盘的 16:45 与 16:56 转向，尚未包含 a-1656-live
  const disk = [
    u('u-1645', 20, '继续思考', 10_000),
    a('a-1645', 21, '中间工具', 15_000),
    u('u-1656', 22, '而且他那个封号的申诉链接也复制不全', 20_000),
  ];

  const merged = mergeAuthoritativeTail(disk as any, canvas as any, 20);
  assert.deepEqual(
    merged.map((r: any) => r.id),
    ['u-0', 'a-0', 'u-1645', 'a-1645', 'u-1656', 'a-1656-live'],
    '16:56 转向与流式尾巴必须保持在 16:45 之后，绝不能篡位到 16:45 上方',
  );
});


