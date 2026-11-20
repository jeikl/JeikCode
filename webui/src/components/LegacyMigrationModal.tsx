import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getLegacyStatus, postMigrateLegacy, type LegacyStatusResponse } from '../api';
import { useT } from '../settings';

export function LegacyMigrationModal() {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<LegacyStatusResponse | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [done, setDone] = useState(false);
  const [resultMsg, setResultMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 延迟 3.5 秒后异步检测老版本架构残留，避免与首屏加载争抢资源
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await getLegacyStatus();
        if (cancelled) return;
        if (res.needs_migration) {
          setStatus(res);
          setVisible(true);
        }
      } catch {
        /* ignore */
      }
    }, 3500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  async function handleStartMigrate() {
    if (migrating || done) return;
    setMigrating(true);
    setErrorMsg(null);
    try {
      const res = await postMigrateLegacy(true);
      setDone(true);
      setResultMsg(
        t('migration.successSummary', {
          files: String(res.cleaned_files_count),
          zombies: String(res.killed_zombies_count),
        }) || `已成功清理 ${res.cleaned_files_count} 个历史文件与 ${res.killed_zombies_count} 个残留进程`
      );
      // 成功后展示 2.5 秒，随后优雅关闭
      window.setTimeout(() => {
        setVisible(false);
      }, 2500);
    } catch (err: unknown) {
      const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
      setErrorMsg(`${t('migration.failed')}${detail}`);
    } finally {
      setMigrating(false);
    }
  }

  if (!visible || !status) return null;

  const modal = (
    <div
      class="modal-overlay legacy-migration-overlay"
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10002,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'modalFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div
        class="modal-card legacy-migration-card"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '520px',
          padding: '28px',
          borderRadius: '20px',
          background: 'var(--bg-modal, #181a20)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.6), 0 0 30px rgba(59, 130, 246, 0.2)',
          color: 'var(--text-color, #f3f4f6)',
        }}
      >
        {!migrating && (
          <button
            type="button"
            class="modal-close btn btn-ghost"
            onClick={() => setVisible(false)}
            aria-label={t('common.dismiss')}
            style={{ position: 'absolute', top: '16px', right: '16px' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div
            style={{
              width: '64px',
              height: '64px',
              margin: '0 auto 16px',
              borderRadius: '50%',
              background: done
                ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.25), rgba(5, 150, 105, 0.4))'
                : 'linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(16, 185, 129, 0.25))',
              border: `1px solid ${done ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: done
                ? '0 0 25px rgba(16, 185, 129, 0.35)'
                : '0 0 25px rgba(59, 130, 246, 0.35)',
            }}
          >
            {done ? (
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color, #3b82f6)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style={migrating ? { animation: 'spin 1s linear infinite' } : {}}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            )}
          </div>
          <h2 style={{ margin: '0 0 10px', fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em' }}>
            {done ? t('migration.titleDone') : t('migration.title')}
          </h2>
          <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-muted, #9ca3af)', lineHeight: '1.6' }}>
            {done ? resultMsg : t('migration.desc')}
          </p>
        </div>

        {!done && (
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '12px',
              padding: '16px',
              marginBottom: '24px',
              fontSize: '13px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <span style={{ color: '#10b981' }}>✓</span>
              <span>{t('migration.step1')}</span>
              {status.has_legacy_files && (
                <span style={{ marginLeft: 'auto', color: '#f59e0b', fontSize: '12px', background: 'rgba(245, 158, 11, 0.1)', padding: '2px 8px', borderRadius: '6px' }}>
                  {status.legacy_files.length} {t('migration.itemsPending')}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <span style={{ color: '#10b981' }}>✓</span>
              <span>{t('migration.step2')}</span>
              {status.has_dirty_path && (
                <span style={{ marginLeft: 'auto', color: '#f59e0b', fontSize: '12px', background: 'rgba(245, 158, 11, 0.1)', padding: '2px 8px', borderRadius: '6px' }}>
                  {t('migration.dirtyDetected')}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: status.zombie_count > 0 ? '#ef4444' : '#10b981' }}>
                {status.zombie_count > 0 ? '⚠' : '✓'}
              </span>
              <span>
                {t('migration.step3', { count: String(status.zombie_count) })}
              </span>
              {status.zombie_count > 0 && (
                <span style={{ marginLeft: 'auto', color: '#ef4444', fontSize: '12px', background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '6px' }}>
                  {status.zombie_count} {t('migration.zombiesPending')}
                </span>
              )}
            </div>
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            style={{
              marginBottom: '16px',
              padding: '10px 12px',
              borderRadius: '10px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              color: '#fca5a5',
              fontSize: '13px',
              lineHeight: '1.5',
            }}
          >
            {errorMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          {!done ? (
            <>
              <button
                type="button"
                class="btn"
                disabled={migrating}
                onClick={() => setVisible(false)}
                style={{ padding: '12px 16px', borderRadius: '10px', fontSize: '14px' }}
              >
                {t('common.dismiss')}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                disabled={migrating}
                onClick={handleStartMigrate}
                style={{
                  flex: 1,
                  padding: '12px',
                  fontSize: '14px',
                  fontWeight: 600,
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                  boxShadow: '0 4px 16px rgba(37, 99, 235, 0.4)',
                  cursor: migrating ? 'not-allowed' : 'pointer',
                }}
              >
                {migrating ? t('migration.running') : errorMsg ? t('common.retry') : t('migration.startBtn')}
              </button>
            </>
          ) : (
            <div style={{ color: '#10b981', fontWeight: 600, fontSize: '14px', padding: '6px 0' }}>
              ✓ {t('migration.completeNotice')}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
