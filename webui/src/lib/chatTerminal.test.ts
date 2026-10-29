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
  reconcileRunningTranscript,
  unpaintedReplaySuffix,
  mergeDiskWithUnpersistedTail,
  mergeAuthoritativeTail,
  diskCoversCanvasTail,
  shouldAdoptDiskTranscript,
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
  const previous = { role: 'user', parts: [{ kind: 'text', text: '上一问' }] };
  const previousDone = { role: 'assistant', parts: [{ kind: 'text', text: '上一答' }] };
  const disk = [previous, previousDone];
  const imageOnlySteer = {
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

test('user echo already on canvas is not appended again', () => {
  const user = { role: 'user', parts: [{ kind: 'text', text: '你好啊' }] };
  const assistant = { role: 'assistant', parts: [{ kind: 'text', text: '你好' }] };
  const notice = { role: 'system', parts: [{ kind: 'notice', text: 'sync' }] };
  const extra = { role: 'assistant', parts: [{ kind: 'text', text: '第二段' }] };
  assert.equal(userMessageAlreadyOnCanvas([user], '你好啊'), true);
  assert.equal(userMessageAlreadyOnCanvas([user, assistant], '你好啊'), true);
  assert.equal(userMessageAlreadyOnCanvas([user, notice], '你好啊'), true);
  assert.equal(userMessageAlreadyOnCanvas([user, assistant, notice], '你好啊'), true);
  assert.equal(userMessageAlreadyOnCanvas([user, assistant, extra], '你好啊'), true);
  assert.equal(userMessageAlreadyOnCanvas([user, assistant], '另一句'), false);
  assert.equal(userMessageAlreadyOnCanvas([], '你好啊'), false);
  const older = { role: 'user', parts: [{ kind: 'text', text: 'OK啊 挺好的' }] };
  const latest = { role: 'user', parts: [{ kind: 'text', text: '继续' }] };
  assert.equal(
    userMessageAlreadyOnCanvas([older, assistant, latest], 'OK啊 挺好的'),
    false,
    'an older repeated prompt is not the open turn',
  );
  assert.equal(userMessageAlreadyOnCanvas([older, assistant, latest], '继续'), true);
});

test('user echo matches disk text against live/watch vision captions', () => {
  const user = { role: 'user', parts: [{ kind: 'text', text: '看看这张图' }] };
  const captioned = '看看这张图\n\n[图片内容（由 VL 识别）]\n一只猫';
  assert.equal(visibleUserText(captioned), '看看这张图');
  assert.equal(userMessageAlreadyOnCanvas([user], captioned), true);
  assert.equal(userMessageAlreadyOnCanvas([user], ' 看看这张图 \n'), true);
  const emptyUser = { role: 'user', parts: [{ kind: 'text', text: '' }] };
  assert.equal(userMessageAlreadyOnCanvas([emptyUser], '[图片识别失败]'), true);
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

test('disk transcript replaces a canvas that is behind the saved session', () => {
  assert.equal(
    shouldAdoptDiskTranscript({ diskText: 40, canvasText: 0, diskHasUser: true }),
    true,
  );
  assert.equal(
    shouldAdoptDiskTranscript({ diskText: 10, canvasText: 40, diskHasUser: true }),
    false,
    'live tokens ahead of disk stay on screen',
  );
  assert.equal(
    shouldAdoptDiskTranscript({ diskText: 40, canvasText: 0, diskHasUser: false }),
    false,
    'do not wipe an optimistic send the server has not stored',
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

test('running disk merge keeps the steer tail and drops a duplicated user echo', () => {
  const previous = { role: 'user', parts: [{ kind: 'text', text: '上一问' }] };
  const previousTools = {
    role: 'assistant',
    parts: [{ kind: 'tool', tool: { id: 'bash-1' } }],
  };
  const previousDone = {
    role: 'assistant',
    parts: [
      { kind: 'text', text: '上一轮正文' },
      { kind: 'tool', tool: { id: 'bash-1', output: 'ok' } },
    ],
  };
  const steer = { role: 'user', parts: [{ kind: 'text', text: '改用 sqlite' }] };
  const live = { role: 'assistant', parts: [{ kind: 'text', text: '正在改' }] };
  const canvas = [previous, previousTools, steer, live];
  const disk = [previous, previousDone];
  const merged = reconcileRunningTranscript(canvas, disk);
  assert.equal(merged.length, 4);
  assert.equal(merged[1], previousDone);
  assert.equal(merged[2], steer);
  assert.equal(merged[3], live);

  const echoed = [...disk, steer, live, steer];
  const deduped = reconcileRunningTranscript(echoed, [...disk, steer, live]);
  assert.equal(deduped.filter((message) => message.role === 'user').length, 2);
  assert.equal(deduped[deduped.length - 1], live);

  const assistant10 = { role: 'assistant', parts: [{ kind: 'tool', tool: { id: 't10', output: 'done' } }] };
  const assistant11 = { role: 'assistant', parts: [{ kind: 'text', text: '第11条' }] };
  const displaced = reconcileRunningTranscript(
    [steer, assistant10, steer, assistant11],
    [steer, assistant10],
  );
  assert.equal(displaced.filter((message) => message.role === 'user').length, 1);
  assert.equal(displaced[1], assistant10);
  assert.equal(displaced[2]?.parts[0]?.text, '第11条');
});

test('userMessageAlreadyOnCanvas recognizes original user prompt when followed by mid-turn steer', () => {
  const originalUser = { role: 'user', parts: [{ kind: 'text', text: '修复 webui ipv6 缺失' }] };
  const toolStep = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '正在分析 lib.rs' },
      { kind: 'tool', tool: { id: 'call_1', name: 'read', status: 'done' } },
    ],
  };
  const steerUser = { role: 'user', parts: [{ kind: 'text', text: '不要动 api_config.rs' }] };
  const inFlightAssistant = {
    role: 'assistant',
    parts: [{ kind: 'reasoning', text: '好，我只看 lib.rs' }],
  };
  const canvas = [originalUser, toolStep, steerUser, inFlightAssistant];

  // 1. 处于未结算的同一轮次中，即使最新一条是 steer，原始提问 Q1 依然应被判定为已在画布上
  assert.equal(userMessageAlreadyOnCanvas(canvas, '修复 webui ipv6 缺失'), true);
  // 2. steer 自身也在画布上
  assert.equal(userMessageAlreadyOnCanvas(canvas, '不要动 api_config.rs'), true);
  // 3. 全新的未发送提问不在画布上
  assert.equal(userMessageAlreadyOnCanvas(canvas, '完全不同的新提问'), false);
});

test('reconcileRunningTranscript never duplicates thinking blocks during disk merge', () => {
  const user = { role: 'user', parts: [{ kind: 'text', text: '跑个测试' }] };
  const diskAssistant = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '第一阶段思考' },
      { kind: 'tool', tool: { id: 't1', name: 'read', status: 'done', output: 'ok' } },
      { kind: 'reasoning', text: '第二阶段思考' },
    ],
  };
  // 画布处于活跃状态，已经接收到了更多的实时增量
  const canvasAssistant = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '第一阶段思考' },
      { kind: 'tool', tool: { id: 't1', name: 'read', status: 'pending' } },
      { kind: 'reasoning', text: '第二阶段思考' },
      { kind: 'text', text: '正在编写新的测试文件...' },
    ],
  };
  const disk = [user, diskAssistant];
  const canvas = [user, canvasAssistant];

  const merged = reconcileRunningTranscript(canvas, disk);
  assert.equal(merged.length, 2);
  const assistant = merged[1];
  assert.equal(assistant.role, 'assistant');

  // 确保 reasoning block 数量严格保持 2 个，绝对不能因为 disk 合并而重复堆叠成 4 个或 6 个！
  const reasonings = assistant.parts.filter((p: { kind: string }) => p.kind === 'reasoning');
  assert.equal(reasonings.length, 2);
  assert.equal(reasonings[0].text, '第一阶段思考');
  assert.equal(reasonings[1].text, '第二阶段思考');

  // 确保 tool 状态同步为 disk 已结算的 done
  const tool = assistant.parts.find((p: { kind: string }) => p.kind === 'tool')?.tool;
  assert.equal(tool?.status, 'done');
  assert.equal(tool?.output, 'ok');

  // 确保画布领先的正文依然保留在末尾，未被插入思考块破坏
  const textPart = assistant.parts[assistant.parts.length - 1];
  assert.equal(textPart.kind, 'text');
  assert.equal(textPart.text, '正在编写新的测试文件...');
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

