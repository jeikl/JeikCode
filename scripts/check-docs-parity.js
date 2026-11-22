#!/usr/bin/env node
/**
 * Docs parity gate. English is the source of truth:
 *   - README.md vs every README.<lang>.md
 *   - docs-site/<page>.md vs docs-site/zh/<page>.md
 *
 * Compares language-agnostic structure (heading levels, code fences, table
 * rows) so a translated page cannot silently lag behind the English version.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HEADING = /^(#{1,6})\s+/;

function signature(text) {
  const headings = [];
  let fences = 0;
  let tableRows = 0;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) headings.push(heading[1].length);
    if (line.startsWith('```')) fences += 1;
    if (line.startsWith('|')) tableRows += 1;
  }
  return { headings, fences, tableRows };
}

function describe(sig) {
  return `headings=${sig.headings.join(',')} fences=${sig.fences} tableRows=${sig.tableRows}`;
}

function compare(label, sourcePath, targetPath, errors) {
  const source = signature(fs.readFileSync(path.join(ROOT, sourcePath), 'utf8'));
  const target = signature(fs.readFileSync(path.join(ROOT, targetPath), 'utf8'));
  if (JSON.stringify(source.headings) !== JSON.stringify(target.headings)) {
    errors.push(`${label}: heading structure drifted\n  source ${sourcePath}: ${describe(source)}\n  target ${targetPath}: ${describe(target)}`);
  }
  if (source.fences !== target.fences) {
    errors.push(`${label}: code-fence count drifted (${sourcePath}=${source.fences}, ${targetPath}=${target.fences})`);
  }
  if (source.tableRows !== target.tableRows) {
    errors.push(`${label}: table-row count drifted (${sourcePath}=${source.tableRows}, ${targetPath}=${target.tableRows})`);
  }
}

function readmeErrors() {
  const errors = [];
  const source = 'README.md';
  const files = fs
    .readdirSync(ROOT)
    .filter((name) => /^README(\.[A-Za-z-]+)?\.md$/.test(name) && name !== source)
    .sort();
  for (const file of files) {
    compare('README', source, file, errors);
  }

  const all = [source, ...files];
  for (const file of all) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const advertising = text
      .split(/\r?\n/)
      .filter((line) => /HarmonyOS|ohos/i.test(line))
      .filter((line) => !/not supported|unsupported|removed|不支持|已移除/i.test(line));
    if (advertising.length) {
      errors.push(`${file}: still advertises HarmonyOS/ohos`);
    }
    if (!text.includes('platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg')) {
      errors.push(`${file}: platform badge must be macOS | Linux | Windows (no dropped platforms)`);
    }
  }
  return errors;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.vitepress', 'zh'].includes(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function docsErrors() {
  const errors = [];
  const docsRoot = path.join(ROOT, 'docs-site');
  for (const source of walk(docsRoot)) {
    const relative = path.relative(docsRoot, source);
    const target = path.join(docsRoot, 'zh', relative);
    if (!fs.existsSync(target)) {
      errors.push(`docs-site: missing Chinese counterpart for ${relative.split(path.sep).join('/')}`);
      continue;
    }
    compare(
      `docs ${relative.split(path.sep).join('/')}`,
      path.relative(ROOT, source).split(path.sep).join('/'),
      path.relative(ROOT, target).split(path.sep).join('/'),
      errors,
    );
    for (const file of [source, target]) {
      const text = fs.readFileSync(file, 'utf8');
      // A page may explicitly document that a platform is unsupported; only
      // positive support claims are drift.
      const advertising = text
        .split(/\r?\n/)
        .filter((line) => /HarmonyOS|ohos/i.test(line))
        .filter((line) => !/not supported|unsupported|removed|不支持|已移除/i.test(line));
      if (advertising.length) {
        errors.push(`${path.relative(ROOT, file)}: still advertises HarmonyOS/ohos`);
      }
    }
  }

  const config = fs.readFileSync(path.join(docsRoot, '.vitepress/config.mts'), 'utf8');
  for (const link of ['/guide/supported-platforms', '/zh/guide/supported-platforms']) {
    if (!config.includes(link)) errors.push(`docs-site/.vitepress/config.mts: sidebar is missing ${link}`);
  }
  return errors;
}

const errors = [...readmeErrors(), ...docsErrors()];
if (errors.length) {
  console.error('Docs parity check failed:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log('Docs parity OK: README translations and docs-site zh mirror the English structure.');
