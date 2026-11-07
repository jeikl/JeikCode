/**
 * Active-session canvas store (B3/B4 side-by-side).
 *
 * The store owns the reducer boundary today while React still owns rendering.
 * Every write goes through `replace` + `dispatch`, so the store is always a
 * mirror of the active canvas and can later become the only owner without
 * changing call sites.
 */
import {
  reduceCanvas,
  type CanvasAction,
  type CanvasRowLike,
} from './canvasStore.ts';
import {
  isCanvasEventAction,
  reduceCanvasEvent,
  type CanvasEventAction,
} from './actions.ts';
import type { ProjectionMessage } from '../sessionProjection.ts';

export class SessionStore<T extends CanvasRowLike & ProjectionMessage> {
  private rows: T[] = [];

  replace(rows: T[]): void {
    this.rows = rows;
  }

  get current(): T[] {
    return this.rows;
  }

  dispatch(action: CanvasAction<T> | CanvasEventAction): T[] {
    const next = isCanvasEventAction(action)
      ? reduceCanvasEvent(this.rows, action)
      : reduceCanvas(this.rows, action);
    // Reducer boundary: a malformed/unknown action must leave the canvas intact
    // instead of poisoning React state with `undefined`.
    if (!Array.isArray(next)) return this.rows;
    this.rows = next;
    return next;
  }
}
