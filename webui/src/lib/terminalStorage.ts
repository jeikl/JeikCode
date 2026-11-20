/**
 * 终端面板轻量级元数据与本地持久化工具。
 *
 * 独立拆出（不导入 `@xterm/*` 依赖），供主入口与角标计数直接读取，
 * 让 1.3 MB 的终端仿真器及其插件彻底按需懒加载。
 */

export interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
  shell?: string;
  timestamp: number;
}

export interface ShellOption {
  id: string;
  name: string;
  icon: string;
}

export type HostPlatform = 'windows' | 'macos' | 'linux';

export const SHELL_CONFIGS: Record<HostPlatform, ShellOption[]> = {
  windows: [
    { id: 'powershell', name: 'PowerShell', icon: '›' },
    { id: 'cmd', name: 'CMD', icon: '›' },
    { id: 'gitbash', name: 'Git Bash', icon: '›' },
    { id: 'wsl', name: 'WSL (Ubuntu)', icon: '›' },
  ],
  macos: [
    { id: 'zsh', name: 'Zsh', icon: '›' },
    { id: 'bash', name: 'Bash', icon: '›' },
  ],
  linux: [
    { id: 'bash', name: 'Bash', icon: '›' },
    { id: 'zsh', name: 'Zsh', icon: '›' },
    { id: 'sh', name: 'Sh', icon: '›' },
  ],
};

export function resolveHostPlatform(cwd?: string): HostPlatform {
  const trimmed = (cwd || '').trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:[/\\]/.test(trimmed) || /^[/\\][a-zA-Z]:/.test(trimmed) || /^\/[a-zA-Z]\//.test(trimmed)) {
    return 'windows';
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const cached = window.localStorage.getItem('jeikcode:host_platform');
      if (cached === 'windows' || cached === 'macos' || cached === 'linux') {
        return cached as HostPlatform;
      }
    }
  } catch {}
  if (trimmed.startsWith('/Users/')) return 'macos';
  if (trimmed.startsWith('/')) return 'linux';

  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    const isMobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
    if (!isMobile) {
      if (/mac/i.test(ua) || /macintosh|macintel/i.test(navigator.platform)) return 'macos';
      if (/linux/i.test(ua) || /linux/i.test(navigator.platform)) return 'linux';
      if (/win/i.test(ua) || /windows/i.test(navigator.platform)) return 'windows';
    }
  }
  return 'linux';
}

export function getPlatformShells(platform: HostPlatform = 'windows'): ShellOption[] {
  return SHELL_CONFIGS[platform] || SHELL_CONFIGS.windows;
}

export function getDefaultShellForPlatform(platform: HostPlatform = 'windows'): string {
  return platform === 'windows' ? 'powershell' : platform === 'macos' ? 'zsh' : 'bash';
}

export function getMainstreamShell(platform: HostPlatform = 'windows'): string {
  return getDefaultShellForPlatform(platform);
}

export function inferShellFromTab(tab: { name?: string; shell?: string }, platform?: HostPlatform): string {
  const p = platform || resolveHostPlatform();
  const direct = (tab.shell || '').toLowerCase().trim();
  if (direct) {
    if (direct.includes('git') || (direct.includes('bash') && p === 'windows')) return 'gitbash';
    if (direct.includes('wsl') || direct.includes('ubuntu')) return 'wsl';
    if (direct.includes('cmd')) return p === 'windows' ? 'cmd' : 'bash';
    if (direct.includes('zsh')) return 'zsh';
    if (direct.includes('power') || direct.includes('pwsh')) {
      return p === 'windows' ? 'powershell' : (p === 'macos' ? 'zsh' : 'bash');
    }
    if (direct.includes('bash')) return p === 'windows' ? 'gitbash' : 'bash';
    if (direct.includes('sh')) return 'sh';
    return direct;
  }
  const name = (tab.name || '').toLowerCase().trim();
  if (name.includes('git') || (name.includes('bash') && p === 'windows')) return 'gitbash';
  if (name.includes('wsl') || name.includes('ubuntu')) return 'wsl';
  if (name.includes('cmd')) return p === 'windows' ? 'cmd' : 'bash';
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('power') || name.includes('pwsh')) {
    return p === 'windows' ? 'powershell' : (p === 'macos' ? 'zsh' : 'bash');
  }
  return getDefaultShellForPlatform(p);
}

