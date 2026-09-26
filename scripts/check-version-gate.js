#!/usr/bin/env node
/**
 * 自动化发版版本号门禁检查器 (Release Version Gatekeeper)
 *
 * 检查当前准备发布的 Git Tag 版本号是否严格大于当前代码仓中已有或最新发布的版本号。
 * 必须遵循语义化版本号规范 (SemVer)，若等于或小于上一个版本则直接拒绝发版。
 */
const fs = require('fs');
const https = require('https');

const tag = process.env.TAG_NAME || process.argv[2];
const repo = process.env.REPO || process.argv[3] || 'jeikl/JeikCode';
const token = process.env.GITHUB_TOKEN;

if (!tag) {
  console.error('❌ Error: Missing tag name. Usage: node scripts/check-version-gate.js <tag> [repo]');
  process.exit(1);
}

function parseSemVer(v) {
  const clean = String(v).replace(/^v/, '').trim();
  const [core, ...pre] = clean.split('-');
  const parts = core.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { raw: clean, parts, pre: pre.join('-') };
}

function compareSemVer(v1, v2) {
  const s1 = parseSemVer(v1);
  const s2 = parseSemVer(v2);
  for (let i = 0; i < 3; i++) {
    if (s1.parts[i] > s2.parts[i]) return 1;
    if (s1.parts[i] < s2.parts[i]) return -1;
  }
  if (!s1.pre && s2.pre) return 1;
  if (s1.pre && !s2.pre) return -1;
  if (s1.pre && s2.pre) return s1.pre.localeCompare(s2.pre);
  return 0;
}

async function fetchPreviousGitHubRelease(currentTag) {
  if (!token) return null;
  const url = `https://api.github.com/repos/${repo}/releases?per_page=15`;
  const options = {
    headers: {
      'User-Agent': 'JeikCode-Release-Gate',
      'Accept': 'application/vnd.github+json',
      'Authorization': `token ${token}`
    }
  };
  return new Promise((resolve) => {
    https.get(url, options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const list = JSON.parse(body);
          if (Array.isArray(list)) {
            for (const r of list) {
              if (r.tag_name && compareSemVer(r.tag_name, currentTag) !== 0) {
                return resolve(r.tag_name);
              }
            }
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function getLocalBaselineVersions(currentTag) {
  const baselines = [];

  // 1. Check latest.json (exclude current tag itself)
  if (fs.existsSync('latest.json')) {
    try {
      const manifest = JSON.parse(fs.readFileSync('latest.json', 'utf8'));
      if (manifest.version && compareSemVer(manifest.version, currentTag) !== 0) {
        baselines.push(manifest.version);
      }
    } catch {}
  }

  // 2. Check Cargo.toml (exclude current tag itself)
  if (fs.existsSync('Cargo.toml')) {
    try {
      const content = fs.readFileSync('Cargo.toml', 'utf8');
      const match = content.match(/^version = "(.*?)"/m);
      if (match && match[1] && compareSemVer(match[1], currentTag) !== 0) {
        baselines.push(match[1]);
      }
    } catch {}
  }

  return baselines;
}

async function run() {
  console.log(`🔍 Checking release version gate for target tag: ${tag}...`);

  const baselines = getLocalBaselineVersions(tag);

  const previousRelease = await fetchPreviousGitHubRelease(tag);
  if (previousRelease) {
    console.log(`   Fetched previous GitHub release: ${previousRelease}`);
    baselines.push(previousRelease);
  }

  if (baselines.length === 0) {
    console.log('   No existing version baseline found. First release allowed.');
    process.exit(0);
  }

  // 找出基线中的最高版本
  let highestBaseline = baselines[0];
  for (const v of baselines) {
    if (compareSemVer(v, highestBaseline) > 0) {
      highestBaseline = v;
    }
  }

  console.log(`   Current highest baseline version: ${highestBaseline}`);
  console.log(`   Target release version:          ${tag}`);

  const cmp = compareSemVer(tag, highestBaseline);
  if (cmp <= 0) {
    console.error('\n================================================================================');
    console.error('❌ RELEASE GATE REJECTED: New version is not strictly greater than previous version!');
    console.error(`   Target Version:   ${tag}`);
    console.error(`   Previous Version: ${highestBaseline}`);
    console.error('   Rule: Every new release MUST have a version strictly greater than the previous.');
    console.error('================================================================================\n');
    process.exit(1);
  }

  console.log(`✅ Release version gate passed: ${tag} > ${highestBaseline}\n`);
}

run().catch(err => {
  console.error('❌ Error executing version gate:', err);
  process.exit(1);
});
