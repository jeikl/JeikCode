/**
 * serverRuntime.ts — 「有没有人在干活」的唯一服务端权威与 busy 的派生规则。
 *
 * 历史教训：busy 曾经是十几处 `setBusy(false)` 的副作用，任何一次「过早收尾」
 * （中间轮 done、磁盘对账、`/chat/active` 恰好处在 `/loop` 的 wakeup 间隙）都会
 * 把按钮/呼吸点切回停止态，而推流仍在继续；只能刷新才能对齐。现在：
 *
 *   1. 服务端 `GET /chat/runtime` 是会话级权威快照（含 `/loop`、`/goal` 控制器），
 *      只在「会话装载/切换、页面重新可见/回前台、网络恢复、终态确认」这些边沿拉取一次；
 *   2. 运行中的状态变化完全靠推送：`/events` 的 `activity`（回合开始/结束、steer
 *      受理、控制器武装/释放）与每个会话的直播帧；
 *   3. 直播内容帧本身也是一条权威证据（服务端正在本会话产字），于是「某处把 busy
 *      清早了」会在下一帧自动纠正；
 *   4. 本端刚发出的 POST（abortRef 仍在）与用户手动停止的 2.5s 防抖窗口是仅有的
 *      两个允许否决服务端的例外。
 *
 * 这里没有任何定时轮询。
 */

/** 能证明「服务端此刻正在本会话执行」的直播帧。终态帧不算。 */
export const RUNNING_PROOF_FRAME_TYPES: ReadonlySet<string> = new Set([
  'user',
  'text',
  'reasoning',
  'tool_start',
  'tool_output',
  'tool_progress',
  'tool_finished',
  'tool_result',
  'permission_request',
  'user_input_request',
  'artifact_start',
  'artifact_content',
  'artifact_end',
  'steered',
]);

/**
 * 这一帧能否作为「回合仍在跑」的点亮证据。
 *
 * 回放帧（重连/刷新补历史）只是把已经发生过的内容再落一遍，不代表此刻仍在
 * 执行，必须排除；否则用户刚点停止，重连回放会立刻把红方块点亮回去。
 */
export function isRunningProofFrame(type: string, replay: boolean): boolean {
  return !replay && RUNNING_PROOF_FRAME_TYPES.has(type);
}

export type RuntimeBusyAction = 'arm' | 'settle' | 'none';

/**
 * 依据服务端权威运行态决定 busy 的下一步。
 *
 * - `arm`：服务端说在跑，本端却熄灭着 → 立刻点亮（等待唤醒的 `/loop` 也算在跑）；
 * - `settle`：服务端说空闲，且本端没有在途 POST、也不在手动停止防抖窗口 → 熄灭；
 * - `none`：其余情况保持现状（在途 POST 可能还没被 admit 进注册表）。
 */
export function resolveRuntimeBusyAction(input: {
  serverRunning: boolean;
  busy: boolean;
  /** 本端还有未完成的 `/chat` POST（admission 尚未落定）。 */
  hasForegroundSend: boolean;
  /** 本端正处于「立即发送」交接或新回合尚未吐帧的保护窗口（旧回合滞后空闲不得误杀）。 */
  hasPendingTurnHandover?: boolean;
  /** 用户刚点过停止：防抖窗口内绝不让服务端/回放把它点亮回去。 */
  inManualStopGuard: boolean;
}): RuntimeBusyAction {
  if (input.serverRunning) {
    return !input.busy && !input.inManualStopGuard ? 'arm' : 'none';
  }
  if (!input.busy) return 'none';
  if (input.hasForegroundSend || input.hasPendingTurnHandover || input.inManualStopGuard) {
    return 'none';
  }
  return 'settle';
}

/** 服务端 `/chat/runtime` 快照（字段缺失时按空闲处理）。 */
export interface ServerChatRuntime {
  running?: boolean;
  source?: string | null;
  status?: string | null;
  /** 权威执行阶段；`compacting` 时与 `compaction_started_at` 一起恢复标记与计时。 */
  phase?: string | null;
  phase_started_at?: number | null;
  /** 当前阶段 owner（manual/turn/live），用于诊断与防跨 owner 误清。 */
  owner?: string | null;
  /** 执行阶段 revision；客户端只接受更高版本。 */
  revision?: number;
  started_at?: number | null;
  /** 当前压缩 pass 的墙钟起点（epoch ms）；压缩结束后为 null。 */
  compaction_started_at?: number | null;
  turn_id?: string | null;
  loop?: { active?: boolean; round?: number; label?: string } | null;
  goal?: { active?: boolean } | null;
  last_terminal?: string | null;
  terminal_seq?: number;
}

/** 保守解析：只有显式 `running: true` 才算在跑。 */
export function serverRuntimeRunning(runtime: ServerChatRuntime | null | undefined): boolean {
  return runtime?.running === true;
}

export type DoneConfirmationAction =
  | 'finish'
  | 'wait_controller'
  | 'reattach_new_turn'
  | 'retry_shutdown';

export interface ResolveDoneConfirmationInput {
  runtime: ServerChatRuntime | null | undefined;
  /** done 事件自身携带的 operation_id（若有） */
  completedOperationId?: string | null;
  /** 前端记录的当前回合 operation_id / request_id */
  expectedOperationId?: string | null;
  /** 剩余重试次数（首次调用通常 > 0，退避耗尽时为 0） */
  attemptsLeft: number;
  inManualStopGuard: boolean;
}

/**
 * 收到 `done` 终态后，结合服务端 `/chat/runtime` 权威快照决定前端收尾动作：
 * - 空闲或处于手动停止保护期内：直接收尾（`'finish'`）；
 * - 后台控制器（`loop` / `goal`）保持激活：保持停驻等待下一轮唤醒（`'wait_controller'`）；
 * - `chat` 通道已切换为另一个不同 `turn_id` 或 `live` 在跑：重连新回合实时流（`'reattach_new_turn'`）；
 * - 同一回合仍在做收尾清理（`handle.shutdown().await` 等）：在有限退避次数内重试（`'retry_shutdown'`），耗尽后直接 `'finish'`，防止停在假忙碌与无限计时。
 */
export function resolveDoneConfirmation(
  input: ResolveDoneConfirmationInput,
): DoneConfirmationAction {
  if (input.inManualStopGuard || !serverRuntimeRunning(input.runtime)) {
    return 'finish';
  }
  const source = input.runtime?.source;
  if (source === 'loop' || source === 'goal') {
    return 'wait_controller';
  }
  if (source === 'live') {
    return 'reattach_new_turn';
  }
  if (source === 'chat' || !source) {
    const serverTurnId = input.runtime?.turn_id;
    const knownTurnIds = [input.completedOperationId, input.expectedOperationId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (
      typeof serverTurnId === 'string' &&
      serverTurnId.length > 0 &&
      knownTurnIds.length > 0 &&
      !knownTurnIds.includes(serverTurnId)
    ) {
      return 'reattach_new_turn';
    }
    return input.attemptsLeft > 0 ? 'retry_shutdown' : 'finish';
  }
  if (source === 'compaction') {
    return input.attemptsLeft > 0 ? 'retry_shutdown' : 'finish';
  }
  return input.attemptsLeft > 0 ? 'retry_shutdown' : 'finish';
}