test('findPendingSelfEchoIndex 优先按客户端关联键认领，文本仅作兜底', () => {
  const pending = [
    { id: 'req-1', text: '同样的提问' },
    { id: 'req-2', text: '同样的提问' },
  ];

  // 1. 关联键命中：即使文本对不上，也精确消费自己的那一条（图片预处理/注入改写正文时就靠它）。
  assert.equal(
    findPendingSelfEchoIndex(pending, { client_input_id: 'req-2', content: '完全不同的文本' }),
    1,
  );
  // 2. 无关联键（legacy daemon / 第三方客户端）→ 文本兜底。
  assert.equal(findPendingSelfEchoIndex(pending, { content: '同样的提问' }), 0);
  // 3. 关联键给了但命中不了 → 继续文本兜底，绝不误伤。
  assert.equal(
    findPendingSelfEchoIndex(pending, { client_input_id: 'req-9', content: '同样的提问' }),
    0,
  );
  // 4. 不是本端发出的 → -1，正常入画布。
  assert.equal(
    findPendingSelfEchoIndex(pending, { client_input_id: 'req-9', content: '别人的提问' }),
    -1,
  );

  // 5. 正文与本地输入不一致（预处理/追加注入）：有 id 靠 id，无 id 时宁可多画一条也不吞真实消息。
  const rewritten = [{ id: 'req-5', text: '修一下这个报错' }];
  const echoed = {
    client_input_id: 'req-5',
    content: '修一下这个报错\n\n[Additional context from user]: 附上日志',
  };
  assert.equal(findPendingSelfEchoIndex(rewritten, echoed), 0);
  assert.equal(findPendingSelfEchoIndex(rewritten, { content: echoed.content }), -1);
});

