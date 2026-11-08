/**
 * 会话画布缓存（L1 内存 LRU + L2 IndexedDB）。
 *
 * 四条铁律（与 `refactor-plan/canvas-message-plan-v2.md` 对齐）：
 * 1. **单写者**：只有本模块能写缓存；调用方只提交 patch，不提交整条快照；
 * 2. **版本闸门**：`revision` 只许前进。旧快照永远不能覆盖新快照；
 * 3. **未传即保留，null 才清空**：避免「忘传一个参数就抹掉一整块数据」；
 * 4. **结构版本变更即整条作废**：`CACHE_SCHEMA` 变化时旧条目直接丢弃。
 *
 * 缓存不是画布的副本，而是「某个 revision 下的已提交记录快照」。
 * 瞬态（Working / 在途待办 / 转向卡 / 本地提示）永远不进这里。
 */

import { normalizeCanvas } from './canvas/canvasStore.ts';
import { stripTransientNoticeRows } from './sessionProjection.ts';
import { readStreamCursor } from './streamCursor.ts';

/// 缓存结构版本。任何字段语义 / 坐标系变更都必须 +1：
/// 旧条目会被 `getSessionCache` 视为不兼容并丢弃，由服务端重新水合。
///
/// v7: 引入 `revision` 版本闸门；`undefined` 改为「保留」，只有 `null` 才清空；
///     删除会就地改写 L1 数组的 `appendMessageToSessionCache`。
/// v8: 丢弃被「刷新回放跨 round 重复」污染的旧画布（工具边界之后的思考/正文被重开一份）。
/// v9: 身份唯一化后不再保留无 id 行的文本兜底，旧画布整体作废。
/// v10: 引入 wire `part_rev`；旧画布没有 revision，无法与新 replay 做
///      幂等合并，必须整体作废后由服务端重新水合。
/// v11: 缓存快照附带已应用的 stream `lastSeq`；旧条目没有游标快照，整体作废。
/// v12: 移除空 assistant 占位与画布清洗；旧缓存可能含这些瞬态行，整体作废。
/// v13: 废弃旧版带临时序号伪造的画布。
/// v14: 彻底废弃被因果断层（a e f）污染的历史缓存；反写强制落盘权威切片 offset 与 total。
export const CACHE_SCHEMA = 14;

/** @deprecated 使用 [`CACHE_SCHEMA`]；保留别名仅为兼容既有导入。 */
export const CACHE_DISPLAY_VERSION = CACHE_SCHEMA;

export interface CachedSessionData {
  sessionId: string;
  projectHash: string;
  messages: any[];
  displayVersion?: number;
  /** 后端权威版本（`SessionDetail.revision` / `session_mutated.revision`）。 */
  revision?: number;
  /** Highest stream `seq` already applied when this snapshot was written. */
  lastSeq?: number;
  /** Snapshot provenance: a live snapshot may be a partial in-flight tail. */
  phase?: 'live' | 'terminal';
  /** Operation that produced this snapshot (new daemon). */
  operationId?: string | null;
  todos?: any[] | null;
  /** Server-assigned monotonic revision of `todos` in this snapshot. */
  todoRevision?: number;
  /** Queue snapshot (cards may carry image bytes); never a source of truth. */
  queue?: any[] | null;
  queueRevision?: number;
  turns?: any[] | null;
  tokenUsage?: any | null;
  /** tokenUsage 是否来自一次已提交的压缩；刷新后优先于服务端压缩前的旧 usage。 */
  compacted?: boolean | null;
  historyOffset?: number;
  historyTotal?: number;
  timestamp: number;
  /** Last read/write time; LRU eviction uses this instead of write time. */
  lastAccess?: number;
  /** Approximate stored bytes (UTF-8 JSON payload). */
  size?: number;
  mtime_ms?: number;
  approvalMode?: string | null;
  preferredModel?: string | null;
  reasoningEffort?: string | null;
  thinkingBudget?: number | null;
}

