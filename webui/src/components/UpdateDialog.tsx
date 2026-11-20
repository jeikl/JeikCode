import DOMPurify from 'dompurify';
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  checkUpdate,
  executeUpdate,
  getUpdateStatus,
  installPreparedDesktopUpdate,
  UpdateCheckResponse,
  UpdateStatus,
  UpdateVersionEntry,
} from '../api';
import { upgradeErrorText } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { shouldReloadUpgradedPage } from '../lib/upgradeReload';
import {
  hasNativeTauriRuntime,
  isLocalDesktopWindow,
  resolveUpdatePlan,
  type PathBEngine,
  type UpdateExecutionMode,
} from '../lib/updateRouting';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { Markdown } from './Markdown';
import { useT } from '../settings';

/** 边缘 Atom 的公告是 HTML；GitHub REST 兜底时仍是 Markdown。 */
function looksLikeHtml(text: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(text);
}

function sanitizeNotesHtml(text: string): string {
  return DOMPurify.sanitize(text, { ADD_ATTR: ['target', 'rel'] });
}

function notesPlainText(text: string): string {
  if (!looksLikeHtml(text)) return text;
  const doc = new DOMParser().parseFromString(sanitizeNotesHtml(text), 'text/html');
  return (doc.body.textContent || text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

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
  const [selectedVersion, setSelectedVersion] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesCopied, setNotesCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [modeOverride, setModeOverride] = useState<UpdateExecutionMode | null>(null);
  const [activeExecMode, setActiveExecMode] = useState<UpdateExecutionMode | null>(null);
  const [activePathBEngine, setActivePathBEngine] = useState<PathBEngine>('none');
  const [pollBackendStatus, setPollBackendStatus] = useState(false);
  const [installingDesktop, setInstallingDesktop] = useState(false);

  const isMounted = useRef(true);
  const reloadStarted = useRef(false);
  const sawInstallProgress = useRef(false);
  const targetVersionRef = useRef('');
  const currentVersionRef = useRef('');
  const initialInstanceIdRef = useRef('');
  const reloadAfterRestartRef = useRef<() => void>(() => {});
  const tauriUnlistenRef = useRef<(() => void) | null>(null);
  const activeExecModeRef = useRef<UpdateExecutionMode>('binary');
  const activePathBEngineRef = useRef<PathBEngine>('none');
  activeExecModeRef.current = activeExecMode ?? 'binary';
  activePathBEngineRef.current = activePathBEngine;

  const isBusyUpdating =
    updating &&
    status?.status !== 'error' &&
    !(activeExecMode === 'desktop' && status?.status === 'ready' && !installingDesktop);

  // 遮罩空白处点击关闭：仅在「按下」与「松开」都落在遮罩本身时生效，避免拖拽划词误关。
  const mainBackdropDismiss = useBackdropDismiss(() => {
    if (!isBusyUpdating) onClose();
  });
  const notesBackdropDismiss = useBackdropDismiss(() => setNotesOpen(false));

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      tauriUnlistenRef.current?.();
      tauriUnlistenRef.current = null;
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
        setSelectedVersion('');
        setNotesOpen(false);
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

  // 轮询后端更新进度（用于路径 A 二进制热更，以及路径 B 后端辅助下载桌面安装包阶段）。
  useEffect(() => {
    if (!pollBackendStatus) return;
    let stopped = false;
    let misses = 0;
    const timer = window.setInterval(async () => {
      if (stopped || reloadStarted.current) return;
      try {
        const s = await getUpdateStatus();
        if (!isMounted.current || stopped) return;
        misses = 0;
        setStatus(s);
        if (s.status === 'error') {
          stopped = true;
          window.clearInterval(timer);
          setPollBackendStatus(false);
          return;
        }
        // 路径 B 后端辅助模式下载并校验完成后停在 ready，等待用户点击“安装并重启”
        if (activeExecModeRef.current === 'desktop' && activePathBEngineRef.current === 'backend_assisted') {
          if (s.status === 'ready') {
            stopped = true;
            window.clearInterval(timer);
            setPollBackendStatus(false);
          }
          return;
        }
        const progressed = s.status === 'installing' || s.status === 'done';
        if (progressed) sawInstallProgress.current = true;
        const restarted =
          s.status === 'done' ||
          (sawInstallProgress.current && (s.status === 'idle' || s.status === 'ready'));
        if (!restarted) return;
        stopped = true;
        window.clearInterval(timer);
        setPollBackendStatus(false);
        reloadAfterRestartRef.current();
      } catch {
        // 后端辅助下载尚未点击启动安装器前不把偶发轮询抖动当成重启完成
        if (activeExecModeRef.current === 'desktop') return;
        misses += 1;
        if (!sawInstallProgress.current || misses < 3 || stopped) return;
        stopped = true;
        window.clearInterval(timer);
        setPollBackendStatus(false);
        reloadAfterRestartRef.current();
      }
    }, 500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pollBackendStatus]);

  const sameVersion = (a?: string, b?: string) => {
    const n = (v?: string) => (v || '').trim().replace(/^v/i, '').toLowerCase();
    const x = n(a);
    const y = n(b);
    return x.length > 0 && x === y;
  };
  const versionEntries: UpdateVersionEntry[] =
    info?.versions && info.versions.length > 0
      ? info.versions
      : info?.latest_version
        ? [{ version: info.latest_version, notes: info.release_notes, released_at: info.released_at }]
        : [];
  const versionOptions = versionEntries.map((entry) => entry.version);
  const targetVersion =
    selectedVersion && versionOptions.some((v) => sameVersion(v, selectedVersion))
      ? versionOptions.find((v) => sameVersion(v, selectedVersion)) || versionOptions[0] || ''
      : versionOptions[0] || '';
  const selectedEntry = versionEntries.find((entry) => sameVersion(entry.version, targetVersion));
  const isLatestPick = !targetVersion || sameVersion(targetVersion, info?.latest_version || versionOptions[0]);
  const forceReinstall = isLatestPick && sameVersion(info?.current_version, targetVersion);
  const hasTauriIpc = hasNativeTauriRuntime();
  const inDesktopWindow = isLocalDesktopWindow();
  const plan = resolveUpdatePlan({
    info,
    targetVersion,
    isLatestPick,
    forceReinstall,
    inDesktopWindow,
    hasTauriIpc,
  });
  const effectiveMode: UpdateExecutionMode =
    modeOverride === 'binary' && plan.canPathA
      ? 'binary'
      : modeOverride === 'desktop' && plan.canPathB
        ? 'desktop'
        : plan.defaultMode;
  const isDesktopProgress = (activeExecMode ?? effectiveMode) === 'desktop';

  useEffect(() => {
    setModeOverride(null);
  }, [channel, targetVersion, info]);

  targetVersionRef.current = targetVersion;
  currentVersionRef.current = info?.current_version || '';
  // 只刷新当前页。桌面壳里这是同一端口的内部导航；换端口会被壳当成外链打开系统浏览器。
  // 异地浏览器同样停在当前地址，sessionStorage 里的 token 和 cookie 都还在。
  reloadAfterRestartRef.current = () => {
    if (reloadStarted.current) return;
    reloadStarted.current = true;
    const want = targetVersionRef.current;
    const from = currentVersionRef.current;
    const initialInstanceId = initialInstanceIdRef.current;
    const timeoutMessage = t('update.restartTimeout');
    void (async () => {
      let misses = 0;
      // 类似小地球机制：先给 500ms 让后端完成最后的数据帧并进入平滑停机与重启流程
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        try {
          const resp = await fetch(`/health?_t=${Date.now()}`, {
            credentials: 'include',
            signal: AbortSignal.timeout(1500),
            cache: 'no-store',
          });
          if (resp.ok) {
            const body = await resp.json();
            const got = String(body?.version ?? '');
            const currentInstanceId = String(body?.instance_id ?? '');
            if (
              shouldReloadUpgradedPage({
                want,
                from,
                got,
                consecutiveMisses: misses,
                initialInstanceId,
                currentInstanceId,
              })
            ) {
              // 刷新前清空版本检测冷却缓存，确保重连新进程后立刻拿到最新桌面壳兼容状态
              try {
                localStorage.removeItem('jeikcode_update_cooldown_v1');
              } catch {}
              window.location.reload();
              return;
            }
          } else {
            misses += 1;
          }
        } catch {
          misses += 1;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
      reloadStarted.current = false;
      if (isMounted.current) {
        setUpdating(false);
        setStatus({
          status: 'error',
          progress: 0,
          bytes: 0,
          total: 0,
          error: timeoutMessage,
        });
      }
    })();
  };

  const handleStartUpdate = async () => {
    if (isChecking || !targetVersion || plan.remoteReadonlyBlocked) return;
    if (effectiveMode === 'desktop' && plan.pathBEngine === 'manual') {
      if (plan.desktopHost?.installer_url) {
        window.open(plan.desktopHost.installer_url, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    reloadStarted.current = false;
    sawInstallProgress.current = false;
    setInstallingDesktop(false);
    setActiveExecMode(effectiveMode);
    setActivePathBEngine(plan.pathBEngine);
    setStatus(null);
    setUpdating(true);

    if (effectiveMode === 'desktop' && plan.pathBEngine === 'tauri_native') {
      setPollBackendStatus(false);
      const tauri = (window as any).__TAURI__;
      const endpoint = plan.desktopHost?.updater_json_url;
      if (!tauri?.core?.invoke || !endpoint) {
        setStatus({
          status: 'error',
          progress: 0,
          bytes: 0,
          total: 0,
          error: t('update.startFailed'),
        });
        return;
      }
      try {
        tauriUnlistenRef.current?.();
        tauriUnlistenRef.current = null;
        if (tauri.event?.listen) {
          const unlisten = await tauri.event.listen(
            'jeikcode:desktop:update_progress',
            (ev: { payload?: Partial<UpdateStatus> }) => {
              if (!isMounted.current || !ev?.payload) return;
              const p = ev.payload;
              setStatus({
                status: (p.status as UpdateStatus['status']) || 'downloading',
                progress: typeof p.progress === 'number' ? p.progress : 0,
                bytes: typeof p.bytes === 'number' ? p.bytes : 0,
                total: typeof p.total === 'number' ? p.total : 0,
                error: p.error,
              });
            },
          );
          if (!isMounted.current) {
            unlisten?.();
            return;
          }
          tauriUnlistenRef.current = unlisten;
        }
        await tauri.core.invoke('start_desktop_shell_update', {
          endpoint,
          proxy: plan.desktopHost?.proxy_url ?? null,
        });
        if (isMounted.current) {
          setStatus((prev) => ({
            status: 'ready',
            progress: 100,
            bytes: prev?.bytes ?? 0,
            total: prev?.total ?? 0,
          }));
        }
      } catch (err: any) {
        if (isMounted.current) {
          setStatus({
            status: 'error',
            progress: 0,
            bytes: 0,
            total: 0,
            error: typeof err === 'string' ? err : err?.message || t('update.startFailed'),
          });
        }
      }
      return;
    }

    if (effectiveMode === 'binary') {
      // 存量老壳先走路径 A 升级后端后，标记刷新时自动强制检测第 2 跳外壳更新
      try {
        if (plan.desktopHost?.legacy_shell) {
          sessionStorage.setItem('jeikcode_pending_legacy_shell_check', '1');
        } else {
          sessionStorage.removeItem('jeikcode_pending_legacy_shell_check');
        }
      } catch {}

      // 启动更新前记录当前实例代际 ID，用于重启后瞬间感知新进程上线
      try {
        const probe = await fetch(`/health?_t=${Date.now()}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(1000),
          cache: 'no-store',
        });
        if (probe.ok) {
          const body = await probe.json();
          initialInstanceIdRef.current = String(body?.instance_id ?? '');
        }
      } catch {
        /* 忽略前置失败 */
      }
    }

    try {
      setPollBackendStatus(true);
      await executeUpdate({
        channel,
        version: targetVersion,
        download_url:
          effectiveMode === 'binary' && isLatestPick
            ? info?.download_url ?? undefined
            : undefined,
        force:
          effectiveMode === 'desktop'
            ? forceReinstall || !isLatestPick || Boolean(plan.desktopHost?.legacy_shell)
            : forceReinstall || !isLatestPick,
        mode: effectiveMode === 'desktop' ? 'desktop_installer' : 'binary',
      });
    } catch (err: any) {
      setPollBackendStatus(false);
      setStatus({
        status: 'error',
        progress: 0,
        bytes: 0,
        total: 0,
        error: err?.message || t('update.startFailed'),
      });
    }
  };

  const handleInstallDesktop = async () => {
    if (installingDesktop) return;
    setInstallingDesktop(true);
    setStatus((prev) => ({
      status: 'installing',
      progress: 100,
      bytes: prev?.bytes ?? 0,
      total: prev?.total ?? 0,
    }));
    try {
      if (activePathBEngine === 'tauri_native') {
        const tauri = (window as any).__TAURI__;
        if (!tauri?.core?.invoke) {
          throw new Error(t('update.startFailed'));
        }
        await tauri.core.invoke('install_desktop_shell_update');
      } else {
        const res = await installPreparedDesktopUpdate();
        if (!res?.success) {
          throw new Error(res?.message || t('update.startFailed'));
        }
      }
    } catch (err: any) {
      if (isMounted.current) {
        setInstallingDesktop(false);
        setStatus({
          status: 'error',
          progress: 0,
          bytes: 0,
          total: 0,
          error: typeof err === 'string' ? err : err?.message || t('update.startFailed'),
        });
      }
    }
  };

  useEffect(() => {
    if (!notesOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setNotesOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notesOpen]);

  useEffect(() => {
    setNotesCopied('idle');
  }, [targetVersion, notesOpen]);

  const notesText = (selectedEntry?.notes || '').trim();
  const notesReleasedAt = (() => {
    const raw = selectedEntry?.released_at;
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString();
  })();

  const handleCopyNotes = async () => {
    if (!notesText) return;
    const ok = await copyTextToClipboard(notesPlainText(notesText));
    setNotesCopied(ok ? 'ok' : 'fail');
  };

  const hasUpdate = info?.has_update ?? false;
  const isDesktopShellUpgrade =
    effectiveMode === 'desktop' &&
    Boolean(plan.desktopHost?.shell_has_update || plan.desktopHost?.legacy_shell);
  // 稳定失败码命中时直接展示自包含的多语言文案；未知码退回 “更新失败: 原始诊断”。
  const localizedUpdateError = upgradeErrorText(t, status?.error_code);
  const canInstall =
    !isChecking &&
    !checkError &&
    !!targetVersion &&
    !plan.remoteReadonlyBlocked &&
    (effectiveMode === 'desktop' ? plan.canPathB : plan.canPathA);
  const primaryActionLabel =
    effectiveMode === 'desktop' && plan.pathBEngine === 'manual'
      ? t('update.btnDownloadInstaller')
      : forceReinstall && !isDesktopShellUpgrade
        ? t('update.btnForce')
        : t('update.btnUpdate');
  const displayTargetVersion =
    !isLatestPick
      ? targetVersion
      : (!hasUpdate && isDesktopShellUpgrade && plan.desktopHost?.latest_shell_version
        ? `v${plan.desktopHost.latest_shell_version.replace(/^v/i, '')}`
        : (targetVersion || info?.latest_version || '...'));
  const hasDisplayVersionDiff =
    hasUpdate || !isLatestPick || (plan.inDesktopWindow && Boolean(plan.desktopHost?.shell_has_update || plan.desktopHost?.legacy_shell));

  return (
    <>
    <div
      class="modal-overlay"
      {...mainBackdropDismiss}
    >
      <div class="modal-card update-modal-card" role="dialog" aria-labelledby="update-dialog-title">
        <div class="modal-header">
          <h3 id="update-dialog-title">{t('update.modalTitle')}</h3>
          {!isBusyUpdating && (
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
              <span class="update-version-label">
                {isLatestPick ? t('update.latestVersion') : t('update.targetVersion')}
              </span>
              <span class={`update-version-val ${hasDisplayVersionDiff ? 'latest' : 'current'}`}>
                {isChecking ? '...' : displayTargetVersion}
              </span>
            </div>
          </div>

          {plan.inDesktopWindow && plan.desktopHost && (
            <div class="update-shell-meta">
              <span class="update-shell-meta-label">{t('update.shellVersionLabel')}:</span>
              <span class="update-shell-meta-val">
                {plan.desktopHost.shell_version
                  ? `v${plan.desktopHost.shell_version.replace(/^v/i, '')}`
                  : t('update.shellLegacyValue')}
                {(plan.desktopHost.shell_has_update || plan.desktopHost.legacy_shell) &&
                  plan.desktopHost.latest_shell_version && (
                    <span class="update-shell-meta-arrow">
                      {' ➔ '}v{plan.desktopHost.latest_shell_version.replace(/^v/i, '')}
                    </span>
                  )}
              </span>
            </div>
          )}

          {!updating && !isChecking && !checkError && plan.canPathA && plan.canPathB && (
            <div class="update-channel-section">
              <div class="update-channel-header">
                <span class="update-channel-label">{t('update.modeLabel')}:</span>
                <div class="update-channel-toggle-group">
                  <button
                    type="button"
                    class={`update-channel-btn ${effectiveMode === 'binary' ? 'active' : ''}`}
                    onClick={() => setModeOverride('binary')}
                  >
                    {t('update.modeBinary')}
                  </button>
                  <button
                    type="button"
                    class={`update-channel-btn ${effectiveMode === 'desktop' ? 'active' : ''}`}
                    onClick={() => setModeOverride('desktop')}
                  >
                    {t('update.modeDesktop')}
                  </button>
                </div>
              </div>
              <p class="update-channel-desc">
                {effectiveMode === 'desktop' ? t('update.modeDesktopDesc') : t('update.modeBinaryDesc')}
              </p>
            </div>
          )}

          {!isChecking && !checkError && (
            <>
              {plan.remoteReadonlyBlocked && (
                <div class="update-mode-notice warning">
                  {t('update.remoteReadonlyNotice')}
                </div>
              )}
              {plan.inDesktopWindow && plan.shellRequired && (
                <div class="update-mode-notice warning">
                  {t('update.shellRequiredNotice')}
                </div>
              )}
              {plan.inDesktopWindow && plan.legacyStep2Ready && (
                <div class="update-mode-notice info">
                  {t('update.legacyShellStep2Notice')}
                </div>
              )}
              {plan.inDesktopWindow && effectiveMode === 'desktop' && plan.pathBEngine === 'manual' && (
                <div class="update-mode-notice">
                  {t('update.manualPackageNotice')}
                </div>
              )}
            </>
          )}

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
                  <span>{t('update.failed', { error: checkError })}</span>
                </div>
              ) : !isLatestPick && targetVersion ? (
                <div class="update-status-row has-update">
                  <span>{t('update.dialogDescTarget', { version: targetVersion })}</span>
                </div>
              ) : hasUpdate ? (
                <div class="update-status-row has-update">
                  <span>{t('update.dialogDesc', { version: info?.latest_version || '' })}</span>
                </div>
              ) : plan.inDesktopWindow && (plan.desktopHost?.shell_has_update || plan.desktopHost?.legacy_shell) ? (
                <div class="update-status-row has-update">
                  <span>
                    {t('update.dialogDesc', {
                      version: plan.desktopHost?.latest_shell_version
                        ? `v${plan.desktopHost.latest_shell_version.replace(/^v/i, '')}`
                        : info?.latest_version || '',
                    })}
                  </span>
                </div>
              ) : forceReinstall ? (
                <div class="update-status-row has-update">
                  <span>{t('update.dialogDescForce', { version: info?.latest_version || '' })}</span>
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
                <span
                  class="update-progress-text"
                  // 原始诊断（URL / HTTP 状态）保留在悬浮提示里，正文只用本地化文案。
                  title={status?.status === 'error' ? status?.error || undefined : undefined}
                >
                  {status?.status === 'downloading'
                    ? isDesktopProgress
                      ? t('update.downloadingSetup', { percent: status?.progress ?? 0 })
                      : t('update.downloadingCli', { percent: status?.progress ?? 0 })
                    : status?.status === 'ready'
                      ? isDesktopProgress
                        ? t('update.readyDesktop')
                        : t('update.downloadingCli', { percent: 100 })
                      : status?.status === 'installing'
                        ? isDesktopProgress
                          ? t('update.installingSetup')
                          : t('update.downloadingCli', { percent: 100 })
                        : status?.status === 'done'
                          ? t('update.readyCli')
                          : status?.status === 'error'
                            ? (localizedUpdateError ??
                              t('update.failed', { error: status?.error || '' }))
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
          <label class="update-version-picker">
            <span class="update-version-picker-label">{t('update.historyLabel')}</span>
            <select
              class="update-version-select"
              aria-label={t('update.historyLabel')}
              value={targetVersion}
              disabled={updating || isChecking || versionOptions.length === 0}
              onChange={(e) => setSelectedVersion((e.target as HTMLSelectElement).value)}
            >
              {versionOptions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            class="update-notes-btn"
            disabled={updating || isChecking || !targetVersion}
            onClick={() => setNotesOpen(true)}
          >
            {t('update.notesBtn')}
          </button>
          <div class="update-footer-actions">
          {!updating ? (
            <>
              {canInstall ? (
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
                    {primaryActionLabel}
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
          ) : isDesktopProgress && (status?.status === 'ready' || installingDesktop) ? (
            <>
              <button
                type="button"
                class="btn btn-secondary"
                disabled={installingDesktop}
                onClick={onClose}
              >
                {t('update.btnCancel')}
              </button>
              <button
                type="button"
                class="btn btn-primary update-confirm-btn"
                disabled={installingDesktop}
                onClick={handleInstallDesktop}
              >
                {installingDesktop ? t('update.installingSetup') : t('update.btnRestartInstall')}
              </button>
            </>
          ) : status?.status === 'done' ? (
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => reloadAfterRestartRef.current()}
            >
              {t('update.btnDone')}
            </button>
          ) : (
            <button
              type="button"
              class={sawInstallProgress.current ? 'btn btn-primary' : 'btn btn-secondary'}
              disabled={!sawInstallProgress.current}
              onClick={() => reloadAfterRestartRef.current()}
              title={isDesktopProgress ? undefined : t('update.reloadNowTitle')}
            >
              {sawInstallProgress.current ? t('update.reloadNow') : (isDesktopProgress ? t('update.preparing') : t('update.installing'))}
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
    {notesOpen && (
      <div
        class="release-notes-overlay"
        {...notesBackdropDismiss}
      >
        <div
          class="release-notes-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="release-notes-title"
        >
          <div class="release-notes-accent" />
          <div class="release-notes-header">
            <div class="release-notes-heading">
              <span class="release-notes-kicker">{t('update.notesTitle')}</span>
              <h3 id="release-notes-title">{targetVersion}</h3>
              {notesReleasedAt && <time class="release-notes-time">{notesReleasedAt}</time>}
            </div>
            <div class="release-notes-header-actions">
              <button
                type="button"
                class="release-notes-copy"
                onClick={handleCopyNotes}
                disabled={!notesText}
              >
                {notesCopied === 'ok'
                  ? t('update.notesCopied')
                  : notesCopied === 'fail'
                    ? t('update.notesCopyFailed')
                    : t('update.notesCopy')}
              </button>
              <button
                type="button"
                class="ghost-btn modal-close"
                onClick={() => setNotesOpen(false)}
                aria-label={t('update.btnClose')}
              >
                ×
              </button>
            </div>
          </div>
          <div class="release-notes-body">
            {notesText && looksLikeHtml(notesText) ? (
              <div
                class="markdown-root assistant-message-content"
                dangerouslySetInnerHTML={{ __html: sanitizeNotesHtml(notesText) }}
              />
            ) : notesText ? (
              <Markdown content={notesText} />
            ) : (
              <p class="release-notes-empty">{t('update.notesEmpty')}</p>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
