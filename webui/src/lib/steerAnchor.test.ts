import test from 'node:test';
import assert from 'node:assert/strict';
import { steerInsertPosition } from './steerAnchor.ts';
import { normalizeCanvas } from './canvas/canvasStore.ts';
import { projectCanvas } from './canvas/project.ts';

const user = (id: string) => ({ id, role: 'user', parts: [] });
const assistant = (id: string, seq?: number) => ({
  id,
  role: 'assistant',
  parts: [],
  ...(seq != null ? { seq } : {}),
});

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

test('回放补回的转向：锚点之后没有助手行时才插回中间', () => {
  const rows = [user('q'), assistant('a1'), user('notify')];
  assert.equal(steerInsertPosition(rows, { messageId: 'a1' }, true), 2);
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
