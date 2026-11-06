import type { RefObject } from 'preact';
import { useT } from '../../settings';

export interface AtMentionRow {
  name: string;
  is_dir: boolean;
  up?: boolean;
}

export function AtMentionMenu({
  rows,
  loading,
  index,
  dirPart,
  menuRef,
  onHover,
  onChoose,
}: {
  rows: AtMentionRow[];
  loading: boolean;
  index: number;
  dirPart: string;
  menuRef?: RefObject<HTMLDivElement>;
  onHover: (index: number) => void;
  onChoose: (row: AtMentionRow) => void;
}) {
  const t = useT();
  return (
    <div class="at-popover" ref={menuRef}>
      {loading && <div class="at-loading">{t('atMention.loading')}</div>}
      {!loading && rows.map((item, i) => (
        <button
          key={(item.up ? 'up:' : item.is_dir ? 'd:' : 'f:') + item.name}
          class={'at-row' + (i === index ? ' active' : '')}
          // stopPropagation: this mousedown is an INSIDE click. Without it the
          // event bubbles to the document click-outside handler, whose
          // `contains(target)` guard fails once `setAtMention` clears+refetches
          // the list (the clicked row detaches), so it wrongly closes the menu.
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onChoose(item); }}
          onMouseEnter={() => onHover(i)}
          type="button"
          title={item.up ? '..' : dirPart + item.name + (item.is_dir ? '/' : '')}
        >
          <span class="at-icon">{item.up ? '⬆' : item.is_dir ? '📁' : '📄'}</span>
          <span class="at-name">{item.up ? '..' : dirPart + item.name + (item.is_dir ? '/' : '')}</span>
        </button>
      ))}
      {!loading && rows.length === 0 && (
        <div class="at-empty">{t('atMention.noFiles')}</div>
      )}
    </div>
  );
}
