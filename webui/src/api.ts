// Task 12 — API client for jeikcode webui

import type { Lang } from './i18n';
import { stripExtendedPathPrefix } from './lib/displayPath.ts';
import type { PermissionDecisionResult } from './lib/pendingPermission.ts';
import type { ServerChatRuntime } from './lib/serverRuntime.ts';

// Serve / webui bootstrap: `/?token=<uuid>` is handed off via HttpOnly cookie
// AND left visible on first paint so we can stash it for Authorization.
// Remote LAN clients often fail to attach the cookie alone (in-app WebViews,
// privacy mode) — Bearer from sessionStorage / localStorage is the reliable
// path. The address-bar token is stripped only after a protected request has
// accepted it (CWE-598). If storage is unavailable, keep ?token= so later
// fetches still authenticate.
/** Shared storage key for the webui access token (api + RemoteAccessControl). */
export const WEBUI_TOKEN_STORAGE_KEY = 'jeikcode_webui_token';

function persistWebuiToken(value: string) {
  try {
    sessionStorage.setItem(WEBUI_TOKEN_STORAGE_KEY, value);
  } catch {
    /* private mode / quota */
  }
  try {
    localStorage.setItem(WEBUI_TOKEN_STORAGE_KEY, value);
  } catch {
    /* private mode / quota */
  }
}

/**
 * localStorage 是跨标签页共享的权威来源：另一个标签页通过新的 `/?token=`
 * 交接成功后会把新 token 写进 localStorage。若这里优先读 per-tab 的
 * sessionStorage，旧标签页会永远回放刷新前就该淘汰的旧 token（刷新也无效）。
 */
function storedWebuiToken(): string {
  try {
    const shared = localStorage.getItem(WEBUI_TOKEN_STORAGE_KEY);
    if (shared) return shared;
  } catch {
    /* ignore */
  }
  try {
    return sessionStorage.getItem(WEBUI_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function tokenFromUrl(): string {
  try {
    return new URLSearchParams(location.search).get('token') ?? '';
  } catch {
    return '';
  }
}

/** 从非 HttpOnly 的 token cookie 兜底读取（某些异地上网环境存储孤岛）。 */
function tokenFromDocumentCookie(): string {
  try {
    if (typeof document === 'undefined' || !document.cookie) return '';
    for (const pair of document.cookie.split(';')) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      // 只认明确的 webui 令牌 cookie，避免把 csrf_token 之类误当 Bearer，
      // 反而遮蔽服务端刚下发的有效 HttpOnly cookie。
      const name = trimmed.slice(0, eq).trim();
      if (name !== 'token' && name !== 'access_token' && !name.startsWith('jeikcode_webui')) {
        continue;
      }
      const val = trimmed.slice(eq + 1).trim();
      if (val) return val;
    }
  } catch {
    /* ignore */
  }
  return '';
}

function stripTokenFromAddressBar() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    const q = url.searchParams.toString();
    history.replaceState(null, '', url.pathname + (q ? `?${q}` : '') + url.hash);
  } catch {
    /* ignore */
  }
}

/** 存储不可用时把 token 写回地址栏，重载后仍能从 URL 完成认证。 */
function setTokenInAddressBar(token: string) {
  try {
    const url = new URL(location.href);
    url.searchParams.set('token', token);
    history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString() + url.hash);
  } catch {
    /* ignore */
  }
}

/** 从存储与地址栏中彻底移除一个已被服务端拒绝的 token。 */
function forgetWebuiToken(value: string) {
  const token = value.trim();
  if (!token) return;
  try {
    if (sessionStorage.getItem(WEBUI_TOKEN_STORAGE_KEY) === token) {
      sessionStorage.removeItem(WEBUI_TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
  try {
    if (localStorage.getItem(WEBUI_TOKEN_STORAGE_KEY) === token) {
      localStorage.removeItem(WEBUI_TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
  try {
    const url = new URL(location.href);
    if (url.searchParams.get('token') !== token) return;
    url.searchParams.delete('token');
    const q = url.searchParams.toString();
    history.replaceState(null, '', url.pathname + (q ? `?${q}` : '') + url.hash);
  } catch {
    /* ignore */
  }
}

function currentWebuiToken(): string {
  const fromUrl = tokenFromUrl();
  if (fromUrl) return fromUrl;
  const stored = storedWebuiToken();
  if (stored) return stored;
  const fromCookie = tokenFromDocumentCookie();
  if (fromCookie) {
    persistWebuiToken(fromCookie);
    return fromCookie;
  }
  return '';
}

function authHeaders(): Record<string, string> {
  // X-JeikCode-Client lets the daemon tag telemetry as webui-originated
  // (resolve_client_mode → SessionMode::Webui); sent regardless of token.
  const h: Record<string, string> = { 'X-JeikCode-Client': 'webui' };
  const token = currentWebuiToken();
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

export type AuthExpiredListener = (expired: boolean) => void;

let authExpired = false;
const authExpiredListeners = new Set<AuthExpiredListener>();

/** 当前页面已知的全部凭据均被服务端拒绝——必须让用户提供新令牌。 */
export function isAuthExpired(): boolean {
  return authExpired;
}

/** 订阅认证失效状态变化；返回取消订阅函数。 */
export function onAuthExpiredChange(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => {
    authExpiredListeners.delete(listener);
  };
}

function setAuthExpired(next: boolean) {
  if (authExpired === next) return;
  authExpired = next;
  for (const listener of [...authExpiredListeners]) {
    try {
      listener(next);
    } catch {
      /* isolate subscriber failures */
    }
  }
}

function clearAuthExpired() {
  setAuthExpired(false);
}

/** 测试/重连用的复位入口：清除“凭据已全部失效”的锁存状态。 */
export function resetAuthExpired(): void {
  setAuthExpired(false);
}

// 另一个标签页完成 token 轮换后，localStorage 的 storage 事件会在本标签页触发。
// 立刻采纳新 token 并解除认证失效锁存，让旧标签页无需刷新即可自愈。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== WEBUI_TOKEN_STORAGE_KEY || !event.newValue) return;
    try {
      sessionStorage.setItem(WEBUI_TOKEN_STORAGE_KEY, event.newValue);
    } catch {
      /* ignore */
    }
    clearAuthExpired();
  });
}

/** 用一个受保护请求确认并采纳新凭据（地址栏 token 只有在确认后才剥离）。 */
function confirmWebuiToken(value: string) {
  const token = value.trim();
  if (!token) return;
  persistWebuiToken(token);
  // 存储不可用（桌面 WebView / 隐私模式）时保留地址栏 token，否则后续请求会 401。
  if (storedWebuiToken() === token) stripTokenFromAddressBar();
  clearAuthExpired();
}

function tokenFromAuthorization(value: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/^bearer\s+/i, '').trim();
}

/** 除已拒绝的那个之外，本页还能尝试的其他凭据（按优先级）。 */
function tokenCandidates(rejected: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const token = raw.trim();
    if (!token || token === rejected || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  push(tokenFromUrl());
  try {
    push(localStorage.getItem(WEBUI_TOKEN_STORAGE_KEY) ?? '');
  } catch {
    /* ignore */
  }
  try {
    push(sessionStorage.getItem(WEBUI_TOKEN_STORAGE_KEY) ?? '');
  } catch {
    /* ignore */
  }
  push(tokenFromDocumentCookie());
  return out;
}

function isPublicRequest(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, 'http://localhost').pathname === '/health';
  } catch {
    return false;
  }
}

/**
 * 构造请求头。`bearer === undefined` 表示沿用当前凭据；传 `null` 表示本次
 * 不带 Bearer（只用 HttpOnly cookie 重新协商）；传字符串表示指定候选凭据。
 */
function buildHeaders(init: RequestInit, bearer?: string | null): Headers {
  const headers = new Headers(init.headers);
  if (!headers.has('X-JeikCode-Client')) headers.set('X-JeikCode-Client', 'webui');
  if (bearer === undefined) {
    if (!headers.has('Authorization')) {
      const token = currentWebuiToken();
      if (token) headers.set('Authorization', 'Bearer ' + token);
    }
  } else {
    headers.delete('Authorization');
    if (bearer) headers.set('Authorization', 'Bearer ' + bearer);
  }
  return headers;
}

async function sendWithToken(
  input: RequestInfo | URL,
  init: RequestInit,
  bearer: string | null,
): Promise<Response> {
  return fetch(input, { ...init, credentials: 'include', headers: buildHeaders(init, bearer) });
}

let recoveringUnauthorized = false;

/**
 * 401 自愈：绝不刷新页面（旧 token 仍会被存储回放，刷新只会无限循环）。
 *
 * 顺序：丢弃服务端刚拒绝的 token → 尝试其他已保存的候选 token（另一个
 * 标签页可能已经轮换成功）→ 最后用 HttpOnly cookie 重试一次。全部失败才
 * 锁存“认证失效”，交由 UI 让用户粘贴新访问链接/token。
 */
async function recoverUnauthorized(
  input: RequestInfo | URL,
  init: RequestInit,
  rejectedToken: string,
  unauthorized: Response,
): Promise<Response> {
  if (authExpired || recoveringUnauthorized) return unauthorized;

  recoveringUnauthorized = true;
  try {
    if (rejectedToken) forgetWebuiToken(rejectedToken);

    for (const candidate of tokenCandidates(rejectedToken)) {
      const retry = await sendWithToken(input, init, candidate);
      if (retry.ok) {
        confirmWebuiToken(candidate);
        return retry;
      }
      if (retry.status !== 401) return retry;
      forgetWebuiToken(candidate);
    }

    // Cookie 是 `/?token=` 交接后由服务端写入的 HttpOnly 凭据。旧 Bearer 会
    // 在中间件里优先于 Cookie，把它遮蔽掉；去掉 Bearer 才能让新 Cookie 生效。
    // 原本就没带 Bearer 说明 Cookie 已经被试过，无需重复请求。
    if (!rejectedToken) {
      setAuthExpired(true);
      return unauthorized;
    }
    const cookieRetry = await sendWithToken(input, init, null);
    if (cookieRetry.ok) {
      clearAuthExpired();
      return cookieRetry;
    }
    if (cookieRetry.status !== 401) return cookieRetry;

    setAuthExpired(true);
    return unauthorized;
  } finally {
    recoveringUnauthorized = false;
  }
}

/**
 * 校验并采纳用户粘贴的访问链接 / token（401 遮罩使用）。
 * 校验请求本身必须先于持久化，避免把错误 token 写进共享存储污染其他标签页。
 */
export async function applyWebuiToken(raw: string): Promise<void> {
  const token = parseTokenInput(raw);
  if (!token) throw new Error('empty token');
  const resp = await fetch('/config', {
    credentials: 'include',
    headers: {
      'X-JeikCode-Client': 'webui',
      Authorization: 'Bearer ' + token,
    },
  });
  if (resp.status === 401 || resp.status === 403) throw new Error('invalid token');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  // 清掉所有被拒绝的旧值，再写入已验证的新 token（两端存储都覆盖）。
  try {
    sessionStorage.removeItem(WEBUI_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(WEBUI_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  persistWebuiToken(token);
  if (storedWebuiToken() === token) {
    stripTokenFromAddressBar();
  } else {
    // 存储被禁用（隐私模式 / 受限 WebView）：把已验证的 token 留在地址栏，
    // 否则随后的整页重载会丢失凭据并再次 401。
    setTokenInAddressBar(token);
  }
  clearAuthExpired();
}

/** 接受裸 token、完整 `/?token=…` 链接或 `?token=…` 查询串。 */
function parseTokenInput(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return (url.searchParams.get('token') ?? '').trim();
  } catch {
    /* not an absolute URL */
  }
  if (text.includes('token=')) {
    try {
      return (new URLSearchParams(text.replace(/^\?/, '')).get('token') ?? '').trim();
    } catch {
      /* not a query string */
    }
  }
  return text;
}

/**
 * Same-origin fetch that always includes cookies (HttpOnly token handoff)
 * and merges auth headers. Remote LAN clients need both cookie + Bearer.
 */
async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = buildHeaders(init);
  const sentToken = tokenFromAuthorization(headers.get('Authorization'));
  try {
    const resp = await fetch(input, { ...init, credentials: 'include', headers });
    if (resp.status === 401) {
      console.warn('[API] 401 Unauthorized: 访问凭据无效或已失效', input);
      return await recoverUnauthorized(input, init, sentToken, resp);
    }
    if (resp.ok && !isPublicRequest(input)) {
      if (sentToken) {
        // 用受保护端点的成功响应确认该凭据，再写入存储/剥离地址栏 token。
        confirmWebuiToken(sentToken);
      } else {
        // 无 Bearer 也能成功（Cookie 生效或已切到免 token 模式）：解除认证门。
        clearAuthExpired();
      }
    }
    return resp;
  } catch (err: any) {
    const isNetworkErr = err instanceof TypeError && (
      err.message.includes('fetch') ||
      err.message.includes('network') ||
      err.message.includes('Failed')
    );
    if (isNetworkErr) {
      throw new Error('连接宿主机后端失败 (Failed to fetch)，请检查网络连接或宿主机服务状态');
    }
    throw err;
  }
}

/** Current session token (URL bootstrap or session/localStorage). */
export function getToken(): string {
  return currentWebuiToken();
}

/** Parse a JSON API body. Empty 401/500 bodies used to surface as
 *  `Failed to execute 'json' on 'Response': Unexpected end of JSON input`. */
async function readApiJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  if (!resp.ok) {
    let detail = '';
    if (text) {
      try {
        const err = JSON.parse(text) as { error?: unknown };
        if (typeof err.error === 'string' && err.error.trim()) detail = err.error;
      } catch {
        /* ignore */
      }
    }
    if (!detail) {
      detail =
        resp.status === 401
          ? 'Unauthorized: missing or invalid access token'
          : `HTTP ${resp.status}`;
    }
    throw new Error(detail);
  }
  if (!text) throw new Error('empty response');
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'invalid JSON');
  }
}

