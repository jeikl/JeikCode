/**
 * 应用内“刷新”事件。
 *
 * 工具栏刷新按钮过去直接 `window.location.reload()`：整页重建会把焦点、滚动位置、
 * 侧栏展开状态和终端连接全部推倒重来，视觉上就是一次“假刷新”。
 * 刷新会话数据不需要重建 UI —— 只用一条全局事件让各数据源各自重新对账。
 */

export const SOFT_REFRESH_EVENT = 'jeikcode:soft-refresh';

export function requestSoftRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SOFT_REFRESH_EVENT));
}

export function onSoftRefresh(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SOFT_REFRESH_EVENT, handler);
  return () => window.removeEventListener(SOFT_REFRESH_EVENT, handler);
}
