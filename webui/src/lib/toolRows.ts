// Tool-row model + the dedup primitive shared by the chat view.
//
// Tool calls render as rows under an assistant message. The bug this guards
// against: a tool_start event for one logical call (same `id`/call_id) can reach
// the handler more than once — e.g. a leaked /live broadcast subscription
// re-delivers the whole turn — and naive appending then shows the SAME call as
// several identical rows. Dedup is by `id` (the kernel call_id), so genuinely
// distinct calls (different ids, even same name+args across goal rounds) stay
// separate, while a replayed event is coalesced. Mirrors the tuix
// coalesce-by-call_id fix (commit 80d6540f).

import type { SubtaskItem } from './subtasks';
import type { TodoItem } from './todos';

export interface ToolRow {
  id: string;
  name: string;
  args: string;
  status: 'pending' | 'done' | 'error' | 'incomplete' | 'waiting_approval';
  duration_ms?: number;
  output?: string;
  /** Ephemeral latest activity for a long-running tool. Replaced in place, never persisted. */
  progress?: string;
  /**
   * Parallel sub-agent rows for the `task` tool fan-out. Seeded from args and
   * updated by progress events so explore#1 / explore#3 show side-by-side
   * (TUI subtask panel parity) instead of alternating on one progress line.
   */
  subtasks?: SubtaskItem[];
}

/** One ordered conversation segment: a run of assistant text, one tool call, or a
 *  non-fatal advisory notice (e.g. "conversation compacted"). Arrival order is
 *  preserved so the text→tool→notice interleaving matches the TUI. */
/**
 * 展示段内部的 wire part 分片。
 *
 * 一个展示段可能合并多个 wire part（同 round 内的正文块 / 旧协议拆段），
 * 但每个 wire part 各自有独立的 `part_rev` 与累积正文。回放只能替换它自己那一段，
 * 否则会把已并入的其他段冲掉或重复追加。
 */
export interface PartSegment {
  id?: string;
  text: string;
  rev?: number;
}

export type MsgPart =
  /** `ids` keeps absorbed wire part ids after coalescing so a later replay
   *  addressed to any of them still lands on this logical part. */
  | { kind: 'text'; text: string; id?: string; ids?: string[]; rev?: number; segments?: PartSegment[] }
  /** Model reasoning / thinking stream — rendered as a collapsible block. */
  | { kind: 'reasoning'; text: string; id?: string; ids?: string[]; rev?: number; segments?: PartSegment[] }
  | { kind: 'tool'; tool: ToolRow }
  | { kind: 'notice'; text: string }
  | { kind: 'rate_limited'; text: string }
  /**
   * Frozen session todo list attached to the previous assistant reply when
   * the user starts the next turn. Live updates use the sticky panel instead.
   */
  | { kind: 'todo_list'; items: TodoItem[] };

/** Append or replace a trailing `todo_list` part on an assistant message. */
export function withTrailingTodoList(parts: MsgPart[], items: TodoItem[]): MsgPart[] {
  const without = parts.filter((p) => p.kind !== 'todo_list');
  if (items.length === 0) return without;
  return [...without, { kind: 'todo_list', items: items.map((i) => ({ ...i })) }];
}

function isTerminalToolStatus(status: ToolRow['status']): boolean {
  return status === 'done' || status === 'error' || status === 'incomplete';
}

function mergeToolRow(existing: ToolRow, incoming: ToolRow): ToolRow {
  const merged: ToolRow = { ...existing, ...incoming };
  // A leaked /live or /watch replay can re-deliver `tool_start` (pending) after
  // `tool_result` already settled the row. Keep the terminal status and any
  // output that the replay event omitted.
  if (isTerminalToolStatus(existing.status) && !isTerminalToolStatus(incoming.status)) {
    merged.status = existing.status;
  }
  if (incoming.output === undefined) merged.output = existing.output;
  if (incoming.duration_ms === undefined) merged.duration_ms = existing.duration_ms;
  return merged;
}

/**
 * Append `tool` as a new tool part, OR — when a tool part with the SAME `tool.id`
 * already exists — update that part in place (merging incoming fields over the
 * existing ones). Idempotent: replaying the same `tool_start` never adds a second
 * row. Pure; returns a new array (no mutation) for React state updates.
 */
