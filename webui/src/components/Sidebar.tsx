// Session sidebar (Claude-Code-inspired: brand + collapse at top, CC-style
// new-conversation row, live-filtered session list, settings at the bottom;
// collapses to an icon rail).

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { listSessions, listProjectSessions, searchSessions, getCapabilities, toggleCapability, getMcpStatus, postMcpReload, postLiveMcpTrust, getSession, getProjects, getSidebarProjects, hideSidebarProject, showSidebarProject, revealSidebarProject, resolveSession, getActiveChatSessions, getHealth, pickNativeDirectory, revealInFileExplorer, CapabilityItem, CapScope, McpStatusInfo, SessionMetaWithProject, ProjectInfo, SidebarProjects } from '../api';
import { mergeSessionRow, onGlobalEvent, removeSessionRows } from '../lib/globalEvents';
import { deleteSessionCache } from '../lib/sessionCache';
import { bakedAppVersion, formatAppVersionLabel, normalizeAppVersion } from '../lib/appVersion';
import { useT, useSettings, SettingsSection, Theme } from '../settings';
import { MsgKey, Lang, languageOptions } from '../i18n';
import { RenameDialog, DeleteDialog } from './SessionDialogs';
import { ConfirmDialog } from './ConfirmDialog';
import { GitWebhookDialog } from './GitWebhookDialog';
import { showToast } from './Toast';
import { CwdPicker } from './CwdPicker';
import { mergeOptimisticSession, mergeOptimisticSessions, uniqueSessionsById } from '../lib/sessionList';
import {
  loadSidebarMemory,
  loadSidebarSnapshot,
  saveExpandedProjects,
  saveManuallyCollapsedProjects,
  saveShowAllProjects,
  saveSidebarSnapshot,
  type SidebarMemory,
  type SidebarSnapshot,
} from '../lib/navState';
import { mcpAutoTrustSignature, mcpEnableNeedsTrust } from '../lib/mcpTrust';
import { sessionMessagesToMarkdownLines } from '../lib/historyMessages';
import { collapseHomePath as collapseHomePathShared, displayPath, isLoopbackHost, stripExtendedPathPrefix } from '../lib/displayPath';
import { FileExplorer } from './FileExplorer';
import { getPageZoom } from '../lib/pageZoom';

interface SidebarProps {
  activeSessionId: string | null;
  /** 当前会话所属项目桶。刷新恢复时它可能先于会话列表就绪，
   *  用它立即展开正确的项目分组，避免空闲会话的分组一直保持折叠。 */
  activeProjectHash?: string;
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
  /** 刚真正完成（内核权威终态 completed）、还没被点开看过的 session：圈圈换成绿色对勾。 */
  completedIds?: string[];
  /** 从资源管理器打开文件 */
  onOpenFile?: (filePath: string) => void;
  activeFilePath?: string | null;
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

/** Cloud glyph for returning to the most recent AI conversation. */
function CloudIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

/** Folder glyph for opening/switching to the file explorer state. */
function FolderRailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
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

/**
 * 刚完成徽标：与运行圈圈同位置的绿色对勾（成功色跟随主题）。
 * 只用来标记「圈圈任务真正跑完」，点一下即进入会话并消失。
 */
function CompletedCheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.3 8.5l3 3 6.4-6.9"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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

/** Folder-open glyph — reused for "reveal the skill's folder" (same as a project folder). */
function FolderOpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Power button glyph (IEC 5009 power symbol: vertical line through broken circle) */
function PowerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 2.2v4.8" />
      <path d="M4 4.5a6 6 0 1 0 8 0" />
    </svg>
  );
}

/**
 * Two circular modern power switches (GLOBAL / PROJECT) for one capability row.
 * Green = powered ON / enabled, red = powered OFF / disabled.
 * Both scopes are toggled independently and the effective runtime state
 * is their union (disabled at either scope ⇒ disabled).
 */
function CapScopeToggles({
  item,
  busy,
  onToggle,
}: {
  item: CapabilityItem;
  busy: Set<string>;
  onToggle: (item: CapabilityItem, scope: CapScope, e: MouseEvent) => void;
}) {
  const t = useT();
  const toggleBtn = (scope: CapScope, label: string, disabled: boolean, baseTitle: string) => {
    const key = `${item.kind}:${item.id}:${scope}`;
    const statusText = disabled
      ? (scope === 'global' ? '全局：已禁用' : '项目：已禁用')
      : (scope === 'global' ? '全局：已启用' : '项目：已启用');
    const fullTitle = `${baseTitle} (${statusText})`;
    return (
      <div class="cap-scope-unit" title={fullTitle}>
        <span class="cap-scope-tag">{label}</span>
        <button
          type="button"
          class={'cap-power-btn ' + (disabled ? 'off' : 'on') + (busy.has(key) ? ' busy' : '')}
          title={fullTitle}
          aria-label={fullTitle}
          aria-pressed={!disabled}
          disabled={busy.has(key)}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => onToggle(item, scope, e as unknown as MouseEvent)}
        >
          <PowerIcon />
        </button>
      </div>
    );
  };
  return (
    <div class="cap-toggles">
      {toggleBtn('global', t('cap.global'), item.global_disabled, t('cap.toggleGlobal'))}
      {/* When the active project IS the user's home dir, the project state file
          and the global one are the SAME file — two toggles would fight over
          one state (clicking one appeared to flip the other). Show only global. */}
      {!item.project_scope_shared &&
        toggleBtn('project', t('cap.project'), item.project_disabled, t('cap.toggleProject'))}
    </div>
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

/** Settings gear glyph. */
function SettingsGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Git 自动同步 glyph（分支 + 汇合弧线）。 */
function GitSyncGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="3.6" r="1.7" stroke="currentColor" stroke-width="1.2" />
      <circle cx="4.5" cy="12.4" r="1.7" stroke="currentColor" stroke-width="1.2" />
      <circle cx="11.5" cy="8" r="1.7" stroke="currentColor" stroke-width="1.2" />
      <path d="M4.5 5.3v5.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      <path d="M6 4.4c2.4.3 3.3 1.5 4 2.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      <path d="M6 11.6c2.4-.3 3.3-1.5 4-2.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  );
}

/** Official GitHub Octocat mark glyph. */
function GithubLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

