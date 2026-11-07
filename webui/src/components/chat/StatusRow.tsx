import { useT } from '../../settings';
import { formatTurnElapsed } from '../../lib/turnTimer';

export function StatusRow({
  mode,
  liveElapsedMs,
}: {
  mode: 'working' | 'compacting';
  liveElapsedMs?: number;
}) {
  const t = useT();
  return (
    <div class="compacting-status" role="status" aria-live="polite">
      <span class="codex-shimmer-status">
        {mode === 'compacting' ? t('chat.statusCompacting') : t('chat.statusWorking')}
      </span>
      {liveElapsedMs != null && (
        <span class="msg-time is-live" style={{ marginLeft: '8px' }}>
          <span class="msg-turn-elapsed">
            {t('chat.turnElapsedLive', { time: formatTurnElapsed(liveElapsedMs) })}
          </span>
        </span>
      )}
    </div>
  );
}
