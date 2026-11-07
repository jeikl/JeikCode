import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useT } from '../../settings';
import { toolMatchesSearch } from '../../lib/canvasSearch';
import { copyTextToClipboard } from '../../lib/clipboard';
import {
  computeToolDiffStats,
  formatToolDetail,
  formatToolPayload,
  isViewOnlyShellDiff,
  isWritingTool,
  jsonArgString,
  prettyToolText,
  resolveToolDiffPreview,
  toolCategory,
  toolGlyph,
  toolRendersAsDiff,
  type DiffPreviewLine,
} from '../../lib/toolDisplay';
import { subtaskCounts, type SubtaskItem } from '../../lib/subtasks';
import type { ToolRow } from '../../lib/toolRows';
import { showToast } from '../Toast';
import { highlightText } from './highlight';
import { DiffStatBadge, ToolArgPreview, ToolStatusIcon } from './ToolBits';
import { displayToolName } from './toolName';

export function ToolGroupView({ tools, search }: { tools: ToolRow[]; search: string }) {
  const t = useT();
  const [batchExpanded, setBatchExpanded] = useState<boolean | null>(null);
  const [batchVersion, setBatchVersion] = useState(0);

  const doneCount = tools.filter((tool) => tool.status === 'done').length;
  // incomplete = 结果未知（工具被中断 / 结果帧丢失），既不是成功也不是失败。
  const errorCount = tools.filter((tool) => tool.status === 'error').length;
  const incompleteCount = tools.filter((tool) => tool.status === 'incomplete').length;
  const runningCount = tools.filter((tool) => tool.status === 'pending' || tool.status === 'waiting_approval').length;

  // 关键过滤：只有真正执行了写/编辑/全局替换类工具或命令时，才计入“修改文件数”；git diff 等只读检查绝不计入已修改文件数！
  const writingTools = tools.filter((tool) => isWritingTool(tool.name, tool.args));
  const hasWritingTools = writingTools.length > 0;
  const allDiffStats = writingTools.map((tool) => computeToolDiffStats(tool.name, tool.output, tool.args));
  const totalAdditions = allDiffStats.reduce((sum, s) => sum + (s?.additions ?? 0), 0);
  const totalDeletions = allDiffStats.reduce((sum, s) => sum + (s?.deletions ?? 0), 0);
  const hasDiffStats = totalAdditions > 0 || totalDeletions > 0;

  return (
    <div class="tool-list">
      {tools.length > 1 && (
        <div class="tool-group-header">
          <span class="tool-group-summary">
            <span class="tool-group-icon" aria-hidden="true">⚡</span>
            <span>
              {hasWritingTools && writingTools.length === tools.length
                ? t('tool.filesChanged', { count: String(writingTools.length) })
                : t('tool.groupSummary', {
                    total: String(tools.length),
                    done: String(doneCount),
                  })}
            </span>
            {hasDiffStats && (
              <DiffStatBadge additions={totalAdditions} deletions={totalDeletions} />
            )}
            {runningCount > 0 && (
              <span class="tool-group-badge running">
                {runningCount} {t('tool.running')}
              </span>
            )}
            {errorCount > 0 && (
              <span class="tool-group-badge error">
                {errorCount} {t('tool.failed')}
              </span>
            )}
            {incompleteCount > 0 && (
              <span class="tool-group-badge warning">
                {incompleteCount} {t('tool.incomplete')}
              </span>
            )}
          </span>
          <div class="tool-group-actions">
            <button
              type="button"
              class="tool-group-btn"
              onClick={() => {
                setBatchExpanded(true);
                setBatchVersion((v) => v + 1);
              }}
            >
              {t('tool.expandAll')}
            </button>
            <span class="tool-group-sep">·</span>
            <button
              type="button"
              class="tool-group-btn"
              onClick={() => {
                setBatchExpanded(false);
                setBatchVersion((v) => v + 1);
              }}
            >
              {t('tool.collapseAll')}
            </button>
          </div>
        </div>
      )}
      {tools.map((tool) => (
        <ToolRowView
          key={tool.id}
          tool={tool}
          search={search}
          forceExpanded={batchExpanded}
          forceVersion={batchVersion}
        />
      ))}
    </div>
  );
}

