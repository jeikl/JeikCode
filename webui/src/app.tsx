// Two-column layout: sidebar + chat, header with cwd breadcrumb + config.
// VSCode design system: timeline messages, violet brand, floating input.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { Chat } from './components/Chat';
import { Sidebar } from './components/Sidebar';
import { RenameDialog, DeleteDialog } from './components/SessionDialogs';
import { CwdPicker } from './components/CwdPicker';
import { LegacyMigrationModal } from './components/LegacyMigrationModal';
import { DesktopClosePromptDialog } from './components/DesktopClosePromptDialog';
import { onboardingDone } from './lib/onboarding';
import { LiveReviewState, NotificationDock } from './components/NotificationDock';
import { onGlobalEvent, startGlobalEventStream } from './lib/globalEvents';
import { clearCompletedBadgeIds, isUserDrivenScroll, nextCompletedBadgeIds } from './lib/completedBadge';
import { RemoteAccessControl } from './components/RemoteAccessControl';
import { resolvePendingAfterDecision } from './lib/pendingPermission';
import { ToastHost, showToast } from './components/Toast';
import { ConfirmModalHost } from './components/ConfirmDialog';
import { parseFilePathAndLines } from './lib/displayPath';
import { dropEditorTabSnapshot, mainEditorStateKey } from './lib/editorTabState';
import { languageOptions } from './i18n';

// 动态按需懒加载非首屏必需的独立弹窗，削减冷启动初始 JS 解析开销。
// 注意：**每次启动都会渲染**的弹窗绝不能放进这里——懒加载它们没有收益，
// 反而会在启动时和同一边界内的其它 lazy 组件竞争，Preact 可能把被抛出的
// Suspense Promise 记成 Uncaught (in promise)。这两个组件改为静态导入。
const ThemeDialog = lazy(() => import('./components/SettingsDialogs').then((m) => ({ default: m.ThemeDialog })));
const LanguageDialog = lazy(() => import('./components/SettingsDialogs').then((m) => ({ default: m.LanguageDialog })));
const ModelConfigDialog = lazy(() => import('./components/SettingsDialogs').then((m) => ({ default: m.ModelConfigDialog })));
const OnboardingWizard = lazy(() => import('./components/OnboardingWizard').then((m) => ({ default: m.OnboardingWizard })));
const UpdateDialog = lazy(() => import('./components/UpdateDialog').then((m) => ({ default: m.UpdateDialog })));
const ConfigSyncModal = lazy(() => import('./components/ConfigSyncModal').then((m) => ({ default: m.ConfigSyncModal })));
const SystemSettingsDialog = lazy(() => import('./components/SystemSettingsDialog').then((m) => ({ default: m.SystemSettingsDialog })));

/** 每个懒加载弹窗独占一个 Suspense 边界：共享边界时，一次 import 解析后的
 *  retry 会连带重渲染仍 pending 的兄弟 lazy 组件，Preact 在分离子树上可能把
 *  抛出的 Promise 变成 unhandled rejection（控制台 “Uncaught (in promise) Promise”）。 */
function LazyBoundary({ children }: { children: ComponentChildren }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
import {
  getProject,
  getConfig,
  getModels,
  changeDir,
  resolveSession,
  createSession,
  getSession,
  getActiveChatSessions,
  getChatPending,
  getHealth,
  checkUpdate,
  fetchUpgradeDiffs,
  postSessionSeen,
  UpdateCheckResponse,
  ConfigDiffItem,
  SessionMetaWithProject,
} from './api';
import { useT, useSettings, SettingsSection } from './settings';
import { setStreamEpoch } from './lib/streamCursor';
import { sessionMessagesToMarkdownLines } from './lib/historyMessages';
import { onSoftRefresh, requestSoftRefresh } from './lib/appRefresh';
import {
  buildRestoreCandidates,
  forgetRememberedSession,
  readRememberedSession,
  rememberSession,
  type RememberedSession,
} from './lib/navState';

// 从 URL (?session=<id>) 读取要打开的会话 id（短 id），用于刷新后恢复。
function readSessionIdFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('session');
  } catch {
    return null;
  }
}

// URL 里只放 UUID 前 8 位以缩短地址；刷新时按前缀在会话列表里还原成完整 id。
function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/** 用本地记忆拼一个首帧元数据，避免刷新时标题头闪成“新建对话”并让历史加载立即有项目桶。 */
function rememberedSessionToMeta(
  remembered: RememberedSession | null,
): SessionMetaWithProject | null {
  if (!remembered?.id) return null;
  return {
    id: remembered.id,
    name: remembered.name ?? remembered.id.slice(0, 8),
    working_dir: remembered.working_dir ?? '',
    created_at: 0,
    updated_at: remembered.updated_at ?? 0,
    message_count: remembered.message_count ?? 0,
    project_hash: remembered.project_hash ?? '',
  };
}