test('reconcileRunningTranscript preserves earlier history when disk snapshot is tail-truncated', () => {
  const t0 = { role: 'user', parts: [{ kind: 'text', text: '早期提问T0' }] };
  const a0 = { role: 'assistant', parts: [{ kind: 'text', text: '回答T0' }] };
  const t1 = { role: 'user', parts: [{ kind: 'text', text: '你帮我拉下来修复' }] };
  const a1 = { role: 'assistant', parts: [{ kind: 'text', text: '工具执行中1' }] };
  const t2 = { role: 'user', parts: [{ kind: 'text', text: '修复完后 和那个朋友说' }] };
  const a2 = { role: 'assistant', parts: [{ kind: 'text', text: '工具执行中2' }] };

  // canvas 拥有完整的历史 (T0, T1, T2)，disk 仅拉到 tail 分页截断后的后缀 (T1, T2)
  const canvas = [t0, a0, t1, a1, t2, a2];
  const disk = [t1, a1, t2, a2];

  const merged = reconcileRunningTranscript(canvas, disk);
  const users = merged.filter((m: { role: string }) => m.role === 'user');
  assert.equal(users.length, 3);
  assert.equal(users[0], t0);
  assert.equal(users[1], t1);
  assert.equal(users[2], t2);
});

test('reconcileRunningTranscript eliminates duplicate turns from corrupted canvas without duplicating in output', () => {
  const t1 = { role: 'user', parts: [{ kind: 'text', text: '你帮我拉下来修复' }] };
  const a1 = { role: 'assistant', parts: [{ kind: 'text', text: '工具执行中1' }] };
  const t2 = { role: 'user', parts: [{ kind: 'text', text: '修复完后 和那个朋友说' }] };
  const a2 = { role: 'assistant', parts: [{ kind: 'text', text: '工具执行中2' }] };

  // 模拟之前被错误重放复制了一遍的 canvas [T1, A1, T2, A2, T1, A1, T2, A2]
  const canvas = [t1, a1, t2, a2, t1, a1, t2, a2];
  const disk = [t1, a1, t2, a2];

  const merged = reconcileRunningTranscript(canvas, disk);
  const users = merged.filter((m: { role: string }) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.equal(users[0], t1);
  assert.equal(users[1], t2);
});

test('reconcileRunningTranscript never routes duplicate prompt continuation into steer turn rest', () => {
  const user1 = { role: 'user', parts: [{ kind: 'text', text: '帮我查一下当前项目的架构' }] };
  const assistant1 = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '思考1' },
      { kind: 'tool', tool: { id: 'c1', name: 'call1', status: 'done' } },
    ],
  };
  const userSteer = { role: 'user', parts: [{ kind: 'text', text: '记得帮我查详细一点' }] };
  const assistant2 = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '思考2' },
      { kind: 'text', text: '架构总结内容' },
    ],
  };

  // 模拟画布含有被 watch echo 意外追加过的残留重复 User 1 轮次
  const user1Echo = { role: 'user', parts: [{ kind: 'text', text: '帮我查一下当前项目的架构' }] };
  const assistant1Echo = {
    role: 'assistant',
    parts: [
      { kind: 'reasoning', text: '思考1' },
      { kind: 'tool', tool: { id: 'c1', name: 'call1', status: 'done' } },
    ],
  };

  const canvas = [user1, assistant1, userSteer, assistant2, user1Echo, assistant1Echo];
  const disk = [user1, assistant1, userSteer, assistant2];

  const merged = reconcileRunningTranscript(canvas, disk);
  const turns = merged.filter((m: { role: string }) => m.role === 'user');
  assert.equal(turns.length, 2);
  assert.equal(turns[0], user1);
  assert.equal(turns[1], userSteer);

  // 验证 Steer 回合的助手消息中绝对没有混入 User 1 的思考1或 call1！
  const steerIdx = merged.indexOf(userSteer);
  const steerRest = merged.slice(steerIdx + 1);
  const steerTools = steerRest.flatMap((m) => m.parts).filter((p) => p.kind === 'tool');
  assert.equal(steerTools.length, 0);
});

