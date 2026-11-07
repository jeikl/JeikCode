import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../../settings';
import { textMatchesSearch } from '../../lib/canvasSearch';
import { highlightText } from './highlight';

export function ReasoningBlock({ text, search }: { text: string; search: string }) {
  const t = useT();
  // Default expanded while streaming (short / growing); collapse once settled
  // if the user prefers — start open so live thinking is visible.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 搜索命中思考块时必须展开：折叠态下命中文本不在 DOM 上，会出现“计数有、页面上却找不到”。
  useEffect(() => {
    if (textMatchesSearch(text, search)) setOpen(true);
  }, [search, text]);
  // Follow latest tokens at the bottom until the user scrolls up (same policy
  // as the main timeline: sticky follow, release on manual up-scroll).
  const followBottomRef = useRef(true);
  const REASONING_BOTTOM_SLACK = 48;
  const recomputeFollow = () => {
    const el = bodyRef.current;
    if (!el) return;
    followBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= REASONING_BOTTOM_SLACK;
  };
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open]);
  if (!text.trim()) return null;
  return (
    <div class={'reasoning-block' + (open ? ' is-open' : '')}>
      <button
        type="button"
        class="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span class="reasoning-icon" aria-hidden="true">
          ✦
        </span>
        <span class="reasoning-label">{t('chat.thinking')}</span>
        <span class={'reasoning-chevron' + (open ? ' expanded' : '')}>▾</span>
      </button>
      {open && (
        <div class="reasoning-body" ref={bodyRef} onScroll={recomputeFollow}>
          {highlightText(text, search)}
        </div>
      )}
    </div>
  );
}
