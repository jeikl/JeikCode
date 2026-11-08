// Fixed-position menu coordinates under `:root { zoom }`.
//
// The app implements page zoom with CSS `zoom` on <html>. `clientX/clientY` are
// visual coordinates (already zoomed), while a fixed menu's `top/left` are
// zoomed AGAIN by the root element. Dividing by the zoom factor once (and
// clamping against the zoomed viewport) keeps the menu exactly under the
// cursor at every scale — the same strict anti-drift recipe used by the file
// explorer context menu.

import { getPageZoom } from './pageZoom.ts';

export interface MenuPoint {
  left: number;
  top: number;
}

export interface MenuPointOptions {
  /** Viewport edge padding, in the same (zoom-normalized) coordinate space. */
  margin?: number;
  /** Override for tests / callers that already resolved the zoom. */
  zoom?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * Pure geometry: keep the menu's top-left inside the viewport, flipping to the
 * other side of the anchor when it would overflow the right/bottom edge.
 */
export function clampMenuPoint(
  rawX: number,
  rawY: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 10,
): MenuPoint {
  const maxX = viewportWidth - margin;
  const maxY = viewportHeight - margin;
  const left = rawX + width > maxX ? Math.max(margin, rawX - width) : rawX;
  const top = rawY + height > maxY ? Math.max(margin, rawY - height) : rawY;
  return { left, top };
}

/**
 * Convert a mouse event's viewport point into `position: fixed` menu
 * coordinates, accounting for page zoom.
 */
export function menuPointFromEvent(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
  options: MenuPointOptions = {},
): MenuPoint {
  const zoom = options.zoom ?? (getPageZoom() || 1.0);
  const viewportWidth = options.viewportWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const viewportHeight = options.viewportHeight
    ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
  return clampMenuPoint(
    Math.round(clientX / zoom),
    Math.round(clientY / zoom),
    width,
    height,
    viewportWidth / zoom,
    viewportHeight / zoom,
    options.margin ?? 10,
  );
}
