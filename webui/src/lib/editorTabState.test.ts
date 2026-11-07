import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpReloadToken,
  dropEditorTabSnapshot,
  mainEditorStateKey,
  previewEditorStateKey,
  readEditorTabSnapshot,
  shouldReloadFromDisk,
  toggleTextMode,
  withTabViewMode,
  withVisitedTab,
  withoutTabEntry,
  writeEditorTabSnapshot,
  type EditorTabSnapshot,
} from './editorTabState.ts';

function snapshot(overrides: Partial<EditorTabSnapshot> = {}): EditorTabSnapshot {
  return {
    content: 'disk',
    isDirty: false,
    viewMode: 'preview',
    imgScale: 1,
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    scrollLeft: 0,
    gutterScrollTop: 0,
    previewScrollTop: 0,
    diskStamp: null,
    ...overrides,
  };
}

test('main and preview canvases keep independent tab state for the same file', () => {
  const path = 'E:/proj/a.md';
  const mainKey = mainEditorStateKey(path);
  const previewKey = previewEditorStateKey(path);
  assert.notEqual(mainKey, previewKey);

  writeEditorTabSnapshot(mainKey, snapshot({ content: 'main draft', isDirty: true, viewMode: 'edit' }));
  writeEditorTabSnapshot(previewKey, snapshot({ content: 'preview copy' }));

  assert.equal(readEditorTabSnapshot(mainKey)?.content, 'main draft');
  assert.equal(readEditorTabSnapshot(mainKey)?.viewMode, 'edit');
  assert.equal(readEditorTabSnapshot(previewKey)?.content, 'preview copy');
  assert.equal(readEditorTabSnapshot(previewKey)?.isDirty, false);
});

test('snapshot survives unmount and reports null for missing keys', () => {
  const key = mainEditorStateKey('E:/proj/b.ts');
  writeEditorTabSnapshot(key, snapshot({ content: 'edited', isDirty: true, selectionStart: 3, selectionEnd: 7, scrollTop: 120 }));
  const restored = readEditorTabSnapshot(key);
  assert.equal(restored?.content, 'edited');
  assert.equal(restored?.selectionStart, 3);
  assert.equal(restored?.selectionEnd, 7);
  assert.equal(restored?.scrollTop, 120);

  assert.equal(readEditorTabSnapshot(mainEditorStateKey('E:/proj/missing.ts')), null);
  assert.equal(readEditorTabSnapshot(null), null);
});

test('closing a tab tombstones late writes until it is opened again', () => {
  const key = mainEditorStateKey('E:/proj/c.rs');
  writeEditorTabSnapshot(key, snapshot({ content: 'draft', isDirty: true }));
  dropEditorTabSnapshot(key);

  // 卸载清理可能晚于关闭动作：关闭后的写回必须被拦截。
  writeEditorTabSnapshot(key, snapshot({ content: 'stale cleanup' }));
  assert.equal(readEditorTabSnapshot(key), null);

  // 重新打开（read）解除墓碑后恢复正常写回。
  writeEditorTabSnapshot(key, snapshot({ content: 'fresh' }));
  assert.equal(readEditorTabSnapshot(key)?.content, 'fresh');
});

test('snapshot store evicts the oldest tabs beyond its LRU cap', () => {
  const keys = Array.from({ length: 40 }, (_, i) => mainEditorStateKey(`E:/proj/lru-${i}.ts`));
  keys.forEach((key, i) => {
    writeEditorTabSnapshot(key, snapshot({ content: `tab-${i}` }));
  });
  assert.equal(readEditorTabSnapshot(keys[0]!), null);
  assert.equal(readEditorTabSnapshot(keys[39]!)?.content, 'tab-39');
});

test('toggleTextMode flips only between text modes', () => {
  assert.equal(toggleTextMode('edit'), 'preview');
  assert.equal(toggleTextMode('preview'), 'edit');
  assert.equal(toggleTextMode('image'), 'edit');
  assert.equal(toggleTextMode('binary'), 'edit');
});

test('view mode map keeps identity when a tab already reports its mode', () => {
  const map = { a: 'preview' as const };
  assert.equal(withTabViewMode(map, 'a', 'preview'), map);
  const next = withTabViewMode(map, 'a', 'edit');
  assert.notEqual(next, map);
  assert.equal(next.a, 'edit');
  assert.equal(withTabViewMode(map, '', 'edit'), map);
});

test('visited map marks a tab repeatedly without churn', () => {
  const first = withVisitedTab({}, 'tab-a');
  assert.deepEqual(first, { 'tab-a': true });
  assert.equal(withVisitedTab(first, 'tab-a'), first);
  const both = withVisitedTab(first, 'tab-b');
  assert.deepEqual(Object.keys(both), ['tab-a', 'tab-b']);
});

test('withoutTabEntry only copies when the entry exists', () => {
  const map = { a: 1, b: 2 };
  assert.equal(withoutTabEntry(map, 'c'), map);
  const next = withoutTabEntry(map, 'a');
  assert.deepEqual(next, { b: 2 });
  assert.deepEqual(map, { a: 1, b: 2 });
});

test('reload tokens bump per tab', () => {
  let tokens: Record<string, number> = {};
  tokens = bumpReloadToken(tokens, 'a');
  tokens = bumpReloadToken(tokens, 'a');
  tokens = bumpReloadToken(tokens, 'b');
  assert.deepEqual(tokens, { a: 2, b: 1 });
  assert.equal(bumpReloadToken(tokens, ''), tokens);
});

test('dirty drafts only yield to an explicit refresh', () => {
  assert.equal(shouldReloadFromDisk(false, false), true);
  assert.equal(shouldReloadFromDisk(false, true), true);
  assert.equal(shouldReloadFromDisk(true, false), false);
  assert.equal(shouldReloadFromDisk(true, true), true);
});
