'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  isNoise,
  groupOf,
  renderChangelogSection,
  upsertChangelog,
  bumpCargoLock,
  collectBinaries,
  publish,
  assetName,
} = require('./publish-release');

test('noise commits and groups', () => {
  assert.equal(isNoise('chore(release): 自动同步 v7.1.29 [linux-x64] 校验清单 [skip ci]'), true);
  assert.equal(isNoise('fix(webui): 工具结束后立即刷新'), false);
  assert.equal(groupOf('feat(run_command): 增加可选的 summary'), 'Features (新功能)');
  assert.equal(groupOf('fix(webui): 刷新'), 'Bug Fixes (修复)');
  assert.equal(groupOf('docs: readme'), 'Documentation (文档)');
  assert.equal(groupOf('随便写了一句'), 'Other (其他)');
});

test('changelog section skips release sync commits and is idempotent', () => {
  const section = renderChangelogSection('v7.1.30', '2026-09-29', [
    { hash: 'aaa', subject: 'feat(run_command): 增加 summary' },
    { hash: 'bbb', subject: 'chore(release): 自动同步 v7.1.29 [linux-x64] 校验清单 [skip ci]' },
    { hash: 'ccc', subject: 'fix(webui): 工具结束后立即刷新' },
  ]);
  assert.match(section, /## v7\.1\.30 \(2026-09-29\)/);
  assert.match(section, /### Features \(新功能\)/);
  assert.match(section, /feat\(run_command\): 增加 summary \(`aaa`\)/);
  assert.match(section, /### Bug Fixes \(修复\)/);
  assert.doesNotMatch(section, /校验清单/);

  const once = upsertChangelog('# Changelog\n\n', section, 'v7.1.30');
  const twice = upsertChangelog(once, section, 'v7.1.30');
  assert.equal(once, twice);
  assert.equal(once.split('## v7.1.30').length, 2);
});

test('cargo lock only bumps workspace package versions', () => {
  const lock = [
    '[[package]]',
    'name = "jeikcode-cli"',
    'version = "7.1.7"',
    '[[package]]',
    'name = "serde"',
    'version = "1.0.0"',
    '',
  ].join('\n');
  const bumped = bumpCargoLock(lock, ['jeikcode-cli'], '7.1.30');
  assert.match(bumped, /name = "jeikcode-cli"\nversion = "7\.1\.30"/);
  assert.match(bumped, /name = "serde"\nversion = "1\.0\.0"/);
});

test('publish writes one manifest and refuses a partial set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeik-publish-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'crates', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'crates', 'demo', 'Cargo.toml'), 'name = "jeikcode-demo"\n');
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace.package]\nversion = "7.1.7"\n');
  fs.writeFileSync(path.join(root, 'latest.json'), '{"version":"v7.1.7"}\n');
  const tag = 'v7.1.30';
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']) {
    fs.writeFileSync(path.join(dist, assetName(tag, target)), target);
  }
  assert.throws(() => collectBinaries(dist, tag), /windows-arm64/);
  fs.writeFileSync(path.join(dist, assetName(tag, 'windows-arm64')), 'arm');
  publish({
    root,
    distDir: dist,
    tag,
    date: '2026-09-29',
    commits: [{ hash: 'abc', subject: 'fix(webui): 刷新' }],
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, tag);
  assert.equal(Object.keys(manifest.binaries).length, 6);
  assert.equal(manifest.binaries['linux-arm64'].size, Buffer.byteLength('linux-arm64'));
  assert.match(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'), /version = "7\.1\.7"/);
  assert.equal(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'), '{"version":"v7.1.7"}\n');
  assert.match(fs.readFileSync(path.join(root, 'release_notes.md'), 'utf8'), /arm64/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('prerelease manifest stays in dist and does not touch the repo file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeik-pre-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, 'latest.json'), '{"version":"v7.1.29","binaries":{}}\n');
  const tag = 'v7.1.30-beta.1';
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-arm64', 'windows-x64']) {
    fs.writeFileSync(path.join(dist, assetName(tag, target)), 'x');
  }
  publish({ root, distDir: dist, tag, date: '2026-09-29', commits: [] });
  assert.equal(
    fs.readFileSync(path.join(root, 'latest.json'), 'utf8'),
    '{"version":"v7.1.29","binaries":{}}\n',
  );
  const staged = JSON.parse(fs.readFileSync(path.join(dist, 'latest.json'), 'utf8'));
  assert.equal(staged.version, tag);
  assert.match(fs.readFileSync(path.join(root, 'release_notes.md'), 'utf8'), /v7\.1\.30-beta\.1/);
  fs.rmSync(root, { recursive: true, force: true });
});