const normCwdKey = (projectCwd?: string) =>
  (projectCwd || 'default').replace(/\\/g, '/').trim().toLowerCase();

export const getProjectTerminalStorageKey = (projectCwd?: string) =>
  `jeikcode:terminal:sessions:${normCwdKey(projectCwd)}`;

const getClosedFlagKey = (projectCwd?: string) =>
  `jeikcode:terminal:all_closed:${normCwdKey(projectCwd)}`;

export function areAllTerminalsClosed(projectCwd?: string): boolean {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(getClosedFlagKey(projectCwd)) === '1';
    }
  } catch {}
  return false;
}

export function markAllTerminalsClosed(projectCwd: string | undefined, closed: boolean): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const key = getClosedFlagKey(projectCwd);
      if (closed) {
        window.localStorage.setItem(key, '1');
      } else {
        window.localStorage.removeItem(key);
      }
    }
  } catch {}
}

export function getSavedSessions(projectCwd?: string): TerminalTab[] | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const key = getProjectTerminalStorageKey(projectCwd);
      const raw = window.sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const plat = resolveHostPlatform(projectCwd);
          return parsed.map((t) => {
            const shell = inferShellFromTab(t, plat);
            let name = t.name;
            if (plat !== 'windows' && name && name.toLowerCase().includes('powershell')) {
              name = name.replace(/powershell/gi, shell);
            }
            return {
              ...t,
              name,
              shell,
            };
          });
        }
      }
    }
  } catch {}
  return null;
}

export function saveSessions(tabs: TerminalTab[], projectCwd?: string): void {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const key = getProjectTerminalStorageKey(projectCwd);
      const plat = resolveHostPlatform(projectCwd);
      const normalized = tabs.map((t) => ({
        ...t,
        shell: inferShellFromTab(t, plat),
      }));
      window.sessionStorage.setItem(key, JSON.stringify(normalized));
    }
  } catch {}
}

export function getSavedActiveTab(projectCwd?: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage.getItem(`jeikcode:terminal:active_tab:${normCwdKey(projectCwd)}`);
    }
  } catch {}
  return null;
}

export function saveActiveTab(tabId: string, projectCwd?: string): void {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(`jeikcode:terminal:active_tab:${normCwdKey(projectCwd)}`, tabId);
    }
  } catch {}
}

/** 仅反映已知已保存的终端数量，不再默认强加幽灵计数 1。 */
export function getSavedTerminalCount(projectCwd?: string): number {
  if (areAllTerminalsClosed(projectCwd)) return 0;
  const saved = getSavedSessions(projectCwd);
  return saved ? saved.length : 0;
}

interface PendingTerminalRunCommand {
  command: string;
  shell?: string;
}

const pendingRunCommands: PendingTerminalRunCommand[] = [];

type TerminalRunHandler = (command: string, shell?: string) => void;

let activeTerminalRunHandler: TerminalRunHandler | null = null;

/** 懒加载终端面板尚未挂载前先暂存命令，待终端挂载后立即消费执行。 */
export function queuePendingTerminalCommand(command: string, shell?: string): void {
  if (!command) return;
  pendingRunCommands.push({ command, shell });
}

export function drainPendingTerminalCommands(): PendingTerminalRunCommand[] {
  if (pendingRunCommands.length === 0) return [];
  return pendingRunCommands.splice(0, pendingRunCommands.length);
}

/** 立即在已挂载终端运行，若尚未懒加载挂载则先入队等待挂载后执行。 */
export function dispatchOrQueueTerminalCommand(command: string, shell?: string): void {
  if (!command) return;
  if (activeTerminalRunHandler) {
    activeTerminalRunHandler(command, shell);
  } else {
    queuePendingTerminalCommand(command, shell);
  }
}

/** 由 `TerminalPanel` 在挂载后注册命令执行回调并排空积压队列。 */
export function registerTerminalRunHandler(handler: TerminalRunHandler): () => void {
  activeTerminalRunHandler = handler;
  const queued = drainPendingTerminalCommands();
  for (const item of queued) {
    handler(item.command, item.shell);
  }
  return () => {
    if (activeTerminalRunHandler === handler) {
      activeTerminalRunHandler = null;
    }
  };
}