export function App() {
  const t = useT();
  const { theme, setTheme, lang, setLang } = useSettings();
  // 刷新恢复优先级：URL 里的短 id（可分享/可直达）> 本浏览器上次选中的完整会话 id。
  // 跨设备/无痕冷启动两者都没有，才真正回到新建落地页。
  const urlSessionRef = useRef<string | null>(readSessionIdFromUrl());
  const rememberedSessionRef = useRef<RememberedSession | null>(readRememberedSession());
  // URL 指向的就是本地记忆里的同一条会话时，首帧直接复用它的标题/项目桶；
  // 若 URL 指向别的会话，则以 URL 为准，等 resolve 后用真实元数据覆盖。
  const rememberedPreviewRef = useRef<SessionMetaWithProject | null>(null);
  const rememberedPreviewReadyRef = useRef(false);
  if (!rememberedPreviewReadyRef.current) {
    rememberedPreviewReadyRef.current = true;
    const remembered = rememberedSessionRef.current;
    const urlId = urlSessionRef.current;
    if (remembered?.id && (!urlId || remembered.id.startsWith(urlId))) {
      rememberedPreviewRef.current = rememberedSessionToMeta(remembered);
    }
  }
  const restoreCandidatesRef = useRef<string[]>([]);
  const restoreTargetsReadyRef = useRef(false);
  if (!restoreTargetsReadyRef.current) {
    restoreTargetsReadyRef.current = true;
    restoreCandidatesRef.current = buildRestoreCandidates(
      urlSessionRef.current,
      rememberedSessionRef.current?.id ?? null,
    );
  }
  const firstUrlSync = useRef(true);
  const [restoring, setRestoring] = useState<boolean>(
    () => restoreCandidatesRef.current.length > 0,
  );
  // URL 里是短 id，必须等 resolve 成完整 id 后再进会话；但若 URL 与本地记忆
  // 指向同一条会话，可以直接用完整 id 先挂载，让侧栏首帧就高亮选中的那一行，
  // 由 restoring 抑制落地页，等 resolve 回来再校准元数据。
  const [sessionId, setSessionId] = useState<string | null>(() =>
    rememberedPreviewRef.current?.id ?? null,
  );
  const [activeSession, setActiveSession] = useState<SessionMetaWithProject | null>(
    () => rememberedPreviewRef.current,
  );
  // 乐观会话集合：让新创建/首条消息发出的会话即时出现在侧栏（即使切到其他会话也不丢失）。
  // 当后端列表出现同 id 的真实会话后，Sidebar 的 mergeOptimisticSessions 会自动以落盘条目为准去重。
  const [optimisticSessions, setOptimisticSessions] = useState<Record<string, SessionMetaWithProject>>({});
  const [cwd, setCwd] = useState(() => rememberedPreviewRef.current?.working_dir ?? '');
  // Physical session-bucket hash of the current project. The sidebar scopes its
  // list by this (see Sidebar `projectHash`), not by the `cwd` string, so a
  // session whose stored `working_dir` was restamped by the daemon's global
  // working_dir can't leak into the wrong project. Tracked alongside `cwd`.
  const [projectHash, setProjectHash] = useState(
    () => rememberedPreviewRef.current?.project_hash ?? '',
  );
  const [pending, setPending] = useState<any | null>(null);
  const [liveReview, setLiveReview] = useState<LiveReviewState | null>(null);
  // 跨实例增量流（每实例一条）：侧栏/通知 dock 各自订阅自己需要的增量，
  // 全程按 id 就地 upsert/remove，无周期性轮询、无整表重拉。
  useEffect(() => startGlobalEventStream(), []);
  // 待交互卡在别处被解决时，同步清掉本实例正在展示的卡片状态；重连 sync 时对齐当前会话状态。
  useEffect(
    () =>
      onGlobalEvent((event) => {
        if (event.type === 'sync') {
          if (sessionId) {
            void getChatPending(sessionId)
              .then((p: any) => {
                setPending((cur: any | null) => {
                  if (!cur || cur.session_id !== sessionId) return cur;
                  if (!p.permission || p.permission.approval_id !== cur.approval_id) {
                    return null;
                  }
                  return cur;
                });
              })
              .catch(() => {});
          }
          return;
        }
        if (event.type === 'session_mode') {
          if (event.session_id && sessionId === event.session_id) {
            setActiveSession((prev) => (prev ? { ...prev, approval_mode: event.mode } : prev));
          }
          return;
        }
        // 跨实例删除：任意端删了当前会话，本端必须回落地页。
        // （本地侧栏删除走 onSessionDeleted；这里补齐异地/其它标签页的路径。）
        if (event.type === 'session_deleted') {
          handleSessionDeleted(event.session_id);
          return;
        }
        // 运行圈圈 / 完成对勾同源：全局 activity 广播携带内核权威终态。
        if (event.type === 'activity') {
          setJustCompletedIds((prev) =>
            nextCompletedBadgeIds(prev, {
              sessionId: event.session_id,
              running: event.running,
              terminal: event.terminal,
            }),
          );
          return;
        }
        // 任意实例打开/查看过该会话：所有实例一起熄灭这个一次性徽标。
        if (event.type === 'session_seen') {
          clearJustCompleted(event.session_id);
          return;
        }
        if (event.type !== 'review_resolved') return;
        setPending((cur: any | null) => {
          if (!cur) return cur;
          if (event.approval_id && cur.approval_id === event.approval_id) return null;
          if (event.request_id != null && cur.request_id === event.request_id) return null;
          return cur;
        });
        setLiveReview((cur) => {
          if (!cur) return cur;
          if (!event.session_id || cur.sessionId !== event.session_id) return cur;
          // 审批卡（permission）与提问卡（user input）都必须能被异地解决事件关掉；
          // 否则另一实例已放行的卡片会在此永久停留，形成幽灵审批。
          if (!cur.userInput) {
            // 审批卡的解析事件带 approval_id；带 request_id 时按调用方请求号精确匹配。
            if (event.approval_id) return null;
            if (event.request_id != null && cur.permission?.request_id !== event.request_id) {
              return cur;
            }
            return null;
          }
          const rid = (cur.userInput as any)?.request_id;
          if (event.request_id != null && rid !== event.request_id) return cur;
          return null;
        });
      }),
    [sessionId],
  );
  const dismissLiveReview = useRef({
    permission: (_runtimeInstanceId: string, _generation: number, _requestId: number, _callId: string) => {},
    userInput: () => {},
  });
  const onLiveReview = useCallback((review: LiveReviewState) => {
    setLiveReview((prev) => {
      if (
        prev
        && prev.sessionId === review.sessionId
        && (prev.permission?.runtime_instance_id ?? '') === (review.permission?.runtime_instance_id ?? '')
        && (prev.permission?.generation ?? -1) === (review.permission?.generation ?? -1)
        && (prev.permission?.request_id ?? -1) === (review.permission?.request_id ?? -1)
        && (prev.userInput?.request_id ?? -1) === (review.userInput?.request_id ?? -1)
      ) {
        return prev;
      }
      return review;
    });
  }, []);
  const onBindReviewDismiss = useCallback((fns: {
    permission: (runtimeInstanceId: string, generation: number, requestId: number, callId: string) => void;
    userInput: () => void;
  }) => {
    dismissLiveReview.current = fns;
  }, []);
  const [showCwd, setShowCwd] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionListVersion, setSessionListVersion] = useState(0);
  const [liveRunningIds, setLiveRunningIds] = useState<Set<string>>(() => new Set());
  /**
   * 刚完成、还没被点开看过的会话（侧栏绿色对勾）。
   *
   * 与蓝圈圈同源：都由全局 `activity` 广播驱动，所以多端/多标签页同步。
   * 只有内核权威终态 `terminal === 'completed'`（计时器真正停止的完成）才点亮，
   * 用户停止 / 失败（`stopped` / `failed`）绝不点亮；点进该会话或它再次开跑即消失，
   * 只显示一次，不做持久化。
   */
  const [justCompletedIds, setJustCompletedIds] = useState<Set<string>>(() => new Set());

  // 正在观察的会话完成时也会亮勾：只要窗口重新获得焦点，或用户真正滚动/拖动它，
  // 就视为「已看过」——本实例熄灭并广播给其它实例。
  // 只认用户手势（滚轮 / 触摸 / 拖动滚动条 / 键盘）之后的滚动：回合收尾自身的
  // “跟随到底”属于程序化滚动，绝不能把刚亮起的勾瞬间吞掉。
  useEffect(() => {
    const sid = sessionId;
    if (!sid || !justCompletedIds.has(sid)) return;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      markSessionSeen(sid);
    };

    const timeline = document.querySelector('.messages-container');
    let lastUserInputAt = 0;
    let pointerDown = false;
    const noteUserInput = () => {
      lastUserInputAt = Date.now();
    };
    const onPointerDown = () => {
      pointerDown = true;
      noteUserInput();
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (!timeline || !target || !timeline.contains(target)) return;
      if (!isUserDrivenScroll({ now: Date.now(), lastUserInputAt, pointerDown })) return;
      dismiss();
    };

    window.addEventListener('focus', dismiss);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', noteUserInput);
    timeline?.addEventListener('wheel', noteUserInput, { passive: true });
    timeline?.addEventListener('touchmove', noteUserInput, { passive: true });
    timeline?.addEventListener('pointerdown', onPointerDown);
    timeline?.addEventListener('focusin', dismiss);
    // scroll 不冒泡，必须在捕获阶段监听（拖动滚动条也只发 scroll）。
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('focus', dismiss);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', noteUserInput);
      timeline?.removeEventListener('wheel', noteUserInput);
      timeline?.removeEventListener('touchmove', noteUserInput);
      timeline?.removeEventListener('pointerdown', onPointerDown);
      timeline?.removeEventListener('focusin', dismiss);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [sessionId, justCompletedIds]);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // 表头会话菜单改用 fixed 定位，避免被祖先 overflow/层叠裁剪；记录锚点坐标。
  const [headerMenuPos, setHeaderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [headerDialog, setHeaderDialog] = useState<'rename' | 'delete' | null>(null);
  const [headerExporting, setHeaderExporting] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // 升级检测与配置同步状态
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [configDiffs, setConfigDiffs] = useState<ConfigDiffItem[] | null>(null);

  useEffect(() => {
    // 软刷新：不重挂任何组件，只让侧栏/运行态重新对账；
    // 焦点、滚动位置、展开状态与终端连接全部原地保留。
    return onSoftRefresh(() => {
      setSessionListVersion((v) => v + 1);
      getActiveChatSessions()
        .then((ids) => {
          setLiveRunningIds((prev) => {
            const next = new Set(ids);
            if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
            return next;
          });
        })
        .catch(() => {});
    });
  }, []);

  // 右上角工具栏收纳菜单（更多操作：刷新、远程访问、更新、主题切换）
  const [topNavMoreOpen, setTopNavMoreOpen] = useState(false);
  const topNavMoreRef = useRef<HTMLDivElement | null>(null);

  // 顶栏电脑端语言切换下拉框状态
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!langMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [langMenuOpen]);

  // 顶栏自适应收纳：监听 header 实际宽度，桌面窗口缩窄时及时收纳到三个点
  const [headerWidth, setHeaderWidth] = useState<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );

  // ── 活跃会话运行态（蓝圈圈）幂等校准：每 12 秒与后端权威 active_chats 列表对齐一次，彻底消灭幽灵转圈卡死 ──
  useEffect(() => {
    let cancelled = false;
    const reconcileRunning = () => {
      getActiveChatSessions()
        .then((serverActiveIds) => {
          if (cancelled) return;
          setLiveRunningIds((prev) => {
            if (prev.size === 0 && serverActiveIds.length === 0) return prev;
            const next = new Set<string>();
            for (const id of serverActiveIds) {
              next.add(id);
            }
            if (prev.size === next.size && [...prev].every((id) => next.has(id))) {
              return prev;
            }
            return next;
          });
        })
        .catch(() => {});
    };

    reconcileRunning();
    const timer = window.setInterval(reconcileRunning, 12000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 断点续传游标的纪元 = daemon 实例身份。重启后 `session_seq` 从 0 重算，
  // 旧游标必须作废，否则新一轮长过旧游标后，服务端只补 `seq > 旧游标` 的帧，
  // 当前回合前半段（开场提问、最初思考与工具）被静默跳过。
  // 静默重启（崩溃 / 重启机器）不会触发升级弹层的 reload，所以这里持续轮询：
  // 纪元一变，旧游标立即失效，下一次重连走全量幂等补发。
  useEffect(() => {
    let cancelled = false;
    const syncEpoch = () => {
      getHealth()
        .then((info) => {
          if (!cancelled) setStreamEpoch(info.instance_id ?? null);
        })
        .catch(() => {
          /* health 不可用：保持上一个已知纪元；从未拿到过则游标一律视为无效 */
        });
    };
    syncEpoch();
    const timer = window.setInterval(syncEpoch, 15000);
    // 手机回前台 / 网络恢复往往正是重连前一瞬：先校准纪元，避免带着旧游标发起补发。
    const onVisible = () => {
      if (!document.hidden) syncEpoch();
    };
    window.addEventListener('focus', syncEpoch);
    window.addEventListener('online', syncEpoch);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', syncEpoch);
      window.removeEventListener('online', syncEpoch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!headerMenuRef.current) return;
    const updateWidth = () => {
      if (headerMenuRef.current) {
        setHeaderWidth(headerMenuRef.current.clientWidth);
      }
    };
    updateWidth();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setHeaderWidth(entry.contentRect.width);
        }
      });
      ro.observe(headerMenuRef.current);
    }
    window.addEventListener('resize', updateWidth);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  const isHeaderCompact = headerWidth < 820;
  const isHeaderUltraCompact = headerWidth < 560;

  useEffect(() => {
    if (!topNavMoreOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.modal-overlay, .modal-card, .remote-access-modal-overlay, .remote-access-modal-card, .confirm-modal-overlay, .confirm-dialog-card')) {
        return;
      }
      if (topNavMoreRef.current && !topNavMoreRef.current.contains(e.target as Node)) {
        setTopNavMoreOpen(false);
      }
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [topNavMoreOpen]);

  // VSCode-style open diff tabs in the session header
  const [diffTabs, setDiffTabs] = useState<any[]>([]);
  const [activeMainTabId, setActiveMainTabId] = useState<string>('chat');
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // 顶部主标签栏滚轮水平滑动与激活标签自动居中 (在 activeMainTabId 声明之后定义，避免 TDZ 报错)
  const handleTabsWheel = (e: WheelEvent) => {
    if (tabsContainerRef.current) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        tabsContainerRef.current.scrollLeft += e.deltaY;
      }
    }
  };

  useEffect(() => {
    if (!tabsContainerRef.current || activeMainTabId === 'chat') return;
    const activeEl = tabsContainerRef.current.querySelector('.header-editor-tab.active');
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeMainTabId]);

  // 移动端顶部会话与Diff标签下拉收纳状态
  const [mobileTabsDropdownOpen, setMobileTabsDropdownOpen] = useState(false);
  const mobileTabsDropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部自动关闭移动端收纳下拉菜单
  useEffect(() => {
    if (!mobileTabsDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        mobileTabsDropdownOpen &&
        mobileTabsDropdownRef.current &&
        !mobileTabsDropdownRef.current.contains(target)
      ) {
        setMobileTabsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [mobileTabsDropdownOpen]);

  // 桌面端/Web 原生通知权限：在用户首次交互后温和请求，保障失焦通知能调起系统原生弹窗
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (window.Notification.permission === 'default') {
        const handler = () => {
          void window.Notification.requestPermission();
          window.removeEventListener('click', handler);
          window.removeEventListener('keydown', handler);
        };
        window.addEventListener('click', handler, { once: true });
        window.addEventListener('keydown', handler, { once: true });
      }
    }
  }, []);

  // 右上角模型选择器插槽宿主 DOM 元素
  const [topModelSlot, setTopModelSlot] = useState<HTMLElement | null>(null);

  const handleCloseDiffTab = (tabId: string) => {
    const closing = diffTabs.find((t) => t.id === tabId);
    if (closing?.type === 'editor' && closing.filePath) {
      dropEditorTabSnapshot(mainEditorStateKey(closing.filePath));
    }
    setDiffTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeMainTabId === tabId) {
        if (next.length > 0) {
          setActiveMainTabId(next[next.length - 1]!.id);
        } else {
          setActiveMainTabId('chat');
        }
      }
      return next;
    });
  };

  // 顶部主标签栏拖拽与排序状态
  const [isMainTabsDragOver, setIsMainTabsDragOver] = useState(false);
  const [mainTabDragIdx, setMainTabDragIdx] = useState<number | null>(null);
  const [mainTabOverIdx, setMainTabOverIdx] = useState<number | null>(null);

  const handleOpenFile = (
    filePath: string,
    insertIndex?: number,
    targetStartLine?: number,
    targetEndLine?: number,
  ) => {
    const { filePath: cleanRaw, startLine: parsedStart, endLine: parsedEnd } = parseFilePathAndLines(filePath);
    const startLine = targetStartLine ?? parsedStart;
    const endLine = targetEndLine ?? parsedEnd;
    let normPath = (cleanRaw || '').trim().replace(/\\/g, '/');
    if (!/^[a-zA-Z]:\//.test(normPath) && !normPath.startsWith('/') && cwd) {
      const base = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      normPath = `${base}/${normPath.replace(/^\.?\/+/, '')}`;
    }
    if (/^[a-z]:\//.test(normPath)) {
      normPath = normPath[0].toUpperCase() + normPath.slice(1);
    }
    const tabId = `editor_${normPath}`;
    const existingIdx = diffTabs.findIndex((t) => t.id === tabId || (t.type === 'editor' && t.filePath === normPath));
    if (existingIdx !== -1) {
      const targetTabId = diffTabs[existingIdx]?.id || tabId;
      const next = [...diffTabs];
      if (next[existingIdx]) {
        next[existingIdx] = {
          ...next[existingIdx],
          startLine,
          endLine,
        };
        if (insertIndex !== undefined && insertIndex !== existingIdx) {
          const [item] = next.splice(existingIdx, 1);
          const targetSlot = insertIndex > existingIdx ? insertIndex - 1 : insertIndex;
          next.splice(targetSlot, 0, item);
        }
        setDiffTabs(next);
      }
      setActiveMainTabId(targetTabId);
      return;
    }
    const fileName = normPath.split(/[\\/]/).pop() || normPath;
    const ext = fileName.split('.').pop() || 'FILE';
    const newTab = {
      id: tabId,
      type: 'editor',
      fileName,
      filePath: normPath,
      fileStatus: ext.slice(0, 3).toUpperCase(),
      startLine,
      endLine,
    };
    setDiffTabs((prev) => {
      if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= prev.length) {
        const next = [...prev];
        next.splice(insertIndex, 0, newTab);
        return next;
      }
      return [...prev, newTab];
    });
    setActiveMainTabId(tabId);
  };

  // 全局文件打开事件广播监听 (例如 Markdown 相对链接点击、文件树定位等)
  useEffect(() => {
    const onOpenFileEvent = (e: any) => {
      const p = e.detail?.path;
      if (p) {
        handleOpenFile(p, undefined, e.detail?.startLine, e.detail?.endLine);
      }
    };
    window.addEventListener('jeikcode:open_file', onOpenFileEvent);
    return () => window.removeEventListener('jeikcode:open_file', onOpenFileEvent);
  }, [diffTabs, cwd]);

  // 监听全局主视图切换广播 (例如从侧边栏快捷回到对话主舞台)
  useEffect(() => {
    const onSwitchTab = (e: any) => {
      const tab = e.detail;
      if (typeof tab === 'string') {
        setActiveMainTabId(tab);
      }
    };
    window.addEventListener('jeikcode:switch_main_tab', onSwitchTab);
    return () => window.removeEventListener('jeikcode:switch_main_tab', onSwitchTab);
  }, []);

  // 全局拖拽防护与解绑：彻底解除拖动限制，杜绝光标在未监听区域出现禁止图标，
  // 并阻止原生浏览器/WebView 将网页直接导航替换为所拖动文件的默认行为。
  // 使用捕获阶段 (capture: true) 拦截 dragenter/dragover，确保在进入任何子元素前已标记 copy 效果，绝不闪现禁止图标！
  useEffect(() => {
    const handleGlobalDragOver = (e: DragEvent) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      if (!dt) return;
      // WebView2 比 Chrome 严：dropEffect 不在 effectAllowed 里时，光标直接变成禁止。
      // 预览标签只允许 move，这里若写死 copy，拖到编辑区就会一直是禁止。
      const allowed = dt.effectAllowed;
      dt.dropEffect =
        allowed === 'move' || allowed === 'linkMove'
          ? 'move'
          : allowed === 'link' || allowed === 'copyLink'
            ? 'link'
            : 'copy';
    };
    const handleGlobalDrop = (e: DragEvent) => {
      e.preventDefault();
      try {
        // `.chat-stage` 内部有自己的落点：主会话区开主标签、右侧预览区开预览标签。
        // 全局兜底只处理舞台之外的拖放，否则同一份文件会被两边同时打开
        //（这就是 .md 同时出现在右侧预览和主会话区的根因之一）。
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('.chat-stage')) return;
        const raw = e.dataTransfer?.getData('application/jeikcode-tab');
        const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
        const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
        if (targetPath && typeof targetPath === 'string' && targetPath.trim()) {
          window.dispatchEvent(new CustomEvent('jeikcode:switch_right_tab', { detail: 'preview' }));
          window.dispatchEvent(
            new CustomEvent('jeikcode:preview:open_file', {
              detail: typeof data === 'object' && data?.filePath ? data : { filePath: targetPath.trim() },
            }),
          );
          return;
        }
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          for (let i = 0; i < e.dataTransfer.files.length; i++) {
            const file = e.dataTransfer.files[i];
            const p = (file as any).path || file.name;
            if (p) {
              window.dispatchEvent(new CustomEvent('jeikcode:switch_right_tab', { detail: 'preview' }));
              window.dispatchEvent(
                new CustomEvent('jeikcode:preview:open_file', {
                  detail: { filePath: p, fileName: file.name },
                }),
              );
            }
          }
        }
      } catch {}
    };

    const listen = { capture: true, passive: false } as const;
    window.addEventListener('dragenter', handleGlobalDragOver, listen);
    window.addEventListener('dragover', handleGlobalDragOver, listen);
    window.addEventListener('drop', handleGlobalDrop, listen);
    document.addEventListener('dragenter', handleGlobalDragOver, listen);
    document.addEventListener('dragover', handleGlobalDragOver, listen);
    return () => {
      window.removeEventListener('dragenter', handleGlobalDragOver, listen);
      window.removeEventListener('dragover', handleGlobalDragOver, listen);
      window.removeEventListener('drop', handleGlobalDrop, listen);
      document.removeEventListener('dragenter', handleGlobalDragOver, listen);
      document.removeEventListener('dragover', handleGlobalDragOver, listen);
    };
  }, []);
  // Chat reports whether it is showing the centered landing (empty) state, so the
  // session-title header can hide on landing (matching the design's full-bleed hero).
  const [isLanding, setIsLanding] = useState(true);

  useEffect(() => {
    let desktop = false;
    try {
      desktop = new URLSearchParams(window.location.search).get('desktop') === '1';
    } catch {
      desktop = false;
    }
    if (!desktop || onboardingDone()) return;
    let cancelled = false;
    getModels()
      .then((models) => {
        if (!cancelled && models.length === 0) setShowOnboarding(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // Skills picked from the sidebar Skills menu → bumped so Chat inserts `/name `.
  const [skillInsert, setSkillInsert] = useState<{ name: string; seq: number } | null>(null);
  // 导航序列号：递增标记每次用户发起的会话/目录/新建切换。
  // 用于使网络飞行中已过期的异步操作（如 openNewSession 的 createSession）直接作废，
  // 彻底杜绝「在一个项目点新建后立即切到另一个项目会话，前一个异步请求晚到覆盖当前视图导致工作目录错乱与穿透」的竞态 BUG。
  const navSeqRef = useRef(0);

  // 关闭表头会话菜单：外部点击 / 滚动 / 缩放（fixed 菜单不跟随锚点，故一并关闭）。
  useEffect(() => {
    if (!headerMenuOpen) return;
    const close = () => setHeaderMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [headerMenuOpen]);

  // Chat 完成首条消息后会回传它创建的 session id；刷新侧栏列表。
  // `claimView=false`：只对齐侧栏/列表，绝不切换当前视图（用户在发送飞行期间已切走）。
  function handleSessionAssigned(id: string, opts?: { claimView?: boolean }) {
    // 把乐观条目的临时 id 对齐到后端真实 id（落地页发送时乐观条目用的是临时 id），
    // 这样接下来的列表刷新能按 id 去重，用真实条目（含自动命名）覆盖乐观条目。
    setOptimisticSessions((prev) => {
      const next: Record<string, SessionMetaWithProject> = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith('optimistic-') || key === id) {
          const item = next[key];
          delete next[key];
          if (item) next[id] = { ...item, id };
        }
      }
      return next;
    });
    // 只有仍在看这条 turn 归属的会话（或落地页）才把视图切过去；已切走时保持用户选择，
    // 新会话由侧栏列表与 /events 的 session_upsert 自行出现。
    if (id !== sessionId && opts?.claimView !== false) {
      setSessionId(id);
    }
    // 关键触发：一旦服务端确认会话分配，立即刷新侧栏，确保切换会话后该会话稳固展示
    setSessionListVersion((v) => v + 1);
  }

  // 首条消息发出瞬间：用消息前 10 字做临时标题，乐观插入侧栏（即时可见）。
  // 优先复用已创建会话的 id / 目录（新建按钮、切目录会预建会话）；落地页直发时
  // 还没有 id，先用临时 id，待 done 回传真实 id 后由 handleSessionAssigned 对齐。
  function handleOptimisticSession(title: string) {
    const now = Math.floor(Date.now() / 1000);
    const id = activeSession?.id ?? `optimistic-${now}`;
    const newSession: SessionMetaWithProject = {
      id,
      name: title,
      working_dir: activeSession?.working_dir ?? cwd,
      // Fall back to the current project's hash (not '') so the optimistic row
      // survives the sidebar's project_hash filter on a landing-page first send.
      project_hash: activeSession?.project_hash ?? projectHash,
      created_at: activeSession?.created_at ?? now,
      updated_at: now,
      message_count: 1,
    };
    setOptimisticSessions((prev) => ({
      ...prev,
      [id]: newSession,
    }));
    // 顶部标题头用的是 activeSession.name；首发时同步成临时标题（已有会话元数据时），
    // 否则标题头会一直停在占位名 session-<ts>。落地页首发无 activeSession，标题头本就
    // 隐藏，待回合结束列表刷新后由 handleActiveSessionMeta 回填真实标题。
    // 但如果用户已手动重命名过会话（名称非 session-xxx 格式），则不覆盖，保护用户选择。
    setActiveSession((prev) =>
      prev
        ? {
            ...prev,
            name: prev.name.startsWith('session-') ? title : prev.name,
          }
        : prev,
    );
  }

  // 侧栏列表（重新）加载后回传当前会话的真实元数据：回合落盘后后端已自动命名，
  // 用真实标题覆盖顶部标题头的临时标题（前 10 字）。仅在仍是同一会话且标题有变时更新。
  function handleActiveSessionMeta(s: SessionMetaWithProject) {
    setActiveSession((prev) =>
      prev && prev.id === s.id && prev.name !== s.name ? { ...prev, name: s.name } : prev,
    );
    // 当真实会话已经从后端拉出且已拥有消息时，才从乐观池移除对应的临时记录，杜绝首轮执行中断档消失
    setOptimisticSessions((prev) => {
      if (!prev[s.id]) return prev;
      if ((s.message_count ?? 0) === 0) return prev;
      const next = { ...prev };
      delete next[s.id];
      return next;
    });
  }

  // ☰：移动端专用，开/关抽屉。桌面端的收起/展开由侧栏自身的按钮处理。
  function toggleSidebar() {
    setSidebarOpen((o) => !o);
  }

  // Seed cwd from /project on mount（恢复会话时以会话目录为准，故只在仍为空时填充）
  useEffect(() => {
    let cancelled = false;
    getProject()
      .then((p) => {
        if (cancelled) return;
        if (p.working_dir) setCwd((c) => c || p.working_dir);
        if (p.project_hash) setProjectHash((h) => h || p.project_hash!);
      })
      .catch(() => {
        // Ignore; cwd stays empty
      });

    // 自动静默检测版本更新（遵循用户选定的通道，有新版本时点亮绿色向上箭头）
    const fetchLatestUpdate = () => {
      if (cancelled) return;
      const savedChannel = localStorage.getItem('jeikcode_update_channel') || undefined;
      checkUpdate(savedChannel)
        .then((res) => {
          if (!cancelled) setUpdateInfo(res);
        })
        .catch(() => {});
    };

    // 升级后首次启动配置覆盖检测（延迟执行，错峰避让冷启动首屏会话加载）
    const fetchConfigUpgrade = () => {
      if (cancelled) return;
      fetchUpgradeDiffs(true, false)
        .then((res) => {
          if (!cancelled && res.should_prompt && res.diffs.length > 0) {
            setConfigDiffs(res.diffs);
          }
        })
        .catch(() => {});
    };

    // 1.5 秒后自动静默检测版本与配置覆盖（错峰延迟）
    const updateTimer = setTimeout(() => {
      fetchLatestUpdate();
      fetchConfigUpgrade();
    }, 1500);

    // 每 15 分钟后台自动静默检测一次，保持更新时效性
    const updateInterval = setInterval(fetchLatestUpdate, 15 * 60 * 1000);

    // 窗口重新获得焦点时静默检测一次（防止开着网页期间发布了新版未及时同步）
    const onWindowFocus = () => {
      fetchLatestUpdate();
    };
    window.addEventListener('focus', onWindowFocus);

    return () => {
      cancelled = true;
      clearTimeout(updateTimer);
      clearInterval(updateInterval);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  const openUpdateDialogWithFreshCheck = () => {
    setShowUpdateDialog(true);
    const savedChannel = localStorage.getItem('jeikcode_update_channel') || undefined;
    checkUpdate(savedChannel)
      .then((res) => setUpdateInfo(res))
      .catch(() => {});
  };

  const handleManualCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    try {
      const savedChannel = localStorage.getItem('jeikcode_update_channel') || undefined;
      const res = await checkUpdate(savedChannel);
      setUpdateInfo(res);
      if (res.has_update) {
        setShowUpdateDialog(true);
      } else {
        showToast(t('update.latest', { version: res.current_version }), 'info');
      }
    } catch (e: any) {
      showToast(t('update.failed', { error: e?.message || String(e) }), 'error');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  // 把当前 session id（取前 8 位）同步进 URL，刷新后可恢复。
  useEffect(() => {
    const url = new URL(window.location.href);
    // 首次执行只负责“认领”首帧：若 URL 带短 id 而 sessionId 尚未还原，
    // 绝不能先把参数清掉；但标记必须消耗掉，否则之后新建会话时永远不会清 URL。
    const firstRun = firstUrlSync.current;
    firstUrlSync.current = false;
    if (sessionId) {
      const shortId = shortSessionId(sessionId);
      if (url.searchParams.get('session') !== shortId) {
        url.searchParams.set('session', shortId);
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
      return;
    }
    if (firstRun) return;
    if (url.searchParams.has('session')) {
      url.searchParams.delete('session');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, [sessionId]);

  // 同一浏览器刷新必须记住“当前选中哪个会话”，而不是每次当作冷启动。
  // 记住完整 id 与项目桶：下次挂载时 Sidebar 可立即展开对应项目，Chat 也可直接加载。
  useEffect(() => {
    if (!sessionId) return;
    if (activeSession?.id === sessionId) {
      const remembered: RememberedSession = {
        id: activeSession.id,
        project_hash: activeSession.project_hash,
        working_dir: activeSession.working_dir,
        name: activeSession.name,
        message_count: activeSession.message_count,
        updated_at: activeSession.updated_at,
      };
      rememberedSessionRef.current = remembered;
      rememberSession(remembered);
      return;
    }
    // 新分配的会话 id 还没拿到元数据：先记住 id，项目桶等 resolve 后补。
    if (rememberedSessionRef.current?.id !== sessionId) {
      const remembered: RememberedSession = { id: sessionId };
      rememberedSessionRef.current = remembered;
      rememberSession(remembered);
    }
  }, [sessionId, activeSession]);

  // 刷新后用 URL 短 id 或本地记忆的完整 id 还原会话（完整 id + project_hash + working_dir），
  // 再交给 Chat 加载历史。用 resolveSession（跨所有桶按 id 定位，不受 /sessions 的
  // 50 条上限影响），否则较旧的会话刷新后会找不到、回落到新建页。仅在挂载时执行一次。
  useEffect(() => {
    const candidates = restoreCandidatesRef.current;
    if (candidates.length === 0) return;
    let cancelled = false;
    void (async () => {
      let found: SessionMetaWithProject | null = null;
      // 只有所有候选都明确返回 404 才能判定“会话已不存在”。网络/daemon 500
      // 属于瞬时故障，绝不能顺手抹掉用户的导航记忆，否则下一次刷新也回不来。
      let transientError = false;
      for (const candidate of candidates) {
        try {
          found = await resolveSession(candidate);
        } catch {
          transientError = true;
          found = null;
        }
        if (cancelled) return;
        if (found) break;
      }
      if (cancelled) return;
      if (found) {
        setSessionId(found.id);
        setActiveSession(found);
        rememberedSessionRef.current = {
          id: found.id,
          project_hash: found.project_hash,
          working_dir: found.working_dir,
          name: found.name,
          message_count: found.message_count,
          updated_at: found.updated_at,
        };
        rememberSession(rememberedSessionRef.current);
        if (found.working_dir) setCwd(found.working_dir);
        if (found.project_hash) setProjectHash(found.project_hash);
        // URL 直达也是“已查看”：让其它实例的完成徽标一起熄灭。
        markSessionSeen(found.id);
      } else if (!transientError) {
        // 本地记忆确实已经失效（会话被删除 / 迁移）：同时清掉记忆和 URL 里的死参数，
        // 否则下一次刷新还会拿同一个 id 解析，再次落回落地页。
        rememberedSessionRef.current = null;
        forgetRememberedSession();
        const url = new URL(window.location.href);
        if (url.searchParams.has('session')) {
          url.searchParams.delete('session');
          window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
        setSessionId(null);
        setActiveSession(null);
      }
    })().finally(() => {
      if (!cancelled) setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全局拦截外部链接点击：确保以新标签页（或系统原生浏览器）打开，绝不覆盖 JeikCode WebUI
  useEffect(() => {
    function handleGlobalAnchorClick(e: MouseEvent) {
      const anchor = (e.target as HTMLElement)?.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (/^https?:\/\//i.test(href)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }
    }
    document.addEventListener('click', handleGlobalAnchorClick, { capture: true });
    return () => document.removeEventListener('click', handleGlobalAnchorClick, { capture: true });
  }, []);

  // 当 sessionId 改变，且 activeSession 的 id 与之不匹配时，自动解析/加载该会话的元数据。
  // 解决了在 TUI 或其他端中执行 /resume 切换会话、或新建会话后，webui 无法同步更新
  // activeSession、CWD 以及 projectHash 的问题。
  useEffect(() => {
    if (!sessionId) return;
    if (activeSession && activeSession.id === sessionId) return;

    let cancelled = false;
    resolveSession(sessionId)
      .then((found) => {
        if (cancelled || !found) return;
        setActiveSession(found);
        if (found.working_dir) setCwd(found.working_dir);
        if (found.project_hash) setProjectHash(found.project_hash);
        setSessionListVersion((v) => v + 1);
      })
      .catch((err) => {
        console.warn('[syncSession] resolve session failed:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 在指定目录下开启一个新建会话视图（草稿态，首条用户消息前绝不调用后端预创建，不占位不写盘）。
  function openNewSession(targetCwd: string | undefined) {
    navSeqRef.current++;
    // 用户明确点了“新建会话”：这是新的导航意图，必须同时清掉本浏览器的选中记忆，
    // 否则刷新会把旧会话又恢复出来。
    rememberedSessionRef.current = null;
    forgetRememberedSession();
    setSessionId(null);
    setActiveSession(null);
    if (targetCwd && targetCwd !== '~') {
      setCwd(targetCwd);
    }
  }

  function handleNewSession(targetDir?: string) {
    setSidebarOpen(false);
    setActiveMainTabId('chat');
    // Top-level 「新建对话」 stays in the current/serve workspace.
    openNewSession(targetDir || cwd || undefined);
  }

  /** 完成对勾是一次性提示：进入该会话即熄灭，绝不再重复出现。 */
  function clearJustCompleted(id: string) {
    setJustCompletedIds((prev) => clearCompletedBadgeIds(prev, id));
  }

  /**
   * 本实例打开了该会话：先本地熄灭，再广播给其它标签页 / 浏览器。
   * 徽标由全局 `activity` 点亮，熄灭必须走同一条全局总线，否则其它实例会残留幽灵勾。
   */
  function markSessionSeen(id: string) {
    if (!id) return;
    clearJustCompleted(id);
    void postSessionSeen(id).catch(() => {
      /* 旧 daemon / 离线：本实例已熄灭，下一次打开会再广播。 */
    });
  }

  function applySessionSelection(session: SessionMetaWithProject) {
    navSeqRef.current++;
    setSessionId(session.id);
    setActiveSession(session);
    setActiveMainTabId('chat');
    if (session.working_dir) {
      setCwd(session.working_dir);
    }
    if (session.project_hash) setProjectHash(session.project_hash);
    setSidebarOpen(false);
    markSessionSeen(session.id);
  }

  function handleSelectSession(session: SessionMetaWithProject) {
    navSeqRef.current++;
    applySessionSelection(session);
  }

  // 点击系统/桌面通知跳转会话与唤醒窗口
  useEffect(() => {
    const onFocusReq = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (!sid) return;
      try {
        window.focus();
      } catch {}
      resolveSession(sid)
        .then((found) => {
          if (found) handleSelectSession(found);
        })
        .catch(() => {});
    };
    window.addEventListener('jeikcode:focus-session', onFocusReq);
    return () => {
      window.removeEventListener('jeikcode:focus-session', onFocusReq);
    };
  }, []);

  // 切换工作目录：侧栏按新目录过滤会话，并在该目录下新建一个会话（落地、侧栏可见）。
  // 也是「切换项目」下拉选中另一个项目时的入口（真正切进去，而非只浏览）。
  function handlePickCwd(path: string) {
    navSeqRef.current++;
    setSidebarOpen(false);
    setCwd(path);
    // We don't know the new dir's bucket hash until the daemon creates a session
    // there; clear it so the sidebar falls back to filtering by `cwd` in the
    // meantime, then openNewSession's response re-pins projectHash.
    setProjectHash('');
    openNewSession(path || undefined);
  }

  // 当从外部（TUI `/cd` 等）收到工作目录变更通知时：
  // 更新 cwd 并拉取最新的项目信息以更新 projectHash。
  function handleCwdChanged(newCwd: string) {
    setCwd(newCwd);
    getProject()
      .then((p) => {
        if (p.project_hash) {
          setProjectHash(p.project_hash);
        }
        setSessionListVersion((v) => v + 1);
      })
      .catch((err) => {
        console.warn('[cwdChanged] failed to get project state:', err);
      });
  }

  // 删除会话：若删的是当前打开的会话，回到空白新对话。
  function handleSessionDeleted(id: string) {
    clearJustCompleted(id);
    if (id === sessionId) {
      navSeqRef.current++;
      rememberedSessionRef.current = null;
      forgetRememberedSession();
      setSessionId(null);
      setActiveSession(null);
    }
  }

  // 重命名会话：若是当前会话，同步更新标题。
  function handleSessionRenamed(id: string, name: string) {
    if (id === sessionId) {
      setActiveSession((prev) => (prev ? { ...prev, name } : prev));
      setOptimisticSessions((prev) => {
        const current = prev[id];
        if (!current) return prev;
        return { ...prev, [id]: { ...current, name } };
      });
    }
  }

  /** Export the active session's conversation as a Markdown file. */
  async function handleExportMarkdown() {
    if (!activeSession) return;
    setHeaderMenuOpen(false);
    setHeaderExporting(true);
    try {
      const detail = await getSession(activeSession.project_hash, activeSession.id);
      const title = detail.name || detail.id.slice(0, 8);
      const lines = sessionMessagesToMarkdownLines(detail.messages, title);
      const mdContent = lines.join('\n');
      const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      showToast(t('sidebar.exportFailed'), 'error');
    } finally {
      setHeaderExporting(false);
    }
  }

  // 刷新首帧 activeSession 可能还未 resolve 完成：用本地记忆的项目桶让 Sidebar
  // 立即展开正确分组，避免先折叠再展开的闪动。
  const rememberedNavSession = rememberedSessionRef.current;
  const activeProjectHash =
    activeSession?.id === sessionId
      ? activeSession.project_hash
      : rememberedNavSession?.id === sessionId
        ? rememberedNavSession.project_hash
        : undefined;

  return (
    <div class="app">
      {/* ===== Full-height sidebar (通栏)：品牌 + 收起按钮在其顶部 ===== */}
      <Sidebar
        activeSessionId={sessionId}
        activeProjectHash={activeProjectHash}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        open={sidebarOpen}
        onCloseDrawer={() => setSidebarOpen(false)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onOpenSettings={(section) => setSettingsSection(section)}
        reloadKey={sessionListVersion}
        optimisticSessions={optimisticSessions}
        onActiveSessionMeta={handleActiveSessionMeta}
        cwd={cwd}
        projectHash={projectHash}
        onSessionRenamed={handleSessionRenamed}
        onSessionDeleted={handleSessionDeleted}
        onPickSkill={(name) => setSkillInsert({ name, seq: Date.now() })}
        onOpenCwd={() => setShowCwd(true)}
        onSwitchProject={handlePickCwd}
        extraRunningIds={Array.from(liveRunningIds)}
        completedIds={Array.from(justCompletedIds)}
        onOpenFile={handleOpenFile}
        activeFilePath={diffTabs.find((t) => t.id === activeMainTabId)?.filePath}
      />
      <div
        class={'sidebar-backdrop' + (sidebarOpen ? ' show' : '')}
        onClick={() => setSidebarOpen(false)}
      />

      {/* ===== Main column: sticky session-title header + chat (no top bar) ===== */}
      <div class={'main-column' + (isLanding ? ' is-landing' : '')}>
        {/* 全局统一应用顶栏：带坚实底色、底边线与清晰边界感，杜绝滚动穿透 */}
        <header
          class={
            'session-header' +
            (isHeaderCompact ? ' is-compact' : '') +
            (isHeaderUltraCompact ? ' is-ultra-compact' : '')
          }
          ref={headerMenuRef}
          onDragOver={(e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer?.getData('application/jeikcode-tab');
            const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
            if (data?.filePath && diffTabs.length === 0) {
              e.preventDefault();
              handleOpenFile(data.filePath);
            }
          }}
        >
          {/* Mobile-only menu button */}
          <button
            class="mobile-menu-btn"
            onClick={toggleSidebar}
            aria-label={t('header.menu')}
            title={t('header.sessionList')}
          >
            ☰
          </button>

          {/* 移动端顶部：左上角会话与Diff标签下拉收纳框 */}
          {activeSession?.name && !isLanding && isHeaderCompact ? (
            <div class="mobile-session-tab-dropdown-wrap" ref={mobileTabsDropdownRef}>
              <button
                type="button"
                class={'mobile-session-tab-btn' + (mobileTabsDropdownOpen ? ' open' : '')}
                onClick={(e) => {
                  e.stopPropagation();
                  setMobileTabsDropdownOpen((v) => !v);
                }}
                aria-label={t('header.tabsMenu')}
              >
                {liveRunningIds.has(activeSession.id) ? (
                  <span
                    class="session-item-running session-header-running"
                    title={t('sidebar.running')}
                    aria-label={t('sidebar.running')}
                  />
                ) : activeMainTabId === 'chat' ? (
                  <span class="mobile-tab-icon">💬</span>
                ) : (
                  <span
                    class={
                      'vscode-tab-badge status-' +
                      (diffTabs.find((t) => t.id === activeMainTabId)?.fileStatus?.toLowerCase() || 'm')
                    }
                  >
                    {diffTabs.find((t) => t.id === activeMainTabId)?.fileStatus || 'M'}
                  </span>
                )}
                <span class="mobile-tab-current-title">
                  {activeMainTabId === 'chat'
                    ? activeSession.name
                    : diffTabs.find((t) => t.id === activeMainTabId)?.fileName || activeSession.name}
                </span>
                {diffTabs.length > 0 && (
                  <span class="mobile-tab-count-badge">{diffTabs.length}</span>
                )}
                <svg
                  class="mobile-tab-chevron"
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>

              {mobileTabsDropdownOpen && (
                <div class="mobile-session-tabs-menu" onClick={(e) => e.stopPropagation()}>
                  <div class="mobile-tabs-group-title">{t('git.chatTab')}</div>
                  <button
                    type="button"
                    class={'mobile-tabs-menu-row' + (activeMainTabId === 'chat' ? ' active' : '')}
                    onClick={() => {
                      setActiveMainTabId('chat');
                      setMobileTabsDropdownOpen(false);
                    }}
                  >
                    <span class="mobile-tabs-row-icon">💬</span>
                    <span class="mobile-tabs-row-name">{activeSession.name}</span>
                    {activeMainTabId === 'chat' && <span class="mobile-tabs-active-check">✓</span>}
                  </button>

                  {diffTabs.length > 0 && (
                    <>
                      <div class="mobile-tabs-group-title">
                        {t('git.changes')} ({diffTabs.length})
                      </div>
                      {diffTabs.map((tab) => (
                        <div
                          key={tab.id}
                          class={'mobile-tabs-menu-row' + (activeMainTabId === tab.id ? ' active' : '')}
                          onClick={() => {
                            setActiveMainTabId(tab.id);
                            setMobileTabsDropdownOpen(false);
                          }}
                        >
                          <span class={'vscode-tab-badge status-' + tab.fileStatus.toLowerCase()}>
                            {tab.fileStatus}
                          </span>
                          <span class="mobile-tabs-row-name" title={tab.filePath}>
                            {tab.fileName}
                          </span>
                          <button
                            type="button"
                            class="mobile-tabs-row-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseDiffTab(tab.id);
                            }}
                            title={t('preview.closeTab')}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : activeSession?.name && (activeSession.message_count ?? 0) > 0 ? (
            /* 桌面端会话标题：只有当该会话真实拥有消息时才展示其标题 */
            <button
              type="button"
              class={
                'session-title-btn' +
                (activeMainTabId === 'chat' ? ' active' : ' clickable-nav')
              }
              title={activeSession.name}
              onClick={() => setActiveMainTabId('chat')}
            >
              <span class="session-title-text">{activeSession.name}</span>
              {liveRunningIds.has(activeSession.id) && (
                <span
                  class="session-item-running session-header-running"
                  title={t('sidebar.running')}
                  aria-label={t('sidebar.running')}
                />
              )}
            </button>
          ) : (
            /* 桌面端常驻小云朵标签：当处于新建会话或无活跃会话时，常驻展示云朵标签，点击直接新建/切回对话 */
            <button
              type="button"
              class={
                'session-title-btn session-new-cloud-btn' +
                (activeMainTabId === 'chat' ? ' active' : ' clickable-nav')
              }
              title={t('sidebar.newChat')}
              aria-label={t('sidebar.newChat')}
              onClick={() => {
                setActiveMainTabId('chat');
                handleNewSession();
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
              </svg>
              <span class="session-title-text">{t('sidebar.newChat')}</span>
            </button>
          )}

          {/* 桌面端 VSCode Editor Tabs：全标签平铺横滑，支持微高度横向滚动条，彻底消除 +20 按钮遮挡 */}
          {!isHeaderCompact && diffTabs.length > 0 && (
            <div
              class={'header-editor-tabs-bar' + (isMainTabsDragOver ? ' is-drag-over-main' : '')}
              ref={tabsContainerRef}
              onWheel={handleTabsWheel}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                setIsMainTabsDragOver(true);
              }}
              onDragLeave={(e) => {
                if (!tabsContainerRef.current?.contains(e.relatedTarget as Node)) {
                  setIsMainTabsDragOver(false);
                  setMainTabOverIdx(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsMainTabsDragOver(false);
                setMainTabOverIdx(null);
                if (mainTabDragIdx !== null) {
                  setDiffTabs((prev) => {
                    const next = [...prev];
                    const [moved] = next.splice(mainTabDragIdx, 1);
                    if (moved) next.push(moved);
                    return next;
                  });
                  setMainTabDragIdx(null);
                  return;
                }
                try {
                  const raw = e.dataTransfer?.getData('application/jeikcode-tab');
                  const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
                  if (data?.filePath) {
                    handleOpenFile(data.filePath);
                  }
                } catch {}
              }}
              role="tablist"
            >
              {diffTabs.map((tab, idx) => {
                const isActive = activeMainTabId === tab.id;
                const isOver = mainTabOverIdx === idx;
                const isDragging = mainTabDragIdx === idx;
                return (
                  <div
                    key={tab.id}
                    class={
                      'header-editor-tab' +
                      (isActive ? ' active' : '') +
                      (isOver ? ' is-drag-over-tab' : '') +
                      (isDragging ? ' is-dragging-tab' : '')
                    }
                    onClick={() => setActiveMainTabId(tab.id)}
                    onDblClick={(e) => {
                      e.stopPropagation();
                      handleCloseDiffTab(tab.id);
                    }}
                    title={`${tab.filePath}${tab.commitShortHash ? ` (${tab.commitShortHash})` : ''} (${t('header.doubleClickClose')})`}
                    draggable={true}
                    onDragStart={(e) => {
                      setMainTabDragIdx(idx);
                      const data = {
                        id: tab.id,
                        filePath: tab.filePath,
                        fileName: tab.fileName,
                        fileStatus: tab.fileStatus,
                      };
                      (window as any).__jeikcode_dragged_tab = data;
                      e.dataTransfer?.setData('application/jeikcode-tab', JSON.stringify(data));
                      e.dataTransfer?.setData('application/jeikcode-main-tab-index', String(idx));
                      e.dataTransfer?.setData('text/plain', tab.filePath);
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'copyMove';
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer) {
                        e.dataTransfer.dropEffect = mainTabDragIdx !== null ? 'move' : 'copy';
                      }
                      if (mainTabOverIdx !== idx) {
                        setMainTabOverIdx(idx);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMainTabOverIdx(null);
                      setIsMainTabsDragOver(false);

                      const fromIndexStr = e.dataTransfer?.getData('application/jeikcode-main-tab-index');
                      if (fromIndexStr !== undefined && fromIndexStr !== '') {
                        const fromIdx = parseInt(fromIndexStr, 10);
                        if (!Number.isNaN(fromIdx) && fromIdx !== idx) {
                          setDiffTabs((prev) => {
                            const next = [...prev];
                            const [moved] = next.splice(fromIdx, 1);
                            if (moved) next.splice(idx, 0, moved);
                            return next;
                          });
                          setMainTabDragIdx(null);
                          return;
                        }
                      }

                      try {
                        const raw = e.dataTransfer?.getData('application/jeikcode-tab');
                        const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
                        if (data?.filePath) {
                          handleOpenFile(data.filePath, idx);
                        }
                      } catch {}
                      setMainTabDragIdx(null);
                    }}
                    onDragEnd={() => {
                      (window as any).__jeikcode_dragged_tab = null;
                      setMainTabDragIdx(null);
                      setMainTabOverIdx(null);
                    }}
                  >
                    <span class={'vscode-tab-badge status-' + (tab.fileStatus || 'M').toLowerCase()}>
                      {tab.fileStatus || 'M'}
                    </span>
                    <span class="tab-filename">{tab.fileName}</span>
                    <button
                      type="button"
                      class="vscode-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseDiffTab(tab.id);
                      }}
                      title={t('preview.closeTab')}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 右上角精炼工具栏：桌面端外显快捷操作（刷新、远程、更新、主题、语言），缩放窄屏或手机时动态收纳至三个点 */}
          <div
            class="top-nav-actions"
            role="toolbar"
            aria-label={t('header.quickSettings')}
          >
            {/* 桌面端外显：刷新当前会话 */}
            <button
              type="button"
              class="top-nav-btn top-nav-desktop-action top-nav-refresh-btn"
              onClick={requestSoftRefresh}
              title={t('header.refresh')}
              aria-label={t('header.refresh')}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
                <path d="M3 21v-5h5" />
                <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>

            {/* 桌面端外显：远程访问控制 */}
            <div class="top-nav-desktop-action top-nav-remote-desktop">
              <RemoteAccessControl />
            </div>

            {/* 桌面端外显：软件更新 */}
            <button
              type="button"
              class={`top-nav-btn top-nav-desktop-action top-nav-update-btn ${updateInfo?.has_update ? 'has-update' : ''}`}
              onClick={openUpdateDialogWithFreshCheck}
              title={updateInfo?.has_update ? t('update.hasUpdate', { version: updateInfo.latest_version }) : t('update.modalTitle')}
              aria-label={t('update.modalTitle')}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>

            {/* 主题切换（桌面外显，极窄或手机收纳） */}
            <button
              type="button"
              class="top-nav-btn top-nav-theme-btn"
              onClick={() => {
                if (theme === 'light') setTheme('dark');
                else if (theme === 'dark') setTheme('system');
                else setTheme('light');
              }}
              title={theme === 'light' ? t('settings.theme.light') : theme === 'dark' ? t('settings.theme.dark') : t('settings.theme.system')}
              aria-label={t('settings.theme')}
            >
              {theme === 'light' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : theme === 'dark' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 3v18" />
                  <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
                </svg>
              )}
            </button>

            {/* 常驻语言切换（电脑版轻量现代下拉框，手机版保持居中弹窗） */}
            <div class="top-nav-lang-wrap" ref={langMenuRef}>
              <button
                type="button"
                class={'top-nav-btn top-nav-lang-btn' + (langMenuOpen ? ' active' : '')}
                onClick={() => {
                  const isMobile = typeof window !== 'undefined'
                    ? (window.innerWidth <= 768 || ('ontouchstart' in window && window.innerWidth <= 1024))
                    : false;
                  if (isMobile) {
                    setSettingsSection('language');
                  } else {
                    setLangMenuOpen((o) => !o);
                  }
                }}
                title={t('settings.menuLang')}
                aria-label={t('settings.menuLang')}
                aria-expanded={langMenuOpen}
              >
                <span>{(() => {
                  switch (lang) {
                    case 'zh': return '简';
                    case 'zh-TW': return '繁';
                    case 'ja': return 'JA';
                    case 'ko': return 'KO';
                    case 'ru': return 'RU';
                    case 'fr': return 'FR';
                    case 'es': return 'ES';
                    case 'de': return 'DE';
                    case 'ar': return 'AR';
                    case 'vi': return 'VI';
                    default: return 'EN';
                  }
                })()}</span>
              </button>

              {langMenuOpen && (
                <div class="top-nav-lang-menu" role="menu">
                  {languageOptions.map(({ value: v, label }) => (
                    <button
                      key={v}
                      type="button"
                      class={'lang-menu-item' + (lang === v ? ' active' : '')}
                      onClick={() => {
                        setLang(v);
                        setLangMenuOpen(false);
                      }}
                    >
                      <span class="lang-item-name">{label}</span>
                      {lang === v && <span class="lang-item-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 模型选择控件插槽（核心操作，内含思考档位与模型胶囊，齿轮已内置） */}
            <div ref={setTopModelSlot} class="top-nav-model-slot" id="top-nav-model-slot" />

            {/* 更多收纳菜单（桌面宽屏隐藏；缩放窄屏或手机时动态显现并承载收纳项） */}
            <div class="top-nav-more-wrap" ref={topNavMoreRef}>
              <button
                type="button"
                class={'top-nav-btn top-nav-more-btn' + (updateInfo?.has_update ? ' has-update-dot' : '')}
                onClick={() => setTopNavMoreOpen((o) => !o)}
                title={t('sidebar.itemMenu')}
                aria-label={t('sidebar.itemMenu')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                  <circle cx="12" cy="5" r="1.5" fill="currentColor" />
                  <circle cx="12" cy="19" r="1.5" fill="currentColor" />
                </svg>
              </button>

              {topNavMoreOpen && (
                <div class="top-nav-more-menu" role="menu">
                  <button
                    type="button"
                    class="top-nav-more-item"
                    onClick={() => {
                      setTopNavMoreOpen(false);
                      requestSoftRefresh();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
                      <path d="M3 21v-5h5" />
                      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
                      <path d="M21 3v5h-5" />
                    </svg>
                    <span>{t('header.refresh')}</span>
                  </button>

                  <div class="top-nav-more-remote-wrapper">
                    <RemoteAccessControl />
                  </div>

                  <button
                    type="button"
                    class="top-nav-more-item"
                    onClick={() => {
                      setTopNavMoreOpen(false);
                      openUpdateDialogWithFreshCheck();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                    <span>{updateInfo?.has_update ? t('update.hasUpdate', { version: updateInfo.latest_version }) : t('update.modalTitle')}</span>
                    {updateInfo?.has_update && <span class="update-more-badge">NEW</span>}
                  </button>

                  <button
                    type="button"
                    class="top-nav-more-item top-nav-more-lang-item"
                    onClick={() => setSettingsSection('language')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18" />
                      <path d="M12 3a15 15 0 0 1 0 18" />
                      <path d="M12 3a15 15 0 0 0 0 18" />
                    </svg>
                    <span>{t('header.language')}</span>
                    <span class="top-nav-more-trailing">{languageOptions.find((o) => o.value === lang)?.label ?? 'English'}</span>
                  </button>

                  <button
                    type="button"
                    class="top-nav-more-item top-nav-more-theme-item"
                    onClick={() => {
                      if (theme === 'light') setTheme('dark');
                      else if (theme === 'dark') setTheme('system');
                      else setTheme('light');
                    }}
                  >
                    {theme === 'light' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="5" />
                        <line x1="12" y1="1" x2="12" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="23" />
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                        <line x1="1" y1="12" x2="3" y2="12" />
                        <line x1="21" y1="12" x2="23" y2="12" />
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                      </svg>
                    ) : theme === 'dark' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 3v18" />
                        <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
                      </svg>
                    )}
                    <span>{theme === 'light' ? t('settings.theme.light') : theme === 'dark' ? t('settings.theme.dark') : t('settings.theme.system')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div
          class="session-body app-sidebar"
          onDragOver={(e) => {
            e.preventDefault();
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            try {
              const raw = e.dataTransfer?.getData('application/jeikcode-tab');
              const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
              const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
              if (targetPath && typeof targetPath === 'string' && targetPath.trim()) {
                handleOpenFile(targetPath.trim());
              }
            } catch {}
          }}
        >
          <Chat
            sessionId={sessionId}
            onSessionId={handleSessionAssigned}
            cwd={cwd}
            onPermission={setPending}
            onPermissionResolved={(callId) =>
              setPending((cur: any) =>
                callId === null ? null : resolvePendingAfterDecision(cur, callId),
              )}
            activeSession={activeSession}
            restoring={restoring}
            onTurnDone={() => {
              setSessionListVersion((v) => v + 1);
              // 回合完成时，立即主动校准本地 liveRunningIds，确保清除残留的旋转菊花
              getActiveChatSessions()
                .then((ids) => {
                  setLiveRunningIds((prev) => {
                    const next = new Set<string>();
                    for (const id of prev) {
                      if (ids.includes(id)) next.add(id);
                    }
                    return next;
                  });
                })
                .catch(() => {});
            }}
            onTurnRunningChange={(id, running) => {
              if (!id) return;
              setLiveRunningIds((prev) => {
                const next = new Set(prev);
                if (running) next.add(id);
                else next.delete(id);
                return next;
              });
            }}
            onOptimisticSession={handleOptimisticSession}
            onOpenCwd={() => setShowCwd(true)}
            onCwdChanged={handleCwdChanged}
            onLanding={setIsLanding}
            skillInsert={skillInsert}
            onSessionRenamed={(name) => {
              setActiveSession((prev) => (prev ? { ...prev, name } : prev));
              setOptimisticSessions((prev) => {
                const curId = activeSession?.id ?? sessionId;
                if (!curId || !prev[curId]) return prev;
                return {
                  ...prev,
                  [curId]: { ...prev[curId], name },
                };
              });
              setSessionListVersion((v) => v + 1);
            }}
            onOpenSidebar={() => setSidebarOpen(true)}
            onNewSession={handleNewSession}
            diffTabs={diffTabs}
            setDiffTabs={setDiffTabs}
            activeMainTabId={activeMainTabId}
            setActiveMainTabId={setActiveMainTabId}
            topModelSlot={topModelSlot}
            onOpenModelConfig={() => setSettingsSection('model')}
            onLiveReview={onLiveReview}
            onBindReviewDismiss={onBindReviewDismiss}
          />
        </div>
      </div>

      {/* ===== Modals ===== */}
      {showCwd && (
        <CwdPicker
          current={cwd}
          onPick={handlePickCwd}
          onClose={() => setShowCwd(false)}
        />
      )}
      {settingsSection === 'theme' && (
        <LazyBoundary>
          <ThemeDialog onClose={() => setSettingsSection(null)} />
        </LazyBoundary>
      )}
      {settingsSection === 'language' && (
        <LazyBoundary>
          <LanguageDialog onClose={() => setSettingsSection(null)} />
        </LazyBoundary>
      )}
      {settingsSection === 'model' && (
        <LazyBoundary>
          <SystemSettingsDialog initialTab="models" onClose={() => setSettingsSection(null)} />
        </LazyBoundary>
      )}
      {settingsSection === 'system' && (
        <LazyBoundary>
          <SystemSettingsDialog initialTab="models" onClose={() => setSettingsSection(null)} />
        </LazyBoundary>
      )}
      {headerDialog === 'rename' && activeSession && (
        <RenameDialog
          session={activeSession}
          onClose={() => setHeaderDialog(null)}
          onDone={(name) => {
            handleSessionRenamed(activeSession.id, name);
            setSessionListVersion((v) => v + 1);
          }}
        />
      )}
      {headerDialog === 'delete' && activeSession && (
        <DeleteDialog
          sessions={[activeSession]}
          onClose={() => setHeaderDialog(null)}
          onDone={(ids) => {
            for (const id of ids) handleSessionDeleted(id);
            setSessionListVersion((v) => v + 1);
          }}
        />
      )}
      {showUpdateDialog && (
        <LazyBoundary>
          <UpdateDialog
            info={updateInfo}
            onClose={() => setShowUpdateDialog(false)}
            onUpdateInfoChange={(newInfo) => setUpdateInfo(newInfo)}
          />
        </LazyBoundary>
      )}
      {showOnboarding && (
        <LazyBoundary>
          <OnboardingWizard
            onClose={() => setShowOnboarding(false)}
            onConfigureModel={() => setSettingsSection('model')}
          />
        </LazyBoundary>
      )}
      {configDiffs && configDiffs.length > 0 && (
        <LazyBoundary>
          <ConfigSyncModal
            diffs={configDiffs}
            onDone={(count) => {
              setConfigDiffs(null);
              // 选中大于 0 个文件才弹出成功提示；若选中 0 个文件点击确定直接静默完成，不跳提示
              if (count > 0) {
                showToast(t('configSync.successToast', { n: count }), 'success');
              }
            }}
            onSkip={() => {
              setConfigDiffs(null);
            }}
          />
        </LazyBoundary>
      )}
      <LegacyMigrationModal />
      <DesktopClosePromptDialog />
      <ConfirmModalHost />
      <ToastHost />
      <NotificationDock
        liveReview={liveReview}
        chatPermission={pending}
        activeSession={activeSession}
        onDismissChatPermission={() => setPending(null)}
        onDismissLivePermission={(runtimeInstanceId, generation, requestId, callId) =>
          dismissLiveReview.current.permission(runtimeInstanceId, generation, requestId, callId)}
        onDismissLiveUserInput={() => dismissLiveReview.current.userInput()}
        onFocusSession={(id) => {
          if (!id || id === sessionId) return;
          resolveSession(id)
            .then((found) => {
              if (found) handleSelectSession(found);
            })
            .catch(() => {});
        }}
      />
    </div>
  );
}
