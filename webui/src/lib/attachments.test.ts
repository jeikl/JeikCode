import { test } from 'node:test';
import assert from 'node:assert';
import {
  formatUserMessageWithAttachments,
  isImageFile,
  countPending,
  calculateScaleDimensions,
  normalizeMimeType,
  MAX_IMAGE_MB,
  MAX_IMAGE_DIMENSION,
  MAX_PANORAMA_DIMENSION,
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

test('isImageFile uses mime type, parameters, and common extensions (including HEIC)', () => {
  assert.equal(isImageFile(new File(['x'], 'a.png', { type: 'image/png' })), true);
  assert.equal(isImageFile(new File(['x'], 'a.png', { type: 'image/png; charset=utf-8' })), true);
  assert.equal(isImageFile(new File(['x'], 'photo.jpg', { type: '' })), true);
  assert.equal(isImageFile(new File(['x'], 'shot.heic', { type: 'image/heic' })), true);
  assert.equal(isImageFile(new File(['x'], 'raw.heif', { type: '' })), true);
  assert.equal(isImageFile(new File(['x'], 'notes.pdf', { type: 'application/pdf' })), false);
  assert.equal(isImageFile(new File(['x'], 'notes.txt', { type: '' })), false);
});

test('normalizeMimeType strips parameters and lowercase', () => {
  assert.equal(normalizeMimeType('image/png; charset=utf-8'), 'image/png');
  assert.equal(normalizeMimeType('IMAGE/JPEG '), 'image/jpeg');
  assert.equal(normalizeMimeType(''), '');
});

test('MAX_IMAGE_MB is upgraded to 8MB', () => {
  assert.equal(MAX_IMAGE_MB, 8);
});

test('calculateScaleDimensions preserves strict aspect ratio without distortion', () => {
  // 1. 普通小图无需缩放
  const small = calculateScaleDimensions(1200, 800);
  assert.deepEqual(small, { width: 1200, height: 800 });

  // 2. 手机常见 19.5:9 竖屏截图 (如 iPhone 14/15/16 Pro: 1290 x 2796)
  const phone = calculateScaleDimensions(1290, 2796);
  assert.equal(phone.height, MAX_IMAGE_DIMENSION); // 2560
  // 验证纵横比一致性 (容差小于 0.001)
  const origRatio = 1290 / 2796;
  const scaledRatio = phone.width / phone.height;
  assert.ok(Math.abs(origRatio - scaledRatio) < 0.001, `Ratio mismatch: ${origRatio} vs ${scaledRatio}`);

  // 3. 超长网页滚屏截图 (如 1080 x 8000, 纵横比 > 2.5:1) 放宽至 MAX_PANORAMA_DIMENSION (4096)
  const longScroll = calculateScaleDimensions(1080, 8000);
  assert.equal(longScroll.height, MAX_PANORAMA_DIMENSION);
  const origLongRatio = 1080 / 8000;
  const scaledLongRatio = longScroll.width / longScroll.height;
  assert.ok(Math.abs(origLongRatio - scaledLongRatio) < 0.001, `Ratio mismatch: ${origLongRatio} vs ${scaledLongRatio}`);
});

test('countPending splits images and files', () => {
  const counts = countPending([
    { id: '1', kind: 'image', image: { media_type: 'image/png', data: 'QQ==' } },
    { id: '2', kind: 'file', name: 'a.pdf', size: 12, file: new File(['x'], 'a.pdf') },
    { id: '3', kind: 'file', name: 'b.txt', size: 4, file: new File(['y'], 'b.txt') },
  ]);
  assert.deepEqual(counts, { images: 1, files: 2 });
});
