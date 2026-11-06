// Right inspector (keep-alive tabs) + collapsed floating rail.
//
// Extracted from Chat so the landing canvas and the session canvas render the
// exact same panel. Previously both branches carried a ~180-line copy, which
// had already drifted (tab order and turn-nav tooltips differed). Tab metadata
// lives in one table below, so adding a tab is a single edit.

import { lazy, Suspense } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { useT } from '../settings';
import { TerminalPanel } from './TerminalPanel';
import { PreviewPanel } from './PreviewPanel';
import type { TurnNavItem } from '../lib/turnNav';
import type { GitCommitFile, GitCommitItem, GitStatusItem } from '../api';

const GitPanel = lazy(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })));

export type RightPanelTab = 'questions' | 'git' | 'terminal' | 'preview';

/** Canonical tab order — header and floating rail both follow it. */
export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ['questions', 'git', 'terminal', 'preview'];

const TAB_LABEL_KEY = {
  questions: 'turnNav.title',
  git: 'panel.git',
  terminal: 'panel.terminal',
  preview: 'panel.preview',
} as const;

/** Header title; GitHub uses the richer `git.title` copy. */
const TAB_TITLE_KEY = {
  questions: 'turnNav.title',
  git: 'git.title',
  terminal: 'panel.terminal',
  preview: 'panel.preview',
} as const;

export function isRightPanelTab(value: unknown): value is RightPanelTab {
  return typeof value === 'string' && (RIGHT_PANEL_TABS as readonly string[]).includes(value);
}

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/**
 * 提问大纲列表。
 *
 * 滚动的两条规则（旧实现没有，刷新/重进时永远停在最顶上）：
 * 1. **首次进入滚到底部**：最新提问在末尾，用户回来关心的就是它。
 * 2. **激活项变化时把它滚到可见**：滚动正文（或跳转）时右侧大纲要跟着走，
 *    否则高亮项在视口外，列表看起来“没反应”。
 */
function TurnNavList({
  items,
  allCount,
  activeId,
  emptyLabel,
  noMatchLabel,
  onJump,
}: {
  items: TurnNavItem[];
  allCount: number;
  activeId: string | null;
  emptyLabel: string;
  noMatchLabel: string;
  onJump: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  // 首次具备真实尺寸时滚到底部（最新提问）。
  // 面板可能是隐藏态（tab 不在 questions / 侧栏折叠），这时 `scrollHeight` 为 0，
  // 赋 `scrollTop` 无效；用 `ResizeObserver` 等它真正获得高度那一刻再滚，
  // 不管用户是刷新、重进还是先切到其他 tab 再切回来。
  useEffect(() => {
    const root = listRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const tryScroll = () => {
      if (initializedRef.current) return;
      if (root.scrollHeight <= root.clientHeight) return;
      initializedRef.current = true;
      root.scrollTop = root.scrollHeight;
    };
    tryScroll();
    const ro = new ResizeObserver(tryScroll);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // 列表内容变化（首次加载/翻页）时再补一次：尺寸已就绪但当时还没有内容。
  useEffect(() => {
    const root = listRef.current;
    if (!root || initializedRef.current || items.length === 0) return;
    if (root.scrollHeight <= root.clientHeight) return;
    initializedRef.current = true;
    root.scrollTop = root.scrollHeight;
  }, [items.length]);

  // 激活项变化：仅当它不在视口内时滚到可见（block: nearest 避免无谓跳动）。
  useEffect(() => {
    const root = listRef.current;
    if (!root || !activeId) return;
    const el = root.querySelector<HTMLElement>(`[data-turn-nav-item="${CSS.escape(activeId)}"]`);
    if (!el) return;
    const rootRect = root.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const visible = elRect.top >= rootRect.top && elRect.bottom <= rootRect.bottom;
    if (!visible) el.scrollIntoView({ block: 'nearest' });
  }, [activeId, items.length]);

  return (
    <div class="turn-nav-list" ref={listRef}>
      {items.length === 0 ? (
        <div class="turn-nav-empty">{allCount === 0 ? emptyLabel : noMatchLabel}</div>
      ) : (
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-turn-nav-item={item.id}
            class={
              'turn-nav-item' +
              (item.id === activeId ? ' active' : '') +
              (item.pending ? ' pending' : '')
            }
            title={item.fullText ?? item.text}
            onClick={() => onJump(item.id)}
          >
            {item.label}
          </button>
        ))
      )}
    </div>
  );
}

function TabIcon({ tab }: { tab: RightPanelTab }) {
  if (tab === 'git') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
      </svg>
    );
  }
  if (tab === 'terminal') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 5l4 3-4 3m6 0h4" />
      </svg>
    );
  }
  if (tab === 'preview') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6 6.5a2 2 0 0 1 3.8.8c0 1.2-1.8 1.5-1.8 2.5" />
      <circle cx="8" cy="12.2" r="0.7" fill="currentColor" />
    </svg>
  );
}

