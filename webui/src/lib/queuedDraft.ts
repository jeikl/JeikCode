import type { ApprovalMode, ImageData, QueuedMessageApiItem } from '../api';

export interface QueuedDraftItem {
  text: string;
  images?: ImageData[];
}

// /chat/queue already persists id as a JSON number OR string. A rejected
// request identity survives local and server storage without a new wire field
// or guessing delivery from repeated user text.
const REJECTED_CHAT_RETRY_PREFIX = 'rejected-chat:';

export function rejectedChatRetryId(requestId: string): string {
  return REJECTED_CHAT_RETRY_PREFIX + requestId;
}

export function isUnacceptedChatRetry(item: { id: number | string; kind?: string }): boolean {
  // A steering HTTP request is not accepted until postChatSteer completes.
  // A sidebar switch during this in-flight interval cannot use an older user
  // bubble with matching text as proof this retry was already delivered.
  return (item.kind === 'queue' || item.kind === 'steering')
    && typeof item.id === 'string'
    && item.id.startsWith(REJECTED_CHAT_RETRY_PREFIX);
}

export function appendRejectedChatRetry<T extends { id: number | string }>(
  queued: T[],
  rejected: T,
): T[] {
  return queued.some((item) => item.id === rejected.id) ? queued : [...queued, rejected];
}

/** After a failed server-clear receipt keep the retry ahead of later queued
 * prompts, without adding a duplicate after another view restored the ID. */
export function restoreRejectedChatRetry<T extends { id: number | string }>(
  queued: T[], retry: T,
): T[] {
  return queued.some((item) => item.id === retry.id) ? queued : [retry, ...queued];
}

/** A GET issued before a confirmed queue-clear may resolve afterward with an
 * obsolete snapshot. It must not resurrect that exact cleared request ID. */
export function shouldHydrateServerQueuedItem(
  item: { id: number | string }, confirmedClearedIds: ReadonlySet<string> | undefined,
): boolean {
  return !confirmedClearedIds?.has(String(item.id));
}

/** A pending Send Now must not use its old A-render closure after a sidebar
 * switch to B or after a replacement view generation of A. */
export function queuedSendStillOwnsView(input: {
  mounted: boolean;
  intendedSession: string | null;
  viewedSession: string | null;
  startingGeneration: number;
  currentGeneration: number;
}): boolean {
  return input.mounted
    && input.viewedSession === input.intendedSession
    && input.startingGeneration === input.currentGeneration;
}

export function queuedItemAlreadyDelivered<T extends { id: number | string; text: string; kind?: string }>(
  item: T,
  textAppearsInTranscript: (text: string) => boolean,
): boolean {
  // A 409 means THIS submission was not accepted. An older user bubble
  // with the same text, even different images/mode, cannot consume it.
  return !isUnacceptedChatRetry(item) && textAppearsInTranscript(item.text);
}

/** Queued image-only submissions are valid even without any visible text. */
export function queuedPayloadHasContent(text: string, images?: ImageData[]): boolean {
  return text.trim().length > 0 || (images?.length ?? 0) > 0;
}

/** A rejected submission may be sent only after the daemon confirms its
 * persisted queue entry is gone. If removal fails, or its view/owner changed,
 * preserve the payload to retry later instead of risking duplicate delivery. */
export async function dispatchRejectedChatRetryAfterQueueClear(
  clearQueue: () => Promise<void>,
  stillOwnedAndIdle: () => boolean,
  deliver: () => void,
  restore: () => void,
): Promise<boolean> {
  try {
    await clearQueue();
    if (!stillOwnedAndIdle()) {
      restore();
      return false;
    }
    deliver();
    return true;
  } catch {
    restore();
    return false;
  }
}

/** Preserve this tab's per-session queue write order across async POSTs.
 * A failed earlier write cannot prevent a subsequent authoritative clear. */
export function serializeSessionQueueWrite(
  tails: Map<string, Promise<void>>,
  sid: string,
  write: () => Promise<void>,
): Promise<void> {
  const previous = tails.get(sid) ?? Promise.resolve();
  const request = previous.catch(() => {}).then(write);
  tails.set(sid, request);
  void request.finally(() => {
    if (tails.get(sid) === request) tails.delete(sid);
  }).catch(() => {});
  return request;
}

/** Use the server's existing snake_case approval_mode field. Casting a local
 * item previously lost its requested mode after cross-device queue refresh. */
export function serializeQueuedForServer<T extends {
  id: number | string;
  text: string;
  images?: ImageData[];
  kind: QueuedMessageApiItem['kind'];
  approvalMode?: ApprovalMode;
}>(items: T[]): QueuedMessageApiItem[] {
  return items.map((item) => ({
    id: item.id,
    text: item.text,
    images: item.images,
    kind: item.kind,
    approval_mode: item.approvalMode,
  }));
}

export function restoreQueuedFromServer(
  item: QueuedMessageApiItem,
  fallbackMode: ApprovalMode,
): QueuedMessageApiItem & { approvalMode: ApprovalMode } {
  return { ...item, approvalMode: item.approval_mode ?? fallbackMode };
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
