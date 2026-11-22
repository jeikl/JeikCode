import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capabilityPendingKey,
  isCapabilityRefreshCurrent,
  normalizeCapabilityDir,
  withPendingCapabilityOverrides,
  type PendingCapabilityToggle,
} from './capabilityState.ts';
import type { CapabilityItem } from '../api';

function item(overrides: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    kind: 'skill',
    id: 'find-skills',
    name: 'find-skills',
    description: '',
    global_disabled: false,
    project_disabled: false,
    effective_disabled: false,
    ...overrides,
  };
}

test('no pending intent returns the same snapshot', () => {
  const items = [item()];
  assert.equal(withPendingCapabilityOverrides(items, []), items);
});

test('project intent keeps the optimistic off state after a stale snapshot', () => {
  const pending: PendingCapabilityToggle[] = [
    { kind: 'skill', id: 'find-skills', scope: 'project', disabled: true },
  ];
  const [row] = withPendingCapabilityOverrides([item()], pending);
  assert.equal(row.project_disabled, true);
  assert.equal(row.global_disabled, false);
  assert.equal(row.effective_disabled, true);
});

test('global intent applies to the global scope and effective union', () => {
  const pending: PendingCapabilityToggle[] = [
    { kind: 'mcp', id: 'brave-search', scope: 'global', disabled: true },
  ];
  const [row] = withPendingCapabilityOverrides(
    [item({ kind: 'mcp', id: 'brave-search' })],
    pending,
  );
  assert.equal(row.global_disabled, true);
  assert.equal(row.effective_disabled, true);
});

test('global and project intents compose for the same row', () => {
  const pending: PendingCapabilityToggle[] = [
    { kind: 'skill', id: 'find-skills', scope: 'project', disabled: true },
    { kind: 'skill', id: 'find-skills', scope: 'global', disabled: false },
  ];
  const [row] = withPendingCapabilityOverrides(
    [item({ global_disabled: true, project_disabled: true, effective_disabled: true })],
    pending,
  );
  assert.equal(row.global_disabled, false);
  assert.equal(row.project_disabled, true);
  assert.equal(row.effective_disabled, true);
});

test('unrelated rows are returned untouched', () => {
  const other = item({ id: 'other-skill' });
  const result = withPendingCapabilityOverrides(
    [other],
    [{ kind: 'skill', id: 'find-skills', scope: 'project', disabled: true }],
  );
  assert.equal(result[0], other);
});

test('only the newest request for the visible project may apply', () => {
  assert.equal(isCapabilityRefreshCurrent(2, 2, 'a|b', 'a|b'), true);
  assert.equal(isCapabilityRefreshCurrent(1, 2, 'a|b', 'a|b'), false);
  assert.equal(isCapabilityRefreshCurrent(2, 2, 'a|b', 'other|b'), false);
});

test('pending keys are stable per kind/id/scope', () => {
  assert.equal(capabilityPendingKey('skill', 'x', 'project'), 'skill:x:project');
  assert.notEqual(
    capabilityPendingKey('skill', 'x', 'project'),
    capabilityPendingKey('skill', 'x', 'global'),
  );
});

test('directory comparison tolerates slashes, trailing slash, and case', () => {
  assert.equal(normalizeCapabilityDir('E:\\code\\JeikCode\\'), normalizeCapabilityDir('e:/code/jeikcode'));
});
