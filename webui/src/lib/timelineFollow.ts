/**
 * Container-local sticky scrolling for the chat timeline.
 *
 * Contract (user intent is the only thing that changes the viewport):
 *   - `initial`   first entry / session reset: keep the latest output pinned
 *                 until the reader's first REAL gesture. Layout clamps that
 *                 happen while the cache is replaced by the live snapshot must
 *                 never release the follow.
 *   - `following` pinned to the bottom; content growth writes scrollTop.
 *   - `reading`   the reader owns the viewport; never write, never yank, even
 *                 when a turn settles. Only a gesture that lands exactly at the
 *                 bottom, or an explicit jump, re-pins.
 *   - `hidden`    the container has no layout box (`display:none` while a diff
 *                 tab is open). Geometry is meaningless there: a hidden
 *                 scrollable reports scrollTop 0 and fires a scroll event, so
 *                 treating it as reader intent used to kill follow forever.
 *
 * A scrollTop delta is NOT intent by itself: removing/merging rows makes the
 * browser clamp the position, which looks exactly like a small scroll-up.
 * Those are recognised by a shrinking scrollHeight and ignored.
 *
 * Layout transactions (`beginSwap` / `endSwap`) capture a reading anchor (the
 * nearest user turn at/above the viewport plus its offset) and restore it after
 * the commit, so turn-end settlement no longer lands the scrollbar anywhere.
 */
export type ScrollAnchor = {
  /** Stable turn-nav id of the anchor row (null when the canvas has none). */
  id: string | null;
  /** Anchor row's offset from the scroll container's top edge. */
  offset: number;
  /** Distance from the bottom at capture time, used as a fallback. */
  distanceFromBottom: number;
  /** Whether the viewport was pinned when the transaction started. */
  atBottom: boolean;
} | null;

type FollowState = 'initial' | 'following' | 'reading';

/** "Really at the bottom" for re-pinning (allows fractional zoom values). */
const BOTTOM_EPS = 4;
/** How long after a wheel/touch/key/pointer event a delta counts as a gesture. */
const GESTURE_WINDOW_MS = 400;

