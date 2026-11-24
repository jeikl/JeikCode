import { fetchGitRepos, fetchGitStatus, type GitStatusResponse } from '../api.ts';

function normalize(path: string): string {
  const value = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(value) ? value.toLowerCase() : value;
}

export function findChangedFile(path: string, root: string, status: GitStatusResponse) {
  const target = normalize(path);
  const base = normalize(root);
  if (!status.is_repo || !target.startsWith(base + '/')) return null;
  const relative = target.slice(base.length + 1);
  for (const [items, staged] of [[status.unstaged, false], [status.untracked, false], [status.staged, true]] as const) {
    const file = items.find((item) => normalize(item.path) === relative ||
      (/^[a-z]:/i.test(root) && normalize(item.path).toLowerCase() === relative));
    if (file) return { file, staged, repoRoot: root };
  }
  return null;
}

export async function lookupMarkdownGitFile(path: string, cwd?: string) {
  if (!cwd) return null;
  const { repos } = await fetchGitRepos(cwd);
  const target = normalize(path);
  const repo = repos.filter((r) => target.startsWith(normalize(r.root) + '/'))
    .sort((a, b) => normalize(b.root).length - normalize(a.root).length)[0];
  if (!repo) return null;
  return findChangedFile(path, repo.root, await fetchGitStatus(repo.root));
}