export interface HealthInfo {
  status: string;
  version: string;
  service: string;
  binary_hash?: string;
  instance_id?: string;
}

/** Public GET /health — version matches the running binary (CARGO_PKG_VERSION). */
export async function getHealth(): Promise<HealthInfo> {
  const resp = await apiFetch('/health');
  if (!resp.ok) throw new Error(`health failed: ${resp.status}`);
  return resp.json() as Promise<HealthInfo>;
}

/**
 * 断点续传游标：live 与 replay 帧都带同一个 session 级 `seq`；`replay`
 * 只说明送达路径（live append / replay replace）。
 *
 * 前端把收到的最大 seq 存起来，重连时当作 `after_seq` 带回去，服务器只补之后的
 * 帧 —— 收到的每一帧都是新的，不再需要靠内容猜「这条画过没有」。
 */
export interface SeqTaggedFrame {
  seq?: number;
  /** True only for frames read from the turn replay snapshot; live frames use
   *  the same seq but append instead of replacing. Absent on old daemons, where
   *  seq presence is the fallback replay marker. */
  replay?: boolean;
}

export type SSEEvent =
  | { type: 'runtime_info'; provider: string; model: string }
  | { type: 'session_assigned'; session_id: string }
  /** `after_seq = -1`（新会话）的握手帧：不补发，只告知起始游标。 */
  | { type: 'session_start'; session_id?: string; cursor: number; caps?: string[] }
  | { type: 'user'; content: string; display_text?: string; internal?: boolean; editable?: boolean; session_id?: string; created_at?: number; message_id?: string; order?: number; turn_ordinal?: number; client_input_id?: string; images?: ImageData[] }
  | { type: 'user_identified'; message_id: string; turn_ordinal?: number }
  | { type: 'text'; content: string; message_id?: string; part_id?: string; part_seq?: number; part_rev?: number }
  | { type: 'reasoning'; content: string; message_id?: string; part_id?: string; part_seq?: number; part_rev?: number }
  | { type: 'tool_start'; id: string; name: string; arguments: unknown; message_id?: string }
  | { type: 'tool_output'; id?: string; chunk: string }
  | { type: 'tool_progress'; id: string; progress: string }
  /** 工具执行已返回（权威结果帧仍按发射顺序排队）。客户端用它先把行状态落定，
   *  避免同一并发批次里耗时长工具未完成时，短工具陪着一起“运行中”。 */
  | { type: 'tool_finished'; id: string; success: boolean }
  | { type: 'tool_result'; id: string; name: string; output: string; success: boolean; duration_ms: number }
  | { type: 'tokens'; prompt: number; completion: number; total: number; cached?: number; cached_estimated?: boolean; reasoning?: number }
  | { type: 'permission_request'; session_id: string; approval_id: string; tool_name: string; reason: string; call_id: string; arguments: unknown }
  | UserInputRequestEvent
  | { type: 'user_input_resolved'; request_id: number }
  | { type: 'steered'; count: number; inputs: { text: string; images?: ImageData[]; message_id?: string }[]; client_input_ids?: Array<string | null>; timestamps?: Array<number | null>; anchor_message_id?: string }
  | { type: 'done'; tokens: unknown; tool_calls: unknown; session_id: string; stop_reason?: string; message?: string; message_id?: string; operation_id?: string }
  | { type: 'stopped'; session_id?: string; operation_id?: string }
  | { type: 'error'; message: string; message_id?: string; operation_id?: string }
  | { type: 'warning'; message: string; message_id?: string; /** Live path: committed compaction's post-context tokens. */ tokens_after?: number }
  /** Committed compaction: update the context meter immediately (no usage follows). */
  | { type: 'context_compacted'; session_id?: string; tokens: number }
  /** 已落盘的显示通知（如手动压缩边界）：带显示日志的权威 `id`/`display_seq`，
   *  各端按同一序号摆成独立 system 行。 */
  | { type: 'display_notice'; session_id?: string; id: string; display_seq: number; text: string; created_at?: number }
  | { type: 'persistence_warning'; message: string }
  | { type: 'rate_limited'; reset_at_display: string; reset_label: string; secs_until_reset: number | null; auto_resuming: boolean; server_message?: string | null; message_id?: string }
  // Artifact events: the daemon's ArtifactDetector strips fenced code blocks from
  // TextDelta and emits them as separate artifact_start / artifact_content / artifact_end
  // events (see ArtifactDetector in crates/jeikcode-daemon/src/lib.rs). Without handling
  // these, code block content is silently lost in the WebUI while the TUI sees it fine.
  | { type: 'artifact_start'; id: string; artifact_type: string; language?: string | null; title?: string | null; fence_len?: number | null }
  | { type: 'artifact_content'; id: string; content: string }
  | { type: 'artifact_end'; id: string }
  | { type: 'session_renamed'; session_id: string; name: string }
  | { type: 'session_status'; session_id?: string; status: string }
  | { type: 'command_output'; text: string }
  /** 本会话待发卡片队列的权威全量快照（`push_to_session_queue` 等带内来源）。 */
  | { type: 'queue_updated'; session_id: string; items: QueuedMessageApiItem[] }
  | SessionMutationEvent;

export interface ModelInfo {
  /** Selection id / 模型别名（配置键）。 */
  provider: string;
  /** Wire model id（上游模型 ID）。 */
  model: string;
  /** 所属提供商账号 id。 */
  account?: string;
  provider_type: string;
  is_default: boolean;
  /** Whether this model accepts reasoning_effort control. */
  effort_applicable: boolean;
  /** Current effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null (model default). */
  reasoning_effort: string | null;
  /** Available reasoning effort levels for this model. */
  reasoning_levels?: string[];
  context_window?: number;
  /** Configured thinking budget in tokens, if any. */
  thinking_budget?: number | null;
  /** Configured max output tokens, if any. */
  max_tokens?: number | null;
}

export async function getModels(): Promise<ModelInfo[]> {
  const r = await apiFetch('/models', { headers: authHeaders() });
  if (!r.ok) throw new Error(`list models failed: ${r.status}`);
  const body: unknown = await r.json();
  if (!Array.isArray(body)) throw new Error('list models returned an invalid payload');
  return body as ModelInfo[];
}

/** A base64-encoded image attachment (no data-URL prefix). */
export interface ImageData {
  media_type: string;
  data: string;
}

export interface SessionMutationEvent {
  type: 'session_mutation';
  session_id: string;
  revision: number;
  action: 'patch' | 'delete' | 'truncate';
  message_id?: string;
  source_index?: number;
  text?: string;
  images?: ImageData[];
  delete_turn?: boolean;
  truncate_after?: boolean;
  target_index?: number;
  target_message_id?: string;
  ts?: number;
}

export interface StreamChatBody {
  message: string;
  session_id?: string;
  request_id?: string;
  working_dir?: string;
  provider?: string;
  images?: ImageData[];
  approval_mode?: ApprovalMode;
}

export interface PromptAck {
  status: 'admitted' | string;
  operation_id: string;
  session_id: string;
}

/**
 * Stateless prompt submission (OpenCode Single Event Bus architecture).
 * Submits the prompt to the backend engine and returns immediately with 202 Accepted.
 * The client does NOT read the stream from the response; all events (user, reasoning,
 * text, tools, steer, terminal) are broadcast exclusively over the single event bus
 * (`watchChatSession`).
 */
export async function postChatPrompt(
  body: StreamChatBody,
  signal?: AbortSignal,
): Promise<PromptAck> {
  const resp = await apiFetch('/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    let errText = '';
    let errCode = '';
    try {
      const errJson = await resp.json();
      errText = errJson.error || errJson.message || '';
      errCode = errJson.code || '';
    } catch {}
    const err = new Error(errText || `HTTP ${resp.status} ${resp.statusText}`);
    (err as any).status = resp.status;
    (err as any).code = errCode;
    throw err;
  }

  try {
    return (await resp.json()) as PromptAck;
  } catch {
    return { status: 'admitted', operation_id: '', session_id: body.session_id || '' };
  }
}

export interface StopChatResult {
  success: boolean;
  /**
   * 权威释放结论：目标槽位已确认空闲，调用方可以紧接着投递一个新回合。
   * 旧版 daemon 缺该字段时按 true 兼容处理（保持旧行为）。
   */
  released: boolean;
  /** Daemon 原文。`was not running` 表示这条别名本来就没占槽。 */
  message?: string;
}

/**
 * Stop the running turn of a session (or of a raw request alias).
 *
 * `released` is the daemon's verdict — not a guess: the compat registry slot is
 * free and no native-runtime turn still occupies the session. "Send now" only
 * delivers after `released`, which is what removes the 409-then-requeue flash.
 */
export async function stopChat(requestId: string): Promise<StopChatResult> {
  const resp = await apiFetch('/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ session_id: requestId }),
  });
  if (!resp.ok) throw new Error(`stop chat failed: ${resp.status}`);
  try {
    const body = (await resp.json()) as Partial<StopChatResult>;
    return {
      success: body.success !== false,
      released: body.released !== false,
      message: typeof body.message === 'string' ? body.message : '',
    };
  } catch {
    // Older daemons answered without a body field set; keep the optimistic
    // contract so a stale binary cannot wedge send-now into never delivering.
    return { success: true, released: true };
  }
}

/** Durably reserve the steer intent + steering queue card on the server. */
export async function admitChatSteer(
  sessionId: string,
  message: string,
  images?: ImageData[],
  clientInputId?: string,
  createdAt?: number,
  approvalMode?: ApprovalMode,
): Promise<void> {
  await postChatSteerEndpoint(
    '/chat/steer/admit',
    sessionId,
    message,
    images,
    clientInputId,
    createdAt,
    approvalMode,
  );
}

/** Fold a queued follow-up into the running `/chat` turn at the next step. */
export async function postChatSteer(
  sessionId: string,
  message: string,
  images?: ImageData[],
  clientInputId?: string,
  createdAt?: number,
  approvalMode?: ApprovalMode,
): Promise<void> {
  await postChatSteerEndpoint(
    '/chat/steer',
    sessionId,
    message,
    images,
    clientInputId,
    createdAt,
    approvalMode,
  );
}

async function postChatSteerEndpoint(
  path: '/chat/steer' | '/chat/steer/admit',
  sessionId: string,
  message: string,
  images?: ImageData[],
  clientInputId?: string,
  createdAt?: number,
  approvalMode?: ApprovalMode,
): Promise<void> {
  const resp = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      message,
      ...(images && images.length ? { images } : {}),
      ...(clientInputId ? { client_input_id: clientInputId } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(approvalMode ? { approval_mode: approvalMode } : {}),
    }),
  });
  let body: { accepted?: boolean; error?: string } = {};
  try {
    body = await resp.json();
  } catch {
    body = {};
  }
  if (!resp.ok || body.accepted === false) {
    throw new Error(body.error || `steer failed: ${resp.status}`);
  }
}

/** Cancel a pending steer that was queued into the running turn before it gets folded. */
export async function cancelChatSteer(
  sessionId: string,
  message?: string,
  clientInputId?: string,
): Promise<void> {
  const resp = await apiFetch('/chat/steer/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      ...(message ? { message } : {}),
      ...(clientInputId ? { client_input_id: clientInputId } : {}),
    }),
  }).catch(() => null);
  if (!resp || !resp.ok) {
    // Fallback: also try DELETE /chat/steer
    await apiFetch('/chat/steer', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        session_id: sessionId,
        ...(message ? { message } : {}),
      }),
    }).catch(() => {});
  }
}

