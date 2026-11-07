import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { useT } from '../settings';
import { modalConfirm } from './ConfirmDialog';
import { CodeEditorTab } from './CodeEditorTab';
import { showToast } from './Toast';
import { parseFilePathAndLines } from '../lib/displayPath';
import {
  bumpReloadToken,
  dropEditorTabSnapshot,
  previewEditorStateKey,
  withTabViewMode,
  withVisitedTab,
  withoutTabEntry,
} from '../lib/editorTabState';

export interface PreviewTab {
  id: string;
  filePath: string;
  fileName: string;
  fileStatus?: string;
  startLine?: number;
  endLine?: number;
}

export interface PreviewPanelProps {
  cwd?: string;
  onTabsCountChange?: (count: number) => void;
  /** 面板整体是否可见（折叠 / 切到其它面板标签）：隐藏时不抢焦点，恢复可见时还原滚动。 */
  surfaceActive?: boolean;
}

export function getSavedPreviewCount(projectCwd?: string): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  try {
    const normCwd = (projectCwd || 'default').replace(/\\/g, '/').toLowerCase();
    const storageKeyTabs = `jeikcode:right_preview_tabs:${normCwd}`;
    const saved = localStorage.getItem(storageKeyTabs);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.length;
    }
  } catch {}
  return 0;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

/** 常驻保活的标签上限：超出后淘汰最久未激活的（脏标签有快照，可安全重挂载）。 */
const MAX_VISITED_PREVIEW_TABS = 8;

function normalizeToAbsolute(filePath: string, cwd?: string): string {
  let p = (filePath || '').trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) {
    return p;
  }
  const base = (cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return base ? `${base}/${p.replace(/^\.?\/+/, '')}` : p;
}

