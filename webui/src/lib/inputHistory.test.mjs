import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pure TypeScript implementation as the composer; no DOM or persistence.
const source = await readFile(new URL('./inputHistory.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { InputHistory, canNavigateInputHistory: can, inputHistoryKey: key } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const setup = (...entries) => {
  const h = new InputHistory();
  h.switchContext('a');
  entries.forEach(value => h.record('a', value));
  return h;
};
const event = (key = 'ArrowUp', value = '', pos = 0, extras = {}) => ({ key, currentTarget: { value, selectionStart: pos, selectionEnd: pos }, ...extras });

test('empty history leaves native arrows alone', () => {
  const h = setup();
  assert.equal(h.navigate('up', 'draft'), null);
  assert.equal(h.navigate('down', 'draft'), null);
});
test('first Up snapshots exact whitespace and multiline draft', () => {
  const h = setup('one', 'two');
  assert.equal(h.navigate('up', '  draft\r\n '), 'two');
  assert.equal(h.navigate('down', 'two'), '  draft\r\n ');
});
test('walk older and newer entries', () => {
  const h = setup('one', 'two');
  assert.equal(h.navigate('up', ''), 'two');
  assert.equal(h.navigate('up', 'two'), 'one');
  assert.equal(h.navigate('down', 'one'), 'two');
  assert.equal(h.navigate('down', 'two'), '');
});
test('oldest entry is bounded', () => {
  const h = setup('one');
  assert.equal(h.navigate('up', 'draft'), 'one');
  assert.equal(h.navigate('up', 'one'), 'one');
  assert.equal(h.navigate('down', 'one'), 'draft');
});
test('Down without browsing is native', () => assert.equal(setup('one').navigate('down', ''), null));
test('editing recalled input exits navigation and preserves new draft', () => {
  const h = setup('one', 'two');
  h.navigate('up', 'draft');
  h.edit('edited two');
  assert.equal(h.navigate('down', 'edited two'), null);
  assert.equal(h.navigate('up', 'edited two'), 'two');
  assert.equal(h.navigate('down', 'two'), 'edited two');
});
test('programmatic edits also become a fresh draft', () => {
  const h = setup('one');
  h.navigate('up', 'draft');
  assert.equal(h.navigate('up', '@file'), 'one');
  assert.equal(h.navigate('down', 'one'), '@file');
});
test('blank submissions are skipped', () => assert.equal(setup('', ' \r\n\t').navigate('up', ''), null));
test('only adjacent exact duplicates coalesce', () => {
  const h = setup('one', 'one', 'two', 'one');
  assert.equal(h.navigate('up', ''), 'one');
  assert.equal(h.navigate('up', 'one'), 'two');
  assert.equal(h.navigate('up', 'two'), 'one');
  assert.equal(h.navigate('down', 'one'), 'two');
});
test('multiline inputs are preserved verbatim', () => assert.equal(setup(' a\r\nb\n ').navigate('up', ''), ' a\r\nb\n '));
test('history is capped at 100 inputs', () => {
  const h = setup(...Array.from({ length: 120 }, (_, i) => String(i)));
  let value = '';
  for (let i = 0; i < 150; i++) value = h.navigate('up', value);
  assert.equal(value, '20');
});
test('projects and sessions are isolated and revisits reset navigation', () => {
  const h = new InputHistory();
  const a = key('project', 'one'), b = key('project', 'two'), c = key('other', 'one');
  h.switchContext(a); h.record(a, 'a'); h.navigate('up', 'old draft');
  h.switchContext(b); assert.equal(h.navigate('up', ''), null); h.record(b, 'b');
  h.switchContext(c); assert.equal(h.navigate('up', ''), null);
  h.switchContext(a); assert.equal(h.navigate('down', 'new draft'), null);
  assert.equal(h.navigate('up', 'new draft'), 'a');
  assert.equal(h.navigate('down', 'a'), 'new draft');
});
test('late acceptance records only its captured context', () => {
  const h = setup(); h.switchContext('b'); h.record('a', 'late');
  assert.equal(h.navigate('up', ''), null);
  h.switchContext('a'); assert.equal(h.navigate('up', ''), 'late');
});
test('context histories use a 32-context LRU cap and revisits refresh recency', () => {
  const h = new InputHistory();
  for (let i = 0; i < 32; i++) h.record(String(i), `input ${i}`);
  h.switchContext('0');
  h.switchContext('31');
  h.record('32', 'new');
  h.switchContext('1');
  assert.equal(h.navigate('up', ''), null);
  h.switchContext('0');
  assert.equal(h.navigate('up', ''), 'input 0');
  h.switchContext('32');
  assert.equal(h.navigate('up', ''), 'new');
});
test('recording a late acceptance refreshes only the source history recency', () => {
  const h = new InputHistory();
  for (let i = 0; i < 32; i++) h.record(String(i), `input ${i}`);
  h.switchContext('31');
  h.record('0', 'late');
  h.record('32', 'new');
  assert.equal(h.navigate('up', ''), 'input 31');
  h.switchContext('1');
  assert.equal(h.navigate('up', ''), null);
  h.switchContext('0');
  assert.equal(h.navigate('up', ''), 'late');
});
test('late acknowledgement preserves browsing snapshot and exact draft even at capacity', () => {
  const h = setup(...Array.from({ length: 100 }, (_, i) => String(i)));
  assert.equal(h.navigate('up', ' draft\r\n '), '99');
  h.record('a', 'late');
  assert.equal(h.navigate('up', '99'), '98');
  assert.equal(h.navigate('down', '98'), '99');
  assert.equal(h.navigate('down', '99'), ' draft\r\n ');
  assert.equal(h.navigate('up', ' draft\r\n '), 'late');
});
test('actual submit recorder uses assigned session without reading changed input or scope', async () => {
  const chat = await readFile(new URL('../components/Chat.tsx', import.meta.url), 'utf8');
  const recorder = chat.match(/const recordAcceptedInput = \(acceptedSessionId\?: string\) =>[\s\S]*?\n    \);/)[0];
  const compiled = ts.transpileModule(recorder, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const h = new InputHistory();
  const make = new Function('inputHistoryRef', 'sessionId', 'historyProject', 'submittedContext', 'originalInput', 'inputHistoryKey', `${compiled}; return recordAcceptedInput;`);
  const remember = make({ current: h }, null, 'project', key('project', null), ' original\n ', key);
  h.switchContext(key('other', 'current'));
  remember('assigned');
  assert.equal(h.navigate('up', ''), null);
  h.switchContext(key('project', null));
  assert.equal(h.navigate('up', ''), null);
  h.switchContext(key('project', 'assigned'));
  assert.equal(h.navigate('up', ''), ' original\n ');
});
test('context keys cannot collide at delimiters', () => assert.notEqual(key('a::b', 'c'), key('a', 'b::c')));
test('Up only on first logical line and Down only on last', () => {
  assert.equal(can(event('ArrowUp', 'abc\ndef', 2)), true);
  assert.equal(can(event('ArrowUp', 'abc\ndef', 4)), false);
  assert.equal(can(event('ArrowDown', 'abc\ndef', 2)), false);
  assert.equal(can(event('ArrowDown', 'abc\ndef', 4)), true);
});
test('CRLF boundaries and trailing blank lines remain native', () => {
  assert.equal(can(event('ArrowUp', 'a\r\nb', 3)), false);
  assert.equal(can(event('ArrowDown', 'a\r\nb', 3)), true);
  assert.equal(can(event('ArrowDown', 'a\n', 1)), false);
  assert.equal(can(event('ArrowDown', 'a\n', 2)), true);
});
test('selection must be collapsed', () => assert.equal(can(event('ArrowUp', 'abc', 0, { currentTarget: { value: 'abc', selectionStart: 0, selectionEnd: 2 } })), false));
for (const flag of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
  test(`${flag} keeps native behavior`, () => assert.equal(can(event('ArrowUp', '', 0, { [flag]: true })), false));
}
test('IME keyCode 229 is ignored', () => assert.equal(can(event('ArrowUp', '', 0, { keyCode: 229 })), false));
test('non-arrow keys never recall', () => assert.equal(can(event('Enter')), false));
test('actual stream acceptance callback records only successful HTTP acceptance', async () => {
  const api = await readFile(new URL('../api.ts', import.meta.url), 'utf8');
  const implementation = api.slice(api.indexOf('export async function streamChat('), api.indexOf('export async function respondPermission('));
  const compiled = ts.transpileModule(implementation.replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const makeStream = (fetch) => new Function('apiFetch', 'authHeaders', `${compiled}; return streamChat;`)(fetch, () => ({}));
  const h = setup();
  const remember = () => h.record('a', ' original\r\ninput ');
  const rejected = makeStream(async () => new Response('', { status: 400 }));
  await assert.rejects(rejected({}, () => {}, undefined, remember), /HTTP 400/);
  assert.equal(h.navigate('up', ''), null);
  const failed = makeStream(async () => { throw new Error('offline'); });
  await assert.rejects(failed({}, () => {}, undefined, remember), /offline/);
  assert.equal(h.navigate('up', ''), null);
  const accepted = makeStream(async () => new Response('data: {"type":"done"}\n\n'));
  await accepted({}, () => {}, undefined, remember);
  assert.equal(h.navigate('up', ''), ' original\r\ninput ');
  await accepted({}, () => {}); // Existing callers need no new callback.
});
test('successful submit wiring excludes validation and failed transports', async () => {
  const chat = await readFile(new URL('../components/Chat.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../api.ts', import.meta.url), 'utf8');
  const submit = chat.slice(chat.indexOf('  async function sendMessage()'), chat.indexOf('  // 当前回合结束'));
  assert.match(submit, /const originalInput = input;/);
  assert.match(submit, /await dispatchSlashCommand[\s\S]*?if \(result.handled\) recordAcceptedInput\(\);[\s\S]*?catch/);
  assert.match(submit, /await deliver\(messageText, images, modeState.confirmedMode, recordAcceptedInput\)/);
  assert.ok(submit.indexOf('if (uploading) return') < submit.indexOf('recordAcceptedInput();'));
  const stream = api.slice(api.indexOf('export async function streamChat('));
  assert.ok(stream.indexOf('if (!resp.ok)') < stream.indexOf('onAccepted?.();'));
  assert.match(chat, /const receipt = await postLiveMessage\([\s\S]*?onAccepted\?\.\(sid \?\? undefined\);/);
  assert.ok(chat.indexOf('if (slashOpen)', chat.indexOf('function handleKeyDown')) < chat.indexOf('if (canNavigateInputHistory'));
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
