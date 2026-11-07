/**
 * The single session-pull policy.
 *
 * Every caller (cold start, switch, background reconcile, older page, right-rail
 * jump, delta resume) goes through one of five modes. The wire request is built
 * here, so no component can invent a sixth ad-hoc `getSession` shape.
 */
import { getSession, type SessionDetail } from '../api.ts';

export type SessionPullMode = 'snapshot' | 'older' | 'jump' | 'delta' | 'outline';

export interface SessionPullRequest {
  projectHash: string;
  sessionId: string;
  mode: SessionPullMode;
  /** Page size. `initial`/`reconcile` default to 48; `older` defaults to 48. */
  limit?: number;
  /** Legacy positional cursor; only used when `beforeSeq` is absent. */
  offset?: number;
  /** Older-history cursor (exclusive). */
  beforeSeq?: number;
  /** Right-rail jump target (record id). */
  around?: string;
  /** Delta resume cursor (exclusive). */
  afterSeq?: number;
  signal?: AbortSignal;
}

const DEFAULT_PAGE = 48;

/** Build and execute the one pull for a mode. Throws on an impossible mode. */
export function pullSession(req: SessionPullRequest): Promise<SessionDetail> {
  const opts: {
    tail?: number;
    offset?: number;
    limit?: number;
    beforeSeq?: number;
    around?: string;
    afterSeq?: number;
    signal?: AbortSignal;
    turnsOnly?: boolean;
  } = { signal: req.signal };
  switch (req.mode) {
    case 'snapshot':
      opts.tail = req.limit ?? DEFAULT_PAGE;
      break;
    case 'outline':
      // 大纲单取：服务端只回 turns + 元数据，不传正文/工具输出/图片。
      // 右栏在回前台时刷新一次，弱网下从几十 KB 降到几百字节。
      opts.turnsOnly = true;
      break;
    case 'older':
      if (req.beforeSeq != null) {
        opts.beforeSeq = req.beforeSeq;
        opts.limit = req.limit ?? DEFAULT_PAGE;
      } else {
        opts.offset = req.offset ?? 0;
        opts.limit = req.limit;
      }
      break;
    case 'jump':
      if (!req.around) throw new Error('pullSession(jump) requires around');
      opts.around = req.around;
      break;
    case 'delta':
      if (req.afterSeq == null) throw new Error('pullSession(delta) requires afterSeq');
      opts.afterSeq = req.afterSeq;
      break;
  }
  return getSession(req.projectHash, req.sessionId, opts);
}
