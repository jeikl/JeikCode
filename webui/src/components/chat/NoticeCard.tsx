import type { NoticeKind, NoticeSeverity, NoticeStatus } from '../../api';
import { highlightText } from './highlight';

export interface NoticeCardProps {
  text: string;
  search?: string;
  className?: string;
  id?: string;
  kind?: NoticeKind;
  severity?: NoticeSeverity;
  status?: NoticeStatus;
  searchRef?: (el: HTMLElement | null) => void;
}

/**
 * 现代高质感系统/命令通知卡片（Notice Card）。
 * 优先按后端下发的结构化 `kind` / `severity` / `status` 决定配色与图标，
 * 仅在兼容旧版命令输出无结构化元数据时回退到轻量状态样式。
 */
export function NoticeCard({
  text,
  search = '',
  className = '',
  id,
  kind,
  severity,
  status,
  searchRef,
}: NoticeCardProps) {
  const isCompactDone = kind === 'compaction';
  const isError = severity === 'error' || kind === 'error';
  const isWarning =
    !isError &&
    (severity === 'warning' ||
      kind === 'warning' ||
      kind === 'retry' ||
      kind === 'timeout' ||
      kind === 'rate_limit' ||
      kind === 'truncation');
  const isActive = status === 'active';
  const isSuccess = isCompactDone;

  const variantClass = isError
    ? 'is-error'
    : isWarning
      ? 'is-warning'
      : isCompactDone
        ? 'is-compact'
        : isSuccess
          ? 'is-success'
          : 'is-info';
  const activeClass = isActive ? 'is-active' : '';

  const sysCls = `msg-notice-card ${variantClass} ${activeClass} ${className}`.trim();

  return (
    <div class={sysCls} id={id} ref={searchRef} role="note">
      <span class="msg-notice-icon-wrapper" aria-hidden="true">
        {isCompactDone ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="msg-notice-svg">
            <path
              d="M4 2.5h8M4 13.5h8M8 5.5v5M5.5 8.5L8 11l2.5-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : isError || isWarning ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="msg-notice-svg">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 5v3.5M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ) : isSuccess ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="msg-notice-svg">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M5.5 8.2l1.8 1.8 3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="msg-notice-svg">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 7v4.5M8 4.75v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <div class="msg-notice-content">
        {highlightText(text, search)}
      </div>
    </div>
  );
}
