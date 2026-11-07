import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeOlderMessages,
  resolveHistoryOffset,
  cachedHeadIsContiguous,
  spliceAuthoritativeDiskTail,
} from './sessionProjection.ts';
import { normalizeCanvas } from './canvas/canvasStore.ts';
import {
  mergeDiskWithUnpersistedTail,
  transcriptHasInFlightAssistant,
} from './chatTerminal.ts';
import { placeArchivedTodos } from './todos.ts';
import { remainingUnloadedTurns } from './turnNav.ts';
import { stashSessionQueued, restoreSessionQueued } from './queuedDraft.ts';

type Part = {
  kind: string;
  text?: string;
  tool?: { id?: string; name?: string; status?: string; output?: string };
};
type Row = {
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Part[];
  sourceIndex?: number;
  ts?: number;
  isSteer?: boolean;
};

const user = (id: string, text: string, index: number, extra: Partial<Row> = {}): Row => ({
  id,
  role: 'user',
  parts: [{ kind: 'text', text }],
  sourceIndex: index,
  ts: 1_700_000_000_000 + index,
  ...extra,
});

const assistant = (id: string, text: string, index: number, extra: Partial<Row> = {}): Row => ({
  id,
  role: 'assistant',
  parts: text ? [{ kind: 'text', text }] : [],
  sourceIndex: index,
  ...extra,
});

const toolRow = (id: string, callId: string, index: number): Row => ({
  id,
  role: 'tool',
  parts: [{ kind: 'tool', tool: { id: callId, name: 'run_command', status: 'done' } }],
  sourceIndex: index,
});

/** A dense display list: user / assistant / tool per turn. */
function history(turns: number, session = 's'): Row[] {
  const rows: Row[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const base = turn * 3;
    rows.push(user(`${session}-u-${turn}`, `question ${turn}`, base));
    rows.push(assistant(`${session}-a-${turn}`, `answer ${turn}`, base + 1));
    rows.push(toolRow(`${session}-t-${turn}`, `${session}-call-${turn}`, base + 2));
  }
  return rows;
}

function page(rows: Row[], offset: number, limit = 48): { offset: number; messages: Row[] } {
  const start = Math.max(0, Math.min(offset, rows.length));
  return { offset: start, messages: rows.slice(start, start + limit) };
}

/** The cold-start loop used by Chat.tsx: tail first, then merge older pages. */
function coldStart(rows: Row[], limit = 48): Row[] {
  const tail = page(rows, Math.max(0, rows.length - limit), limit);
  let canvas = tail.messages;
  let offset = tail.offset;
  let guard = 0;
  while (offset > 0 && guard++ < 100) {
    const older = page(rows, Math.max(0, offset - limit), limit);
    canvas = mergeOlderMessages(canvas, older.messages);
    if (older.offset >= offset) break;
    offset = older.offset;
  }
  return canvas;
}

function assertStableRows(rows: Row[], expectedIds: string[]) {
  const ids = rows.map((row) => row.id).filter((id): id is string => !!id);
  assert.equal(new Set(ids).size, ids.length, 'message ids must be unique');
  assert.deepEqual([...ids].sort(), [...expectedIds].sort(), 'no row may be lost');
  const indexed = rows.filter((row) => typeof row.sourceIndex === 'number');
  for (let i = 1; i < indexed.length; i++) {
    assert.ok(
      indexed[i]!.sourceIndex! >= indexed[i - 1]!.sourceIndex!,
      'indexed rows must stay ascending',
    );
  }
}

test('cold start: tail + older pages covers every row exactly once', () => {
  const rows = history(40); // 120 rows
  const canvas = coldStart(rows);
  assert.equal(canvas.length, rows.length);
  assertStableRows(canvas, rows.map((row) => row.id!));
});

test('warm start: full cache + tail merge is idempotent; stale compaction cache is rejected', () => {
  const rows = history(40);
  const diskOffset = Math.max(0, rows.length - 48);
  const cached = coldStart(rows);
  const tail = page(rows, diskOffset).messages;

  assert.equal(cachedHeadIsContiguous(cached, diskOffset), true);
  assert.equal(
    resolveHistoryOffset({ cachedMessages: cached, cachedOffset: 0, diskOffset }),
    0,
  );
  assert.equal(mergeOlderMessages(cached, tail).length, rows.length);

  // A partial cache with only a far head and the tail must be rejected; the
  // "load older" cursor walks backward from the head and cannot fill the hole.
  const hole = [...rows.slice(0, 31), ...rows.slice(diskOffset)];
  assert.equal(cachedHeadIsContiguous(hole, diskOffset), false);

  // The cache was written before a compaction: its coordinates end far before
  // the new authoritative tail. It must not be treated as contiguous.
  const stale = history(15); // 45 rows
  const compacted = history(60); // 180 rows
  const compactedTail = Math.max(0, compacted.length - 48);
  assert.equal(cachedHeadIsContiguous(stale, compactedTail), false);
  const remote = coldStart(compacted);
  assert.equal(remote.length, compacted.length);
  assertStableRows(remote, compacted.map((row) => row.id!));
});

