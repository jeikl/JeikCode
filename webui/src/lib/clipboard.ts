/** Clipboard helpers that work on localhost, LAN IP, and public HTTP `--host` URLs. */

export type CopyImage = {
  media_type: string;
  data: string;
};

export function imageToDataUrl(img: CopyImage): string {
  return `data:${img.media_type};base64,${img.data}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build HTML clipboard payload: data-URL images + plain text (for insecure HTTP and rich copy). */
export function buildCopyHtml(dataUrls: string | string[], text: string): string {
  const urls = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
  const imgs = urls.map((u) => `<img src="${u}">`).join('<br>');
  if (!text) return imgs;
  return `${imgs}<br>${escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>')}`;
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

/** Decode a data URL into a File (for paste fallback from text/html). */
export function dataUrlToFile(dataUrl: string, nameBase = 'paste-image'): File | null {
  const cleaned = dataUrl.replace(/\s+/g, '');
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(cleaned);
  if (!match) return null;
  const mime = match[1];
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `${nameBase}.${extForMime(mime)}`, { type: mime });
  } catch {
    return null;
  }
}

/** Pull `data:image/...;base64,...` sources out of HTML clipboard markup. */
export function extractDataUrlImagesFromHtml(html: string): File[] {
  if (!html) return [];
  const files: File[] = [];
  const seen = new Set<string>();
  const re = /src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .trim();
    if (!raw.toLowerCase().startsWith('data:image/')) continue;
    // Full payload: a short prefix is shared by every PNG and would drop later images.
    if (seen.has(raw)) continue;
    seen.add(raw);
    const file = dataUrlToFile(raw, `paste-image-${++index}`);
    if (file) files.push(file);
  }
  return files;
}

/**
 * Prefer native file items for a real file paste.
 * A multi-image copy can only put one image in the binary clipboard slot; the rest
 * live in text/html. When that HTML carries more images than the native file list,
 * it is the complete payload and the lone native image is just the first picture.
 */
export function collectClipboardFiles(dt: DataTransfer): File[] {
  const native: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) native.push(file);
  }
  const html = dt.getData?.('text/html') ?? '';
  const fromHtml = extractDataUrlImagesFromHtml(html);
  if (fromHtml.length === 0) return native;
  const nativeImages = native.filter((file) => (file.type || '').toLowerCase().startsWith('image/'));
  if (fromHtml.length > nativeImages.length) {
    const nonImages = native.filter((file) => !(file.type || '').toLowerCase().startsWith('image/'));
    return [...nonImages, ...fromHtml];
  }
  if (native.length > 0) return native;
  return fromHtml;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return fetch(dataUrl).then((r) => r.blob());
}

/** Modern ClipboardItem path (HTTPS / localhost secure context). Supports multiple images via text/html. */
async function copyViaClipboardItem(
  text: string,
  firstBlob: Blob | null,
  firstMime: string | null,
  htmlPayload?: string,
): Promise<boolean> {
  const clipboard = navigator.clipboard as Clipboard & {
    write?: (items: ClipboardItem[]) => Promise<void>;
  };
  if (typeof ClipboardItem === 'undefined' || !clipboard?.write) return false;

  const attempts: Array<Record<string, Blob | Promise<Blob>>> = [];

  // Attempt 1: Full rich payload (Primary image binary + text/html + text/plain)
  const fullItem: Record<string, Blob> = {};
  if (firstBlob && firstMime) fullItem[firstMime] = firstBlob;
  if (htmlPayload) fullItem['text/html'] = new Blob([htmlPayload], { type: 'text/html' });
  if (text) fullItem['text/plain'] = new Blob([text], { type: 'text/plain' });
  if (Object.keys(fullItem).length > 0) {
    attempts.push(fullItem);
  }

  // Attempt 2: HTML + Plain Text (Multi-image safe across browsers)
  if (htmlPayload) {
    const htmlOnly: Record<string, Blob> = {
      'text/html': new Blob([htmlPayload], { type: 'text/html' }),
    };
    if (text) htmlOnly['text/plain'] = new Blob([text], { type: 'text/plain' });
    attempts.push(htmlOnly);
  }

  // Attempt 3: Single binary image + plain text fallback
  if (firstBlob && firstMime && text) {
    attempts.push({
      [firstMime]: firstBlob,
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
  }

  for (const payload of attempts) {
    try {
      await clipboard.write([new ClipboardItem(payload)]);
      return true;
    } catch {
      /* try next shape */
    }
  }
  return false;
}

/**
 * Select real <img>s + text and execCommand('copy').
 * Works on Chromium builds even over plain HTTP LAN/public `--host`.
 */
function copyViaDomSelection(dataUrls: string[], text: string): boolean {
  const host = document.createElement('div');
  host.contentEditable = 'true';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
  for (const url of dataUrls) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    host.appendChild(img);
    host.appendChild(document.createElement('br'));
  }
  if (text) {
    host.appendChild(document.createTextNode(text));
  }
  document.body.appendChild(host);

  const selection = window.getSelection();
  const previous: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) previous.push(selection.getRangeAt(i));
    selection.removeAllRanges();
  }
  const range = document.createRange();
  range.selectNodeContents(host);
  selection?.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    selection?.removeAllRanges();
    for (const r of previous) selection?.addRange(r);
    document.body.removeChild(host);
  }
  return ok;
}

/** Force text/html + text/plain onto the clipboard via the copy event (HTTP-safe). */
function copyViaClipboardEvent(dataUrls: string[], text: string): boolean {
  const html = buildCopyHtml(dataUrls, text);
  let wrote = false;
  const onCopy = (event: ClipboardEvent) => {
    try {
      event.clipboardData?.setData('text/html', html);
      if (text) event.clipboardData?.setData('text/plain', text);
      event.preventDefault();
      wrote = true;
    } catch {
      wrote = false;
    }
  };
  document.addEventListener('copy', onCopy, true);
  try {
    document.execCommand('copy');
    return wrote;
  } catch {
    return wrote;
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

/**
 * Copy text + all images into the clipboard.
 * Preserves all attached pictures in text/html and primary image binary,
 * so pasting into WebUI or rich-text apps restores every image and text.
 */
export async function copyTextAndImages(
  text: string,
  images?: CopyImage[] | null,
): Promise<boolean> {
  const validImages = (images ?? []).filter((img) => !!img?.data);
  if (validImages.length === 0) return copyTextToClipboard(text);

  const dataUrls = validImages.map(imageToDataUrl);
  const html = buildCopyHtml(dataUrls, text);

  let firstBlob: Blob | null = null;
  let firstMime: string | null = null;
  try {
    firstBlob = await dataUrlToBlob(dataUrls[0]);
    firstMime = firstBlob.type || validImages[0].media_type || 'image/png';
  } catch {
    /* ignore */
  }

  try {
    // Several images cannot share one binary clipboard slot. Write HTML first so a
    // paste does not stop at the primary image and drop the rest.
    if (validImages.length > 1 && await copyViaClipboardItem(text, null, null, html)) return true;
    if (await copyViaClipboardItem(text, firstBlob, firstMime, html)) return true;
  } catch {
    /* fall through to HTTP-safe paths */
  }

  if (copyViaDomSelection(dataUrls, text)) return true;
  if (copyViaClipboardEvent(dataUrls, text)) return true;
  return copyTextToClipboard(text);
}

/** Legacy single-image adapter, preserving backward compatibility. */
export async function copyTextAndImage(
  text: string,
  image?: CopyImage | null,
): Promise<boolean> {
  return copyTextAndImages(text, image ? [image] : []);
}
