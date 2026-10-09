import {
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
} from './historyMessages.ts';

export interface ChatDoneTerminal {
  stopReason?: string;
  message?: string;
}

export type ChatDoneDisposition =
  | { kind: 'completed'; discardQueued: false }
  | { kind: 'incomplete'; discardQueued: true; detail: string };

/**
 * Classify the daemon's authoritative turn terminal.
 *
 * Older daemons did not include `stop_reason`, so an absent reason remains a
 * natural completion for wire compatibility. Once a reason is present, only
 * kernel `Stopped` (`stopped` on the wire) means the model finished normally;
 * every other current or future reason is incomplete and must fail closed.
 */
export function classifyChatDone(terminal: ChatDoneTerminal): ChatDoneDisposition {
  if (terminal.stopReason === undefined || terminal.stopReason === 'stopped') {
    return { kind: 'completed', discardQueued: false };
  }

  const message = terminal.message?.trim();
  return {
    kind: 'incomplete',
    discardQueued: true,
    detail: message || terminal.stopReason || 'unknown_terminal',
  };
}

export interface LiveLifecycleState {
  running: boolean;
  terminalConsumed: boolean;
}

export type LiveLifecycleEvent =
  | { type: 'snapshot' }
  | { type: 'input_accepted' }
  | { type: 'state'; running: boolean; stopReason?: string; message?: string }
  | { type: 'error'; message: string };

export interface LiveLifecycleTransition {
  state: LiveLifecycleState;
  terminal?: ChatDoneDisposition;
  diagnostic?: string;
}

export function createLiveLifecycleState(): LiveLifecycleState {
  return { running: false, terminalConsumed: false };
}

/**
 * Track only authoritative `/live` lifecycle observations.
 *
 * Kernel error events are diagnostics and cannot finish a turn. The following
 * `state { running: false }` owns the terminal, and duplicate idle states are
 * ignored so queue/persistence side effects happen once.
 */
export function reduceLiveLifecycle(
  current: LiveLifecycleState,
  event: LiveLifecycleEvent,
): LiveLifecycleTransition {
  switch (event.type) {
    case 'snapshot':
      return { state: createLiveLifecycleState() };
    case 'input_accepted':
      return { state: { running: true, terminalConsumed: false } };
    case 'error':
      return { state: current, diagnostic: event.message };
    case 'state':
      if (event.running) {
        return { state: { running: true, terminalConsumed: false } };
      }
      if (current.terminalConsumed) {
        return { state: { running: false, terminalConsumed: true } };
      }
      return {
        state: { running: false, terminalConsumed: true },
        terminal: classifyChatDone({
          stopReason: event.stopReason,
          message: event.message,
        }),
      };
  }
}

/** A snapshot is persisted history, not evidence that a turn is active. */
export function restoreLiveSnapshot<T>(messages: T[]): { messages: T[]; running: false } {
  return { messages, running: false };
}

/** Saved transcript is ahead of the canvas. Used while a turn is running so the
 *  open page tracks disk the same way a reload does, even if the live socket
 *  is only sending keepalives. */
export function shouldAdoptDiskTranscript(input: {
  diskText: number;
  canvasText: number;
  diskHasUser: boolean;
}): boolean {
  return input.diskHasUser && input.diskText > input.canvasText;
}

/** Empty hub projections (view-only “new session”) must not wipe a canvas that
 * already has turns. A reconnect after the first Submit used to paint the
 * landing page over the live transcript. */
export function keepCanvasOnEmptyLiveSnapshot(
  snapshotMessageCount: number,
  canvasMessageCount: number,
  viewingThisSession: boolean,
): boolean {
  return viewingThisSession && snapshotMessageCount === 0 && canvasMessageCount > 0;
}

/** Keep the existing `/live` SSE when returning to the execution session.
 * Reconnecting would snapshot-replace the canvas (dropping in-flight bash
 * output) and replay trailing text/user events on top of the restored cache. */
export function shouldReuseLiveStream(input: {
  sync: boolean;
  sessionId: string | null;
  liveSessionId: string | null;
  streamOpen: boolean;
}): boolean {
  return Boolean(
    input.sync &&
      input.sessionId &&
      input.liveSessionId === input.sessionId &&
      input.streamOpen,
  );
}

/** Resume the turn stopwatch from a stamped assistant duration after switching
 * back to a still-running session. */
export function resumeTurnStartedAt(now: number, elapsedMs: number | undefined): number {
  const elapsed = Math.max(0, elapsedMs ?? 0);
  return now - elapsed;
}

/** New/draft sessions and not-yet-resolved ids should stay on the landing page
 * instead of flashing the empty-chat chrome or a “continue session” hint. */
export function stayOnNewSessionLanding(input: {
  sessionId: string | null;
  activeSession?: { id: string; message_count?: number; project_hash?: string } | null;
}): boolean {
  if (!input.sessionId) return true;
  const active = input.activeSession;
  if (!active || active.id !== input.sessionId || !active.project_hash) return true;
  return (active.message_count ?? 0) === 0;
}

type CanvasPart = {
  kind: string;
  text?: string;
  tool?: { id?: string; output?: string; status?: string };
};
type CanvasMessage = { role: string; parts: CanvasPart[]; ts?: number };

function canvasUserText(message: CanvasMessage | undefined): string | undefined {
  if (!message) return undefined;
  const joined = message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text || '')
    .join('');
  return joined || undefined;
}

const VISION_ANNOTATION_MARKERS = [
  '\n\n[图片内容（由',
  '[图片内容（由',
  '\n\n[图片识别失败]',
  '[图片识别失败]',
];

export function visibleUserText(text: string): string {
  let cut = -1;
  for (const marker of VISION_ANNOTATION_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx >= 0 && (cut < 0 || idx < cut)) cut = idx;
  }
  const raw = cut >= 0 ? text.slice(0, cut) : text;
  return stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(raw))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

