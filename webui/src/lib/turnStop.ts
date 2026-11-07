/**
 * 「停止当前运行中回合」的共享判定：WebUI 的「停止」按钮、排队卡片的「立即发送」，
 * 以及程序化停止后的终态收尾都依赖这里的规则。
 *
 * 历史教训：本端回合被 `/chat` admit（202 Accepted）之后 `requestIdRef` 即被清空，
 * 会话 id 才是长期有效的停止别名。若停止只认 request id 别名，停止会被整体跳过，
 * 紧接着的投递必然撞上后端 409 `session_busy`，消息被退回收件箱式的排队卡片。
 */

/** 「立即发送」发起的程序化停止标记：旧回合的 `stopped` 终态到达时按此一次性识别。 */
export interface ProgrammaticStopMark {
  sessionId: string;
  expiresAt: number;
  /** Operation id of the displaced turn. New daemons stamp terminals with the
   *  same id, so the replacement turn's terminal must not be swallowed. */
  operationId?: string;
}

/**
 * 解析停止运行中回合应投递的别名集合（按序去重，忽略空白）。
 *
 * 后端对未知别名是幂等空操作（返回 `was not running`），因此可以安全地全量投递：
 * 全新会话首轮尚未绑定 id 之前用 request id 别名，绑定之后会话 id 别名长期有效。
 */
