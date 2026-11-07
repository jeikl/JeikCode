import { render } from 'preact';
import { App } from './app';
import { AuthExpiredDialog } from './components/AuthExpiredDialog';
import { SettingsProvider } from './settings';
import { ensureRandomUUIDPolyfill } from './lib/randomId';
import { initPageZoom, initEditorFontSize } from './lib/pageZoom';
import { installViewportSync } from './lib/viewport';
// Bundled serif for the landing greeting (close to claude.ai's display serif).
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/500.css';
import './styles/theme.css';
import './styles/app.css';
import './index.css';
import 'katex/dist/katex.min.css';

// 禁用浏览器默认的历史滚动恢复，避免刷新时与聊天时间线底部粘性定位冲突产生跳变
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

// 当服务端发版重启导致异地旧标签页请求的异步 chunk hash 失效时，自动刷新页面拉取最新资源
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', () => {
    window.location.reload();
  });

  // Preact Suspense 用“抛出 Promise”作为控制流。若 lazy 组件在边界重试时
  // 再次抛出 pending Promise，浏览器会把它记为 unhandled rejection；它既不是
  // Error 也不是业务失败。这里只吞掉 Promise 类型的原因，真实 chunk 加载错误
  // （Error）仍然会走上面的 vite:preloadError。
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof Promise) event.preventDefault();
  });
}

// http://LAN-IP (jeikcode serve remote clients) is not a secure context —
// crypto.randomUUID is missing there. Polyfill before any component mounts.
ensureRandomUUIDPolyfill();

// 初始化类似 Chrome 的页面缩放（Ctrl + 滚轮 / 快捷键）
initPageZoom();
// 初始化代码编辑/预览全局字号
initEditorFontSize();
// 同步移动端可视视口：软键盘收起后不残留底部黑边 / 顶部裁切
installViewportSync();

render(
  <SettingsProvider>
    <App />
    <AuthExpiredDialog />
  </SettingsProvider>,
  document.getElementById('app')!,
);
