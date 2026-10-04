// Temporary extra listener. The page you are on keeps its current host and
// port; Apply opens another bind (default 0.0.0.0:4096) for LAN access.

import { useEffect, useRef, useState } from 'preact/hooks';
import { getRemoteAccess, postRemoteAccess, type RemoteAccessStatus } from '../api';
import { useT } from '../settings';

export function RemoteAccessControl() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('0.0.0.0');
  const [port, setPort] = useState('4096');
  const [token, setToken] = useState('');
  const [noToken, setNoToken] = useState(false);
  const [applying, setApplying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [note, setNote] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [listenHost, setListenHost] = useState('0.0.0.0');
  const [listenPort, setListenPort] = useState('4096');
  const [firewall, setFirewall] = useState('');
  const [copied, setCopied] = useState(false);
  const [active, setActive] = useState(false);
  const applyingRef = useRef(false);
  const stopAfterRef = useRef(false);
  const revision = useRef(0);

  function showStatus(status: RemoteAccessStatus, stopped = false) {
    setActive(status.active);
    setHost(status.host || '0.0.0.0');
    setPort(String(status.port || 4096));
    setNoToken(!!status.no_token);
    if (status.token) setToken(status.token);
    if (stopped || !status.active) {
      setLinks([]);
      setFirewall('');
      setNote('');
      return;
    }
    setListenHost(status.host || '0.0.0.0');
    setListenPort(String(status.port || 4096));
    const urls = (status.urls && status.urls.length > 0 ? status.urls : status.url ? [status.url] : [])
      .filter((item): item is string => !!item);
    setLinks(urls);
    setFirewall(status.firewall === 'prompt' ? status.firewall : '');
    setNote(urls.length === 0 ? t('remote.noLan', { port: String(status.port) }) : '');
  }

  useEffect(() => {
    if (!open) return;
    const seen = revision.current;
    let cancelled = false;
    getRemoteAccess()
      .then((status) => {
        if (cancelled || revision.current !== seen) return;
        if (!status.active) {
          setActive(false);
          setLinks([]);
          setFirewall('');
          return;
        }
        showStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function apply(stop = false) {
    revision.current += 1;
    const seen = revision.current;
    if (stop && applyingRef.current) {
      stopAfterRef.current = true;
      setStopping(true);
      return;
    }
    if (stop) setStopping(true);
    else {
      applyingRef.current = true;
      setApplying(true);
    }
    setCopied(false);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 12000);
    try {
      const status = await postRemoteAccess({
        host: host.trim() || '0.0.0.0',
        port: Number(port) || 4096,
        token: noToken ? '' : token,
        no_token: noToken,
        stop,
      }, ctrl.signal);
      showStatus(status, stop);
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const message = err instanceof Error && !aborted ? err.message : t('remote.applyFailed');
      try {
        const fresh = await getRemoteAccess();
        if (revision.current !== seen) return;
        if (fresh.active && aborted) {
          showStatus(fresh);
          return;
        }
        if (!fresh.active) {
          setActive(false);
          setLinks([]);
          setFirewall('');
        }
      } catch {
        if (revision.current !== seen) return;
      }
      if (revision.current !== seen) return;
      setNote(message);
    } finally {
      window.clearTimeout(timer);
      if (stop) setStopping(false);
      else {
        applyingRef.current = false;
        setApplying(false);
      }
      if (!stop && stopAfterRef.current) {
        stopAfterRef.current = false;
        void apply(true);
      }
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

  return (
    <div class="remote-access">
      <button
        type="button"
        class={'top-nav-btn' + (active ? ' remote-access-live' : '')}
        title={t('remote.bindTitle')}
        aria-label={t('remote.bindTitle')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </svg>
      </button>
      {open && (
        <div class="remote-access-panel" role="dialog" aria-label={t('remote.bindTitle')}>
          <div class="remote-access-title">{t('remote.bindTitle')}</div>
          <label class="remote-access-field">
            <span>{t('remote.host')}</span>
            <input
              value={host}
              onInput={(e) => setHost((e.target as HTMLInputElement).value)}
              spellcheck={false}
            />
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
            <div class="remote-access-note">{t('remote.bound', { host: listenHost, port: listenPort })}</div>
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
          <div class="remote-access-actions">
            {links.length > 0 && (
              <button type="button" class="btn btn-secondary" onClick={() => void copyLink()}>
                {copied ? t('remote.copied') : t('remote.copy')}
              </button>
            )}
            <button type="button" class="btn btn-primary" disabled={applying || stopping} onClick={() => void apply(false)}>
              {t('remote.apply')}
            </button>
            {active && (
              <button type="button" class="btn btn-secondary" disabled={stopping} onClick={() => void apply(true)}>
                {t('remote.stop')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
