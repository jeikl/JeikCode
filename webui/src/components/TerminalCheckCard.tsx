import { useCallback, useEffect, useState } from 'preact/hooks';
import { useSettings } from '../settings';
import {
  getTerminalCliStatus,
  hasTerminalCliIpc,
  type TerminalCliState,
  type TerminalCliStatus,
} from '../lib/terminalCli';
import { TerminalInstallDialog } from './TerminalInstallDialog';

function IconTerminal({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function IconRefresh({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function IconCopy({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function dotClass(state: string): string {
  switch (state) {
    case 'owned_current':
      return 'is-ok';
    case 'owned_outdated':
    case 'external_newer':
    case 'path_missing':
      return 'is-warn';
    case 'error':
      return 'is-danger';
    case 'external':
    case 'package_managed':
      return 'is-neutral';
    default:
      return 'is-muted';
  }
}

export function TerminalCheckCard() {
  const { t } = useSettings();
  const [status, setStatus] = useState<TerminalCliStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);

  const available = typeof window !== 'undefined' && hasTerminalCliIpc();

  const refresh = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    setError(null);
    try {
      const next = await getTerminalCliStatus();
      setStatus(next);
      setLastChecked(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    if (!available) return;
    void refresh();
  }, [available, refresh]);

  if (!available) return null;

  const state: TerminalCliState | string = status?.state ?? 'error';
  const stateLabel = (() => {
    switch (state) {
      case 'not_installed':
        return t('settings.terminalCheck.notInstalled');
      case 'owned_current':
        return t('settings.terminalCheck.ownedCurrent');
      case 'owned_outdated':
        return t('settings.terminalCheck.ownedOutdated');
      case 'external':
        return t('settings.terminalCheck.external');
      case 'external_newer':
        return t('settings.terminalCheck.externalNewer');
      case 'package_managed':
        return t('settings.terminalCheck.packageManaged');
      case 'path_missing':
        return t('settings.terminalCheck.pathMissing');
      default:
        return t('settings.terminalCheck.detectionError');
    }
  })();

  const active = status?.active ?? null;
  const target = status?.target ?? null;
  const primaryEntry = active ?? target;
  const primaryPath =
    primaryEntry?.path ??
    (status?.managed_by_installer ? status.desktop_cli.path : status?.target_path) ??
    '';
  const primaryVersion = primaryEntry?.version ?? status?.desktop_cli.version ?? '';
  const desktopVersion = status?.desktop_cli.version ?? '';

  async function copyPath() {
    if (!primaryPath) return;
    try {
      await navigator.clipboard.writeText(primaryPath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }

  const primaryAction = () => {
    if (!status) return null;
    if (state === 'error') {
      return (
        <button type="button" class="btn btn-secondary" onClick={() => void refresh()} disabled={loading}>
          <IconRefresh /> {t('settings.terminalCheck.actionRetry')}
        </button>
      );
    }
    if (status.managed_by_installer && state !== 'owned_current') {
      return (
        <button type="button" class="btn btn-secondary" onClick={() => setDialogOpen(true)}>
          <IconTerminal /> {t('settings.terminalCheck.actionViewDetails')}
        </button>
      );
    }
    if (state === 'owned_current') {
      return (
        <button type="button" class="btn btn-secondary" onClick={() => void copyPath()}>
          <IconCopy /> {copied ? t('settings.terminalCheck.copied') : t('settings.terminalCheck.actionCopyPath')}
        </button>
      );
    }
    const label =
      state === 'not_installed'
        ? t('settings.terminalCheck.actionInstall')
        : state === 'owned_outdated'
          ? t('settings.terminalCheck.actionUpdate', { version: desktopVersion })
          : state === 'path_missing'
            ? t('settings.terminalCheck.actionRepairPath')
            : t('settings.terminalCheck.actionViewDetails');
    return (
      <button type="button" class="btn btn-primary" onClick={() => setDialogOpen(true)}>
        <IconTerminal /> {label}
      </button>
    );
  };

  const relativeTime = lastChecked
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(lastChecked)
    : '';

  return (
    <div class="system-settings-card-box terminal-check-card" aria-busy={loading}>
      <div class="terminal-check-head">
        <div class="terminal-check-title">
          <span class="terminal-check-title-icon" aria-hidden="true"><IconTerminal size={17} /></span>
          <span>{t('settings.terminalCheck.title')}</span>
        </div>
        <button
          type="button"
          class="btn btn-secondary terminal-check-refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <span class="terminal-install-spinner" /> : <IconRefresh />}
          {loading ? t('settings.terminalCheck.detecting') : t('settings.terminalCheck.detect')}
        </button>
      </div>
      <div class="system-settings-box-desc">{t('settings.terminalCheck.desc')}</div>

      {error && (
        <div class="terminal-install-notice is-danger terminal-check-error">{error}</div>
      )}

      {!status && loading && (
        <div class="terminal-check-skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
      )}

      {status && (
        <>
          <div class="terminal-check-state" role="status">
            <span class={`terminal-check-dot ${dotClass(state)}`} aria-hidden="true" />
            <span class="terminal-check-state-label">{stateLabel}</span>
            <span class="terminal-check-version" dir="ltr">
              {primaryVersion ? `v${primaryVersion}` : ''}
            </span>
          </div>

          <div class="terminal-check-path-row">
            <code class="terminal-check-path" dir="ltr">{primaryPath || '—'}</code>
            <button
              type="button"
              class="terminal-check-copy"
              onClick={() => void copyPath()}
              aria-label={t('settings.terminalCheck.actionCopyPath')}
              title={copied ? t('settings.terminalCheck.copied') : t('settings.terminalCheck.actionCopyPath')}
            >
              <IconCopy />
            </button>
          </div>

          <div class="terminal-check-meta">
            <span class="terminal-check-meta-label">{t('settings.terminalCheck.engine')}</span>
            <span class="terminal-check-meta-value" dir="ltr">
              v{desktopVersion}
              <span class="terminal-check-meta-hint"> · {t('settings.terminalCheck.engineHint')}</span>
            </span>
            <span class="terminal-check-meta-label">{t('settings.terminalCheck.terminal')}</span>
            <span class="terminal-check-meta-value" dir="ltr">
              {active ? `${active.path} · v${active.version ?? '—'}` : t('settings.terminalCheck.notInstalled')}
            </span>
            <span class="terminal-check-meta-label">{t('settings.terminalCheck.pathState')}</span>
            <span class="terminal-check-meta-value">
              {status.active_on_path || status.path_has_target
                ? t('settings.terminalCheck.pathIncluded')
                : t('settings.terminalCheck.pathMissingShort')}
            </span>
          </div>

          {status.managed_by_installer && (
            <div class="terminal-install-notice is-info terminal-check-note">
              {t('settings.terminalCheck.noticeWindowsInstaller')}
            </div>
          )}

          <div class="terminal-check-actions">
            {primaryAction()}
            {relativeTime && (
              <span class="terminal-check-last">
                {t('settings.terminalCheck.lastChecked', { time: relativeTime })}
              </span>
            )}
          </div>
        </>
      )}

      {dialogOpen && status && (
        <TerminalInstallDialog
          status={status}
          onClose={() => setDialogOpen(false)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}
