import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMath, looksLikeCurrency } from './markdownMath.ts';
import { markdownToHtml } from './markdownRender.ts';

test('looksLikeCurrency rejects $100-style amounts but preserves numeric TeX formulas', () => {
  assert.equal(looksLikeCurrency('100'), true);
  assert.equal(looksLikeCurrency('1,299.00'), true);
  assert.equal(looksLikeCurrency('50k'), true);
  assert.equal(looksLikeCurrency('100万'), true);
  assert.equal(looksLikeCurrency('x=1'), false);
  assert.equal(looksLikeCurrency('3 \\times 72 = 216'), false);
  assert.equal(looksLikeCurrency('1 + 1 = 2'), false);
  assert.equal(looksLikeCurrency('10^5'), false);
  assert.equal(looksLikeCurrency('2x'), false);
});

test('extractMath keeps $$ formulas and skips fenced code', () => {
  const md = [
    '价格 $100 不是公式',
    '$$\\text{发布时间}=t-r$$',
    '',
    '```ts',
    'const n = $foo$',
    '```',
    '',
    '行内 $a+b$',
  ].join('\n');
  const { text, slots } = extractMath(md);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].display, true);
  assert.match(slots[0].tex, /发布时间/);
  assert.equal(slots[1].display, false);
  assert.equal(slots[1].tex, 'a+b');
  assert.match(text, /const n = \$foo\$/);
  assert.match(text, /价格 \$100/);
});

test('SEO-style $$ formula with \\text and \\sim renders via KaTeX', () => {
  const md =
    '改为**“向过去递减”**： $$\\text{文章发布时间} = \\text{当前实际时间} - \\text{随机分钟}(0\\sim59\\text{分}) - \\text{随机秒数}(0\\sim59\\text{秒})$$';
  const html = markdownToHtml(md);
  assert.match(html, /katex/);
  assert.match(html, /文章发布时间/);
  assert.doesNotMatch(html, /\$\$/);
  assert.match(html, /<strong>/);
});

test('inline $x^2$ renders and currency stays literal', () => {
  const html = markdownToHtml('面积 $x^2$ 约 $100。');
  assert.match(html, /katex/);
  assert.match(html, /\$100/);
});

test('inline numeric-prefixed formulas like $3 \\times 72 = 216$ render via KaTeX', () => {
  const html = markdownToHtml('时有 $3 \\times 72 = 216$ 个计算线程');
  assert.match(html, /katex/);
  assert.doesNotMatch(html, /\$3 \\times 72 = 216\$/);
});

test('unclosed or cross-paragraph backticks do not swallow subsequent LaTeX formulas', () => {
  const md = [
    '正文的 `` 标记（未在当前段闭合）',
    '',
    '### 三、总结',
    '',
    '1. 思考文本：通过 `thought: true` $\\rightleftharpoons$ `` 正文 的管道',
    '2. 防伪签名：$\\succ$ 官方哨兵',
  ].join('\n');

  const html = markdownToHtml(md);
  // 必须成功渲染双向鱼叉箭头 ⇌ (rightleftharpoons) 和偏序符号 ≻ (succ)
  assert.match(html, /⇌/);
  assert.match(html, /≻/);
  assert.doesNotMatch(html, /\$\\rightleftharpoons\$/);
  assert.doesNotMatch(html, /\$\\succ\$/);
});

