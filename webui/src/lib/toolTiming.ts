/** Formatting + resolution for the per-tool `switch` / `cost` metrics badge. */

export function formatToolTiming(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface ToolTimingLike {
  status: string;
  started_at?: number;
  finished_at?: number;
  duration_ms?: number;
}

/**
 * Resolve the displayed `cost`:
 * - a settled daemon measurement always wins (frozen);
 * - otherwise derive it from the persisted anchors (still frozen);
 * - only a running row grows with the (server) clock.
 */
export function resolveToolCostMs(
  tool: ToolTimingLike,
  nowMs: number,
): number | undefined {
  if (tool.duration_ms != null && Number.isFinite(tool.duration_ms)) {
    return Math.max(0, tool.duration_ms);
  }
  if (tool.started_at != null && tool.finished_at != null) {
    return Math.max(0, tool.finished_at - tool.started_at);
  }
  if (tool.started_at != null && tool.status === 'pending') {
    return Math.max(0, nowMs - tool.started_at);
  }
  return undefined;
}
