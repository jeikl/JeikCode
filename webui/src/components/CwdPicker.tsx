// Task 15b — Working directory picker modal

import { useEffect, useRef, useState } from 'preact/hooks';
import { listDir, getProjects, changeDir, deleteProject, mkdir, ProjectInfo } from '../api';
import { fsBreadcrumbs, joinFsChild, stripExtendedPathPrefix } from '../lib/displayPath';
import { useT } from '../settings';

interface CwdPickerProps {
  current: string;
  onPick: (path: string) => void;
  onClose: () => void;
  /** Overrides the default "switch directory" title (add-project flow). */
  title?: string;
}

export function CwdPicker({ current, onPick, onClose, title }: CwdPickerProps) {
  const t = useT();
  const initialPath = stripExtendedPathPrefix(current || '~');
  const [inputPath, setInputPath] = useState(initialPath);
  const [browsePath, setBrowsePath] = useState(initialPath);
  const [dirs, setDirs] = useState<string[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load directory listing when browsePath changes
  useEffect(() => {
    setDirLoading(true);
    setDirError(null);
    listDir(browsePath)
      .then((result) => {
        const path = stripExtendedPathPrefix(result.path);
        setBrowsePath(path); // server may normalize the path
        setInputPath((cur) => (cur === browsePath ? path : cur));
        setDirs(result.dirs);
      })
      .catch((e: unknown) => {
        setDirError(e instanceof Error ? e.message : String(e));
        setDirs([]);
      })
      .finally(() => setDirLoading(false));
  }, [browsePath]);

  // Load recent projects once
  useEffect(() => {
    getProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  function handleJump() {
    const p = stripExtendedPathPrefix(inputPath.trim());
    if (p) {
      setInputPath(p);
      setBrowsePath(p);
    }
  }

  function handleSubdirClick(dirName: string) {
    const newPath = joinFsChild(browsePath, dirName);
    setBrowsePath(newPath);
    setInputPath(newPath);
  }

  function handleBreadcrumbClick(fullPath: string) {
    setBrowsePath(fullPath);
    setInputPath(fullPath);
  }

  function handleProjectClick(workingDir: string) {
    const path = stripExtendedPathPrefix(workingDir);
    setBrowsePath(path);
    setInputPath(path);
  }

  async function handleDeleteProject(hash: string, e: MouseEvent) {
    e.stopPropagation();
    try {
      await deleteProject(hash);
      setProjects((prev) => prev.filter((p) => p.hash !== hash));
    } catch {
      setProjects((prev) => prev.filter((p) => p.hash !== hash));
    }
  }

  async function handleCreateFolder() {
    const name = newFolder.trim();
    if (!name) return;
    setMkdirError(null);
    try {
      const result = await mkdir(joinFsChild(browsePath, name));
      setBrowsePath(result.path);
      setInputPath(result.path);
      setNewFolder('');
    } catch (e: unknown) {
      setMkdirError(t('cwd.createFailed'));
    }
  }

  async function handleConfirm() {
    const finalPath = stripExtendedPathPrefix(browsePath.trim() || inputPath.trim());
    if (!finalPath) return;
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

  const crumbs = fsBreadcrumbs(browsePath);

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal-card">
        <div class="modal-header">
          <span>📁</span>
          <h3>{title || t('cwd.title')}</h3>
          <span class="modal-sub" style="margin-left:auto">{t('cwd.affectsSession')}</span>
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
              {t('cwd.hintBefore')} <code>~</code> {t('cwd.hintAfter')}
            </p>
          </div>

          {/* Directory browser */}
          <div class="dir-browser">
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

            <div class="dir-list">
              {dirLoading && <div class="dir-note">{t('cwd.loading')}</div>}
              {dirError && <div class="dir-note error">{dirError}</div>}
              {!dirLoading && !dirError && dirs.length === 0 && (
                <div class="dir-note">{t('cwd.noSubdirs')}</div>
              )}
              {!dirLoading &&
                dirs.map((d) => (
                  <button key={d} class="dir-item" onClick={() => handleSubdirClick(d)}>
                    <span>📁</span>
                    <span>{d}</span>
                  </button>
                ))}
            </div>

            <div class="cwd-newfolder">
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
            </div>
            {mkdirError && <div class="dir-note error">{mkdirError}</div>}
          </div>

          {/* Recent projects */}
          {projects.length > 0 && (
            <div class="field-group">
              <span class="modal-label">{t('cwd.recentProjects')}</span>
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
          )}
        </div>

        <div class="modal-footer">
          <button class="btn" onClick={onClose}>
            {t('cwd.cancel')}
          </button>
          <button class="btn btn-primary" onClick={handleConfirm} disabled={confirming}>
            {t('cwd.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
