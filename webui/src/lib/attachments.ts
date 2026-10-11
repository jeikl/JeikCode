import type { ImageData } from '../api';

/** Max attached images per message and per-image byte cap (raw file size). */
export const MAX_IMAGES = 6;
export const MAX_IMAGE_MB = 8;
export const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

/** Supported multimodal image MIME types (Anthropic, OpenAI, Gemini compatible). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const ACCEPTED_IMAGE_INPUT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/*';

export const MAX_IMAGE_DIMENSION = 2560;
export const MAX_PANORAMA_DIMENSION = 4096;
export const JPEG_QUALITY = 0.90;

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

export interface ImageDimensions {
  width: number;
  height: number;
}

export function normalizeMimeType(type: string): string {
  return type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function guessImageMediaType(name: string): string | null {
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

export function isImageFile(file: File): boolean {
  const type = normalizeMimeType(file.type);
  if (type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i.test(file.name);
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

/**
 * 计算严格等比例缩放后的尺寸（Strict Aspect Ratio Preservation）。
 * 绝不拉伸、挤压或裁切画面内容。长宽均采用同一缩放因子 scale。
 */
export function calculateScaleDimensions(
  width: number,
  height: number,
  maxDimension = MAX_IMAGE_DIMENSION,
  maxPanoramaDimension = MAX_PANORAMA_DIMENSION,
): ImageDimensions {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 };
  const maxSide = Math.max(width, height);
  const minSide = Math.min(width, height);
  const aspectRatio = minSide > 0 ? maxSide / minSide : 1;
  // 长宽比超过 2.5:1 的长截图自适应放宽上限至 4096px，确保代码和文字清晰
  const bound = aspectRatio >= 2.5 ? maxPanoramaDimension : maxDimension;
  const scale = Math.min(1, bound / maxSide);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 读取文件为原始 Base64 Data URL */
function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * 将 File 转换为大模型兼容的 ImageData。
 * 1. 拦截超过 MAX_IMAGE_BYTES (8MB) 的超大文件；
 * 2. 动图 GIF 优先保留原始动态帧；
 * 3. 对高分辨率手机长图/截图执行严格等比自适应缩放（锁定宽高比，杜绝画面拉伸/畸形）；
 * 4. 自动将 iOS HEIC / BMP 等非标准格式转码为各大模型原生支持的 image/jpeg；
 * 5. 在缺少 DOM 环境（如 Node.js 单元测试）下提供安全回退。
 */
export async function fileToImageData(file: File): Promise<ImageData | null> {
  if (!isImageFile(file) || file.size > MAX_IMAGE_BYTES) {
    return null;
  }

  const normalizedType = normalizeMimeType(file.type);
  const guessedType = guessImageMediaType(file.name);
  const rawMime = normalizedType && normalizedType.startsWith('image/') ? normalizedType : guessedType;

  // GIF 动图不通过 Canvas 重绘（避免丢帧变成静态图），直接保留原始数据
  if (rawMime === 'image/gif') {
    const dataUrl = await readAsDataUrl(file);
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? { media_type: 'image/gif', data: dataUrl.slice(comma + 1) } : null;
  }

  // 缺少 DOM / Canvas 环境时的无头安全回退（如 Node.js 测试环境）
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    const dataUrl = await readAsDataUrl(file);
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    const mediaType = (rawMime && ACCEPTED_IMAGE_TYPES.includes(rawMime as typeof ACCEPTED_IMAGE_TYPES[number]))
      ? rawMime
      : 'image/jpeg';
    return comma >= 0 ? { media_type: mediaType, data: dataUrl.slice(comma + 1) } : null;
  }

  // 浏览器环境：加载图片并进行尺寸与兼容性分析
  return new Promise<ImageData | null>((resolve) => {
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = async () => {
      URL.revokeObjectURL(blobUrl);
      const naturalWidth = img.naturalWidth || img.width;
      const naturalHeight = img.naturalHeight || img.height;

      if (!naturalWidth || !naturalHeight) {
        resolve(null);
        return;
      }

      const targetDim = calculateScaleDimensions(naturalWidth, naturalHeight);
      const scaleNoop = targetDim.width === naturalWidth && targetDim.height === naturalHeight;
      const isStandardMime = rawMime && (rawMime === 'image/png' || rawMime === 'image/jpeg' || rawMime === 'image/webp');

      // 若分辨率无需缩放、格式已经是标准大模型格式、且大小在 2MB 以内，直接复用原图 Base64，100% 原始画质
      if (scaleNoop && isStandardMime && file.size <= 2 * 1024 * 1024) {
        const rawDataUrl = await readAsDataUrl(file);
        if (rawDataUrl) {
          const comma = rawDataUrl.indexOf(',');
          if (comma >= 0) {
            resolve({ media_type: rawMime, data: rawDataUrl.slice(comma + 1) });
            return;
          }
        }
      }

      // 需要等比自适应缩放或转码（如手机高分辨率大图、超 2MB 图片、或 iOS 的 HEIC 格式）
      try {
        const canvas = document.createElement('canvas');
        canvas.width = targetDim.width;
        canvas.height = targetDim.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        // 高保真平滑缩放
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetDim.width, targetDim.height);

        // 如果是轻量且无需缩放的 PNG 则保持 PNG；大图、照片及其他格式统一输出高质量 JPEG (0.90)
        const exportMime = (rawMime === 'image/png' && scaleNoop && file.size <= 2 * 1024 * 1024)
          ? 'image/png'
          : 'image/jpeg';

        const exportUrl = canvas.toDataURL(exportMime, exportMime === 'image/jpeg' ? JPEG_QUALITY : undefined);
        const comma = exportUrl.indexOf(',');
        if (comma >= 0) {
          resolve({ media_type: exportMime, data: exportUrl.slice(comma + 1) });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    };

    img.onerror = async () => {
      URL.revokeObjectURL(blobUrl);
      // 降级尝试：直接读取原文件数据
      const rawDataUrl = await readAsDataUrl(file);
      if (!rawDataUrl) {
        resolve(null);
        return;
      }
      const comma = rawDataUrl.indexOf(',');
      const mediaType = (rawMime && ACCEPTED_IMAGE_TYPES.includes(rawMime as typeof ACCEPTED_IMAGE_TYPES[number]))
        ? rawMime
        : 'image/jpeg';
      resolve(comma >= 0 ? { media_type: mediaType, data: rawDataUrl.slice(comma + 1) } : null);
    };

    img.src = blobUrl;
  });
}
