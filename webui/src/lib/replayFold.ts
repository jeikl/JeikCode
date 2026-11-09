/**
 * `/chat/watch` 的回放缓冲只装着当前这一轮，不是 48 条以外的整段历史。
 *
 * 首屏仍只拿最后一页。回放从这一轮的开头按时间到达：
 * - 已经在这一页上的帧交给画布按身份合并，不能再接成一条新的助手消息；
 * - 页还没画到这一轮时，先按住。碰到页内帧后，**只有能证明是折叠线以上**的
 *   工具/正文才丢（它们在更早的历史里，补到回答下面就是上次的重放叠加）；
 *   证明不了的必须按线序补画——断线重连时这一段是当前轮唯一的副本。
 * - 同一轮被页切掉的用户提问不能跟着丢掉，要插回这一轮助手内容的前面；
 * - 整段都碰不到这一页时，说明这一轮还没落盘，直播帧或终态再整段放出来。
 *
 * 页大小本身不动。把窗口退回到回合开头会把整轮工具调用一次拉进画布。
 */

import type { SSEEvent } from '../api.ts';
import { userMessageAlreadyOnCanvas } from './chatTerminal.ts';
import { identifiedAssistantIndex } from './sessionProjection.ts';
import type { MsgPart } from './toolRows.ts';

export interface ReplayFoldMessage {
  role: string;
  id?: string;
  ts?: number;
  parts: MsgPart[];
}

const TERMINAL = new Set(['done', 'stopped', 'error']);
/** 折叠线以上的正文可以丢，待审批 / 待输入 / 压缩边界通知不能丢。 */
const INTERACTIVE = new Set(['permission_request', 'user_input_request', 'display_notice']);

/**
 * Should this frame be applied with replay semantics (replace the accumulated
 * part) rather than appended as a live delta?
 *
 * New daemons put the same session `seq` on live and replay frames and mark
 * replays with `replay: true`. Live deltas also carry `part_rev`; using seq or
 * "attached without a cursor" as a replay signal makes the part-revision path
 * REPLACE each token with a small chunk. Old daemons only put seq on replays,
 * so the fallback stays for frames without `part_rev`.
 */
export function needsReplayDedup(
  frame: SSEEvent & { seq?: number; part_rev?: number; replay?: boolean },
  attachNeedsDedup: boolean,
): boolean {
  if (typeof frame.part_rev === 'number') return frame.replay === true;
  return attachNeedsDedup || frame.replay === true
    || (frame.replay === undefined && typeof frame.seq === 'number');
}

export interface ReplayFoldState {
  held: Array<SSEEvent & { seq?: number; replay?: boolean }>;
  overlapped: boolean;
  /** 整段回放都属于折叠线以上（已落盘的旧回合）：到 flush 时必须丢弃，绝不能补到末尾。 */
  aboveFold: boolean;
}

/** 页内已经有这一轮时，把被切掉的提问插到这个助手消息前面。 */
export interface ReplayFoldAnchor {
  messageId?: string;
  toolId?: string;
}

export interface AcceptedReplay {
  /** 按顺序落笔。已经在页上的前缀工具/正文不在这里。 */
  paint: Array<SSEEvent & { seq?: number; replay?: boolean }>;
  /** 这一轮被页切掉的提问。插到 `before` 前面，不能追加到回答下面。 */
  placeUsers: Array<SSEEvent & { seq?: number; replay?: boolean }>;
  before?: ReplayFoldAnchor;
}

export function createReplayFold(): ReplayFoldState {
  return { held: [], overlapped: false, aboveFold: false };
}

function canvasHasTool(messages: ReplayFoldMessage[], id?: string): boolean {
  if (!id) return false;
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => part.kind === 'tool' && part.tool.id === id),
  );
}

/** 这一帧是不是已经落在当前页上。对不上的回放帧先暂存，不能直接补到末尾。 */
export function replayFrameOnCanvas(messages: ReplayFoldMessage[], event: SSEEvent): boolean {
  switch (event.type) {
    case 'user':
      return userMessageAlreadyOnCanvas(messages, event.content, event.created_at, event.message_id);
    case 'user_identified':
      return messages.some((message) => message.id === event.message_id);
    case 'text':
    case 'reasoning': {
      if (event.message_id && identifiedAssistantIndex(messages, event.message_id) >= 0) return true;
      if (event.part_id) {
        const owner = event.part_id.split(':')[0];
        if (owner && identifiedAssistantIndex(messages, owner) >= 0) return true;
      }
      return false;
    }
    case 'tool_start':
      if (event.message_id && identifiedAssistantIndex(messages, event.message_id) >= 0) return true;
      return canvasHasTool(messages, event.id);
    case 'tool_output':
    case 'tool_progress':
    case 'tool_finished':
    case 'tool_result':
      return canvasHasTool(messages, event.id);
    case 'permission_request':
      return canvasHasTool(messages, event.call_id);
    default:
      return false;
  }
}

