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
import { collectClipboardFiles } from '../lib/clipboard';

export interface InlineBubbleEditorProps {
  initialText: string;
  initialImages?: ImageData[];
  models: ModelInfo[];
  currentModel: string;
  onSaveRewrite: (text: string, images: ImageData[]) => void;
  onRollbackSubmit: (text: string, images: ImageData[], tempModel?: string) => void;
  onCancel: () => void;
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

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea to fit content up to 260px
  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 260)}px`;
    }
  };

  useEffect(() => {
    adjustHeight();
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
      textareaRef.current.selectionEnd = textareaRef.current.value.length;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text]);

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
        }
      }
    }
    setUploading(false);
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
    if (!e.clipboardData) return;
    const files = collectClipboardFiles(e.clipboardData);
    if (files.length > 0) {
      const imageFiles = files.filter(isImageFile);
      if (imageFiles.length > 0) {
        e.preventDefault();
        void handleAddFiles(imageFiles);
      }
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleRollback();
            }
          }}
          placeholder={t('chat.editPlaceholder')}
          rows={1}
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
