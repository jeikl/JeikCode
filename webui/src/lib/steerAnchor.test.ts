import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSteerPaint, steerInsertPosition } from './steerAnchor.ts';
import { normalizeCanvas } from './canvas/canvasStore.ts';
import { projectCanvas } from './canvas/project.ts';

const user = (id: string) => ({ id, role: 'user', parts: [] });
const assistant = (id: string, seq?: number) => ({
  id,
  role: 'assistant',
  parts: [],
  ...(seq != null ? { seq } : {}),
});
const notice = (id: string) => ({ id, role: 'system', parts: [] });

test('混用两套 seq 坐标系时，转向行不会被重排到会话最前面', () => {
  // 磁盘行是 DisplayRecord.seq（上千），直播 / 转向行是本地自增值（个位数）。
  // 排序权威只认数组因果序，因此转向卡必须留在它被插入的位置。
  const rows = normalizeCanvas([
    { id: 'disk-u', role: 'user', seq: 1200 },
    { id: 'disk-a', role: 'assistant', seq: 1201 },
    { id: 'steer', role: 'user', seq: 2 },
    { id: 'live-a', role: 'assistant', seq: 3 },
  ]);
  assert.deepEqual(
    projectCanvas(rows).map((row) => row.id),
    ['disk-u', 'disk-a', 'steer', 'live-a'],
  );
});

test('回放补回的转向：锚点之后没有助手或用户行时才插回中间', () => {
  const rows = [user('q'), assistant('a1'), notice('notice')];
  assert.equal(steerInsertPosition(rows, { messageId: 'a1' }, true), 2);
  assert.equal(
    steerInsertPosition([user('q'), assistant('a1'), user('later')], { messageId: 'a1' }, true),
    -1,
    'never insert an earlier steer ahead of a later user row',
  );
});

test('权威服务端锚点允许在其后已有行时按真实 fold 位置插入', () => {
  const rows = [user('q'), assistant('a1'), user('later'), assistant('a2')];
  assert.equal(
    steerInsertPosition(rows, { messageId: 'a1', authoritative: true }, true),
    2,
  );
  assert.equal(
    steerInsertPosition(rows, { messageId: 'a1', authoritative: true }, false),
    2,
    'server anchor is valid for live events too',
  );
});

test('权威锚点不在当前窗口时必须延迟落笔，绝不追加到尾部', () => {
  // B 端刷新/中途进入只加载了尾窗，锚点（较早的助手行）不在窗口内：这条转向
  // 属于切片之上，画布不能画；队列卡由调用方消费，位置交给磁盘/服务端大纲。
  const rows = [user('q'), assistant('a2')];
  assert.deepEqual(
    decideSteerPaint(rows, { messageId: 'above-fold', authoritative: true }, true),
    { at: -1, defer: true },
  );
  // 权威锚点在窗口内：按真实 fold 位置插入。
  assert.deepEqual(
    decideSteerPaint(rows, { messageId: 'a2', authoritative: true }, true),
    { at: 2, defer: false },
  );
  // 老协议/无锚点仍保持尾部追加语义，不受新契约影响。
  assert.equal(decideSteerPaint(rows, { messageId: 'missing' }, true).defer, false);
  assert.equal(decideSteerPaint(rows, undefined, true).defer, false);
});

test('deferred steer becomes paint-ready once the anchor assistant row arrives', () => {
  const anchor = { messageId: 'as2', authoritative: true as const };
  assert.deepEqual(decideSteerPaint([user('q')], anchor, true), { at: -1, defer: true });
  assert.deepEqual(decideSteerPaint([user('q'), assistant('as2')], anchor, true), {
    at: 2,
    defer: false,
  });
});

test('锚点后面还跟着同一批工具卡时，绝不插到中间（否则 Read/Read 被劈开）', () => {
  const rows = [user('q'), assistant('a1'), assistant('a2')];
  assert.equal(
    steerInsertPosition(rows, { messageId: 'a1' }, true),
    -1,
    'a later assistant row means the steer would split one contiguous block',
  );
  assert.equal(steerInsertPosition(rows, { toolId: 'read-1' }, true), -1);
});

test('锚点未命中 / 非回放路径一律追加到尾部', () => {
  assert.equal(steerInsertPosition([user('q'), assistant('a1')], undefined, true), -1);
  assert.equal(steerInsertPosition([user('q'), assistant('a1')], { messageId: 'missing' }, true), -1);
  assert.equal(steerInsertPosition([user('q'), assistant('a1')], { messageId: 'a1' }, false), -1);
});

test('index 为 -1 的追加不会把空占位行留在尾部', () => {
  // append 分支由调用方 pop 掉尾部空 assistant 占位；这里只锁定纯函数的边界语义。
  const rows = [user('q'), assistant('a1')];
  const at = steerInsertPosition(rows, undefined, true);
  assert.equal(at, -1);
  assert.equal(rows.length, 2);
});
