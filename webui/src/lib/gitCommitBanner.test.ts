import test from 'node:test';
import assert from 'node:assert/strict';

import { formatGitCommitBanner, resolveCommittedFileCount } from './gitCommitBanner.ts';

function mockT(key: string, params?: Record<string, string | number>): string {
  if (key === 'git.commitSuccessCount') {
    return `${params?.count} 个文件已提交`;
  }
  if (key === 'git.commitSuccess') {
    return '提交成功';
  }
  return key;
}

test('优先使用结构化 files_changed 生成单行绿色摘要且不暴露文件明细', () => {
  const banner = formatGitCommitBanner(
    {
      files_changed: 99,
      message: '[beta 69e85680d] docs cleanup (99 files changed)',
    },
    mockT,
    3,
  );
  assert.equal(banner, '99 个文件已提交');
});

test('兼容旧版 daemon 返回的多行 raw stdout，只抽取文件总数防止刷屏', () => {
  const legacyRaw = [
    '[beta 69e85680d] 文档清除',
    ' 99 files changed, 2147 insertions(+), 31682 deletions(-)',
    ' delete mode 100644 docs/architecture.md',
    ' delete mode 100644 docs/plans/a.md',
    ' create mode 100644 docs/report.md',
  ].join('\n');
  const banner = formatGitCommitBanner({ message: legacyRaw }, mockT);
  assert.equal(banner, '99 个文件已提交');
  assert.ok(!banner.includes('delete mode'));
  assert.ok(!banner.includes('docs/architecture.md'));
});

test('单文件输出、无统计信息时回退 fallbackCount，零文件或缺失时返回简洁提交成功', () => {
  assert.equal(
    formatGitCommitBanner({ message: '[beta abc1234] fix\n 1 file changed, 2 insertions(+)' }, mockT),
    '1 个文件已提交',
  );
  assert.equal(formatGitCommitBanner({ message: 'Commit successful' }, mockT, 4), '4 个文件已提交');
  assert.equal(formatGitCommitBanner({ files_changed: 0, message: '[beta x] empty' }, mockT, 4), '提交成功');
  assert.equal(resolveCommittedFileCount(undefined, 0), undefined);
});
