#!/usr/bin/env node
/**
 * Single source of truth for release platforms.
 *
 * `scripts/platforms.json` is the only place that lists CLI targets, desktop
 * bundles, updater keys, npm platform tags and installer arch aliases.
 *
 *   node scripts/platforms.js --check              # CI gate, never mutates files
 *   node scripts/platforms.js --write              # regenerate marked blocks
 *   node scripts/platforms.js --emit-github-matrix # plan-job outputs for build.yml
 *
 * Marked blocks in installers/docs are generated; edit the JSON and re-run
 * `--write` instead of editing inside the markers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(__dirname, 'platforms.json');

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

const data = load();

const CLI = data.cli;
const CLI_BY_ID = new Map(CLI.map((entry) => [entry.id, entry]));
const CLI_TARGETS = CLI.map((entry) => entry.id);
const DESKTOP_BUILDS = data.desktopBuilds;
const DESKTOP_INSTALLERS = data.desktopInstallers;
const NPM_PLATFORMS = data.npm.platforms;
const POLICY = data.policy;

const OS_LABEL = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' };
const OS_LABEL_ZH = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' };
const ARCH_LABEL = { arm64: 'ARM64', x64: 'x64' };

function fail(message) {
  throw new Error(message);
}

function validate() {
  if (data.schemaVersion !== 1) fail(`platforms.json: unsupported schemaVersion ${data.schemaVersion}`);
  if (!Array.isArray(CLI) || !CLI.length) fail('platforms.json: cli must be a non-empty array');

  const ids = new Set();
  const triples = new Set();
  for (const entry of CLI) {
    for (const field of ['id', 'buildFamily', 'os', 'arch', 'rustOs', 'rustArch', 'triple', 'runner', 'support']) {
      if (typeof entry[field] !== 'string' || !entry[field]) {
        fail(`platforms.json: cli entry ${entry.id || '<unknown>'} is missing ${field}`);
      }
    }
    if (ids.has(entry.id)) fail(`platforms.json: duplicate cli id ${entry.id}`);
    if (triples.has(entry.triple)) fail(`platforms.json: duplicate cli triple ${entry.triple}`);
    if (!['macos', 'linux', 'windows'].includes(entry.buildFamily)) {
      fail(`platforms.json: ${entry.id} has unknown buildFamily ${entry.buildFamily}`);
    }
    if (!['arm64', 'x64'].includes(entry.arch)) {
      fail(`platforms.json: ${entry.id} has unknown arch ${entry.arch}`);
    }
    if (!Array.isArray(entry.unameArch) || !entry.unameArch.length) {
      fail(`platforms.json: ${entry.id} needs unameArch aliases`);
    }
    ids.add(entry.id);
    triples.add(entry.triple);
  }

  for (const build of DESKTOP_BUILDS) {
    if (!CLI_BY_ID.has(build.cliTarget)) {
      fail(`platforms.json: desktop build ${build.key} points at unknown cli target ${build.cliTarget}`);
    }
  }

  const installerKeys = new Set();
  for (const installer of DESKTOP_INSTALLERS) {
    if (installerKeys.has(installer.installerKey)) {
      fail(`platforms.json: duplicate installerKey ${installer.installerKey}`);
    }
    if (!Array.isArray(installer.assetSuffixes) || !installer.assetSuffixes.length) {
      fail(`platforms.json: installer ${installer.installerKey} needs assetSuffixes`);
    }
    if (!['windows', 'macos', 'linux'].includes(installer.hostOs)) {
      fail(`platforms.json: installer ${installer.installerKey} has unknown hostOs`);
    }
    installerKeys.add(installer.installerKey);
  }

  for (const npm of NPM_PLATFORMS) {
    if (!CLI_BY_ID.has(npm.cli)) fail(`platforms.json: npm entry points at unknown cli target ${npm.cli}`);
    if (!npm.tag) fail(`platforms.json: npm entry for ${npm.cli} needs a tag`);
  }
}

function uniqueAliases(predicate) {
  const seen = [];
  for (const entry of CLI.filter(predicate)) {
    for (const alias of entry.unameArch || []) {
      if (!seen.includes(alias)) seen.push(alias);
    }
  }
  return seen;
}

function groupUnsupported() {
  return POLICY.unsupportedArches.map((group) => ({
    aliases: group.aliases,
    message: group.message,
  }));
}

function renderInstallOs() {
  const byOs = new Map();
  for (const entry of CLI) {
    if (!byOs.has(entry.os)) byOs.set(entry.os, { aliases: [], ext: entry.ext });
    for (const alias of entry.unameOs || []) {
      if (!byOs.get(entry.os).aliases.includes(alias)) byOs.get(entry.os).aliases.push(alias);
    }
  }
  const lines = ['case "$uname_s" in'];
  for (const os of ['darwin', 'linux', 'windows']) {
    const info = byOs.get(os);
    if (!info) continue;
    const pattern = info.aliases.join('|');
    const assign = os === 'windows'
      ? `os="windows"; ext="${info.ext}"`
      : `os="${os}"`;
    lines.push(`    ${pattern}) ${assign} ;;`);
  }
  lines.push('    *) echo "Unsupported OS: $uname_s (Windows users: download the release binary)" >&2; exit 1 ;;');
  lines.push('esac');
  return lines.join('\n');
}

function renderInstallArch() {
  const arm = uniqueAliases((entry) => entry.arch === 'arm64');
  const x64 = uniqueAliases((entry) => entry.arch === 'x64');
  const lines = ['case "$uname_m" in'];
  if (arm.length) lines.push(`    ${arm.join('|')}) arch="arm64" ;;`);
  if (x64.length) lines.push(`    ${x64.join('|')}) arch="x64" ;;`);
  for (const group of groupUnsupported()) {
    lines.push(`    ${group.aliases.join('|')})`);
    lines.push(`        echo "Error: $uname_m: ${group.message}" >&2`);
    lines.push('        exit 1');
    lines.push('        ;;');
  }
  lines.push('    *) echo "Unsupported architecture: $uname_m (supported: x86_64, aarch64)" >&2; exit 1 ;;');
  lines.push('esac');
  return lines.join('\n');
}

function renderInstallPs1Arch() {
  const lines = ['switch ($RealArch) {'];
  for (const entry of CLI.filter((item) => item.os === 'windows')) {
    for (const alias of entry.windowsEnvArch || []) {
      lines.push(`    "${alias}" { $arch = "${entry.arch}" }`);
    }
  }
  lines.push('    default {');
  lines.push('        Write-Host "Unsupported architecture: $RealArch (supported: AMD64, ARM64)" -ForegroundColor Red');
  lines.push('        exit 1');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function cliNotes(entry, lang) {
  const zh = lang === 'zh';
  if (entry.os === 'linux') return zh ? '静态 musl 单文件' : 'Static musl binary';
  if (entry.os === 'darwin') return zh ? 'Mach-O 单文件' : 'Mach-O binary';
  return zh ? '`.exe` 单文件' : '`.exe` binary';
}

function renderMarkdownCli(lang) {
  const zh = lang === 'zh';
  const header = zh
    ? ['| 无头二进制 | 操作系统 | 架构 | 说明 |', '| --- | --- | --- | --- |']
    : ['| Headless binary | OS | Architecture | Notes |', '| --- | --- | --- | --- |'];
  const rows = CLI.map((entry) => {
    const os = zh ? OS_LABEL_ZH[entry.os] : OS_LABEL[entry.os];
    return `| \`${entry.id}\` | ${os} | ${ARCH_LABEL[entry.arch]} | ${cliNotes(entry, lang)} |`;
  });
  return [...header, ...rows].join('\n');
}

function desktopDocFields(key) {
  const [os, arch] = key.split('-');
  return { os, arch, label: key };
}

function renderMarkdownDesktop(lang) {
  const zh = lang === 'zh';
  const header = zh
    ? ['| 桌面安装包 | 操作系统 | 架构 | 格式 |', '| --- | --- | --- | --- |']
    : ['| Desktop package | OS | Architecture | Formats |', '| --- | --- | --- | --- |'];
  const rows = DESKTOP_BUILDS.map((build) => {
    const fields = desktopDocFields(build.key);
    const os = zh ? OS_LABEL_ZH[fields.os] : OS_LABEL[fields.os];
    return `| \`${build.key}\` | ${os} | ${ARCH_LABEL[fields.arch]} | ${build.formats} |`;
  });
  return [...header, ...rows].join('\n');
}

const BLOCKS = [
  {
    file: 'scripts/install.sh',
    name: 'os',
    prefix: '#',
    render: () => renderInstallOs(),
  },
  {
    file: 'scripts/install.sh',
    name: 'arch',
    prefix: '#',
    render: () => renderInstallArch(),
  },
  {
    file: 'scripts/install.ps1',
    name: 'arch',
    prefix: '#',
    render: () => renderInstallPs1Arch(),
  },
  {
    file: 'docs-site/guide/supported-platforms.md',
    name: 'cli',
    prefix: '<!--',
    suffix: '-->',
    render: () => renderMarkdownCli('en'),
  },
  {
    file: 'docs-site/guide/supported-platforms.md',
    name: 'desktop',
    prefix: '<!--',
    suffix: '-->',
    render: () => renderMarkdownDesktop('en'),
  },
  {
    file: 'docs-site/zh/guide/supported-platforms.md',
    name: 'cli',
    prefix: '<!--',
    suffix: '-->',
    render: () => renderMarkdownCli('zh'),
  },
  {
    file: 'docs-site/zh/guide/supported-platforms.md',
    name: 'desktop',
    prefix: '<!--',
    suffix: '-->',
    render: () => renderMarkdownDesktop('zh'),
  },
];

function marker(prefix, suffix, name, close) {
  const arrow = close ? '<<<' : '>>>';
  return `${prefix} ${arrow} platforms:${name}${suffix ? ` ${suffix}` : ''}`;
}

function replaceBlock(text, block) {
  const start = marker(block.prefix, block.suffix, block.name, false);
  const end = marker(block.prefix, block.suffix, block.name, true);
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    fail(`${block.file}: missing generated block markers for platforms:${block.name}`);
  }
  const bodyStart = startIndex + start.length;
  // `.gitattributes` checks out `*.ps1` with CRLF on every OS. Preserve the
  // file's EOL when writing the generated block, and normalize only for the
  // staleness comparison so Windows and Linux reach the same verdict.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = block.render();
  const renderedForFile = rendered.replace(/\n/g, eol);
  const currentBody = text.slice(bodyStart, endIndex);
  return {
    text: `${text.slice(0, bodyStart)}${eol}${renderedForFile}${eol}${text.slice(endIndex)}`,
    changed: currentBody.replace(/\r\n/g, '\n').trim() !== rendered.trim(),
  };
}

function writeBlocks() {
  validate();
  const byFile = new Map();
  for (const block of BLOCKS) {
    if (!byFile.has(block.file)) byFile.set(block.file, []);
    byFile.get(block.file).push(block);
  }
  let changed = 0;
  for (const [file, blocks] of byFile) {
    const absolute = path.join(ROOT, file);
    let text = fs.readFileSync(absolute, 'utf8');
    for (const block of blocks) {
      const result = replaceBlock(text, block);
      text = result.text;
      if (result.changed) changed += 1;
    }
    fs.writeFileSync(absolute, text);
  }
  console.log(`platforms: regenerated ${changed} block(s) across ${byFile.size} file(s)`);
}

function extractNpmTags() {
  const binFile = path.join(ROOT, 'packages/npm/bin/jeikcode.js');
  const buildFile = path.join(ROOT, 'packages/npm/scripts/build_npm_package.sh');
  const bin = fs.readFileSync(binFile, 'utf8');
  const build = fs.readFileSync(buildFile, 'utf8');

  const binTags = new Set();
  for (const match of bin.matchAll(/jeikcode-([a-z0-9]+-[a-z0-9]+)/g)) {
    const tag = match[1];
    if (/^(darwin|linux|win32)-/.test(tag)) binTags.add(tag);
  }

  const buildTags = new Set();
  for (const match of build.matchAll(/^\s*"([a-z0-9]+-[a-z0-9]+):([a-z0-9]+):([a-z0-9]+)"/gm)) {
    buildTags.add(match[1]);
  }

  return { binTags, buildTags, bin, build };
}

function checkNpm() {
  const expected = new Set(NPM_PLATFORMS.map((entry) => entry.tag));
  const { binTags, buildTags, bin, build } = extractNpmTags();
  const errors = [];

  const sameSet = (actual, label) => {
    for (const tag of expected) if (!actual.has(tag)) errors.push(`${label}: missing npm platform ${tag}`);
    for (const tag of actual) if (!expected.has(tag)) errors.push(`${label}: unexpected npm platform ${tag}`);
  };
  sameSet(binTags, 'packages/npm/bin/jeikcode.js');
  sameSet(buildTags, 'packages/npm/scripts/build_npm_package.sh');

  for (const [file, text] of [
    ['packages/npm/bin/jeikcode.js', bin],
    ['packages/npm/scripts/build_npm_package.sh', build],
    ['packages/npm/README.md', fs.readFileSync(path.join(ROOT, 'packages/npm/README.md'), 'utf8')],
  ]) {
    if (/ohos|HarmonyOS/i.test(text)) errors.push(`${file}: still mentions HarmonyOS/ohos`);
  }
  return errors;
}

function checkConsumers() {
  const errors = [];

  // publish-release.js must derive its list instead of hardcoding one.
  const publishRelease = require(path.join(ROOT, 'scripts/publish-release.js'));
  const releaseTargets = publishRelease.TARGETS || [];
  if (JSON.stringify(releaseTargets) !== JSON.stringify(CLI_TARGETS)) {
    errors.push(`scripts/publish-release.js: TARGETS (${releaseTargets.join(',')}) != platforms.json cli (${CLI_TARGETS.join(',')})`);
  }

  // The desktop manifest specs must come from desktopInstallers.
  const desktopManifest = require(path.join(ROOT, 'scripts/publish-desktop-manifest.js'));
  const specs = desktopManifest.DESKTOP_SPECS || [];
  const expectedKeys = DESKTOP_INSTALLERS.map((entry) => entry.installerKey);
  const actualKeys = specs.map((entry) => entry.installerKey);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    errors.push(`scripts/publish-desktop-manifest.js: installer keys (${actualKeys.join(',')}) != platforms.json (${expectedKeys.join(',')})`);
  }

  // Installers must not advertise dropped platforms.
  for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (/HarmonyOS|ohos/i.test(text)) errors.push(`${file}: still mentions HarmonyOS/ohos`);
  }

  errors.push(...checkNpm());
  return errors;
}

function checkBlocks() {
  const errors = [];
  const cache = new Map();
  for (const block of BLOCKS) {
    const absolute = path.join(ROOT, block.file);
    if (!cache.has(absolute)) cache.set(absolute, fs.readFileSync(absolute, 'utf8'));
    try {
      const result = replaceBlock(cache.get(absolute), block);
      if (result.changed) {
        errors.push(`${block.file}: generated block platforms:${block.name} is stale; run node scripts/platforms.js --write`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

function collectErrors() {
  validate();
  return [...checkBlocks(), ...checkConsumers()];
}

function check() {
  const errors = collectErrors();
  if (errors.length) {
    console.error('Platform consistency check failed:\n- ' + errors.join('\n- '));
    process.exit(1);
  }
  console.log(`Platform consistency OK: ${CLI_TARGETS.length} CLI targets, ${DESKTOP_BUILDS.length} desktop bundles, ${NPM_PLATFORMS.length} npm platforms.`);
}

function emitGithubMatrix() {
  validate();
  const families = {};
  for (const entry of CLI) {
    if (!families[entry.buildFamily]) families[entry.buildFamily] = [];
    families[entry.buildFamily].push({ target: entry.triple, arch: entry.arch });
  }
  for (const [family, include] of Object.entries(families)) {
    console.log(`${family}=${JSON.stringify({ include })}`);
  }
  console.log(`desktop=${JSON.stringify({ include: DESKTOP_BUILDS })}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--write')) return writeBlocks();
  if (args.includes('--check')) return check();
  if (args.includes('--emit-github-matrix')) return emitGithubMatrix();
  console.error('Usage: node scripts/platforms.js --check | --write | --emit-github-matrix');
  process.exit(1);
}

module.exports = {
  ROOT,
  DATA_FILE,
  data,
  POLICY,
  CLI,
  CLI_TARGETS,
  CLI_BY_ID,
  DESKTOP_BUILDS,
  DESKTOP_INSTALLERS,
  NPM_PLATFORMS,
  validate,
  collectErrors,
  check,
  writeBlocks,
  emitGithubMatrix,
  assetName(tag, target) {
    const entry = CLI_BY_ID.get(target);
    if (!entry) fail(`unknown CLI target: ${target}`);
    return `jeikcode-${tag}-${target}${entry.ext}`;
  },
  matrix(family) {
    return {
      include: CLI.filter((entry) => entry.buildFamily === family).map((entry) => ({
        target: entry.triple,
        arch: entry.arch,
      })),
    };
  },
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