export function Sidebar({
  activeSessionId,
  activeProjectHash,
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
  completedIds,
  onOpenFile,
  activeFilePath,
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
  const { theme, setTheme, lang, setLang, githubLogo, autoGitSync, setAutoGitSync } = useSettings();
  const SIDEBAR_TAB_STORAGE_KEY = 'jeikcode:sidebar_tab';
  // Sidebar View Tab: 'chats' (会话与项目) vs 'files' (资源管理器)，刷新自动记忆最后选择
  const [sidebarTab, setSidebarTabState] = useState<'chats' | 'files'>(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY);
      if (saved === 'chats' || saved === 'files') return saved;
    } catch {}
    return 'chats';
  });
  const setSidebarTab = (tab: 'chats' | 'files') => {
    setSidebarTabState(tab);
    try {
      localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
    } catch {}
  };
  const [appVersion, setAppVersion] = useState(bakedAppVersion());
  // 首屏快照：列表/项目/选中行直接画上次那一份，随后服务端数据就地校准。
  const initialSidebarSnapshotRef = useRef<SidebarSnapshot | null | undefined>(undefined);
  if (initialSidebarSnapshotRef.current === undefined) {
    initialSidebarSnapshotRef.current = loadSidebarSnapshot();
  }
  const initialSidebarSnapshot = initialSidebarSnapshotRef.current;
  // 旧版快照没有 scrollTop：那种情况沿用“居中选中行”行为；
  // 新版快照则原地恢复滚动位置，避免刷新时列表再跳一次。
  const restoredScrollTopRef = useRef<number | null>(
    typeof initialSidebarSnapshot?.scrollTop === 'number' ? initialSidebarSnapshot.scrollTop : null,
  );
  const [sessions, setSessions] = useState<SessionMetaWithProject[]>(
    () => initialSidebarSnapshot?.sessions ?? [],
  );
  const [loading, setLoading] = useState(() => !initialSidebarSnapshot);
  // 活跃（正在运行 turn）的会话 id，来自 GET /chat/active；配合 5s 轮询，
  // 让「哪个会话正在执行」实时显示在侧栏行右侧的圈圈里。
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const sessionListBodyRef = useRef<HTMLDivElement | null>(null);
  const activeSessionItemRef = useRef<HTMLDivElement | null>(null);
  // Selection is an explicit navigation intent, unlike a background reload.
  // Keep it pending across a cross-project fetch until the destination row
  // actually exists; ordinary reloads must not steal the user's scroll.
  const pendingCenterSessionIdRef = useRef<string | null>(
    restoredScrollTopRef.current != null ? null : activeSessionId,
  );
  // 首帧若已有保存的滚动位置，就不要再居中选中行（否则会把恢复的位置顶掉）。
  const initialScrollWasRestoredRef = useRef(restoredScrollTopRef.current != null);
  const previousActiveSessionIdRef = useRef<string | null>(activeSessionId);
  // Project sessions accordion
  const [projects, setProjects] = useState<ProjectInfo[]>(() => initialSidebarSnapshot?.projects ?? []);
  const [projectSessionsMap, setProjectSessionsMap] = useState<Record<string, SessionMetaWithProject[]>>(
    () => initialSidebarSnapshot?.projectSessions ?? {},
  );

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
  // 同一浏览器刷新必须原样恢复上次展开的分组；只有跨设备/无痕冷启动
  // （localStorage 为空）才退回 daemon 的默认展开行为。
  const initialSidebarMemoryRef = useRef<SidebarMemory | null>(null);
  if (!initialSidebarMemoryRef.current) initialSidebarMemoryRef.current = loadSidebarMemory();
  const initialSidebarMemory = initialSidebarMemoryRef.current;
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(initialSidebarMemory.expanded),
  );
  const [showAllProjects, setShowAllProjects] = useState<Set<string>>(
    () => new Set(initialSidebarMemory.showAll),
  );
  const [hiddenProjectHashes, setHiddenProjectHashes] = useState<Set<string>>(
    () => new Set(initialSidebarSnapshot?.hidden ?? []),
  );
  const [pinnedProjects, setPinnedProjects] = useState<ProjectInfo[]>(
    () => initialSidebarSnapshot?.pinned ?? [],
  );
  const [removeProjectTarget, setRemoveProjectTarget] = useState<ProjectInfo | null>(null);
  const [gitWebhookProject, setGitWebhookProject] = useState<ProjectInfo | null>(null);
  const [webPickerOpen, setWebPickerOpen] = useState(false);
  const pendingHideRef = useRef<Set<string>>(new Set());
  const pendingRevealRef = useRef<Set<string>>(new Set());
  const revealingRef = useRef<Set<string>>(new Set());
  const prevHiddenRef = useRef<Set<string>>(new Set());
  // 记录用户主动手动折叠的项目（防止忙碌自动展开强制覆盖用户意图）。
  // 这个意图同样要跨刷新保留：刷新后自动展开不得把用户刚折叠的分组重新打开。
  const manuallyCollapsedProjectsRef = useRef<Set<string>>(
    new Set(initialSidebarMemory.collapsed),
  );
  // 记录冷启动时因保底而自动展开的项目 hash（用于后续发现真正忙碌项目时自动收起）
  const initialAutoExpandedHashRef = useRef<string | null>(null);
  const projectSessionsMapRef = useRef(projectSessionsMap);
  projectSessionsMapRef.current = projectSessionsMap;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const lastActiveSessionIdRef = useRef<string | null>(null);
  // 当前会话所属项目在数据就绪前的待展开目标（列表晚到时继续重试）。
  const pendingAutoExpandSessionRef = useRef<{ id: string; projectHash?: string } | null>(null);
  const expandedProjectsRef = useRef(expandedProjects);
  expandedProjectsRef.current = expandedProjects;
  // 首次恢复用瞬时定位，之后的用户切换才使用平滑滚动，避免刷新时列表来回滚动。
  const initialCenterDoneRef = useRef(false);
  const [query, setQuery] = useState('');
  // Capability menu (unified MCP server + skills list): fetched lazily; the count
  // badges show once loaded.
  const [capabilities, setCapabilities] = useState<CapabilityItem[] | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);
  const [capsBusy, setCapsBusy] = useState<Set<string>>(new Set());
  const [capsError, setCapsError] = useState<string | null>(null);
  const [skillsMenuOpen, setSkillsMenuOpen] = useState(false);
  const [skillsMenuPos, setSkillsMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const skillsMenuRef = useRef<HTMLDivElement | null>(null);
  const skillsBtnRef = useRef<HTMLButtonElement | null>(null);
  // MCP menu: the rows come from `capabilities`; `/mcp/status` is consumed only to
  // auto-confirm an untrusted project (no prompt is rendered).
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
  // 项目信任自动确认：签名 = 当前项目 + 被拦截 server 集合。同一次拦截只尝试一次，
  // 失败不循环重试；手动刷新（↻）与项目切换会重置签名，允许再次尝试。
  const mcpAutoTrustSigRef = useRef<string | null>(null);
  // 上次已拉取过能力表的项目身份（cwd|projectHash），用于项目切换后补拉一次。
  const capProjectKeyRef = useRef('');

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
  // 遮罩空白处点击关闭：仅在「按下」与「松开」都落在遮罩本身时生效，避免拖拽划词误关。
  const searchBackdropDismiss = useBackdropDismiss(() => setSearchOpen(false));
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
        if (epoch === loadEpochRef.current) setLoading(false);
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

  const applySidebarView = useCallback((view: SidebarProjects) => {
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
  }, []);

  const loadSidebar = useCallback(() => {
    getSidebarProjects().then(applySidebarView).catch(() => {});
  }, [applySidebarView]);

  // ── 纯事件驱动侧栏刷新机制（彻底拔除 5s 无脑定时轮询，释放 CPU 与网络 IO）──
  // 冷启动单次拉取项目与折叠状态；之后仅在 reloadKey 变更（新建/删除/回合完成/切目录）
  // 或切回前台时按需触发单次对齐，零定时器空转！
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return;
      loadSessions(true);
      refreshProjectSessions();
      loadSidebar();
      getActiveChatSessions()
        .then(setActiveIds)
        .catch(() => {});
    };

    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 当 reloadKey 变更时（例如回合结束 onTurnDone、删除会话、新建会话触发）即时核验一次
    refresh();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, refreshProjectSessions, loadSidebar]);

  // ── 跨实例增量订阅（无轮询、无整表重拉）──
  // 服务端只推“变了什么”（带 payload），这里按 id 就地 upsert/删行并同步失效缓存；
  // 刷新后仍以同一份本地缓存恢复，与后端保持最终一致。
  useEffect(() => {
    return onGlobalEvent((event) => {
      if (event.type === 'session_upsert') {
        const row = event.session;
        setSessions((cur) => mergeSessionRow(cur, row));
        setProjectSessionsMap((prev) => {
          const list = prev[row.project_hash];
          if (!list) return prev; // 未展开/未加载的项目不凭空造列表
          return { ...prev, [row.project_hash]: mergeSessionRow(list, row) };
        });
        return;
      }
      if (event.type === 'session_mode') {
        if (!event.session_id) return;
        setSessions((cur) =>
          cur.map((s) => (s.id === event.session_id ? { ...s, approval_mode: event.mode } : s))
        );
        setProjectSessionsMap((prev) => {
          let changed = false;
          const next: typeof prev = {};
          for (const [hash, list] of Object.entries(prev)) {
            const updated = list.map((s) =>
              s.id === event.session_id ? { ...s, approval_mode: event.mode } : s
            );
            if (updated !== list) changed = true;
            next[hash] = updated;
          }
          return changed ? next : prev;
        });
        return;
      }
      if (event.type === 'session_deleted') {
        const removed = new Set([event.session_id]);
        setSessions((cur) => removeSessionRows(cur, removed));
        setProjectSessionsMap((prev) => {
          let changed = false;
          const next: typeof prev = {};
          for (const [hash, list] of Object.entries(prev)) {
            const filtered = removeSessionRows(list, removed);
            if (filtered !== list) changed = true;
            next[hash] = filtered;
          }
          return changed ? next : prev;
        });
        setProjects((prev) =>
          prev.map((proj) =>
            proj.hash === event.project_hash
              ? { ...proj, session_count: Math.max(0, proj.session_count - 1) }
              : proj
          )
        );
        setSelectedIds((cur) => {
          if (!cur.has(event.session_id)) return cur;
          const next = new Set(cur);
          next.delete(event.session_id);
          return next;
        });
        setActiveIds((cur) =>
          cur.includes(event.session_id)
            ? cur.filter((id) => id !== event.session_id)
            : cur,
        );
        // 缓存必须同步失效，否则幽灵会话会在下一次读取时复活。
        void deleteSessionCache(event.project_hash, event.session_id);
        return;
      }
      if (event.type === 'runtime_activity') {
        setActiveIds((cur) => {
          const has = cur.includes(event.session_id);
          if (event.running && !has) return [...cur, event.session_id];
          if (!event.running && has) return cur.filter((id) => id !== event.session_id);
          return cur;
        });
        return;
      }
      if (event.type === 'activity') {
        setActiveIds((cur) => {
          const has = cur.includes(event.session_id);
          if (event.running && !has) return [...cur, event.session_id];
          if (!event.running && has) return cur.filter((id) => id !== event.session_id);
          return cur;
        });
        return;
      }
      if (event.type === 'sync') {
        loadSidebar();
        return;
      }
      if (event.type === 'sidebar_projects') {
        applySidebarView({
          hidden: Array.isArray(event.hidden) ? event.hidden : [],
          pinned: event.pinned ?? [],
        });
      }
    });
  }, [applySidebarView, loadSidebar]);

  useEffect(() => {
    if (activeSessionId !== previousActiveSessionIdRef.current) {
      pendingCenterSessionIdRef.current = activeSessionId;
      previousActiveSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId]);

  // 首帧恢复上次的列表滚动位置（在浏览器绘制前完成，避免先看到顶部再跳）。
  useLayoutEffect(() => {
    const top = restoredScrollTopRef.current;
    if (top == null) return;
    const container = sessionListBodyRef.current;
    if (!container) return;
    container.scrollTop = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
    restoredScrollTopRef.current = null; // 只恢复一次，后续网络更新不再拉回旧位置
    pendingCenterSessionIdRef.current = null;
  }, [sidebarTab, collapsed, sessions.length, projectSessionsMap, expandedProjects, projects]);

  // 展开状态属于「本浏览器上次看到的样子」，刷新后原样恢复；跨设备冷启动
  // 没有本地记忆，才由下方的活跃/忙碌自动展开兜底决定。
  useEffect(() => {
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  useEffect(() => {
    saveShowAllProjects(showAllProjects);
  }, [showAllProjects]);

  // 每次侧栏真实渲染后把这一屏存成快照；刷新首帧先还原它，
  // 服务端数据到达后再按 id 就地合并，绝不再经历“空列表 → 重排 → 选中”。
  const sidebarSnapshotRef = useRef<SidebarSnapshot | null>(null);
  sidebarSnapshotRef.current = {
    projects,
    pinned: pinnedProjects,
    sessions,
    projectSessions: projectSessionsMap,
    hidden: [...hiddenProjectHashes],
  };
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const snapshot = sidebarSnapshotRef.current;
      if (snapshot) {
        saveSidebarSnapshot({
          ...snapshot,
          scrollTop: sessionListBodyRef.current?.scrollTop ?? snapshot.scrollTop ?? 0,
        });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [projects, pinnedProjects, sessions, projectSessionsMap, hiddenProjectHashes]);

  // 刷新/关闭页面前同步落盘，避免刚好赶在 250ms 防抖窗口内丢掉最后一次状态。
  useEffect(() => {
    const flush = () => {
      const snapshot = sidebarSnapshotRef.current;
      if (!snapshot) return;
      saveSidebarSnapshot({
        ...snapshot,
        scrollTop: sessionListBodyRef.current?.scrollTop ?? snapshot.scrollTop ?? 0,
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    const pendingId = pendingCenterSessionIdRef.current;
    if (loading || collapsed || !pendingId || pendingId !== activeSessionId) return;
    const container = sessionListBodyRef.current;
    const item = activeSessionItemRef.current;
    if (!container || !item || !container.contains(item)) return;
    item.scrollIntoView({
      behavior: initialCenterDoneRef.current ? 'smooth' : 'auto',
      block: 'center',
      inline: 'nearest',
    });
    initialCenterDoneRef.current = true;
    pendingCenterSessionIdRef.current = null;
  }, [activeSessionId, activeProjectHash, collapsed, loading, sessions, projectSessionsMap, expandedProjects, projectHash]);

  useEffect(() => {
    getProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [reloadKey]);

  useEffect(() => {
    if (!projectHash) return;
    // 静默预加载当前项目的会话列表缓存，不强行默认自动展开空闲项目
    if (!projectSessionsMapRef.current[projectHash]) {
      listProjectSessions(projectHash)
        .then((list) => {
          setProjectSessionsMap((m) => ({ ...m, [projectHash]: list }));
        })
        .catch(() => {});
    }
  }, [projectHash]);

  // 当前会话所属项目必须在会话数据就绪后自动展开。刷新时 activeSessionId 往往
  // 先于 /sessions 与 /projects/:hash/sessions 到达；旧实现只跑一次、拿不到 hash
  // 就永久放弃，于是空闲会话的分组一直折叠（忙碌会话只是被忙碌兜底碰巧展开）。
  // 这里保留待展开目标，等列表/元数据任一到达后再完成一次，不重复覆盖用户操作。
  useEffect(() => {
    if (!activeSessionId) {
      pendingAutoExpandSessionRef.current = null;
      lastActiveSessionIdRef.current = null;
      return;
    }
    if (lastActiveSessionIdRef.current !== activeSessionId) {
      const isInitialSelection = lastActiveSessionIdRef.current === null;
      lastActiveSessionIdRef.current = activeSessionId;
      pendingAutoExpandSessionRef.current = { id: activeSessionId, projectHash: activeProjectHash };
      if (!(isInitialSelection && initialScrollWasRestoredRef.current)) {
        pendingCenterSessionIdRef.current = activeSessionId;
      }
    }
    const pending = pendingAutoExpandSessionRef.current;
    if (!pending || pending.id !== activeSessionId) return;
    if (!pending.projectHash && activeProjectHash) pending.projectHash = activeProjectHash;

    let targetHash = pending.projectHash;
    if (!targetHash) {
      for (const s of sessionsRef.current) {
        if (s.id === activeSessionId && s.project_hash) {
          targetHash = s.project_hash;
          break;
        }
      }
    }
    if (!targetHash) {
      for (const [pHash, pList] of Object.entries(projectSessionsMapRef.current)) {
        if (pList.some((s) => s.id === activeSessionId)) {
          targetHash = pHash;
          break;
        }
      }
    }
    if (!targetHash) return; // 列表尚未就绪：等 sessions / projectSessionsMap 变化后重试。
    pendingAutoExpandSessionRef.current = null;
    if (!manuallyCollapsedProjectsRef.current.has(targetHash)) {
      openProjectInSidebar(targetHash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeProjectHash, sessions, projectSessionsMap, projects, allOptimistic]);

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
    initialAutoExpandedHashRef.current = null;
    const next = new Set(expandedProjectsRef.current);
    if (next.has(hash)) {
      next.delete(hash);
      manuallyCollapsedProjectsRef.current.add(hash);
    } else {
      next.add(hash);
      manuallyCollapsedProjectsRef.current.delete(hash);
      if (!projectSessionsMapRef.current[hash]) {
        listProjectSessions(hash)
          .then((list) => {
            setProjectSessionsMap((m) => ({ ...m, [hash]: list }));
          })
          .catch(() => {});
      }
    }
    expandedProjectsRef.current = next;
    setExpandedProjects(next);
    // 同步落盘：折叠/展开与外层的展开记忆必须一起更新，
    // 否则紧接着的刷新可能读到「既展开又手动折叠」的冲突快照。
    saveExpandedProjects(next);
    saveManuallyCollapsedProjects(manuallyCollapsedProjectsRef.current);
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
    if (!hash || manuallyCollapsedProjectsRef.current.has(hash)) return;
    if (!expandedProjectsRef.current.has(hash)) {
      const next = new Set(expandedProjectsRef.current);
      next.add(hash);
      expandedProjectsRef.current = next;
      setExpandedProjects(next);
      saveExpandedProjects(next);
    }
    if (projectSessionsMapRef.current[hash]) return;
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
    loadSidebar();
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
    const running = new Set(extraRunningIds !== undefined ? extraRunningIds : activeIds);
    const known = new Map<string, string>();
    const take = (session: { id: string; project_hash?: string }) => {
      if (session.id && session.project_hash) known.set(session.id, session.project_hash);
    };
    for (const session of sessionsRef.current) take(session);
    for (const list of Object.values(projectSessionsMapRef.current)) {
      for (const session of list) take(session);
    }
    for (const session of allOptimistic) take(session);

    // 收集所有包含忙碌会话或乐观会话的项目 hash
    const busyHashes = new Set<string>();
    for (const id of running) {
      const hash = known.get(id);
      if (hash) busyHashes.add(hash);
    }
    for (const session of allOptimistic) {
      if (session.project_hash) {
        busyHashes.add(session.project_hash);
      }
    }

    const missing = [...running].filter((id) => !known.has(id));
    void (async () => {
      for (const id of missing) {
        try {
          const found = await resolveSession(id);
          if (cancelled || !found?.project_hash) continue;
          busyHashes.add(found.project_hash);
          // 预注入项目会话列表缓存，让忙碌项与 projectIsRunning 立即就位
          setProjectSessionsMap((prev) => {
            const list = prev[found.project_hash!] ?? [];
            if (list.some((s) => s.id === found.id)) return prev;
            return { ...prev, [found.project_hash!]: [found, ...list] };
          });
        } catch {
          /* the next poll retries */
        }
      }
      if (cancelled) return;

      // 1. 如果有包含忙碌会话的项目被隐藏（hidden），自动解除隐藏
      for (const hash of busyHashes) {
        if (hiddenProjectHashes.has(hash)) {
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
          revealSidebarProject(hash)
            .then((view) => {
              pendingRevealRef.current.delete(hash);
              applySidebarView(view);
            })
            .catch(() => {})
            .finally(() => revealingRef.current.delete(hash));
        }
      }

      // 2. 自动展开所有包含忙碌会话的项目（支持展开多个）
      if (busyHashes.size > 0) {
        for (const hash of busyHashes) {
          if (!manuallyCollapsedProjectsRef.current.has(hash)) {
            openProjectInSidebar(hash);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeIds, extraRunningIds, allOptimistic, hiddenProjectHashes, applySidebarView]);

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
    const zoom = getPageZoom() || 1.0;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (menuFor === id) {
      setMenuFor(null);
      return;
    }
    const right = (window.innerWidth - rect.right) / zoom;
    // 3 rows (rename + export + delete); estimate generously so we flip up a touch
    // early rather than let the last item clip off the bottom edge.
    const MENU_EST_HEIGHT = 144;
    const spaceBelow = (window.innerHeight - rect.bottom) / zoom;
    if (spaceBelow < MENU_EST_HEIGHT + 8) {
      // Not enough room below → open upward, anchored above the kebab.
      setMenuPos({ bottom: (window.innerHeight - rect.top + 4) / zoom, right });
    } else {
      setMenuPos({ top: (rect.bottom + 4) / zoom, right });
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

    // 统计各项目被删除的会话数，用于精准同步扣减 project.session_count
    const deletedCountByProject: Record<string, number> = {};
    for (const id of ids) {
      let foundHash: string | undefined;
      for (const [hash, list] of Object.entries(projectSessionsMap)) {
        if (list.some((s) => s.id === id)) {
          foundHash = hash;
          break;
        }
      }
      if (!foundHash) {
        const s = sessions.find((item) => item.id === id);
        if (s?.project_hash) foundHash = s.project_hash;
      }
      if (foundHash) {
        deletedCountByProject[foundHash] = (deletedCountByProject[foundHash] || 0) + 1;
      }
    }

    setSessions((current) => current.filter((session) => !removed.has(session.id)));
    setProjectSessionsMap((prev) => {
      const next = { ...prev };
      for (const hash of Object.keys(next)) {
        next[hash] = next[hash].filter((s) => !removed.has(s.id));
      }
      return next;
    });
    setProjects((prev) =>
      prev.map((proj) => {
        const count = deletedCountByProject[proj.hash] || 0;
        return count > 0
          ? { ...proj, session_count: Math.max(0, proj.session_count - count) }
          : proj;
      })
    );
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
      showToast(t('sidebar.exportFailed'), 'error');
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
    const zoom = getPageZoom() || 1.0;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Anchor the menu's bottom just above the button (it opens upward).
    setSettingsMenuPos({ left: rect.left / zoom, bottom: (window.innerHeight - rect.top + 4) / zoom });
    setSettingsSub(null);
    setSettingsMenuOpen(true);
  }

  function chooseSettings(section: SettingsSection) {
    setSettingsMenuOpen(false);
    onCloseDrawer?.();
    onOpenSettings(section);
  }

  // Fetch the unified capability list (MCP + skills) once; both menus reuse it.
  // The `/mcp/status` ride-along only feeds the silent project-trust auto-confirm.
  // The project identity of THIS fetch is recorded so a later project switch (or the
  // arrival of `cwd`/`projectHash` after mount) can be detected as stale data.
  function capabilityProjectKey() {
    return `${cwd || ''}|${projectHash || ''}`;
  }
  function refreshCapabilities() {
    capProjectKeyRef.current = capabilityProjectKey();
    setCapsLoading(true);
    getCapabilities(cwd || undefined)
      .then(setCapabilities)
      .catch(() => setCapabilities((cur) => cur ?? []))
      .finally(() => setCapsLoading(false));
    getMcpStatus(cwd || undefined)
      .then(maybeAutoTrustProjectMcp)
      .catch(() => {});
  }

  // 用户偏好：项目级 MCP 的信任不做任何提示，检测到未信任就直接确认。
  // 判定规则见 `lib/mcpTrust`（只有 daemon 明确上报「未信任」且确实存在被拦截的项目级
  // server 才动作）；信任成功后立即刷新，让刚放行的 server 出现在面板上并开始连接。
  // 失败保持静默，不弹提示（点 ↻ 可重试）。
  function maybeAutoTrustProjectMcp(info: McpStatusInfo) {
    const sig = mcpAutoTrustSignature(info, cwd || '');
    if (sig === null || mcpAutoTrustSigRef.current === sig) return;
    mcpAutoTrustSigRef.current = sig;
    postLiveMcpTrust()
      .then((result) => {
        if (!result.ok) return;
        mcpPollAttemptsRef.current = 0;
        refreshCapabilities();
      })
      .catch(() => {});
  }

  function ensureCapabilities() {
    if (capabilities !== null || capsLoading) return;
    refreshCapabilities();
  }
  useEffect(() => {
    ensureCapabilities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 能力开关与信任状态都是项目级的，而切换项目不会重挂载侧栏：当 cwd/projectHash 与
  // 「上一次拉取所针对的项目身份」不一致时补拉一次（也覆盖挂载拉取早于 cwd 就绪的情形），
  // 并重置自动信任签名，让新项目重新确认信任。
  useEffect(() => {
    if (!cwd && !projectHash) return;
    if (capProjectKeyRef.current === capabilityProjectKey()) return;
    mcpAutoTrustSigRef.current = null;
    refreshCapabilities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, projectHash]);

  // Toggle one capability's disabled flag at a scope, then reconcile with the backend
  // so the row reflects the authoritative state. Optimistic paint keeps the switch
  // responsive; the backend rebuild makes the change land in the very next prompt.
  async function onToggleCapability(item: CapabilityItem, scope: CapScope, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const key = `${item.kind}:${item.id}:${scope}`;
    if (capsBusy.has(key)) return;
    setCapsError(null);
    setCapsBusy((s) => new Set(s).add(key));
    const wasDisabled = scope === 'global' ? item.global_disabled : item.project_disabled;
    setCapabilities((cur) =>
      cur
        ? cur.map((c) =>
            c.kind === item.kind && c.id === item.id
              ? {
                  ...c,
                  global_disabled: scope === 'global' ? !wasDisabled : c.global_disabled,
                  project_disabled: scope === 'project' ? !wasDisabled : c.project_disabled,
                  effective_disabled:
                    scope === 'global'
                      ? !wasDisabled || c.project_disabled
                      : c.global_disabled || !wasDisabled,
                }
              : c,
          )
        : cur,
    );
    try {
      // 铁律：开关是唯一权威 —— 打开就得加载。若信任门正拦截着已启用的项目级 MCP，
      // 先静默补上信任（不提示）再落开关，让开关一落地就是「已连接」，而不是等状态
      // 轮询兜底。关闭路径、技能开关与信任门无关，连状态都不查。
      if (item.kind === 'mcp' && wasDisabled) {
        try {
          const info = await getMcpStatus(cwd || undefined);
          if (mcpEnableNeedsTrust(info, item.kind, true)) await postLiveMcpTrust();
        } catch {
          /* 静默失败：开关照落，随后的状态刷新仍会走一次自动信任兜底 */
        }
      }
      const res = await toggleCapability(
        item.kind,
        item.id,
        scope,
        !wasDisabled,
        cwd || undefined,
      );
      if (!res.ok) setCapsError(res.error || 'toggle failed');
      // Give the runtime a beat to rebuild, then reconcile with the backend.
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      refreshCapabilities();
    } catch (error) {
      setCapsError(error instanceof Error ? error.message : String(error));
    } finally {
      setCapsBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

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
    // Reopening forces a fresh fetch (same as the MCP menu), so skills added or
    // removed on disk — or disabled in another project — are reflected instead of
    // showing a stale list/count from mount time.
    refreshCapabilities();
    const zoom = getPageZoom() || 1.0;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSkillsMenuPos({ top: (rect.bottom + 4) / zoom, left: rect.left / zoom, width: rect.width / zoom });
    setSkillsMenuOpen(true);
  }

  function chooseSkill(name: string) {
    setSkillsMenuOpen(false);
    onPickSkill?.(name);
  }

  async function reloadMcpServers(e?: MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    if (mcpReloading) return;
    setMcpReloading(true);
    setMcpReloaded(false);
    setCapsLoading(true);
    try {
      // 手动刷新也是用户的重试入口：重置签名后重新检测一次信任状态。
      mcpAutoTrustSigRef.current = null;
      await postMcpReload();
      mcpPollAttemptsRef.current = 0;
      let list = await getCapabilities(cwd || undefined);
      setCapabilities(list);
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!list.some((c) => c.kind === 'mcp' && c.status === 'connecting')) break;
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        list = await getCapabilities(cwd || undefined);
        setCapabilities(list);
      }
      getMcpStatus(cwd || undefined).then(maybeAutoTrustProjectMcp).catch(() => {});
      setMcpReloaded(true);
      if (mcpReloadedTimerRef.current != null) window.clearTimeout(mcpReloadedTimerRef.current);
      mcpReloadedTimerRef.current = window.setTimeout(() => setMcpReloaded(false), 2500);
    } catch {
      setCapabilities((cur) => cur ?? []);
    } finally {
      setCapsLoading(false);
      setMcpReloading(false);
    }
  }
  // Poll while any MCP server is still `connecting` so the panel converges to the
  // settled state without the user reopening it. An attempt cap guards against a
  // server that never settles.
  useEffect(() => {
    const anyConnecting = (capabilities ?? []).some(
      (c) => c.kind === 'mcp' && c.status === 'connecting',
    );
    if (!anyConnecting) {
      mcpPollAttemptsRef.current = 0;
      return;
    }
    if (mcpPollAttemptsRef.current >= 20) return; // ~30s ceiling
    const id = window.setTimeout(() => {
      mcpPollAttemptsRef.current += 1;
      refreshCapabilities();
    }, 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities]);

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
    refreshCapabilities();
    const zoom = getPageZoom() || 1.0;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMcpMenuPos({ top: (rect.bottom + 4) / zoom, left: rect.left / zoom, width: rect.width / zoom });
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

        {/* Git 自动同步：Agent 跑完改动分支/远端的命令后，自动刷新并对齐远端（仅 fetch） */}
        <button
          type="button"
          class="item-menu-row settings-toggle-row"
          role="switch"
          aria-checked={autoGitSync}
          title={t('settings.autoGitSyncHint')}
          onClick={() => {
            void setAutoGitSync(!autoGitSync).catch(() => {
              showToast(t('settings.autoGitSyncSaveFailed'), 'error');
            });
          }}
        >
          <GitSyncGlyph />
          <span>{t('settings.autoGitSync')}</span>
          <span class={'settings-toggle' + (autoGitSync ? ' on' : '')} aria-hidden="true" />
        </button>
        <div class="settings-menu-divider" />

        {/* 系统设置：模块化系统设置弹窗 */}
        <button class="item-menu-row" onClick={() => chooseSettings('system')}>
          <SettingsGlyph />
          <span>{t('settings.systemSettings')}</span>
        </button>
      </div>,
          document.body,
        )
      : null;

  // Skills popover (opens downward below the Skills action). Portaled to <body>
  // so the mobile drawer's transform/overflow can't clip it. Rows come from the
  // unified capability list (bare name + description + per-scope toggles + folder).
  const renderSkillsMenu = () => {
    if (!skillsMenuOpen || !skillsMenuPos) return null;
    const rows = (capabilities ?? []).filter((c) => c.kind === 'skill');
    return createPortal(
      <div
        class="item-menu skills-menu"
        ref={skillsMenuRef}
        style={{
          top: `${skillsMenuPos.top}px`,
          left: `${skillsMenuPos.left}px`,
          minWidth: `${Math.max(skillsMenuPos.width, 260)}px`,
        }}
      >
        {capsLoading && rows.length === 0 && (
          <div class="group-by-menu-title">{t('sidebar.skillsLoading')}</div>
        )}
        {!capsLoading && rows.length === 0 && (
          <div class="group-by-menu-title">{t('sidebar.skillsEmpty')}</div>
        )}
        {capsError && (
          <div class="cap-error">{t('cap.toggleFailed', { error: capsError })}</div>
        )}
        {rows.map((s) => (
          <div
            key={s.id}
            class={'skills-menu-row cap-row' + (s.effective_disabled ? ' caps-disabled' : '')}
          >
            <button
              type="button"
              class="cap-row-main"
              onClick={() => chooseSkill(s.name)}
              title={s.description || ''}
            >
              <span class="skills-menu-name notranslate" translate={false}>/{s.name}</span>
              {s.description && <span class="skills-menu-desc notranslate" translate={false}>{s.description}</span>}
            </button>
            {s.dir && (
              <button
                type="button"
                class="cap-folder-btn"
                title={t('cap.revealFolder')}
                aria-label={t('cap.revealFolder')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void revealInFileExplorer(s.dir as string);
                }}
              >
                <FolderOpenIcon />
              </button>
            )}
            <CapScopeToggles item={s} busy={capsBusy} onToggle={onToggleCapability} />
          </div>
        ))}
      </div>,
      document.body,
    );
  };

  // MCP popover (opens downward below the MCP action). Portaled to <body> so the
  // mobile drawer's transform/overflow can't clip it. Rows come from the unified
  // capability list (server name + live status + per-scope toggles).
  const renderMcpMenu = () => {
    if (!mcpMenuOpen || !mcpMenuPos) return null;
    const rows = (capabilities ?? []).filter((c) => c.kind === 'mcp');
    return createPortal(
      <div
        class="item-menu mcp-menu"
        ref={mcpMenuRef}
        style={{
          top: `${mcpMenuPos.top}px`,
          left: `${Math.max(8, Math.min(mcpMenuPos.left, (typeof window !== 'undefined' ? window.innerWidth : 400) - 340))}px`,
          minWidth: `${Math.max(mcpMenuPos.width, 280)}px`,
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
        {capsLoading && rows.length === 0 && (
          <div class="group-by-menu-title">{t('sidebar.mcpLoading')}</div>
        )}
        {!capsLoading && rows.length === 0 && (
          <div class="group-by-menu-title">{t('sidebar.mcpEmpty')}</div>
        )}
        {capsError && (
          <div class="cap-error">{t('cap.toggleFailed', { error: capsError })}</div>
        )}
        {rows.map((s) => {
          const statusLabel =
            s.status === 'connected' ? t('sidebar.mcpConnected') :
            s.status === 'connecting' ? t('sidebar.mcpConnecting') :
            s.status === 'error' ? t('sidebar.mcpError') :
            t('sidebar.mcpDisconnected');
          const statusClass = 'mcp-status-dot ' + (s.status || 'disconnected');
          return (
            <div
              key={s.id}
              class={'mcp-menu-row' + (s.effective_disabled ? ' caps-disabled' : '')}
              title={s.error || s.name}
            >
              <div class="mcp-row-header">
                <span class="mcp-menu-name notranslate" translate={false} title={s.name}>
                  {s.name}
                </span>
                <div class="mcp-row-actions">
                  <CapScopeToggles item={s} busy={capsBusy} onToggle={onToggleCapability} />
                </div>
              </div>

              <div class="mcp-row-meta">
                {!s.effective_disabled && <span class={statusClass} />}
                {!s.effective_disabled && <span class="mcp-menu-status-text">{statusLabel}</span>}
                {s.tool_count != null && !s.effective_disabled && (
                  <span class="mcp-menu-tool-count">{t('sidebar.mcpTools', { n: s.tool_count })}</span>
                )}
              </div>

              {s.error && !s.effective_disabled && (
                <div class="mcp-row-error" title={s.error}>
                  <svg class="mcp-error-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 1a7 7 0 1 0 7 7A7 7 0 0 0 8 1zm0 10.2a.9.9 0 1 1 .9-.9.9.9 0 0 1-.9.9zm.8-3.2H7.2V4.5h1.6z"/>
                  </svg>
                  <span class="mcp-error-text">{s.error}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>,
      document.body,
    );
  };

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
      const raw = s.updated_at || s.created_at || 0;
      const norm = raw > 0 && raw < 1e11 ? raw * 1000 : raw;
      ts = Math.max(ts, norm);
    };
    for (const s of sessions) if (s.project_hash === p.hash) bump(s);
    for (const s of projectSessionsMap[p.hash] ?? []) bump(s);
    for (const s of allOptimistic) {
      if (s.project_hash === p.hash || sameProjectDir(s.working_dir, p.working_dir)) bump(s);
    }
    return ts;
  };
  const activeSet = new Set(extraRunningIds !== undefined ? extraRunningIds : activeIds);
  const completedSet = new Set(completedIds ?? []);
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

  // 会话行归属去重：同一 id 只归第一个包含它的项目分组。
  // 项目桶缓存过期或乐观条目同时命中两个分组时，同一条会话会被渲染两遍；
  // 完成徽标便一次亮两处、点一次消两处。
  const projectOwnerById = new Map<string, string>();
  for (const p of visibleProjects) {
    const rows = [
      ...(projectSessionsMap[p.hash] ?? sessions.filter((s) => s.project_hash === p.hash)),
      ...allOptimistic.filter(
        (opt) =>
          opt.project_hash === p.hash || sameProjectDir(opt.working_dir, p.working_dir),
      ),
    ];
    for (const row of rows) {
      if (row.id && !projectOwnerById.has(row.id)) projectOwnerById.set(row.id, p.hash);
    }
  }

  const sortSessions = (list: SessionMetaWithProject[]) => {
    return list.slice().sort((a, b) => {
      const aAct = activeSet.has(a.id) ? 1 : 0;
      const bAct = activeSet.has(b.id) ? 1 : 0;
      if (aAct !== bAct) return bAct - aAct;
      const aTs = a.updated_at || a.created_at || 0;
      const bTs = b.updated_at || b.created_at || 0;
      const aMs = aTs > 0 && aTs < 1e11 ? aTs * 1000 : aTs;
      const bMs = bTs > 0 && bTs < 1e11 ? bTs * 1000 : bTs;
      return bMs - aMs;
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
    merged.filter((s) => {
      if (s.project_hash && knownHashes.has(s.project_hash)) return false;
      // 已被某个项目分组认领的会话不再进“最近”，避免同一 id 出现两行。
      return !projectOwnerById.has(s.id);
    })
  );

  const filtered = q ? searchFiltered : merged;

  // 兜底：即使上游仍送来重复行，同一个会话也只画一个完成徽标。
  const completedRendered = new Set<string>();

  const renderItem = (s: SessionMetaWithProject) => {
    const active = s.id === activeSessionId;
    const running = activeSet.has(s.id);
    // 圈圈消失的同一瞬间换绿勾：运行中永远优先于完成徽标。
    const justCompleted = !running && completedSet.has(s.id) && !completedRendered.has(s.id);
    if (justCompleted) completedRendered.add(s.id);
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
        {running ? (
          <span
            class="session-item-running"
            title={t('sidebar.running')}
            aria-label={t('sidebar.running')}
          />
        ) : justCompleted ? (
          <button
            type="button"
            class="session-item-completed"
            title={t('sidebar.completed')}
            aria-label={t('sidebar.completed')}
            onClick={(e) => {
              e.stopPropagation();
              // 点勾 = 点进去：进入该会话的同时徽标自行熄灭。
              onSelect(s);
            }}
          >
            <CompletedCheckIcon />
          </button>
        ) : null}
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
          {/* 回到最近的一次 AI 会话 */}
          <button
            class={'rail-btn' + (sidebarTab === 'chats' ? ' active' : '')}
            onClick={() => {
              setSidebarTab('chats');
              window.dispatchEvent(new CustomEvent('jeikcode:switch_main_tab', { detail: 'chat' }));
              const recent = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
              if (recent) {
                onSelect(recent);
              }
              if (collapsed && onToggleCollapse) {
                onToggleCollapse();
              }
            }}
            title={t('sidebar.recentChat')}
            aria-label={t('sidebar.recentChat')}
          >
            <CloudIcon />
          </button>
          {/* 回到最近的一次资源管理器状态 */}
          <button
            class={'rail-btn' + (sidebarTab === 'files' ? ' active' : '')}
            onClick={() => {
              setSidebarTab('files');
              if (collapsed && onToggleCollapse) {
                onToggleCollapse();
              }
            }}
            title={t('sidebar.recentFiles')}
            aria-label={t('sidebar.recentFiles')}
          >
            <FolderRailIcon />
          </button>
        </nav>
        <div class="sidebar-rail-bottom">
          {githubLogo !== false && (
            <a
              class="sidebar-rail-btn sidebar-rail-github-btn"
              href="https://github.com/jeikl/JeikCode"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub: JeikCode"
              aria-label="GitHub Repository"
            >
              <GithubLogo />
            </a>
          )}
          <button
            class="sidebar-rail-btn"
            onClick={() => {
              onCloseDrawer?.();
              onOpenSettings('system');
            }}
            title={t('settings.systemSettings')}
            aria-label={t('settings.systemSettings')}
          >
            <SettingsGlyph />
          </button>
        </div>
      </aside>
    );
  }

  const skillCount = (capabilities ?? []).filter((c) => c.kind === 'skill').length;
  const mcpCount = (capabilities ?? []).filter((c) => c.kind === 'mcp').length;

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

      {/* 顶部双子胶囊切页：对话与项目 vs 资源管理器 (解决多项目会话与文件树拥挤痛点) */}
      <div class="sidebar-segment-tabs">
        <button
          type="button"
          class={'sidebar-segment-btn' + (sidebarTab === 'chats' ? ' active' : '')}
          onClick={() => {
            setSidebarTab('chats');
            window.dispatchEvent(new CustomEvent('jeikcode:switch_main_tab', { detail: 'chat' }));
            const recent = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
            if (recent) {
              onSelect(recent);
            }
          }}
        >
          <span>💬</span>
          <span>{t('sidebar.chats') || '对话'}</span>
        </button>
        <button
          type="button"
          class={'sidebar-segment-btn' + (sidebarTab === 'files' ? ' active' : '')}
          onClick={() => setSidebarTab('files')}
        >
          <span>📁</span>
          <span>{t('sidebar.files') || '资源管理'}</span>
        </button>
      </div>

      {sidebarTab === 'files' ? (
        <FileExplorer cwd={cwd} onOpenFile={onOpenFile} activeFilePath={activeFilePath} />
      ) : (
        <>
          <div class="sidebar-actions">
            <button class="sidebar-action" onClick={() => { exitSelectMode(); onNew(); }}>
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
            {uniqueSessionsById(sortSessions(searchFiltered)).map(renderItem)}
          </div>
        ) : (
          <>
            <div class="sidebar-section-header">
              <span class="sidebar-section-title">{t('sidebar.projects')}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <button
                  type="button"
                  class="sidebar-section-action-btn"
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
                  type="button"
                  class="sidebar-section-action-btn"
                  onClick={handleOpenNativeDirectory}
                  title={isLoopbackHost(window.location.hostname) ? t('sidebar.addProjectFolder') : t('sidebar.addProjectFolderRemote')}
                  aria-label={isLoopbackHost(window.location.hostname) ? t('sidebar.addProjectFolder') : t('sidebar.addProjectFolderRemote')}
                >
                  <PlusIcon />
                </button>
              </div>
            </div>

            {visibleProjects.map((p) => {
              const isExpanded = expandedProjects.has(p.hash);
              const isShowAll = showAllProjects.has(p.hash);

              // 过滤掉尚未发出第一条消息的空白会话（新建但未发送消息者不建会话、不入列表；首发即入列并持续展示）
              const isNonEmptySession = (s: SessionMetaWithProject) => {
                if (allOptimistic.some((opt) => opt.id === s.id)) return true;
                if (s.id === activeSessionId) return true;
                if (activeIds.includes(s.id) || extraRunningIds?.includes(s.id)) return true;
                return (s.message_count ?? 0) > 0;
              };

              const rawBase = projectSessionsMap[p.hash] ?? sessions.filter((s) => s.project_hash === p.hash);
              const baseSessions = rawBase.filter(isNonEmptySession);
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
              let displayList: SessionMetaWithProject[];
              if (isShowAll) {
                displayList = sorted;
              } else {
                const top5 = sorted.slice(0, 5);
                if (activeSessionId && !top5.some((s) => s.id === activeSessionId)) {
                  const activeItem = sorted.find((s) => s.id === activeSessionId);
                  displayList = activeItem && isNonEmptySession(activeItem) ? [...top5, activeItem] : top5;
                } else {
                  displayList = top5;
                }
              }
              const count = pSessions.length;

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

                      {/* GitHub 联动与自动审查配置 */}
                      <button
                        type="button"
                        class="project-group-action-btn"
                        onClick={() => setGitWebhookProject(p)}
                        title={t('gitWebhook.btnTitle')}
                        aria-label={t('gitWebhook.btnTitle')}
                      >
                        <GithubLogo />
                      </button>

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
                      {uniqueSessionsById(
                        displayList.filter((s) => projectOwnerById.get(s.id) === p.hash),
                      ).map(renderItem)}
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
                  {uniqueSessionsById(recentsList.slice(0, 10)).map(renderItem)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )}

      <div class="sidebar-bottom">
        {githubLogo !== false && (
          <a
            class="sidebar-bottom-github-btn"
            href="https://github.com/jeikl/JeikCode"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub: JeikCode"
            aria-label="GitHub Repository"
          >
            <GithubLogo />
          </a>
        )}
        <span class="sidebar-bottom-spacer" />
        <button
          class="sidebar-icon-btn sidebar-settings-btn"
          onClick={() => {
            onCloseDrawer?.();
            onOpenSettings('system');
          }}
          title={t('settings.systemSettings')}
          aria-label={t('settings.systemSettings')}
        >
          <SettingsGlyph />
        </button>
      </div>
      {renderSkillsMenu()}
      {renderMcpMenu()}

      {/* Session search dialog (centered modal) */}
      {searchOpen && createPortal(
        <div class="modal-overlay" {...searchBackdropDismiss}>
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
      {gitWebhookProject && createPortal(
        <GitWebhookDialog
          project={gitWebhookProject}
          onClose={() => setGitWebhookProject(null)}
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
            // 自动停用该项目的 Git 联动并记住最后一次开启状态
            try {
              const raw = localStorage.getItem(`jeikcode_git_binding_${hash}`);
              if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed.enabled) {
                  localStorage.setItem(`jeikcode_git_binding_${hash}`, JSON.stringify({
                    ...parsed,
                    enabled: false,
                    lastEnabledState: true,
                  }));
                }
              }
            } catch {}
            pendingHideRef.current.add(hash);
            pendingRevealRef.current.delete(hash);
            setHiddenProjectHashes((prev) => {
              const next = new Set(prev);
              next.add(hash);
              return next;
            });
            try {
              const view = await hideSidebarProject(hash);
              pendingHideRef.current.delete(hash);
              applySidebarView(view);
            } catch (err) {
              pendingHideRef.current.delete(hash);
              setHiddenProjectHashes((prev) => {
                const next = new Set(prev);
                next.delete(hash);
                return next;
              });
              throw err;
            }
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
