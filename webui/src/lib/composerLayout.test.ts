import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSER_MAX_HEIGHT,
  collapseComposerTextarea,
  resizeComposerTextarea,
  withPinnedTimelineViewport,
} from './composerLayout.ts';

function makeScroller(clientHeight = 600, flex = '1 1 0%', height = '') {
  return { clientHeight, style: { flex, height } };
}

function makeTextarea(scrollHeight: number) {
  return { style: { height: '' }, scrollHeight };
}

test('composer measurement pins the timeline box and restores it afterwards', () => {
  const scroller = makeScroller(600, '1 1 0%', '');
  const textarea = makeTextarea(140);
  let seen: { flex: string; height: string } | null = null;
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    get() {
      seen = { flex: scroller.style.flex, height: scroller.style.height };
      return 140;
    },
  });

  resizeComposerTextarea(textarea, scroller);

  assert.deepEqual(seen, { flex: '0 0 auto', height: '600px' }, '测量时时间线必须被冻结在原高度');
  assert.equal(textarea.style.height, '140px');
  assert.equal(scroller.style.flex, '1 1 0%', 'flex 必须原样恢复');
  assert.equal(scroller.style.height, '', '内联高度必须原样恢复');
});

test('composer measurement caps at the maximum height', () => {
  const textarea = makeTextarea(999);
  resizeComposerTextarea(textarea, makeScroller());
  assert.equal(textarea.style.height, `${COMPOSER_MAX_HEIGHT}px`);

  resizeComposerTextarea(textarea, makeScroller(), 240);
  assert.equal(textarea.style.height, '240px');
});

test('composer measurement keeps a short draft at its intrinsic height', () => {
  const textarea = makeTextarea(22);
  resizeComposerTextarea(textarea, makeScroller());
  assert.equal(textarea.style.height, '22px');
});

test('no scroller box means no pin, but the textarea still resizes', () => {
  const textarea = makeTextarea(88);
  resizeComposerTextarea(textarea, makeScroller(0));
  assert.equal(textarea.style.height, '88px');

  const second = makeTextarea(44);
  resizeComposerTextarea(second, null);
  assert.equal(second.style.height, '44px');
});

test('collapsing a sent draft uses the same viewport pin', () => {
  const scroller = makeScroller(500);
  const textarea = makeTextarea(120);
  collapseComposerTextarea(textarea, scroller);
  assert.equal(textarea.style.height, 'auto');
  assert.equal(scroller.style.flex, '1 1 0%');
  assert.equal(scroller.style.height, '');
});

test('an exception during measurement still restores the timeline box', () => {
  const scroller = makeScroller(480);
  const textarea = makeTextarea(0);
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    get() {
      throw new Error('layout failed');
    },
  });
  assert.throws(() => resizeComposerTextarea(textarea, scroller), /layout failed/);
  assert.equal(scroller.style.flex, '1 1 0%');
  assert.equal(scroller.style.height, '');
});

test('withPinnedTimelineViewport returns the callback result and restores nested runs once', () => {
  const scroller = makeScroller(320, '0 1 auto', '40px');
  const result = withPinnedTimelineViewport(scroller, () => {
    assert.equal(scroller.style.flex, '0 0 auto');
    assert.equal(scroller.style.height, '320px');
    const inner = withPinnedTimelineViewport(scroller, () => 7);
    assert.equal(inner, 7);
    assert.equal(scroller.style.height, '320px', '嵌套时内层必须保持外层冻结值');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(scroller.style.flex, '0 1 auto');
  assert.equal(scroller.style.height, '40px');
});
