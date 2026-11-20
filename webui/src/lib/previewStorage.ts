/**
 * 右侧预览面板轻量级元数据与延迟打开队列。
 *
 * 独立拆出（不导入 `PreviewPanel` 及 `CodeEditorTab` / 代码编辑器依赖），
 * 使主入口只读取标签计数并在面板懒加载前缓冲打开文件请求。
 */

export interface PendingPreviewOpenDetail {
  filePath: string;
  fileName?: string;
  fileStatus?: string;
  startLine?: number;
  endLine?: number;
}

export function getSavedPreviewCount(projectCwd?: string): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  try {
    const normCwd = (projectCwd || 'default').replace(/\\/g, '/').toLowerCase();
    const storageKeyTabs = `jeikcode:right_preview_tabs:${normCwd}`;
    const saved = localStorage.getItem(storageKeyTabs);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.length;
    }
  } catch {}
  return 0;
}

type PreviewOpenHandler = (detail: PendingPreviewOpenDetail) => void;

let activePreviewHandler: PreviewOpenHandler | null = null;
const pendingPreviewOpens: PendingPreviewOpenDetail[] = [];
let previewQueueInstalled = false;

/**
 * 安装全局 `jeikcode:preview:open_file` 监听：
 * 面板尚未懒加载挂载时暂存请求，挂载后一次性排空执行。
 */
export function ensurePreviewOpenQueue(): void {
  if (previewQueueInstalled || typeof window === 'undefined') return;
  previewQueueInstalled = true;
  window.addEventListener('jeikcode:preview:open_file', ((e: CustomEvent<PendingPreviewOpenDetail>) => {
    const detail = e?.detail;
    if (!detail?.filePath) return;
    if (activePreviewHandler) {
      activePreviewHandler(detail);
    } else {
      pendingPreviewOpens.push(detail);
    }
  }) as EventListener);
}

/** 由 `PreviewPanel` 在挂载时注册实时处理器并消费此前暂存的打开请求。 */
export function registerPreviewOpenHandler(handler: PreviewOpenHandler): () => void {
  ensurePreviewOpenQueue();
  activePreviewHandler = handler;
  if (pendingPreviewOpens.length > 0) {
    const queued = pendingPreviewOpens.splice(0, pendingPreviewOpens.length);
    for (const item of queued) {
      handler(item);
    }
  }
  return () => {
    if (activePreviewHandler === handler) {
      activePreviewHandler = null;
    }
  };
}