export function createTimelineFollow(
  following: { current: boolean },
  showJump: (show: boolean) => void,
) {
  let element: HTMLElement | null = null;
  let frame: number | null = null;
  let disconnect: (() => void) | null = null;
  let lastTop = 0;
  let lastHeight = 0;
  /** Scrollport height at the last observed scroll/write. */
  let lastClientHeight = 0;
  let writtenTop: number | null = null;
  let touchY: number | null = null;
  let state: FollowState = 'initial';
  let visible = true;
  let generation = 0;
  let gestureUntil = 0;
  let suppressWritesUntil = 0;
  let txDepth = 0;
  let txAnchor: ScrollAnchor = null;
  let anchorFrame: number | null = null;
  /** The next write snaps instead of gliding (mount / session reset / jump). */
  let snapNext = true;
  /** Writes inside this window always snap, even after the first one. */
  let snapUntil = 0;

  const now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  const reducedMotion = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasBox = () => !!element && element.clientHeight > 0;
  const bottomDistance = () =>
    !element ? Number.POSITIVE_INFINITY
      : element.scrollHeight - element.scrollTop - element.clientHeight;
  const atBottom = () => bottomDistance() <= BOTTOM_EPS;

  const cancel = () => {
    generation++;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  /** Reader owns the viewport from now on. Idempotent. */
  const release = () => {
    writtenTop = null;
    if (state === 'reading') {
      showJump(true);
      return;
    }
    state = 'reading';
    following.current = false;
    cancel();
    showJump(true);
  };

  const pin = () => {
    state = 'following';
    following.current = true;
    showJump(false);
  };

  const schedule = () => {
    if (!element || frame !== null) return;
    if (state === 'reading') return;
    if (now() < suppressWritesUntil) return;
    const ticket = generation;
    frame = requestAnimationFrame(() => {
      if (ticket !== generation) return;
      frame = null;
      write();
    });
  };

  const isReading = () => state === 'reading';

  /**
   * Follow the tail. A single content insertion larger than one viewport is
   * caught up over a few frames instead of whipping the reader a whole screen.
   * Explicit jumps pass `instant`.
   */
  const write = (instant = false) => {
    if (!element) return;
    if (!hasBox()) {
      visible = false;
      return;
    }
    if (isReading()) return;
    if (!instant && now() < suppressWritesUntil) return;
    const prevHeight = lastHeight;
    // Scroll delivery can lag behind RAF/ResizeObserver: inspect the visible
    // position before overwriting a scrollbar move that has not fired yet.
    if (!instant) scroll();
    if (isReading()) return;
    const height = element.scrollHeight;
    const viewport = element.clientHeight;
    const top = element.scrollTop;
    lastClientHeight = viewport;
    const target = Math.max(0, height - viewport);
    if (target - top <= 0.5) {
      lastTop = top;
      lastHeight = height;
      writtenTop = null;
      snapNext = false;
      return;
    }
    // A single insertion larger than one viewport is caught up over a few
    // frames; ordinary token growth still lands in one frame.
    const grew = prevHeight > 0 ? height - prevHeight : 0;
    const capped = !instant && !snapNext && now() >= snapUntil && grew > viewport;
    const step = capped ? Math.min(target - top, Math.max(viewport, 1)) : target - top;
    snapNext = false;
    element.scrollTop = top + step;
    writtenTop = element.scrollTop;
    lastTop = element.scrollTop;
    lastHeight = element.scrollHeight;
    lastClientHeight = element.clientHeight;
    if (!instant && element.scrollTop < element.scrollHeight - viewport - 0.5) schedule();
  };

  const changed = () => {
    if (!element) return;
    if (!hasBox()) {
      visible = false;
      return;
    }
    schedule();
  };

  /**
   * Classify a scroll delta. `shrank` means the browser clamped the position
   * because the transcript got shorter - a layout event, not a reader.
   */
  const scroll = () => {
    if (!element) return;
    if (!hasBox()) {
      visible = false;
      return;
    }
    if (!visible) {
      visible = true;
      lastTop = element.scrollTop;
      lastHeight = element.scrollHeight;
      lastClientHeight = element.clientHeight;
      writtenTop = null;
      return;
    }
    const top = element.scrollTop;
    const height = element.scrollHeight;
    const viewport = element.clientHeight;
    // A growing scrollport clamps a bottom-pinned scroll position *down*; the
    // resulting upward delta is layout, not a reader. (Keyboard close, panel
    // toggle, or a composer collapse that escaped the measurement pin.)
    const viewportGrew = viewport > lastClientHeight + 0.5;
    // A queued event from our own write, or fractional values under page zoom,
    // must not be mistaken for reader movement.
    const ownWrite = writtenTop !== null && Math.abs(top - writtenTop) < 1.5;
    if (!ownWrite && Math.abs(top - lastTop) >= 0.5) {
      const shrank = height < lastHeight - 0.5;
      const gesture = now() < gestureUntil;
      if (top < lastTop) {
        if (state === 'initial' && !gesture) {
          // First-entry hydration replaces the cache canvas; a clamp here is
          // not the reader leaving. Keep following the live snapshot.
        } else if (shrank && !gesture) {
          // Layout clamp (window resize, panel toggle, markdown reflow).
        } else if (viewportGrew && !gesture && atBottom()) {
          // Scrollport growth clamped the previous bottom to the new bottom:
          // the reader never moved relative to the tail.
        } else {
          release();
        }
      } else if (gesture && atBottom()) {
        // Only a real gesture that lands exactly at the bottom re-pins.
        pin();
      }
    }
    writtenTop = null;
    lastTop = top;
    lastHeight = height;
    lastClientHeight = viewport;
  };

  type Consume = 'none' | 'edge' | 'inside';
  const isScrollable = (node: HTMLElement) =>
    node.scrollHeight > node.clientHeight + 1 &&
    (typeof getComputedStyle === 'undefined' ||
      /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY));

  /**
   * Nested panes (tool output, terminal, reasoning) own the gesture while they
   * can still move in that direction. Reading inside one is reader intent, so
   * the outer follow is released; at the edge the movement hands off to the
   * timeline and the normal scroll delta decides.
   */
  const consumeScroll = (target: EventTarget | null, deltaY: number): Consume => {
    let child = target as HTMLElement | null;
    while (child && child !== element) {
      if (isScrollable(child)) {
        const edge = deltaY < 0
          ? child.scrollTop <= 0.5
          : child.scrollTop >= child.scrollHeight - child.clientHeight - 0.5;
        return edge ? 'edge' : 'inside';
      }
      child = child.parentElement;
    }
    return 'none';
  };

  const wheel = (event: WheelEvent) => {
    // Ctrl/Cmd + wheel is page zoom (see pageZoom.ts) or a trackpad pinch - it
    // is never reader intent.
    if (event.ctrlKey || event.metaKey) return;
    if (event.defaultPrevented) return;
    const consumed = consumeScroll(event.target, event.deltaY);
    gestureUntil = now() + GESTURE_WINDOW_MS;
    writtenTop = null;
    if (consumed === 'inside') {
      release();
      return;
    }
    if (consumed === 'edge') return;
    if (state === 'reading') return;
    // Only explicit upward intent suspends. Downward intent alone does not
    // resume: the position must actually reach the bottom afterwards.
    if (element && element.scrollTop > 0 && event.deltaY < 0) release();
  };

  const pointer = (event: PointerEvent) => {
    writtenTop = null;
    if (event.type === 'pointerdown' || (event.buttons ?? 0) > 0) {
      gestureUntil = now() + GESTURE_WINDOW_MS;
    }
  };

  const key = (event: KeyboardEvent) => {
    let target = event.target as HTMLElement | null;
    while (target && target !== element) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '') ||
          target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return;
      target = target.parentElement;
    }
    if (event.defaultPrevented || !element) return;

    if (event.key === 'Home') {
      if (consumeScroll(event.target, -1) !== 'none') return;
      event.preventDefault();
      release();
      gestureUntil = now() + GESTURE_WINDOW_MS;
      if (typeof element.scrollTo === 'function' && !reducedMotion()) {
        element.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        element.scrollTop = 0;
      }
      lastTop = 0;
      return;
    }

    if (event.key === 'End') {
      if (consumeScroll(event.target, 1) !== 'none') return;
      event.preventDefault();
      gestureUntil = now() + GESTURE_WINDOW_MS;
      jump({ smooth: !reducedMotion() });
      return;
    }

    if (['ArrowUp', 'PageUp'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)) {
      gestureUntil = now() + GESTURE_WINDOW_MS;
      if (consumeScroll(event.target, -1) === 'none' && element.scrollTop > 0) release();
    }
  };

  const touchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
    gestureUntil = now() + GESTURE_WINDOW_MS;
  };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY ?? null;
    if (y !== null && touchY !== null && !event.defaultPrevented) {
      gestureUntil = now() + GESTURE_WINDOW_MS;
      const consumed = consumeScroll(event.target, y > touchY ? -1 : 1);
      if (y > touchY) {
        if (consumed === 'inside') release();
        else if (consumed === 'none' && element && element.scrollTop > 0) release();
      }
    }
    touchY = y;
  };

  /** Capture what the reader is looking at; used around canvas replacements. */
  const captureAnchor = (): ScrollAnchor => {
    if (!element || !hasBox()) return null;
    const distance = bottomDistance();
    const anchor: Exclude<ScrollAnchor, null> = {
      id: null,
      offset: 0,
      distanceFromBottom: distance,
      atBottom: distance <= BOTTOM_EPS,
    };
    if (typeof element.getBoundingClientRect !== 'function' ||
        typeof element.querySelectorAll !== 'function') return anchor;
    const rootTop = element.getBoundingClientRect().top;
    const nodes = element.querySelectorAll<HTMLElement>('[data-turn-nav]');
    let above: HTMLElement | null = null;
    let below: HTMLElement | null = null;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      if (typeof node.getBoundingClientRect !== 'function') continue;
      if (node.getBoundingClientRect().top - rootTop <= 4) above = node;
      else { below = node; break; }
    }
    const row = above ?? below;
    if (row) {
      anchor.id = row.getAttribute('data-turn-nav');
      anchor.offset = row.getBoundingClientRect().top - rootTop;
    }
    return anchor;
  };

  const restoreAnchor = (target: ScrollAnchor) => {
    if (!target || !element || !hasBox()) return;
    if (state !== 'reading' && target.atBottom) {
      write(true);
      return;
    }
    let restored = false;
    if (target.id && typeof element.querySelector === 'function' &&
        typeof element.getBoundingClientRect === 'function') {
      const node = element.querySelector<HTMLElement>(`[data-turn-nav="${target.id}"]`);
      if (node) {
        const rootTop = element.getBoundingClientRect().top;
        const delta = node.getBoundingClientRect().top - rootTop - target.offset;
        if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
          element.scrollTop = Math.max(0, element.scrollTop + delta);
        }
        restored = true;
      }
    }
    if (!restored) {
      element.scrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight - target.distanceFromBottom,
      );
    }
    lastTop = element.scrollTop;
    lastHeight = element.scrollHeight;
    lastClientHeight = element.clientHeight;
    writtenTop = null;
  };

  const restoreAnchorSoon = (target: ScrollAnchor) => {
    if (!target) return;
    if (anchorFrame !== null) cancelAnimationFrame(anchorFrame);
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = null;
      restoreAnchor(target);
    });
  };

  const attach = (next: HTMLElement | null) => {
    if (element === next) return;
    cancel();
    if (anchorFrame !== null) cancelAnimationFrame(anchorFrame);
    anchorFrame = null;
    disconnect?.();
    disconnect = null;
    element = next;
    writtenTop = null;
    lastTop = 0;
    lastHeight = 0;
    touchY = null;
    gestureUntil = 0;
    suppressWritesUntil = 0;
    if (!next) {
      visible = false;
      return;
    }
    visible = next.clientHeight > 0;
    lastTop = next.scrollTop;
    lastHeight = next.scrollHeight;
    lastClientHeight = next.clientHeight;
    next.addEventListener('scroll', scroll);
    next.addEventListener('wheel', wheel, { passive: true });
    next.addEventListener('pointerdown', pointer, { passive: true });
    next.addEventListener('pointermove', pointer, { passive: true });
    next.addEventListener('keydown', key);
    next.addEventListener('touchstart', touchStart, { passive: true });
    next.addEventListener('touchmove', touchMove, { passive: true });
    // Captured resource load covers late images even without ResizeObserver.
    next.addEventListener('load', changed, true);

    const onWindowKey = (e: KeyboardEvent) => {
      if (!element || !hasBox()) return;
      const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
      if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName ?? '') ||
          active.isContentEditable || active.getAttribute?.('contenteditable') === 'true')) {
        return;
      }
      // Own Home/End only while the timeline itself (or the page body) holds
      // focus. A focused sidebar/panel/button keeps its native behaviour.
      if (active && active !== document.body && !element.contains(active)) return;
      key(e);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onWindowKey);
    }

    const onResize = () => {
      if (!element) return;
      if (element.clientHeight > 0) {
        if (!visible) {
          // `display:none` ends: Chrome restores the old scrollTop and fires a
          // scroll event. Rebase instead of reading it as reader movement.
          visible = true;
          lastTop = element.scrollTop;
          lastHeight = element.scrollHeight;
          writtenTop = null;
          if (state !== 'reading') changed();
          return;
        }
        changed();
      } else {
        visible = false;
      }
    };
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(onResize) : null;
    observer?.observe(next);
    observer?.observe(next.querySelector('.timeline-inner') ?? next);
    const mutations = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(changed) : null;
    // Attributes are intentionally excluded: class/aria churn does not change
    // height, and the whole transcript is observed.
    mutations?.observe(next, { subtree: true, childList: true, characterData: true });
    disconnect = () => {
      observer?.disconnect();
      mutations?.disconnect();
      next.removeEventListener('scroll', scroll);
      next.removeEventListener('wheel', wheel);
      next.removeEventListener('pointerdown', pointer);
      next.removeEventListener('pointermove', pointer);
      next.removeEventListener('keydown', key);
      next.removeEventListener('touchstart', touchStart);
      next.removeEventListener('touchmove', touchMove);
      next.removeEventListener('load', changed, true);
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onWindowKey);
      }
    };
    changed();
  };

  const jump = (opts?: { smooth?: boolean }) => {
    pin();
    cancel();
    if (!element) return;
    if (!hasBox()) {
      visible = false;
      return;
    }
    // An explicit jump overrides any unreported reader movement.
    lastTop = element.scrollTop;
    lastClientHeight = element.clientHeight;
    writtenTop = null;
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    const distance = target - element.scrollTop;
    if (opts?.smooth && distance > 0 && !reducedMotion() &&
        typeof element.scrollTo === 'function') {
      // Do not let content growth teleport over the animation. Smooth scrolling
      // loses the eye's anchor far less than an instant multi-screen jump.
      suppressWritesUntil = now() + 1200;
      element.scrollTo({ top: target, behavior: 'smooth' });
      const ticket = generation;
      let settled = false;
      const settle = () => {
        if (settled || ticket !== generation) return;
        settled = true;
        suppressWritesUntil = 0;
        if (!element) return;
        lastTop = element.scrollTop;
        lastHeight = element.scrollHeight;
        writtenTop = null;
        changed();
      };
      if (typeof element.addEventListener === 'function') {
        element.addEventListener('scrollend', settle, { once: true });
      }
      if (typeof window !== 'undefined') {
        window.setTimeout(settle, 1200);
      }
      return;
    }
    write(true);
    changed();
  };

  return {
    attach,
    changed,
    jump,
    /** Explicit release used by turn-nav / search jumps. */
    pause: release,
    /** Capture an anchor before replacing the canvas, restore after commit. */
    beginSwap() {
      if (txDepth === 0) txAnchor = captureAnchor();
      txDepth += 1;
    },
    endSwap() {
      if (txDepth === 0) return;
      txDepth -= 1;
      if (txDepth > 0) return;
      const anchor = txAnchor;
      txAnchor = null;
      restoreAnchorSoon(anchor);
    },
    captureAnchor,
    restoreAnchorSoon,
    isFollowing: () => state !== 'reading',
    // Reset intent once per session, not each late history response.
    reset() {
      cancel();
      suppressWritesUntil = 0;
      writtenTop = null;
      if (element) {
        lastTop = element.scrollTop;
        lastHeight = element.scrollHeight;
        lastClientHeight = element.clientHeight;
      }
      touchY = null;
      gestureUntil = 0;
      snapNext = true;
      snapUntil = now() + 300;
      state = 'initial';
      following.current = true;
      showJump(false);
      changed();
    },
    dispose() {
      attach(null);
      cancel();
      if (anchorFrame !== null) cancelAnimationFrame(anchorFrame);
      anchorFrame = null;
    },
  };
}
