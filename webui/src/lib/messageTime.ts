import type { MsgKey } from '../i18n';
import type { CanvasRecord as Message } from './canvas/records';
import { rootTurnUserTs } from './turnTimer';

/** Zero-pad a number to 2 digits. */
export const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n);

/** Whether two dates fall on the same calendar day (Y/M/D all equal). */
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function precedingUserTs(msgs: Message[], idx: number): number | undefined {
  return rootTurnUserTs(msgs, idx);
}

export function formatMsgTime(
  ts: number | undefined,
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay(d, now)) return hm;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yest)) return `${t('time.yesterday')} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return t('time.sameYear', { m: d.getMonth() + 1, d: d.getDate(), hm });
  return t('time.otherYear', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hm });
}

/** Full local timestamp for the hover tooltip (seconds + full date). */
export function formatMsgTimeFull(ts?: number): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
