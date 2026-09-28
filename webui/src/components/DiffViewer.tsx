import { useMemo } from 'preact/hooks';

interface DiffViewerProps {
  diffText: string;
  filePath: string;
  commitHash: string;
  commitMessage: string;
}

interface ParsedDiffLine {
  type: 'header' | 'hunk' | 'add' | 'del' | 'context';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  const lines = diff.split('\n');
  const result: ParsedDiffLine[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      result.push({ type: 'header', text: line });
      continue;
    }

    if (line.startsWith('@@ ')) {
      // Parse hunk header like @@ -15,7 +15,9 @@
      const match = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (match) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[2]!, 10);
      }
      result.push({ type: 'hunk', text: line });
      continue;
    }

    if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line.slice(1),
        newLineNumber: newLine++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'del',
        text: line.slice(1),
        oldLineNumber: oldLine++,
      });
    } else if (line.startsWith(' ') || line === '') {
      result.push({
        type: 'context',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    } else {
      result.push({ type: 'header', text: line });
    }
  }

  return result;
}

export function DiffViewer({ diffText, filePath, commitHash, commitMessage }: DiffViewerProps) {
  const parsedLines = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  return (
    <div class="diff-viewer-root">
      <div class="diff-viewer-toolbar">
        <div class="diff-toolbar-meta">
          <span class="diff-hash-pill">{commitHash.slice(0, 8)}</span>
          <span class="diff-meta-msg" title={commitMessage}>{commitMessage}</span>
          <span class="diff-meta-divider">·</span>
          <span class="diff-meta-path" title={filePath}>{filePath}</span>
        </div>
      </div>

      <div class="diff-code-table-wrap">
        <table class="diff-code-table">
          <tbody>
            {parsedLines.map((line, idx) => {
              if (line.type === 'hunk') {
                return (
                  <tr key={idx} class="diff-row diff-row-hunk">
                    <td class="diff-gutter-num old-num">...</td>
                    <td class="diff-gutter-num new-num">...</td>
                    <td class="diff-gutter-marker"></td>
                    <td class="diff-line-content hunk-header">{line.text}</td>
                  </tr>
                );
              }

              if (line.type === 'header') {
                return (
                  <tr key={idx} class="diff-row diff-row-header">
                    <td class="diff-gutter-num old-num"></td>
                    <td class="diff-gutter-num new-num"></td>
                    <td class="diff-gutter-marker"></td>
                    <td class="diff-line-content file-header">{line.text}</td>
                  </tr>
                );
              }

              const isAdd = line.type === 'add';
              const isDel = line.type === 'del';
              let rowClass = 'diff-row';
              let marker = ' ';

              if (isAdd) {
                rowClass += ' diff-row-add';
                marker = '+';
              } else if (isDel) {
                rowClass += ' diff-row-del';
                marker = '-';
              } else {
                rowClass += ' diff-row-context';
              }

              return (
                <tr key={idx} class={rowClass}>
                  <td class="diff-gutter-num old-num">
                    {line.oldLineNumber != null ? line.oldLineNumber : ''}
                  </td>
                  <td class="diff-gutter-num new-num">
                    {line.newLineNumber != null ? line.newLineNumber : ''}
                  </td>
                  <td class="diff-gutter-marker">{marker}</td>
                  <td class="diff-line-content">
                    <code>{line.text}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
