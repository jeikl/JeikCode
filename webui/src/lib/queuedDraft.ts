import type { ApprovalMode, ImageData } from '../api';

export interface QueuedDraftItem {
  text: string;
  images?: ImageData[];
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'build' || value === 'plan' || value === 'bypass' || value === 'accept_edits';
}

/** Map the UI approval mode to the daemon queue's existing wire property. */
export function serializeQueuedCard<T extends { approvalMode?: ApprovalMode; clientInputId?: string }>(
  item: T,
): Omit<T, 'approvalMode' | 'clientInputId'> & {
  approval_mode?: ApprovalMode;
  client_input_id?: string;
} {
  const { approvalMode, clientInputId, ...rest } = item;
  return {
    ...rest,
    ...(clientInputId ? { client_input_id: clientInputId } : {}),
    ...(isApprovalMode(approvalMode) ? { approval_mode: approvalMode } : {}),
  };
}

/** Restore a daemon queue card without trusting malformed persisted modes. */
export function deserializeQueuedCard<T extends { approval_mode?: ApprovalMode; client_input_id?: string }>(
  item: T,
): Omit<T, 'approval_mode' | 'client_input_id'> & {
  approvalMode?: ApprovalMode;
  clientInputId?: string;
} {
  const { approval_mode, client_input_id, ...rest } = item;
  return {
    ...rest,
    ...(client_input_id ? { clientInputId: client_input_id } : {}),
    ...(isApprovalMode(approval_mode) ? { approvalMode: approval_mode } : {}),
  };
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
export function restoreSessionQueued<
  T extends { id?: unknown; clientInputId?: string },
>(
  stash: Map<string, T[]>,
  sessionId: string | null | undefined,
): T[] {
  const identity = (item: T | undefined): string =>
    item?.clientInputId || String(item?.id ?? '');
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
        // Merge by the stable client identity first; numeric ids collide after
        // refreshes and are only a legacy fallback.
        const existingIds = new Set(found.map(identity));
        const merged = [...found];
        for (const it of loaded) {
          if (!existingIds.has(identity(it))) {
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

const QUEUE_KIND_RANK: Record<string, number> = { queue: 0, steering: 1, steer: 2 };

/** A local stage only overrides the server while its write is still in flight. */
export function mergeQueuedCardState<T extends { kind?: string }>(
  serverCard: T,
  localCard: T | undefined,
  localMutationInFlight: boolean,
): T {
  if (
    !localCard ||
    !localMutationInFlight ||
    (QUEUE_KIND_RANK[localCard.kind ?? ''] ?? 0) <= (QUEUE_KIND_RANK[serverCard.kind ?? ''] ?? 0)
  ) {
    return serverCard;
  }
  return { ...serverCard, kind: localCard.kind };
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
