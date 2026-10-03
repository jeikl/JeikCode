// Two-column layout: sidebar + chat, header with cwd breadcrumb + config.
// VSCode design system: timeline messages, violet brand, floating input.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Chat } from './components/Chat';
import { Sidebar } from './components/Sidebar';
import { ThemeDialog, LanguageDialog, ModelConfigDialog } from './components/SettingsDialogs';
import { RenameDialog, DeleteDialog } from './components/SessionDialogs';
import { CwdPicker } from './components/CwdPicker';
import { LiveReviewState, NotificationDock } from './components/NotificationDock';
import { UpdateDialog } from './components/UpdateDialog';
import { ConfigSyncModal } from './components/ConfigSyncModal';
import { OnboardingWizard, onboardingDone } from './components/OnboardingWizard';
import { RemoteAccessControl } from './components/RemoteAccessControl';
import { resolvePendingAfterDecision } from './lib/pendingPermission';
import {
  getProject,
  getConfig,
  getModels,
  changeDir,
  resolveSession,
  createSession,
  getSession,
  pollNotifyFocus,
  postLiveSwitchSession,
  checkUpdate,
  fetchUpgradeDiffs,
  UpdateCheckResponse,
  ConfigDiffItem,
  SessionMetaWithProject,
} from './api';
import { useT, useSettings, SettingsSection } from './settings';
import { sessionMessagesToMarkdownLines } from './lib/historyMessages';

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

