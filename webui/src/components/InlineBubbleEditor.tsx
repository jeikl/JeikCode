import { useEffect, useRef, useState } from 'preact/hooks';
import type { ImageData, ModelInfo } from '../api';
import { useT } from '../settings';
import {
  countPending,
  fileToImageData,
  isImageFile,
  MAX_IMAGES,
  type PendingAttach,
  type PendingImage,
} from '../lib/attachments';
import { collectClipboardFiles, buildCopyHtml, copyTextAndImages } from '../lib/clipboard';
import { showToast } from './Toast';

export interface InlineBubbleEditorProps {
  initialText: string;
  initialImages?: ImageData[];
  models: ModelInfo[];
  currentModel: string;
  onSaveRewrite: (text: string, images: ImageData[]) => void;
  onRollbackSubmit: (text: string, images: ImageData[], tempModel?: string) => void;
  onCancel: () => void;
  onDraftChange?: (text: string, images: ImageData[], selectedModel?: string) => void;
  disabled?: boolean;
}

function imagesToPending(images: ImageData[]): PendingAttach[] {
  return (images || []).map((img, idx) => ({
    id: `bubble-edit-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'image' as const,
    image: img,
  }));
}

function pendingToImageData(attach: PendingAttach[]): ImageData[] {
  return attach
    .filter((item): item is PendingImage => item.kind === 'image')
    .map((item) => item.image);
}

export function InlineBubbleEditor({
  initialText,
  initialImages = [],
  models,
  currentModel,
  onSaveRewrite,
  onRollbackSubmit,
  onCancel,
  onDraftChange,
  disabled = false,
}: InlineBubbleEditorProps) {
  const t = useT();
  const [text, setText] = useState(initialText);
  const [pendingAttach, setPendingAttach] = useState<PendingAttach[]>(() =>
    imagesToPending(initialImages),
  );
  const [selectedModel, setSelectedModel] = useState<string>(currentModel);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const lastSyncedRef = useRef<{ text: string; attachLen: number; model: string }>({
    text: initialText,
    attachLen: initialImages.length,
    model: currentModel,
  });

  // 实时通知外部草稿变更，确保刷新页面或会话切换时保留编辑状态。
  // 严格比对新旧变更，杜绝无意义重复通知引发的父子组件无限重渲染死循环。
  useEffect(() => {
    if (
      text === lastSyncedRef.current.text &&
      pendingAttach.length === lastSyncedRef.current.attachLen &&
      selectedModel === lastSyncedRef.current.model
    ) {
      return;
    }
    lastSyncedRef.current = {
      text,
      attachLen: pendingAttach.length,
      model: selectedModel,
    };
    onDraftChangeRef.current?.(text, pendingToImageData(pendingAttach), selectedModel);
  }, [text, pendingAttach, selectedModel]);

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the editor viewport stable. Auto-growing the textarea on every
  // keystroke shifted the toolbar and the scroll thumb; long edits scroll
  // inside the fixed-height textarea instead.
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
      textareaRef.current.selectionEnd = textareaRef.current.value.length;
    }
    // The bubble may be partially under the fixed composer; bring the whole
    // editor into view once, without re-scrolling on every keystroke.
    containerRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Click Outside & Escape listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }

    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      // Do not trigger cancel if clicking inside editor container or inside a dialog/modal
      if (containerRef.current && containerRef.current.contains(target)) return;
      const insideModal = (target as HTMLElement).closest?.(
        '.modal-overlay, .confirm-dialog, .dialog-box',
      );
      if (insideModal) return;
      onCancel();
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onCancel]);

  async function handleAddFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const counts = countPending(pendingAttach);
    const added: PendingAttach[] = [];
    const undecodable: string[] = [];
    setUploading(true);
    for (const file of list) {
      if (counts.images >= MAX_IMAGES) break;
      if (isImageFile(file)) {
        const img = await fileToImageData(file);
        if (img) {
          counts.images += 1;
          added.push({
            id: `bubble-attach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: 'image',
            image: img,
          });
        } else {
          // 浏览器解不开的格式（HEIC/TIFF 等）不会静默丢失，明确提示用户先转格式
          undecodable.push(file.name);
        }
      }
    }
    setUploading(false);
    if (undecodable.length > 0) {
      showToast(t('attach.undecodable', { name: undecodable[0] }), 'error');
    }
    if (added.length) {
      setPendingAttach((prev) => [...prev, ...added]);
    }
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length) {
      void handleAddFiles(input.files);
      input.value = '';
    }
  }

  function removeAttach(id: string) {
    setPendingAttach((prev) => prev.filter((item) => item.id !== id));
  }

  function handlePaste(e: ClipboardEvent) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = collectClipboardFiles(dt);
    if (files.length > 0) {
      const imageFiles = files.filter(isImageFile);
      if (imageFiles.length > 0) {
        e.preventDefault();
        void handleAddFiles(imageFiles);
        const pastedText = dt.getData('text/plain');
        if (pastedText) {
          const ta = textareaRef.current;
          if (ta) {
            const start = ta.selectionStart ?? 0;
            const end = ta.selectionEnd ?? 0;
            const val = ta.value ?? '';
            const next = val.slice(0, start) + pastedText + val.slice(end);
            setText(next);
            requestAnimationFrame(() => {
              ta.selectionStart = ta.selectionEnd = start + pastedText.length;
            });
          } else {
            setText((prev) => (prev ? `${prev}\n${pastedText}` : pastedText));
          }
        }
      }
    }
  }

  function handleCopy(e: ClipboardEvent) {
    const ta = textareaRef.current || (e.target as HTMLTextAreaElement);
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const val = ta.value ?? '';
    const isAllSelected = (val.length > 0 && start === 0 && end >= val.length) || (val.length === 0);

    const attachedImages = pendingToImageData(pendingAttach);
    if (isAllSelected && attachedImages.length > 0) {
      e.preventDefault();
      const dataUrls = attachedImages.map((img) => `data:${img.media_type};base64,${img.data}`);
      const html = buildCopyHtml(dataUrls, val);
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', val);
        e.clipboardData.setData('text/html', html);
      }
      void copyTextAndImages(val, attachedImages);
      showToast(t('copy.copiedWithMedia'), 'info');
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length) {
      void handleAddFiles(e.dataTransfer.files);
    }
  }

  const hasContent = text.trim().length > 0 || pendingAttach.length > 0;

  function handleRewrite() {
    if (!hasContent || disabled) return;
    onSaveRewrite(text.trim(), pendingToImageData(pendingAttach));
  }

  function handleRollback() {
    if (!hasContent || disabled) return;
    onRollbackSubmit(text.trim(), pendingToImageData(pendingAttach), selectedModel);
  }

  return (
    <div
      ref={containerRef}
      class={`inline-bubble-editor ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {/* Attached images previews */}
      {pendingAttach.length > 0 && (
        <div class="inline-bubble-editor-attachments" role="list">
          {pendingAttach.map((item) => (
            <div key={item.id} class="inline-bubble-thumb-card" role="listitem">
              {item.kind === 'image' && (
                <img
                  src={`data:${item.image.media_type};base64,${item.image.data}`}
                  alt="thumbnail"
                  class="inline-bubble-thumb-img"
                />
              )}
              <button
                type="button"
                class="inline-bubble-thumb-remove"
                onClick={() => removeAttach(item.id)}
                title={t('chat.removeAttachment')}
                aria-label={t('chat.removeAttachment')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Textarea */}
      <div class="inline-bubble-editor-body">
        <textarea
          ref={textareaRef}
          class="inline-bubble-textarea"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onPaste={handlePaste}
          onCopy={handleCopy}
          onKeyDown={(e) => {
            // Shift + Enter 为多行换行，不拦截；普通 Enter（桌面端非输入法中）与 Ctrl+Enter 均触发回溯并提交
            if (e.key === 'Enter' && !e.shiftKey) {
              if (e.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              handleRollback();
              return;
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleRollback();
              return;
            }
          }}
          placeholder={t('chat.editPlaceholder')}
          rows={5}
          disabled={disabled}
        />
      </div>

      {/* Controls & Action Bar */}
      <div class="inline-bubble-editor-toolbar">
        {/* Left: media attach + mini model temporary selector */}
        <div class="inline-bubble-editor-tools-left">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            class="hidden-file-input"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            class="inline-bubble-tool-btn"
            onClick={() => fileInputRef.current?.click()}
            title={t('chat.attachFiles')}
            aria-label={t('chat.attachFiles')}
            disabled={disabled || uploading || countPending(pendingAttach).images >= MAX_IMAGES}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l7.88-7.88" />
            </svg>
          </button>

          {/* Mini Model temporary selector */}
          {models.length > 0 && (
            <div class="inline-bubble-mini-model-wrap" title={t('chat.miniModelTooltip')}>
              <select
                class="inline-bubble-mini-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel((e.target as HTMLSelectElement).value)}
                disabled={disabled}
                aria-label={t('chat.miniModelTooltip')}
              >
                {models.map((m) => (
                  <option key={m.provider} value={m.provider}>
                    {m.provider}
                  </option>
                ))}
              </select>
              <svg class="mini-model-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          )}
        </div>

        {/* Right: Cancel, Rewrite History, Rollback & Submit */}
        <div class="inline-bubble-editor-tools-right">
          {/* 取消 (Cancel) */}
          <button
            type="button"
            class="bubble-editor-btn bubble-editor-btn-cancel"
            onClick={onCancel}
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
            disabled={disabled}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <span>{t('common.cancel')}</span>
          </button>

          {/* 改写历史 (Rewrite history) */}
          <button
            type="button"
            class="bubble-editor-btn bubble-editor-btn-rewrite"
            onClick={handleRewrite}
            title={t('chat.rewriteHistory')}
            aria-label={t('chat.rewriteHistory')}
            disabled={!hasContent || disabled}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>{t('chat.rewriteHistory')}</span>
          </button>

          {/* 回溯并提交 (Rollback & submit) */}
          <button
            type="button"
            class="bubble-editor-btn bubble-editor-btn-rollback"
            onClick={handleRollback}
            title={t('chat.rollbackAndSubmit')}
            aria-label={t('chat.rollbackAndSubmit')}
            disabled={!hasContent || disabled}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            <span>{t('chat.rollbackAndSubmit')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
