// Task 12 — API client for jeikcode webui

import { stripExtendedPathPrefix } from './lib/displayPath.ts';

// Serve / webui bootstrap: `/?token=<uuid>` is handed off via HttpOnly cookie
// AND left visible on first paint so we can stash it for Authorization.
// Remote LAN clients often fail to attach the cookie alone (in-app WebViews,
// privacy mode) — Bearer from sessionStorage / localStorage is the reliable
// path. Strip the token from the address bar only after it is stored
// (CWE-598). If storage is unavailable, keep ?token= so later fetches still
// authenticate.
/** Shared sessionStorage key for the webui access token (api + LoginButton). */
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

function storedWebuiToken(): string {
  try {
    const session = sessionStorage.getItem(WEBUI_TOKEN_STORAGE_KEY);
    if (session) return session;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(WEBUI_TOKEN_STORAGE_KEY) ?? '';
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

function captureWebuiToken(): string {
  const fromUrl = tokenFromUrl();
  if (fromUrl) {
    persistWebuiToken(fromUrl);
    // Leave ?token= in the address bar when storage is unavailable (desktop
    // WebView / private mode). Stripping first would 401 every later fetch.
    if (storedWebuiToken() === fromUrl) stripTokenFromAddressBar();
    return fromUrl;
  }
  return storedWebuiToken();
}

captureWebuiToken();

function currentWebuiToken(): string {
  const fromUrl = tokenFromUrl();
  if (fromUrl) {
    persistWebuiToken(fromUrl);
    return fromUrl;
  }
  return storedWebuiToken();
}

function authHeaders(): Record<string, string> {
  // X-JeikCode-Client lets the daemon tag telemetry as webui-originated
  // (resolve_client_mode → SessionMode::Webui); sent regardless of token.
  const h: Record<string, string> = { 'X-JeikCode-Client': 'webui' };
  const token = currentWebuiToken();
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

/**
 * Same-origin fetch that always includes cookies (HttpOnly token handoff)
 * and merges auth headers. Remote LAN clients need both cookie + Bearer.
 */
function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = authHeaders();
  for (const [k, v] of Object.entries(auth)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return fetch(input, { ...init, credentials: 'include', headers });
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

export type SSEEvent =
  | { type: 'runtime_info'; provider: string; model: string }
  | { type: 'session_assigned'; session_id: string }
  | { type: 'user'; content: string; session_id?: string; created_at?: number }
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_start'; id: string; name: string; arguments: unknown }
  | { type: 'tool_output'; id?: string; chunk: string }
  | { type: 'tool_progress'; id: string; progress: string }
  | { type: 'tool_result'; id: string; name: string; output: string; success: boolean; duration_ms: number }
  | { type: 'tokens'; prompt: number; completion: number; total: number; cached?: number; cached_estimated?: boolean; reasoning?: number }
  | { type: 'permission_request'; session_id: string; approval_id: string; tool_name: string; reason: string; call_id: string; arguments: unknown }
  | UserInputRequestEvent
  | { type: 'user_input_resolved'; request_id: number }
  | { type: 'steered'; count: number; inputs: { text: string; images?: ImageData[] }[] }
  | { type: 'done'; tokens: unknown; tool_calls: unknown; session_id: string; stop_reason?: string; message?: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'persistence_warning'; message: string }
  | { type: 'rate_limited'; reset_at_display: string; reset_label: string; secs_until_reset: number | null; auto_resuming: boolean; server_message?: string | null }
  // Artifact events: the daemon's ArtifactDetector strips fenced code blocks from
  // TextDelta and emits them as separate artifact_start / artifact_content / artifact_end
  // events (see ArtifactDetector in crates/jeikcode-daemon/src/lib.rs). Without handling
  // these, code block content is silently lost in the WebUI while the TUI sees it fine.
  | { type: 'artifact_start'; id: string; artifact_type: string; language?: string | null; title?: string | null }
  | { type: 'artifact_content'; id: string; content: string }
  | { type: 'artifact_end'; id: string }
  | { type: 'session_renamed'; session_id: string; name: string }
  | { type: 'command_output'; text: string };

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
    try {
      const errJson = await resp.json();
      errText = errJson.error || errJson.message || '';
    } catch {}
    throw new Error(errText || `HTTP ${resp.status} ${resp.statusText}`);
  }

  try {
    return (await resp.json()) as PromptAck;
  } catch {
    return { status: 'admitted', operation_id: '', session_id: body.session_id || '' };
  }
}

export async function stopChat(requestId: string): Promise<void> {
  const resp = await apiFetch('/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ session_id: requestId }),
  });
  if (!resp.ok) throw new Error(`stop chat failed: ${resp.status}`);
}

/** Fold a queued follow-up into the running `/chat` turn at the next step. */
export async function postChatSteer(
  sessionId: string,
  message: string,
  images?: ImageData[],
): Promise<void> {
  const resp = await apiFetch('/chat/steer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      message,
      ...(images && images.length ? { images } : {}),
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
): Promise<void> {
  const resp = await apiFetch('/chat/steer/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      session_id: sessionId,
      ...(message ? { message } : {}),
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

export async function revealInFileExplorer(path: string): Promise<void> {
  await apiFetch('/fs/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path }),
  }).catch(() => {});
}

export interface QueuedMessageApiItem {
  id: number | string;
  text: string;
  images?: ImageData[];
  kind: 'queue' | 'steering' | 'steer';
  approval_mode?: ApprovalMode;
}

export async function getChatQueue(sessionId: string): Promise<QueuedMessageApiItem[]> {
  const resp = await apiFetch(`/chat/queue?session_id=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) return [];
  try {
    const list = await resp.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveChatQueue(sessionId: string, items: QueuedMessageApiItem[]): Promise<void> {
  await apiFetch('/chat/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ session_id: sessionId, items }),
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
 * Reattach to a turn started by another client (OpenAI API / another tab).
 * Same SSE `ChatEvent` frames as `POST /chat`.
 */
export async function watchChatSession(
  sessionId: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
  opts?: { standbyOnly?: boolean },
): Promise<void> {
  const params = new URLSearchParams({ session_id: sessionId });
  if (opts?.standbyOnly) params.set('standby', 'true');
  const resp = await apiFetch(
    `/chat/watch?${params.toString()}`,
    { headers: authHeaders(), signal },
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

export async function respondPermission(
  sessionId: string,
  approvalId: string,
  decision: 'allow' | 'deny' | 'always_allow' | 'allow_persist',
  toolName?: string,
): Promise<{ success: boolean }> {
  const resp = await apiFetch('/chat/permission', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ session_id: sessionId, approval_id: approvalId, decision, tool_name: toolName }),
  });
  return resp.json();
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
  text: string;
}

export interface SessionDetail {
  id: string;
  name: string;
  working_dir: string;
  created_at: number;
  updated_at: number;
  /** Total messages on disk (not the returned window size). */
  message_count: number;
  /** Index of `messages[0]` in the full transcript. Absent on older daemons. */
  offset?: number;
  /** All user questions for the right-rail outline. Independent of the message window. */
  turns?: SessionTurnOutline[];
  messages: SessionMessage[];
  /** Per-session model selection. Absent on older sessions. */
  preferred_model?: string | null;
  /** Last-request occupancy for the footer (persists across restart). Not turn-cumulative billing. */
  token_usage?: SessionTokenUsage | null;
  /** `manual` / `scheduled` / `protocol`. Protocol sessions are observed in Auto. */
  origin?: 'manual' | 'scheduled' | 'protocol';
  /** Authoritative active todo list from backend transcript. */
  todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
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
}

export async function getConfig(): Promise<ConfigInfo> {
  const resp = await apiFetch('/config', { headers: authHeaders() });
  return readApiJson<ConfigInfo>(resp);
}

/** Persist the global language switch (`en`, `vi`, or `zh`). */
export async function postLanguage(lang: 'en' | 'zh' | 'vi'): Promise<void> {
  const language = lang === 'zh' ? 'zh-CN' : lang === 'vi' ? 'vi-VN' : 'en';
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

/** Same-browser tabs plus a refetch hint. Other machines pick this up on the sidebar poll. */
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
  return {
    hidden: Array.isArray(body.hidden) ? body.hidden.filter((h) => typeof h === 'string') : [],
    pinned: Array.isArray(body.pinned) ? body.pinned : [],
  };
}

export async function hideSidebarProject(hash: string): Promise<SidebarProjects> {
  const resp = await apiFetch('/projects/sidebar/hide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ hash }),
  });
  if (!resp.ok) throw new Error(`hide project failed: ${resp.status}`);
  const body = await resp.json() as SidebarProjects;
  broadcastSidebarProjects();
  return body;
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
export async function revealSidebarProject(hash: string): Promise<void> {
  const resp = await apiFetch('/projects/sidebar/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ hash }),
  });
  if (!resp.ok) throw new Error(`reveal project failed: ${resp.status}`);
  broadcastSidebarProjects();
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

export async function getMcpStatus(): Promise<McpStatusInfo> {
  const resp = await apiFetch('/mcp/status', { headers: authHeaders() });
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

export async function getSession(
  projectHash: string,
  sessionId: string,
  opts?: { tail?: number; offset?: number; limit?: number },
): Promise<SessionDetail> {
  const q = new URLSearchParams();
  if (opts?.tail != null) q.set('tail', String(opts.tail));
  if (opts?.offset != null) q.set('offset', String(opts.offset));
  if (opts?.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString();
  const path = `/projects/${projectHash}/sessions/${sessionId}`;
  const resp = await apiFetch(qs ? `${path}?${qs}` : path, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    throw new Error(`getSession failed with status ${resp.status}`);
  }
  return resp.json();
}

// --- Live session (multi-tab real-time sync) ---

/** Approval mode: 'build' = interactive approval, 'plan' = read-only exploration,
 *  'bypass' = Auto (auto-approve everything). Mirrors the daemon `ApprovalMode`
 *  while preserving the established wire value. */
export type ApprovalMode = 'build' | 'plan' | 'bypass' | 'accept_edits';

export interface ApprovalModeResponse {
  ok: boolean;
  mode: ApprovalMode;
}

export type LiveWireEvent =
  | { type: 'snapshot'; messages: SessionMessage[]; session_id: string; session_name?: string; project_hash: string; provider: string; mode: ApprovalMode; working_dir?: string }
  | { type: 'provider'; provider: string }
  | { type: 'mode'; mode: ApprovalMode }
  | { type: 'user'; text: string; images?: ImageData[]; client_input_id?: string }
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  | { type: 'tool_output'; id: string; chunk: string }
  | { type: 'tool_progress'; id: string; progress: string }
  | { type: 'tool_result'; id: string; name: string; output: string; success: boolean; duration_ms: number }
  | { type: 'tokens'; prompt: number; completion: number; total: number; cached?: number }
  | { type: 'state'; running: boolean; stop_reason?: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'persistence_warning'; message: string }
  | { type: 'rate_limited'; reset_at_display: string; reset_label: string; secs_until_reset: number | null; auto_resuming: boolean; server_message?: string | null }
  | { type: 'permission_request'; session_id?: string; runtime_instance_id: string; generation: number; request_id: number; tool_name: string; reason: string; call_id: string; arguments: string }
  | { type: 'user_input_request'; session_id?: string; request_id: number; header: string; question: string; mode: 'single' | 'multiple' | 'text'; options: { label: string; description?: string }[] }
  | { type: 'user_input_resolved'; request_id: number }
  | { type: 'steered'; count: number; inputs: { text: string; images: ImageData[] }[]; client_input_ids: Array<string | null> }
  | { type: 'session_switched'; session_id: string }
  | { type: 'session_renamed'; session_id: string; name: string }
  | { type: 'working_dir'; working_dir: string }
  | { type: 'command_output'; text: string };

export async function streamLive(
  onEvent: (e: LiveWireEvent) => void,
  signal?: AbortSignal,
  sessionId?: string | null,
  // Called on every chunk received (events AND the 15s keepalive ping) so the
  // caller can run a staleness watchdog that reconnects a silently-dead stream.
  onActivity?: () => void,
): Promise<void> {
  const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
  const resp = await apiFetch(`/live${params}`, { headers: authHeaders(), signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const json = line.slice('data:'.length).trim();
      if (!json) continue;
      try { onEvent(JSON.parse(json) as LiveWireEvent); } catch { /* ignore keepalive */ }
    }
  }
}

export async function postLiveMessage(
  message: string,
  images?: ImageData[],
  provider?: string,
  sessionId?: string | null,
  clientInputId?: string,
): Promise<{ disposition: 'started' | 'steered'; generation: number; turn_id: number }> {
  const resp = await apiFetch('/live/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      message,
      ...(images && images.length ? { images } : {}),
      ...(provider ? { provider } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(clientInputId ? { client_input_id: clientInputId } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`send live message failed: ${resp.status}`);
  const body = await resp.json() as {
    accepted?: boolean;
    disposition?: 'started' | 'steered';
    generation?: number;
    turn_id?: number;
    error?: string;
  };
  if (!body.accepted) throw new Error(body.error ?? 'live runtime rejected the message');
  // Compatibility with a daemon from before typed submit receipts. The old
  // response only said `accepted:true`; treating it as started avoids rolling
  // back an input the server has already accepted and duplicating it on retry.
  if (body.disposition === undefined) {
    return { disposition: 'started', generation: 0, turn_id: 0 };
  }
  if (
    (body.disposition !== 'started' && body.disposition !== 'steered') ||
    typeof body.generation !== 'number' ||
    typeof body.turn_id !== 'number'
  ) {
    throw new Error('live runtime returned an invalid submit receipt');
  }
  return {
    disposition: body.disposition,
    generation: body.generation,
    turn_id: body.turn_id,
  };
}

export async function postLiveStop(sessionId?: string | null): Promise<void> {
  const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
  const resp = await apiFetch(`/live/stop${params}`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`stop live chat failed: ${resp.status}`);
  const body = await resp.json() as { accepted?: boolean };
  if (!body.accepted) throw new Error('live runtime rejected the stop request');
}

/** Sync-mode manual compaction: dispatch a compaction against the shared live
 *  runtime. `accepted:false` means no live runtime is bound (nothing to compact). */
export async function postLiveCompact(): Promise<{ accepted: boolean }> {
  const resp = await apiFetch('/live/compact', {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`live compact failed: ${resp.status}`);
  const body = await resp.json() as { accepted?: boolean };
  return { accepted: body.accepted === true };
}

/** Ask the bound native runtime to resume an existing session. */
export async function postLiveSwitchSession(
  sessionId: string,
): Promise<{ ok: boolean; activeTurn: boolean; error?: string }> {
  const resp = await apiFetch('/live/switch_session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!resp.ok) throw new Error(`switch live session failed: ${resp.status}`);
  const body = await resp.json() as { ok?: boolean; active_turn?: boolean; error?: string };
  return {
    ok: body.ok === true,
    activeTurn: body.active_turn === true,
    error: body.error,
  };
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

export function broadcastApprovalMode(mode: ApprovalMode): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jeikcode:approval_mode_changed', { detail: mode }));
    try {
      getModeBroadcastChannel()?.postMessage({ type: 'mode', mode });
    } catch {
      // ignore
    }
  }
}

/** Switch the approval mode (build / accept_edits / bypass / plan). Runtime
 *  session state — the next turn's PermissionDecider follows it; broadcast to
 *  other tabs. */
export async function postLiveMode(mode: ApprovalMode): Promise<ApprovalMode> {
  const resp = await apiFetch('/approval_mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ mode }),
  });
  if (!resp.ok) throw new Error(`switch mode failed: ${resp.status}`);
  const body = (await resp.json()) as ApprovalModeResponse;
  if (!body.ok) throw new Error('live runtime rejected the mode switch');
  broadcastApprovalMode(body.mode);
  return body.mode;
}

export async function getApprovalMode(): Promise<ApprovalMode> {
  const resp = await apiFetch('/approval_mode', { headers: authHeaders() });
  if (!resp.ok) throw new Error(`get mode failed: ${resp.status}`);
  const body = (await resp.json()) as ApprovalModeResponse;
  return body.mode;
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

export async function postLivePermission(
  decision: 'allow' | 'deny' | 'always_allow' | 'allow_persist',
  toolName?: string,
  sessionId?: string | null,
  runtimeInstanceId?: string | null,
  generation?: number,
  requestId?: number,
): Promise<{ accepted: boolean }> {
  if (!sessionId || !runtimeInstanceId || generation === undefined || requestId === undefined) {
    throw new Error('missing live approval identity');
  }
  const resp = await apiFetch('/live/permission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      decision,
      tool_name: toolName,
      session_id: sessionId,
      runtime_instance_id: runtimeInstanceId,
      generation,
      request_id: requestId,
    }),
  });
  if (!resp.ok) throw new Error(`answer live permission failed: ${resp.status}`);
  const body = await resp.json() as { accepted?: boolean };
  if (!body.accepted) throw new Error('live runtime did not accept permission');
  return { accepted: true };
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

export interface UpdateCheckResponse {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  is_desktop: boolean;
  release_notes?: string | null;
  download_url?: string | null;
  released_at?: string | null;
  channel?: 'stable' | 'beta';
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



