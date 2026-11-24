// Desktop-only IPC bridge for the terminal CLI check module.
// The desktop shell delegates to the bundled CLI's hidden `self` commands;
// this module only types the JSON and wraps Tauri invoke.

export type TerminalCliState =
  | 'not_installed'
  | 'owned_current'
  | 'owned_outdated'
  | 'external'
  | 'external_newer'
  | 'package_managed'
  | 'path_missing'
  | 'error';

export interface TerminalCliEntry {
  path: string;
  version?: string | null;
  source: 'desktop' | 'user' | 'package_manager' | 'system' | 'unknown' | string;
  owned: boolean;
  active: boolean;
}

export interface TerminalCliMarker {
  installer: string;
  path: string;
  version: string;
  sha256: string;
  installed_at: string;
  rc_files: string[];
  prefix: string;
}

export interface TerminalCliStatus {
  platform: string;
  state: TerminalCliState | string;
  desktop_cli: TerminalCliEntry;
  target_path: string;
  target?: TerminalCliEntry | null;
  active?: TerminalCliEntry | null;
  active_is_target: boolean;
  active_on_path: boolean;
  entries: TerminalCliEntry[];
  path_has_target: boolean;
  shell: string;
  rc_files: string[];
  writable: boolean;
  managed_by_installer: boolean;
  marker?: TerminalCliMarker | null;
  can_install: boolean;
  can_update: boolean;
  can_replace: boolean;
  can_switch: boolean;
  can_repair_path: boolean;
  error?: string | null;
}

export interface TerminalCliInstallResult {
  success: boolean;
  path: string;
  version: string;
  backed_up?: string | null;
  rc_files: string[];
  path_added: boolean;
  path_already_present: boolean;
  error?: string | null;
}

export interface TerminalCliUninstallResult {
  success: boolean;
  removed_path?: string | null;
  rc_files: string[];
  error?: string | null;
}

type TauriCore = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function tauriCore(): TauriCore | null {
  const tauri = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  return tauri?.core ?? null;
}

export function hasTerminalCliIpc(): boolean {
  return typeof tauriCore()?.invoke === 'function';
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = tauriCore();
  if (!core || typeof core.invoke !== 'function') {
    return Promise.reject(new Error('terminal CLI check is only available in the desktop app'));
  }
  return core.invoke.call(core, cmd, args) as Promise<T>;
}

export function getTerminalCliStatus(): Promise<TerminalCliStatus> {
  return invoke<TerminalCliStatus>('terminal_check_status');
}

export function installTerminalCli(options: {
  replace?: boolean;
  ensurePath?: boolean;
  pathOnly?: boolean;
}): Promise<TerminalCliInstallResult> {
  return invoke<TerminalCliInstallResult>('terminal_install_cli', {
    options: {
      replace: options.replace ?? false,
      ensurePath: options.ensurePath ?? true,
      pathOnly: options.pathOnly ?? false,
    },
  });
}

export function uninstallTerminalCli(): Promise<TerminalCliUninstallResult> {
  return invoke<TerminalCliUninstallResult>('terminal_uninstall_cli');
}
