import { useState, useEffect, useRef } from 'preact/hooks';
import { checkUpdate, executeUpdate, getUpdateStatus, UpdateCheckResponse, UpdateStatus } from '../api';
import { useT } from '../settings';

const STORAGE_KEY_CHANNEL = 'jeikcode_update_channel';

interface UpdateDialogProps {
  info: UpdateCheckResponse | null;
  onClose: () => void;
  onUpdateInfoChange?: (info: UpdateCheckResponse) => void;
}

export function UpdateDialog({ info: initialInfo, onClose, onUpdateInfoChange }: UpdateDialogProps) {
  const t = useT();

  // 读取已保存的通道偏好；若无则根据版本判断默认通道（含 '-' 为 beta，否则为 stable）
  const getInitialChannel = (): 'stable' | 'beta' => {
    const saved = localStorage.getItem(STORAGE_KEY_CHANNEL);
    if (saved === 'beta' || saved === 'stable') return saved;
    if (initialInfo?.channel === 'beta' || initialInfo?.channel === 'stable') return initialInfo.channel;
    if (initialInfo?.current_version?.includes('-')) return 'beta';
    return 'stable';
  };

  const [channel, setChannel] = useState<'stable' | 'beta'>(getInitialChannel);
  const [info, setInfo] = useState<UpdateCheckResponse | null>(initialInfo);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  const isDesktop = info?.is_desktop ?? false;
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // 检查更新
  const doCheckUpdate = async (targetChannel: 'stable' | 'beta') => {
    setIsChecking(true);
    setCheckError(null);
    try {
      const res = await checkUpdate(targetChannel);
      if (isMounted.current) {
        setInfo(res);
        if (onUpdateInfoChange) {
          onUpdateInfoChange(res);
        }
      }
    } catch (err: any) {
      if (isMounted.current) {
        setCheckError(err?.message || String(err));
      }
    } finally {
      if (isMounted.current) {
        setIsChecking(false);
      }
    }
  };

  // 切换更新通道
  const handleSelectChannel = (newChannel: 'stable' | 'beta') => {
    if (newChannel === channel && info) return;
    setChannel(newChannel);
    localStorage.setItem(STORAGE_KEY_CHANNEL, newChannel);
    doCheckUpdate(newChannel);
  };

  // 弹窗打开时立即无条件执行一次最新版本探测，彻底消除历史缓存滞后，确保拉取到绝对最新的跨版本数据
  useEffect(() => {
    doCheckUpdate(channel);
  }, []);

  // 轮询更新进度
  useEffect(() => {
    let timer: any = null;
    if (updating) {
      timer = setInterval(async () => {
        try {
          const s = await getUpdateStatus();
          if (isMounted.current) {
            setStatus(s);
            if (s.status === 'done' || s.status === 'error') {
              if (timer) clearInterval(timer);
            }
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
    if (isChecking) return;
    setUpdating(true);
    try {
      await executeUpdate({
        channel,
        version: info?.latest_version,
        download_url: info?.download_url ?? undefined,
      });
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

  const hasUpdate = info?.has_update ?? false;

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
          <h3 id="update-dialog-title">{t('update.modalTitle')}</h3>
          {!updating && (
            <button class="ghost-btn modal-close" onClick={onClose} aria-label={t('common.cancel')}>
              ×
            </button>
          )}
        </div>

        <div class="modal-body update-dialog-body">
          {/* 更新通道选择器（对标 Antigravity-Manager） */}
          <div class="update-channel-section">
            <div class="update-channel-header">
              <span class="update-channel-label">{t('update.channel')}:</span>
              <div class="update-channel-toggle-group">
                <button
                  type="button"
                  class={`update-channel-btn ${channel === 'stable' ? 'active' : ''}`}
                  onClick={() => handleSelectChannel('stable')}
                  disabled={updating || isChecking}
                >
                  {t('update.channelStable')}
                </button>
                <button
                  type="button"
                  class={`update-channel-btn beta ${channel === 'beta' ? 'active' : ''}`}
                  onClick={() => handleSelectChannel('beta')}
                  disabled={updating || isChecking}
                >
                  <span>{t('update.channelBeta')}</span>
                  <span class="update-channel-beta-dot" />
                </button>
              </div>
            </div>
            <p class={`update-channel-desc ${channel === 'beta' ? 'beta' : ''}`}>
              {channel === 'beta' ? t('update.channelBetaDesc') : t('update.channelStableDesc')}
            </p>
          </div>

          {/* 版本对比卡片 */}
          <div class="update-version-card">
            <div class="update-version-row">
              <span class="update-version-label">{t('update.currentVersion')}</span>
              <span class="update-version-val current">
                {info?.current_version || 'v' + (typeof window !== 'undefined' ? (window as any).__JEIKCODE_VERSION__ || '...' : '...')}
              </span>
            </div>
            <div class="update-version-arrow">➔</div>
            <div class="update-version-row">
              <span class="update-version-label">{t('update.latestVersion')}</span>
              <span class={`update-version-val ${hasUpdate ? 'latest' : 'current'}`}>
                {isChecking ? '...' : (info?.latest_version || info?.current_version || '...')}
              </span>
            </div>
          </div>

          {/* 状态展示与进度条 */}
          {!updating ? (
            <div class="update-status-display">
              {isChecking ? (
                <div class="update-status-row checking">
                  <div class="update-spinner" />
                  <span>{t('update.checking')}</span>
                </div>
              ) : checkError ? (
                <div class="update-status-row error">
                  <span class="update-status-error-icon">⚠️</span>
                  <span>{t('update.failed', { error: checkError })}</span>
                </div>
              ) : hasUpdate ? (
                <div class="update-status-row has-update">
                  <span class="update-status-sparkle">✨</span>
                  <span>{t('update.dialogDesc', { version: info?.latest_version || '' })}</span>
                </div>
              ) : (
                <div class="update-status-row latest">
                  <span class="update-status-check-icon">✓</span>
                  <span>{t('update.statusLatest')} ({info?.current_version})</span>
                </div>
              )}
            </div>
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
              {hasUpdate ? (
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
              ) : (
                <>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onClick={() => doCheckUpdate(channel)}
                    disabled={isChecking}
                  >
                    {isChecking ? t('update.btnChecking') : t('update.btnCheck')}
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    onClick={onClose}
                  >
                    {t('update.btnClose')}
                  </button>
                </>
              )}
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
                {t('update.btnRetry')}
              </button>
            </>
          ) : status?.status === 'done' ? (
            <button
              type="button"
              class="btn btn-primary"
              onClick={onClose}
            >
              {t('update.btnDone')}
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
