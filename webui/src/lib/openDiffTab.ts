export interface OpenDiffTab {
  id: string; // `${commit.short_hash}:${file.path}` 或 `editor:${absPath}`
  commitHash: string;
  commitShortHash: string;
  commitMessage: string;
  filePath: string;
  fileName: string;
  fileStatus: string;
  diffText: string;
  loading: boolean;
  /** 'editor' 为普通文件编辑标签（App 头部标签栏创建）；缺省表示 git diff 标签。 */
  type?: 'editor';
  startLine?: number;
  endLine?: number;
}
