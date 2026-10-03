// When the WebUI should raise a corner card or an OS toast.
//
// Build, Plan, and Accept edits park on each review, so those prompts are shown.
// Auto (`bypass`) does not: only a finished or stopped turn is notified.
// A structured question still has to be answerable in Auto, or the turn stalls.

export type NotifyApprovalMode = 'build' | 'plan' | 'bypass' | 'accept_edits';

export type TerminalKind = 'completed' | 'stopped' | 'failed';

export interface TerminalEdge {
  sessionId: string;
  seq: number;
  kind: TerminalKind;
}

const FAILED_REASONS = new Set([
  'provider_error',
  'timeout',
  'prompt_rejected',
  'policy_denied',
  'internal_error',
]);

/** Tool-approval cards and their OS pings. Auto never parks on these. */
export function showPermissionNotice(mode: NotifyApprovalMode | null | undefined): boolean {
  return mode !== 'bypass';
}

/** OS toast for a review. The corner card is the focused UI; the OS toast is for when the window is away. */
export function shouldOsNotifyReview(
  mode: NotifyApprovalMode | null | undefined,
  windowAway: boolean,
): boolean {
  return showPermissionNotice(mode) && windowAway;
}

/** Every mode, including Auto, toasts when a turn finishes or the session stops. */
export function shouldOsNotifyTerminal(): boolean {
  return true;
}

export function terminalKindFromDone(stopReason: string | undefined): TerminalKind {
  if (stopReason === undefined || stopReason === '' || stopReason === 'stopped') {
    return 'completed';
  }
  if (stopReason === 'cancelled') return 'stopped';
  if (FAILED_REASONS.has(stopReason)) return 'failed';
  return 'stopped';
}

export function isTerminalKind(value: string | null | undefined): value is TerminalKind {
  return value === 'completed' || value === 'stopped' || value === 'failed';
}

/**
 * The first poll is a baseline: record seqs and stay quiet so opening the page
 * does not replay turns that already finished.
 * After that, a higher seq emits one edge. A session that appears already
 * finished (the whole turn landed between polls) emits too.
 * A jump of several seqs is still one notice, so a done+stopped pair in the
 * same gap does not double-fire.
 */
export function takeTerminalEdges(
  seen: Map<string, number>,
  rows: Array<{ sessionId: string; seq: number; kind: string | null | undefined }>,
  options?: { baseline?: boolean },
): TerminalEdge[] {
  const baseline = options?.baseline === true;
  const edges: TerminalEdge[] = [];
  const live = new Set<string>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    live.add(row.sessionId);
    const seq = Number.isFinite(row.seq) ? row.seq : 0;
    const prev = seen.get(row.sessionId);
    if (prev === undefined) {
      seen.set(row.sessionId, seq);
      if (!baseline && seq > 0 && isTerminalKind(row.kind)) {
        edges.push({ sessionId: row.sessionId, seq, kind: row.kind });
      }
      continue;
    }
    if (seq > prev && isTerminalKind(row.kind)) {
      edges.push({ sessionId: row.sessionId, seq, kind: row.kind });
    }
    if (seq !== prev) seen.set(row.sessionId, seq);
  }
  for (const id of [...seen.keys()]) {
    if (!live.has(id)) seen.delete(id);
  }
  return edges;
}

/** Same session and kind inside the window is one toast (poll racing a second seq). */
export function shouldEmitNotice(
  recent: Map<string, number>,
  key: string,
  now: number,
  windowMs: number,
): boolean {
  const prev = recent.get(key);
  if (prev !== undefined && now - prev < windowMs) return false;
  recent.set(key, now);
  return true;
}

export function sessionNoticeLabel(input: {
  id: string;
  name?: string | null;
  workingDir?: string | null;
}): string {
  const name = input.name?.trim();
  if (name && !name.startsWith('session-') && !name.startsWith('optimistic-')) return name;
  const folder = (input.workingDir ?? '')
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .pop();
  const short = input.id.slice(0, 8);
  return folder ? `${folder} · ${short}` : short || input.id;
}