export async function revealInFileExplorer(path: string, cwd?: string): Promise<{ success: boolean; is_dir?: boolean }> {
  const resp = await apiFetch('/fs/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, cwd }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function openFileWithOs(path: string, cwd?: string): Promise<{ success: boolean }> {
  const resp = await apiFetch('/fs/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, cwd }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export function getFsRawUrl(filePath: string): string {
  return `/fs/raw?path=${encodeURIComponent(filePath)}`;
}

export interface QueuedMessageApiItem {
  id: number | string;
  /** Stable client correlation id: the atomic queue-claim key and the eventual
   *  prompt id. Minted when the card is created; absent on legacy cards. */
  client_input_id?: string;
  text: string;
  images?: ImageData[];
  kind: 'queue' | 'steering' | 'steer';
  approval_mode?: ApprovalMode;
  /** 卡片创建时间（epoch ms）：跨端 / 刷新恢复保留原始排队时间。 */
  createdAt?: number;
  /** 立即发送已画上气泡、但当时投递被退回：drain 必须照发。 */
  forceSend?: boolean;
}

export interface ChatQueueSnapshot {
  revision: number;
  items: QueuedMessageApiItem[];
}

export async function getChatQueue(sessionId: string): Promise<ChatQueueSnapshot> {
  const resp = await apiFetch(`/chat/queue?session_id=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) return { revision: 0, items: [] };
  try {
    const data = await resp.json();
    // New daemons return `{ revision, items }`; accept the legacy bare array too.
    if (Array.isArray(data)) return { revision: 0, items: data };
    return {
      revision: typeof data?.revision === 'number' ? data.revision : 0,
      items: Array.isArray(data?.items) ? data.items : [],
    };
  } catch {
    return { revision: 0, items: [] };
  }
}

export async function saveChatQueue(
  sessionId: string,
  items: QueuedMessageApiItem[],
  baseRevision?: number,
): Promise<{ revision: number; conflict: boolean; items?: QueuedMessageApiItem[] }> {
  const resp = await apiFetch('/chat/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      items,
      ...(typeof baseRevision === 'number' ? { base_revision: baseRevision } : {}),
    }),
  }).catch(() => null);
  if (!resp) return { revision: baseRevision ?? 0, conflict: false };
  const data = await resp.json().catch(() => null);
  if (resp.status === 409) {
    return {
      revision: typeof data?.revision === 'number' ? data.revision : 0,
      conflict: true,
      items: Array.isArray(data?.items) ? data.items : [],
    };
  }
  return {
    revision: typeof data?.revision === 'number' ? data.revision : (baseRevision ?? 0),
    conflict: false,
  };
}

/** Atomically take ownership of one queued card. Exactly one tab can win. */
export async function claimChatQueue(
  sessionId: string,
  clientInputId: string,
  item?: QueuedMessageApiItem,
): Promise<boolean> {
  const resp = await apiFetch('/chat/queue/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      client_input_id: clientInputId,
      ...(item ? { item } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json().catch(() => ({}))) as { claimed?: boolean };
  return data.claimed === true;
}

/** Return a claim when delivery failed; the card is restored for a later drain. */
export async function releaseChatQueue(
  sessionId: string,
  clientInputId: string,
  item?: QueuedMessageApiItem,
): Promise<void> {
  await apiFetch('/chat/queue/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      client_input_id: clientInputId,
      ...(item ? { item } : {}),
    }),
  }).catch(() => {});
}

export interface RuntimeSessionInfo {
  session_id: string;
  working_dir: string;
  activity: string;
  last_terminal?: string | null;
  terminal_seq?: number;
}

/** Live runners across sessions, including the latest terminal label. */
export async function getRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
  const resp = await apiFetch('/runtime/sessions', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`runtime sessions failed: ${resp.status}`);
  const body: unknown = await resp.json();
  if (!Array.isArray(body)) throw new Error('runtime sessions returned an invalid payload');
  return body as RuntimeSessionInfo[];
}

/** Session id and event version from a clicked OS toast, or null when unavailable. */
export async function pollNotifyFocus(): Promise<{ version: number; sessionId: string | null } | null> {
  const resp = await apiFetch('/notify-focus', { headers: authHeaders() });
  if (!resp.ok) return null;
  const body = (await resp.json()) as { version?: number; session_id?: string | null };
  const id = body.session_id?.trim();
  return {
    version: body.version ?? 0,
    sessionId: id || null,
  };
}

/** Detached OS toast. The daemon spawns the notifier and returns immediately. */
export async function postSystemNotify(input: {
  title: string;
  body: string;
  tag?: string;
  sessionId?: string;
  approvalId?: string;
}): Promise<void> {
  const resp = await apiFetch('/system-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      tag: input.tag,
      session_id: input.sessionId,
      approval_id: input.approvalId,
    }),
  });
  if (!resp.ok && resp.status !== 400) {
    throw new Error(`system notify failed: ${resp.status}`);
  }
}

export async function getActiveChatSessions(): Promise<string[]> {
  const resp = await apiFetch('/chat/active', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`active chats failed: ${resp.status}`);
  const body: unknown = await resp.json();
  if (!Array.isArray(body) || !body.every((entry) => typeof entry === 'string')) {
    throw new Error('active chats returned an invalid payload');
  }
  return body;
}

/**
 * 会话级服务端权威运行态（`chat` / `live` / `loop` / `goal` 并集）。
 *
 * `/chat/active` 只是一个 id 列表，且口径只覆盖「有回合在执行」；`/loop` 在两次
 * 唤醒之间没有执行中的回合，却仍有控制器在续轮。WebUI 的 busy 只认这份快照，
 * 不再用本地启发式猜「是不是已经停下来了」。
 */
export async function getChatRuntime(sessionId: string): Promise<ServerChatRuntime> {
  const resp = await apiFetch(
    `/chat/runtime?session_id=${encodeURIComponent(sessionId)}`,
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new Error(`chat runtime failed: ${resp.status}`);
  return (await resp.json()) as ServerChatRuntime;
}

/** Unanswered interactive prompts for an active turn (Build / AcceptEdits / Plan).
 *  Restores approval / user-input cards after refresh or session switch when the
 *  original SSE edge was missed. Auto (bypass) never parks here. */
export interface ChatPendingInteractive {
  active: boolean;
  permission: {
    type: 'permission_request';
    session_id: string;
    approval_id: string;
    tool_name: string;
    reason: string;
    call_id: string;
    arguments: unknown;
  } | null;
  user_input: UserInputRequestEvent | null;
}

export async function getChatPending(sessionId: string): Promise<ChatPendingInteractive> {
  const resp = await apiFetch(
    `/chat/pending?session_id=${encodeURIComponent(sessionId)}`,
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new Error(`chat pending failed: ${resp.status}`);
  const body = (await resp.json()) as {
    success?: boolean;
    active?: boolean;
    permission?: ChatPendingInteractive['permission'];
    user_input?: UserInputRequestEvent | null;
  };
  return {
    active: body.active === true,
    permission: body.permission ?? null,
    user_input: body.user_input ?? null,
  };
}

/**
 * 获取或分配当前浏览器标签页（Window Tab）专属的唯一客户端 ID。
 * 存放在 sessionStorage 中，单标签页刷新保持不变（防止同端重复注册），多标签页/多设备各具唯一性（避免多端待机互踢）。
 */
export function getTabClientId(): string {
  if (typeof window === 'undefined' || !window.sessionStorage) return 'default_client';
  try {
    let id = window.sessionStorage.getItem('jeikcode_tab_client_id');
    if (!id) {
      id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `client_${Date.now().toString(36)}`;
      window.sessionStorage.setItem('jeikcode_tab_client_id', id);
    }
    return id;
  } catch {
    return 'default_client';
  }
}

/**
 * Reattach to a turn started by another client (OpenAI API / another tab).
 * Same SSE `ChatEvent` frames as `POST /chat`.
 */
export async function watchChatSession(
  sessionId: string,
  /** 回放帧带 `seq` 游标，调用方据此推进断点续传游标（见 `SeqTaggedFrame`）。 */
  onEvent: (event: SSEEvent & SeqTaggedFrame) => void,
  signal?: AbortSignal,
  opts?: { standbyOnly?: boolean; afterSeq?: number; clientId?: string },
): Promise<void> {
  const params = new URLSearchParams({ session_id: sessionId });
  if (opts?.standbyOnly) params.set('standby', 'true');
  if (opts?.afterSeq !== undefined) params.set('after_seq', String(opts.afterSeq));
  const effectiveClientId = opts?.clientId || getTabClientId();
  if (effectiveClientId) params.set('client_id', effectiveClientId);
  const streamAbort = new AbortController();
  const onParentAbort = () => streamAbort.abort();
  if (signal) {
    if (signal.aborted) streamAbort.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let lastActivity = Date.now();
  // 活性看门狗：后端每 15 秒发送一次 ping 心跳。
  // 若超过 25 秒没有任何网络数据（含 15s keepalive ping），判定连接底层假死，主动 abort 中断当前 reader。
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > 25000) {
      streamAbort.abort();
    }
  }, 4000);

  try {
    const resp = await apiFetch(
      `/chat/watch?${params.toString()}`,
      { headers: authHeaders(), signal: streamAbort.signal },
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminalSeen = false;

    const emit = (event: SSEEvent) => {
      if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') {
        terminalSeen = true;
      }
      onEvent(event);
    };

    while (true) {
      const { done, value } = await reader.read();
      lastActivity = Date.now();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice('data:'.length).trim();
        if (!jsonStr) continue;
        try {
          emit(JSON.parse(jsonStr) as SSEEvent);
        } catch {
          /* keep-alive */
        }
      }
    }

    if (buffer.trim()) {
      const dataLine = buffer.split('\n').find((line) => line.startsWith('data:'));
      if (dataLine) {
        const jsonStr = dataLine.slice('data:'.length).trim();
        if (jsonStr) {
          try {
            emit(JSON.parse(jsonStr) as SSEEvent);
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (signal?.aborted) {
      const error = new Error('chat watch aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (!terminalSeen) {
      onEvent({
        type: 'done',
        tokens: 0,
        tool_calls: 0,
        session_id: sessionId,
        stop_reason: 'watch_closed',
      } as SSEEvent);
    }
  } finally {
    clearInterval(watchdog);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Explicitly cancel a detached /chat turn (local abort + POST /chat/stop).
 *
 * Use only when the user intends to stop the turn (e.g. Stop button on a
 * detached_active session). Do NOT call this on sidebar session switches —
 * switching views must leave the daemon turn running so the user can return
 * and reattach via /chat/active (same as a page refresh).
 */
export async function cancelDetachedChat(
  requestId: string,
  controller: AbortController,
): Promise<void> {
  controller.abort();
  await stopChat(requestId);
}

export async function streamChat(
  body: StreamChatBody,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
  onAccepted?: () => void,
): Promise<void> {
  const resp = await apiFetch('/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const reader = resp.body!.getReader();
  onAccepted?.();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalSeen = false;

  const emit = (event: SSEEvent) => {
    if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') {
      terminalSeen = true;
    }
    onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Split on double-newline (SSE event boundaries)
    const parts = buffer.split('\n\n');
    // The last part may be an incomplete event — keep it in buffer
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      // Find the data: line within the event block
      const dataLine = part
        .split('\n')
        .find((line) => line.startsWith('data:'));
      if (!dataLine) continue;

      const jsonStr = dataLine.slice('data:'.length).trim();
      if (!jsonStr) continue;

      try {
        const parsed = JSON.parse(jsonStr) as SSEEvent;
        emit(parsed);
      } catch {
        // Ignore malformed lines (keep-alive comments, etc.)
      }
    }
  }

  // Process any trailing content in the buffer
  if (buffer.trim()) {
    const dataLine = buffer
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine) {
      const jsonStr = dataLine.slice('data:'.length).trim();
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr) as SSEEvent;
          emit(parsed);
        } catch {
          // Ignore
        }
      }
    }
  }

  if (signal?.aborted) {
    const error = new Error('chat stream aborted');
    error.name = 'AbortError';
    throw error;
  }
  if (!terminalSeen) {
    throw new Error('chat stream ended before an authoritative terminal event');
  }
}

/**
 * Hard upper bound for a decision POST. Approval delivery is a tiny request, but
 * the card latches its buttons while it is in flight: a half-open connection
 * (long-idle NAT/relay drop, suspended desktop webview) that never answers would
 * otherwise leave the card permanently unclickable with no error.
 */
const PERMISSION_DECISION_TIMEOUT_MS = 15_000;

function permissionDecisionSignal(): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined') return undefined;
  const AbortSignalAny = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AbortSignalAny.timeout === 'function') {
    return AbortSignalAny.timeout(PERMISSION_DECISION_TIMEOUT_MS);
  }
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), PERMISSION_DECISION_TIMEOUT_MS);
  return controller.signal;
}

export async function respondPermission(
  sessionId: string,
  approvalId: string,
  decision: 'allow' | 'deny' | 'always_allow' | 'allow_persist',
  toolName?: string,
): Promise<PermissionDecisionResult> {
  const resp = await apiFetch('/chat/permission', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ session_id: sessionId, approval_id: approvalId, decision, tool_name: toolName }),
    signal: permissionDecisionSignal(),
  });
  // The daemon answers every decision with a JSON verdict (success / expired /
  // already_resolved). A non-JSON body is a transport-level surprise, not a
  // verdict — surface it as a retryable failure instead of guessing.
  const text = await resp.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (body && typeof body === 'object') {
    const verdict = body as {
      success?: unknown;
      already_resolved?: unknown;
      applied?: unknown;
      expired?: unknown;
      error?: unknown;
    };
    return {
      success: verdict.success === true,
      already_resolved: verdict.already_resolved === true,
      applied: typeof verdict.applied === 'string' ? verdict.applied : undefined,
      expired: verdict.expired === true,
      error: typeof verdict.error === 'string' ? verdict.error : undefined,
    };
  }
  throw new Error(
    resp.ok ? 'permission decision returned an invalid payload' : `permission decision failed: HTTP ${resp.status}`,
  );
}

// --- Session types ---

export interface SessionMeta {
  id: string;
  name: string;
  working_dir: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  file_size?: number;
  approval_mode?: ApprovalMode | null;
  preferred_model?: string | null;
  /** Per-session reasoning effort; absent means "inherit the provider default". */
  reasoning_effort?: string | null;
  thinking_budget?: number | null;
}

export interface SessionMetaWithProject extends SessionMeta {
  project_hash: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  display: string;
}

export interface ToolResultInfo {
  call_id: string;
  success: boolean;
  summary: string;
  line_count: number;
}

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Stable per-message identity from the pipeline (`Message.id`). Absent on
   *  older daemons; UI then falls back to positional identity. */
  id?: string;
  /** Durable client-input correlation id (`SessionInput.id`) for user rows.
   *  Lets a reloaded bubble match its queued steer card by identity. */
  client_input_id?: string;
  /** v4 display order cursor (`seq`). Additive; absent for snapshot-only rows. */
  seq?: number;
  /** Server-rendered user-facing text (already unwrapped / stripped). */
  display_text?: string;
  /** Server-authored visibility flag: hide this row from the transcript. */
  internal?: boolean;
  /** Server-authored mutation permission; false = archive/presentation row. */
  editable?: boolean;
  /** Persisted kernel turn id (display/session detail). Absent on older daemons
   *  and backfilled rows; the timer falls back to steer-root penetration then. */
  turn_id?: number;
  /** Model reasoning/thinking for assistant messages (persisted losslessly;
   *  previously dropped at the API boundary so a reload lost all earlier
   *  thinking). Rendered as a collapsible thinking block before the text. */
  reasoning?: string;
  synthetic?: boolean;
  internal_origin?: string;
  internalOrigin?: string;
  tool_calls?: ToolCallInfo[];
  tool_result?: ToolResultInfo;
  artifacts?: unknown;
  images?: ImageData[];
  /** Epoch ms this message was authored (PR #562 send-time labels). Absent
   *  on older daemons and on live/snapshot turns (the webui injects Date.now()
   *  there). Optional + `?` so historical payloads without it still parse. */
  created_at?: number;
  /** Whole user-turn wall-clock duration in ms (user send → final answer).
   *  Survives refresh / session switch. Not a single LLM round. */
  elapsed_ms?: number;
}

export interface SessionTurnOutline {
  /** Stable ordinal among real user questions. Absent on older daemons. */
  ordinal?: number;
  /** Absolute index in the full transcript (not the returned window). */
  index: number;
  /** Stable persisted message id; primary dedupe identity when available. */
  id?: string;
  /** Short rail label. Full question text comes from the loaded messages. */
  label: string;
  /** Admitted but not yet folded/persisted (durable input log). */
  pending?: boolean;
  /** Local live row not yet confirmed by the authoritative server outline. */
  provisional?: boolean;
  /** Admission sequence from the input log. */
  seq?: number;
}

export interface SessionDetail {
  id: string;
  name: string;
  working_dir: string;
  created_at: number;
  updated_at: number;
  /** Total messages on disk (not the returned window size). */
  message_count: number;
  /** 会话权威版本（内核 `cache_epoch`）。每次显式变更（编辑/删除/回溯）自增。
   *  客户端用它给缓存写入设闸门：旧快照永远不能覆盖新快照。旧 daemon 缺省为 0。 */
  revision?: number;
  /** Identity-first paging cursor (oldest display seq in this window). */
  cursor?: { oldest_seq?: number; total: number };
  /** 本 daemon 的能力集（`id` / `revision` / `seq` / `session_mutated`）。
   *  声明了 `id` 就关闭客户端所有文本兜底。旧 daemon 缺省为空。 */
  /** 旧 daemon 的兼容声明字段已废弃；新契约始终身份优先。 */
  /** Index of `messages[0]` in the full transcript. Absent on older daemons.
   *  When `pinned_user_index` is set, `messages[0]` is that pinned question and
   *  `offset` is the index of `messages[1]`. */
  offset?: number;
  /** Absolute index of the user question pinned in front of a mid-turn tail page.
   *  The rows between it and `offset` are not in this page. */
  pinned_user_index?: number;
  /** All user questions for the right-rail outline. Independent of the message window. */
  turns?: SessionTurnOutline[];
  /** Daemon capability negotiation (`id`, `revision`, `terminal_operation_id`, ...). */
  caps?: string[];
  /** Highest durable input-log sequence. Pass back as `after_seq` to fetch only
   *  newly admitted prompt/steer rows. */
  input_cursor?: number;
  messages: SessionMessage[];
  /** Per-session model selection. Absent on older sessions. */
  preferred_model?: string | null;
  /** Per-session approval mode ("build" | "accept_edits" | "bypass" | "plan"). Absent on older sessions. */
  approval_mode?: ApprovalMode | null;
  /** Per-session reasoning effort; absent means "inherit the provider default". */
  reasoning_effort?: string | null;
  thinking_budget?: number | null;
  /** Last-request occupancy for the footer (persists across restart). Not turn-cumulative billing. */
  token_usage?: SessionTokenUsage | null;
  /** `manual` / `scheduled` / `protocol`. Protocol sessions are observed in Auto. */
  origin?: 'manual' | 'scheduled' | 'protocol';
  /** Authoritative active todo list from backend transcript. */
  todos?: Array<{ id?: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** Monotonic server revision of `todos`; lower revisions must never overwrite higher ones. */
  todos_revision?: number;
}

/** Token footer snapshot from session turn_stats (GET /projects/:hash/sessions/:id).
 *  `prompt` is last-request occupancy (`used_tokens`), not summed model_usage. */
export interface SessionTokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cached: number;
  cached_estimated?: boolean;
  ctx_window?: number;
}

// NOTE: `/sessions` caps at the 50 most-recent sessions ACROSS ALL projects.
// For a project's full history use listProjectSessions; for finding a session
// anywhere use searchSessions. This capped list is only for cross-project
// lookups where 50 is enough (e.g. URL-restore of a recent session).
export async function listSessions(): Promise<SessionMetaWithProject[]> {
  const resp = await apiFetch('/sessions', { headers: authHeaders() });
  return resp.json();
}

// A single project's sessions, UNCAPPED (reads one bucket directly). This is
// what the sidebar shows — the global `/sessions` cap would otherwise starve a
// project of its own history when many other projects have newer sessions.
// The endpoint returns bare SessionMeta; every row is in `projectHash`, so we
// stamp it back on for the client's project-scoped dedup/filter.
export async function listProjectSessions(projectHash: string): Promise<SessionMetaWithProject[]> {
  const resp = await apiFetch(`/projects/${encodeURIComponent(projectHash)}/sessions`, {
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`list project sessions failed: ${resp.status}`);
  const list: SessionMeta[] = await resp.json();
  return list.map((m) => ({ ...m, project_hash: projectHash }));
}

/**
 * 广播「该会话已被用户打开」：其它标签页 / 浏览器收到 `session_seen` 后
 * 熄灭该会话的绿色「刚完成」徽标。徽标由全局 `activity` 点亮，
 * 熄灭必须走同一条全局总线，否则只清当前实例会留下幽灵勾。
 */
export async function postSessionSeen(sessionId: string): Promise<void> {
  const resp = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/seen`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`mark session seen failed: ${resp.status}`);
}

// Cross-project session search by name, UNCAPPED. Backs the search modal so it
// can find a session in ANY project (the sidebar list itself is per-project).
export async function searchSessions(q: string): Promise<SessionMetaWithProject[]> {
  const resp = await apiFetch(`/sessions/search?q=${encodeURIComponent(q)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`search sessions failed: ${resp.status}`);
  return resp.json();
}

// Resolve a (short) session id to its full record across all projects, UNCAPPED.
// URL-restore only has a short id from the address bar; the capped `/sessions`
// can't locate an older session. Returns null when nothing matches.
export async function resolveSession(id: string): Promise<SessionMetaWithProject | null> {
  const resp = await apiFetch(`/sessions/resolve/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`resolve session failed: ${resp.status}`);
  return resp.json();
}

export interface CreateSessionResponse {
  id: string;
  name: string;
  working_dir: string;
  project_hash: string;
  created_at: number;
}

export async function createSession(
  workingDir?: string,
  title?: string,
): Promise<CreateSessionResponse> {
  const body: Record<string, string> = {};
  if (workingDir) body.working_dir = workingDir;
  if (title) body.title = title;
  const resp = await apiFetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`create session failed: ${resp.status}`);
  return resp.json();
}

export async function renameSession(
  projectHash: string,
  sessionId: string,
  name: string,
): Promise<void> {
  const resp = await apiFetch(
    `/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}/rename`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    },
  );
  if (!resp.ok) throw new Error(`rename failed: ${resp.status}`);
}

