import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageSearchableFullText,
  normalizeSearchQuery,
  textMatchesSearch,
  toolMatchesSearch,
  toolSearchText,
} from './canvasSearch.ts';

// 用户报的症状：Ctrl+F 只高亮正文，工具输出/参数、思考块“计数有但页面上找不到”。
// 这些用例锁死“计数口径 = 渲染口径”这条契约。
test('工具行参与搜索的字段与渲染层一致（名称/参数/输出/进度/子任务）', () => {
  const tool = {
    name: 'mcp__codegraph__search',
    args: '{"query":"Penalty"}',
    output: 'stdout: 603 passed',
    progress: 'indexing 42%',
    subtasks: [
      { label: 'scan-auth', activity: 'reading auth.rs', description: 'audit tokens' },
    ],
  };
  for (const needle of [
    'codegraph',
    'penalty',
    '603 passed',
    'indexing',
    'scan-auth',
    'reading auth.rs',
    'audit tokens',
  ]) {
    assert.equal(toolMatchesSearch(tool, needle), true, `应当命中：${needle}`);
  }
  assert.equal(toolMatchesSearch(tool, 'not-in-this-row'), false);
  // 空关键词（搜索框关闭/只有空白）绝不展开任何行。
  assert.equal(toolMatchesSearch(tool, '   '), false);
  assert.equal(normalizeSearchQuery(undefined), '');
});

test('消息级搜索覆盖正文、思考、通知与工具，大小写不敏感', () => {
  const message = {
    parts: [
      { kind: 'text', text: '正文里的关键词 Alpha' },
      { kind: 'reasoning', text: '思考里的关键词 Beta' },
      { kind: 'notice', text: '通知里的关键词 Gamma' },
      { kind: 'rate_limited', text: '限流提示 Delta' },
      { kind: 'tool', tool: { name: 'bash', args: '{"command":"echo Epsilon"}' } },
    ],
  };
  const haystack = messageSearchableFullText(message);
  for (const needle of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    assert.ok(haystack.includes(needle), `应当命中：${needle}`);
  }
  assert.equal(haystack, haystack.toLowerCase(), '统一小写，供小写关键词直接比对');
});

test('折叠块的展开判定只认自身内容，空白关键词不触发', () => {
  assert.equal(textMatchesSearch('思考内容 epsilon', 'EPSILON'), true);
  assert.equal(textMatchesSearch('思考内容', 'epsilon'), false);
  assert.equal(textMatchesSearch(undefined, 'epsilon'), false);
  assert.equal(textMatchesSearch('任何内容', '  '), false);
});

test('工具行搜索文本不重复拼接、不吞字段', () => {
  const text = toolSearchText({ name: 'read', args: '{"path":"a.md"}', output: 'ok' });
  assert.equal(text, 'read {"path":"a.md"} ok');
  assert.equal(toolSearchText({}), '');
});
