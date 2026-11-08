import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import {
  fetchFsRead,
  fetchFsWrite,
  openFileWithOs,
  revealInFileExplorer,
  getFsRawUrl,
} from '../api';
import { Markdown, highlightHtml } from './Markdown';
import { showToast } from './Toast';
import { highlightCode, formatCodeContent } from '../lib/codeHighlight';
import { changeEditorFontSize } from '../lib/pageZoom';
import { getCachedFileContent, saveCachedFileContent } from '../lib/sessionCache';
import {
  readEditorTabSnapshot,
  shouldReloadFromDisk,
  toggleTextMode,
  writeEditorTabSnapshot,
  type EditorTabSnapshot,
} from '../lib/editorTabState';
import { fileStampFromRead, type FileStamp } from '../lib/fileStamp';
import { subscribeFileFreshness, type FileFreshnessSubscription } from '../lib/fsFreshness';
import { useT } from '../settings';

export interface CodeEditorTabProps {
  filePath: string;
  onClose?: () => void;
  cwd?: string;
  defaultViewMode?: 'edit' | 'preview';
  onViewModeChange?: (mode: 'edit' | 'preview') => void;
  hideHeaderToolbar?: boolean;
  startLine?: number;
  endLine?: number;
  /** 嵌入式（右侧预览）拖入文件时的落点。缺省时保持主编辑器的行为：
   *  打开主标签页。预览面板必须传 openTab，否则拖入 .md 会同时开主标签。 */
  onFileDrop?: (path: string) => void;
  /** Markdown 内文件徽章/链接的默认打开落点：主画布保持 'main'（默认），
   *  右侧预览面板传 'right'，保证在右侧点开的文件继续在右侧标签区新建标签。
   *  Ctrl/Cmd/Alt + 点击仍由 Markdown 组件强制送去中间主编辑区。 */
  linkTargetContext?: 'main' | 'right';
  /** 标签现场键（main:/preview: 前缀）：卸载后重新挂载时据此恢复草稿、模式、光标与滚动。 */
  stateKey?: string;
  /** 是否为所属画布的前台标签。保活的后台标签不响应全局快捷键，也不抢占焦点。 */
  active?: boolean;
  /** 外部刷新令牌：自增即代表用户显式要求重读磁盘（允许覆盖未保存草稿）。 */
  reloadToken?: number;
  /** 切回前台时是否把焦点还给编辑器。右侧预览等辅助面板应传 false，避免抢走聊天输入焦点。 */
  restoreFocusOnActivate?: boolean;
  /** 未保存修改状态变化：预览面板据此显示脏点、关闭/刷新前确认。 */
  onDirtyChange?: (dirty: boolean) => void;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'iso']);
const BINARY_EXTS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'pdf', 'wasm',
  'mp3', 'wav', 'ogg', 'flac', 'aac',
  'mp4', 'webm', 'mkv', 'avi', 'mov',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
]);

