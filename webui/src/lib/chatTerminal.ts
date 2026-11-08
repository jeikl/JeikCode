import {
  legacyUserTextsMatch as userTextsMatch,
  stripInjectedRemindersForDisplay,
  stripSteerEnvelopeForDisplay,
  visibleUserText,
} from './wire/legacy.ts';

export { legacyUserTextsMatch as userTextsMatch, visibleUserText } from './wire/legacy.ts';

export interface ChatDoneTerminal {
  stopReason?: string;
  message?: string;
}

export type ChatDoneDisposition =
  | { kind: 'completed'; discardQueued: false }
  /** 用户主动取消（停止按钮 / 立即发送交接 / 撞上回合边界的转向）：收尾但不报异常。 */
  | { kind: 'cancelled'; discardQueued: true; detail: string }
  | { kind: 'incomplete'; discardQueued: true; detail: string };

/**
 * Classify the daemon's authoritative turn terminal.
 *
 * Older daemons did not include `stop_reason`, so an absent reason remains a
 * natural completion for wire compatibility. Once a reason is present, only
 * kernel `Stopped` (`stopped` on the wire) means the model finished normally.
 *
 * `cancelled` is the kernel's explicit cancel — the Stop button, the send-now
 * handover, or a steer that raced the turn boundary. It settles the turn like
 * any other terminal but is NOT an abnormal ending: rendering the yellow
 * "turn incomplete" notice for it turned every Stop press and every mid-turn
 * steer into a fake failure banner.
 *
 * Every other current or future reason is incomplete and must fail closed.
 */
export function classifyChatDone(terminal: ChatDoneTerminal): ChatDoneDisposition {
  if (terminal.stopReason === undefined || terminal.stopReason === 'stopped') {
    return { kind: 'completed', discardQueued: false };
  }

  const message = terminal.message?.trim();
  const detail = message || terminal.stopReason || 'unknown_terminal';
  if (
    terminal.stopReason === 'cancelled'
    || terminal.stopReason === 'manual_stop'
    || terminal.stopReason === 'interrupted_by_user'
  ) {
    return { kind: 'cancelled', discardQueued: true, detail };
  }
  return { kind: 'incomplete', discardQueued: true, detail };
}

export interface LiveLifecycleState {
  running: boolean;
  terminalConsumed: boolean;
}

export function createLiveLifecycleState(): LiveLifecycleState {
  return { running: false, terminalConsumed: false };
}

import { spliceAuthoritativeDiskTail } from './sessionProjection.ts';

type TailPart = { kind: string; text?: string };
type TailMessage = { role: string; parts: TailPart[]; images?: unknown[]; id?: string; clientInputId?: string };

function tailPlain(message: TailMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text || '')
    .join('');
}

/**
 * Does the authoritative disk slice actually cover the canvas's LAST row?
 *
 * `diskHasCanvasUser` only checks the latest user prompt. After Stop the daemon
 * may have persisted that prompt but not its answer yet: the last user matches,
 * while the disk tail still ends at the previous answer. Treating that as
 * "covers tail" makes `mergeDiskWithUnpersistedTail` adopt the old answer and
 * drop the stopped turn. This check also compares the tail row itself.
 */
export function diskCoversCanvasTail(disk: TailMessage[], canvas: TailMessage[]): boolean {
  if (canvas.length === 0) return true;
  const last = canvas[canvas.length - 1];
  if (!last) return true;
  // 用户行必须走下面的“提问 + 回答都在切片里”判定：
  // 只看 id 命中会把“提问已落盘、回答被取消/未写”的回合误判为已覆盖。
  if (last.role !== 'user' && last.id && disk.some((message) => message.id === last.id)) return true;
  if (last.role === 'user') {
    // 用户回合只认身份：没有 id 就不是同一行，绝不按文本猜测。
    // “覆盖”意味着**这一提问及其后的内容都在切片里**：提问在切片中间、但回答
    // 没落盘（回合被取消/限流/重启收尾时只写了 user 行）不算覆盖，
    // 否则 splice 会把这条旧提问直接接到最新一轮上，中间整段消失。
    if (!last.id) return false;
    const at = disk.findIndex((message) => message.id === last.id);
    if (at < 0) return false;
    if (at === disk.length - 1) return true;
    const next = disk[at + 1];
    return !!next && next.role !== 'user';
  }
  const diskLast = disk[disk.length - 1];
  if (!diskLast || diskLast.role !== last.role) return false;
  const canvasText = tailPlain(last).trim();
  const diskText = tailPlain(diskLast).trim();
  if (last.role === 'assistant') {
    if (!canvasText) return false;
    // Disk may hold the complete answer while the stopped canvas has only a
    // prefix. Only "disk extends canvas" (or equal) counts as covered; a
    // different previous answer or a longer live canvas must be preserved.
    return diskText === canvasText || diskText.startsWith(canvasText);
  }
  return false;
}