/**
 * 一次缓存写入的补丁。
 *
 * 三个值的语义必须严格区分：
 * - `undefined` → **保持原值**（本次没有这个信息）；
 * - `null`      → **显式清空**（例如回合结束后不再有在途待办）；
 * - 其它值      → 覆盖。
 */
export interface CachePatch {
  messages?: any[] | null;
  revision?: number | null;
  lastSeq?: number | null;
  phase?: 'live' | 'terminal' | null;
  operationId?: string | null;
  todos?: any[] | null;
  todoRevision?: number | null;
  queue?: any[] | null;
  queueRevision?: number | null;
  turns?: any[] | null;
  tokenUsage?: any | null;
  compacted?: boolean | null;
  historyOffset?: number | null;
  historyTotal?: number | null;
  approvalMode?: string | null;
  preferredModel?: string | null;
  reasoningEffort?: string | null;
  thinkingBudget?: number | null;
  mtimeMs?: number | null;
}

const DB_NAME = 'jeikcode_cache';
const DB_VERSION = 2;
const STORE_SESSIONS = 'sessions';
const STORE_FILES = 'files';
const STORE_TREES = 'trees';
const MAX_MEMORY_ENTRIES = 30;
/** L2 IndexedDB budget. Keep it well below typical browser quotas. */
const MAX_DB_BYTES = 64 * 1024 * 1024;
const MAX_DB_ENTRIES = 200;
const DB_TARGET_RATIO = 0.8;
let evictionScheduled = false;

// L1 内存 LRU 缓存 (0.00ms 极速响应)
const memoryCache = new Map<string, CachedSessionData>();
/** 已见过的最大 revision（按 key）。即使 L1 尚未水合，也能拦住旧快照回写。 */
const knownRevisions = new Map<string, number>();
const fileMemoryCache = new Map<string, string>();
const treeMemoryCache = new Map<string, any>();

function makeKey(projectHash: string, sessionId: string): string {
  return `${projectHash}:${sessionId}`;
}

/**
 * 估算缓存体积（仅用于 LRU 预算）。
 *
 * 不再对整条会话做 `JSON.stringify`：带 base64 图片时那会在每一次去抖写上
 * 分配几十 MB 的字符串。这里按结构累加，误差对淘汰策略足够。
 */
function estimateCachedBytes(data: CachedSessionData): number {
  let bytes = 512;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (const message of messages) {
    bytes += 96;
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const part of parts) {
      if (typeof part?.text === 'string') bytes += part.text.length * 2;
      if (typeof part?.tool?.args === 'string') bytes += part.tool.args.length * 2;
      if (typeof part?.tool?.output === 'string') bytes += part.tool.output.length * 2;
      if (typeof part?.tool?.progress === 'string') bytes += part.tool.progress.length;
    }
    const images = Array.isArray(message?.images) ? message.images : [];
    for (const image of images) {
      bytes += typeof image?.data === 'string' ? image.data.length : 0;
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === 'messages' || key === 'size') continue;
    if (typeof value === 'string') bytes += value.length * 2;
  }
  return bytes;
}

// ============================================================================
// 纯函数：合并与闸门（可直接单测，不依赖 IndexedDB）
// ============================================================================

/**
 * 版本闸门。
 *
 * - `incoming == null`（旧 daemon / 未提供）→ 允许写入：调用方仍可能写入
 *   比已存更新鲜的画布，拒绝会丢数据；此时只依赖 schema 与后续版本纠偏。
 * - `stored == null`（首次写入）→ 允许。
 * - 其余 → `incoming >= stored` 才允许。**绝不允许低版本覆盖高版本。**
 */
export function shouldAcceptCacheWrite(
  stored: number | null | undefined,
  incoming: number | null | undefined,
): boolean {
  if (incoming == null) return true;
  if (stored == null) return true;
  return incoming >= stored;
}

/** 取补丁值：`undefined` 保留 `previous`，`null` 清空，其它覆盖。 */
function pick<T>(patchValue: T | null | undefined, previous: T | undefined): T | undefined {
  if (patchValue === undefined) return previous;
  if (patchValue === null) return undefined;
  return patchValue;
}