export function ToolRowView({
  tool,
  search,
  forceExpanded = null,
  forceVersion = 0,
}: {
  tool: ToolRow;
  search: string;
  forceExpanded?: boolean | null;
  forceVersion?: number;
}) {
  const t = useT();
  const userCollapsedRef = useRef(false);
  const userManuallyExpandedRef = useRef(false);
  const outputRef = useRef<HTMLPreElement>(null);
  /** 输出窗自己也有滚动条：用户上滑阅读时必须停止自动贴底，否则每个 chunk
   *  都会把他弹回底部，和外层时间线一起形成逐帧抖动。 */
  const outputFollowRef = useRef(true);
  const hasSubtasks = !!(tool.subtasks && tool.subtasks.length > 0);
  const category = toolCategory(tool.name);
  const glyph = toolGlyph(tool.name);
  // 关键过滤：仅当工具实际写入文件（isWritingTool）、属于纯展示的合法 shell diff（如 git diff），
  // 或作为专用差异渲染工具（如 edit/write）时才计算变更指标；常规只读终端命令绝不显示 +N -M 徽章。
  const shouldComputeDiff =
    category !== 'terminal'
      ? toolRendersAsDiff(tool.name) ||
        tool.name === 'write' ||
        tool.name === 'write_file' ||
        tool.name === 'create_file'
      : isWritingTool(tool.name, tool.args) ||
        isViewOnlyShellDiff(tool.name, tool.output, tool.args);
  const diffStats = shouldComputeDiff
    ? computeToolDiffStats(tool.name, tool.output, tool.args)
    : null;

  // Default: collapsed! Only auto-expand if status is error/incomplete so problems are immediately visible.
  const [expanded, setExpanded] = useState(
    () => tool.status === 'error' || tool.status === 'incomplete',
  );

  // 搜索必须能“找到”命中：折叠行里的参数/输出/进度默认不在 DOM 上，
  // 只统计不展示就是用户说的“有些根本找不到”。命中即展开（同 Chrome 对
  // <details> 的行为）。
  const searchHit = toolMatchesSearch(tool, search);
  useEffect(() => {
    if (searchHit) setExpanded(true);
  }, [searchHit, search]);

  // Batch expand/collapse support from parent ToolGroupView
  const prevBatchVersionRef = useRef(forceVersion);
  useEffect(() => {
    if (forceVersion !== prevBatchVersionRef.current) {
      prevBatchVersionRef.current = forceVersion;
      if (forceExpanded !== null) {
        setExpanded(forceExpanded);
        userCollapsedRef.current = !forceExpanded;
        userManuallyExpandedRef.current = forceExpanded;
      }
    }
  }, [forceExpanded, forceVersion]);

  // When a tool transitions to error/incomplete during live execution,
  // auto-expand it to alert the user (unless they explicitly collapsed it).
  useEffect(() => {
    if (userCollapsedRef.current) return;
    if (tool.status === 'error' || tool.status === 'incomplete') {
      setExpanded(true);
    }
  }, [tool.status]);

  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const onScroll = () => {
      outputFollowRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !tool.output || !outputRef.current) return;
    if (!outputFollowRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [expanded, tool.output]);

  let annotation: { cls: string; label: string } | null = null;
  if (tool.status === 'waiting_approval') {
    annotation = { cls: 'waiting', label: t('tool.waiting') };
  } else if (tool.status === 'pending') {
    annotation = { cls: 'pending', label: t('tool.running') };
  } else if (tool.status === 'done') {
    annotation = { cls: 'success', label: t('tool.done') };
  } else if (tool.status === 'error') {
    annotation = { cls: 'error', label: t('tool.failed') };
  } else if (tool.status === 'incomplete') {
    annotation = { cls: 'warning', label: t('tool.incomplete') };
  }

  const hasDetail = hasSubtasks ? false : !!(tool.args || tool.output);
  const showFlatProgress =
    tool.status === 'pending' && !!tool.progress && !hasSubtasks;

  const counts = hasSubtasks ? subtaskCounts(tool.subtasks!) : null;
  const headerDetail = counts
    ? t('subtask.summary', {
        done: String(counts.completed),
        total: String(counts.total),
        running: String(counts.running),
        pending: String(counts.pending),
        failed: String(counts.failed),
      })
    : formatToolDetail(tool.name, tool.args);

  return (
    <div class={'tool-body kind-' + category + ' notranslate'} translate={false}>
      <div
        class="tool-header notranslate"
        translate={false}
        onClick={() => {
          if (!hasDetail) return;
          setExpanded((e) => {
            const next = !e;
            userCollapsedRef.current = !next;
            userManuallyExpandedRef.current = next;
            return next;
          });
        }}
      >
        <span class="tool-glyph" aria-hidden="true">{glyph}</span>
        <span class="tool-name notranslate" translate={false}>{displayToolName(tool.name)}</span>
        <ToolArgPreview text={headerDetail} search={search} />
        {diffStats && (
          <DiffStatBadge additions={diffStats.additions} deletions={diffStats.deletions} />
        )}
        {annotation && (
          <span class={'tool-annotation ' + annotation.cls}>
            <ToolStatusIcon cls={annotation.cls} />
            {annotation.label}
          </span>
        )}
        {hasDetail && (
          <span class={'tool-chevron' + (expanded ? ' expanded' : '')}>▾</span>
        )}
      </div>
      {hasSubtasks && <SubtaskPanel items={tool.subtasks!} search={search} />}
      {showFlatProgress && (
        <div class="tool-progress" title={tool.progress}>{highlightText(tool.progress || '', search)}</div>
      )}
      {expanded && hasDetail && (
        <ToolExpandedBody tool={tool} outputRef={outputRef} search={search} />
      )}
    </div>
  );
}

