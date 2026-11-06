import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SSEEvent } from '../api.ts';
import {
  acceptReplayFrame,
  createReplayFold,
  needsReplayDedup,
  replayFrameOnCanvas,
  type ReplayFoldMessage,
} from './replayFold.ts';

function assistant(id: string, toolId?: string): ReplayFoldMessage {
  return {
    role: 'assistant',
    id,
    parts: toolId
      ? [{ kind: 'tool', tool: { id: toolId, name: 'bash', args: '', status: 'done' } }]
      : [{ kind: 'text', text: '已在页内', id: `${id}:1:text` }],
  };
}

function seq<T extends SSEEvent>(event: T, n: number): T & { seq: number } {
  return { ...event, seq: n };
}

test('live frame uses seq but replay=false must bypass the replay fold', () => {
  const fold = createReplayFold();
  const live = {
    type: 'text' as const,
    content: 'live',
    seq: 9,
    replay: false,
  };
  const accepted = acceptReplayFrame(fold, live, 102, () => false);
  assert.deepEqual(accepted.paint, [live]);
  assert.equal(fold.held.length, 0);
});

test('页内回放照常落笔，不因为带 seq 被按住', () => {
  const canvas = [assistant('m-visible')];
  const fold = createReplayFold();
  const text = seq({ type: 'text', content: '已在页内', message_id: 'm-visible' }, 4);
  const painted = acceptReplayFrame(fold, text, 102, (event) => replayFrameOnCanvas(canvas, event));
  assert.equal(painted.paint.length, 1);
  assert.equal(painted.paint[0], text);
  assert.deepEqual(painted.placeUsers, []);
  assert.equal(fold.held.length, 0);
  assert.equal(fold.overlapped, true);
});

test('折叠线以上的工具先按住，证明是旧回合后才丢掉；被切掉的提问要插回这一轮前面', () => {
  const canvas = [assistant('m-visible', 'tool-visible')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const aboveFold = (event: SSEEvent) => event.type === 'user';
  const user = seq({ type: 'user', content: '为什么按 F5 会响' }, 1);
  const earlyTool = seq(
    { type: 'tool_start', id: 'tool-early', name: 'bash', arguments: {}, message_id: 'm-early' },
    2,
  );
  const visibleTool = seq(
    { type: 'tool_start', id: 'tool-visible', name: 'bash', arguments: {}, message_id: 'm-visible' },
    3,
  );

  assert.deepEqual(acceptReplayFrame(fold, user, 102, onCanvas, false, aboveFold).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, earlyTool, 102, onCanvas, false, aboveFold).paint, []);
  const painted = acceptReplayFrame(fold, visibleTool, 102, onCanvas, false, aboveFold);
  assert.deepEqual(painted.placeUsers, [user]);
  assert.deepEqual(painted.paint, [visibleTool]);
  assert.equal(painted.before?.messageId, 'm-visible');
  assert.equal(painted.before?.toolId, 'tool-visible');
  assert.equal(fold.held.length, 0);
  assert.equal(fold.overlapped, true);
});

test('断线重连：本轮尚未上屏的正文 / 工具碰到页内帧时必须按线序补画，不能整段吞掉', () => {
  // 复现根因：暂停区里的 [text, tool] 是断网期间产生的当前轮内容，没有任何副本。
  // 碰到页内帧时如果直接清空 held，用户看到的就是 c→f 凭空消失。
  const canvas = [assistant('m-visible', 'tool-visible')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const user = seq({ type: 'user', content: '这一问', message_id: 'u-1' }, 1);
  const body = seq(
    { type: 'text', content: '断网期间产生的正文', message_id: 'm-live', part_id: 'm-live:1:text' },
    2,
  );
  const tool = seq(
    { type: 'tool_start', id: 't-live', name: 'bash', arguments: {}, message_id: 'm-live' },
    3,
  );
  const visible = seq(
    { type: 'tool_start', id: 'tool-visible', name: 'bash', arguments: {}, message_id: 'm-visible' },
    4,
  );

  assert.deepEqual(acceptReplayFrame(fold, user, 102, onCanvas).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, body, 102, onCanvas).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, tool, 102, onCanvas).paint, []);
  const out = acceptReplayFrame(fold, visible, 102, onCanvas);
  assert.deepEqual(out.paint.map((frame) => frame.type), ['text', 'tool_start', 'tool_start']);
  assert.deepEqual(out.placeUsers, [user]);
  assert.equal(fold.held.length, 0);
});

