import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SSEEvent } from '../api.ts';
import { acceptReplayFrame, createReplayFold, replayFrameOnCanvas, type ReplayFoldMessage } from './replayFold.ts';
import { steerInsertPosition } from './steerAnchor.ts';
import { normalizeCanvas } from './canvas/canvasStore.ts';
import { projectCanvas } from './canvas/project.ts';
import { canLoadOlder } from './turnNav.ts';
import { mergeOlderMessages, spliceAuthoritativeDiskTail } from './sessionProjection.ts';

/**
 * 断网重连四条症状的回归矩阵。每条都对应一个曾经可复现的线上故障：
 *   1. c→f 中间整段内容消失；
 *   2. 中途 steer 卡被插到工具卡中间 / 首条消息后面；
 *   3. 两套 seq 坐标系混排后，中间内容被重排到会话最前面（切会话也会复现）；
 *   4. 「向上展开」幽灵卡片：显示还有 N 条，点下去没有任何反应。
 */

const seqEv = <T extends SSEEvent>(event: T, n: number): T & { seq: number } => ({ ...event, seq: n });

const row = (id: string, role: string, seq?: number): ReplayFoldMessage & { seq?: number } => ({
  id,
  role,
  parts: [],
  ...(seq != null ? { seq } : {}),
});

test('症状 1：断线重连后，本轮尚未上屏的正文 / 工具按线序补画，不整段消失', () => {
  const canvas: ReplayFoldMessage[] = [
    {
      role: 'assistant',
      id: 'm-visible',
      parts: [{ kind: 'tool', tool: { id: 'tool-visible', name: 'Read', args: '', status: 'done' } }],
    },
  ];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);

  const user = seqEv({ type: 'user', content: '第二条提问', message_id: 'u-2' }, 1);
  const body = seqEv(
    { type: 'text', content: '断网期间从 c 渲染到 f 的正文', message_id: 'm-live', part_id: 'm-live:1:text' },
    2,
  );
  const tool = seqEv(
    { type: 'tool_start', id: 't-live', name: 'Edit', arguments: {}, message_id: 'm-live' },
    3,
  );
  const visible = seqEv(
    { type: 'tool_start', id: 'tool-visible', name: 'Read', arguments: {}, message_id: 'm-visible' },
    4,
  );

  assert.deepEqual(acceptReplayFrame(fold, user, 48, onCanvas).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, body, 48, onCanvas).paint, []);
  assert.deepEqual(acceptReplayFrame(fold, tool, 48, onCanvas).paint, []);

  const out = acceptReplayFrame(fold, visible, 48, onCanvas);
  assert.deepEqual(
    out.paint.map((frame) => frame.type),
    ['text', 'tool_start', 'tool_start'],
    '暂存区里的当前轮内容必须跟着落笔，不能因为命中页内帧就整体清空',
  );
  assert.deepEqual(out.placeUsers, [user], '被页切掉的提问仍然插回这一轮开头');
  assert.equal(fold.held.length, 0);
});

test('症状 2：中途 steer 绝不插进同一批工具卡中间', () => {
  const run = [row('q', 'user'), row('a1', 'assistant'), row('a2', 'assistant')];
  // 锚点命中 a1，但它后面还跟着 a2（同一批工具的第二个 round）→ 必须追加到尾部
  assert.equal(steerInsertPosition(run, { messageId: 'a1' }, true), -1);
  // 非回放（发送端自己）同样只追加
  assert.equal(steerInsertPosition(run, { messageId: 'a1' }, false), -1);
  // 锚点之后没有助手内容时，才允许插回中间
  assert.equal(
    steerInsertPosition([row('q', 'user'), row('a1', 'assistant'), row('n', 'system')], { messageId: 'a1' }, true),
    2,
  );
});

