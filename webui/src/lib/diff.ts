export interface ParsedDiffLine {
  type: 'header' | 'hunk' | 'add' | 'del' | 'context';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  const result: ParsedDiffLine[] = [];
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      result.push({ type: 'hunk', text: line });
    } else if (line.startsWith('\\ No newline at end of file')) {
      continue;
    } else if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith('-') && oldRemaining > 0) {
        result.push({ type: 'del', text: line.slice(1), oldLineNumber: oldLine++ });
        oldRemaining--;
      } else if (line.startsWith('+') && newRemaining > 0) {
        result.push({ type: 'add', text: line.slice(1), newLineNumber: newLine++ });
        newRemaining--;
      } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        result.push({ type: 'context', text: line.slice(1), oldLineNumber: oldLine++, newLineNumber: newLine++ });
        oldRemaining--;
        newRemaining--;
      } else if (line !== '') {
        result.push({ type: 'header', text: line });
      }
    } else if (line !== '') {
      result.push({ type: 'header', text: line });
    }
  }
  return result;
}

type DiffRow = { old?: ParsedDiffLine; new?: ParsedDiffLine; full?: ParsedDiffLine };

export function pairDiffLines(lines: ParsedDiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === 'add' || line.type === 'del') {
      const deleted: ParsedDiffLine[] = [], added: ParsedDiffLine[] = [];
      while (i < lines.length && (lines[i]!.type === 'add' || lines[i]!.type === 'del')) {
        const change = lines[i++]!;
        (change.type === 'del' ? deleted : added).push(change);
      }
      for (let n = 0; n < Math.max(deleted.length, added.length); n++) {
        rows.push({ old: deleted[n], new: added[n] });
      }
    } else {
      rows.push(line.type === 'context' ? { old: line, new: line } : { full: line });
      i++;
    }
  }
  return rows;
}
