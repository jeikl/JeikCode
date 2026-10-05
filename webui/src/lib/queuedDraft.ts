import type { ImageData } from '../api';

export interface QueuedDraftItem {
  text: string;
  images?: ImageData[];
}

export const STORAGE_KEY_QUEUED_MESSAGES = 'jeikcode_queued_messages_v2';
export const LEGACY_STORAGE_KEY_QUEUED_MESSAGES = 'jeikcode_queued_messages';

/**
 * Load queued/steer items map from persistent localStorage across page refreshes.
 * Fallback to sessionStorage for backward compatibility.
 */
export function loadQueuedFromStorage<T>(): Map<string, T[]> {
  const map = new Map<string, T[]>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY_QUEUED_MESSAGES)
      || window.sessionStorage?.getItem(LEGACY_STORAGE_KEY_QUEUED_MESSAGES);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length > 0) {
          map.set(k, v as T[]);
        }
      }
    }
  } catch {
    // Ignore storage parse error
  }
  return map;
}

/**
 * Persist queued/steer items map into localStorage so page refreshes and
 * session switches never lose queued or steered follow-up cards until actually sent.
 */
export function saveQueuedToStorage<T>(stash: Map<string, T[]>): void {
  if (typeof window === 'undefined') return;
  try {
    const obj: Record<string, T[]> = {};
    for (const [k, v] of stash.entries()) {
      if (v && v.length > 0) {
        obj[k] = v;
      }
    }
    const serialized = JSON.stringify(obj);
    if (Object.keys(obj).length > 0) {
      window.localStorage?.setItem(STORAGE_KEY_QUEUED_MESSAGES, serialized);
      window.sessionStorage?.setItem(LEGACY_STORAGE_KEY_QUEUED_MESSAGES, serialized);
    } else {
      window.localStorage?.removeItem(STORAGE_KEY_QUEUED_MESSAGES);
      window.sessionStorage?.removeItem(LEGACY_STORAGE_KEY_QUEUED_MESSAGES);
    }
  } catch {
    // Ignore storage quota / access error
  }
}

/**
 * Stash a session's in-flight queued/steer items when switching away.
 */
export function stashSessionQueued<T>(
  stash: Map<string, T[]>,
  sessionId: string | null | undefined,
  items: T[],
): void {
  if (!sessionId) return;
  if (items.length > 0) {
    stash.set(sessionId, [...items]);
  } else {
    stash.delete(sessionId);
  }
  saveQueuedToStorage(stash);
}

/**
 * Restore a session's stashed queued/steer items when switching back or refreshing.
 */
export function restoreSessionQueued<T>(
  stash: Map<string, T[]>,
  sessionId: string | null | undefined,
): T[] {
  if (!sessionId) return [];
  let found = stash.get(sessionId);
  // Always query storage so any cross-tab or refreshed items are thoroughly restored
  if (typeof window !== 'undefined') {
    const stored = loadQueuedFromStorage<T>();
    const loaded = stored.get(sessionId);
    if (loaded && loaded.length > 0) {
      if (!found || found.length === 0) {
        stash.set(sessionId, loaded);
        found = loaded;
      } else {
        // Merge without duplicating IDs
        const existingIds = new Set(found.map((item: any) => String(item?.id ?? '')));
        const merged = [...found];
        for (const it of loaded) {
          if (!existingIds.has(String((it as any)?.id ?? ''))) {
            merged.push(it);
          }
        }
        stash.set(sessionId, merged);
        found = merged;
      }
    }
  }
  return found && found.length > 0 ? [...found] : [];
}

/**
 * Keep this tab's follow-up queue when `/chat/active` says the session is
 * still running. Clearing it hid queued and steered chrome after a sidebar
 * switch even though `postChatSteer` continued to apply at the next step.
 */
export function queueAfterSessionActiveCheck<T>(input: {
  restored: T[];
  sessionActive: boolean;
}): T[] {
  return input.restored;
}

/**
 * Put queued follow-ups back into the composer.
 * Text stays in queue order and is placed before whatever the user has since typed.
 * Images already in the composer stay first; queued images follow them.
 */
export function mergeQueuedIntoDraft(
  queued: QueuedDraftItem[],
  draftText: string,
  draftImages: ImageData[],
): { text: string; images: ImageData[] } {
  const queuedText = queued
    .map((item) => item.text)
    .filter((text) => text.trim().length > 0)
    .join('\n');
  const text = draftText.trim()
    ? (queuedText ? `${queuedText}\n${draftText}` : draftText)
    : queuedText;
  return {
    text,
    images: [
      ...draftImages,
      ...queued.flatMap((item) => item.images ?? []),
    ],
  };
}
