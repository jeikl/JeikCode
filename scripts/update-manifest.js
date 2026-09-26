#!/usr/bin/env node
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const tag = process.env.TAG_NAME || process.argv[2];
const repo = process.env.REPO || process.argv[3] || 'jeikl/JeikCode';
const token = process.env.GITHUB_TOKEN;

if (!tag) {
  console.error('Usage: node scripts/update-manifest.js <tag> [repo]');
  process.exit(1);
}

const cleanVersion = tag.replace(/^v/, '');
console.log(`Updating release manifest and repository metadata for tag: ${tag} (${cleanVersion}) in ${repo}...`);

async function fetchRelease() {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const options = {
    headers: {
      'User-Agent': 'JeikCode-Release-Bot',
      'Accept': 'application/vnd.github+json'
    }
  };
  if (token) {
    options.headers['Authorization'] = `token ${token}`;
  }
  return new Promise((resolve, reject) => {
    https.get(url, options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.message && !json.assets) {
            return reject(new Error(`GitHub API error: ${json.message}`));
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse release response: ${body}`));
        }
      });
    }).on('error', reject);
  });
}

async function downloadAndHash(url) {
  return new Promise((resolve, reject) => {
    function follow(targetUrl) {
      https.get(targetUrl, { headers: { 'User-Agent': 'JeikCode-Release-Bot' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`));
        }
        const hash = crypto.createHash('sha256');
        let size = 0;
        res.on('data', chunk => {
          hash.update(chunk);
          size += chunk.length;
        });
        res.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
      }).on('error', reject);
    }
    follow(url);
  });
}

async function run() {
  const release = await fetchRelease();
  if (!release.assets || release.assets.length === 0) {
    console.error('No assets found in release:', release);
    process.exit(1);
  }

  const binaries = {};
  for (const asset of release.assets) {
    let target = null;
    if (asset.name === `jeikcode-${tag}-windows-x64.exe`) target = 'windows-x64';
    else if (asset.name === `jeikcode-${tag}-windows-arm64.exe`) target = 'windows-arm64';
    else if (asset.name === `jeikcode-${tag}-linux-x64`) target = 'linux-x64';
    else if (asset.name === `jeikcode-${tag}-linux-arm64`) target = 'linux-arm64';
    else if (asset.name === `jeikcode-${tag}-darwin-x64`) target = 'darwin-x64';
    else if (asset.name === `jeikcode-${tag}-darwin-arm64`) target = 'darwin-arm64';

    if (target) {
      console.log(`Fetching & hashing ${asset.name} (${target}) ...`);
      const info = await downloadAndHash(asset.browser_download_url);
      binaries[target] = info;
      console.log(`  -> ${target}: ${info.size} bytes, sha256: ${info.sha256}`);
    }
  }

  if (Object.keys(binaries).length === 0) {
    console.error('No recognized target binaries found in release assets.');
    process.exit(1);
  }

  // 1. 写回 latest.json
  const manifest = {
    version: tag,
    released_at: new Date().toISOString().slice(0, 10),
    binaries: binaries
  };
  fs.writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`latest.json successfully generated with ${Object.keys(binaries).length} targets.`);

  // 2. 自动同步 Cargo.toml
  if (fs.existsSync('Cargo.toml')) {
    let c = fs.readFileSync('Cargo.toml', 'utf8');
    c = c.replace(/^version = ".*"/m, `version = "${cleanVersion}"`);
    fs.writeFileSync('Cargo.toml', c);
    console.log(`Cargo.toml version updated to ${cleanVersion}`);
  }

  // 3. 自动同步 scripts/install.ps1 与 scripts/install.sh
  if (fs.existsSync('scripts/install.ps1')) {
    let c = fs.readFileSync('scripts/install.ps1', 'utf8');
    c = c.replace(/\$DefaultVersion = ".*"/, `$DefaultVersion = "${tag}"`);
    fs.writeFileSync('scripts/install.ps1', c);
    console.log(`scripts/install.ps1 DefaultVersion updated to ${tag}`);
  }
  if (fs.existsSync('scripts/install.sh')) {
    let c = fs.readFileSync('scripts/install.sh', 'utf8');
    c = c.replace(/DEFAULT_VERSION=".*"/, `DEFAULT_VERSION="${tag}"`);
    fs.writeFileSync('scripts/install.sh', c);
    console.log(`scripts/install.sh DEFAULT_VERSION updated to ${tag}`);
  }

  // 4. 自动同步 README*.md 徽章
  for (const file of ['README.md', 'README.zh-CN.md', 'README.en.md']) {
    if (fs.existsSync(file)) {
      let c = fs.readFileSync(file, 'utf8');
      c = c.replace(/badge\/version-[0-9a-zA-Z.-]+-blue\.svg/g, `badge/version-${cleanVersion}-blue.svg`);
      c = c.replace(/badge\/Releases-v?[0-9a-zA-Z.-]+-00f2fe/g, `badge/Releases-${tag}-00f2fe`);
      fs.writeFileSync(file, c);
      console.log(`${file} version badges updated.`);
    }
  }
}

run().catch(err => {
  console.error('Fatal error in update-manifest:', err);
  process.exit(1);
});