export function upsertToolPart(parts: MsgPart[], tool: ToolRow): MsgPart[] {
  const idx = parts.findIndex((p) => p.kind === 'tool' && p.tool.id === tool.id);
  if (idx < 0) return [...parts, { kind: 'tool', tool }];
  const existing = (parts[idx] as { kind: 'tool'; tool: ToolRow }).tool;
  const next = parts.slice();
  next[idx] = { kind: 'tool', tool: mergeToolRow(existing, tool) };
  return next;
}

export function replaceToolOutput(
  parts: MsgPart[],
  id: string | undefined,
  content: string,
): MsgPart[] {
  let idx = -1;
  if (id) {
    idx = parts.findIndex((p) => p.kind === 'tool' && p.tool.id === id);
  }
  if (idx < 0) idx = parts.map((p) => p.kind).lastIndexOf('tool');
  if (idx < 0) return parts;
  const part = parts[idx] as { kind: 'tool'; tool: ToolRow };
  const next = parts.slice();
  next[idx] = { kind: 'tool', tool: { ...part.tool, output: content } };
  return next;
}

export function updateToolProgress(
  parts: MsgPart[],
  id: string,
  progress: string,
  /** Optional full tool patch (e.g. updated subtasks list). */
  patch?: Partial<ToolRow>,
): MsgPart[] {
  return parts.map((part) =>
    part.kind === 'tool' && part.tool.id === id
      ? {
          kind: 'tool' as const,
          tool: { ...part.tool, progress, ...patch },
        }
      : part,
  );
}

/** Bound live-appended tool output so a runaway `yes`/build log cannot freeze the tab. */
export const MAX_LIVE_TOOL_OUTPUT = 256 * 1024;

/**
 * Append a live stdout/stderr chunk to the matching tool row.
 * Prefer `id` (kernel call_id) so parallel tools do not mix; fall back to the
 * most recent tool part when the wire event omitted it.
 */
