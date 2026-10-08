import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineFollow } from './timelineFollow.ts';

// Geometry and browser scheduling are explicit: growth does not automatically
// move scrollTop, and observer/scroll delivery can occur in either order.
function setup(resize = true) {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const observers: Array<{ callback: () => void; disconnected: boolean }> = [];
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  class Observer {
    disconnected = false;
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: resize ? Observer : undefined });
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, writable: true, value: Observer });
  class Container extends EventTarget {
    scrollHeight = 1000;
    clientHeight = 200;
    top = 0;
    writes = 0;
    get scrollTop() { return this.top; }
    set scrollTop(value: number) {
      this.writes++;
      this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    }
    querySelector() { return this; }
    emit(type: string, props = {}) {
      this.dispatchEvent(Object.assign(new Event(type), props));
    }
  }
  const element = new Container();
  const following = { current: true };
  let jump = false;
  const follow = createTimelineFollow(following, (show) => { jump = show; });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return {
    element, following, follow, frames, observers, flush,
    get jump() { return jump; },
    attach() { follow.attach(element as unknown as HTMLElement); },
    cleanup() {
      follow.dispose();
      for (const name of ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver']) {
        if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('empty landing to history mounts at bottom; streaming updates coalesce', () => {
  const s = setup();
  try {
    s.follow.changed();
    assert.equal(s.frames.size, 0);
    s.attach(); s.flush();
    assert.equal(s.element.scrollTop, 800);
    s.element.scrollHeight = 1200;
    s.follow.changed(); s.follow.changed();
    assert.equal(s.frames.size, 1);
    s.flush();
    assert.equal(s.element.scrollTop, 1000);
    assert.equal(s.element.writes, 2);
  } finally { s.cleanup(); }
});

test('wheel away cancels initial follow and delayed resize; jump resumes', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.emit('wheel', { deltaY: -100 });
    s.element.top = 300; s.element.emit('scroll');
    s.element.scrollHeight = 1600;
    for (const observer of s.observers) observer.callback();
    s.follow.changed(); s.flush();
    assert.equal(s.element.scrollTop, 300);
    assert.equal(s.jump, true);
    s.follow.jump(); s.flush();
    assert.equal(s.element.scrollTop, 1400);
    assert.equal(s.jump, false);
    s.element.scrollHeight = 1900;
    s.observers[0].callback(); s.flush();
    assert.equal(s.element.scrollTop, 1700);
  } finally { s.cleanup(); }
});

test('programmatic scroll events after content growth do not pause follow', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.scrollHeight = 1500;
    s.element.emit('scroll');
    assert.equal(s.following.current, true);
    s.observers[0].callback(); s.flush();
    assert.equal(s.element.scrollTop, 1300);
    // A subsequent layout-only event is also not reader intent.
    s.element.emit('scroll');
    s.element.scrollHeight = 1800; s.element.emit('scroll');
    assert.equal(s.following.current, true);
  } finally { s.cleanup(); }
});

test('manual scrollbar and touch release follow; manual bottom resumes', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.top = 250; s.element.emit('scroll');
    assert.equal(s.following.current, false);
    s.element.top = 780; s.element.emit('scroll');
    assert.equal(s.following.current, true);
    s.element.emit('touchstart', { touches: [{ clientY: 10 }] });
    s.element.emit('touchmove', { touches: [{ clientY: 40 }] });
    assert.equal(s.following.current, false);
    s.follow.changed(); s.flush();
    assert.equal(s.element.scrollTop, 780);
  } finally { s.cleanup(); }
});

test('session reset cancels stale RAF; late history does not reset reading intent', () => {
  const s = setup();
  try {
    s.attach();
    const oldCallbacks = [...s.frames.values()];
    s.follow.reset();
    for (const callback of oldCallbacks) callback(0);
    assert.equal(s.element.writes, 0);
    s.flush();
    assert.equal(s.element.scrollTop, 800);
    s.follow.pause();
    s.element.top = 200;
    s.follow.changed(); s.flush();
    assert.equal(s.element.scrollTop, 200);
    s.follow.reset(); s.flush();
    assert.equal(s.element.scrollTop, 800);
    s.follow.dispose();
    for (const observer of s.observers) observer.callback();
    assert.equal(s.frames.size, 0);
    assert.ok(s.observers.every((observer) => observer.disconnected));
  } finally { s.cleanup(); }
});

