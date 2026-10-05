// Bottom-right stack for every session that is waiting on the user, plus a
// short toast when a turn finishes or stops. OS toasts are fired from here
// through POST /system-notify so they show on Windows, macOS, and Linux even
// when this tab is in the background.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ApprovalMode,
  ChatPendingInteractive,
  getActiveChatSessions,
  getApprovalMode,
  getChatPending,
  getRuntimeSessions,
  listSessions,
  postChatUserInput,
  postLivePermission,
  postLiveUserInput,
  postSystemNotify,
  respondPermission,
  UserInputAnswer,
  UserInputRequestEvent,
} from '../api';
import {
  dispatchSystemNotification,
  sessionNoticeLabel,
  shouldEmitNotice,
  shouldOsNotifyReview,
  isWindowAway,
  shouldOsNotifyTerminal,
  shouldToastTerminal,
  showPermissionNotice,
  takeTerminalEdges,
  TerminalKind,
  TerminalNoticeContext,
} from '../lib/sessionNotify';
import { useT } from '../settings';
import { PermissionCard } from './PermissionCard';
import { UserInputCard } from './UserInputCard';

export interface LiveReviewState {
  sessionId: string | null;
  permission: {
    tool_name: string;
    reason: string;
    call_id: string;
    arguments: unknown;
  } | null;
  userInput: UserInputRequestEvent | null;
}

interface ChatPermission {
  session_id: string;
  tool_name: string;
  reason: string;
  call_id: string;
  arguments: unknown;
}

interface TerminalToast {
  id: string;
  sessionId: string;
  kind: TerminalKind;
}

interface PolledPrompt {
  sessionId: string;
  permission: ChatPendingInteractive['permission'];
  userInput: UserInputRequestEvent | null;
}

interface SessionHint {
  name?: string;
  workingDir?: string;
}

const POLL_MS = 2000;
const NAME_MS = 8000;
const TOAST_MS = 8000;
const DEDUPE_MS = 2500;

function windowAway(): boolean {
  return isWindowAway();
}

function samePermission(
  a: { call_id: string } | null | undefined,
  b: { call_id: string } | null | undefined,
): boolean {
  return !!a && !!b && a.call_id === b.call_id;
}