export function appendToolOutput(
  parts: MsgPart[],
  id: string | undefined,
  chunk: string,
): MsgPart[] {
  if (!chunk) return parts;
  let idx = -1;
  if (id) {
    idx = parts.findIndex((p) => p.kind === 'tool' && p.tool.id === id);
  }
  if (idx < 0) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]!.kind === 'tool') {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return parts;
  const tp = parts[idx] as { kind: 'tool'; tool: ToolRow };
  const normalizedChunk = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const prevOut = tp.tool.output ?? '';
  let sep = '';
  if (
    prevOut &&
    !prevOut.endsWith('\n') &&
    !normalizedChunk.startsWith('\n') &&
    (normalizedChunk.includes('\n') ||
      /[.:!?;…\]）】]$/.test(prevOut.trim()) ||
      /^[\p{Script=Han}\[A-Z]/u.test(normalizedChunk.trim()))
  ) {
    sep = '\n';
  }
  let output = prevOut + sep + normalizedChunk;
  if (output.length > MAX_LIVE_TOOL_OUTPUT) {
    output = output.slice(output.length - MAX_LIVE_TOOL_OUTPUT);
  }
  const next = parts.slice();
  const finished = /\[exit code |\[bash cancelled\]|\[bash reached max_timeout_secs\]|\[task was canceled by bash kill tool\]/.test(
    output,
  );
  next[idx] = {
    kind: 'tool',
    tool: {
      ...tp.tool,
      output,
      status: finished ? (tp.tool.status === 'error' ? 'error' : 'done') : tp.tool.status,
    },
  };
  return next;
}

/** Append a reasoning delta to the last reasoning part, or start a new one.
 *  `id` 是线协议里的 part 身份：建新部件时立即盖章，后续重放/重连才能按 part
 *  定向合并（没有身份就只能靠文本启发式，会在刷新时把整段思考重打一遍）。 */
export function appendReasoningPart(parts: MsgPart[], delta: string, id?: string): MsgPart[] {
  if (!delta) return parts;
  const tail = parts[parts.length - 1];
  // 核心铁律：若末尾已经是思考部件，一律无缝合并进这同一个思考部件，严禁连续出现两个思考部件！
  if (tail && tail.kind === 'reasoning') {
    const next = parts.slice();
    const ids = Array.from(new Set([
      ...(tail.id ? [tail.id] : []),
      ...(tail.ids ?? []),
      ...(id ? [id] : []),
    ]));
    const primary = tail.id ?? id;
    const aliases = ids.filter((value) => value !== primary);
    next[next.length - 1] = {
      kind: 'reasoning',
      text: tail.text + delta,
      ...(primary ? { id: primary } : {}),
      ...(aliases.length > 0 ? { ids: aliases } : {}),
    };
    return next;
  }
  return [...parts, { kind: 'reasoning', text: delta, ...(id ? { id } : {}) }];
}

export function toolResultStatus(
  success: boolean,
  output: string,
  toolName?: string,
): ToolRow['status'] {
  // Only a live bash pane uses this marker. Guide/docs tools quote the same
  // string; matching any output would leave them "运行中" with a blinking caret
  // after the call already finished.
  const name = (toolName ?? '').toLowerCase();
  if (
    (name === 'bash' || name === 'run_command') &&
    output.includes('[bash-await-decision]')
  ) {
    return 'pending';
  }
  if (success) return 'done';
  return output.startsWith('Code review incomplete') ? 'incomplete' : 'error';
}

function isBashAwaitDecision(tool: ToolRow): boolean {
  const name = tool.name.toLowerCase();
  return (
    (name === 'bash' || name === 'run_command') &&
    (tool.output ?? '').includes('[bash-await-decision]')
  );
}

/**
 * 执行已返回时的行状态补丁（`tool_finished` 帧）。
 *
 * 权威 `tool_result` 必须按发射顺序落地（provider 配对 / 前缀缓存确定性），
 * 所以同一并发批次里的短工具本来要陪长工具一起“运行中”。这里只落状态，
 * 不改 `output` / `duration_ms`：它们仍由稍后的权威结果帧负责。
 *
 * `[bash-await-decision]` 是“进程还活着、在等用户决定”，执行返回不等于完成，
 * 保持 pending 交给权威结果帧判定。幂等：已终态的行不再回退。
 */
export function settleToolRow(
  tool: ToolRow,
  success: boolean,
): Partial<ToolRow> | undefined {
  if (isTerminalToolStatus(tool.status)) return undefined;
  if (isBashAwaitDecision(tool)) return undefined;
  return { status: success ? 'done' : 'error', progress: undefined };
}

/**
 * Turn ended: settle leftover pending rows except a still-live bash await.
 *
 * 只落成 `incomplete`（未完成），绝不猜 `done` / `error`：没有 `tool_result`
 * 就说明我们根本不知道进程是正常退出、被杀掉还是结果帧丢在断网期。
 * 把带输出的僵尸行标成「完成」正是「假完成」的来源；磁盘上真有结果时，
 * 权威对账（`adoptAuthoritativeDiskTail`）会把整行替换成真实状态。
 */
export function finalizeToolsAfterTurn(
  parts: MsgPart[],
  opts?: {
    /**
     * 默认 true：`[bash-await-decision]` 行是“进程还活着、在等用户决定”，
     * 回合收尾时必须保持 pending（这是审批卡的数据源）。
     * 服务端已确认没有任何回合在跑时传 false：那种行也不可能再等到决定。
     */
    keepAwaitingBashDecision?: boolean;
  },
): MsgPart[] {
  const keepAwait = opts?.keepAwaitingBashDecision !== false;
  let changed = false;
  const next = parts.map((part) => {
    if (part.kind !== 'tool') return part;
    // waiting_approval 也在内：回合已结束，不可能再有人点那张审批卡。
    if (part.tool.status !== 'pending' && part.tool.status !== 'waiting_approval') return part;
    if (keepAwait && isBashAwaitDecision(part.tool)) return part;
    changed = true;
    return {
      kind: 'tool' as const,
      tool: {
        ...part.tool,
        status: 'incomplete' as const,
        progress: undefined,
      },
    };
  });
  // 幂等：没有任何需要收尾的行就返回原数组，避免调用方因“新数组”重渲染/重写缓存。
  return changed ? next : parts;
}
