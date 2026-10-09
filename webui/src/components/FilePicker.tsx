// Server-side file picker modal. The browser's native file input can't expose
// an absolute path (security), so we browse the daemon's filesystem via
// /fs/list (dirs + files) and return the chosen file's absolute path for
// insertion into the chat input. Reuses CwdPicker's modal/dir-browser styles.

import { useEffect, useRef, useState } from 'preact/hooks';
import { listDir } from '../api';
import { fsBreadcrumbs, joinFsChild, stripExtendedPathPrefix } from '../lib/displayPath';
import { useT } from '../settings';

interface FilePickerProps {
  /** Initial directory to browse (typically the current cwd). */
  current: string;
  /** Called with the selected file's absolute path. */
  onPick: (path: string) => void;
  onClose: () => void;
}

export function FilePicker({ current, onPick, onClose }: FilePickerProps) {
  const t = useT();
  const [browsePath, setBrowsePath] = useState(stripExtendedPathPrefix(current || '~'));
  const [dirs, setDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 用于拼接选中文件的绝对路径：始终用服务端归一化后的 browsePath。
  const resolvedPath = useRef(current || '');

  useEffect(() => {
    setLoading(true);
    setError(null);
    listDir(browsePath)
      .then((result) => {
        const path = stripExtendedPathPrefix(result.path);
        resolvedPath.current = path;
        if (path !== browsePath) setBrowsePath(path);
        setDirs(result.dirs);
        setFiles(result.files ?? []);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setDirs([]);
        setFiles([]);
      })
      .finally(() => setLoading(false));
  }, [browsePath]);

  function enterDir(name: string) {
    setBrowsePath(joinFsChild(resolvedPath.current, name));
  }

  function pickFile(name: string) {
    onPick(joinFsChild(resolvedPath.current, name));
    onClose();
  }

  const crumbs = fsBreadcrumbs(browsePath);

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal-card file-picker-modal">
        <div class="modal-header">
          <span>📄</span>
          <h3>{t('filepicker.title')}</h3>
        </div>

        <div class="modal-body">
          <div class="dir-browser">
            <div class="dir-breadcrumb">
              {crumbs.map((crumb, i) => (
                <span key={i}>
                  <span
                    onClick={() => setBrowsePath(crumb.fullPath)}
                    class={'dir-crumb' + (i === crumbs.length - 1 ? ' current' : '')}
                  >
                    {crumb.label}
                  </span>
                  {i < crumbs.length - 1 && <span> / </span>}
                </span>
              ))}
            </div>

            <div class="dir-list">
              {loading && <div class="dir-note">{t('filepicker.loading')}</div>}
              {error && <div class="dir-note error">{error}</div>}
              {!loading && !error && dirs.length === 0 && files.length === 0 && (
                <div class="dir-note">{t('filepicker.empty')}</div>
              )}
              {!loading &&
                dirs.map((d) => (
                  <button key={'d:' + d} class="dir-item" onClick={() => enterDir(d)}>
                    <span>📁</span>
                    <span>{d}</span>
                  </button>
                ))}
              {!loading &&
                files.map((f) => (
                  <button key={'f:' + f} class="dir-item file-item" onClick={() => pickFile(f)}>
                    <span>📄</span>
                    <span>{f}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
