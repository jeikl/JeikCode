#!/usr/bin/env node
'use strict';

const fs = require('fs');

function json(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function cargoVersion(path) {
  const text = fs.readFileSync(path, 'utf8');
  const match = text.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('workspace version not found in ' + path);
  return match[1];
}

function packageVersion(path) {
  const value = json(path).version;
  if (!value) throw new Error('version not found in ' + path);
  return String(value);
}

function packageLockVersion(path) {
  const lock = json(path);
  const root = lock.packages && lock.packages[''] && lock.packages[''].version;
  if (!lock.version || !root) throw new Error('root version not found in ' + path);
  if (String(lock.version) !== String(root)) {
    throw new Error(path + ' top-level version ' + lock.version + ' != root package version ' + root);
  }
  return String(root);
}

function tauriCargoVersion(path) {
  const text = fs.readFileSync(path, 'utf8');
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('package version not found in ' + path);
  return match[1];
}

function cargoLockVersion(path) {
  const text = fs.readFileSync(path, 'utf8');
  const match = text.match(/\[\[package\]\]\r?\nname = "jeikcode"\r?\nversion = "([^"]+)"/m);
  if (!match) throw new Error('jeikcode package version not found in ' + path);
  return match[1];
}

const expected = cargoVersion('Cargo.toml');
const strictChecks = [
  ['package.json', packageVersion],
  ['webui/package.json', packageVersion],
  ['desktop/package.json', packageVersion],
  ['desktop/src-tauri/Cargo.toml', tauriCargoVersion],
  ['desktop/src-tauri/tauri.conf.json', packageVersion],
  ['packages/npm/package.json', packageVersion],
  ['Cargo.lock', cargoLockVersion],
];

const optionalChecks = [
  ['webui/package-lock.json', packageLockVersion],
  ['desktop/package-lock.json', packageLockVersion],
  ['docs-site/package.json', packageVersion],
  ['docs-site/package-lock.json', packageLockVersion],
];

const mismatches = [];
for (const [path, readVersion] of strictChecks) {
  try {
    const actual = readVersion(path);
    if (actual !== expected) mismatches.push(path + ': ' + actual + ' (expected ' + expected + ')');
  } catch (e) {
    mismatches.push(path + ': ' + e.message);
  }
}

for (const [path, readVersion] of optionalChecks) {
  try {
    const actual = readVersion(path);
    if (actual !== expected) {
      console.warn('Notice: ' + path + ' version is ' + actual + ' (target ' + expected + ')');
    }
  } catch {
    // Non-blocking for optional manifests
  }
}

if (mismatches.length) {
  console.error('Version consistency check failed:\n- ' + mismatches.join('\n- '));
  process.exit(1);
}

console.log('Version consistency OK: ' + expected + ' across core shipping manifests.');
