#!/usr/bin/env node
/**
 * JeikCode Version Bump Helper Script
 *
 * Usage:
 *   npm run bump          (default: bump beta, e.g. 7.1.41 -> 7.1.42-beta.1 or 7.1.42-beta.1 -> 7.1.42-beta.2)
 *   npm run bump:beta     (same as above)
 *   npm run bump:patch    (e.g. 7.1.41 -> 7.1.42)
 *   npm run bump:minor    (e.g. 7.1.41 -> 7.2.0)
 *   npm run bump:major    (e.g. 7.1.41 -> 8.0.0)
 *   node scripts/bump-version.js 7.1.42-beta.1
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function comparePrerelease(p1, p2) {
  if (!p1 && !p2) return 0;
  if (!p1 && p2) return 1;
  if (p1 && !p2) return -1;

  const id1 = p1.split('.');
  const id2 = p2.split('.');
  const len = Math.max(id1.length, id2.length);
  for (let i = 0; i < len; i++) {
    if (id1[i] === undefined) return -1;
    if (id2[i] === undefined) return 1;
    if (id1[i] === id2[i]) continue;

    const isNum1 = /^\d+$/.test(id1[i]);
    const isNum2 = /^\d+$/.test(id2[i]);

    if (isNum1 && isNum2) {
      const n1 = parseInt(id1[i], 10);
      const n2 = parseInt(id2[i], 10);
      if (n1 !== n2) return n1 > n2 ? 1 : -1;
    } else if (isNum1) {
      return -1;
    } else if (isNum2) {
      return 1;
    } else {
      const cmp = id1[i].localeCompare(id2[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function compareSemVer(a, b) {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.pre, pb.pre);
}

function getCurrentVersion() {
  const candidates = [];

  // Read workspace Cargo.toml
  const cargoPath = path.join(root, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    const content = fs.readFileSync(cargoPath, 'utf8');
    const match = content.match(/^version = "(.*?)"/m);
    if (match && match[1]) candidates.push(match[1]);
  }

  // Fallback / compare to git describe
  try {
    const tag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (tag) candidates.push(tag.replace(/^v/, ''));
  } catch {}

  if (candidates.length === 0) {
    return '7.1.49';
  }

  candidates.sort(compareSemVer);
  return candidates[candidates.length - 1];
}

function parseSemVer(v) {
  const clean = String(v).replace(/^v/, '').trim();
  const [core, ...pre] = clean.split('-');
  const [major, minor, patch] = core.split('.').map(n => parseInt(n, 10) || 0);
  return {
    raw: clean,
    major: major || 0,
    minor: minor || 0,
    patch: patch || 0,
    pre: pre.join('-'),
  };
}

function computeNextVersion(currentStr, targetType) {
  const parsed = parseSemVer(currentStr);

  if (/^v?\d+\.\d+\.\d+/.test(targetType) && targetType !== 'beta' && targetType !== 'patch' && targetType !== 'minor' && targetType !== 'major') {
    return targetType.replace(/^v/, '');
  }

  const mode = (targetType || 'beta').toLowerCase();

  if (mode === 'major') {
    return `${parsed.major + 1}.0.0`;
  }
  if (mode === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (mode === 'patch') {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  if (mode === 'beta') {
    if (parsed.pre && parsed.pre.startsWith('beta.')) {
      const num = parseInt(parsed.pre.slice(5), 10) || 0;
      return `${parsed.major}.${parsed.minor}.${parsed.patch}-beta.${num + 1}`;
    }
    // New beta series for next patch
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-beta.1`;
  }

  throw new Error(`Unknown bump mode or invalid version: ${targetType}`);
}

function skipJsonWhitespace(text, pos) {
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function scanJsonStringEnd(text, startQuote) {
  let i = startQuote + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return -1;
}

/**
 * 仅替换 JSON 顶层对象的 `version` 字段，保留原始缩进、单行数组与换行风格，
 * 避免嵌套子节点（如插件/依赖配置）中的同名 `version` 字段被正则误替换。
 */
