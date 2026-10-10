import test from 'node:test';
import assert from 'node:assert/strict';
import { isInternalHistoryUserMessage, reduceSessionHistoryMutation, sessionMessagesToMarkdownLines, stripInjectedRemindersForDisplay, stripSteerEnvelopeForDisplay } from './historyMessages.ts';
import type { SessionMessage } from '../api.ts';
import type { MsgPart } from './toolRows.ts';

test('stripInjectedRemindersForDisplay keeps only the user question', () => {
  const raw = '帮我看下端口\n\n<system-reminder>\nCurrent date: 2026-09-01 (Tue)\n</system-reminder>';
  assert.equal(stripInjectedRemindersForDisplay(raw), '帮我看下端口');
  assert.equal(stripInjectedRemindersForDisplay('plain'), 'plain');
});

test('stripSteerEnvelopeForDisplay keeps the user instruction and drops the note', () => {
  const raw = '改用 sqlite\n\n[jeikcode-steer]\nOn your next step, adjust direction.';
  assert.equal(stripSteerEnvelopeForDisplay(raw), '改用 sqlite');
  assert.equal(stripSteerEnvelopeForDisplay('plain'), 'plain');
  const xmlRaw = '<user-query>\nuse sqlite instead of json\n</user-query>\n\n[jeikcode-steer]\nYou are currently in the middle of executing a task...';
  assert.equal(stripSteerEnvelopeForDisplay(xmlRaw), 'use sqlite instead of json');
  const unclosed = '<user-query> 跨平台都只需要声音通知就可以\n\n[jeikcode-steer]\nnotes';
  assert.equal(stripSteerEnvelopeForDisplay(unclosed), '跨平台都只需要声音通知就可以');
  const imageOnlyRaw = '<user-query>\n(The user attached image(s))\n</user-query>\n\n[jeikcode-steer]\n...';
  assert.equal(stripSteerEnvelopeForDisplay(imageOnlyRaw), '');
});

test('isInternalHistoryUserMessage hides synthetic and legacy internal users', () => {
  assert.equal(isInternalHistoryUserMessage('real prompt'), false);
  assert.equal(isInternalHistoryUserMessage('real prompt', true), true);
  assert.equal(
    isInternalHistoryUserMessage('You made code edits but have not verified them. Run cargo check.'),
    true,
  );
  assert.equal(
    isInternalHistoryUserMessage('Output limit hit when running pytest; how do I debug it?'),
    false,
  );
});

