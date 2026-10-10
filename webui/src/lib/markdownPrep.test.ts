import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marked } from 'marked';
import {
  buildTableDelimiter,
  isTableDelimiterLine,
  preprocessMarkdown,
  splitTableCells,
  stripLanguageSentinel,
} from './markdownPrep.ts';
import { markdownToHtml } from './markdownRender.ts';

marked.setOptions({ gfm: true, breaks: false });
marked.use({ tokenizer: { del: () => undefined } });

function html(markdown: string): string {
  return marked.parse(preprocessMarkdown(markdown)) as string;
}

test('splitTableCells drops wrapping pipes and keeps escaped pipes', () => {
  assert.deepEqual(splitTableCells('| 目标 | 协议 |'), ['目标', '协议']);
  assert.deepEqual(splitTableCells('|---|'), ['---']);
  assert.deepEqual(splitTableCells('| a \\| b | c |'), ['a | b', 'c']);
});

test('isTableDelimiterLine accepts one-column |---|', () => {
  assert.equal(isTableDelimiterLine('|---|'), true);
  assert.equal(isTableDelimiterLine('|---|---|'), true);
  assert.equal(isTableDelimiterLine('| 目标 | 协议 |'), false);
  assert.equal(isTableDelimiterLine('---'), true);
});

test('buildTableDelimiter pads to header width and keeps alignment', () => {
  assert.equal(buildTableDelimiter(2, ['---']), '| --- | --- |');
  assert.equal(buildTableDelimiter(2, [':---', '---:']), '| :--- | ---: |');
});

test('screenshot-like 2-col header with 1-col delimiter renders as a table', () => {
  const markdown = [
    '## 怎么选',
    '| 目标 | 协议 |',
    '|---|',
    '| 思考完整回传 + 多轮签名不断 | Gemini |',
    '| Claude Code /ic SDK |ic  /v1/  |',
    '| Cherry Studio / 通用 OpenAI 客户端，不在乎思考链 | OpenAI |',
    '客户端配置示例:',
  ].join('\n');
  const out = html(markdown);
  assert.match(out, /<table>/);
  assert.match(out, /<th>目标<\/th>/);
  assert.match(out, /<th>协议<\/th>/);
  assert.match(out, /<td>Gemini<\/td>/);
  assert.match(out, /<p>客户端配置示例:/);
  assert.doesNotMatch(out, /<td>客户端配置示例:/);
});

test('well-formed GFM table still renders and does not swallow following prose', () => {
  const out = html('| 目标 | 协议 |\n|---|---|\n| a | b |\n客户端配置示例:');
  assert.match(out, /<table>/);
  assert.match(out, /<td>a<\/td>/);
  assert.match(out, /<p>客户端配置示例:/);
});

test('missing delimiter between two pipe rows is inserted', () => {
  const out = html('| 目标 | 协议 |\n| a | Gemini |\n后面的话');
  assert.match(out, /<table>/);
  assert.match(out, /<td>Gemini<\/td>/);
  assert.match(out, /<p>后面的话<\/p>/);
});

test('bare --- under a pipe header becomes a table delimiter instead of setext', () => {
  const out = html('| A | B |\n---\n| x | y |');
  assert.match(out, /<table>/);
  assert.match(out, /<td>x<\/td>/);
  assert.doesNotMatch(out, /<h2>/);
});

test('ordinary setext heading is preserved', () => {
  const out = html('Heading\n---\nbody');
  assert.match(out, /<h2.*>Heading<\/h2>/);
});

test('prose containing a pipe plus --- stays a setext heading', () => {
  const out = html('run foo | grep bar\n---\nbody');
  assert.match(out, /<h2.*>run foo \| grep bar<\/h2>/);
  assert.doesNotMatch(out, /<table>/);
});

test('fullwidth pipes are normalized into a table', () => {
  const out = html('| 左 ｜ 右 |\n| --- ｜ --- |\n| a ｜ b |');
  assert.match(out, /<table>/);
  assert.match(out, /<th>左<\/th>/);
  assert.match(out, /<td>a<\/td>/);
});

test('tables inside fenced code are not rewritten', () => {
  const markdown = ['```markdown', '| A | B |', '|---|', '| x | y |', '```'].join('\n');
  const prepared = preprocessMarkdown(markdown);
  assert.match(prepared, /\|---\|/);
  const out = html(markdown);
  assert.doesNotMatch(out, /<table>/);
  assert.match(out, /<pre><code/);
});

test('heading without space after hashes is repaired', () => {
  const out = html('###怎么选\nhello');
  assert.match(out, /<h3.*>怎么选<\/h3>/);
});

test('unclosed fence is closed so trailing prose stays in the code block', () => {
  const out = html('intro\n```ts\nconst x = 1;');
  assert.match(out, /<pre><code class="language-ts">[\s\S]*const x = 1;/);
  assert.doesNotMatch(out, /<p>const x = 1;/);
});

