import type { DesktopHostUpdateInfo, UpdateCheckResponse } from '../api';
import { normalizeUpgradeVersion } from './upgradeReload.ts';

export type UpdateExecutionMode = 'binary' | 'desktop';
export type PathBEngine = 'tauri_native' | 'backend_assisted' | 'manual' | 'none';

export interface UpdatePlan {
  inDesktopWindow: boolean;
  hasTauriIpc: boolean;
  desktopHost: DesktopHostUpdateInfo | null;
  canPathA: boolean;
  canPathB: boolean;
  pathBEngine: PathBEngine;
  defaultMode: UpdateExecutionMode;
  shellRequired: boolean;
  legacyStep2Ready: boolean;
  remoteReadonlyBlocked: boolean;
}

export function hasNativeTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke);
}

function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase();
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1' || bare === '[::1]';
}

export function isLocalDesktopWindow(): boolean {
  if (typeof window === 'undefined') return false;
  if (hasNativeTauriRuntime()) return true;
  if (!isLoopbackHost(window.location.hostname)) return false;
  try {
    if (new URLSearchParams(window.location.search).get('desktop') === '1') {
      return true;
    }
    return window.sessionStorage.getItem('jeikcode_desktop') === '1';
  } catch {
    return false;
  }
}

export function hasEffectiveUpdate(info?: UpdateCheckResponse | null): boolean {
  if (!info) return false;
  if (info.has_update) return true;
  return isLocalDesktopWindow() && Boolean(info.desktop_host?.shell_has_update);
}

export function compareUpdateSemver(latest?: string | null, current?: string | null): boolean {
  const parse = (raw?: string | null) => {
    const clean = normalizeUpgradeVersion(raw);
    if (!clean) return null;
    const idx = clean.indexOf('-');
    const mainPart = idx >= 0 ? clean.slice(0, idx) : clean;
    const prePart = idx >= 0 ? clean.slice(idx + 1) : '';
    const nums = mainPart.split('.').map((s) => Number.parseInt(s, 10) || 0);
    const pre = prePart ? prePart.split('.') : null;
    return { nums, pre };
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  const maxLen = Math.max(l.nums.length, c.nums.length);
  for (let i = 0; i < maxLen; i++) {
    const lv = l.nums[i] ?? 0;
    const cv = c.nums[i] ?? 0;
    if (lv !== cv) return lv > cv;
  }
  if (!l.pre && c.pre) return true;
  if (l.pre && !c.pre) return false;
  if (!l.pre && !c.pre) return false;
  const lp = l.pre!;
  const cp = c.pre!;
  const maxPre = Math.max(lp.length, cp.length);
  for (let i = 0; i < maxPre; i++) {
    const a = lp[i];
    const b = cp[i];
    if (a === undefined && b !== undefined) return false;
    if (a !== undefined && b === undefined) return true;
    if (a !== b && a !== undefined && b !== undefined) {
      const na = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
      const nb = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
      if (na !== null && nb !== null) return na > nb;
      if (na !== null) return false;
      if (nb !== null) return true;
      return a > b;
    }
  }
  return false;
}

export function resolvePathBEngine(input: {
  desktopHost: DesktopHostUpdateInfo | null;
  hasTauriIpc: boolean;
  isLatestPick: boolean;
}): PathBEngine {
  const { desktopHost, hasTauriIpc, isLatestPick } = input;
  if (!desktopHost) return 'none';
  if (
    hasTauriIpc &&
    desktopHost.signed_updater_ready &&
    desktopHost.native_updater_supported &&
    isLatestPick &&
    Boolean(desktopHost.updater_json_url)
  ) {
    return 'tauri_native';
  }
  if (
    desktopHost.native_updater_supported &&
    Boolean(desktopHost.installer_url) &&
    Boolean(desktopHost.installer_sha256)
  ) {
    return 'backend_assisted';
  }
  if (desktopHost.installer_url) {
    return 'manual';
  }
  return 'none';
}

export function resolveUpdatePlan(input: {
  info: UpdateCheckResponse | null;
  targetVersion: string;
  isLatestPick: boolean;
  forceReinstall: boolean;
  inDesktopWindow: boolean;
  hasTauriIpc: boolean;
}): UpdatePlan {
  const { info, targetVersion, isLatestPick, forceReinstall, inDesktopWindow, hasTauriIpc } = input;
  const hostMeta = info?.desktop_host ?? null;
  const desktopHost = inDesktopWindow ? hostMeta : null;
  const binaryWritable = hostMeta ? hostMeta.binary_writable : true;
  const remoteReadonlyBlocked = !inDesktopWindow && Boolean(hostMeta && !hostMeta.binary_writable);

  const shellRequired = Boolean(
    desktopHost &&
    (
      !binaryWritable ||
      (isLatestPick && desktopHost.shell_update_required) ||
      (desktopHost.min_shell_version &&
        desktopHost.shell_version &&
        compareUpdateSemver(desktopHost.min_shell_version, desktopHost.shell_version))
    ),
  );

  const backendNeedsUpdate = Boolean(
    targetVersion &&
    (!isLatestPick || info?.has_update || forceReinstall),
  );
  const canPathA = binaryWritable && !remoteReadonlyBlocked && (!inDesktopWindow || !shellRequired) && backendNeedsUpdate;

  const pathBEngine = resolvePathBEngine({
    desktopHost,
    hasTauriIpc,
    isLatestPick,
  });

  const shellTargetOutdated = Boolean(
    desktopHost &&
    targetVersion &&
    (
      desktopHost.legacy_shell ||
      (desktopHost.shell_version && compareUpdateSemver(targetVersion, desktopHost.shell_version)) ||
      (isLatestPick && desktopHost.shell_has_update)
    ),
  );
  const canPathB = Boolean(
    inDesktopWindow &&
    desktopHost &&
    pathBEngine !== 'none' &&
    (shellTargetOutdated || shellRequired || forceReinstall || !isLatestPick),
  );

  const legacyStep2Ready = Boolean(
    inDesktopWindow &&
    desktopHost?.legacy_shell &&
    !info?.has_update &&
    desktopHost.shell_has_update &&
    canPathB,
  );

  let defaultMode: UpdateExecutionMode = 'binary';
  if (!inDesktopWindow) {
    defaultMode = 'binary';
  } else if (!canPathA && canPathB) {
    defaultMode = 'desktop';
  } else if (desktopHost?.legacy_shell && info?.has_update && canPathA) {
    // 存量老壳先跑第 1 跳热更内核，刷新后再执行第 2 跳一键升级外壳
    defaultMode = 'binary';
  } else if (legacyStep2Ready) {
    defaultMode = 'desktop';
  } else if (desktopHost?.shell_changed && desktopHost?.shell_has_update && canPathB) {
    defaultMode = 'desktop';
  } else if (canPathA) {
    defaultMode = 'binary';
  } else if (canPathB) {
    defaultMode = 'desktop';
  }

  return {
    inDesktopWindow,
    hasTauriIpc,
    desktopHost,
    canPathA,
    canPathB,
    pathBEngine,
    defaultMode,
    shellRequired,
    legacyStep2Ready,
    remoteReadonlyBlocked,
  };
}