export function userTextsMatch(a: string, b: string): boolean {
  const left = visibleUserText(a);
  const right = visibleUserText(b);
  if (left === right) return true;
  if (!left || !right) return left === right;
  // Disk history is stripped; live/watch echo may still carry the caption.
  if (left.startsWith(right) || right.startsWith(left)) {
    const longer = left.length >= right.length ? left : right;
    const shorter = left.length >= right.length ? right : left;
    const rest = longer.slice(shorter.length);
    if (rest.trim() === '') return true;
    return VISION_ANNOTATION_MARKERS.some((m) => rest.includes(m.replace(/^\n\n/, '')));
  }
  return false;
}

/** True when `userText` is already the latest user turn on the canvas.
 * Snapshot reconnect / `/chat/watch` replay both re-emit that echo; appending
 * it again creates duplicate bubbles.
 * Also accounts for mid-turn steers: if a turn had a steer message, replaying
 * the original user prompt must not re-append it below the steer. */
export function userMessageAlreadyOnCanvas(
  messages: CanvasMessage[],
  userText: string,
  userTs?: number,
): boolean {
  const want = visibleUserText(userText);
  if (!want && want !== '') return false;
  const matches = (message: CanvasMessage | undefined): boolean =>
    !!message && message.role === 'user' && userTextsMatch(canvasUserText(message) ?? '', want);

  // 1. 若提供了时间戳且历史气泡有对应时间戳（误差 3s 内），优先基于时间戳和内容精准匹配
  if (userTs && userTs > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === 'user' && matches(message)) {
        if (message.ts && Math.abs(message.ts - userTs) < 3000) return true;
      }
    }
  }

  // 2. 查找画布上最靠后的匹配项
  let matchIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (matches(messages[i])) {
      matchIndex = i;
      break;
    }
  }
  if (matchIndex === -1) return false;

  // 3. 查找画布上最靠后的 user 消息
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  // 若最后一条 user 消息就是该提问，毫无疑问已在画布上
  if (matchIndex === lastUserIndex) return true;

  // 4. 若 matchIndex 之后存在后续的 user 消息：
  // 检查后续 user 消息是否是全新的、已独立结算完毕的轮次：
  // 如果画布最末尾存在一个没有任何助手响应的纯 user 提问（开放提问，如 [older, assistant, latest]），
  // 且 matchIndex 之后的对应助手已经结算完结，则说明 matchIndex 属于过去的旧轮次。
  const hasOpenTrailingUser = messages.length > 0 && messages[messages.length - 1]?.role === 'user';
  if (hasOpenTrailingUser && lastUserIndex === messages.length - 1) {
    // 检查 matchIndex 对应的助手是否已经生成了内容
    const nextAssistant = messages.slice(matchIndex + 1, lastUserIndex).find((m) => m.role === 'assistant');
    const nextAssistantSettled = nextAssistant && nextAssistant.parts.some(
      (part) => part.kind === 'text' && (part.text || '').trim().length > 0,
    );
    if (nextAssistantSettled) {
      return false;
    }
  }

  // 5. 其余场景（包括正在执行中的中途 steer：[originalUser, assistant, steerUser, assistant_in_flight]），
  // 原始提问与 steer 均属于当前未结算的同一轮次，绝对判定为已在画布上，杜绝重放追加！
  return true;
}

/** The newest row is a user prompt that does not yet have assistant text,
 *  tools, or thinking. An empty Working placeholder does not close the turn. */
export function transcriptHasOpenUserTurn(
  messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'assistant') {
      const hasContent = message.parts.some((part) => {
        if (part.kind === 'tool') return true;
        if (
          (part.kind === 'text' || part.kind === 'reasoning') &&
          (part.text || '').trim().length > 0
        ) {
          return true;
        }
        return false;
      });
      if (!hasContent) continue;
      return false;
    }
    if (message.role === 'user') return true;
  }
  return false;
}

/** `session_assigned` is on the owner SSE and on `/chat/watch` replay.
 *  Only the tab that already owns POST /chat may claim the turn. An observer
 *  (another browser on `--host`) and a refresh have no open stream; claiming
 *  the id makes the watch callback drop every later user/text/tool event. */
export function sessionAssignedClaimsLocalTurn(input: {
  ownsOpenStream: boolean;
  previousIdIsLocalTurn: boolean;
}): boolean {
  return input.ownsOpenStream || input.previousIdIsLocalTurn;
}

/** Idle snapshot replay of a finished turn repeats the latest user text.
 *  Hold that echo. A running turn whose prompt repeats the previous one
 *  (snapshot still shows the old turn) is released when an unpainted delta
 *  arrives — see `releaseHeldDuplicateUser`. */
export function holdDuplicateUserEcho(input: {
  idleSnapshot: boolean;
  alreadyOnCanvas: boolean;
  openUserTurn: boolean;
  canvasInFlight: boolean;
  turnLive: boolean;
}): boolean {
  return (
    input.idleSnapshot &&
    input.alreadyOnCanvas &&
    !input.openUserTurn &&
    !input.canvasInFlight &&
    !input.turnLive
  );
}

/** True when `incoming` still belongs on the last assistant (replay of this
 *  turn) rather than opening the next one. A brand-new thinking block does
 *  not start with the previous answer, and the previous answer is not a
 *  prefix of it. */
export function deltaContinuesLastAssistant(
  messages: Array<{ role: string; parts: ReplayPart[] }>,
  event: { type: string; content?: string; id?: string },
): boolean {
  const last = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!last) return false;
  if (event.type === 'tool_start' || event.type === 'tool_output' || event.type === 'tool_result') {
    return !!event.id && last.parts.some((part) => part.kind === 'tool' && part.tool?.id === event.id);
  }
  if (event.type !== 'text' && event.type !== 'reasoning') return false;
  const kind = event.type === 'reasoning' ? 'reasoning' : 'text';
  let existing = '';
  for (const part of last.parts) {
    if (part.kind === kind && part.text) existing += part.text;
  }
  const incoming = event.content ?? '';
  if (!existing || !incoming) return false;
  const painted = withoutDisplayTruncation(existing);
  if (!painted) return false;
  return incoming.startsWith(painted) || painted.startsWith(incoming);
}

