import type { ImageData } from '../api';

export interface QueuedDraftItem {
  text: string;
  images?: ImageData[];
}

/**
 * Put queued follow-ups back into the composer.
 * Text stays in queue order and is placed before whatever the user has since typed.
 * Images already in the composer stay first; queued images follow them.
 */
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
}

/**
 * Restore a session's stashed queued/steer items when switching back.
 */
export function restoreSessionQueued<T>(
  stash: Map<string, T[]>,
  sessionId: string | null | undefined,
): T[] {
  if (!sessionId) return [];
  const found = stash.get(sessionId);
  return found && found.length > 0 ? [...found] : [];
}

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
