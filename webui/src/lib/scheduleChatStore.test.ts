import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendScheduleAiMessage,
  createScheduleAiThread,
  getActiveScheduleAiThread,
  listScheduleAiThreads,
  removeScheduleAiThread,
  selectScheduleAiThread,
  setScheduleAiThreadModel,
} from './scheduleChatStore.ts';

test('scheduleChatStore maintains independent in-memory multi-turn threads', () => {
  const initial = getActiveScheduleAiThread();
  assert.ok(initial.id.startsWith('sched-ai-'));
  assert.equal(initial.messages.length, 0);

  const afterTurn1 = appendScheduleAiMessage(initial.id, {
    role: 'user',
    content: 'Every weekday at 09:00 check git status',
  });
  const afterReply1 = appendScheduleAiMessage(afterTurn1.id, {
    role: 'assistant',
    content: 'Created task for weekdays at 09:00.',
  });
  assert.equal(afterReply1.messages.length, 2);

  // Create a second independent thread with its own memory context
  const second = createScheduleAiThread('custom-provider');
  assert.notEqual(second.id, initial.id);
  assert.equal(second.model, 'custom-provider');
  assert.equal(second.messages.length, 0);

  appendScheduleAiMessage(second.id, { role: 'user', content: 'Every 30m inspect logs' });
  setScheduleAiThreadModel(second.id, 'another-provider');

  // Switch back to initial thread: prior memory must remain completely intact
  const switchedBack = selectScheduleAiThread(initial.id);
  assert.equal(switchedBack.messages.length, 2);
  assert.equal(switchedBack.messages[0].content, 'Every weekday at 09:00 check git status');

  const threads = listScheduleAiThreads();
  assert.equal(threads.length, 2);
  const secondLatest = threads.find((t) => t.id === second.id)!;
  assert.equal(secondLatest.messages.length, 1);
  assert.equal(secondLatest.model, 'another-provider');

  const nextActive = removeScheduleAiThread(second.id);
  assert.equal(nextActive.id, initial.id);
  assert.equal(listScheduleAiThreads().length, 1);
});
