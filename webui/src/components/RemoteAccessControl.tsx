// The desktop process already listens on 0.0.0.0. This panel shows that
// port and the startup token. A token edit on the same port applies now.
// A different port is saved for the next launch. "No token" is not saved.

import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getRemoteAccess, postRemoteAccess, type RemoteAccessStatus } from '../api';
import { useT } from '../settings';

export function RemoteAccessControl() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('0.0.0.0');
  const [port, setPort] = useState('13457');
  const [token, setToken] = useState('');
  const [noToken, setNoToken] = useState(false);
  const [applying, setApplying] = useState(false);
  const [note, setNote] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [listenHost, setListenHost] = useState('0.0.0.0');
  const [listenPort, setListenPort] = useState('13457');
  const [firewall, setFirewall] = useState('');
  const [copied, setCopied] = useState(false);
  const [active, setActive] = useState(false);
  const [savedPort, setSavedPort] = useState(0);
  const applyingRef = useRef(false);
  const revision = useRef(0);

  function showStatus(status: RemoteAccessStatus) {
    const livePort = String(status.port || 13457);
    const pending = status.next_port && status.next_port !== status.port ? status.next_port : 0;
    setActive(status.active);
    setHost(status.host || '0.0.0.0');
    setListenHost(status.host || '0.0.0.0');
    setListenPort(livePort);
    setNoToken(!!status.no_token);
    setSavedPort(pending);
    if (status.token) setToken(status.token);
    setPort(pending ? String(pending) : livePort);
    const urls = (status.urls && status.urls.length > 0 ? status.urls : status.url ? [status.url] : [])
      .filter((item): item is string => !!item);
    setLinks(status.active ? urls : []);
    setFirewall(status.firewall === 'prompt' ? status.firewall : '');
    const notes: string[] = [];
    if (pending) {
      notes.push(t('remote.portNext', { port: String(pending), listenPort: livePort }));
    }
    if (status.no_token) {
      notes.push(t('remote.noTokenSession'));
    } else if (!pending && status.active && urls.length === 0) {
      notes.push(t('remote.noLan', { port: livePort }));
    }
    setNote(notes.join(' '));
  }

  // Once, so the globe and the token are filled before the panel opens.
  useEffect(() => {
    const seen = revision.current;
    let cancelled = false;
    getRemoteAccess()
      .then((status) => {
        if (cancelled || revision.current !== seen) return;
        showStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const seen = revision.current;
    let cancelled = false;
    getRemoteAccess()
      .then((status) => {
        if (cancelled || revision.current !== seen) return;
        showStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function apply() {
    revision.current += 1;
    const seen = revision.current;
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setCopied(false);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 12000);
    try {
      const status = await postRemoteAccess({
        host: host.trim() || '0.0.0.0',
        port: Number(port) || 13457,
        token: noToken ? '' : token,
        no_token: noToken,
        apply_launch: true,
      }, ctrl.signal);
      showStatus(status);
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const message = err instanceof Error && !aborted ? err.message : t('remote.applyFailed');
      try {
        const fresh = await getRemoteAccess();
        if (revision.current !== seen) return;
        showStatus(fresh);
      } catch {
        if (revision.current !== seen) return;
      }
      if (revision.current !== seen) return;
      setNote(message);
    } finally {
      window.clearTimeout(timer);
      applyingRef.current = false;
      setApplying(false);
    }
  }

  async function copyLink() {
    const text = links[0];
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selection still works on the address text */
    }
  }

  const modalDialog = open && (
    <div
      class="modal-overlay remote-access-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('remote.bindTitle')}
    >
      <div class="modal-card remote-access-modal-card" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header remote-streamlined-header">
          <div class="modal-title-row">
            <span class="modal-title-icon">🌐</span>
            <span class="modal-title-text">{t('remote.bindTitle')}</span>
          </div>
          <button
            type="button"
            class="modal-close-btn"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="modal-body remote-access-modal-body">
          <label class="remote-access-field">
            <span>{t('remote.host')}</span>
            <input value={host} readOnly spellcheck={false} />
          </label>
          <label class="remote-access-field">
            <span>{t('remote.port')}</span>
            <input
              value={port}
              inputMode="numeric"
              onInput={(e) => setPort((e.target as HTMLInputElement).value.replace(/[^\d]/g, ''))}
            />
          </label>
          <label class="remote-access-field">
            <span>{t('remote.token')}</span>
            <input
              class={'remote-token-input' + (noToken ? ' is-blank' : '')}
              value={noToken ? '' : token}
              disabled={noToken}
              spellcheck={false}
              onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="remote-access-check">
            <input
              type="checkbox"
              checked={noToken}
              onChange={(e) => setNoToken((e.target as HTMLInputElement).checked)}
            />
            <span>{t('remote.noToken')}</span>
          </label>
          {active && (
            <div class="remote-access-note">
              {savedPort || noToken
                ? t('remote.listeningOn', { host: listenHost, port: listenPort })
                : t('remote.bound', { host: listenHost, port: listenPort })}
            </div>
          )}
          {links.length > 0 && (
            <>
              <div class="remote-access-note">{t('remote.listening')}</div>
              <ul class="remote-access-urls">
                {links.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {firewall === 'prompt' && <div class="remote-access-note">{t('remote.firewallPrompt')}</div>}
          {note && <div class="remote-access-note">{note}</div>}
        </div>

        <div class="modal-footer remote-access-actions">
          {links.length > 0 && (
            <button type="button" class="btn btn-secondary" onClick={() => void copyLink()}>
              {copied ? t('remote.copied') : t('remote.copy')}
            </button>
          )}
          <button type="button" class="btn btn-primary" disabled={applying} onClick={() => void apply()}>
            {t('remote.apply')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div class="remote-access">
      <button
        type="button"
        class={'top-nav-btn' + (active ? ' remote-access-live' : '')}
        title={active ? `${t('remote.bindTitle')} (${listenPort})` : t('remote.bindTitle')}
        aria-label={active ? `${t('remote.bindTitle')} (${listenPort})` : t('remote.bindTitle')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </svg>
        {listenPort && <span class="remote-access-port-text">{listenPort}</span>}
      </button>
      {modalDialog && (typeof document !== 'undefined' ? createPortal(modalDialog, document.body) : modalDialog)}
    </div>
  );
}