export class DeleteSessionError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DeleteSessionError';
    this.code = code;
  }
}

export async function deleteSession(
  projectHash: string,
  sessionId: string,
): Promise<void> {
  const resp = await apiFetch(
    `/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (!resp.ok) {
    const payload: unknown = await resp.json().catch(() => undefined);
    const errorValue =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error: unknown }).error
        : undefined;
    const codeValue =
      payload && typeof payload === 'object' && 'code' in payload
        ? (payload as { code: unknown }).code
        : undefined;
    const detail =
      typeof payload === 'string'
        ? payload
        : typeof errorValue === 'string'
          ? errorValue
          : undefined;
    const code = typeof codeValue === 'string' ? codeValue : undefined;
    throw new DeleteSessionError(detail || `delete failed: ${resp.status}`, code);
  }
}

export async function patchSessionMessage(
  projectHash: string,
  sessionId: string,
  index: number,
  params: {
    text: string;
    images?: ImageData[];
    expected_text?: string;
    expected_message_id?: string;
    expected_role?: 'user' | 'assistant';
    /** Edit = rewrite: remove every message after this row from context/disk. */
    truncate_after?: boolean;
  },
): Promise<{ success: boolean; revision: number; source_index: number; message_count?: number; truncated?: boolean }> {
  const resp = await apiFetch(
    `/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}/messages/${index}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(params),
    },
  );
  return readApiJson(resp);
}

export async function deleteSessionMessage(
  projectHash: string,
  sessionId: string,
  index: number,
  params?: {
    delete_turn?: boolean;
    expected_text?: string;
    expected_message_id?: string;
    expected_role?: 'user' | 'assistant';
  },
): Promise<{ success: boolean; revision: number; source_index?: number; notFound?: boolean }> {
  const q = new URLSearchParams();
  if (params?.delete_turn) q.set('delete_turn', 'true');
  if (params?.expected_text) q.set('expected_text', params.expected_text);
  if (params?.expected_message_id) q.set('expected_message_id', params.expected_message_id);
  if (params?.expected_role) q.set('expected_role', params.expected_role);
  const qs = q.toString() ? `?${q.toString()}` : '';
  const resp = await apiFetch(
    `/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}/messages/${index}${qs}`,
    {
      method: 'DELETE',
      headers: authHeaders(),
    },
  );
  return readApiJson(resp);
}