/**
 * 这一帧落到的那条助手行（轮编号优先，其次工具 call id）。
 * 回放侧用它判定折叠锚点；客户端用它把补回的 `steered` 提问插回被打断的那一轮
 * 之后，而不是追加到时间线末尾。
 */
export function replayFrameAnchor(event: SSEEvent): ReplayFoldAnchor {
  switch (event.type) {
    case 'text':
    case 'reasoning':
      return { messageId: event.message_id };
    case 'tool_start':
      return { messageId: event.message_id, toolId: event.id };
    case 'tool_output':
      return event.id ? { toolId: event.id } : {};
    case 'tool_progress':
    case 'tool_finished':
    case 'tool_result':
      return { toolId: event.id };
    case 'permission_request':
      return { toolId: event.call_id };
    default:
      return {};
  }
}

function anchorOf(event: SSEEvent): ReplayFoldAnchor {
  return replayFrameAnchor(event);
}

function isTurnUser(event: SSEEvent): boolean {
  return event.type === 'user' || event.type === 'user_identified';
}

const EMPTY: AcceptedReplay = { paint: [], placeUsers: [] };

/**
 * 返回这一拍可以落笔的帧，以及要插回回合开头的提问。
 * `paint` 为空表示先按住（折叠线以上的工具/正文，还没碰到当前页）。
 */