/**
 * 画布行在权威切片里的“内容身份”。
 *
 * 直播行往往没有 message id（内核在消息真正入会话时才分配），但它的工具调用
 * `call.id` 与正文文本是对账的硬身份。只按行 id 比对时，这些行永远对不上磁盘，
 * 回合结算就会被整段当成“尚未落盘的尾巴”追加到末尾——用户看到的就是长回合
 * 收尾时，回答下面又被之前的工具轮灌一遍。
 */
export interface TailCoverage {
  ids: Set<string>;
  keys: Set<string>;
}

export function tailCoverage<T extends TailMessage>(rows: T[]): TailCoverage {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const row of rows) {
    // 同一条提问在生命周期里有两个身份：落盘前是 `clientInputId`，落盘后是 `id`。
    // 两者必须同时算作“已覆盖”，否则磁盘切片里的提问和画布上的本地副本会各留一份。
    if (row.id) ids.add(row.id);
    if (row.clientInputId) ids.add(row.clientInputId);
    for (const key of rowContentKeys(row)) keys.add(key);
  }
  return { ids, keys };
}

function rowContentKeys(row: TailMessage): string[] {
  // 用户提问只认身份（`id` / `clientInputId`）：同一句话连发多次是**多条真实提问**，
  // 绝不能因为内容相同就被判定为“磁盘切片已覆盖”。
  if (row.role === 'user') return [];
  const parts = ((row as { parts?: Array<{ kind?: string; text?: string; tool?: { id?: string } }> })
    .parts ?? []);
  const keys: string[] = [];
  for (const part of parts) {
    if (part.kind === 'tool' && part.tool?.id) keys.push(`tool:${part.tool.id}`);
  }
  const text = parts
    .filter((part) => part.kind === 'text' || part.kind === 'reasoning')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (text) keys.push(`text:${text.slice(0, 160)}`);
  return keys;
}

/** 这一行是否已经被权威切片完整覆盖（行 id 或全部内容键均命中）。 */
export function tailRowCovered<T extends TailMessage>(row: T, coverage: TailCoverage): boolean {
  if (row.id && coverage.ids.has(row.id)) return true;
  if (row.clientInputId && coverage.ids.has(row.clientInputId)) return true;
  const keys = rowContentKeys(row);
  return keys.length > 0 && keys.every((key) => coverage.keys.has(key));
}

/**
 * 画布上「磁盘还没落盘」那段尾巴的起点。
 *
 * 先用消息身份找最后一条画布与磁盘共有的行：它之后就是本轮还没写进 display
 * 日志的内容（中途转向 + 后续工具/正文）。只认最后一条 user 的话，一次长回合
 * 里的多个 steer 只有最后一个能留下，更早的会被整段丢掉。
 * 返回 -1 表示画布与磁盘没有交集（旧 daemon 无 id / 纯直播行）。
 */
function unpersistedTailStart(canvas: TailMessage[], coverage: TailCoverage): number {
  if (coverage.ids.size === 0 && coverage.keys.size === 0) return -1;
  for (let i = canvas.length - 1; i >= 0; i--) {
    const row = canvas[i];
    if (!row) continue;
    if (tailRowCovered(row, coverage)) return i + 1;
  }
  return -1;
}

