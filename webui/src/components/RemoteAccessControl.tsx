// Temporary extra listener. The page you are on keeps its current host and
// port; Apply opens another bind (default 0.0.0.0:4096) for LAN access.

import { useEffect, useState } from 'preact/hooks';
import { getRemoteAccess, postRemoteAccess } from '../api';
import { useT } from '../settings';

export function RemoteAccessControl() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('0.0.0.0');
  const [port, setPort] = useState('4096');
  const [token, setToken] = useState('');
  const [noToken, setNoToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getRemoteAccess()
      .then((status) => {
        if (cancelled || !status.active) return;
        setHost(status.host || '0.0.0.0');
        setPort(String(status.port || 4096));
        setNoToken(!!status.no_token);
        if (status.token) setToken(status.token);
        setActive(true);
        if (status.url) setNote(status.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function apply(stop = false) {
    setBusy(true);
    setNote('');
    try {
      const status = await postRemoteAccess({
        host: host.trim() || '0.0.0.0',
        port: Number(port) || 4096,
        token: noToken ? '' : token,
        no_token: noToken,
        stop,
      });
      setActive(status.active);
      if (status.token) setToken(status.token);
      setNote(stop ? '' : status.url || t('remote.applied', { url: `${status.host}:${status.port}` }));
    } catch (err) {
      setNote(err instanceof Error ? err.message : t('remote.applyFailed'));
    } finally {
      setBusy(false);
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
          {note && <div class="remote-access-note">{note}</div>}
          <div class="remote-access-actions">
            <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void apply(false)}>
              {t('remote.apply')}
            </button>
            {active && (
              <button type="button" class="btn btn-secondary" disabled={busy} onClick={() => void apply(true)}>
                {t('remote.stop')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