export async function truncateSession(
  projectHash: string,
  sessionId: string,
  params: {
    target_index: number;
    target_message_id?: string;
    expected_text?: string;
    expected_role?: 'user' | 'assistant';
    inclusive?: boolean;
  },
): Promise<{ success: boolean; revision: number; target_index?: number; notFound?: boolean }> {
  const resp = await apiFetch(
    `/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}/truncate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(params),
    },
  );
  return readApiJson(resp);
}

// --- Config types ---

export interface AccountInfo {
  id: string;
  type: string;
  base_url?: string;
  has_api_key: boolean;
  skip_tls_verify?: boolean;
}

export interface ProviderInfo {
  name: string;
  type: string;
  model: string;
  account?: string;
  base_url?: string;
  has_api_key: boolean;
  requires_login?: boolean;
  is_default: boolean;
  context_window?: number;
  max_tokens?: number;
  thinking_enabled?: boolean | null;
  thinking_budget?: number | null;
  thinking_type?: string | null;
  thinking_keep?: string | null;
  reasoning_history?: string | null;
  reasoning_effort?: string | null;
  skip_tls_verify?: boolean;
  supports_vision?: boolean | null;
  reasoning_model?: boolean | null;
}

export interface ConfigInfo {
  path: string;
  default_provider: string;
  default_workdir?: string;
  providers: ProviderInfo[];
  accounts?: AccountInfo[];
  /** "en", "vi-VN", or "zh-CN". Missing on older servers. */
  language?: string;
  /** Whether to display the GitHub repository logo in the UI. Defaults to true. */
  github_logo?: boolean;
  /** Agent 执行完会改动分支/引用/远端的 git 命令后，是否自动向所有会话广播 Git 刷新。默认 true。 */
  auto_git_sync?: boolean;
}

export async function getConfig(): Promise<ConfigInfo> {
  const resp = await apiFetch('/config', { headers: authHeaders() });
  return readApiJson<ConfigInfo>(resp);
}

/** Persist the global language switch. */
export async function postLanguage(lang: Lang): Promise<void> {
  const language =
    lang === 'zh'
      ? 'zh-CN'
      : lang === 'zh-TW'
        ? 'zh-TW'
        : lang === 'vi'
          ? 'vi-VN'
          : lang;
  const resp = await apiFetch('/config/language', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ language }),
  });
  if (!resp.ok) throw new Error(`set language failed: ${resp.status}`);
}

/** Persist the "auto git sync" switch (POST /config/auto-git-sync). */
export async function postAutoGitSync(enabled: boolean): Promise<void> {
  const resp = await apiFetch('/config/auto-git-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (!resp.ok) throw new Error(`set auto git sync failed: ${resp.status}`);
}

export interface RemoteAccessStatus {
  host: string;
  port: number;
  no_token: boolean;
  active: boolean;
  token?: string | null;
  url?: string | null;
  urls?: string[] | null;
  /** `allowed` or `prompt` when the listener is open to other devices. */
  firewall?: string | null;
  /** Saved port that differs from the socket listening now. */
  next_port?: number | null;
  /** Saved host that differs from the socket listening now. */
  next_host?: string | null;
  /** `desktop` | `systemd` | `procd` | `launchd` | `windows-logon` | `foreground` */
  launch_mode?: string;
}

export async function getRemoteAccess(): Promise<RemoteAccessStatus> {
  const resp = await apiFetch('/api/remote-access', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`remote access status failed: ${resp.status}`);
  return resp.json();
}

export async function postRemoteAccess(
  body: {
    host: string;
    port: number;
    token?: string;
    no_token?: boolean;
    stop?: boolean;
    /** Save port and token for the next 0.0.0.0 launch. Same port updates the token now. */
    apply_launch?: boolean;
    /** Immediately restart the daemon process to apply new host/port. */
    restart?: boolean;
  },
  signal?: AbortSignal,
): Promise<RemoteAccessStatus> {
  const resp = await apiFetch('/api/remote-access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const payload = await resp.json();
      detail = payload?.error || '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `remote access failed: ${resp.status}`);
  }
  return resp.json();
}

export interface ZombieProcessInfo {
  pid: number;
  name: string;
  path?: string | null;
  reason: string;
}

export interface LegacyStatusResponse {
  has_legacy_files: boolean;
  legacy_files: string[];
  has_dirty_path: boolean;
  zombie_count: number;
  zombies: ZombieProcessInfo[];
  needs_migration: boolean;
}

export async function getLegacyStatus(): Promise<LegacyStatusResponse> {
  const resp = await apiFetch('/api/system/legacy-status', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`failed to get legacy status: ${resp.status}`);
  return resp.json();
}

export async function postMigrateLegacy(killZombies: boolean): Promise<{
  success: boolean;
  cleaned_files_count: number;
  killed_zombies_count: number;
}> {
  const resp = await apiFetch('/api/system/migrate-legacy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kill_zombies: killZombies }),
  });
  if (!resp.ok) throw new Error(`failed to migrate legacy: ${resp.status}`);
  return resp.json();
}

export interface DesktopSettings {
  close_action: 'ask' | 'tray' | 'quit';
}

export async function getDesktopSettings(): Promise<DesktopSettings> {
  const resp = await apiFetch('/api/system/desktop-settings', { headers: authHeaders() });
  if (!resp.ok) return { close_action: 'ask' };
  return resp.json();
}

export async function postDesktopSettings(settings: DesktopSettings): Promise<void> {
  const resp = await apiFetch('/api/system/desktop-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(settings),
  });
  if (!resp.ok) throw new Error('failed to save desktop settings');
}

/** Trigger a hot-reload of config from disk (POST /config/reload). */
export async function postConfigReload(): Promise<void> {
  const resp = await apiFetch('/config/reload', {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`config reload failed: ${resp.status}`);
}

// --- Projects types ---

export interface ProjectInfo {
  hash: string;
  name: string;
  working_dir: string;
  description?: string;
  session_count: number;
  created_at: number;
  last_updated: number;
}

export async function getProjects(): Promise<ProjectInfo[]> {
  const resp = await apiFetch('/projects', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`list projects failed: ${resp.status}`);
  const body: unknown = await resp.json();
  if (!Array.isArray(body)) throw new Error('list projects returned an invalid payload');
  return body as ProjectInfo[];
}

export interface SidebarProjects {
  hidden: string[];
  pinned: ProjectInfo[];
}

let sidebarBroadcastChannel: BroadcastChannel | null = null;
function getSidebarBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!sidebarBroadcastChannel) {
    try {
      sidebarBroadcastChannel = new BroadcastChannel('jeikcode_sidebar_projects');
    } catch {
      /* BroadcastChannel unavailable in some sandbox contexts */
    }
  }
  return sidebarBroadcastChannel;
}

/** Same-browser tabs plus a refetch hint. Other machines follow `/events` `sidebar_projects`. */
export function broadcastSidebarProjects(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('jeikcode:sidebar_projects'));
  try {
    getSidebarBroadcastChannel()?.postMessage({ type: 'refresh' });
  } catch {
    /* ignore */
  }
}

export async function getSidebarProjects(): Promise<SidebarProjects> {
  const resp = await apiFetch('/projects/sidebar', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`sidebar projects failed: ${resp.status}`);
  const body = await resp.json() as Partial<SidebarProjects>;
  return parseSidebarProjects(body);
}

function parseSidebarProjects(body: Partial<SidebarProjects> | null | undefined): SidebarProjects {
  return {
    hidden: Array.isArray(body?.hidden) ? body.hidden.filter((h) => typeof h === 'string') : [],
    pinned: Array.isArray(body?.pinned) ? body.pinned : [],
  };
}

export async function hideSidebarProject(hash: string): Promise<SidebarProjects> {
  const resp = await apiFetch('/projects/sidebar/hide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ hash }),
  });
  if (!resp.ok) throw new Error(`hide project failed: ${resp.status}`);
  const body = await resp.json() as Partial<SidebarProjects>;
  broadcastSidebarProjects();
  return parseSidebarProjects(body);
}

/** Pin a directory into the shared sidebar and clear any hide flag. */
export async function showSidebarProject(path: string): Promise<ProjectInfo> {
  const resp = await apiFetch('/projects/sidebar/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: stripExtendedPathPrefix(path) }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(e.error || `show project failed: ${resp.status}`);
  }
  const body = await resp.json() as ProjectInfo;
  if (body.working_dir) body.working_dir = stripExtendedPathPrefix(body.working_dir);
  broadcastSidebarProjects();
  return body;
}

/** Put a hidden project back. Used when a session in it is still running. */
export async function revealSidebarProject(hash: string): Promise<SidebarProjects> {
  const resp = await apiFetch('/projects/sidebar/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ hash }),
  });
  if (!resp.ok) throw new Error(`reveal project failed: ${resp.status}`);
  const body = await resp.json() as Partial<SidebarProjects>;
  broadcastSidebarProjects();
  return parseSidebarProjects(body);
}

// --- Current project state ---

export interface ProjectState {
  working_dir: string;
  previous_dir?: string;
  recent_dirs?: string[];
  name?: string;
  // Physical session-bucket hash for `working_dir`. The sidebar scopes its
  // list by this (not the mutable `working_dir` string) so sessions whose
  // stored working_dir was restamped can't leak across projects.
  project_hash?: string;
}

export async function getProject(): Promise<ProjectState> {
  const resp = await apiFetch('/project', { headers: authHeaders() });
  return resp.json();
}


// --- MCP server status ---

export interface McpServerInfo {
  name: string;
  status: string;
  tool_count?: number;
  error?: string;
}

export interface McpStatusInfo {
  servers: McpServerInfo[];
  /** Whether the current project is trusted for MCP. Absent on older daemons — treat as untrusted. */
  trusted?: boolean;
  /** Names of MCP servers withheld because the project is untrusted. Absent on older daemons — treat as empty. */
  blocked?: string[];
}

export async function getMcpStatus(workingDir?: string): Promise<McpStatusInfo> {
  const q = workingDir ? `?working_dir=${encodeURIComponent(workingDir)}` : '';
  const resp = await apiFetch(`/mcp/status${q}`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`mcp status failed: ${resp.status}`);
  return resp.json();
}

/** Re-read mcp.json and remount MCP servers (POST /mcp/reload). */
export async function postMcpReload(): Promise<{ ok: boolean; status?: string; runtime_reloaded?: boolean }> {
  const resp = await apiFetch('/mcp/reload', {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`mcp reload failed: ${resp.status}`);
  return resp.json();
}

/** Trust the current project for MCP servers, then rebuild the MCP registry. */
export async function postLiveMcpTrust(): Promise<{ ok: boolean; error?: string }> {
  const resp = await apiFetch('/live/mcp/trust', {
    method: 'POST',
    headers: authHeaders(),
  });
  return resp.json();
}

// --- User-invocable skills (for the input "+" attach menu) ---

export interface SkillInfo {
  name: string;
  description: string;
}

export async function getSkills(): Promise<SkillInfo[]> {
  const resp = await apiFetch('/skills', { headers: authHeaders() });
  return resp.json();
}

// --- User-invoked slash commands (custom `commands/*.md`) ---

export type CommandArgsRequirement = 'required' | 'optional' | 'none';

export interface CommandInfo {
  name: string;
  description: string;
  args_requirement: CommandArgsRequirement;
}

export async function getCommands(): Promise<CommandInfo[]> {
  const resp = await apiFetch('/commands', { headers: authHeaders() });
  return resp.json();
}

// --- Unified capabilities (MCP servers + skills, GLOBAL + PROJECT scopes) ---

export type CapKind = 'mcp' | 'skill';
export type CapScope = 'global' | 'project';

export interface CapabilityItem {
  kind: CapKind;
  /** Stable identity for the toggle endpoint (MCP server name / skill registry name). */
  id: string;
  /** Human-facing name (skills show the bare name). */
  name: string;
  description: string;
  global_disabled: boolean;
  project_disabled: boolean;
  /** The state the runtime applies (disabled at EITHER scope). */
  effective_disabled: boolean;
  /** MCP only: connection status (connected / connecting / error / disconnected). */
  status?: string;
  /** MCP only: tool count when connected. */
  tool_count?: number;
  /** MCP only: connection error. */
  error?: string;
  /** Skills only: the folder that owns the skill (for "reveal in explorer"). */
  dir?: string;
  /** Skills only: the project-scope state file IS the global one (home project).
   *  Both toggles would edit one file, so the project toggle is hidden. */
  project_scope_shared?: boolean;
}

/** GET /capabilities — one unified list for the sidebar's MCP + skills menus. */
/**
 * Unified MCP + skills inventory. `workingDir` asks about the project of the
 * session being VIEWED — after a restart the daemon's own project may still be
 * its launch directory, and without this the panel would show (and toggle)
 * another project's servers and skills.
 */
export async function getCapabilities(workingDir?: string): Promise<CapabilityItem[]> {
  const q = workingDir ? `?working_dir=${encodeURIComponent(workingDir)}` : '';
  const resp = await apiFetch(`/capabilities${q}`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`capabilities failed: ${resp.status}`);
  const body = await resp.json() as { items?: CapabilityItem[] };
  return body.items ?? [];
}

/**
 * POST /capabilities/toggle — persist a capability's disabled flag at one scope and
 * rebuild capabilities so the change lands in the very next prompt.
 */
export async function toggleCapability(
  kind: CapKind,
  id: string,
  scope: CapScope,
  disabled: boolean,
  workingDir?: string,
): Promise<{ ok: boolean; error?: string; runtime_reloaded?: boolean }> {
  const resp = await apiFetch('/capabilities/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kind, id, scope, disabled, working_dir: workingDir }),
  });
  return resp.json();
}

// --- Remote access (蒲公英 / Oray PGY) status ---

export interface PgyInfo {
  installed: boolean;
  ipv4: string | null;
}

export interface TunnelStatus {
  bind_host: string;
  port: number;
  /** server bound to a non-loopback address (reachable by other devices) */
  reachable: boolean;
  pgy: PgyInfo;
  /** ready-to-use remote URL (蒲公英 ip + token); null when not usable */
  remote_url: string | null;
  /** SVG string of the QR code for remote_url; null when not usable */
  qr_svg: string | null;
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  const resp = await apiFetch('/tunnel/status', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`tunnel status failed: ${resp.status}`);
  return resp.json();
}

// --- Provider CRUD ---

export interface CreateProviderBody {
  name: string;
  type: string; // openai | anthropic | responses | ollama | claude
  model: string;
  account?: string;
  api_key?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number | null;
  supports_vision?: boolean;
  reasoning_model?: boolean;
  reasoning_effort?: string | null;
  reasoning_history?: string | null;
  thinking_enabled?: boolean | null;
  thinking_budget?: number | null;
  set_default?: boolean;
}

