// Session sidebar (Claude-Code-inspired: brand + collapse at top, CC-style
// new-conversation row, live-filtered session list, settings at the bottom;
// collapses to an icon rail).

import { useEffect, useRef, useState, useCallback, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { listSessions, listProjectSessions, searchSessions, getSkills, getMcpStatus, postMcpReload, postLiveMcpTrust, getSession, getProjects, getSidebarProjects, hideSidebarProject, showSidebarProject, revealSidebarProject, resolveSession, getActiveChatSessions, getHealth, pickNativeDirectory, revealInFileExplorer, SkillInfo, McpStatusInfo, SessionMetaWithProject, ProjectInfo } from '../api';
import { bakedAppVersion, formatAppVersionLabel, normalizeAppVersion } from '../lib/appVersion';
import { useT, useSettings, SettingsSection, Theme } from '../settings';
import { MsgKey, Lang, languageOptions } from '../i18n';
import { RenameDialog, DeleteDialog } from './SessionDialogs';
import { ConfirmDialog } from './ConfirmDialog';
import { CwdPicker } from './CwdPicker';
import { mergeOptimisticSession, mergeOptimisticSessions } from '../lib/sessionList';
import { sessionMessagesToMarkdownLines } from '../lib/historyMessages';
import { collapseHomePath as collapseHomePathShared, displayPath, isLoopbackHost, stripExtendedPathPrefix } from '../lib/displayPath';

interface SidebarProps {
  activeSessionId: string | null;
  onSelect: (session: SessionMetaWithProject) => void;
  onNew: (targetDir?: string) => void;
  /** Open a specific settings dialog (theme / language / model). */
  onOpenSettings: (section: SettingsSection) => void;
  /** Mobile drawer open state */
  open?: boolean;
  /** Close the mobile drawer */
  onCloseDrawer?: () => void;
  /** Desktop collapsed (icon rail) state */
  collapsed?: boolean;
  /** Toggle the desktop collapsed/expanded state */
  onToggleCollapse?: () => void;
  /** Bump to force a session-list reload (e.g. after a new session is created) */
  reloadKey?: number;
  /** 乐观会话：首条消息发出瞬间即时插入列表（后端空会话不入列表）。
   *  一旦后端列表出现同 id 的真实会话，即被其覆盖（按 id 去重，真实条目优先）。 */
  optimisticSession?: SessionMetaWithProject | null;
  /** 多个正在进行中的乐观会话（例如用户在会话A发消息后切走并继续新建会话B）。 */
  optimisticSessions?: SessionMetaWithProject[] | Record<string, SessionMetaWithProject> | null;
  /** 列表（重新）加载后回传当前会话的真实元数据，供顶部标题头同步自动命名后的标题。 */
  onActiveSessionMeta?: (session: SessionMetaWithProject) => void;
  /** Current working directory, for display + as the fallback session scope. */
  cwd?: string;
  /** Physical session-bucket hash of the current project. When set, the list is
   *  scoped to sessions in THIS bucket (robust against `working_dir` restamping);
   *  sessions lacking a hash fall back to matching `cwd`. Empty = scope by cwd. */
  projectHash?: string;
  /** Called after a session is renamed (id + new name). */
  onSessionRenamed?: (id: string, name: string) => void;
  /** Called after a session is deleted. */
  onSessionDeleted?: (id: string) => void;
  /** Pick a skill from the sidebar Skills menu → insert `/name ` into the chat input. */
  onPickSkill?: (name: string) => void;
  /** Open the working-directory picker (to switch to / start a project in any dir). */
  onOpenCwd?: () => void;
  /** Switch INTO another project (by its working dir): change cwd + land on a new
   *  conversation there + reflect it in the URL (survives refresh). */
  onSwitchProject?: (workingDir: string) => void;
  /** Live / `--host` 正在跑的 session，立刻转圈，不必等 5s 的 /chat/active。 */
  extraRunningIds?: string[];
}

type Translate = (key: MsgKey, params?: Record<string, string | number>) => string;

/** 把时间戳格式化为 YYYY-MM-DD（本地时区），用作日期分组键。 */
function dateKey(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 友好日期分组标题：今天 / 昨天 / 本年内 MM-DD / 跨年 YYYY-MM-DD。 */
function friendlyDateLabel(key: string, t: Translate): string {
  const today = dateKey(Date.now());
  if (key === today) return t('sidebar.dateToday');
  const yMs = Date.now() - 86400000;
  if (key === dateKey(yMs)) return t('sidebar.dateYesterday');
  const [y, m, d] = key.split('-');
  const sameYear = String(new Date().getFullYear()) === y;
  return sameYear ? `${m}-${d}` : key;
}

/** 把 unix 时间戳（秒或毫秒）格式化为相对时间。 */
function formatTime(ts: number, t: Translate): string {
  if (!ts) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const now = Date.now();
  const diff = now - ms;
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  if (diff < MIN) return t('time.justNow');
  if (diff < HOUR) return t('time.minutesAgo', { n: Math.floor(diff / MIN) });
  if (diff < DAY) return t('time.hoursAgo', { n: Math.floor(diff / HOUR) });
  if (diff < 2 * DAY) return t('time.yesterday');
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return sameYear ? md : `${d.getFullYear()}-${md}`;
}

function shortDir(p: string): string {
  return displayPath(p);
}

/** Inline panel-collapse glyph (monochrome, uses currentColor). */
function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.2" />
    </svg>
  );
}

/** Sparkles glyph for the Skills action. */
function SparklesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.3l1.15 3.1a2 2 0 0 0 1.2 1.2L13.4 6.8l-3.05 1.15a2 2 0 0 0-1.2 1.2L8 12.2 6.85 9.15a2 2 0 0 0-1.2-1.2L2.6 6.8l3.05-1.2a2 2 0 0 0 1.2-1.2z" />
      <path d="M12.7 10.4l.5 1.35.5-1.35 1.35-.5-1.35-.5-.5-1.35-.5 1.35-1.35.5z" />
    </svg>
  );
}

