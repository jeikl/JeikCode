// Settings store: theme (light/dark/system) + language (en/vi/zh), persisted to
// localStorage and exposed via a Preact context. `t()` does message lookup +
// {placeholder} interpolation against the i18n catalog.

import { createContext, ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { messages, Lang, MsgKey } from './i18n';
import { getConfig, postLanguage, postAutoGitSync } from './api';
import { Theme, EffectiveTheme, resolveEffectiveTheme } from './lib/theme';

export type { Theme, EffectiveTheme };
export { resolveEffectiveTheme };

/** Which settings dialog to open from the sidebar settings menu. */
export type SettingsSection = 'theme' | 'language' | 'model' | 'system';

export type TParams = Record<string, string | number>;

interface SettingsCtx {
  theme: Theme;
  effectiveTheme: EffectiveTheme;
  setTheme: (t: Theme) => void;
  lang: Lang;
  setLang: (l: Lang) => Promise<void>;
  t: (key: MsgKey, params?: TParams) => string;
  githubLogo: boolean;
  /** Agent 执行 git 变更命令后是否自动同步/刷新（来自 /config，默认开启）。 */
  autoGitSync: boolean;
  setAutoGitSync: (v: boolean) => Promise<void>;
  /** ESC 是否执行“撤销上一条消息 / 取消待发卡片 / 退出编辑”（默认开启）。 */
  escUndoEnabled: boolean;
  setEscUndoEnabled: (v: boolean) => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

const THEME_KEY = 'jeikcode.theme';
const LANG_KEY = 'jeikcode.lang';
const ESC_UNDO_KEY = 'jeikcode.escUndo';

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  // Default to clean Gemini-style dark mode
  return 'dark';
}

export function detectBrowserPreferredLang(): Lang | null {
  if (typeof navigator === 'undefined') return null;
  // Google-style preferred language array matching across navigator.languages
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    for (const candidate of navigator.languages) {
      const match = normalizeServerLang(candidate);
      if (match) return match;
    }
  }
  // Single language fallback
  if (navigator.language) {
    const match = normalizeServerLang(navigator.language);
    if (match) return match;
  }
  return null;
}

function readEscUndo(): boolean {
  try {
    const v = localStorage.getItem(ESC_UNDO_KEY);
    if (v === '0' || v === 'false') return false;
  } catch {
    /* ignore */
  }
  // Default on: ESC keeps its historical undo/restore behavior until opted out.
  return true;
}

function readLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    const normalized = normalizeServerLang(v ?? undefined);
    if (normalized) return normalized;
  } catch {
    /* ignore */
  }
  // Auto-detect browser/system language preferences when unconfigured
  const detected = detectBrowserPreferredLang();
  if (detected) return detected;
  // English baseline fallback
  return 'en';
}

export function normalizeServerLang(value: string | undefined): Lang | null {
  if (!value) return null;
  const norm = value.trim().toLowerCase().replace('_', '-');
  if (norm === 'en' || norm.startsWith('en-')) return 'en';
  if (norm === 'vi' || norm.startsWith('vi-')) return 'vi';
  if (
    norm === 'zh-tw' ||
    norm.startsWith('zh-tw') ||
    norm === 'zh-hk' ||
    norm.startsWith('zh-hk') ||
    norm === 'zh-hant' ||
    norm.startsWith('zh-hant')
  ) {
    return 'zh-TW';
  }
  if (norm === 'zh' || norm.startsWith('zh-')) return 'zh';
  if (norm === 'ja' || norm.startsWith('ja-')) return 'ja';
  if (norm === 'ko' || norm.startsWith('ko-')) return 'ko';
  if (norm === 'ru' || norm.startsWith('ru-')) return 'ru';
  if (norm === 'fr' || norm.startsWith('fr-')) return 'fr';
  if (norm === 'es' || norm.startsWith('es-')) return 'es';
  if (norm === 'de' || norm.startsWith('de-')) return 'de';
  if (norm === 'ar' || norm.startsWith('ar-')) return 'ar';
  return null;
}

