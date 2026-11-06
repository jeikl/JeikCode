/**
 * 断点续传游标（每会话一份）。
 *
 * 服务器给 live 与 replay 帧统一编号（`seq`）。前端每应用一帧就记住最大的
 * seq；断线重连时把它当作 `after_seq` 带回去，服务器只补这之后的帧 ——
 * 于是重连天然不重复、不乱序，**不需要**再猜「这条是不是已经画过了」。
 *
 * 存 sessionStorage：按标签页隔离（另一个标签页有自己的游标）。
 * 会话回合结束时调用方应清掉它（缓冲已被服务器清空，旧游标会失效）。
 *
 * 关键约束：游标只在「写它的那份画布还活在同一个页面文档里」时有效。
 * 画布落 IndexedDB 是防抖异步的（每帧只排队一次 800ms 写），进程被刷新打断时
 * 画布会停在旧快照，而游标早已越过那些帧。若刷新后继续带游标续传，服务器会跳过
 * 已记账却从未画上的帧 —— 典型就是中途 steer 的 `steered` 边界帧：它的用户气泡
 * 在回合结算前根本不落盘，于是刷新后气泡凭空消失、新一轮正文贴到上一条回答下面。
 * 因此每条记录带上页面身份，新文档一律视为「无游标」走全量补发（前端按身份幂等收敛）。
 */

const CURSOR_PREFIX = 'jeikcode:stream_cursor:';

