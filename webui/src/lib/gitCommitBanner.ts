export interface GitCommitBannerInput {
  files_changed?: number;
  message?: string;
}

export type GitCommitBannerKey = 'git.commitSuccessCount' | 'git.commitSuccess';

export type GitBannerTranslator = (key: GitCommitBannerKey, params?: { count: number }) => string;

/** 从提交响应中提取变更文件数，兼容结构化字段与旧版多行 git stdout 回退匹配。 */
export function resolveCommittedFileCount(
  res?: GitCommitBannerInput | null,
  fallbackCount?: number,
): number | undefined {
  if (typeof res?.files_changed === 'number' && Number.isFinite(res.files_changed) && res.files_changed >= 0) {
    return res.files_changed;
  }
  const msg = res?.message ?? '';
  const match = msg.match(/\b(\d+)\s+files?\s+changed\b/i);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (typeof fallbackCount === 'number' && Number.isFinite(fallbackCount) && fallbackCount > 0) {
    return fallbackCount;
  }
  return undefined;
}

/** 生成 Git 面板提交成功绿色摘要文案，避免大量文件的 delete/create mode 输出刷屏。 */
export function formatGitCommitBanner(
  res: GitCommitBannerInput | null | undefined,
  t: GitBannerTranslator,
  fallbackCount?: number,
): string {
  const count = resolveCommittedFileCount(res, fallbackCount);
  if (count !== undefined && count > 0) {
    return t('git.commitSuccessCount', { count });
  }
  return t('git.commitSuccess');
}
