import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCanvas } from './project.ts';

test('projectCanvas returns the same reference for an already canonical canvas', () => {
  const rows = [
    { id: 'a', role: 'user', kind: 'user', seq: 1 },
    { id: 'b', role: 'assistant', kind: 'model', seq: 2 },
  ];
  assert.equal(projectCanvas(rows), rows);
});

test('projectCanvas never reorders: 数组顺序就是因果顺序', () => {
  // 两套 seq 坐标系（磁盘 DisplayRecord.seq 上千 / 本地直播行从 0 自增）拼在一起时，
  // 按 seq 排序会把中间一段正文和 steer 卡端到最前面。
  const rows = [
    { id: 'b', role: 'assistant', seq: 9, sourceIndex: 2 },
    { id: 'a', role: 'user', seq: 3, sourceIndex: 99 },
  ];
  assert.equal(projectCanvas(rows), rows);
  assert.deepEqual(projectCanvas(rows).map((row) => row.id), ['b', 'a']);
});

test('projectCanvas keeps keyless live rows at their array position', () => {
  const rows = [
    { id: 'live', role: 'assistant' },
    { id: 'a', role: 'user', seq: 1 },
  ];
  assert.equal(projectCanvas(rows), rows);
  assert.deepEqual(projectCanvas(rows).map((row) => row.id), ['live', 'a']);
});
