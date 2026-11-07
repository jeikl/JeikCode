import {
  isInternalHistoryUserMessage,
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
} from './wire/legacy.ts';

/** One user question in the session outline (DeepSeek-style right rail). */
export interface TurnNavItem {
  /** Stable DOM id on the user message wrapper. Derived from `index`. */
  id: string;
  /** Session-wide outline ordinal. Display metadata only — never an identity:
   *  the canvas numbers the *loaded window*, which drifts from the server outline
   *  as soon as history is paginated or internal rows exist. */
  ordinal: number;
  /** Absolute index in the raw persisted transcript, used for history loading
   *  and as the canonical anchor identity (unique across pages). */
  index: number;
  /** Outline label. Kept intact on purpose: the rail is resizable, so the
   *  visual ellipsis is decided by CSS at the real available width instead of a
   *  fixed character count. */
  label: string;
  /** Short compacted display/search text (the server's outline label). */
  text: string;
  /** Stable persisted message id; primary dedupe identity when available. */
  messageId?: string;
  /** Full question text resolved from the loaded message window, when available.
   *  The outline itself only carries a short label; the canvas owns the full text. */
  fullText?: string;
  /** Admitted but not yet folded/persisted (durable input log). */
  pending?: boolean;
  /** Admission sequence from the input log. */
  seq?: number;
}

/**
 * Anchor DOM id for one user turn: identity first, positional index only for
 * legacy rows without a persisted id. The index is a pagination coordinate and
 * must never become the cross-page identity.
 */
export function turnNavId(messageId: string | undefined, index: number): string {
  return `turn-nav-${messageId ?? index}`;
}

export function compactTurnNavText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 提问大纲去重与规范化（彻底解决乐观发送/回放对账导致的尾部 2~3 条提问重复问题）。
 *
 * 核心规则：
 * 1. 绝对下标去重（同一 index 只保留一个条目）；
 * 2. 文本语义去重：若两条条目的提问文本完全一致，或其中一条是另一条的截断前缀（例如 steer 提问被信封切掉一截），
 *    合并为单一真实条目，保留更早的权威 index 与更完整的内容；
 * 3. 严格按 index 升序排列。
 */
type OutlineLike = { index: number; id?: string; label?: string; text?: string; ordinal?: number; pending?: boolean; seq?: number };

function outlineText(t: OutlineLike): string {
  return t.label ?? t.text ?? '';
}

/**
 * 合并服务端大纲与本地在途/乐观大纲条目。
 * 
 * 核心铁律：
 * 当会话还在运行（或最新一条提问刚发出尚未落盘时），本地的大纲可能包含了
 * 服务端磁盘切片里尚未记录的最新用户提问。此时若无脑拿服务端的 detail.turns
 * 覆盖整个 state，正在运行的最新提问就会瞬间从大纲面板中消失！
 * 因此必须以服务端大纲为基石，并将本地更新的尾部提问安全合并进来。
 */
export function mergeServerWithLocalOutline<T extends OutlineLike>(
  serverTurns: T[],
  localTurns: T[],
): T[] {
  if (!localTurns || localTurns.length === 0) return serverTurns || [];
  if (!serverTurns || serverTurns.length === 0) return localTurns;

  const serverIndices = new Set(serverTurns.map((t) => t.index));
  const serverIds = new Set(serverTurns.map((t) => t.id).filter(Boolean));
  const maxServerIndex = Math.max(...serverTurns.map((t) => t.index));

  // 筛选出本地更新的、明显在服务端大纲之后或尚未落盘的大纲条目
  const trailingLocal = localTurns.filter((local) => {
    if (local.id && serverIds.has(local.id)) return false;
    if (serverIndices.has(local.index)) return false;
    // 只有绝对下标大于服务端最大下标（真正的尾部最新提问）才保留
    return local.index > maxServerIndex;
  });

  return dedupeTurnOutline([...serverTurns, ...trailingLocal]);
}

export function fullerOutline<T extends OutlineLike>(
  a: T[] | null | undefined,
  b: T[] | null | undefined,
): T[] {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  // Both candidates cover the same session. A tail-window cache has fewer
  // entries but a HIGHER first index; choosing by length keeps the complete
  // outline instead of letting a 2-turn slice replace a 30-turn rail.
  return left.length >= right.length ? left : right;
}

