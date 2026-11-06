/**
 * 压缩阶段（`Compacting…`）的纯展示判定。
 *
 * 压缩既不是一条 assistant 内容，也不是某一轮的私有状态：刷新/切会话/断线后
 * 它必须能从服务端权威快照（`GET /chat/runtime`）恢复。标记与计时都从这里
 * 派生，渲染层不得各自再造一份，否则就会出现「两个 Compacting…」或
 * 「标记丢了只剩计时器」。
 */

export type ChatStatusRole = 'user' | 'assistant' | 'system' | undefined;

/**
 * 实时用时锚点。
 *
 * 压缩期间没有新的用户提问，`userTs` 仍是上一轮提问的时刻；若让它优先，
 * 计时器会显示上一轮已经过去的时长。压缩自己的开始时刻才是唯一正确锚点，
 * 其次是本回合开始时刻，最后才回退到用户提问时间。
 */
export function resolveLiveElapsedAnchor(input: {
  compacting: boolean;
  compactionStartedAt?: number | null;
  turnStartedAt?: number | null;
  userTs?: number | null;
  /** 当前墙钟：服务端时钟可能略快，锚点不得越过 now（否则计时器会瞬间消失）。 */
  now?: number;
}): number | undefined {
  const { compacting, compactionStartedAt, turnStartedAt, userTs, now } = input;
  const anchor = compacting
    ? compactionStartedAt ?? turnStartedAt ?? userTs ?? undefined
    : userTs ?? turnStartedAt ?? undefined;
  if (anchor == null) return undefined;
  if (now != null && Number.isFinite(now) && anchor > now) return now;
  return anchor;
}

/**
 * 是否需要独立的 `Compacting… / Working…` 状态行。
 *
 * `busy` 且**最后一行可见消息**是 assistant 时，助手气泡内的 shimmer 已经承担了
 * 标记（见 `AssistantMessageView` 的 `isLast`）；再画一行就是重复的 `Compacting…`。
 * 注意不能跳过末尾 system 通知来判断压缩：气泡的 shimmer 只在“它就是最后一行”时
 * 渲染，末尾一旦有通知，就必须由独立状态行兜底。
 */
export function standaloneStatusMode(input: {
  compacting: boolean;
  busy: boolean;
  /** 最后一行可见消息的角色（含 system 通知）。 */
  lastVisibleRole: ChatStatusRole;
  /** 最后一条非 system 消息的角色（Working 圈子沿用它）。 */
  lastRole: ChatStatusRole;
}): 'compacting' | 'working' | null {
  const { compacting, busy, lastVisibleRole, lastRole } = input;
  if (compacting) {
    // 压缩已结束但服务端仍处于压缩阶段（或刷新后尚未吐首帧）时气泡不会流动，
    // 必须由独立状态行兜底；只有“正在流式输出的 assistant 气泡”才拥有标记。
    if (busy && lastVisibleRole === 'assistant') return null;
    return 'compacting';
  }
  if (busy && lastRole === 'user') return 'working';
  return null;
}
