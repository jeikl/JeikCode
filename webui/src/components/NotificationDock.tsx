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
  showPermissionNotice,  TerminalKind,
  TerminalNoticeContext,
  isSessionNoticeSuppressed,
  permissionInstanceKey,
  samePermissionInstance,
} from '../lib/sessionNotify';
import { onGlobalEvent } from '../lib/globalEvents';
import { useT } from '../settings';
import { PermissionCard } from './PermissionCard';
import { UserInputCard } from './UserInputCard';
import { showToast } from './Toast';
import {
  PermissionRetiredError,
  permissionRetiredInfo,
  stillPendingApproval,
} from '../lib/pendingPermission';

export interface LiveReviewState {
  sessionId: string | null;
  permission: {
    runtime_instance_id: string;
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

// 视觉通知完全由 WebUI 自身的堆叠通知 Dock 呈现；冷启动后完全走事件推送驱动，彻底拔除定时轮询
const NAME_MS = 60000;
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
  onDismissLivePermission: (runtimeInstanceId: string, generation: number, requestId: number, callId: string) => void;
  onDismissLiveUserInput: () => void;
  onFocusSession: (sessionId: string) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [hints, setHints] = useState<Record<string, SessionHint>>({});
  const [polled, setPolled] = useState<PolledPrompt[]>([]);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<TerminalToast[]>([]);
  /** A decision POST is in flight: resume-reconciliation must never race it. */
  const decisionInFlight = useRef(false);
  const recent = useRef(new Map<string, number>());
  const sentReview = useRef(new Set<string>());
  /** 推送终态通知的本地序号（跨实例推送没有服务端 seq，用递增序号保证 toast id 唯一）。 */
  const pushedTerminalSeqRef = useRef(0);
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

  // Draggable dock: the whole corner stack can be repositioned by dragging its grip.
  const [dockOffset, setDockOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  function onDragStart(e: PointerEvent) {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: dockOffset.x,
      baseY: dockOffset.y,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  }
  function onDragMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setDockOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
  }
  function onDragEnd(e: PointerEvent) {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function dismissCardLocally(
    cardKey: string,
    sessionId: string,
    callOrReqId: string | number,
    approvalId?: string,
    requestId?: number,
    generation?: number,
    runtimeInstanceId?: string,
  ) {
    const idStr = String(callOrReqId);
    const identityKey = approvalId
      ? permissionInstanceKey(sessionId, { call_id: idStr, approval_id: approvalId })
      : requestId !== undefined
        ? permissionInstanceKey(sessionId, {
          call_id: idStr,
          runtime_instance_id: runtimeInstanceId,
          request_id: requestId,
          generation,
        })
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
    // 手动停止、中途 steer、立即发送导致的 stopped 不是任务真正结束：
    // 不进右下角卡片、不响系统通知（连去重窗口都不占用）。
    if (kind === 'stopped') return;
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
    // 日常单纯的 stopped（中途打断/停止）已经在函数入口拦掉；这里只处理真正的完成/失败。
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
    // ── 跨实例增量订阅：待交互卡片与终态通知（无轮询、无整表重拉）──
    // review_asked 只对该会话做一次定向 pending 拉取（单会话小请求）；
    // review_resolved 按 id 就地移除；activity.terminal 直接推右下角通知。
    return onGlobalEvent((event) => {
      if (event.type === 'sync') {
        // 重连 / 唤醒对账：与服务端单真值进行绝对校准，消除半开断线期间遗留的幽灵审批卡片
        void reconcileAuthoritativePending({ force: true });
        return;
      }
      if (event.type === 'session_upsert') {
        const row = event.session;
        setHints((prev) => ({
          ...prev,
          [row.id]: { name: row.name, workingDir: row.working_dir },
        }));
        return;
      }
      if (event.type === 'review_asked') {
        const sessionId = event.session_id;
        void getChatPending(sessionId)
          .then((pending) => {
            setPolled((prev) => {
              const next = prev.filter((item) => item.sessionId !== sessionId);
              next.push({
                sessionId,
                permission: pending.permission,
                userInput: pending.user_input,
              });
              return next;
            });
          })
          .catch(() => {});
        return;
      }
      if (event.type === 'review_resolved') {
        const { session_id, approval_id, request_id } = event;
        setPolled((prev) => {
          const next = prev.filter((item) => {
            if (item.sessionId !== session_id) return true;
            if (approval_id && item.permission?.approval_id === approval_id) return false;
            if (request_id != null) {
              if (item.userInput?.request_id === request_id) return false;
            }
            return true;
          });
          if (next.length !== prev.length) return next;
          // id 未能直接命中：对该会话做一次定向核验，确实已无待交互才移除。
          if (prev.some((item) => item.sessionId === session_id)) {
            void getChatPending(session_id)
              .then((pending) => {
                if (pending.permission || pending.user_input) return;
                setPolled((cur) => cur.filter((item) => item.sessionId !== session_id));
              })
              .catch(() => {});
          }
          return prev;
        });
        return;
      }
      if (event.type === 'activity') {
        // 全局 activity 只用于侧栏/运行状态，绝不作为终态通知源：
        // 工具轮 / 子任务 / steer 期间都可能出现临时 terminal。
        // 真正的结束由本端回合的 done 处理器发出 `jeikcode:terminal` 事件。
        return;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 真正的终态通知只由本端回合的 done 处理器发出（带 finality 判定），
  // 全局 activity.terminal 不再参与。
  useEffect(() => {
    const onTerminal = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; kind?: TerminalKind }>).detail;
      if (!detail?.sessionId || !detail.kind) return;
      pushedTerminalSeqRef.current += 1;
      pushTerminal(detail.sessionId, detail.kind, pushedTerminalSeqRef.current);
    };
    window.addEventListener('jeikcode:terminal', onTerminal);
    return () => window.removeEventListener('jeikcode:terminal', onTerminal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let namesLoaded = false;

    // 冷启动仅拉取一次会话名称，后续绝对不周期性拉取全量会话列表
    async function initNamesOnce() {
      if (namesLoaded) return;
      namesLoaded = true;
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
        // Names are decorative.
      }
    }

    // 冷启动仅拉取一次审批模式初始状态，后续完全走事件广播，彻底拔除定时轮询
    getApprovalMode()
      .then((initMode) => {
        if (cancelled) return;
        setMode(initMode);
        modeRef.current = initMode;
      })
      .catch(() => {});

    void initNamesOnce();

    async function tick() {
      // 视口感知：前台且无活动时或在页面隐藏时，跳过空转请求，彻底释放 CPU
      if (typeof document !== 'undefined' && document.hidden) return;

      let runtime: Awaited<ReturnType<typeof getRuntimeSessions>> = [];
      let active: string[] = [];
      try {
        const [nextRuntime, nextActive] = await Promise.all([
          getRuntimeSessions(),
          getActiveChatSessions(),
        ]);
        if (cancelled) return;
        runtime = nextRuntime;
        active = nextActive;
      } catch {
        return;
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

    // 冷启动仅拉取一次初始状态，后续完全由单事件总线及卡片状态驱动，彻底拔除周期性定时轮询
    void tick();
    return () => {
      cancelled = true;
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
  const liveUserInput = liveReview?.userInput ?? null;
  const liveSessionId = liveReview?.sessionId ?? null;
  const chatPerm = allowPermission ? chatPermission : null;
  const chatPermRef = useRef(chatPerm);
  chatPermRef.current = chatPerm;

  async function reconcileAuthoritativePending(opts?: { force?: boolean }) {
    if (!opts?.force && typeof document !== 'undefined' && document.hidden) return;
    if (decisionInFlight.current) return;

    let runtime: Awaited<ReturnType<typeof getRuntimeSessions>> = [];
    let active: string[] = [];
    try {
      const [nextRuntime, nextActive] = await Promise.all([
        getRuntimeSessions(),
        getActiveChatSessions(),
      ]);
      runtime = nextRuntime;
      active = nextActive;
    } catch {
      return;
    }

    const ids = new Set(active);
    for (const row of runtime) {
      if (row.activity === 'waiting_approval' || row.activity === 'waiting_user_input') {
        ids.add(row.session_id);
      }
    }
    if (activeSession?.id) ids.add(activeSession.id);
    if (chatPermRef.current?.session_id) ids.add(chatPermRef.current.session_id);

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

    const validPrompts = prompts.filter((item): item is PolledPrompt => item !== null);
    setPolled(validPrompts);

    // 对前台正展示的 chatPerm 进行绝对真值校准：
    // 若服务端最新 pending 已无此 approval_id，说明已在异地端处理或已失效，就地撤卡并提示。
    const currentChatPerm = chatPermRef.current;
    if (currentChatPerm) {
      const sid = currentChatPerm.session_id;
      const targetPrompt = validPrompts.find((p) => p.sessionId === sid);
      const serverPending = targetPrompt?.permission;
      if (!stillPendingApproval(serverPending, { approval_id: currentChatPerm.approval_id, call_id: currentChatPerm.call_id })) {
        dismissCardLocally(
          `chat:${permissionInstanceKey(sid, currentChatPerm)}`,
          sid,
          currentChatPerm.call_id,
          currentChatPerm.approval_id,
        );
        onDismissChatPermission();
        showToast(tRef.current('perm.stale'), 'info');
      }
    }
  }

  const permissionCards: Array<{
    key: string;
    sessionId: string;
    approval_id?: string;
    runtime_instance_id?: string;
    generation?: number;
    request_id?: number;
    tool_name: string;
    reason: string;
    call_id: string;
    arguments: unknown;
    live: boolean;
  }> = [];
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

  // 卡片可能比审批活得更久：用户把弹窗晾了几个小时后，该审批可能早已在别的实例
  // 被处理（或回合已结束），而本该清掉它的 SSE 可能已经静默断连——留在屏幕上的
  // 卡片看起来还能点，实际每次都撞在已被消费的路由上。用户回来的那一刻（窗口
  // 重新获得焦点 / 页面恢复可见）向 daemon 复核一次，确认不再是同一个审批就撤掉。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let lastCheck = 0;
    const verify = () => {
      const now = Date.now();
      // 焦点事件会连发（alt-tab / devtools），2s 内只复核一次。
      if (now - lastCheck < 2000) return;
      lastCheck = now;
      void reconcileAuthoritativePending({ force: true });
    };
    window.addEventListener('focus', verify);
    document.addEventListener('visibilitychange', verify);
    return () => {
      window.removeEventListener('focus', verify);
      document.removeEventListener('visibilitychange', verify);
    };
  }, []);

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
        ? `${t('perm.title')}: ${currentCard.card.tool_name}`
        : `${t('ask.title')}: ${currentCard.card.req.header || currentCard.card.req.question}`;
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

  // Route the current interactive card: when it belongs to the ACTIVE session and the
  // window is in the foreground, show it as a NON-BLOCKING centered modal (the user can
  // still click the rest of the UI); otherwise it stays in the bottom-right dock.
  const activeId = activeSession?.id ?? null;
  const centerCurrent =
    !isMobile &&
    !!currentCard &&
    !!activeId &&
    currentCard.card.sessionId === activeId &&
    !windowAway();
  const showDock = !centerCurrent || toasts.length > 0 || totalCards > 1;

  // The one interactive card (permission / question), rendered in the dock OR the
  // centered stage. `isCenter` drops the session label (the centered card already sits
  // in front of the active session) and switches the card to its non-blocking stage.
  const renderActiveCard = (mode: 'dock' | 'center') => {
    if (!currentCard) return null;
    const isCenter = mode === 'center';
    if (currentCard.kind === 'permission') {
      return (
        <section class="notify-item" key={currentCard.card.key}>
          {!isCenter && (
            <button
              type="button"
              class="notify-session"
              onClick={() => onFocusSession(currentCard.card.sessionId)}
            >
              {labelFor(currentCard.card.sessionId)}
            </button>
          )}
          <PermissionCard
            dock={!isCenter}
            center={isCenter}
            req={{
              session_id: currentCard.card.sessionId,
              approval_id: currentCard.card.approval_id,
              tool_name: currentCard.card.tool_name,
              reason: currentCard.card.reason,
              call_id: currentCard.card.call_id,
              arguments: currentCard.card.arguments,
            }}
            onDone={() => {
              if (currentCard.card.live) {
                const runtimeInstanceId = currentCard.card.runtime_instance_id;
                const generation = currentCard.card.generation;
                const requestId = currentCard.card.request_id;
                if (!runtimeInstanceId || generation === undefined || requestId === undefined) {
                  return;
                }
                dismissCardLocally(
                  currentCard.card.key,
                  currentCard.card.sessionId,
                  currentCard.card.call_id,
                  undefined,
                  requestId,
                  generation,
                  runtimeInstanceId,
                );
                onDismissLivePermission(
                  runtimeInstanceId,
                  generation,
                  requestId,
                  currentCard.card.call_id,
                );
                return;
              }
              dismissCardLocally(
                currentCard.card.key,
                currentCard.card.sessionId,
                currentCard.card.call_id,
                currentCard.card.approval_id,
                currentCard.card.request_id,
                currentCard.card.generation,
                currentCard.card.runtime_instance_id,
              );
              if (chatPerm && chatPerm.approval_id === currentCard.card.approval_id)
                onDismissChatPermission();
            }}
            onDecide={async (decision, toolName) => {
              decisionInFlight.current = true;
              try {
                const result = await respondPermission(
                  currentCard.card.sessionId,
                  currentCard.card.approval_id ?? '',
                  decision,
                  toolName,
                );
                const retired = permissionRetiredInfo(result);
                if (retired) {
                  // Already applied (lost reply / another client) or dead for good:
                  // retrying this exact approval can never succeed. The card retires
                  // and explains why through `onRetired`.
                  throw new PermissionRetiredError(retired);
                }
                if (!result.success) {
                  throw new Error(result.error ?? 'permission request is no longer pending');
                }
              } finally {
                decisionInFlight.current = false;
              }
            }}
            onRetired={() => showToast(tRef.current('perm.stale'), 'info')}
          />
        </section>
      );
    }
    return (
      <section class="notify-item" key={currentCard.card.key}>
        {!isCenter && (
          <button
            type="button"
            class="notify-session"
            onClick={() => onFocusSession(currentCard.card.sessionId)}
          >
            {labelFor(currentCard.card.sessionId)}
          </button>
        )}
        <UserInputCard
          dock={!isCenter}
          center={isCenter}
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
    );
  };

  return (
    <>
      {centerCurrent && renderActiveCard('center')}
      {showDock && (
    <div
      class={`notify-dock ${isMobile && mobileExpanded ? 'mobile-dock-expanded' : ''}`}
      aria-live="polite"
      style={{ transform: `translate(${dockOffset.x}px, ${dockOffset.y}px)` }}
    >
      <div
        class="notify-drag-handle"
        title={t('notify.drag')}
        aria-label={t('notify.drag')}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      />
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
      {!centerCurrent && renderActiveCard('dock')}
    </div>
      )}
    </>
  );
}
