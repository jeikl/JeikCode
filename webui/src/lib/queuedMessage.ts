import type { ApprovalMode, ImageData } from '../api';

export interface QueuedMessage {
  /** Local/UI identity. New cards use a UUID; legacy persisted cards may be numeric. */
  id: number | string;
  text: string;
  images?: ImageData[];
  approvalMode: ApprovalMode;
  /** queue = send after this turn; steering = HTTP in flight; steer = folded next step. */
  kind: 'queue' | 'steering' | 'steer';
  /** 客户端关联键（= 发送给 /chat/steer 或 /live/message 的 client_input_id）。 */
  clientInputId?: string;
  forceSend?: boolean;
  createdAt?: number;
}

/**
 * 「立即发送」对一张卡片（尤其是转向卡）的处置。
 *
 * - `retire`：这条转向已经并入正文（画布或内核回执账本命中），只回收卡片，
 *   绝不能再次投递，否则同一句指令被执行两次；
 * - `steer`：还没投递过，先交给服务端裁决能否转向（只有 409 才回退停止+新回合）；
 * - `promote`：内核缓冲区里已经排着这条转向。send-now 的语义是「现在发」，
 *   必须先撤销那条排队转向，再停掉旧回合把它作为新回合发出。
 */
export type SendNowSteerAction = 'retire' | 'steer' | 'promote';

export function resolveSendNowSteerAction(input: {
  kind: QueuedMessage['kind'];
  folded: boolean;
}): SendNowSteerAction {
  if (input.folded) return 'retire';
  return input.kind === 'queue' ? 'steer' : 'promote';
}
