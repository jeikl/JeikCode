// The desktop process already listens on 0.0.0.0. This panel shows that
// port and the startup token. A token edit on the same port applies now.
// A different port is saved for the next launch. "No token" is not saved.

import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getRemoteAccess, getToken, postRemoteAccess, type RemoteAccessStatus } from '../api';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { useT } from '../settings';

export function RemoteAccessControl() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(
    typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '127.0.0.1'
  );
  const currentUrlPort = (typeof window !== 'undefined' && window.location.port) ? window.location.port : '13457';
  const [port, setPort] = useState(currentUrlPort);
  const [token, setToken] = useState('');
  const [noToken, setNoToken] = useState(false);
  const [applying, setApplying] = useState(false);
  const [note, setNote] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [listenHost, setListenHost] = useState('0.0.0.0');
  const [listenPort, setListenPort] = useState(currentUrlPort);
  const [firewall, setFirewall] = useState('');
  const [copied, setCopied] = useState(false);
  const [active, setActive] = useState(false);
  const [savedPort, setSavedPort] = useState(0);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const applyingRef = useRef(false);
  const revision = useRef(0);

  // 遮罩空白处点击关闭：仅在「按下」与「松开」都落在遮罩本身时生效，避免拖拽划词误关。
  const backdropDismiss = useBackdropDismiss(() => setOpen(false), { stopPropagation: true });
  const restartBackdropDismiss = useBackdropDismiss(() => {
    if (!restarting) setShowRestartModal(false);
  }, { stopPropagation: true });

  function showStatus(status: RemoteAccessStatus) {
    const livePort = String(status.port || ((typeof window !== 'undefined' && window.location.port) ? window.location.port : 13457));
    const pending = status.next_port && status.next_port !== status.port ? status.next_port : 0;
    setActive(status.active);
    const resolvedHost = (status.next_host && status.next_host.trim()) || status.host || '127.0.0.1';
    setHost(resolvedHost);
    setListenHost(status.host || '127.0.0.1');
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
    try {
      if (typeof window !== 'undefined' && window.location.search.includes('desktop=')) {
        sessionStorage.setItem('jeikcode_desktop', '1');
      }
    } catch {
      /* ignore */
    }
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
    if (!open && !showRestartModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showRestartModal && !restarting) {
          setShowRestartModal(false);
        } else if (open) {
          setOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, showRestartModal, restarting]);

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

  async function apply(shouldRestart: boolean = false): Promise<boolean> {
    revision.current += 1;
    const seen = revision.current;
    if (applyingRef.current) return false;
    applyingRef.current = true;
    setApplying(true);
    setCopied(false);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 12000);
    const targetHost = host.trim() || '127.0.0.1';
    try {
      const status = await postRemoteAccess({
        host: targetHost,
        port: Number(port) || 13457,
        token: noToken ? '' : token,
        no_token: noToken,
        apply_launch: true,
        restart: shouldRestart,
      }, ctrl.signal);
      showStatus(status);
      if (!shouldRestart) {
        setOpen(false);
      }
      return true;
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const message = err instanceof Error && !aborted ? err.message : t('remote.applyFailed');
      try {
        const fresh = await getRemoteAccess();
        if (revision.current !== seen) return false;
        showStatus(fresh);
      } catch {
        if (revision.current !== seen) return false;
      }
      if (revision.current !== seen) return false;
      setNote(message);
      return false;
    } finally {
      window.clearTimeout(timer);
      applyingRef.current = false;
      setApplying(false);
    }
  }

  function handleApplyClick() {
    const currentHost = listenHost;
    const currentPort = Number(listenPort) || 13457;
    const targetHost = host.trim() || '127.0.0.1';
    const targetPort = Number(port) || 13457;
    const hostChanged = targetHost.toLowerCase() !== currentHost.toLowerCase();
    const portChanged = targetPort !== currentPort;
    if (hostChanged || portChanged) {
      setShowRestartModal(true);
    } else {
      void apply(false);
    }
  }

  async function triggerImmediateRestart() {
    setRestarting(true);
    const targetPortNum = Number(port) || 13457;
    const livePortNum = Number(listenPort) || 0;
    const samePort = targetPortNum === livePortNum;
    const targetToken = noToken ? '' : token;

    // 1. 发起后端保存并安全重启；后端拒绝（例如非回环地址关闭 Token）时不再转圈
    const accepted = await apply(true);
    if (!accepted) {
      setRestarting(false);
      return;
    }

    // 2. 探活地址：端口不变时走同源 /health（兼容反向代理 / 域名 / 默认 80、443 端口）；
    //    换端口时保留浏览器当前访问的主机名（禁止重定向到 0.0.0.0），只替换端口。
    let probeHost = window.location.hostname || '127.0.0.1';
    if (probeHost === '0.0.0.0') probeHost = '127.0.0.1';
    const proto = window.location.protocol || 'http:';
    const hostPart = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
    const probeUrl = samePort ? '/health' : `${proto}//${hostPart}:${targetPortNum}/health`;

    // 跨端口即跨源，公网 IP / 域名访问时 CORS 会拦下普通 fetch；
    // no-cors 只关心「连得上」，服务起来后返回 opaque 响应，连不上则直接报错。
    const probeOnce = async (): Promise<boolean> => {
      try {
        const resp = await fetch(probeUrl, {
          signal: AbortSignal.timeout(1500),
          cache: 'no-store',
          mode: samePort ? 'same-origin' : 'no-cors',
        });
        return resp.ok || resp.type === 'opaque';
      } catch {
        return false;
      }
    };
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

    // 3. 同端口重启时先等旧进程下线（最多 5 秒），避免探到即将退出的旧实例就提前刷新
    await sleep(500);
    if (samePort) {
      const downDeadline = Date.now() + 5000;
      while (Date.now() < downDeadline && (await probeOnce())) {
        await sleep(300);
      }
    }

    // 4. 等新实例上线（最多 45 秒，覆盖 systemd RestartSec / procd respawn 的延迟）
    const upDeadline = Date.now() + 45000;
    while (Date.now() < upDeadline) {
      if (await probeOnce()) {
        let currentToken = targetToken;
        if (!currentToken && !noToken) {
          // 统一走 getToken()：URL → 共享 localStorage → sessionStorage，
          // 避免旧标签页里 per-tab 的过期 sessionStorage 覆盖轮换后的新 token。
          currentToken = getToken();
        }
        const nextUrl = new URL(window.location.href);
        if (!samePort) nextUrl.port = String(targetPortNum);
        if (currentToken) {
          // Token 可能已更换，始终用新值覆盖
          nextUrl.searchParams.set('token', currentToken);
        } else {
          nextUrl.searchParams.delete('token');
        }
        let isDesktop = window.location.search.includes('desktop=');
        if (!isDesktop) {
          try {
            isDesktop = sessionStorage.getItem('jeikcode_desktop') === '1';
          } catch {
            /* ignore */
          }
        }
        if (isDesktop) nextUrl.searchParams.set('desktop', '1');
        window.location.href = nextUrl.toString();
        return;
      }
      await sleep(600);
    }
    setRestarting(false);
    setNote(t('remote.connectTimeout'));
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
      {...backdropDismiss}
      role="dialog"
      aria-modal="true"
      aria-label={t('remote.bindTitle')}
    >
      <div
        class="modal-card remote-access-modal-card"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div class="modal-header remote-streamlined-header">
          <div class="modal-title-row">
            <span class="modal-title-icon">🌐</span>
            <span class="modal-title-text">{t('remote.bindTitle')}</span>
          </div>
          <button
            type="button"
            class="modal-close-btn"
            onClick={() => setOpen(false)}
            aria-label={t('common.dismiss')}
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
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                value={host}
                spellcheck={false}
                placeholder="127.0.0.1 / 0.0.0.0"
                onInput={(e) => setHost((e.target as HTMLInputElement).value.trim())}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                class="btn btn-secondary"
                style={{ padding: '4px 8px', fontSize: '12px', whiteSpace: 'nowrap' }}
                onClick={() => setHost(host === '0.0.0.0' ? '127.0.0.1' : '0.0.0.0')}
                title="127.0.0.1 / 0.0.0.0"
              >
                {host === '0.0.0.0' ? '127.0.0.1' : '0.0.0.0'}
              </button>
            </div>
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
          <button type="button" class="btn btn-primary" disabled={applying} onClick={handleApplyClick}>
            {t('remote.apply')}
          </button>
        </div>
      </div>
    </div>
  );

  const restartModalDialog = showRestartModal && (
    <div
      class="modal-overlay remote-access-restart-overlay"
      {...restartBackdropDismiss}
      role="dialog"
      aria-modal="true"
      style={{ zIndex: 10001 }}
    >
      <div
        class="modal-card remote-access-restart-card"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          maxWidth: '440px',
          padding: '24px',
          borderRadius: '16px',
          background: 'var(--bg-modal, rgba(28, 30, 36, 0.95))',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1)',
        }}
      >
        {!restarting && (
          <button
            type="button"
            class="btn btn-ghost modal-close"
            onClick={() => setShowRestartModal(false)}
            aria-label={t('settings.close') || 'Close'}
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              padding: '6px',
              borderRadius: '8px',
              color: 'var(--text-muted, #9ca3af)',
              cursor: 'pointer',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <div style={{ textAlign: 'center', marginBottom: '18px' }}>
          <div
            style={{
              width: '54px',
              height: '54px',
              margin: '0 auto 14px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(16, 185, 129, 0.2))',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(59, 130, 246, 0.25)',
            }}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent-color, #3b82f6)"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={restarting ? { animation: 'spin 1s linear infinite' } : {}}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </div>
          <h3 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: 600 }}>
            {t('remote.restartPromptTitle')}
          </h3>
          <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-muted, #9ca3af)', lineHeight: '1.5' }}>
            {t('remote.restartPromptDesc', {
              from: `${listenHost}:${listenPort}`,
              to: `${host.trim() || '127.0.0.1'}:${port.trim() || '13457'}`,
            })}
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            padding: '10px 14px',
            marginBottom: '20px',
            borderRadius: '10px',
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            fontSize: '13px',
            fontFamily: 'monospace',
          }}
        >
          <span style={{ color: 'var(--text-muted, #9ca3af)' }}>{listenHost}:{listenPort}</span>
          <span style={{ color: 'var(--accent-color, #3b82f6)' }}>➔</span>
          <span style={{ color: '#10b981', fontWeight: 600 }}>
            {host.trim() || '127.0.0.1'}:{port.trim() || '13457'}
          </span>
        </div>

        {restarting ? (
          <div style={{ textAlign: 'center', padding: '10px 0', color: 'var(--accent-color, #3b82f6)', fontSize: '14px', fontWeight: 500 }}>
            {t('remote.restarting')}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              class="btn btn-secondary"
              onClick={() => {
                setShowRestartModal(false);
                void apply(false);
              }}
              style={{ flex: 1, padding: '9px 12px' }}
            >
              {t('remote.restartLater')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              onClick={triggerImmediateRestart}
              style={{
                flex: 1,
                padding: '9px 12px',
                background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)',
              }}
            >
              {t('remote.restartNow')}
            </button>
          </div>
        )}
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
        <span class="remote-access-label">{t('remote.bindTitle')}</span>
      </button>
      {modalDialog && (typeof document !== 'undefined' ? createPortal(modalDialog, document.body) : modalDialog)}
      {restartModalDialog && (typeof document !== 'undefined' ? createPortal(restartModalDialog, document.body) : restartModalDialog)}
    </div>
  );
}