export function runningTurnStopAliases(input: {
  requestAlias?: string | null;
  sessionId?: string | null;
}): string[] {
  const aliases: string[] = [];
  for (const candidate of [input.requestAlias, input.sessionId]) {
    const alias = candidate?.trim();
    if (alias && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases;
}

/**
 * 该 `stopped` 终态是否属于「立即发送」发起的程序化停止（一次性抑制标记）。
 *
 * 命中时必须跳过 `restoreQueuedToComposer()`：用户只要求立刻发出这一条，
 * 其余排队卡片与已投递的转向必须原地保留，绝不能整段回吐到输入框或被顺带撤回。
 * 会话 id 不匹配或标记已过期时一律回退到用户主动停止的既有语义。
 */
export function consumesProgrammaticStopMark(
  mark: ProgrammaticStopMark | null | undefined,
  sessionId: string | null | undefined,
  now: number,
  operationId?: string | null,
): boolean {
  if (!mark) return false;
  const sid = sessionId?.trim();
  if (!sid || sid !== mark.sessionId) return false;
  if (mark.operationId && operationId && mark.operationId !== operationId) return false;
  return now <= mark.expiresAt;
}

/** Minimal terminal-frame shape needed to classify a displaced turn. */
export interface StopTerminalFrame {
  type: string;
  stop_reason?: string;
  operation_id?: string;
}

/**
 * Is this terminal frame still reporting the turn that 「立即发送」 displaced?
 *
 * A cancelled turn emits `done(stop_reason=cancelled)` **and** a legacy
 * `stopped`. Both belong to the old turn: settling the connection or clearing
 * busy on them flips the send button back to the arrow while the replacement
 * turn is already streaming. A normal completion (`done` without a cancel/stop
 * reason) must still be honoured.
 */
export function isStaleProgrammaticStopFrame(
  mark: ProgrammaticStopMark | null | undefined,
  frame: StopTerminalFrame,
  sessionId: string | null | undefined,
  now: number,
): boolean {
  if (!consumesProgrammaticStopMark(mark, sessionId, now, frame.operation_id)) return false;
  if (frame.type === 'stopped') return true;
  return (
    frame.type === 'done' &&
    (frame.stop_reason === 'cancelled' || frame.stop_reason === 'stopped')
  );
}

/**
 * Is a terminal frame arriving **after a new turn was delivered, but before that
 * turn produced any frame**, actually the previous turn's cached terminal?
 *
 * `/chat/watch` re-sends `session_terminal` to a reattaching watcher when the
 * session looks idle. A freshly-drained steer starts its POST a moment later, so
 * the cached `done` can land in between and would otherwise clear `busy` / close
 * the new connection: the send button flips back to the arrow while the agent is
 * running ("fake stop"). A turn that already produced a frame owns the next
 * terminal, and the window expires so a genuinely silent failure cannot wedge it.
 */
export function isStaleTerminalForArmedTurn(input: {
  armedAt?: number;
  frameSeen: boolean;
  now: number;
  ttlMs?: number;
}): boolean {
  if (input.armedAt == null) return false;
  if (input.frameSeen) return false;
  return input.now - input.armedAt <= (input.ttlMs ?? 15_000);
}

/**
 * 当前会话是否正处于「立即发送 / 新回合切换」的保护窗口内。
 *
 * Single Event Bus 架构下，`POST /chat` 收到 `202 Accepted`（数毫秒）后前台 HTTP
 * 请求即结束（`abortRef === null`），但被「立即发送」停掉的旧回合退场广播的
 * `activity(running: false)`、磁盘空闲探针（`!fresh.running`）或旧观察流的
 * `watch_closed` 往往滞后到达。只要处于以下任一阶段，外部空闲信号均属于旧回合残影，
 * 绝不能据此掐断新回合的 `/chat/watch` 流或清掉 `busy`：
 *   1. `sendNowUntil`：「立即发送」正在执行 `stopRunningTurn -> deliver` 交接；
 *   2. `armedAt`（且 `!frameSeen`）：新回合已投递但尚未收到首帧；
 *   3. `mark`（且 `!frameSeen`）：程序化停止标记仍在有效期内，新回合尚未吐帧。
 */
export function isTurnHandoverProtected(input: {
  sessionId: string | null | undefined;
  now: number;
  sendNowUntil?: number;
  armedAt?: number;
  frameSeen: boolean;
  mark?: ProgrammaticStopMark | null;
}): boolean {
  const sid = input.sessionId?.trim();
  if (!sid) return false;
  if (input.sendNowUntil != null && input.now <= input.sendNowUntil) return true;
  if (
    isStaleTerminalForArmedTurn({
      armedAt: input.armedAt,
      frameSeen: input.frameSeen,
      now: input.now,
    })
  ) {
    return true;
  }
  if (!input.frameSeen && consumesProgrammaticStopMark(input.mark, sid, input.now)) {
    return true;
  }
  return false;
}

const LANDING_EPOCH_KEY = '__landing__';

function sendNowEpochKey(sessionId: string | null | undefined): string {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : LANDING_EPOCH_KEY;
}

/** 按会话隔离递增「立即发送」代数，互不取消其他会话正在交接的立即发送。 */
export function bumpSessionSendNowEpoch(
  epochs: Map<string, number>,
  sessionId: string | null | undefined,
): number {
  const key = sendNowEpochKey(sessionId);
  const next = (epochs.get(key) ?? 0) + 1;
  epochs.set(key, next);
  return next;
}

/** 校验该会话的「立即发送」交接是否仍为最新代数（未被同会话的新操作或手动停止打断）。 */
export function isCurrentSessionSendNowEpoch(
  epochs: Map<string, number>,
  sessionId: string | null | undefined,
  expectedEpoch: number,
): boolean {
  const key = sendNowEpochKey(sessionId);
  return (epochs.get(key) ?? 0) === expectedEpoch;
}

/**
 * 这一条停止别名是否允许紧接着投递下一回合。
 *
 * `released: true` 是权威结论。`was not running` 是幂等空操作（别名本来就没占槽），
 * 不能拿它否决同一次停止里真正停掉的那条别名——否则「立即发送」会整段跳过投递，
 * 消息只留在磁盘上，刷新才出现。
 * 仍在运行（`released: false` 且文案不是 was not running）必须继续等待。
 */
export function stopAliasAllowsNextTurn(result: {
  released?: boolean;
  message?: string | null;
}): boolean {
  if (result.released !== false) return true;
  return /was not running/i.test(result.message ?? '');
}