export function NotificationDock({
  liveReview,
  chatPermission,
  activeSession,
  onDismissChatPermission,
  onDismissLivePermission,
  onDismissLiveUserInput,
  onFocusSession,
}: {
  liveReview: LiveReviewState | null;
  chatPermission: ChatPermission | null;
  activeSession?: { id: string; name: string; working_dir?: string } | null;
  onDismissChatPermission: () => void;
  onDismissLivePermission: (callId: string) => void;
  onDismissLiveUserInput: () => void;
  onFocusSession: (sessionId: string) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [hints, setHints] = useState<Record<string, SessionHint>>({});
  const [polled, setPolled] = useState<PolledPrompt[]>([]);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<TerminalToast[]>([]);
  const seenSeq = useRef(new Map<string, number>());
  const primedSeq = useRef(false);
  const recent = useRef(new Map<string, number>());
  const sentReview = useRef(new Set<string>());
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!activeSession?.id) return;
    setHints((prev) => ({
      ...prev,
      [activeSession.id]: {
        name: activeSession.name,
        workingDir: activeSession.working_dir ?? prev[activeSession.id]?.workingDir,
      },
    }));
  }, [activeSession?.id, activeSession?.name, activeSession?.working_dir]);

  function dismissCardLocally(cardKey: string, sessionId: string, callOrReqId: string | number) {
    const idStr = String(callOrReqId);
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.add(cardKey);
      next.add(`${sessionId}:${idStr}`);
      return next;
    });
    setPolled((prev) =>
      prev.filter(
        (p) =>
          !(
            p.sessionId === sessionId &&
            (p.permission?.call_id === idStr ||
              (p.userInput?.request_id != null && String(p.userInput.request_id) === idStr))
          ),
      ),
    );
  }

  function labelFor(id: string, workingDir?: string | null): string {
    const hint = hintsRef.current[id];
    return sessionNoticeLabel({
      id,
      name: hint?.name,
      workingDir: workingDir ?? hint?.workingDir,
    });
  }

  function pushTerminal(sessionId: string, kind: TerminalKind, seq: number) {
    const key = `${sessionId}:${kind}`;
    if (!shouldEmitNotice(recent.current, key, Date.now(), DEDUPE_MS)) return;
    const id = `${sessionId}:${seq}:${kind}`;
    const away = windowAway();
    const noticeCtx: TerminalNoticeContext = {
      sessionId,
      activeSessionId: activeSession?.id ?? null,
      windowAway: away,
    };
    if (shouldToastTerminal(noticeCtx)) {
      setToasts((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, { id, sessionId, kind }]));
    }
    if (!shouldOsNotifyTerminal(noticeCtx)) return;
    const session = labelFor(sessionId);
    const title = tRef.current(
      kind === 'completed' ? 'notify.done.title' : kind === 'failed' ? 'notify.failed.title' : 'notify.stopped.title',
    );
    const body = tRef.current(
      kind === 'completed' ? 'notify.done.body' : kind === 'failed' ? 'notify.failed.body' : 'notify.stopped.body',
      { session },
    );
    dispatchSystemNotification({
      title,
      body,
      sessionId,
      // Stable across the poll and the chat SSE so the daemon drops the second
      // copy. The in-window card id above still includes the seq.
      tag: `${sessionId}:${kind}`,
      postSystemNotifyFn: postSystemNotify,
    });
  }

  function pingReview(tag: string, sessionId: string, detail: string, ask: boolean) {
    if (modeRef.current == null) return;
    if (sentReview.current.has(tag)) return;
    if (!shouldOsNotifyReview(modeRef.current, windowAway())) {
      sentReview.current.add(tag);
      return;
    }
    sentReview.current.add(tag);
    const session = labelFor(sessionId);
    dispatchSystemNotification({
      title: tRef.current(ask ? 'notify.ask.title' : 'notify.review.title'),
      body: tRef.current(ask ? 'notify.ask.body' : 'notify.review.body', { session, detail }),
      sessionId,
      tag,
      postSystemNotifyFn: postSystemNotify,
    });
  }

  useEffect(() => {
    let cancelled = false;
    let namesAt = 0;

    async function refreshNames() {
      const now = Date.now();
      if (now - namesAt < NAME_MS) return;
      namesAt = now;
      try {
        const sessions = await listSessions();
        if (cancelled) return;
        setHints((prev) => {
          const next = { ...prev };
          for (const session of sessions) {
            next[session.id] = {
              name: session.name,
              workingDir: session.working_dir,
            };
          }
          return next;
        });
      } catch {
        // Names are decorative. The short id still identifies the session.
      }
    }

    async function tick() {
      await refreshNames();
      let runtime: Awaited<ReturnType<typeof getRuntimeSessions>> = [];
      let active: string[] = [];
      try {
        const [nextMode, nextRuntime, nextActive] = await Promise.all([
          getApprovalMode(),
          getRuntimeSessions(),
          getActiveChatSessions(),
        ]);
        if (cancelled) return;
        setMode(nextMode);
        modeRef.current = nextMode;
        runtime = nextRuntime;
        active = nextActive;
      } catch {
        return;
      }

      const edges = takeTerminalEdges(
        seenSeq.current,
        runtime.map((row) => ({
          sessionId: row.session_id,
          seq: row.terminal_seq ?? 0,
          kind: row.last_terminal,
        })),
        { baseline: !primedSeq.current },
      );
      primedSeq.current = true;
      for (const edge of edges) {
        const row = runtime.find((item) => item.session_id === edge.sessionId);
        if (row?.working_dir) {
          setHints((prev) => ({
            ...prev,
            [edge.sessionId]: {
              name: prev[edge.sessionId]?.name,
              workingDir: row.working_dir,
            },
          }));
        }
        pushTerminal(edge.sessionId, edge.kind, edge.seq);
      }

      const ids = new Set(active);
      for (const row of runtime) {
        if (row.activity === 'waiting_approval' || row.activity === 'waiting_user_input') {
          ids.add(row.session_id);
        }
        if (row.working_dir) {
          setHints((prev) => {
            if (prev[row.session_id]?.workingDir === row.working_dir && prev[row.session_id]?.name) {
              return prev;
            }
            return {
              ...prev,
              [row.session_id]: {
                name: prev[row.session_id]?.name,
                workingDir: row.working_dir,
              },
            };
          });
        }
      }

      const prompts = await Promise.all(
        [...ids].map(async (sessionId) => {
          try {
            const pending = await getChatPending(sessionId);
            return { sessionId, permission: pending.permission, userInput: pending.user_input } satisfies PolledPrompt;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setPolled(prompts.filter((item): item is PolledPrompt => item !== null));
    }

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.slice(1));
    }, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  const allowPermission = showPermissionNotice(mode);
  const livePermission = allowPermission ? liveReview?.permission ?? null : null;
  const liveUserInput = liveReview?.userInput ?? null;
  const liveSessionId = liveReview?.sessionId ?? null;
  const chatPerm = allowPermission ? chatPermission : null;

  const permissionCards: Array<{
    key: string;
    sessionId: string;
    tool_name: string;
    reason: string;
    call_id: string;
    arguments: unknown;
    live: boolean;
  }> = [];
  if (livePermission && liveSessionId) {
    permissionCards.push({
      key: `live:${livePermission.call_id}`,
      sessionId: liveSessionId,
      ...livePermission,
      live: true,
    });
  }
  if (chatPerm && !samePermission(chatPerm, livePermission)) {
    permissionCards.push({
      key: `chat:${chatPerm.call_id}`,
      sessionId: chatPerm.session_id,
      tool_name: chatPerm.tool_name,
      reason: chatPerm.reason,
      call_id: chatPerm.call_id,
      arguments: chatPerm.arguments,
      live: false,
    });
  }
  for (const item of polled) {
    const perm = item.permission;
    if (!allowPermission || !perm) continue;
    if (dismissedKeys.has(`poll:${item.sessionId}:${perm.call_id}`) || dismissedKeys.has(`${item.sessionId}:${perm.call_id}`)) {
      continue;
    }
    if (permissionCards.some((card) => card.call_id === perm.call_id && card.sessionId === item.sessionId)) {
      continue;
    }
    permissionCards.push({
      key: `poll:${item.sessionId}:${perm.call_id}`,
      sessionId: item.sessionId,
      tool_name: perm.tool_name,
      reason: perm.reason,
      call_id: perm.call_id,
      arguments: perm.arguments,
      live: false,
    });
  }

  const questionCards: Array<{ key: string; sessionId: string; req: UserInputRequestEvent; live: boolean }> = [];
  if (liveUserInput) {
    const sessionId = liveUserInput.session_id || liveSessionId || '';
    if (sessionId) {
      questionCards.push({
        key: `live-ask:${liveUserInput.request_id}`,
        sessionId,
        req: liveUserInput,
        live: !liveUserInput.session_id,
      });
    }
  }
  for (const item of polled) {
    const req = item.userInput;
    if (!req) continue;
    if (dismissedKeys.has(`poll-ask:${item.sessionId}:${req.request_id}`) || dismissedKeys.has(`${item.sessionId}:${req.request_id}`)) {
      continue;
    }
    if (questionCards.some((card) => card.req.request_id === req.request_id && card.sessionId === item.sessionId)) {
      continue;
    }
    questionCards.push({
      key: `poll-ask:${item.sessionId}:${req.request_id}`,
      sessionId: item.sessionId,
      req: { ...req, session_id: req.session_id || item.sessionId },
      live: false,
    });
  }

  useEffect(() => {
    for (const card of permissionCards) {
      pingReview(`perm:${card.sessionId}:${card.call_id}`, card.sessionId, card.tool_name, false);
    }
    for (const card of questionCards) {
      if (!showPermissionNotice(modeRef.current)) continue;
      const detail = card.req.question || card.req.header;
      pingReview(`ask:${card.sessionId}:${card.req.request_id}`, card.sessionId, detail, true);
    }
  }, [mode, permissionCards.map((card) => card.key).join('|'), questionCards.map((card) => card.key).join('|')]);

  if (permissionCards.length === 0 && questionCards.length === 0 && toasts.length === 0) {
    return null;
  }

  return (
    <div class="notify-dock" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          class={'notify-toast notify-toast-' + toast.kind}
          onClick={() => onFocusSession(toast.sessionId)}
        >
          <span class="notify-toast-title">
            {t(
              toast.kind === 'completed'
                ? 'notify.done.title'
                : toast.kind === 'failed'
                  ? 'notify.failed.title'
                  : 'notify.stopped.title',
            )}
          </span>
          <span class="notify-toast-body">{labelFor(toast.sessionId)}</span>
          <span
            class="notify-toast-close"
            role="button"
            aria-label={t('notify.dismiss')}
            onClick={(event) => {
              event.stopPropagation();
              setToasts((prev) => prev.filter((item) => item.id !== toast.id));
            }}
          >
            ×
          </span>
        </button>
      ))}
      {permissionCards.map((card) => (
        <section class="notify-item" key={card.key}>
          <button type="button" class="notify-session" onClick={() => onFocusSession(card.sessionId)}>
            {labelFor(card.sessionId)}
          </button>
          <PermissionCard
            dock
            req={{
              session_id: card.sessionId,
              tool_name: card.tool_name,
              reason: card.reason,
              call_id: card.call_id,
              arguments: card.arguments,
            }}
            onDone={() => {
              dismissCardLocally(card.key, card.sessionId, card.call_id);
              if (card.live) onDismissLivePermission(card.call_id);
              else if (chatPerm && chatPerm.call_id === card.call_id) onDismissChatPermission();
            }}
            onDecide={async (decision, toolName) => {
              // 用户一旦点击，立即本地移除卡片，彻底根除必须点多次才消失的顽疾！
              dismissCardLocally(card.key, card.sessionId, card.call_id);
              if (card.live) {
                await postLivePermission(decision, toolName, card.sessionId);
                return;
              }
              const result = await respondPermission(card.sessionId, decision, toolName);
              if (!result.success) {
                await postLivePermission(decision, toolName, card.sessionId);
              }
            }}
          />
        </section>
      ))}
      {questionCards.map((card) => (
        <section class="notify-item" key={card.key}>
          <button type="button" class="notify-session" onClick={() => onFocusSession(card.sessionId)}>
            {labelFor(card.sessionId)}
          </button>
          <UserInputCard
            dock
            req={card.req}
            onDone={() => {
              dismissCardLocally(card.key, card.sessionId, card.req.request_id);
              if (card.live || (liveUserInput && liveUserInput.request_id === card.req.request_id)) {
                onDismissLiveUserInput();
              }
            }}
            submitAnswer={async (body: UserInputAnswer) => {
              dismissCardLocally(card.key, card.sessionId, card.req.request_id);
              if (!card.req.session_id) {
                return postLiveUserInput(body, card.sessionId);
              }
              try {
                return await postChatUserInput(card.req.session_id, body);
              } catch {
                return postLiveUserInput(body, card.sessionId);
              }
            }}
          />
        </section>
      ))}
    </div>
  );
}
