import type { ImageData } from '../api';

/** Max attached images per message and per-image byte cap (raw file size). */
export const MAX_IMAGES = 6;
export const MAX_IMAGE_MB = 2;
export const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

/** Max non-image uploads per message and per-file byte cap. */
export const MAX_FILES = 10;
export const MAX_FILE_MB = 20;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

export type PendingImage = {
  id: string;
  kind: 'image';
  image: ImageData;
};

export type PendingFile = {
  id: string;
  kind: 'file';
  name: string;
  size: number;
  file: File;
};

export type PendingAttach = PendingImage | PendingFile;

export function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name);
}

export function countPending(attach: PendingAttach[]): { images: number; files: number } {
  let images = 0;
  let files = 0;
  for (const item of attach) {
    if (item.kind === 'image') images += 1;
    else files += 1;
  }
  return { images, files };
}

/** Build the user-turn text: original prompt, then numbered attachment paths. */
export function formatUserMessageWithAttachments(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  const lines = paths.map((path, i) => `附件${i + 1}：${path}`);
  const body = text.trim();
  return body ? `${body}\n\n${lines.join('\n')}` : lines.join('\n');
}

export function fileToImageData(file: File): Promise<ImageData | null> {
  return new Promise((resolve) => {
    if (!isImageFile(file) || file.size > MAX_IMAGE_BYTES) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      const mediaType = file.type && file.type.startsWith('image/')
        ? file.type
        : guessImageMediaType(file.name);
      resolve(comma >= 0 && mediaType ? { media_type: mediaType, data: result.slice(comma + 1) } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

function guessImageMediaType(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}
