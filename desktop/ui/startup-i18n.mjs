export const startupMessages = Object.freeze({
  en: Object.freeze({ lang: 'en', starting: 'Starting…' }),
  vi: Object.freeze({ lang: 'vi-VN', starting: 'Đang khởi động…' }),
  zh: Object.freeze({ lang: 'zh-CN', starting: '正在启动…' }),
});

function supportedLanguage(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  for (const language of ['en', 'vi', 'zh']) {
    if (normalized === language || normalized.startsWith(`${language}-`)) return language;
  }
  return null;
}

// Browser preferences only: the shell origin cannot read the localhost WebUI's
// saved locale. No storage, native bootstrap override, or cross-origin requests.
// A saved WebUI locale may differ; WebUI applies its own policy after navigation.
export function detectStartupLanguage(browser = globalThis.navigator) {
  if (Array.isArray(browser?.languages)) {
    for (const candidate of browser.languages) {
      const language = supportedLanguage(candidate);
      if (language) return language;
    }
  }
  return supportedLanguage(browser?.language) ?? 'en';
}

if (typeof document !== 'undefined') {
  const messages = startupMessages[detectStartupLanguage()];
  document.documentElement.lang = messages.lang;
  const status = document.getElementById('status');
  // Native startup errors also use this element. Do not replace an error that
  // arrived before this deferred module ran; those messages remain native-owned.
  if (status?.textContent === startupMessages.en.starting) {
    status.textContent = messages.starting;
  }
}
