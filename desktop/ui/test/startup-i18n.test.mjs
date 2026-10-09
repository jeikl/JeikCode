import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { detectStartupLanguage, startupMessages } from '../startup-i18n.mjs';

test('first supported browser preference wins', () => {
  for (const [languages, expected] of [
    [['ja', 'zh-TW', 'en'], 'zh'],
    [['ko', 'vi-VN', 'en-US'], 'vi'],
    [['en-GB', 'zh-CN'], 'en'],
    [['vi', 'zh'], 'vi'],
  ]) assert.equal(detectStartupLanguage({ languages, language: 'en' }), expected);
});

test('base, regional, case and underscore aliases match WebUI language families', () => {
  for (const [value, expected] of [
    ['en', 'en'], ['EN_us', 'en'], ['vi', 'vi'], [' VI_vn ', 'vi'],
    ['zh', 'zh'], ['zh-CN', 'zh'], ['zh-Hant-TW', 'zh'],
  ]) assert.equal(detectStartupLanguage({ languages: [value] }), expected);
});

test('single browser language is used when the chain has no supported entry', () => {
  for (const languages of [undefined, [], ['fr', 'de'], 'vi', null]) {
    assert.equal(detectStartupLanguage({ languages, language: 'vi-VN' }), 'vi');
  }
});

test('unsupported, absent and non-string inputs safely fall back to English', () => {
  for (const browser of [undefined, null, {}, '', 42,
    { languages: [] }, { languages: ['fr', 'de'], language: 'ja' },
    { languages: [null, undefined, 42, {}, '', 'english', 'vietnamese', 'zhCN'], language: false },
  ]) assert.equal(detectStartupLanguage(browser), 'en');
});

test('catalog contains localized loading text and canonical document languages', () => {
  assert.deepEqual(startupMessages, {
    en: { lang: 'en', starting: 'Starting…' },
    vi: { lang: 'vi-VN', starting: 'Đang khởi động…' },
    zh: { lang: 'zh-CN', starting: '正在启动…' },
  });
});

test('HTML keeps an English no-JS fallback, external module and untranslated brand', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<p id="status">Starting…<\/p>/);
  assert.match(html, /<script type="module" src="\.\/startup-i18n\.mjs"><\/script>/);
  assert.match(html, /<title>JeikCode Desktop<\/title>/);
});

test('module updates textContent and document language without overwriting native errors', async () => {
  const previousDocument = globalThis.document;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['vi-VN'] } });
    for (const [index, initial] of ['Starting…', 'Native startup error'].entries()) {
      const status = { textContent: initial };
      globalThis.document = { documentElement: {}, getElementById: () => status };
      await import(`../startup-i18n.mjs?dom-test=${index}`);
      assert.equal(globalThis.document.documentElement.lang, 'vi-VN');
      assert.equal(status.textContent, index === 0 ? 'Đang khởi động…' : initial);
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});
