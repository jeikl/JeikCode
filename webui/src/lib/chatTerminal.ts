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

export function createLiveLifecycleState(): LiveLifecycleState {
  return { running: false, terminalConsumed: false };
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

import { spliceAuthoritativeDiskTail } from './sessionProjection.ts';

type TailPart = { kind: string; text?: string };
type TailMessage = { role: string; parts: TailPart[]; images?: unknown[]; id?: string };

function tailPlain(message: TailMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text || '')
    .join('');
}

function sameTailImages(
  a?: unknown[],
  b?: unknown[],
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((img: any, i) => img?.media_type === (right[i] as any)?.media_type && img?.data === (right[i] as any)?.data);
}

function lastTailUser(messages: TailMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return tailPlain(messages[i]);
  }
  return '';
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
  if (last.id && disk.some((message) => message.id === last.id)) return true;
  const diskLast = disk[disk.length - 1];
  if (!diskLast || diskLast.role !== last.role) return false;
  const canvasText = tailPlain(last).trim();
  const diskText = tailPlain(diskLast).trim();
  if (last.role === 'user') {
    if (!canvasText) return false;
    // Disk text may carry an injected prefix; canvas text must be its suffix.
    // Do NOT treat a longer canvas as covered: that is an unpersisted tail.
    return diskText === canvasText || diskText.endsWith(canvasText);
  }
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
    if (row.id) ids.add(row.id);
    for (const key of rowContentKeys(row)) keys.add(key);
  }
  return { ids, keys };
}

