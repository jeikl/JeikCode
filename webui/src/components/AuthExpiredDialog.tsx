// 认证失效遮罩：服务端已换 token，而本页保存的旧凭据被反复拒绝时的唯一出口。
//
// 历史实现是在 401 时 `location.reload()`，但旧 token 仍留在 storage 中，刷新后
// 继续 401，形成无限刷新。这里改成阻塞式重连：粘贴新的访问链接/token，先用
// /config 校验，成功才写入存储并整页重载。

import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../settings';
import { applyWebuiToken, isAuthExpired, onAuthExpiredChange } from '../api';
import { useBackdropDismiss } from '../lib/backdropDismiss';

export function AuthExpiredDialog() {
  const t = useT();
  const [expired, setExpired] = useState(isAuthExpired);
  const [dismissed, setDismissed] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      onAuthExpiredChange((next) => {
        setExpired(next);
        if (next) {
          // 新一轮失效必须重新露出遮罩，并清掉上一轮的错误与输入状态。
          setDismissed(false);
          setBusy(false);
          setError(null);
        }
      }),
    [],
  );

  useEffect(() => {
    if (expired && !dismissed) inputRef.current?.focus();
  }, [expired, dismissed]);

  const backdropDismiss = useBackdropDismiss(() => {
    if (!busy) setDismissed(true);
  });

  if (!expired || dismissed) return null;

  const submit = async () => {
    if (busy) return;
    const raw = value.trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      await applyWebuiToken(raw);
      // 新凭据已通过 /config 校验并落盘：整页重载让所有缓存视图与流重新握手。
      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message === 'invalid token' ? t('auth.invalidToken') : t('auth.verifyFailed'));
      setBusy(false);
    }
  };

  const modal = (
    <div class="modal-overlay confirm-modal-overlay" {...backdropDismiss}>
      <form
        class="modal-card modal-card-sm"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="modal-header">
          <h3>{t('auth.expiredTitle')}</h3>
        </div>
        <div class="modal-body">
          <p class="field-hint" style="margin: 0 0 10px; line-height: 1.5;">{t('auth.expiredBody')}</p>
          <div class="modal-input-wrap">
            <input
              ref={inputRef}
              type="text"
              class="input modal-input"
              value={value}
              placeholder={t('auth.tokenPlaceholder')}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              disabled={busy}
              autocomplete="off"
              spellcheck={false}
            />
          </div>
          {error && <div class="modal-error">{error}</div>}
        </div>
        <div class="modal-footer">
          <button
            type="button"
            class="btn btn-secondary"
            onClick={() => setDismissed(true)}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy || !value.trim()}>
            {busy ? t('auth.reconnecting') : t('auth.reconnect')}
          </button>
        </div>
      </form>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