/** 当前页面文档的身份。同一文档内稳定，刷新 / 复制标签页后必然是新的。 */
const DOCUMENT_OWNER = (() => {
  try {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  } catch {
    /* 非浏览器环境 / 旧内核：退化为时间戳随机串 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();

/** 可注入的存储：测试用假实现，浏览器用 sessionStorage。 */
export interface CursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): CursorStorage | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export interface StreamCursor {
  /** 已应用的最大缓冲序号。 */
  seq: number;
}

/**
 * daemon 实例身份（`/health.instance_id`）。重启 / 升级后必变。
 *
 * 为什么游标必须绑纪元：daemon 的回合序号（`session_seq`）是**进程内存**里的计数器，
 * 重启后从 0 重新计数；而浏览器 sessionStorage 里的旧游标是重启前的大值。一旦新一轮
 * 的缓冲长度越过这个旧游标，服务端就只补 `seq > after_seq` 的帧 —— 当前回合的前半段
 * （开场提问、最初的思考与工具调用）被整段跳过，客户端直接从回合中段开始画，
 * 旧回答与工具行看起来“缺了一段 / 夹在中间”。
 *
 * 纪元未知（health 尚未返回）时一律视为无游标，走全量补发：宁可多画一遍幂等帧，
 * 也不能静默跳帧。
 */
let streamEpoch: string | null = null;

export function setStreamEpoch(epoch: string | null | undefined): void {
  const next = typeof epoch === 'string' ? epoch.trim() : '';
  streamEpoch = next ? next : null;
}

export function currentStreamEpoch(): string | null {
  return streamEpoch;
}

/** 读取某条流的游标；`stream` 用于区分画布流与镜像流（两条流的序号空间不同）。
 *  其它页面文档写下的游标一律视为无效（见文件头：画布可能落后于游标）。 */
export function readStreamCursor(
  sessionId: string,
  stream = 'watch',
  storage: CursorStorage | null = defaultStorage(),
  owner: string = DOCUMENT_OWNER,
): StreamCursor | null {
  if (!sessionId || !storage) return null;
  try {
    const raw = storage.getItem(CURSOR_PREFIX + stream + ':' + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { seq?: unknown; owner?: unknown; epoch?: unknown };
    if (parsed?.owner !== owner) return null;
    // 纪元必须已知且一致：daemon 重启后旧游标落在新计数器区间里会静默跳帧。
    if (!streamEpoch || parsed?.epoch !== streamEpoch) return null;
    return typeof parsed?.seq === 'number' && Number.isFinite(parsed.seq)
      ? { seq: parsed.seq }
      : null;
  } catch {
    return null;
  }
}

/** 记录游标（只前进：乱序/重放帧不会把游标往回拨）。 */
export function writeStreamCursor(
  sessionId: string,
  seq: number,
  stream = 'watch',
  storage: CursorStorage | null = defaultStorage(),
  owner: string = DOCUMENT_OWNER,
): void {
  if (!sessionId || !storage || !Number.isFinite(seq) || seq < 0) return;
  const current = readStreamCursor(sessionId, stream, storage, owner);
  if (current && current.seq >= seq) return;
  try {
    storage.setItem(
      CURSOR_PREFIX + stream + ':' + sessionId,
      JSON.stringify({ seq, owner, epoch: streamEpoch }),
    );
  } catch {
    /* 存储不可用（隐私模式/配额）→ 退化为无游标，走全量补发兜底 */
  }
}

/** 清掉游标（回合结束：服务器缓冲已清空，旧序号不再有意义）。 */
export function clearStreamCursor(
  sessionId: string,
  stream = 'watch',
  storage: CursorStorage | null = defaultStorage(),
): void {
  if (!sessionId || !storage) return;
  try {
    storage.removeItem(CURSOR_PREFIX + stream + ':' + sessionId);
  } catch {
    /* ignore */
  }
}

/**
 * 决定这次连接带什么游标：
 * - 有游标 → 带上它（只补之后的帧，收到的全是新的）
 * - 无游标且画布为空（新会话）→ `-1`：服务器不补发，直接给一个起始游标后转实时
 * - 无游标但画布有历史（换设备/清缓存）→ `undefined`：全量补发，前端按身份幂等收敛
 */
export function resolveAfterSeq(
  cursor: StreamCursor | null,
  canvasIsEmpty: boolean,
): number | undefined {
  if (cursor) return cursor.seq;
  return canvasIsEmpty ? -1 : undefined;
}

export interface SnapshotRowIdentityLike {
  id?: string;
  role?: string;
}

/**
 * 校验实际采用上屏的画布数组是否确实覆盖了绑定 `lastSeq` 的那份缓存快照。
 *
 * `messageCacheRef`（SessionStoreMap）与 `sessionCache`（L1/L2 快照）是两套内存结构：
 * - 引用相同时直接成立；
 * - 引用不同时，上屏画布长度不得小于快照长度，且快照末尾最后一条带 `id` 的消息必须存在于
 *   上屏画布中（若快照均无 `id`，则要求长度与末行 `role` 一致）。否则拒绝复用 `lastSeq`。
 */
export function adoptedCanvasCoversCachedSnapshot(
  adopted: ReadonlyArray<SnapshotRowIdentityLike> | null | undefined,
  snapshot: ReadonlyArray<SnapshotRowIdentityLike> | null | undefined,
): boolean {
  if (!adopted || !snapshot || adopted.length === 0 || snapshot.length === 0) return false;
  if (adopted === snapshot) return true;
  if (adopted.length < snapshot.length) return false;

  // A snapshot may be adopted verbatim, or be a prefix/tail window inside a
  // larger canvas. Require the whole snapshot to appear **contiguously** in the
  // adopted array; the last-id-anywhere shortcut let a truncated/reordered tail
  // pass and restored a cursor ahead of the actually painted rows.
  const rowMatches = (a: SnapshotRowIdentityLike | undefined, s: SnapshotRowIdentityLike | undefined): boolean => {
    if (!a || !s) return false;
    if (s.id) return a.id === s.id;
    return a.role === s.role;
  };

  // Anchor on the last snapshot row that carries an id. Rows without ids are
  // matched by role relative to that anchor; without any id we cannot prove
  // alignment safely, so fail closed and let the caller request a full replay.
  let anchor = -1;
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    if (snapshot[i]?.id) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return false;

  const anchorId = snapshot[anchor]!.id!;
  for (let ai = adopted.length - 1; ai >= anchor; ai -= 1) {
    if (adopted[ai]?.id !== anchorId) continue;
    const start = ai - anchor;
    if (start < 0) continue;
    let covered = true;
    for (let i = 0; i < snapshot.length; i += 1) {
      if (!rowMatches(adopted[start + i], snapshot[i])) {
        covered = false;
        break;
      }
    }
    if (covered) return true;
  }
  return false;
}

/**
 * 从已验证上屏的缓存快照恢复流空间（stream-space）续传游标。
 *
 * 铁律：
 * - 绝不跨刷新复用独立的 sessionStorage 裸游标（它超前于 800ms 防抖缓存，会跳过未落缓存的 steered 帧）；
 * - 必须同时满足：服务端确认当前回合正在运行（`serverRunning === true`）、快照处于 `live` 阶段、
 *   快照 `operationId` 与服务端活跃 `turn_id` 严格一致、且实际采用上屏的画布覆盖了该快照的 `messages`。
 *   这样既避免超长回合刷新时全量重放已落缓存的前缀帧，又确保快照之后的所有增量帧一帧不漏。
 */
export function resolveHydratedStreamCursor(input: {
  cacheAdopted: boolean;
  serverRunning?: boolean;
  cachedPhase?: 'live' | 'terminal' | null;
  cachedOperationId?: string | null;
  cachedLastSeq?: number | null;
  activeTurnId?: string | null;
  adoptedMessages?: ReadonlyArray<SnapshotRowIdentityLike> | null;
  cachedMessages?: ReadonlyArray<SnapshotRowIdentityLike> | null;
}): number | undefined {
  if (!input.cacheAdopted) return undefined;
  if (input.serverRunning !== true) return undefined;
  if (input.cachedPhase !== 'live') return undefined;
  const cachedOp = input.cachedOperationId?.trim();
  const activeOp = input.activeTurnId?.trim();
  if (!cachedOp || !activeOp || cachedOp !== activeOp) return undefined;
  if (
    input.adoptedMessages !== undefined ||
    input.cachedMessages !== undefined
  ) {
    if (!adoptedCanvasCoversCachedSnapshot(input.adoptedMessages, input.cachedMessages)) {
      return undefined;
    }
  }
  if (
    typeof input.cachedLastSeq !== 'number' ||
    !Number.isFinite(input.cachedLastSeq) ||
    input.cachedLastSeq < 0
  ) {
    return undefined;
  }
  return input.cachedLastSeq;
}