/**
 * 磁盘对账不能抹掉「立即发送」刚画上、尚未落盘的用户回合。
 * 磁盘末条用户与画布末条用户还对不上时，把画布从该用户气泡起的尾巴接回去。
 * 已经落盘（刷新能看见）时原样采用磁盘，避免乐观气泡和权威历史各画一条。
 *
 * 定位优先按消息身份（id）：从「最后一条与磁盘共有的消息」之后整段接回。
 * 只认最后一条 user 时，长回合里的多个中途转向只有最后一个能留下。
 */
export function mergeDiskWithUnpersistedTail<T extends TailMessage>(
  disk: T[],
  canvas: T[],
  opts?: {
    /**
     * 磁盘切片是否覆盖了画布当前这一轮（默认 true）。
     * 传 false = 磁盘还停在上一轮（daemon 正在收尾 / 重启丢了快照）：
     * 此时画布上的 steer 与后续工具行是唯一副本，必须整段接回来，
     * 否则刷新后 steer 卡和用户气泡一起消失，只剩工具行。
     */
    diskCoversTail?: boolean;
  },
): T[] {
  // A new loop may already contain reasoning/tools before its final text. The
  // old turn's terminal reconcile must not mistake that for a settled turn and
  // replace the canvas (steer bubble + new loop) with the stale disk tail.
  const openTail =
    transcriptHasOpenUserTurn(canvas) || transcriptHasInFlightAssistant(canvas);
  if (!openTail && opts?.diskCoversTail !== false) return disk;

  const coverage = tailCoverage(disk);
  const byIdentity = unpersistedTailStart(canvas, coverage);
  // 画布里早于磁盘窗口的行必须保留：断网期间跑完多个回合、重连只拿到最新窗口时，
  // 直接返回 disk 会把旧历史（甚至 c 的提问）整段抖掉，看起来就是 c 直接接最新一轮。
  const head = earlierCanvasHead(disk, canvas, coverage.ids);
  if (byIdentity >= 0) {
    // 只接回“磁盘确实还没落盘”的尾巴：
    // 1) 与磁盘同身份的旧副本不得再追加一次（否则就是 a b c d b）；
    // 2) **按因果位次插入**：画布上带 sourceIndex 的行如果落在磁盘窗口覆盖的区间
    //    之外（磁盘缺这个位置，比如后台期间工具行没被写进窗口），必须插回
    //    它自己的位置，而不是被丢掉、也不能一律拼到末尾；
    // 3) 未落盘的本地行（无 sourceIndex）照常接在末尾。
    const diskLastUserTs = (() => {
      for (let i = disk.length - 1; i >= 0; i--) {
        const row = disk[i];
        if (row?.role === 'user' && typeof (row as { ts?: number }).ts === 'number') {
          return (row as { ts?: number }).ts!;
        }
      }
      return 0;
    })();

    const seenTailIds = new Set<string>();
    const tail: T[] = [];
    const insertBefore: Array<{ row: T; at: number }> = [];
    const diskUserTurns = disk.filter((m) => m.role === 'user');
    const diskLastUser = diskUserTurns[diskUserTurns.length - 1];

    for (let i = byIdentity; i < canvas.length; i++) {
      const row = canvas[i];
      if (!row) continue;
      if (disk.includes(row)) continue;
      if ((row.id && coverage.ids.has(row.id)) || (row.clientInputId && coverage.ids.has(row.clientInputId))) continue;
      if (row.id) {
        if (seenTailIds.has(row.id)) continue;
        seenTailIds.add(row.id);
      }
      // 关键防倒挂：如果该行是助手/工具消息，但它所属的用户提问并非磁盘最新轮次
      // （磁盘已经推进到了更新的用户轮次），说明它属于更早轮次的推流残影，
      // 绝对不能跨轮次倒挂追加到新轮次（如轮次 c）的下方！
      if (row.role !== 'user' && diskLastUser) {
        let owningUser: T | undefined;
        for (let j = i; j >= 0; j--) {
          if (canvas[j]?.role === 'user') {
            owningUser = canvas[j];
            break;
          }
        }
        if (owningUser && owningUser.id !== diskLastUser.id) {
          const owningSrc = (owningUser as { sourceIndex?: number }).sourceIndex;
          const diskLastSrc = (diskLastUser as { sourceIndex?: number }).sourceIndex;
          if (typeof diskLastSrc === 'number' && typeof owningSrc === 'number' && diskLastSrc > owningSrc) {
            continue;
          }
          if (diskUserTurns.some((u) => u.id === owningUser!.id && u !== diskLastUser)) {
            continue;
          }
        }
      }
      // 关键防线：没有可信下标的本地未落盘行，若其时间戳明显早于磁盘已落盘的最早提问/最新提问，
      // 说明它属于更早的中断孤儿提问，绝不能倒挂追加到新一轮回答的最下方！
      const rowTs = (row as { ts?: number }).ts;
      if (diskLastUserTs > 0 && typeof rowTs === 'number' && rowTs < diskLastUserTs - 5000) {
        continue;
      }
      const src = (row as { sourceIndex?: number }).sourceIndex;
      if (typeof src === 'number') insertBefore.push({ row, at: src });
      else tail.push(row);
    }
    let merged = [...head, ...disk];
    // 带因果下标的行先按位次插回；无下标的本地尾行最后接上（它们属于正在进行的回合）。
    for (const { row, at } of insertBefore.sort((a, b) => a.at - b.at)) {
      const index = merged.findIndex((candidate) => {
        const src = (candidate as { sourceIndex?: number }).sourceIndex;
        return typeof src === 'number' && src > at;
      });
      merged = index < 0
        ? [...merged, row]
        : [...merged.slice(0, index), row, ...merged.slice(index)];
    }
    return tail.length > 0 ? [...merged, ...tail] : merged;
  }
  // 身份优先：没有共同身份时，磁盘切片是权威，但仍保留窗口之前的头部。
  return head.length > 0 ? [...head, ...disk] : disk;
}