export function dedupeTurnOutline<T extends OutlineLike>(turns: T[]): T[] {
  if (!turns || turns.length <= 1) return turns || [];
  const result: T[] = [];
  for (const t of turns) {
    const label = compactTurnNavText(
      stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(outlineText(t))),
    );
    if (!label) continue;

    // Identity is the persisted id whenever both rows carry one. `index` is
    // only a legacy fallback for pre-id rows; it is a coordinate, never an
    // identity — two different questions can share a provisional index.
    const matchIdx = result.findIndex((prev) => {
      if (t.id && prev.id) return t.id === prev.id;
      return prev.index === t.index;
    });

    if (matchIdx >= 0) {
      const existing = result[matchIdx]!;
      const existingLabel = compactTurnNavText(
        stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(outlineText(existing))),
      );
      // Same row arrived twice: keep the richer label, but never let a
      // provisional pending index override the persisted row's index. When
      // both are settled, the first entry is the server/authoritative row.
      const richer = label.length > existingLabel.length ? t : existing;
      const preferredIndex =
        existing.pending === true && t.pending !== true
          ? t.index
          : t.pending === true && existing.pending !== true
            ? existing.index
            : existing.index;
      result[matchIdx] = {
        ...richer,
        id: existing.id ?? t.id,
        index: preferredIndex,
        ordinal: existing.ordinal ?? t.ordinal,
        // A promoted row supersedes a pending row with the same identity.
        ...(existing.pending === true && t.pending !== true ? { pending: false } : {}),
        seq: existing.seq ?? t.seq,
      };
    } else {
      result.push({ ...t });
    }
  }
  return result.sort((a, b) => a.index - b.index);
}

export function buildTurnNavItemsFromOutline(
  turns: { ordinal?: number; index: number; id?: string; label: string; pending?: boolean; seq?: number }[],
): TurnNavItem[] {
  const items: TurnNavItem[] = [];
  const cleanTurns = dedupeTurnOutline(turns);
  for (const turn of cleanTurns) {
    const raw = turn.label ?? '';
    // 关键修复：先剥离 steer 转向封套与提醒前缀，再判断是否为内部系统行。
    // 杜绝因 raw 开头携带 '[jeikcode-steer]' 协议前缀而将用户的转向提问在刷新后误删出大纲！
    const stripped = stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(raw));
    if (!stripped || isInternalHistoryUserMessage(stripped)) continue;
    const text = compactTurnNavText(stripped);
    const label = text;
    if (!label) continue;
    const ordinal = turn.ordinal ?? items.length;
    items.push({
      id: turnNavId(turn.id, turn.index),
      messageId: turn.id,
      ordinal,
      index: turn.index,
      label,
      text,
      ...(turn.pending ? { pending: true } : {}),
      ...(typeof turn.seq === 'number' ? { seq: turn.seq } : {}),
    });
  }
  return items;
}

export function buildTurnNavItems(
  messages: { role: string; text: string; id?: string; sourceIndex?: number }[],
  windowOffset = 0,
): TurnNavItem[] {
  const items: TurnNavItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = compactTurnNavText(
      stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(msg.text)),
    );
    const label = text;
    if (!label) continue;
    // History rendering filters synthetic messages and folds tool-result rows
    // into their assistant. Prefer the raw transcript index carried through
    // conversion; the visible index is only a fallback for live/legacy data.
    const index = msg.sourceIndex ?? windowOffset + i;
    const ordinal = items.length;
    // Same contract as the outline path: the id is the absolute index, `ordinal`
    // is only carried along for display/back-compat.
    items.push({ id: turnNavId(msg.id, index), messageId: msg.id, ordinal, index, label, text, fullText: text });
  }
  return items;
}

/**
 * 画布实际头部对应的分页游标。
 *
 * 游标语义是「连续加载到的头部」，右栏点击只拿它做一次性判定：
 * `index < cursor` 才去拉页。它一旦比画布头部更靠前（权威尾部对账把画布
 * 裁回窗口、缓存被截断等），更早的提问就永远不拉取——点上去只是死链。
 * 因此每次画布被整段替换/裁剪后都要用这个函数重新对齐。
 */
export function canvasHistoryHead(
  messages: Array<{ sourceIndex?: number }>,
): number | null {
  let head: number | null = null;
  for (const message of messages) {
    if (typeof message.sourceIndex !== 'number') continue;
    if (!Number.isFinite(message.sourceIndex) || message.sourceIndex < 0) continue;
    if (head === null || message.sourceIndex < head) head = message.sourceIndex;
  }
  return head;
}