function replaceTopLevelJsonVersion(text, newVersion) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.version !== 'string') {
    return text;
  }

  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = scanJsonStringEnd(text, i);
      if (end === -1) break;
      if (depth === 1) {
        let key;
        try {
          key = JSON.parse(text.slice(i, end));
        } catch {
          key = null;
        }
        const afterKey = skipJsonWhitespace(text, end);
        if (key === 'version' && text[afterKey] === ':') {
          const valStart = skipJsonWhitespace(text, afterKey + 1);
          if (text[valStart] === '"') {
            const valEnd = scanJsonStringEnd(text, valStart);
            if (valEnd !== -1) {
              return text.slice(0, valStart) + JSON.stringify(newVersion) + text.slice(valEnd);
            }
          }
        }
      }
      i = end;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return text;
}

function updateFile(filePath, updater) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = updater(original);
  if (original !== updated) {
    fs.writeFileSync(filePath, updated, 'utf8');
    return true;
  }
  return false;
}

function bumpAllFiles(newVersion, targetRoot = root) {
  const updatedFiles = [];

  // 1. Cargo.toml
  if (updateFile(path.join(targetRoot, 'Cargo.toml'), text => {
    return text.replace(/^version = ".*?"/m, `version = "${newVersion}"`);
  })) updatedFiles.push('Cargo.toml');

  // 2. webui/package.json
  if (updateFile(path.join(targetRoot, 'webui', 'package.json'), text => {
    return replaceTopLevelJsonVersion(text, newVersion);
  })) updatedFiles.push('webui/package.json');

  // 3. desktop/package.json
  if (updateFile(path.join(targetRoot, 'desktop', 'package.json'), text => {
    return replaceTopLevelJsonVersion(text, newVersion);
  })) updatedFiles.push('desktop/package.json');

  // 4. desktop/src-tauri/tauri.conf.json
  if (updateFile(path.join(targetRoot, 'desktop', 'src-tauri', 'tauri.conf.json'), text => {
    return replaceTopLevelJsonVersion(text, newVersion);
  })) updatedFiles.push('desktop/src-tauri/tauri.conf.json');

  // 5. desktop/src-tauri/Cargo.toml
  if (updateFile(path.join(targetRoot, 'desktop', 'src-tauri', 'Cargo.toml'), text => {
    return text.replace(/^version = ".*?"/m, `version = "${newVersion}"`);
  })) updatedFiles.push('desktop/src-tauri/Cargo.toml');

  // 6. packages/npm/package.json
  if (updateFile(path.join(targetRoot, 'packages', 'npm', 'package.json'), text => {
    return replaceTopLevelJsonVersion(text, newVersion);
  })) updatedFiles.push('packages/npm/package.json');

  // 7. root package.json
  if (updateFile(path.join(targetRoot, 'package.json'), text => {
    return replaceTopLevelJsonVersion(text, newVersion);
  })) updatedFiles.push('package.json');

  // 8. docs-site/.vitepress/theme/HeroImageWithVersion.vue
  if (updateFile(path.join(targetRoot, 'docs-site', '.vitepress', 'theme', 'HeroImageWithVersion.vue'), text => {
    if (newVersion.includes('-')) {
      return text.replace(/const betaVersion = ref\('v.*?'\)/, `const betaVersion = ref('v${newVersion}')`);
    } else {
      return text.replace(/const stableVersion = ref\('v.*?'\)/, `const stableVersion = ref('v${newVersion}')`);
    }
  })) updatedFiles.push('docs-site/.vitepress/theme/HeroImageWithVersion.vue');

  // 9. docs-site/package.json
  if (updateFile(path.join(targetRoot, 'docs-site', 'package.json'), text => {
    return replaceTopLevelJsonVersion(text, newVersion);
  })) updatedFiles.push('docs-site/package.json');

  // 10. package-lock.json files
  const lockFiles = [
    path.join(targetRoot, 'webui', 'package-lock.json'),
    path.join(targetRoot, 'desktop', 'package-lock.json'),
    path.join(targetRoot, 'docs-site', 'package-lock.json'),
  ];
  for (const lockPath of lockFiles) {
    if (updateFile(lockPath, text => {
      try {
        const d = JSON.parse(text);
        d.version = newVersion;
        if (d.packages && d.packages['']) {
          d.packages[''].version = newVersion;
        }
        return JSON.stringify(d, null, 2) + '\n';
      } catch {
        return text;
      }
    })) {
      updatedFiles.push(path.relative(targetRoot, lockPath).replace(/\\/g, '/'));
    }
  }

  // 11. Cargo.lock (Workspace packages)
  const workspaceCrates = [
    'jeikcode',
    'jeikcode-auth',
    'jeikcode-capabilities',
    'jeikcode-clix',
    'jeikcode-coding',
    'jeikcode-config',
    'jeikcode-daemon',
    'jeikcode-kernel',
    'jeikcode-review',
    'jeikcode-telemetry',
    'jeikcode-tuix',
    'jeikcode-updater',
  ];
  if (updateFile(path.join(targetRoot, 'Cargo.lock'), text => {
    let updated = text;
    for (const crate of workspaceCrates) {
      const regex = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = )"[^"]+"`, 'g');
      updated = updated.replace(regex, `$1"${newVersion}"`);
    }
    return updated;
  })) {
    updatedFiles.push('Cargo.lock');
  }

  // 12. desktop/src-tauri/Cargo.lock (jeikcode-desktop package)
  if (updateFile(path.join(targetRoot, 'desktop', 'src-tauri', 'Cargo.lock'), text => {
    const regex = /(\[\[package\]\]\r?\nname = "jeikcode-desktop"\r?\nversion = )"[^"]+"/g;
    return text.replace(regex, `$1"${newVersion}"`);
  })) {
    updatedFiles.push('desktop/src-tauri/Cargo.lock');
  }

  return updatedFiles;
}

