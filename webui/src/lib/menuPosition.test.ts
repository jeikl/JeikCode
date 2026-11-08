import test from 'node:test';
import assert from 'node:assert/strict';

import { clampMenuPoint, menuPointFromEvent } from './menuPosition.ts';

test('菜单正常落在光标右下角', () => {
  assert.deepEqual(clampMenuPoint(120, 80, 200, 150, 1200, 800), { left: 120, top: 80 });
});

test('右侧放不下时翻到光标左侧，且始终保留 10px 边距', () => {
  assert.deepEqual(clampMenuPoint(1150, 80, 200, 150, 1200, 800), { left: 950, top: 80 });
});

test('下方放不下时翻到光标上方', () => {
  assert.deepEqual(clampMenuPoint(100, 760, 200, 150, 1200, 800), { left: 100, top: 610 });
});

test('极限位置不会越过左/上边距', () => {
  assert.deepEqual(clampMenuPoint(2, 3, 1200, 900, 800, 600), { left: 10, top: 10 });
});

test('菜单坐标按页面缩放归一化', () => {
  assert.deepEqual(
    menuPointFromEvent(600, 400, 180, 160, {
      zoom: 1.5,
      viewportWidth: 1200,
      viewportHeight: 800,
    }),
    { left: 400, top: 267 },
  );
});

test('缩放后靠近右下角时仍按缩放后的视口翻转', () => {
  assert.deepEqual(
    menuPointFromEvent(1150, 700, 180, 160, {
      zoom: 1.5,
      viewportWidth: 1200,
      viewportHeight: 800,
    }),
    { left: 587, top: 307 },
  );
});