/** 画布裁剪后用画布头部重算「还能不能往前加载」。 */
export function historyCursorFor(
  messages: Array<{ sourceIndex?: number }>,
  turns: Array<{ index: number }> | undefined,
): { offset: number; hasOlder: boolean } | null {
  const head = canvasHistoryHead(messages);
  if (head === null) return null;
  const firstTurnIndex = turns?.[0]?.index ?? 0;
  const hasOlder = hasOlderVisibleMessages({
    offset: head,
    firstTurnIndex,
    canvasHasFirstTurn: messages.some(
      (message) => typeof message.sourceIndex === 'number' && message.sourceIndex <= firstTurnIndex,
    ),
  });
  return { offset: head, hasOlder };
}

/** Convert a target's viewport position into a scrollTop inside its chat root. */
export function turnNavScrollTop(
  rootScrollTop: number,
  rootViewportTop: number,
  targetViewportTop: number,
): number {
  return Math.max(0, rootScrollTop + targetViewportTop - rootViewportTop);
}

/** Case-insensitive substring filter over the full question text. */
export function filterTurnNavItems(items: TurnNavItem[], query: string): TurnNavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => (it.fullText ?? it.text).toLowerCase().includes(q));
}

/**
 * 是否还有更早的【可见】历史消息未加载。
 *
 * 核心架构防线：
 * 会话前缀（0..firstTurnIndex）通常全为 System prompts 与 synthetic 技能/MCP 指令（例如前 8 条全不可见）。
 * 此时当 offset 已经抵达或越过首个用户提问（offset <= firstTurnIndex），或者画布顶部已经绘制了
 * 首个提问时，上方剩余的仅为不可见系统指令，绝不能向用户展示「还剩 8 条」幽灵气泡或允许向空展开。
 */
/**
 * 画布顶部**还有更早的历史没加载**吗？
 *
 * 唯一判据是身份：画布首行的 `seq` 是否大于会话最早的 `seq`。
 *
 * 旧实现对 `offset` 做了过多推断（`offset <= threshold` 就判“到顶”），
 * 结果两点都有 bug：
 * - 用户点过向上展开后 `offset` 被写成缓存游标，刷新时与画布实际内容脱节 →
 *   按钮消失或永远显示；
 * - 窗口首行 `seq` 明明还有更早的行，但因为 `offset` 被裁成 0 就判到顶。
 *
 * `offset` 只作为没有 seq 的旧 daemon 的回退判据。
 */
export function hasOlderVisibleMessages(input: {
  offset: number;
  firstTurnIndex?: number;
  canvasHasFirstTurn?: boolean;
  /** Identity-first cursor: when the first loaded row has a server seq, use it. */
  oldestSeq?: number;
  /** First visible outline turn's seq, when known. */
  firstTurnSeq?: number;
}): boolean {
  if (typeof input.oldestSeq === 'number') {
    // 身份优先：首行 seq 就是会话最小 seq（或已经覆盖大纲首问）→ 真的到顶。
    if (input.oldestSeq <= 0) return false;
    if (typeof input.firstTurnSeq === 'number' && input.oldestSeq <= input.firstTurnSeq) return false;
    if (input.canvasHasFirstTurn === true) return false;
    return true;
  }
  if (input.offset <= 0) return false;
  const threshold = input.firstTurnIndex ?? 0;
  if (input.offset <= threshold) return false;
  if (input.canvasHasFirstTurn) return false;
  return true;
}

/**
 * 画布是否已经到会话开头。
 *
 * 「向上展开」闪一下就回来，根本原因是画布已经持有全量历史（同步异常后被回灌），
 * 而分页返回的每一行都是重复行 —— 合并不增长、入口却还在。
 * 判据只用服务端身份（offset / seq），绝不按文本猜。
 */
export function canvasAtVeryBeginning(input: {
  offset: number;
  canvasHeadSeq?: number;
  pageHeadSeq?: number;
  firstTurnSeq?: number;
}): boolean {
  if (input.offset <= 0) return true;
  const head = input.canvasHeadSeq;
  if (typeof head !== 'number') return false;
  // 必须真正到达会话开头的最小 seq（或首个可见提问的 seq），绝不能拿当前视口切片的首行 seq 比对，
  // 否则在冷启动时尾页首行（例如 seq: 166）会与本地缓存首行（seq: 166）相等而被误判为整篇会话到顶！
  if (typeof input.firstTurnSeq === 'number' && head <= input.firstTurnSeq) return true;
  if (head <= 1) return true;
  return false;
}

/**
 * 综合判定「向上展开」入口是否可见：同时结合页偏移/最小 seq 与当前画布真实首行身份，
 * 防止画布已持有全量历史时 offset/oldest_seq 仍残留幽灵入口。
 */
