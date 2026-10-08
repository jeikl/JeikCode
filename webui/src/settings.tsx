// Settings store: theme (light/dark/system) + language (en/vi/zh), persisted to
// localStorage and exposed via a Preact context. `t()` does message lookup +
// {placeholder} interpolation against the i18n catalog.

import { createContext, ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { messages, Lang, MsgKey } from './i18n';
import { getConfig, postLanguage } from './api';

export type Theme = 'light' | 'dark' | 'system';

/** Which settings dialog to open from the sidebar settings menu. */
export type SettingsSection = 'theme' | 'language' | 'model';

type TParams = Record<string, string | number>;

interface SettingsCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  lang: Lang;
  setLang: (l: Lang) => Promise<void>;
  t: (key: MsgKey, params?: TParams) => string;
}

const Ctx = createContext<SettingsCtx | null>(null);

const THEME_KEY = 'jeikcode.theme';
const LANG_KEY = 'jeikcode.lang';

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

function readLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    const normalized = normalizeServerLang(v ?? undefined);
    if (normalized) return normalized;
  } catch {
    /* ignore */
  }
  return 'en';
}

export function normalizeServerLang(value: string | undefined): Lang | null {
  if (!value) return null;
  const norm = value.trim().toLowerCase().replace('_', '-');
  if (norm === 'en' || norm.startsWith('en-')) return 'en';
  if (norm === 'vi' || norm.startsWith('vi-')) return 'vi';
  if (norm === 'zh' || norm.startsWith('zh-')) return 'zh';
  return null;
}

export function SettingsProvider({ children }: { children: ComponentChildren }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [lang, setLangState] = useState<Lang>(readLang);

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
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function setLang(next: Lang): Promise<void> {
    selectionVersion.current += 1;
    setLangState(next);
    // Serialize writes so a slower earlier request cannot replace a newer choice.
    const save = pendingSave.current.then(() => postLanguage(next));
    // Giữ hàng đợi sống sau lỗi, nhưng trả lỗi thực cho dialog/wizard đang lưu.
    pendingSave.current = save.catch(() => {});
    return save;
  }

  // Apply theme to <html data-theme>; theme.css keys light/dark off this.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : lang);
    document.documentElement.setAttribute('dir', 'ltr');
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
      value={{ theme, setTheme: setThemeState, lang, setLang, t }}
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
  return useSettings().t;
}
