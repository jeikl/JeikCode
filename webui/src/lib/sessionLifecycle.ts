/**
 * Session lifecycle decision (P1-A).
 *
 * The canvas may render from cache, but only the server may declare a turn
 * finished/absent. This pure function centralises the idle/standby/live
 * decision so the cache fast path, cold load and terminal path cannot drift.
 */
export type SessionPhase = 'standby' | 'live' | 'terminal';

export interface SessionLifecycleInput {
  /** `/chat/active` says this session currently has a turn. */
  serverActive: boolean;
  /** A local turn was admitted by this tab. */
  localTurn?: boolean;
  /** A background watcher owns this session. */
  backgroundTurn?: boolean;
  /** The authoritative terminal already settled in this document. */
  terminalSettled?: boolean;
}

export interface SessionLifecycle {
  phase: SessionPhase;
  watch: 'standby' | 'detached' | 'none';
  busy: boolean;
}

export function resolveSessionLifecycle(input: SessionLifecycleInput): SessionLifecycle {
  if (input.terminalSettled) {
    return { phase: 'terminal', watch: 'none', busy: false };
  }
  if (input.serverActive || input.localTurn || input.backgroundTurn) {
    return { phase: 'live', watch: 'detached', busy: true };
  }
  return { phase: 'standby', watch: 'standby', busy: false };
}