test('near-bottom upward wheel stays paused until downward scroll or explicit jump', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.emit('wheel', { deltaY: -20 });
    s.element.top = 780; s.element.emit('scroll');
    assert.equal(s.following.current, false);
    for (const observer of s.observers) observer.callback();
    s.flush();
    assert.equal(s.element.scrollTop, 780);
    s.element.scrollHeight = 1020;
    for (const observer of s.observers) observer.callback();
    s.follow.changed(); s.flush();
    assert.equal(s.element.scrollTop, 780);
    assert.equal(s.following.current, false);
    s.element.top = 770; s.element.emit('scroll');
    assert.equal(s.following.current, false);
    s.element.top = 800; s.element.emit('scroll');
    assert.equal(s.following.current, true);
    s.element.emit('wheel', { deltaY: -10 });
    s.element.top = 790; s.element.emit('scroll');
    s.follow.jump(); s.flush();
    assert.equal(s.following.current, true);
    assert.equal(s.element.scrollTop, 820);
  } finally { s.cleanup(); }
});

test('queued programmatic descent and layout scroll cannot resume upward suspension', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.scrollHeight = 1020;
    s.follow.changed();
    const queued = [...s.frames.values()];
    s.element.emit('wheel', { deltaY: -20 });
    s.element.top = 780; s.element.emit('scroll');
    for (const callback of queued) callback(0);
    s.element.emit('scroll');
    for (const observer of s.observers) observer.callback();
    s.flush();
    assert.equal(s.element.scrollTop, 780);
    assert.equal(s.following.current, false);
    s.follow.jump(); s.flush();
    assert.equal(s.element.scrollTop, 820);
    assert.equal(s.following.current, true);
  } finally { s.cleanup(); }
});

test('plain pointer click does not suspend follow; undelivered scrollbar movement does', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.emit('pointerdown');
    s.element.scrollHeight = 1200;
    s.observers[0].callback(); s.flush();
    assert.equal(s.following.current, true);
    assert.equal(s.element.scrollTop, 1000);
    s.element.top = 980;
    s.observers[0].callback(); s.flush();
    assert.equal(s.following.current, false);
    assert.equal(s.element.scrollTop, 980);
  } finally { s.cleanup(); }
});

test('prevented and independently consumed nested wheels do not pause the timeline', () => {
  const s = setup();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  try {
    s.attach(); s.flush();
    const prevented = new Event('wheel', { cancelable: true });
    Object.assign(prevented, { deltaY: -20 });
    prevented.preventDefault();
    s.element.dispatchEvent(prevented);
    assert.equal(s.following.current, true);
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true, value: () => ({ overflowY: 'auto' }),
    });
    const child = { scrollHeight: 500, clientHeight: 100, scrollTop: 30, parentElement: s.element };
    const wheel = new Event('wheel');
    Object.assign(wheel, { deltaY: -20 });
    Object.defineProperty(wheel, 'target', { value: child });
    s.element.dispatchEvent(wheel);
    assert.equal(s.following.current, true);
    child.scrollTop = 0;
    s.element.dispatchEvent(wheel);
    assert.equal(s.following.current, false);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'getComputedStyle', saved);
    else Reflect.deleteProperty(globalThis, 'getComputedStyle');
    s.cleanup();
  }
});

test('nested touch scrolling preserves follow until the child hands off at its edge', () => {
  const s = setup();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  try {
    s.attach(); s.flush();
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true, value: () => ({ overflowY: 'auto' }),
    });
    const child = { scrollHeight: 500, clientHeight: 100, scrollTop: 30, parentElement: s.element };
    const move = (clientY: number) => {
      const event = new Event('touchmove');
      Object.assign(event, { touches: [{ clientY }] });
      Object.defineProperty(event, 'target', { value: child });
      s.element.dispatchEvent(event);
    };
    s.element.emit('touchstart', { touches: [{ clientY: 10 }] });
    move(40);
    assert.equal(s.following.current, true);
    assert.equal(s.jump, false);
    child.scrollTop = 0;
    // Đổi hướng sau khi con cuộn phải dùng vị trí chạm mới nhất.
    move(30);
    assert.equal(s.following.current, true);
    move(35);
    assert.equal(s.following.current, false);
    assert.equal(s.jump, true);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'getComputedStyle', saved);
    else Reflect.deleteProperty(globalThis, 'getComputedStyle');
    s.cleanup();
  }
});

test('prevented touch movement preserves follow and updates the touch position', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.emit('touchstart', { touches: [{ clientY: 10 }] });
    const event = new Event('touchmove', { cancelable: true });
    Object.assign(event, { touches: [{ clientY: 40 }] });
    event.preventDefault();
    s.element.dispatchEvent(event);
    assert.equal(s.following.current, true);
    assert.equal(s.jump, false);
    s.element.emit('touchmove', { touches: [{ clientY: 30 }] });
    assert.equal(s.following.current, true);
    s.element.emit('touchmove', { touches: [{ clientY: 35 }] });
    assert.equal(s.following.current, false);
    assert.equal(s.jump, true);
  } finally { s.cleanup(); }
});