function rowContentKeys(row: TailMessage): string[] {
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
function unpersistedTailStart(disk: TailMessage[], canvas: TailMessage[]): number {
  const coverage = tailCoverage(disk);
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

  // 身份定位优先：从「最后一条与磁盘共有的消息」之后整段接回（支持多个中途转向）。
  const byIdentity = unpersistedTailStart(disk, canvas);
  if (byIdentity >= 0) {
    // spliced 已经按锚点放回过本地通知行（压缩标记等），接尾巴时避免同一对象再插一遍。
    const tail = canvas.slice(byIdentity).filter((row) => !disk.includes(row));
    return tail.length > 0 ? [...disk, ...tail] : disk;
  }

  let lastUser = -1;
  for (let i = canvas.length - 1; i >= 0; i--) {
    if (canvas[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return disk;

  const lastUserMsg = canvas[lastUser];
  const canvasUser = visibleUserText(tailPlain(lastUserMsg));
  const hasCanvasImages = Array.isArray(lastUserMsg?.images) && lastUserMsg.images.length > 0;
  if (!canvasUser && !hasCanvasImages) return disk;

  let lastDiskUser = -1;
  for (let i = disk.length - 1; i >= 0; i--) {
    if (disk[i]?.role === 'user') {
      lastDiskUser = i;
      break;
    }
  }
  if (lastDiskUser >= 0) {
    const lastDiskUserMsg = disk[lastDiskUser];
    const diskUser = visibleUserText(tailPlain(lastDiskUserMsg));
    const hasDiskImages = Array.isArray(lastDiskUserMsg?.images) && lastDiskUserMsg.images.length > 0;

    const textMatches = !!canvasUser && !!diskUser && (diskUser === canvasUser || userTextsMatch(diskUser, canvasUser));
    const imageMatches = !canvasUser && !diskUser && hasCanvasImages && hasDiskImages && sameTailImages(lastDiskUserMsg.images, lastUserMsg?.images);
    if (textMatches || imageMatches) return disk;
  }

  // 最后一道兜底：只接回**磁盘尚未覆盖**的行。
  // 直接按“最后一条用户消息之后全接”会把已经上屏（且已落盘）的早期工具轮
  // 整段追加到回答下面，长回合收尾时就是“底部被之前的消息灌一遍”。
  const coverage = tailCoverage(disk);
  const tail = canvas
    .slice(lastUser)
    .filter((row) => !disk.includes(row) && !tailRowCovered(row, coverage));
  return tail.length > 0 ? [...disk, ...tail] : disk;
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

  // 深度归一化比对 (去除所有连续空白和换行差异)
  const normLeft = left.replace(/\s+/g, ' ').trim().toLowerCase();
  const normRight = right.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normLeft === normRight) return true;

  // Disk history is stripped; live/watch echo may still carry the caption.
  if (left.startsWith(right) || right.startsWith(left)) {
    const longer = left.length >= right.length ? left : right;
    const shorter = left.length >= right.length ? right : left;
    const rest = longer.slice(shorter.length);
    if (rest.trim() === '') return true;
    return VISION_ANNOTATION_MARKERS.some((m) => rest.includes(m.replace(/^\n\n/, '')));
  }
  // 到这里说明两条文本既不完全相同、也不互为前缀（尾部纯空白 / 视觉标记的重放
  // 形态已在上面收敛）。旧实现在这里再按「前 40 字符一致」兜底判同一条，会把
  // 「前缀相同、只改末尾」的真实追问（路径/参数/文件名）误判成重放而吞掉。
  // 用户提问的去重只能靠精确相等 / 严格前缀 / 消息身份，绝不能靠模糊前缀。
  return false;
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
  // 1. 身份优先：服务端回声带回了发出去时的关联键，命中即精确消费，无需猜文本。
  if (event.client_input_id) {
    const byId = pending.findIndex((item) => item.id === event.client_input_id);
    if (byId >= 0) return byId;
  }
  // 2. 文本兜底（无 id 的旧服务端/第三方端）：完全一致或归一化后一致。
  const want = visibleUserText(event.content);
  return pending.findIndex(
    (item) => userTextsMatch(item.text, event.content) || visibleUserText(item.text) === want,
  );
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

  // 2. 查找画布上最靠后的匹配项与最靠后的 user 消息
  let matchIndex = -1;
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      if (lastUserIndex === -1) lastUserIndex = i;
      if (matchIndex === -1 && matches(messages[i])) {
        matchIndex = i;
      }
    }
  }
  if (matchIndex === -1) return false;
  if (matchIndex === lastUserIndex) return true;

  // 3. 若 matchIndex 之后存在后续的 user 消息：
  // 仅当末尾的用户提问内容与当前检查的完全不同，且中间的助手已经产生最终回答时，
  // 才说明 matchIndex 属于过去的旧轮次（例如用户又输入了全新的后续问题）。
  // 关键防线：如果当前检查的消息内容与末尾开放提问是一样的，绝对判定为已在画布上（true），杜绝重放追加克隆！
  const trailingUser = messages[lastUserIndex];
  const trailingUserText = visibleUserText(canvasUserText(trailingUser) ?? '');
  if (trailingUserText === want || userTextsMatch(trailingUserText, want)) {
    return true;
  }

  const hasOpenTrailingUser = messages.length > 0 && messages[messages.length - 1]?.role === 'user';
  if (hasOpenTrailingUser && lastUserIndex === messages.length - 1) {
    const nextAssistant = messages.slice(matchIndex + 1, lastUserIndex).find((m) => m.role === 'assistant');
    const nextAssistantSettled = nextAssistant && nextAssistant.parts.some(
      (part) => part.kind === 'text' && (part.text || '').trim().length > 0,
    );
    if (nextAssistantSettled) {
      return false;
    }
  }

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

/** 归属消息优先：多回合 turn 中每一轮都是独立的 assistant 消息；只认“最后一条”
 *  会把早先回合的日志重放判成新内容（幽灵思考块 / 幽灵正文）。
 *  先按 message_id 定位回合，再按 tool call id 定位，最后回退到最后一条 assistant。 */
type ReconcilePart = {
  kind: string;
  text?: string;
  tool?: { id?: string; output?: string; status?: string };
};
type ReconcileMessage = { role: string; parts: ReconcilePart[]; id?: string };

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
  // 上下文压缩：磁盘被摘要替换后**比画布更短**（而且不再是画布的前缀）。
  // 显示只增不减 —— 画布是权威，绝不能用更短的磁盘去覆盖，
  // 否则一次刷新就把画布里的历史显示成了压缩版。
  const diskCompacted =
    diskText.length > 0 && canvasText.length > diskText.length && !canvasText.startsWith(diskText);

  // 1. 若前端画布处于活跃进行中（in-flight）或文本已经领先/包含落盘文本：
  // 画布是正在流式生成的绝对真实源！严禁从落后的 diskRest 抽取旧思考块追加到末尾！
  // 仅将 diskRest 中已结算的 tool 状态同步到 canvasRest 对应的 tool 调用中。
  if (canvasAhead || diskCompacted) {
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

  // 2. 顺序对齐全局 Turns，杜绝因单向指针错位导致的整段历史重复追加。
  // 优先按用户消息的稳定 id 对齐（重复文本/纯图片时唯一无歧义），文本匹配作回退。
  const matches: Array<{ d: number; c: number }> = [];
  let cSearch = 0;
  for (let d = 0; d < diskTurns.length; d++) {
    const dUser = diskTurns[d]!.user;
    const dText = reconcileUserText(dUser);
    const dId = dUser.id;
    let found = -1;
    if (dId) {
      for (let c = cSearch; c < canvasTurns.length; c++) {
        if (canvasTurns[c]!.user.id === dId) {
          found = c;
          break;
        }
      }
    }
    if (found < 0) {
      for (let c = cSearch; c < canvasTurns.length; c++) {
        if (userTextsMatch(reconcileUserText(canvasTurns[c]!.user), dText)) {
          found = c;
          break;
        }
      }
    }
    if (found >= 0) {
      matches.push({ d, c: found });
      cSearch = found + 1;
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
    // 合并当前匹配的 (d, c) 轮次 (保留引用并在需要时安全保留本地画布中的多模态图片)
    const diskTurn = diskTurns[d]!;
    const canvasTurn = canvasTurns[c]!;
    const diskUser = diskTurn.user;
    const canvasUser = canvasTurn.user as any;
    const canvasImages = canvasUser.images && canvasUser.images.length > 0 ? canvasUser.images : undefined;
    const mergedUser = (canvasImages && !(diskUser as any).images) || (canvasUser.id && !diskUser.id)
      ? {
          ...diskUser,
          ...(canvasImages ? { images: canvasImages } : {}),
          ...(canvasUser.id && !diskUser.id ? { id: canvasUser.id } : {}),
        }
      : diskUser;
    outTurns.push({
      user: mergedUser,
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
    const cId = (cTurn.user as any).id || (cTurn.user as any).pendingSteerId;
    const targetTurn = outTurns.find((rt) => {
      const rId = (rt.user as any).id || (rt.user as any).pendingSteerId;
      if (cId && rId && cId === rId) return true;
      return userTextsMatch(reconcileUserText(rt.user), text);
    });
    if (targetTurn) {
      // 绝对防重放防线：只要该提问已经在输出中存在，坚决禁止作为新轮次追加到末尾！
      // 只能将未落盘的增量内容合入对应的 targetTurn.rest
      const continuation = continuationNotOnTranscript(targetTurn.rest, cTurn.rest);
      if (continuation.length > 0) {
        targetTurn.rest.push(...continuation);
      }
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
      // 仅当在整个输出中均不存在该提问时，才作为真正的新提问轮次追加
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
export function dropSnapshotDuplicates<T extends { id?: string; role?: string; parts?: InFlightPart[] }>(
  snapshot: T[],
  tail: T[],
): T[] {
  const ids = new Set(snapshot.map((m) => m.id).filter((value): value is string => !!value));
  return tail.filter((m) => {
    if (m.id && ids.has(m.id)) return false;
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
