/**
 * Excel-like column resizing for rendered markdown tables.
 *
 * Markdown tables are injected as HTML and re-created whenever the message is
 * re-rendered (streaming, search highlighting, theme/language changes). Column
 * widths therefore live in a module-level store keyed by the header row, and
 * the enhancer re-applies them after every render:
 *
 * - Tables stay on the browser's auto layout until the user drags a boundary.
 * - The first drag freezes every column into a <colgroup> and switches the
 *   table to `table-layout: fixed`, so text wraps inside the chosen width.
 * - A scroll wrapper keeps wide tables horizontally scrollable instead of
 *   stretching the chat column.
 * - Double-clicking a boundary drops the stored widths and returns to auto.
 */

const MIN_COL_WIDTH = 56;
const MAX_COL_WIDTH = 1600;
const MAX_STORED_TABLES = 200;

/** Header-signature → column widths (px). Shared by every Markdown instance. */
const storedWidths = new Map<string, number[]>();

function clampWidth(width: number): number {
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
}

function tableKey(table: HTMLTableElement): string {
  const header = table.tHead?.rows[0];
  const cells = header ? Array.from(header.cells) : [];
  const text = cells
    .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim())
    .join('\u0001');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `${cells.length}:${hash}`;
}

function rememberWidths(key: string, widths: number[]): void {
  storedWidths.delete(key);
  storedWidths.set(key, widths.slice());
  while (storedWidths.size > MAX_STORED_TABLES) {
    const oldest = storedWidths.keys().next();
    if (oldest.done) break;
    storedWidths.delete(oldest.value);
  }
}

function applyWidths(table: HTMLTableElement, cols: HTMLElement[], widths: number[]): void {
  table.style.tableLayout = 'fixed';
  let total = 0;
  widths.forEach((width, index) => {
    const value = clampWidth(width);
    total += value;
    const col = cols[index];
    if (col) col.style.width = `${value}px`;
  });
  table.style.width = `${total}px`;
}

function clearWidths(table: HTMLTableElement, cols: HTMLElement[]): void {
  table.style.tableLayout = '';
  table.style.width = '';
  table.style.minWidth = '';
  for (const col of cols) col.style.width = '';
}

export interface MarkdownTableLabels {
  /** aria-label for a column boundary. */
  resize: string;
  /** Tooltip explaining the double-click reset. */
  reset: string;
}

/**
 * Enhance every table inside `root` in place. Safe to call after each render;
 * tables are re-created by the caller, so no duplicate handles are produced.
 */
export function enhanceMarkdownTables(root: HTMLElement, labels: MarkdownTableLabels): void {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table'));
  for (const table of tables) {
    const headerRow = table.tHead?.rows[0] ?? table.rows[0];
    if (!headerRow) continue;

    const columnCount = headerRow.cells.length;
    if (columnCount === 0) continue;

    // A scroll wrapper lets wide tables pan instead of stretching the chat.
    let wrapper = table.parentElement;
    if (!wrapper || !wrapper.classList.contains('md-table-scroll')) {
      wrapper = document.createElement('div');
      wrapper.className = 'md-table-scroll';
      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    }

    // Own the colgroup: drop anything that came from raw markdown HTML.
    table.querySelectorAll(':scope > colgroup').forEach((group) => group.remove());
    const colgroup = document.createElement('colgroup');
    const cols: HTMLElement[] = [];
    for (let i = 0; i < columnCount; i += 1) {
      const col = document.createElement('col');
      colgroup.appendChild(col);
      cols.push(col);
    }
    const caption = table.querySelector(':scope > caption');
    table.insertBefore(colgroup, caption ? caption.nextSibling : table.firstChild);

    const key = tableKey(table);
    table.dataset.mdTableKey = key;
    const saved = storedWidths.get(key);
    if (saved && saved.length === columnCount) {
      applyWidths(table, cols, saved);
    }

    const readCurrentWidths = (): number[] => {
      return Array.from(headerRow.cells).map((cell, index) => {
        const explicit = parseFloat(cols[index]?.style.width || '');
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        return clampWidth(cell.getBoundingClientRect().width || MIN_COL_WIDTH);
      });
    };

    const resetColumn = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      storedWidths.delete(key);
      clearWidths(table, cols);
    };

    for (let index = 0; index < columnCount; index += 1) {
      const th = headerRow.cells[index];
      if (!th) continue;
      th.classList.add('md-th-resizable');
      if (index === columnCount - 1) th.classList.add('md-th-last');

      const handle = document.createElement('span');
      handle.className = 'md-col-resizer';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', labels.resize);
      handle.title = labels.reset;
      handle.dataset.col = String(index);

      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const widths = readCurrentWidths();
        if (widths.length !== columnCount) return;
        applyWidths(table, cols, widths);

        const startX = e.clientX;
        const startWidth = widths[index] ?? MIN_COL_WIDTH;
        const active = handle;
        active.classList.add('is-active');
        table.classList.add('is-resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = (moveEvent: PointerEvent) => {
          const next = clampWidth(startWidth + (moveEvent.clientX - startX));
          widths[index] = next;
          const col = cols[index];
          if (col) col.style.width = `${next}px`;
          table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
        };

        const finish = () => {
          active.classList.remove('is-active');
          table.classList.remove('is-resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          window.removeEventListener('blur', finish);
          rememberWidths(key, widths);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        window.addEventListener('blur', finish);
      });

      handle.addEventListener('dblclick', resetColumn);
      th.appendChild(handle);
    }
  }
}