type ReconcilePart = {
  kind: string;
  text?: string;
  tool?: { id?: string; output?: string; status?: string };
};
type ReconcileMessage = { role: string; parts: ReconcilePart[] };

function reconcileUserText(message: ReconcileMessage): string {
  const text = message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text || '')
    .join('');
  return visibleUserText(text);
}

function transcriptTurns<T extends ReconcileMessage>(messages: T[]): Array<{ user: T; rest: T[] }> {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') starts.push(index);
  });
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]! : messages.length;
    return { user: messages[start]!, rest: messages.slice(start + 1, end) };
  });
}

function joinedTurnText(rest: ReconcileMessage[]): string {
  let text = '';
  for (const message of rest) {
    for (const part of message.parts) {
      if ((part.kind === 'text' || part.kind === 'reasoning') && part.text) text += part.text;
    }
  }
  return text;
}

/** Settled disk text must fill a tool-only canvas, and live tokens already
 *  ahead of the file must stay. Unique tool rows from the other side are kept. */
function mergeTurnRest<T extends ReconcileMessage>(diskRest: T[], canvasRest: T[]): T[] {
  if (diskRest.length === 0) return canvasRest;
  if (canvasRest.length === 0) return diskRest;

  const diskText = joinedTurnText(diskRest);
  const canvasText = joinedTurnText(canvasRest);
  const canvasInFlight = transcriptHasInFlightAssistant(canvasRest as unknown as Array<{ role: string; parts: InFlightPart[] }>);
  const canvasAhead = (canvasText.startsWith(diskText) && canvasText.length >= diskText.length) || canvasInFlight;

  // 1. 若前端画布处于活跃进行中（in-flight）或文本已经领先/包含落盘文本：
  // 画布是正在流式生成的绝对真实源！严禁从落后的 diskRest 抽取旧思考块追加到末尾！
  // 仅将 diskRest 中已结算的 tool 状态同步到 canvasRest 对应的 tool 调用中。
  if (canvasAhead) {
    const diskToolsById = new Map<string, ReconcilePart['tool']>();
    for (const m of diskRest) {
      for (const p of m.parts) {
        if (p.kind === 'tool' && p.tool?.id && p.tool.status && p.tool.status !== 'pending' && p.tool.status !== 'running') {
          diskToolsById.set(p.tool.id, p.tool);
        }
      }
    }
    if (diskToolsById.size === 0) return canvasRest;
    return canvasRest.map((msg) => {
      if (msg.role !== 'assistant') return msg;
      let changed = false;
      const parts = msg.parts.map((p) => {
        if (p.kind === 'tool' && p.tool?.id && diskToolsById.has(p.tool.id)) {
          const settled = diskToolsById.get(p.tool.id)!;
          if (p.tool.status !== settled.status || (!p.tool.output && settled.output)) {
            changed = true;
            return { ...p, tool: { ...p.tool, status: settled.status, output: settled.output ?? p.tool.output } };
          }
        }
        return p;
      });
      return changed ? { ...msg, parts } : msg;
    });
  }

  // 2. 若磁盘历史明显比画布更新且已落盘结算（如离开页面期间后台已完成整轮输出）：
  // 磁盘历史包含更完整的正文与思考，以 diskRest 为准。
  const base = diskRest;
  const added = continuationNotOnTranscript(base, canvasRest);
  if (added.length === 0) return base;
  const last = base[base.length - 1];
  if (last && last.role === 'assistant' && added.every((message) => message.role === 'assistant')) {
    return [
      ...base.slice(0, -1),
      { ...last, parts: [...last.parts, ...added.flatMap((message) => message.parts)] },
    ];
  }
  return [...base, ...added];
}

/**
 * Merge a running canvas with a disk snapshot without reordering turns.
 *
 * Disk owns settled turns (it has the assistant text that was not flushed
 * when the page first painted). The canvas keeps a newer tail the file does
 * not have yet — the steer the user just sent, and tokens still ahead of
 * disk. A watch echo of a user message that is already in the snapshot is
 * not appended again at the bottom.
 */
