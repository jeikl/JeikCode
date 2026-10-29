import {
  isInternalHistoryUserMessage,
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
} from './historyMessages.ts';

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
}

/**
 * Anchor DOM id for one user turn.
 *
 * The key MUST be the absolute transcript index (`sourceIndex`), not a
 * window-relative ordinal: the outline covers the whole session while the canvas
 * only holds the loaded window, so an ordinal-based id points at a different row
 * (or collides across pages) the moment history is paginated.
 */
export function turnNavId(index: number): string {
  return `turn-nav-${index}`;
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
type OutlineLike = { index: number; id?: string; label?: string; text?: string; ordinal?: number };

function outlineText(t: OutlineLike): string {
  return t.label ?? t.text ?? '';
}

export function dedupeTurnOutline<T extends OutlineLike>(turns: T[]): T[] {
  if (!turns || turns.length <= 1) return turns || [];
  const result: T[] = [];
  for (const t of turns) {
    const c = compactTurnNavText(
      stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(outlineText(t))),
    );
    if (!c) continue;

    // 检查是否已有完全匹配、相似、或包含关系的提问。
    // 服务端大纲只带短 label（以 … 结尾）；不同 index 的截断 label 不能按
    // 文本相似度合并，否则前缀相同的两个真实长提问会被误删。
    const capped = c.endsWith('…');
    const matchIdx = result.findIndex((prev) => {
      if (t.id && prev.id && t.id === prev.id) return true;
      if (prev.index === t.index) return true;
      const prevC = compactTurnNavText(
        stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(outlineText(prev))),
      );
      const prevCapped = prevC.endsWith('…');
      if (capped || prevCapped) return false;
      if (prevC === c) return true;
      // 允许前缀包含匹配（至少 8 个字符，避免单字误伤）
      if (
        prevC.length >= 8 &&
        c.length >= 8 &&
        (prevC.startsWith(c) || c.startsWith(prevC))
      ) {
        return true;
      }
      return false;
    });

    if (matchIdx >= 0) {
      const existing = result[matchIdx]!;
      const existingC = compactTurnNavText(
        stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(outlineText(existing))),
      );
      // 如果当前项文本更完整，升级文本内容；下标保留更小（更靠前）的权威下标
      if (c.length > existingC.length) {
        result[matchIdx] = {
          ...t,
          id: t.id ?? existing.id,
          index: Math.min(existing.index, t.index),
          ordinal: existing.ordinal ?? t.ordinal,
        };
      }
    } else {
      result.push({ ...t });
    }
  }
  return result.sort((a, b) => a.index - b.index);
}

export function buildTurnNavItemsFromOutline(
  turns: { ordinal?: number; index: number; id?: string; label: string }[],
): TurnNavItem[] {
  const items: TurnNavItem[] = [];
  const cleanTurns = dedupeTurnOutline(turns);
  for (const turn of cleanTurns) {
    // Older daemons sent `text`; the current wire uses `label`. Accept both for
    // one compatibility window (the cache schema bump clears stale canvases).
    const raw = turn.label ?? (turn as { text?: string }).text ?? '';
    // Older sessions may not mark injected user rows as synthetic. Keep the
    // server outline aligned with the same rows history rendering suppresses.
    if (isInternalHistoryUserMessage(raw)) continue;
    const text = compactTurnNavText(
      stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(raw)),
    );
    const label = text;
    if (!label) continue;
    const ordinal = turn.ordinal ?? items.length;
    items.push({
      id: turnNavId(turn.index),
      messageId: turn.id,
      ordinal,
      index: turn.index,
      label,
      text,
    });
  }
  return items;
}

export function buildTurnNavItems(
  messages: { role: string; text: string; id?: string; sourceIndex?: number; turnNavOrdinal?: number }[],
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
    const ordinal = typeof msg.turnNavOrdinal === 'number' ? msg.turnNavOrdinal : items.length;
    // Same contract as the outline path: the id is the absolute index, `ordinal`
    // is only carried along for display/back-compat.
    items.push({ id: turnNavId(index), messageId: msg.id, ordinal, index, label, text, fullText: text });
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
export function hasOlderVisibleMessages(input: {
  offset: number;
  firstTurnIndex?: number;
  canvasHasFirstTurn?: boolean;
}): boolean {
  if (input.offset <= 0) return false;
  const threshold = input.firstTurnIndex ?? 0;
  if (input.offset <= threshold) return false;
  if (input.canvasHasFirstTurn) return false;
  return true;
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
  turns: { index: number }[],
  messages: { role: string; sourceIndex?: number }[],
): number {
  if (turns.length === 0) return 0;
  const loaded = new Set<number>();
  for (const message of messages) {
    if (message.role === 'user' && typeof message.sourceIndex === 'number') {
      loaded.add(message.sourceIndex);
    }
  }
  return turns.reduce((count, turn) => count + (loaded.has(turn.index) ? 0 : 1), 0);
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
