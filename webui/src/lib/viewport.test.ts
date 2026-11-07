import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldResetViewportScroll } from './viewport.ts';

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
