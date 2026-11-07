import test from 'node:test';
import assert from 'node:assert/strict';
import { recordKind } from './records.ts';

test('recordKind maps role to the three record kinds', () => {
  assert.equal(recordKind('user'), 'user');
  assert.equal(recordKind('system'), 'system');
  assert.equal(recordKind('assistant'), 'model');
  assert.equal(recordKind(undefined), 'model');
});
