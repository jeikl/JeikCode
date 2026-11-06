import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { useT } from '../../settings';
import { formatTurnElapsed } from '../../lib/turnTimer';
import type { TodoItem } from '../../lib/todos';
import type { ToolRow } from '../../lib/toolRows';
import { copyTextToClipboard } from '../../lib/clipboard';
import { showToast } from '../Toast';
import { Markdown } from '../Markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { SessionTodoPanel } from './SessionTodoPanel';
import { ToolGroupView } from './ToolViews';
import { NoticeCard } from './NoticeCard';
import { highlightText } from './highlight';
import { messageHasTools, messageText } from './messageText';
import type { CanvasRecord as Message } from '../../lib/canvas/records';
import type { MsgPart } from '../../lib/toolRows';

function assistantMessagePropsEqual(prev: any, next: any): boolean {
  return prev.msg === next.msg
    && prev.isLast === next.isLast
    && prev.busy === next.busy
    && prev.isLastInTurn === next.isLastInTurn
    && prev.isCompacting === next.isCompacting
    && prev.isActiveSearchMatch === next.isActiveSearchMatch
    && prev.timeLabel === next.timeLabel
    && prev.timeFull === next.timeFull
    && prev.liveElapsedMs === next.liveElapsedMs
    && prev.turnTotalMs === next.turnTotalMs
    && prev.search === next.search
    && prev.turnLastText === next.turnLastText
    && prev.turnAllText === next.turnAllText
    && prev.cwd === next.cwd;
}

/** Render an assistant message's ordered parts in chronological order: each
 *  text run becomes Markdown; runs of consecutive tool calls share one
 *  `.tool-list` container. This is what preserves the text→tool→text→tool
 *  interleaving (matching the TUI) instead of grouping all tools at the head. */
