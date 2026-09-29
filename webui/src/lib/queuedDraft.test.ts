import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeQueuedIntoDraft } from './queuedDraft.ts';

test('mergeQueuedIntoDraft keeps queue order ahead of the current draft', () => {
  const merged = mergeQueuedIntoDraft(
    [
      { text: 'first', images: [{ media_type: 'image/png', data: 'a' }] },
      { text: 'second', images: [{ media_type: 'image/png', data: 'b' }] },
    ],
    'draft',
    [{ media_type: 'image/jpeg', data: 'd' }],
  );
  assert.equal(merged.text, 'first\nsecond\ndraft');
  assert.deepEqual(merged.images.map((image) => image.data), ['d', 'a', 'b']);
});

test('mergeQueuedIntoDraft ignores blank queued text but keeps its images', () => {
  const merged = mergeQueuedIntoDraft(
    [{ text: '   ', images: [{ media_type: 'image/png', data: 'only' }] }],
    '',
    [],
  );
  assert.equal(merged.text, '');
  assert.equal(merged.images.length, 1);
});
