#!/usr/bin/env node
/**
 * 单平台/单架构构建后即时元数据与版本同步器 (Per-Platform Manifest Updater)
 *
 * 当单个平台或单个架构（如 windows-x64）构建完成后，立即计算真实 SHA256 与文件大小，
 * 采用 GitHub Contents API 乐观锁 (CAS) + 冲突自动重试，安全原子合并进 latest.json。
 * 彻底杜绝多 Runner 并发 Git 冲突问题，实现各平台构建完毕即时更新、立即可用！
 */
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const tag = process.env.TAG_NAME || process.argv[2];
const platformArgs = process.argv.slice(3);
const repo = process.env.REPO || 'jeikl/JeikCode';
const token = process.env.GITHUB_TOKEN;

if (!tag || platformArgs.length === 0) {
  console.error('Usage: node scripts/update-platform-manifest.js <tag> <target:filepath> [target:filepath ...]');
  process.exit(1);
}

const cleanVersion = tag.replace(/^v/, '');
console.log(`🚀 Updating platform manifest for tag ${tag} (${cleanVersion})...`);

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { sha256, size: stat.size };
}

// 计算本次传入的目标平台与哈希
const newBinaries = {};
const targetNames = [];
for (const arg of platformArgs) {
  const [target, filePath] = arg.split(':');
  if (!target || !filePath) continue;
  console.log(`   Computing hash for ${target} (${filePath})...`);
  const info = hashFile(filePath);
  newBinaries[target] = info;
  targetNames.push(target);
  console.log(`   -> ${target}: size=${info.size}, sha256=${info.sha256}`);
}

if (targetNames.length === 0) {
  console.log('No valid targets provided.');
  process.exit(0);
}

function ghRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'JeikCode-Release-Bot',
        'Accept': 'application/vnd.github+json',
      }
    };
    if (token) opts.headers['Authorization'] = `token ${token}`;
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getRemoteFile(filePath) {
  const res = await ghRequest('GET', `/repos/${repo}/contents/${filePath}?ref=main`);
  if (res.status === 200) {
    try {
      const json = JSON.parse(res.data);
      const content = Buffer.from(json.content, 'base64').toString('utf8');
      return { sha: json.sha, content };
    } catch {}
  }
  return null;
}

async function putRemoteFile(filePath, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: 'main',
    ...(sha ? { sha } : {})
  };
  const res = await ghRequest('PUT', `/repos/${repo}/contents/${filePath}`, body);
  return res.status === 200 || res.status === 201;
}

/**
 * 通过 GitHub Contents API 乐观锁 (CAS) 进行无锁原子合并，遇并发冲突自动重试
 */
async function atomicUpdateLatestJson() {
  console.log(`🔄 Performing atomic CAS update of latest.json via GitHub API...`);
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const remote = await getRemoteFile('latest.json');
      let manifest = {
        version: tag,
        released_at: new Date().toISOString().slice(0, 10),
        binaries: {}
      };

      if (remote) {
        try {
          const parsed = JSON.parse(remote.content);
          if (parsed && typeof parsed.binaries === 'object') {
            manifest.binaries = { ...parsed.binaries };
          }
        } catch {}
      }

      manifest.version = tag;
      manifest.released_at = new Date().toISOString().slice(0, 10);

      // 安全合并本次编译的二进制架构（绝不覆盖其他平台的字段）
      for (const [t, info] of Object.entries(newBinaries)) {
        manifest.binaries[t] = info;
      }

      const newContent = JSON.stringify(manifest, null, 2) + '\n';
      const commitMsg = `chore(release): 自动同步 ${tag} [${targetNames.join(', ')}] 校验清单 [skip ci]`;

      const ok = await putRemoteFile('latest.json', newContent, remote ? remote.sha : undefined, commitMsg);
      if (ok) {
        console.log(`✅ latest.json atomically updated on main via GitHub API with [${targetNames.join(', ')}]!`);
        return true;
      }
      console.warn(`⚠️ Attempt ${attempt}: 409 Conflict / CAS miss, retrying with fresh state in 1s...`);
    } catch (e) {
      console.warn(`⚠️ Attempt ${attempt} network error: ${e.message}, retrying...`);
    }
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));
  }
  return false;
}

async function run() {
  let apiSuccess = false;
  if (token) {
    apiSuccess = await atomicUpdateLatestJson();
  }

  // 本地文件同步（供当前 runner 与本地 git 兜底）
  let localManifest = {
    version: tag,
    released_at: new Date().toISOString().slice(0, 10),
    binaries: {}
  };
  if (fs.existsSync('latest.json')) {
    try {
      const existing = JSON.parse(fs.readFileSync('latest.json', 'utf8'));
      if (existing && existing.binaries) localManifest.binaries = { ...existing.binaries };
    } catch {}
  }
  localManifest.version = tag;
  for (const [t, info] of Object.entries(newBinaries)) {
    localManifest.binaries[t] = info;
  }
  fs.writeFileSync('latest.json', JSON.stringify(localManifest, null, 2) + '\n');

  if (fs.existsSync('Cargo.toml')) {
    let c = fs.readFileSync('Cargo.toml', 'utf8');
    c = c.replace(/^version = ".*"/m, `version = "${cleanVersion}"`);
    fs.writeFileSync('Cargo.toml', c);
  }
  if (fs.existsSync('scripts/install.ps1')) {
    let c = fs.readFileSync('scripts/install.ps1', 'utf8');
    c = c.replace(/\$DefaultVersion = ".*"/, `$DefaultVersion = "${tag}"`);
    fs.writeFileSync('scripts/install.ps1', c);
  }
  if (fs.existsSync('scripts/install.sh')) {
    let c = fs.readFileSync('scripts/install.sh', 'utf8');
    c = c.replace(/DEFAULT_VERSION=".*"/, `DEFAULT_VERSION="${tag}"`);
    fs.writeFileSync('scripts/install.sh', c);
  }
  for (const file of ['README.md', 'README.zh-CN.md', 'README.en.md']) {
    if (fs.existsSync(file)) {
      let c = fs.readFileSync(file, 'utf8');
      c = c.replace(/badge\/version-[0-9a-zA-Z.-]+-blue\.svg/g, `badge/version-${cleanVersion}-blue.svg`);
      c = c.replace(/badge\/Releases-v?[0-9a-zA-Z.-]+-00f2fe/g, `badge/Releases-${tag}-00f2fe`);
      fs.writeFileSync(file, c);
    }
  }

  // 若 GitHub API 提交未完成（如 token 受限），走带 rebase 的 Git push 兜底
  if (!apiSuccess) {
    try {
      console.log(`🔄 Falling back to git commit & push for ${targetNames.join(', ')}...`);
      execSync('git config --global user.name "github-actions[bot]"', { stdio: 'ignore' });
      execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' });

      const commitMsg = `chore(release): 自动同步 ${tag} [${targetNames.join(', ')}] 校验清单 [skip ci]`;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          execSync('git pull --rebase origin main', { stdio: 'inherit' });
          execSync('git add latest.json Cargo.toml README*.md scripts/install.*', { stdio: 'inherit' });
          const status = execSync('git status --porcelain', { encoding: 'utf8' });
          if (!status.trim()) break;
          execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });
          execSync('git push origin main', { stdio: 'inherit' });
          console.log(`✅ Successfully pushed via git fallback!`);
          break;
        } catch {
          execSync('sleep 3', { stdio: 'ignore' });
        }
      }
    } catch (e) {
      console.warn('⚠️ Git fallback ended with:', e.message);
    }
  }
}

run().catch(err => {
  console.error('❌ Error executing platform manifest update:', err);
  process.exit(1);
});