test('sessionMessagesToMarkdownLines skips internal user messages', () => {
  const messages: SessionMessage[] = [
    { role: 'user', content: 'real prompt' },
    { role: 'user', content: 'You made code edits but have not verified them.', synthetic: true },
    { role: 'user', content: '[Auto-read from error: src/main.rs]\nfn main() {}' },
    { role: 'assistant', content: 'reply' },
  ];

  const markdown = sessionMessagesToMarkdownLines(messages, 'Session').join('\n');

  assert.match(markdown, /## User\n\nreal prompt/);
  assert.match(markdown, /## Assistant\n\nreply/);
  assert.doesNotMatch(markdown, /not verified/);
  assert.doesNotMatch(markdown, /Auto-read/);
});

test('sessionMessagesToMarkdownLines skips verify cadence assistant messages', () => {
  const messages: SessionMessage[] = [
    { role: 'user', content: 'create f.txt' },
    { role: 'assistant', content: 'No verification is needed.', internal_origin: 'verify_cadence' },
    { role: 'assistant', content: 'I am JeikCode.' },
  ];

  const markdown = sessionMessagesToMarkdownLines(messages, 'Session').join('\n');

  assert.doesNotMatch(markdown, /No verification is needed/);
  assert.match(markdown, /I am JeikCode/);
});

test('sessionMessagesToMarkdownLines skips camel case verify cadence assistant messages', () => {
  const messages: SessionMessage[] = [
    { role: 'assistant', content: 'No verification is needed.', internalOrigin: 'verify_cadence' },
    { role: 'assistant', content: 'I am JeikCode.' },
  ];

  const markdown = sessionMessagesToMarkdownLines(messages, 'Session').join('\n');

  assert.doesNotMatch(markdown, /No verification is needed/);
  assert.match(markdown, /I am JeikCode/);
});

test('sessionMessagesToMarkdownLines keeps verify cadence assistants with tool calls', () => {
  const messages: SessionMessage[] = [
    {
      role: 'assistant',
      content: 'Running verification',
      internal_origin: 'verify_cadence',
      tool_calls: [{ id: 'b1', name: 'bash', arguments: '{"command":"true"}' }],
    },
  ];

  const markdown = sessionMessagesToMarkdownLines(messages, 'Session').join('\n');

  assert.match(markdown, /Running verification/);
  assert.match(markdown, /### Tool: bash/);
});

interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  sourceIndex?: number;
  parts: MsgPart[];
  images?: { media_type: string; data: string }[];
}

function historySurface(sessionId: string, label: string) {
  const messages: DisplayMessage[] = [
    { role: 'user', sourceIndex: 4, parts: [{ kind: 'text', text: `${label} question` }] },
    { role: 'assistant', sourceIndex: 7, parts: [{ kind: 'text', text: `${label} answer` }] },
  ];
  return { sessionId, messages, turns: [{ index: 4, ordinal: 0, text: `${label} question` }] };
}

test('delayed rewrite A -> B updates A transcript and outline without changing B', () => {
  const origin = historySurface('A', 'A');
  const viewed = historySurface('B', 'B');
  const beforeA = structuredClone(origin);
  const beforeB = structuredClone(viewed);
  const images = [{ media_type: 'image/png', data: 'image-A' }];

  const next = reduceSessionHistoryMutation(origin, {
    action: 'patch', source_index: 4, text: 'rewritten A', images,
  }, viewed);

  assert.equal(next.reconcileView, false);
  assert.deepEqual(next.messages[0].parts, [{ kind: 'text', text: 'rewritten A' }]);
  assert.deepEqual(next.messages[0].images, images);
  assert.equal(next.messages[1], origin.messages[1]);
  assert.deepEqual(next.turns, [{ index: 4, ordinal: 0, text: 'rewritten A' }]);
  assert.deepEqual(origin, beforeA);
  assert.deepEqual(viewed, beforeB);
});

test('A -> B -> A rewrite reconciles the replacement A and preserves its newer messages', () => {
  const origin = historySurface('A', 'old A');
  const replacement = historySurface('A', 'current A');
  replacement.messages.push({ role: 'assistant', sourceIndex: 9, parts: [{ kind: 'text', text: 'newer A result' }] });
  replacement.turns[0].ordinal = 5;

  const next = reduceSessionHistoryMutation(origin, {
    action: 'patch', source_index: 4, text: 'committed rewrite',
  }, replacement);

  assert.equal(next.reconcileView, true);
  assert.equal(next.messages.length, 3);
  assert.equal(next.messages[1], replacement.messages[1]);
  assert.equal(next.messages[2], replacement.messages[2]);
  assert.deepEqual(next.turns, [{ index: 4, ordinal: 5, text: 'committed rewrite' }]);
  // The same surface is used for the canvas and cache; a later switch cannot stash obsolete A.
  const switchedAwayCache = { sessionId: 'A', messages: next.messages, turns: next.turns };
  const replay = reduceSessionHistoryMutation(switchedAwayCache, {
    action: 'patch', source_index: 4, text: 'committed rewrite',
  }, historySurface('B', 'B'));
  assert.deepEqual(replay.messages, next.messages);
  assert.deepEqual(replay.turns, next.turns);
});

test('turn deletion removes only the target turn and remains safe after an SSE echo', () => {
  const origin = historySurface('A', 'A');
  origin.messages.push(
    { role: 'system', parts: [{ kind: 'notice', text: 'turn notice' }] },
    { role: 'user', sourceIndex: 12, parts: [{ kind: 'text', text: 'next question' }] },
    { role: 'assistant', sourceIndex: 14, parts: [{ kind: 'text', text: 'next answer' }] },
  );
  origin.turns.push({ index: 12, ordinal: 1, text: 'next question' });
  const mutation = { action: 'delete' as const, source_index: 4, delete_turn: true };

  const next = reduceSessionHistoryMutation(origin, mutation, historySurface('B', 'B'));
  assert.deepEqual(next.messages.map((message) => message.sourceIndex), [12, 14]);
  assert.deepEqual(next.turns, [{ index: 12, ordinal: 1, text: 'next question' }]);
  const cached = { sessionId: 'A', messages: next.messages, turns: next.turns };
  const echoed = reduceSessionHistoryMutation(cached, mutation, cached);
  assert.equal(echoed.messages, next.messages);
  assert.deepEqual(echoed.turns, next.turns);
  assert.equal(origin.messages.length, 5);
});

test('authoritative assistant deletion finds the raw target in a replacement view, not its old visible index', () => {
  const origin = historySurface('A', 'old A');
  const replacement = historySurface('A', 'A');
  replacement.messages.unshift({ role: 'assistant', sourceIndex: 2, parts: [{ kind: 'text', text: 'older loaded answer' }] });
  const target = replacement.messages[2];
  const mutation = { action: 'delete' as const, source_index: 7 };

  const next = reduceSessionHistoryMutation(origin, mutation, replacement);
  assert.equal(next.reconcileView, true);
  assert.deepEqual(next.messages.map((message) => message.sourceIndex), [2, 4]);
  assert.equal(next.turns, replacement.turns);
  assert.equal(replacement.messages[2], target);
  const cached = { sessionId: 'A', messages: next.messages, turns: next.turns };
  assert.equal(reduceSessionHistoryMutation(cached, mutation, cached).messages, next.messages);
});

test('a live assistant can be deleted by captured identity without guessing another session row', () => {
  const origin = historySurface('A', 'A');
  const target: DisplayMessage = { role: 'assistant', parts: [{ kind: 'text', text: 'live answer' }] };
  origin.messages.push(target);
  const viewed = historySurface('B', 'B');
  const next = reduceSessionHistoryMutation(origin, {
    action: 'delete', source_index: 10,
  }, viewed, target);
  assert.deepEqual(next.messages, origin.messages.slice(0, 2));
  assert.equal(viewed.messages.length, 2);
  assert.equal(next.reconcileView, false);
});

test('rollback and regenerate truncate A at its raw target while preserving B', () => {
  const origin = historySurface('A', 'A');
  origin.messages.unshift({ role: 'assistant', sourceIndex: 1, parts: [{ kind: 'text', text: 'earlier answer' }] });
  origin.turns.unshift({ index: 0, ordinal: -1, text: 'earlier question' });
  const viewed = historySurface('B', 'B');
  const beforeB = structuredClone(viewed);
  const next = reduceSessionHistoryMutation(origin, { action: 'truncate', target_index: 4 }, viewed);

  assert.deepEqual(next.messages.map((message) => message.sourceIndex), [1]);
  assert.deepEqual(next.turns, [{ index: 0, ordinal: -1, text: 'earlier question' }]);
  assert.equal(next.reconcileView, false);
  assert.deepEqual(viewed, beforeB);
});

test('truncation handles an unloaded target and mutation replay does not empty a surviving cache', () => {
  const origin = historySurface('A', 'A');
  const next = reduceSessionHistoryMutation(origin, { action: 'truncate', target_index: 6 }, origin);
  assert.deepEqual(next.messages.map((message) => message.sourceIndex), [4]);
  assert.deepEqual(next.turns, origin.turns);
  const cached = { sessionId: 'A', messages: next.messages, turns: next.turns };
  const echoed = reduceSessionHistoryMutation(cached, { action: 'truncate', target_index: 6 }, cached);
  assert.equal(echoed.messages, next.messages);
  const missingDelete = reduceSessionHistoryMutation(cached, { action: 'delete', source_index: 99 }, cached);
  assert.equal(missingDelete.messages, next.messages);
  assert.equal(missingDelete.turns, next.turns);
});

test('a confirmed delete prefers captured identity when its returned index names another cached row', () => {
  const origin = historySurface('A', 'A');
  const target: DisplayMessage = { role: 'assistant', sourceIndex: 10, parts: [{ kind: 'text', text: 'target answer' }] };
  origin.messages.push(target);
  const next = reduceSessionHistoryMutation(origin, {
    action: 'delete', source_index: 7, revision: 3,
  }, origin, target);
  assert.equal(next.applied, true);
  assert.deepEqual(next.messages, origin.messages.slice(0, 2));
  assert.equal(next.messages[1], origin.messages[1]);
});

test('rewrite ACK uses the captured question identity for both transcript and outline after raw indices shift', () => {
  const origin = historySurface('A', 'A');
  const target: DisplayMessage = { role: 'user', sourceIndex: 12, parts: [{ kind: 'text', text: 'target question' }] };
  origin.messages.push(target);
  origin.turns.push({ index: 12, ordinal: 1, text: 'target question' });
  const next = reduceSessionHistoryMutation(origin, {
    action: 'patch', source_index: 4, text: 'rewritten target', revision: 4,
  }, origin, target);
  assert.equal(next.messages[0], origin.messages[0]);
  assert.deepEqual(next.messages[2].parts, [{ kind: 'text', text: 'rewritten target' }]);
  assert.equal(next.turns[0], origin.turns[0]);
  assert.equal(next.turns[1].text, 'rewritten target');
});

test('SSE before its ACK cannot delete a second row after canonical indices are reused', () => {
  const original = historySurface('A', 'A');
  const target = original.messages[1];
  const event = { action: 'delete' as const, source_index: 7, revision: 5 };
  const fromSse = reduceSessionHistoryMutation(original, event, original);
  assert.equal(fromSse.messages.length, 1);
  const canonical = {
    sessionId: 'A', revision: 5,
    messages: [...fromSse.messages, { role: 'assistant' as const, sourceIndex: 7, parts: [{ kind: 'text' as const, text: 'surviving answer' }] }],
    turns: fromSse.turns,
  };
  const ack = reduceSessionHistoryMutation(canonical, event, canonical, target);
  assert.equal(ack.applied, false);
  assert.equal(ack.messages, canonical.messages);
  assert.equal(ack.turns, canonical.turns);
  const older = reduceSessionHistoryMutation(canonical, {
    action: 'patch', source_index: 7, text: 'obsolete result', revision: 4,
  }, canonical);
  assert.equal(older.applied, false);
  assert.equal(older.messages, canonical.messages);
});

test('an ACK before its duplicate SSE also preserves a canonical row reusing the deleted index', () => {
  const original = historySurface('A', 'A');
  const target = original.messages[1];
  const mutation = { action: 'delete' as const, source_index: 7, revision: 6 };
  const fromAck = reduceSessionHistoryMutation(original, mutation, original, target);
  const canonical = {
    sessionId: 'A', revision: 6,
    messages: [...fromAck.messages, { role: 'assistant' as const, sourceIndex: 7, parts: [{ kind: 'text' as const, text: 'different answer' }] }],
    turns: fromAck.turns,
  };
  const duplicate = reduceSessionHistoryMutation(canonical, mutation, canonical);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.messages, canonical.messages);
});

test('a disappeared captured target does not let a fresh ACK modify another row at its old index', () => {
  const original = historySurface('A', 'old A');
  const replacement = historySurface('A', 'new A');
  const next = reduceSessionHistoryMutation(original, {
    action: 'delete', source_index: 7, revision: 8,
  }, replacement, original.messages[1]);
  assert.equal(next.applied, false);
  assert.equal(next.messages, replacement.messages);
  assert.equal(next.turns, replacement.turns);
});
