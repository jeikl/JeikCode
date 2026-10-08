/** Container-local sticky scrolling. Content growth is not user intent. */
export function createTimelineFollow(
  following: { current: boolean },
  showJump: (show: boolean) => void,
) {
  let element: HTMLElement | null = null;
  let frame: number | null = null;
  let disconnect: (() => void) | null = null;
  let lastTop = 0;
  let writtenTop: number | null = null;
  let touchY: number | null = null;
  let upwardIntentSuspended = false;
  let generation = 0;
  const nearBottom = () => !!element &&
    element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
  const pause = () => {
    upwardIntentSuspended = true;
    following.current = false;
    writtenTop = null;
    cancel();
    showJump(true);
  };
  const cancel = () => {
    generation++;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const write = () => {
    if (!element || !following.current) return;
    // Scroll delivery can lag behind RAF/ResizeObserver: inspect the visible
    // position before overwriting a scrollbar move that has not fired yet.
    scroll();
    if (!following.current) return;
    element.scrollTop = element.scrollHeight;
    writtenTop = element.scrollTop;
    lastTop = element.scrollTop;
  };
  const changed = () => {
    if (!element || !following.current || frame !== null) return;
    const ticket = generation;
    frame = requestAnimationFrame(() => {
      if (ticket !== generation) return;
      frame = null;
      write();
    });
  };
  const scroll = () => {
    if (!element) return;
    const top = element.scrollTop;
    // A queued event from our own write, or a layout-only event, must not
    // release follow when streaming has already increased scrollHeight.
    const ownWrite = writtenTop !== null && Math.abs(top - writtenTop) < 0.5;
    if (!ownWrite && top !== lastTop) {
      // Moving away is reading intent even inside the bottom 80px. Only a
      // subsequent downward movement into that zone may resume following.
      if (top < lastTop && element.scrollHeight - top - element.clientHeight > 0) {
        upwardIntentSuspended = true;
      } else if (top > lastTop && nearBottom()) {
        upwardIntentSuspended = false;
      }
      following.current = !upwardIntentSuspended && nearBottom();
      showJump(!following.current);
    }
    writtenTop = null;
    lastTop = top;
  };
  const canConsumeScroll = (target: EventTarget | null, deltaY: number) => {
    // Nested terminals/code panes consume their own wheel movement. Avoid DOM
    // constructors here so geometry-only tests and detached targets work too.
    let child = target as HTMLElement | null;
    while (child && child !== element) {
      if (child.scrollHeight > child.clientHeight &&
          (typeof getComputedStyle === 'undefined' ||
            /^(auto|scroll|overlay)$/.test(getComputedStyle(child).overflowY)) &&
          (deltaY < 0 ? child.scrollTop > 0 :
            child.scrollTop < child.scrollHeight - child.clientHeight)) return true;
      child = child.parentElement;
    }
    return false;
  };
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented || canConsumeScroll(event.target, event.deltaY)) return;
    writtenTop = null;
    // Only explicit upward intent suspends. Downward intent alone does not
    // resume: a subsequent downward position change must reach near-bottom.
    if (element && element.scrollTop > 0 && event.deltaY < 0) pause();
  };
  const pointer = () => { writtenTop = null; };
  const key = (event: KeyboardEvent) => {
    let target = event.target as HTMLElement | null;
    while (target && target !== element) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '') ||
          target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return;
      target = target.parentElement;
    }
    if (event.defaultPrevented) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)) {
      if (!canConsumeScroll(event.target, -1) && element && element.scrollTop > 0) pause();
    }
  };
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY ?? null;
    if (y !== null && touchY !== null && !event.defaultPrevented &&
        !canConsumeScroll(event.target, touchY - y) && y > touchY) pause();
    touchY = y;
  };
  const attach = (next: HTMLElement | null) => {
    if (element === next) return;
    cancel();
    disconnect?.();
    disconnect = null;
    element = next;
    writtenTop = null;
    lastTop = 0;
    touchY = null;
    upwardIntentSuspended = false;
    if (!next) return;
    lastTop = next.scrollTop;
    next.addEventListener('scroll', scroll);
    next.addEventListener('wheel', wheel, { passive: true });
    next.addEventListener('pointerdown', pointer, { passive: true });
    next.addEventListener('keydown', key);
    next.addEventListener('touchstart', touchStart, { passive: true });
    next.addEventListener('touchmove', touchMove, { passive: true });
    // Captured resource load covers late images even without ResizeObserver.
    next.addEventListener('load', changed, true);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(changed) : null;
    observer?.observe(next);
    observer?.observe(next.querySelector('.timeline-inner') ?? next);
    const mutations = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(changed) : null;
    mutations?.observe(next, { subtree: true, childList: true, characterData: true, attributes: true });
    disconnect = () => {
      observer?.disconnect();
      mutations?.disconnect();
      next.removeEventListener('scroll', scroll);
      next.removeEventListener('wheel', wheel);
      next.removeEventListener('pointerdown', pointer);
      next.removeEventListener('keydown', key);
      next.removeEventListener('touchstart', touchStart);
      next.removeEventListener('touchmove', touchMove);
      next.removeEventListener('load', changed, true);
    };
    changed();
  };
  const jump = () => {
    upwardIntentSuspended = false;
    following.current = true;
    showJump(false);
    // An explicit jump overrides any unreported reader movement.
    if (element) lastTop = element.scrollTop;
    writtenTop = null;
    write();
    changed();
  };
  return {
    attach, changed, jump, pause,
    // Reset intent once per session, not each late history response.
    reset() {
      cancel();
      writtenTop = null;
      if (element) lastTop = element.scrollTop;
      touchY = null;
      upwardIntentSuspended = false;
      following.current = true;
      showJump(false);
      changed();
    },
    dispose() { attach(null); cancel(); },
  };
}
