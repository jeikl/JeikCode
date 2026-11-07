/**
 * 前台标签的磁盘新鲜度轮询（全局单例调度器）。
 *
 * 标签保活之后，“切回来重新挂载 = 顺带刷新”这条隐式刷新路径没了，必须显式补上：
 * - 只有**当前可见**的编辑器才订阅（主画布前台标签 + 右侧预览前台标签，最多 2 个）；
 * - 所有订阅共用一个计时器，`setTimeout` 链式调度，慢请求不叠加、不会并行风暴；
 * - 每轮最多查 2 个目标，标签再多也按轮转公平调度；
 * - 页面隐藏时完全停止，`visibilitychange` / `focus` 只做一次即时唤醒；
 * - 只拉 `mtime + size`（/fs/stat），确认变化后由编辑器自己决定是否重读全文。
 */

import { fetchFsStat } from '../api';
import { fileStampFromStat, sameFileStamp, type FileStamp } from './fileStamp';

const POLL_INTERVAL_MS = 2500;
const MAX_INTERVAL_MS = 30_000;
const MAX_CHECKS_PER_TICK = 2;
const STAT_TIMEOUT_MS = 4000;

interface Entry {
  key: string;
  path: string;
  cwd?: string;
  baseline: FileStamp | null;
  onExternalChange: (stamp: FileStamp) => void;
  busy: boolean;
}

const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let cursor = 0;
// 连续失败（旧后端没 /fs/stat、断网、代理异常）时逐步退避，避免持续空轮询。
let intervalMs = POLL_INTERVAL_MS;
let detachWakeListeners: (() => void) | null = null;

export interface FileFreshnessSubscription {
  updateBaseline: (stamp: FileStamp | null) => void;
  dispose: () => void;
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function clearTimer(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(): void {
  if (typeof window === 'undefined') return;
  if (timer != null || running || entries.size === 0 || !pageVisible()) return;
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, intervalMs);
}

async function checkEntry(entry: Entry): Promise<boolean> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), STAT_TIMEOUT_MS) : null;
  try {
    const stat = await fetchFsStat(entry.path, entry.cwd, controller?.signal);
    const next = fileStampFromStat(stat);
    if (!entry.baseline) {
      // 首轮只建立基线：不要把“订阅前就存在的版本”误报成外部更新。
      entry.baseline = next;
      return true;
    }
    if (sameFileStamp(entry.baseline, next)) return true;
    // 先推进基线再通知：同一版本的重复响应/抖动不会形成新一轮提示。
    entry.baseline = next;
    entry.onExternalChange(next);
    return true;
  } catch {
    // 网络失败或超时：基线保持不动，下一轮重试；绝不把失败当成文件变化。
    return false;
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

async function tick(): Promise<void> {
  if (running || entries.size === 0) return;
  // 页面隐藏时不轮询，等 visibilitychange/focus 唤醒。
  if (!pageVisible()) return;
  running = true;
  try {
    const idle = Array.from(entries.values()).filter((entry) => !entry.busy);
    if (idle.length === 0) return;
    const batch: Entry[] = [];
    for (let i = 0; i < idle.length && batch.length < MAX_CHECKS_PER_TICK; i++) {
      const entry = idle[(cursor + i) % idle.length]!;
      if (!batch.includes(entry)) batch.push(entry);
    }
    cursor = (cursor + batch.length) % Math.max(1, idle.length);
    const results = await Promise.all(
      batch.map((entry) => {
        entry.busy = true;
        return checkEntry(entry).finally(() => {
          entry.busy = false;
        });
      }),
    );
    // 至少一次成功就回到基准节奏；全部失败则指数退避（旧后端 404 / 断网）。
    if (results.some(Boolean)) {
      intervalMs = POLL_INTERVAL_MS;
    } else {
      intervalMs = Math.min(intervalMs * 2, MAX_INTERVAL_MS);
    }
  } finally {
    running = false;
    schedule();
  }
}

function wake(): void {
  if (entries.size === 0) return;
  clearTimer();
  void tick();
}

function installWakeListeners(): void {
  if (detachWakeListeners || typeof window === 'undefined') return;
  const doc = typeof document === 'undefined' ? null : document;
  const onVisibilityChange = () => {
    if (!pageVisible()) {
      clearTimer();
      return;
    }
    wake();
  };
  const onFocus = () => wake();
  doc?.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  detachWakeListeners = () => {
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onFocus);
  };
}

function uninstallWakeListeners(): void {
  detachWakeListeners?.();
  detachWakeListeners = null;
}

/**
 * 订阅某个前台编辑器标签的磁盘戳。切标签时旧订阅 dispose、新订阅建立，
 * 计时器不会因为订阅变化而并行增殖；最后一个订阅退订时调度器完全停止。
 */
export function subscribeFileFreshness(args: {
  key: string;
  path: string;
  cwd?: string;
  baseline?: FileStamp | null;
  onExternalChange: (stamp: FileStamp) => void;
}): FileFreshnessSubscription {
  const entry: Entry = {
    key: args.key,
    path: args.path,
    cwd: args.cwd,
    baseline: args.baseline ?? null,
    onExternalChange: args.onExternalChange,
    busy: false,
  };
  entries.set(entry.key, entry);
  if (entries.size === 1) intervalMs = POLL_INTERVAL_MS;
  installWakeListeners();
  schedule();

  return {
    updateBaseline(stamp) {
      const live = entries.get(entry.key);
      if (live === entry) live.baseline = stamp;
    },
    dispose() {
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      if (entries.size === 0) {
        clearTimer();
        uninstallWakeListeners();
      }
    },
  };
}

/** 仅供调试/测试观察调度器是否空转；生产路径不依赖它。 */
export function activeFreshnessWatcherCount(): number {
  return entries.size;
}
