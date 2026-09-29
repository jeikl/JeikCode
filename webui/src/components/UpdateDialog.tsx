import { useState, useEffect } from 'preact/hooks';
import { executeUpdate, getUpdateStatus, UpdateCheckResponse, UpdateStatus } from '../api';
import { useT } from '../settings';

interface UpdateDialogProps {
  info: UpdateCheckResponse;
  onClose: () => void;
}

export function UpdateDialog({ info, onClose }: UpdateDialogProps) {
  const t = useT();
  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  const isDesktop = info.is_desktop;

  useEffect(() => {
    let timer: any = null;
    if (updating) {
      timer = setInterval(async () => {
        try {
          const s = await getUpdateStatus();
          setStatus(s);
          if (s.status === 'done' || s.status === 'error') {
            if (timer) clearInterval(timer);
          }
        } catch {
          // ignore transient poll error
        }
      }, 500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [updating]);

  const handleStartUpdate = async () => {
    setUpdating(true);
    try {
      await executeUpdate();
    } catch (err: any) {
      setStatus({
        status: 'error',
        progress: 0,
        bytes: 0,
        total: 0,
        error: err?.message || '发起更新失败',
      });
    }
  };

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (!updating && e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal-card update-modal-card" role="dialog" aria-labelledby="update-dialog-title">
        <div class="modal-header">
          <span style="font-size: 16px;">🚀</span>
          <h3 id="update-dialog-title">{t('update.dialogTitle')}</h3>
          {!updating && (
            <button class="ghost-btn modal-close" onClick={onClose} aria-label={t('common.cancel')}>
              ×
            </button>
          )}
        </div>

        <div class="modal-body update-dialog-body">
          <div class="update-version-card">
            <div class="update-version-row">
              <span class="update-version-label">{t('update.currentVersion')}</span>
              <span class="update-version-val current">{info.current_version}</span>
            </div>
            <div class="update-version-arrow">➔</div>
            <div class="update-version-row">
              <span class="update-version-label">{t('update.latestVersion')}</span>
              <span class="update-version-val latest">{info.latest_version}</span>
            </div>
          </div>

          {!updating ? (
            <p class="update-prompt-text">
              {t('update.dialogDesc', { version: info.latest_version })}
            </p>
          ) : (
            <div class="update-progress-section">
              <div class="update-progress-bar-bg">
                <div
                  class={`update-progress-bar-fill ${status?.status === 'error' ? 'error' : ''}`}
                  style={{ width: `${status?.progress ?? 0}%` }}
                />
              </div>
              <div class="update-progress-status-row">
                <span class="update-progress-text">
                  {status?.status === 'downloading'
                    ? isDesktop
                      ? t('update.downloadingSetup', { percent: status?.progress ?? 0 })
                      : t('update.downloadingCli', { percent: status?.progress ?? 0 })
                    : status?.status === 'ready' || status?.status === 'installing'
                      ? isDesktop
                        ? t('update.readyDesktop')
                        : t('update.downloadingCli', { percent: 100 })
                      : status?.status === 'done'
                        ? t('update.readyCli')
                        : status?.status === 'error'
                          ? t('update.failed', { error: status?.error || '' })
                          : t('update.downloading')}
                </span>
                <span class="update-progress-percent">
                  {status?.progress ?? 0}%
                </span>
              </div>
            </div>
          )}
        </div>

        <div class="modal-footer update-dialog-footer">
          {!updating ? (
            <>
              <button
                type="button"
                class="btn btn-secondary"
                onClick={onClose}
              >
                {t('update.btnCancel')}
              </button>
              <button
                type="button"
                class="btn btn-primary update-confirm-btn"
                onClick={handleStartUpdate}
              >
                {t('update.btnUpdate')}
              </button>
            </>
          ) : status?.status === 'error' ? (
            <>
              <button
                type="button"
                class="btn btn-secondary"
                onClick={onClose}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                onClick={handleStartUpdate}
              >
                重试
              </button>
            </>
          ) : status?.status === 'done' ? (
            <button
              type="button"
              class="btn btn-primary"
              onClick={onClose}
            >
              完成
            </button>
          ) : (
            <button
              type="button"
              class="btn btn-secondary"
              disabled
            >
              {isDesktop ? '正在准备安装…' : '正在更新…'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