test('ordinary parent touch only pauses for movement away from the bottom', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.emit('touchstart', { touches: [{ clientY: 40 }] });
    s.element.emit('touchmove', { touches: [{ clientY: 40 }] });
    s.element.emit('touchmove', { touches: [{ clientY: 10 }] });
    assert.equal(s.following.current, true);
    assert.equal(s.jump, false);
    s.element.emit('touchmove', { touches: [{ clientY: 20 }] });
    assert.equal(s.following.current, false);
    assert.equal(s.jump, true);
    s.element.scrollHeight = 1200;
    s.follow.changed(); s.flush();
    assert.equal(s.element.scrollTop, 800);
  } finally { s.cleanup(); }
});

test('without ResizeObserver mutations and captured resource load still follow', () => {
  const s = setup(false);
  try {
    s.attach(); s.flush();
    s.element.scrollHeight = 1400;
    s.observers[0].callback(); s.flush();
    assert.equal(s.element.scrollTop, 1200);
    s.element.scrollHeight = 1700;
    s.element.emit('load'); s.flush();
    assert.equal(s.element.scrollTop, 1500);
  } finally { s.cleanup(); }
});

test('upward wheel at distance 30 cancels pending resize; downward wheel waits for movement', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.top = 780; // Input precedes delivery of the corresponding scroll.
    s.observers[0].callback();
    s.element.emit('wheel', { deltaY: -10 });
    assert.equal(s.frames.size, 0);
    s.element.top = 770; s.element.emit('scroll');
    assert.equal(s.following.current, false);
    for (const observer of s.observers) observer.callback();
    s.flush();
    assert.equal(s.element.scrollTop, 770);
    s.element.emit('wheel', { deltaY: 10 });
    s.observers[0].callback(); s.flush();
    assert.equal(s.following.current, false);
    assert.equal(s.element.scrollTop, 770);
    s.element.top = 780; s.element.emit('scroll');
    assert.equal(s.following.current, true);
    s.observers[0].callback(); s.flush();
    assert.equal(s.element.scrollTop, 800);
  } finally { s.cleanup(); }
});

test('unknown and zero wheel deltas do not suspend; upward wheel at top cannot pause', () => {
  const s = setup();
  try {
    s.attach(); s.flush();
    s.element.emit('wheel');
    assert.equal(s.following.current, true);
    s.element.emit('wheel', { deltaY: 0 });
    assert.equal(s.following.current, true);
    s.follow.reset(); s.flush();
    s.element.scrollHeight = s.element.clientHeight;
    s.element.top = 0; s.element.emit('scroll');
    s.follow.reset(); s.flush();
    s.element.emit('wheel', { deltaY: -10 });
    assert.equal(s.following.current, true);
  } finally { s.cleanup(); }
});

test('nested geometry without DOM styles consumes wheels until its directional edge', () => {
  const s = setup();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  try {
    Reflect.deleteProperty(globalThis, 'getComputedStyle');
    s.attach(); s.flush();
    const child = { scrollHeight: 500, clientHeight: 100, scrollTop: 30, parentElement: s.element };
    const emit = (deltaY: number) => {
      const event = new Event('wheel');
      Object.assign(event, { deltaY });
      Object.defineProperty(event, 'target', { value: child });
      s.element.dispatchEvent(event);
    };
    emit(-10);
    assert.equal(s.following.current, true);
    child.scrollTop = 0; emit(-10);
    assert.equal(s.following.current, false);
    child.scrollTop = 400; emit(10);
    assert.equal(s.following.current, false);
    s.element.top = 790; s.element.emit('scroll');
    assert.equal(s.following.current, false);
    s.element.top = 800; s.element.emit('scroll');
    assert.equal(s.following.current, true);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'getComputedStyle', saved);
    s.cleanup();
  }
});

test('keyboard reader intent ignores editable controls and pauses timeline navigation', () => {
  const s = setup();
  class KeyEvent extends Event {
    key: string;
    constructor(key: string) { super('keydown'); this.key = key; }
  }
  try {
    s.attach(); s.flush();
    for (const props of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }, { isContentEditable: true }]) {
      const event = new KeyEvent('ArrowUp');
      Object.defineProperty(event, 'target', { value: { ...props, parentElement: s.element } });
      s.element.dispatchEvent(event);
      assert.equal(s.following.current, true);
    }
    s.element.dispatchEvent(new KeyEvent('ArrowUp'));
    assert.equal(s.following.current, false);
    s.observers[0].callback(); s.flush();
    assert.equal(s.element.scrollTop, 800);
  } finally { s.cleanup(); }
});