export function computeEffectiveHasOlder(input: {
  offset: number;
  firstTurnIndex?: number;
  canvasHasFirstTurn?: boolean;
  oldestSeq?: number;
  firstTurnSeq?: number;
  canvasHeadSeq?: number;
  pageHeadSeq?: number;
  hasCanvasRows?: boolean;
}): boolean {
  const olderExists = hasOlderVisibleMessages({
    offset: input.offset,
    firstTurnIndex: input.firstTurnIndex,
    canvasHasFirstTurn: input.canvasHasFirstTurn,
    oldestSeq: input.oldestSeq,
    firstTurnSeq: input.firstTurnSeq,
  });
  if (!olderExists) return false;
  if (input.hasCanvasRows === false) return true;
  return !canvasAtVeryBeginning({
    offset: input.offset,
    canvasHeadSeq: input.canvasHeadSeq,
    pageHeadSeq: input.pageHeadSeq,
    firstTurnSeq: input.firstTurnSeq,
  });
}

/**
 * 「向上展开」是不是一个真能取到更早行的入口。
 *
 * 可见性（`hasOlder`）与动作（`loadOlderMessages`）必须共用这一个判定，否则就会出现
 * 「明明已经在顶部，却还显示向上展开 N 条，点下去什么都不发生」的幽灵卡片。
 * 偏移量归零后仍可用服务端 `seq` 作 `before_seq` 往前翻，所以只看 offset 会误判。
 */
export function canLoadOlder(input: {
  hasOlder: boolean;
  offset: number;
  headSeq?: number;
}): boolean {
  if (!input.hasOlder) return false;
  // `hasOlder` 已经是身份对账的结果（首行 seq 之后是否还有更早的行）。
  // 只要它成立，就一定有办法翻页：有 offset 用 offset，没 offset 用 before_seq。
  if (Number.isFinite(input.offset) && input.offset > 0) return true;
  return typeof input.headSeq === 'number' && Number.isFinite(input.headSeq) && input.headSeq > 0;
}

/**
 * 剩余未加载的【可见】消息数量（扣除会话开头的不可见系统指令前缀）。
 */
export function visibleOlderRemainingCount(offset: number, firstTurnIndex?: number): number {
  if (offset <= 0) return 0;
  const threshold = firstTurnIndex ?? 0;
  return Math.max(0, offset - threshold);
}

/**
 * 尚未加载到画布上的提问数（按服务端大纲的绝对 index 对账）。
 *
 * 旧计数器用「offset - 首问下标」算原始行数；一个回合往往包含几十上百条
 * tool/tool_result 行，会被误显示成「还剩 568 条消息」。这里只数真正能在
 * 右栏和画布上看到的提问，加载按钮的数字才与用户感知一致。
 */
export function remainingUnloadedTurns(
  turns: { index: number; id?: string }[],
  messages: { role: string; sourceIndex?: number; id?: string; clientInputId?: string }[],
): number {
  if (turns.length === 0) return 0;
  const loadedIndices = new Set<number>();
  const loadedIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'user') {
      if (typeof message.sourceIndex === 'number') loadedIndices.add(message.sourceIndex);
      if (message.id) loadedIds.add(message.id);
      if (message.clientInputId) loadedIds.add(message.clientInputId);
    }
  }
  return turns.reduce((count, turn) => {
    if (turn.id && loadedIds.has(turn.id)) return count;
    if (loadedIndices.has(turn.index)) return count;
    return count + 1;
  }, 0);
}

export interface TurnNavScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Stable outline spy: last question whose content top is still above a
 * near-top marker. Avoids IntersectionObserver flicker between neighbours.
 * At the bottom of the thread, always the last question (its answer fills the view).
 */
export function resolveActiveTurnId(
  items: { id: string }[],
  contentTopById: (id: string) => number | undefined,
  metrics: TurnNavScrollMetrics,
  opts?: { markerOffsetPx?: number; bottomSlack?: number },
): string | null {
  if (items.length === 0) return null;
  const markerOffsetPx = opts?.markerOffsetPx ?? 24;
  const bottomSlack = opts?.bottomSlack ?? 32;
  const { scrollTop, clientHeight, scrollHeight } = metrics;
  if (scrollTop + clientHeight >= scrollHeight - bottomSlack) {
    return items[items.length - 1].id;
  }
  const marker = scrollTop + markerOffsetPx;
  let active = items[0].id;
  for (const item of items) {
    const top = contentTopById(item.id);
    if (top == null || !Number.isFinite(top)) continue;
    if (top <= marker) active = item.id;
    else break;
  }
  return active;
}