export function reconcileRunningTranscript<T extends ReconcileMessage>(canvas: T[], disk: T[]): T[] {
  if (disk.length === 0) return canvas;
  if (canvas.length === 0) return disk;
  const diskTurns = transcriptTurns(disk);
  const canvasTurns = transcriptTurns(canvas);
  if (diskTurns.length === 0) return canvas.length >= disk.length ? canvas : disk;
  if (canvasTurns.length === 0) return disk;

  // 1. 保留前置 assistant/system 消息（即在第一个 user 提问之前的开场白）
  const firstDiskUser = disk.findIndex((message) => message.role === 'user');
  const firstCanvasUser = canvas.findIndex((message) => message.role === 'user');
  let lead: T[] = [];
  if (firstDiskUser > 0 && firstCanvasUser > 0) {
    const diskLead = disk.slice(0, firstDiskUser);
    const canvasLead = canvas.slice(0, firstCanvasUser);
    lead = joinedTurnText(diskLead).length >= joinedTurnText(canvasLead).length ? diskLead : canvasLead;
  } else if (firstDiskUser > 0) {
    lead = disk.slice(0, firstDiskUser);
  } else if (firstCanvasUser > 0) {
    lead = canvas.slice(0, firstCanvasUser);
  }

  // 2. 顺序对齐全局 Turns，杜绝因单向指针错位导致的整段历史重复追加
  const matches: Array<{ d: number; c: number }> = [];
  let cSearch = 0;
  for (let d = 0; d < diskTurns.length; d++) {
    const dText = reconcileUserText(diskTurns[d]!.user);
    for (let c = cSearch; c < canvasTurns.length; c++) {
      const cText = reconcileUserText(canvasTurns[c]!.user);
      if (userTextsMatch(dText, cText)) {
        matches.push({ d, c });
        cSearch = c + 1;
        break;
      }
    }
  }

  const matchedC = new Set(matches.map((m) => m.c));
  const matchedD = new Set(matches.map((m) => m.d));
  const outTurns: Array<{ user: T; rest: T[] }> = [];

  let nextC = 0;
  let nextD = 0;
  for (const { d, c } of matches) {
    // 放入 d 之前未匹配的 disk turns
    while (nextD < d) {
      if (!matchedD.has(nextD)) {
        outTurns.push(diskTurns[nextD]!);
      }
      nextD++;
    }
    // 放入 c 之前未匹配的 canvas turns (例如 disk tail 分页截断前更早的历史)
    while (nextC < c) {
      if (!matchedC.has(nextC)) {
        const text = reconcileUserText(canvasTurns[nextC]!.user);
        const alreadyInDisk = diskTurns.some((dt) => userTextsMatch(reconcileUserText(dt.user), text));
        const alreadyOut = outTurns.some((rt) => userTextsMatch(reconcileUserText(rt.user), text));
        if (!alreadyInDisk && !alreadyOut) {
          outTurns.push(canvasTurns[nextC]!);
        }
      }
      nextC++;
    }
    // 合并当前匹配的 (d, c) 轮次
    const diskTurn = diskTurns[d]!;
    const canvasTurn = canvasTurns[c]!;
    outTurns.push({
      user: diskTurn.user,
      rest: mergeTurnRest(diskTurn.rest, canvasTurn.rest),
    });
    nextD = d + 1;
    nextC = c + 1;
  }

  // 处理剩余未匹配的 disk turns
  while (nextD < diskTurns.length) {
    if (!matchedD.has(nextD)) {
      outTurns.push(diskTurns[nextD]!);
    }
    nextD++;
  }

  // 处理剩余未匹配的 canvas turns（新发送的 live tail / steer）
  while (nextC < canvasTurns.length) {
    const cTurn = canvasTurns[nextC]!;
    nextC++;
    const text = reconcileUserText(cTurn.user);
    // 检查是否是历史已存在轮次的纯粹无害重复回放（例如 canvas 尾部残留的整段已结算轮次镜像）：
    // 若 targetTurn 已经完全包含了 cTurn 的所有内容（没有新 tool、新 text、新 reasoning），纯粹去重丢弃。
    const targetTurn = outTurns.find((rt) => userTextsMatch(reconcileUserText(rt.user), text));
    if (targetTurn && continuationNotOnTranscript(targetTurn.rest, cTurn.rest).length === 0) {
      continue;
    }
    // 若当前末尾轮次尚未结算且与 cTurn 提问匹配，合入当前末尾轮次
    const lastTurn = outTurns[outTurns.length - 1];
    const lastTurnInFlight = lastTurn && (!lastTurn.rest.length || !lastTurn.rest.some((m) => m.role === 'assistant' && m.parts?.some((p) => p.kind === 'text' && (p.text || '').trim().length > 0)));
    if (lastTurn && lastTurnInFlight && userTextsMatch(reconcileUserText(lastTurn.user), text)) {
      const continuation = continuationNotOnTranscript(lastTurn.rest, cTurn.rest);
      if (continuation.length > 0) {
        lastTurn.rest.push(...continuation);
      }
    } else {
      // 否则为具有新内容的新提问轮次（包括用户合法多次发送相同提问）：作为独立新轮次追加
      outTurns.push(cTurn);
    }
  }

  const out: T[] = [...lead];
  for (const turn of outTurns) {
    out.push(turn.user, ...turn.rest);
  }

  if (out.length === canvas.length && out.every((message, index) => message === canvas[index])) {
    return canvas;
  }
  return out;
}

function continuationNotOnTranscript<T extends ReconcileMessage>(base: T[], extra: T[]): T[] {
  const toolIds = new Set<string>();
  const reasoningTexts: string[] = [];
  let text = '';
  for (const message of base) {
    for (const part of message.parts) {
      if (part.kind === 'tool' && part.tool?.id) toolIds.add(part.tool.id);
      if (part.kind === 'reasoning' && part.text) reasoningTexts.push(part.text.trim());
      if (part.kind === 'text' && part.text) text += part.text;
    }
  }
  const kept: T[] = [];
  for (const message of extra) {
    const parts = message.parts.flatMap((part) => {
      if (part.kind === 'tool' && part.tool?.id) {
        return toolIds.has(part.tool.id) ? [] : [part];
      }
      // 思考块去重防线：严格区分 reasoning 与 text，若 base 中已有完全相同或相互包含的思考块，严禁重复追加！
      if (part.kind === 'reasoning' && part.text) {
        const clean = part.text.trim();
        if (!clean) return [];
        const alreadyExists = reasoningTexts.some(
          (existing) => existing === clean || existing.includes(clean) || clean.includes(existing),
        );
        if (alreadyExists) return [];
        reasoningTexts.push(clean);
        return [part];
      }
      // 正文去重防线：若已有正文包含该文本，直接过滤；若为未渲染后缀则保留增量
      if (part.kind === 'text' && part.text) {
        const clean = part.text.trim();
        if (!clean) return [];
        if (text.includes(clean)) return [];
        const suffix = unpaintedReplaySuffix(text, part.text);
        if (!suffix) return [];
        text += suffix;
        return suffix === part.text ? [part] : [{ ...part, text: suffix }];
      }
      return [part];
    });
    if (parts.length > 0) kept.push({ ...message, parts });
  }
  return kept;
}

/** Session detail caps a field at 24KB and appends this marker. The live replay
 *  still carries the original text, so a raw prefix compare misses. */
export const DISPLAY_TRUNCATION_MARK = '\n… [truncated for display]';

export function withoutDisplayTruncation(value: string): string {
  return value.endsWith(DISPLAY_TRUNCATION_MARK)
    ? value.slice(0, -DISPLAY_TRUNCATION_MARK.length)
    : value;
}

