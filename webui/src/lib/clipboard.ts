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

/** Build HTML clipboard payload: data-URL image + plain text (for insecure HTTP). */
export function buildCopyHtml(dataUrl: string, text: string): string {
  const img = `<img src="${dataUrl}">`;
  if (!text) return img;
  return `${img}<br>${escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>')}`;
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
    const key = raw.slice(0, 96);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = dataUrlToFile(raw, `paste-image-${++index}`);
    if (file) files.push(file);
  }
  return files;
}

/** Prefer native file items; otherwise recover images from text/html data URLs. */
export function collectClipboardFiles(dt: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length > 0) return files;
  const html = dt.getData?.('text/html') ?? '';
  return extractDataUrlImagesFromHtml(html);
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

/** Modern ClipboardItem path (HTTPS / localhost secure context). */
async function copyViaClipboardItem(text: string, blob: Blob, mime: string): Promise<boolean> {
  const clipboard = navigator.clipboard as Clipboard & {
    write?: (items: ClipboardItem[]) => Promise<void>;
  };
  if (typeof ClipboardItem === 'undefined' || !clipboard?.write) return false;

  const attempts: Array<Record<string, Blob | Promise<Blob>>> = [];
  if (text) {
    attempts.push({
      [mime]: blob,
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    attempts.push({
      [mime]: Promise.resolve(blob),
      'text/plain': Promise.resolve(new Blob([text], { type: 'text/plain' })),
    });
  }
  attempts.push({ [mime]: blob });
  attempts.push({ [mime]: Promise.resolve(blob) });

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
 * Select a real <img> + text and execCommand('copy').
 * Works on many Chromium builds even over plain HTTP LAN/public `--host`.
 */
function copyViaDomSelection(dataUrl: string, text: string): boolean {
  const host = document.createElement('div');
  host.contentEditable = 'true';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  host.appendChild(img);
  if (text) {
    host.appendChild(document.createElement('br'));
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
function copyViaClipboardEvent(dataUrl: string, text: string): boolean {
  const html = buildCopyHtml(dataUrl, text);
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
 * Copy text + first image (QQ/Telegram style).
 * Tries secure ClipboardItem first, then HTTP-safe DOM/HTML fallbacks so any
 * machine that can open `--host` WebUI can copy image+text — not only localhost.
 */
export async function copyTextAndImage(
  text: string,
  image?: CopyImage | null,
): Promise<boolean> {
  if (!image?.data) return copyTextToClipboard(text);

  const dataUrl = imageToDataUrl(image);
  try {
    const blob = await dataUrlToBlob(dataUrl);
    const mime = blob.type || image.media_type || 'image/png';
    if (await copyViaClipboardItem(text, blob, mime)) return true;
  } catch {
    /* fall through to HTTP-safe paths */
  }

  if (copyViaDomSelection(dataUrl, text)) return true;
  if (copyViaClipboardEvent(dataUrl, text)) return true;
  return copyTextToClipboard(text);
}
