import { test } from 'node:test';
import assert from 'node:assert';
import {
  formatUserMessageWithAttachments,
  isImageFile,
  countPending,
} from './attachments.ts';

test('formatUserMessageWithAttachments appends numbered absolute paths', () => {
  assert.equal(
    formatUserMessageWithAttachments('请看这个', ['E:/proj/.jeikcode_store/a.pdf', 'E:/proj/.jeikcode_store/b.txt']),
    '请看这个\n\n附件1：E:/proj/.jeikcode_store/a.pdf\n附件2：E:/proj/.jeikcode_store/b.txt',
  );
});

test('formatUserMessageWithAttachments works with empty prompt', () => {
  assert.equal(
    formatUserMessageWithAttachments('  ', ['D:/store/a.csv']),
    '附件1：D:/store/a.csv',
  );
});

test('formatUserMessageWithAttachments is a no-op without paths', () => {
  assert.equal(formatUserMessageWithAttachments('hello', []), 'hello');
});

test('isImageFile uses mime type and common extensions', () => {
  assert.equal(isImageFile(new File(['x'], 'a.png', { type: 'image/png' })), true);
  assert.equal(isImageFile(new File(['x'], 'photo.jpg', { type: '' })), true);
  assert.equal(isImageFile(new File(['x'], 'notes.pdf', { type: 'application/pdf' })), false);
  assert.equal(isImageFile(new File(['x'], 'notes.txt', { type: '' })), false);
});

test('countPending splits images and files', () => {
  const counts = countPending([
    { id: '1', kind: 'image', image: { media_type: 'image/png', data: 'QQ==' } },
    { id: '2', kind: 'file', name: 'a.pdf', size: 12, file: new File(['x'], 'a.pdf') },
    { id: '3', kind: 'file', name: 'b.txt', size: 4, file: new File(['y'], 'b.txt') },
  ]);
  assert.deepEqual(counts, { images: 1, files: 2 });
});