/** Coalesced `/chat/watch` replay sends the whole text-so-far as one delta.
 *  Return only the part that is not already on the assistant. */
export function unpaintedReplaySuffix(existing: string, incoming: string): string {
  if (!incoming) return '';
  const existingBody = withoutDisplayTruncation(existing);
  if (!existingBody) return incoming;
  if (incoming.startsWith(existingBody)) {
    return incoming.length === existingBody.length ? '' : incoming.slice(existingBody.length);
  }
  existing = existingBody;
  if (!existing) return incoming;
  if (existing === incoming || existing.endsWith(incoming) || existing.startsWith(incoming)) return '';
  if (incoming.startsWith(existing)) return incoming.slice(existing.length);
  const painted = collapseWs(existing);
  const chunk = collapseWs(incoming);
  if (!chunk) return '';
  if (painted === chunk || painted.endsWith(chunk) || painted.startsWith(chunk)) return '';
  if (chunk.startsWith(painted) && painted.length > 0) {
    let rest = incoming;
    let seen = 0;
    while (rest.length > 0 && seen < painted.length) {
      if (/\s/.test(rest[0]!)) {
        rest = rest.slice(1);
        continue;
      }
      seen += 1;
      rest = rest.slice(1);
    }
    return rest;
  }
  return incoming;
}

type InFlightPart = {
  kind: string;
  text?: string;
  tool?: { id?: string; status?: string; name?: string };
};

/** Trailing assistant still has a running tool, or an empty shell waiting for tokens. */
export function transcriptHasInFlightAssistant(
  messages: Array<{ role: string; parts: InFlightPart[] }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    if (message.parts.length === 0) return true;
    return message.parts.some((part) => {
      if (
        part.kind === 'tool' &&
        (part.tool?.status === 'pending' || part.tool?.status === 'waiting_approval')
      ) {
        return true;
      }
      return false;
    });
  }
  return false;
}

/** A successful `/live/message` receipt means the runtime accepted the input.
 *  Never roll the optimistic bubble back just because the tab's busy flag
 *  missed a `state.running` event (frozen TUI → WebUI looks idle). */
export function liveSubmitKeepsTurn(disposition: 'started' | 'steered'): boolean {
  return disposition === 'started' || disposition === 'steered';
}

/** Disk history is turn-boundary stale while a turn is still running.
 *  Once the turn is finished, disk is authoritative — a longer in-flight cache
 *  is the partial canvas from before we switched away, not a newer transcript. */
export function shouldKeepCachedTranscript(input: {
  cacheLen: number;
  diskLen: number;
  cacheInFlight: boolean;
  turnActive: boolean;
}): boolean {
  if (!input.turnActive) return false;
  if (input.cacheLen <= 0) return false;
  if (input.cacheLen > input.diskLen) return true;
  return input.cacheInFlight || input.cacheLen >= input.diskLen;
}

/** This tab started the turn or is attached to its live stream. */
export function thisTabOwnsTurn(input: {
  isLiveSession: boolean;
  isLocalTurn: boolean;
}): boolean {
  return input.isLiveSession || input.isLocalTurn;
}

/** `/webui` + TUI share one live runtime. Until the snapshot binds
 * `liveSessionId`, treat the viewed session as ours so the composer
 * sends/stops against that unique session. */
export function liveSyncOwnsViewedSession(input: {
  sync: boolean;
  viewedSessionId: string;
  liveSessionId: string | null;
}): boolean {
  if (!input.sync) return false;
  return input.liveSessionId == null || input.liveSessionId === input.viewedSessionId;
}

/**
 * Occupancy never locks an observer. Any view of the unique session can
 * send (steer / interrupt) and stop; `/chat/active` only drives the spinner.
 */
export function shouldLockSendAsDetached(_input: {
  turnActive: boolean;
  thisTabOwnsTurn: boolean;
}): boolean {
  return false;
}

/** Events that prove a turn is actually streaming. Idle `/chat/watch` must not
 * upgrade to busy on `runtime_info` / leftover `user` replay / tokens — that
 * painted a stop button and blinking cursor on already-finished sessions. */
/** After an idle `/live` snapshot, leftover journal events of a finished turn
 *  must not be painted again. A new `user` that is not already on the canvas
 *  (or `state.running=true` that is not stale) starts the next turn.
 *
 *  `turnLive` is the current-turn exception: this tab just submitted, the
 *  canvas already has an empty in-flight assistant, or lifecycle.running is
 *  true. Without it, an idle snapshot followed by our own user echo (already
 *  on the canvas) would swallow every later text/tool event until refresh. */
export function shouldIgnoreLiveReplayAfterIdleSnapshot(
  idleSnapshot: boolean,
  eventType: string,
  turnLive = false,
): boolean {
  if (!idleSnapshot || turnLive) return false;
  switch (eventType) {
    case 'text':
    case 'reasoning':
    case 'tool_start':
    case 'tool_output':
    case 'tool_progress':
    case 'tool_result':
    case 'tokens':
      return true;
    default:
      return false;
  }
}

/** Snapshot of a finished transcript must not arm the leftover-journal gate
 *  when we are keeping an in-flight canvas or already know a turn is live. */
export function idleFlagAfterLiveSnapshot(input: {
  snapshotHasInFlight: boolean;
  keepCanvas: boolean;
  canvasHasInFlight: boolean;
  turnLive: boolean;
  openUserTurn?: boolean;
}): boolean {
  if (input.turnLive || input.openUserTurn) return false;
  if (input.keepCanvas) return !input.canvasHasInFlight;
  return !input.snapshotHasInFlight;
}

/** Own `/live` echo is already on the canvas. Still leave idle-snapshot mode
 *  when that echo belongs to the turn we just started. */
export function shouldClearIdleLiveSnapshotOnUser(input: {
  alreadyOnCanvas: boolean;
  canvasInFlight: boolean;
  turnLive: boolean;
  openUserTurn?: boolean;
}): boolean {
  if (!input.alreadyOnCanvas) return true;
  return input.canvasInFlight || input.turnLive || input.openUserTurn === true;
}