/**
 * 画布里**早于磁盘窗口**的行（按 sourceIndex 判定），按身份去重。
 * 窗口从中间开始时，这些行只能从画布/缓存里来，绝不能被“磁盘权威”覆盖掉。
 */
function earlierCanvasHead<T extends TailMessage>(
  disk: T[],
  canvas: T[],
  diskIds: ReadonlySet<string>,
): T[] {
  let diskFirstIndex: number | undefined;
  for (const row of disk) {
    const src = (row as { sourceIndex?: number }).sourceIndex;
    if (typeof src === 'number' && (diskFirstIndex === undefined || src < diskFirstIndex)) {
      diskFirstIndex = src;
    }
  }
  if (typeof diskFirstIndex !== 'number') return [];
  // 只有「最后一个明确落在 diskFirstIndex 之前的带可信下标行」及它之前的区段才属于
  // 窗口前的旧历史头部；尾部的无下标直播行 / steer 行属于未落盘尾巴，绝不能塞进 head
  // 排到 disk 前面（否则 16:56 的新转向气泡会倒挂在 16:45 旧提问上方）。
  let lastEarlierIdx = -1;
  for (let i = 0; i < canvas.length; i++) {
    const row = canvas[i]!;
    if (row.id && diskIds.has(row.id)) break;
    if (row.clientInputId && diskIds.has(row.clientInputId)) break;
    const src = (row as { sourceIndex?: number }).sourceIndex;
    if (typeof src === 'number') {
      if (src >= diskFirstIndex) break;
      if ((row as { isSteer?: boolean }).isSteer !== true) {
        lastEarlierIdx = i;
      }
    }
  }
  if (lastEarlierIdx < 0) return [];
  const head: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= lastEarlierIdx; i++) {
    const row = canvas[i]!;
    if (row.id && (diskIds.has(row.id) || seen.has(row.id))) continue;
    if (row.clientInputId && diskIds.has(row.clientInputId)) continue;
    if (row.id) seen.add(row.id);
    head.push(row);
  }
  return head;
}