test('remote cold start: empty cache on a compacted session pages from zero', () => {
  const rows = history(70); // 210 rows, simulates prefix + retained suffix
  const canvas = coldStart(rows);
  assert.equal(canvas.length, rows.length);
  assert.equal(
    remainingUnloadedTurns(
      rows
        .filter((row) => row.role === 'user')
        .map((row) => ({ index: row.sourceIndex! })),
      canvas,
    ),
    0,
  );
});

test('session switch: canvases and queued steer cards never cross sessions', () => {
  const a = coldStart(history(10, 'session-A'));
  const b = coldStart(history(20, 'session-B'));
  const canvases = new Map([
    ['A', a],
    ['B', b],
  ]);
  assert.equal(canvases.get('A')!.length, 30);
  assert.equal(canvases.get('B')!.length, 60);
  assert.notEqual(canvases.get('A')![0]!.id, canvases.get('B')![0]!.id);

  const stash = new Map<string, string[]>();
  stashSessionQueued(stash, 'A', ['steer-A', 'queue-A']);
  stashSessionQueued(stash, 'B', ['steer-B']);
  assert.deepEqual(restoreSessionQueued(stash, 'A'), ['steer-A', 'queue-A']);
  assert.deepEqual(restoreSessionQueued(stash, 'B'), ['steer-B']);
  // Switching back must not leak B's card into A.
  assert.deepEqual(restoreSessionQueued(stash, 'A'), ['steer-A', 'queue-A']);
});

test('steer fold before/after done: todo host, bubble and new loop survive old disk reconcile', () => {
  const base = [user('u-1', '上一问', 0), assistant('a-1', '上一答', 1)];
  const disk = [base[0]!, base[1]!];
  const archive = [{ content: '完成项', status: 'completed' as const }];

  // Event order A: steered/fold happens first, then the old done commits todo.
  const folded = [
    ...base,
    user('s-1', 'steer 自然发出', 2, { isSteer: true }),
    assistant('sa-1', '', 3),
  ];
  const archived = placeArchivedTodos(folded, archive, null);
  assert.equal(
    archived[1]!.parts.some((part) => part.kind === 'todo_list'),
    true,
    'todo must land on the previous answer',
  );
  assert.equal(
    archived[3]!.parts.some((part) => part.kind === 'todo_list'),
    false,
    'todo must not land on the new steer placeholder',
  );

  // Event order B: the old done commits the todo BEFORE the steer is delivered.
  const afterDone = placeArchivedTodos(base, archive, null);
  assert.equal(
    afterDone[1]!.parts.some((part) => part.kind === 'todo_list'),
    true,
    'done-first keeps the todo on the previous answer',
  );
  const delivered = [
    ...afterDone,
    user('s-1', 'steer 自然发出', 2, { isSteer: true }),
    { id: 'sa-1', role: 'assistant' as const, parts: [] },
  ];
  const running = delivered.map((row, index) =>
    index === 3
      ? {
          ...row,
          parts: [
            { kind: 'reasoning', text: '新 loop 思考' },
            { kind: 'tool', tool: { id: 'call-new', name: 'run_command', status: 'pending' } },
          ],
        }
      : row,
  );
  assert.equal(transcriptHasInFlightAssistant(running), true);
  const merged = mergeDiskWithUnpersistedTail(
    spliceAuthoritativeDiskTail(running, disk, 2),
    running,
  );
  assert.equal(merged.length, 4);
  assert.equal(
    merged[2]!.parts.some((part) => part.text === 'steer 自然发出'),
    true,
  );
  assert.equal(
    merged[3]!.parts.some((part) => part.tool?.id === 'call-new'),
    true,
  );
});

test('duplicate steered replay does not create a second steer bubble', () => {
  const base = [user('u-1', 'Q', 0), assistant('a-1', 'A', 1)];
  const fold = (canvas: Row[], text: string): Row[] => {
    if (
      canvas.some(
        (row) =>
          row.role === 'user' &&
          row.parts.some((part) => part.kind === 'text' && part.text === text),
      )
    ) {
      return canvas;
    }
    return [...canvas, user('s-1', text, 2, { isSteer: true }), assistant('sa-1', '', 3)];
  };
  const once = fold(base, 'steer 自然发出');
  const twice = fold(once, 'steer 自然发出');
  assert.equal(twice.filter((row) => row.role === 'user').length, 2);
  assert.equal(twice.length, 4);
});

