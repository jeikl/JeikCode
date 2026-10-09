import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator, messages, normalizeLocale } from '../src/i18n';

function testLocaleNormalizationFollowsVSCodeLanguage() {
  assert.equal(normalizeLocale('zh-cn'), 'zh');
  assert.equal(normalizeLocale('zh-CN'), 'zh');
  assert.equal(normalizeLocale('zh-tw'), 'zh');
  assert.equal(normalizeLocale('zhCN'), 'zh');
  for (const alias of ['vi', 'vi-VN', 'VI_vn', 'Vietnamese', ' Vietnamese ']) {
    assert.equal(normalizeLocale(alias), 'vi');
  }
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('fr'), 'en');
  assert.equal(normalizeLocale(undefined), 'en');
}

function testTranslatorFallsBackToEnglishAndInterpolatesValues() {
  const zh = createTranslator('zh-CN');
  const en = createTranslator('en-US');

  assert.equal(zh('welcome.quick.intro'), '了解 JeikCode');
  assert.equal(en('welcome.quick.intro'), 'Learn JeikCode');
  assert.equal(zh('setup.providersConfigured', { count: 3 }), '已配置 3 个 Provider');
  assert.equal(zh('mode.auto'), 'Auto');
  assert.equal(en('mode.auto'), 'Auto');
}

function testCatalogsHaveMatchingKeys() {
  const zhKeys = Object.keys(messages.zh).sort();
  const enKeys = Object.keys(messages.en).sort();
  assert.deepEqual(zhKeys, enKeys);
}

function testVSCodeManifestUsesNlsPlaceholders() {
  const root = process.cwd();
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');

  assert.match(packageJson, /"l10n":\s*"\.\/l10n"/);
  assert.match(packageJson, /"title":\s*"%jeikcode\.commands\.openSidebar\.title%"/);
  assert.match(packageJson, /"shortTitle":\s*"%jeikcode\.commands\.explain\.shortTitle%"/);
  assert.match(packageJson, /"shortTitle":\s*"%jeikcode\.commands\.fix\.shortTitle%"/);
  assert.match(packageJson, /"shortTitle":\s*"%jeikcode\.commands\.optimize\.shortTitle%"/);
  assert.match(packageJson, /"shortTitle":\s*"%jeikcode\.commands\.addToChat\.shortTitle%"/);
  assert.match(packageJson, /"description":\s*"%jeikcode\.configuration\.daemon\.port\.description%"/);
  assert.ok(existsSync(join(root, 'package.nls.json')));
  assert.ok(existsSync(join(root, 'package.nls.zh-cn.json')));
}

function testPackageNlsFilesCoverEveryManifestPlaceholder() {
  const root = process.cwd();
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const en = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const zhCn = JSON.parse(readFileSync(join(root, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
  const placeholders = Array.from(packageJson.matchAll(/%([^%]+)%/g), (match) => match[1]).sort();

  assert.ok(placeholders.length > 0);
  for (const key of placeholders) {
    assert.ok(en[key], `English package.nls.json missing ${key}`);
    assert.ok(zhCn[key], `Chinese package.nls.zh-cn.json missing ${key}`);
  }
}

function placeholders(text: string) {
  return Array.from(text.matchAll(/\{([^{}]+)\}/g), match => match[1]).sort();
}

function testVietnameseCatalogAndPlaceholderParity() {
  assert.deepEqual(Object.keys(messages.vi).sort(), Object.keys(messages.en).sort());
  for (const key of Object.keys(messages.en) as Array<keyof typeof messages.en>) {
    assert.ok(messages.vi[key].trim(), key);
    assert.deepEqual(placeholders(messages.vi[key]), placeholders(messages.en[key]), key);
    assert.deepEqual(placeholders(messages.zh[key]), placeholders(messages.en[key]), key);
  }
  assert.equal(createTranslator('Vietnamese')('setup.providersConfigured', { count: 3 }), 'Đã cấu hình 3 nhà cung cấp');
  assert.equal(createTranslator('vi')('input.imageTooLarge', { mb: 5 }), 'Ảnh phải nhỏ hơn 5 MB.');
}

function testUnsupportedAndMissingTranslationFallback() {
  assert.equal(createTranslator('fr')('header.search'), messages.en['header.search']);
  const key = 'header.search';
  const original = messages.vi[key];
  try {
    delete (messages.vi as Partial<typeof messages.vi>)[key];
    assert.equal(createTranslator('vi')(key), messages.en[key]);
  } finally {
    messages.vi[key] = original;
  }
}

function testVietnameseNativeCatalogParity() {
  const root = process.cwd();
  for (const [baseFile, viFile, sourceIsKey] of [
    ['package.nls.json', 'package.nls.vi.json', false],
    ['l10n/bundle.l10n.zh-cn.json', 'l10n/bundle.l10n.vi.json', true],
  ] as const) {
    const base = JSON.parse(readFileSync(join(root, baseFile), 'utf8')) as Record<string, string>;
    const vi = JSON.parse(readFileSync(join(root, viFile), 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(vi).sort(), Object.keys(base).sort());
    for (const key of Object.keys(base)) {
      assert.ok(vi[key].trim(), key);
      assert.deepEqual(placeholders(vi[key]), placeholders(sourceIsKey ? key : base[key]), key);
    }
  }
}

function testExistingVSCodeLocaleBridgeHasNoInventedSetting() {
  const root = process.cwd();
  const provider = readFileSync(join(root, 'src/chat/provider.ts'), 'utf8');
  const chatProvider = readFileSync(join(root, 'webview-ui/src/state/ChatProvider.tsx'), 'utf8');
  const reducer = readFileSync(join(root, 'webview-ui/src/state/reducer.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(provider, /locale: vscode\.env\.language/);
  assert.match(chatProvider, /locale: msg\.locale/);
  assert.match(reducer, /locale: action\.locale \?\? state\.locale/);
  assert.match(reducer, /locale: document\.body\.dataset\.locale/);
  assert.ok(!Object.keys(manifest.contributes.configuration.properties).some(key => /language|locale/i.test(key)));
  // Explicit VS Code display-language choices remain authoritative; no OS/browser override.
  assert.equal(createTranslator('en')('header.search'), 'Search');
  assert.equal(createTranslator('zh')('header.search'), '搜索');
  assert.equal(createTranslator('vi')('header.search'), 'Tìm kiếm');
}

testVietnameseCatalogAndPlaceholderParity();
testUnsupportedAndMissingTranslationFallback();
testVietnameseNativeCatalogParity();
testExistingVSCodeLocaleBridgeHasNoInventedSetting();
testLocaleNormalizationFollowsVSCodeLanguage();
testTranslatorFallsBackToEnglishAndInterpolatesValues();
testCatalogsHaveMatchingKeys();
testVSCodeManifestUsesNlsPlaceholders();
testPackageNlsFilesCoverEveryManifestPlaceholder();
console.log('i18n regression: 9 test groups passed');