export function PreviewPanel({ cwd, onTabsCountChange, surfaceActive = true }: PreviewPanelProps) {
  const t = useT();

  const normCwd = useMemo(() => (cwd || 'default').replace(/\\/g, '/').toLowerCase(), [cwd]);
  const storageKeyTabs = `jeikcode:right_preview_tabs:${normCwd}`;
  const storageKeyActive = `jeikcode:right_preview_active_tab:${normCwd}`;

  const [tabs, setTabs] = useState<PreviewTab[]>(() => {
    try {
      const saved = localStorage.getItem(storageKeyTabs);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [];
  });

  const [activeTabId, setActiveTabId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(storageKeyActive);
      if (saved) return saved;
    } catch {}
    return '';
  });

  // 右侧面板当前激活标签的编辑/预览模式：新标签仍从预览进入（保持原有入口体验），
  // 但每个标签此后各自记住最后一轮模式，不再随标签切换被写死回预览。
  const [tabViewModes, setTabViewModes] = useState<Record<string, 'preview' | 'edit'>>({});
  // 首次激活后才挂载并保活：未被访问过的标签不预加载文件内容。
  const [visitedTabIds, setVisitedTabIds] = useState<Record<string, true>>({});
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({});
  // 标签脏状态由各编辑器实例上报；关闭/清空/刷新前据此确认，标签上也显示脏点。
  const [dirtyTabIds, setDirtyTabIds] = useState<Record<string, true>>({});
  const markTabDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyTabIds((prev) => {
      if (!!prev[tabId] === dirty) return prev;
      const next = { ...prev };
      if (dirty) next[tabId] = true;
      else delete next[tabId];
      return next;
    });
  }, []);

  const activeViewMode: 'preview' | 'edit' =
    (activeTabId ? tabViewModes[activeTabId] : undefined) || 'preview';

  const handleViewModeChange = useCallback(
    (tabId: string, m: 'edit' | 'preview' | 'image' | 'binary') => {
      if (m !== 'edit' && m !== 'preview') return;
      setTabViewModes((prev) => withTabViewMode(prev, tabId, m));
    },
    [],
  );

  useEffect(() => {
    if (!activeTabId) return;
    setVisitedTabIds((prev) => {
      const next = withVisitedTab(prev, activeTabId);
      const keys = Object.keys(next);
      if (keys.length <= MAX_VISITED_PREVIEW_TABS) return next;
      const keep: Record<string, true> = {};
      for (const key of keys.slice(-MAX_VISITED_PREVIEW_TABS)) keep[key] = true;
      keep[activeTabId] = true;
      return keep;
    });
  }, [activeTabId]);

  // 关闭标签时同步清掉它的模式 / 刷新令牌 / 挂载记录 / 脏标记，重新打开时回到全新预览。
  const forgetTab = useCallback((tabId: string) => {
    setTabViewModes((prev) => withoutTabEntry(prev, tabId));
    setVisitedTabIds((prev) => withoutTabEntry(prev, tabId));
    setReloadTokens((prev) => withoutTabEntry(prev, tabId));
    setDirtyTabIds((prev) => withoutTabEntry(prev, tabId));
  }, []);

  const hydratedKeyRef = useRef<string>('');
  // 只有真正切换项目时才清空跨项目簿记；首次挂载不能清掉首个激活标签的保活记录。
  const previousCwdKeyRef = useRef<string | null>(null);

  // 当项目/工作目录切换时，自动同步对应项目的独立预览标签列表，彻底杜绝跨项目同名文件混淆
  useEffect(() => {
    const projectChanged =
      previousCwdKeyRef.current !== null && previousCwdKeyRef.current !== storageKeyTabs;
    previousCwdKeyRef.current = storageKeyTabs;
    try {
      const savedTabs = localStorage.getItem(storageKeyTabs);
      const parsedTabs = savedTabs ? JSON.parse(savedTabs) : [];
      setTabs(Array.isArray(parsedTabs) ? parsedTabs : []);

      const savedActive = localStorage.getItem(storageKeyActive) || '';
      setActiveTabId(savedActive);
      if (projectChanged) {
        // 避免 map 无限增长、旧项目标签被提前挂载；脏标签的快照仍在，重建后可恢复。
        setTabViewModes({});
        setVisitedTabIds({});
        setReloadTokens({});
        setDirtyTabIds({});
      }
    } catch {
      setTabs([]);
      setActiveTabId('');
    }
    hydratedKeyRef.current = storageKeyTabs;
  }, [storageKeyTabs, storageKeyActive]);

  // 持久化保存当前项目的标签与当前激活项
  useEffect(() => {
    // 只有在当前 key 已经从本地存储水合完成后，才允许回写持久化，避免未就绪时空列表冲掉原有项目标签
    if (hydratedKeyRef.current !== storageKeyTabs) return;
    try {
      localStorage.setItem(storageKeyTabs, JSON.stringify(tabs));
    } catch {}
    onTabsCountChange?.(tabs.length);
  }, [tabs, storageKeyTabs, onTabsCountChange]);

  useEffect(() => {
    try {
      if (activeTabId) {
        localStorage.setItem(storageKeyActive, activeTabId);
      }
    } catch {}
  }, [activeTabId, storageKeyActive]);

  // 保证 activeTabId 在 tabs 变化时有效
  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId) setActiveTabId('');
    } else if (!tabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[tabs.length - 1]!.id);
    }
  }, [tabs, activeTabId]);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId]);

  // 打开或追加一个标签页
  const openTab = useCallback(
    (
      info: {
        filePath: string;
        fileName?: string;
        fileStatus?: string;
        startLine?: number;
        endLine?: number;
      },
      insertIndex?: number,
    ) => {
      const rawPath = info.filePath;
      const { filePath: cleanRaw, startLine: parsedStart, endLine: parsedEnd } = parseFilePathAndLines(rawPath);
      const startLine = info.startLine ?? parsedStart;
      const endLine = info.endLine ?? parsedEnd;
      const absPath = normalizeToAbsolute(cleanRaw, cwd);
      const fileName = info.fileName || absPath.split(/[\\/]/).pop() || absPath;
      const tabId = `preview_${absPath}`;

      setTabs((prev) => {
        const existingIdx = prev.findIndex((t) => t.id === tabId || t.filePath === absPath);
        if (existingIdx !== -1) {
          const next = [...prev];
          const existingItem = next[existingIdx];
          if (existingItem) {
            next[existingIdx] = {
              ...existingItem,
              startLine,
              endLine,
            };
          }
          if (insertIndex !== undefined && insertIndex !== existingIdx) {
            const [item] = next.splice(existingIdx, 1);
            const targetSlot = insertIndex > existingIdx ? insertIndex - 1 : insertIndex;
            next.splice(targetSlot, 0, item);
          }
          return next;
        }
        const newTab: PreviewTab = {
          id: tabId,
          filePath: absPath,
          fileName,
          fileStatus: info.fileStatus || (fileName.split('.').pop() || 'FILE').slice(0, 3).toUpperCase(),
          startLine,
          endLine,
        };
        if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= prev.length) {
          const next = [...prev];
          next.splice(insertIndex, 0, newTab);
          return next;
        }
        return [...prev, newTab];
      });

      setActiveTabId(tabId);
    },
    [cwd],
  );

  // 监听全局打开预览事件
  useEffect(() => {
    const handleOpenFileEvent = (
      e: CustomEvent<{
        filePath: string;
        fileName?: string;
        fileStatus?: string;
        startLine?: number;
        endLine?: number;
      }>,
    ) => {
      if (e.detail?.filePath) {
        openTab(e.detail);
      }
    };
    window.addEventListener('jeikcode:preview:open_file', handleOpenFileEvent as EventListener);
    return () => {
      window.removeEventListener('jeikcode:preview:open_file', handleOpenFileEvent as EventListener);
    };
  }, [openTab]);

  // 关闭标签：有未保存修改时先确认，避免静默丢草稿。
  const closeTabNow = (tabId: string) => {
    const closing = tabs.find((t) => t.id === tabId);
    if (closing) dropEditorTabSnapshot(previewEditorStateKey(closing.filePath));
    forgetTab(tabId);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (next.length > 0) {
          setActiveTabId(next[next.length - 1]!.id);
        } else {
          setActiveTabId('');
        }
      }
      return next;
    });
  };

  const handleCloseTab = async (tabId: string, e?: MouseEvent) => {
    e?.stopPropagation();
    if (dirtyTabIds[tabId]) {
      const ok = await modalConfirm({
        title: t('preview.closeDirtyTitle'),
        body: t('preview.closeDirtyDesc'),
        confirmLabel: t('preview.closeDirtyConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    closeTabNow(tabId);
  };

  // 清空所有标签（有脏标签时先确认）
  const handleClearAll = async () => {
    const dirtyCount = tabs.reduce((n, tab) => n + (dirtyTabIds[tab.id] ? 1 : 0), 0);
    if (dirtyCount > 0) {
      const ok = await modalConfirm({
        title: t('preview.clearDirtyTitle'),
        body: t('preview.clearDirtyDesc', { n: String(dirtyCount) }),
        confirmLabel: t('preview.clearDirtyConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    for (const tab of tabs) dropEditorTabSnapshot(previewEditorStateKey(tab.filePath));
    setTabViewModes({});
    setVisitedTabIds({});
    setReloadTokens({});
    setDirtyTabIds({});
    setTabs([]);
    setActiveTabId('');
  };

  // 标签栏横向滚动容器 Ref
  const tabsScrollRef = useRef<HTMLDivElement>(null);

  // 激活标签平滑滚动居中
  useEffect(() => {
    if (!tabsScrollRef.current || !activeTabId) return;
    const el = tabsScrollRef.current.querySelector('.preview-tab-item.active') as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  // 拖拽排序状态（像浏览器标签一样在内部重排，或接收外部标签拖入）
  const [draggedTabIndex, setDraggedTabIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDropTargetBar, setIsDropTargetBar] = useState(false);

  const handleTabDragStart = (index: number, e: DragEvent) => {
    setDraggedTabIndex(index);
    const tab = tabs[index];
    if (tab && e.dataTransfer) {
      e.dataTransfer.setData('application/jeikcode-tab', JSON.stringify(tab));
      e.dataTransfer.setData('application/jeikcode-preview-index', String(index));
      e.dataTransfer.effectAllowed = 'move';
      (window as any).__jeikcode_dragged_tab = tab;
    }
  };

  const handleTabDragOver = (index: number, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = draggedTabIndex !== null ? 'move' : 'copy';
    }
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleTabDrop = (targetIndex: number, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverIndex(null);
    setIsDropTargetBar(false);

    // 1. 如果是右侧内部标签排序
    const internalIndexStr = e.dataTransfer?.getData('application/jeikcode-preview-index');
    if (internalIndexStr !== undefined && internalIndexStr !== '') {
      const fromIndex = parseInt(internalIndexStr, 10);
      if (!Number.isNaN(fromIndex) && fromIndex !== targetIndex) {
        setTabs((prev) => {
          const next = [...prev];
          const [moved] = next.splice(fromIndex, 1);
          if (moved) {
            next.splice(targetIndex, 0, moved);
          }
          return next;
        });
        setDraggedTabIndex(null);
        return;
      }
    }

    // 2. 如果是从外部（如主标签栏）拖入到该标签位置
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath) {
        openTab(typeof data === 'object' && data?.filePath ? data : { filePath: targetPath }, targetIndex);
        setDraggedTabIndex(null);
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            openTab({ filePath: p, fileName: file.name }, targetIndex);
          }
        }
      }
    } catch {}
    setDraggedTabIndex(null);
  };

  const handleBarDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = draggedTabIndex !== null ? 'move' : 'copy';
    }
    setIsDropTargetBar(true);
  };

  const handleBarDragLeave = (e: DragEvent) => {
    if (!tabsScrollRef.current?.contains(e.relatedTarget as Node)) {
      setIsDropTargetBar(false);
      setDragOverIndex(null);
    }
  };

  const handleBarDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDropTargetBar(false);
    setDragOverIndex(null);

    // 如果内部标签拖到了标签栏末尾空白处
    if (draggedTabIndex !== null) {
      setTabs((prev) => {
        const next = [...prev];
        const [moved] = next.splice(draggedTabIndex, 1);
        if (moved) next.push(moved);
        return next;
      });
      setDraggedTabIndex(null);
      return;
    }

    // 外部标签拖到空白处，追加到末尾
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath) {
        openTab(typeof data === 'object' && data?.filePath ? data : { filePath: targetPath });
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            openTab({ filePath: p, fileName: file.name });
          }
        }
      }
    } catch {}
  };

  // 获取文件图标或徽章
  const getTabIcon = (filePath: string) => {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXTS.has(ext)) return '🖼️';
    if (ext === 'md' || ext === 'markdown') return '📖';
    if (ext === 'rs') return '🦀';
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return '⚡';
    if (ext === 'json' || ext === 'toml' || ext === 'yaml' || ext === 'yml') return '⚙️';
    if (ext === 'sh' || ext === 'bash' || ext === 'ps1') return '🐚';
    return '📄';
  };

  return (
    <div
      class="preview-panel-root"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const raw = e.dataTransfer?.getData('application/jeikcode-tab');
          const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
          const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
          if (targetPath) {
            openTab(typeof data === 'object' && data?.filePath ? data : { filePath: targetPath });
            return;
          }
          if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
              const file = e.dataTransfer.files[i];
              const p = (file as any).path || file.name;
              if (p) {
                openTab({ filePath: p, fileName: file.name });
              }
            }
          }
        } catch {}
      }}
    >
      {/* 顶部多文件标签栏 (与终端多标签结构和样式高度一致) */}
      <div class="preview-tabs-bar">
        <div
          ref={tabsScrollRef}
          class={'preview-tabs-scroll' + (isDropTargetBar ? ' is-drag-over-bar' : '')}
          onWheel={(e) => {
            if (e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
          onDragOver={handleBarDragOver}
          onDragLeave={handleBarDragLeave}
          onDrop={handleBarDrop}
        >
          {tabs.map((tab, idx) => {
            const isActive = tab.id === activeTabId;
            const isDragOver = dragOverIndex === idx;
            const isDragging = draggedTabIndex === idx;

            return (
              <div
                key={tab.id}
                class={
                  'preview-tab-item' +
                  (isActive ? ' active' : '') +
                  (isDragOver ? ' is-drag-over' : '') +
                  (isDragging ? ' is-dragging' : '')
                }
                draggable={true}
                onClick={() => setActiveTabId(tab.id)}
                onDblClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id, e as unknown as MouseEvent);
                }}
                onDragStart={(e) => handleTabDragStart(idx, e as unknown as DragEvent)}
                onDragOver={(e) => handleTabDragOver(idx, e as unknown as DragEvent)}
                onDrop={(e) => handleTabDrop(idx, e as unknown as DragEvent)}
                onDragEnd={() => {
                  setDraggedTabIndex(null);
                  setDragOverIndex(null);
                }}
                title={tab.filePath}
              >
                <span class="preview-tab-icon">{getTabIcon(tab.filePath)}</span>
                <span class="preview-tab-name">{tab.fileName}</span>
                {dirtyTabIds[tab.id] && (
                  <span
                    class="preview-tab-dirty"
                    title={t('preview.tabDirty')}
                    aria-label={t('preview.tabDirty')}
                  />
                )}
                <button
                  type="button"
                  class="preview-tab-close"
                  onClick={(e) => handleCloseTab(tab.id, e as unknown as MouseEvent)}
                  title={t('preview.closeTab')}
                  aria-label={t('preview.closeTab')}
                >
                  ×
                </button>
              </div>
            );
          })}

          {tabs.length === 0 && (
            <div class="preview-tabs-empty-hint">
              <span>{t('preview.dropHint')}</span>
            </div>
          )}
        </div>

        {/* 顶部右侧快捷工具按钮 */}
        <div class="preview-bar-actions">
          {activeTab && (
            <button
              type="button"
              class="preview-action-btn"
              onClick={async () => {
                if (!activeTab) return;
                if (dirtyTabIds[activeTab.id]) {
                  const ok = await modalConfirm({
                    title: t('preview.refreshDirtyTitle'),
                    body: t('preview.refreshDirtyDesc'),
                    confirmLabel: t('preview.refreshDirtyConfirm'),
                    danger: true,
                  });
                  if (!ok) return;
                }
                setReloadTokens((prev) => bumpReloadToken(prev, activeTab.id));
                showToast(t('preview.refreshed'), 'info');
              }}
              title={t('preview.refresh')}
              aria-label={t('preview.refresh')}
            >
              🔄
            </button>
          )}

          {activeTab && (
            <button
              type="button"
              class={'preview-action-btn' + (activeViewMode === 'edit' ? ' active' : '')}
              onClick={() => {
                window.dispatchEvent(new CustomEvent(`jeikcode:editor:toggle_mode:${previewEditorStateKey(activeTab.filePath)}`));
              }}
              title={
                activeViewMode === 'edit'
                  ? `${t('editor.switchToPreview')} (Ctrl+Shift+V)`
                  : `${t('editor.switchToEdit')} (Ctrl+Shift+V)`
              }
              aria-label={t('preview.toggleMode')}
            >
              {activeViewMode === 'edit' ? '📖' : '✏️'}
            </button>
          )}

          {activeTab && activeViewMode === 'edit' && (
            <button
              type="button"
              class="preview-action-btn"
              onClick={() => {
                window.dispatchEvent(new CustomEvent(`jeikcode:editor:save:${previewEditorStateKey(activeTab.filePath)}`));
              }}
              title={`${t('editor.save')} (Ctrl+S)`}
              aria-label={t('editor.save')}
            >
              💾
            </button>
          )}

          {tabs.length > 0 && (
            <button
              type="button"
              class="preview-action-btn preview-clear-btn"
              onClick={handleClearAll}
              title={t('preview.clearAll')}
              aria-label={t('preview.clearAll')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 主体预览/编辑舞台 (由 CodeEditorTab 驱动，满血具备撤销、黄色搜索高亮与替换功能) */}
      <div
        class="preview-viewport-stage"
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const raw = e.dataTransfer?.getData('application/jeikcode-tab');
            const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
            const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
            if (targetPath) {
              openTab(typeof data === 'object' && data?.filePath ? data : { filePath: targetPath });
              return;
            }
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
              for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                const p = (file as any).path || file.name;
                if (p) {
                  openTab({ filePath: p, fileName: file.name });
                }
              }
            }
          } catch {}
        }}
      >
        {tabs.length === 0 || !activeTab ? (
          <div class="preview-empty-stage">
            <div class="preview-empty-box">
              <div class="preview-empty-icon">👁️</div>
              <div class="preview-empty-title">
                {t('preview.emptyTitle')}
              </div>
              <div class="preview-empty-desc">
                {t('preview.emptyDesc')}
              </div>
            </div>
          </div>
        ) : (
          // 标签保活：已访问过的标签常驻 DOM，只做 CSS 显隐切换。
          // 与浏览器标签一致，切走再切回会保留编辑/预览模式、未保存草稿、光标与滚动位置。
          tabs
            .filter((tab) => visitedTabIds[tab.id] || tab.id === activeTabId)
            .map((tab) => {
              const isActiveTab = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  class="preview-editor-slot"
                  style={{ display: isActiveTab ? 'flex' : 'none' }}
                >
                  <CodeEditorTab
                    key={tab.id}
                    filePath={tab.filePath}
                    cwd={cwd}
                    startLine={tab.startLine}
                    endLine={tab.endLine}
                    stateKey={previewEditorStateKey(tab.filePath)}
                    defaultViewMode={tabViewModes[tab.id] ?? 'preview'}
                    active={surfaceActive && isActiveTab}
                    restoreFocusOnActivate={false}
                    reloadToken={reloadTokens[tab.id] ?? 0}
                    onViewModeChange={(mode) => handleViewModeChange(tab.id, mode)}
                    onDirtyChange={(dirty) => markTabDirty(tab.id, dirty)}
                    hideHeaderToolbar={true}
                    onFileDrop={(path) => openTab({ filePath: path })}
                    linkTargetContext="right"
                    onClose={() => handleCloseTab(tab.id)}
                  />
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}