/**
 * 合并结果里的“因果洞”：两行 sourceIndex 之间缺了至少一整段。
 *
 * 断网期间跑完多个回合、重连只拿到最新窗口时会出现：缓存的头停在 c 的提问，
 * 窗口从更晚的行开始，中间的回答在磁盘上但没人拉 —— 画面就是 c 直接接到最新一轮。
 * 调用方据此用 `older` 模式补一页（有界，只补一次）。
 */
export function findCausalGap<T extends { sourceIndex?: number }>(
  rows: T[],
  threshold = 0,
): { before: number; after: number } | null {
  let previous: number | undefined;
  for (const row of rows) {
    const src = row.sourceIndex;
    if (typeof src !== 'number') continue;
    if (typeof previous === 'number' && src - previous - 1 > threshold) {
      return { before: previous, after: src };
    }
    previous = src;
  }
  return null;
}

/**
 * The exact authoritative-tail composition used by Chat.tsx.
 *
 * Kept pure so the stop/reconnect race can be tested without mounting the UI:
 * a stale disk tail (previous turn, or current prompt without its answer) must
 * preserve the current canvas tail instead of replacing it wholesale.
 */
export function mergeAuthoritativeTail<
  T extends TailMessage & { sourceIndex?: number; isSteer?: boolean },
>(diskTail: T[], canvas: T[], diskOffset: number): T[] {
  if (diskTail.length === 0) return canvas;
  const diskCoversTail = diskCoversCanvasTail(diskTail, canvas);
  if (!diskCoversTail) {
    // Do NOT splice first in this branch: splice can append an orphan current
    // answer (a1) as overlay, making identity matching think the current turn
    // is already on disk and dropping its user question. Merge from the
    // ORIGINAL stale tail so the last shared id is the previous answer.
    return mergeDiskWithUnpersistedTail(diskTail, canvas, { diskCoversTail: false });
  }
  const spliced = spliceAuthoritativeDiskTail(canvas, diskTail, diskOffset);
  return mergeDiskWithUnpersistedTail(spliced, canvas, { diskCoversTail: true });
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
type CanvasMessage = { role: string; id?: string; parts: CanvasPart[]; ts?: number };

/** The optimistic user row painted by send-now / a queued send. */
export interface PaintedUserRow {
  role: string;
  id?: string;
  clientInputId?: string;
  parts?: Array<{ kind: string; text?: string }>;
  images?: Array<{ media_type?: string; data?: string }>;
}

/**
 * Find the optimistic user row that belongs to THIS send request.
 *
 * Identity first: a same-text prompt from the previous turn (e.g. the queue card
 * that was just auto-drained) is a different message and must never be claimed by
 * the send-now request. The text fallback exists only for legacy callers that do
 * not mint a request id before painting.
 */
export function findPaintedUserRow<T extends PaintedUserRow>(
  messages: T[],
  requestId: string | undefined,
  cleanText: string,
  images?: PaintedUserRow['images'],
): T | undefined {
  if (requestId) {
    return messages.find(
      (m) => m.role === 'user' && (m.id === requestId || m.clientInputId === requestId),
    );
  }
  const sameImages = (a?: PaintedUserRow['images'], b?: PaintedUserRow['images']) => {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length
      && left.every((img, i) => img.media_type === right[i]?.media_type && img.data === right[i]?.data);
  };
  return messages.find((m) => {
    if (m.role !== 'user') return false;
    if (cleanText) {
      return (m.parts ?? []).some((p) => p.kind === 'text' && userTextsMatch(p.text ?? '', cleanText));
    }
    return !!images?.length && sameImages(m.images, images);
  });
}

/**
 * A stale queue card whose text was already auto-drained into the running turn.
 * The matching user row must be NEWER than the card; otherwise it is the turn's
 * own prompt (or a legitimate repeated message) and the card still owns a send.
 */
export function queueCardAlreadyDelivered(input: {
  running: boolean;
  latestUserTs?: number;
  cardCreatedAt?: number;
  /** Identity proof: the newest user row is the card's persisted id. */
  sameIdentity?: boolean;
  sameText: boolean;
}): boolean {
  if (!input.running) return false;
  if (!input.sameIdentity && !input.sameText) return false;
  const latest = input.latestUserTs ?? 0;
  const card = input.cardCreatedAt ?? 0;
  return latest > 0 && latest >= card;
}

export interface QueueCardOnCanvas {
  text: string;
  images?: PaintedUserRow['images'];
  clientInputId?: string;
  createdAt?: number;
}

export function queueCardPresentInOutline(
  turns: ReadonlyArray<{ id?: string | null; pending?: boolean; provisional?: boolean }>,
  clientInputId?: string | null,
): boolean {
  // Only a server-confirmed outline row proves the card was folded. A local
  // provisional row (optimistic send / stale cache) must never consume a queue
  // card, or a refresh hides a card that the server still owns.
  return !!clientInputId && turns.some(
    (turn) => turn.id === clientInputId && turn.pending !== true && turn.provisional !== true,
  );
}

/**
 * Is THIS queue/steer card already represented on the canvas?
 *
 * Identity first: a text-identical prompt from an earlier turn is a different
 * message and must never swallow a later steer/queue card. Only legacy cards
 * without an id fall back to text/images, and then only a row created at or
 * after the card can be its delivered copy. Missing timestamps keep the card
 * (silently dropping real user input is worse than a rare duplicate).
 */
export function queueCardAlreadyOnCanvas<T extends PaintedUserRow & { ts?: number }>(
  messages: T[],
  card: QueueCardOnCanvas,
): boolean {
  const cid = card.clientInputId;
  if (cid) {
    return messages.some(
      (m) => m.role === 'user' && (m.id === cid || m.clientInputId === cid),
    );
  }
  const clean = visibleUserText(card.text).trim();
  const cardImages = card.images ?? [];
  const sameImages = (images?: PaintedUserRow['images']) => {
    const other = images ?? [];
    return cardImages.length > 0
      && cardImages.length === other.length
      && cardImages.every(
        (img, i) => img.media_type === other[i]?.media_type && img.data === other[i]?.data,
      );
  };
  return messages.some((m) => {
    if (m.role !== 'user') return false;
    if (clean) {
      const text = (m.parts ?? [])
        .filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '')
        .join('');
      if (!userTextsMatch(text, clean)) return false;
    } else if (!sameImages(m.images)) {
      return false;
    }
    if (m.ts != null && card.createdAt != null) return m.ts >= card.createdAt;
    return false;
  });
}

