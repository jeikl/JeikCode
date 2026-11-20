import { formatTurnElapsed } from '../../lib/turnTimer';

/**
 * Compact elapsed-time badge used under assistant turns and in live status rows.
 * The icon carries the meaning; the visible label is only the duration. The
 * localized full phrase stays available as aria-label / title for accessibility.
 */
export function ElapsedBadge({
  ms,
  live = false,
  label,
  className,
}: {
  ms: number;
  live?: boolean;
  label?: string;
  className?: string;
}) {
  const text = formatTurnElapsed(Math.max(0, ms));
  return (
    <span
      class={'msg-turn-elapsed' + (live ? ' is-live' : '') + (className ? ' ' + className : '')}
      aria-label={label}
      title={label}
    >
      <svg
        class="msg-elapsed-icon"
        width="11"
        height="11"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="9" r="5" />
        <path d="M8 6.2v2.9l1.9 1.1" />
        <path d="M6.3 1.8h3.4" />
        <path d="M8 1.8v1.4" />
      </svg>
      <span class="msg-elapsed-value">{text}</span>
    </span>
  );
}
