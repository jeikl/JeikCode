import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCopyFeedbackController } from './copyFeedback.ts';

function fixture(copyText: (text: string) => Promise<boolean> = async () => true) {
  const states: boolean[] = [];
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  let errors = 0;
  const controller = createCopyFeedbackController({
    copyText,
    onCopied: (value) => states.push(value),
    onError: () => { errors++; },
    schedule: (callback, delay) => {
      delays.push(delay);
      timers.set(++id, callback);
      return id;
    },
    cancel: (timer) => { timers.delete(timer); },
  });
  const expire = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  };
  return { controller, states, timers, delays, expire, errors: () => errors };
}

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

test('copy success uses provided text and resets feedback after 1200 ms', async () => {
  const texts: string[] = [];
  const f = fixture(async (text) => { texts.push(text); return true; });
  await f.controller.copy('code');
  assert.deepEqual(texts, ['code']);
  assert.deepEqual(f.states, [true]);
  assert.deepEqual(f.delays, [1200]);
  f.expire();
  assert.deepEqual(f.states, [true, false]);
  assert.equal(f.errors(), 0);
});

test('false and rejected copies notify errors without success or timers', async () => {
  for (const copy of [async () => false, async () => { throw new Error('denied'); }]) {
    const f = fixture(copy);
    await f.controller.copy('code');
    assert.equal(f.errors(), 1);
    assert.deepEqual(f.states, []);
    assert.equal(f.timers.size, 0);
  }
});

test('repeated success replaces the reset timer with a fresh 1200 ms timer', async () => {
  const f = fixture();
  await f.controller.copy('first');
  const firstTimer = [...f.timers.keys()][0];
  await f.controller.copy('second');
  assert.equal(f.timers.has(firstTimer), false);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.delays, [1200, 1200]);
  f.expire();
  assert.deepEqual(f.states, [true, true, false]);
});

test('failed repeated copy does not prevent earlier feedback from expiring', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1);
  await f.controller.copy('first');
  await f.controller.copy('second');
  f.expire();
  assert.equal(f.errors(), 1);
  assert.deepEqual(f.states, [true, false]);
});

test('reset cancels timers and invalidates pending copy results', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? Promise.resolve(true) : pending.promise);
  await f.controller.copy('first');
  const copying = f.controller.copy('pending');
  f.controller.reset();
  assert.equal(f.timers.size, 0);
  pending.resolve(true);
  await copying;
  assert.deepEqual(f.states, [true, false]);
  assert.deepEqual(f.delays, [1200]);
});

test('dispose clears timers and ignores future copies and resets', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return true; });
  await f.controller.copy('code');
  f.controller.dispose();
  f.controller.dispose();
  f.controller.reset();
  await f.controller.copy('after unmount');
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.states, [true]);
});

test('async success or failure after dispose schedules no feedback or notification', async () => {
  for (const result of [true, false]) {
    const pending = deferred();
    const f = fixture(() => pending.promise);
    const copying = f.controller.copy('code');
    f.controller.dispose();
    pending.resolve(result);
    await copying;
    assert.deepEqual(f.states, []);
    assert.deepEqual(f.delays, []);
    assert.equal(f.errors(), 0);
  }
});

test('out-of-order repeated results cannot override the latest copy', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? first.promise : second.promise);
  const copyingFirst = f.controller.copy('first');
  const copyingSecond = f.controller.copy('second');
  second.resolve(true);
  await copyingSecond;
  first.resolve(false);
  await copyingFirst;
  assert.deepEqual(f.states, [true]);
  assert.equal(f.errors(), 0);
  assert.equal(f.timers.size, 1);
});

test('empty text does not invoke clipboard or change feedback', async () => {
  const f = fixture(async () => { throw new Error('must not copy'); });
  await f.controller.copy('');
  assert.deepEqual(f.states, []);
  assert.equal(f.errors(), 0);
  assert.equal(f.timers.size, 0);
});