export function acceptReplayFrame(
  state: ReplayFoldState,
  event: SSEEvent & { seq?: number; replay?: boolean; replay_last?: boolean },
  historyOffset: number,
  onCanvas: (candidate: SSEEvent) => boolean,
  canvasHasOpenTurn = false,
  /** 这个提问是否落在折叠线以上（已落盘的更早回合）。有它才能在 flush 时丢弃而不是补到末尾。 */
  isAboveFold?: (event: SSEEvent) => boolean,
  /** True when this replay belongs to the CURRENT running operation: its
   *  frames are the open turn, not already-persisted older history. */
  allowAboveFoldPaint = false,
  /** New daemons advertise `explicit_replay`: `seq` alone is NOT replay. */
  explicitReplay = false,
): AcceptedReplay {
  // `seq` is now present on live frames too; only `replay` decides whether the
  // fold applies. Old daemons have no flag, where seq presence is the fallback.
  const replay = event.replay === true
    || (!explicitReplay && event.replay === undefined && typeof event.seq === 'number');
  // 会话级阶段状态与上下文占用变化不属于某条折叠线以上的历史消息，必须立刻放行。
  if (event.type === 'session_status' || event.type === 'context_compacted') {
    return { paint: [event], placeUsers: [] };
  }
  const terminal = TERMINAL.has(event.type);
  const userEvent = event as SSEEvent & {
    message_id?: string;
    client_input_id?: string;
  };
  const userAnchorId = userEvent.message_id ?? userEvent.client_input_id;
  // A user boundary always re-anchors whatever assistant frames arrived before
  // it — regardless of `historyOffset`. With the window fully expanded
  // (offset 0) the old code released those frames immediately and appended them
  // after the new turn; the anchor must not depend on the fold line existing.
  if (isTurnUser(event) && state.held.length > 0 && userAnchorId) {
    const placeUsers = state.held.filter((held) => held.type === 'user');
    const assistants = state.held.filter(
      (held) => held.type !== 'user' && !onCanvas(held),
    );
    state.held.length = 0;
    state.overlapped = true;
    return {
      paint: [event, ...assistants],
      placeUsers,
      before: { messageId: userAnchorId },
    };
  }
  // 整份记录都在页内、直播帧、终态：不再按住。没碰到当前页的暂存是还没落盘的这一轮，一起放出来。
  const release = !replay || terminal
    || (historyOffset <= 0 && (isTurnUser(event) || onCanvas(event)));
  if (release) {
    if (!state.overlapped && state.held.length > 0 && (!replay || terminal)) {
      const flushed = state.held.splice(0, state.held.length);
      // 折叠线以上的旧回合：它们已经在磁盘上（窗口之外），补到末尾就是“提问跑到底部”的孪生 bug。
      if (state.aboveFold && !allowAboveFoldPaint) return { paint: [event], placeUsers: [] };
      if (state.aboveFold) {
        // 开场提问已在折叠线之上（`index < historyOffset`）：它不能走 `paint` 当作新提问追加到画布末尾，
        // 必须走 `placeUsers` 按大纲坐标归位（或由窗口连续性守卫忽略）；只有未落盘的后续帧走 `paint`。
        const placeUsers = flushed.filter((held) => held.type === 'user');
        const tailPaint = flushed.filter((held) => held.type !== 'user');
        return { paint: [...tailPaint, event], placeUsers };
      }
      return { paint: [...flushed, event], placeUsers: [] };
    }
    return { paint: [event], placeUsers: [] };
  }

  if (onCanvas(event)) {
    // 提问已经在页上：若该提问后面尚无任何已落盘的助手内容（canvasHasOpenTurn），说明这一轮
    // 正处于画布末尾（非页顶截断），立即打开闸门放行后续所有工具/思考/正文；
    // 否则它后面、页尾之前的工具仍是前缀，不在此处打开闸门。
    if (isTurnUser(event)) {
      if (canvasHasOpenTurn) {
        state.overlapped = true;
      }
      return { paint: [event], placeUsers: [] };
    }
    state.overlapped = true;
    const placeUsers = state.held.filter((held) => held.type === 'user');
    // 暂存区里除了提问，还有本轮的正文 / 思考 / 工具帧。一旦 `onCanvas(event)` 命中，
    // 说明当前页已经有这一轮后半段的落盘行：若开场提问在折叠线以上（`state.aboveFold`），
    // 命中点之前的暂存帧就是折叠线以上的旧 round，必须丢弃，绝不能因 `allowAboveFoldPaint`
    // 把它们重播到画布底部；只有开场提问不在折叠线以上时才按线序补画。
    // 待审批 / 待输入 / 压缩边界永远不能丢。
    const aboveFold = state.aboveFold;
    const replayable = state.held.filter(
      (held) => held.type !== 'user' && (INTERACTIVE.has(held.type) || !aboveFold),
    );
    state.held.length = 0;
    return {
      paint: [...replayable, event],
      placeUsers,
      before: anchorOf(event),
    };
  }
  if (state.overlapped) return { paint: [event], placeUsers: [] };
  // 记录：这一整段回放是否全在折叠线以上（第一个页外提问即可判定）。
  if (
    !state.aboveFold &&
    (event.type === 'user' || event.type === 'user_identified') &&
    isAboveFold?.(event) === true
  ) {
    state.aboveFold = true;
  }
  if (event.replay_last === true) {
    // 服务端回放缓冲已到最后一帧但仍未与当前页发生重叠，说明整段回放均属于尚未落盘的新内容，
    // 立即全量释放上屏，杜绝异地浏览器进入或刷新时因等待未来直播帧而卡在空白转圈。
    state.overlapped = true;
    const flushed = state.held.splice(0, state.held.length);
    // 但若这段回放全在折叠线以上，它就是已落盘的旧回合：绝不能把它补到时间线末尾。
    // 当前运行 operation 的回放例外：它的起点头可能早于 tail 窗口，但仍是未结束的当前轮。
    if (state.aboveFold && !allowAboveFoldPaint) return EMPTY;
    if (state.aboveFold) {
      // `after_seq` 续传会把折叠线以上的 `opening_user` 补在切片头部（若游标已在末尾，
      // `opening_user` 自身就是唯一的 `replay_last` 帧）：必须连同 `event` 一起按类型分离，
      // 让 `user` 走 `placeUsers` 坐标归位，绝不能混进 `paint` 当作新提问贴到画布底部。
      const all = [...flushed, event];
      const placeUsers = all.filter((held) => held.type === 'user');
      const tailPaint = all.filter((held) => held.type !== 'user');
      return { paint: tailPaint, placeUsers };
    }
    return { paint: [...flushed, event], placeUsers: [] };
  }
  state.held.push(event);
  return EMPTY;
}
