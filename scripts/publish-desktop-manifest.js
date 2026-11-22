#!/usr/bin/env node
/**
 * 汇总桌面端各平台打包产物与签名，生成 Tauri 标准 `desktop-updater.json`（含全平台 SHA256 `installers` 索引）。
 *
 * 用法：
 *   node scripts/publish-desktop-manifest.js --tag vX.Y.Z --dist desktop-dist [--repo jeikl/JeikCode] [--out desktop-dist/desktop-updater.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DESKTOP_INSTALLERS } = require('./platforms');

// Derived from scripts/platforms.json; never hand-list desktop keys here.
const DESKTOP_SPECS = DESKTOP_INSTALLERS.map((entry) => ({
  installerKey: entry.installerKey,
  tauriTarget: entry.tauriTarget || null,
  match: (name) => entry.assetSuffixes.some((suffix) => name.endsWith(suffix)),
}));

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function sha256AndSize(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}

function normalizeReleaseAssetName(name) {
  return String(name).replace(/\s+/g, '.');
}

function findMatchingAsset(files, predicate) {
  return files.find((filePath) => predicate(normalizeReleaseAssetName(path.basename(filePath))));
}

function readOptionalSig(files, assetPath) {
  if (!assetPath) return '';
  const direct = `${assetPath}.sig`;
  if (fs.existsSync(direct)) {
    return fs.readFileSync(direct, 'utf8').trim();
  }
  const targetSigName = `${normalizeReleaseAssetName(path.basename(assetPath))}.sig`;
  const found = findMatchingAsset(files, (name) => name === targetSigName);
  return found ? fs.readFileSync(found, 'utf8').trim() : '';
}

function buildDesktopManifest({ tag, distDir, repo = 'jeikl/JeikCode', pubDate, notes }) {
  const normalizedTag = tag.startsWith('v') || tag.startsWith('V') ? tag : `v${tag}`;
  const cleanVersion = normalizedTag.replace(/^v/i, '');
  const downloadBase = `https://github.com/${repo}/releases/download/${normalizedTag}`;
  const files = walkFiles(distDir);

  const platforms = {};
  const installers = {};

  for (const spec of DESKTOP_SPECS) {
    const filePath = findMatchingAsset(files, spec.match);
    if (!filePath) continue;
    const filename = normalizeReleaseAssetName(path.basename(filePath));
    const url = `${downloadBase}/${filename}`;
    const { sha256, size } = sha256AndSize(filePath);
    installers[spec.installerKey] = {
      url,
      filename,
      sha256,
      size,
    };

    if (spec.tauriTarget) {
      const signature = readOptionalSig(files, filePath);
      if (signature) {
        platforms[spec.tauriTarget] = {
          url,
          signature,
        };
      }
    }
  }

  return {
    version: cleanVersion,
    notes: notes || 'See release page for details',
    pub_date: pubDate || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms,
    installers,
  };
}

function parseArgs(argv) {
  const out = {
    tag: process.env.TAG_NAME || '',
    dist: 'desktop-dist',
    repo: process.env.GITHUB_REPOSITORY || 'jeikl/JeikCode',
    outFile: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') out.tag = argv[++i];
    else if (arg === '--dist') out.dist = argv[++i];
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--out') out.outFile = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tag) {
    console.error('Usage: node scripts/publish-desktop-manifest.js --tag vX.Y.Z [--dist desktop-dist] [--repo owner/repo]');
    process.exit(1);
  }
  const distDir = path.resolve(args.dist);
  const manifest = buildDesktopManifest({
    tag: args.tag,
    distDir,
    repo: args.repo,
  });
  const outPath = args.outFile ? path.resolve(args.outFile) : path.join(distDir, 'desktop-updater.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `desktop-updater.json written: version=${manifest.version}, signedPlatforms=${Object.keys(manifest.platforms).length}, installers=${Object.keys(manifest.installers).length}`,
  );
}

module.exports = {
  DESKTOP_SPECS,
  normalizeReleaseAssetName,
  buildDesktopManifest,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
