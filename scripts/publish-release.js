#!/usr/bin/env node
/**
 * 发版清单随 Release 上传，不写回 git。
 *
 * 平台 Job 只上传二进制。本脚本在六个架构都齐之后：
 *   - 把带 SHA256 的 latest.json 写到 dist/，随 Release 上传
 *   - 按 Conventional Commits 写出 release_notes.md，作为 Release 正文
 *
 * 不改仓库文件，不推送。清单不在 main 上，下游不用为发版再 pull。
 *
 *   node scripts/publish-release.js --tag vX.Y.Z [--dist dist] [--root .]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'windows-arm64',
  'windows-x64',
];

const EN_GROUPS = [
  { type: 'feat', title: 'Features' },
  { type: 'fix', title: 'Bug Fixes' },
  { type: 'perf', title: 'Performance Improvements' },
  { type: 'refactor', title: 'Code Refactoring' },
  { type: 'docs', title: 'Documentation' },
  { type: 'test', title: 'Tests' },
  { type: 'maintenance', title: 'Maintenance' },
  { type: 'other', title: 'Other Changes' },
];

const ZH_GROUPS = [
  { type: 'feat', title: '新特性' },
  { type: 'fix', title: '缺陷修复' },
  { type: 'perf', title: '性能优化' },
  { type: 'refactor', title: '代码重构' },
  { type: 'docs', title: '文档更新' },
  { type: 'test', title: '测试用例' },
  { type: 'maintenance', title: '日常维护' },
  { type: 'other', title: '其他改动' },
];

const TYPE_TO_KEY = {
  feat: 'feat',
  fix: 'fix',
  perf: 'perf',
  refactor: 'refactor',
  docs: 'docs',
  test: 'test',
  chore: 'maintenance',
  ci: 'maintenance',
  build: 'maintenance',
  style: 'maintenance',
};

function assetName(tag, target) {
  const ext = target.startsWith('windows') ? '.exe' : '';
  return `jeikcode-${tag}-${target}${ext}`;
}

function isStableTag(tag) {
  return !String(tag).includes('-');
}

function hashFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
  };
}

function collectBinaries(distDir, tag) {
  const binaries = {};
  const missing = [];
  for (const target of TARGETS) {
    const name = assetName(tag, target);
    const filePath = path.join(distDir, name);
    if (!fs.existsSync(filePath)) {
      missing.push(name);
      continue;
    }
    binaries[target] = hashFile(filePath);
  }
  if (missing.length) {
    throw new Error(`缺少产物，拒绝发布半套清单: ${missing.join(', ')}`);
  }
  return binaries;
}

function isNoise(subject) {
  return /^chore\(release\)\b/.test(subject) || /\[skip ci\]/i.test(subject);
}

function groupKeyOf(subject) {
  const match = String(subject).match(/^(feat|fix|perf|refactor|docs|test|chore|ci|build|style)(\([^)]*\))?!?:/);
  if (!match) return 'other';
  return TYPE_TO_KEY[match[1]] || 'other';
}

function groupOf(subject) {
  const key = groupKeyOf(subject);
  const found = EN_GROUPS.find((g) => g.type === key);
  return found ? found.title : 'Other Changes';
}

function renderChangelogSection(tag, date, commits) {
  const buckets = new Map();
  for (const commit of commits || []) {
    const subject = (commit && commit.subject) || '';
    if (!subject || isNoise(subject)) continue;
    const key = groupKeyOf(subject);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(commit);
  }

  const enLines = [];
  let any = false;
  for (const group of EN_GROUPS) {
    const items = buckets.get(group.type);
    if (!items || !items.length) continue;
    any = true;
    enLines.push(`### ${group.title}`, '');
    for (const commit of items) {
      const hash = commit.hash ? ` (\`${commit.hash}\`)` : '';
      enLines.push(`- ${commit.subject}${hash}`);
    }
    enLines.push('');
  }
  if (!any) {
    enLines.push('No changes listed for this release.', '');
  }

  const zhLines = [];
  let anyZh = false;
  for (const group of ZH_GROUPS) {
    const items = buckets.get(group.type);
    if (!items || !items.length) continue;
    anyZh = true;
    zhLines.push(`### ${group.title}`, '');
    for (const commit of items) {
      const hash = commit.hash ? ` (\`${commit.hash}\`)` : '';
      zhLines.push(`- ${commit.subject}${hash}`);
    }
    zhLines.push('');
  }
  if (!anyZh) {
    zhLines.push('本次发布没有可列入说明的提交变更。', '');
  }

  const lines = [
    `## ${tag} (${date})`,
    '',
    enLines.join('\n').trim(),
    '',
    '---',
    '',
    zhLines.join('\n').trim(),
  ];

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function upsertChangelog(existing, section, tag) {
  const text = existing || '';
  if (text.includes(`## ${tag} `) || text.includes(`## ${tag}\n`)) {
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  const body = section.endsWith('\n') ? section : `${section}\n`;
  if (!text.trim()) {
    return `# Changelog\n\n${body}`;
  }
  if (text.startsWith('# Changelog')) {
    const nl = text.indexOf('\n');
    const rest = text.slice(nl + 1).replace(/^\n/, '');
    const tail = rest.endsWith('\n') || rest.length === 0 ? rest : `${rest}\n`;
    return `# Changelog\n\n${body}\n${tail}`;
  }
  const tail = text.endsWith('\n') ? text : `${text}\n`;
  return `${body}\n${tail}`;
}

function renderReleaseNotes(tag, section) {
  const body = section.replace(/^## .+\n+/, '').trimEnd();
  const v = tag.replace(/^v/, '');
  const base = `https://github.com/jeikl/JeikCode/releases/download/${tag}`;

  return [
    `## 🚀 Downloads & Installation`,
    '',
    '| Operating System | Recommended Installers (GUI + CLI) | Architecture |',
    '| :--- | :--- | :--- |',
    `| **Windows** | [📥 **Download Windows Installer (.exe)**](${base}/JeikCode.Desktop_${v}_x64-setup.exe) | x64 / arm64 |`,
    `| **macOS** | [🍏 **Download macOS Apple Silicon (.dmg)**](${base}/JeikCode.Desktop_${v}_aarch64.dmg)<br>[🍎 **Download macOS Intel (.dmg)**](${base}/JeikCode.Desktop_${v}_x64.dmg) | arm64 / x64 |`,
    `| **Linux** | [🐧 **Download Debian / Ubuntu (.deb)**](${base}/JeikCode.Desktop_${v}_amd64.deb)<br>[📦 **Download Universal AppImage (.AppImage)**](${base}/JeikCode.Desktop_${v}_amd64.AppImage) | x64 / arm64 |`,
    '',
    '#### ⚡ One-Line Terminal Installation (CLI)',
    '',
    '```bash',
    '# Linux / macOS / HarmonyOS PC',
    'curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash',
    '```',
    '',
    '```powershell',
    '# Windows (PowerShell)',
    'irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex',
    '```',
    '',
    '---',
    '',
    body || 'No changes listed for this release.',
    '',
  ].join('\n');
}

function bumpCargoLock(text, names, version) {
  const set = new Set(names);
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^name = "([^"]+)"$/);
    if (!match || !set.has(match[1])) continue;
    if (i + 1 < lines.length && /^version = ".*"/.test(lines[i + 1])) {
      lines[i + 1] = `version = "${version}"`;
    }
  }
  return lines.join('\n');
}

function collectCommits(tag) {
  let range = tag;
  try {
    const prev = execSync(`git describe --tags --abbrev=0 ${tag}^`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (prev) range = `${prev}..${tag}`;
  } catch {
    range = tag;
  }
  let out = '';
  try {
    out = execSync(`git log --no-merges --format=%h%x09%s ${range}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab === -1) return { hash: '', subject: line };
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    .filter((commit) => !isNoise(commit.subject));
}

function extractSectionFromMarkdown(filePath, tag) {
  if (!fs.existsSync(filePath)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRegex = new RegExp(`^#{2,3}\\s+\\[?${escaped}\\]?(?:\\s*\\([^)]*\\))?\\s*$`);
  let found = false;
  const sectionLines = [];
  for (const line of lines) {
    if (!found) {
      if (headerRegex.test(line)) {
        found = true;
      }
    } else {
      if (/^#{2,3}\s+/.test(line)) {
        break;
      }
      sectionLines.push(line);
    }
  }
  return sectionLines.join('\n').trim();
}

function extractChangelogSection(changelogPath, tag) {
  return extractSectionFromMarkdown(changelogPath, tag);
}

function buildReleaseSection({ root, tag, day, commits }) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelogDetail = extractChangelogSection(changelogPath, tag);

  if (changelogDetail) {
    // 若 CHANGELOG 内部已包含 '---' 分割线，代表已按「英文一段，分割线，中文一段」组织
    if (/^---\s*$/m.test(changelogDetail)) {
      return `## ${tag} (${day})\n\n${changelogDetail}`;
    }

    const hasChinese = /[\u4e00-\u9fa5]/.test(changelogDetail);
    if (hasChinese) {
      // 当前 CHANGELOG 章节主要为中文，尝试从 README.en.md 或 README.md 提取对应的英文段落
      let enDetail = extractSectionFromMarkdown(path.join(root, 'README.en.md'), tag);
      if (!enDetail) {
        enDetail = extractSectionFromMarkdown(path.join(root, 'README.md'), tag);
      }
      if (enDetail) {
        return `## ${tag} (${day})\n\n${enDetail}\n\n---\n\n${changelogDetail}`;
      }
    } else {
      // 当前 CHANGELOG 章节主要为英文，尝试从 README.zh-CN.md 提取中文段落
      const zhDetail = extractSectionFromMarkdown(path.join(root, 'README.zh-CN.md'), tag);
      if (zhDetail) {
        return `## ${tag} (${day})\n\n${changelogDetail}\n\n---\n\n${zhDetail}`;
      }
    }

    return `## ${tag} (${day})\n\n${changelogDetail}`;
  }

  // CHANGELOG 无内容时，退化为从 Conventional Commits 自动生成双语段落
  return renderChangelogSection(tag, day, commits);
}

function publish({ root, distDir, tag, date, commits }) {
  const stable = isStableTag(tag);
  const binaries = collectBinaries(distDir, tag);
  const day = date || new Date().toISOString().slice(0, 10);
  const section = buildReleaseSection({
    root,
    tag,
    day,
    commits: commits || collectCommits(tag),
  });
  const notes = renderReleaseNotes(tag, section);
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'release_notes.md'), notes);
  fs.writeFileSync(
    path.join(distDir, 'latest.json'),
    `${JSON.stringify({ version: tag, released_at: day, binaries }, null, 2)}\n`,
  );
  return { stable, binaries, notes };
}

function parseArgs(argv) {
  const out = { root: process.cwd(), dist: 'dist', tag: process.env.TAG_NAME || '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') out.tag = argv[++i];
    else if (arg === '--dist') out.dist = argv[++i];
    else if (arg === '--root') out.root = argv[++i];
    else if (!arg.startsWith('-') && !out.tag) out.tag = arg;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tag) {
    console.error('Usage: node scripts/publish-release.js --tag vX.Y.Z [--dist dist] [--root .]');
    process.exit(1);
  }
  const root = path.resolve(args.root);
  const result = publish({
    root,
    distDir: path.resolve(root, args.dist),
    tag: args.tag,
  });
  const kind = result.stable ? 'stable' : 'prerelease';
  console.log(`release notes written (${kind}), binaries=${Object.keys(result.binaries).length}`);
}

module.exports = {
  TARGETS,
  assetName,
  isStableTag,
  isNoise,
  groupOf,
  renderChangelogSection,
  upsertChangelog,
  renderReleaseNotes,
  bumpCargoLock,
  collectBinaries,
  extractChangelogSection,
  extractSectionFromMarkdown,
  buildReleaseSection,
  publish,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