/** Idle hub snapshots report `running: false`. Do not drop a busy cursor that
 *  this tab already armed for an in-flight send. */
export function shouldKeepLiveBusyAcrossIdleSnapshot(input: {
  keepCanvas: boolean;
  canvasInFlight: boolean;
  turnLive: boolean;
  openUserTurn?: boolean;
}): boolean {
  return input.keepCanvas || input.canvasInFlight || input.turnLive || input.openUserTurn === true;
}

const SUBSTANTIAL_REPLAY_DELTA = 8;

function collapseWs(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Opening/closing fence restored from `artifact_*` (e.g. ```` ```text\\n ````). */
export function isMarkdownFenceDelta(incoming: string): boolean {
  return /^\s{0,3}(`{3,}|~{3,})[^\n]*\n?$/.test(incoming);
}

/**
 * True when `incoming` is a journal/replay chunk already painted on the
 * assistant. Sidebar leave → new session → return reconnects `/live`, which
 * snapshot-paints the turn and then replays the same TextDelta/Reasoning
 * window; appending those chunks duplicated 思考过程 / 「正在查看」 blocks.
 *
 * Short streaming tokens (1–4 chars) are not treated as duplicates just
 * because the character appeared earlier in the turn.
 *
 * CRITICAL: Only match at the head (startsWith) or tail (endsWith). Never use
 * includes() in the middle of existing text: a reply can legitimately repeat
 * section templates, headings, code snippets, or list prefixes (e.g. `* **报错输出**：`),
 * and middle includes() swallowed those tokens, corrupting markdown fences and layout.
 */
export function assistantDeltaAlreadyPainted(existing: string, incoming: string): boolean {
  if (!incoming) return true;
  if (!existing) return false;
  if (existing.endsWith(incoming) || existing.startsWith(incoming)) return true;
  if (isMarkdownFenceDelta(incoming)) return false;
  if (incoming.length < SUBSTANTIAL_REPLAY_DELTA) return false;
  const painted = collapseWs(existing);
  const chunk = collapseWs(incoming);
  return chunk.length >= SUBSTANTIAL_REPLAY_DELTA && (painted.startsWith(chunk) || painted.endsWith(chunk));
}

type ReplayPart = {
  kind: string;
  text?: string;
  tool?: { id?: string; output?: string; status?: string };
};

function joinedKindText(parts: ReplayPart[], kind: string): string {
  let out = '';
  for (const part of parts) {
    if (part.kind === kind && part.text) out += part.text;
  }
  return out;
}

/** Skip `/live` journal replay that would re-append text, reasoning, or tool
 *  stdout already restored from snapshot/cache after a session switch. */
export function liveContentDeltaAlreadyOnParts(
  parts: ReplayPart[],
  event: { type: string; content?: string; chunk?: string; id?: string },
): boolean {
  switch (event.type) {
    case 'text':
      return assistantDeltaAlreadyPainted(joinedKindText(parts, 'text'), event.content ?? '');
    case 'reasoning':
      return assistantDeltaAlreadyPainted(
        joinedKindText(parts, 'reasoning'),
        event.content ?? '',
      );
    case 'tool_output': {
      const chunk = event.chunk ?? '';
      if (!chunk) return true;
      const row = event.id
        ? parts.find((part) => part.kind === 'tool' && part.tool?.id === event.id)
        : [...parts].reverse().find((part) => part.kind === 'tool');
      return assistantDeltaAlreadyPainted(row?.tool?.output ?? '', chunk);
    }
    default:
      return false;
  }
}

/** After an idle `/live` snapshot, drop only journal replay that is already
 *  on the canvas. A new text/thinking/tool delta means the turn kept going
 *  (a phone refresh mid-stream) and must be painted. */
export function idleReplayAlreadyPainted(
  messages: Array<{ role: string; parts: ReplayPart[] }>,
  event: { type: string; content?: string; chunk?: string; id?: string },
): boolean {
  const last = [...messages].reverse().find((message) => message.role === 'assistant');
  const parts = last?.parts ?? [];
  switch (event.type) {
    case 'text':
    case 'reasoning':
    case 'tool_output':
      return liveContentDeltaAlreadyOnParts(parts, event);
    case 'tool_start':
      return !!event.id && parts.some((part) => part.kind === 'tool' && part.tool?.id === event.id);
    case 'tool_result':
    case 'tool_progress': {
      if (!event.id) return false;
      const row = parts.find((part) => part.kind === 'tool' && part.tool?.id === event.id);
      if (!row || row.kind !== 'tool') return false;
      const status = row.tool?.status;
      return status === 'done' || status === 'error' || status === 'incomplete';
    }
    case 'tokens':
      return true;
    default:
      return false;
  }
}

export function isWatchTurnActivationEvent(type: string): boolean {
  switch (type) {
    case 'text':
    case 'reasoning':
    case 'tool_start':
    case 'tool_output':
    case 'tool_progress':
    case 'tool_result':
    case 'permission_request':
    case 'user_input_request':
    case 'artifact_start':
    case 'artifact_content':
    case 'artifact_end':
      return true;
    default:
      return false;
  }
}

export type LiveSnapshotQueueDisposition =
  | { discardQueued: false }
  | { discardQueued: true; reason: 'terminal_unknown' };

/**
 * A reconnect snapshot contains persisted history but no terminal reason. If
 * the previous connection observed an active turn, the daemon may have already
 * cleared that turn's replay window while the client was disconnected. Queued
 * input therefore cannot be drained safely until a fresh authoritative turn
 * lifecycle is observed.
 */
export function liveSnapshotQueueDisposition(
  wasRunning: boolean,
  queuedCount: number,
): LiveSnapshotQueueDisposition {
  return wasRunning && queuedCount > 0
    ? { discardQueued: true, reason: 'terminal_unknown' }
    : { discardQueued: false };
}

