import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import type { MsgKey } from '../i18n';
import { useSettings } from '../settings';
import {
  installTerminalCli,
  type TerminalCliEntry,
  type TerminalCliInstallResult,
  type TerminalCliStatus,
} from '../lib/terminalCli';

interface TerminalInstallDialogProps {
  status: TerminalCliStatus;
  onClose: () => void;
  onDone: () => void;
}

function IconTerminal() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function versionLabel(entry?: TerminalCliEntry | null): string {
  return entry?.version ? `v${entry.version}` : '—';
}

function sourceLabel(source?: string): MsgKey {
  switch (source) {
    case 'desktop':
      return 'settings.terminalCheck.sourceDesktop';
    case 'user':
      return 'settings.terminalCheck.sourceUser';
    case 'package_manager':
      return 'settings.terminalCheck.sourcePackage';
    case 'system':
      return 'settings.terminalCheck.sourceSystem';
    default:
      return 'settings.terminalCheck.sourceUnknown';
  }
}

export function TerminalInstallDialog({ status, onClose, onDone }: TerminalInstallDialogProps) {
  const { t } = useSettings();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TerminalCliInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pathOnlyRun, setPathOnlyRun] = useState(false);
  const [lastAction, setLastAction] = useState<{ replace: boolean; pathOnly: boolean } | null>(null);

  const state = status.state;
  const active = status.active ?? null;
  const target = status.target ?? null;
  const desktopVersion = status.desktop_cli.version ?? '';
  const displayEntry = active ?? target;
  const displayPath =
    displayEntry?.path ??
    (status.managed_by_installer ? status.desktop_cli.path : status.target_path);
  const displayVersion = displayEntry?.version ?? desktopVersion;
  const needsPath = !status.path_has_target;
  const targetExists = Boolean(target);
  const targetOwned = Boolean(target?.owned);
  const isExternalTarget = targetExists && !targetOwned;
  const activeIsTarget = status.active_is_target;

  const backdropDismiss = useBackdropDismiss(() => {
    if (!busy) onClose();
  });

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard may be unavailable; keep the UI quiet */
    }
  }

  async function runInstall(options: { replace: boolean; pathOnly: boolean }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPathOnlyRun(options.pathOnly);
    setLastAction(options);
    try {
      const res = await installTerminalCli({
        replace: options.replace,
        ensurePath: true,
        pathOnly: options.pathOnly,
      });
      if (!res.success) {
        setError(res.error || t('settings.terminalCheck.errorInstall'));
      } else {
        setResult(res);
        onDone();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function title() {
    if (result?.success) {
      return pathOnlyRun
        ? t('settings.terminalCheck.resultPathRepaired')
        : t('settings.terminalCheck.resultInstalled');
    }
    if (error) return t('settings.terminalCheck.promptErrorTitle');
    if (status.managed_by_installer && state !== 'owned_current') {
      return t('settings.terminalCheck.promptWindowsTitle');
    }
    switch (state) {
      case 'owned_outdated':
        return t('settings.terminalCheck.promptUpdateTitle');
      case 'owned_current':
        return t('settings.terminalCheck.promptCurrentTitle');
      case 'external':
      case 'external_newer':
        return t('settings.terminalCheck.promptExistingTitle');
      case 'package_managed':
        return t('settings.terminalCheck.promptManagedTitle');
      case 'path_missing':
        return t('settings.terminalCheck.promptPathTitle');
      case 'error':
        return t('settings.terminalCheck.promptErrorTitle');
      default:
        return t('settings.terminalCheck.promptInstallTitle');
    }
  }

  function lead() {
    if (result?.success) return t('settings.terminalCheck.commandHint');
    if (error) return t('settings.terminalCheck.promptErrorLead');
    if (status.managed_by_installer && state !== 'owned_current') {
      return t('settings.terminalCheck.promptWindowsLead');
    }
    switch (state) {
      case 'owned_outdated':
        return t('settings.terminalCheck.promptUpdateLead');
      case 'owned_current':
        return t('settings.terminalCheck.promptCurrentLead');
      case 'external':
        return t('settings.terminalCheck.promptExistingLead');
      case 'external_newer':
        return t('settings.terminalCheck.promptNewerLead');
      case 'package_managed':
        return t('settings.terminalCheck.promptManagedLead');
      case 'path_missing':
        return t('settings.terminalCheck.promptPathLead');
      case 'error':
        return t('settings.terminalCheck.promptErrorLead');
      default:
        return t('settings.terminalCheck.promptInstallLead');
    }
  }

  function notice() {
    if (result?.success || error) return null;
    if (status.managed_by_installer && state !== 'owned_current') {
      return (
        <div class="terminal-install-notice is-info">
          {t('settings.terminalCheck.noticeWindowsInstaller')}
        </div>
      );
    }
    if (!status.writable) {
      return (
        <div class="terminal-install-notice is-danger">
          {t('settings.terminalCheck.noticeNoWrite')}
        </div>
      );
    }
    if (state === 'external') {
      if (isExternalTarget) {
        return (
          <div class="terminal-install-notice is-warn">
            {t('settings.terminalCheck.noticeReplaceTarget')}
          </div>
        );
      }
      return (
        <div class="terminal-install-notice is-info">
          {t('settings.terminalCheck.noticeShadow')}
        </div>
      );
    }
    if (state === 'external_newer') {
      return (
        <div class="terminal-install-notice is-warn">
          {t('settings.terminalCheck.noticeNoDowngrade')}
        </div>
      );
    }
    if (state === 'package_managed') {
      return (
        <>
          <div class="terminal-install-notice is-info">
            {t('settings.terminalCheck.noticePackageManaged')}
          </div>
          <div class="terminal-install-notice is-info">
            {t('settings.terminalCheck.noticeShadow')}
          </div>
        </>
      );
    }
    if (state === 'owned_outdated') {
      return (
        <div class="terminal-install-notice is-info">
          {t('settings.terminalCheck.noticeBackup')}
        </div>
      );
    }
    if (state === 'path_missing' || (state === 'not_installed' && needsPath)) {
      return (
        <div class="terminal-install-notice is-info">
          {t('settings.terminalCheck.noticePathUpdate')}
        </div>
      );
    }
    return null;
  }

  function footer() {
    if (result?.success) {
      return (
        <div class="terminal-install-actions">
          <button
            type="button"
            class="btn btn-secondary"
            onClick={() => copyText(`jeikcode --version`)}
          >
            <IconCopy /> {copied ? t('settings.terminalCheck.copied') : t('settings.terminalCheck.actionCopyCommand')}
          </button>
          <button type="button" class="btn btn-primary" onClick={onClose}>
            {t('settings.terminalCheck.actionDone')}
          </button>
        </div>
      );
    }

    if (error) {
      return (
        <div class="terminal-install-actions">
          <button type="button" class="btn btn-secondary" onClick={onClose}>
            {t('settings.terminalCheck.actionDone')}
          </button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy}
            onClick={() => {
              if (lastAction) {
                void runInstall(lastAction);
              } else {
                onDone();
              }
            }}
          >
            <IconRefresh /> {t('settings.terminalCheck.actionRetry')}
          </button>
        </div>
      );
    }

    if (status.managed_by_installer) {
      return (
        <div class="terminal-install-actions">
          <button type="button" class="btn btn-secondary" onClick={() => copyText(displayPath)}>
            <IconCopy /> {t('settings.terminalCheck.actionCopyPath')}
          </button>
          <button type="button" class="btn btn-primary" onClick={onClose}>
            {t('settings.terminalCheck.actionDone')}
          </button>
        </div>
      );
    }

    switch (state) {
      case 'not_installed':
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-secondary" disabled={busy} onClick={onClose}>
              {t('settings.terminalCheck.actionNotNow')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || !status.writable}
              onClick={() => runInstall({ replace: false, pathOnly: false })}
            >
              {busy ? <span class="terminal-install-spinner" /> : <IconTerminal />}
              {t('settings.terminalCheck.actionInstall')}
            </button>
          </div>
        );
      case 'owned_outdated':
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-secondary" disabled={busy} onClick={onClose}>
              {t('settings.terminalCheck.actionKeep')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || !status.writable}
              onClick={() => runInstall({ replace: true, pathOnly: false })}
            >
              {busy ? <span class="terminal-install-spinner" /> : <IconRefresh />}
              {t('settings.terminalCheck.actionUpdate', { version: desktopVersion })}
            </button>
          </div>
        );
      case 'owned_current':
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-primary" onClick={onClose}>
              {t('settings.terminalCheck.actionDone')}
            </button>
          </div>
        );
      case 'external':
        if (status.can_replace) {
          return (
            <div class="terminal-install-actions">
              <button
                type="button"
                class="terminal-install-danger"
                disabled={busy || !status.writable}
                onClick={() => runInstall({ replace: true, pathOnly: false })}
              >
                {t('settings.terminalCheck.actionReplaceBackup')}
              </button>
              <button type="button" class="btn btn-secondary" disabled={busy} onClick={onClose}>
                {t('settings.terminalCheck.actionNotNow')}
              </button>
              <button type="button" class="btn btn-primary" disabled={busy} onClick={onClose}>
                {t('settings.terminalCheck.actionKeep')}
              </button>
            </div>
          );
        }
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-secondary" disabled={busy} onClick={onClose}>
              {t('settings.terminalCheck.actionKeep')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || !status.writable}
              onClick={() =>
                runInstall({ replace: targetExists, pathOnly: false })
              }
            >
              {busy ? <span class="terminal-install-spinner" /> : <IconTerminal />}
              {t('settings.terminalCheck.actionSwitch', { version: desktopVersion })}
            </button>
          </div>
        );
      case 'external_newer':
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-secondary" onClick={() => copyText(displayPath)}>
              <IconCopy /> {t('settings.terminalCheck.actionCopyPath')}
            </button>
            <button type="button" class="btn btn-primary" onClick={onClose}>
              {t('settings.terminalCheck.actionDone')}
            </button>
          </div>
        );
      case 'package_managed':
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-secondary" onClick={() => copyText(displayPath)}>
              <IconCopy /> {t('settings.terminalCheck.actionCopyPath')}
            </button>
            {status.can_switch && (
              <button
                type="button"
                class="terminal-install-danger"
                disabled={busy || !status.writable}
                onClick={() => runInstall({ replace: targetExists, pathOnly: false })}
              >
                {t('settings.terminalCheck.actionSwitch', { version: desktopVersion })}
              </button>
            )}
            <button type="button" class="btn btn-primary" onClick={onClose}>
              {t('settings.terminalCheck.actionDone')}
            </button>
          </div>
        );
      case 'path_missing':
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-secondary" disabled={busy} onClick={onClose}>
              {t('settings.terminalCheck.actionNotNow')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || !status.writable}
              onClick={() => runInstall({ replace: false, pathOnly: true })}
            >
              {busy ? <span class="terminal-install-spinner" /> : <IconRefresh />}
              {t('settings.terminalCheck.actionRepairPath')}
            </button>
          </div>
        );
      default:
        return (
          <div class="terminal-install-actions">
            <button type="button" class="btn btn-primary" onClick={onClose}>
              {t('settings.terminalCheck.actionDone')}
            </button>
          </div>
        );
    }
  }

  const headerIcon = result?.success ? <IconCheck /> : error ? <IconAlert /> : <IconTerminal />;

  const modal = (
    <div
      class="modal-overlay terminal-install-overlay"
      {...backdropDismiss}
      role="dialog"
      aria-modal="true"
      aria-labelledby="terminal-install-title"
    >
      <div class="modal-card terminal-install-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header terminal-install-head">
          <span class="terminal-install-head-icon" aria-hidden="true">{headerIcon}</span>
          <h3 id="terminal-install-title">{title()}</h3>
          <button
            type="button"
            class="modal-close btn btn-ghost"
            onClick={onClose}
            disabled={busy}
            aria-label={t('settings.terminalCheck.actionClose')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="terminal-install-body" aria-live="polite">
          <p class="terminal-install-lead">{lead()}</p>

          {result?.success ? (
            <>
              <div class="terminal-install-status">
                <div class="terminal-install-row">
                  <span class="terminal-install-label">{t('settings.terminalCheck.fieldPath')}</span>
                  <span class="terminal-install-value terminal-install-mono" dir="ltr">{result.path}</span>
                  <button type="button" class="terminal-install-copy" onClick={() => copyText(result.path)} aria-label={t('settings.terminalCheck.actionCopyPath')}>
                    <IconCopy />
                  </button>
                </div>
                <div class="terminal-install-row">
                  <span class="terminal-install-label">{t('settings.terminalCheck.fieldVersion')}</span>
                  <span class="terminal-install-value terminal-install-mono" dir="ltr">v{result.version || desktopVersion}</span>
                </div>
                <div class="terminal-install-row">
                  <span class="terminal-install-label">{t('settings.terminalCheck.pathState')}</span>
                  <span class="terminal-install-value terminal-install-mono" dir="ltr">
                    {result.path_added
                      ? t('settings.terminalCheck.pathAdded')
                      : result.path_already_present
                        ? t('settings.terminalCheck.pathIncluded')
                        : t('settings.terminalCheck.pathMissingShort')}
                  </span>
                </div>
              </div>
              <div class="terminal-install-command" dir="ltr">
                <span class="terminal-install-command-prompt">$</span> jeikcode --version
              </div>
            </>
          ) : (
            <>
              <div class="terminal-install-status">
                {state === 'not_installed' && !status.managed_by_installer ? (
                  <>
                    <div class="terminal-install-row">
                      <span class="terminal-install-label">{t('settings.terminalCheck.fieldPath')}</span>
                      <span class="terminal-install-value terminal-install-mono" dir="ltr">{status.target_path}</span>
                    </div>
                    <div class="terminal-install-row">
                      <span class="terminal-install-label">{t('settings.terminalCheck.fieldVersion')}</span>
                      <span class="terminal-install-value terminal-install-mono" dir="ltr">v{desktopVersion}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div class="terminal-install-row">
                      <span class="terminal-install-label">{t('settings.terminalCheck.engine')}</span>
                      <span class="terminal-install-value terminal-install-mono" dir="ltr">
                        v{desktopVersion} · {status.desktop_cli.path}
                      </span>
                    </div>
                    <div class="terminal-install-row">
                      <span class="terminal-install-label">{t('settings.terminalCheck.terminal')}</span>
                      <span class="terminal-install-value terminal-install-mono" dir="ltr">
                        {displayPath} · {versionLabel(displayEntry)}
                      </span>
                    </div>
                    {target && !activeIsTarget && (
                      <div class="terminal-install-row">
                        <span class="terminal-install-label">{t('settings.terminalCheck.fieldPath')}</span>
                        <span class="terminal-install-value terminal-install-mono" dir="ltr">
                          {target.path} · {versionLabel(target)}
                        </span>
                      </div>
                    )}
                    <div class="terminal-install-row">
                      <span class="terminal-install-label">{t('settings.terminalCheck.fieldSource')}</span>
                      <span class="terminal-install-value">{t(sourceLabel(displayEntry?.source))}</span>
                    </div>
                  </>
                )}
                <div class="terminal-install-row">
                  <span class="terminal-install-label">{t('settings.terminalCheck.pathState')}</span>
                  <span class="terminal-install-value">
                    {status.active_on_path || status.path_has_target
                      ? t('settings.terminalCheck.pathIncluded')
                      : t('settings.terminalCheck.pathMissingShort')}
                  </span>
                </div>
                {(!status.managed_by_installer || status.rc_files.length > 0) && (
                  <div class="terminal-install-row">
                    <span class="terminal-install-label">{t('settings.terminalCheck.fieldShell')}</span>
                    <span class="terminal-install-value terminal-install-mono" dir="ltr">
                      {status.shell}{status.rc_files[0] ? ` · ${status.rc_files[0]}` : ''}
                    </span>
                  </div>
                )}
              </div>

              {needsPath &&
                (state === 'owned_outdated' || state === 'external') && (
                  <div class="terminal-install-notice is-info">
                    {t('settings.terminalCheck.noticePathUpdate')}
                  </div>
                )}

              {notice()}
              {error && <div class="terminal-install-notice is-danger">{error}</div>}
            </>
          )}
        </div>

        <div class="terminal-install-footer">{footer()}</div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
