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
  broadcastApprovalMode,
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
  isSessionNoticeSuppressed,
  permissionInstanceKey,
  samePermissionInstance,
} from '../lib/sessionNotify';
import { useT } from '../settings';
import { PermissionCard } from './PermissionCard';
import { UserInputCard } from './UserInputCard';

export interface LiveReviewState {
  sessionId: string | null;
  permission: {
    generation: number;
    request_id: number;
    tool_name: string;
    reason: string;
    call_id: string;
    arguments: unknown;
  } | null;
  userInput: UserInputRequestEvent | null;
}

interface ChatPermission {
  session_id: string;
  approval_id: string;
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
  onDismissLivePermission: (generation: number, requestId: number, callId: string) => void;
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

  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 720 : false,
  );

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 720);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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

  function dismissCardLocally(
    cardKey: string,
    sessionId: string,
    callOrReqId: string | number,
    approvalId?: string,
    requestId?: number,
    generation?: number,
  ) {
    const idStr = String(callOrReqId);
    const identityKey = approvalId
      ? permissionInstanceKey(sessionId, { call_id: idStr, approval_id: approvalId })
      : requestId !== undefined
        ? permissionInstanceKey(sessionId, { call_id: idStr, request_id: requestId, generation })
        : `${sessionId}:${idStr}`;
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.add(cardKey);
      next.add(identityKey);
      return next;
    });
    setPolled((prev) =>
      prev.filter(
        (p) =>
          !(
            p.sessionId === sessionId &&
            ((p.permission &&
              (approvalId
                ? p.permission.approval_id === approvalId
                : requestId !== undefined
                  ? false
                : p.permission.call_id === idStr)) ||
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
    // 严格遵循用户偏好：手动点击停止、中途steer、或者日常stopped打断，严禁发送系统通知骚扰
    if (isSessionNoticeSuppressed(sessionId)) return;
    const key = `${sessionId}:${kind}`;
    if (!shouldEmitNotice(recent.current, key, Date.now(), DEDUPE_MS)) return;
    const id = `${sessionId}:${seq}:${kind}`;
    const away = windowAway();
    const noticeCtx: TerminalNoticeContext = {
      sessionId,
      activeSessionId: activeSession?.id ?? null,
      windowAway: away,
      kind,
    };
    if (shouldToastTerminal(noticeCtx)) {
      setToasts((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, { id, sessionId, kind }]));
    }
    // 日常单纯的 stopped（中途打断/停止）严禁向操作系统发通知；只在真正完成且离开窗口时发
    if (kind === 'stopped') return;
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

  function pingReview(
    tag: string,
    sessionId: string,
    detail: string,
    ask: boolean,
    approvalId?: string,
  ) {
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
      approvalId,
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
        if (modeRef.current !== null && nextMode !== modeRef.current) {
          broadcastApprovalMode(nextMode);
        }
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
    approval_id?: string;
    generation?: number;
    request_id?: number;
    tool_name: string;
    reason: string;
    call_id: string;
    arguments: unknown;
    live: boolean;
  }> = [];
  if (livePermission && liveSessionId && !samePermissionInstance(chatPerm, livePermission)) {
    permissionCards.push({
      key: `live:${permissionInstanceKey(liveSessionId, livePermission)}`,
      sessionId: liveSessionId,
      ...livePermission,
      live: true,
    });
  }
  if (chatPerm) {
    permissionCards.push({
      key: `chat:${permissionInstanceKey(chatPerm.session_id, chatPerm)}`,
      sessionId: chatPerm.session_id,
      approval_id: chatPerm.approval_id,
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
    const identityKey = permissionInstanceKey(item.sessionId, perm);
    if (dismissedKeys.has(`poll:${identityKey}`) || dismissedKeys.has(identityKey)) {
      continue;
    }
    if (permissionCards.some((card) =>
      card.sessionId === item.sessionId && samePermissionInstance(card, perm)
    )) {
      continue;
    }
    permissionCards.push({
      key: `poll:${identityKey}`,
      sessionId: item.sessionId,
      approval_id: perm.approval_id,
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
      pingReview(
        `perm:${permissionInstanceKey(card.sessionId, card)}`,
        card.sessionId,
        card.tool_name,
        false,
        card.live ? undefined : card.approval_id,
      );
    }
    for (const card of questionCards) {
      if (!showPermissionNotice(modeRef.current)) continue;
      const detail = card.req.question || card.req.header;
      pingReview(`ask:${card.sessionId}:${card.req.request_id}`, card.sessionId, detail, true);
    }
  }, [mode, permissionCards.map((card) => card.key).join('|'), questionCards.map((card) => card.key).join('|')]);

  const interactiveCards: Array<
    | { kind: 'permission'; card: (typeof permissionCards)[0] }
    | { kind: 'question'; card: (typeof questionCards)[0] }
  > = [
    ...permissionCards.map((c) => ({ kind: 'permission' as const, card: c })),
    ...questionCards.map((c) => ({ kind: 'question' as const, card: c })),
  ];

  const totalCards = interactiveCards.length;
  const safeCardIndex = Math.min(
    Math.max(0, activeCardIndex),
    Math.max(0, totalCards - 1),
  );
  const currentCard = totalCards > 0 ? interactiveCards[safeCardIndex] : null;

  // 追踪移动端审批卡片的清空与切换，确保新卡片默认处于折叠状态（Notification Capsule）
  const prevTotalCardsRef = useRef(totalCards);
  useEffect(() => {
    if (totalCards === 0) {
      setMobileExpanded(false);
    } else if (prevTotalCardsRef.current === 0 && totalCards > 0) {
      setMobileExpanded(false);
    }
    prevTotalCardsRef.current = totalCards;
  }, [totalCards]);

  if (permissionCards.length === 0 && questionCards.length === 0 && toasts.length === 0) {
    return null;
  }

  // 手机移动端：采用仿聊天软件新消息收纳小条（Notification Capsule）
  // 占屏幕空间极小，不遮挡主聊天区域，点击即可平滑展开卡片进行操作
  if (isMobile && currentCard && !mobileExpanded) {
    const summary =
      currentCard.kind === 'permission'
        ? `${t('perm.title') || '工具审批'}: ${currentCard.card.tool_name}`
        : `${t('ask.title') || '询问输入'}: ${currentCard.card.req.header || currentCard.card.req.question}`;
    return (
      <div class="notify-dock mobile-dock" aria-live="polite">
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
        <button
          type="button"
          class="mobile-notify-pill"
          onClick={() => setMobileExpanded(true)}
          aria-label={t('notify.action.expand')}
        >
          <span class="mobile-notify-bell">🔔</span>
          <div class="mobile-notify-pill-content">
            <span class="mobile-notify-pill-session">
              {labelFor(currentCard.card.sessionId)}
            </span>
            <span class="mobile-notify-pill-desc">{summary}</span>
          </div>
          {totalCards > 1 && (
            <span class="mobile-notify-badge">
              {safeCardIndex + 1}/{totalCards}
            </span>
          )}
          <span class="mobile-notify-pill-action">{t('notify.action.view')}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      class={`notify-dock ${isMobile && mobileExpanded ? 'mobile-dock-expanded' : ''}`}
      aria-live="polite"
    >
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

      {/* 当有多个卡片等待审批或手机端展开时，提供指示与随时收纳小条的入口 */}
      {(totalCards > 1 || (isMobile && mobileExpanded)) && (
        <div class="notify-deck-bar">
          <div class="notify-deck-info">
            {totalCards > 1 && (
              <span class="notify-deck-badge">
                {safeCardIndex + 1} / {totalCards}
              </span>
            )}
            <span class="notify-deck-label">
              {currentCard ? labelFor(currentCard.card.sessionId) : ''}
            </span>
          </div>
          <div class="notify-deck-nav">
            {totalCards > 1 && (
              <>
                <button
                  type="button"
                  class="notify-deck-nav-btn"
                  disabled={safeCardIndex <= 0}
                  onClick={() => setActiveCardIndex((i) => Math.max(0, i - 1))}
                  title={t('notify.action.prev')}
                >
                  ◀
                </button>
                <button
                  type="button"
                  class="notify-deck-nav-btn"
                  disabled={safeCardIndex >= totalCards - 1}
                  onClick={() => setActiveCardIndex((i) => Math.min(totalCards - 1, i + 1))}
                  title={t('notify.action.next')}
                >
                  ▶
                </button>
              </>
            )}
            {isMobile && mobileExpanded && (
              <button
                type="button"
                class="notify-deck-collapse-btn"
                onClick={() => setMobileExpanded(false)}
                title={t('notify.action.collapse')}
              >
                {t('notify.action.collapse')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 手机端展开状态下或卡片多于 1 张时只渲染当前卡片；单卡片在桌面端正常展示 */}
      {currentCard && currentCard.kind === 'permission' && (
        <section class="notify-item" key={currentCard.card.key}>
          <button
            type="button"
            class="notify-session"
            onClick={() => onFocusSession(currentCard.card.sessionId)}
          >
            {labelFor(currentCard.card.sessionId)}
          </button>
          <PermissionCard
            dock
            req={{
              session_id: currentCard.card.sessionId,
              approval_id: currentCard.card.approval_id,
              tool_name: currentCard.card.tool_name,
              reason: currentCard.card.reason,
              call_id: currentCard.card.call_id,
              arguments: currentCard.card.arguments,
            }}
            onDone={() => {
              dismissCardLocally(
                currentCard.card.key,
                currentCard.card.sessionId,
                currentCard.card.call_id,
                currentCard.card.approval_id,
                currentCard.card.request_id,
                currentCard.card.generation,
              );
              if (
                currentCard.card.live
                && currentCard.card.generation !== undefined
                && currentCard.card.request_id !== undefined
              ) {
                onDismissLivePermission(
                  currentCard.card.generation,
                  currentCard.card.request_id,
                  currentCard.card.call_id,
                );
              }
              else if (
                chatPerm &&
                chatPerm.approval_id === currentCard.card.approval_id
              )
                onDismissChatPermission();
            }}
            onDecide={async (decision, toolName) => {
              if (currentCard.card.live) {
                await postLivePermission(
                  decision,
                  toolName,
                  currentCard.card.sessionId,
                  currentCard.card.generation,
                  currentCard.card.request_id,
                );
                return;
              }
              const result = await respondPermission(
                currentCard.card.sessionId,
                currentCard.card.approval_id ?? '',
                decision,
                toolName,
              );
              if (!result.success) throw new Error('permission request is no longer pending');
            }}
          />
        </section>
      )}

      {currentCard && currentCard.kind === 'question' && (
        <section class="notify-item" key={currentCard.card.key}>
          <button
            type="button"
            class="notify-session"
            onClick={() => onFocusSession(currentCard.card.sessionId)}
          >
            {labelFor(currentCard.card.sessionId)}
          </button>
          <UserInputCard
            dock
            req={currentCard.card.req}
            onDone={() => {
              dismissCardLocally(
                currentCard.card.key,
                currentCard.card.sessionId,
                currentCard.card.req.request_id,
              );
              if (
                currentCard.card.live ||
                (liveUserInput && liveUserInput.request_id === currentCard.card.req.request_id)
              ) {
                onDismissLiveUserInput();
              }
            }}
            submitAnswer={async (body: UserInputAnswer) => {
              dismissCardLocally(
                currentCard.card.key,
                currentCard.card.sessionId,
                currentCard.card.req.request_id,
              );
              if (!currentCard.card.req.session_id) {
                return postLiveUserInput(body, currentCard.card.sessionId);
              }
              try {
                return await postChatUserInput(currentCard.card.req.session_id, body);
              } catch {
                return postLiveUserInput(body, currentCard.card.sessionId);
              }
            }}
          />
        </section>
      )}
    </div>
  );
}