export function CopyableCodeBlock({
  text,
  lang,
  live,
  outputRef,
  search,
}: {
  text: string;
  lang?: string;
  live?: boolean;
  outputRef?: { current: HTMLPreElement | null };
  /** 会话内搜索关键词：工具的输入/输出也必须能高亮与定位。 */
  search?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <div class="code-block-wrapper tool-code-block">
      <pre ref={outputRef} class={live ? 'is-live' : undefined}>
        <code class={lang ? `language-${lang}` : undefined}>{highlightText(text, search ?? '')}</code>
      </pre>
      <button
        type="button"
        class="copy-button"
        onClick={(e) => {
          e.stopPropagation();
          void copyTextToClipboard(text).then((ok) => {
            if (!ok) {
              showToast(t('copy.failed'), 'error');
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? t('copy.copied') : t('copy.copy')}
      </button>
    </div>
  );
}

export function DiffBody({
  lines,
  raw,
  variant = 'applied',
  caption,
  search,
}: {
  lines: DiffPreviewLine[];
  raw?: string;
  variant?: 'applied' | 'planned';
  caption?: string;
  search?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div class={'code-block-wrapper tool-code-block tool-diff-block is-' + variant}>
      {caption ? <div class="tool-diff-caption">{caption}</div> : null}
      <pre class="tool-diff-body">
        {lines.map((line, i) => {
          if (line.kind === 'meta') {
            return (
              <span key={i} class="diff-line diff-meta">
                <span class="diff-ln" />
                <span class="diff-content">
                  <span class="diff-code">{highlightText(line.text || ' ', search ?? '')}</span>
                </span>
              </span>
            );
          }
          const ln = line.kind === 'del' ? line.oldLine : (line.newLine ?? line.oldLine);
          const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
          const body = line.text.replace(/^[-+ ]/, '');
          return (
            <span key={i} class={'diff-line diff-' + line.kind}>
              <span class="diff-ln">{ln != null ? ln : ''}</span>
              <span class="diff-content">
                <span class="diff-sign">{sign}</span>
                <span class="diff-code">{highlightText(body || ' ', search ?? '')}</span>
              </span>
            </span>
          );
        })}
      </pre>
      {raw ? (
        <button
          type="button"
          class="copy-button"
          onClick={(e) => {
            e.stopPropagation();
            void copyTextToClipboard(raw).then((ok) => {
              if (!ok) {
                showToast(t('copy.failed'), 'error');
                return;
              }
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? t('copy.copied') : t('copy.copy')}
        </button>
      ) : null}
    </div>
  );
}

export function formatTerminalOutput(raw?: string): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.includes('#< CLIXML')) {
    const lines = text.split('\n');
    const filtered: string[] = [];
    let inError = false;
    let errorBuf = '';
    for (const line of lines) {
      if (line.startsWith('#< CLIXML')) continue;
      if (line.includes('<S S="Error">')) {
        inError = true;
        const start = line.indexOf('<S S="Error">') + '<S S="Error">'.length;
        const remainder = line.slice(start);
        const end = remainder.indexOf('</S>');
        if (end !== -1) {
          errorBuf += remainder.slice(0, end);
          inError = false;
        } else {
          errorBuf += remainder;
        }
        continue;
      }
      if (inError) {
        const end = line.indexOf('</S>');
        if (end !== -1) {
          errorBuf += line.slice(0, end);
          inError = false;
        } else {
          errorBuf += line;
        }
        continue;
      }
      if (line.trim().startsWith('<') && line.trim().endsWith('>')) continue;
      if (line.trim()) filtered.push(line);
    }
    if (errorBuf) {
      const cleaned = errorBuf
        .replace(/_x000D__x000A_/g, '\n')
        .replace(/_x000D_/g, '\n')
        .replace(/_x000A_/g, '\n')
        .replace(/_x0020_/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
      if (cleaned) filtered.push(cleaned);
    }
    text = filtered.join('\n');
  }
  return text;
}

export function ToolTerminalBody({
  tool,
  outputRef,
  hideOutput = false,
  search,
}: {
  tool: ToolRow;
  outputRef: { current: HTMLPreElement | null };
  hideOutput?: boolean;
  search?: string;
}) {
  const t = useT();
  const live = tool.status === 'pending';
  const cmd = jsonArgString(tool.args, 'command') || tool.args;
  const summary = jsonArgString(tool.args, 'summary').trim();
  const [copied, setCopied] = useState(false);
  const terminalOut = useMemo(() => formatTerminalOutput(tool.output), [tool.output]);

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    const contentToCopy = terminalOut || cmd || '';
    if (!contentToCopy) return;
    void copyTextToClipboard(contentToCopy).then((ok) => {
      if (!ok) {
        showToast(t('copy.failed'), 'error');
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div class={'tool-terminal' + (live ? ' is-live' : '')}>
      {summary && <div class="tool-terminal-cmd">{highlightText(summary, search ?? '')}</div>}
      {cmd && <div class="tool-terminal-cmd">$ {highlightText(cmd, search ?? '')}</div>}
      {terminalOut && !hideOutput ? (
        <div class="code-block-wrapper tool-code-block">
          <pre ref={outputRef} class={'tool-terminal-out' + (live ? ' is-live' : '')}>
            <code>{highlightText(terminalOut, search ?? '')}</code>
          </pre>
          <button
            type="button"
            class="copy-button"
            onClick={handleCopy}
            title={copied ? t('copy.copied') : t('copy.copy')}
            aria-label={copied ? t('copy.copied') : t('copy.copy')}
          >
            {copied ? t('copy.copied') : t('copy.copy')}
          </button>
        </div>
      ) : live ? (
        <div class="tool-terminal-out is-empty is-live"></div>
      ) : null}
    </div>
  );
}

export function ToolExpandedBody({
  tool,
  outputRef,
  search,
}: {
  tool: ToolRow;
  outputRef: { current: HTMLPreElement | null };
  search: string;
}) {
  const t = useT();
  const live = tool.status === 'pending';
  const category = toolCategory(tool.name);

  // 1. Bash / terminal tool: render a unified terminal console ($ command + output).
  //    A read-only `git diff` reuses the edit red/green panel for display only.
  if (category === 'terminal') {
    const shellDiff = isViewOnlyShellDiff(tool.name, tool.output, tool.args)
      ? resolveToolDiffPreview(tool.name, tool.output, tool.args)
      : null;
    if (shellDiff) {
      return (
        <div class="tool-terminal-diff">
          <ToolTerminalBody tool={tool} outputRef={outputRef} hideOutput search={search} />
          <DiffBody
            lines={shellDiff.lines}
            raw={shellDiff.raw}
            variant="applied"
            caption={t('tool.diffView')}
            search={search}
          />
        </div>
      );
    }
    return <ToolTerminalBody tool={tool} outputRef={outputRef} search={search} />;
  }

  const argsPretty = tool.args ? prettyToolText(tool.args) : null;
  const outputPretty = tool.output ? prettyToolText(tool.output) : null;
  const diffPreview = resolveToolDiffPreview(tool.name, tool.output, tool.args, tool.status);
  const isDone = tool.status === 'done';
  const diffIsPlanned = !isDone && diffPreview?.source === 'args';
  const isDiagnostic = !isDone && diffPreview?.source === 'diagnostic';
  const isFailed = tool.status === 'error';
  const diffCaption = isDiagnostic
    ? t('tool.diffDiagnostic')
    : isFailed
    ? t('tool.diffFailed')
    : diffIsPlanned
    ? t('tool.diffPlanned')
    : t('tool.diffApplied');

  return (
    <div class={'tool-cli' + (live ? ' is-live' : '')}>
      {argsPretty && argsPretty.text && (
        <div class="tool-cli-row">
          <div class="tool-cli-label">{t('tool.args')}</div>
          <CopyableCodeBlock text={argsPretty.text} lang={argsPretty.lang} search={search} />
        </div>
      )}
      {tool.output && (
        <div class="tool-cli-row">
          <div class="tool-cli-label">{t('tool.output')}</div>
          {diffPreview ? (
            <>
              {(diffIsPlanned || isDiagnostic || isFailed) && tool.output.trim() ? (
                <pre class="tool-edit-error">{highlightText(tool.output.trim(), search)}</pre>
              ) : null}
              <DiffBody
                lines={diffPreview.lines}
                raw={diffPreview.raw}
                variant={diffIsPlanned || isDiagnostic || isFailed ? 'planned' : 'applied'}
                caption={diffCaption}
                search={search}
              />
            </>
          ) : (
            <CopyableCodeBlock
              text={outputPretty?.text || tool.output}
              lang={outputPretty?.lang}
              live={live}
              outputRef={outputRef}
              search={search}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Parallel sub-agent rows — TUI `SubtaskProgress` panel parity. */
export function SubtaskPanel({ items, search = '' }: { items: SubtaskItem[]; search?: string }) {
  const t = useT();
  const { completed, running, pending, failed, total } = subtaskCounts(items);
  // Prefer showing active/failed rows; completed ones stay visible so the
  // panel still reads as a full fan-out (unlike TUI footer which hides done).
  return (
    <div class="subtask-panel">
      <div class="subtask-panel-header">
        {t('subtask.summary', {
          done: String(completed),
          total: String(total),
          running: String(running),
          pending: String(pending),
          failed: String(failed),
        })}
      </div>
      <div class="subtask-list">
        {items.map((item) => (
          <div class={'subtask-row status-' + item.status} key={item.label}>
            <span class="subtask-status-dot" aria-hidden="true">
              {item.status === 'completed'
                ? '✓'
                : item.status === 'failed'
                  ? '✗'
                  : item.status === 'running'
                    ? '●'
                    : '○'}
            </span>
            <span class="subtask-label">{highlightText(item.label, search)}</span>
            {item.model && <span class="subtask-model">{item.model}</span>}
            <span class="subtask-desc" title={item.description || item.activity}>
              {highlightText(item.activity || item.description || '—', search)}
            </span>
            {item.outputTokens > 0 && (
              <span class="subtask-tokens">↑ {item.outputTokens}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
