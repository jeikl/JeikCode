import { useEffect, useState } from 'preact/hooks';
import { useT } from '../../settings';
import { formatTurnElapsed } from '../../lib/turnTimer';
import { ElapsedBadge } from './ElapsedBadge';

/**
 * 隔离的 1 秒实时用时读秒组件：仅在本行叶子节点内触发重渲染，
 * 避免每秒钟驱动顶层 `Chat` 与整条消息时间线全量 diff。
 */
export function LiveElapsedText({
  anchorMs,
  className,
}: {
  anchorMs: number | undefined;
  className?: string;
}) {
  const t = useT();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (anchorMs == null || !Number.isFinite(anchorMs)) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anchorMs]);

  if (anchorMs == null || !Number.isFinite(anchorMs)) return null;
  const elapsed = Math.max(0, nowMs - anchorMs);

  return (
    <span class={className ? `msg-time is-live ${className}` : 'msg-time is-live'}>
      <ElapsedBadge
        ms={elapsed}
        live
        label={t('chat.turnElapsedLive', { time: formatTurnElapsed(elapsed) })}
      />
    </span>
  );
}
