import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import fs from 'node:fs';
import path from 'node:path';
import { mockApiPlugin } from './mock-server';

function stripVersionPrefix(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * WebUI 编译期版本注入。优先级：
 * 1. `JEIKCODE_VERSION` / `GITHUB_REF_NAME`（CI 打 Tag 发版时注入，例如 v7.0.13）；
 * 2. `Cargo.toml` `[workspace.package].version`（本地开发）。
 *
 * 注意：工作区 Cargo.toml 不一定跟 Tag 走（发版流水线只在
 * Rust job 里临时 sed），所以打 Tag 时必须走 env，否则侧栏会烘上一次手改的旧号。
 */
function getAppVersion(): string {
  const fromEnv = process.env.JEIKCODE_VERSION || process.env.GITHUB_REF_NAME;
  if (fromEnv && fromEnv.trim()) {
    return stripVersionPrefix(fromEnv);
  }
  try {
    const cargoTomlPath = path.resolve(__dirname, '../Cargo.toml');
    const tomlContent = fs.readFileSync(cargoTomlPath, 'utf8');
    const match = tomlContent.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/);
    if (match && match[1]) {
      return stripVersionPrefix(match[1]);
    }
  } catch {}
  return '0.0.0';
}

export default defineConfig({
  plugins: [preact(), mockApiPlugin()],
  base: './',
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(getAppVersion()),
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '0.0.0.0', port: 5173 },
});