function main() {
  const args = process.argv.slice(2);
  const targetType = args[0] || 'beta';
  const current = getCurrentVersion();
  const nextVersion = computeNextVersion(current, targetType);
  const nextTag = `v${nextVersion}`;

  console.log(`\n📦 JeikCode Version Bump`);
  console.log(`   Current version: ${current}`);
  console.log(`   Target version:  ${nextVersion}`);
  console.log(`   Target Git tag:  ${nextTag}\n`);

  const files = bumpAllFiles(nextVersion);
  if (files.length > 0) {
    console.log(`✅ Updated version to ${nextVersion} in:`);
    files.forEach(f => console.log(`   - ${f}`));
  } else {
    console.log(`ℹ️  No files needed updating (version already set to ${nextVersion}).`);
  }

  const isPrerelease = nextVersion.includes('-');
  console.log(`\n📌 Next steps for ${isPrerelease ? 'Prerelease (Beta)' : 'Stable Release'}:`);
  console.log(`   1. Update CHANGELOG.md following the standard template (English + --- + Chinese).`);
  console.log(`      ⚠️  Notice: Do NOT copy changelog history into README files! READMEs maintain a single permanent reference.`);
  console.log(`   2. git commit -am "chore(release): bump version to ${nextTag}"`);
  console.log(`   3. git tag ${nextTag}`);
  if (isPrerelease) {
    console.log(`   4. git push origin ${nextTag}`);
    console.log(`      (Or push to beta branch: git push origin beta)`);
  } else {
    console.log(`   4. git push origin main ${nextTag}`);
  }
  console.log('');
}

module.exports = {
  comparePrerelease,
  compareSemVer,
  parseSemVer,
  computeNextVersion,
  replaceTopLevelJsonVersion,
  bumpAllFiles,
};

if (require.main === module) {
  main();
}