/**
 * A steer card's client-minted id and the persisted bubble's kernel message id
 * can diverge after a reconnect (another tab folded it, display.jsonl only
 * knows the kernel id, or a reconnect lost the correlation). Identity first;
 * only when that misses do we fall back to exact display text + images + a
 * close timestamp. This is deliberately steer-only: ordinary queue cards must
 * stay identity-first so repeated identical prompts are not swallowed.
 */
export function steerCardBubbleOnCanvas(
  messages: Array<{
    role?: string;
    id?: string;
    clientInputId?: string;
    parts?: Array<{ kind: string; text?: string }>;
    images?: Array<{ media_type: string; data: string }>;
    ts?: number;
  }>,
  card: {
    clientInputId?: string;
    text: string;
    images?: Array<{ media_type: string; data: string }>;
    createdAt?: number;
  },
): boolean {
  const cid = card.clientInputId;
  if (
    cid &&
    messages.some(
      (message) =>
        message.role === 'user' &&
        (message.id === cid || message.clientInputId === cid),
    )
  ) {
    return true;
  }
  const clean = stripSteerEnvelopeForDisplay(visibleUserText(card.text)).trim();
  const cardImages = card.images ?? [];
  if (!clean && cardImages.length === 0) return false;
  return messages.some((message) => {
    if (message.role !== 'user') return false;
    const text = (message.parts ?? [])
      .filter((part) => part.kind === 'text')
      .map((part) => part.text ?? '')
      .join('');
    const bubble = stripSteerEnvelopeForDisplay(text).trim();
    if (clean) {
      if (!userTextsMatch(bubble, clean)) return false;
    } else {
      const images = message.images ?? [];
      const same =
        cardImages.length > 0 &&
        cardImages.length === images.length &&
        cardImages.every(
          (image, index) =>
            image.media_type === images[index]?.media_type &&
            image.data === images[index]?.data,
        );
      if (!same) return false;
    }
    // The text fallback is only safe with both timestamps: a steer bubble is
    // created at/after the card. Missing timestamps stay identity-only rather
    // than guessing and swallowing a legitimate same-text prompt.
    if (message.ts == null || card.createdAt == null) return false;
    // Allow a small clock skew and a bounded delay for the kernel fold.
    if (message.ts < card.createdAt - 10_000) return false;
    if (message.ts > card.createdAt + 30 * 60_000) return false;
    return true;
  });
}

