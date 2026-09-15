import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToHtml } from './markdownRender.ts';

test('GitHub alerts become classed blockquotes', () => {
  const note = markdownToHtml('> [!NOTE]\n> hello');
  assert.match(note, /md-alert md-alert-note/);
  assert.match(note, /md-alert-title/);
  assert.match(note, /hello/);

  const warn = markdownToHtml('> [!WARNING] be careful');
  assert.match(warn, /md-alert-warning/);
  assert.match(warn, /be careful/);
});

test('code fence language sentinel is stripped and generic lang is hidden', () => {
  const out = markdownToHtml('```text\ntext\nBase URL: http://127.0.0.1:8045\n```');
  assert.match(out, /Base URL: http:\/\/127\.0\.0\.1:8045/);
  assert.doesNotMatch(out, /<code[^>]*>text\nBase URL/);
  assert.doesNotMatch(out, /<span class="code-block-lang">text<\/span>/);
});

test('named language gets a toolbar label', () => {
  const out = markdownToHtml('```ts\nconst n = 1;\n```');
  assert.match(out, /<span class="code-block-lang">ts<\/span>/);
  assert.match(out, /const n = 1;/);
});

test('two indented ```text fences in one numbered list both render', () => {
  const content = [
    '已通过并发工具调用同时并行执行了两个 Hello World 任务：',
    '',
    '1. **任务 1** 输出：',
    '   ```text',
    '   Hello World 1',
    '   ```',
    '',
    '2. **任务 2** 输出：',
    '   ```text',
    '   Hello World 2',
    '   ```',
    '',
    '两个任务已在单轮中并行派发并成功完成。',
  ].join('\n');
  const out = markdownToHtml(content);
  assert.match(out, /Hello World 1/);
  assert.match(out, /Hello World 2/);
  assert.equal((out.match(/code-block-wrapper/g) ?? []).length, 2);
  assert.doesNotMatch(out, /<p>[^<]*```/);
});
