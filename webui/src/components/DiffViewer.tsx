import { useMemo } from 'preact/hooks';
import { pairDiffLines, parseUnifiedDiff, type ParsedDiffLine } from '../lib/diff';

interface DiffViewerProps {
  diffText: string;
  filePath: string;
  commitHash: string;
  commitMessage: string;
}

export function DiffViewer({ diffText, filePath, commitHash, commitMessage }: DiffViewerProps) {
  const rows = useMemo(() => pairDiffLines(parseUnifiedDiff(diffText)), [diffText]);

  // 清理可能包含旧格式冗余文件名的 commitMessage (如 "Working Tree: xxx")
  const displayMsg = useMemo(() => {
    if (!commitMessage) return '';
    const prefixMatch = commitMessage.match(/^(Working Tree|Staged Changes|工作区改动|暂存改动):\s*(.+)$/i);
    if (prefixMatch && prefixMatch[1]) {
      return prefixMatch[1];
    }
    return commitMessage;
  }, [commitMessage]);

  return (
    <div class="diff-viewer-root">
      <div class="diff-viewer-toolbar">
        <div class="diff-toolbar-meta">
          <span class="diff-hash-pill">{commitHash.slice(0, 8)}</span>
          <span class="diff-meta-msg" title={displayMsg}>{displayMsg}</span>
          <span class="diff-meta-divider">·</span>
          <span class="diff-meta-path" title={filePath}>{filePath}</span>
        </div>
      </div>

      <div class="diff-code-table-wrap">
        <table class="diff-code-table" style="table-layout: fixed; min-width: 700px">
          <colgroup>
            <col style="width: 48px" /><col style="width: 16px" /><col style="width: calc(50% - 64px)" />
            <col style="width: 48px" /><col style="width: 16px" /><col style="width: calc(50% - 64px)" />
          </colgroup>
          <tbody>
            {rows.map((row, idx) => {
              if (row.full) {
                const isHunk = row.full.type === 'hunk';
                return (
                  <tr key={idx} class={`diff-row ${isHunk ? 'diff-row-hunk' : 'diff-row-header'}`}>
                    <td colspan={6} class={`diff-line-content ${isHunk ? 'hunk-header' : 'file-header'}`}>{row.full.text}</td>
                  </tr>
                );
              }
              const side = (line: ParsedDiffLine | undefined, old: boolean) => {
                const color = line?.type === 'del' ? 'diff-row-del' : line?.type === 'add' ? 'diff-row-add' : '';
                return [
                  <td class={`diff-gutter-num ${color}`}>{old ? line?.oldLineNumber : line?.newLineNumber}</td>,
                  <td class={`diff-gutter-marker ${color}`}>{line?.type === 'del' ? '-' : line?.type === 'add' ? '+' : ''}</td>,
                  <td class={`diff-line-content ${color}`} style="white-space: pre-wrap; overflow-wrap: anywhere"><code>{line?.text}</code></td>,
                ];
              };
              return <tr key={idx} class="diff-row diff-row-context">{side(row.old, true)}{side(row.new, false)}</tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