/**
 * 认领本端乐观气泡：优先用服务端回传的客户端关联 id（`/chat` 的 `request_id`，
 * `/live` 的 `client_input_id`）精确命中；缺失或不匹配时才退回文本比对，
 * 供 legacy daemon / 第三方客户端兜底。
 *
 * 返回应消费的待回声条目下标，`-1` 表示这条不是本端发出的。
 */
export function findPendingSelfEchoIndex(
  pending: ReadonlyArray<{ id: string; text: string }>,
  event: { client_input_id?: string; content: string },
): number {
  if (!event.client_input_id) return -1;
  return pending.findIndex((item) => item.id === event.client_input_id);
}

/** True when `userText` is already the latest user turn on the canvas.
 * Snapshot reconnect / `/chat/watch` replay both re-emit that echo; appending
 * it again creates duplicate bubbles.
 * Also accounts for mid-turn steers: if a turn had a steer message, replaying
 * the original user prompt must not re-append it below the steer. */
export function userMessageAlreadyOnCanvas(
  messages: CanvasMessage[],
  _userText: string,
  _userTs?: number,
  messageId?: string,
): boolean {
  return !!messageId && messages.some((message) => message.id === messageId);
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

/** Legacy session detail capped a field at 24KB and appended this marker. New
 *  daemon builds return full fields; keep the marker handling so old caches and
 *  old display logs still reconcile without duplicating blocks. */
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
  if (!chunk) {
    // 纯空白增量（段落/列表分隔的换行、Markdown 缩进）绝不能当成"已画过"丢弃：
    // provider 常把 "\n\n" 作为独立 delta 发出，丢了它 live 渲染就会把行/列表
    // 粘在一起（刷新读全文才恢复）。
    // 去重只针对"画布末尾已有同类空白"：重放/重复帧不得叠空行，
    // 但末尾是空格之类非换行空白时，新的换行依然必须画上去。
    const tail = existing.match(/\s+$/)?.[0] ?? '';
    if (tail.endsWith(incoming)) return '';
    if (incoming.includes('\n') && tail.includes('\n')) return '';
    return incoming;
  }
  if (painted === chunk || painted.endsWith(chunk) || painted.startsWith(chunk)) {
    // 折叠比较会把"非空白内容已画过、但换行骨架不同"的重放也判成已画过：
    // 画布若已经粘连（旧版本丢过换行），直接丢弃就永远无法自愈。
    // 安全收尾：非空白内容确实已存在时，只补回缺失的前导空白（不重写正文、不重复文本）。
    const skeleton = (value: string) => value.replace(/[^\S\n]+/g, '');
    if (!incoming.includes('\n') || skeleton(existing).endsWith(skeleton(incoming))) return '';
    const leadingWhitespace = incoming.match(/^\s+/)?.[0] ?? '';
    return leadingWhitespace && !existing.endsWith(leadingWhitespace) ? leadingWhitespace : '';
  }
  if (chunk.startsWith(painted) && painted.length > 0) {
    // 按「非空白字符」对齐走完 painted，再返回 incoming 真正剩下的部分。
    // 旧实现直接拿 painted.length 去数 incoming 的非空白字符，而 painted 是
    // 空白折叠后的串（仍包含空格）——空格越多就多吃几个字，重放尾巴被切成
    // 半句话，正文里出现 jsonl 中并不存在的拼接片段。
    const paintedNonSpace = painted.replace(/\s/g, '').length;
    let cursor = 0;
    let stripped = 0;
    while (cursor < incoming.length && stripped < paintedNonSpace) {
      if (!/\s/.test(incoming[cursor]!)) stripped += 1;
      cursor += 1;
    }
    return incoming.slice(cursor);
  }
  return incoming;
}