export function SettingsProvider({ children }: { children: ComponentChildren }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => resolveEffectiveTheme(readTheme()));
  const [lang, setLangState] = useState<Lang>(readLang);
  const [githubLogo, setGithubLogo] = useState<boolean>(true);
  const [autoGitSync, setAutoGitSyncState] = useState<boolean>(true);
  const [escUndoEnabled, setEscUndoEnabledState] = useState<boolean>(readEscUndo);

  const selectionVersion = useRef(0);
  const pendingSave = useRef(Promise.resolve());

  // The config file is the global switch. A missing choice stays English.
  useEffect(() => {
    let cancelled = false;
    const version = selectionVersion.current;
    getConfig()
      .then((cfg) => {
        if (cancelled || version !== selectionVersion.current) return;
        const next = normalizeServerLang(cfg.language);
        if (next) setLangState(next);
        if (typeof cfg.github_logo === 'boolean') {
          setGithubLogo(cfg.github_logo);
        }
        if (typeof cfg.auto_git_sync === 'boolean') {
          setAutoGitSyncState(cfg.auto_git_sync);
        }
      })
      .catch(() => {});

    const handleReload = () => {
      getConfig().then((cfg) => {
        // 语言（小地球）是全局设置：别的实例改了要立刻跟随；
        // 本端刚点过（版本已推进）则以本地选择为准，避免慢请求回写旧值。
        if (version === selectionVersion.current) {
          const next = normalizeServerLang(cfg.language);
          if (next) setLangState(next);
        }
        if (typeof cfg.github_logo === 'boolean') {
          setGithubLogo(cfg.github_logo);
        }
        if (typeof cfg.auto_git_sync === 'boolean') {
          setAutoGitSyncState(cfg.auto_git_sync);
        }
      }).catch(() => {});
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('jeikcode:config-reloaded', handleReload);
    }
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('jeikcode:config-reloaded', handleReload);
      }
    };
  }, []);

  function setLang(next: Lang): Promise<void> {
    selectionVersion.current += 1;
    setLangState(next);
    // Serialize writes so a slower earlier request cannot replace a newer choice.
    const save = pendingSave.current.then(() => postLanguage(next));
    // Keep the promise chain alive on error while propagating rejection to caller.
    pendingSave.current = save.catch(() => {});
    return save;
  }

  // ESC 撤销是浏览器本地快捷键偏好：立即持久化，跨标签页通过 storage 事件同步。
  function setEscUndoEnabled(next: boolean): void {
    setEscUndoEnabledState(next);
    try {
      localStorage.setItem(ESC_UNDO_KEY, next ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ESC_UNDO_KEY) return;
      setEscUndoEnabledState(readEscUndo());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 乐观切换 Git 自动同步开关：失败时回滚，保证 UI 与磁盘配置一致。
  function setAutoGitSync(next: boolean): Promise<void> {
    setAutoGitSyncState(next);
    const save = pendingSave.current.then(() => postAutoGitSync(next));
    pendingSave.current = save.catch(() => {});
    return save.catch((err) => {
      setAutoGitSyncState((prev) => (prev === next ? !next : prev));
      throw err;
    });
  }

  // Apply theme to <html data-theme>; theme.css and app.css key light/dark off this.
  // When theme is 'system', dynamically resolve to 'light' or 'dark' and listen to system preference changes.
  useEffect(() => {
    const applyResolved = () => {
      const eff = resolveEffectiveTheme(theme);
      setEffectiveTheme(eff);
      document.documentElement.setAttribute('data-theme', eff);
      document.documentElement.setAttribute('data-theme-preference', theme);
    };

    applyResolved();

    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }

    if (theme === 'system' && typeof window !== 'undefined' && window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        applyResolved();
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
      } else if (typeof (media as any).addListener === 'function') {
        (media as any).addListener(listener);
        return () => (media as any).removeListener(listener);
      }
    }
  }, [theme]);

  // Apply document direction (RTL for Arabic, LTR for others) and record active app language.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : lang);
      document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('data-app-lang', lang);
    }
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  function t(key: MsgKey, params?: TParams): string {
    const table = messages[lang] ?? messages.en;
    let s = table[key] ?? messages.en[key] ?? key;
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.split(`{${k}}`).join(String(params[k]));
      }
    }
    return s;
  }

  return (
    <Ctx.Provider
      value={{ theme, effectiveTheme, setTheme: setThemeState, lang, setLang, t, githubLogo, autoGitSync, setAutoGitSync, escUndoEnabled, setEscUndoEnabled }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSettings(): SettingsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSettings must be used within <SettingsProvider>');
  return c;
}

/** Convenience hook when a component only needs the translator. */
export function useT(): SettingsCtx['t'] {
  const c = useContext(Ctx);
  if (!c) {
    // 优雅兜底降级：当组件在独立 DOM 挂载点（如 Markdown 中的 Mermaid 渲染孤岛）脱离 Provider 时，安全使用当前配置的语言
    const fallbackLang = readLang();
    return (key: MsgKey, params?: TParams): string => {
      const table = messages[fallbackLang] ?? messages.en;
      let s = table[key] ?? messages.en[key] ?? key;
      if (params) {
        for (const k of Object.keys(params)) {
          s = s.split(`{${k}}`).join(String(params[k]));
        }
      }
      return s;
    };
  }
  return c.t;
}
