import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOATING_WIDGET_EDGE_GAP,
  FLOATING_WIDGET_SIZE,
  clampFloatingWidgetPos,
  floatingWidgetLeft,
  floatingWidgetPosFromLeft,
  moveFloatingWidget,
  parseFloatingWidgetPos,
} from './floatingWidget.ts';

const wide = { width: 1920, height: 1080 };
const zoomedOut = { width: 2560, height: 1440 };

test('贴右的工具条在缩放导致视口变宽后仍紧贴右边缘', () => {
  const docked = { edge: 'right' as const, offset: FLOATING_WIDGET_EDGE_GAP, top: 130 };
  const zoomed = clampFloatingWidgetPos(docked, zoomedOut);
  assert.equal(zoomed.edge, 'right');
  assert.equal(zoomed.offset, FLOATING_WIDGET_EDGE_GAP, '缩放不应重新引入绝对 left 造成的空隙');
  assert.equal(
    floatingWidgetLeft(zoomed, zoomedOut),
    zoomedOut.width - FLOATING_WIDGET_SIZE.width - FLOATING_WIDGET_EDGE_GAP,
  );
});

test('旧版左侧坐标迁移时按最近边换算，贴右坐标回到右边缘', () => {
  const left = wide.width - FLOATING_WIDGET_SIZE.width - FLOATING_WIDGET_EDGE_GAP;
  const migrated = floatingWidgetPosFromLeft(left, 130, wide);
  assert.deepEqual(migrated, { edge: 'right', offset: FLOATING_WIDGET_EDGE_GAP, top: 130 });
});

test('拖到左半屏后锚定左边，窗口变宽不会把工具条推着跑', () => {
  const leftDocked = floatingWidgetPosFromLeft(64, 130, wide);
  assert.deepEqual(leftDocked, { edge: 'left', offset: 64, top: 130 });

  const resized = clampFloatingWidgetPos(leftDocked, zoomedOut);
  assert.equal(resized.edge, 'left');
  assert.equal(floatingWidgetLeft(resized, zoomedOut), 64, '左侧锚定应保持到左边缘的距离');
});

test('拖拽跨越中线时锚定边切换但物理位置连续', () => {
  const start = { edge: 'left' as const, offset: 200, top: 130 };
  const startLeft = floatingWidgetLeft(start, wide);
  const next = moveFloatingWidget(start, 1600, 0, wide);
  assert.equal(next.edge, 'right');
  assert.equal(floatingWidgetLeft(next, wide), startLeft + 1600);
});

test('拖拽与夹取不会把工具条推出视口', () => {
  const start = { edge: 'right' as const, offset: 12, top: 130 };
  const pushed = moveFloatingWidget(start, 5000, 5000, wide);
  assert.equal(pushed.offset, FLOATING_WIDGET_EDGE_GAP);
  // 垂直方向被底边夹住，但仍然完整留在视口内。
  assert.ok(pushed.top + FLOATING_WIDGET_SIZE.height <= wide.height);
});

test('极窄视口下仍保留最小边距，不产生负偏移', () => {
  const tiny = { width: 60, height: 120 };
  const pos = clampFloatingWidgetPos({ edge: 'right', offset: 999, top: 999 }, tiny);
  assert.equal(pos.offset, FLOATING_WIDGET_EDGE_GAP);
  assert.ok(pos.top >= 48);
});

test('解析 v2 / 旧版 right / 旧版 left 三种持久化形态', () => {
  assert.deepEqual(
    parseFloatingWidgetPos('{"edge":"right","offset":12,"top":130}', wide),
    { edge: 'right', offset: 12, top: 130 },
  );
  assert.deepEqual(
    parseFloatingWidgetPos('{"right":12,"top":130}', wide),
    { edge: 'right', offset: 12, top: 130 },
  );
  assert.deepEqual(
    parseFloatingWidgetPos('{"left":190,"top":130}', wide),
    { edge: 'left', offset: 190, top: 130 },
  );
});

test('无法解析的存档回落到 null，交给调用方贴右', () => {
  assert.equal(parseFloatingWidgetPos(null, wide), null);
  assert.equal(parseFloatingWidgetPos('not-json', wide), null);
  assert.equal(parseFloatingWidgetPos('{"top":"x"}', wide), null);
  assert.equal(parseFloatingWidgetPos('{}', wide), null);
});

test('位置未变化时返回原对象，避免无谓重渲染', () => {
  const pos = { edge: 'right' as const, offset: 12, top: 130 };
  assert.equal(clampFloatingWidgetPos(pos, wide), pos);
});