test('==highlight== and footnotes render outside code', () => {
  const out = html('see ==hot== and a note[^1]\n\n[^1]: extra detail');
  assert.match(out, /<mark class="md-highlight">hot<\/mark>/);
  assert.match(out, /<sup class="md-footnote-ref">/);
  assert.match(out, /id="md-fn-/);
  assert.match(out, /extra detail/);
});

test('highlight and footnote syntax inside inline code stay literal', () => {
  const out = html('use `==hot==` and `[^1]`');
  assert.match(out, /<code>==hot==<\/code>/);
  assert.match(out, /<code>\[\^1\]<\/code>/);
});

test('tilde ranges are not turned into strikethrough', () => {
  const out = html('步骤 1~3 然后 4~7');
  assert.match(out, /步骤 1~3 然后 4~7/);
  assert.doesNotMatch(out, /<del>/);
});

test('Chinese curly quotes inside **bold** render as strong, not literal asterisks', () => {
  const md =
    '中出现的**“未点击审核却自动发布”**以及**“发布时间超前于当前真实时间”**的现象，是由于系统现行的**SEO文章自动发布机制与拟人化时间规则**所导致的';
  const out = html(md);
  assert.match(out, /<strong>“未点击审核却自动发布”<\/strong>/);
  assert.match(out, /<strong>“发布时间超前于当前真实时间”<\/strong>/);
  assert.match(out, /<strong>SEO文章自动发布机制与拟人化时间规则<\/strong>/);
  assert.doesNotMatch(out, /\*\*[“”]/);
  assert.doesNotMatch(out, /[“”]\*\*/);
});

test('spaced CJK corner brackets still bold via normal marked path', () => {
  const out = html('配置有 **「设置发布频率」** 功能');
  assert.match(out, /<strong>「设置发布频率」<\/strong>/);
  assert.doesNotMatch(out, /\*\*/);
});

test('CJK-quote bold repair leaves inline code untouched', () => {
  const out = html('用 `**“字面量”**` 表示');
  assert.match(out, /<code>\*\*“字面量”\*\*<\/code>/);
});

test('task list checkboxes survive', () => {
  const out = html('- [ ] todo\n- [x] done');
  assert.match(out, /<input disabled="" type="checkbox">/);
  assert.match(out, /checked=""/);
});

test('stripLanguageSentinel drops a duplicated text first line', () => {
  assert.equal(stripLanguageSentinel('text\nBase URL: 1\n', 'text'), 'Base URL: 1\n');
  assert.equal(stripLanguageSentinel('text\nBase URL: 1', ''), 'Base URL: 1');
  assert.equal(stripLanguageSentinel('text', ''), 'text');
  assert.equal(stripLanguageSentinel('hello\nworld', 'text'), 'hello\nworld');
});

test('markdownToHtml renders external links with target="_blank" and rel="noopener noreferrer"', () => {
  const out = markdownToHtml('[官方文档](https://jeikcode.com)');
  assert.match(out, /<a href="https:\/\/jeikcode\.com" target="_blank" rel="noopener noreferrer">官方文档<\/a>/);
});

test('markdownToHtml keeps internal anchor links without target="_blank"', () => {
  const out = markdownToHtml('[回到顶部](#header)');
  assert.match(out, /<a href="#header">回到顶部<\/a>/);
  assert.doesNotMatch(out, /target="_blank"/);
});

test('code fence glued to list items or colons splits cleanly without trapping following lists', () => {
  const md = [
    '3. 【兜底拦截】低相似度彻底失配时：直接放弃展示上下文',
    '- **源码位置**：`edit.rs` 第 1763、1780 行',
    '- **代码现状**：```rust',
    'const MISMATCH_GREP_HINT: &str = "...";',
    'if score < 0.30 || end <= start {',
    '    return Some(MISMATCH_GREP_HINT.to_string());',
    '}',
    '```',
    '- **问题所在**：',
    '  当相似度低于 30% 时...',
    '- **优化建议**：',
    '  即便低于 30%...',
    '---',
  ].join('\n');
  const out = markdownToHtml(md);
  // 必须生成带 rust 语言标识的代码块
  assert.match(out, /<code class="language-rust">/);
  // 后续的“问题所在”和“优化建议”必须作为正常的 HTML 列表渲染，严禁被吞入 <code> 代码块！
  assert.match(out, /<li><strong>问题所在<\/strong>：/);
  assert.match(out, /<li><strong>优化建议<\/strong>：/);
  assert.match(out, /<hr>/);
  // 确认“问题所在”没有出现在 <code> 标签内部
  const codeContent = out.match(/<code[\s\S]*?<\/code>/g)?.[0] ?? '';
  assert.doesNotMatch(codeContent, /问题所在/);
});

test('streaming unclosed code block without language tag does not break on ATX headings', () => {
  const streamingMd = [
    '好的 为你编写好了 最标准的提示词',
    '```',
    '# 模型提示词',
    '**任务清单规则：**',
    '  - 规则 1',
  ].join('\n');
  const out = markdownToHtml(streamingMd);
  assert.match(out, /<div class="code-block-wrapper/);
  assert.match(out, /<pre><code class=""># 模型提示词\n\*\*任务清单规则：\*\*\n  - 规则 1<\/code><\/pre>/);
  assert.doesNotMatch(out, /<h1/);
});

test('streaming unclosed markdown code block with nested code blocks does not break outer container', () => {
  const streamingNested = [
    '好的 为你编写好了 最标准的提示词',
    '```markdown',
    '# 模型提示词',
    '```bash',
    'echo hello',
    '```',
    '**任务清单规则：**',
    '  - 规则 1',
  ].join('\n');
  const out = markdownToHtml(streamingNested);
  assert.match(out, /<div class="code-block-wrapper has-language">/);
  assert.match(out, /<span class="code-block-lang">markdown<\/span>/);
  // 内部所有内容（包括 bash 代码块以及其后的任务清单规则）都必须包裹在最外层的 markdown code block 中
  const codeContent = out.match(/<code class="language-markdown">([\s\S]*?)<\/code>/)?.[1] ?? '';
  assert.match(codeContent, /# 模型提示词/);
  assert.match(codeContent, /```bash\necho hello\n```/);
  assert.match(codeContent, /\*\*任务清单规则：\*\*/);
  // 严禁外泄到画布顶层
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<strong>任务清单规则：<\/strong>/);
});

test('code blocks with nested code fences in Rust, Python, Java, C# are promoted cleanly without breaking subsequent prose', () => {
  for (const lang of ['rust', 'python', 'java', 'c#', 'csharp', 'cpp', 'diff']) {
    const md = [
      `\`\`\`${lang}`,
      '// Sample implementation with embedded markdown doc',
      '```bash',
      'npm run test',
      '```',
      '// End of code',
      '```',
      '',
      '#### 重要的后续正文标题',
      '- 列表条目 1',
    ].join('\n');

    const out = markdownToHtml(md);
    // 后续正文标题严禁被吞入代码块！必须正常渲染为 <h4>
    assert.match(out, /<h4[^>]*>重要的后续正文标题<\/h4>/, `Failed for lang: ${lang}`);
    assert.match(out, /<li>列表条目 1<\/li>/, `Failed for lang: ${lang}`);
    // 内部的子代码块必须作为代码块文本保留在 pre/code 内部
    assert.match(out, /npm run test/, `Failed for lang: ${lang}`);
  }
});

test('C# and C++ preprocessor hash directives are not mistaken for ATX headings', () => {
  const csharpMd = [
    '```c#',
    '#region PublicMethods',
    'public void Run() {',
    '#if DEBUG',
    '    Console.WriteLine("debug");',
    '#endif',
    '}',
    '#endregion',
    '```',
    '',
    '正文内容在此',
  ].join('\n');

  const out = markdownToHtml(csharpMd);
  assert.match(out, /<code class="language-csharp">/);
  assert.match(out, /#region PublicMethods/);
  assert.match(out, /<p>正文内容在此<\/p>/);
  assert.doesNotMatch(out, /<h1[^>]*>PublicMethods/);
});

test('code fence glued to title or prose without colon splits cleanly and renders as code block', () => {
  const md = [
    '### 二、中文对照版本```markdown',
    '<explore_strategy>',
    '# 代码库探索策略与工具专职纪律',
    '充分、准确且非冗余的探索是所有代码分析的前提。',
    '```',
    '',
    '后续总结段落',
  ].join('\n');

  const out = markdownToHtml(md);
  // 前置标题必须正常渲染为 <h3>
  assert.match(out, /<h3[^>]*>二、中文对照版本<\/h3>/);
  // 代码块必须正常渲染且带有 markdown 语言高亮
  assert.match(out, /<code class="language-markdown">/);
  // 确认内部代码没有外泄为 <h1> 或顶级段落
  assert.doesNotMatch(out, /<h1[^>]*>代码库探索策略与工具专职纪律<\/h1>/);
  assert.match(out, /<p>后续总结段落<\/p>/);
});

test('inline code with backticks does not get falsely split by glued-fence detector', () => {
  const md = '在普通文本中调用 `run_command` 或使用 `` `嵌套` ``，绝对不被误伤。';
  const prepared = preprocessMarkdown(md);
  assert.equal(prepared, md);
  const out = markdownToHtml(md);
  assert.match(out, /<code>run_command<\/code>/);
  assert.match(out, /<code>`嵌套`<\/code>/);
});




