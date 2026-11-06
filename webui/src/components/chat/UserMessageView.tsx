import { useState } from 'preact/hooks';
import type { CanvasRecord as Message } from '../../lib/canvas/records';
import type { ImageData, ModelInfo } from '../../api';
import { InlineBubbleEditor } from '../InlineBubbleEditor';
import { Markdown } from '../Markdown';
import { MsgImage } from './ImageLightbox';
import { highlightText } from './highlight';
import { messageText } from './messageText';
import { showToast } from '../Toast';
import { useT } from '../../settings';
import { buildCopyHtml, copyTextAndImages } from '../../lib/clipboard';

const SKILL_COLLAPSE_MIN = 400;

function detectSkillContent(text: string): string | null {
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed.startsWith('#') || text.length < SKILL_COLLAPSE_MIN) return null;
  const firstLine = trimmed.split('\n', 1)[0];
  const title = firstLine.replace(/^#{1,6}\s*/, '').trim();
  return title || null;
}

async function copyUserMessage(text: string, images?: ImageData[]): Promise<boolean> {
  return copyTextAndImages(text, images);
}

export function UserMessageView({
  msg,
  anchorId,
  turnNavIdx,
  searchRef,
  timeLabel,
  timeFull,
  search,
  isActiveSearchMatch,
  isEditing,
  draftText,
  draftImages,
  draftModel,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveRewrite,
  onRollbackSubmit,
  onDelete,
  models,
  currentModel,
  disabled,
  cwd,
}: {
  msg: Message;
  anchorId?: string;
  turnNavIdx?: number;
  searchRef?: (el: HTMLElement | null) => void;
  timeLabel?: string;
  timeFull?: string;
  search: string;
  isActiveSearchMatch: boolean;
  isEditing?: boolean;
  draftText?: string;
  draftImages?: ImageData[];
  draftModel?: string;
  onDraftChange?: (text: string, images: ImageData[], selectedModel?: string) => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onSaveRewrite?: (text: string, images: ImageData[]) => void;
  onRollbackSubmit?: (text: string, images: ImageData[], tempModel?: string) => void;
  onDelete?: () => void;
  models?: ModelInfo[];
  currentModel?: string;
  disabled?: boolean;
  cwd?: string;
}) {
  const t = useT();
  // 技能/文档型消息默认折叠为一行徽章，点击展开查看原文。
  const text = messageText(msg);
  const skillTitle = detectSkillContent(text);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void copyUserMessage(text, msg.images).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        showToast(t('copy.failed'), 'error');
      }
    });
  }

  // 气泡内全选文本快捷键/右键复制时，连同多图附件一块打包入剪贴板
  function handleBubbleCopy(e: ClipboardEvent) {
    if (!msg.images || msg.images.length === 0) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const selText = sel.toString().trim();
    const fullText = text.trim();
    if (selText && (selText === fullText || selText.length >= fullText.length)) {
      e.preventDefault();
      const dataUrls = msg.images.map((img) => `data:${img.media_type};base64,${img.data}`);
      const html = buildCopyHtml(dataUrls, text);
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', html);
      }
      void copyUserMessage(text, msg.images);
      showToast(t('copy.copiedWithMedia'), 'info');
    }
  }

  const images = msg.images && msg.images.length > 0 && (
    <div class="msg-images">
      {msg.images.map((img, i) => (
        <MsgImage key={i} img={img} />
      ))}
    </div>
  );

  const copyBtn = (
    <button
      class={'msg-copy-btn' + (copied ? ' copied' : '')}
      onClick={handleCopy}
      title={copied ? t('copy.copied') : t('copy.copy')}
      aria-label={copied ? t('copy.copied') : t('copy.copy')}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.2" />
          <path d="M2.5 10.5V3.5A1.5 1.5 0 0 1 4 2h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      )}
    </button>
  );

  const wrapperClass =
    'user-message-wrapper' +
    (isActiveSearchMatch ? ' is-active-search-match' : '') +
    (msg.pendingInput ? ' pending-input' : '');

  if (isEditing && onSaveRewrite && onRollbackSubmit && onCancelEdit) {
    return (
      <div class={wrapperClass + ' is-editing'} id={anchorId} data-turn-nav={anchorId || undefined} data-turn-nav-idx={turnNavIdx} data-message-id={msg.id || undefined} data-client-input-id={msg.clientInputId || undefined} ref={searchRef}>
        <InlineBubbleEditor
          initialText={draftText ?? text}
          initialImages={draftImages ?? msg.images}
          models={models ?? []}
          currentModel={draftModel ?? currentModel ?? ''}
          onSaveRewrite={onSaveRewrite}
          onRollbackSubmit={onRollbackSubmit}
          onCancel={onCancelEdit}
          onDraftChange={onDraftChange}
          disabled={disabled}
        />
      </div>
    );
  }

  if (skillTitle && !expanded) {
    return (
      <div class={wrapperClass} id={anchorId} data-turn-nav={anchorId || undefined} data-turn-nav-idx={turnNavIdx} data-message-id={msg.id || undefined} data-client-input-id={msg.clientInputId || undefined} ref={searchRef}>
        {images}
        <button
          class="skill-badge"
          onClick={() => setExpanded(true)}
          title={t('chat.skillExpand')}
        >
          <span class="skill-badge-icon" aria-hidden="true">⚡</span>
          <span class="skill-badge-label notranslate" translate={false}>{skillTitle}</span>
          <span class="skill-badge-hint">{t('chat.skillExpand')}</span>
        </button>
        {timeLabel && <div class="msg-time msg-time-user" title={timeFull}>{timeLabel}</div>}
      </div>
    );
  }

  return (
    <div class={wrapperClass} id={anchorId} data-turn-nav={anchorId || undefined} data-turn-nav-idx={turnNavIdx} data-message-id={msg.id || undefined} data-client-input-id={msg.clientInputId || undefined} ref={searchRef}>
      <div
        class={'user-message-bubble' + (skillTitle ? ' is-markdown' : '')}
        onCopy={handleBubbleCopy}
      >
        {images}
        {skillTitle && (
          <button class="skill-collapse" onClick={() => setExpanded(false)}>
            {t('chat.skillCollapse')}
          </button>
        )}
        {/* 技能/文档型内容本就是 markdown（注入的 SKILL.md），渲染它；
            普通用户消息保持逐字纯文本（不把用户输入当 markdown 解析）。 */}
        {skillTitle ? <Markdown content={text} search={search} cwd={cwd} targetContext="chat" /> : highlightText(text, search)}
      </div>
      <div class="msg-footer-row user-footer-row">
        {timeLabel && <span class="msg-time msg-time-user" title={timeFull}>{timeLabel}</span>}
        {msg.readOnly === true && (
          <span class="msg-readonly-badge" title={t('chat.readOnlyArchiveHint')}>
            {t('chat.readOnlyArchive')}
          </span>
        )}
        <div class="user-footer-actions">
          {copyBtn}
          {onStartEdit && !disabled && (
            <button
              type="button"
              class="msg-action-btn btn-edit"
              onClick={onStartEdit}
              title={t('chat.editMessage')}
              aria-label={t('chat.editMessage')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
          {onDelete && !disabled && (
            <button
              type="button"
              class="msg-action-btn btn-delete"
              onClick={onDelete}
              title={t('chat.deleteMessage')}
              aria-label={t('chat.deleteMessage')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Status glyph: a check when done, a cross on error, otherwise a spinner that
// animates while the call is pending / awaiting approval.