/**
 * 把一次 patch 合并到已有快照上。**唯一**的字段合并实现。
 *
 * 与旧实现的区别：`todos` / `tokenUsage` 不再因为调用方没传就被清空；
 * 需要清空时必须显式传 `null`。
 */
export function mergeCachePatch(
  projectHash: string,
  sessionId: string,
  previous: CachedSessionData | undefined,
  patch: CachePatch,
  now = Date.now(),
): CachedSessionData {
  const messages = patch.messages === undefined
    ? (previous?.messages ?? [])
    : patch.messages === null
      ? []
      : patch.messages;
  // 只有本次真正提交了画布 messages（或显式传入 patch.lastSeq）时才采样实时流游标：
  // 仅更新模型/模式元数据（patch.messages === undefined）绝不能把超前的流游标写进旧画布快照，
  // 否则刷新续传会跳过尚未写入 messages 的中间帧（如 steered 气泡）。
  // 同时只有当 patch 未改写 operationId，或新旧 operationId 均存在且严格相等时，才允许继承
  // previous.lastSeq；旧缓存无 operationId 而新 patch 携带 operationId 时绝不能继承旧高水位。
  const nextOperationId = pick(patch.operationId, previous?.operationId);
  const sameOperation =
    patch.operationId === undefined ||
    (patch.operationId !== null && previous?.operationId === patch.operationId);
  let lastSeq: number | undefined;
  if (patch.lastSeq === null) {
    lastSeq = undefined;
  } else {
    const cursorSeq = patch.messages !== undefined ? readStreamCursor(sessionId)?.seq : undefined;
    const seqCandidates = [
      patch.lastSeq,
      sameOperation ? previous?.lastSeq : undefined,
      cursorSeq,
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    lastSeq = seqCandidates.length > 0 ? Math.max(...seqCandidates) : undefined;
  }
  const data: CachedSessionData = {
    sessionId,
    projectHash,
    displayVersion: CACHE_SCHEMA,
    messages,
    revision: pick(patch.revision, previous?.revision),
    lastSeq,
    phase: pick(patch.phase, previous?.phase),
    operationId: nextOperationId,
    todos: pick(patch.todos, previous?.todos),
    todoRevision: pick(patch.todoRevision, previous?.todoRevision),
    queue: pick(patch.queue, previous?.queue),
    queueRevision: pick(patch.queueRevision, previous?.queueRevision),
    turns: pick(patch.turns, previous?.turns),
    tokenUsage: pick(patch.tokenUsage, previous?.tokenUsage),
    compacted: pick(patch.compacted, previous?.compacted),
    historyOffset: pick(patch.historyOffset, previous?.historyOffset),
    historyTotal: pick(patch.historyTotal, previous?.historyTotal),
    timestamp: now,
    lastAccess: now,
    mtime_ms: pick(patch.mtimeMs, previous?.mtime_ms),
    approvalMode: pick(patch.approvalMode, previous?.approvalMode),
    preferredModel: pick(patch.preferredModel, previous?.preferredModel),
    reasoningEffort: pick(patch.reasoningEffort, previous?.reasoningEffort),
    thinkingBudget: pick(patch.thinkingBudget, previous?.thinkingBudget),
  };
  data.size = estimateCachedBytes(data);
  return data;
}

// ============================================================================
// L2 持久化（单写者：只有本文件能调用）
// ============================================================================

function persistSessionCacheAccess(projectHash: string, sessionId: string, data: CachedSessionData): void {
  void (async () => {
    const db = await getDB();
    if (!db) return;
    try {
      const key = makeKey(projectHash, sessionId);
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.get(key);
      req.onsuccess = () => {
        const latest = req.result as CachedSessionData | undefined;
        // 只更新时间戳，绝不把刚才读到的旧快照写回去（那会覆盖更新的写入）。
        // key 必须一并写回：store 的 keyPath 是 `key`，缺字段的 put 会失败。
        if (latest && latest.timestamp === data.timestamp) {
          store.put({ key, ...latest, lastAccess: data.lastAccess ?? Date.now() });
        }
      };
    } catch {
      // best effort: LRU accuracy does not justify surfacing a cache error
    }
  })();
}

function scheduleSessionCacheEviction(): void {
  if (evictionScheduled) return;
  evictionScheduled = true;
  const timer = typeof window !== 'undefined' ? window.setTimeout : globalThis.setTimeout;
  timer(() => {
    evictionScheduled = false;
    void evictSessionCacheBudget();
  }, 1000);
}

async function evictSessionCacheBudget(): Promise<void> {
  const db = await getDB();
  if (!db) return;
  const entries: Array<{ key: string; size: number; lastAccess: number }> = [];
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const req = tx.objectStore(STORE_SESSIONS).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const value = cursor.value as CachedSessionData & { key?: string };
        const size = typeof value.size === 'number' ? value.size : estimateCachedBytes(value);
        entries.push({
          key: value.key ?? cursor.primaryKey as string,
          size,
          lastAccess: value.lastAccess ?? value.timestamp ?? 0,
        });
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {
    return;
  }

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= MAX_DB_BYTES && entries.length <= MAX_DB_ENTRIES) return;

  entries.sort((a, b) => a.lastAccess - b.lastAccess);
  const targetBytes = Math.floor(MAX_DB_BYTES * DB_TARGET_RATIO);
  const targetEntries = Math.floor(MAX_DB_ENTRIES * DB_TARGET_RATIO);
  const deleted: string[] = [];
  const tx = db.transaction(STORE_SESSIONS, 'readwrite');
  const store = tx.objectStore(STORE_SESSIONS);
  for (const entry of entries) {
    if (total <= targetBytes && entries.length - deleted.length <= targetEntries) break;
    store.delete(entry.key);
    deleted.push(entry.key);
    total -= entry.size;
  }
  for (const key of deleted) {
    memoryCache.delete(key);
    knownRevisions.delete(key);
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDB(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
            db.createObjectStore(STORE_SESSIONS, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(STORE_FILES)) {
            db.createObjectStore(STORE_FILES, { keyPath: 'path' });
          }
          if (!db.objectStoreNames.contains(STORE_TREES)) {
            db.createObjectStore(STORE_TREES, { keyPath: 'path' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          console.warn('[SessionCache] IndexedDB open failed, falling back to memory only');
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

// ============================================================================
// L1 读
// ============================================================================

/** 同步快速检查 L1 内存中是否已存在该会话 (0.00ms) */
export function hasMemorySession(projectHash: string, sessionId: string): boolean {
  const key = makeKey(projectHash, sessionId);
  return memoryCache.has(key);
}

/** 同步从 L1 内存获取该会话 (0.00ms) */
export function getMemorySession(projectHash: string, sessionId: string): CachedSessionData | null {
  const key = makeKey(projectHash, sessionId);
  const data = memoryCache.get(key);
  if (data && data.displayVersion === CACHE_SCHEMA) {
    // LRU: 刷新访问顺序
    memoryCache.delete(key);
    memoryCache.set(key, data);
    return data;
  }
  return null;
}

/** 同步取某会话已缓存的版本号（0 = 未知）。 */
export function getMemorySessionRevision(projectHash: string, sessionId: string): number {
  const data = getMemorySession(projectHash, sessionId);
  return typeof data?.revision === 'number' ? data.revision : 0;
}

/** 读取缓存时清理旧版本误持久化的瞬时提示（不改写 DB，下一次保存自然收敛）。 */
function cleanCachedSession(
  data: CachedSessionData | undefined,
): CachedSessionData | undefined {
  if (!data || !Array.isArray(data.messages)) return data;
  const stripped = stripTransientNoticeRows(data.messages);
  let changed = stripped !== data.messages;
  const messages = stripped.map((row: any) => {
    // 旧版把 turn_diagnostic（压缩标记/告警）伪装成 assistant 行。
    // 只有 notice 部件的 assistant 行不是回答，归一化为 system，
    // 否则刷新后仍会以“回答”的身份挂在时间线上。
    if (row?.role !== 'assistant' || !Array.isArray(row.parts) || row.parts.length === 0) {
      return row;
    }
    const onlyNotices = row.parts.every(
      (part: any) => part?.kind === 'notice' || part?.kind === 'rate_limited',
    );
    if (!onlyNotices) return row;
    changed = true;
    return { ...row, role: 'system' };
  });
  return changed ? { ...data, messages } : data;
}

/**
 * 异步获取会话缓存：优先 L1 内存，次选 L2 IndexedDB (1~3ms)
 * 当 projectHash 未知时（如冷启动首帧），自动按 sessionId 检索，实现真正的 0ms 离线秒出。
 */
export async function getSessionCache(
  projectHash: string,
  sessionId: string,
  opts?: { preferPersisted?: boolean },
): Promise<CachedSessionData | null> {
  if (!opts?.preferPersisted) {
    if (projectHash) {
      const mem = getMemorySession(projectHash, sessionId);
      if (mem) return cleanCachedSession(mem) ?? null;
    } else {
      for (const data of memoryCache.values()) {
        if (data.sessionId === sessionId && data.displayVersion === CACHE_SCHEMA) {
          return cleanCachedSession(data) ?? null;
        }
      }
    }
  }

  const db = await getDB();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      if (projectHash) {
        const req = store.get(makeKey(projectHash, sessionId));
        req.onsuccess = () => {
          const result = cleanCachedSession(req.result as CachedSessionData | undefined);
          if (
            result &&
            result.displayVersion === CACHE_SCHEMA &&
            Array.isArray(result.messages)
          ) {
            result.lastAccess = Date.now();
            if (typeof result.size !== 'number') result.size = estimateCachedBytes(result);
            if (typeof result.revision === 'number') knownRevisions.set(makeKey(projectHash, sessionId), result.revision);
            setMemorySession(projectHash, sessionId, result);
            persistSessionCacheAccess(projectHash, sessionId, result);
            resolve(result);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } else {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const result = cleanCachedSession(cursor.value as CachedSessionData | undefined);
            if (
              result &&
              result.sessionId === sessionId &&
              result.displayVersion === CACHE_SCHEMA &&
              Array.isArray(result.messages)
            ) {
              result.lastAccess = Date.now();
              if (typeof result.size !== 'number') result.size = estimateCachedBytes(result);
              if (typeof result.revision === 'number') knownRevisions.set(makeKey(result.projectHash, sessionId), result.revision);
              setMemorySession(result.projectHash, sessionId, result);
              persistSessionCacheAccess(result.projectHash, sessionId, result);
              resolve(result);
              return;
            }
            cursor.continue();
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      }
    } catch {
      resolve(null);
    }
  });
}

function setMemorySession(projectHash: string, sessionId: string, data: CachedSessionData): void {
  const key = makeKey(projectHash, sessionId);
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  } else if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    // 淘汰最久未访问的首个 entry
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, data);
}

// ============================================================================
// 写（唯一入口）
// ============================================================================

async function persistEntry(entry: CachedSessionData): Promise<void> {
  const db = await getDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    tx.objectStore(STORE_SESSIONS).put({
      key: makeKey(entry.projectHash, entry.sessionId),
      ...entry,
    });
    scheduleSessionCacheEviction();
  } catch (err) {
    console.warn('[SessionCache] Failed to write to IndexedDB:', err);
  }
}

/**
 * 弱网/流式期间的 L2 写入合并（#7）。
 *
 * 流式每个 token 批次都提交画布时，逐次 `IndexedDB.put` 会把主线程写入与
 * 结构化克隆开销叠加在渲染上。这里把同一会话的多次提交合并成一次，并在
 * `requestIdleCallback`（无则 setTimeout）里落盘：
 * - 同一 key 只保留最后一次（画布是快照，旧版本无意义）；
 * - 页面隐藏/卸载前强制冲刷（flushPendingPersist），绝不丢最后状态。
 */
const pendingPersist = new Map<string, CachedSessionData>();
let persistScheduled = false;

function scheduleFlush(): void {
  if (persistScheduled) return;
  persistScheduled = true;
  const run = () => {
    persistScheduled = false;
    void flushPendingPersist();
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(run, { timeout: 1200 });
  else setTimeout(run, 60);
}

/** 立即把所有待落盘条目写入 L2（页面隐藏/切会话/卸载前调用）。 */
export async function flushPendingPersist(): Promise<void> {
  if (pendingPersist.size === 0) return;
  const entries = [...pendingPersist.values()];
  pendingPersist.clear();
  for (const entry of entries) {
    await persistEntry(entry);
  }
}

/** 延后落盘的入口：同 key 覆盖，idle 时批量写。 */
function queuePersist(entry: CachedSessionData): void {
  pendingPersist.set(makeKey(entry.projectHash, entry.sessionId), entry);
  scheduleFlush();
}

/**
 * 提交一次缓存 patch（**唯一**写入口）。
 *
 * 同步更新 L1，异步落 L2。返回是否真的写入（版本闸门拒绝时返回 false）。
 * 调用方必须先有 `projectHash` 与 `sessionId`，**不得**在 await 之后再读
 * “当前会话 id”来决定写谁。
 */
export function writeSessionCache(
  projectHash: string,
  sessionId: string,
  patch: CachePatch,
): boolean {
  if (!projectHash || !sessionId) return false;
  const key = makeKey(projectHash, sessionId);
  const previous = memoryCache.get(key);
  const storedRevision = previous?.revision ?? knownRevisions.get(key);
  if (!shouldAcceptCacheWrite(storedRevision, patch.revision)) return false;
  // 单写者兼最后一道幂等闸门：落盘前按 id 归一，任何调用点都不可能把
  // 同一条消息写成两份（旧缓存条目已由 schema v7 丢弃）。
  const normalizedPatch = Array.isArray(patch.messages)
    ? { ...patch, messages: normalizeCanvas(patch.messages) }
    : patch;
  const next = mergeCachePatch(projectHash, sessionId, previous, normalizedPatch);
  if (typeof next.revision === 'number') knownRevisions.set(key, next.revision);
  setMemorySession(projectHash, sessionId, next);
  queuePersist(next);
  return true;
}

/**
 * 生产代码唯一的画布缓存提交边界。组件与事件处理只调用它；底层
 * `writeSessionCache` 仅保留给存储层单测与 meta patch。
 */
export function commitCanvasCache(
  projectHash: string,
  sessionId: string,
  patch: CachePatch,
): boolean {
  // 瞬时通知（notice / rate_limited）绝不进缓存：它们属于“当前轮次的反馈”，
  // 一旦随快照落盘，后续每一轮都会把新回答排在它后面（用户看到提示粘在所有
  // 回答下面）。需要时由当前轮自己的事件重新生成。
  const cleaned = Array.isArray(patch.messages)
    ? { ...patch, messages: stripTransientNoticeRows(patch.messages) }
    : patch;
  return writeSessionCache(projectHash, sessionId, cleaned);
}

/**
 * 就地更新会话缓存中的「会话级配置」字段（模型 / 模式 / 强度），不触碰消息画布。
 *
 * 用于下拉框一行变更就立即落库：即使随后切走会话或刷新，也不会被另一会话的
 * 选择或全局默认值覆盖。若尚无缓存条目则静默跳过（首屏拉取会补全）。
 */
export function updateSessionCacheMeta(
  projectHash: string,
  sessionId: string,
  patch: {
    approvalMode?: string | null;
    preferredModel?: string | null;
    reasoningEffort?: string | null;
    thinkingBudget?: number | null;
  },
): void {
  if (!projectHash || !sessionId) return;
  const key = makeKey(projectHash, sessionId);
  if (!memoryCache.has(key)) return;
  writeSessionCache(projectHash, sessionId, patch);
}

/**
 * 删除某会话的本地缓存（L1 内存 + L2 IndexedDB）。
 *
 * 会话被删除（本端操作或跨实例推送）后必须立即失效：否则侧栏/正文一旦
 * 再次读到旧缓存，幽灵会话就会复活到下一次冷启动重拉为止。
 */
export async function deleteSessionCache(
  projectHash: string,
  sessionId: string,
): Promise<void> {
  const key = makeKey(projectHash, sessionId);
  memoryCache.delete(key);
  knownRevisions.delete(key);
  const db = await getDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    tx.objectStore(STORE_SESSIONS).delete(key);
  } catch (err) {
    console.warn('[SessionCache] Failed to delete from IndexedDB:', err);
  }
}

/**
 * Ctrl + F5 强制清理：一网打尽清空所有 L1 内存与 L2 IndexedDB 缓存
 */
export async function clearAllSessionCache(): Promise<void> {
  memoryCache.clear();
  knownRevisions.clear();
  fileMemoryCache.clear();
  treeMemoryCache.clear();
  const db = await getDB();
  if (!db) return;
  try {
    const stores = [STORE_SESSIONS, STORE_FILES, STORE_TREES].filter((name) =>
      db.objectStoreNames.contains(name)
    );
    if (stores.length === 0) return;
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) {
      tx.objectStore(name).clear();
    }
  } catch {
    // 忽略清空错误
  }
}

// ==================== 文件内容与目录树 IndexedDB 缓存 (打破 5MB 限制) ====================

/**
 * 异步获取文件内容缓存：优先 L1 内存，次选 L2 IndexedDB (1~2ms 极速直出)
 */
export async function getCachedFileContent(path: string): Promise<string | null> {
  const norm = path.replace(/\\/g, '/');
  if (fileMemoryCache.has(norm)) return fileMemoryCache.get(norm)!;

  const db = await getDB();
  if (!db || !db.objectStoreNames.contains(STORE_FILES)) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const store = tx.objectStore(STORE_FILES);
      const req = store.get(norm);
      req.onsuccess = () => {
        const res = req.result;
        if (res && typeof res.content === 'string') {
          fileMemoryCache.set(norm, res.content);
          resolve(res.content);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 同步将文件内容写入 L1 内存并异步持久化至 L2 IndexedDB
 */
export async function saveCachedFileContent(path: string, content: string): Promise<void> {
  const norm = path.replace(/\\/g, '/');
  fileMemoryCache.set(norm, content);

  const db = await getDB();
  if (!db || !db.objectStoreNames.contains(STORE_FILES)) return;

  try {
    const tx = db.transaction(STORE_FILES, 'readwrite');
    const store = tx.objectStore(STORE_FILES);
    store.put({ path: norm, content, timestamp: Date.now() });
  } catch {}
}

/**
 * 获取目录树缓存（L1 内存 + L2 IndexedDB，彻底解除 sessionStorage 5MB 限制）
 */
export async function getCachedDirectoryTree<T = any>(path: string): Promise<T | null> {
  const norm = (path || 'root').replace(/\\/g, '/');
  if (treeMemoryCache.has(norm)) return treeMemoryCache.get(norm) as T;

  const db = await getDB();
  if (!db || !db.objectStoreNames.contains(STORE_TREES)) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_TREES, 'readonly');
      const store = tx.objectStore(STORE_TREES);
      const req = store.get(norm);
      req.onsuccess = () => {
        const res = req.result;
        if (res && res.tree) {
          treeMemoryCache.set(norm, res.tree);
          resolve(res.tree as T);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 持久化目录树快照至 L1 内存与 L2 IndexedDB
 */
export async function saveCachedDirectoryTree(path: string, tree: any): Promise<void> {
  const norm = (path || 'root').replace(/\\/g, '/');
  treeMemoryCache.set(norm, tree);

  const db = await getDB();
  if (!db || !db.objectStoreNames.contains(STORE_TREES)) return;

  try {
    const tx = db.transaction(STORE_TREES, 'readwrite');
    const store = tx.objectStore(STORE_TREES);
    store.put({ path: norm, tree, timestamp: Date.now() });
  } catch {}
}