export type ChatRecoveryState =
  | 'ready'
  | 'checking'
  | 'detached_active'
  | 'terminal_unknown';

export type ChatRecoveryEvent =
  | { type: 'session_switch'; hasSession: boolean }
  | { type: 'active_check_succeeded'; active: boolean }
  | { type: 'active_check_failed' }
  | { type: 'transport_lost' }
  | { type: 'stop_succeeded' }
  | { type: 'stop_failed' }
  | { type: 'authoritative_terminal' };

export interface ChatRecoveryPolicy {
  allowSend: boolean;
  allowQueueDrain: boolean;
  allowStop: boolean;
}

/**
 * Switching views is observation, not occupancy. Discovery of a live turn
 * arms stop; it never blocks send — any observer can interrupt the unique
 * session. `terminal_unknown` keeps the stop alias after a transport drop.
 */
export function reduceChatRecovery(
  _current: ChatRecoveryState,
  event: ChatRecoveryEvent,
): ChatRecoveryState {
  switch (event.type) {
    case 'session_switch':
      return 'ready';
    case 'active_check_succeeded':
      return event.active ? 'detached_active' : 'ready';
    case 'active_check_failed':
      return 'ready';
    case 'transport_lost':
    case 'stop_failed':
      return 'terminal_unknown';
    case 'stop_succeeded':
    case 'authoritative_terminal':
      return 'ready';
  }
}

export function chatRecoveryPolicy(state: ChatRecoveryState): ChatRecoveryPolicy {
  if (state === 'ready') {
    return { allowSend: true, allowQueueDrain: true, allowStop: false };
  }
  // checking / detached_active / terminal_unknown: observer can still
  // interrupt the unique session. Queue drain stays off only after a
  // dropped /chat transport so a stale queue cannot double-submit.
  return {
    allowSend: true,
    allowQueueDrain: state !== 'terminal_unknown',
    allowStop: true,
  };
}

export type SyncAttachDisposition =
  | { allowed: true }
  | { allowed: false; reason: 'active_chat' | 'unresolved_chat' };

export function syncAttachDisposition(
  _chatRunning: boolean,
  _recoveryState: ChatRecoveryState,
): SyncAttachDisposition {
  return { allowed: true };
}

/** Gate every `/chat` event, not only the promise terminal, against replacement. */
export function isCurrentChatStream(
  requestId: string,
  requestGeneration: number,
  currentRequestId: string | null,
  currentGeneration: number,
  aborted: boolean,
): boolean {
  return (
    !aborted &&
    requestId === currentRequestId &&
    requestGeneration === currentGeneration
  );
}

export type LiveDetachDisposition =
  | { allowed: true }
  | { allowed: false; reason: 'active_turn' };

/** Detach from the live stream ownership (rare). View switches use
 * {@link liveSessionSwitchDisposition} instead and are always allowed. */
export function liveDetachDisposition(running: boolean): LiveDetachDisposition {
  return running ? { allowed: false, reason: 'active_turn' } : { allowed: true };
}

/** Switching the WebUI view never rebinds or cancels a CodingRuntime.
 * OpenCode model: selected SessionKey is a client ViewBinding only. */
export function liveSessionSwitchDisposition(_running?: boolean): LiveDetachDisposition {
  return { allowed: true };
}

/** Clear only the structured-input prompt whose native request was resolved.
 * A late terminal for an older request must never dismiss a newer prompt. */
export function resolveUserInputRequest<T extends { request_id: number }>(
  current: T | null,
  resolvedRequestId: number,
): T | null {
  return current?.request_id === resolvedRequestId ? null : current;
}

/** TUI/live can answer or decline `request_user_input` without a matching
 * `user_input_resolved` on the `/chat` bus. The tool result is the close. */
export function toolResultClearsUserInput(name?: string): boolean {
  return name === 'request_user_input';
}

/** Tool row for `callId` already handled (running or finished) — do not resurrect its approval card. */
export function transcriptToolCallIsResolved(
  messages: Array<{ role: string; parts: InFlightPart[] }>,
  callId: string,
): boolean {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.kind !== 'tool' || part.tool?.id !== callId) continue;
      const status = part.tool?.status;
      // 只要该工具状态不是 waiting_approval（已进入 pending 运行中或已完成 done/error/incomplete），
      // 都绝对不能再误判为待审批，严禁复活审批卡或反复弹出系统通知！
      return status !== 'waiting_approval';
    }
  }
  return false;
}

/** Latest `request_user_input` tool on the canvas already has a result.
 * `/chat/pending` must not resurrect the card while TUI keeps chatting. */
export function transcriptLatestUserInputIsResolved(
  messages: Array<{ role: string; parts: InFlightPart[] }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (part.kind !== 'tool' || part.tool?.name !== 'request_user_input') continue;
      const status = part.tool?.status;
      return status !== 'pending' && status !== 'waiting_approval';
    }
  }
  return false;
}

/** Tracks prefix-cache estimation across successive provider usage events. */
export type TokenCacheState = {
  /** Prompt tokens from the immediately prior LLM usage event. */
  lastPrompt: number;
  /** True once the provider has reported `cached > 0` (telemetry is trusted). */
  providerReportsCache: boolean;
  /** Sum of per-step prompts in the current user turn (industrial loop denominator). */
  turnPromptSum: number;
  /** Sum of per-step cache hits in the current user turn (industrial loop numerator). */
  turnCachedSum: number;
};

export function createTokenCacheState(): TokenCacheState {
  return { lastPrompt: 0, providerReportsCache: false, turnPromptSum: 0, turnCachedSum: 0 };
}

export function resetTokenCacheState(baselinePrompt = 0): TokenCacheState {
  return {
    lastPrompt: Math.max(0, baselinePrompt),
    providerReportsCache: false,
    turnPromptSum: 0,
    turnCachedSum: 0,
  };
}