test('reconcileRunningTranscript never duplicates multiple prior user-agent turns (1 2 3) during long running merge', () => {
  const u1 = { role: 'user', parts: [{ kind: 'text', text: '1' }] };
  const a1 = { role: 'assistant', parts: [{ kind: 'text', text: 'A1' }, { kind: 'tool', tool: { id: 'call_1', output: 'done' } }] };
  const u2 = { role: 'user', parts: [{ kind: 'text', text: '2' }] };
  const a2 = { role: 'assistant', parts: [{ kind: 'text', text: 'A2' }] };
  const u3 = { role: 'user', parts: [{ kind: 'text', text: '3' }] };
  const a3_in_flight = { role: 'assistant', parts: [{ kind: 'text', text: 'A3 partial' }] };
  const a3_disk = { role: 'assistant', parts: [{ kind: 'text', text: 'A3' }] };

  // Canvas 有 1 2 3（正在运行中），而 Disk 已经落盘了 1 2 3
  const canvas = [u1, a1, u2, a2, u3, a3_in_flight];
  const disk = [u1, a1, u2, a2, u3, a3_disk];

  const merged = reconcileRunningTranscript(canvas, disk);
  const userMessages = merged.filter((m: { role: string }) => m.role === 'user');
  // 必须严格只有 3 个用户气泡，绝不能翻倍成 6 个！
  assert.equal(userMessages.length, 3);
  assert.equal(userMessages[0].parts[0]?.text, '1');
  assert.equal(userMessages[1].parts[0]?.text, '2');
  assert.equal(userMessages[2].parts[0]?.text, '3');
});

test('reconcileRunningTranscript aligns turns by message id before text (duplicate texts)', () => {
  const dU1 = { role: 'user', id: 'm1', parts: [{ kind: 'text', text: 'q' }] };
  const dA1 = { role: 'assistant', parts: [{ kind: 'text', text: 'A-from-m1' }] };
  const dU2 = { role: 'user', id: 'm2', parts: [{ kind: 'text', text: 'q' }] };
  const dA2 = { role: 'assistant', parts: [{ kind: 'text', text: 'A-from-m2' }] };
  const disk = [dU1, dA1, dU2, dA2];

  // Canvas turns share the SAME text but keep stable ids — a reorder/steer scenario.
  const canvas = [
    { role: 'user', id: 'm2', parts: [{ kind: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: 'A-from-m2' }] },
    { role: 'user', id: 'm1', parts: [{ kind: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: 'A-from-m1' }] },
  ];

  const merged = reconcileRunningTranscript(canvas, disk);
  const users = merged.filter((m: { role: string }) => m.role === 'user');
  assert.equal(users.length, 2, '轮次不重复');
  assert.equal(users[0].id, 'm1');
  const firstAssistant = merged.find((m: { role: string }) => m.role === 'assistant');
  assert.equal(
    (firstAssistant as { parts: Array<{ text?: string }> } | undefined)?.parts[0]?.text,
    'A-from-m1',
    '必须按 id 对齐，而非首个同文本轮次',
  );
});

test('快照合并：无落盘 id 的乐观提问也去重，不得在底部出现两次', () => {
  const snapshot = [
    { role: 'user', id: 'm-user-9', parts: [{ kind: 'text', text: '我是大王' }] },
    { role: 'assistant', id: 'm-asst-9', parts: [{ kind: 'text', text: '收到' }] },
  ];
  // 本端刚发出、尚未绑定落盘 id 的乐观尾部：文本已在快照里 → 不得再追加一遍
  const tail = [
    { role: 'user', parts: [{ kind: 'text', text: '我是大王' }] },
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
