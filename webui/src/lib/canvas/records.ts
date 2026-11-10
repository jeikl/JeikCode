/**
 * 画布记录模型（CanvasRecord）。
 *
 * 这是画布状态层的**唯一实体类型**。它取代了旧的 `Message` 数组语义：
 * - `id`：终身身份（用户 `u-` / 模型 `m-` / 系统 `s-`）；
 * - `seq`：会话内单调顺序号（服务端 display seq；旧 daemon 才回退 sourceIndex）；
 * - `kind`：`user` / `model` / `system`，由 `role` 派生并持久在行上；
 * - `parts`：模型/用户的内容部件（思考 / 正文 / 工具 / 通知）。
 *
 * 坐标纪律（违反任意一条都会长回第六套坐标）：
 * 1. `seq` 是唯一顺序键；`sourceIndex` 只是分页游标，不参与判重/排序。
 * 2. `id` 是唯一身份；`clientInputId` 只是旧 daemon 的 `id` 别名。
 * 3. `part_rev` 只负责同一 part 的内容幂等，不参与记录排序。
 *
 * 渲染层暂时仍消费 `role + parts` 的形状，因此 `CanvasRecord` 保留这两个字段；
 * 但**排序、判重、归档、跨端对账只允许看 `id` 与 `seq`**，绝不看文本。
 */
import type { ImageData } from '../../api';
import type { MsgPart } from '../toolRows';

export type RecordKind = 'user' | 'model' | 'system';

export interface CanvasRecord {
  /** 记录类型。旧行可能缺失，由 `normalizeCanvas` 从 role 派生后写回。 */
  kind?: RecordKind;
  /** 会话内单调顺序号。旧行可能缺失，由 `normalizeCanvas` 从 sourceIndex 派生。 */
  seq?: number;

  role: 'user' | 'assistant' | 'system';
  parts: MsgPart[];
  images?: ImageData[];
  /** 管线派发的稳定消息 id（message_id）。 */
  id?: string;
  /** Epoch ms this message was sent/received. */
  ts?: number;
  /** Browser-local correlation for an optimistic /live submission. Never persisted. */
  pendingSteerId?: string;
  /** 是否为中途转向注入（Steer）消息。 */
  isSteer?: boolean;
  /** Admitted input projected from the durable input log, not yet persisted. */
  pendingInput?: boolean;
  /** Wall-clock duration of this assistant turn (ms). */
  elapsedMs?: number;
  /** Absolute index in the persisted raw transcript（= 磁盘行的 seq）。 */
  sourceIndex?: number;
  /** `sourceIndex` 的来源：只有磁盘/服务端映射出的下标是权威排序坐标；
   *  本地预测下标没有该标记，合并时只能沿用数组因果顺序。 */
  sourceIndexAuthority?: 'disk' | 'outline';
  /** Persisted kernel turn id of the row (display/session detail). Lets a steer
   *  delivered after a terminal be distinguished from a mid-turn steer even
   *  after a refresh; live rows may omit it. */
  turnId?: number;
  /** 客户端关联键（`client_input_id`）：新契约下与 `id` 同值。 */
  clientInputId?: string;
  /** Rebuilt from the append-only JSONL after compaction: edit/delete disabled. */
  readOnly?: boolean;
}

/** `role` → `kind` 的唯一映射。 */
export function recordKind(role: string | undefined): RecordKind {
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  return 'model';
}
