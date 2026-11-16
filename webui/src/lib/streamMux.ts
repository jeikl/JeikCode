/**
 * streamMux.ts — 单标签页 WebSocket 多路复用与 SSE Leader 降级通道。
 *
 * 1. 优先复用单条 `/stream/ws` WebSocket 承载全局 `/events`（channel: "global"）
 *    与多个并发会话 `watch` / `unwatch`（channel: "chat"），彻底避开 HTTP/1.1 同源 6 连接上限。
 * 2. 若代理或环境阻断 WebSocket 握手，自动降级为 HTTP SSE，并由 BroadcastChannel 选主
 *    （仅 1 个 Leader 标签页持有 `/events`，其余标签页静默收广播）；
 *    同时在标签页切入后台时自动暂停 standby 监视以节省连接与唤醒开销。
 */
import type { GlobalWireEvent, SSEEvent, SeqTaggedFrame } from '../api';

export interface MuxChatWatchOptions {
  standbyOnly?: boolean;
  afterSeq?: number;
  clientId?: string;
}

type GlobalSubscriber = {
  onEvent: (event: GlobalWireEvent) => void;
  onDrop: (err?: Error) => void;
};

type ChatWatcher = {
  sessionId: string;
  standbyOnly: boolean;
  afterSeq?: number;
  clientId?: string;
  onEvent: (event: SSEEvent & SeqTaggedFrame) => void;
  onResolve: () => void;
  onReject: (err: Error) => void;
  terminalSeen: boolean;
  subscribedOnWire: boolean;
  pausedByHidden: boolean;
  settled: boolean;
};

let ws: WebSocket | null = null;
let wsOpenedOnce = false;
let wsConnecting = false;
let wsLastActivity = 0;
let wsPingTimer: number | null = null;
let wsWatchdogTimer: number | null = null;
let wsListenersInstalled = false;
let wsConsecutiveHandshakeFailures = 0;
let wsFallbackUntil = 0;
let currentGetToken: () => string = () => '';

const globalSubs = new Set<GlobalSubscriber>();
const chatWatchers = new Map<string, ChatWatcher>();

const WS_HEARTBEAT_MS = 20_000;
const WS_IDLE_TIMEOUT_MS = 30_000;
const WS_FALLBACK_COOLDOWN_MS = 60_000;

export function canUseStreamMux(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof WebSocket === 'function' &&
    typeof location !== 'undefined' &&
    Boolean(location.host)
  );
}

export function isMuxFallbackActive(): boolean {
  return Date.now() < wsFallbackUntil;
}

function buildWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = currentGetToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${location.host}/stream/ws${q}`;
}

function sendWsCmd(payload: Record<string, unknown>): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function shouldPauseStandby(): boolean {
  return typeof document !== 'undefined' && Boolean(document.hidden);
}

function syncWatcherOnWire(watcher: ChatWatcher) {
  if (watcher.settled || !ws || ws.readyState !== WebSocket.OPEN) return;
  const hidden = shouldPauseStandby();
  if (watcher.standbyOnly && hidden) {
    if (watcher.subscribedOnWire) {
      sendWsCmd({ op: 'unwatch', session_id: watcher.sessionId });
      watcher.subscribedOnWire = false;
    }
    watcher.pausedByHidden = true;
    return;
  }
  if (!watcher.subscribedOnWire) {
    watcher.pausedByHidden = false;
    const sent = sendWsCmd({
      op: 'watch',
      session_id: watcher.sessionId,
      standby: watcher.standbyOnly,
      ...(watcher.afterSeq !== undefined ? { after_seq: watcher.afterSeq } : {}),
      ...(watcher.clientId ? { client_id: watcher.clientId } : {}),
    });
    if (sent) watcher.subscribedOnWire = true;
  }
}

function syncAllWatchersVisibility() {
  for (const watcher of chatWatchers.values()) {
    syncWatcherOnWire(watcher);
  }
}

function stopWsTimers() {
  if (wsPingTimer !== null) {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
  if (wsWatchdogTimer !== null) {
    clearInterval(wsWatchdogTimer);
    wsWatchdogTimer = null;
  }
}

function closeWsIfIdle() {
  if (globalSubs.size === 0 && chatWatchers.size === 0 && ws) {
    stopWsTimers();
    const closing = ws;
    ws = null;
    wsConnecting = false;
    try {
      closing.close();
    } catch {}
  }
}

function checkWsWakeup() {
  if (typeof document !== 'undefined' && document.hidden) return;
  syncAllWatchersVisibility();
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - wsLastActivity > WS_IDLE_TIMEOUT_MS) {
    try {
      ws.close();
    } catch {}
  }
}

function installWsListeners() {
  if (wsListenersInstalled || typeof window === 'undefined') return;
  wsListenersInstalled = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', checkWsWakeup);
  }
  window.addEventListener('focus', checkWsWakeup);
  window.addEventListener('online', checkWsWakeup);
}

function settleAllWatchersWithDrop(reason: string) {
  const err = new Error(reason);
  for (const [sid, watcher] of [...chatWatchers.entries()]) {
    chatWatchers.delete(sid);
    if (watcher.settled) continue;
    watcher.settled = true;
    if (watcher.terminalSeen) {
      watcher.onResolve();
    } else {
      watcher.onReject(err);
    }
  }
}

function notifyGlobalDrop(err?: Error) {
  for (const sub of [...globalSubs]) {
    globalSubs.delete(sub);
    sub.onDrop(err);
  }
}

function ensureMuxSocket(getToken: () => string): boolean {
  currentGetToken = getToken;
  if (!canUseStreamMux() || isMuxFallbackActive()) return false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return true;
  }

  installWsListeners();
  stopWsTimers();
  let openedInThisAttempt = false;
  wsConnecting = true;
  wsOpenedOnce = false;
  wsLastActivity = Date.now();

  let socket: WebSocket;
  try {
    socket = new WebSocket(buildWsUrl());
  } catch {
    wsConnecting = false;
    wsConsecutiveHandshakeFailures += 1;
    if (wsConsecutiveHandshakeFailures >= 2) {
      wsFallbackUntil = Date.now() + WS_FALLBACK_COOLDOWN_MS;
    }
    return false;
  }
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    openedInThisAttempt = true;
    wsOpenedOnce = true;
    wsConnecting = false;
    wsConsecutiveHandshakeFailures = 0;
    wsFallbackUntil = 0;
    wsLastActivity = Date.now();

    for (const watcher of chatWatchers.values()) {
      watcher.subscribedOnWire = false;
      syncWatcherOnWire(watcher);
    }

    stopWsTimers();
    wsPingTimer = window.setInterval(() => {
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        sendWsCmd({ op: 'ping' });
      }
    }, WS_HEARTBEAT_MS);
    wsWatchdogTimer = window.setInterval(() => {
      if (ws === socket && Date.now() - wsLastActivity > WS_IDLE_TIMEOUT_MS) {
        try {
          socket.close();
        } catch {}
      }
    }, 4000);
  };

  socket.onmessage = (msgEvent) => {
    if (ws !== socket) return;
    wsLastActivity = Date.now();
    if (typeof msgEvent.data !== 'string') return;
    let parsed: {
      channel?: string;
      event?: unknown;
      session_id?: string;
      ended?: boolean;
      error?: string;
    };
    try {
      parsed = JSON.parse(msgEvent.data);
    } catch {
      return;
    }

    if (parsed.channel === 'pong') return;

    if (parsed.channel === 'global' && parsed.event && typeof parsed.event === 'object') {
      const ev = parsed.event as GlobalWireEvent;
      for (const sub of [...globalSubs]) {
        try {
          sub.onEvent(ev);
        } catch {}
      }
      return;
    }

    if (parsed.channel === 'chat' && parsed.session_id) {
      const watcher = chatWatchers.get(parsed.session_id);
      if (!watcher || watcher.settled) return;
      if (parsed.event && typeof parsed.event === 'object') {
        const chatEvent = parsed.event as SSEEvent & SeqTaggedFrame;
        if (typeof chatEvent.seq === 'number' && Number.isInteger(chatEvent.seq)) {
          watcher.afterSeq = chatEvent.seq;
        }
        if (
          chatEvent.type === 'done' ||
          chatEvent.type === 'stopped' ||
          chatEvent.type === 'error'
        ) {
          watcher.terminalSeen = true;
        }
        try {
          watcher.onEvent(chatEvent);
        } catch {}
      }
      if (parsed.ended) {
        chatWatchers.delete(parsed.session_id);
        watcher.settled = true;
        if (!watcher.terminalSeen) {
          try {
            watcher.onEvent({
              type: 'done',
              tokens: 0,
              tool_calls: 0,
              session_id: parsed.session_id,
              stop_reason: parsed.error || 'watch_closed',
            } as SSEEvent);
          } catch {}
        }
        watcher.onResolve();
        closeWsIfIdle();
      }
    }
  };

  socket.onerror = () => {
    /* 详细收尾统一交由 onclose 处理，避免重复结算 */
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    stopWsTimers();
    ws = null;
    wsConnecting = false;
    if (!openedInThisAttempt && !wsOpenedOnce) {
      wsConsecutiveHandshakeFailures += 1;
      if (wsConsecutiveHandshakeFailures >= 2) {
        wsFallbackUntil = Date.now() + WS_FALLBACK_COOLDOWN_MS;
      }
      const fallbackErr = new Error('ws_mux_unavailable');
      fallbackErr.name = 'MuxUnavailableError';
      settleAllWatchersWithDrop('ws_mux_unavailable');
      notifyGlobalDrop(fallbackErr);
      return;
    }
    settleAllWatchersWithDrop('ws_mux_closed');
    notifyGlobalDrop(new Error('ws_mux_closed'));
  };

  return true;
}

/** 通过复用 WebSocket 订阅全局增量事件。若 WS 不可用会抛出 `MuxUnavailableError` 供降级。 */
export function muxStreamGlobalEvents(
  getToken: () => string,
  onEvent: (event: GlobalWireEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('global events aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const sub: GlobalSubscriber = {
      onEvent,
      onDrop: (err) => {
        cleanup();
        if (err && err.name === 'MuxUnavailableError') {
          reject(err);
        } else {
          resolve();
        }
      },
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('global events aborted');
      err.name = 'AbortError';
      reject(err);
    };
    const cleanup = () => {
      globalSubs.delete(sub);
      if (signal) signal.removeEventListener('abort', onAbort);
      closeWsIfIdle();
    };
    globalSubs.add(sub);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (!ensureMuxSocket(getToken)) {
      cleanup();
      const err = new Error('ws_mux_unavailable');
      err.name = 'MuxUnavailableError';
      reject(err);
    }
  });
}

/** 通过复用 WebSocket 订阅单会话 `watch`；WS 不可用时抛出 `MuxUnavailableError`。 */
export function muxWatchChatSession(
  getToken: () => string,
  sessionId: string,
  onEvent: (event: SSEEvent & SeqTaggedFrame) => void,
  signal?: AbortSignal,
  opts?: MuxChatWatchOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('chat watch aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }

    // 同一 session 若已有残留订阅先替换，保证与原 single-session watch 一致
    const existing = chatWatchers.get(sessionId);
    if (existing && !existing.settled) {
      existing.settled = true;
      chatWatchers.delete(sessionId);
      sendWsCmd({ op: 'unwatch', session_id: sessionId });
      existing.onResolve();
    }

    const onAbort = () => {
      const current = chatWatchers.get(sessionId);
      if (current === watcher) {
        chatWatchers.delete(sessionId);
        if (current.subscribedOnWire) {
          sendWsCmd({ op: 'unwatch', session_id: sessionId });
        }
        closeWsIfIdle();
      }
      if (!watcher.settled) {
        watcher.settled = true;
        const err = new Error('chat watch aborted');
        err.name = 'AbortError';
        reject(err);
      }
    };

    const cleanupSignal = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const watcher: ChatWatcher = {
      sessionId,
      standbyOnly: Boolean(opts?.standbyOnly),
      afterSeq: opts?.afterSeq,
      clientId: opts?.clientId,
      onEvent,
      onResolve: () => {
        cleanupSignal();
        resolve();
      },
      onReject: (err) => {
        cleanupSignal();
        reject(err);
      },
      terminalSeen: false,
      subscribedOnWire: false,
      pausedByHidden: false,
      settled: false,
    };

    chatWatchers.set(sessionId, watcher);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (!ensureMuxSocket(getToken)) {
      chatWatchers.delete(sessionId);
      watcher.settled = true;
      cleanupSignal();
      const err = new Error('ws_mux_unavailable');
      err.name = 'MuxUnavailableError';
      reject(err);
      return;
    }

    if (ws && ws.readyState === WebSocket.OPEN && !wsConnecting) {
      syncWatcherOnWire(watcher);
    }
  });
}

// =========================================================================
// SSE 降级增强：BroadcastChannel 选主 + 后台可见性暂停
// =========================================================================

const SSE_LEADER_LOCK_KEY = 'jeikcode_sse_events_leader_v1';
const SSE_EVENT_BC_NAME = 'jeikcode_sse_events_bc_v1';
const LEADER_LEASE_MS = 8_000;
const LEADER_RENEW_MS = 2_800;

function randomTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 暂停 standby 监视直至标签页重新回到前台（或 signal 终止）。 */
export function waitUntilVisible(signal?: AbortSignal): Promise<void> {
  if (typeof document === 'undefined' || !document.hidden) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted while hidden');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVis);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onVis = () => {
      if (!document.hidden) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('aborted while hidden');
      err.name = 'AbortError';
      reject(err);
    };
    document.addEventListener('visibilitychange', onVis);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 在 SSE 降级模式下运行跨标签页选主：
 * 同源多标签页中只有 1 个 Leader 建立 `/events` HTTP 连接，其余 Follower 通过 BroadcastChannel 接收事件。
 */
export async function runSseGlobalLeader(
  onEvent: (event: GlobalWireEvent) => void,
  signal: AbortSignal | undefined,
  openRawSse: (emit: (ev: GlobalWireEvent) => void, sseSignal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (
    typeof window === 'undefined' ||
    typeof BroadcastChannel !== 'function' ||
    typeof localStorage === 'undefined'
  ) {
    const localAbort = new AbortController();
    const forwardAbort = () => localAbort.abort();
    if (signal) {
      if (signal.aborted) localAbort.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      await openRawSse(onEvent, localAbort.signal);
    } finally {
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
    return;
  }

  const myTabId = randomTabId();
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(SSE_EVENT_BC_NAME);
  } catch {
    const localAbort = new AbortController();
    const forwardAbort = () => localAbort.abort();
    if (signal) {
      if (signal.aborted) localAbort.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      await openRawSse(onEvent, localAbort.signal);
    } finally {
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
    return;
  }

  const readLock = (): { id: string; exp: number } | null => {
    try {
      const raw = localStorage.getItem(SSE_LEADER_LOCK_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { id: string; exp: number };
    } catch {
      return null;
    }
  };

  const tryAcquireLeadership = (): boolean => {
    try {
      const now = Date.now();
      const cur = readLock();
      if (!cur || cur.id === myTabId || cur.exp < now) {
        localStorage.setItem(
          SSE_LEADER_LOCK_KEY,
          JSON.stringify({ id: myTabId, exp: now + LEADER_LEASE_MS }),
        );
        const confirm = readLock();
        return confirm?.id === myTabId;
      }
    } catch {
      return true;
    }
    return false;
  };

  const releaseLeadership = () => {
    try {
      const cur = readLock();
      if (cur?.id === myTabId) {
        localStorage.removeItem(SSE_LEADER_LOCK_KEY);
      }
    } catch {}
  };

  try {
    if (tryAcquireLeadership()) {
      const sseAbort = new AbortController();
      const onParentAbort = () => sseAbort.abort();
      if (signal) {
        if (signal.aborted) sseAbort.abort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
      }
      const renewTimer = window.setInterval(() => {
        if (!tryAcquireLeadership()) {
          sseAbort.abort();
        }
      }, LEADER_RENEW_MS);
      const onBeforeUnload = () => releaseLeadership();
      window.addEventListener('beforeunload', onBeforeUnload);
      try {
        await openRawSse((ev) => {
          onEvent(ev);
          try {
            channel?.postMessage({ kind: 'event', ev });
          } catch {}
        }, sseAbort.signal);
      } finally {
        clearInterval(renewTimer);
        window.removeEventListener('beforeunload', onBeforeUnload);
        if (signal) signal.removeEventListener('abort', onParentAbort);
        releaseLeadership();
      }
      return;
    }

    // Follower 分支：监听广播直至 Leader 租约过期或页面中止
    onEvent({ type: 'sync' });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearInterval(checkTimer);
        if (channel) channel.onmessage = null;
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error('global events aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      channel!.onmessage = (e) => {
        const msg = e.data as { kind?: string; ev?: GlobalWireEvent } | null;
        if (msg?.kind === 'event' && msg.ev && msg.ev.type !== 'sync') {
          onEvent(msg.ev);
        }
      };
      const checkTimer = window.setInterval(() => {
        const cur = readLock();
        if (!cur || cur.exp < Date.now()) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        }
      }, 2000);
    });
  } finally {
    try {
      channel.close();
    } catch {}
  }
}
