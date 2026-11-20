'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  compareSemVer,
  computeNextVersion,
  replaceTopLevelJsonVersion,
  bumpAllFiles,
} = require('./bump-version');

test('compareSemVer compares prerelease numbers numerically instead of lexically', () => {
  assert.ok(compareSemVer('7.5.2-beta.10', '7.5.2-beta.2') > 0);
  assert.ok(compareSemVer('7.5.2-beta.2', '7.5.2-beta.10') < 0);
  assert.ok(compareSemVer('7.5.2', '7.5.2-beta.10') > 0);
  assert.ok(compareSemVer('7.5.2-beta.10', '7.5.2') < 0);
  assert.equal(compareSemVer('7.5.2-beta.2', '7.5.2-beta.2'), 0);
  assert.ok(compareSemVer('7.5.2-beta.2.1', '7.5.2-beta.2') > 0);
});

test('computeNextVersion increments beta, patch, minor, and major properly', () => {
  assert.equal(computeNextVersion('7.5.2-beta.9', 'beta'), '7.5.2-beta.10');
  assert.equal(computeNextVersion('7.5.2', 'beta'), '7.5.3-beta.1');
  assert.equal(computeNextVersion('7.5.2', 'patch'), '7.5.3');
  assert.equal(computeNextVersion('7.5.2', 'minor'), '7.6.0');
  assert.equal(computeNextVersion('7.5.2', 'major'), '8.0.0');
});

test('replaceTopLevelJsonVersion only updates root version and preserves formatting', () => {
  const input = [
    '{',
    '  "plugins": {',
    '    "updater": {',
    '      "version": "0.0.1"',
    '    }',
    '  },',
    '  "description": "mentions \\"version\\": \\"9.9.9\\"",',
    '  "bundle": {',
    '    "targets": ["nsis", "dmg", "deb", "appimage"]',
    '  },',
    '  "version": "7.5.2-beta.0"',
    '}',
    '',
  ].join('\n');

  const out = replaceTopLevelJsonVersion(input, '7.5.2-beta.1');
  const parsed = JSON.parse(out);
  assert.equal(parsed.version, '7.5.2-beta.1');
  assert.equal(parsed.plugins.updater.version, '0.0.1');
  assert.match(out, /"targets": \["nsis", "dmg", "deb", "appimage"\]/);
});

test('bumpAllFiles updates desktop manifests and lockfiles consistently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeik-bump-'));
  try {
    fs.mkdirSync(path.join(tmp, 'desktop', 'src-tauri'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'webui'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages', 'npm'), { recursive: true });

    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[workspace.package]\nversion = "7.5.2-beta.0"\n');
    fs.writeFileSync(
      path.join(tmp, 'Cargo.lock'),
      '[[package]]\nname = "jeikcode"\nversion = "7.5.2-beta.0"\n',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{\n  "name": "jeikcode",\n  "version": "7.5.2-beta.0"\n}\n');
    fs.writeFileSync(path.join(tmp, 'webui', 'package.json'), '{\n  "name": "jeikcode-webui",\n  "version": "7.5.2-beta.0"\n}\n');
    fs.writeFileSync(path.join(tmp, 'desktop', 'package.json'), '{\n  "name": "jeikcode-desktop",\n  "version": "7.5.2-beta.0"\n}\n');
    fs.writeFileSync(
      path.join(tmp, 'desktop', 'package-lock.json'),
      JSON.stringify({
        name: 'jeikcode-desktop',
        version: '7.5.2-beta.0',
        packages: { '': { name: 'jeikcode-desktop', version: '7.5.2-beta.0' } },
      }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'desktop', 'src-tauri', 'tauri.conf.json'),
      '{\n  "productName": "JeikCode Desktop",\n  "version": "7.5.2-beta.0",\n  "bundle": { "targets": ["nsis", "dmg"] }\n}\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'desktop', 'src-tauri', 'Cargo.toml'),
      '[workspace]\n\n[package]\nname = "jeikcode-desktop"\nversion = "7.5.2-beta.0"\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'desktop', 'src-tauri', 'Cargo.lock'),
      '[[package]]\nname = "jeikcode-desktop"\nversion = "7.5.2-beta.0"\n',
    );
    fs.writeFileSync(path.join(tmp, 'packages', 'npm', 'package.json'), '{\n  "name": "@github.com/jeikcode",\n  "version": "7.5.2-beta.0"\n}\n');

    const updated = bumpAllFiles('7.5.2-beta.10', tmp);
    assert.ok(updated.includes('desktop/package.json'));
    assert.ok(updated.includes('desktop/package-lock.json'));
    assert.ok(updated.includes('desktop/src-tauri/tauri.conf.json'));
    assert.ok(updated.includes('desktop/src-tauri/Cargo.toml'));
    assert.ok(updated.includes('desktop/src-tauri/Cargo.lock'));

    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '7.5.2-beta.10');
    assert.match(fs.readFileSync(path.join(tmp, 'desktop', 'src-tauri', 'Cargo.lock'), 'utf8'), /version = "7\.5\.2-beta\.10"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
