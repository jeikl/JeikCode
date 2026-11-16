import { useT } from '../../settings';
import { formatTurnElapsed } from '../../lib/turnTimer';
import { LiveElapsedText } from './LiveElapsedText';

export function StatusRow({
  mode,
  liveAnchorMs,
  liveElapsedMs,
}: {
  mode: 'working' | 'compacting';
  liveAnchorMs?: number;
  liveElapsedMs?: number;
}) {
  const t = useT();
  return (
    <div class="compacting-status" role="status" aria-live="polite">
      <span class="codex-shimmer-status">
        {mode === 'compacting' ? t('chat.statusCompacting') : t('chat.statusWorking')}
      </span>
      {liveAnchorMs != null ? (
        <span style={{ marginLeft: '8px' }}>
          <LiveElapsedText anchorMs={liveAnchorMs} />
        </span>
      ) : liveElapsedMs != null ? (
        <span class="msg-time is-live" style={{ marginLeft: '8px' }}>
          <span class="msg-turn-elapsed">
            {t('chat.turnElapsedLive', { time: formatTurnElapsed(liveElapsedMs) })}
          </span>
        </span>
      ) : null}
    </div>
  );
}
