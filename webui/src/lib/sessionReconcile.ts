import type { CanvasRecord as Message } from './canvas/records';
import { dropSnapshotDuplicates, userMessageAlreadyOnCanvas } from './chatTerminal';

export function lastUserPlain(
  messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    return message.parts.filter((part) => part.kind === 'text').map((part) => part.text || '').join('');
  }
  return '';
}

/** Disk catch-up must not wipe an optimistic send the server has not stored yet. */
export function diskHasCanvasUser(
  disk: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>,
  canvas: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>,
): boolean {
  const canvasUser = lastUserPlain(canvas).trim();
  if (!canvasUser) return true;
  const diskUser = lastUserPlain(disk).trim();
  return diskUser === canvasUser || diskUser.endsWith(canvasUser) || canvasUser.endsWith(diskUser);
}

/**
 * 检查切走前存下的本地缓存是否缺失了后台已跑完轮次的最终正文消息。
 * 典型场景：Agent 正在跑工具时用户切到其他会话，切走时缓存里只有工具调用没有正文；
 * 后台跑完并生成最终正文落盘后，切回时必须识别出磁盘上的最终正文并予以采纳。
 */
export function cacheMissingSettledAssistant(
  cached: Message[],
  loaded: Message[],
): boolean {
  if (loaded.length === 0) return false;
  const lastLoaded = loaded[loaded.length - 1];
  if (lastLoaded.role !== 'assistant' || !lastLoaded.parts) return false;

  const loadedHasText = lastLoaded.parts.some(
    (p) => p.kind === 'text' && (p.text?.trim()?.length ?? 0) > 0,
  );
  if (!loadedHasText) return false;

  if (cached.length === 0) return true;
  const lastCached = cached[cached.length - 1];
  if (lastCached.role !== 'assistant' || !lastCached.parts) return true;

  const cachedHasText = lastCached.parts.some(
    (p) => p.kind === 'text' && (p.text?.trim()?.length ?? 0) > 0,
  );
  if (!cachedHasText && loadedHasText) return true;

  return lastLoaded.parts.length > lastCached.parts.length;
}

/**
 * 合并快照与本地缓存中的用户提问，防止旧快照把用户刚发送的最新提问气泡抹去。
 */
export function reconcileSnapshotWithCache(cached: Message[] | undefined, snapshot: Message[]): Message[] {
  if (!cached || cached.length === 0) return snapshot;
  if (!snapshot || snapshot.length === 0) return cached;
  const cachedUserIndices: number[] = [];
  cached.forEach((m, idx) => { if (m.role === 'user') cachedUserIndices.push(idx); });
  const snapshotUserIndices: number[] = [];
  snapshot.forEach((m, idx) => { if (m.role === 'user') snapshotUserIndices.push(idx); });

  // id 收敛：若缓存的每个 user 提问都已在快照中（按稳定 id 命中），则缓存不含
  // 新轮次，直接以磁盘快照为准（不再依赖 user 计数启发式）。
  if (cachedUserIndices.length > 0) {
    const snapIds = new Set(snapshot.map((m) => m.id).filter((v): v is string => !!v));
    if (
      snapIds.size > 0 &&
      cachedUserIndices.every((i) => {
        const m = cached[i];
        return !!m?.id && snapIds.has(m.id);
      })
    ) {
      return snapshot;
    }
  }

  if (cachedUserIndices.length > snapshotUserIndices.length) {
    const lastCachedUserIdx = cachedUserIndices[cachedUserIndices.length - 1];
    const missingTail = cached.slice(lastCachedUserIdx);
    const missingUser = missingTail.find((m) => m.role === 'user');
    const missingText = missingUser
      ? missingUser.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join('')
      : '';
    if (missingText && userMessageAlreadyOnCanvas(snapshot, missingText)) {
      return snapshot;
    }
    const tail = dropSnapshotDuplicates(snapshot, missingTail);
    return [...snapshot, ...tail];
  }
  return snapshot;
}
