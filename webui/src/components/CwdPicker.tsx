// Working directory picker modal — Modern Explorer experience
// Supports drives switching (e.g. C:, D: on Windows), quick access shortcuts,
// instant subfolder filtering, breadcrumbs navigation, and global language safety.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { listDir, getProjects, changeDir, deleteProject, mkdir, ProjectInfo, FsShortcut } from '../api';
import { fsBreadcrumbs, joinFsChild, stripExtendedPathPrefix } from '../lib/displayPath';
import { useT } from '../settings';

interface CwdPickerProps {
  current: string;
  onPick: (path: string) => void;
  onClose: () => void;
  /** Overrides the default "switch directory" title (add-project flow). */
  title?: string;
  /** Browse and return a host path without changing sessions or creating folders. */
  selectionOnly?: boolean;
}

export function CwdPicker({ current, onPick, onClose, title, selectionOnly = false }: CwdPickerProps) {
  const t = useT();
  const initialPath = stripExtendedPathPrefix(current || '~');
  const [inputPath, setInputPath] = useState(initialPath);
  const [browsePath, setBrowsePath] = useState(initialPath);
  const [dirs, setDirs] = useState<string[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [shortcuts, setShortcuts] = useState<FsShortcut[]>([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listingSequence = useRef(0);
  const [loadedPath, setLoadedPath] = useState('');
  const [listingAttempt, setListingAttempt] = useState(0);

  // Load directory listing when browsePath changes
  useEffect(() => {
    const sequence = ++listingSequence.current;
    let active = true;
    setDirLoading(true);
    setDirError(null);
    setLoadedPath('');
    setFilterQuery(''); // Reset filter when navigating into a new folder
    listDir(browsePath)
      .then((result) => {
        if (!active || sequence !== listingSequence.current) return;
        const path = stripExtendedPathPrefix(result.path);
        setBrowsePath(path); // server may normalize the path
        setInputPath((cur) => (cur === browsePath ? path : cur));
        setLoadedPath(path);
        setDirs(result.dirs || []);
        if (result.drives && result.drives.length > 0) {
          setDrives(result.drives);
        }
        if (result.shortcuts && result.shortcuts.length > 0) {
          setShortcuts(result.shortcuts);
        }
      })
      .catch((e: unknown) => {
        if (!active || sequence !== listingSequence.current) return;
        setDirError(e instanceof Error ? e.message : String(e));
        setDirs([]);
      })
      .finally(() => {
        if (active && sequence === listingSequence.current) setDirLoading(false);
      });
    return () => { active = false; };
  }, [browsePath, listingAttempt]);

  // Load recent projects once
  useEffect(() => {
    if (selectionOnly) return;
    let active = true;
    getProjects()
      .then((result) => { if (active) setProjects(result); })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [selectionOnly]);

  useEffect(() => {
    if (!selectionOnly) return;
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [selectionOnly]);

  function navigateTo(path: string) {
    listingSequence.current++;
    setLoadedPath('');
    setDirLoading(true);
    setDirError(null);
    setDirs([]);
    if (path === browsePath) setListingAttempt((value) => value + 1);
    setInputPath(path);
    setBrowsePath(path);
  }

  function handleJump() {
    const p = stripExtendedPathPrefix(inputPath.trim());
    if (p) navigateTo(p);
  }

  function handleSubdirClick(dirName: string) {
    const newPath = joinFsChild(browsePath, dirName);
    navigateTo(newPath);
  }

  function handleBreadcrumbClick(fullPath: string) {
    navigateTo(fullPath);
  }

  function handleProjectClick(workingDir: string) {
    const path = stripExtendedPathPrefix(workingDir);
    navigateTo(path);
  }

  function handleDriveClick(drive: string) {
    // Windows drive letters need a trailing backslash to represent root (e.g. "D:\")
    const target = drive.endsWith(':') ? `${drive}\\` : drive;
    navigateTo(target);
  }

  function handleShortcutClick(shortcutPath: string) {
    const path = stripExtendedPathPrefix(shortcutPath);
    navigateTo(path);
  }

  async function handleDeleteProject(hash: string, e: MouseEvent) {
    e.stopPropagation();
    if (selectionOnly) return;
    try {
      await deleteProject(hash);
      setProjects((prev) => prev.filter((p) => p.hash !== hash));
    } catch {
      setProjects((prev) => prev.filter((p) => p.hash !== hash));
    }
  }

  async function handleCreateFolder() {
    if (selectionOnly) return;
    const name = newFolder.trim();
    if (!name) return;
    setMkdirError(null);
    try {
      const result = await mkdir(joinFsChild(browsePath, name));
      setBrowsePath(result.path);
      setInputPath(result.path);
      setNewFolder('');
    } catch {
      setMkdirError(t('cwd.createFailed'));
    }
  }

  async function handleConfirm() {
    const finalPath = stripExtendedPathPrefix(browsePath.trim() || inputPath.trim());
    if (!finalPath) return;
    if (selectionOnly) {
      if (!selectionReady) return;
      onPick(finalPath);
      onClose();
      return;
    }
    setConfirming(true);
    try {
      await changeDir(finalPath);
      onPick(finalPath);
      onClose();
    } catch {
      // Best-effort; still switch cwd locally
      onPick(finalPath);
      onClose();
    } finally {
      setConfirming(false);
    }
  }

  // Filtered subdirectories based on search query
  const filteredDirs = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    if (!query) return dirs;
    return dirs.filter((d) => d.toLowerCase().includes(query));
  }, [dirs, filterQuery]);

  const crumbs = fsBreadcrumbs(browsePath);
  const selectionReady = loadedPath === browsePath && !!loadedPath &&
    inputPath.trim() === browsePath && !dirLoading && !dirError;

  // Shortcut icon helper
  function getShortcutIcon(id: string) {
    switch (id) {
      case 'home':
        return '🏠';
      case 'desktop':
        return '🖥️';
      case 'downloads':
        return '📥';
      case 'documents':
        return '📄';
      default:
        return '📁';
    }
  }

  // Check if a drive is current
  function isDriveActive(drive: string) {
    const upperBrowse = browsePath.toUpperCase();
    const upperDrive = drive.toUpperCase();
    return upperBrowse.startsWith(upperDrive);
  }

  return (
    <div
      class={'modal-overlay' + (selectionOnly ? ' repair-picker-overlay' : '')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (!selectionOnly || e.isComposing) return;
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
        if (e.key !== 'Tab') return;
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
        ));
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
    >
      <div class="modal-card cwd-picker-modal" role="dialog" aria-modal="true"
        aria-label={title || t('cwd.title')}>
        <div class="modal-header">
          <span>📁</span>
          <h3>{title || t('cwd.title')}</h3>
          <span class="modal-sub" style="margin-left:auto">
            {selectionOnly ? t('repair.hostFilesystem') : t('cwd.affectsSession')}
          </span>
        </div>

        <div class="modal-body">
          {/* Path input */}
          <div class="field-group">
            <span class="modal-label">{t('cwd.path')}</span>
            <div class="field-row">
              <input
                ref={inputRef}
                type="text"
                class="menu-input"
                value={inputPath}
                onInput={(e) => setInputPath((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  // 忽略输入法组字阶段的回车（选词确认），避免误触发跳转。
                  if (e.isComposing) return;
                  if (e.key === 'Enter') handleJump();
                }}
                placeholder="~/..."
              />
              <button class="btn btn-primary" onClick={handleJump}>
                {t('cwd.jump')}
              </button>
            </div>
            <p class="field-hint">
              {selectionOnly
                ? t('repair.browseHint')
                : <>{t('cwd.hintBefore')} <code>~</code> {t('cwd.hintAfter')}</>}
            </p>
          </div>

          {/* Quick access & drives bar */}
          {(shortcuts.length > 0 || drives.length > 0) && (
            <div class="cwd-quick-bar">
              {/* Storage drives */}
              {drives.map((d) => (
                <button
                  key={d}
                  type="button"
                  class={'cwd-quick-chip' + (isDriveActive(d) ? ' active' : '')}
                  title={`${t('cwd.drives')}: ${d}`}
                  onClick={() => handleDriveClick(d)}
                >
                  <span>💽</span>
                  <span>{d}</span>
                </button>
              ))}

              {/* System shortcuts */}
              {shortcuts.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  class="cwd-quick-chip"
                  title={s.path}
                  onClick={() => handleShortcutClick(s.path)}
                >
                  <span>{getShortcutIcon(s.id)}</span>
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Directory browser */}
          <div class="dir-browser">
            {/* Breadcrumb row */}
            <div class="dir-breadcrumb">
              {crumbs.map((crumb, i) => (
                <span key={i}>
                  <span
                    onClick={() => handleBreadcrumbClick(crumb.fullPath)}
                    class={'dir-crumb' + (i === crumbs.length - 1 ? ' current' : '')}
                  >
                    {crumb.label}
                  </span>
                  {i < crumbs.length - 1 && <span> / </span>}
                </span>
              ))}
            </div>

            {/* Instant Filter Bar */}
            {dirs.length > 5 && (
              <div class="dir-filter-bar">
                <span style="opacity:0.6;font-size:11px;">🔍</span>
                <input
                  type="text"
                  class="dir-filter-input"
                  placeholder={t('cwd.filter')}
                  value={filterQuery}
                  onInput={(e) => setFilterQuery((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.isComposing) return;
                    if (e.key === 'Escape' && filterQuery) {
                      // Clear this filter first; only a subsequent Escape
                      // should reach the selection-only dialog's close handler.
                      e.stopPropagation();
                      e.preventDefault();
                      setFilterQuery('');
                    }
                  }}
                />
                {filterQuery && (
                  <button
                    type="button"
                    style="background:none;border:none;cursor:pointer;opacity:0.6;font-size:11px;padding:0 2px;color:inherit;"
                    onClick={() => setFilterQuery('')}
                    title="Clear filter"
                  >
                    ✕
                  </button>
                )}
                <span class="dir-filter-count">
                  {filterQuery ? `${filteredDirs.length}/${dirs.length}` : `${dirs.length}`}
                </span>
              </div>
            )}

            {/* Subdirectories list */}
            <div class="dir-list">
              {dirLoading && <div class="dir-note">{t('cwd.loading')}</div>}
              {dirError && <div class="dir-note error">{dirError}</div>}
              {!dirLoading && !dirError && dirs.length === 0 && (
                <div class="dir-note">{t('cwd.noSubdirs')}</div>
              )}
              {!dirLoading && !dirError && dirs.length > 0 && filteredDirs.length === 0 && (
                <div class="dir-note">{t('cwd.noMatches')}</div>
              )}
              {!dirLoading &&
                filteredDirs.map((d) => (
                  <button key={d} class="dir-item" onClick={() => handleSubdirClick(d)}>
                    <span>📁</span>
                    <span>{d}</span>
                  </button>
                ))}
            </div>

            {/* New folder creation */}
            {!selectionOnly && <div class="cwd-newfolder">
              <input
                type="text"
                class="menu-input"
                placeholder={t('cwd.folderName')}
                value={newFolder}
                onInput={(e) => {
                  setNewFolder((e.target as HTMLInputElement).value);
                  setMkdirError(null);
                }}
                onKeyDown={(e) => {
                  if (e.isComposing) return;
                  if (e.key === 'Enter') handleCreateFolder();
                }}
              />
              <button class="btn btn-primary" onClick={handleCreateFolder}>
                {t('cwd.create')}
              </button>
            </div>}
            {mkdirError && <div class="dir-note error">{mkdirError}</div>}
          </div>

          {/* Recent projects */}
          {!selectionOnly && projects.length > 0 && (
            <div class="field-group cwd-recent-projects">
              <span class="modal-label">{t('cwd.recentProjects')}</span>
              <div class="cwd-recent-list">
                {projects.slice(0, 6).map((p) => {
                  const isCurrent = p.working_dir === browsePath;
                  return (
                    <div
                      key={p.hash}
                      class={'list-row' + (isCurrent ? ' active' : '')}
                      onClick={() => handleProjectClick(p.working_dir)}
                    >
                      <span class="mono" style="flex:1;min-width:0">{p.working_dir}</span>
                      {isCurrent && <span class="badge">● {t('cwd.current')}</span>}
                      <button
                        type="button"
                        title={t('cwd.removeRecent')}
                        aria-label={t('cwd.removeRecent')}
                        style="background:none;border:none;cursor:pointer;padding:2px 4px;opacity:0.6;font-size:12px;margin-left:auto;color:inherit;"
                        onClick={(e) => handleDeleteProject(p.hash, e)}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div class="modal-footer">
          <button class="btn" onClick={onClose}>
            {t('cwd.cancel')}
          </button>
          <button class="btn btn-primary" onClick={handleConfirm}
            disabled={confirming || (selectionOnly && !selectionReady)}>
            {selectionOnly ? t('repair.chooseFolder') : t('cwd.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
