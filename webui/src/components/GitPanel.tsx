import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { useSettings } from '../settings';
import {
  fetchGitBranches,
  fetchGitGraph,
  checkoutGitBranch,
  fetchGitCommitDetail,
  fetchGitStatus,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitCommit,
  gitPush,
  gitPull,
  gitAction,
  fetchGitRepos,
  type GitBranchesResponse,
  type GitCommitItem,
  type GitCommitFile,
  type GitStatusResponse,
  type GitStatusItem,
  type GitRepoInfo,
} from '../api';
import {
  buildGitGraph,
  formatRelativeTime,
  formatRelativeTimeI18n,
  formatCommitDateTime,
  ROW_HEIGHT,
  LANE_WIDTH,
  LANE_OFFSET,
} from '../lib/gitGraph';

interface GitPanelProps {
  cwd?: string;
  refreshTrigger?: number;
  onBranchChanged?: (newBranch: string) => void;
  onOpenFileDiff?: (commit: GitCommitItem, file: GitCommitFile, repoRoot?: string) => void;
  onOpenWorkingDiff?: (file: GitStatusItem, staged: boolean, repoRoot?: string) => void;
}

export function GitPanel({
  cwd,
  refreshTrigger,
  onBranchChanged,
  onOpenFileDiff,
  onOpenWorkingDiff,
}: GitPanelProps) {
  const { t, lang } = useSettings();
  const isZh = lang === 'zh';

  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [commits, setCommits] = useState<GitCommitItem[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [filterBranch, setFilterBranch] = useState<'all' | string>('all');
  const [subView, setSubView] = useState<'changes' | 'graph' | 'branches'>('changes');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Expanded commit state for modified files
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Record<string, GitCommitFile[]>>({});
  const [loadingCommitHash, setLoadingCommitHash] = useState<string | null>(null);

  // Multi-repository support
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [activeRepoRoot, setActiveRepoRoot] = useState<string | null>(null);
  const effectiveCwd = activeRepoRoot || cwd;

  // Scan and discover all git repositories in workspace
  useEffect(() => {
    let unmounted = false;
    fetchGitRepos(cwd)
      .then((res) => {
        if (unmounted) return;
        setRepos(res.repos);
        if (res.repos.length > 0) {
          setActiveRepoRoot((current) => {
            if (current && res.repos.some((r) => r.root === current)) return current;
            const rootRepo = res.repos.find((r) => r.is_root) || res.repos[0];
            return rootRepo ? rootRepo.root : null;
          });
        }
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [cwd]);

  // VSCode Context Menu State
  interface ContextMenuState {
    x: number;
    y: number;
    commit: GitCommitItem;
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // VSCode-style Commit Hover Details State
  interface HoverCommitState {
    x: number;
    y: number;
    commit: GitCommitItem;
  }
  const [hoverCommit, setHoverCommit] = useState<HoverCommitState | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleRowMouseEnter = useCallback((e: MouseEvent, commit: GitCommitItem) => {
    clearHoverTimer();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    hoverTimerRef.current = window.setTimeout(() => {
      const cardWidth = 440;
      const cardHeight = 320;
      let x = rect.left + Math.min(rect.width * 0.45, 260);
      if (x + cardWidth > window.innerWidth - 16) {
        x = Math.max(16, window.innerWidth - cardWidth - 16);
      }
      let y = rect.bottom + 4;
      if (y + cardHeight > window.innerHeight - 16) {
        y = Math.max(16, rect.top - cardHeight - 4);
      }
      setHoverCommit({ x, y, commit });
    }, 240);
  }, [clearHoverTimer]);

  const handleRowMouseLeave = useCallback(() => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverCommit(null);
    }, 180);
  }, [clearHoverTimer]);

  const handleHoverCardMouseEnter = useCallback(() => {
    clearHoverTimer();
  }, [clearHoverTimer]);

  const handleHoverCardMouseLeave = useCallback(() => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverCommit(null);
    }, 150);
  }, [clearHoverTimer]);

  useEffect(() => {
    return () => {
      clearHoverTimer();
    };
  }, [clearHoverTimer]);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Remote Web URL resolver (GitHub, GitLab, Gitee, Bitbucket, etc.)
  const getCommitWebUrl = useCallback(
    (hash: string): { url: string; platform: string } | null => {
      const rawUrl = branches?.remote_url;
      if (!rawUrl || !hash) return null;
      let url = rawUrl.trim();
      if (url.startsWith('git@')) {
        const match = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
        if (match) {
          url = `https://${match[1]}/${match[2]}`;
        }
      } else if (url.startsWith('http')) {
        url = url.replace(/\.git$/, '');
      } else {
        return null;
      }
      let platform = 'Git';
      if (url.includes('github.com')) platform = 'GitHub';
      else if (url.includes('gitlab.com') || url.includes('gitlab')) platform = 'GitLab';
      else if (url.includes('gitee.com')) platform = 'Gitee';
      else if (url.includes('bitbucket.org')) platform = 'Bitbucket';

      return {
        url: `${url}/commit/${hash}`,
        platform,
      };
    },
    [branches?.remote_url]
  );

  // Helper to extract or calculate commit statistics (files changed, additions, deletions)
  const getCommitStats = useCallback(
    (commit: GitCommitItem) => {
      if (commit.total_files != null && commit.total_files > 0) {
        return {
          files: commit.total_files,
          additions: commit.total_additions ?? 0,
          deletions: commit.total_deletions ?? 0,
        };
      }
      const files = commitFiles[commit.hash];
      if (files && files.length > 0) {
        return {
          files: files.length,
          additions: files.reduce((acc, f) => acc + f.additions, 0),
          deletions: files.reduce((acc, f) => acc + f.deletions, 0),
        };
      }
      return null;
    },
    [commitFiles]
  );

  // Context menu actions
  const handleOpenGitHub = (hash: string) => {
    const webInfo = getCommitWebUrl(hash);
    if (webInfo?.url) {
      window.open(webInfo.url, '_blank');
    }
  };

  const handleCreateBranchAt = async (commit: GitCommitItem) => {
    const name = window.prompt(t('git.promptBranchName'));
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'create_branch', target: commit.hash, name: name.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch ${name.trim()} created`);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to create branch');
    }
  };

  const handleCreateTagAt = async (commit: GitCommitItem) => {
    const name = window.prompt(t('git.promptTagName'));
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'create_tag', target: commit.hash, name: name.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Tag ${name.trim()} created`);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to create tag');
    }
  };

  const handleCherryPick = async (commit: GitCommitItem) => {
    if (!window.confirm(`Cherry pick ${commit.short_hash} "${commit.message}"?`)) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'cherry_pick', target: commit.hash, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Cherry-pick successful');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Cherry-pick failed');
    }
  };

  const handleRevert = async (commit: GitCommitItem) => {
    if (!window.confirm(`Revert commit ${commit.short_hash} "${commit.message}"?`)) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'revert', target: commit.hash, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Revert successful');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Revert failed');
    }
  };

  // Branch Context Menu State
  interface BranchContextMenuState {
    x: number;
    y: number;
    branch: string;
    isRemote: boolean;
  }
  const [branchContextMenu, setBranchContextMenu] = useState<BranchContextMenuState | null>(null);

  // Close branch context menu on outside click or Escape
  useEffect(() => {
    if (!branchContextMenu) return;
    const close = () => setBranchContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBranchContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [branchContextMenu]);

  const handleBranchContextMenu = (e: MouseEvent, branch: string, isRemote: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 320);
    setBranchContextMenu({ x, y, branch, isRemote });
  };

  const handleRenameBranch = async (branch: string) => {
    const newName = window.prompt(t('git.promptRenameBranch'), branch);
    if (!newName || !newName.trim() || newName.trim() === branch) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'rename_branch', target: branch, name: newName.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch renamed to ${newName.trim()}`);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to rename branch');
    }
  };

  const handleDeleteBranch = async (branch: string, isRemote: boolean) => {
    if (!isRemote && branch === currentBranch) {
      setError(t('git.cannotDeleteCurrent'));
      return;
    }
    const confirmPrompt = isRemote
      ? t('git.confirmDeleteRemoteBranch').replace('{b}', branch)
      : t('git.confirmDeleteBranch').replace('{b}', branch);
    if (!window.confirm(confirmPrompt)) return;
    setError(null);
    try {
      const action = isRemote ? 'delete_remote_branch' : 'delete_branch';
      const res = await gitAction({ action, target: branch, cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch ${branch} deleted`);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete branch');
    }
  };

  const handleMergeBranch = async (branch: string) => {
    if (!window.confirm(`Merge "${branch}" into "${currentBranch}"?`)) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'merge_branch', target: branch, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Merge successful');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Merge failed');
    }
  };

  const handlePushBranch = async (branch: string) => {
    setError(null);
    try {
      const res = await gitAction({ action: 'push_branch', target: branch, cwd: effectiveCwd });
      setSuccessMsg(res.message || `Pushed ${branch} to remote`);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Push failed');
    }
  };

  const handleCreateBranchFrom = async (branch: string) => {
    const name = window.prompt(t('git.promptBranchName'));
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'create_branch', target: branch, name: name.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch ${name.trim()} created from ${branch}`);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to create branch');
    }
  };

  // Commit and Stage state
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [actionLoadingPath, setActionLoadingPath] = useState<string | null>(null);

  // Load Git data. A newer request wins so a slow status fetch cannot
  // paint over a refresh that already saw `git add` / `git commit`.
  const loadSeqRef = useRef(0);
  const loadGitData = useCallback(async (isSilent = false) => {
    const seq = ++loadSeqRef.current;
    if (!isSilent) setLoading(true);
    setError(null);
    try {
      const [branchRes, graphRes, statusRes] = await Promise.all([
        fetchGitBranches(effectiveCwd),
        fetchGitGraph({ cwd: effectiveCwd, branch: filterBranch === 'all' ? undefined : filterBranch, limit: 80 }),
        fetchGitStatus(effectiveCwd),
      ]);
      if (seq !== loadSeqRef.current) return;
      setBranches(branchRes);
      setCommits(graphRes.commits);
      setGitStatus(statusRes);
      if (branchRes.current && !selectedBranch) {
        setSelectedBranch(branchRes.current);
      }
    } catch (err: any) {
      if (seq !== loadSeqRef.current) return;
      setError(err?.message || 'Failed to load Git status');
    } finally {
      if (seq === loadSeqRef.current && !isSilent) setLoading(false);
    }
  }, [effectiveCwd, filterBranch, selectedBranch]);

  // Initial load shows the spinner. Later bumps (a tool just finished) stay
  // silent so the file list updates in place instead of flashing.
  const seenRefreshRef = useRef<number | null>(null);
  useEffect(() => {
    const triggered = seenRefreshRef.current !== null && seenRefreshRef.current !== (refreshTrigger ?? 0);
    seenRefreshRef.current = refreshTrigger ?? 0;
    loadGitData(triggered);
  }, [loadGitData, refreshTrigger]);

  // Handle branch checkout
  const handleCheckout = async (branchName: string) => {
    if (branchName === branches?.current || switching) return;
    setSwitching(branchName);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await checkoutGitBranch(branchName, effectiveCwd);
      setSuccessMsg(`${t('git.switchSuccess')} ${res.branch}`);
      setSelectedBranch(res.branch);
      onBranchChanged?.(res.branch);
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || t('git.switchFailed'));
    } finally {
      setSwitching(null);
    }
  };

  // Stage file or all
  const handleStage = async (path?: string, all?: boolean) => {
    setActionLoadingPath(path || 'all');
    setError(null);
    try {
      await gitStage({ path, all, cwd: effectiveCwd });
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Stage failed');
    } finally {
      setActionLoadingPath(null);
    }
  };

  // Unstage file or all
  const handleUnstage = async (path?: string, all?: boolean) => {
    setActionLoadingPath(path || 'all');
    setError(null);
    try {
      await gitUnstage({ path, all, cwd: effectiveCwd });
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Unstage failed');
    } finally {
      setActionLoadingPath(null);
    }
  };

  // Discard changes
  const handleDiscard = async (file: GitStatusItem) => {
    if (!window.confirm(t('git.discardConfirm').replace('{path}', file.path))) return;
    setActionLoadingPath(file.path);
    setError(null);
    try {
      await gitDiscard({ path: file.path, isUntracked: file.status === '?', cwd: effectiveCwd });
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Discard failed');
    } finally {
      setActionLoadingPath(null);
    }
  };

  // Commit
  const handleCommit = async () => {
    const msg = commitMessage.trim();
    if (!msg) {
      setError(t('git.commitEmptyHint'));
      return;
    }

    const stagedCount = gitStatus?.staged.length ?? 0;
    const unstagedCount = (gitStatus?.unstaged.length ?? 0) + (gitStatus?.untracked.length ?? 0);

    if (stagedCount === 0) {
      if (unstagedCount === 0) {
        setError('No changes to commit');
        return;
      }
      if (!window.confirm(t('git.commitNoStagedPrompt'))) {
        return;
      }
      // Auto stage all
      await handleStage(undefined, true);
    }

    setIsCommitting(true);
    setError(null);
    try {
      const res = await gitCommit({ message: msg, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Commit successful');
      setCommitMessage('');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Commit failed');
    } finally {
      setIsCommitting(false);
    }
  };

  // Sync / Push / Pull
  const handleSync = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      if (!gitStatus?.tracking_branch) {
        // Publish branch
        const res = await gitPush({ setUpstream: true, cwd: effectiveCwd });
        setSuccessMsg(res.message || 'Published branch successfully');
      } else {
        // Pull then Push
        if (gitStatus.behind > 0) {
          await gitPull({ cwd: effectiveCwd });
        }
        if (gitStatus.ahead > 0 || gitStatus.behind === 0) {
          const res = await gitPush({ cwd: effectiveCwd });
          setSuccessMsg(res.message || 'Synced successfully');
        }
      }
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  };

  // Toggle commit expansion to load files changed
  const toggleCommitExpanded = async (commit: GitCommitItem) => {
    if (expandedCommitHash === commit.hash) {
      setExpandedCommitHash(null);
      return;
    }
    setExpandedCommitHash(commit.hash);
    if (!commitFiles[commit.hash]) {
      setLoadingCommitHash(commit.hash);
      try {
        const res = await fetchGitCommitDetail(commit.hash, effectiveCwd);
        setCommitFiles((prev) => ({ ...prev, [commit.hash]: res.files }));
      } catch (err: any) {
        setError(err?.message || 'Failed to load commit files');
      } finally {
        setLoadingCommitHash(null);
      }
    }
  };

  // Copy commit hash
  const handleCopyHash = (hash: string) => {
    navigator.clipboard?.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 1500);
  };

  // Build the graph layout
  const graphRows = useMemo(() => buildGitGraph(commits), [commits]);
  const maxLanes = graphRows.length > 0 ? graphRows[0]!.maxLanes : 1;
  const svgWidth = Math.max(16, LANE_OFFSET * 2 + Math.min(maxLanes, 5) * LANE_WIDTH);

  if (loading && !branches && !gitStatus) {
    return (
      <div class="git-panel-loading">
        <div class="git-spinner" />
        <span>{t('git.loading')}</span>
      </div>
    );
  }

  if (branches && !branches.is_repo) {
    return (
      <div class="git-panel-empty">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" class="git-empty-icon" aria-hidden="true">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
        </svg>
        <div class="git-empty-title">{t('git.notRepo')}</div>
      </div>
    );
  }

  const currentBranch = branches?.current || gitStatus?.current_branch || '';
  const stagedItems = gitStatus?.staged || [];
  const unstagedItems = [...(gitStatus?.unstaged || []), ...(gitStatus?.untracked || [])];
  const totalChangedCount = stagedItems.length + unstagedItems.length;

  return (
    <div class="git-panel-root">
      {/* Top Toolbar */}
      <div class="git-panel-toolbar">
        <div class="git-panel-subtabs">
          <button
            type="button"
            class={'git-subtab-btn' + (subView === 'changes' ? ' active' : '')}
            onClick={() => setSubView('changes')}
            title={t('git.changes')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M14.5 2h-13a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5zm-12 1h11v9h-11V3zm2 2h7v1h-7V5zm0 3h7v1h-7V8z" />
            </svg>
            <span>{t('git.changes')}</span>
            {totalChangedCount > 0 && (
              <span class="git-badge-counter badge-highlight">{totalChangedCount}</span>
            )}
          </button>
          <button
            type="button"
            class={'git-subtab-btn' + (subView === 'graph' ? ' active' : '')}
            onClick={() => setSubView('graph')}
            title={t('git.graph')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M10.5 8a2.5 2.5 0 0 1-5 0H1v-1h4.5a2.5 2.5 0 0 1 5 0H15v1h-4.5z" />
            </svg>
            <span>{t('git.graph')}</span>
          </button>
          <button
            type="button"
            class={'git-subtab-btn' + (subView === 'branches' ? ' active' : '')}
            onClick={() => setSubView('branches')}
            title={t('git.branches')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
            </svg>
            <span>{t('git.branches')}</span>
            <span class="git-badge-counter">{branches?.local.length ?? 0}</span>
          </button>
        </div>

        <button
          type="button"
          class={'git-refresh-btn' + (loading ? ' spinning' : '')}
          onClick={() => loadGitData(false)}
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V2l-2.35.35z" />
          </svg>
        </button>
      </div>

      {/* Multi-Repo Switcher Bar (VSCode style) */}
      {repos.length > 0 && (
        <div class="git-repo-bar">
          <span class="git-repo-label" title={t('git.switchRepo')}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M1.75 2.5h3.61a1.5 1.5 0 0 1 1.06.44l1.08 1.06h6.75A1.75 1.75 0 0 1 16 5.75v7.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V4.25C0 3.28.78 2.5 1.75 2.5z" />
            </svg>
          </span>
          <select
            class="git-repo-select"
            value={effectiveCwd}
            onChange={(e) => {
              const newRoot = (e.target as HTMLSelectElement).value;
              setActiveRepoRoot(newRoot);
              setSelectedBranch(null);
            }}
            title={effectiveCwd}
          >
            {repos.map((r) => (
              <option key={r.root} value={r.root}>
                {r.name} {r.current_branch ? `(${r.current_branch})` : ''} {r.is_root ? `· ${t('git.rootRepo')}` : `· ${r.relative_path}`}
              </option>
            ))}
          </select>
          {repos.length > 1 && (
            <span class="git-badge-counter">{t('git.repoCount', { count: repos.length })}</span>
          )}
        </div>
      )}

      {/* Alert / Notifications */}
      {error && (
        <div class="git-alert-banner git-alert-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {successMsg && (
        <div class="git-alert-banner git-alert-success" role="status">
          <span>{successMsg}</span>
          <button type="button" onClick={() => setSuccessMsg(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* VIEW: SOURCE CONTROL (CHANGES & COMMIT & SYNC) */}
      {subView === 'changes' && (
        <div class="git-source-control-container">
          {/* Branch & Sync Bar */}
          <div class="git-sync-bar">
            <div class="git-sync-branch-label" title={currentBranch}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
              </svg>
              <span>{currentBranch}</span>
            </div>

            <button
              type="button"
              class={'git-sync-action-btn' + (isSyncing ? ' syncing' : '')}
              onClick={handleSync}
              disabled={isSyncing}
              title={
                !gitStatus?.tracking_branch
                  ? t('git.publishBranch')
                  : `${t('git.sync')} (${gitStatus.ahead}↑ ${gitStatus.behind}↓)`
              }
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" class={isSyncing ? 'git-spin' : ''} aria-hidden="true">
                <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V2l-2.35.35z" />
              </svg>
              <span>
                {!gitStatus?.tracking_branch ? (
                  t('git.publishBranch')
                ) : (
                  <>
                    {t('git.sync')}
                    {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                      <span class="git-sync-counts">
                        {gitStatus.ahead > 0 && `${gitStatus.ahead}↑`}
                        {gitStatus.behind > 0 && ` ${gitStatus.behind}↓`}
                      </span>
                    )}
                  </>
                )}
              </span>
            </button>
          </div>

          {/* Commit Message Box */}
          <div class="git-commit-box">
            <textarea
              class="git-commit-textarea"
              placeholder={t('git.commitMsgPlaceholder')}
              value={commitMessage}
              rows={3}
              onInput={(e) => setCommitMessage((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleCommit();
                }
              }}
            />
            <button
              type="button"
              class="git-commit-submit-btn"
              onClick={handleCommit}
              disabled={isCommitting}
            >
              {isCommitting ? (
                <>
                  <span class="git-spinner-mini" />
                  <span>{t('git.commitBtn')}…</span>
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M3 8.5l3.5 3.5 6.5-7" />
                  </svg>
                  <span>{t('git.commitBtn')}</span>
                </>
              )}
            </button>
          </div>

          {/* Staged Changes Section */}
          {stagedItems.length > 0 && (
            <div class="git-changes-group">
              <div class="git-changes-header">
                <span class="git-changes-title">{t('git.stagedChanges')}</span>
                <span class="git-badge-counter">{stagedItems.length}</span>
                <div class="git-group-actions">
                  <button
                    type="button"
                    class="git-icon-action-btn"
                    onClick={() => handleUnstage(undefined, true)}
                    title={t('git.unstageAll')}
                  >
                    −
                  </button>
                </div>
              </div>
              <div class="git-file-list">
                {stagedItems.map((file) => {
                  const isLoading = actionLoadingPath === file.path;
                  return (
                    <div
                      key={file.path}
                      class="git-status-file-row"
                      onClick={() => onOpenWorkingDiff?.(file, true, effectiveCwd)}
                      title={`${file.path} (${t('git.stagedChanges')})`}
                    >
                      <span class={'git-file-status-tag status-' + file.status.toLowerCase()}>
                        {file.status}
                      </span>
                      <span class="git-file-name">{file.path}</span>
                      <div class="git-row-actions">
                        <button
                          type="button"
                          class="git-row-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUnstage(file.path);
                          }}
                          disabled={isLoading}
                          title={t('git.unstageFile')}
                        >
                          {isLoading ? <span class="git-spinner-mini" /> : '−'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Unstaged Changes Section */}
          <div class="git-changes-group">
            <div class="git-changes-header">
              <span class="git-changes-title">{t('git.changes')}</span>
              <span class="git-badge-counter">{unstagedItems.length}</span>
              {unstagedItems.length > 0 && (
                <div class="git-group-actions">
                  <button
                    type="button"
                    class="git-icon-action-btn"
                    onClick={() => handleStage(undefined, true)}
                    title={t('git.stageAll')}
                  >
                    +
                  </button>
                </div>
              )}
            </div>
            {unstagedItems.length === 0 && stagedItems.length === 0 ? (
              <div class="git-files-clean-hint">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path d="M3 8.5l3.5 3.5 6.5-7" />
                </svg>
                <span>Working tree clean</span>
              </div>
            ) : (
              <div class="git-file-list">
                {unstagedItems.map((file) => {
                  const isLoading = actionLoadingPath === file.path;
                  const isUntracked = file.status === '?';
                  return (
                    <div
                      key={file.path}
                      class="git-status-file-row"
                      onClick={() => onOpenWorkingDiff?.(file, false, effectiveCwd)}
                      title={`${file.path} (${t('git.changes')})`}
                    >
                      <span class={'git-file-status-tag status-' + file.status.toLowerCase()}>
                        {isUntracked ? 'U' : file.status}
                      </span>
                      <span class="git-file-name">{file.path}</span>
                      <div class="git-row-actions">
                        <button
                          type="button"
                          class="git-row-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDiscard(file);
                          }}
                          disabled={isLoading}
                          title={t('git.discardFile')}
                        >
                          ↺
                        </button>
                        <button
                          type="button"
                          class="git-row-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStage(file.path);
                          }}
                          disabled={isLoading}
                          title={t('git.stageFile')}
                        >
                          {isLoading ? <span class="git-spinner-mini" /> : '+'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW: BRANCHES TREE */}
      {subView === 'branches' && (
        <div class="git-branches-container">
          {/* Local Branches Section */}
          <div class="git-section-header">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
            <span class="git-section-title">{t('git.local')}</span>
            <span class="git-badge-counter">{branches?.local.length ?? 0}</span>
          </div>
          <div class="git-branch-list">
            {branches?.local.map((b) => {
              const isCurrent = b === currentBranch;
              const isSelected = b === selectedBranch;
              const isPending = switching === b;
              return (
                <div
                  key={b}
                  class={
                    'git-branch-item' +
                    (isCurrent ? ' current' : '') +
                    (isSelected ? ' selected' : '')
                  }
                  onClick={() => setSelectedBranch(b)}
                  onDblClick={() => !isCurrent && handleCheckout(b)}
                  onContextMenu={(e) => handleBranchContextMenu(e, b, false)}
                  title={isCurrent ? `${b} (${t('git.currentBranch')})` : b}
                >
                  <span class="git-branch-status-icon">
                    {isCurrent ? (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M3 8.5l3.5 3.5 6.5-7" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" opacity="0.6" aria-hidden="true">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
                      </svg>
                    )}
                  </span>
                  <span class="git-branch-name">{b}</span>
                  {isCurrent && <span class="git-head-pill">HEAD</span>}
                  
                  {/* Explicit Checkout Action Button */}
                  {!isCurrent && (
                    <div class="git-branch-actions">
                      <button
                        type="button"
                        class="git-checkout-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCheckout(b);
                        }}
                        title={`${t('git.checkoutConfirm')} ${b}`}
                      >
                        {isPending ? <span class="git-spinner-mini" /> : t('git.checkout')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Remote Branches Section */}
          {branches && branches.remote.length > 0 && (
            <>
              <div class="git-section-header" style={{ marginTop: '16px' }}>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
                <span class="git-section-title">{t('git.remote')}</span>
                <span class="git-badge-counter">{branches.remote.length}</span>
              </div>
              <div class="git-branch-list">
                {branches.remote.map((rb) => {
                  const isPending = switching === rb;
                  const isSelected = rb === selectedBranch;
                  return (
                    <div
                      key={rb}
                      class={'git-branch-item remote' + (isSelected ? ' selected' : '')}
                      onClick={() => setSelectedBranch(rb)}
                      onDblClick={() => handleCheckout(rb)}
                      onContextMenu={(e) => handleBranchContextMenu(e, rb, true)}
                      title={rb}
                    >
                      <span class="git-branch-status-icon">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" opacity="0.5" aria-hidden="true">
                          <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
                        </svg>
                      </span>
                      <span class="git-branch-name">{rb}</span>
                      <div class="git-branch-actions">
                        <button
                          type="button"
                          class="git-checkout-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCheckout(rb);
                          }}
                          title={`${t('git.checkoutConfirm')} ${rb}`}
                        >
                          {isPending ? <span class="git-spinner-mini" /> : t('git.checkout')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* VIEW: GRAPH (走线图谱) */}
      {subView === 'graph' && (
        <div class="git-graph-container">
          {/* Branch filter picker */}
          <div class="git-graph-filter-row">
            <span class="git-filter-label">{t('git.branches')}:</span>
            <select
              class="git-filter-select"
              value={filterBranch}
              onChange={(e) => setFilterBranch((e.target as HTMLSelectElement).value)}
            >
              <option value="all">{t('git.allBranches')}</option>
              {branches?.local.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          {/* Commits & Swimlanes table */}
          {graphRows.length === 0 ? (
            <div class="git-no-commits">{t('git.noCommits')}</div>
          ) : (
            <div
              class="git-graph-rows-wrap"
              onScroll={() => {
                clearHoverTimer();
                setHoverCommit(null);
              }}
            >
              {graphRows.map((row) => {
                const c = row.commit;
                const isHead = c.refs.some((r) => r.includes('HEAD'));
                const hasPill = c.refs.length > 0;
                const isExpanded = expandedCommitHash === c.hash;
                const files = commitFiles[c.hash] || [];
                const isLoadingFiles = loadingCommitHash === c.hash;

                return (
                  <div
                    key={c.hash}
                    class={'git-graph-item-block' + (isExpanded ? ' expanded' : '')}
                  >
                    <div
                      class={
                        'git-graph-row' +
                        (isHead ? ' head-row' : '') +
                        (isExpanded ? ' selected' : '')
                      }
                      onClick={() => {
                        clearHoverTimer();
                        setHoverCommit(null);
                        toggleCommitExpanded(c);
                      }}
                      onMouseEnter={(e) => handleRowMouseEnter(e, c)}
                      onMouseLeave={handleRowMouseLeave}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        clearHoverTimer();
                        setHoverCommit(null);
                        const x = Math.min(e.clientX, window.innerWidth - 220);
                        const y = Math.min(e.clientY, window.innerHeight - 320);
                        setContextMenu({ x, y, commit: c });
                      }}
                    >
                      {/* SVG Swimlane column */}
                      <div class="git-graph-svg-col" style={{ width: `${svgWidth}px` }}>
                        <svg
                          width={svgWidth}
                          height={ROW_HEIGHT}
                          viewBox={`0 0 ${svgWidth} ${ROW_HEIGHT}`}
                          class="git-swimlane-svg"
                        >
                          {/* Connecting Paths */}
                          {row.paths.map((p, idx) => (
                            <path
                              key={idx}
                              d={p.d}
                              stroke={p.color}
                              stroke-width={p.isMerge ? 1.4 : 1.6}
                              fill="none"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              opacity={p.isMerge ? 0.85 : 1}
                            />
                          ))}
                          {/* Commit Node Circle */}
                          <circle
                            cx={row.cx}
                            cy={row.cy}
                            r={isHead ? 4 : 3}
                            fill={isHead ? 'var(--app-background, #1e1e1e)' : row.color}
                            stroke={row.color}
                            stroke-width={isHead ? 2 : 1.2}
                          />
                        </svg>
                      </div>

                      {/* Commit Info Details */}
                      <div class="git-commit-info">
                        <div class="git-commit-line1">
                          {/* Ref Pills (HEAD, branch, tags) */}
                          {hasPill && (
                            <div class="git-refs-group">
                              {c.refs.map((r, rIdx) => {
                                const isCur = r.includes('HEAD') || r === currentBranch;
                                const isRemote = r.startsWith('origin/');
                                const isTag = r.startsWith('tag:');
                                const label = r.replace(/^HEAD\s*->\s*/, '').replace(/^tag:\s*/, '');

                                let pillClass = 'git-ref-pill';
                                if (isCur) pillClass += ' pill-head';
                                else if (isTag) pillClass += ' pill-tag';
                                else if (isRemote) pillClass += ' pill-remote';
                                else pillClass += ' pill-local';

                                return (
                                  <span key={rIdx} class={pillClass}>
                                    {label}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          <span class="git-commit-msg">
                            {c.message.split('\n')[0]}
                          </span>
                        </div>

                        <div class="git-commit-line2">
                          <span
                            class="git-commit-hash"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyHash(c.hash);
                            }}
                          >
                            {copiedHash === c.hash ? 'copied!' : c.short_hash}
                          </span>
                          <span class="git-commit-author">
                            {c.author_name}
                          </span>
                          <span class="git-commit-time">
                            {formatRelativeTime(c.timestamp)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Expanded Files Panel */}
                    {isExpanded && (
                      <div
                        class="git-commit-files-panel"
                        style={{ marginLeft: `${Math.min(svgWidth + 4, 32)}px` }}
                      >
                        {/* Expanded Commit Details (VSCode Style) */}
                        <div class="git-expanded-details-card">
                          <div class="git-expanded-meta-row">
                            <span class="git-hover-user-icon">👤</span>
                            <span class="git-expanded-author">{c.author_name}</span>
                            {c.author_email && (
                              <span class="git-hover-email">&lt;{c.author_email}&gt;</span>
                            )}
                            <span class="git-hover-meta-comma">,</span>
                            <span class="git-hover-clock-icon">🕒</span>
                            <span class="git-expanded-time">
                              {formatRelativeTimeI18n(c.timestamp, isZh)} ({formatCommitDateTime(c.timestamp, isZh)})
                            </span>
                          </div>

                          <div class="git-expanded-subject">{c.message.split('\n')[0]}</div>

                          {c.message.includes('\n') && (
                            <div class="git-expanded-body">
                              {c.message.split('\n').slice(1).join('\n').trim()}
                            </div>
                          )}

                          {(() => {
                            const stats = getCommitStats(c);
                            if (!stats) return null;
                            return (
                              <div class="git-hover-stats-row">
                                <span class="git-hover-stats-files">
                                  {t('git.statFilesChanged', { files: stats.files })},
                                </span>
                                <span class="git-hover-stats-add stat-add">
                                  {t('git.statInsertions', { count: stats.additions })},
                                </span>
                                <span class="git-hover-stats-del stat-del">
                                  {t('git.statDeletions', { count: stats.deletions })}
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                        {isLoadingFiles ? (
                          <div class="git-files-loading">
                            <span class="git-spinner-mini" />
                            <span>{t('git.loading')}</span>
                          </div>
                        ) : files.length === 0 ? (
                          <div class="git-files-empty">{t('git.noFiles')}</div>
                        ) : (
                          <div class="git-files-list">
                            <div class="git-files-count-badge">
                              {t('git.filesChanged', { count: files.length })}:
                            </div>
                            {files.map((file) => (
                              <div
                                key={file.path}
                                class="git-file-row"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenFileDiff?.(c, file, effectiveCwd);
                                }}
                                title={`${t('git.viewDiff')}: ${file.path}`}
                              >
                                <span class={'git-file-status-tag status-' + file.status.toLowerCase()}>
                                  {file.status}
                                </span>
                                <span class="git-file-name" title={file.path}>
                                  {file.path}
                                </span>
                                {(file.additions > 0 || file.deletions > 0) && (
                                  <span class="git-file-stats">
                                    {file.additions > 0 && <span class="stat-add">+{file.additions}</span>}
                                    {file.deletions > 0 && <span class="stat-del">-{file.deletions}</span>}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* VSCode Context Menu */}
      {contextMenu && (
        <div
          class="git-context-menu"
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              toggleCommitExpanded(contextMenu.commit);
              setContextMenu(null);
            }}
          >
            <span>{t('git.ctxOpenChanges')}</span>
          </button>
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              handleCopyHash(contextMenu.commit.hash);
              setContextMenu(null);
            }}
          >
            <span>{t('git.ctxCopyHash')}</span>
          </button>
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(contextMenu.commit.message);
              setContextMenu(null);
            }}
          >
            <span>{t('git.ctxCopyMsg')}</span>
          </button>
          {branches?.remote_url && branches.remote_url.includes('github') && (
            <button
              type="button"
              class="git-context-menu-item"
              onClick={() => {
                handleOpenGitHub(contextMenu.commit.hash);
                setContextMenu(null);
              }}
            >
              <span>{t('git.ctxOpenGitHub')}</span>
            </button>
          )}

          <div class="git-context-menu-divider" />

          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              handleCheckout(contextMenu.commit.hash);
              setContextMenu(null);
            }}
          >
            <span>{t('git.ctxCheckout')}</span>
          </button>
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              const c = contextMenu.commit;
              setContextMenu(null);
              handleCreateBranchAt(c);
            }}
          >
            <span>{t('git.ctxCreateBranch')}</span>
          </button>
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              const c = contextMenu.commit;
              setContextMenu(null);
              handleCreateTagAt(c);
            }}
          >
            <span>{t('git.ctxCreateTag')}</span>
          </button>

          <div class="git-context-menu-divider" />

          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              const c = contextMenu.commit;
              setContextMenu(null);
              handleCherryPick(c);
            }}
          >
            <span>{t('git.ctxCherryPick')}</span>
          </button>
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              const c = contextMenu.commit;
              setContextMenu(null);
              handleRevert(c);
            }}
          >
            <span>{t('git.ctxRevert')}</span>
          </button>
        </div>
      )}

      {/* VSCode Branch Context Menu */}
      {branchContextMenu && (
        <div
          class="git-context-menu"
          style={{ top: `${branchContextMenu.y}px`, left: `${branchContextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Checkout */}
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              const b = branchContextMenu.branch;
              setBranchContextMenu(null);
              handleCheckout(b);
            }}
          >
            <span>{t('git.ctxCheckoutBranch')}</span>
          </button>

          {/* Copy Branch Name */}
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(branchContextMenu.branch);
              setBranchContextMenu(null);
            }}
          >
            <span>{t('git.ctxCopyBranchName')}</span>
          </button>

          <div class="git-context-menu-divider" />

          {/* Local-only branch options */}
          {!branchContextMenu.isRemote && (
            <>
              <button
                type="button"
                class="git-context-menu-item"
                onClick={() => {
                  const b = branchContextMenu.branch;
                  setBranchContextMenu(null);
                  handleRenameBranch(b);
                }}
              >
                <span>{t('git.ctxRenameBranch')}</span>
              </button>
              <button
                type="button"
                class="git-context-menu-item"
                onClick={() => {
                  const b = branchContextMenu.branch;
                  setBranchContextMenu(null);
                  handlePushBranch(b);
                }}
              >
                <span>{t('git.ctxPushBranch')}</span>
              </button>
              {branchContextMenu.branch !== currentBranch && (
                <button
                  type="button"
                  class="git-context-menu-item"
                  onClick={() => {
                    const b = branchContextMenu.branch;
                    setBranchContextMenu(null);
                    handleMergeBranch(b);
                  }}
                >
                  <span>{t('git.ctxMergeBranch').replace('{b}', currentBranch)}</span>
                </button>
              )}
            </>
          )}

          {/* Create Branch From Here */}
          <button
            type="button"
            class="git-context-menu-item"
            onClick={() => {
              const b = branchContextMenu.branch;
              setBranchContextMenu(null);
              handleCreateBranchFrom(b);
            }}
          >
            <span>{t('git.ctxCreateBranchFrom').replace('{b}', branchContextMenu.branch)}</span>
          </button>

          <div class="git-context-menu-divider" />

          {/* Delete Branch */}
          <button
            type="button"
            class="git-context-menu-item danger"
            onClick={() => {
              const b = branchContextMenu.branch;
              const isRem = branchContextMenu.isRemote;
              setBranchContextMenu(null);
              handleDeleteBranch(b, isRem);
            }}
          >
            <span>
              {branchContextMenu.isRemote
                ? t('git.ctxDeleteRemoteBranch')
                : t('git.ctxDeleteBranch')}
            </span>
          </button>
        </div>
      )}

      {/* VSCode-style Commit Hover Details Card */}
      {hoverCommit && !contextMenu && (
        <div
          class="git-commit-hover-card"
          style={{ top: `${hoverCommit.y}px`, left: `${hoverCommit.x}px` }}
          onMouseEnter={handleHoverCardMouseEnter}
          onMouseLeave={handleHoverCardMouseLeave}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Top Meta Row: 👤 Author, 🕒 Relative time (Full date) */}
          <div class="git-hover-author-row">
            <span class="git-hover-user-icon">👤</span>
            <span class="git-hover-author-name">{hoverCommit.commit.author_name}</span>
            {hoverCommit.commit.author_email && (
              <span class="git-hover-email">&lt;{hoverCommit.commit.author_email}&gt;</span>
            )}
            <span class="git-hover-meta-comma">,</span>
            <span class="git-hover-clock-icon">🕒</span>
            <span class="git-hover-time-text">
              {formatRelativeTimeI18n(hoverCommit.commit.timestamp, isZh)}
              <span class="git-hover-time-full">
                {' '}({formatCommitDateTime(hoverCommit.commit.timestamp, isZh)})
              </span>
            </span>
          </div>

          {/* Commit Subject (Bold / Prominent) */}
          <div class="git-hover-subject">
            {hoverCommit.commit.message.split('\n')[0]}
          </div>

          {/* Commit Body (Multi-line paragraphs, Co-Authored-By, etc.) */}
          {hoverCommit.commit.message.includes('\n') && (
            <div class="git-hover-body">
              {hoverCommit.commit.message.split('\n').slice(1).join('\n').trim()}
            </div>
          )}

          {/* Stats Row: 已更改 X 个文件，Y 行插入(+), Z 行删除(-) */}
          {(() => {
            const stats = getCommitStats(hoverCommit.commit);
            if (!stats) return null;
            return (
              <div class="git-hover-stats-row">
                <span class="git-hover-stats-files">
                  {t('git.statFilesChanged', { files: stats.files })},
                </span>
                <span class="git-hover-stats-add stat-add">
                  {t('git.statInsertions', { count: stats.additions })},
                </span>
                <span class="git-hover-stats-del stat-del">
                  {t('git.statDeletions', { count: stats.deletions })}
                </span>
              </div>
            );
          })()}

          {/* Ref Badges (Branches & Tags) */}
          {hoverCommit.commit.refs.length > 0 && (
            <div class="git-hover-refs-wrap">
              {hoverCommit.commit.refs.map((r, idx) => {
                const isCur = r.includes('HEAD') || r === currentBranch;
                const isRemote = r.startsWith('origin/');
                const isTag = r.startsWith('tag:');
                const label = r.replace(/^HEAD\s*->\s*/, '').replace(/^tag:\s*/, '');

                let pillClass = 'git-ref-pill';
                if (isCur) pillClass += ' pill-head';
                else if (isTag) pillClass += ' pill-tag';
                else if (isRemote) pillClass += ' pill-remote';
                else pillClass += ' pill-local';

                return (
                  <span key={idx} class={pillClass}>
                    {label}
                  </span>
                );
              })}
            </div>
          )}

          {/* Bottom Bar: ⎇ short_hash [copy] | 🌐 在 GitHub 上打开 */}
          <div class="git-hover-bottom-bar">
            <div class="git-hover-bottom-left">
              <span class="git-hover-branch-icon">⎇</span>
              <span
                class="git-hover-hash"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyHash(hoverCommit.commit.hash);
                }}
                title={t('git.hoverCopyHash')}
              >
                {hoverCommit.commit.short_hash}
              </span>
              <button
                type="button"
                class="git-hover-copy-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyHash(hoverCommit.commit.hash);
                }}
                title={copiedHash === hoverCommit.commit.hash ? t('git.hoverCopied') : t('git.hoverCopyHash')}
              >
                {copiedHash === hoverCommit.commit.hash ? (
                  <span class="git-hover-copied-badge">✓ {t('git.hoverCopied')}</span>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
              {(() => {
                const webLink = getCommitWebUrl(hoverCommit.commit.hash);
                if (!webLink) return null;
                return (
                  <>
                    <span class="git-hover-bar-sep">|</span>
                    <a
                      href={webLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="git-hover-remote-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                      <span>{t('git.openOnRemote', { platform: webLink.platform })}</span>
                    </a>
                  </>
                );
              })()}
            </div>
            <div class="git-hover-bottom-right">
              <span class="git-hover-tip-hint">{t('git.hoverTips')}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
