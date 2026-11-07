import test from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyUserDisplayText,
  resolveEditable,
  resolveInternal,
  resolveUserDisplayText,
} from './legacy.ts';

test('new wire fields win over every legacy heuristic', () => {
  const msg = {
    display_text: '服务器给的人话',
    content: '[jeikcode-steer]\n<user-query>原始协议</user-query>',
    internal: false,
    editable: true,
    role: 'user',
  };
  assert.equal(resolveUserDisplayText(msg), '服务器给的人话');
  assert.equal(resolveInternal(msg), false);
  assert.equal(resolveEditable(msg), true);
});

test('steer envelope is stripped even when it arrives in display_text', () => {
  const msg = {
    display_text: '[jeikcode-steer]\n<user-query>继续修这个问题</user-query>\n<system-reminder>内部</system-reminder>',
    content: 'ignored',
    role: 'user',
  };
  assert.equal(resolveUserDisplayText(msg), '继续修这个问题');
});

test('legacy text pipeline unwraps steer envelope and reminders', () => {
  const raw = '[jeikcode-steer]\n<user-query>继续</user-query>\n<system-reminder>内部</system-reminder>';
  assert.equal(legacyUserDisplayText(raw), '继续');
});

test('legacy visibility falls back to synthetic and known prefixes', () => {
  assert.equal(resolveInternal({ content: '普通提问', synthetic: false, role: 'user' }), false);
  assert.equal(resolveInternal({ content: '<system-reminder>x', synthetic: false, role: 'user' }), true);
  assert.equal(resolveInternal({ content: '普通提问', synthetic: true, role: 'user' }), true);
});

test('legacy editability mirrors archive/presentation rules', () => {
  assert.equal(resolveEditable({ role: 'user', internal_origin: 'transcript_archive' }), false);
  assert.equal(resolveEditable({ role: 'user', internal_origin: 'presentation' }), false);
  assert.equal(resolveEditable({ role: 'user', internal_origin: 'pending_input' }), false);
  assert.equal(resolveEditable({ role: 'user' }), true);
  assert.equal(resolveEditable({ role: 'assistant' }), undefined);
});
