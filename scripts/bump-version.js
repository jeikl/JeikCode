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

function compareSemVer(a, b) {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.raw.localeCompare(pb.raw);
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

function bumpAllFiles(newVersion) {
  const updatedFiles = [];

  // 1. Cargo.toml
  if (updateFile(path.join(root, 'Cargo.toml'), text => {
    return text.replace(/^version = ".*?"/m, `version = "${newVersion}"`);
  })) updatedFiles.push('Cargo.toml');

  // 2. webui/package.json
  if (updateFile(path.join(root, 'webui', 'package.json'), text => {
    return text.replace(/"version":\s*".*?"/, `"version": "${newVersion}"`);
  })) updatedFiles.push('webui/package.json');

  // 3. desktop/package.json
  if (updateFile(path.join(root, 'desktop', 'package.json'), text => {
    return text.replace(/"version":\s*".*?"/, `"version": "${newVersion}"`);
  })) updatedFiles.push('desktop/package.json');

  // 4. desktop/src-tauri/tauri.conf.json
  if (updateFile(path.join(root, 'desktop', 'src-tauri', 'tauri.conf.json'), text => {
    return text.replace(/"version":\s*".*?"/, `"version": "${newVersion}"`);
  })) updatedFiles.push('desktop/src-tauri/tauri.conf.json');

  // 5. desktop/src-tauri/Cargo.toml
  if (updateFile(path.join(root, 'desktop', 'src-tauri', 'Cargo.toml'), text => {
    return text.replace(/^version = ".*?"/m, `version = "${newVersion}"`);
  })) updatedFiles.push('desktop/src-tauri/Cargo.toml');

  // 6. packages/npm/package.json
  if (updateFile(path.join(root, 'packages', 'npm', 'package.json'), text => {
    return text.replace(/"version":\s*".*?"/, `"version": "${newVersion}"`);
  })) updatedFiles.push('packages/npm/package.json');

  // 7. root package.json
  if (updateFile(path.join(root, 'package.json'), text => {
    return text.replace(/"version":\s*".*?"/, `"version": "${newVersion}"`);
  })) updatedFiles.push('package.json');

  // 8. docs-site/.vitepress/theme/HeroImageWithVersion.vue
  if (updateFile(path.join(root, 'docs-site', '.vitepress', 'theme', 'HeroImageWithVersion.vue'), text => {
    return text
      .replace(/const version = ref\('v.*?'\)/, `const version = ref('v${newVersion}')`)
      .replace(/const version = 'v.*?'/, `const version = 'v${newVersion}'`);
  })) updatedFiles.push('docs-site/.vitepress/theme/HeroImageWithVersion.vue');

  // 9. docs-site/package.json
  if (updateFile(path.join(root, 'docs-site', 'package.json'), text => {
    return text.replace(/"version":\s*".*?"/, `"version": "${newVersion}"`);
  })) updatedFiles.push('docs-site/package.json');

  // 10. package-lock.json files
  const lockFiles = [
    path.join(root, 'webui', 'package-lock.json'),
    path.join(root, 'desktop', 'package-lock.json'),
    path.join(root, 'docs-site', 'package-lock.json'),
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
      updatedFiles.push(path.relative(root, lockPath).replace(/\\/g, '/'));
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
  if (updateFile(path.join(root, 'Cargo.lock'), text => {
    let updated = text;
    for (const crate of workspaceCrates) {
      const regex = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = )"[^"]+"`, 'g');
      updated = updated.replace(regex, `$1"${newVersion}"`);
    }
    return updated;
  })) {
    updatedFiles.push('Cargo.lock');
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
  console.log(`   git commit -am "chore(release): bump version to ${nextTag}"`);
  console.log(`   git tag ${nextTag}`);
  if (isPrerelease) {
    console.log(`   git push origin ${nextTag}`);
    console.log(`   (Or push to beta branch: git push origin beta)`);
  } else {
    console.log(`   git push origin main ${nextTag}`);
  }
  console.log('');
}

if (require.main === module) {
  main();
}
