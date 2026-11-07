import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveComposerEnterAction,
  resolveQueuedCardArrowAction,
  nextActionIndex,
  fallbackActionKey,
  isComposerTypedKey,
  resolveComposerEscapeAction,
  tailQueuedCard,
} from './composerShortcuts.ts';

const enter = (extras: Record<string, unknown> = {}) =>
  resolveComposerEnterAction({ key: 'Enter', ...extras } as never);

test('plain Enter still sends on desktop', () => {
  assert.equal(enter(), 'send');
  assert.equal(enter({ shiftKey: false, ctrlKey: false, metaKey: false }), 'send');
});

test('Shift+Enter stays a real newline', () => {
  assert.equal(enter({ shiftKey: true }), 'newline');
});

test('Enter on a touch keyboard stays a real newline', () => {
  assert.equal(enter({ mobile: true }), 'newline');
});

test('Ctrl+Enter / Cmd+Enter queue a steer card', () => {
  assert.equal(enter({ ctrlKey: true }), 'steer-card');
  assert.equal(enter({ metaKey: true }), 'steer-card');
  // A modifier is a deliberate act, so it also works on touch keyboards.
  assert.equal(enter({ ctrlKey: true, mobile: true }), 'steer-card');
});

test('IME composition and already-handled keys are ignored', () => {
  assert.equal(enter({ isComposing: true }), 'ignore');
  assert.equal(enter({ keyCode: 229 }), 'ignore');
  assert.equal(enter({ defaultPrevented: true }), 'ignore');
  assert.equal(resolveComposerEnterAction({ key: 'a' } as never), 'ignore');
});

test('arrow keys drive the card action group', () => {
  assert.equal(resolveQueuedCardArrowAction({ key: 'ArrowLeft' }), 'prev');
  assert.equal(resolveQueuedCardArrowAction({ key: 'ArrowRight' }), 'next');
  assert.equal(resolveQueuedCardArrowAction({ key: 'Home' }), 'first');
  assert.equal(resolveQueuedCardArrowAction({ key: 'End' }), 'last');
  assert.equal(resolveQueuedCardArrowAction({ key: 'Enter' }), 'none');
  assert.equal(resolveQueuedCardArrowAction({ key: 'ArrowLeft', ctrlKey: true }), 'none');
  assert.equal(resolveQueuedCardArrowAction({ key: 'ArrowRight', metaKey: true }), 'none');
  assert.equal(resolveQueuedCardArrowAction({ key: 'ArrowRight', defaultPrevented: true }), 'none');
});

test('focus movement wraps around the enabled actions', () => {
  const enabled = ['steer', 'sendNow', 'cancel'];
  assert.equal(nextActionIndex('steer', enabled, 'next'), 'sendNow');
  assert.equal(nextActionIndex('sendNow', enabled, 'next'), 'cancel');
  assert.equal(nextActionIndex('cancel', enabled, 'next'), 'steer');
  assert.equal(nextActionIndex('steer', enabled, 'prev'), 'cancel');
  assert.equal(nextActionIndex('steer', enabled, 'first'), 'steer');
  assert.equal(nextActionIndex('steer', enabled, 'last'), 'cancel');
  assert.equal(nextActionIndex(null, enabled, 'next'), 'steer');
  assert.equal(nextActionIndex('steer', [], 'next'), null);
});

test('a vanished action hands the focus to the next one in canonical order', () => {
  const order = ['steer', 'sendNow', 'cancel'];
  assert.equal(fallbackActionKey('steer', ['sendNow', 'cancel'], order), 'sendNow');
  assert.equal(fallbackActionKey('sendNow', ['cancel'], order), 'cancel');
  assert.equal(fallbackActionKey('cancel', ['steer', 'sendNow'], order), 'sendNow');
  assert.equal(fallbackActionKey(null, ['steer', 'sendNow'], order), 'steer');
  assert.equal(fallbackActionKey('steer', [], order), null);
});

test('typing on a focused card button belongs to the composer', () => {
  assert.equal(isComposerTypedKey({ key: 'a' }), true);
  assert.equal(isComposerTypedKey({ key: '7' }), true);
  assert.equal(isComposerTypedKey({ key: '中' }), true);
  assert.equal(isComposerTypedKey({ key: ' ' }), false);
  assert.equal(isComposerTypedKey({ key: 'Enter' }), false);
  assert.equal(isComposerTypedKey({ key: 'a', ctrlKey: true }), false);
  assert.equal(isComposerTypedKey({ key: 'a', metaKey: true }), false);
});

test('Esc cancels the tail pending card', () => {
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 1 }), 'cancel-card');
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 3 }), 'cancel-card');
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 0 }), 'none');
  // A popup that already consumed Esc wins.
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 2, defaultPrevented: true }), 'none');
});

test('Esc in pure playing state stops and restores message', () => {
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 0, busy: true }), 'stop-and-restore');
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 1, busy: true }), 'cancel-card');
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 0, busy: false }), 'none');
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 0, busy: true, defaultPrevented: true }), 'none');
});

test('ESC undo preference disables both card cancel and stop/restore', () => {
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 1, undoEnabled: false }), 'none');
  assert.equal(
    resolveComposerEscapeAction({ pendingCardCount: 0, busy: true, undoEnabled: false }),
    'none',
  );
  // Default / explicit true keeps the historical behavior.
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 1 }), 'cancel-card');
  assert.equal(resolveComposerEscapeAction({ pendingCardCount: 1, undoEnabled: true }), 'cancel-card');
});

test('the tail card is the most recently queued one', () => {
  const cards = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(tailQueuedCard(cards), { id: 3 });
  assert.equal(tailQueuedCard([]), null);
});
