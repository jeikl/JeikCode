/**
 * Legacy wire adapter — the ONLY place allowed to infer display semantics from
 * raw protocol text.
 *
 * New daemons send `display_text` / `internal` / `editable`, so the canvas,
 * outline and cache never parse protocol strings on the authoritative path.
 * Everything below exists solely for daemons and caches written before those
 * fields (capability window = one minor release).
 */

const INTERNAL_USER_PREFIXES = [
  '<system-reminder>',
  '<strong-reminder>',
  'You made code edits but have not verified them.',
  'Output limit hit — your last response was cut off',
  'Output limit hit. If the task is already complete',
  '[PLAN MODE',
  '[Context was compressed',
  '[Additional context from user]:',
  '[SYNTAX CHECK:',
  '[DEV SERVER ERROR',
  '[Auto-read from error:',
  '[Images returned by the tool calls above',
];

/** Marker written by the daemon ahead of a mid-turn steer note. */
const STEER_MARKER = '[jeikcode-steer]';

export function isInternalHistoryUserMessage(text: string, synthetic?: boolean): boolean {
  if (synthetic === true) return true;
  const trimmed = text.trimStart();
  return INTERNAL_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** UI-only: the steer note is for the model. The bubble keeps the user's words. */
export function stripSteerEnvelopeForDisplay(text: string): string {
  const match = text.match(/<user-query>\s*([\s\S]*?)\s*<\/user-query>/i);
  if (match) {
    const inner = match[1].trim();
    if (inner === '(The user attached image(s))' || inner === '（用户附加了新的图片）') {
      return '';
    }
    return inner;
  }
  let clean = text;
  const idx = clean.indexOf(STEER_MARKER);
  if (idx >= 0) {
    clean = clean.slice(0, idx).trim();
  }
  clean = clean.replace(/<\/?user-query>/gi, '').trim();
  if (clean === '(The user attached image(s))' || clean === '（用户附加了新的图片）') {
    return '';
  }
  return clean;
}

/** UI-only: drop appended `<system-reminder>` / `<strong-reminder>` tails. */
export function stripInjectedRemindersForDisplay(text: string): string {
  const stripTag = (input: string, open: string, close: string): string => {
    let rest = input;
    let out = '';
    while (true) {
      const start = rest.indexOf(open);
      if (start < 0) {
        out += rest;
        break;
      }
      out += rest.slice(0, start);
      const end = rest.indexOf(close, start + open.length);
      if (end < 0) {
        out += rest.slice(start);
        break;
      }
      rest = rest.slice(end + close.length);
    }
    return out;
  };
  const withoutSys = stripTag(text, '<system-reminder>', '</system-reminder>');
  const withoutStrong = stripTag(withoutSys, '<strong-reminder>', '</strong-reminder>');
  return withoutStrong.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip the daemon's VL annotation block for non-vision models. It is internal
 * context appended after the user's text (`\n\n[图片内容（由 X 识别）]\n…` or
 * `\n\n[图片识别失败]`), never something the user typed.
 */
export function stripVisionAnnotation(text: string): string {
  const markers = ['\n\n[图片内容（由', '[图片内容（由', '\n\n[图片识别失败]', '[图片识别失败]'];
  let cut = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (cut < 0 || index < cut)) cut = index;
  }
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}

/** Full legacy pipeline for a user row's visible text. */
export function legacyUserDisplayText(content: string): string {
  return stripSteerEnvelopeForDisplay(
    stripInjectedRemindersForDisplay(stripVisionAnnotation(content)),
  );
}

const VISION_ANNOTATION_MARKERS = [
  '\n\n[图片内容（由',
  '[图片内容（由',
  '\n\n[图片识别失败]',
  '[图片识别失败]',
];

/** Legacy visible text: VL marker + steer envelope + injected reminders. */
export function visibleUserText(text: string): string {
  return stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(stripVisionAnnotation(text)))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * Legacy text comparison. Only valid when a row has NO id; never use it as the
 * primary identity on the authoritative path.
 */
export function legacyUserTextsMatch(a: string, b: string): boolean {
  const left = visibleUserText(a);
  const right = visibleUserText(b);
  if (left === right) return true;
  if (!left || !right) return left === right;

  const normLeft = left.replace(/\s+/g, ' ').trim().toLowerCase();
  const normRight = right.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normLeft === normRight) return true;

  // Disk history is stripped; live/watch echo may still carry the caption.
  if (left.startsWith(right) || right.startsWith(left)) {
    const longer = left.length >= right.length ? left : right;
    const shorter = left.length >= right.length ? right : left;
    const rest = longer.slice(shorter.length);
    if (rest.trim() === '') return true;
    return VISION_ANNOTATION_MARKERS.some((marker) => rest.includes(marker.replace(/^\n\n/, '')));
  }
  return false;
}

export interface WireDisplayFields {
  display_text?: string;
  content?: string;
  internal?: boolean;
  synthetic?: boolean;
  editable?: boolean;
  role?: string;
  internal_origin?: string;
  internalOrigin?: string;
}

/** Server text first; protocol parsing only when the daemon did not send it. */
export function resolveUserDisplayText(msg: WireDisplayFields): string {
  // `display_text` is server-authored, but steered prompts still carry the
  // model-only `<user-query>` / `[jeikcode-steer]` envelope in that field.
  // Run the legacy sanitizer even on the authoritative path; it is idempotent
  // for ordinary text and prevents raw protocol instructions from becoming a
  // visible user bubble.
  if (msg.display_text != null) return legacyUserDisplayText(msg.display_text);
  return legacyUserDisplayText(msg.content ?? '');
}

/** Server visibility first; synthetic/prefix guessing is the legacy fallback. */
export function resolveInternal(msg: WireDisplayFields): boolean {
  if (msg.internal != null) return msg.internal;
  return msg.synthetic === true
    || isInternalHistoryUserMessage(msg.content ?? '', msg.synthetic);
}

/**
 * Server mutation permission first. `undefined` means "no opinion" (assistant
 * and tool rows); callers only disable editing when this returns `false`.
 */
export function resolveEditable(msg: WireDisplayFields): boolean | undefined {
  if (msg.editable != null) return msg.editable;
  const origin = msg.internal_origin ?? msg.internalOrigin;
  if (origin) {
    return !(origin === 'transcript_archive'
      || origin === 'presentation'
      || origin === 'pending_input');
  }
  if (msg.role === 'user') return msg.synthetic !== true;
  return undefined;
}