/**
 * Id-based tail dedup for snapshot reconciliation.
 * Drop canvas-tail messages whose stable `id` already exists in the settled
 * snapshot, so a replayed/echoed message is not appended a second time.
 *
 * Optimistic rows carry no stored id yet (just sent, not bound), so an id-only
 * check re-appends them: after a mid-turn refresh the newest prompt showed up
 * TWICE at the bottom of the canvas. User text is therefore the fallback
 * identity — same content on the snapshot means the row is already there.
 */
export function dropSnapshotDuplicates<T extends { id?: string; clientInputId?: string; role?: string; parts?: InFlightPart[] }>(
  snapshot: T[],
  tail: T[],
): T[] {
  const ids = new Set<string>();
  for (const m of snapshot) {
    if (m.id) ids.add(m.id);
    if (m.clientInputId) ids.add(m.clientInputId);
  }
  return tail.filter((m) => {
    if (m.id && ids.has(m.id)) return false;
    if (m.clientInputId && ids.has(m.clientInputId)) return false;
    if (m.role !== 'user') return true;
    const text = m.parts?.filter((part) => part.kind === 'text').map((part) => part.text || '').join('') ?? '';
    return !text || !userMessageAlreadyOnCanvas(snapshot as unknown as CanvasMessage[], text);
  });
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
        (part.tool?.status === 'pending' ||
          part.tool?.status === 'running' ||
          part.tool?.status === 'waiting_approval')
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

/**
 * 切到一个**新会话**（sessionId === null 的草稿态）时，画布该不该清空。
 *
 * 关键场景：在旧会话发完消息立刻点「新建会话」。此时旧会话的回合还在跑，
 * 画布上就是那一轮的乐观提问 + Working。旧实现用目标 sessionId 判活跃，
 * sessionId 为 null 时恒为 false → 直接清屏，表现成“老会话记录被清空，
 * 只剩用户气泡和 Working”；刷新后又从磁盘恢复。
 * 活跃判定必须看**来源会话**（prevId），不是看即将进入的新会话。
 */
export function shouldClearCanvasOnSwitch(input: {
  targetSessionId: string | null;
  sourceSessionId: string | null;
  canvasLen: number;
  sourceActive: boolean;
}): boolean {
  if (input.canvasLen <= 0) return false;
  // 新建会话（草稿态）必须是**空白 landing 页**：landing 判定是 messages.length === 0，
  // 保留旧画布会让新会话直接显示上一会话的记录。
  // 旧会话的在途记录不靠“留着画布”保存，而是在切走前已经写入它自己的缓存
  // （`messageCacheRef.set(prevId, cached)`），回来时原样恢复。
  if (!input.targetSessionId) return true;
  return !input.sourceActive;
}

/** This tab started the turn or is attached to its live stream. */
export function thisTabOwnsTurn(input: {
  isLiveSession: boolean;
  isLocalTurn: boolean;
}): boolean {
  return input.isLiveSession || input.isLocalTurn;
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

function collapseWs(value: string): string {
  return value.replace(/\s+/g, '');
}

export function isWatchTurnActivationEvent(type: string): boolean {
  switch (type) {
    case 'steered':
    case 'user_identified':
    case 'text':
    case 'reasoning':
    case 'tool_start':
    case 'tool_output':
    case 'tool_progress':
    case 'tool_finished':
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
};

export function createTokenCacheState(): TokenCacheState {
  return { lastPrompt: 0, providerReportsCache: false };
}

export function resetTokenCacheState(baselinePrompt = 0): TokenCacheState {
  return {
    lastPrompt: Math.max(0, baselinePrompt),
    providerReportsCache: false,
  };
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
