/**
 * Composer keyboard contract.
 *
 * Enter keeps its historical meaning: send (desktop) / real newline (Shift or
 * touch keyboard). Ctrl+Enter (Cmd+Enter on macOS) is the explicit
 * "queue as a pending card and steer it" shortcut: the draft never leaves the
 * composer as a normal send, it becomes a queued card whose steer action is
 * triggered right away.
 *
 * The pending card's own action buttons form a roving-focus group: Left/Right
 * move between them, Enter activates the focused one (native button behavior).
 */

export type ComposerEnterAction = 'steer-card' | 'send' | 'newline' | 'ignore';

export interface ComposerEnterEvent {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** Touch keyboards emit a real newline; auto-send must never fire there. */
  mobile?: boolean;
}

/**
 * Decide what a composer Enter means.
 *
 * - Shift+Enter → newline (never intercepted)
 * - Ctrl/Cmd+Enter → 'steer-card' (works on touch keyboards too: the modifier
 *   is a deliberate act, unlike a bare Enter)
 * - Enter on a touch keyboard → newline
 * - Enter elsewhere → 'send'
 */
export function resolveComposerEnterAction(event: ComposerEnterEvent): ComposerEnterAction {
  if (event.key !== 'Enter') return 'ignore';
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return 'ignore';
  if (event.shiftKey) return 'newline';
  if (event.ctrlKey || event.metaKey) return 'steer-card';
  if (event.mobile) return 'newline';
  return 'send';
}

/** Arrow navigation inside the pending card's action group. */
export type QueuedCardArrowAction = 'prev' | 'next' | 'first' | 'last' | 'none';

export interface QueuedCardArrowEvent {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Map a keydown inside the card action group to a focus movement.
 * Modifier combinations stay native (browser zoom, devtools, ...).
 */
export function resolveQueuedCardArrowAction(
  event: QueuedCardArrowEvent,
): QueuedCardArrowAction {
  if (event.defaultPrevented || event.isComposing) return 'none';
  if (event.ctrlKey || event.metaKey || event.altKey) return 'none';
  if (event.key === 'ArrowLeft') return 'prev';
  if (event.key === 'ArrowRight') return 'next';
  if (event.key === 'Home') return 'first';
  if (event.key === 'End') return 'last';
  return 'none';
}

/**
 * Pick the next focused action.
 *
 * `enabled` lists the action keys that can take focus, in canonical order.
 * Movement wraps around so a keyboard user never gets stuck at an edge.
 */
export function nextActionIndex<T extends string>(
  current: T | null,
  enabled: T[],
  direction: 'prev' | 'next' | 'first' | 'last',
): T | null {
  if (enabled.length === 0) return null;
  if (direction === 'first') return enabled[0];
  if (direction === 'last') return enabled[enabled.length - 1];
  const position = current ? enabled.indexOf(current) : -1;
  if (position < 0) return direction === 'next' ? enabled[0] : enabled[enabled.length - 1];
  const offset = direction === 'next' ? 1 : -1;
  const next = (position + offset + enabled.length) % enabled.length;
  return enabled[next];
}

/**
 * Fallback when the focused action disappears (a steer turns the card into a
 * "steering" card and drops the steer button): keep the keyboard focus inside
 * the card by moving to the next action in canonical order.
 */
export function fallbackActionKey<T extends string>(
  missing: T | null,
  enabled: T[],
  order: readonly T[],
): T | null {
  if (enabled.length === 0) return null;
  if (missing) {
    const index = order.indexOf(missing);
    if (index >= 0) {
      for (let i = index + 1; i < order.length; i += 1) {
        if (enabled.includes(order[i])) return order[i];
      }
      for (let i = index - 1; i >= 0; i -= 1) {
        if (enabled.includes(order[i])) return order[i];
      }
    }
  }
  return enabled[0];
}

/**
 * True when a keydown on a focused action button should be handed back to the
 * composer: the user started typing again and must not lose the character.
 */
export function isComposerTypedKey(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key.length !== 1) return false;
  // Space is the native button activation; keep it.
  return event.key !== ' ';
}

export type ComposerEscapeAction = 'cancel-card' | 'stop-and-restore' | 'none';

/**
 * Esc inside the composer:
 * 0. If the user disabled ESC undo, do nothing (no card cancel, no stop/restore).
 * 1. If there is a pending card in the queue, cancel the tail card.
 * 2. If no card is in the queue and the session is running (playing), stop and restore the last message.
 * 3. Otherwise, do nothing.
 */
export function resolveComposerEscapeAction(input: {
  defaultPrevented?: boolean;
  pendingCardCount: number;
  busy?: boolean;
  /** User preference; omitted/true keeps the historical ESC undo behavior. */
  undoEnabled?: boolean;
}): ComposerEscapeAction {
  if (input.defaultPrevented) return 'none';
  if (input.undoEnabled === false) return 'none';
  if (input.pendingCardCount > 0) return 'cancel-card';
  if (input.busy) return 'stop-and-restore';
  return 'none';
}

/**
 * The card Esc acts on: the most recently queued one (queue tail).
 */
export function tailQueuedCard<T>(cards: T[]): T | null {
  return cards.length > 0 ? cards[cards.length - 1] : null;
}

/** True on touch-first viewports: the soft keyboard's Enter is a real newline. */
export function isMobileComposer(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= 768 || ('ontouchstart' in window && window.innerWidth <= 1024);
}