/** Keep prefix baseline across a new user turn; zero the loop accumulators. */
export function startTokenTurn(state: TokenCacheState): TokenCacheState {
  return { ...state, turnPromptSum: 0, turnCachedSum: 0 };
}

/** Provider KV-cache block size. A partial trailing block does not count as a hit. */
export const CACHE_BLOCK_TOKENS = 64;

/**
 * Industrial prefix-cache estimate for one LLM step:
 *   cached_n ≈ prompt_{n-1}  (previous request is the reusable prefix)
 *   hit_n    = cached_n / prompt_n
 * A ≥10% prompt drop invalidates the key (compaction / rewrite).
 * Hits are floored to `CACHE_BLOCK_TOKENS` so a near-equal prompt cannot
 * paint a fake 100% from min(current, previous).
 */
export function estimatePrefixCached(currentPrompt: number, previousPrompt: number): number {
  if (currentPrompt <= 0 || previousPrompt <= 0) return 0;
  if (currentPrompt < previousPrompt * 0.9) return 0;
  const raw = Math.min(currentPrompt, previousPrompt);
  const aligned = Math.floor(raw / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS;
  if (aligned <= 0) return 0;
  // Estimated hits must stay strictly below the current prompt so the footer
  // cannot show 100% unless the provider reported a full-prefix hit.
  return aligned >= currentPrompt ? Math.max(0, aligned - CACHE_BLOCK_TOKENS) : aligned;
}

/** Cached tokens cannot exceed the prompt they were read from. */
export function clampCachedToPrompt(cached: number, prompt: number): number {
  if (cached <= 0 || prompt <= 0) return 0;
  return Math.min(cached, prompt);
}

/** Resolve cache telemetry for the footer pill. Provider `cached > 0` wins;
 * once a provider has reported cache hits we also trust explicit zeros;
 * otherwise fall back to prefix estimation against the prior usage prompt.
 * `prompt === 0` usage events are ignored so they cannot wipe `lastPrompt`
 * (that made the first round of a new turn show no cache). */
export function resolveTokenCache(
  event: { prompt: number; cached?: number },
  state: TokenCacheState,
): { cached: number; cached_estimated: boolean; nextState: TokenCacheState } {
  const prompt = Math.max(0, event.prompt);
  if (prompt <= 0) {
    return { cached: 0, cached_estimated: false, nextState: state };
  }
  const reported = event.cached != null ? Math.max(0, event.cached) : null;
  let providerReportsCache = state.providerReportsCache;
  if (reported != null && reported > 0) providerReportsCache = true;

  let cached = 0;
  let cached_estimated = false;

  if (reported != null && reported > 0) {
    cached = clampCachedToPrompt(reported, prompt);
  } else {
    // Missing or explicit 0: first-round providers often omit cache telemetry.
    // Estimate from the previous request prefix (industrial step n ≈ prompt_{n-1}).
    const estimated = estimatePrefixCached(prompt, state.lastPrompt);
    if (estimated > 0) {
      cached = estimated;
      cached_estimated = true;
    }
  }

  return {
    cached,
    cached_estimated,
    nextState: {
      lastPrompt: prompt,
      providerReportsCache,
      turnPromptSum: state.turnPromptSum + prompt,
      turnCachedSum: state.turnCachedSum + cached,
    },
  };
}

/** Recompute cache while locally growing prompt between provider usage events. */
export function estimateLocalCached(
  state: TokenCacheState,
  prompt: number,
  prev: { cached?: number; cached_estimated?: boolean } | null | undefined,
): { cached: number; cached_estimated: boolean } {
  const prevCached = prev?.cached ?? 0;
  if (prev && prevCached > 0) {
    return {
      cached: prevCached,
      cached_estimated: Boolean(prev.cached_estimated),
    };
  }
  if (state.providerReportsCache && prev && prevCached === 0) {
    return { cached: 0, cached_estimated: false };
  }
  const estimated = estimatePrefixCached(prompt, state.lastPrompt);
  return { cached: estimated, cached_estimated: estimated > 0 };
}

/** Offline cache estimate when reloading a session from message history only. */
export function estimateCacheFromHistoryPrompt(
  currentPrompt: number,
  promptBeforeLastUserTurn: number,
): { cached: number; cached_estimated: boolean; cacheState: TokenCacheState } {
  const cached = estimatePrefixCached(currentPrompt, promptBeforeLastUserTurn);
  return {
    cached,
    cached_estimated: cached > 0,
    cacheState: {
      lastPrompt: currentPrompt,
      providerReportsCache: false,
      turnPromptSum: currentPrompt,
      turnCachedSum: cached,
    },
  };
}

/** Hit rate = cached / prompt (industrial single-step, or loop if sums are passed).
 * 100% is reserved for a real full-prefix provider hit — never from rounding
 * or from min(current, previous) estimates. */
export function formatCacheHitRate(
  cached: number,
  prompt: number,
  estimated = false,
): string | null {
  if (cached <= 0 || prompt <= 0) return null;
  const ratio = (cached / prompt) * 100;
  if (cached >= prompt) return estimated ? '99%' : '100%';
  if (estimated && ratio >= 99) return '99%';
  if (ratio >= 99.5) return '99%';
  if (ratio >= 10) return `${Math.round(ratio)}%`;
  return `${ratio.toFixed(1)}%`;
}

/**
 * Detect persisted footer usage that is turn-cumulative billing rather than
 * last-request occupancy. Older daemons summed every LLM round's prompt/cache
 * into `token_usage`, so a restart painted e.g. 1.7M/1.0M (100% cache) until
 * the next live Usage event replaced it.
 */
export function isStackedTurnBillingUsage(
  usage: { prompt?: number; cached?: number } | null | undefined,
  contextLimit?: number | null,
): boolean {
  if (!usage || !contextLimit || contextLimit <= 0) return false;
  const prompt = usage.prompt ?? 0;
  const cached = usage.cached ?? 0;
  if (prompt <= contextLimit) return false;
  return cached >= prompt * 0.9;
}
