import type { ChatAction, ExtensionMessage } from './types';

type PermissionRequestMessage = Extract<ExtensionMessage, { type: 'permissionRequest' }>;
type PermissionRequestAction = Extract<ChatAction, { type: 'PERMISSION_REQUEST' }>;

export function permissionRequestAction(msg: PermissionRequestMessage): PermissionRequestAction {
  return {
    type: 'PERMISSION_REQUEST',
    id: msg.id,
    approvalId: msg.approvalId,
    sessionId: msg.sessionId,
    toolName: msg.toolName,
    reason: msg.reason,
    args: msg.args,
    isDestructive: msg.isDestructive,
  };
}
