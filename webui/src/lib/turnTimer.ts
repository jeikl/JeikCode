/** Live turn elapsed-time helpers for the WebUI chat timeline. */

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * Format a duration for the in-turn stopwatch.
 * Seconds stay in seconds until 60, then the unit rolls to m:ss (and h:mm:ss).
 */
export function formatTurnElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  if (m > 0) return `${m}:${pad2(s)}`;
  return `${s}s`;
}

/** Resume the live stopwatch from the current user-bubble timestamp.
 *  Falls back to `now` when the send time is missing or in the future so a
 *  refresh during an in-flight turn does not restart at 0s when history has
 *  the original `created_at`. */
export function resumeTurnClockEpoch(now: number, lastUserTs?: number): number {
  if (lastUserTs == null || !Number.isFinite(lastUserTs) || lastUserTs <= 0) return now;
  if (lastUserTs > now) return now;
  return lastUserTs;
}

/** Wall-clock from the user bubble to `endTs` (final answer or now). */
export function turnDurationMs(userTs?: number, endTs?: number): number | undefined {
  if (userTs == null || endTs == null) return undefined;
  if (!Number.isFinite(userTs) || !Number.isFinite(endTs)) return undefined;
  if (endTs < userTs) return undefined;
  return endTs - userTs;
}

/** Done-turn "用时": prefer user-bubble → final answer, else the stamped
 *  full-turn elapsed (never a lone last-round kernel duration when a span exists). */
export function turnTotalElapsedMs(
  userTs?: number,
  endTs?: number,
  elapsedMs?: number,
): number | undefined {
  const fromUser = turnDurationMs(userTs, endTs);
  if (fromUser && fromUser > 0) {
    if (elapsedMs != null && Number.isFinite(elapsedMs) && elapsedMs > fromUser) {
      return elapsedMs;
    }
    return fromUser;
  }
  return elapsedMs;
}

/** Stamp `elapsedMs` (and optional completion time) onto the latest assistant
 *  message that does not already have a duration (or overwrite with cumulative duration when `opts.overwrite` is true). */
export function stampLastAssistantElapsed<T extends { role: string; elapsedMs?: number; ts?: number }>(
  msgs: T[],
  elapsedMs: number,
  finishedAt?: number,
  opts?: { overwrite?: boolean },
): T[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== 'assistant') continue;
    const prevElapsed = msgs[i]!.elapsedMs;
    if (prevElapsed != null && !opts?.overwrite) return msgs;
    const next = msgs.slice();
    next[i] = {
      ...msgs[i]!,
      elapsedMs: prevElapsed != null ? Math.max(prevElapsed, elapsedMs) : elapsedMs,
      ts: finishedAt ?? Date.now(),
    };
    return next;
  }
  return msgs;
}

/**
 * 为中途「立即发送」或跨轮延续的 Steer 卡片附加转向标记，确保后端落盘与刷新后仍能识别为 Steer 延续。
 */
export function composeSteerWireText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes('[jeikcode-steer]') || /<user-query>[\s\S]*?<\/user-query>/i.test(trimmed)) {
    return text;
  }
  return trimmed ? `${trimmed}\n\n[jeikcode-steer]` : '[jeikcode-steer]';
}

/**
 * 判断一条用户消息是否为中途转向注入（Steer）消息。
 * 判定依据（任一满足即可）：
 * 1. 显式标记 isSteer === true 或带有 pendingSteerId 关联；
 * 2. 文本中包含标准转向标记 [jeikcode-steer] 或包裹在 <user-query> ... </user-query> 转向信封中。
 */
export function isSteerUserMessage(msg: {
  role?: string;
  isSteer?: boolean;
  pendingSteerId?: string;
  parts?: Array<{ kind?: string; text?: string }>;
  content?: string;
}): boolean {
  if (msg.role && msg.role !== 'user') return false;
  if (msg.isSteer === true || Boolean(msg.pendingSteerId)) return true;

  const rawText =
    msg.content ??
    msg.parts
      ?.filter((p) => p.kind === 'text')
      .map((p) => p.text)
      .join('\n') ??
    '';

  if (!rawText) return false;
  return rawText.includes('[jeikcode-steer]') || /<user-query>[\s\S]*?<\/user-query>/i.test(rawText);
}

/**
 * 寻找当前 Assistant 消息所属轮次的真正根用户提问时间戳（Root Turn User Timestamp）。
 * 遇到中途插入的 Steer 转向消息时自动向上穿透，直到找到发起该整趟任务的最初用户提问。
 * 如果没有更早的非 Steer 用户提问，则回退使用找到的最早用户提问。
 */
export function rootTurnUserTs<
  T extends {
    role: string;
    ts?: number;
    /** Persisted kernel turn id (display/session detail). */
    turnId?: number;
    isSteer?: boolean;
    pendingSteerId?: string;
    parts?: Array<{ kind?: string; text?: string }>;
    content?: string;
  },
>(
  msgs: T[],
  idx: number,
  opts?: {
    /**
     * `true` (default): mid-turn steers continue the SAME continuous work timer.
     * `false`: after a real turn terminal, the next user row is a NEW root even
     * when it is a steer — the previous task completed, so the timer must reset.
     */
    penetrateSteers?: boolean;
  },
): number | undefined {
  const penetrate = opts?.penetrateSteers !== false;
  const users = msgs.slice(0, idx).filter((m) => m.role === 'user');
  let fallbackTs: number | undefined = undefined;
  for (let k = users.length - 1; k >= 0; k--) {
    const m = users[k]!;
    if (fallbackTs === undefined && m.ts != null) {
      fallbackTs = m.ts;
    }
    if (!penetrate || !isSteerUserMessage(m)) {
      return m.ts ?? fallbackTs;
    }
    // Durable boundary (survives refresh): a steer row whose persisted turn id
    // differs from the user row BELOW it belongs to a NEW turn — the previous
    // task stopped, so do not penetrate to the old root. A mid-turn steer shares
    // the turn id with the turn's root and continues the continuous timer.
    const below = users[k - 1];
    if (m.turnId != null && below?.turnId != null && m.turnId !== below.turnId) {
      return m.ts ?? fallbackTs;
    }
  }
  return fallbackTs;
}


