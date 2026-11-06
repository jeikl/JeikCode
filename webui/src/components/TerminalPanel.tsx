import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  createTerminalSession,
  fetchTerminalList,
  closeTerminalSession,
  sendTerminalInput,
} from '../api';
import { showToast } from './Toast';
import { useT, useSettings } from '../settings';
import { getPageZoom } from '../lib/pageZoom';

function measureTerminalGrid(term: Terminal, container: HTMLElement): { cols: number; rows: number } | null {
  const core = (term as unknown as {
    _core?: {
      _renderService?: {
        dimensions?: { css?: { cell?: { width?: number; height?: number } } };
      };
    };
  })._core;
  let cellW = core?._renderService?.dimensions?.css?.cell?.width || 0;
  let cellH = core?._renderService?.dimensions?.css?.cell?.height || 0;

  // 兜底与动态校准：若 renderService 尚未刷出 dimensions（或由于隐藏处于 paused），
  // 按照等宽字体比例基于当前 fontSize 精准推算，确保网格始终铺满且计算可用
  if (cellW <= 0 || cellH <= 0) {
    const fs = term.options.fontSize || 12;
    // Cascadia Mono / Consolas 等宽字体的长宽比通常为 0.605 : 1
    cellW = Math.round(fs * 0.605 * 100) / 100;
    cellH = Math.round(fs * (term.options.lineHeight || 1) * 1.25 * 100) / 100;
  }
  if (cellW <= 0 || cellH <= 0) return null;

  const style = window.getComputedStyle(container);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  // 与 @xterm/addon-fit 一样预留 14px 滚动条，避免最后一列被挡住后提前换行。
  const scrollbar = term.options.scrollback === 0 ? 0 : 14;
  const availW = Math.max(0, container.clientWidth - padX - scrollbar);
  const availH = Math.max(0, container.clientHeight - padY);
  if (availW < cellW || availH < cellH) return null;
  return {
    cols: Math.max(2, Math.min(500, Math.floor(availW / cellW))),
    rows: Math.max(1, Math.min(200, Math.floor(availH / cellH))),
  };
}

export interface TerminalPanelProps {
  cwd?: string;
  active?: boolean;
  onTabsCountChange?: (count: number) => void;
}

export function getSavedTerminalCount(projectCwd?: string): number {
  const saved = getSavedSessions(projectCwd);
  return saved && saved.length > 0 ? saved.length : 1;
}

export interface ShellOption {
  id: string;
  name: string;
  icon: string;
}

export type HostPlatform = 'windows' | 'macos' | 'linux';

export const SHELL_CONFIGS: Record<HostPlatform, ShellOption[]> = {
  windows: [
    { id: 'powershell', name: 'PowerShell', icon: '⚡' },
    { id: 'cmd', name: 'CMD', icon: '⬛' },
    { id: 'gitbash', name: 'Git Bash', icon: '🌲' },
    { id: 'wsl', name: 'WSL (Ubuntu)', icon: '🐧' },
  ],
  macos: [
    { id: 'zsh', name: 'Zsh', icon: '🐚' },
    { id: 'bash', name: 'Bash', icon: '🐚' },
  ],
  linux: [
    { id: 'bash', name: 'Bash', icon: '🐚' },
    { id: 'zsh', name: 'Zsh', icon: '🐚' },
    { id: 'sh', name: 'Sh', icon: '🐚' },
  ],
};

export function resolveHostPlatform(cwd?: string): HostPlatform {
  const trimmed = (cwd || '').trim().replace(/\\/g, '/');
  // 1. 如果路径含有 Windows 盘符特征（例如 E:/code/jeikcode 或 C:\... 或 /c/...），100% 确定宿主机为 Windows！
  if (/^[a-zA-Z]:[/\\]/.test(trimmed) || /^[/\\][a-zA-Z]:/.test(trimmed) || /^\/[a-zA-Z]\//.test(trimmed)) {
    return 'windows';
  }
  // 2. 本地持久化缓存的真实宿主机平台 (由后端 API 返回并记住)
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const cached = window.localStorage.getItem('jeikcode:host_platform');
      if (cached === 'windows' || cached === 'macos' || cached === 'linux') {
        return cached as HostPlatform;
      }
    }
  } catch {}
  // 3. 常见路径推断 (Unix 绝对路径)
  if (trimmed.startsWith('/Users/')) return 'macos';
  // 关键修复：任何以 / 开头的绝对路径（如 /root, /root/..., /home/..., /var/..., /etc/..., /tmp/..., /usr/... 等），
  // 只要不属于 Windows 虚拟挂载盘符，必然为 Linux / Unix 宿主机！
  if (trimmed.startsWith('/')) return 'linux';

  // 4. 客户端自身判定（仅在桌面浏览器且无盘符时作为弱参考）
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

export const PLATFORM_SHELLS: ShellOption[] = SHELL_CONFIGS.windows;
export const DEFAULT_SHELL = 'powershell';

export function getMainstreamShell(platform: HostPlatform = 'windows'): string {
  return getDefaultShellForPlatform(platform);
}

const DARK_TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(56, 139, 253, 0.4)',
  black: '#282c34',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff',
  foreground: '#1e293b',
  cursor: '#0f172a',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(37, 99, 235, 0.25)',
  black: '#0f172a',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
  shell?: string;
  timestamp: number;
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

const getProjectTerminalStorageKey = (projectCwd?: string) => {
  const norm = (projectCwd || 'default').replace(/\\/g, '/').trim().toLowerCase();
  return `jeikcode:terminal:sessions:${norm}`;
};

function getSavedSessions(projectCwd?: string): TerminalTab[] | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const key = getProjectTerminalStorageKey(projectCwd);
      const raw = window.sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
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

