/**
 * 右侧浮动工具条（提问 / Git / 终端 / 预览）的位置模型。
 *
 * 背景：页面缩放走的是根元素 CSS `zoom`，布局视口的 CSS 宽度会随缩放比例变化。
 * 旧实现把工具条的绝对 `left`（局部像素）存进 localStorage，缩放后这个坐标不再
 * 对应右边缘，工具条就会停在旧位置，离右边越来越远。
 *
 * 现在的模型是“锚定到最近的一条竖边 + 保存到该边的距离”：
 * - 停在右边缘的工具条在缩放 / 改窗后仍然贴住右边缘；
 * - 拖到左半屏的工具条改为锚定左边缘，不会因为窗口变宽被推着跑；
 * - 水平位置始终可自由拖拽，跨越中线时锚定边无缝切换（视觉位置不变）。
 *
 * 视口与尺寸统一使用缩放后的局部 CSS 像素（device px / zoom），与 `getBoundingClientRect`
 * 之外的拖拽计算保持一致。
 */

export const FLOATING_WIDGET_POS_STORAGE_KEY = 'jeikcode:floating-widget-pos-v2';
/** 旧版只存左侧绝对 left，缩放后会漂移，仅用于一次性迁移顶部位置。 */
export const LEGACY_FLOATING_WIDGET_POS_KEY = 'jeikcode:floating-widget-pos';
export const LEGACY_FLOATING_WIDGET_TOP_KEY = 'jeikcode:floating-widget-top';

/** 折叠态工具条的默认尺寸（与 CSS 中 40px 宽、拖拽把手 + 4 个 32px 按钮对应）。 */
export const FLOATING_WIDGET_SIZE = { width: 40, height: 160 } as const;

/** 贴边时与视口边缘保留的间距。 */
export const FLOATING_WIDGET_EDGE_GAP = 12;

/** 顶部最小留白：避免工具条钻到顶部工具栏下面。 */
export const FLOATING_WIDGET_MIN_TOP = 48;

export type FloatingWidgetEdge = 'left' | 'right';

export interface FloatingWidgetPos {
  /** 水平方向锚定的竖边。 */
  edge: FloatingWidgetEdge;
  /** 到锚定边的距离（局部 CSS 像素）。 */
  offset: number;
  /** 距视口顶部的距离（局部 CSS 像素）。 */
  top: number;
}

export interface FloatingWidgetViewport {
  width: number;
  height: number;
}

export interface FloatingWidgetSize {
  width: number;
  height: number;
}

function normalizeViewport(viewport: FloatingWidgetViewport): FloatingWidgetViewport {
  return {
    width: Number.isFinite(viewport.width) ? Math.max(1, Math.round(viewport.width)) : 1,
    height: Number.isFinite(viewport.height) ? Math.max(1, Math.round(viewport.height)) : 1,
  };
}

/** 把位置夹进视口；未发生改变时返回原对象，便于 `setState` 提前退出。 */
export function clampFloatingWidgetPos(
  pos: FloatingWidgetPos,
  viewport: FloatingWidgetViewport,
  size: FloatingWidgetSize = FLOATING_WIDGET_SIZE,
): FloatingWidgetPos {
  const { width, height } = normalizeViewport(viewport);
  const maxOffset = Math.max(FLOATING_WIDGET_EDGE_GAP, width - size.width - FLOATING_WIDGET_EDGE_GAP);
  const offset = Math.max(FLOATING_WIDGET_EDGE_GAP, Math.min(maxOffset, Math.round(pos.offset)));
  const maxTop = Math.max(FLOATING_WIDGET_MIN_TOP, height - size.height - FLOATING_WIDGET_EDGE_GAP);
  const top = Math.max(FLOATING_WIDGET_MIN_TOP, Math.min(maxTop, Math.round(pos.top)));
  if (offset === pos.offset && top === pos.top) return pos;
  return { edge: pos.edge, offset, top };
}

/** 由左侧绝对坐标推导锚定边：靠近哪条边就贴哪条边。 */
export function floatingWidgetPosFromLeft(
  left: number,
  top: number,
  viewport: FloatingWidgetViewport,
  size: FloatingWidgetSize = FLOATING_WIDGET_SIZE,
): FloatingWidgetPos {
  const { width } = normalizeViewport(viewport);
  const leftGap = Math.max(0, left);
  const rightGap = width - left - size.width;
  const edge: FloatingWidgetEdge = rightGap <= leftGap ? 'right' : 'left';
  return clampFloatingWidgetPos(
    { edge, offset: edge === 'right' ? rightGap : leftGap, top },
    viewport,
    size,
  );
}

/** 当前锚定下的左侧绝对坐标（局部像素），供拖拽把位置换算回统一坐标。 */
export function floatingWidgetLeft(
  pos: FloatingWidgetPos,
  viewport: FloatingWidgetViewport,
  size: FloatingWidgetSize = FLOATING_WIDGET_SIZE,
): number {
  const { width } = normalizeViewport(viewport);
  return pos.edge === 'right' ? width - pos.offset - size.width : pos.offset;
}

/** 拖拽增量（局部像素）落到哪一侧，就在哪一侧继续锚定。 */
export function moveFloatingWidget(
  start: FloatingWidgetPos,
  dx: number,
  dy: number,
  viewport: FloatingWidgetViewport,
  size: FloatingWidgetSize = FLOATING_WIDGET_SIZE,
): FloatingWidgetPos {
  const left = floatingWidgetLeft(start, viewport, size) + (Number.isFinite(dx) ? dx : 0);
  const top = start.top + (Number.isFinite(dy) ? dy : 0);
  return floatingWidgetPosFromLeft(left, top, viewport, size);
}

/**
 * 解析持久化位置。兼容 v2 `{edge, offset, top}`、早期 `{right, top}` 与
 * 纯左侧坐标 `{left, top}`；无法解析时返回 null，由调用方回落到默认贴右。
 */
export function parseFloatingWidgetPos(
  raw: string | null | undefined,
  viewport: FloatingWidgetViewport,
  size: FloatingWidgetSize = FLOATING_WIDGET_SIZE,
): FloatingWidgetPos | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const top = Number(record.top);
  if (!Number.isFinite(top)) return null;

  if (record.edge === 'left' || record.edge === 'right') {
    const offset = Number(record.offset);
    if (Number.isFinite(offset)) {
      return clampFloatingWidgetPos({ edge: record.edge, offset, top }, viewport, size);
    }
  }
  const right = Number(record.right);
  if (Number.isFinite(right)) {
    return clampFloatingWidgetPos({ edge: 'right', offset: right, top }, viewport, size);
  }
  const left = Number(record.left);
  if (Number.isFinite(left)) {
    return floatingWidgetPosFromLeft(left, top, viewport, size);
  }
  return null;
}
