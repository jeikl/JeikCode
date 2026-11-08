/**
 * Composer auto-height measurement that never disturbs the transcript viewport.
 *
 * The usual `height:auto` → `scrollHeight` dance transiently collapses the
 * textarea. Because the composer is a flex sibling of the message timeline, the
 * timeline's scrollport grows during that measurement; the browser clamps the
 * current `scrollTop` to the new (smaller) maximum, and when the textarea is
 * restored the clamp stays. The final container height matches the pre-measure
 * height, so no ResizeObserver tick arrives and the bottom-follow is silently
 * left a composer-height above the tail. The clamp also emits a scroll event
 * that looks exactly like a reader scrolling up.
 *
 * Pinning the timeline to its current box for the synchronous measure removes
 * the clamp at the source: the scrollport never grows, so `scrollTop` is never
 * rewritten. The pin is restored in `finally` so an exception in the
 * measurement can never leave the layout frozen.
 */

/** Default maximum rendered composer height (px). */
export const COMPOSER_MAX_HEIGHT = 160;

export interface ComposerScrollerLike {
  clientHeight: number;
  style: { flex: string; height: string };
}

export interface ComposerTextareaLike {
  style: { height: string };
  scrollHeight: number;
}

/**
 * Run `mutate` while the timeline keeps its current height. The caller restores
 * the exact box afterwards; only synchronous layout work belongs here.
 */
export function withPinnedTimelineViewport<T>(
  scroller: ComposerScrollerLike | null,
  mutate: () => T,
): T {
  const viewport = scroller && scroller.clientHeight > 0 ? scroller.clientHeight : 0;
  if (!scroller || viewport === 0) return mutate();
  const prevFlex = scroller.style.flex;
  const prevHeight = scroller.style.height;
  // `flex: 1 1 0%` wins over an inline height in a column flex container, so
  // both the flex basis and the box height must be frozen together.
  scroller.style.flex = '0 0 auto';
  scroller.style.height = `${viewport}px`;
  try {
    return mutate();
  } finally {
    scroller.style.flex = prevFlex;
    scroller.style.height = prevHeight;
  }
}

/**
 * Resize the composer textarea to its content height (capped at `maxHeight`)
 * without letting the surrounding timeline scrollport change mid-measure.
 */
export function resizeComposerTextarea(
  textarea: ComposerTextareaLike | null,
  scroller: ComposerScrollerLike | null,
  maxHeight = COMPOSER_MAX_HEIGHT,
): void {
  if (!textarea) return;
  withPinnedTimelineViewport(scroller, () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  });
}

/**
 * Collapse the composer back to its intrinsic one-line height without clamping
 * the timeline (used when a draft is cleared after sending).
 */
export function collapseComposerTextarea(
  textarea: ComposerTextareaLike | null,
  scroller: ComposerScrollerLike | null,
): void {
  if (!textarea) return;
  withPinnedTimelineViewport(scroller, () => {
    textarea.style.height = 'auto';
  });
}