test('out-of-order and overlapping pages never duplicate or invert the transcript', () => {
  const rows = history(30);
  const tail = page(rows, rows.length - 48).messages;
  // Deliberately reverse the first page; the insertion must still be sorted.
  const older = page(rows, 0).messages.slice().reverse();
  const merged = mergeOlderMessages(tail, older);
  assertStableRows(merged, rows.map((row) => row.id!));

  // Replay the exact same page (watch/reconnect overlap).
  const replayed = mergeOlderMessages(merged, page(rows, 0).messages);
  assert.equal(replayed.length, merged.length);
  assertStableRows(replayed, rows.map((row) => row.id!));

  // Two consecutive identical user prompts with different absolute indices are
  // real messages and must both survive.
  const repeated = mergeOlderMessages(
    [user('u-a', 'same', 0), assistant('a-a', 'A', 1)],
    [user('u-b', 'same', 2)],
  );
  assert.equal(repeated.filter((row) => row.role === 'user').length, 2);
});

test('event-order matrix: steer/tool/reconcile in several interleavings', () => {
  const rows = history(20);
  const base = page(rows, rows.length - 48).messages;
  const disk = page(rows, rows.length - 6).messages.filter((row) => row.role !== 'tool');
  // A tool can only belong to the new loop after the steer exists, so these
  // are the realistic interleavings of steer arrival, first tool, and the old
  // turn's disk reconcile.
  const orders = [
    ['steer', 'tool', 'reconcile'],
    ['steer', 'reconcile', 'tool'],
    ['reconcile', 'steer', 'tool'],
    ['reconcile', 'steer', 'reconcile', 'tool'],
  ] as const;

  for (const order of orders) {
    // Clone rows/parts: the tool step mutates the last assistant, and the
    // same base rows are reused by the next permutation.
    let canvas: Row[] = base.map((row) => ({
      ...row,
      parts: row.parts.map((part) => ({ ...part, tool: part.tool ? { ...part.tool } : undefined })),
    }));
    let steered = false;
    for (const step of order) {
      if (step === 'steer') {
        if (!steered) {
          canvas = [
            ...canvas,
            user('s-x', 'steer 自然发出', rows.length + 2, { isSteer: true }),
            // The live placeholder intentionally has no sourceIndex yet.
            { id: 'sa-x', role: 'assistant', parts: [] },
          ];
          steered = true;
        }
      } else if (step === 'tool') {
        const last = canvas[canvas.length - 1];
        if (last && last.role === 'assistant') {
          last.parts = [
            ...last.parts,
            { kind: 'tool', tool: { id: 'call-x', name: 'run_command', status: 'pending' } },
          ];
        }
      } else if (step === 'reconcile') {
        canvas = mergeDiskWithUnpersistedTail(
          spliceAuthoritativeDiskTail(canvas, disk, rows.length - 6),
          canvas,
        );
      }
    }

    const sanitized = normalizeCanvas(canvas);
    const ids = sanitized.map((row) => row.id).filter((id): id is string => !!id);
    assert.equal(new Set(ids).size, ids.length, `duplicate in order ${order.join('>')}`);
    assert.equal(
      sanitized.filter((row) => row.role === 'user' && row.parts.some((p) => p.text === 'steer 自然发出')).length,
      1,
      `steer duplicated in order ${order.join('>')}`,
    );
    const steerIndex = sanitized.findIndex(
      (row) => row.role === 'user' && row.parts.some((p) => p.text === 'steer 自然发出'),
    );
    const toolIndex = sanitized.findIndex((row) =>
      row.parts.some((part) => part.kind === 'tool' && part.tool?.id === 'call-x'),
    );
    assert.ok(steerIndex >= 0, `steer missing in order ${order.join('>')}`);
    assert.ok(toolIndex > steerIndex, `new loop must follow its steer in order ${order.join('>')}`);
  }
});

test('after a compacted disk snapshot, a new steer keeps the full display history', () => {
  const full = coldStart(history(60)); // 180 display rows survive compaction
  const compactedDisk = full.slice(-6); // snapshot only retains the last steps
  const steer = user('post-compact-steer', 'steer after compact', full.length, {
    isSteer: true,
  });
  const newLoop = {
    id: 'post-compact-assistant',
    role: 'assistant' as const,
    parts: [{ kind: 'tool', tool: { id: 'post-compact-tool', name: 'read', status: 'pending' } }],
  };
  const canvas = [...full, steer, newLoop];
  const spliced = spliceAuthoritativeDiskTail(canvas, compactedDisk, full.length - 6);
  const merged = mergeDiskWithUnpersistedTail(spliced, canvas);

  assert.equal(merged.length, full.length + 2);
  assertStableRows(merged, [...full.map((row) => row.id!), steer.id!, newLoop.id!]);
  const steerIndex = merged.findIndex((row) => row.id === steer.id);
  const toolIndex = merged.findIndex((row) =>
    row.parts.some((part) => part.tool?.id === 'post-compact-tool'),
  );
  assert.ok(steerIndex >= full.length - 1);
  assert.ok(toolIndex > steerIndex);
});

test('cache schema version is 14, so pre-transient canvases are not trusted', async () => {
  const { CACHE_DISPLAY_VERSION, CACHE_SCHEMA } = await import('./sessionCache.ts');
  assert.equal(CACHE_SCHEMA, 14);
  assert.equal(CACHE_DISPLAY_VERSION, CACHE_SCHEMA);
});
