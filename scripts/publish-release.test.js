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
  renderReleaseNotes,
  buildReleaseSection,
  upsertChangelog,
  bumpCargoLock,
  collectBinaries,
  publish,
  assetName,
} = require('./publish-release');

test('noise commits and groups', () => {
  assert.equal(isNoise('chore(release): 自动同步 v7.1.29 [linux-x64] 校验清单 [skip ci]'), true);
  assert.equal(isNoise('fix(webui): 工具结束后立即刷新'), false);
  assert.equal(groupOf('feat(run_command): 增加可选的 summary'), 'Features');
  assert.equal(groupOf('fix(webui): 刷新'), 'Bug Fixes');
  assert.equal(groupOf('docs: readme'), 'Documentation');
  assert.equal(groupOf('随便写了一句'), 'Other Changes');
});

test('changelog section skips release sync commits and renders English section, separator, then Chinese section', () => {
  const section = renderChangelogSection('v7.1.30', '2026-09-29', [
    { hash: 'aaa', subject: 'feat(run_command): 增加 summary' },
    { hash: 'bbb', subject: 'chore(release): 自动同步 v7.1.29 [linux-x64] 校验清单 [skip ci]' },
    { hash: 'ccc', subject: 'fix(webui): 工具结束后立即刷新' },
  ]);
  assert.match(section, /## v7\.1\.30 \(2026-09-29\)/);
  // 必须严格包含分割线且英文段落居前、中文段落居后
  const parts = section.split('\n---\n');
  assert.equal(parts.length, 2, '应该恰好由一个分割线分为英文段与中文段');

  const [enPart, zhPart] = parts;
  assert.match(enPart, /### Features/);
  assert.match(enPart, /feat\(run_command\): 增加 summary \(`aaa`\)/);
  assert.match(enPart, /### Bug Fixes/);
  assert.match(enPart, /fix\(webui\): 工具结束后立即刷新 \(`ccc`\)/);
  assert.doesNotMatch(enPart, /校验清单/);
  assert.doesNotMatch(enPart, /新特性/);

  assert.match(zhPart, /### 新特性/);
  assert.match(zhPart, /feat\(run_command\): 增加 summary \(`aaa`\)/);
  assert.match(zhPart, /### 缺陷修复/);
  assert.match(zhPart, /fix\(webui\): 工具结束后立即刷新 \(`ccc`\)/);

  const once = upsertChangelog('# Changelog\n\n', section, 'v7.1.30');
  const twice = upsertChangelog(once, section, 'v7.1.30');
  assert.equal(once, twice);
  assert.equal(once.split('## v7.1.30').length, 2);
});

test('release notes desktop links do not 404 (uses dot instead of space) and install table is purely English', () => {
  const notes = renderReleaseNotes('v7.1.49', '## v7.1.49 (2026-10-04)\n\nSome changes');
  // 桌面端安装包文件名必须是 JeikCode.Desktop_ 而非 JeikCode%20Desktop_
  assert.match(notes, /JeikCode\.Desktop_7\.1\.49_x64-setup\.exe/);
  assert.match(notes, /JeikCode\.Desktop_7\.1\.49_aarch64\.dmg/);
  assert.match(notes, /JeikCode\.Desktop_7\.1\.49_x64\.dmg/);
  assert.match(notes, /JeikCode\.Desktop_7\.1\.49_amd64\.deb/);
  assert.match(notes, /JeikCode\.Desktop_7\.1\.49_amd64\.AppImage/);
  assert.doesNotMatch(notes, /JeikCode%20Desktop_/);

  // 安装路由部分严格保持全英文，杜绝中英斜杠混合格式
  assert.match(notes, /## 🚀 Downloads & Installation\n/);
  assert.doesNotMatch(notes, /Downloads & Installation \//);
  assert.doesNotMatch(notes, /操作系统/);
  assert.doesNotMatch(notes, /推荐安装包/);
  assert.doesNotMatch(notes, /下载 Windows/);
  assert.doesNotMatch(notes, /终端一键安装/);
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

test('buildReleaseSection preserves English block, separator, and Chinese block from changelog or merges with readme', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeik-changelog-test-'));
  const tag = 'v7.1.50';

  // 场景 1：CHANGELOG 本身包含标准双语分段模板（英文一段 + 分割线 + 中文一段）
  const bilingualContent = [
    '# Changelog\n',
    `## ${tag} (2026-10-04)\n`,
    '- **[Upstream HTTP/2] Fix disconnects**: Complete overhaul.\n',
    '---\n',
    '- **[上游 HTTP/2 协议] 根治断流**: 深度优化。\n',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), bilingualContent);

  const section1 = buildReleaseSection({ root, tag, day: '2026-10-04', commits: [] });
  const parts1 = section1.split('\n---\n');
  assert.equal(parts1.length, 2);
  assert.match(parts1[0], /Upstream HTTP\/2/);
  assert.match(parts1[1], /上游 HTTP\/2 协议/);

  // 场景 2：CHANGELOG 只有中文，而 README.en.md 提供英文段落，自动组合为双语分段
  const zhOnlyTag = 'v7.1.51';
  fs.appendFileSync(
    path.join(root, 'CHANGELOG.md'),
    `\n## ${zhOnlyTag} (2026-10-04)\n\n- **[桌面模型] 纯中文日志**: 修复空响应。\n`,
  );
  fs.writeFileSync(
    path.join(root, 'README.en.md'),
    `# Readme\n\n### ${zhOnlyTag} (2026-10-04)\n\n- **[Desktop Models] Pure English notes**: Fix empty response.\n`,
  );

  const section2 = buildReleaseSection({ root, tag: zhOnlyTag, day: '2026-10-04', commits: [] });
  const parts2 = section2.split('\n---\n');
  assert.equal(parts2.length, 2);
  assert.match(parts2[0], /Pure English notes/);
  assert.match(parts2[1], /纯中文日志/);

  // 验证生成的 Release Notes 整体格式：纯英文安装路由 -> 英文段落 -> 分割线 -> 中文段落
  const fullNotes = renderReleaseNotes(tag, section1);
  assert.match(fullNotes, /^## 🚀 Downloads & Installation\n/);
  assert.match(fullNotes, /JeikCode\.Desktop_7\.1\.50_x64-setup\.exe/);
  assert.match(fullNotes, /Upstream HTTP\/2/);
  assert.match(fullNotes, /---\n\n- \*\*\[上游 HTTP\/2 协议\]/);

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