export const AssistantMessageView = memo(function AssistantMessageView({
  msg,
  isLast,
  busy,
  lastIdx: _lastIdx,
  isLastInTurn,
  turnLastText,
  turnAllText,
  searchRef,
  timeLabel,
  timeFull,
  liveElapsedMs,
  turnTotalMs,
  isCompacting,
  search,
  isActiveSearchMatch,
  onRegenerate,
  onDelete,
  cwd,
}: {
  msg: Message;
  isLast: boolean;
  busy: boolean;
  lastIdx: number;
  isLastInTurn: boolean;
  turnLastText: string;
  turnAllText: string;
  searchRef?: (el: HTMLElement | null) => void;
  timeLabel?: string;
  timeFull?: string;
  liveElapsedMs?: number;
  /** User-bubble → this final answer. Only set on the last assistant of the turn. */
  turnTotalMs?: number;
  isCompacting?: boolean;
  search: string;
  isActiveSearchMatch: boolean;
  onRegenerate?: () => void;
  onDelete?: () => void;
  cwd?: string;
}) {
  const t = useT();
  const text = messageText(msg);
  const trimmed = text.trim();
  const isError =
    !messageHasTools(msg) &&
    !msg.parts.some((p) => p.kind === 'reasoning') &&
    (trimmed.startsWith('[错误:') ||
      trimmed.startsWith('[连接错误:') ||
      trimmed.startsWith('[Error:') ||
      trimmed.startsWith('[Connection error:'));
  const streaming = isLast && busy;
  // 终条且简短（无工具、单行）时，去掉多余 of "时间线末端"橙点，只留一个起始点。
  const terse =
    isLast && !streaming && !messageHasTools(msg) && !text.includes('\n');
  const dotClass = isError ? 'dot-error' : 'dot-brand';
  const cls =
    'timeline-message ' +
    dotClass +
    (streaming ? ' dot-blink' : '') +
    (isLast ? ' is-last' : '') +
    (terse ? ' is-terse' : '') +
    (isActiveSearchMatch ? ' is-active-search-match' : '');
  // 本轮还在跑：画布上**所有**本轮助手行都不能被离屏优化跳过绘制。
  // 旧实现只护 `is-last`：模型在代码块闭合后继续说话时会新开一行，前一行
  // 立刻失去 is-last → `content-visibility` 回到 auto → 代码框被跳过绘制，
  // 表现就是“闭合那一瞬代码块消失，stop 后才又出现”。
  // `is-last-in-turn` 比 `is-last` 更贴近“这一轮还在输出”的语义。
  const liveCls = busy && isLastInTurn ? ' is-live' : '';

  // Copy buttons: only shown on the last assistant message in a turn.
  // 1. 复制最后正文回答 (Copy final response)
  // 2. 复制所有正文 (Copy all responses)
  const [copiedLast, setCopiedLast] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  function handleCopyLast() {
    const target = turnLastText || turnAllText;
    if (!target) return;
    void copyTextToClipboard(target).then((ok) => {
      if (ok) {
        setCopiedLast(true);
        setTimeout(() => setCopiedLast(false), 2000);
      } else {
        // Surface failure — silent .catch previously made the button look dead.
        showToast(t('copy.failed'), 'error');
      }
    });
  }

  function handleCopyAll() {
    const target = turnAllText || turnLastText;
    if (!target) return;
    void copyTextToClipboard(target).then((ok) => {
      if (ok) {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2000);
      } else {
        showToast(t('copy.failed'), 'error');
      }
    });
  }

  const copyBtn = isLastInTurn && !isError && !streaming && (turnLastText || turnAllText || onRegenerate || onDelete) ? (
    <div class="msg-actions msg-actions-left assistant-footer-actions">
      {(turnLastText || turnAllText) && (
        <>
          <button
            class={'msg-copy-btn' + (copiedLast ? ' copied' : '')}
            onClick={handleCopyLast}
            title={copiedLast ? t('copy.copiedLast') : t('copy.copyLast')}
            aria-label={copiedLast ? t('copy.copiedLast') : t('copy.copyLast')}
          >
            {copiedLast ? (
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
          <button
            class={'msg-copy-btn' + (copiedAll ? ' copied' : '')}
            onClick={handleCopyAll}
            title={copiedAll ? t('copy.copiedAll') : t('copy.copyAll')}
            aria-label={copiedAll ? t('copy.copiedAll') : t('copy.copyAll')}
          >
            {copiedAll ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="4.5" y="4.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M2.5 10.5V3A1.5 1.5 0 0 1 4 1.5h6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                <path d="M7 7.5h4M7 9.5h4M7 11.5h2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
              </svg>
            )}
          </button>
        </>
      )}
      {onRegenerate && (
        <button
          type="button"
          class="msg-action-btn btn-regenerate"
          onClick={onRegenerate}
          title={t('chat.regenerate')}
          aria-label={t('chat.regenerate')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      )}
      {onDelete && (
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
  ) : null;

  const hasContent = msg.parts.some(
    (p) => (p.kind === 'text' && p.text.trim().length > 0) || p.kind === 'tool' || p.kind === 'reasoning',
  );

  return (
    <div class={cls + liveCls} ref={searchRef}>
      {/* Error turns are pure injected text — render flat. */}
      {isError ? (
        <div class="error-message-content">
          {highlightText(text, search)}
          {streaming && !hasContent && (
            <span class="codex-shimmer-status" aria-live="polite">
              {t('chat.statusWorking')}
            </span>
          )}
        </div>
      ) : (
        <>
          {/* Segments in chronological order: text→tool→text→tool,
              matching the TUI. Consecutive tools share one tool-list. */}
          {renderAssistantParts(msg.parts, search, cwd)}
          {streaming && !hasContent && (
            <span class="codex-shimmer-status" aria-live="polite">
              {isCompacting ? t('chat.statusCompacting') : t('chat.statusWorking')}
            </span>
          )}
          {streaming && hasContent && isCompacting && (
            <span class="codex-shimmer-status" aria-live="polite" style={{ display: 'block', marginTop: '6px' }}>
              {t('chat.statusCompacting')}
            </span>
          )}
        </>
      )}
      <div class="msg-footer-row assistant-footer-row">
        {/* 只在本轮最后一条助手消息上显示时刻和用时。中间的工具/思考/分段正文不要时间。 */}
        {isLastInTurn && timeLabel && !streaming && !isError && (
          <span class="msg-time" title={timeFull}>
            <span class="msg-clock">{timeLabel}</span>
            {turnTotalMs != null && (
              <span class="msg-turn-elapsed">
                {t('chat.turnElapsedDone', { time: formatTurnElapsed(turnTotalMs) })}
              </span>
            )}
          </span>
        )}
        {isLastInTurn && !timeLabel && !streaming && turnTotalMs != null && !isError && (
          <span class="msg-time">
            <span class="msg-turn-elapsed">
              {t('chat.turnElapsedDone', { time: formatTurnElapsed(turnTotalMs) })}
            </span>
          </span>
        )}
        {isLastInTurn && streaming && liveElapsedMs != null && (
          <span class="msg-time is-live">
            <span class="msg-turn-elapsed">
              {t('chat.turnElapsedLive', { time: formatTurnElapsed(liveElapsedMs) })}
            </span>
          </span>
        )}
        {msg.readOnly === true && (
          <span class="msg-readonly-badge" title={t('chat.readOnlyArchiveHint')}>
            {t('chat.readOnlyArchive')}
          </span>
        )}
        {copyBtn}
      </div>
    </div>
  );
}, assistantMessagePropsEqual);

function renderAssistantParts(parts: MsgPart[], search: string, cwd?: string): VNode[] {
  const out: VNode[] = [];
  let trailingTodos: { kind: 'todo_list'; items: TodoItem[] } | null = null;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.kind === 'todo_list') {
      trailingTodos = p;
      i++;
      continue;
    }
    if (p.kind === 'tool') {
      const groupKey = i;
      const tools: ToolRow[] = [];
      while (i < parts.length) {
        const q = parts[i];
        if (q.kind === 'todo_list') {
          trailingTodos = q;
          i++;
          continue;
        }
        if (q.kind !== 'tool') break;
        tools.push(q.tool);
        i++;
      }
      if (tools.length > 0) {
        out.push(
          <ToolGroupView key={`tg-${groupKey}`} tools={tools} search={search} />
        );
      }
    } else if (p.kind === 'reasoning') {
      out.push(<ReasoningBlock key={`rs-${i}`} text={p.text} search={search} />);
      i++;
    } else if (p.kind === 'notice') {
      out.push(
        <NoticeCard key={`nt-${i}`} text={p.text} search={search} />,
      );
      i++;
    } else if (p.kind === 'rate_limited') {
      out.push(
        <div class="rate-limited-notice" key={`rl-${i}`}>
          {highlightText(p.text, search)}
        </div>,
      );
      i++;
    } else if (p.kind === 'text') {
      if (p.text) out.push(<Markdown key={`tx-${i}`} content={p.text} search={search} cwd={cwd} targetContext="chat" />);
      i++;
    } else {
      i++;
    }
  }

  // 待办清单是整轮任务的最终成果核对单，始终且必然沉淀在助手回复的最末尾（所有思考、工具卡片、最终文本的最下方）！
  if (trailingTodos && trailingTodos.items.length > 0) {
    out.push(
      <SessionTodoPanel key="td-trailing" items={trailingTodos.items} embedded />,
    );
  }

  return out;
}

/** Collapsible thinking / reasoning block (chain-of-thought stream). */
