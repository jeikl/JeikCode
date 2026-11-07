import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileStampFromRead,
  fileStampFromStat,
  sameFileStamp,
  type FileStamp,
} from './fileStamp.ts';

const stamp = (overrides: Partial<FileStamp> = {}): FileStamp => ({
  exists: true,
  modifiedMs: 1_700_000_000_000,
  size: 120,
  ...overrides,
});

test('stat responses become a comparable stamp', () => {
  assert.deepEqual(
    fileStampFromStat({ exists: true, size: 42, modified_ms: 123 }),
    { exists: true, modifiedMs: 123, size: 42 },
  );
  assert.deepEqual(fileStampFromStat({ exists: false }), {
    exists: false,
    modifiedMs: null,
    size: 0,
  });
});

test('read responses provide the baseline and tolerate legacy payloads', () => {
  assert.deepEqual(fileStampFromRead({ size: 9, modified_ms: 5 }), {
    exists: true,
    modifiedMs: 5,
    size: 9,
  });
  assert.equal(fileStampFromRead({ content: 'legacy' }), null);
});

test('sameFileStamp treats mtime, size and deletion as distinct changes', () => {
  const base = stamp();
  assert.equal(sameFileStamp(base, stamp()), true);
  assert.equal(sameFileStamp(base, stamp({ modifiedMs: 2 })), false);
  assert.equal(sameFileStamp(base, stamp({ size: 121 })), false);
  assert.equal(sameFileStamp(base, stamp({ exists: false })), false);
  assert.equal(sameFileStamp(null, null), true);
  assert.equal(sameFileStamp(null, base), false);
  assert.equal(sameFileStamp(base, null), false);
});