test('碰到页内帧之后的新正文仍然落笔', () => {
  const canvas = [assistant('m-visible')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  acceptReplayFrame(fold, seq({ type: 'text', content: '已在页内', message_id: 'm-visible' }, 1), 12, onCanvas);
  const newer = seq({ type: 'text', content: '还没落盘', message_id: 'm-new' }, 2);
  const painted = acceptReplayFrame(fold, newer, 12, onCanvas);
  assert.deepEqual(painted.paint, [newer]);
  assert.deepEqual(painted.placeUsers, []);
});

test('整段回放都对不上当前页时，直播帧把它作为新回合放出来', () => {
  const canvas = [assistant('m-old')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const user = seq({ type: 'user', content: '新的提问' }, 1);
  assert.deepEqual(acceptReplayFrame(fold, user, 40, onCanvas).paint, []);
  const live = { type: 'text', content: '续写', message_id: 'm-live' } as SSEEvent;
  const painted = acceptReplayFrame(fold, live, 40, onCanvas);
  assert.deepEqual(painted.paint, [user, live]);
  assert.deepEqual(painted.placeUsers, []);
});

test('页内工具的审批卡本身就算命中，折叠线以上的提问插回这一轮前面而不是丢掉', () => {
  const canvas = [assistant('m-visible', 'tool-visible')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const user = seq({ type: 'user', content: '折叠线以上' }, 1);
  const permission = seq(
    {
      type: 'permission_request',
      session_id: 's',
      approval_id: 'a',
      tool_name: 'bash',
      reason: 'run',
      call_id: 'tool-visible',
      arguments: {},
    },
    2,
  );
  assert.deepEqual(acceptReplayFrame(fold, user, 8, onCanvas).paint, []);
  const painted = acceptReplayFrame(fold, permission, 8, onCanvas);
  assert.deepEqual(painted.placeUsers, [user]);
  assert.deepEqual(painted.paint, [permission]);
  assert.equal(painted.before?.toolId, 'tool-visible');
  assert.equal(fold.held.length, 0);
  assert.equal(fold.overlapped, true);
});

test('还没画到页内工具时，审批卡先按住，命中当前页后再放出来', () => {
  const canvas = [assistant('m-visible')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const permission = seq(
    {
      type: 'permission_request',
      session_id: 's',
      approval_id: 'a',
      tool_name: 'bash',
      reason: 'run',
      call_id: 'tool-early',
      arguments: {},
    },
    1,
  );
  const visible = seq({ type: 'text', content: '已在页内', message_id: 'm-visible' }, 2);
  assert.deepEqual(acceptReplayFrame(fold, permission, 8, onCanvas).paint, []);
  const painted = acceptReplayFrame(fold, visible, 8, onCanvas);
  assert.deepEqual(painted.paint, [permission, visible]);
  assert.deepEqual(painted.placeUsers, []);
});

test('提问已经在页上时不打开折叠线，但未证明在折叠线以上的工具仍要补画', () => {
  const canvas = [
    { id: 'u-1', role: 'user', parts: [{ kind: 'text', text: '这一问' }] },
    assistant('m-visible', 'tool-visible'),
  ];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const user = seq({ type: 'user', content: '这一问', message_id: 'u-1' }, 1);
  const earlyTool = seq(
    { type: 'tool_start', id: 'tool-early', name: 'bash', arguments: {}, message_id: 'm-early' },
    2,
  );
  const visibleTool = seq(
    { type: 'tool_start', id: 'tool-visible', name: 'bash', arguments: {}, message_id: 'm-visible' },
    3,
  );
  const seenUser = acceptReplayFrame(fold, user, 20, onCanvas);
  assert.deepEqual(seenUser.paint, [user]);
  assert.equal(fold.overlapped, false);
  assert.deepEqual(acceptReplayFrame(fold, earlyTool, 20, onCanvas).paint, []);
  const painted = acceptReplayFrame(fold, visibleTool, 20, onCanvas);
  assert.deepEqual(painted.placeUsers, []);
  assert.deepEqual(
    painted.paint,
    [earlyTool, visibleTool],
    '没有证据证明 earlyTool 在折叠线以上时，它就是当前轮唯一副本，绝不能再丢',
  );
  assert.equal(fold.held.length, 0);
});

test('没有更早历史时不按住，短会话的回放仍整段落笔', () => {
  const fold = createReplayFold();
  const user = seq({ type: 'user', content: '只有一轮' }, 1);
  const painted = acceptReplayFrame(fold, user, 0, () => false);
  assert.deepEqual(painted.paint, [user]);
  assert.deepEqual(painted.placeUsers, []);
  assert.equal(fold.held.length, 0);
});

test('异地浏览器刷新：当画布末尾是本轮开放提问（尚无助手落盘）时，立即打开闸门渲染本轮全部回放帧', () => {
  const canvas: ReplayFoldMessage[] = [
    assistant('m-old'),
    { id: 'u-2', role: 'user', parts: [{ kind: 'text', text: '最新提问' }] },
    { role: 'assistant', parts: [] },
  ];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const user = seq({ type: 'user', content: '最新提问', message_id: 'u-2' }, 1);
  const tool = seq(
    { type: 'tool_start', id: 'tool-live-1', name: 'todo_write', arguments: {}, message_id: 'm-live' },
    2,
  );
  const seenUser = acceptReplayFrame(fold, user, 25, onCanvas, true);
  assert.deepEqual(seenUser.paint, [user]);
  assert.equal(fold.overlapped, true);

  const seenTool = acceptReplayFrame(fold, tool, 25, onCanvas, true);
  assert.deepEqual(seenTool.paint, [tool]);
  assert.equal(fold.held.length, 0);
});

test('异地浏览器刷新：回放缓冲尾帧（replay_last）仍未与旧画布重叠时，立即全量释放而非死等未来直播帧', () => {
  const canvas = [assistant('m-old')];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const user = seq({ type: 'user', content: '新的提问' }, 1);
  const text = { ...seq({ type: 'text', content: '生成中的回复', message_id: 'm-new' }, 2), replay_last: true };

  assert.deepEqual(acceptReplayFrame(fold, user, 40, onCanvas).paint, []);
  const flushed = acceptReplayFrame(fold, text, 40, onCanvas);
  assert.deepEqual(flushed.paint, [user, text]);
  assert.equal(fold.held.length, 0);
  assert.equal(fold.overlapped, true);
});

test('当前运行 operation 的 above-fold 回放允许 flush，不当作旧回合丢弃', () => {
  const canvas = [assistant('m-old')];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const aboveFold = (event: SSEEvent) => event.type === 'user';
  const fold = createReplayFold();
  const user = seq({ type: 'user', content: '当前长回合的开场提问', created_at: 1000 }, 1);
  const mid = seq({ type: 'tool_start', id: 't-1', name: 'bash', arguments: {}, message_id: 'm-mid' }, 2);
  const last = {
    ...seq({ type: 'text', content: '当前回合正文', message_id: 'm-last' }, 3),
    replay_last: true,
  };
  assert.deepEqual(acceptReplayFrame(fold, user, 55, onCanvas, false, aboveFold, true).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, mid, 55, onCanvas, false, aboveFold, true).paint, []);
  const flushed = acceptReplayFrame(fold, last, 55, onCanvas, false, aboveFold, true);
  assert.deepEqual(
    flushed.paint,
    [mid, last],
    'an active operation replay must paint non-user delta frames even when its question is above the tail fold',
  );
  assert.deepEqual(
    flushed.placeUsers,
    [user],
    'above-fold opening_user must go to placeUsers (coordinate placement) instead of paint (tail append)',
  );
});

test('整段回放都在折叠线以上（已落盘旧回合）时，绝不 flush 到时间线末尾', () => {
  const canvas = [assistant('m-old')];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const aboveFold = (event: SSEEvent) => event.type === 'user';
  const fold = createReplayFold();
  const user = seq({ type: 'user', content: '被折叠线切掉的开场提问', created_at: 1000 }, 1);
  const mid = seq({ type: 'text', content: '中间过程', message_id: 'm-mid' }, 2);
  const last = {
    ...seq({ type: 'text', content: '最终答案', message_id: 'm-last' }, 3),
    replay_last: true,
  };

  assert.deepEqual(acceptReplayFrame(fold, user, 55, onCanvas, false, aboveFold).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, mid, 55, onCanvas, false, aboveFold).paint, []);
  assert.deepEqual(
    acceptReplayFrame(fold, last, 55, onCanvas, false, aboveFold).paint,
    [],
    'above-fold replay must not append a duplicate turn at the end',
  );
  assert.equal(fold.aboveFold, true);
});

test('折叠线以上暂存之后到达的直播帧仍然放行', () => {
  const canvas = [assistant('m-old')];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const aboveFold = (event: SSEEvent) => event.type === 'user';
  const fold = createReplayFold();
  acceptReplayFrame(fold, seq({ type: 'user', content: '旧提问', created_at: 1 }, 1), 55, onCanvas, false, aboveFold);
  acceptReplayFrame(fold, seq({ type: 'text', content: '旧回合中间', message_id: 'm-a' }, 2), 55, onCanvas, false, aboveFold);
  const live = acceptReplayFrame(fold, { type: 'text', content: '新直播增量' }, 55, onCanvas, false, aboveFold);
  assert.equal(live.paint.length, 1);
  assert.equal(live.paint[0]!.type, 'text');
});


test('needsReplayDedup: new daemon live frames with part_rev are NOT replay', () => {
  const live = { type: 'text' as const, content: '增量', message_id: 'm-1', part_id: 'm-1:1:text', part_rev: 3, seq: 9 };
  assert.equal(needsReplayDedup(live, true), false, 'attach-without-cursor must not turn live deltas into replaces');
  assert.equal(needsReplayDedup(live, false), false);
});

test('needsReplayDedup: explicit replay and legacy seq-only replays stay replay', () => {
  const replay = { type: 'text' as const, content: '累积正文', message_id: 'm-1', part_id: 'm-1:1:text', part_rev: 9, replay: true, seq: 9 };
  assert.equal(needsReplayDedup(replay, false), true);
  const legacyReplay = { type: 'text' as const, content: '旧累积帧', message_id: 'm-1', part_id: 'm-1:1:text', seq: 9 };
  assert.equal(needsReplayDedup(legacyReplay, false), true);
  // Old daemon live frames had no seq.
  const legacyLive = { type: 'text' as const, content: '旧增量', message_id: 'm-1', part_id: 'm-1:1:text' };
  assert.equal(needsReplayDedup(legacyLive, false), false);
});

test('explicit_replay capability stops seq-only live frames from folding', () => {
  const canvas = [assistant('m-old')];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const live = seq({ type: 'text', content: '直播增量', message_id: 'm-new' }, 99);
  const fold = createReplayFold();
  const accepted = acceptReplayFrame(fold, live, 55, onCanvas, false, undefined, true, true);
  assert.deepEqual(accepted.paint, [live]);
  assert.equal(fold.held.length, 0);
});

test('held steered frame is preserved in paint when replay overlaps canvas', () => {
  const canvas: ReplayFoldMessage[] = [
    {
      id: 'm-visible',
      role: 'assistant',
      parts: [{ kind: 'tool', tool: { id: 'tool-visible', name: 'bash', args: '', status: 'done' } }],
    },
  ];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const fold = createReplayFold();
  const steered = seq({ type: 'steered', count: 1, inputs: [{ text: '转向提问', message_id: 's-1' }] }, 2);
  const visibleTool = seq(
    { type: 'tool_start', id: 'tool-visible', name: 'bash', arguments: {}, message_id: 'm-visible' },
    3,
  );
  assert.deepEqual(acceptReplayFrame(fold, steered, 20, onCanvas).paint, []);
  const out = acceptReplayFrame(fold, visibleTool, 20, onCanvas);
  assert.deepEqual(out.paint, [steered, visibleTool]);
});

test('长回合切回：allowAboveFoldPaint=true 且命中页内帧时，折叠线以上的旧工具与开场提问不得重播到底部', () => {
  const canvas: ReplayFoldMessage[] = [
    { id: 'u-steer-1656', role: 'user', parts: [{ kind: 'text', text: '而且他那个封号的申诉链接也复制不全' }] },
    assistant('m-visible', 'tool-visible'),
  ];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const aboveFold = (event: SSEEvent) => event.type === 'user' && event.message_id === 'u-open-1645';
  const fold = createReplayFold();
  const openUser = seq({ type: 'user', content: '继续思考', message_id: 'u-open-1645', created_at: 1_000 }, 1);
  const preFoldTool = seq(
    { type: 'tool_start', id: 'tool-early', name: 'bash', arguments: {}, message_id: 'm-early' },
    2,
  );
  const visibleTool = seq(
    { type: 'tool_start', id: 'tool-visible', name: 'bash', arguments: {}, message_id: 'm-visible' },
    3,
  );
  assert.deepEqual(acceptReplayFrame(fold, openUser, 55, onCanvas, false, aboveFold, true).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, preFoldTool, 55, onCanvas, false, aboveFold, true).paint, []);
  const overlapped = acceptReplayFrame(fold, visibleTool, 55, onCanvas, false, aboveFold, true);
  assert.deepEqual(
    overlapped.paint,
    [visibleTool],
    'pre-fold tool must be dropped once replay overlaps the visible 48-row window',
  );
  assert.deepEqual(overlapped.placeUsers, [openUser]);
});

test('长回合 after_seq 已在缓冲末尾：唯一补发的 opening_user (replay_last=true) 必须进 placeUsers 而非 paint', () => {
  const canvas: ReplayFoldMessage[] = [
    { id: 'u-steer-1656', role: 'user', parts: [{ kind: 'text', text: '而且他那个封号的申诉链接也复制不全' }] },
    assistant('m-visible', 'tool-visible'),
  ];
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const aboveFold = (event: SSEEvent) => event.type === 'user' && event.message_id === 'u-open-1645';
  const fold = createReplayFold();
  const soleOpenUser = {
    ...seq({ type: 'user', content: '继续思考', message_id: 'u-open-1645', created_at: 1_000 }, 1),
    replay: true,
    replay_last: true,
  };
  const out = acceptReplayFrame(fold, soleOpenUser, 55, onCanvas, false, aboveFold, true, true);
  assert.deepEqual(out.paint, [], 'sole replay_last opening_user must never enter paint');
  assert.deepEqual(out.placeUsers, [soleOpenUser]);
});



