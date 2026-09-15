import type { ModelInfo } from '../api';

/** 下拉主文案：配置里的模型别名（selection id）。 */
export function modelAliasLabel(m: Pick<ModelInfo, 'provider'>): string {
  return m.provider.trim() || 'model';
}

/**
 * 括号内文案：`提供商/modelId`。
 * 提供商优先用账号 id；没有账号时退回协议类型，避免括号里只剩重复别名。
 */
export function modelSourceLabel(
  m: Pick<ModelInfo, 'account' | 'model' | 'provider_type'>,
): string {
  const modelId = m.model.trim();
  const account = m.account?.trim();
  if (account && modelId) return `${account}/${modelId}`;
  if (modelId && m.provider_type?.trim()) {
    return `${m.provider_type.trim()}/${modelId}`;
  }
  return modelId;
}