export interface RightInspectorProps {
  tab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  /** Expand the panel and switch to this tab (floating rail). */
  onSelectTab: (tab: RightPanelTab) => void;
  collapsed: boolean;
  onCollapse: () => void;
  counts: Partial<Record<RightPanelTab, number>>;
  /** Panel resize handle (pointerdown on the left edge). */
  onResizeStart: (e: PointerEvent) => void;

  turnNav: {
    items: TurnNavItem[];
    filtered: TurnNavItem[];
    activeId: string | null;
    query: string;
    onQueryChange: (query: string) => void;
    onJump: (id: string) => void;
  };
  git: {
    cwd: string;
    sessionId?: string;
    refreshTrigger: number;
    onBranchChanged: (branch: string) => void;
    onOpenFileDiff: (commit: GitCommitItem, file: GitCommitFile, repoRoot?: string) => void;
    onOpenWorkingDiff: (file: GitStatusItem, staged: boolean, repoRoot?: string) => void;
  };
  workingDir: string;
  onTerminalCountChange: (count: number) => void;
  onPreviewCountChange: (count: number) => void;

  eyeDragOver: boolean;
  onEyeDragOver: (e: DragEvent) => void;
  onEyeDragLeave: () => void;
  onEyeDrop: (e: DragEvent) => void;

  rail: {
    top: number;
    left: number;
    onDragStart: (e: MouseEvent | TouchEvent) => void;
  };
}

