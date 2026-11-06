/**
 * Session-id → SessionStore registry (P1-D).
 *
 * `messageCacheRef` historically was a Map<string, Message[]>; this class keeps
 * that tiny surface (get/set/has/delete/clear) while every entry is owned by a
 * SessionStore. Background/cache paths therefore mutate through the same
 * reducer boundary as the active canvas.
 */
import type { CanvasRowLike } from './canvasStore.ts';
import type { ProjectionMessage } from '../sessionProjection.ts';
import { SessionStore } from './sessionStore.ts';

export class SessionStoreMap<T extends CanvasRowLike & ProjectionMessage> {
  private readonly stores = new Map<string, SessionStore<T>>();

  private store(key: string): SessionStore<T> {
    let store = this.stores.get(key);
    if (!store) {
      store = new SessionStore<T>();
      this.stores.set(key, store);
    }
    return store;
  }

  get(key: string): T[] | undefined {
    return this.stores.get(key)?.current;
  }

  set(key: string, rows: T[]): this {
    this.store(key).replace(rows);
    return this;
  }

  has(key: string): boolean {
    return this.stores.has(key);
  }

  delete(key: string): boolean {
    return this.stores.delete(key);
  }

  clear(): void {
    this.stores.clear();
  }
}
