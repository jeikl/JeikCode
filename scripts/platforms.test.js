#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const platforms = require('./platforms');
const { TARGETS } = require('./publish-release');
const { DESKTOP_SPECS } = require('./publish-desktop-manifest');

const ROOT = platforms.ROOT;

test('platform manifest validates', () => {
  assert.doesNotThrow(() => platforms.validate());
});

test('publish-release targets are derived from the CLI manifest', () => {
  assert.deepEqual(TARGETS, platforms.CLI_TARGETS);
});

test('desktop manifest specs are derived from the desktop manifest', () => {
  assert.deepEqual(
    DESKTOP_SPECS.map((spec) => spec.installerKey),
    platforms.DESKTOP_INSTALLERS.map((entry) => entry.installerKey),
  );
});

test('generated installer/docs blocks and consumers are up to date', () => {
  assert.deepEqual(platforms.collectErrors(), []);
});

test('asset names follow each target extension', () => {
  assert.equal(platforms.assetName('v1.2.3', 'linux-x64'), 'jeikcode-v1.2.3-linux-x64');
  assert.equal(platforms.assetName('v1.2.3', 'windows-arm64'), 'jeikcode-v1.2.3-windows-arm64.exe');
  assert.throws(() => platforms.assetName('v1.2.3', 'ohos-arm64'), /unknown CLI target/);
});

test('github matrix keeps the three build families together', () => {
  assert.deepEqual(platforms.matrix('linux'), {
    include: [
      { target: 'aarch64-unknown-linux-musl', arch: 'arm64' },
      { target: 'x86_64-unknown-linux-musl', arch: 'x64' },
    ],
  });
  assert.equal(platforms.matrix('windows').include.length, 2);
  assert.equal(platforms.matrix('macos').include.length, 2);
});

test('installer rejects 32-bit and MIPS with explicit messages', { skip: process.platform === 'win32' }, () => {
  const cases = [
    ['armv7l', /32-bit ARM userland/],
    ['armv8l', /32-bit ARM userland/],
    ['i686', /32-bit x86/],
    ['mips', /MIPS is not supported/],
  ];
  for (const [machine, pattern] of cases) {
    const result = spawnSync('sh', [path.join(ROOT, 'scripts/install.sh')], {
      env: {
        ...process.env,
        JEIKCODE_TEST_UNAME_S: 'Linux',
        JEIKCODE_TEST_UNAME_M: machine,
        JEIKCODE_MANIFEST_URL: 'http://127.0.0.1:1/latest.json',
        JEIKCODE_NO_PATH_UPDATE: '1',
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(result.status, 0, `${machine} must fail closed`);
    assert.match(`${result.stdout}${result.stderr}`, pattern, machine);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Unsupported architecture: armv7l/);
  }
});

test('installer maps aarch64 to the linux-arm64 artifact', { skip: process.platform === 'win32' }, () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/install.sh'), 'utf8');
  // Alias order follows the first CLI entry (macOS arm64 first); accept either.
  assert.match(script, /(?:arm64\|aarch64|aarch64\|arm64)\) arch="arm64"/);
  assert.match(script, /x86_64\|amd64\) arch="x64"/);
});