test('症状 3：两套 seq 坐标系混排后，中间内容不会被重排到最前面', () => {
  // 磁盘行 DisplayRecord.seq = 1200+；本地直播 / 转向行是本地自增的小值。
  const mixed = normalizeCanvas([
    { id: 'disk-u', role: 'user', seq: 1200 },
    { id: 'disk-a', role: 'assistant', seq: 1201 },
    { id: 'steer', role: 'user', seq: 2 },
    { id: 'live-a', role: 'assistant', seq: 3 },
  ]);
  assert.deepEqual(
    projectCanvas(mixed).map((message) => message.id),
    ['disk-u', 'disk-a', 'steer', 'live-a'],
    '渲染顺序只认数组因果序，seq 不再参与重排',
  );
});

test('症状 3b：向上翻页合并更早历史时，只插入新页，不重排已有画布', () => {
  // 画布头部是真实磁盘 seq（1200+），尾部是本地坐标系的直播 / 转向行（个位数）。
  // 旧实现会因“键不是严格递增”走整表重排，把尾部行端到最前面。
  const prev = [
    { id: 'disk-u', role: 'user', seq: 1200, sourceIndex: 48 },
    { id: 'disk-a', role: 'assistant', seq: 1201, sourceIndex: 49 },
    { id: 'steer', role: 'user', seq: 2 },
    { id: 'live-a', role: 'assistant', seq: 3 },
  ];
  const older = [
    { id: 'old-u', role: 'user', seq: 1100, sourceIndex: 46 },
    { id: 'old-a', role: 'assistant', seq: 1101, sourceIndex: 47 },
  ];
  assert.deepEqual(
    mergeOlderMessages(prev, older).map((message) => message.id),
    ['old-u', 'old-a', 'disk-u', 'disk-a', 'steer', 'live-a'],
  );
});

test('症状 5：长回合（工具输出需要翻页）切会话，钉住的提问不会被再次追加到底部', () => {
  // 形状取自真实大会话：48 行窗口 offset=2387，服务端把当前提问钉在切片头部
  // （sourceIndex < offset）。画布上它还有一份本地副本（只有 clientInputId）。
  // 旧实现只按 `id` 去重 → 本地副本被当成未落盘尾巴追加到末尾 →
  // 底部多出一条提问 + 假 Working，新正文继续在它下面渲染。
  const diskOffset = 2387;
  const tool = { kind: 'tool' as const, tool: { id: 't1', name: 'Bash', args: '', status: 'done' } };
  const diskTail = [
    { role: 'user', id: 'req-1', sourceIndex: 2380 },
    { role: 'assistant', id: 'm-a1', sourceIndex: diskOffset },
    { role: 'assistant', id: 'm-a2', sourceIndex: diskOffset + 1, parts: [tool] },
  ];
  const canvas = [
    { role: 'assistant', id: 'm-a1', sourceIndex: diskOffset },
    { role: 'assistant', id: 'm-a2', sourceIndex: diskOffset + 1, parts: [tool] },
    { role: 'user', clientInputId: 'req-1', parts: [{ kind: 'text' as const, text: '那你把你介意的全都补上' }] },
  ];
  const merged = spliceAuthoritativeDiskTail(canvas, diskTail, diskOffset);
  assert.equal(
    merged.filter((row) => row.role === 'user').length,
    1,
    '同一条提问（同一个 clientInputId）不得在头部与底部各留一份',
  );
  assert.notEqual(merged[merged.length - 1]?.role, 'user', '最新提问不应被挪到时间线最底部');
});

test('症状 4：到顶后不再提供点不开的「向上展开」入口', () => {
  // 到顶：offset 归零且首行没有可用 seq → 不可点，按钮不应渲染
  assert.equal(canLoadOlder({ hasOlder: true, offset: 0, headSeq: undefined }), false);
  // offset 归零但首行带服务端 seq：仍然可以真正往前翻
  assert.equal(canLoadOlder({ hasOlder: true, offset: 0, headSeq: 1200 }), true);
  // 正常分页
  assert.equal(canLoadOlder({ hasOlder: true, offset: 96, headSeq: 1200 }), true);
  // 服务端已判定没有更早历史
  assert.equal(canLoadOlder({ hasOlder: false, offset: 96, headSeq: 1200 }), false);
});
