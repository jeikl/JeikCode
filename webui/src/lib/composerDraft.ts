import type { ImageData } from '../api';

export interface ComposerDraft {
  text: string;
  images?: ImageData[];
}

export interface BubbleEditDraft {
  sourceIndex: number;
  /** Stable persisted/user identity; edit/rewind targets must not rely on the
   *  right-rail turn ordinal. */
  messageId?: string;
  text: string;
  images?: ImageData[];
  selectedModel?: string;
}

export const STORAGE_KEY_COMPOSER_DRAFT_PREFIX = 'jeikcode:composer_draft:';
export const STORAGE_KEY_BUBBLE_EDIT_DRAFT_PREFIX = 'jeikcode:bubble_edit_draft:';
export const NEW_SESSION_DRAFT_KEY = '__new__';

export function getComposerDraftKey(sessionId: string | null | undefined): string {
  return `${STORAGE_KEY_COMPOSER_DRAFT_PREFIX}${sessionId || NEW_SESSION_DRAFT_KEY}`;
}

export function getBubbleEditDraftKey(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return `${STORAGE_KEY_BUBBLE_EDIT_DRAFT_PREFIX}${sessionId}`;
}

/**
 * 从本地存储加载主输入框草稿。
 * 跨页面刷新保留未发送的文字与图片附件。
 */
export function loadComposerDraft(sessionId: string | null | undefined): ComposerDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const key = getComposerDraftKey(sessionId);
    const raw = window.localStorage?.getItem(key) || window.sessionStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const images = Array.isArray(parsed.images) ? (parsed.images as ImageData[]) : [];
    if (!text && images.length === 0) return null;
    return { text, images: images.length > 0 ? images : undefined };
  } catch {
    return null;
  }
}

/**
 * 持久化主输入框草稿。
 * 内容为空时自动从存储中移除，释放空间。
 * 遇配额超限错误时尝试仅保留文本降级保存，避免抛错阻断界面。
 */
export function saveComposerDraft(
  sessionId: string | null | undefined,
  draft: ComposerDraft | null,
): void {
  if (typeof window === 'undefined') return;
  const key = getComposerDraftKey(sessionId);
  const text = draft?.text ?? '';
  const images = draft?.images ?? [];
  if (!text.trim() && images.length === 0) {
    try {
      window.localStorage?.removeItem(key);
      window.sessionStorage?.removeItem(key);
    } catch {}
    return;
  }
  const payload: ComposerDraft = {
    text,
    images: images.length > 0 ? images : undefined,
  };
  try {
    const serialized = JSON.stringify(payload);
    window.localStorage?.setItem(key, serialized);
    window.sessionStorage?.setItem(key, serialized);
  } catch {
    // 若因图片过多触发 LocalStorage QuotaExceededError，尝试仅保留文本草稿
    try {
      const textOnly = JSON.stringify({ text, images: undefined });
      window.localStorage?.setItem(key, textOnly);
      window.sessionStorage?.setItem(key, textOnly);
    } catch {}
  }
}

/**
 * 彻底清除指定会话的主输入框草稿。
 */
export function clearComposerDraft(sessionId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    const key = getComposerDraftKey(sessionId);
    window.localStorage?.removeItem(key);
    window.sessionStorage?.removeItem(key);
  } catch {}
}

/**
 * 从本地存储加载消息气泡编辑草稿。
 * 跨页面刷新保留正在编辑的消息索引、改写文字、多图附件及选中的模型。
 */
export function loadBubbleEditDraft(sessionId: string | null | undefined): BubbleEditDraft | null {
  if (typeof window === 'undefined') return null;
  const key = getBubbleEditDraftKey(sessionId);
  if (!key) return null;
  try {
    const raw = window.localStorage?.getItem(key) || window.sessionStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.sourceIndex !== 'number') return null;
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const images = Array.isArray(parsed.images) ? (parsed.images as ImageData[]) : [];
    const selectedModel = typeof parsed.selectedModel === 'string' ? parsed.selectedModel : undefined;
    return {
      sourceIndex: parsed.sourceIndex,
      text,
      images: images.length > 0 ? images : undefined,
      selectedModel,
    };
  } catch {
    return null;
  }
}

/**
 * 持久化消息气泡编辑草稿。
 */
export function saveBubbleEditDraft(
  sessionId: string | null | undefined,
  draft: BubbleEditDraft | null,
): void {
  if (typeof window === 'undefined') return;
  const key = getBubbleEditDraftKey(sessionId);
  if (!key) return;
  if (!draft) {
    try {
      window.localStorage?.removeItem(key);
      window.sessionStorage?.removeItem(key);
    } catch {}
    return;
  }
  const payload: BubbleEditDraft = {
    sourceIndex: draft.sourceIndex,
    text: draft.text ?? '',
    images: draft.images && draft.images.length > 0 ? draft.images : undefined,
    selectedModel: draft.selectedModel,
  };
  try {
    const serialized = JSON.stringify(payload);
    window.localStorage?.setItem(key, serialized);
    window.sessionStorage?.setItem(key, serialized);
  } catch {
    try {
      const textOnly = JSON.stringify({
        ...payload,
        images: undefined,
      });
      window.localStorage?.setItem(key, textOnly);
      window.sessionStorage?.setItem(key, textOnly);
    } catch {}
  }
}

/**
 * 彻底清除指定会话的消息气泡编辑草稿。
 */
export function clearBubbleEditDraft(sessionId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  const key = getBubbleEditDraftKey(sessionId);
  if (!key) return;
  try {
    window.localStorage?.removeItem(key);
    window.sessionStorage?.removeItem(key);
  } catch {}
}
