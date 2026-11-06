import type { ImageData } from '../api';
import type { PendingAttach, PendingImage } from './attachments';

export function sameImageSet(a?: ImageData[], b?: ImageData[]): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every(
    (img, i) => img.media_type === right[i]?.media_type && img.data === right[i]?.data,
  );
}

export function imagesToPending(images: ImageData[]): PendingImage[] {
  return images.map((image) => ({ id: crypto.randomUUID(), kind: 'image', image }));
}

export function pendingImageData(attach: PendingAttach[]): ImageData[] {
  return attach
    .filter((item): item is PendingImage => item.kind === 'image')
    .map((item) => item.image);
}
