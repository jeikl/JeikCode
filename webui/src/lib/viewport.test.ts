import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewportLayout, shouldResetViewportScroll } from './viewport.ts';

test('可视区被键盘平移过时必须归零（顶部被裁 / 底部黑边）', () => {
  assert.equal(
    shouldResetViewportScroll({ offsetTop: 42, height: 780, fullHeight: 780 }),
    true,
  );
});

test('键盘压缩期间不平移就不打断输入', () => {
  assert.equal(
    shouldResetViewportScroll({ offsetTop: 0, height: 430, fullHeight: 780 }),
    false,
  );
});

test('键盘收起回到满高时顺手归零残留的布局滚动', () => {
  assert.equal(
    shouldResetViewportScroll({ offsetTop: 0, height: 780, fullHeight: 780 }),
    true,
  );
  // 允许 1px 的取整误差。
  assert.equal(
    shouldResetViewportScroll({ offsetTop: 0, height: 779, fullHeight: 780 }),
    true,
  );
});

test('尚未学习到满高时不做满高判断', () => {
  assert.equal(
    shouldResetViewportScroll({ offsetTop: 0, height: 780, fullHeight: 0 }),
    false,
  );
});

test('resizes-content 已缩小布局视口时以 innerHeight 为准，忽略可视视口的二次扣减', () => {
  // Chrome 安卓底部地址栏 + 键盘：innerHeight 已经缩到 433，但
  // visualViewport.height 又被多减了一次底部工具栏，只剩 350。
  const layout = resolveViewportLayout({
    layoutHeight: 433,
    visualHeight: 350,
    visualOffsetTop: 0,
    visualScale: 1,
    fullLayoutHeight: 873,
    fullVisualHeight: 873,
  });
  assert.deepEqual(layout, {
    height: 433,
    offsetTop: 0,
    keyboardOpen: true,
    layoutResized: true,
  });
});

test('resizes-visual 布局视口未变时使用可视视口高度', () => {
  const layout = resolveViewportLayout({
    layoutHeight: 873,
    visualHeight: 433,
    visualOffsetTop: 0,
    visualScale: 1,
    fullLayoutHeight: 873,
    fullVisualHeight: 873,
  });
  assert.deepEqual(layout, {
    height: 433,
    offsetTop: 0,
    keyboardOpen: true,
    layoutResized: false,
  });
});

test('可视区被浏览器向下平移时，把平移量还原成 #app 的顶部位移', () => {
  const layout = resolveViewportLayout({
    layoutHeight: 873,
    visualHeight: 433,
    visualOffsetTop: 120,
    visualScale: 1,
    fullLayoutHeight: 873,
    fullVisualHeight: 873,
  });
  assert.equal(layout.height, 433);
  assert.equal(layout.offsetTop, 120);
  assert.equal(layout.keyboardOpen, true);
  assert.equal(layout.layoutResized, false);
});

test('地址栏伸缩（小于键盘阈值）只跟随布局高度，不标记键盘', () => {
  const layout = resolveViewportLayout({
    layoutHeight: 817,
    visualHeight: 817,
    visualOffsetTop: 0,
    visualScale: 1,
    fullLayoutHeight: 873,
    fullVisualHeight: 873,
  });
  assert.deepEqual(layout, {
    height: 817,
    offsetTop: 0,
    keyboardOpen: false,
    layoutResized: true,
  });
});

test('双指缩放不按键盘收缩，保持整窗布局', () => {
  const layout = resolveViewportLayout({
    layoutHeight: 873,
    visualHeight: 360,
    visualOffsetTop: 40,
    visualScale: 2,
    fullLayoutHeight: 873,
    fullVisualHeight: 873,
  });
  assert.deepEqual(layout, {
    height: 873,
    offsetTop: 0,
    keyboardOpen: false,
    layoutResized: false,
  });
});

test('键盘收起后恢复满高且不标记键盘', () => {
  const layout = resolveViewportLayout({
    layoutHeight: 873,
    visualHeight: 873,
    visualOffsetTop: 0,
    visualScale: 1,
    fullLayoutHeight: 873,
    fullVisualHeight: 873,
  });
  assert.deepEqual(layout, {
    height: 873,
    offsetTop: 0,
    keyboardOpen: false,
    layoutResized: false,
  });
});
