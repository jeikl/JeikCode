const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.resolve(__dirname, '../bundle-daemon.js');
const binaryEnvNames = [
  'JEIKCODE_DAEMON_DARWIN_ARM64',
  'JEIKCODE_DAEMON_DARWIN_X64',
  'JEIKCODE_DAEMON_LINUX_X64',
  'JEIKCODE_DAEMON_LINUX_ARM64',
  'JEIKCODE_DAEMON_WIN32_X64',
];

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jeikcode-bundle-daemon-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const root = path.join(repo, 'extensions', 'vscode');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(script, path.join(root, 'scripts', 'bundle-daemon.js'));
  fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[workspace.package]\nversion = "7.2.1-beta.5"\n');
  const env = { ...process.env };
  for (const name of binaryEnvNames) delete env[name];
  return {
    repo,
    root,
    env,
    run(args = []) {
      return spawnSync(process.execPath, [path.join(root, 'scripts', 'bundle-daemon.js'), ...args], {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
    },
  };
}

test('local bundling creates version metadata without daemon binaries', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /missing binaries/);
  const metadata = path.join(f.root, 'resources', 'bin', 'daemon-version.txt');
  assert.equal(fs.readFileSync(metadata, 'utf8'), '7.2.1-beta.5');
  assert.deepEqual(fs.readdirSync(path.dirname(metadata)), ['daemon-version.txt']);
});

test('local bundling can overwrite existing version metadata', (t) => {
  const f = fixture(t);
  const dir = path.join(f.root, 'resources', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'daemon-version.txt'), 'old-version');
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'daemon-version.txt'), 'utf8'), '7.2.1-beta.5');
});

test('required bundling still rejects missing binaries before writing metadata', (t) => {
  const f = fixture(t);
  const result = f.run(['--require']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing binaries/);
  assert.match(result.stderr, /set the listed env vars/);
  assert.equal(fs.existsSync(path.join(f.root, 'resources', 'bin')), false);
});

test('required bundling copies all supplied platform fixtures and metadata', (t) => {
  const f = fixture(t);
  const source = path.join(f.repo, 'fixture-binary');
  fs.writeFileSync(source, 'fixture payload, not an executable daemon');
  for (const name of binaryEnvNames) f.env[name] = source;
  const result = f.run(['--require']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const bin = path.join(f.root, 'resources', 'bin');
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    const exe = target === 'win32-x64' ? 'jeikcode-daemon.exe' : 'jeikcode-daemon';
    assert.equal(fs.readFileSync(path.join(bin, target, exe), 'utf8'), fs.readFileSync(source, 'utf8'));
  }
  assert.equal(fs.readFileSync(path.join(bin, 'daemon-version.txt'), 'utf8'), '7.2.1-beta.5');
});
