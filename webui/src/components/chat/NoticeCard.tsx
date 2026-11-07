import { highlightText } from './highlight';

export interface NoticeCardProps {
  text: string;
  search?: string;
  className?: string;
  id?: string;
  searchRef?: (el: HTMLElement | null) => void;
}

/** 压缩完成/无需压缩的提示文案（覆盖全部 UI 语言）。
 *  导出给画布去重与边界标记渲染使用：同一次压缩的本地兜底提示与
 *  服务端持久标记不能叠两份。 */
export function isCompactionDoneNotice(text: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  return [
    '已压缩',
    '已壓縮',
    '无需压缩',
    '無需壓縮',
    'Compacted',
    'Nothing to compact',
    'Đã thu gọn',
    'không có gì để thu gọn',
    '圧縮済み',
    '圧縮不要',
    '압축됨',
    '압축할 필요',
    'Сжато',
    'нечего сжимать',
    'Komprimiert',
    'nichts zu komprimieren',
    'Compacté',
    'rien à compacter',
    'Compactado',
    'nada que compactar',
    'تم الضغط',
    'لا شيء لضغطه',
  ].some((marker) => text.includes(marker));
}

/**
 * 现代高质感系统/命令通知卡片（Notice Card）。
 * 兼容深色/浅色主题，采用简约微卡片与毛玻璃柔和微投影质感，
 * 彻底替换原先简陋的单色等宽框框。
 */
export function NoticeCard({
  text,
  search = '',
  className = '',
  id,
  searchRef,
}: NoticeCardProps) {
  const isCompactDone = isCompactionDoneNotice(text);
  const isErrorOrWarn =
    text.includes('失败') ||
    text.includes('Error') ||
    text.includes('failed') ||
    text.includes('未找到') ||
    text.includes('Blocked') ||
    text.includes('connError');
  const isSuccess =
    isCompactDone ||
    text.includes('成功') ||
    text.includes('已保存') ||
    text.includes('已切换') ||
    text.includes('Done') ||
    text.includes('已清空');

  const variantClass = isErrorOrWarn
    ? 'is-warning'
    : isCompactDone
      ? 'is-compact'
      : isSuccess
        ? 'is-success'
        : 'is-info';

  const sysCls = `msg-notice-card ${variantClass} ${className}`.trim();

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
        ) : isErrorOrWarn ? (
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
