import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeLiveSteers,
  dropFoldedQueuedCards,
  pendingSteersToDraft,
  resolveLingeringSteers,
} from './liveSteer.ts';

test('acknowledgeLiveSteers consumes only matching client ids', () => {
  const pending = [
    { id: 'one-id', text: 'one', confirmed: true },
    { id: 'two-id', text: 'two', images: [{ media_type: 'image/png', data: 'abc' }], confirmed: true },
  ];

  assert.deepEqual(
    acknowledgeLiveSteers(pending, [{ text: 'peer input', images: [] }]),
    pending,
  );
  assert.deepEqual(
    acknowledgeLiveSteers(
      pending,
      [{ text: 'VL-preprocessed text', images: [] }],
      ['one-id'],
    ),
    [pending[1]],
  );
  // 没有关联键的回执不再按文本认领，卡片必须保留。
  assert.deepEqual(acknowledgeLiveSteers(pending, [{ text: 'one', images: [] }]), pending);
  assert.deepEqual(
    acknowledgeLiveSteers(pending, [
      { text: 'one', images: [] },
      { text: 'two', images: [{ media_type: 'image/png', data: 'abc' }] },
    ]),
    pending,
  );
});

test('pendingSteersToDraft preserves text and image order', () => {
  assert.deepEqual(
    pendingSteersToDraft([
      { id: 'first-id', text: 'first', confirmed: true },
      { id: 'second-id', text: 'second', images: [{ media_type: 'image/jpeg', data: 'xyz' }], confirmed: true },
    ]),
    {
      text: 'first\nsecond',
      images: [{ media_type: 'image/jpeg', data: 'xyz' }],
    },
  );
});

// 跨端广播“转向已被内核消费”：必须在收到广播的实例里删掉同一张卡，
// 否则切过去 / 刷新时它会复活成一张还会被 drain 的待发卡片。
test('dropFoldedQueuedCards 按关联键销毁转向卡', () => {
  const keep = { id: 1, text: '排队中的后续问题', kind: 'queue' };
  const steerByText = {
    id: 2,
    text: '接下来帮我干xxx',
    kind: 'steer',
    clientInputId: 'web-1',
    createdAt: 1_000,
  };
  const steerById = {
    id: 3,
    text: '点转向发出的另一条',
    kind: 'steering' as const,
    clientInputId: 'web-2',
  };
  const imageOnly = {
    id: 4,
    text: '',
    kind: 'steer' as const,
    clientInputId: 'web-3',
    images: [{ media_type: 'image/png', data: 'img' }],
  };
  const queue = [keep, steerByText, steerById, imageOnly];

  const afterText = dropFoldedQueuedCards(
    queue,
    [{ text: '<user-query>\n接下来帮我干xxx\n</user-query>\n\n[jeikcode-steer]\nguidelines', images: [] }],
    ['web-1'],
  );
  assert.deepEqual(afterText.map((item) => item.id), [1, 3, 4]);

  const afterId = dropFoldedQueuedCards(afterText, [{ text: 'VL 改写后的文本', images: [] }], ['web-2']);
  assert.deepEqual(afterId.map((item) => item.id), [1, 4]);

  const afterImage = dropFoldedQueuedCards(afterId, [
    { text: '', images: [{ media_type: 'image/png', data: 'img' }] },
  ], ['web-3']);
  assert.deepEqual(afterImage.map((item) => item.id), [1]);

  // 未命中任何卡片：返回原数组（调用方据此跳过存储写入）。
  assert.equal(dropFoldedQueuedCards(afterImage, [{ text: '没有这张卡', images: [] }]), afterImage);
});

// 「自然发出」：上一轮 done 后内核把残留转向落成新一轮；本端如果同时把它改回
// queue 再 drain，就是用一次 POST 去抢占/重启那一轮（同一条回答跑两遍）。
test('resolveLingeringSteers：已发出的转向卡销毁，真没被消费的才降级排队', () => {
  const steer = { id: 1, text: '改为 sqlite', kind: 'steer' as const };
  const steering = { id: 2, text: '立即发送的那条', kind: 'steering' as const };
  const plainQueued = { id: 3, text: '普通排队', kind: 'queue' as const };
  const cards = [plainQueued, steer, steering];

  // 会话重新在跑 = 内核已把它落成新一轮 → 两个转向卡都销毁，普通排队不动。
  assert.deepEqual(
    resolveLingeringSteers(cards, true, () => false).map((item) => item.id),
    [3],
  );
  // 会话空闲，但气泡已在画布上 → 同样视为已消费。
  assert.deepEqual(
    resolveLingeringSteers(cards, false, (item) => item.id !== 2).map((item) => item.id),
    [3, 2],
  );
  // 会话空闲且什么都没发生 → 降级为普通排队卡，绝不默默丢掉。
  assert.deepEqual(
    resolveLingeringSteers(cards, false, () => false).map((item) => [item.id, item.kind]),
    [[3, 'queue'], [1, 'queue'], [2, 'queue']],
  );
  // 没有转向卡：原数组返回（调用方据此跳过存储写入）。
  const untouched = [plainQueued];
  assert.equal(resolveLingeringSteers(untouched, false, () => false), untouched);
});