export function App() {
  const t = useT();
  const { theme, setTheme, lang, setLang } = useSettings();
  // URL 里是短 id，不能直接当完整 id 用（后端需要完整 id）；先置空，挂载后再还原。
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionMetaWithProject | null>(null);
  // 乐观会话集合：让新创建/首条消息发出的会话即时出现在侧栏（即使切到其他会话也不丢失）。
  // 当后端列表出现同 id 的真实会话后，Sidebar 的 mergeOptimisticSessions 会自动以落盘条目为准去重。
  const [optimisticSessions, setOptimisticSessions] = useState<Record<string, SessionMetaWithProject>>({});
  const [cwd, setCwd] = useState('');
  // Physical session-bucket hash of the current project. The sidebar scopes its
  // list by this (see Sidebar `projectHash`), not by the `cwd` string, so a
  // session whose stored `working_dir` was restamped by the daemon's global
  // working_dir can't leak into the wrong project. Tracked alongside `cwd`.
  const [projectHash, setProjectHash] = useState('');
  const [pending, setPending] = useState<any | null>(null);
  const [liveReview, setLiveReview] = useState<LiveReviewState | null>(null);
  const dismissLiveReview = useRef({
    permission: (_callId: string) => {},
    userInput: () => {},
  });
  const onLiveReview = useCallback((review: LiveReviewState) => {
    setLiveReview((prev) => {
      if (
        prev
        && prev.sessionId === review.sessionId
        && (prev.permission?.call_id ?? '') === (review.permission?.call_id ?? '')
        && (prev.userInput?.request_id ?? -1) === (review.userInput?.request_id ?? -1)
      ) {
        return prev;
      }
      return review;
    });
  }, []);
  const onBindReviewDismiss = useCallback((fns: {
    permission: (callId: string) => void;
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

  // VSCode-style open diff tabs in the session header
  const [diffTabs, setDiffTabs] = useState<any[]>([]);
  const [activeMainTabId, setActiveMainTabId] = useState<string>('chat');

  // 右侧检视面板（提问记录 / Git面板）折叠与宽度布局状态，用于自适应避让右上角快捷工具栏
  const [rightPanelLayout, setRightPanelLayout] = useState<{ collapsed: boolean; width: number }>(() => {
    try {
      const collapsed = localStorage.getItem('jeikcode:right-panel-collapsed') === 'true';
      const savedWidth = localStorage.getItem('jeikcode:right-panel-width');
      const width = savedWidth ? parseInt(savedWidth, 10) : 260;
      return { collapsed, width: Number.isFinite(width) ? width : 260 };
    } catch {
      return { collapsed: false, width: 260 };
    }
  });

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
      .catch(() => {
        if (!cancelled) setShowOnboarding(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Skills picked from the sidebar Skills menu → bumped so Chat inserts `/name `.
  const [skillInsert, setSkillInsert] = useState<{ name: string; seq: number } | null>(null);
  // 挂载时 URL 里的（短）session id；用 ref 暂存，避免被 URL 同步 effect 清掉。
  const urlSessionRef = useRef<string | null>(readSessionIdFromUrl());
  // 跳过首次 URL 同步：此时可能正等待把短 id 还原成完整会话，别先清掉参数。
  const firstUrlSync = useRef(true);
  // 刷新时若 URL 带 session id，先进入「恢复中」态：在按短 id 还原出会话前，
  // 抑制 Chat 的新建落地页，避免「先闪一下新建页再跳到历史」的体验。
  const [restoring, setRestoring] = useState<boolean>(() => readSessionIdFromUrl() != null);
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
  function handleSessionAssigned(id: string) {
    // 把乐观条目的临时 id 对齐到后端真实 id（落地页发送时乐观条目用的是临时 id），
    // 这样接下来的列表刷新能按 id 去重，用真实条目（含自动命名）覆盖乐观条目。
    setOptimisticSessions((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith('optimistic-') || key === id) {
          const item = next[key];
          delete next[key];
          next[id] = { ...item, id };
        }
      }
      return next;
    });
    if (id !== sessionId) {
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
    // 当真实会话已经从后端拉出时，从乐观池移除对应的临时记录
    setOptimisticSessions((prev) => {
      if (!prev[s.id]) return prev;
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

    // 1.5秒后自动静默检测版本更新（有新版本时点亮绿色向上箭头）
    const updateTimer = setTimeout(() => {
      checkUpdate()
        .then((res) => {
          if (!cancelled) setUpdateInfo(res);
        })
        .catch(() => {});
    }, 1500);

    // 升级后首次启动配置覆盖检测
    fetchUpgradeDiffs(true, false)
      .then((res) => {
        if (!cancelled && res.should_prompt && res.diffs.length > 0) {
          setConfigDiffs(res.diffs);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      clearTimeout(updateTimer);
    };
  }, []);

  const handleManualCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    try {
      const res = await checkUpdate();
      setUpdateInfo(res);
      if (res.has_update) {
        setShowUpdateDialog(true);
      } else {
        alert(t('update.latest', { version: res.current_version }));
      }
    } catch (e: any) {
      alert(t('update.failed', { error: e?.message || String(e) }));
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  // 把当前 session id（取前 8 位）同步进 URL，刷新后可恢复。
  useEffect(() => {
    // 跳过首次：挂载时若 URL 已带短 id 而 sessionId 尚未还原，别先把参数清掉。
    if (firstUrlSync.current) {
      firstUrlSync.current = false;
      return;
    }
    const url = new URL(window.location.href);
    if (sessionId) {
      url.searchParams.set('session', shortSessionId(sessionId));
    } else {
      url.searchParams.delete('session');
    }
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [sessionId]);

  // 刷新后用 URL 里的短 id 还原成完整记录（完整 id + project_hash + working_dir），
  // 再交给 Chat 加载历史。用 resolveSession（跨所有桶按 id 定位，不受 /sessions 的
  // 50 条上限影响），否则较旧的会话刷新后会找不到、回落到新建页。仅在挂载时执行一次。
  useEffect(() => {
    const urlSid = urlSessionRef.current;
    if (!urlSid) return;
    let cancelled = false;
    resolveSession(urlSid)
      .then((found) => {
        if (cancelled || !found) return;
        setSessionId(found.id);
        setActiveSession(found);
        if (found.working_dir) setCwd(found.working_dir);
        if (found.project_hash) setProjectHash(found.project_hash);
      })
      .catch(() => {
        /* 找不到就维持现状（回到新建页） */
      })
      .finally(() => {
        // 无论找没找到，恢复流程结束：解除抑制（找到→历史页，没找到→新建页）。
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

  // 在指定目录下创建一个新会话并切过去（首条用户消息前不写盘）。
  // 先重置画布回落地页给即时反馈，再异步建会话；失败则停在落地页。
  function openNewSession(targetCwd: string | undefined) {
    const currentSeq = ++navSeqRef.current;
    setSessionId(null);
    setActiveSession(null);
    if (targetCwd && targetCwd !== '~') {
      setCwd(targetCwd);
    }
    // 仅在同步开启（?sync=1）时让后端广播新建，使 sync 模式 TUI 跟随；
    // 关闭同步时 webui 新建对话不应牵连 TUI 新建（issue #850）。
    let sync = false;
    try { sync = new URLSearchParams(location.search).get('sync') === '1'; } catch { /* ignore */ }
    createSession(targetCwd || undefined, undefined, sync)
      .then((data) => {
        // 如果网络往返期间用户切换了会话或发起了新导航，该响应已失效，坚决丢弃，防止穿透和目录污染
        if (currentSeq !== navSeqRef.current) return;
        if (data.working_dir) setCwd(data.working_dir);
        if (data.project_hash) setProjectHash(data.project_hash);
        setSessionId(data.id);
        setActiveSession({
          id: data.id,
          name: data.name,
          working_dir: data.working_dir,
          project_hash: data.project_hash,
          created_at: data.created_at,
          updated_at: data.created_at,
          message_count: 0,
        });
        setSessionListVersion((v) => v + 1);
      })
      .catch((err) => {
        if (currentSeq !== navSeqRef.current) return;
        // 创建失败时已在前端落地页，仅打印日志
        console.warn('[newSession] create session failed:', err);
      });
  }

  function handleNewSession(targetDir?: string) {
    setSidebarOpen(false);
    openNewSession(targetDir || '~');
  }

  function isSyncMode(): boolean {
    try {
      return new URLSearchParams(location.search).get('sync') === '1';
    } catch {
      return false;
    }
  }

  function applySessionSelection(session: SessionMetaWithProject) {
    navSeqRef.current++;
    setSessionId(session.id);
    setActiveSession(session);
    if (session.working_dir) {
      setCwd(session.working_dir);
    }
    if (session.project_hash) setProjectHash(session.project_hash);
    setSidebarOpen(false);
  }

  function handleSelectSession(session: SessionMetaWithProject) {
    navSeqRef.current++;
    // Sync/live: tell the native runtime to switch view binding + replay snapshot.
    if (isSyncMode()) {
      const currentSeq = navSeqRef.current;
      postLiveSwitchSession(session.id)
        .then((r) => {
          if (currentSeq !== navSeqRef.current) return;
          if (!r.ok) {
            console.warn('[switchSession] live switch failed:', r.error);
          }
          applySessionSelection(session);
        })
        .catch((err) => {
          if (currentSeq !== navSeqRef.current) return;
          console.warn('[switchSession]', err);
          applySessionSelection(session);
        });
      return;
    }
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
    // WinRT toasts cannot run page script. The click posts to the daemon, and
    // this poll turns that into the same focus event as a Web Notification.
    const timer = window.setInterval(() => {
      void pollNotifyFocus()
        .then((sid) => {
          if (!sid) return;
          window.dispatchEvent(
            new CustomEvent('jeikcode:focus-session', { detail: { sessionId: sid } }),
          );
        })
        .catch(() => {});
    }, 500);
    return () => {
      window.removeEventListener('jeikcode:focus-session', onFocusReq);
      window.clearInterval(timer);
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
    if (id === sessionId) {
      navSeqRef.current++;
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
      alert(t('sidebar.exportFailed'));
    } finally {
      setHeaderExporting(false);
    }
  }

  return (
    <div class="app">
      {/* ===== Full-height sidebar (通栏)：品牌 + 收起按钮在其顶部 ===== */}
      <Sidebar
        activeSessionId={sessionId}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        open={sidebarOpen}
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
      />
      <div
        class={'sidebar-backdrop' + (sidebarOpen ? ' show' : '')}
        onClick={() => setSidebarOpen(false)}
      />

      {/* ===== Main column: sticky session-title header + chat (no top bar) ===== */}
      <div class="main-column">
        {/* 右上角快捷工具栏：检测更新、主题、语言切换 + 现代化模型选择控件 */}
        <div
          class="top-nav-actions"
          role="toolbar"
          aria-label="Quick settings"
        >
          <button
            type="button"
            class="top-nav-btn"
            onClick={() => window.location.reload()}
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
          <RemoteAccessControl />
          <button
            class={`top-nav-btn top-nav-update-btn ${updateInfo?.has_update ? 'has-update' : ''}`}
            onClick={() => {
              if (updateInfo?.has_update) {
                setShowUpdateDialog(true);
              } else {
                handleManualCheckUpdate();
              }
            }}
            title={
              updateInfo?.has_update
                ? t('update.hasUpdate', { version: updateInfo.latest_version })
                : isCheckingUpdate
                  ? t('update.checking')
                  : t('update.check')
            }
            aria-label="Check for update"
          >
            {updateInfo?.has_update ? (
              <svg
                class="update-arrow-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            ) : (
              <svg
                class={isCheckingUpdate ? 'spin-icon' : ''}
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3" />
                <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3" />
                <path d="M21 3v6h-6" />
                <path d="M3 21v-6h6" />
              </svg>
            )}
          </button>

          <button
            class="top-nav-btn"
            onClick={() => {
              if (theme === 'light') setTheme('dark');
              else if (theme === 'dark') setTheme('system');
              else setTheme('light');
            }}
            title={
              theme === 'light'
                ? t('settings.theme.light')
                : theme === 'dark'
                  ? t('settings.theme.dark')
                  : t('settings.theme.system')
            }
            aria-label="Theme toggle"
          >
            {theme === 'light' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <path d="M12 3v18" />
                <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
              </svg>
            )}
          </button>

          <button
            class="top-nav-btn top-nav-lang-btn"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={lang === 'zh' ? '切换为 English' : 'Switch to 简体中文'}
            aria-label="Language switch"
          >
            <span>{lang === 'zh' ? '简' : 'EN'}</span>
          </button>

          {/* 右上角红框区域：模型选择控件插槽 */}
          <div ref={setTopModelSlot} class="top-nav-model-slot" id="top-nav-model-slot" />
        </div>
        {/* Mobile-only floating menu button (the old top bar carried the ☰; the
            redesign has no top bar, so a fixed button gives mobile drawer access). */}
        <button
          class="mobile-menu-btn"
          onClick={toggleSidebar}
          aria-label={t('header.menu')}
          title={t('header.sessionList')}
        >
          ☰
        </button>

        {((activeSession?.name && !isLanding) || diffTabs.length > 0) && (
          <header class="session-header" ref={headerMenuRef}>
            {activeSession?.name && !isLanding && (
              <button
                class="session-title-btn"
                title={activeSession.name}
                onClick={(e) => {
                  if (headerMenuOpen) {
                    setHeaderMenuOpen(false);
                    return;
                  }
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setHeaderMenuPos({ top: r.bottom + 4, left: r.left });
                  setHeaderMenuOpen(true);
                }}
              >
                <span class="session-title-text">{activeSession.name}</span>
                {liveRunningIds.has(activeSession.id) && (
                  <span
                    class="session-item-running session-header-running"
                    title={t('sidebar.running')}
                    aria-label={t('sidebar.running')}
                  />
                )}
                <svg
                  class="session-title-chevron"
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
            )}

            {/* VSCode Editor Tabs embedded in Session Header row */}
            {diffTabs.length > 0 && (
              <div class="header-editor-tabs-bar" role="tablist">
                <button
                  type="button"
                  class={'header-editor-tab' + (activeMainTabId === 'chat' ? ' active' : '')}
                  onClick={() => setActiveMainTabId('chat')}
                >
                  <span>💬</span>
                  <span>{t('git.chatTab')}</span>
                </button>
                {diffTabs.map((tab) => (
                  <div
                    key={tab.id}
                    class={'header-editor-tab' + (activeMainTabId === tab.id ? ' active' : '')}
                    onClick={() => setActiveMainTabId(tab.id)}
                    title={`${tab.filePath} (${tab.commitShortHash})`}
                  >
                    <span class={'vscode-tab-badge status-' + tab.fileStatus.toLowerCase()}>
                      {tab.fileStatus}
                    </span>
                    <span class="tab-filename">{tab.fileName}</span>
                    <button
                      type="button"
                      class="vscode-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseDiffTab(tab.id);
                      }}
                      title="Close tab"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {headerMenuOpen && headerMenuPos && (
              <div
                class="item-menu"
                style={{ top: `${headerMenuPos.top}px`, left: `${headerMenuPos.left}px` }}
              >
                <button
                  class="item-menu-row"
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    setHeaderDialog('rename');
                  }}
                >
                  <span>{t('sidebar.rename')}</span>
                </button>
                <button
                  class="item-menu-row"
                  onClick={handleExportMarkdown}
                  disabled={headerExporting}
                >
                  <span>{headerExporting ? t('sidebar.exporting') : t('sidebar.exportMarkdown')}</span>
                </button>
                <button
                  class="item-menu-row danger"
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    setHeaderDialog('delete');
                  }}
                >
                  <span>{t('sidebar.delete')}</span>
                </button>
              </div>
            )}
          </header>
        )}

        <div class="session-body app-sidebar">
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
            onLiveTurnDone={() => setSessionListVersion((v) => v + 1)}
            onLiveRunningChange={(id, running) => {
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
            onRightPanelLayoutChange={setRightPanelLayout}
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
        <ThemeDialog onClose={() => setSettingsSection(null)} />
      )}
      {settingsSection === 'language' && (
        <LanguageDialog onClose={() => setSettingsSection(null)} />
      )}
      {settingsSection === 'model' && (
        <ModelConfigDialog onClose={() => setSettingsSection(null)} />
      )}
      <NotificationDock
        liveReview={liveReview}
        chatPermission={pending}
        activeSession={activeSession}
        onDismissChatPermission={() => setPending(null)}
        onDismissLivePermission={(callId) => dismissLiveReview.current.permission(callId)}
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
      {showUpdateDialog && updateInfo && (
        <UpdateDialog
          info={updateInfo}
          onClose={() => setShowUpdateDialog(false)}
        />
      )}
      {showOnboarding && (
        <OnboardingWizard
          onClose={() => setShowOnboarding(false)}
          onConfigureModel={() => setSettingsSection('model')}
        />
      )}
      {configDiffs && configDiffs.length > 0 && (
        <ConfigSyncModal
          diffs={configDiffs}
          onDone={(count) => {
            setConfigDiffs(null);
            alert(t('configSync.successToast', { n: count }));
          }}
          onSkip={() => {
            setConfigDiffs(null);
          }}
        />
      )}
    </div>
  );
}
