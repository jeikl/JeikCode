// Generic confirmation modal. Replaces native window.confirm/alert/prompt so every
// confirmation shares the webui modal style (adaptive to light & dark themes).

import { createPortal } from 'preact/compat';
import { useEffect, useState, useRef } from 'preact/hooks';
import { useT } from '../settings';
import { useBackdropDismiss } from '../lib/backdropDismiss';

export interface ConfirmDialogProps {
  title: string;
  /** Already-translated body text. */
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Header glyph. Defaults to the trash icon. */
  icon?: string;
  /** Style the confirm button as destructive (red). Defaults to true. */
  danger?: boolean;
  /** When true, only show the confirm button (alert modal). */
  alertOnly?: boolean;
  /** Optional input field (replaces window.prompt). */
  input?: {
    defaultValue?: string;
    placeholder?: string;
    type?: string;
    autoFocus?: boolean;
  };
  /** Runs on confirm. Receives the optional input value. If it throws, the message
   *  is shown inline and the dialog stays open; on success the dialog closes. */
  onConfirm: (inputValue?: string) => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = true,
  alertOnly = false,
  input,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const t = useT();
  const effectiveConfirm = confirmLabel || t('common.confirm') || 'Confirm';
  const effectiveCancel = cancelLabel || t('common.cancel') || 'Cancel';
  const modalIcon = danger ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 2.2l6 10.8H2z" />
      <path d="M8 6v3.2" />
      <circle cx="8" cy="11.4" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4" />
      <circle cx="8" cy="4.9" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(input?.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const [selectedOption, setSelectedOption] = useState<'cancel' | 'confirm'>('confirm');

  // 遮罩空白处点击关闭：仅在「按下」与「松开」都落在遮罩本身时生效，避免拖拽划词误关。
  const backdropDismiss = useBackdropDismiss(() => {
    if (!busy) onClose();
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busy) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // 如果焦点在输入框中，左右键由文本框自行移动光标
      if (input && document.activeElement === inputRef.current) {
        return;
      }
      // 支持方向键左右切换选项
      if (!alertOnly) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setSelectedOption('cancel');
          cancelBtnRef.current?.focus();
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setSelectedOption('confirm');
          confirmBtnRef.current?.focus();
          return;
        }
      }
      // 回车确认当前选中的选项
      if (e.key === 'Enter') {
        if (
          document.activeElement === cancelBtnRef.current ||
          (!alertOnly && selectedOption === 'cancel' && document.activeElement !== confirmBtnRef.current)
        ) {
          e.preventDefault();
          onClose();
        } else {
          e.preventDefault();
          void handleConfirm();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose, alertOnly, selectedOption, input]);

  useEffect(() => {
    if (input) {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    } else {
      // 默认聚焦在确认按钮上，用户可直接回车确认或用方向键切换到取消
      confirmBtnRef.current?.focus();
    }
  }, [input]);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(input ? inputValue : undefined);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const overlay = (
    <div
      class="modal-overlay confirm-modal-overlay"
      {...backdropDismiss}
    >
      <div class="modal-card modal-card-sm" role="dialog" aria-modal="true">
        <div class="modal-header">
          <span class="confirm-modal-icon" aria-hidden="true">{modalIcon}</span>
          <h3>{title}</h3>
          <button class="ghost-btn modal-close" onClick={onClose} aria-label={cancelLabel}>
            ×
          </button>
        </div>
        <div class="modal-body">
          {body ? <p class="field-hint" style="margin: 0; line-height: 1.5;">{body}</p> : null}
          {input && (
            <div class="modal-input-wrap">
              <input
                ref={inputRef}
                type={input.type || 'text'}
                class="input modal-input"
                value={inputValue}
                placeholder={input.placeholder}
                onInput={(e) => setInputValue((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleConfirm();
                  }
                }}
                disabled={busy}
              />
            </div>
          )}
          {error && <div class="modal-error">{error}</div>}
        </div>
        <div class="modal-footer">
          {!alertOnly && (
            <button
              ref={cancelBtnRef}
              class={`btn btn-secondary ${selectedOption === 'cancel' ? 'modal-btn-selected' : ''}`}
              onClick={onClose}
              onFocus={() => setSelectedOption('cancel')}
              disabled={busy}
              style={selectedOption === 'cancel' ? { outline: '2px solid var(--app-primary, #3b82f6)', outlineOffset: '2px' } : undefined}
            >
              {effectiveCancel}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            class={`btn ${danger ? 'btn-danger' : 'btn-primary'} ${selectedOption === 'confirm' ? 'modal-btn-selected' : ''}`}
            onClick={handleConfirm}
            onFocus={() => setSelectedOption('confirm')}
            disabled={busy}
            style={selectedOption === 'confirm' ? { outline: '2px solid var(--app-primary, #3b82f6)', outlineOffset: '2px' } : undefined}
          >
            {effectiveConfirm}
          </button>
        </div>
      </div>
    </div>
  );

  // 挂到 body，避免被 SettingsModal（z-index: 99999）等已 portal 的窗口盖住。
  return typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay;
}

// ─────────────────────────────────────────────────────────────────────────────
// 全局命令式 Promise API (无侵入式替代 window.confirm / prompt / alert)
// ─────────────────────────────────────────────────────────────────────────────

type ModalHostState = {
  props: ConfirmDialogProps;
} | null;

let setGlobalModalState: ((state: ModalHostState) => void) | null = null;

export function ConfirmModalHost() {
  const [modal, setModal] = useState<ModalHostState>(null);

  useEffect(() => {
    setGlobalModalState = setModal;
    return () => {
      setGlobalModalState = null;
    };
  }, []);

  if (!modal) return null;
  return <ConfirmDialog {...modal.props} />;
}

export function modalConfirm(options: {
  title?: string;
  body: string;
  icon?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setGlobalModalState) {
      resolve(window.confirm(options.body));
      return;
    }
    setGlobalModalState({
      props: {
        title: options.title || '确认操作',
        body: options.body,
        icon: options.icon || (options.danger ? '⚠️' : '❓'),
        danger: options.danger ?? true,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        onConfirm: () => {
          resolve(true);
        },
        onClose: () => {
          resolve(false);
          setGlobalModalState?.(null);
        },
      },
    });
  });
}

export function modalPrompt(options: {
  title?: string;
  body?: string;
  defaultValue?: string;
  placeholder?: string;
  icon?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!setGlobalModalState) {
      resolve(window.prompt(options.body || options.title || '', options.defaultValue));
      return;
    }
    setGlobalModalState({
      props: {
        title: options.title || '',
        body: options.body || '',
        icon: options.icon || '✏️',
        danger: false,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        input: {
          defaultValue: options.defaultValue,
          placeholder: options.placeholder,
        },
        onConfirm: (val) => {
          resolve(val ?? '');
        },
        onClose: () => {
          resolve(null);
          setGlobalModalState?.(null);
        },
      },
    });
  });
}

export function modalAlert(options: {
  title?: string;
  body: string;
  icon?: string;
  confirmLabel?: string;
}): Promise<void> {
  return new Promise((resolve) => {
    if (!setGlobalModalState) {
      window.alert(options.body);
      resolve();
      return;
    }
    setGlobalModalState({
      props: {
        title: options.title || '提示',
        body: options.body,
        icon: options.icon || 'ℹ️',
        danger: false,
        alertOnly: true,
        confirmLabel: options.confirmLabel,
        onConfirm: () => {
          resolve();
        },
        onClose: () => {
          resolve();
          setGlobalModalState?.(null);
        },
      },
    });
  });
}
