import type { CapabilityItem, CapKind, CapScope } from '../api';

export interface PendingCapabilityToggle {
  kind: CapKind;
  id: string;
  scope: CapScope;
  disabled: boolean;
}

export function capabilityPendingKey(kind: CapKind, id: string, scope: CapScope): string {
  return `${kind}:${id}:${scope}`;
}

/**
 * Overlay in-flight toggle intents on a server snapshot.
 *
 * A menu-open `/capabilities` fetch can resolve AFTER the user clicked a toggle.
 * Without this overlay that older snapshot replaces the optimistic row and the
 * switch visibly flips back. The entry is removed only after a post-write
 * reconcile, so a late response can never win.
 */
export function withPendingCapabilityOverrides(
  items: CapabilityItem[],
  pending: Iterable<PendingCapabilityToggle>,
): CapabilityItem[] {
  const intents = Array.from(pending);
  if (intents.length === 0) return items;

  let changed = false;
  const next = items.map((item) => {
    let globalDisabled = item.global_disabled;
    let projectDisabled = item.project_disabled;
    for (const intent of intents) {
      if (intent.kind !== item.kind || intent.id !== item.id) continue;
      if (intent.scope === 'global') globalDisabled = intent.disabled;
      else projectDisabled = intent.disabled;
    }
    if (
      globalDisabled === item.global_disabled &&
      projectDisabled === item.project_disabled
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      global_disabled: globalDisabled,
      project_disabled: projectDisabled,
      effective_disabled: globalDisabled || projectDisabled,
    };
  });
  return changed ? next : items;
}

/** Only the newest request for the project still on screen may touch state. */
export function isCapabilityRefreshCurrent(
  seq: number,
  latestSeq: number,
  requestProjectKey: string,
  currentProjectKey: string,
): boolean {
  return seq === latestSeq && requestProjectKey === currentProjectKey;
}

/** Cross-platform comparison for capability project directories. */
export function normalizeCapabilityDir(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