function saveSessions(tabs: TerminalTab[], projectCwd?: string) {
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

function getSavedActiveTab(projectCwd?: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const norm = (projectCwd || 'default').replace(/\\/g, '/').trim().toLowerCase();
      return window.sessionStorage.getItem(`jeikcode:terminal:active_tab:${norm}`);
    }
  } catch {}
  return null;
}

function saveActiveTab(tabId: string, projectCwd?: string) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const norm = (projectCwd || 'default').replace(/\\/g, '/').trim().toLowerCase();
      window.sessionStorage.setItem(`jeikcode:terminal:active_tab:${norm}`, tabId);
    }
  } catch {}
}

export function TerminalPanel({ cwd, active, onTabsCountChange }: TerminalPanelProps) {
  const t = useT();
  const { theme, effectiveTheme } = useSettings();
  const isDark = effectiveTheme ? effectiveTheme === 'dark' : (theme === 'dark');

  const sessionScopeKey = cwd || 'default';

  const stableDefaultId = useMemo(() => {
    const norm = (cwd || 'default').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    return `term_main_${norm}`;
  }, [cwd]);

  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    const saved = getSavedSessions(cwd);
    if (saved && saved.length > 0) return saved;
    const norm = (cwd || 'default').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const id = `term_main_${norm}`;
    // 首个标签必须跟随宿主机真实平台（Windows→PowerShell，macOS→Zsh，Linux→Bash）。
    // 此前硬编码 DEFAULT_SHELL('powershell')：非 Windows 宿主上标签名写着 powershell，
    // 后端却按 bash 启动实际进程，导致“标签名与真实终端不一致”。
    const shell = getDefaultShellForPlatform(resolveHostPlatform(cwd));
    return [
      {
        id,
        name: `${shell} 1`,
        cwd: cwd || '.',
        shell,
        timestamp: 0,
      },
    ];
  });

  const [activeTabId, setActiveTabIdState] = useState<string>(() => {
    const saved = getSavedActiveTab(cwd);
    if (saved && tabs.some((t) => t.id === saved)) return saved;
    return tabs[0]?.id || '';
  });

  const setActiveTabId = useCallback(
    (idOrFn: string | ((prev: string) => string)) => {
      setActiveTabIdState((prev) => {
        const next = typeof idOrFn === 'function' ? idOrFn(prev) : idOrFn;
        saveActiveTab(next, cwd);
        return next;
      });
    },
    [cwd]
  );

  const [hostPlatform, setHostPlatform] = useState<HostPlatform>(() => resolveHostPlatform(cwd));
  const isHostWin = hostPlatform === 'windows';
  const currentPlatformShells = getPlatformShells(hostPlatform);

  useEffect(() => {
    const detected = resolveHostPlatform(cwd);
    if (detected !== hostPlatform) {
      setHostPlatform(detected);
    }
  }, [cwd, hostPlatform]);

  useEffect(() => {
    onTabsCountChange?.(tabs.length);
  }, [tabs.length, onTabsCountChange]);
  const [shellDropdownOpen, setShellDropdownOpen] = useState(false);
  const shellDropdownRef = useRef<HTMLDivElement>(null);

  const [preferredShell, setPreferredShell] = useState<string>(() => {
    const initPlat = resolveHostPlatform(cwd);
    const validIds = getPlatformShells(initPlat).map((s) => s.id);
    try {
      const stored = localStorage.getItem('jeikcode:terminal_preferred_shell');
      if (stored && validIds.includes(stored)) return stored;
    } catch {}
    return getDefaultShellForPlatform(initPlat);
  });

  // 保证 preferredShell 与宿主机平台匹配 (例如手机访问 Windows 宿主时，自动纠正客户端历史存留的 'bash' 为 'powershell' 或 'gitbash')
  useEffect(() => {
    const validIds = currentPlatformShells.map((s) => s.id);
    if (!validIds.includes(preferredShell)) {
      const next = preferredShell === 'bash' && hostPlatform === 'windows' ? 'gitbash' : getDefaultShellForPlatform(hostPlatform);
      setPreferredShell(next);
      try {
        localStorage.setItem('jeikcode:terminal_preferred_shell', next);
      } catch {}
    }
  }, [hostPlatform, currentPlatformShells, preferredShell]);

  // 终端独立基础字号 (Ctrl+滚轮在终端内部独立缩放)
  const [termFontSize, setTermFontSize] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('jeikcode:terminal_fontsize')) || 12;
    } catch {
      return 12;
    }
  });
  const termFontSizeRef = useRef(termFontSize);
  termFontSizeRef.current = termFontSize;

  const panelRootRef = useRef<HTMLDivElement>(null);

  // 原生代输命令编辑框（打开终端时默认展开）
  const [scratchpadOpen, setScratchpadOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:terminal:scratchpad_open');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  const toggleScratchpad = () => {
    setScratchpadOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('jeikcode:terminal:scratchpad_open', String(next));
      } catch {}
      return next;
    });
  };
  const [scratchpadText, setScratchpadText] = useState(() => {
    try {
      return window.sessionStorage?.getItem(`jeikcode:terminal:scratchpad:${sessionScopeKey}`) || '';
    } catch {
      return '';
    }
  });

  // 每个 Tab 对应一个真实的 xterm 终端仿真器与 WebSocket 实例
  const pendingCommandsRef = useRef<Map<string, string>>(new Map());
  const termMap = useRef<
    Map<
      string,
      {
        term: Terminal;
        fitAddon: FitAddon;
        container: HTMLElement | null;
        ws: WebSocket | null;
        ro?: ResizeObserver;
        layoutSync?: (immediate: boolean, force?: boolean) => void;
        lastSentCols?: number;
        lastSentRows?: number;
      }
    >
  >(new Map());
  // 终端只在「用户主动打开/切换终端」时抢焦点。页面刷新时右侧终端可能仍是
  // 上次保存的 active tab，但焦点必须留给对话输入框，绝不能由挂载阶段抢走。
  const focusOnNextLayoutRef = useRef(false);
  const panelActiveRef = useRef(active !== false);

  // 画面失效标记：面板隐藏或页面挂起时置位，回来后必须整体重绘一次。
  // 只在真的可能失效时才重绘，避免无谓的 DOM 重绘（重绘会重建行节点、清掉终端里的文本选区）。
  const stalePaintRef = useRef(false);

  // 面板恢复可见时，把所有终端（含挂机后台标签）整屏重绘一次。
  // xterm v6 在容器不可见时会暂停渲染（RenderService._isPaused），期间所有渲染请求被丢弃，
  // 恢复可见只有命中“自愈标记”才会补画；挂机期间没有任何写入时标记不会置位，
  // 于是所有终端（不只是当前可见的那个）都会停在空白（黑屏）。
  //
  // 安全性：term.refresh() 只走渲染器重绘（CoreBrowserTerminal.refresh → RenderService.refreshRows），
  // 不经过 onData、不发送任何字节到 PTY、不做 resize，因此绝不会让已运行的终端掉线。
  // 这里只做重绘、不做尺寸同步：遍历后台终端触发 ConPTY resize 会打乱后台命令行对齐。
  const repaintAllTerminals = useCallback((force = false) => {
    if (!force && !stalePaintRef.current) return;
    stalePaintRef.current = false;
    for (const record of termMap.current.values()) {
      try {
        record.term.refresh(0, Math.max(0, record.term.rows - 1));
      } catch {}
    }
  }, []);

  // 1. 终端内部 Ctrl + 鼠标滚轮独立调整字号（在捕获阶段拦截，阻止触发全局缩放）
  useEffect(() => {
    const el = panelRootRef.current;
    if (!el) return;
    const handleCaptureWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const delta = e.deltaY < 0 ? 1 : -1;
        setTermFontSize((prev) => {
          const next = Math.max(9, Math.min(28, prev + delta));
          try {
            localStorage.setItem('jeikcode:terminal_fontsize', String(next));
          } catch {}
          return next;
        });
      }
    };
    el.addEventListener('wheel', handleCaptureWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener('wheel', handleCaptureWheel, { capture: true } as any);
    };
  }, []);

  // 1.5 捕获阶段拦截 Ctrl+Shift+C / Ctrl+Shift+V：
  // 彻底阻止 Chromium/Edge 默认触发开发者工具 Inspect Element，同时对齐终端与代发框的复制粘贴
  useEffect(() => {
    const el = panelRootRef.current;
    if (!el) return;
    const handleCaptureKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'c' || key === 'v') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          const isScratchpad = Boolean(
            document.activeElement &&
            document.activeElement.classList.contains('scratchpad-textarea')
          );

          if (key === 'c') {
            // 复制操作：严格区分代发框与终端内部
            if (isScratchpad) {
              const ta = document.activeElement as HTMLTextAreaElement;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const textToCopy = start !== end ? ta.value.slice(start, end) : ta.value;
              if (textToCopy) {
                void navigator.clipboard?.writeText(textToCopy);
                showToast(t('terminal.copied'), 'info');
              }
            } else {
              // 焦点在终端（xterm-helper-textarea 或终端视口内部）
              const activeRecord = termMap.current.get(activeTabId);
              const sel = activeRecord?.term.getSelection();
              if (sel) {
                void navigator.clipboard?.writeText(sel);
                showToast(t('terminal.copied'), 'info');
              }
            }
          } else if (key === 'v') {
            // 粘贴操作：严格区分代发框与终端内部
            if (isScratchpad) {
              const ta = document.activeElement as HTMLTextAreaElement;
              void navigator.clipboard?.readText().then((pasteText) => {
                if (pasteText) {
                  const start = ta.selectionStart ?? 0;
                  const end = ta.selectionEnd ?? 0;
                  const val = ta.value;
                  const next = val.slice(0, start) + pasteText + val.slice(end);
                  setScratchpadText(next);
                  requestAnimationFrame(() => {
                    ta.selectionStart = ta.selectionEnd = start + pasteText.length;
                    ta.focus();
                  });
                }
              });
            } else {
              // 焦点在终端内部：读取系统剪贴板并立即发送到后台 PTY 终端进行粘贴
              const activeRecord = termMap.current.get(activeTabId);
              if (activeRecord?.ws && activeRecord.ws.readyState === WebSocket.OPEN) {
                void navigator.clipboard?.readText().then((txt) => {
                  if (txt && activeRecord.ws && activeRecord.ws.readyState === WebSocket.OPEN) {
                    activeRecord.ws.send(txt.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
                  }
                });
              }
            }
          }
        }
      }
    };
    el.addEventListener('keydown', handleCaptureKeyDown, { capture: true });
    return () => {
      el.removeEventListener('keydown', handleCaptureKeyDown, { capture: true } as any);
    };
  }, [activeTabId, t]);

  // 字号变化先改格子，PTY 尺寸防抖后再通知。滚轮连缩放时如果每一步都 resize ConPTY，
  // 控制台会反复重绘并插入空行，提示符和命令就对不齐。
  useEffect(() => {
    for (const record of termMap.current.values()) {
      try {
        record.term.options.fontSize = termFontSize;
      } catch {}
    }
    const frame = requestAnimationFrame(() => {
      if (active === false) return;
      termMap.current.get(activeTabId)?.layoutSync?.(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [termFontSize, active, activeTabId]);

  // 页面缩放或窗口变化时，按同一套格子重新对齐当前终端。
  useEffect(() => {
    const onZoomOrResize = () => {
      if (active === false) return;
      requestAnimationFrame(() => {
        termMap.current.get(activeTabId)?.layoutSync?.(false);
      });
    };
    window.addEventListener('jeikcode:zoom_change', onZoomOrResize);
    window.addEventListener('resize', onZoomOrResize);
    return () => {
      window.removeEventListener('jeikcode:zoom_change', onZoomOrResize);
      window.removeEventListener('resize', onZoomOrResize);
    };
  }, [active, activeTabId]);

  // 终端主题跟随全局亮/暗：亮色模式用高对比浅色终端，暗色用经典深色终端。
  useEffect(() => {
    for (const { term } of termMap.current.values()) {
      term.options.theme = isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    }
  }, [isDark]);

  // 建立或重新连接指定 Tab 的 WebSocket PTY 串流（支持休眠唤醒与意外断线自愈）
  const connectTabSocket = useCallback(
    (
      tab: TerminalTab,
      record: {
        term: Terminal;
        fitAddon: FitAddon;
        ws: WebSocket | null;
        layoutSync?: (immediate: boolean, force?: boolean) => void;
        lastSentCols?: number;
        lastSentRows?: number;
      },
      isInitial = false
    ) => {
      if (
        record.ws &&
        (record.ws.readyState === WebSocket.OPEN || record.ws.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const tabShell = inferShellFromTab(tab, hostPlatform);
        const cols = Math.min(500, Math.max(2, record.term.cols || 80));
        const rows = Math.min(200, Math.max(1, record.term.rows || 24));
        let token = '';
        try {
          token =
            sessionStorage.getItem('jeikcode_webui_token') ||
            localStorage.getItem('jeikcode_webui_token') ||
            '';
        } catch {}
        if (!token) {
          try {
            const m = document.cookie.match(/jeikcode_webui(?:_\d+)?=([^;]+)/);
            if (m && m[1]) token = m[1].trim();
          } catch {}
        }
        if (!token) {
          try {
            const search = new URLSearchParams(window.location.search);
            token = search.get('token') || '';
          } catch {}
        }
        const wsUrl = `${protocol}//${window.location.host}/terminal/ws?id=${encodeURIComponent(tab.id)}&cwd=${encodeURIComponent(cwd || '')}&shell=${encodeURIComponent(tabShell)}&cols=${cols}&rows=${rows}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
        const ws = new WebSocket(wsUrl);
        record.lastSentCols = 0;
        record.lastSentRows = 0;
        record.ws = ws;

        let receivedAnyData = false;

        ws.onopen = () => {
          record.layoutSync?.(true, true);
          if (isInitial) {
            const initialCmd = pendingCommandsRef.current.get(tab.id);
            if (initialCmd) {
              pendingCommandsRef.current.delete(tab.id);
              setTimeout(() => {
                if (record.ws && record.ws.readyState === WebSocket.OPEN) {
                  const trimmed = initialCmd.trimEnd();
                  const normalized = trimmed.replace(/\r?\n/g, '\r') + '\r';
                  record.ws.send(normalized);
                  setTimeout(() => {
                    try {
                      record.term.focus();
                    } catch {}
                  }, 50);
                }
              }, 400);
            }
          }
        };

        ws.onmessage = (event) => {
          receivedAnyData = true;
          // 防御性剔除 Windows ConPTY 残留的光标查询序列 (\x1b[6n / \x1b[?6n)，
          // 彻底阻断 xterm.js 自动生成 CPR 响应（\x1b[1;1R）导致向终端敲入 1R1R。
          const raw = event.data;
          const clean = typeof raw === 'string' && raw.includes('\x1b[')
            ? raw.replace(/\x1b\[\??6n/g, '')
            : raw;
          if (clean) {
            record.term.write(clean);
          }
        };

        ws.onclose = () => {
          // 保留当前连接对象状态，等待唤醒重连
        };

        ws.onerror = () => {
          // 兜底提示：如果未能收到 WebSocket 数据，显示就绪提示符，绝不呈现全黑死寂窗口
          setTimeout(() => {
            if (!receivedAnyData && (!record.ws || record.ws.readyState !== WebSocket.OPEN)) {
              const promptChar = tabShell.includes('powershell') ? 'PS ' : tabShell.includes('cmd') ? '' : '$ ';
              const cwdDisplay = (cwd || '.').replace(/\\/g, '/');
              record.term.write(`\r\n\x1b[32m[JeikCode Terminal - ${tabShell}]\x1b[0m\r\n${promptChar}${cwdDisplay}> `);
            }
          }, 800);
        };
      } catch {}
    },
    [cwd]
  );

  // 绑定或挂载 Terminal 实例到对应 DOM 容器，装配全套官方 Addons 并连接 WebSocket PTY 串流
  const bindTerminalContainer = useCallback(
    (tab: TerminalTab, el: HTMLElement | null) => {
      if (!el) return;
      const tabId = tab.id;
      let record = termMap.current.get(tabId);
      if (!record) {
        const term = new Terminal({
          cursorBlink: true,
          cursorStyle: 'block',
          fontSize: termFontSizeRef.current,
          fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
          lineHeight: 1,
          letterSpacing: 0,
          theme: isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
          allowProposedApi: true,
          scrollback: 10000,
          windowsPty: isHostWin ? { backend: 'conpty' } : undefined,
        });

        // 1. 装载官方自适应尺寸插件（度量失败时的兜底）
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        // 2. 装载官方 Unicode11 字符宽度对齐插件（解决中文/Emoji错位）
        try {
          const unicode11Addon = new Unicode11Addon();
          term.loadAddon(unicode11Addon);
          term.unicode.activeVersion = '11';
        } catch {}

        // 3. 装载官方 Web 链接插件
        try {
          const webLinksAddon = new WebLinksAddon((_e, uri) => {
            window.open(uri, '_blank');
          });
          term.loadAddon(webLinksAddon);
        } catch {}

        term.open(el);

        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        let fitting = false;

        const measureAndFit = () => {
          const targetEl = termMap.current.get(tabId)?.container || el;
          if (!targetEl || targetEl.clientWidth < 40 || targetEl.clientHeight < 24) return;
          const grid = measureTerminalGrid(term, targetEl);
          if (!grid) {
            try {
              fitAddon.fit();
            } catch {}
            return;
          }
          if (grid.cols === term.cols && grid.rows === term.rows) return;
          fitting = true;
          try {
            term.resize(grid.cols, grid.rows);
          } catch {
          } finally {
            fitting = false;
          }
        };

        const sendPtySize = (force = false) => {
          const cur = termMap.current.get(tabId);
          if (!cur?.ws || cur.ws.readyState !== WebSocket.OPEN) return;
          const cols = term.cols;
          const rows = term.rows;
          if (cols < 2 || rows < 1) return;
          if (!force && cols === cur.lastSentCols && rows === cur.lastSentRows) return;
          cur.lastSentCols = cols;
          cur.lastSentRows = rows;
          cur.ws.send(JSON.stringify({ resize: { cols, rows } }));
        };

        // immediate：立刻把格子同步给 PTY（打开、切标签）。
        // 否则防抖，避免字号滚轮每一步都让 ConPTY 重绘并打乱命令对齐。
        const layoutSync = (immediate: boolean, force = false) => {
          measureAndFit();
          // xterm v6 内部用 IntersectionObserver 在容器不可见时暂停渲染（display:none 会命中），
          // 恢复可见时只有“隐藏期间发生过写入/尺寸变化”才会自愈重绘，否则视口会一直停在空白（黑屏）。
          // 这里无条件整屏重绘一次：可见时立刻出画；仍处于暂停态时 xterm 只记录待刷新标记，
          // 等真正恢复可见时由它自身补画，两条路径都能保证画面回来。
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
          } catch {}
          if (immediate) {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = null;
            sendPtySize(force);
            return;
          }
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            sendPtySize(force);
          }, 160);
        };

        const ro = new ResizeObserver(() => {
          layoutSync(false);
        });
        ro.observe(el);

        record = { term, fitAddon, container: el, ws: null, ro, layoutSync, lastSentCols: 0, lastSentRows: 0 };
        termMap.current.set(tabId, record);

        measureAndFit();
        connectTabSocket(tab, record, true);
        term.onData((data) => {
          const cur = termMap.current.get(tabId);
          if (cur?.ws && cur.ws.readyState === WebSocket.OPEN) {
            cur.ws.send(data);
          }
        });

        term.onResize(() => {
          if (fitting) return;
          layoutSync(false);
        });

        // 快捷键增强 (复制、粘贴)，坚决阻止浏览器拦截打开开发者工具
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
            const key = e.key.toLowerCase();
            if (key === 'c' || key === 'v') {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              return false;
            }
          }
          return true;
        });

        // 不在挂载阶段 focus：刷新时终端会被重建，focus 会把键盘从对话输入框抢走。
        // 用户点击终端视口时 xterm 自己会获取焦点；主动打开终端面板由下方 effect 处理。
      } else if (record.container !== el) {
        // 容器 DOM 节点发生变更（如切换 session 重新挂载、tabs 重排等）：
        // 1. 断开旧容器的 ResizeObserver 监听，并在新容器上重新建立监听
        try {
          record.ro?.disconnect();
        } catch {}
        record.container = el;

        // 2. 将终端 DOM 挂载到新容器
        if (record.term.element && record.term.element.parentElement !== el) {
          el.appendChild(record.term.element);
        } else if (!record.term.element) {
          record.term.open(el);
        }

        // 3. 重新建立 ResizeObserver 监听新的容器 el
        const ro = new ResizeObserver(() => {
          record?.layoutSync?.(false);
        });
        ro.observe(el);
        record.ro = ro;

        // 4. 强制执行自适应排版和刷新；焦点留待用户真正切到终端页签时再给。
        record.layoutSync?.(true, true);
      }
    },
    [isDark, t, cwd, preferredShell, connectTabSocket]
  );

  // 激活 Tab 切换 / 终端面板重新可见时：检查连接自愈、平滑重测；
  // 只有用户主动打开终端（或点击终端页签）才把焦点交给 xterm。
  useEffect(() => {
    const activeNow = active !== false;
    const becameActive = activeNow && !panelActiveRef.current;
    panelActiveRef.current = activeNow;
    const record = termMap.current.get(activeTabId);
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (record && activeTab) {
      const broken =
        !record.ws ||
        record.ws.readyState === WebSocket.CLOSED ||
        record.ws.readyState === WebSocket.CLOSING;
      if (broken) {
        // 面板从隐藏恢复时 active 会翻转，此处必须重做一次断线检查：
        // 切换右侧面板不会触发 visibilitychange / focus，若 WebSocket 已在隐藏期间断开，
        // 漏掉这次重连，终端就会永远停在空视口（黑屏）且无法再接收输出。
        connectTabSocket(activeTab, record, false);
      }
      if (!activeNow) return;
      const shouldFocus = becameActive || focusOnNextLayoutRef.current;
      focusOnNextLayoutRef.current = false;
      requestAnimationFrame(() => {
        try {
          record.layoutSync?.(true);
          record.term.refresh(0, Math.max(0, record.term.rows - 1));
          if (shouldFocus) record.term.focus();
        } catch {}
      });
    }
  }, [activeTabId, tabs, connectTabSocket, active]);

  // 当终端切回前台可见状态时 (active 变化或从隐藏恢复)，执行多阶段自愈重绘拟合，杜绝切后台尺寸坍缩与停在黑屏
  useEffect(() => {
    if (active === false) {
      // 面板进入隐藏：xterm 渲染被暂停，回来时必须整体重绘一次
      stalePaintRef.current = true;
      return;
    }
    // 先把全部终端（含挂机后台标签）强制重绘出来，再做当前可见终端的尺寸自愈。
    repaintAllTerminals(true);
    const activeRec = termMap.current.get(activeTabId);
    activeRec?.layoutSync?.(true);
    try {
      activeRec?.term.refresh(0, Math.max(0, (activeRec.term.rows || 1) - 1));
    } catch {}

    const timer1 = setTimeout(() => {
      termMap.current.get(activeTabId)?.layoutSync?.(false);
      repaintAllTerminals(true);
    }, 80);
    const timer2 = setTimeout(() => {
      termMap.current.get(activeTabId)?.layoutSync?.(true);
      repaintAllTerminals(true);
    }, 250);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [active, activeTabId, repaintAllTerminals]);

  // 页面离开切回（visibilitychange）、窗口恢复焦点（focus）时，自动健康检查并对断开的终端自愈重连
  useEffect(() => {
    const handleWakeup = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // 页面挂起：浏览器会冻结渲染，回来时画面可能已失效
        stalePaintRef.current = true;
        return;
      }
      for (const tab of tabs) {
        const record = termMap.current.get(tab.id);
        if (record) {
          if (!record.ws || record.ws.readyState === WebSocket.CLOSED || record.ws.readyState === WebSocket.CLOSING) {
            connectTabSocket(tab, record, false);
          }
        }
      }
      if (active !== false) {
        setTimeout(() => {
          termMap.current.get(activeTabId)?.layoutSync?.(true);
          repaintAllTerminals();
        }, 120);
      } else {
        // 页面从后台恢复时同样要重绘全部终端，避免挂机标签停在空白黑屏
        repaintAllTerminals();
      }
    };
    document.addEventListener('visibilitychange', handleWakeup);
    window.addEventListener('focus', handleWakeup);
    return () => {
      document.removeEventListener('visibilitychange', handleWakeup);
      window.removeEventListener('focus', handleWakeup);
    };
  }, [tabs, active, activeTabId, connectTabSocket, repaintAllTerminals]);

  // 同步并拉取后端项目常驻终端会话（跨页面刷新、多标签、异地访问保持强一致广播同步，彻底消除死尸缓存污染）
  const syncWithBackend = useCallback(async () => {
    try {
      const res = await fetchTerminalList(cwd);
      if (res.success) {
        if (res.platform && res.platform !== hostPlatform) {
          setHostPlatform(res.platform);
          try {
            localStorage.setItem('jeikcode:host_platform', res.platform);
          } catch {}
        }
        const activePlat = res.platform || hostPlatform;
        const enriched = (res.terminals || []).map((t: TerminalTab) => {
          const inferred = inferShellFromTab(t, activePlat);
          let name = t.name;
          // 关键修复：如果宿主机是 Linux/macOS，但之前标签名被错误赋为 powershell 1 等，自动更正标签名称
          if (activePlat !== 'windows' && name && name.toLowerCase().includes('powershell')) {
            name = name.replace(/powershell/gi, inferred);
          } else if (activePlat === 'windows' && name && name.toLowerCase().startsWith('bash') && !name.toLowerCase().includes('git')) {
            name = name.replace(/^bash/gi, 'gitbash');
          }
          return {
            ...t,
            name,
            shell: inferred,
          };
        });

        if (enriched.length > 0) {
          // 清理本地已经不在后端运行的无效记录
          const validIds = new Set(enriched.map((t: TerminalTab) => t.id));
          for (const [id, rec] of termMap.current.entries()) {
            if (!validIds.has(id)) {
              try { rec.ro?.disconnect(); } catch {}
              try { rec.ws?.close(); } catch {}
              try { rec.term.dispose(); } catch {}
              termMap.current.delete(id);
            }
          }

          // 以后端真实运行的列表为唯一真值，绝不将本地残留的死尸 merge 回去！
          setTabs(enriched);
          saveSessions(enriched, cwd);
          setActiveTabId((cur) => {
            const saved = getSavedActiveTab(cwd);
            if (saved && enriched.some((t: any) => t.id === saved)) return saved;
            const has = enriched.some((t: any) => t.id === cur);
            return has ? cur : enriched[0]!.id;
          });
        } else {
          // 如果后端已被清空（如在其他浏览器删除了所有终端），本地清理并仅保留一个新创建的干净初始会话！
          for (const [id, record] of termMap.current.entries()) {
            try { record.ro?.disconnect(); } catch {}
            try { record.ws?.close(); } catch {}
            try { record.term.dispose(); } catch {}
          }
          termMap.current.clear();
          const newId = stableDefaultId;
          const newTab: TerminalTab = {
            id: newId,
            name: `${preferredShell} 1`,
            cwd: cwd || '.',
            shell: preferredShell,
            timestamp: Date.now(),
          };
          setTabs([newTab]);
          saveSessions([newTab], cwd);
          setActiveTabId(newId);
        }
      }
    } catch {}
  }, [cwd, preferredShell]);

  useEffect(() => {
    void syncWithBackend();
  }, [syncWithBackend]);

  // 监听后端全局 SSE 广播（terminal_updated 事件）以及本地跨标签同步：实现全设备毫秒级强一致同步
  useEffect(() => {
    const handleRemoteUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<{ cwd?: string }>;
      const eventCwd = customEvent.detail?.cwd;
      const normCur = (cwd || '').replace(/\\/g, '/').toLowerCase();
      const normEvt = (eventCwd || '').replace(/\\/g, '/').toLowerCase();
      if (!normEvt || !normCur || normCur === normEvt || normCur.includes(normEvt) || normEvt.includes(normCur)) {
        void syncWithBackend();
      }
    };
    window.addEventListener('jeikcode:terminal:remote_updated', handleRemoteUpdate);
    return () => {
      window.removeEventListener('jeikcode:terminal:remote_updated', handleRemoteUpdate);
    };
  }, [cwd, syncWithBackend]);

  // 建立同一浏览器各标签页之间的即时广播通道 (0ms 无网络延迟本地同步)
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('jeikcode:terminal:sync');
    channel.onmessage = (e) => {
      const msgCwd = e.data?.cwd;
      const normCur = (cwd || '').replace(/\\/g, '/').toLowerCase();
      const normEvt = (msgCwd || '').replace(/\\/g, '/').toLowerCase();
      if (!normEvt || !normCur || normCur === normEvt || normCur.includes(normEvt) || normEvt.includes(normCur)) {
        void syncWithBackend();
      }
    };
    return () => {
      try { channel.close(); } catch {}
    };
  }, [cwd, syncWithBackend]);

  // 每次 tabs 状态变动时持久化同步，保障 background 级别的常驻生命周期
  useEffect(() => {
    saveSessions(tabs, cwd);
  }, [tabs, cwd]);

  // 同步代输命令框内容
  useEffect(() => {
    try {
      window.sessionStorage?.setItem(`jeikcode:terminal:scratchpad:${sessionScopeKey}`, scratchpadText);
    } catch {}
  }, [scratchpadText, sessionScopeKey]);

  // 创建新终端标签
  const createNewTab = useCallback(
    async (shellName = preferredShell, initialCommand?: string) => {
      // 用户主动新建终端：允许下一次布局把焦点交给新终端。
      focusOnNextLayoutRef.current = true;
      try {
        const res = await createTerminalSession({ shell: shellName, cwd });
        const newTab: TerminalTab = {
          id: res.terminal_id,
          name: `${res.name}`,
          cwd: res.cwd,
          shell: shellName,
          timestamp: Date.now(),
        };
        if (initialCommand) {
          pendingCommandsRef.current.set(newTab.id, initialCommand);
        }
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
      } catch {
        const mockId = `term_${Date.now().toString(36)}`;
        const fallbackTab: TerminalTab = {
          id: mockId,
          name: `${shellName} ${tabs.length + 1}`,
          cwd: cwd || '.',
          shell: shellName,
          timestamp: Date.now(),
        };
        if (initialCommand) {
          pendingCommandsRef.current.set(fallbackTab.id, initialCommand);
        }
        setTabs((prev) => [...prev, fallbackTab]);
        setActiveTabId(mockId);
      }
    },
    [cwd, tabs.length, preferredShell]
  );

  // 监听全局终端执行命令事件（如 /init 构建代码图谱自动拉起主流终端并执行）
  useEffect(() => {
    const handleRunCommand = (e: Event) => {
      const customEvent = e as CustomEvent<{ command: string; shell?: string }>;
      const { command, shell } = customEvent.detail || {};
      if (!command) return;
      const targetShell = shell || getMainstreamShell(hostPlatform);
      void createNewTab(targetShell, command);
    };
    window.addEventListener('jeikcode:terminal:run_command', handleRunCommand);
    return () => {
      window.removeEventListener('jeikcode:terminal:run_command', handleRunCommand);
    };
  }, [createNewTab, hostPlatform]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // 代输命令框发送
  const executeCommand = async (cmdText: string) => {
    if (!cmdText.trim() || !activeTab) return;
    const record = termMap.current.get(activeTab.id);
    const trimmed = cmdText.trimEnd();
    const normalized = trimmed.replace(/\r?\n/g, '\r') + '\r';
    if (record && record.ws && record.ws.readyState === WebSocket.OPEN) {
      record.ws.send(normalized);
      setTimeout(() => {
        try {
          record.term?.focus();
        } catch {}
      }, 50);
    } else {
      // 降级支持：通过 /terminal/input REST 接口直接向常驻会话投递
      try {
        if (record?.term) {
          record.term.write(`\r\n${cmdText.trim()}\r\n`);
        }
        const res = await sendTerminalInput(activeTab.id, cmdText);
        if (res.success && res.output && record?.term) {
          record.term.write(res.output.replace(/\r?\n/g, '\r\n'));
        }
      } catch {}
    }
  };

  const selectAndCreateShell = (shellId: string) => {
    setPreferredShell(shellId);
    try {
      localStorage.setItem('jeikcode:terminal_preferred_shell', shellId);
    } catch {}
    setShellDropdownOpen(false);
    void createNewTab(shellId);
  };

  // 关闭单个终端 Tab
  const closeTab = (tabId: string, e: MouseEvent) => {
    e.stopPropagation();
    if (tabs.length <= 1) {
      showToast(t('terminal.minOneSession'), 'info');
      return;
    }
    const record = termMap.current.get(tabId);
    if (record) {
      try {
        record.ro?.disconnect();
      } catch {}
      try {
        record.ws?.close();
      } catch {}
      try {
        record.term.dispose();
      } catch {}
      termMap.current.delete(tabId);
    }
    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    void closeTerminalSession(tabId);
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const bc = new BroadcastChannel('jeikcode:terminal:sync');
        bc.postMessage({ type: 'sync', cwd });
        bc.close();
      }
    } catch {}
    if (activeTabId === tabId) {
      focusOnNextLayoutRef.current = true;
      setActiveTabId(remaining[remaining.length - 1]!.id);
    }
  };

  // 关闭所有终端标签（终止所有任务，恢复纯净初始终端）
  const closeAllTabs = () => {
    tabs.forEach((tab) => {
      const record = termMap.current.get(tab.id);
      if (record) {
        try { record.ro?.disconnect(); } catch {}
        try { record.ws?.close(); } catch {}
        try { record.term.dispose(); } catch {}
        termMap.current.delete(tab.id);
      }
      void closeTerminalSession(tab.id);
    });
    const newId = stableDefaultId;
    const newTab: TerminalTab = {
      id: newId,
      name: `${preferredShell} 1`,
      cwd: cwd || '.',
      shell: preferredShell,
      timestamp: Date.now(),
    };
    setTabs([newTab]);
    focusOnNextLayoutRef.current = true;
    setActiveTabId(newId);
    saveSessions([newTab], cwd);
    showToast(t('terminal.allClosed') || '已关闭所有终端标签并终止任务', 'info');
  };

  return (
    <div
      class="terminal-panel-root"
      ref={panelRootRef}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        try {
          const raw = e.dataTransfer?.getData('application/jeikcode-tab');
          const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
          const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
          if (targetPath && typeof targetPath === 'string') {
            const formatted = targetPath.includes(' ') ? `"${targetPath}"` : targetPath;
            const activeRecord = termMap.current.get(activeTabId);
            if (activeRecord?.ws && activeRecord.ws.readyState === WebSocket.OPEN) {
              activeRecord.ws.send(formatted);
            } else if (scratchpadOpen) {
              setScratchpadText((prev) => (prev ? `${prev} ${formatted}` : formatted));
            }
          }
        } catch {}
      }}
    >
      {/* 顶部多终端标签栏 */}
      <div class="terminal-tabs-bar">
        <div
          class="terminal-tabs-scroll"
          onWheel={(e) => {
            if (e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                class={'terminal-tab-item' + (isActive ? ' active' : '')}
                onClick={() => {
                  focusOnNextLayoutRef.current = true;
                  setActiveTabId(tab.id);
                }}
                onDblClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id, e as unknown as MouseEvent);
                }}
                title={tab.name + ' (双击关闭标签)'}
              >
                <span class="terminal-tab-icon">💻</span>
                <span class="terminal-tab-name">{tab.name}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    class="terminal-tab-close"
                    onClick={(e) => closeTab(tab.id, e as unknown as MouseEvent)}
                    title="Close terminal"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div class="terminal-bar-actions">
          {/* +号默认一键创建主流终端，独立▾下拉三角展开细分Shell选择 */}
          <div class="terminal-create-group" ref={shellDropdownRef}>
            <button
              type="button"
              class="terminal-create-btn"
              onClick={() => void createNewTab(preferredShell)}
              title={`${t('terminal.newPowerShell')} (${preferredShell})`}
            >
              +
            </button>
            <button
              type="button"
              class="terminal-create-chevron"
              onClick={() => setShellDropdownOpen((o) => !o)}
              title="Select Shell Type"
            >
              ▾
            </button>
            {shellDropdownOpen && (
              <div class="terminal-shell-menu" role="menu">
                {currentPlatformShells.map((sh) => (
                  <button
                    key={sh.id}
                    type="button"
                    class={'terminal-shell-menu-item' + (preferredShell === sh.id ? ' active' : '')}
                    onClick={() => selectAndCreateShell(sh.id)}
                  >
                    <span>{`${sh.icon} ${sh.name}`}</span>
                    {preferredShell === sh.id && <span class="shell-active-check">✓</span>}
                  </button>
                ))}
                <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.1)', margin: '4px 0' }} />
                <button
                  type="button"
                  class="terminal-shell-menu-item terminal-close-all-danger"
                  style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: '6px' }}
                  onClick={() => {
                    setShellDropdownOpen(false);
                    closeAllTabs();
                  }}
                  title={t('terminal.closeAll') || '关闭所有标签 (终止全部任务)'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                  <span>{t('terminal.closeAll') || '关闭所有终端 (终止全部任务)'}</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            class={'terminal-action-btn' + (scratchpadOpen ? ' active' : '')}
            onClick={toggleScratchpad}
            title={t('terminal.scratchpad')}
          >
            📝
          </button>
        </div>
      </div>

      {/* 原生代输命令编辑框 (FinalShell / Xshell 风格，支持大块长命令与多行编辑粘贴) */}
      {scratchpadOpen && (
        <div class="terminal-scratchpad-box">
          <div class="scratchpad-header">
            <span>{t('terminal.scratchpadTitle')}</span>
            <button
              type="button"
              class="scratchpad-send-btn"
              onClick={() => {
                void executeCommand(scratchpadText);
                setScratchpadText('');
              }}
            >
              {`🚀 ${t('terminal.send')}`}
            </button>
          </div>
          <textarea
            class="scratchpad-textarea"
            placeholder={t('terminal.scratchpadPlaceholder')}
            value={scratchpadText}
            onInput={(e) => setScratchpadText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void executeCommand(scratchpadText);
                setScratchpadText('');
              }
            }}
            rows={3}
          />
        </div>
      )}

      {/* 现代 xterm 真实终端视口区：绝对定位重叠，visibility 切换，保留完整物理宽高 */}
      <div class="terminal-xterm-stage">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(el) => bindTerminalContainer(tab, el)}
            class={'terminal-xterm-viewport' + (tab.id === activeTabId ? ' active' : '')}
          />
        ))}
      </div>
    </div>
  );
}
