// Pending-card action group.
//
// The card footer is a small roving-focus toolbar: Left/Right move between the
// actions, Enter activates the focused one (native button behavior), Escape
// hands the keyboard back to the composer. When the action set changes (a
// steer turns the card into a "steering" card and drops the steer button) the
// focus stays inside the card instead of falling back to <body>.

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  fallbackActionKey,
  isComposerTypedKey,
  nextActionIndex,
  resolveQueuedCardArrowAction,
} from '../lib/composerShortcuts';

export type QueuedCardKind = 'queue' | 'steer' | 'steering';

export interface QueuedCardActionsLabels {
  steer: string;
  sendNow: string;
  cancel: string;
  steerTitle: string;
  sendNowTitle: string;
  cancelTitle: string;
  /** Tooltip explaining the keyboard flow of the group. */
  groupTitle: string;
}

export interface QueuedCardActionsProps {
  /** Stable queue card identity; also used as the DOM hook for focus lookups. */
  cardId: number | string;
  kind: QueuedCardKind;
  labels: QueuedCardActionsLabels;
  /** Focus the first action when the card appears (composer-created cards). */
  autoFocus?: boolean;
  /** Called once the automatic focus has been applied. */
  onAutoFocusDone?: () => void;
  onSteer: () => void;
  onSendNow: () => void;
  onCancel: () => void;
  /**
   * Escape (no character) or a printable keystroke hands the keyboard back to
   * the composer. The character is forwarded so the typed text is not lost.
   */
  onReturnToComposer?: (typedChar?: string) => void;
  /** When false, ESC must not cancel/retract the card. Explicit buttons still work. */
  escapeUndoEnabled?: boolean;
}

const ACTION_ORDER = ['steer', 'sendNow', 'cancel'] as const;
type ActionKey = (typeof ACTION_ORDER)[number];

interface CardAction {
  key: ActionKey;
  label: string;
  title: string;
  className: string;
  icon: ComponentChildren;
  disabled?: boolean;
  onClick: () => void;
}

function SteerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 11.5V8.5a3.5 3.5 0 0 1 3.5-3.5H12" />
      <path d="M9.5 2.5 12.5 5 9.5 7.5" />
    </svg>
  );
}

function SendNowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function QueuedCardActions({
  cardId,
  kind,
  labels,
  autoFocus,
  onAutoFocusDone,
  onSteer,
  onSendNow,
  onCancel,
  onReturnToComposer,
  escapeUndoEnabled = true,
}: QueuedCardActionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Partial<Record<ActionKey, HTMLButtonElement | null>>>({});
  const [focusKey, setFocusKey] = useState<ActionKey | null>(null);
  const focusKeyRef = useRef<ActionKey | null>(null);
  focusKeyRef.current = focusKey;
  /** Last button that held the keyboard focus; used to detect a focus dropped
   *  by the browser when that button is removed from the DOM. */
  const focusedElementRef = useRef<HTMLElement | null>(null);

  const actions: CardAction[] = [];
  if (kind === 'queue') {
    actions.push({
      key: 'steer',
      label: labels.steer,
      title: labels.steerTitle,
      className: 'queued-btn-steer',
      icon: <SteerIcon />,
      onClick: onSteer,
    });
  }
  if (kind === 'queue' || kind === 'steering' || kind === 'steer') {
    actions.push({
      key: 'sendNow',
      label: labels.sendNow,
      title: labels.sendNowTitle,
      className: 'queued-btn-send-now',
      icon: <SendNowIcon />,
      onClick: onSendNow,
    });
  }
  actions.push({
    key: 'cancel',
    label: labels.cancel,
    title: labels.cancelTitle,
    className: 'queued-btn-cancel',
    icon: <CancelIcon />,
    disabled: false,
    onClick: onCancel,
  });

  // Action set fingerprint: changes whenever a button appears or disappears.
  const signature = actions.map((action) => `${action.key}:${action.disabled ? 'd' : 'e'}`).join('|');

  function enabledActionKeys(): ActionKey[] {
    const container = containerRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-action]'))
      .filter((button) => !button.disabled)
      .map((button) => button.getAttribute('data-action') as ActionKey);
  }

  // A freshly created card takes the keyboard focus so it can be driven with
  // the arrow keys right away.
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const first = containerRef.current?.querySelector<HTMLButtonElement>('button[data-action]:not(:disabled)');
    if (first) {
      setFocusKey(first.getAttribute('data-action') as ActionKey);
      first.focus();
    }
    onAutoFocusDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  // Keep the focus inside the card when the action set changes: the steer
  // button disappears once the steer is accepted, and the browser would drop
  // the focus to <body> — hand it to the next action instead.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = document.activeElement as HTMLElement | null;
    const focusInside = !!active && container.contains(active);
    const last = focusedElementRef.current;
    const focusDropped = !!last && !last.isConnected && (!active || active === document.body);
    if (!focusInside && !focusDropped) return;
    const enabled = enabledActionKeys();
    const current = focusKeyRef.current;
    if (current && enabled.includes(current)) {
      if (active !== buttonRefs.current[current]) {
        buttonRefs.current[current]?.focus();
      }
      return;
    }
    const next = fallbackActionKey(current, enabled, ACTION_ORDER);
    if (next) {
      setFocusKey(next);
      buttonRefs.current[next]?.focus();
    } else {
      container.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  function handleKeyDown(e: KeyboardEvent) {
    const action = resolveQueuedCardArrowAction(e);
    if (action !== 'none') {
      const next = nextActionIndex(focusKeyRef.current, enabledActionKeys(), action);
      if (!next) return;
      e.preventDefault();
      setFocusKey(next);
      buttonRefs.current[next]?.focus();
      return;
    }
    if (e.key === 'Escape') {
      // 用户关闭 ESC 撤销后：不拦截、不取消卡片，让事件继续冒泡（显式按钮仍可用）。
      if (!escapeUndoEnabled) return;
      // Esc 等同于按一次卡片上的最后一个动作（取消）：无论卡片是否已转向，
      // 都把这条待发消息收回输入框。
      e.preventDefault();
      const enabled = enabledActionKeys();
      const last = enabled.length > 0 ? enabled[enabled.length - 1] : null;
      if (last === 'cancel') {
        onCancel();
        return;
      }
      onReturnToComposer?.();
      return;
    }
    if (isComposerTypedKey(e)) {
      // The user started typing again: the composer takes the keystroke back.
      e.preventDefault();
      onReturnToComposer?.(e.key);
    }
  }

  return (
    <div
      ref={containerRef}
      class="queued-footer-actions"
      data-queued-card-actions={cardId}
      title={labels.groupTitle}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          ref={(element) => { buttonRefs.current[action.key] = element; }}
          type="button"
          class={`queued-action-btn ${action.className}`}
          data-action={action.key}
          onClick={action.onClick}
          onFocus={(e) => {
            focusedElementRef.current = e.currentTarget as HTMLElement;
            setFocusKey(action.key);
          }}
          disabled={action.disabled}
          title={action.title}
          aria-label={action.label}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
