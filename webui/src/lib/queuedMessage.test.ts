import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSendNowSteerAction } from './queuedMessage.ts';

test('未投递的排队卡：立即发送先交给服务端裁决能不能转向', () => {
  assert.equal(resolveSendNowSteerAction({ kind: 'queue', folded: false }), 'steer');
});

test('已点过转向的卡片：必须先撤销排队转向，再作为新回合发出', () => {
  // 回归：steer 卡再次点「立即发送」曾直接重发 /chat/steer 并 return，
  // 表现为点了没反应（消息发不出去）。
  assert.equal(resolveSendNowSteerAction({ kind: 'steer', folded: false }), 'promote');
  assert.equal(resolveSendNowSteerAction({ kind: 'steering', folded: false }), 'promote');
});

test('已经并入正文的转向卡：只回收卡片，绝不重复投递', () => {
  for (const kind of ['queue', 'steering', 'steer'] as const) {
    assert.equal(resolveSendNowSteerAction({ kind, folded: true }), 'retire');
  }
});
