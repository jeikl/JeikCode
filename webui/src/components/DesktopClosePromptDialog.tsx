import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { postDesktopSettings } from '../api';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { useT } from '../settings';

export function DesktopClosePromptDialog() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);

  // 遮罩空白处点击关闭：避免弹窗内拖拽划词时被误判为外部点击而秒关。
  const backdropDismiss = useBackdropDismiss(() => setOpen(false));

  useEffect(() => {
    const handlePrompt = () => {
      setOpen(true);
    };
    window.addEventListener('jeikcode:desktop:close_prompt', handlePrompt);
    return () => {
      window.removeEventListener('jeikcode:desktop:close_prompt', handlePrompt);
    };
  }, []);

  async function handleAction(action: 'tray' | 'quit') {
    setOpen(false);
    if (action === 'tray') {
      if (remember) {
        // Persist BEFORE the native action so the daemon (single writer for the
        // merged settings document) has already committed `close_action`.
        try {
          await postDesktopSettings({ close_action: action });
        } catch {
          /* ignore */
        }
        try {
          window.open('http://tauri.localhost/__desktop_action/set_close_action?action=tray', '_blank');
        } catch {
          /* ignore */
        }
      }
      // 触发桌面壳隐藏到托盘（通过受控伪窗口跳转拦截与原生桥接双通道）
      window.dispatchEvent(new CustomEvent('jeikcode:desktop:hide_to_tray'));
      try {
        window.open('http://tauri.localhost/__desktop_action/hide_to_tray', '_blank');
      } catch {
        /* ignore */
      }
      try {
        const tauriWindow = (window as any).__TAURI__?.window?.getCurrentWindow?.();
        tauriWindow?.hide?.();
      } catch {
        /* ignore */
      }
    } else {
      if (remember) {
        try {
          await postDesktopSettings({ close_action: action });
        } catch {
          /* ignore */
        }
        try {
          window.open('http://tauri.localhost/__desktop_action/set_close_action?action=quit', '_blank');
        } catch {
          /* ignore */
        }
      }
      // 触发桌面壳安全退出程序
      window.dispatchEvent(new CustomEvent('jeikcode:desktop:quit_app'));
      try {
        window.open('http://tauri.localhost/__desktop_action/quit_app', '_blank');
      } catch {
        /* ignore */
      }
      try {
        const tauriApp = (window as any).__TAURI__?.process?.exit;
        tauriApp?.(0);
      } catch {
        /* ignore */
      }
      window.location.href = 'http://tauri.localhost/__desktop_action/quit_app';
    }
  }

  if (!open) return null;

  const modal = (
    <div
      class="modal-overlay desktop-close-prompt-overlay"
      {...backdropDismiss}
      role="dialog"
      aria-modal="true"
      style={{
        zIndex: 100001,
        background: 'var(--app-modal-background, rgba(0, 0, 0, 0.65))',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        class="modal-card modal-card-sm desktop-close-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 94vw)',
          padding: '24px',
          borderRadius: '16px',
          background: 'var(--app-menu-background, #181a20)',
          border: '1px solid var(--app-menu-border, rgba(255, 255, 255, 0.1))',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.55)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '18px' }}>
          <div
            style={{
              width: '52px',
              height: '52px',
              margin: '0 auto 12px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(16, 185, 129, 0.2))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
            }}
          >
            🖥️
          </div>
          <h3 style={{ margin: '0 0 8px', fontSize: '17px', fontWeight: 600 }}>
            {t('desktop.closePromptTitle') || '关闭 JeikCode'}
          </h3>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted, #9ca3af)', lineHeight: '1.6' }}>
            {t('desktop.closePromptDesc') || '是否最小化到系统托盘并保持后台运行？'}
          </p>
        </div>

        <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
            />
            <span>{t('desktop.rememberChoice') || '记住我的选择（可随时在系统设置中修改）'}</span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            class="btn btn-secondary"
            onClick={() => handleAction('quit')}
            style={{ flex: 1, padding: '9px 12px' }}
          >
            {t('desktop.actionQuit') || '退出程序'}
          </button>
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => handleAction('tray')}
            style={{
              flex: 1,
              padding: '9px 12px',
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)',
            }}
          >
            {t('desktop.actionTray') || '最小化到托盘'}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