export async function createProvider(body: CreateProviderBody): Promise<unknown> {
  const r = await apiFetch('/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error || `HTTP ${r.status}`); }
  return r.json();
}

export async function deleteProvider(name: string): Promise<void> {
  const r = await apiFetch(`/providers/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error || `HTTP ${r.status}`); }
}

export interface UpdateProviderBody {
  name?: string;
  type?: string;
  model?: string;
  account?: string;
  api_key?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number | null;
  clear_max_tokens?: boolean;
  supports_vision?: boolean | null;
  reasoning_model?: boolean | null;
  reasoning_effort?: string | null;
  reasoning_history?: string | null;
  thinking_enabled?: boolean | null;
  thinking_budget?: number | null;
}

/** PATCH /providers/:name —— 部分更新已有 provider（可改名：body.name 传新名）。 */
export async function updateProvider(name: string, body: UpdateProviderBody): Promise<unknown> {
  const r = await apiFetch(`/providers/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error || `HTTP ${r.status}`); }
  return r.json();
}

export interface CreateOrUpdateAccountBody {
  id?: string;
  type?: string;
  base_url?: string;
  api_key?: string;
  clear_api_key?: boolean;
  clear_base_url?: boolean;
  skip_tls_verify?: boolean;
}

export async function createOrUpdateAccount(
  id: string,
  body: CreateOrUpdateAccountBody,
): Promise<AccountInfo> {
  const r = await apiFetch(`/provider-accounts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as any).error || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function deleteAccount(id: string): Promise<void> {
  const r = await apiFetch(`/provider-accounts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as any).error || `HTTP ${r.status}`);
  }
}

/** POST /providers/upstream-models — 拉取 openai/anthropic/responses/gemini/ollama 上游模型列表。 */
export async function fetchUpstreamModels(body: {
  protocol?: string;
  base_url?: string;
  api_key?: string;
  /** 已有提供商账号：表单密钥为空时由服务端继承账号密钥。 */
  account?: string;
  provider_name?: string;
  skip_tls_verify?: boolean;
}): Promise<string[]> {
  const r = await apiFetch('/providers/upstream-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as any).error || `HTTP ${r.status}`);
  }
  const data = await r.json();
  return Array.isArray(data?.models) ? data.models.filter((id: unknown) => typeof id === 'string') : [];
}

export interface UpstreamProbeResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

/** POST /providers/upstream-models {probe:true} — 用当前账号的 key/url 按协议发一次极小「Hi」探活。 */
export async function probeUpstreamModel(body: {
  protocol?: string;
  base_url?: string;
  api_key?: string;
  /** 已有提供商账号：服务端继承其 key / base_url / 协议。 */
  account?: string;
  provider_name?: string;
  skip_tls_verify?: boolean;
  model: string;
}): Promise<UpstreamProbeResult> {
  const r = await apiFetch('/providers/upstream-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ...body, probe: true }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error((data as any)?.error || `HTTP ${r.status}`);
  }
  return {
    ok: data?.ok === true,
    latency_ms: typeof data?.latency_ms === 'number' ? data.latency_ms : 0,
    error: typeof data?.error === 'string' ? data.error : undefined,
  };
}

/** POST /providers/:name/default —— 设为默认 provider。 */
export async function setDefaultProvider(name: string): Promise<unknown> {
  const r = await apiFetch(`/providers/${encodeURIComponent(name)}/default`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error || `HTTP ${r.status}`); }
  return r.json();
}

// --- Filesystem browsing ---

export interface FsShortcut {
  id: string;
  name: string;
  path: string;
}

export interface FsListResult {
  path: string;
  dirs: string[];
  /** Regular files in the directory (webui file picker). */
  files?: string[];
  /** Available storage drives/partitions (e.g. C:, D: on Windows, / on Unix). */
  drives?: string[];
  /** System quick access shortcuts (Home, Desktop, Downloads, Documents). */
  shortcuts?: FsShortcut[];
}

export async function listDir(path: string): Promise<FsListResult> {
  const clean = stripExtendedPathPrefix(path);
  const resp = await apiFetch('/fs/list?path=' + encodeURIComponent(clean), {
    headers: authHeaders(),
  });
  const body = await resp.json() as FsListResult;
  if (body && typeof body.path === 'string') {
    body.path = stripExtendedPathPrefix(body.path);
  }
  return body;
}

// --- Create directory ---

export async function mkdir(path: string): Promise<{ path: string }> {
  const r = await apiFetch('/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: stripExtendedPathPrefix(path) }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error || `HTTP ${r.status}`); }
  const body = await r.json() as { path: string };
  if (body && typeof body.path === 'string') body.path = stripExtendedPathPrefix(body.path);
  return body;
}

export async function pickNativeDirectory(): Promise<{ path: string | null; canceled: boolean }> {
  const r = await apiFetch('/fs/pick_dir', {
    method: 'POST',
    headers: { ...authHeaders() },
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as any).error || `HTTP ${r.status}`);
  }
  return r.json();
}

export type UploadProgress = {
  current: number;
  total: number;
  fileName: string;
  percent: number;
};

/** POST /fs/upload — save non-image attachments under `{cwd}/.jeikcode_store`.
 *  Called only when the user sends, so removed pending files never hit disk.
 *  Large files are streamed one-by-one with upload progress. */
export async function uploadSessionFiles(
  workingDir: string,
  files: File[],
  onProgress?: (info: UploadProgress) => void,
): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    onProgress?.({
      current: i + 1,
      total: files.length,
      fileName: file.name || 'upload.bin',
      percent: 0,
    });
    const path = await uploadOneFile(workingDir, file, (loaded, total) => {
      onProgress?.({
        current: i + 1,
        total: files.length,
        fileName: file.name || 'upload.bin',
        percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      });
    });
    paths.push(path);
  }
  return paths;
}

function uploadOneFile(
  workingDir: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/fs/upload');
    xhr.withCredentials = true;
    for (const [key, value] of Object.entries(authHeaders())) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      let errorText = `upload failed: ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText) as { paths?: unknown; error?: string };
        if (xhr.status >= 200 && xhr.status < 300) {
          if (Array.isArray(body.paths) && typeof body.paths[0] === 'string') {
            resolve(body.paths[0]);
            return;
          }
          reject(new Error('upload returned an invalid payload'));
          return;
        }
        if (body.error) errorText = body.error;
      } catch {
        /* keep status text */
      }
      reject(new Error(errorText));
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.onabort = () => reject(new Error('upload aborted'));
    const body = new FormData();
    body.append('working_dir', workingDir);
    body.append('files', file, file.name || 'upload.bin');
    xhr.send(body);
  });
}

// --- Change working directory ---

export interface CdResponse {
  success: boolean;
  message: string;
  current_dir: string;
  project_hash: string;
}

/** Switch the daemon's current working directory.
 *  Always updates the live project state (so a webui switch survives refresh);
 *  `setDefault` also persists it as the configured default (across restarts). */
export async function changeDir(path: string, setDefault = false): Promise<CdResponse> {
  const resp = await apiFetch('/cd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ path, set_default: setDefault }),
  });
  return resp.json();
}

/** Delete a historical project and its sessions catalog. */
export async function deleteProject(hash: string): Promise<void> {
  const resp = await apiFetch(`/projects/${hash}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!resp.ok) {
    throw new Error(`deleteProject failed: ${resp.status}`);
  }
}


// --- Session detail (messages endpoint exists) ---