export function CodeEditorTab({
  filePath,
  onClose,
  cwd,
  defaultViewMode,
  onViewModeChange,
  hideHeaderToolbar = false,
  startLine,
  endLine,
  onFileDrop,
  linkTargetContext = 'main',
  stateKey,
  active = true,
  reloadToken,
  restoreFocusOnActivate = true,
  onDirtyChange,
}: CodeEditorTabProps) {
  const t = useT();
  // 事件作用域：同一个文件可能同时打开在主画布与右侧预览，切换/保存指令必须按标签现场隔离。
  const eventScope = stateKey || filePath;
  const ext = useMemo(() => (filePath.split('.').pop() || '').toLowerCase(), [filePath]);
  const isImage = useMemo(() => IMAGE_EXTS.has(ext), [ext]);
  const isArchive = useMemo(() => ARCHIVE_EXTS.has(ext), [ext]);
  const isBinary = useMemo(() => isArchive || BINARY_EXTS.has(ext), [ext, isArchive]);
  const isSvg = ext === 'svg';

  // 每个标签实例只读取一次现场；本实例随后的写入不会再回灌自己。
  const [restoredSnapshot] = useState<EditorTabSnapshot | null>(() => readEditorTabSnapshot(stateKey));

  const [content, setContent] = useState<string>(() => restoredSnapshot?.content ?? '');
  const [loading, setLoading] = useState<boolean>(() => {
    if (isImage || isBinary) return false;
    // 已有标签现场时直接渲染，避免重新挂载瞬间闪一次加载态。
    return !restoredSnapshot;
  });
  const [saving, setSaving] = useState<boolean>(false);
  const [isDirty, setIsDirty] = useState<boolean>(() => restoredSnapshot?.isDirty ?? false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTrigger, setReloadTrigger] = useState<number>(0);

  // 追踪当前实例绑定的 filePath 与 stateKey，发生切换时彻底重置现场，绝不串台
  const boundPathRef = useRef(filePath);
  useEffect(() => {
    if (boundPathRef.current !== filePath) {
      boundPathRef.current = filePath;
      const freshSnap = readEditorTabSnapshot(stateKey);
      setContent(freshSnap?.content ?? '');
      setIsDirty(freshSnap?.isDirty ?? false);
      isDirtyRef.current = freshSnap?.isDirty ?? false;
      diskStampRef.current = freshSnap?.diskStamp ?? null;
      historyRef.current = freshSnap?.isDirty ? [{ text: freshSnap.content, cursor: freshSnap.selectionStart }] : [];
      historyIndexRef.current = freshSnap?.isDirty ? 0 : -1;
      setDiskConflict(false);
      setLoading(!freshSnap);
      setReloadTrigger((n) => n + 1);
    }
  }, [filePath, stateKey]);

  // 磁盘与编辑器的版本分歧：非脏标签静默覆盖，脏标签只提示、绝不丢草稿。
  const [diskConflict, setDiskConflict] = useState<boolean>(false);
  // 图片被外部更新时用版本号打穿浏览器缓存。
  const [assetVersion, setAssetVersion] = useState<number>(0);
  const diskStampRef = useRef<FileStamp | null>(restoredSnapshot?.diskStamp ?? null);
  const freshnessSubRef = useRef<FileFreshnessSubscription | null>(null);
  // 重读后的收尾：external 自动更新需要提示；manual 冲突重载只需把光标夹回有效范围。
  const externalReloadRef = useRef(false);
  const manualReloadRef = useRef(false);
  // 最近一次成功读盘的时刻：回到窗口时的补读过于频繁则跳过。
  const lastDiskLoadAtRef = useRef(0);

  // 后台刷新守门：用 ref 取最新脏标记，旧闭包绝不能用磁盘内容覆盖未保存草稿。
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);
  // 脏状态上报用 ref 转发：父组件的内联回调每次都换引用，不能让它驱动副作用。
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(isDirty);
  }, [isDirty]);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  // 已消费的外部刷新令牌；发生变化即代表用户显式要求重读磁盘。
  const reloadTokenRef = useRef(reloadToken ?? 0);

  // 跨行完备 Undo / Redo 历史快照栈 (彻底解决原生 textarea 跨行回车后无法撤回的痛点)
  const historyRef = useRef<Array<{ text: string; cursor: number }>>(
    restoredSnapshot?.isDirty
      ? [{ text: restoredSnapshot.content, cursor: restoredSnapshot.selectionStart }]
      : [],
  );
  const historyIndexRef = useRef<number>(restoredSnapshot?.isDirty ? 0 : -1);
  const isUndoRedoActionRef = useRef<boolean>(false);
  const inputDebounceTimerRef = useRef<number | null>(null);

  const pushSnapshot = useCallback((newText: string, cursor: number) => {
    if (isUndoRedoActionRef.current) return;
    const history = historyRef.current;
    const curIdx = historyIndexRef.current;
    if (curIdx >= 0 && history[curIdx]?.text === newText) {
      history[curIdx].cursor = cursor;
      return;
    }
    const nextHistory = history.slice(0, curIdx + 1);
    nextHistory.push({ text: newText, cursor });
    if (nextHistory.length > 500) {
      nextHistory.shift();
    }
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      isUndoRedoActionRef.current = true;
      historyIndexRef.current--;
      const snapshot = historyRef.current[historyIndexRef.current];
      if (snapshot) {
        setContent(snapshot.text);
        setIsDirty(true);
        window.requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(snapshot.cursor, snapshot.cursor);
          }
          isUndoRedoActionRef.current = false;
        });
      }
    }
  }, []);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      isUndoRedoActionRef.current = true;
      historyIndexRef.current++;
      const snapshot = historyRef.current[historyIndexRef.current];
      if (snapshot) {
        setContent(snapshot.text);
        setIsDirty(true);
        window.requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(snapshot.cursor, snapshot.cursor);
          }
          isUndoRedoActionRef.current = false;
        });
      }
    }
  }, []);

  // 模式：'edit' (源码编辑) | 'preview' (Markdown深度渲染) | 'image' (图片自适应预览) | 'binary' (二进制引导卡片)
  const isMarkdown = useMemo(() => {
    return /\.md$/i.test(filePath) || /\.markdown$/i.test(filePath);
  }, [filePath]);

  const [viewMode, setViewModeState] = useState<'edit' | 'preview' | 'image' | 'binary'>(() => {
    if (isBinary) return 'binary';
    // 标签最后停留的模式优先于“按扩展名写死的默认预览”，但必须与文件类型兼容。
    const restoredMode = restoredSnapshot?.viewMode;
    if (isImage || isSvg) {
      if (restoredMode === 'image' || restoredMode === 'edit' || restoredMode === 'preview') return restoredMode;
      return 'image';
    }
    if (restoredMode === 'edit' || restoredMode === 'preview') return restoredMode;
    return defaultViewMode || (isMarkdown ? 'preview' : 'edit');
  });
  const viewModeRef = useRef(viewMode);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // 图片预览与缩放状态
  const [imgScale, setImgScale] = useState<number>(() => restoredSnapshot?.imgScale ?? 1.0);
  const [imgDimensions, setImgDimensions] = useState<{ w: number; h: number } | null>(null);

  const onViewModeChangeRef = useRef(onViewModeChange);
  useEffect(() => {
    onViewModeChangeRef.current = onViewModeChange;
  }, [onViewModeChange]);

  const setViewMode = useCallback(
    (updater: 'edit' | 'preview' | 'image' | 'binary' | ((prev: 'edit' | 'preview' | 'image' | 'binary') => 'edit' | 'preview' | 'image' | 'binary')) => {
      setViewModeState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        if (next === 'edit' || next === 'preview') {
          onViewModeChangeRef.current?.(next);
        }
        // 只有前台标签切到编辑模式才抢焦点：后台保活标签必须保持安静。
        if (next === 'edit' && activeRef.current) {
          window.setTimeout(() => {
            textareaRef.current?.focus();
          }, 50);
        }
        return next;
      });
    },
    [],
  );

  // 首次挂载由 useState 从标签现场恢复（有现场就沿用最后模式，没有才按扩展名默认），
  // 这里只处理同一实例真的换了文件的兜底场景。
  const lastFilePathRef = useRef<string | null>(filePath);
  useEffect(() => {
    if (lastFilePathRef.current === filePath) return;
    lastFilePathRef.current = filePath;

    if (isImage && !isSvg) setViewModeState('image');
    else if (isSvg) setViewModeState('image');
    else if (isBinary) setViewModeState('binary');
    else if (defaultViewMode) {
      setViewModeState(defaultViewMode);
      onViewModeChangeRef.current?.(defaultViewMode);
    } else if (isMarkdown) {
      setViewModeState('preview');
      onViewModeChangeRef.current?.('preview');
    } else {
      setViewModeState('edit');
      onViewModeChangeRef.current?.('edit');
    }
    setImgScale(1.0);
    setImgDimensions(null);
  }, [filePath, isImage, isSvg, isBinary, isMarkdown, defaultViewMode]);

  // 挂载（含从标签现场恢复）后把当前模式同步给父级工具栏，避免图标与实际视图脱节。
  useEffect(() => {
    if (viewModeRef.current === 'edit' || viewModeRef.current === 'preview') {
      onViewModeChangeRef.current?.(viewModeRef.current);
    }
  }, []);

  // 监听外部触发的视图切换广播 (例如右侧面板顶栏铅笔图标点击)
  useEffect(() => {
    const handleToggle = () => {
      setViewMode((prev) => {
        const next = toggleTextMode(prev);
        showToast(next === 'preview' ? t('editor.switchToPreview') : t('editor.switchToEdit'), 'info');
        return next;
      });
    };
    window.addEventListener(`jeikcode:editor:toggle_mode:${eventScope}`, handleToggle);
    return () => {
      window.removeEventListener(`jeikcode:editor:toggle_mode:${eventScope}`, handleToggle);
    };
  }, [eventScope, setViewMode, t]);

  // 图片预览模式下 Ctrl + 鼠标滚轮缩放图片
  const handleImageWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      setImgScale((s) => Math.max(0.1, Math.min(10.0, Math.round((s + delta) * 100) / 100)));
    }
  };

  // 搜索替换栏状态 (Ctrl+F, Ctrl+H)
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState<number>(0);
  const [previewMatchCount, setPreviewMatchCount] = useState<number>(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // 计算所有匹配项的起始索引
  const matchIndices = useMemo(() => {
    if (!findText) return [];
    const indices: number[] = [];
    const query = findText.toLowerCase();
    const haystack = content.toLowerCase();
    let pos = 0;
    while ((pos = haystack.indexOf(query, pos)) !== -1) {
      indices.push(pos);
      pos += Math.max(1, query.length);
    }
    return indices;
  }, [content, findText]);

  // 跳转到指定序号的匹配项并在 textarea 或预览 Markdown 中选中与滚动定位
  const jumpToMatch = useCallback(
    (idx: number) => {
      const total = viewMode === 'preview' ? previewMatchCount : matchIndices.length;
      if (total === 0) return;
      const safeIdx = (idx + total) % total;
      setCurrentMatchIdx(safeIdx);

      if (viewMode === 'preview') {
        const container = previewContainerRef.current;
        if (container) {
          const marks = container.querySelectorAll<HTMLElement>('.msg-search-highlight');
          marks.forEach((m, i) => {
            if (i === safeIdx) {
              m.classList.add('is-current-match');
              m.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
              m.classList.remove('is-current-match');
            }
          });
        }
        return;
      }

      if (!textareaRef.current) return;
      const targetPos = matchIndices[safeIdx];
      if (targetPos === undefined) return;
      const ta = textareaRef.current;
      // 保持焦点在搜索框中，防止用户按回车切换时误将选中文本删除覆盖！
      findInputRef.current?.focus();

      const textBefore = content.slice(0, targetPos);
      const lineNo = textBefore.split('\n').length - 1;
      const lineHeight = 20;
      const targetScroll = Math.max(0, lineNo * lineHeight - 60);
      ta.scrollTop = targetScroll;
      if (preRef.current) preRef.current.scrollTop = targetScroll;
      if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = targetScroll;
    },
    [matchIndices, findText, content, viewMode, previewMatchCount]
  );

  const handleFindNext = useCallback(() => {
    jumpToMatch(currentMatchIdx + 1);
  }, [jumpToMatch, currentMatchIdx]);

  const handleFindPrev = useCallback(() => {
    jumpToMatch(currentMatchIdx - 1);
  }, [jumpToMatch, currentMatchIdx]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const fileName = useMemo(() => filePath.split(/[\\/]/).pop() || filePath, [filePath]);

  // 标签现场的滚动 / 选区记忆：display:none 会让浏览器丢掉滚动盒位置，
  // 所以离开前持续记住，切回时再原样还回去（初始值来自卸载前的现场）。
  const editorViewportRef = useRef({
    start: restoredSnapshot?.selectionStart ?? 0,
    end: restoredSnapshot?.selectionEnd ?? 0,
    scrollTop: restoredSnapshot?.scrollTop ?? 0,
    scrollLeft: restoredSnapshot?.scrollLeft ?? 0,
    gutterScrollTop: restoredSnapshot?.gutterScrollTop ?? 0,
    previewScrollTop: restoredSnapshot?.previewScrollTop ?? 0,
  });

  const rememberEditorViewport = useCallback(() => {
    const viewport = editorViewportRef.current;
    const ta = textareaRef.current;
    if (ta) {
      viewport.start = ta.selectionStart ?? 0;
      viewport.end = ta.selectionEnd ?? 0;
      viewport.scrollTop = ta.scrollTop;
      viewport.scrollLeft = ta.scrollLeft;
    }
    const gutter = lineNumbersRef.current;
    if (gutter) viewport.gutterScrollTop = gutter.scrollTop;
    const preview = previewContainerRef.current;
    if (preview) viewport.previewScrollTop = preview.scrollTop;
  }, []);

  const isEditorVisible = useCallback(() => {
    const root = editorRootRef.current;
    if (!root) return false;
    // 祖先 display:none 时没有布局盒：保活编辑器不得吞掉前台快捷键。
    return root.getClientRects().length > 0;
  }, []);

  // 首次可见与前台切回共用一条还原路径：把离开前的滚动与选区还给用户。
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!becameActive) return;
    const viewport = editorViewportRef.current;
    const frame = requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        try {
          ta.setSelectionRange(viewport.start, viewport.end);
        } catch {}
        ta.scrollTop = viewport.scrollTop;
        ta.scrollLeft = viewport.scrollLeft;
        // 回到前台继续编辑：把焦点还给编辑器，保持与浏览器标签一致的编辑现场。
        if (viewModeRef.current === 'edit' && restoreFocusOnActivate) ta.focus();
      }
      if (preRef.current) {
        preRef.current.scrollTop = viewport.scrollTop;
        preRef.current.scrollLeft = viewport.scrollLeft;
      }
      if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = viewport.gutterScrollTop;
      if (previewContainerRef.current) previewContainerRef.current.scrollTop = viewport.previewScrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, loading, restoreFocusOnActivate]);

  // 持续把标签现场写进内存簿记：整棵树被替换（落地页 ↔ 会话画布）时据此恢复。
  const latestTabStateRef = useRef({ content, isDirty, viewMode, imgScale });
  const persistTabSnapshot = useCallback(() => {
    if (!stateKey) return;
    const latest = latestTabStateRef.current;
    const viewport = editorViewportRef.current;
    writeEditorTabSnapshot(stateKey, {
      content: latest.content,
      isDirty: latest.isDirty,
      viewMode: latest.viewMode,
      imgScale: latest.imgScale,
      selectionStart: viewport.start,
      selectionEnd: viewport.end,
      scrollTop: viewport.scrollTop,
      scrollLeft: viewport.scrollLeft,
      gutterScrollTop: viewport.gutterScrollTop,
      previewScrollTop: viewport.previewScrollTop,
      diskStamp: diskStampRef.current,
    });
  }, [stateKey]);

  useEffect(() => {
    latestTabStateRef.current = { content, isDirty, viewMode, imgScale };
    persistTabSnapshot();
  }, [persistTabSnapshot, content, isDirty, viewMode, imgScale]);

  // 卸载（含关闭标签）时补存最后一帧滚动 / 选区；关闭后被墓碑拦截，不会复活。
  useEffect(() => () => persistTabSnapshot(), [persistTabSnapshot]);

  // 前台切回时重新校验磁盘（AI 可能刚改过这个文件）；未保存草稿优先，不参与刷新。
  const activationReloadReadyRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (!activationReloadReadyRef.current) {
      activationReloadReadyRef.current = true;
      return;
    }
    if (isDirtyRef.current) return;
    setReloadTrigger((n) => n + 1);
  }, [active]);

  // 前台标签的磁盘新鲜度轮询：只有可见编辑器才订阅，切走立即退订。
  // 全局单例调度器每轮最多查 2 个目标，标签切换不会形成轮询风暴。
  useEffect(() => {
    if (!active || isBinary) return;
    const subscription = subscribeFileFreshness({
      key: stateKey || filePath,
      path: filePath,
      cwd,
      baseline: diskStampRef.current,
      onExternalChange: (stamp) => {
        // 先把本实例的基线推进到新版本：冲突面板跨标签切换/重新挂载后不会重复弹同一版本。
        diskStampRef.current = stamp;
        // 图片没有文本内容可重载：换一个版本号让 <img> 重新取图。
        if (viewModeRef.current === 'image') {
          setAssetVersion(Date.now());
          return;
        }
        if (isDirtyRef.current) {
          setDiskConflict(true);
          return;
        }
        // 非脏标签：保持当前编辑/预览模式，静默换上磁盘最新内容。
        externalReloadRef.current = true;
        setDiskConflict(false);
        setReloadTrigger((n) => n + 1);
      },
    });
    freshnessSubRef.current = subscription;
    return () => {
      subscription.dispose();
      if (freshnessSubRef.current === subscription) freshnessSubRef.current = null;
    };
  }, [active, isBinary, stateKey, filePath, cwd]);

  // 回到窗口/标签页可见时补一次磁盘校验：不依赖 /fs/stat 是否可用，
  // 保证“离开一段时间后回来”能看到外部程序/其他工具的落盘结果。
  useEffect(() => {
    if (!active) return;
    const refreshOnReturn = () => {
      if (document.visibilityState !== 'visible') return;
      // 草稿优先；刚读过盘（打开/切换标签）则不必重复。
      if (isDirtyRef.current) return;
      if (Date.now() - lastDiskLoadAtRef.current < 1500) return;
      setReloadTrigger((n) => n + 1);
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [active]);

  // 语法高亮分词 HTML (与 Markdown 预览模式共享黄色搜索高亮与当前项聚焦高亮！)
  const highlightedHtml = useMemo(() => {
    const codeHtml = highlightCode(content, filePath);
    if (findOpen && findText.trim()) {
      return highlightHtml(codeHtml, findText, currentMatchIdx).html;
    }
    return codeHtml;
  }, [content, filePath, findOpen, findText, currentMatchIdx]);

  // 一键格式化代码 (支持 JSON/JSONC、JS/TS/Rust 等标准化美化)
  const handleFormat = useCallback(() => {
    const formatted = formatCodeContent(content, filePath);
    if (formatted !== content) {
      setContent(formatted);
      setIsDirty(true);
      pushSnapshot(formatted, 0);
      showToast(t('editor.formatted'), 'success');
    } else {
      showToast(t('editor.alreadyFormatted'), 'info');
    }
  }, [content, filePath, t]);

  const handleScroll = (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = ta.scrollTop;
    }
    rememberEditorViewport();
  };

  // 独立的编辑器/文件预览字号滚轮缩放 (全局共享，不影响主画布)
  const handleEditorWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 1 : -1;
      changeEditorFontSize(delta);
    }
  };

  // 现代代码编辑器键盘增强：全局撤销重做、智能回车缩进、成对括号展开、Tab/Shift+Tab 缩进与智能退格
  const handleTextareaKeyDown = (e: KeyboardEvent) => {
    const ta = textareaRef.current;
    if (!ta) return;

    // 0. 全局撤销 (Ctrl+Z / Cmd+Z) 与 重做 (Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      redo();
      return;
    }

    // 1. Enter 键智能缩进
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = ta.value;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      // 在跨行前如果尚未推入快照，先锁定当前行状态
      pushSnapshot(val, start);

      // 获取当前行文本与当前缩进
      const lastNewline = val.lastIndexOf('\n', start - 1);
      const currentLine = val.slice(lastNewline + 1, start);
      const indent = currentLine.match(/^\s*/)?.[0] || '';

      // 检查光标前一个字符与后一个字符
      const trimmedBefore = currentLine.trimEnd();
      const lastChar = trimmedBefore[trimmedBefore.length - 1];
      const nextChar = val[start];

      // 判断是否需要增加一级缩进 (遇到 { 或 [ 或 ( 或 :)
      const shouldIncreaseIndent = lastChar === '{' || lastChar === '[' || lastChar === '(' || lastChar === ':';
      const isBracketPair =
        (lastChar === '{' && nextChar === '}') ||
        (lastChar === '[' && nextChar === ']') ||
        (lastChar === '(' && nextChar === ')');

      if (isBracketPair) {
        // 成对大/中括号中间回车：展开为 3 行，光标停在中间行缩进位置
        const innerIndent = indent + '  ';
        const inserted = `\n${innerIndent}\n${indent}`;
        const nextVal = val.slice(0, start) + inserted + val.slice(end);
        setContent(nextVal);
        setIsDirty(true);
        const cursorPosition = start + 1 + innerIndent.length;
        pushSnapshot(nextVal, cursorPosition);
        window.requestAnimationFrame(() => {
          ta.setSelectionRange(cursorPosition, cursorPosition);
        });
        return;
      }

      const extraIndent = shouldIncreaseIndent ? '  ' : '';
      const inserted = `\n${indent}${extraIndent}`;
      const nextVal = val.slice(0, start) + inserted + val.slice(end);
      setContent(nextVal);
      setIsDirty(true);
      const cursorPosition = start + inserted.length;
      pushSnapshot(nextVal, cursorPosition);
      window.requestAnimationFrame(() => {
        ta.setSelectionRange(cursorPosition, cursorPosition);
      });
      return;
    }

    // 2. Tab 键缩进 (支持单点插入与 Shift+Tab 反向减少缩进)
    if (e.key === 'Tab') {
      e.preventDefault();
      const val = ta.value;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      pushSnapshot(val, start);

      if (!e.shiftKey) {
        // Tab 正向缩进 2 空格
        if (start === end) {
          const nextVal = val.slice(0, start) + '  ' + val.slice(end);
          setContent(nextVal);
          setIsDirty(true);
          const cursorPosition = start + 2;
          pushSnapshot(nextVal, cursorPosition);
          window.requestAnimationFrame(() => {
            ta.setSelectionRange(cursorPosition, cursorPosition);
          });
        } else {
          // 多行选区：每行首加 2 空格
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          const selectedBlock = val.slice(lineStart, end);
          const indentedBlock = selectedBlock.split('\n').map((l) => '  ' + l).join('\n');
          const nextVal = val.slice(0, lineStart) + indentedBlock + val.slice(end);
          setContent(nextVal);
          setIsDirty(true);
          const nextCursor = end + (indentedBlock.length - selectedBlock.length);
          pushSnapshot(nextVal, nextCursor);
          window.requestAnimationFrame(() => {
            ta.setSelectionRange(start + 2, nextCursor);
          });
        }
      } else {
        // Shift+Tab 反向缩进
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const selectedBlock = val.slice(lineStart, end);
        const unindentedBlock = selectedBlock
          .split('\n')
          .map((l) => (l.startsWith('  ') ? l.slice(2) : l.startsWith(' ') ? l.slice(1) : l))
          .join('\n');
        const nextVal = val.slice(0, lineStart) + unindentedBlock + val.slice(end);
        setContent(nextVal);
        setIsDirty(true);
        const nextCursor = Math.max(lineStart, end - (selectedBlock.length - unindentedBlock.length));
        pushSnapshot(nextVal, nextCursor);
        window.requestAnimationFrame(() => {
          ta.setSelectionRange(
            Math.max(lineStart, start - 2),
            nextCursor,
          );
        });
      }
      return;
    }

    // 3. 智能退格 (Backspace：若光标前是 2 个空格且行首全为空格，一次删除 2 空格)
    if (e.key === 'Backspace') {
      const val = ta.value;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start === end && start >= 2) {
        const lastNewline = val.lastIndexOf('\n', start - 1);
        const beforeCursor = val.slice(lastNewline + 1, start);
        if (/^\s+$/.test(beforeCursor) && beforeCursor.endsWith('  ')) {
          e.preventDefault();
          pushSnapshot(val, start);
          const nextVal = val.slice(0, start - 2) + val.slice(end);
          setContent(nextVal);
          setIsDirty(true);
          const cursorPosition = start - 2;
          pushSnapshot(nextVal, cursorPosition);
          window.requestAnimationFrame(() => {
            ta.setSelectionRange(cursorPosition, cursorPosition);
          });
        }
      }
    }
  };

  // 读取文件内容 (非文本类文件直接跳过文本读取，进入图片/二进制视图)
  useEffect(() => {
    let cancelled = false;
    if ((isImage && !isSvg) || isBinary) {
      // 图片/二进制没有文本可重读：显式刷新时用版本号打穿缓存（/fs/raw 带 24h 强缓存）。
      const requestedToken = reloadToken ?? 0;
      const forced = requestedToken !== reloadTokenRef.current;
      reloadTokenRef.current = requestedToken;
      if (forced && isImage) setAssetVersion(Date.now());
      setLoading(false);
      setLoadError(null);
      return;
    }

    const norm = (filePath || '').trim().replace(/\\/g, '/');
    const isAbs = /^[a-zA-Z]:\//.test(norm) || norm.startsWith('/');
    // 若为相对路径且 cwd 尚未就绪（如页面刷新首帧等待项目异步就绪），暂缓发起请求避免误报 404
    if (!isAbs && !cwd) {
      return;
    }

    // 标签现场优先：后台重新挂载 / 项目切换 / cwd 变更都不得静默覆盖未保存草稿，
    // 只有显式刷新令牌（用户点刷新）才允许让位给磁盘内容。
    const requestedToken = reloadToken ?? 0;
    const forcedReload = requestedToken !== reloadTokenRef.current;
    reloadTokenRef.current = requestedToken;
    // 冲突面板的“重新加载”是用户显式放弃草稿：绕过脏标记守门，但在真正替换成功前不改脏状态。
    const manualForce = manualReloadRef.current;
    if (!shouldReloadFromDisk(isDirtyRef.current, forcedReload || manualForce)) {
      setLoading(false);
      setLoadError(null);
      return;
    }

    setLoadError(null);

    // 优先从 L1/L2 IndexedDB 异步直出已缓存内容（1~2ms），杜绝白屏等待与加载中闪烁
    void getCachedFileContent(filePath).then((cached) => {
      // 用户已开始编辑时，缓存直出不得覆盖本地草稿。
      if (!cancelled && !isDirtyRef.current && cached !== null) {
        setContent(cached);
        historyRef.current = [{ text: cached, cursor: 0 }];
        historyIndexRef.current = 0;
        setLoading(false);
      }
    });

    // 已有标签现场时后台静默校验磁盘，避免重挂载瞬间闪一次加载态。
    if (!restoredSnapshot) setLoading(true);
    fetchFsRead(filePath, cwd)
      .then((res) => {
        // 请求期间用户可能已经键入：磁盘旧内容不得覆盖未保存草稿。
        // 例外：冲突面板的“重新加载”或顶栏刷新（用户已确认）是显式放弃草稿的授权。
        if (!cancelled && (!isDirtyRef.current || manualForce || forcedReload)) {
          const loaded = res.content || '';
          const previousContent = latestTabStateRef.current.content;
          const replaced = loaded !== previousContent;
          setContent(loaded);
          historyRef.current = [{ text: loaded, cursor: 0 }];
          historyIndexRef.current = 0;
          setIsDirty(false);
          setLoadError(null);
          lastDiskLoadAtRef.current = Date.now();
          void saveCachedFileContent(filePath, loaded);
          // 记录磁盘基线：轮询据此判断“外部是不是真的改过这个文件”。
          const stamp = fileStampFromRead(res);
          if (stamp) {
            diskStampRef.current = stamp;
            freshnessSubRef.current?.updateBaseline(stamp);
          }
          const wasExternal = externalReloadRef.current;
          const wasManual = manualReloadRef.current;
          externalReloadRef.current = false;
          manualReloadRef.current = false;
          if (wasExternal && replaced) {
            setDiskConflict(false);
            showToast(t('editor.reloadedFromDisk', { name: fileName }), 'info');
          }
          if (wasExternal || wasManual || replaced) {
            // 内容整体替换后把光标夹回有效范围，避免停在已不存在的偏移。
            requestAnimationFrame(() => {
              const ta = textareaRef.current;
              if (!ta) return;
              const max = loaded.length;
              try {
                ta.setSelectionRange(
                  Math.min(ta.selectionStart ?? 0, max),
                  Math.min(ta.selectionEnd ?? 0, max),
                );
              } catch {}
            });
          }
        } else if (!cancelled) {
          // 请求期间用户已经键入：草稿优先，绝不静默覆盖；外部更新降级为冲突提示。
          if (externalReloadRef.current) setDiskConflict(true);
          externalReloadRef.current = false;
          manualReloadRef.current = false;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const errMsg = err?.message || String(err);
          setLoadError(errMsg);
          // 重载失败时保留原草稿与脏状态，不能假装“已放弃修改”。
          manualReloadRef.current = false;
          // 在编辑器内部以专业内联卡片展示错误状态与恢复选项，绝不以全局浮动 Toast 骚扰用户
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, cwd, reloadTrigger, reloadToken, isImage, isSvg, isBinary]);

  // 保存文件
  const handleSave = useCallback(async (e?: any) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetchFsWrite(filePath, content);
      setIsDirty(false);
      // 保存本身就是对磁盘冲突的收尾：本地版本已成为最新磁盘版本。
      setDiskConflict(false);
      void saveCachedFileContent(filePath, content);
      // 自己的写入也要推进磁盘基线，否则下一次轮询会把这次保存误报成外部更新。
      const stamp = fileStampFromRead(res);
      if (stamp) {
        diskStampRef.current = stamp;
        freshnessSubRef.current?.updateBaseline(stamp);
      }
      showToast(t('editor.saveSuccess', { name: fileName }), 'success');
      // 广播工作区文件变动事件，如果保存的是 gitignore 则派发 gitignore 特别事件
      window.dispatchEvent(new CustomEvent('jeikcode:worktree_touch'));
      const lower = (filePath || '').toLowerCase().replace(/\\/g, '/');
      if (lower.endsWith('.gitignore') || lower.endsWith('/.gitignore')) {
        window.dispatchEvent(new CustomEvent('jeikcode:gitignore_touch'));
      }
    } catch (err: any) {
      showToast(t('editor.saveFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }, [filePath, content, saving, fileName]);

  // 冲突面板：重新加载 = 明确放弃本地草稿（真正替换成功后才清脏）。
  const handleReloadFromDisk = useCallback(() => {
    setDiskConflict(false);
    manualReloadRef.current = true;
    setReloadTrigger((n) => n + 1);
  }, []);

  // 冲突面板：保留本地草稿。调度器已把基线推进到新版本，同一版本不会反复提示。
  const handleKeepLocalDraft = useCallback(() => {
    setDiskConflict(false);
  }, []);

  // 监听外部保存指令广播 (例如右侧面板顶栏保存图标点击)
  useEffect(() => {
    const handleExternalSave = () => {
      void handleSave();
    };
    window.addEventListener(`jeikcode:editor:save:${eventScope}`, handleExternalSave);
    return () => {
      window.removeEventListener(`jeikcode:editor:save:${eventScope}`, handleExternalSave);
    };
  }, [eventScope, handleSave]);

  // 快捷键监听：Ctrl+S (保存), Ctrl+F (查找), Ctrl+H (替换), Ctrl+Shift+V (MD切换)
  useEffect(() => {
    // 后台保活的标签不注册全局快捷键，否则一次 Ctrl+S 会同时写多个文件。
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // 右侧面板折叠 / 切到其它面板时，保活编辑器仍在 DOM 里但没有布局盒，不得吞掉快捷键。
      if (!isEditorVisible()) return;
      // 主画布与右侧预览可能同时各有一个可见编辑器：只有焦点所在的编辑器响应快捷键。
      // 焦点不在任何编辑器内时一律不响应，避免右侧预览抢走聊天输入框的 Ctrl+F / Ctrl+S。
      const focused = document.activeElement as HTMLElement | null;
      if (!focused || !editorRootRef.current?.contains(focused)) return;
      // Ctrl+S
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
        return;
      }
      // Ctrl+Alt+L (格式化代码)
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleFormat();
        return;
      }
      // Ctrl+Shift+V (切换预览/代码编辑模式，对齐主面板与右侧面板)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        const next = toggleTextMode(viewMode);
        setViewMode(next);
        showToast(next === 'preview' ? t('editor.switchToPreview') : t('editor.switchToEdit'), 'info');
        return;
      }
      // Ctrl+F
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.file-explorer-root, .chat-messages-scroll, .terminal-panel-root, .xterm')) return;
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(true);
        setReplaceOpen(false);
        setTimeout(() => findInputRef.current?.focus(), 50);
        return;
      }
      // Ctrl+H
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.file-explorer-root, .chat-messages-scroll, .terminal-panel-root, .xterm')) return;
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(true);
        setReplaceOpen(true);
        return;
      }
      // Escape
      if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
        setReplaceOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave, isMarkdown, viewMode, findOpen, active, isEditorVisible]);

  // 执行替换
  const handleReplaceOne = () => {
    if (!findText) return;
    const idx = content.indexOf(findText);
    if (idx === -1) {
      showToast(t('editor.noMatch'), 'info');
      return;
    }
    const next = content.slice(0, idx) + replaceText + content.slice(idx + findText.length);
    setContent(next);
    setIsDirty(true);
  };

  const handleReplaceAll = () => {
    if (!findText) return;
    const parts = content.split(findText);
    if (parts.length <= 1) {
      showToast(t('editor.noMatch'), 'info');
      return;
    }
    const next = parts.join(replaceText);
    setContent(next);
    setIsDirty(true);
    showToast(t('editor.replaceAllSuccess', { n: String(parts.length - 1) }), 'success');
  };

  // 计算行号范围高亮带 (支持单行号及多行范围)
  const targetLineBand = useMemo(() => {
    if (!startLine || startLine <= 0 || !content) return null;
    const lines = content.split('\n');
    const start = Math.min(lines.length, startLine);
    const end = endLine && endLine >= start ? Math.min(lines.length, endLine) : start;
    const lineCount = end - start + 1;
    return {
      top: `${(start - 1) * 20 + 8}px`,
      height: `${lineCount * 20}px`,
    };
  }, [startLine, endLine, content]);

  // 平滑滚动并高亮选中目标行号范围
  const scrollToTargetLine = useCallback(
    (targetStart?: number, targetEnd?: number, select = true) => {
      if (!targetStart || targetStart <= 0 || !content) return;
      const lines = content.split('\n');
      const startIdx = Math.min(lines.length, Math.max(1, targetStart));
      const endIdx = targetEnd && targetEnd >= startIdx ? Math.min(lines.length, targetEnd) : startIdx;

      let charStart = 0;
      for (let i = 0; i < startIdx - 1; i++) {
        charStart += lines[i].length + 1;
      }
      let charEnd = charStart;
      for (let i = startIdx - 1; i < endIdx; i++) {
        charEnd += lines[i].length + (i < lines.length - 1 ? 1 : 0);
      }

      const ta = textareaRef.current;
      if (ta) {
        try {
          // 前台标签才抢焦点；后台保活标签只记录选区，不抢当前画布的焦点。
          // 延迟重试只修滚动位置，不再改选区，以免用户已经开始输入又被拉回目标行。
          if (select) {
            if (activeRef.current) ta.focus();
            ta.setSelectionRange(charStart, charEnd);
          }
        } catch {}
        const totalLines = Math.max(1, lines.length);
        const approxLineHeight = ta.scrollHeight / totalLines || 20;
        const targetScrollTop = Math.max(0, (startIdx - 4) * approxLineHeight);
        ta.scrollTop = targetScrollTop;
        if (preRef.current) preRef.current.scrollTop = targetScrollTop;
        if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = targetScrollTop;
      }

      if (viewMode === 'preview' && previewContainerRef.current) {
        const container = previewContainerRef.current;
        const targetScrollTop = Math.max(0, ((startIdx - 4) / Math.max(1, lines.length)) * container.scrollHeight);
        container.scrollTop = targetScrollTop;
      }
      if (select) rememberEditorViewport();
    },
    [content, viewMode, rememberEditorViewport],
  );

  // 目标行跳转只响应“打开/跳转到某行”的一次性意图：后续输入引起的 content 变化
  // 不得反复抢回选区，否则带行号打开的文件根本没法编辑。
  // 从标签现场恢复时沿用现场光标，不重复跳到当初打开的行号。
  const appliedLineTargetRef = useRef<string | null>(
    restoredSnapshot && startLine ? `${startLine}:${endLine ?? ''}` : null,
  );
  useEffect(() => {
    if (!startLine || startLine <= 0) {
      appliedLineTargetRef.current = null;
      return;
    }
    const target = `${startLine}:${endLine ?? ''}`;
    if (appliedLineTargetRef.current === target) return;
    // 内容未就绪时先不消费目标，等它到达再定位一次。
    if (!content) return;
    appliedLineTargetRef.current = target;
    const frame = requestAnimationFrame(() => scrollToTargetLine(startLine, endLine, true));
    // 延迟重试只为等 Markdown 渲染 / 字体度量就绪后修正滚动，不再重复抢选区。
    const t1 = setTimeout(() => scrollToTargetLine(startLine, endLine, false), 80);
    const t2 = setTimeout(() => scrollToTargetLine(startLine, endLine, false), 240);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [startLine, endLine, content, scrollToTargetLine]);

  // 计算行号列表与行号纯文本（将原本上万个 DOM 节点精简为单个 pre 文本节点，大文件缩放性能提升 100 倍！）
  const lines = useMemo(() => content.split('\n'), [content]);
  const lineNumbersText = useMemo(() => {
    const len = lines.length;
    let res = '';
    for (let i = 1; i <= len; i++) {
      res += i + '\n';
    }
    return res;
  }, [lines.length]);

  // 独立的编辑器/文件预览字号滚轮缩放 (在捕获阶段拦截，支持代码编辑模式与 Markdown 预览模式平滑缩放，40ms 防抖杜绝卡顿)
  useEffect(() => {
    const el = editorRootRef.current;
    if (!el) return;
    let zoomTimer: any = null;
    let accum = 0;
    const onWheelCapture = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        accum += e.deltaY < 0 ? 1 : -1;
        if (zoomTimer) clearTimeout(zoomTimer);
        zoomTimer = setTimeout(() => {
          if (accum !== 0) {
            changeEditorFontSize(accum > 0 ? 1 : -1);
            accum = 0;
          }
        }, 40);
      }
    };
    el.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
    return () => {
      el.removeEventListener('wheel', onWheelCapture, { capture: true } as any);
      if (zoomTimer) clearTimeout(zoomTimer);
    };
  }, []);

  const handleEditorDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleEditorDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath) {
        // 预览面板内部：拖入文件继续留在右侧，不能再开一份主标签。
        if (onFileDrop) {
          onFileDrop(String(targetPath).trim());
          return;
        }
        window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: targetPath.trim() } }));
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            if (onFileDrop) {
              onFileDrop(String(p));
              continue;
            }
            window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: p } }));
          }
        }
      }
    } catch {}
  };

  const handleEditorRootMouseDown = (e: MouseEvent) => {
    // 点击编辑器任意非控件区域时把焦点交给编辑器：快捷键（Ctrl+F/S）只作用于
    // 焦点所在的编辑器，避免右侧预览抢走聊天输入框的按键。
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, button, a, select')) return;
    editorRootRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      class="code-editor-root"
      ref={editorRootRef}
      tabIndex={0}
      onMouseDown={handleEditorRootMouseDown}
      onDragOver={handleEditorDragOver}
      onDrop={handleEditorDrop}
    >
      {/* 顶部工具栏 */}
      {!hideHeaderToolbar && (
        <div class="code-editor-toolbar">
        <div class="editor-file-info">
          <span class="editor-file-badge">{fileName.split('.').pop()?.toUpperCase() || 'FILE'}</span>
          <span class="editor-file-name">{fileName}</span>
          {isDirty && <span class="editor-dirty-dot" title={t('editor.dirty')}>●</span>}
          <span class="editor-file-path" title={filePath}>{filePath}</span>
        </div>

        <div class="editor-toolbar-actions">
          {/* 图片模式专属控制 */}
          {viewMode === 'image' && (
            <>
              {isSvg && (
                <button
                  type="button"
                  class="editor-tool-btn"
                  onClick={() => setViewMode('edit')}
                  title={t('editor.svgSourceTitle')}
                >
                  <span class="editor-btn-icon">✏️</span>
                  <span class="editor-btn-text">{t('editor.svgSource')}</span>
                </button>
              )}
              <button
                type="button"
                class="editor-tool-btn"
                onClick={() => setImgScale((s) => Math.max(0.2, s - 0.2))}
                title={t('editor.zoomOut')}
              >
                <span class="editor-btn-icon">➖</span>
              </button>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={() => setImgScale(1.0)}
                title={t('editor.actualSize')}
              >
                <span class="editor-btn-icon">{`${Math.round(imgScale * 100)}%`}</span>
              </button>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={() => setImgScale((s) => Math.min(5.0, s + 0.2))}
                title={t('editor.zoomIn')}
              >
                <span class="editor-btn-icon">➕</span>
              </button>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={() => setImgScale(1.0)}
                title={t('editor.fitToView')}
              >
                <span class="editor-btn-icon">⤢</span>
                <span class="editor-btn-text">{t('editor.fitToView')}</span>
              </button>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={async () => {
                  try {
                    await openFileWithOs(filePath);
                    showToast(t('preview.openWithDefaultAppSuccess', { path: fileName }), 'success');
                  } catch {
                    // 系统外壳调用失败时静默忽略
                  }
                }}
                title={t('preview.openWithDefaultApp')}
              >
                <span class="editor-btn-icon">🚀</span>
                <span class="editor-btn-text">{t('preview.openWithDefaultApp')}</span>
              </button>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={async () => {
                  try {
                    await revealInFileExplorer(filePath);
                    showToast(t('preview.revealDirSuccess', { path: fileName }), 'success');
                  } catch {
                    // 系统外壳调用失败时静默忽略
                  }
                }}
                title={t('explorer.revealInOs')}
              >
                <span class="editor-btn-icon">📁</span>
                <span class="editor-btn-text">{t('explorer.revealInOs')}</span>
              </button>
            </>
          )}

          {/* 二进制模式专属控制 */}
          {viewMode === 'binary' && (
            <>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={async () => {
                  try {
                    await openFileWithOs(filePath);
                    showToast(t('preview.openWithDefaultAppSuccess', { path: fileName }), 'success');
                  } catch {
                    // 系统外壳调用失败时静默忽略
                  }
                }}
                title={t('preview.openWithDefaultApp')}
              >
                <span class="editor-btn-icon">🚀</span>
                <span class="editor-btn-text">{t('preview.openWithDefaultApp')}</span>
              </button>
              <button
                type="button"
                class="editor-tool-btn"
                onClick={async () => {
                  try {
                    await revealInFileExplorer(filePath);
                    showToast(t('preview.revealDirSuccess', { path: fileName }), 'success');
                  } catch {
                    // 系统外壳调用失败时静默忽略
                  }
                }}
                title={t('explorer.revealInOs')}
              >
                <span class="editor-btn-icon">📁</span>
                <span class="editor-btn-text">{t('explorer.revealInOs')}</span>
              </button>
            </>
          )}

          {/* 代码与文本编辑模式控制 */}
          {(viewMode === 'edit' || viewMode === 'preview') && (
            <>
              {isSvg && (
                <button
                  type="button"
                  class="editor-tool-btn"
                  onClick={() => setViewMode('image')}
                  title={t('editor.svgPreviewTitle')}
                >
                  <span class="editor-btn-icon">🖼️</span>
                  <span class="editor-btn-text">{t('editor.svgPreview')}</span>
                </button>
              )}

              {/* Markdown 双模切换按钮 */}
              {isMarkdown && (
                <button
                  type="button"
                  class={'editor-tool-btn' + (viewMode === 'preview' ? ' active' : '')}
                  onClick={() => setViewMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
                  title={viewMode === 'edit' ? t('editor.switchToPreview') : t('editor.switchToEdit')}
                >
                  <span class="editor-btn-icon">{viewMode === 'edit' ? '📖' : '✏️'}</span>
                  <span class="editor-btn-text">{viewMode === 'edit' ? t('editor.preview') : t('editor.edit')}</span>
                </button>
              )}

              <button
                type="button"
                class="editor-tool-btn"
                onClick={handleFormat}
                title={t('editor.format')}
              >
                <span class="editor-btn-icon">🪄</span>
                <span class="editor-btn-text">{t('editor.format')}</span>
              </button>
              <button
                type="button"
                class={'editor-tool-btn' + (findOpen ? ' active' : '')}
                onClick={() => {
                  setFindOpen((v) => !v);
                  if (!findOpen) setReplaceOpen(false);
                }}
                title={t('editor.find')}
              >
                <span class="editor-btn-icon">🔍</span>
                <span class="editor-btn-text">{t('editor.find')}</span>
              </button>
              <button
                type="button"
                class={'editor-tool-btn' + (replaceOpen ? ' active' : '')}
                onClick={() => {
                  setFindOpen(true);
                  setReplaceOpen((v) => !v);
                }}
                title={t('editor.replace')}
              >
                <span class="editor-btn-icon">🔄</span>
                <span class="editor-btn-text">{t('editor.replace')}</span>
              </button>
              <button
                type="button"
                class="editor-save-btn"
                onClick={handleSave}
                disabled={saving || !isDirty}
                title={t('editor.save')}
              >
                <span class="editor-btn-icon">{saving ? '⏳' : isDirty ? '💾' : '✓'}</span>
                <span class="editor-btn-text">{saving ? t('editor.saving') : isDirty ? t('editor.save') : t('editor.saved')}</span>
              </button>
            </>
          )}
        </div>
      </div>
      )}

      {/* 磁盘 vs 本地草稿冲突：只提示，不自动覆盖用户正在编辑的内容 */}
      {diskConflict && (
        <div class="editor-disk-conflict" role="alert">
          <div class="editor-disk-conflict-text">
            <span class="editor-disk-conflict-title">{t('editor.diskUpdated')}</span>
            <span class="editor-disk-conflict-desc">{t('editor.diskUpdatedDesc')}</span>
          </div>
          <div class="editor-disk-conflict-actions">
            <button
              type="button"
              class="editor-disk-conflict-btn"
              onClick={handleKeepLocalDraft}
            >
              {t('editor.keepLocalDraft')}
            </button>
            <button
              type="button"
              class="editor-disk-conflict-btn is-primary"
              onClick={handleReloadFromDisk}
            >
              {t('editor.reloadFromDisk')}
            </button>
          </div>
        </div>
      )}

      {/* 搜索与替换浮动条 (标准上下双行 VS Code 经典排版) */}
      {findOpen && (
        <div class="editor-find-bar">
          <div class="find-row">
            <button
              type="button"
              class="find-toggle-chevron"
              onClick={() => setReplaceOpen((v) => !v)}
              title={replaceOpen ? t('editor.replaceCollapse') : t('editor.replaceExpand')}
            >
              {replaceOpen ? '▼' : '▶'}
            </button>
            <div class="find-input-wrap">
              <input
                ref={findInputRef}
                type="text"
                class="find-input"
                placeholder={t('editor.find') || '查找'}
                value={findText}
                onInput={(e) => {
                  setFindText((e.target as HTMLInputElement).value);
                  setCurrentMatchIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) {
                      handleFindPrev();
                    } else {
                      handleFindNext();
                    }
                  }
                }}
              />
              {findText && (
                <span class="find-count-badge">
                  {(viewMode === 'preview' ? previewMatchCount : matchIndices.length) > 0
                    ? `${currentMatchIdx + 1}/${viewMode === 'preview' ? previewMatchCount : matchIndices.length}`
                    : '0/0'}
                </span>
              )}
            </div>
            <button
              type="button"
              class="find-nav-btn"
              onClick={handleFindPrev}
              disabled={(viewMode === 'preview' ? previewMatchCount : matchIndices.length) === 0}
              title={t('editor.findPrevTitle')}
            >
              ↑
            </button>
            <button
              type="button"
              class="find-nav-btn"
              onClick={handleFindNext}
              disabled={(viewMode === 'preview' ? previewMatchCount : matchIndices.length) === 0}
              title={t('editor.findNextTitle')}
            >
              ↓
            </button>
            <button
              type="button"
              class="find-close-btn"
              onClick={() => {
                setFindOpen(false);
                setReplaceOpen(false);
              }}
              title={t('editor.findCloseTitle')}
            >
              ✕
            </button>
          </div>

          {/* 第二行：替换行 (展开在搜索框正下方) */}
          {replaceOpen && (
            <div class="replace-row">
              <div class="replace-indent-spacer" />
              <div class="find-input-wrap">
                <input
                  type="text"
                  class="find-input"
                  placeholder={t('editor.replace') || '替换'}
                  value={replaceText}
                  onInput={(e) => setReplaceText((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (e.altKey || (e.ctrlKey && e.altKey)) {
                        handleReplaceAll();
                      } else {
                        handleReplaceOne();
                      }
                    }
                  }}
                />
              </div>
              <button
                type="button"
                class="find-action-btn"
                onClick={handleReplaceOne}
                title={t('editor.replaceCurrentTitle')}
              >
                {t('editor.replace') || '替换'}
              </button>
              <button
                type="button"
                class="find-action-btn"
                onClick={handleReplaceAll}
                title={t('editor.replaceAllTitle')}
              >
                {t('editor.replaceAll') || '全部替换'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 核心舞台：代码编辑器 或 Markdown 深度渲染 或 图片预览 或 二进制引导卡片 */}
      <div
        class="code-editor-stage"
        onDragOver={handleEditorDragOver}
        onDrop={handleEditorDrop}
      >
        {loadError ? (
          <div class="editor-error-stage">
            <div class="editor-error-card">
              <div class="editor-error-icon">⚠️</div>
              <div class="editor-error-title">{t('editor.readFailedTitle')}</div>
              <div class="editor-error-desc">
                {loadError.toLowerCase().includes('not found')
                  ? t('editor.fileNotFoundDesc')
                  : `${t('editor.readFailedDesc')}: ${loadError}`}
              </div>
              <div class="editor-error-path" title={filePath}>{filePath}</div>
              <div class="editor-error-actions">
                <button
                  type="button"
                  class="editor-error-retry-btn"
                  onClick={() => {
                    setLoadError(null);
                    setReloadTrigger((n) => n + 1);
                  }}
                  title={t('common.retry')}
                >
                  <span>🔄 {t('common.retry')}</span>
                </button>
                {onClose && (
                  <button
                    type="button"
                    class="editor-error-close-btn"
                    onClick={onClose}
                    title={t('editor.closeTab')}
                  >
                    <span>✕ {t('editor.closeTab')}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : loading ? (
          <div class="diff-loading-wrap">
            <div class="git-spinner" />
            <span>{t('editor.loading')}</span>
          </div>
        ) : viewMode === 'image' ? (
          <div class="editor-image-stage" onWheel={handleImageWheel}>
            <div class="editor-image-wrapper" style={{ transform: `scale(${imgScale})` }}>
              <img
                src={getFsRawUrl(filePath) + (assetVersion ? `&v=${assetVersion}` : '')}
                alt={fileName}
                class="editor-image-elem"
                onLoad={(e) => {
                  const img = e.currentTarget as HTMLImageElement;
                  setImgDimensions({ w: img.naturalWidth, h: img.naturalHeight });
                }}
              />
            </div>
            {imgDimensions && (
              <div class="editor-image-pill">
                <span>{`${imgDimensions.w} × ${imgDimensions.h} px`}</span>
                <span>•</span>
                <span>{`${Math.round(imgScale * 100)}%`}</span>
              </div>
            )}
          </div>
        ) : viewMode === 'binary' ? (
          <div class="editor-binary-stage">
            <div class="editor-binary-card">
              <div class="editor-binary-icon">
                {isArchive
                  ? '📦'
                  : ext === 'pdf'
                  ? '📕'
                  : ['mp3', 'wav', 'ogg'].includes(ext)
                  ? '🎵'
                  : ['mp4', 'mov', 'webm'].includes(ext)
                  ? '🎬'
                  : '⚙️'}
              </div>
              <div class="editor-binary-title">{fileName}</div>
              <div class="editor-binary-desc">
                {isArchive
                  ? t('editor.archiveBinaryDesc')
                  : t('editor.binaryDesc')}
              </div>
              <div class="editor-binary-path">{filePath}</div>
              <div class="editor-binary-actions">
                <button
                  type="button"
                  class="binary-action-primary-btn"
                  onClick={async () => {
                    try {
                      await openFileWithOs(filePath);
                      showToast(t('preview.openWithDefaultAppSuccess', { path: fileName }), 'success');
                    } catch {
                      // 系统外壳调用失败时静默忽略
                    }
                  }}
                >
                  <span>🚀 {t('preview.openWithDefaultApp')}</span>
                </button>
                <button
                  type="button"
                  class="binary-action-secondary-btn"
                  onClick={async () => {
                    try {
                      await revealInFileExplorer(filePath);
                      showToast(t('preview.revealDirSuccess', { path: fileName }), 'success');
                    } catch {
                      // 系统外壳调用失败时静默忽略
                    }
                  }}
                >
                  <span>📁 {t('explorer.revealInOs')}</span>
                </button>
              </div>
            </div>
          </div>
        ) : viewMode === 'preview' && isMarkdown ? (
          <div
            class="editor-markdown-preview"
            ref={previewContainerRef}
            onScroll={rememberEditorViewport}
            onDragOver={handleEditorDragOver}
            onDrop={handleEditorDrop}
          >
            <Markdown
              content={content}
              basePath={filePath}
              search={findOpen ? findText : undefined}
              activeSearchIndex={findOpen ? currentMatchIdx : undefined}
              onMatchCountChange={setPreviewMatchCount}
              targetContext={linkTargetContext}
            />
          </div>
        ) : (
          <div
            class="editor-code-container"
            onDragOver={handleEditorDragOver}
            onDrop={handleEditorDrop}
          >
            {/* 行号侧栏 (单个 pre 极速渲染，大文件缩放与滚动零延迟) */}
            <div class="editor-line-numbers" ref={lineNumbersRef} aria-hidden="true">
              {targetLineBand && (
                <div class="editor-target-gutter-band" style={targetLineBand} aria-hidden="true" />
              )}
              <pre class="line-numbers-pre">{lineNumbersText}</pre>
            </div>
            {/* 代码主体包装器 (双层叠加：高亮预览底层 + 原生透明编辑上层) */}
            <div
              class="editor-code-wrapper"
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
            >
              {targetLineBand && (
                <div class="editor-target-lines-band" style={targetLineBand} aria-hidden="true" />
              )}
              <pre ref={preRef} class="editor-syntax-highlight" aria-hidden="true">
                <code dangerouslySetInnerHTML={{ __html: highlightedHtml + '\n' }} />
              </pre>
              <textarea
                ref={textareaRef}
                class={'editor-textarea' + (viewMode === 'preview' ? ' is-preview-readonly' : '')}
                value={content}
                readOnly={viewMode === 'preview'}
                onDragOver={handleEditorDragOver}
                onDrop={handleEditorDrop}
                onSelect={rememberEditorViewport}
                onKeyUp={rememberEditorViewport}
                onInput={(e) => {
                  const val = (e.target as HTMLTextAreaElement).value;
                  const cur = (e.target as HTMLTextAreaElement).selectionStart;
                  setContent(val);
                  setIsDirty(true);
                  if (inputDebounceTimerRef.current) {
                    clearTimeout(inputDebounceTimerRef.current);
                  }
                  inputDebounceTimerRef.current = window.setTimeout(() => {
                    pushSnapshot(val, cur);
                  }, 280);
                }}
                onKeyDown={handleTextareaKeyDown}
                onScroll={handleScroll}
                spellcheck={false}
                wrap="off"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