export function RightInspector({
  tab,
  onTabChange,
  onSelectTab,
  collapsed,
  onCollapse,
  counts,
  onResizeStart,
  turnNav,
  git,
  workingDir,
  onTerminalCountChange,
  onPreviewCountChange,
  eyeDragOver,
  onEyeDragOver,
  onEyeDragLeave,
  onEyeDrop,
  rail,
}: RightInspectorProps) {
  const t = useT();
  const title = t(TAB_TITLE_KEY[tab]);

  const tabButton = (id: RightPanelTab) => {
    const active = tab === id;
    const count = counts[id] ?? 0;
    const isPreview = id === 'preview';
    return (
      <button
        key={id}
        type="button"
        role="tab"
        id={`right-panel-tab-${id}`}
        aria-selected={active}
        aria-controls={`right-panel-panel-${id}`}
        tabIndex={active ? 0 : -1}
        class={
          'right-panel-tab-btn' +
          (active ? ' active' : '') +
          (isPreview && eyeDragOver ? ' is-drag-over-eye' : '')
        }
        onClick={() => onTabChange(id)}
        onDragEnter={isPreview ? (onEyeDragOver as any) : undefined}
        onDragOver={isPreview ? (onEyeDragOver as any) : undefined}
        onDragLeave={isPreview ? onEyeDragLeave : undefined}
        onDrop={isPreview ? (onEyeDrop as any) : undefined}
        title={t(TAB_LABEL_KEY[id])}
        aria-label={t(TAB_LABEL_KEY[id])}
      >
        <TabIcon tab={id} />
        {count > 0 && <span class="tab-badge">{badgeText(count)}</span>}
      </button>
    );
  };

  const panelAttrs = (id: RightPanelTab, style: any) => ({
    id: `right-panel-panel-${id}`,
    role: 'tabpanel' as const,
    'aria-labelledby': `right-panel-tab-${id}`,
    style,
  });

  return (
    <>
      {!collapsed && (
        <div class="right-inspector-backdrop" onClick={onCollapse} aria-hidden="true" />
      )}

      <aside
        class="right-inspector-panel"
        style={{ display: collapsed ? 'none' : 'flex' }}
        aria-label={title}
      >
        {/* Draggable resizer on the left edge */}
        <div
          class="right-panel-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onResizeStart as any}
          title={t('panel.resizeHandle')}
          aria-label={t('panel.resizeHandle')}
        />

        {/* Header tab bar */}
        <div class="right-panel-header">
          <div class="right-panel-tabs" role="tablist" aria-label={t('chat.inspectorTabs')}>
            {RIGHT_PANEL_TABS.map(tabButton)}
          </div>

          <span class="right-panel-title">{title}</span>

          <button
            type="button"
            class="right-panel-collapse-btn"
            onClick={onCollapse}
            title={t('panel.collapse')}
            aria-label={t('panel.collapse')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div class="right-panel-body">
          <div
            {...panelAttrs('questions', {
              display: tab === 'questions' ? 'flex' : 'none',
              flex: 1,
              flexDirection: 'column',
              minHeight: 0,
              height: '100%',
              width: '100%',
            })}
          >
            <nav class="turn-nav" aria-label={t('turnNav.title')}>
              <div class="turn-nav-header">
                <input
                  class="turn-nav-search"
                  type="text"
                  value={turnNav.query}
                  placeholder={t('turnNav.searchPlaceholder')}
                  aria-label={t('turnNav.searchPlaceholder')}
                  onInput={(e) => turnNav.onQueryChange((e.target as HTMLInputElement).value)}
                />
              </div>
              <TurnNavList
                items={turnNav.filtered}
                allCount={turnNav.items.length}
                activeId={turnNav.activeId}
                emptyLabel={t('turnNav.empty')}
                noMatchLabel={t('turnNav.noMatch')}
                onJump={turnNav.onJump}
              />
            </nav>
          </div>

          <div
            {...panelAttrs('git', {
              display: tab === 'git' ? 'flex' : 'none',
              flex: 1,
              flexDirection: 'column',
              minHeight: 0,
              height: '100%',
              width: '100%',
            })}
          >
            <Suspense
              fallback={
                <div class="git-empty-state">
                  <div class="git-spinner" />
                  <span>{t('git.loading')}</span>
                </div>
              }
            >
              <GitPanel
                cwd={git.cwd}
                sessionId={git.sessionId}
                refreshTrigger={git.refreshTrigger}
                onBranchChanged={git.onBranchChanged}
                onOpenFileDiff={git.onOpenFileDiff}
                onOpenWorkingDiff={git.onOpenWorkingDiff}
              />
            </Suspense>
          </div>

          {/* The terminal keeps its layout box and only toggles visibility: xterm v6
              pauses rendering while its container has no layout box and stays blank
              after being shown again. */}
          <div
            {...panelAttrs('terminal', {
              position: 'absolute',
              inset: 0,
              zIndex: tab === 'terminal' ? 1 : 0,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              height: '100%',
              width: '100%',
            })}
            class={'terminal-panel-slot' + (tab === 'terminal' ? '' : ' is-hidden')}
          >
            <TerminalPanel
              cwd={workingDir}
              active={tab === 'terminal' && !collapsed}
              onTabsCountChange={onTerminalCountChange}
            />
          </div>

          <div
            {...panelAttrs('preview', {
              display: tab === 'preview' ? 'flex' : 'none',
              flex: 1,
              flexDirection: 'column',
              minHeight: 0,
              height: '100%',
              width: '100%',
            })}
          >
            <PreviewPanel
              cwd={workingDir}
              onTabsCountChange={onPreviewCountChange}
              surfaceActive={tab === 'preview' && !collapsed}
            />
          </div>
        </div>
      </aside>

      {/* Collapsed floating rail */}
      {collapsed && (
        <div
          class="right-panel-collapsed-rail draggable-floating-widget"
          role="toolbar"
          aria-label={t('chat.inspectorTabs')}
          style={{ top: `${rail.top}px`, left: `${rail.left}px`, right: 'auto' }}
        >
          <div
            class="widget-drag-handle"
            onMouseDown={rail.onDragStart as any}
            onTouchStart={rail.onDragStart as any}
            title={t('common.drag')}
            aria-label={t('common.dragHandle')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="4" r="1.5" />
              <circle cx="11" cy="4" r="1.5" />
              <circle cx="5" cy="8" r="1.5" />
              <circle cx="11" cy="8" r="1.5" />
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="11" cy="12" r="1.5" />
            </svg>
          </div>
          {RIGHT_PANEL_TABS.map((id) => {
            const active = tab === id;
            const count = counts[id] ?? 0;
            const isPreview = id === 'preview';
            return (
              <button
                key={id}
                type="button"
                class={
                  'right-panel-tab-btn' +
                  (active ? ' active' : '') +
                  (isPreview && eyeDragOver ? ' is-drag-over-eye' : '')
                }
                onClick={() => onSelectTab(id)}
                onDragEnter={isPreview ? (onEyeDragOver as any) : undefined}
                onDragOver={isPreview ? (onEyeDragOver as any) : undefined}
                onDragLeave={isPreview ? onEyeDragLeave : undefined}
                onDrop={isPreview ? (onEyeDrop as any) : undefined}
                title={t(TAB_LABEL_KEY[id])}
                aria-label={t(TAB_LABEL_KEY[id])}
                aria-pressed={active}
              >
                <TabIcon tab={id} />
                <span class="rail-tab-text">{t(TAB_LABEL_KEY[id])}</span>
                {count > 0 && <span class="tab-badge">{badgeText(count)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
