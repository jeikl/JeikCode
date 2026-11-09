import assert from 'node:assert/strict';
import test from 'node:test';

import type { SSEEvent } from '../api.ts';
import { reduceCanvasEvent } from './canvas/actions.ts';
import { mergeAuthoritativeTail } from './chatTerminal.ts';
import { acceptReplayFrame, createReplayFold, replayFrameOnCanvas, type ReplayFoldMessage } from './replayFold.ts';

/**
 * End-to-end shape of the stop-time regression:
 *
 * replay: previous turn's final assistant frame -> current turn's opening user
 *         -> current turn's assistant -> done
 * canvas: q2 + current assistant (disk tail; previous row absent)
 *
 * Before the fix the previous assistant was released immediately when the
 * window was fully expanded (historyOffset=0), appended after the current
 * answer, and the terminal disk merge preserved that bad order. The user anchor
 * must work with AND without the fold line.
 */

const user = (id: string, text: string): ReplayFoldMessage => ({
  role: 'user',
  id,
  parts: [{ kind: 'text', text }],
});
const assistant = (id: string, text: string): ReplayFoldMessage => ({
  role: 'assistant',
  id,
  parts: [{ kind: 'text', text }],
});

const frame = (event: Record<string, unknown>): SSEEvent => event as unknown as SSEEvent;

function runStopReplay(historyOffset: number) {
  const canvas = [
    { ...user('q1', 'q1'), sourceIndex: 19 },
    { ...assistant('m-tool', 'turn3 tool'), sourceIndex: 20 },
    { ...user('q2', 'q2'), sourceIndex: 38 },
    { ...assistant('m-current', 'r2'), sourceIndex: 39 },
  ];
  const fold = createReplayFold();
  const onCanvas = (event: SSEEvent) => replayFrameOnCanvas(canvas, event);
  const replayFrames = [
    frame({ type: 'text', content: 'r1stop', message_id: 'm-prev', seq: 1, replay: true }),
    frame({ type: 'user', content: 'q2', message_id: 'q2', seq: 2, replay: true }),
    frame({ type: 'text', content: 'r2', message_id: 'm-current', seq: 3, replay: true }),
    frame({ type: 'done', seq: 4, replay: true }),
  ];

  const paint: Array<{ frame: SSEEvent; beforeMessageId?: string }> = [];
  for (const event of replayFrames) {
    const accepted = acceptReplayFrame(fold, event, historyOffset, onCanvas);
    for (const painted of accepted.paint) {
      paint.push({ frame: painted, beforeMessageId: accepted.before?.messageId });
    }
  }

  let rows: any[] = canvas;
  for (const { frame: painted, beforeMessageId } of paint) {
    if (painted.type === 'text') {
      rows = reduceCanvasEvent(rows, {
        type: 'text',
        content: painted.content,
        messageId: painted.message_id,
        beforeMessageId,
      });
    }
  }

  // Terminal disk reconciliation (tail starts at q2, offset 38).
  const disk = [
    { ...user('q2', 'q2'), sourceIndex: 38 },
    { ...assistant('m-current', 'r2'), sourceIndex: 39 },
  ];
  const merged = mergeAuthoritativeTail(disk as any, rows, 38);
  return { rows, merged, ids: merged.map((row: any) => row.id) };
}

for (const offset of [38, 0]) {
  test(`stop replay keeps the previous answer before q2 (historyOffset=${offset})`, () => {
    const { ids } = runStopReplay(offset);
    assert.deepEqual(ids, ['q1', 'm-tool', 'm-prev', 'q2', 'm-current']);
    assert.ok(ids.indexOf('m-prev') < ids.indexOf('q2'), 'the old answer must stay before q2');
  });
}