/** File size and mtime only. No message bodies. */
export async function getSessionFreshness(
  projectHash: string,
  sessionId: string,
): Promise<{ bytes: number; mtime_ms: number; running: boolean }> {
  const resp = await apiFetch(
    `/projects/${projectHash}/sessions/${sessionId}/freshness`,
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new Error(`session freshness failed: ${resp.status}`);
  return resp.json();
}

const SESSION_DETAIL_CACHE_MAX = 8;
const sessionDetailEtagCache = new Map<
  string,
  { etag: string; detail: SessionDetail }
>();

export async function getSession(
  projectHash: string,
  sessionId: string,
  opts?: {
    tail?: number;
    offset?: number;
    limit?: number;
    afterSeq?: number;
    /** Older-history cursor (exclusive): rows with `seq < beforeSeq`. */
    beforeSeq?: number;
    /** Jump to the page containing this record id. */
    around?: string;
    /** Outline-only: skip the transcript (server returns turns + metadata). */
    turnsOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<SessionDetail> {
  const q = new URLSearchParams();
  if (opts?.tail != null) q.set('tail', String(opts.tail));
  if (opts?.offset != null) q.set('offset', String(opts.offset));
  if (opts?.limit != null) q.set('limit', String(opts.limit));
  if (opts?.afterSeq != null) q.set('after_seq', String(opts.afterSeq));
  if (opts?.beforeSeq != null) q.set('before_seq', String(opts.beforeSeq));
  if (opts?.around != null) q.set('around', opts.around);
  if (opts?.turnsOnly) q.set('turns_only', 'true');
  const qs = q.toString();
  const path = `/projects/${projectHash}/sessions/${sessionId}`;
  const requestPath = qs ? `${path}?${qs}` : path;
  // First paint (`tail`), live deltas (`after_seq`) and the outline-only read must
  // be FRESH. Reusing a cached detail body via 304 can pin an older outline/window
  // when the display log changed without bumping the client-visible ETag — the
  // "only 2-3 turns until I switch sessions" bug. Paged history
  // (`offset`/`limit`) may still use the conditional cache.
  const cacheable = opts?.tail == null && opts?.afterSeq == null && opts?.turnsOnly !== true;
  const cached = cacheable ? sessionDetailEtagCache.get(requestPath) : undefined;
  const headers = authHeaders();
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const resp = await apiFetch(requestPath, {
    headers,
    signal: opts?.signal,
  });
  // Conditional hit: reuse the exact previous body without re-parsing or
  // transferring it. The cache is tiny and keyed by the full window query.
  if (resp.status === 304 && cached) {
    sessionDetailEtagCache.delete(requestPath);
    sessionDetailEtagCache.set(requestPath, cached);
    return cached.detail;
  }
  if (!resp.ok) {
    throw new Error(`getSession failed with status ${resp.status}`);
  }
  const detail = (await resp.json()) as SessionDetail;
  const etag = resp.headers.get('ETag');
  if (cacheable && etag) {
    sessionDetailEtagCache.delete(requestPath);
    sessionDetailEtagCache.set(requestPath, { etag, detail });
    while (sessionDetailEtagCache.size > SESSION_DETAIL_CACHE_MAX) {
      const oldest = sessionDetailEtagCache.keys().next().value;
      if (!oldest) break;
      sessionDetailEtagCache.delete(oldest);
    }
  } else {
    sessionDetailEtagCache.delete(requestPath);
  }
  return detail;
}

// --- Live session (multi-tab real-time sync) ---

/** Approval mode: 'build' = interactive approval, 'plan' = read-only exploration,
 *  'bypass' = Auto (auto-approve everything). Mirrors the daemon `ApprovalMode`
 *  while preserving the established wire value. */
export type ApprovalMode = 'build' | 'plan' | 'bypass' | 'accept_edits';

export interface ApprovalModeResponse {
  ok: boolean;
  mode: ApprovalMode;
  /** 全局模式开关当前是否开启（所有会话统一跟随 `mode`）。 */
  global: boolean;
}

/**
 * 跨实例增量事件（`GET /events`）。
 *
 * 与「失效信号→整表重拉」不同，每条都自带 payload：客户端按 id 就地 upsert/
 * 删除自己的缓存；`sync` 只是冷启动对齐信号（客户端仍只做一次既有拉取）。
 */
export type GlobalWireEvent =
  | { type: 'sync' }
  | { type: 'session_upsert'; session: SessionMetaWithProject }
  | { type: 'session_deleted'; session_id: string; project_hash: string }
  /** 某会话已被某个实例打开/查看：其它实例熄灭该会话的「刚完成」徽标。 */
  | { type: 'session_seen'; session_id: string }
  /**
   * 会话转录被显式变更（编辑 / 删除单条 / 回溯 / 压缩）：
   * 全局失效信号，只带 revision。客户端据此作废本地缓存（低版本）并对
   * 正在显示的会话做一次定向重取；**绝不**用增量帧套用 mutation。
   */
  | { type: 'session_mutated'; session_id: string; revision: number }
  /** 一条展示记录已落盘（压缩边界/警告）；客户端做一次定向磁盘对账。 */
  | { type: 'display_appended'; session_id: string }
  | { type: 'activity'; session_id: string; running: boolean; terminal?: 'completed' | 'stopped' | 'failed'; status?: string }
  /**
   * 执行态的权威快照（带 revision/owner/phase）。新客户端只按它更新
   * Compacting/Busy；`activity` 仅作旧客户端兼容与侧栏活动列表。
   */
  | {
      type: 'runtime_activity';
      session_id: string;
      revision: number;
      running: boolean;
      phase?: string | null;
      phase_started_at?: number | null;
      owner?: string | null;
    }
  /** 该会话弹出了审批/提问卡：对该会话做一次定向 pending 拉取（单会话小请求）。 */
  | { type: 'review_asked'; session_id: string }
  /** 待交互已解决：按 id 就地从所有实例的通知卡片中移除。 */
  | { type: 'review_resolved'; session_id: string; approval_id?: string; request_id?: number }
  /**
   * 该会话的待发卡片队列（排队 / 转向中 / 转向已排队）发生变化：
   * 创建、点转向、取消、被内核消费都算。只带会话 id，客户端对该会话做一次
   * 定向 `/chat/queue` 拉取并就地更新本地卡片，不做整表重拉。
   */
  | { type: 'queue_updated'; session_id: string }
  /**
   * 中途转向已被内核 fold（即将在下一轮请求生效）：携带权威输入。
   * 活跃视图由 `/chat/watch` 的 `steered` 帧落笔（带光标与归位锚点）；
   * 本事件用于**其它会话/其它客户端**把这条提问提前写进该会话的本地画布缓存，
   * 保证切过去或冷启动时用户气泡已经在里面。
   */
  | {
      type: 'steer_folded';
      session_id: string;
      /** 只带文本/身份：图片本体可能是一整张 base64，绝不进全局通道。 */
      inputs: Array<{ text: string; message_id?: string; has_images?: boolean }>;
      client_input_ids?: Array<string | null>;
      timestamps?: Array<number | null>;
      anchor_message_id?: string;
    }
  /**
   * 模型配置变更（会话聊天模型 / 提供商 / 模型 id / 思考强度 / 思考预算）。
   * `effort` 存在时两字段都是快照（`null` = 继承模型默认）；
   * `deferred` = 本轮仍在跑，参数已落盘、下一轮生效。
   */
  | {
      type: 'model_config';
      session_id?: string | null;
      provider?: string;
      effort?: { reasoning_effort: string | null; thinking_budget: number | null };
      deferred?: boolean;
    }
  /** 全局配置热重载信号（如 CLI 执行 jeikcode ghimg 或后台配置更新）。 */
  | { type: 'config_reloaded' }
  /** 侧栏项目可见性（隐藏/钉住/运行中自动恢复），跨实例就地对齐。 */
  | { type: 'sidebar_projects'; hidden: string[]; pinned?: ProjectInfo[] }
  /** Git 仓库变更（discard / stage / commit / pull / fetch 等），跨实例全量广播 */
  | { type: 'git_updated'; cwd: string; fetch?: boolean }
  /** 终端会话变更（创建 / 关闭 / 清空），跨实例项目级全量广播 */
  | { type: 'terminal_updated'; cwd: string }
  /** 会话审批模式变更（跨实例全局广播） */
  | { type: 'session_mode'; session_id?: string | null; mode: ApprovalMode }
  /** 全局模式开关变更：开启后所有会话统一跟随 `mode`。 */
  | { type: 'mode_global'; enabled: boolean; mode: ApprovalMode };

const GLOBAL_EVENTS_IDLE_TIMEOUT_MS = 30_000;

/** 跨实例增量流。断线由调用方重连；本函数只在 abort/流关闭时返回。 */
export async function streamGlobalEvents(
  onEvent: (event: GlobalWireEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const streamAbort = new AbortController();
  const onParentAbort = () => streamAbort.abort();
  if (signal) {
    if (signal.aborted) streamAbort.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let lastActivity = Date.now();
  // 活性看门狗：后端 /events 每 15 秒发送一次 ping 心跳。
  // 若超过 30 秒没有任何网络数据（含 15s keepalive ping），判定底层 TCP 连接已处于半开假死状态，
  // 主动 abort 中断当前 reader，促使外部自动重连并触发 Sync 增量校准。
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > GLOBAL_EVENTS_IDLE_TIMEOUT_MS) {
      streamAbort.abort();
    }
  }, 4000);
  if (typeof (watchdog as any).unref === 'function') {
    (watchdog as any).unref();
  }

  // 视口唤醒自愈：设备从休眠/熄屏恢复时立即检测是否超时，不等下一次 4s interval tick
  const checkWakeup = () => {
    if (typeof document !== 'undefined' && !document.hidden) {
      if (Date.now() - lastActivity > GLOBAL_EVENTS_IDLE_TIMEOUT_MS) {
        streamAbort.abort();
      }
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', checkWakeup);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', checkWakeup);
    window.addEventListener('online', checkWakeup);
  }

  let readerCancelHandler: (() => void) | null = null;
  try {
    const resp = await apiFetch('/events', { headers: authHeaders(), signal: streamAbort.signal });
    if (!resp.ok) {
      const error = new Error(`HTTP ${resp.status} ${resp.statusText}`);
      // 凭据被拒时重连只会反复 401；交给全局认证遮罩引导用户换 token。
      if (resp.status === 401) error.name = 'AuthExpiredError';
      throw error;
    }
    const reader = resp.body!.getReader();
    readerCancelHandler = () => {
      try {
        reader.cancel().catch(() => {});
      } catch {}
    };
    streamAbort.signal.addEventListener('abort', readerCancelHandler, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      lastActivity = Date.now();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice('data:'.length).trim();
        if (!jsonStr) continue;
        try {
          onEvent(JSON.parse(jsonStr) as GlobalWireEvent);
        } catch {
          /* keep-alive / malformed frame */
        }
      }
    }
    if (signal?.aborted) {
      const error = new Error('global events aborted');
      error.name = 'AbortError';
      throw error;
    }
  } finally {
    clearInterval(watchdog);
    if (signal) signal.removeEventListener('abort', onParentAbort);
    if (readerCancelHandler) {
      streamAbort.signal.removeEventListener('abort', readerCancelHandler);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', checkWakeup);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', checkWakeup);
      window.removeEventListener('online', checkWakeup);
    }
  }
}

/** Sync-mode model switch: notify the daemon immediately when the dropdown
 *  changes (not just on send), so the TUI header and other tabs follow. */
export async function postLiveProvider(
  provider: string,
  sessionId?: string | null,
): Promise<{ ok: boolean; activeTurn: boolean; error?: string }> {
  const resp = await apiFetch('/live/provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider, ...(sessionId ? { session_id: sessionId } : {}) }),
  });
  if (!resp.ok) throw new Error(`switch live provider failed: ${resp.status}`);
  // A business rejection (e.g. active_turn) is NOT thrown — the caller reverts its
  // optimistic selection and shows a notice. Only transport failures throw.
  const body = await resp.json() as { ok?: boolean; active_turn?: boolean; error?: string };
  return { ok: body.ok === true, activeTurn: body.active_turn === true, error: body.error };
}

// --- /command endpoint ---

export type CommandResult =
  | { kind: 'undo'; undone: number }
  | { kind: 'remember'; scope: 'global' | 'project' }
  | { kind: 'forget'; removed: string[] }
  | { kind: 'memory'; global: string[]; project: string[] }
  | { kind: 'context'; used_tokens: number; total_messages: number; ctx_window: number; utilization: number; ctx_name: string }
  | { kind: 'compact'; applied: boolean; removed_messages: number; before_tokens: number; after_tokens: number }
  | { kind: 'whoami'; logged_in: boolean; username?: string; name?: string; email?: string }
  | { kind: 'status'; logged_in: boolean; username?: string; provider: string; model: string; working_dir: string; config_path: string; text: string }
  | { kind: 'config'; path: string; provider: string }
  | { kind: 'diff'; stat: string }
  | { kind: 'cost'; total_tokens: number; turn_count: number }
  | { kind: 'todo'; items: { status: string; content: string }[] }
  | { kind: 'error'; message: string };

export async function postCommand(body: {
  command: string;
  arg?: string;
  session_id?: string;
  working_dir?: string;
  project_hash?: string;
  provider?: string;
}): Promise<CommandResult> {
  const resp = await apiFetch('/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`command failed: ${resp.status}`);
  return resp.json();
}

let modeBroadcastChannel: BroadcastChannel | null = null;
function getModeBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!modeBroadcastChannel) {
    try {
      modeBroadcastChannel = new BroadcastChannel('jeikcode_approval_mode');
    } catch {
      // BroadcastChannel unavailable in some sandbox contexts
    }
  }
  return modeBroadcastChannel;
}

export function broadcastApprovalMode(
  mode: ApprovalMode,
  sessionId?: string | null,
  global?: boolean,
): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('jeikcode:approval_mode_changed', {
        detail: { mode, session_id: sessionId ?? undefined, global },
      }),
    );
    try {
      getModeBroadcastChannel()?.postMessage({
        type: 'mode',
        mode,
        session_id: sessionId ?? undefined,
        global,
      });
    } catch {
      // ignore
    }
  }
}

/** Switch the approval mode (build / accept_edits / bypass / plan). Runtime
 *  session state — the next turn's PermissionDecider follows it; broadcast to
 *  other tabs. `global` toggles the cross-session override switch. */
export async function postLiveMode(
  mode: ApprovalMode,
  sessionId?: string | null,
  global?: boolean,
): Promise<ApprovalMode> {
  const resp = await apiFetch('/approval_mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      mode,
      session_id: sessionId || undefined,
      global: global === undefined ? undefined : global,
    }),
  });
  if (!resp.ok) throw new Error(`switch mode failed: ${resp.status}`);
  const body = (await resp.json()) as ApprovalModeResponse;
  if (!body.ok) throw new Error('live runtime rejected the mode switch');
  broadcastApprovalMode(body.mode, sessionId, body.global);
  return body.mode;
}

export async function getApprovalMode(sessionId?: string | null): Promise<ApprovalMode> {
  return (await getApprovalModeState(sessionId)).mode;
}

/** Mode + global-switch state in one round-trip (cold start / focus / switch). */
export async function getApprovalModeState(
  sessionId?: string | null,
): Promise<{ mode: ApprovalMode; global: boolean }> {
  const url = sessionId
    ? `/approval_mode?session_id=${encodeURIComponent(sessionId)}`
    : '/approval_mode';
  const resp = await apiFetch(url, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`get mode failed: ${resp.status}`);
  const body = (await resp.json()) as ApprovalModeResponse;
  return { mode: body.mode, global: !!body.global };
}

/** Set the `reasoning_effort` and optional `thinking_budget` for a provider.
 *  Persists to the provider config so the next turn picks it up. */
