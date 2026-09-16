import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCopyHtml,
  collectClipboardFiles,
  dataUrlToFile,
  extractDataUrlImagesFromHtml,
  imageToDataUrl,
} from './clipboard.ts';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('imageToDataUrl prefixes media type and base64', () => {
  assert.equal(
    imageToDataUrl({ media_type: 'image/png', data: PNG_1X1 }),
    `data:image/png;base64,${PNG_1X1}`,
  );
});

test('buildCopyHtml embeds data URL image and escapes text', () => {
  const html = buildCopyHtml(`data:image/png;base64,${PNG_1X1}`, '这是<a>\n第二行');
  assert.match(html, new RegExp(`src="data:image/png;base64,${PNG_1X1}"`));
  assert.match(html, /这是&lt;a&gt;<br>第二行/);
  assert.doesNotMatch(html, /<a>/);
});

test('dataUrlToFile round-trips a tiny png', () => {
  const file = dataUrlToFile(`data:image/png;base64,${PNG_1X1}`, 'shot');
  assert.ok(file);
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'shot.png');
  assert.ok(file.size > 0);
});

test('extractDataUrlImagesFromHtml recovers img src data URLs', () => {
  const html = buildCopyHtml(`data:image/png;base64,${PNG_1X1}`, 'hello');
  const files = extractDataUrlImagesFromHtml(html);
  assert.equal(files.length, 1);
  assert.equal(files[0].type, 'image/png');
});

test('extractDataUrlImagesFromHtml ignores non-image and http srcs', () => {
  const html =
    '<img src="https://example.com/a.png"><img src="data:text/plain;base64,YQ==">';
  assert.deepEqual(extractDataUrlImagesFromHtml(html), []);
});

test('collectClipboardFiles prefers native file items over html', () => {
  const native = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
  const dt = {
    items: [
      {
        kind: 'file',
        getAsFile: () => native,
      },
    ],
    getData: () => buildCopyHtml(`data:image/png;base64,${PNG_1X1}`, 'x'),
  } as unknown as DataTransfer;
  const files = collectClipboardFiles(dt);
  assert.equal(files.length, 1);
  assert.equal(files[0], native);
});

test('collectClipboardFiles falls back to html data URLs', () => {
  const dt = {
    items: [],
    getData: (type: string) =>
      type === 'text/html' ? buildCopyHtml(`data:image/png;base64,${PNG_1X1}`, '这是') : '',
  } as unknown as DataTransfer;
  const files = collectClipboardFiles(dt);
  assert.equal(files.length, 1);
  assert.equal(files[0].type, 'image/png');
});
