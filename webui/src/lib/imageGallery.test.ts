import test from 'node:test';
import assert from 'node:assert/strict';
import { collectImageSrcs, stepImageIndex } from './imageGallery.ts';

const root = (srcs: Array<string | { currentSrc?: string; src?: string }>) => ({
  querySelectorAll: () => srcs.map((item) => (typeof item === 'string' ? { src: item } : item)),
});

test('会话图片按 DOM 顺序去重收集', () => {
  const list = collectImageSrcs(root(['a.png', 'b.png', 'a.png', '  ', 'c.png']));
  assert.deepEqual(list, ['a.png', 'b.png', 'c.png']);
});

test('懒加载图片优先取 currentSrc，未加载时回退 src', () => {
  const list = collectImageSrcs(root([
    { currentSrc: 'real.png', src: 'placeholder.png' },
    { src: 'fallback.png' },
  ]));
  assert.deepEqual(list, ['real.png', 'fallback.png']);
});

test('点击的图片一定在列表里，且不会重复', () => {
  assert.deepEqual(collectImageSrcs(root(['a.png']), 'a.png'), ['a.png']);
  // 画布之外（输入框待发附件）点开的图片：补到末尾，保证灯箱能定位当前张。
  assert.deepEqual(collectImageSrcs(root(['a.png']), 'draft.png'), ['a.png', 'draft.png']);
  assert.deepEqual(collectImageSrcs(null, 'draft.png'), ['draft.png']);
  assert.deepEqual(collectImageSrcs(null), []);
});

test('上一张 / 下一张循环切换', () => {
  assert.equal(stepImageIndex(0, 3, 1), 1);
  assert.equal(stepImageIndex(2, 3, 1), 0);
  assert.equal(stepImageIndex(0, 3, -1), 2);
  assert.equal(stepImageIndex(1, 3, -1), 0);
  // 只有一张 / 空列表：没有可切换目标。
  assert.equal(stepImageIndex(0, 1, 1), undefined);
  assert.equal(stepImageIndex(0, 0, 1), undefined);
});