/** Chevron-down glyph (for the Skills action's caret). */
function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Collapse a home prefix to `~` for readability; also strips Windows `\\?\`. */
function collapseHomePath(p: string): string {
  return collapseHomePathShared(p);
}

/** Chat bubble glyph for session items to visually distinguish child conversation nodes. */
function ChatBubbleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5A2 2 0 0 1 4.5 2.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-4.5L4 14v-2.5h-.5a2 2 0 0 1-2-2v-5z"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Folder glyph for the project selector. */
function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.75 4c0-.55.45-1 1-1h3l1.5 1.5h5c.55 0 1 .45 1 1V12c0 .55-.45 1-1 1h-10c-.55 0-1-.45-1-1V4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

/** Checkmark glyph for the active menu item. */
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Kebab (vertical three-dot) glyph for the per-session menu. */
function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="13" r="1.4" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10.8 2.6l2.6 2.6-7.3 7.3-3 .7.7-3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.8 4.5l.6 8.5h5.2l.6-8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Download / export glyph for the export-markdown menu item. */
function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v8M4.5 7.5L8 10.5l3.5-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M2.5 12.5h11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.2 8A5.2 5.2 0 1 1 11.4 3.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      <path d="M11.2 1.8v2.6h2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** MCP / plug glyph (plug-connector for MCP servers). */
function McpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 1.5v5a2.5 2.5 0 0 0 5 0v-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="4" y1="9" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      <path d="M4 9v4.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Search (magnifying glass) glyph. */
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6.8" cy="6.8" r="4.3" stroke="currentColor" stroke-width="1.3" />
      <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}

/** Gear / settings glyph. */
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M7.1 1l-.5 2.2a4.8 4.8 0 0 0-1.8 1L2.8 3.2 1.4 5.6l1.7 1.4a4.8 4.8 0 0 0 0 2l-1.7 1.4 1.4 2.4 2-.6a4.8 4.8 0 0 0 1.8 1l.5 2.2h2.8l.5-2.2a4.8 4.8 0 0 0 1.8-1l2 .6 1.4-2.4-1.7-1.4a4.8 4.8 0 0 0 0-2l1.7-1.4-1.4-2.4-2 .6a4.8 4.8 0 0 0-1.8-1L9.9 1z"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2" />
    </svg>
  );
}

/** Theme glyph (half-filled circle = light/dark contrast). */
function ThemeGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2" />
      <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" />
    </svg>
  );
}

/** Language glyph (globe with meridians). */
function LangGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2" />
      <path d="M2.6 8h10.8M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" stroke="currentColor" stroke-width="1.2" />
    </svg>
  );
}

/** Model glyph (chip). */
function ModelGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2" />
      <path d="M6.5 1.5v1.8M9.5 1.5v1.8M6.5 12.7v1.8M9.5 12.7v1.8M1.5 6.5h1.8M1.5 9.5h1.8M12.7 6.5h1.8M12.7 9.5h1.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
    </svg>
  );
}

export function Sidebar({
  activeSessionId,
  onSelect,
  onNew,
  onOpenSettings,
  open,
  onCloseDrawer,
  collapsed,
  onToggleCollapse,
  reloadKey,
  optimisticSession,
  optimisticSessions,
  onActiveSessionMeta,
  cwd,
  projectHash,
  onSessionRenamed,
  onSessionDeleted,
  onPickSkill,
  onOpenCwd,
  onSwitchProject,
  extraRunningIds,
}: SidebarProps) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  const t = useT();
  const { theme, setTheme, lang, setLang } = useSettings();
  const [appVersion, setAppVersion] = useState(bakedAppVersion());
  const [sessions, setSessions] = useState<SessionMetaWithProject[]>([]);
  const [loading, setLoading] = useState(true);
  // 活跃（正在运行 turn）的会话 id，来自 GET /chat/active；配合 5s 轮询，
  // 让「哪个会话正在执行」实时显示在侧栏行右侧的圈圈里。
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const sessionListBodyRef = useRef<HTMLDivElement | null>(null);
  const activeSessionItemRef = useRef<HTMLDivElement | null>(null);
  // Selection is an explicit navigation intent, unlike a background reload.
  // Keep it pending across a cross-project fetch until the destination row
  // actually exists; ordinary reloads must not steal the user's scroll.
  const pendingCenterSessionIdRef = useRef<string | null>(activeSessionId);
  const previousActiveSessionIdRef = useRef<string | null>(activeSessionId);
  // Project sessions accordion
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectSessionsMap, setProjectSessionsMap] = useState<Record<string, SessionMetaWithProject[]>>({});

  const allOptimistic = useMemo<SessionMetaWithProject[]>(() => {
    const list: SessionMetaWithProject[] = [];
    if (optimisticSessions) {
      if (Array.isArray(optimisticSessions)) {
        list.push(...optimisticSessions);
      } else {
        list.push(...Object.values(optimisticSessions));
      }
    }
    if (optimisticSession && !list.some((s) => s.id === optimisticSession.id)) {
      list.push(optimisticSession);
    }
    return list;
  }, [optimisticSessions, optimisticSession]);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [showAllProjects, setShowAllProjects] = useState<Set<string>>(() => new Set());
  const [hiddenProjectHashes, setHiddenProjectHashes] = useState<Set<string>>(() => new Set());
  const [pinnedProjects, setPinnedProjects] = useState<ProjectInfo[]>([]);
  const [removeProjectTarget, setRemoveProjectTarget] = useState<ProjectInfo | null>(null);
  const [webPickerOpen, setWebPickerOpen] = useState(false);
  const pendingHideRef = useRef<Set<string>>(new Set());
  const pendingRevealRef = useRef<Set<string>>(new Set());
  const revealingRef = useRef<Set<string>>(new Set());
  const prevHiddenRef = useRef<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  // Skills menu: list fetched lazily; the count badge shows once loaded.
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsMenuOpen, setSkillsMenuOpen] = useState(false);
  const [skillsMenuPos, setSkillsMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const skillsMenuRef = useRef<HTMLDivElement | null>(null);
  const skillsBtnRef = useRef<HTMLButtonElement | null>(null);
  // MCP menu: server list fetched lazily; the count badge shows once loaded.
  const [mcpStatus, setMcpStatus] = useState<McpStatusInfo | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpReloading, setMcpReloading] = useState(false);

  // 侧栏可拖拽宽度状态与本地持久化
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:sidebar-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (parsed >= 220 && parsed <= 600) return parsed;
      }
    } catch {}
    return 280;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const handleResizerMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(220, Math.min(600, startWidth + (moveEvent.clientX - startX)));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      try {
        localStorage.setItem('jeikcode:sidebar-width', String(sidebarWidthRef.current));
      } catch {}
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };
  const [mcpReloaded, setMcpReloaded] = useState(false);
  const mcpReloadedTimerRef = useRef<number | null>(null);
  // Bounds the connecting-state poll loop (see the poll effect below).
  const mcpPollAttemptsRef = useRef(0);
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false);
  const [mcpMenuPos, setMcpMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const mcpMenuRef = useRef<HTMLDivElement | null>(null);
  const mcpBtnRef = useRef<HTMLButtonElement | null>(null);
  // Trust flow: in-flight POST + error for the "Trust this project" button.
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  // Per-session kebab menu: which session, and where to anchor the fixed menu.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // top XOR bottom: `top` opens the menu downward below the kebab; `bottom`
  // opens it upward above the kebab (used when there isn't room below, so the
  // 2-row menu isn't clipped by the viewport edge).
  const [menuPos, setMenuPos] = useState<
    { top?: number; bottom?: number; right: number } | null
  >(null);
  // Session search: a centered modal dialog (same .modal-overlay/.modal-card
  // family as the rename/delete dialogs), closes on backdrop click / Escape.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Cross-project search results (the sidebar list itself is per-project, so the
  // search modal hits the dedicated all-projects endpoint instead of filtering
  // the loaded list — which would only ever see the current project).
  const [searchResults, setSearchResults] = useState<SessionMetaWithProject[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionMetaWithProject | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<SessionMetaWithProject[] | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDeleteCount, setPendingDeleteCount] = useState(0);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Settings menu (3 entries → each opens its own dialog), fixed-anchored above the button.
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [settingsSub, setSettingsSub] = useState<'theme' | 'language' | null>(null);
  const [settingsMenuPos, setSettingsMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const itemMenuRef = useRef<HTMLDivElement | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);

  // Guards against out-of-order load responses: switching project sets
  // projectHash '' → bucket, firing two loads (the capped fallback, then the
  // per-project fetch). The fallback reads every project and is SLOWER, so
  // without this it can land last and clobber the correct per-project list with
  // the capped one. Only the newest load's response is applied.
  const loadEpochRef = useRef(0);
  function loadSessions(silent = false) {
    const epoch = ++loadEpochRef.current;
    if (!silent) setLoading(true);
    // 加载全局会话
    listSessions()
      .then((list) => {
        if (epoch !== loadEpochRef.current) return;
        setSessions(list);
        if (activeSessionId) {
          const found = list.find((s) => s.id === activeSessionId);
          if (found) onActiveSessionMeta?.(found);
        }
      })
      .catch(() => {
        if (epoch === loadEpochRef.current) setSessions([]);
      })
      .finally(() => {
        if (epoch === loadEpochRef.current && !silent) setLoading(false);
      });
  }

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((info) => {
        if (cancelled) return;
        const running = normalizeAppVersion(info.version);
        if (running) setAppVersion(running);
      })
      .catch(() => {
        /* keep the Vite-baked fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 刷新指定项目或所有展开项目的会话列表缓存
  const refreshProjectSessions = useCallback((targetHashes?: string[]) => {
    const hashes = new Set<string>(targetHashes ?? []);
    if (projectHash) hashes.add(projectHash);
    expandedProjects.forEach((h) => hashes.add(h));

    hashes.forEach((hash) => {
      listProjectSessions(hash)
        .then((list) => {
          setProjectSessionsMap((m) => ({ ...m, [hash]: list }));
        })
        .catch(() => {});
    });
  }, [projectHash, expandedProjects]);

  const loadSidebar = useCallback(() => {
    getSidebarProjects()
      .then((view) => {
        const hidden = new Set(view.hidden);
        for (const hash of pendingHideRef.current) {
          if (hidden.has(hash)) pendingHideRef.current.delete(hash);
          else hidden.add(hash);
        }
        for (const hash of pendingRevealRef.current) {
          if (!hidden.has(hash)) pendingRevealRef.current.delete(hash);
          else hidden.delete(hash);
        }
        setHiddenProjectHashes(hidden);
        setPinnedProjects(view.pinned ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
    refreshProjectSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // 页面可见时周期刷新侧栏：API（OpenAI/Anthropic）在其他会话/其他端发起的
  // turn 不会经过本端的 /chat 或 /live，WebUI 无法感知 → 新建会话不出现。
  // 5s 轮询兜底，让 API 新建/更新的会话实时浮现，无需手动刷新。仅页面可见时
  // 运行，后台标签页不耗请求。
  useEffect(() => {
    let visible = !document.hidden;
    const refresh = () => {
      if (!visible) return;
      loadSessions(true);
      refreshProjectSessions();
      getProjects().then(setProjects).catch(() => {});
      loadSidebar();
      getActiveChatSessions()
        .then(setActiveIds)
        .catch(() => {});
    };
    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // 当 reloadKey 变更（例如回合结束 onLiveTurnDone 触发）时，立即主动刷新一次，
    // 零延迟解除活跃状态与转圈菊花，而不是傻等 5 秒后的 setInterval 首次触发！
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, refreshProjectSessions]);

  useEffect(() => {
    if (activeSessionId !== previousActiveSessionIdRef.current) {
      pendingCenterSessionIdRef.current = activeSessionId;
      previousActiveSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId]);

  useEffect(() => {
    const pendingId = pendingCenterSessionIdRef.current;
    if (loading || collapsed || !pendingId || pendingId !== activeSessionId) return;
    const container = sessionListBodyRef.current;
    const item = activeSessionItemRef.current;
    if (!container || !item || !container.contains(item)) return;
    item.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    pendingCenterSessionIdRef.current = null;
  }, [activeSessionId, collapsed, loading, sessions, projectHash]);

  useEffect(() => {
    getProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [reloadKey]);

  useEffect(() => {
    if (projectHash) {
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        next.add(projectHash);
        return next;
      });
      listProjectSessions(projectHash)
        .then((list) => {
          setProjectSessionsMap((m) => ({ ...m, [projectHash]: list }));
        })
        .catch(() => {});
    }
  }, [projectHash]);

  // 当有乐观会话产生时，自动展开其归属的项目文件夹，确保新会话立即呈现在视线中
  useEffect(() => {
    for (const opt of allOptimistic) {
      if (opt.project_hash) {
        setExpandedProjects((prev) => {
          if (prev.has(opt.project_hash!)) return prev;
          const next = new Set(prev);
          next.add(opt.project_hash!);
          return next;
        });
      }
    }
  }, [allOptimistic]);

  function toggleProjectExpand(hash: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
        listProjectSessions(hash)
          .then((list) => {
            setProjectSessionsMap((m) => ({ ...m, [hash]: list }));
          })
          .catch(() => {});
      }
      return next;
    });
  }

  function toggleShowAll(hash: string) {
    setShowAllProjects((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
        if (!projectSessionsMap[hash]) {
          listProjectSessions(hash)
            .then((list) => {
              setProjectSessionsMap((m) => ({ ...m, [hash]: list }));
            })
            .catch(() => {});
        }
      }
      return next;
    });
  }

  function openProjectInSidebar(hash: string) {
    if (!hash) return;
    setExpandedProjects((prev) => {
      if (prev.has(hash)) return prev;
      const next = new Set(prev);
      next.add(hash);
      return next;
    });
    listProjectSessions(hash)
      .then((list) => {
        setProjectSessionsMap((m) => ({ ...m, [hash]: list }));
      })
      .catch(() => {});
  }

  async function adoptProjectDirectory(path: string) {
    const clean = stripExtendedPathPrefix(path);
    let dir = clean;
    try {
      const info = await showSidebarProject(clean);
      dir = stripExtendedPathPrefix(info.working_dir || clean);
      pendingRevealRef.current.add(info.hash);
      pendingHideRef.current.delete(info.hash);
      setHiddenProjectHashes((prev) => {
        if (!prev.has(info.hash)) return prev;
        const next = new Set(prev);
        next.delete(info.hash);
        return next;
      });
      setPinnedProjects((prev) => (prev.some((p) => p.hash === info.hash) ? prev : [...prev, info]));
      openProjectInSidebar(info.hash);
      getProjects().then(setProjects).catch(() => {});
    } catch (err) {
      console.warn('show project failed:', err);
    }
    onSwitchProject?.(dir);
  }

  async function handleOpenNativeDirectory() {
    // A remote browser must not call /fs/pick_dir: that opens a native dialog
    // on the instance and the HTTP request stays open until someone closes it.
    if (!isLoopbackHost(window.location.hostname)) {
      setWebPickerOpen(true);
      return;
    }
    try {
      const res = await pickNativeDirectory();
      if (!res.canceled && res.path) {
        await adoptProjectDirectory(res.path);
      }
    } catch (err) {
      console.warn('Native folder pick failed:', err);
      setWebPickerOpen(true);
    }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem('jeikcode:hidden-project-hashes');
      if (!raw) return;
      localStorage.removeItem('jeikcode:hidden-project-hashes');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const hash of arr) {
        if (typeof hash !== 'string' || !hash) continue;
        pendingHideRef.current.add(hash);
        void hideSidebarProject(hash).catch(() => {});
      }
    } catch {
      /* ignore a corrupt local cache */
    }
  }, []);

  useEffect(() => {
    const onRefresh = () => loadSidebar();
    window.addEventListener('jeikcode:sidebar_projects', onRefresh);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel('jeikcode_sidebar_projects');
      channel.onmessage = () => loadSidebar();
    } catch {
      /* BroadcastChannel unavailable */
    }
    return () => {
      window.removeEventListener('jeikcode:sidebar_projects', onRefresh);
      channel?.close();
    };
  }, [loadSidebar]);

  useEffect(() => {
    const prev = prevHiddenRef.current;
    const reappeared: string[] = [];
    for (const hash of prev) {
      if (!hiddenProjectHashes.has(hash)) reappeared.push(hash);
    }
    prevHiddenRef.current = hiddenProjectHashes;
    for (const hash of reappeared) openProjectInSidebar(hash);
  }, [hiddenProjectHashes]);

  useEffect(() => {
    let cancelled = false;
    const running = new Set([...(activeIds), ...(extraRunningIds ?? [])]);
    const known = new Map<string, string>();
    const take = (session: { id: string; project_hash?: string }) => {
      if (session.id && session.project_hash) known.set(session.id, session.project_hash);
    };
    for (const session of sessions) take(session);
    for (const list of Object.values(projectSessionsMap)) {
      for (const session of list) take(session);
    }
    for (const session of allOptimistic) take(session);

    const hashes = new Set<string>();
    for (const id of running) {
      const hash = known.get(id);
      if (hash && hiddenProjectHashes.has(hash)) hashes.add(hash);
    }
    for (const session of allOptimistic) {
      if (session.project_hash && hiddenProjectHashes.has(session.project_hash)) {
        hashes.add(session.project_hash);
      }
    }
    const missing = [...running].filter((id) => !known.has(id));
    void (async () => {
      for (const id of missing) {
        try {
          const found = await resolveSession(id);
          if (cancelled || !found?.project_hash) continue;
          if (hiddenProjectHashes.has(found.project_hash)) hashes.add(found.project_hash);
        } catch {
          /* the next poll retries */
        }
      }
      if (cancelled) return;
      for (const hash of hashes) {
        if (revealingRef.current.has(hash)) continue;
        revealingRef.current.add(hash);
        pendingRevealRef.current.add(hash);
        pendingHideRef.current.delete(hash);
        setHiddenProjectHashes((prev) => {
          if (!prev.has(hash)) return prev;
          const next = new Set(prev);
          next.delete(hash);
          return next;
        });
        openProjectInSidebar(hash);
        revealSidebarProject(hash)
          .catch(() => {})
          .finally(() => revealingRef.current.delete(hash));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeIds, extraRunningIds, sessions, projectSessionsMap, allOptimistic, hiddenProjectHashes]);

  // The kebab menu is fixed-positioned (so the list's overflow can't clip it);
  // close it on outside click, scroll, or resize since it won't track anchors.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (itemMenuRef.current?.contains(el)) return;
      // Clicks on a kebab button are handled by its own toggle.
      if (el.closest?.('.session-item-kebab')) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menuFor]);

  function openItemMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (menuFor === id) {
      setMenuFor(null);
      return;
    }
    const right = window.innerWidth - rect.right;
    // 3 rows (rename + export + delete); estimate generously so we flip up a touch
    // early rather than let the last item clip off the bottom edge.
    const MENU_EST_HEIGHT = 144;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < MENU_EST_HEIGHT + 8) {
      // Not enough room below → open upward, anchored above the kebab.
      setMenuPos({ bottom: window.innerHeight - rect.top + 4, right });
    } else {
      setMenuPos({ top: rect.bottom + 4, right });
    }
    setMenuFor(id);
  }

  function handleRenamed(id: string, name: string) {
    loadSessions();
    setProjectSessionsMap((prev) => {
      const next = { ...prev };
      for (const hash of Object.keys(next)) {
        next[hash] = next[hash].map((s) => (s.id === id ? { ...s, name } : s));
      }
      return next;
    });
    onSessionRenamed?.(id, name);
  }

  function handleDeleted(ids: string[]) {
    // The DELETE response is authoritative for these rows. Removing them locally
    // avoids an O(N) catalog reload after every deletion, which made clearing a
    // large history progressively slow. Invalidate any older in-flight list
    // response so it cannot resurrect the deleted row; normal reload triggers
    // still reconcile the complete list later.
    loadEpochRef.current += 1;
    setLoading(false);
    const removed = new Set(ids);
    setSessions((current) => current.filter((session) => !removed.has(session.id)));
    setProjectSessionsMap((prev) => {
      const next = { ...prev };
      for (const hash of Object.keys(next)) {
        next[hash] = next[hash].filter((s) => !removed.has(s.id));
      }
      return next;
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    for (const id of ids) onSessionDeleted?.(id);
  }

  function handleDeleteBatchStart(count: number) {
    setDeleteError(null);
    setPendingDeleteCount(count);
  }

  function handleDeleteBatchProgress() {
    setPendingDeleteCount((current) => Math.max(0, current - 1));
  }

  function handleDeleteBatchFinished(error: string | null) {
    setPendingDeleteCount(0);
    if (error) {
      setDeleteError(error);
      return;
    }
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Export a session's conversation as a Markdown file and trigger a browser download. */
  async function handleExportMarkdown(session: SessionMetaWithProject) {
    setMenuFor(null);
    try {
      const detail = await getSession(session.project_hash, session.id);
      const title = detail.name || detail.id.slice(0, 8);
      const lines = sessionMessagesToMarkdownLines(detail.messages, title);
      const mdContent = lines.join('\n');
      // Trigger browser download
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
    }
  }

  // Settings menu: fixed-anchored above its button; close on outside/scroll/resize.
  useEffect(() => {
    if (!settingsMenuOpen) return;
    const close = () => setSettingsMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (settingsMenuRef.current?.contains(el)) return;
      // Clicks on a settings trigger are handled by its own toggle.
      if (el.closest?.('.sidebar-settings-btn, .rail-btn-settings')) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [settingsMenuOpen]);

  function toggleSettingsMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (settingsMenuOpen) {
      setSettingsMenuOpen(false);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Anchor the menu's bottom just above the button (it opens upward).
    setSettingsMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    setSettingsSub(null);
    setSettingsMenuOpen(true);
  }

  function chooseSettings(section: SettingsSection) {
    setSettingsMenuOpen(false);
    onCloseDrawer?.();
    onOpenSettings(section);
  }

  // Fetch skills once (for the count badge + menu list).
  function ensureSkills() {
    if (skills !== null || skillsLoading) return;
    setSkillsLoading(true);
    getSkills()
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setSkillsLoading(false));
  }
  useEffect(() => {
    ensureSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Skills menu is fixed-positioned (so the action row's container can't clip
  // it); close on outside click / scroll / resize.
  // Scroll events originating inside the menu itself are ignored so the user
  // can scroll the list without the menu closing.
  useEffect(() => {
    if (!skillsMenuOpen) return;
    const close = () => setSkillsMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (skillsMenuRef.current?.contains(el)) return;
      if (skillsBtnRef.current?.contains(el)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (skillsMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [skillsMenuOpen]);

  function toggleSkillsMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (skillsMenuOpen) {
      setSkillsMenuOpen(false);
      return;
    }
    ensureSkills();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSkillsMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setSkillsMenuOpen(true);
  }

  function chooseSkill(name: string) {
    setSkillsMenuOpen(false);
    onPickSkill?.(name);
  }

  // Fetch MCP status (for the count badge + menu list). Unlike a one-shot cache,
  // this can re-run: remote servers (especially HTTP) connect asynchronously, so
  // an early snapshot can show them as `connecting` and must be refreshed until
  // they settle. Only the in-flight fetch is deduped (mcpLoading), not the result.
  function refreshMcpStatus() {
    if (mcpLoading) return;
    setMcpLoading(true);
    getMcpStatus()
      .then((status) => {
        setMcpStatus(status);
      })
      // On a transient error keep whatever we had; only fall back to empty if we
      // never got a result, so a blip doesn't wipe a populated panel.
      .catch((_err) => {
        setMcpStatus((cur) => cur ?? { servers: [] });
      })
      .finally(() => setMcpLoading(false));
  }

  async function reloadMcpServers(e?: MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    if (mcpReloading) return;
    setMcpReloading(true);
    setMcpReloaded(false);
    setMcpLoading(true);
    setMcpStatus((cur) =>
      cur
        ? {
            ...cur,
            servers: cur.servers.map((srv) =>
              srv.status === 'connected' ? { ...srv, status: 'connecting' } : srv,
            ),
          }
        : cur,
    );
    try {
      await postMcpReload();
      mcpPollAttemptsRef.current = 0;
      let status = await getMcpStatus();
      setMcpStatus(status);
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!(status.servers ?? []).some((srv) => srv.status === 'connecting')) break;
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        status = await getMcpStatus();
        setMcpStatus(status);
      }
      setMcpReloaded(true);
      if (mcpReloadedTimerRef.current != null) window.clearTimeout(mcpReloadedTimerRef.current);
      mcpReloadedTimerRef.current = window.setTimeout(() => setMcpReloaded(false), 2500);
    } catch {
      setMcpStatus((cur) => cur ?? { servers: [] });
    } finally {
      setMcpLoading(false);
      setMcpReloading(false);
    }
  }
  useEffect(() => {
    refreshMcpStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Poll while any server is still `connecting` so the panel converges to the
  // settled state (connected / error) without the user reopening it. Servers
  // resolve to connected/failed within their timeout, so this stops on its own;
  // an attempt cap guards against a server that never settles.
  useEffect(() => {
    const anyConnecting = (mcpStatus?.servers ?? []).some((s) => s.status === 'connecting');
    if (!anyConnecting) {
      mcpPollAttemptsRef.current = 0;
      return;
    }
    if (mcpPollAttemptsRef.current >= 20) return; // ~30s ceiling
    const id = window.setTimeout(() => {
      mcpPollAttemptsRef.current += 1;
      refreshMcpStatus();
    }, 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpStatus]);

  // MCP menu is fixed-positioned; close on outside click / scroll / resize.
  // Scroll events originating inside the menu itself are ignored so the user
  // can scroll the list without the menu closing.
  useEffect(() => {
    if (!mcpMenuOpen) return;
    const close = () => setMcpMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (mcpMenuRef.current?.contains(el)) return;
      if (mcpBtnRef.current?.contains(el)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (mcpMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [mcpMenuOpen]);

  async function onTrust() {
    if (trusting) return;
    setTrusting(true);
    setTrustError(null);
    try {
      const result = await postLiveMcpTrust();
      if (result.ok) {
        // Refresh MCP status so the blocked notice disappears and new servers appear.
        mcpPollAttemptsRef.current = 0;
        refreshMcpStatus();
      } else {
        setTrustError(result.error ?? 'Trust failed');
      }
    } catch (e) {
      setTrustError(e instanceof Error ? e.message : 'Trust failed');
    } finally {
      setTrusting(false);
    }
  }

  function toggleMcpMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (mcpMenuOpen) {
      setMcpMenuOpen(false);
      return;
    }
    // Reopening forces a fresh fetch (and restarts the connecting poll) so a
    // panel that was empty during the connect window picks up newly-ready servers.
    mcpPollAttemptsRef.current = 0;
    refreshMcpStatus();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMcpMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setMcpMenuOpen(true);
  }

  // Close the search dialog on Escape (backdrop click is handled on the overlay).
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  // Focus the input on open; reset query/results on close so a reopen starts
  // fresh instead of flashing the previous search's stale results.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    } else {
      setSearchQuery('');
      setSearchResults([]);
      setSearchBusy(false);
    }
  }, [searchOpen]);

  // Cross-project search: debounce the query and hit the all-projects endpoint.
  // Empty query → clear (the modal then shows the current project's list).
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSessions(q)
        .then((r) => {
          if (!cancelled) setSearchResults(r);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearchBusy(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchOpen]);

  // The settings popup (3 entries). Fixed-positioned, but portaled to <body>:
  // on mobile the sidebar becomes a `transform`ed off-canvas drawer, which
  // would make it the containing block for `position: fixed` descendants and
  // clip them with its `overflow: hidden`. Portaling escapes the drawer so the
  // menu is positioned against the viewport (its getBoundingClientRect coords)
  // and never clipped. Rendered inside both the rail and expanded layouts.
  const renderSettingsMenu = () =>
    settingsMenuOpen && settingsMenuPos
      ? createPortal(
      <div
        class="item-menu settings-menu"
        ref={settingsMenuRef}
        style={{ left: `${settingsMenuPos.left}px`, bottom: `${settingsMenuPos.bottom}px` }}
      >
        <div class="group-by-menu-title">{t('sidebar.settings')}</div>

        {/* 主题：选项少，直接内联展开二级菜单 */}
        <button
          class="item-menu-row"
          onClick={() => setSettingsSub((s) => (s === 'theme' ? null : 'theme'))}
        >
          <ThemeGlyph />
          <span>{t('settings.menuTheme')}</span>
          <span class="submenu-caret">{settingsSub === 'theme' ? '▾' : '▸'}</span>
        </button>
        {settingsSub === 'theme' && (
          <div class="settings-submenu">
            {(
              [
                ['light', t('settings.theme.light')],
                ['dark', t('settings.theme.dark')],
                ['system', t('settings.theme.system')],
              ] as [Theme, string][]
            ).map(([v, label]) => (
              <button key={v} class="item-menu-row sub" onClick={() => setTheme(v)}>
                <span>{label}</span>
                {theme === v && <CheckIcon />}
              </button>
            ))}
          </div>
        )}

        {/* 语言：同样内联展开 */}
        <button
          class="item-menu-row"
          onClick={() => setSettingsSub((s) => (s === 'language' ? null : 'language'))}
        >
          <LangGlyph />
          <span>{t('settings.menuLang')}</span>
          <span class="submenu-caret">{settingsSub === 'language' ? '▾' : '▸'}</span>
        </button>
        {settingsSub === 'language' && (
          <div class="settings-submenu">
            {languageOptions.map(({ value: v, label }) => (
              <button key={v} class="item-menu-row sub" onClick={() => setLang(v)}>
                <span>{label}</span>
                {lang === v && <CheckIcon />}
              </button>
            ))}
          </div>
        )}

        {/* 模型配置：内容多，仍用弹窗 */}
        <button class="item-menu-row" onClick={() => chooseSettings('model')}>
          <ModelGlyph />
          <span>{t('settings.menuModel')}</span>
        </button>
      </div>,
          document.body,
        )
      : null;

  // Skills popover (opens downward below the Skills action). Portaled to <body>
  // so the mobile drawer's transform/overflow can't clip it. Selecting a skill
  // inserts `/name ` into the chat input (via onPickSkill, lifted to App).
  const renderSkillsMenu = () =>
    skillsMenuOpen && skillsMenuPos
      ? createPortal(
          <div
            class="item-menu skills-menu"
            ref={skillsMenuRef}
            style={{
              top: `${skillsMenuPos.top}px`,
              left: `${skillsMenuPos.left}px`,
              minWidth: `${Math.max(skillsMenuPos.width, 200)}px`,
            }}
          >
            {skillsLoading && <div class="group-by-menu-title">{t('sidebar.skillsLoading')}</div>}
            {!skillsLoading && (skills?.length ?? 0) === 0 && (
              <div class="group-by-menu-title">{t('sidebar.skillsEmpty')}</div>
            )}
            {!skillsLoading &&
              (skills ?? []).map((s) => (
                <button key={s.name} class="skills-menu-row" onClick={() => chooseSkill(s.name)} title={s.description || ''}>
                  <span class="skills-menu-name">/{s.name}</span>
                  {s.description && <span class="skills-menu-desc">{s.description}</span>}
                </button>
              ))}
          </div>,
          document.body,
        )
      : null;

  // MCP popover (opens downward below the MCP action). Portaled to <body>
  // so the mobile drawer's transform/overflow can't clip it. Shows each
  // MCP server name, its connection status, and (if connected) tool count.
  const renderMcpMenu = () =>
    mcpMenuOpen && mcpMenuPos
      ? createPortal(
          <div
            class="item-menu mcp-menu"
            ref={mcpMenuRef}
            style={{
              top: `${mcpMenuPos.top}px`,
              left: `${mcpMenuPos.left}px`,
              minWidth: `${Math.max(mcpMenuPos.width, 220)}px`,
            }}
          >
            <div class="mcp-menu-header">
              <span class="group-by-menu-title">{t('sidebar.mcp')}</span>
              {mcpReloaded && !mcpReloading && (
                <span class="mcp-reloaded-hint">{t('sidebar.mcpReloaded')}</span>
              )}
              <button
                type="button"
                class={'mcp-refresh-btn' + (mcpReloading ? ' spinning' : '')}
                disabled={mcpReloading}
                title={mcpReloading ? t('sidebar.mcpReloading') : t('sidebar.mcpRefresh')}
                aria-label={mcpReloading ? t('sidebar.mcpReloading') : t('sidebar.mcpRefresh')}
                onClick={(ev) => void reloadMcpServers(ev as unknown as MouseEvent)}
                onMouseDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); }}
              >
                <RefreshIcon />
              </button>
            </div>
            {mcpLoading && !mcpStatus && <div class="group-by-menu-title">{t('sidebar.mcpLoading')}</div>}
            {!mcpLoading && (mcpStatus?.servers?.length ?? 0) === 0 && !(mcpStatus?.blocked?.length) && (
              <div class="group-by-menu-title">{t('sidebar.mcpEmpty')}</div>
            )}
            {(mcpStatus?.blocked?.length ?? 0) > 0 && (
              <div class="mcp-blocked-notice">
                <span>{t('mcp.blockedUntrusted').replace('{n}', String(mcpStatus!.blocked!.length))}</span>
                {trustError && <span class="mcp-blocked-error">{trustError}</span>}
                <button class="btn btn-primary" disabled={trusting} onClick={onTrust}>
                  {trusting ? '…' : t('mcp.trustProject')}
                </button>
              </div>
            )}
            {(mcpStatus?.servers ?? []).map((srv) => {
                const statusLabel =
                  srv.status === 'connected' ? t('sidebar.mcpConnected') :
                  srv.status === 'connecting' ? t('sidebar.mcpConnecting') :
                  srv.status === 'error' ? t('sidebar.mcpError') :
                  t('sidebar.mcpDisconnected');
                const statusClass = 'mcp-status-dot ' + srv.status;
                return (
                  <div key={srv.name} class="mcp-menu-row" title={srv.error || ''}>
                    <span class="mcp-menu-name">{srv.name}</span>
                    <span class="mcp-menu-meta">
                      <span class={statusClass} />
                      <span class="mcp-menu-status-text">{statusLabel}</span>
                      {srv.tool_count != null && (
                        <span class="mcp-menu-tool-count">{t('sidebar.mcpTools', { n: srv.tool_count })}</span>
                      )}
                    </span>
                    {srv.error && <span class="mcp-menu-error">{srv.error}</span>}
                  </div>
                );
              })}
          </div>,
          document.body,
        )
      : null;

  // 乐观会话并入列表：仅当后端列表尚无对应条目时置顶插入。后端落盘后列表刷新带出
  // 真实会话，此处便不再插入，真实条目（含自动命名标题）自然取而代之。注意乐观条目
  // 与落盘条目的 id 可能不同（live 快照的会话 id ≠ /sessions 列出的 core .json id），
  // 故 mergeOptimisticSessions 在 id 不匹配时按「同目录 + 名字互为前缀」兜底去重，
  // 避免出现两条相同会话（刷新才消失）。
  const merged = mergeOptimisticSessions(allOptimistic, sessions);

  const allProjects = projects.slice();
  for (const pinned of pinnedProjects) {
    if (!allProjects.some((p) => p.hash === pinned.hash)) allProjects.push(pinned);
  }
  if (projectHash && !allProjects.some((p) => p.hash === projectHash) && !hiddenProjectHashes.has(projectHash)) {
    allProjects.unshift({
      hash: projectHash,
      name: shortDir(cwd || ''),
      working_dir: cwd || '',
      session_count: 0,
      created_at: Date.now(),
      last_updated: Date.now(),
    });
  }
  const sameProjectDir = (a?: string, b?: string) => {
    if (!a || !b) return false;
    const norm = (p: string) => stripExtendedPathPrefix(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
  };
  const projectActivity = (p: ProjectInfo) => {
    let ts = p.last_updated || p.created_at || 0;
    const bump = (s: { updated_at?: number; created_at?: number }) => {
      ts = Math.max(ts, s.updated_at || s.created_at || 0);
    };
    for (const s of sessions) if (s.project_hash === p.hash) bump(s);
    for (const s of projectSessionsMap[p.hash] ?? []) bump(s);
    for (const s of allOptimistic) {
      if (s.project_hash === p.hash || sameProjectDir(s.working_dir, p.working_dir)) bump(s);
    }
    return ts;
  };
  const activeSet = new Set([...activeIds, ...(extraRunningIds ?? [])]);
  const projectIsRunning = (p: ProjectInfo) => {
    const rows = [
      ...sessions.filter((s) => s.project_hash === p.hash),
      ...(projectSessionsMap[p.hash] ?? []),
      ...allOptimistic.filter(
        (s) => s.project_hash === p.hash || sameProjectDir(s.working_dir, p.working_dir),
      ),
    ];
    return rows.some((s) => activeSet.has(s.id));
  };
  allProjects.sort((a, b) => {
    const ar = projectIsRunning(a) ? 1 : 0;
    const br = projectIsRunning(b) ? 1 : 0;
    if (ar !== br) return br - ar;
    return projectActivity(b) - projectActivity(a);
  });
  const visibleProjects = allProjects.filter((p) => !hiddenProjectHashes.has(p.hash));

  const sortSessions = (list: SessionMetaWithProject[]) => {
    return list.slice().sort((a, b) => {
      const aAct = activeSet.has(a.id) ? 1 : 0;
      const bAct = activeSet.has(b.id) ? 1 : 0;
      if (aAct !== bAct) return bAct - aAct;
      return (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0);
    });
  };

  const q = query.trim().toLowerCase();
  const searchFiltered = q
    ? merged.filter(
        (s) =>
          (s.name || '').toLowerCase().includes(q) ||
          s.id.toLowerCase().startsWith(q) ||
          (s.working_dir || '').toLowerCase().includes(q),
      )
    : [];

  const knownHashes = new Set(allProjects.map((p) => p.hash));
  const recentsList = sortSessions(
    merged.filter((s) => !s.project_hash || !knownHashes.has(s.project_hash))
  );

  const filtered = q ? searchFiltered : merged;

  const renderItem = (s: SessionMetaWithProject) => {
    const active = s.id === activeSessionId;
    const running = activeSet.has(s.id);
    const selected = selectedIds.has(s.id);
    const label = s.name || s.id.slice(0, 8);
    const dir = shortDir(s.working_dir);
    return (
      <div
        key={s.id}
        ref={active ? activeSessionItemRef : undefined}
        class={
          'session-item' +
          (active && !selectMode ? ' active' : '') +
          (running ? ' running' : '') +
          (menuFor === s.id ? ' menu-open' : '') +
          (selectMode && selected ? ' selected' : '') +
          (selectMode ? ' selecting' : '')
        }
      >
        {selectMode && (
          <button
            type="button"
            class={'session-item-check' + (selected ? ' checked' : '')}
            role="checkbox"
            aria-checked={selected}
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              toggleSelected(s.id);
            }}
          />
        )}
        <button
          class="session-item-main"
          onClick={() => (selectMode ? toggleSelected(s.id) : onSelect(s))}
          title={dir}
        >
          <div class="session-item-header">
            <span class="session-item-icon" aria-hidden="true"><ChatBubbleIcon /></span>
            <span class="session-item-name">{label}</span>
          </div>
          <span class="session-item-meta">
            {formatTime(s.updated_at || s.created_at, t)}
          </span>
        </button>
        {running && (
          <span
            class="session-item-running"
            title={t('sidebar.running')}
            aria-label={t('sidebar.running')}
          />
        )}
        {!selectMode && (
          <button
            class="session-item-kebab"
            onClick={(e) => openItemMenu(e as unknown as MouseEvent, s.id)}
            title={t('sidebar.itemMenu')}
            aria-label={t('sidebar.itemMenu')}
          >
            <KebabIcon />
          </button>
        )}
      </div>
    );
  };

  const menuSession = menuFor
    ? filtered.find((s) => s.id === menuFor) ?? sessions.find((s) => s.id === menuFor) ?? null
    : null;

  // Rail (collapsed desktop): a narrow icon rail instead of hiding the sidebar.
  // 移动端用抽屉；isMobile 随 matchMedia 更新，避免窄屏仍渲染 220px 空 rail。
  if (collapsed && !open && !isMobile) {
    return (
      <aside class="session-list app-sidebar collapsed">
        <nav class="sidebar-rail">
          <button
            class="rail-btn"
            onClick={onToggleCollapse}
            title={t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
          >
            <PanelIcon />
          </button>
          <button
            class="rail-btn"
            onClick={() => onNew('~')}
            title={t('sidebar.newChat')}
            aria-label={t('sidebar.newChat')}
          >
            <PlusIcon />
          </button>
          <button
            class="rail-btn"
            onClick={onToggleCollapse}
            title={t('sidebar.skills')}
            aria-label={t('sidebar.skills')}
          >
            <SparklesIcon />
          </button>
          <button
            class="rail-btn"
            onClick={onToggleCollapse}
            title={t('sidebar.mcp')}
            aria-label={t('sidebar.mcp')}
          >
            <McpIcon />
          </button>
        </nav>
        <div class="sidebar-rail-bottom">
          <button
            class="sidebar-rail-btn"
            onClick={() => {
              onCloseDrawer?.();
              onOpenSettings('model');
            }}
            title={t('settings.menuModel')}
            aria-label={t('settings.menuModel')}
          >
            <ModelGlyph />
          </button>
        </div>
      </aside>
    );
  }

  const skillCount = skills?.length ?? 0;
  const mcpCount = mcpStatus?.servers?.length ?? 0;

  return (
    <aside
      class={'session-list app-sidebar' + (open ? ' open' : '')}
      style={{ '--sidebar-width': `${sidebarWidth}px`, width: `var(--sidebar-width)` } as any}
    >
      {/* 边缘拖拽把手，支持拉宽侧栏以防标题文字被按钮遮挡 */}
      <div
        class="sidebar-resizer"
        onMouseDown={handleResizerMouseDown as any}
        title={t('sidebar.dragToResize') || 'Drag to resize'}
      />
      <div class="sidebar-brand-row">
        <span class="sidebar-brand">
<span class="sidebar-brand-name">JeikCode</span>
          <span class="sidebar-brand-version">{formatAppVersionLabel(appVersion) || 'v?'}</span>
        </span>
        <span class="sidebar-brand-btns">
          <button
            class="sidebar-search-btn"
            onClick={() => {
              onCloseDrawer?.();
              setSearchOpen(true);
              setSearchQuery('');
            }}
            title={t('sidebar.search')}
            aria-label={t('sidebar.search')}
          >
            <SearchIcon />
          </button>
          <button
            class="sidebar-collapse-btn"
            onClick={() => {
              if (open && onCloseDrawer) {
                onCloseDrawer();
              } else if (onToggleCollapse) {
                onToggleCollapse();
              }
            }}
            title={t('sidebar.collapse')}
            aria-label={t('sidebar.collapse')}
          >
            <PanelIcon />
          </button>
        </span>
      </div>

      <div class="sidebar-actions">
        <button class="sidebar-action" onClick={() => { exitSelectMode(); onNew('~'); }}>
          <span class="sidebar-action-icon"><PlusIcon /></span>
          <span class="sidebar-action-label">{t('sidebar.newChat')}</span>
        </button>
        <button
          ref={skillsBtnRef}
          class={'sidebar-action' + (skillsMenuOpen ? ' open' : '')}
          onClick={(e) => toggleSkillsMenu(e as unknown as MouseEvent)}
          aria-haspopup="menu"
          aria-expanded={skillsMenuOpen}
        >
          <span class="sidebar-action-icon"><SparklesIcon /></span>
          <span class="sidebar-action-label">{t('sidebar.skills')}</span>
          {skillCount > 0 && <span class="sidebar-action-badge">{skillCount}</span>}
          <span class="sidebar-action-caret"><ChevronDownIcon /></span>
        </button>
        <button
          ref={mcpBtnRef}
          class={'sidebar-action' + (mcpMenuOpen ? ' open' : '')}
          onClick={(e) => toggleMcpMenu(e as unknown as MouseEvent)}
          aria-haspopup="menu"
          aria-expanded={mcpMenuOpen}
        >
          <span class="sidebar-action-icon"><McpIcon /></span>
          <span class="sidebar-action-label">{t('sidebar.mcp')}</span>
          {mcpCount > 0 && <span class="sidebar-action-badge">{mcpCount}</span>}
          <span class="sidebar-action-caret"><ChevronDownIcon /></span>
        </button>
      </div>

      <div class="session-group-header">
        <span class="session-group-label">
          {selectMode ? t('sidebar.selectedCount', { n: selectedIds.size }) : t('sidebar.recent')}
        </span>
        <span class="session-group-actions">
          {selectMode ? (
            <>
              <button
                type="button"
                class="session-select-btn"
                onClick={() => {
                  const visible = filtered.map((s) => s.id);
                  const allSelected = visible.length > 0 && visible.every((id) => selectedIds.has(id));
                  setSelectedIds(allSelected ? new Set() : new Set(visible));
                }}
              >
                {t('sidebar.selectAll')}
              </button>
              <button
                type="button"
                class="session-select-btn"
                onClick={() => {
                  const visible = filtered.map((s) => s.id);
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const id of visible) {
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                    }
                    return next;
                  });
                }}
              >
                {t('sidebar.invertSelect')}
              </button>
              <button
                type="button"
                class="session-select-btn"
                onClick={exitSelectMode}
                disabled={pendingDeleteCount > 0}
              >
                {t('sidebar.selectDone')}
              </button>
            </>
          ) : (
            <button
              type="button"
              class="session-select-btn"
              onClick={() => {
                setMenuFor(null);
                setSelectMode(true);
              }}
              disabled={filtered.length === 0}
            >
              {t('sidebar.select')}
            </button>
          )}
        </span>
      </div>
      {selectMode && (
        <div class="session-select-delete-bar">
          {deleteError && (
            <div class="session-select-delete-error" role="alert">{deleteError}</div>
          )}
          {pendingDeleteCount > 0 && (
            <div class="session-select-delete-progress" aria-live="polite">
              {t('sidebar.deletingCount', { n: pendingDeleteCount })}
            </div>
          )}
          <button
            type="button"
            class="session-select-delete-btn"
            disabled={selectedIds.size === 0 || pendingDeleteCount > 0}
            onClick={() => {
              const targets = filtered.filter((s) => selectedIds.has(s.id));
              if (targets.length === 0) return;
              setDeleteError(null);
              setDeleteTargets(targets);
            }}
          >
            <TrashIcon />
            <span>
              {selectedIds.size > 0
                ? t('sidebar.deleteSelectedCount', { n: selectedIds.size })
                : t('sidebar.deleteSelected')}
            </span>
          </button>
        </div>
      )}

      <div class="session-list-body" ref={sessionListBodyRef} aria-busy={loading || pendingDeleteCount > 0}>
        {loading && allProjects.length === 0 && (
          <div class="session-empty">{t('sidebar.loading')}</div>
        )}
        {q ? (
          <div class="session-search-results">
            {searchFiltered.length === 0 && (
              <div class="session-empty">{t('sidebar.noMatch')}</div>
            )}
            {sortSessions(searchFiltered).map(renderItem)}
          </div>
        ) : (
          <>
            <div class="sidebar-section-header">
              <span class="sidebar-section-title">{t('sidebar.projects')}</span>
              <button
                type="button"
                class="sidebar-section-action-btn"
                onClick={handleOpenNativeDirectory}
                title={isLoopbackHost(window.location.hostname) ? t('sidebar.addProjectFolder') : t('sidebar.addProjectFolderRemote')}
                aria-label={isLoopbackHost(window.location.hostname) ? t('sidebar.addProjectFolder') : t('sidebar.addProjectFolderRemote')}
              >
                <PlusIcon />
              </button>
            </div>

            {visibleProjects.map((p) => {
              const isExpanded = expandedProjects.has(p.hash);
              const isShowAll = showAllProjects.has(p.hash);
              const baseSessions = projectSessionsMap[p.hash] ?? sessions.filter((s) => s.project_hash === p.hash);
              const projectOptimistics = allOptimistic.filter(
                (opt) =>
                  opt.project_hash === p.hash ||
                  (opt.working_dir && p.working_dir &&
                    (opt.working_dir === p.working_dir ||
                     opt.working_dir.replace(/\\/g, '/').toLowerCase() === p.working_dir.replace(/\\/g, '/').toLowerCase()))
              );
              const pSessions = projectOptimistics.length > 0
                ? mergeOptimisticSessions(projectOptimistics, baseSessions)
                : baseSessions;
              const sorted = sortSessions(pSessions);
              const displayList = isShowAll ? sorted : sorted.slice(0, 5);
              const count = Math.max(p.session_count, pSessions.length);

              return (
                <div key={p.hash} class="project-group">
                  <div
                    class={'project-group-header' + (p.hash === projectHash ? ' active-project' : '')}
                    onClick={() => toggleProjectExpand(p.hash)}
                  >
                    <span class="project-group-icon"><FolderIcon /></span>
                    <span class="project-group-name" title={p.working_dir}>
                      {p.name || shortDir(p.working_dir)}
                    </span>
                    {count > 0 && <span class="project-group-badge">{count}</span>}

                    <div class="project-group-actions-cluster" onClick={(e) => e.stopPropagation()}>
                      {/* 在文件资源管理器打开项目目录 */}
                      {p.working_dir && (
                        <button
                          type="button"
                          class="project-group-action-btn"
                          onClick={() => void revealInFileExplorer(p.working_dir)}
                          title={t('sidebar.revealInExplorer')}
                          aria-label={t('sidebar.revealInExplorer')}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        </button>
                      )}

                      {/* 在当前项目发起新会话 */}
                      <button
                        type="button"
                        class="project-group-action-btn"
                        onClick={() => {
                          exitSelectMode();
                          onNew(p.working_dir);
                        }}
                        title={t('sidebar.newChat')}
                        aria-label={t('sidebar.newChat')}
                      >
                        +
                      </button>

                      {/* 从左侧列表清除该项目显示（保留磁盘物理文件与会话记录，再次添加时可还原） */}
                      <button
                        type="button"
                        class="project-group-action-btn danger"
                        onClick={() => setRemoveProjectTarget(p)}
                        title={t('sidebar.removeProjectFromList')}
                        aria-label={t('sidebar.removeProjectFromList')}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>

                    <span class="project-group-caret">
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  </div>
                  {isExpanded && (
                    <div class="project-sessions-list">
                      {displayList.map(renderItem)}
                      {sorted.length > 5 && (
                        <button
                          type="button"
                          class="project-show-more-btn"
                          onClick={() => toggleShowAll(p.hash)}
                        >
                          <span>{isShowAll ? t('sidebar.showLess') : t('sidebar.showMore')}</span>
                        </button>
                      )}
                      {sorted.length === 0 && (
                        <div class="session-empty" style={{ padding: '6px 12px', fontSize: '11.5px' }}>
                          {t('sidebar.empty')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {recentsList.length > 0 && (
              <div class="sidebar-recents-section">
                <div class="sidebar-section-header">
                  <span class="sidebar-section-title">{t('sidebar.recents')}</span>
                </div>
                <div class="project-sessions-list" style={{ paddingLeft: 0 }}>
                  {recentsList.slice(0, 10).map(renderItem)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div class="sidebar-bottom">
        <span class="sidebar-bottom-spacer" />
        <button
          class="sidebar-icon-btn sidebar-settings-btn"
          onClick={() => {
            onCloseDrawer?.();
            onOpenSettings('model');
          }}
          title={t('settings.menuModel')}
          aria-label={t('settings.menuModel')}
        >
          <ModelGlyph />
        </button>
      </div>
      {renderSkillsMenu()}
      {renderMcpMenu()}

      {/* Session search dialog (centered modal) */}
      {searchOpen && createPortal(
        <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setSearchOpen(false); }}>
          <div class="modal-card search-modal-card">
            <div class="search-input-row">
              <SearchIcon />
              <input
                ref={searchInputRef}
                class="search-input"
                type="text"
                placeholder={t('sidebar.searchPlaceholder')}
                value={searchQuery}
                onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                autofocus
              />
            </div>
            <div class="search-results">
              {(() => {
                const q = searchQuery.trim();
                // Non-empty query → cross-project results from the endpoint;
                // empty → the current project's loaded list (recent).
                const results = q ? searchResults : sessions;
                if (q && searchBusy && results.length === 0) {
                  return <div class="search-empty">{t('sidebar.searching')}</div>;
                }
                if (results.length === 0) {
                  return <div class="search-empty">{t('sidebar.noMatch')}</div>;
                }
                // 日期分组
                const groups: { key: string; items: typeof results }[] = [];
                for (const s of results) {
                  const key = dateKey(s.updated_at || s.created_at);
                  const last = groups[groups.length - 1];
                  if (last && last.key === key) {
                    last.items.push(s);
                  } else {
                    groups.push({ key, items: [s] });
                  }
                }
                return groups.map((g) => (
                  <div key={g.key} class="search-date-group">
                    <div class="search-date-label">{friendlyDateLabel(g.key, t)}</div>
                    {g.items.map((s) => {
                      const label = s.name || s.id.slice(0, 8);
                      const dir = shortDir(s.working_dir);
                      return (
                        <button
                          key={s.id}
                          class={'search-result-item' + (s.id === activeSessionId ? ' active' : '')}
                          onClick={() => { onSelect(s); setSearchOpen(false); }}
                        >
                          <span class="search-result-name">{label}</span>
                          <span class="search-result-dir">{dir}</span>
                          <span class="search-result-time">{formatTime(s.updated_at || s.created_at, t)}</span>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Per-session actions menu. Fixed + portaled to <body> so neither the
          scroll container nor the mobile drawer's transform/overflow clips it. */}
      {menuSession && menuPos && createPortal(
        <div
          class="item-menu"
          ref={itemMenuRef}
          style={{
            top: menuPos.top != null ? `${menuPos.top}px` : undefined,
            bottom: menuPos.bottom != null ? `${menuPos.bottom}px` : undefined,
            right: `${menuPos.right}px`,
          }}
        >
          <button
            class="item-menu-row"
            onClick={() => {
              setRenameTarget(menuSession);
              setMenuFor(null);
            }}
          >
            <PencilIcon />
            <span>{t('sidebar.rename')}</span>
          </button>
          <button
            class="item-menu-row"
            onClick={() => handleExportMarkdown(menuSession)}
          >
            <DownloadIcon />
            <span>{t('sidebar.exportMarkdown')}</span>
          </button>
          <button
            class="item-menu-row danger"
            onClick={() => {
              setDeleteTargets([menuSession]);
              setMenuFor(null);
            }}
          >
            <TrashIcon />
            <span>{t('sidebar.delete')}</span>
          </button>
        </div>,
        document.body,
      )}

      {renameTarget && createPortal(
        <RenameDialog
          session={renameTarget}
          onClose={() => setRenameTarget(null)}
          onDone={(name) => handleRenamed(renameTarget.id, name)}
        />,
        document.body,
      )}
      {removeProjectTarget && createPortal(
        <ConfirmDialog
          title={t('sidebar.removeProjectTitle')}
          body={t('sidebar.removeProjectBody', {
            name: removeProjectTarget.name || shortDir(removeProjectTarget.working_dir),
          })}
          confirmLabel={t('sidebar.removeProjectConfirm')}
          cancelLabel={t('common.cancel')}
          onClose={() => setRemoveProjectTarget(null)}
          onConfirm={async () => {
            const hash = removeProjectTarget.hash;
            pendingHideRef.current.add(hash);
            pendingRevealRef.current.delete(hash);
            setHiddenProjectHashes((prev) => {
              const next = new Set(prev);
              next.add(hash);
              return next;
            });
            await hideSidebarProject(hash);
          }}
        />,
        document.body,
      )}
      {webPickerOpen && createPortal(
        <CwdPicker
          current={cwd || '~'}
          title={t('sidebar.addProjectFolderRemote')}
          onClose={() => setWebPickerOpen(false)}
          onPick={(path) => { void adoptProjectDirectory(path); }}
        />,
        document.body,
      )}
      {deleteTargets && deleteTargets.length > 0 && createPortal(
        <DeleteDialog
          sessions={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDone={handleDeleted}
          onBatchStart={handleDeleteBatchStart}
          onBatchProgress={handleDeleteBatchProgress}
          onBatchFinished={handleDeleteBatchFinished}
        />,
        document.body,
      )}
    </aside>
  );
}
