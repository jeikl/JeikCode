import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
    jsxFactory: 'h', target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (name) => {
    assert.ok(name in dependencies, `Unexpected import ${name}`);
    return dependencies[name];
  }, ...globals });
  return exports;
}
const { vi } = load('./vi.ts');
const { messages, languageOptions } = load('./i18n.ts', { './vi': { vi } });
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('all three catalogs mirror English keys and placeholder occurrences', () => {
  const keys = Object.keys(messages.en).sort();
  assert.ok(keys.length >= 650, 'catalog coverage must not shrink');
  for (const lang of ['en', 'vi', 'zh']) {
    assert.deepEqual(Object.keys(messages[lang]).sort(), keys);
    for (const key of keys) {
      assert.ok(messages[lang][key].trim(), `${lang}:${key} is empty`);
      assert.deepEqual(placeholders(messages[lang][key]), placeholders(messages.en[key]), `${lang}:${key}`);
    }
  }
});

test('language selectors share native self-names in English-first order', () => {
  assert.equal(JSON.stringify(languageOptions), JSON.stringify([
    { value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' },
    { value: 'zh', label: '简体中文' },
  ]));
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function harness(stored, blocked = false, navigatorLang = undefined, navigatorLangs = undefined) {
  const config = deferred();
  const writes = [];
  const attrs = {};
  const storage = new Map(stored ? [['jeikcode.lang', stored]] : []);
  const states = [], refs = [], effects = [], dependencies = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, context;
  const hooks = {
    useState(init) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], value => { states[i] = value; }];
    },
    useRef(init) { const i = refIndex++; return refs[i] ??= { current: init }; },
    useEffect(fn, deps) {
      const i = effectIndex++;
      if (!dependencies[i] || deps.some((v, j) => v !== dependencies[i][j])) {
        effects.push(fn); dependencies[i] = deps;
      }
    },
    useContext() { return context; },
  };
  const navObj = (navigatorLang || navigatorLangs) ? {
    language: navigatorLang,
    languages: navigatorLangs,
  } : undefined;
  const settings = load('./settings.tsx', {
    preact: { createContext: () => ({ Provider: 'provider' }) },
    'preact/hooks': hooks, './i18n': { messages },
    './api': { getConfig: () => config.promise, postLanguage: async lang => { writes.push(lang); } },
  }, {
    h: (_type, props) => { context = props.value; },
    document: { documentElement: { setAttribute: (key, value) => { attrs[key] = value; } } },
    navigator: navObj,
    localStorage: {
      getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); },
    },
  });
  function render() {
    stateIndex = refIndex = effectIndex = 0;
    settings.SettingsProvider({ children: null });
    const cleanups = effects.splice(0).map(fn => fn()).filter(Boolean);
    return cleanups;
  }
  const cleanups = render();
  return { settings, config, writes, attrs, storage, render, cleanups, context: () => context };
}

test('unconfigured first run without browser language falls back to English', () => {
  for (const blocked of [false, true]) {
    const h = harness(undefined, blocked);
    assert.equal(h.context().lang, 'en');
    assert.equal(h.attrs.lang, 'en');
    assert.equal(h.attrs.dir, 'ltr');
  }
});

test('unconfigured first run detects supported browser language with English fallback', () => {
  for (const [nav, expected] of [['zh-CN', 'zh'], ['zh', 'zh'], ['vi-VN', 'vi'], ['vi', 'vi'], ['en-US', 'en'], ['fr-FR', 'en'], ['de', 'en']]) {
    const h = harness(undefined, false, nav);
    assert.equal(h.context().lang, expected);
  }
});

test('Google-style navigator.languages chain matching respects first supported candidate', () => {
  // Candidate list has unsupported first, then supported:
  const hZh = harness(undefined, false, undefined, ['ja', 'zh-TW', 'en']);
  assert.equal(hZh.context().lang, 'zh');

  const hVi = harness(undefined, false, undefined, ['ko', 'vi-VN', 'en-US']);
  assert.equal(hVi.context().lang, 'vi');

  // Candidate list with only unsupported languages falls back cleanly to English baseline:
  const hFallback = harness(undefined, false, undefined, ['de', 'es', 'it']);
  assert.equal(hFallback.context().lang, 'en');

  // User explicit storage overrides browser languages:
  const hSaved = harness('en', false, undefined, ['zh-CN', 'zh']);
  assert.equal(hSaved.context().lang, 'en');
});

test('legacy and regional persisted values normalize on reload', () => {
  for (const [value, expected] of [['zh', 'zh'], ['en', 'en'], ['vi', 'vi'], ['vi-VN', 'vi'], ['zh-CN', 'zh'], ['en-US', 'en'], ['VI_vn', 'vi'], ['invalid', 'en']]) {
    const h = harness(value);
    assert.equal(h.context().lang, expected);
    assert.equal(h.storage.get('jeikcode.lang'), expected);
    assert.equal(h.attrs.lang, expected === 'zh' ? 'zh-CN' : expected);
    assert.equal(h.context().t('sidebar.mcpTools', { n: 3 }), messages[expected]['sidebar.mcpTools'].replace('{n}', '3'));
  }
});

test('server config round-trips all supported locales', async () => {
  for (const [value, expected] of [['vi-VN', 'vi'], ['vi', 'vi'], ['en-US', 'en'], ['zh-CN', 'zh']]) {
    const h = harness();
    h.config.resolve({ language: value });
    await Promise.resolve();
    h.render();
    assert.equal(h.context().lang, expected);
    assert.equal(h.storage.get('jeikcode.lang'), expected);
  }
});

test('explicit choice wins over stale startup fetch and saves in selection order', async () => {
  const h = harness();
  const first = h.context().setLang('vi');
  const second = h.context().setLang('zh');
  h.config.resolve({ language: 'en' });
  await Promise.all([first, second]);
  h.render();
  assert.equal(h.context().lang, 'zh');
  assert.equal(JSON.stringify(h.writes), JSON.stringify(['vi', 'zh']));
  assert.equal(h.storage.get('jeikcode.lang'), 'zh');
});

test('disposed startup fetch cannot update state', async () => {
  const h = harness();
  h.cleanups.forEach(fn => fn());
  h.config.resolve({ language: 'vi-VN' });
  await Promise.resolve();
  h.render();
  assert.equal(h.context().lang, 'en');
});

test('API language payloads use canonical backend codes', async () => {
  // Extract just this function to avoid initializing unrelated transport globals.
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function postLanguage(');
  const end = source.indexOf('\n}', start) + 2;
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const payloads = [];
  const exports = {};
  vm.runInNewContext(code, { exports, authHeaders: () => ({}), apiFetch: async (url, options) => {
    assert.equal(url, '/config/language');
    assert.equal(options.method, 'POST');
    payloads.push(JSON.parse(options.body).language);
    return { ok: true };
  } });
  for (const lang of ['en', 'vi', 'zh']) await exports.postLanguage(lang);
  assert.deepEqual(payloads, ['en', 'vi-VN', 'zh-CN']);
});