export async function postLiveReasoningEffort(
  effort: string | null,
  provider?: string,
  thinkingBudget?: number | null,
  clearThinkingBudget?: boolean,
  sessionId?: string | null,
): Promise<void> {
  const resp = await apiFetch('/live/reasoning_effort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      reasoning_effort: effort,
      ...(provider ? { provider } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(thinkingBudget !== undefined && thinkingBudget !== null ? { thinking_budget: thinkingBudget } : {}),
      ...(clearThinkingBudget ? { clear_thinking_budget: true } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`set live reasoning effort failed: ${resp.status}`);
  const body = await resp.json() as { ok?: boolean; error?: string };
  if (!body.ok) throw new Error(body.error ?? 'live runtime rejected reasoning effort');
}

export interface UserInputQuestion {
  header: string;
  question: string;
  mode: 'single' | 'multiple' | 'text';
  options: { label: string; description?: string }[];
  /** Offer the "type your own answer" row (single/multiple). Absent ⇒ true. */
  custom?: boolean;
}

export interface UserInputResponseBody {
  declined: boolean;
  selected: string[];
  text: string | null;
}

export interface UserInputRequestEvent {
  type: 'user_input_request';
  request_id: number;
  /** Present on the `/chat` path; `/live` is already bound to one session. */
  session_id?: string;
  header: string;
  question: string;
  mode: 'single' | 'multiple' | 'text';
  options: { label: string; description?: string }[];
  /// Present for a multi-question batch; the webui steps through these and posts
  /// one batched answer. Omitted for a single question (use the flat fields above).
  questions?: UserInputQuestion[];
  /// Offer the "type your own answer" row for a single question. Absent ⇒ true.
  custom?: boolean;
}

export function isUserInputBatch(req: UserInputRequestEvent): boolean {
  return Array.isArray(req.questions) && req.questions.length > 0;
}

export type UserInputAnswer =
  | ({ request_id: number } & UserInputResponseBody)
  | { request_id: number; responses: UserInputResponseBody[] };

export async function postLiveUserInput(
  body: UserInputAnswer,
  sessionId?: string | null,
): Promise<{ accepted: boolean }> {
  const resp = await apiFetch('/live/user-input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      ...body,
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`answer live user input failed: ${resp.status}`);
  const result = await resp.json() as { accepted: boolean; error?: string };
  if (!result.accepted) {
    throw new Error(result.error ?? 'live runtime did not accept the user input answer');
  }
  return result;
}

export async function postChatUserInput(
  sessionId: string,
  body: UserInputAnswer,
): Promise<{ accepted: boolean }> {
  const resp = await apiFetch('/chat/user-input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ session_id: sessionId, ...body }),
  });
  if (!resp.ok) throw new Error(`answer chat user input failed: ${resp.status}`);
  const result = await resp.json() as { accepted: boolean; error?: string };
  if (!result.accepted) {
    throw new Error(result.error ?? 'chat runtime did not accept the user input answer');
  }
  return result;
}

// ============================================================================
// Git API (Source Control & Branch Graph)
// ============================================================================

export interface GitRepoInfo {
  root: string;
  name: string;
  relative_path: string;
  current_branch?: string | null;
  is_root: boolean;
}

export interface GitReposResponse {
  repos: GitRepoInfo[];
}

export async function fetchGitRepos(cwd?: string): Promise<GitReposResponse> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const resp = await apiFetch(`/git/repos${query}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface GitBranchesResponse {
  is_repo: boolean;
  repo_root?: string | null;
  remote_url?: string | null;
  current?: string | null;
  local: string[];
  remote: string[];
}

export interface GitCommitItem {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  timestamp: number;
  message: string;
  refs: string[];
  total_files?: number;
  total_additions?: number;
  total_deletions?: number;
}

export interface GitGraphResponse {
  is_repo: boolean;
  current_branch?: string | null;
  remote_url?: string | null;
  commits: GitCommitItem[];
}

export interface GitCheckoutResponse {
  success: boolean;
  branch: string;
  message: string;
}

export async function fetchGitBranches(cwd?: string): Promise<GitBranchesResponse> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const resp = await apiFetch(`/git/branches${query}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchGitGraph(options?: {
  cwd?: string;
  branch?: string;
  limit?: number;
}): Promise<GitGraphResponse> {
  const params = new URLSearchParams();
  if (options?.cwd) params.set('cwd', options.cwd);
  if (options?.branch) params.set('branch', options.branch);
  if (options?.limit) params.set('limit', String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : '';
  const resp = await apiFetch(`/git/graph${query}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function checkoutGitBranch(branch: string, cwd?: string): Promise<GitCheckoutResponse> {
  const resp = await apiFetch('/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ branch, cwd }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface GitCommitFile {
  path: string;
  status: string; // 'M' | 'A' | 'D' | 'R'
  additions: number;
  deletions: number;
}

export interface GitCommitDetailResponse {
  hash: string;
  files: GitCommitFile[];
  total_files?: number;
  total_additions?: number;
  total_deletions?: number;
}

export interface GitFileDiffResponse {
  hash: string;
  path: string;
  diff: string;
}

export async function fetchGitCommitDetail(hash: string, cwd?: string): Promise<GitCommitDetailResponse> {
  const params = new URLSearchParams({ hash });
  if (cwd) params.set('cwd', cwd);
  const resp = await apiFetch(`/git/commit-detail?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchGitFileDiff(hash: string, path: string, cwd?: string): Promise<GitFileDiffResponse> {
  const params = new URLSearchParams({ hash, path });
  if (cwd) params.set('cwd', cwd);
  const resp = await apiFetch(`/git/file-diff?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface GitStatusItem {
  path: string;
  status: string; // 'M' | 'A' | 'D' | 'R' | '?'
  staged: boolean;
}

export interface GitStatusResponse {
  is_repo: boolean;
  current_branch?: string | null;
  tracking_branch?: string | null;
  ahead: number;
  behind: number;
  staged: GitStatusItem[];
  unstaged: GitStatusItem[];
  untracked: GitStatusItem[];
}

export async function fetchGitStatus(cwd?: string): Promise<GitStatusResponse> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const resp = await apiFetch(`/git/status${query}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitStage(options: { path?: string; all?: boolean; cwd?: string }): Promise<{ success: boolean }> {
  const resp = await apiFetch('/git/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitUnstage(options: { path?: string; all?: boolean; cwd?: string }): Promise<{ success: boolean }> {
  const resp = await apiFetch('/git/unstage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitDiscard(options: { path: string; isUntracked?: boolean; cwd?: string }): Promise<{ success: boolean }> {
  const resp = await apiFetch('/git/discard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: options.path, is_untracked: options.isUntracked, cwd: options.cwd }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitCommit(options: { message: string; amend?: boolean; cwd?: string }): Promise<{ success: boolean; message: string }> {
  const resp = await apiFetch('/git/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitPush(options?: { branch?: string; remote?: string; setUpstream?: boolean; cwd?: string }): Promise<{ success: boolean; message: string }> {
  const resp = await apiFetch('/git/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      branch: options?.branch,
      remote: options?.remote,
      set_upstream: options?.setUpstream,
      cwd: options?.cwd,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitPull(options?: { branch?: string; remote?: string; cwd?: string }): Promise<{ success: boolean; message: string }> {
  const resp = await apiFetch('/git/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options || {}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitFetch(options?: { remote?: string; prune?: boolean; cwd?: string }): Promise<{ success: boolean; message: string; has_remote?: boolean }> {
  const resp = await apiFetch('/git/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options || {}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export const fetchGitFetch = gitFetch;

export async function fetchGitWorkingDiff(path: string, staged?: boolean, cwd?: string): Promise<GitFileDiffResponse> {
  const params = new URLSearchParams({ path });
  if (staged) params.set('staged', 'true');
  if (cwd) params.set('cwd', cwd);
  const resp = await apiFetch(`/git/working-diff?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gitAction(options: {
  action:
    | 'checkout'
    | 'create_branch'
    | 'create_tag'
    | 'cherry_pick'
    | 'revert'
    | 'delete_branch'
    | 'delete_remote_branch'
    | 'rename_branch'
    | 'merge_branch'
    | 'push_branch';
  target: string;
  name?: string;
  cwd?: string;
}): Promise<{ success: boolean; message: string }> {
  const resp = await apiFetch('/git/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// --- Update & Config Sync API ---

export interface UpdateVersionEntry {
  version: string;
  notes?: string | null;
  released_at?: string | null;
}

export interface UpdateCheckResponse {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  is_desktop: boolean;
  release_notes?: string | null;
  download_url?: string | null;
  released_at?: string | null;
  channel?: 'stable' | 'beta';
  /** Channel history, newest first. */
  versions?: UpdateVersionEntry[];
}

export interface UpdateStatus {
  status: 'idle' | 'downloading' | 'ready' | 'installing' | 'done' | 'error';
  progress: number;
  bytes: number;
  total: number;
  error?: string | null;
}

export interface ConfigDiffItem {
  relative_path: string;
  description: string;
  target_path: string;
  kind: 'new' | 'modified' | 'obsolete';
  selected: boolean;
}

export interface UpgradeDiffsResponse {
  should_prompt: boolean;
  current_version: string;
  last_seen_version?: string | null;
  diffs: ConfigDiffItem[];
}

export async function checkUpdate(channel?: string): Promise<UpdateCheckResponse> {
  const url = channel ? `/api/update/check?channel=${encodeURIComponent(channel)}` : '/api/update/check';
  const resp = await apiFetch(url, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const resp = await apiFetch('/api/update/status', {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function executeUpdate(payload?: {
  channel?: string;
  version?: string;
  download_url?: string;
  force?: boolean;
}): Promise<{ success: boolean; message: string }> {
  const resp = await apiFetch('/api/update/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchUpgradeDiffs(firstLaunch = false, force = false): Promise<UpgradeDiffsResponse> {
  const params = new URLSearchParams();
  if (firstLaunch) params.set('first_launch', 'true');
  if (force) params.set('force', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  const resp = await apiFetch(`/api/config/upgrade-diffs${query}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function applyUpgradeDiffs(selectedPaths: string[]): Promise<{ success: boolean; applied_count: number }> {
  const resp = await apiFetch('/api/config/apply-diffs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ selected_paths: selectedPaths }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function dismissUpgradeDiffs(): Promise<{ success: boolean }> {
  const resp = await apiFetch('/api/config/dismiss-diffs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ==========================================
// Explorer & Terminal API
// ==========================================

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  is_ignored?: boolean;
}

export interface FsTreeResponse {
  path: string;
  entries: FsEntry[];
  dirs: string[];
  files: string[];
}

export async function fetchFsTree(path?: string): Promise<FsTreeResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  const q = params.toString() ? `?${params.toString()}` : '';
  const resp = await apiFetch(`/fs/tree${q}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface FsReadResult {
  path: string;
  content: string;
  success: boolean;
  size?: number;
  modified_ms?: number | null;
}

export async function fetchFsRead(path: string, cwd?: string): Promise<FsReadResult> {
  const params = new URLSearchParams({ path });
  if (cwd) params.set('cwd', cwd);
  const resp = await apiFetch(`/fs/read?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface FsStatResult {
  path: string;
  exists: boolean;
  is_file: boolean;
  size: number;
  modified_ms: number | null;
}

/** 轻量文件戳：编辑器轮询它判断磁盘是否变化，变化时才拉全文。 */
export async function fetchFsStat(
  path: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<FsStatResult> {
  const params = new URLSearchParams({ path });
  if (cwd) params.set('cwd', cwd);
  const resp = await apiFetch(`/fs/stat?${params.toString()}`, {
    headers: authHeaders(),
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchFsWrite(
  path: string,
  content: string,
): Promise<{ success: boolean; message?: string; size?: number; modified_ms?: number | null }> {
  const resp = await apiFetch('/fs/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, content }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchFsAction(
  action: 'create_file' | 'create_dir' | 'rename' | 'delete',
  options: { path: string; new_name?: string; content?: string },
): Promise<{ success: boolean; message?: string }> {
  const resp = await apiFetch('/fs/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ action, ...options }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface FsSearchResult {
  file: string;
  line: number;
  content: string;
  matches?: [number, number][];
}

export interface FsLocateItem {
  name: string;
  path: string;
  rel_path: string;
  is_dir: boolean;
}

export async function fetchFsLocate(q: string, path?: string): Promise<{ query: string; results: FsLocateItem[] }> {
  const params = new URLSearchParams({ q });
  if (path) params.set('path', path);
  const resp = await apiFetch(`/fs/locate?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    return { query: q, results: [] };
  }
  return resp.json();
}

export async function fetchFsSearch(q: string, path?: string): Promise<{ query: string; results: FsSearchResult[] }> {
  const params = new URLSearchParams({ q });
  if (path) params.set('path', path);
  const resp = await apiFetch(`/fs/search?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function createTerminalSession(options: { shell?: string; cwd?: string } = {}): Promise<{
  success: boolean;
  terminal_id: string;
  name: string;
  cwd: string;
}> {
  const resp = await apiFetch('/terminal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchTerminalList(cwd?: string): Promise<{
  success: boolean;
  terminals: Array<{
    id: string;
    name: string;
    cwd: string;
    shell: string;
    history: string[];
    timestamp: number;
  }>;
  platform?: 'windows' | 'macos' | 'linux';
}> {
  const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const resp = await apiFetch(`/terminal/list${q}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) return { success: false, terminals: [] };
  return resp.json();
}

export async function closeTerminalSession(terminalId: string): Promise<{ success: boolean }> {
  const resp = await apiFetch('/terminal/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ terminal_id: terminalId }),
  });
  if (!resp.ok) return { success: false };
  return resp.json();
}

export async function sendTerminalInput(
  terminalId: string,
  input: string,
): Promise<{ success: boolean; output: string }> {
  const resp = await apiFetch('/terminal/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ terminal_id: terminalId, input }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as any).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function getGitBinding(projectHash: string): Promise<any> {
  const resp = await apiFetch(`/api/git/binding?project_hash=${encodeURIComponent(projectHash)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) return null;
  return resp.json();
}

export async function saveGitBinding(config: any): Promise<{ success: boolean; error?: string }> {
  const resp = await apiFetch('/api/git/binding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  });
  if (!resp.ok) {
    let errorMsg = '';
    try {
      const err = await resp.json();
      errorMsg = err.error || err.message;
    } catch {
      errorMsg = await resp.text().catch(() => '');
    }
    return { success: false, error: errorMsg || `HTTP ${resp.status}` };
  }
  return resp.json();
}

export async function generateGitHubAppToken(payload: {
  appId: number;
  privateKeyPath?: string;
  privateKey?: string;
  repoIdentifier?: string;
  projectHash?: string;
}): Promise<{
  success: boolean;
  token?: string;
  expiresAt?: number;
  installationId?: string;
  message?: string;
  error?: string;
}> {
  const resp = await apiFetch('/api/git/generate-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    let errorMsg = '';
    try {
      const err = await resp.json();
      errorMsg = err.error || err.message;
    } catch {
      errorMsg = await resp.text().catch(() => '');
    }
    return { success: false, error: errorMsg || `HTTP ${resp.status}` };
  }
  return resp.json();
}

export async function testGitBinding(
  config: any
): Promise<{ success: boolean; message?: string; error?: string }> {
  const resp = await apiFetch('/api/git/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  });
  if (!resp.ok) {
    let errorMsg = '';
    try {
      const err = await resp.json();
      errorMsg = err.error || err.message;
    } catch {
      errorMsg = await resp.text().catch(() => '');
    }
    return { success: false, error: errorMsg || `HTTP ${resp.status}` };
  }
  return resp.json();
}



