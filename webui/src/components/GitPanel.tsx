import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useSettings } from '../settings';
import { modalConfirm, modalPrompt } from './ConfirmDialog';
import { showToast } from './Toast';
import { getPageZoom } from '../lib/pageZoom';
import { formatGitCommitBanner } from '../lib/gitCommitBanner';
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
import { copyTextToClipboard } from '../lib/clipboard';
import { gitPanelFingerprint } from '../lib/gitRefresh';
import { gitStore, getSessionActiveRepo, type GitProjectState } from '../lib/gitStore';

interface ParsedCommitMessage {
  subject: string;
  body: string;
  trailers: string[];
}

function parseCommitMessage(rawMessage: string): ParsedCommitMessage {
  if (!rawMessage) return { subject: '', body: '', trailers: [] };
  const lines = rawMessage.split('\n');
  const subject = (lines[0] || '').trim();
  const remaining = lines.slice(1).join('\n').trim();
  if (!remaining) {
    return { subject, body: '', trailers: [] };
  }

  const bodyLines: string[] = [];
  const trailers: string[] = [];

  for (const line of remaining.split('\n')) {
    const trimmed = line.trim();
    if (/^(Co-Authored-By|Signed-off-by|Reviewed-by):\s+/i.test(trimmed)) {
      trailers.push(trimmed);
    } else {
      bodyLines.push(line);
    }
  }

  return {
    subject,
    body: bodyLines.join('\n').trim(),
    trailers,
  };
}

interface GitPanelProps {
  cwd?: string;
  sessionId?: string | null;
  refreshTrigger?: number;
  onBranchChanged?: (newBranch: string) => void;
  onOpenFileDiff?: (commit: GitCommitItem, file: GitCommitFile, repoRoot?: string) => void;
  onOpenWorkingDiff?: (file: GitStatusItem, staged: boolean, repoRoot?: string) => void;
}

export function GitPanel({
  cwd,
  sessionId,
  refreshTrigger,
  onBranchChanged,
  onOpenFileDiff,
  onOpenWorkingDiff,
}: GitPanelProps) {
  const { t, lang } = useSettings();
  const isZh = lang === 'zh';

  // ── 项目级全局 Git 状态 Store 订阅 (0ms 瞬间恢复首屏，跨会话共享，彻底杜绝白屏蹦图) ──
  const [storeState, setStoreState] = useState<GitProjectState>(() => gitStore.getState(cwd));
  useEffect(() => {
    setStoreState(gitStore.getState(cwd));
    return gitStore.subscribe(cwd, (next) => setStoreState(next));
  }, [cwd]);

  const branches = storeState.branches;
  const commits = storeState.commits;
  const gitStatus = storeState.gitStatus;
  const loading = storeState.loading;
  const repos = storeState.repos;
  const activeRepoRoot = storeState.activeRepoRoot;
  const effectiveCwd = activeRepoRoot || cwd;

  const [switching, setSwitching] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(() => storeState.branches?.current ?? null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const error = panelError || storeState.error;
  const setError = setPanelError;
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [filterBranch, setFilterBranch] = useState<'all' | string>('all');
  const [subView, setSubView] = useState<'changes' | 'graph' | 'branches'>('changes');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [actionDropdownHash, setActionDropdownHash] = useState<string | null>(null);

  // 移动端/桌面端视口感知：手机版依旧保持 commits 在顶层独立标签，桌面端双容器联动
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // 桌面端 VSCode 风格上下双容器（Changes + Commits）高度分割比例与折叠状态持久化
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:git_panel_split_ratio');
      if (saved) {
        const val = parseFloat(saved);
        if (val >= 0.15 && val <= 0.85) return val;
      }
    } catch {}
    return 0.5;
  });

  const [commitsCollapsed, setCommitsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('jeikcode:git_panel_commits_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleCommitsCollapse = () => {
    setCommitsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('jeikcode:git_panel_commits_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  const isResizingRef = useRef(false);
  const combinedViewRef = useRef<HTMLDivElement>(null);

  const handleResizerMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current || !combinedViewRef.current) return;
      const rect = combinedViewRef.current.getBoundingClientRect();
      const offsetY = moveEvent.clientY - rect.top;
      const newRatio = Math.max(0.15, Math.min(0.85, offsetY / rect.height));
      setSplitRatio(newRatio);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      try {
        localStorage.setItem('jeikcode:git_panel_split_ratio', String(splitRatio));
      } catch {}
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Expanded commit state for modified files
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Record<string, GitCommitFile[]>>({});
  const [loadingCommitHash, setLoadingCommitHash] = useState<string | null>(null);

  // 异步探测子仓库列表（并在传入 sessionId 时优先对齐当前会话绑定的子仓）
  useEffect(() => {
    void gitStore.refreshRepos(cwd, sessionId);
  }, [cwd, sessionId]);

  // 跨会话切换时，若当前会话绑定了特定子仓，静默对齐当前激活子仓
  useEffect(() => {
    if (!sessionId || repos.length === 0) return;
    const target = getSessionActiveRepo(sessionId, repos);
    if (target && target !== storeState.activeRepoRoot) {
      gitStore.setActiveRepoRoot(cwd, target, sessionId);
      setSelectedBranch(null);
    }
  }, [sessionId, repos]);

  // VSCode Context Menu State
  interface ContextMenuState {
    x: number;
    y: number;
    commit: GitCommitItem;
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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

  // Close commit action dropdown on outside click or Escape
  useEffect(() => {
    if (!actionDropdownHash) return;
    const close = () => setActionDropdownHash(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActionDropdownHash(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [actionDropdownHash]);

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
    const name = await modalPrompt({
      title: t('git.ctxCreateBranch'),
      body: t('git.promptBranchName'),
      placeholder: 'feature/xxx',
      confirmLabel: t('common.create') || '创建',
      cancelLabel: t('common.cancel') || '取消',
    });
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'create_branch', target: commit.hash, name: name.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch ${name.trim()} created`);
      showToast(res.message || `Branch ${name.trim()} created`, 'success');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to create branch');
    }
  };

  const handleCreateTagAt = async (commit: GitCommitItem) => {
    const name = await modalPrompt({
      title: t('git.ctxCreateTag'),
      body: t('git.promptTagName'),
      placeholder: 'v1.0.0',
      confirmLabel: t('common.create') || '创建',
      cancelLabel: t('common.cancel') || '取消',
    });
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'create_tag', target: commit.hash, name: name.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Tag ${name.trim()} created`);
      showToast(res.message || `Tag ${name.trim()} created`, 'success');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to create tag');
    }
  };

  const handleCherryPick = async (commit: GitCommitItem) => {
    const ok = await modalConfirm({
      title: t('git.ctxCherryPick'),
      body: `Cherry pick ${commit.short_hash} "${commit.message}"?`,
      danger: false,
      confirmLabel: t('git.ctxCherryPick'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'cherry_pick', target: commit.hash, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Cherry-pick successful');
      showToast(res.message || 'Cherry-pick successful', 'success');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Cherry-pick failed');
    }
  };

  const handleRevert = async (commit: GitCommitItem) => {
    const ok = await modalConfirm({
      title: t('git.ctxRevert'),
      body: `Revert commit ${commit.short_hash} "${commit.message}"?`,
      icon: '↺',
      danger: true,
      confirmLabel: t('git.ctxRevert'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'revert', target: commit.hash, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Revert successful');
      showToast(res.message || 'Revert successful', 'success');
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

  const calcGitContextMenuPos = (e: MouseEvent, menuWidth = 200, menuHeight = 280) => {
    const zoom = getPageZoom() || 1.0;
    const rawX = Math.round(e.clientX / zoom);
    const rawY = Math.round(e.clientY / zoom);
    const viewportWidth = window.innerWidth / zoom;
    const viewportHeight = window.innerHeight / zoom;
    const x = rawX + menuWidth > viewportWidth ? Math.max(10, rawX - menuWidth) : rawX;
    const y = rawY + menuHeight > viewportHeight ? Math.max(10, rawY - menuHeight) : rawY;
    return { x, y };
  };

  const handleBranchContextMenu = (e: MouseEvent, branch: string, isRemote: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = calcGitContextMenuPos(e, 200, 320);
    setBranchContextMenu({ x, y, branch, isRemote });
  };

  const handleRenameBranch = async (branch: string) => {
    const newName = await modalPrompt({
      title: t('git.ctxRenameBranch'),
      body: t('git.promptRenameBranch'),
      defaultValue: branch,
      icon: '✏️',
      confirmLabel: t('common.confirm') || '确定',
      cancelLabel: t('common.cancel') || '取消',
    });
    if (!newName || !newName.trim() || newName.trim() === branch) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'rename_branch', target: branch, name: newName.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch renamed to ${newName.trim()}`);
      showToast(res.message || `Branch renamed to ${newName.trim()}`, 'success');
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
    const ok = await modalConfirm({
      title: isRemote ? t('git.ctxDeleteRemoteBranch') : t('git.ctxDeleteBranch'),
      body: confirmPrompt,
      danger: true,
      confirmLabel: t('common.delete') || '删除',
      cancelLabel: t('common.cancel') || '取消',
    });
    if (!ok) return;
    setError(null);
    try {
      const action = isRemote ? 'delete_remote_branch' : 'delete_branch';
      const res = await gitAction({ action, target: branch, cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch ${branch} deleted`);
      showToast(res.message || `Branch ${branch} deleted`, 'success');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete branch');
    }
  };

  const handleMergeBranch = async (branch: string) => {
    const ok = await modalConfirm({
      title: t('git.ctxMergeBranch').replace('{b}', currentBranch),
      body: `Merge "${branch}" into "${currentBranch}"?`,
      danger: false,
      confirmLabel: t('common.confirm') || '合并',
      cancelLabel: t('common.cancel') || '取消',
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'merge_branch', target: branch, cwd: effectiveCwd });
      setSuccessMsg(res.message || 'Merge successful');
      showToast(res.message || 'Merge successful', 'success');
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
      showToast(res.message || `Pushed ${branch} to remote`, 'success');
      gitStore.setOptimisticState(cwd, (prev) => {
        if (!prev || !prev.gitStatus) return prev;
        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            ahead: 0,
          },
        };
      });
      void handleFullRefresh();
    } catch (err: any) {
      setError(err?.message || 'Push failed');
    }
  };

  const handleCreateBranchFrom = async (branch: string) => {
    const name = await modalPrompt({
      title: t('git.ctxCreateBranchFrom').replace('{b}', branch),
      body: t('git.promptBranchName'),
      placeholder: 'feature/xxx',
      confirmLabel: t('common.create') || '创建',
      cancelLabel: t('common.cancel') || '取消',
    });
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const res = await gitAction({ action: 'create_branch', target: branch, name: name.trim(), cwd: effectiveCwd });
      setSuccessMsg(res.message || `Branch ${name.trim()} created from ${branch}`);
      showToast(res.message || `Branch ${name.trim()} created from ${branch}`, 'success');
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to create branch');
    }
  };

  // Commit and Stage state
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [actionLoadingPath, setActionLoadingPath] = useState<string | null>(null);

  // 统一调度 Git 状态刷新（经由单例 gitStore 的 Single-flight 原子锁与防抖控制）
  const refresh = useCallback((immediate = false, forceAll = false) => {
    setPanelError(null);
    gitStore.scheduleRefresh(cwd, { immediate, forceAll, filterBranch });
  }, [cwd, filterBranch]);

  // 兼容别名
  const loadGitData = useCallback(async (isSilent = false) => {
    refresh(!isSilent, !isSilent);
  }, [refresh]);

  // 手动获取全部远程分支与代码 (Fetch All)
  const handleFetch = useCallback(async (silent = false) => {
    if (isFetching) return;
    setIsFetching(true);
    if (!silent) setPanelError(null);
    try {
      const fetchTarget = effectiveCwd || cwd;
      const ok = await gitStore.triggerAutoFetch(fetchTarget, { force: !silent });
      if (!silent) {
        if (ok) {
          showToast(t('git.fetchSuccess'), 'success');
        } else {
          showToast(t('git.fetchFailed'), 'error');
        }
      }
    } catch (err: any) {
      if (!silent) {
        const msg = err?.message || t('git.fetchFailed');
        setError(msg);
        showToast(msg, 'error');
      }
    } finally {
      setIsFetching(false);
    }
  }, [cwd, effectiveCwd, isFetching, t]);

  // 综合刷新（阶段一：本地状态毫秒级先到先更；阶段二：网络Fetch异步非阻塞，远端新引用到货后级联重绘图谱并重新落缓存）
  const handleFullRefresh = useCallback(async () => {
    // 阶段 1：本地即时快速刷新（<15ms 本地更改列表、当前分支、ahead/behind 即刻上屏）
    gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: false, filterBranch });
    // 阶段 2：异步并发拉取远程最新代码（按钮优雅旋转，完全非阻塞，连击自动单飞复用）
    void (async () => {
      await handleFetch(false);
      // 阶段 3：远程到货后，无条件以 forceAll 刷新图谱，后端校验双指纹变动并重新落缓存
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true, filterBranch });
    })();
  }, [cwd, filterBranch, handleFetch]);

  // Initial load 与外部 refreshTrigger 联动
  const seenRefreshRef = useRef<number | null>(null);
  useEffect(() => {
    const triggered = seenRefreshRef.current !== null && seenRefreshRef.current !== (refreshTrigger ?? 0);
    seenRefreshRef.current = refreshTrigger ?? 0;
    const hasData = Boolean(storeState.branches || storeState.gitStatus);
    gitStore.scheduleRefresh(cwd, {
      immediate: triggered || !hasData,
      forceAll: triggered,
      filterBranch,
    });
  }, [cwd, refreshTrigger, filterBranch]);

  // 彻底移除盲目轮询，仅在窗口由后台切回 (focus) 或恢复可见 (visibilitychange) 时触发单次静默刷新
  useEffect(() => {
    const refreshIfIdle = () => {
      if (document.visibilityState !== 'visible') return;
      // 1. 本地快速瞬时刷新
      gitStore.scheduleRefresh(cwd, { immediate: false, filterBranch });
      // 2. 聚焦补偿 (Focus Catch-up)：后台静默发起节流 Fetch (60s 防抖)
      void gitStore.triggerAutoFetch(cwd);
    };
    document.addEventListener('visibilitychange', refreshIfIdle);
    window.addEventListener('focus', refreshIfIdle);

    // 3. 前台激活时，每 180s 周期性执行静默 Fetch（对齐 VS Code 黄金周期）
    const intervalTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void gitStore.triggerAutoFetch(cwd);
      }
    }, 180_000);

    return () => {
      document.removeEventListener('visibilitychange', refreshIfIdle);
      window.removeEventListener('focus', refreshIfIdle);
      window.clearInterval(intervalTimer);
    };
  }, [cwd, filterBranch]);

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
      refresh(true, true);
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

    // 0ms 瞬间乐观更新：立即从未暂存移至暂存区，体验对齐 VS Code
    gitStore.setOptimisticState(cwd, (prev) => {
      if (!prev || !prev.gitStatus) return prev;
      const curStaged = [...(prev.gitStatus.staged || [])];
      let curUnstaged = [...(prev.gitStatus.unstaged || [])];
      let curUntracked = [...(prev.gitStatus.untracked || [])];

      if (all || !path) {
        // 暂存全部
        const stagedPaths = new Set(curStaged.map((f) => f.path));
        for (const item of [...curUnstaged, ...curUntracked]) {
          if (!stagedPaths.has(item.path)) {
            stagedPaths.add(item.path);
            curStaged.push({
              ...item,
              status: item.status === '?' ? 'A' : item.status,
              staged: true,
            });
          }
        }
        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            staged: curStaged,
            unstaged: [],
            untracked: [],
          },
        };
      } else {
        // 暂存单个文件
        const targetFromUnstaged = curUnstaged.find((f) => f.path === path);
        const targetFromUntracked = curUntracked.find((f) => f.path === path);
        const target = targetFromUnstaged || targetFromUntracked;
        if (!target) return prev;

        curUnstaged = curUnstaged.filter((f) => f.path !== path);
        curUntracked = curUntracked.filter((f) => f.path !== path);

        const existingIdx = curStaged.findIndex((f) => f.path === path);
        const stagedItem: GitStatusItem = {
          ...target,
          status: target.status === '?' ? 'A' : target.status,
          staged: true,
        };
        if (existingIdx !== -1) {
          curStaged[existingIdx] = stagedItem;
        } else {
          curStaged.push(stagedItem);
        }

        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            staged: curStaged,
            unstaged: curUnstaged,
            untracked: curUntracked,
          },
        };
      }
    });

    try {
      await gitStage({ path, all, cwd: effectiveCwd });
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: false });
    } catch (err: any) {
      setError(err?.message || 'Stage failed');
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
    } finally {
      setActionLoadingPath(null);
    }
  };

  // Unstage file or all
  const handleUnstage = async (path?: string, all?: boolean) => {
    setActionLoadingPath(path || 'all');
    setError(null);

    // 0ms 瞬间乐观更新：立即将文件从暂存区移回未暂存区
    gitStore.setOptimisticState(cwd, (prev) => {
      if (!prev || !prev.gitStatus) return prev;
      let curStaged = [...(prev.gitStatus.staged || [])];
      const curUnstaged = [...(prev.gitStatus.unstaged || [])];
      let curUntracked = [...(prev.gitStatus.untracked || [])];

      if (all || !path) {
        // 取消暂存全部
        const unstagedPaths = new Set(curUnstaged.map((f) => f.path));
        for (const item of curStaged) {
          if (!unstagedPaths.has(item.path)) {
            unstagedPaths.add(item.path);
            if (item.status === 'A') {
              curUntracked.push({ ...item, status: '?', staged: false });
            } else {
              curUnstaged.push({ ...item, staged: false });
            }
          }
        }
        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            staged: [],
            unstaged: curUnstaged,
            untracked: curUntracked,
          },
        };
      } else {
        // 取消暂存单个文件
        const target = curStaged.find((f) => f.path === path);
        if (!target) return prev;

        curStaged = curStaged.filter((f) => f.path !== path);
        if (target.status === 'A') {
          if (!curUntracked.some((f) => f.path === path)) {
            curUntracked.push({ ...target, status: '?', staged: false });
          }
        } else {
          if (!curUnstaged.some((f) => f.path === path)) {
            curUnstaged.push({ ...target, staged: false });
          }
        }

        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            staged: curStaged,
            unstaged: curUnstaged,
            untracked: curUntracked,
          },
        };
      }
    });

    try {
      await gitUnstage({ path, all, cwd: effectiveCwd });
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: false });
    } catch (err: any) {
      setError(err?.message || 'Unstage failed');
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
    } finally {
      setActionLoadingPath(null);
    }
  };

  // Discard changes
  const handleDiscard = async (file: GitStatusItem) => {
    const ok = await modalConfirm({
      title: t('git.discardFile'),
      body: t('git.discardConfirm').replace('{path}', file.path),
      icon: '⚠️',
      danger: true,
      confirmLabel: t('git.discardFile'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setActionLoadingPath(file.path);
    setError(null);

    // 0ms 瞬间乐观更新：立刻在前端移除该文件，绝不产生滞留视觉
    gitStore.setOptimisticState(cwd, (prev) => {
      if (!prev || !prev.gitStatus) return prev;
      return {
        ...prev,
        gitStatus: {
          ...prev.gitStatus,
          unstaged: prev.gitStatus.unstaged.filter((f) => f.path !== file.path),
          untracked: prev.gitStatus.untracked.filter((f) => f.path !== file.path),
          staged: prev.gitStatus.staged.filter((f) => f.path !== file.path),
        },
      };
    });

    try {
      await gitDiscard({ path: file.path, isUntracked: file.status === '?', cwd: effectiveCwd });
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
    } catch (err: any) {
      setError(err?.message || 'Discard failed');
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
    } finally {
      setActionLoadingPath(null);
    }
  };

  // Discard all changes
  const handleDiscardAll = async () => {
    if (unstagedItems.length === 0) return;
    const ok = await modalConfirm({
      title: t('git.discardAll'),
      body: t('git.discardAllCountConfirm').replace('{count}', String(unstagedItems.length)),
      icon: '⚠️',
      danger: true,
      confirmLabel: t('git.discardAll'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;

    setActionLoadingPath('all');
    setError(null);

    // 0ms 瞬间乐观清空
    gitStore.setOptimisticState(cwd, (prev) => {
      if (!prev || !prev.gitStatus) return prev;
      return {
        ...prev,
        gitStatus: {
          ...prev.gitStatus,
          unstaged: [],
          untracked: [],
        },
      };
    });

    try {
      for (const file of unstagedItems) {
        await gitDiscard({ path: file.path, isUntracked: file.status === '?', cwd: effectiveCwd });
      }
      showToast(t('git.discardAll') + ` (${unstagedItems.length})`, 'info');
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
    } catch (err: any) {
      setError(err?.message || 'Discard all failed');
      await gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
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
      const ok = await modalConfirm({
        title: t('git.commitBtn'),
        body: t('git.commitNoStagedPrompt'),
          danger: false,
        confirmLabel: t('git.stageAllAndCommit'),
        cancelLabel: t('common.cancel'),
      });
      if (!ok) {
        return;
      }
      // Auto stage all
      await handleStage(undefined, true);
    }

    setIsCommitting(true);
    setError(null);
    try {
      const res = await gitCommit({ message: msg, cwd: effectiveCwd });

      // 0ms 瞬间乐观更新：暂存区立即清空，ahead 立即累加，体验对齐 VS Code 极速体感
      gitStore.setOptimisticState(cwd, (prev) => {
        if (!prev || !prev.gitStatus) return prev;
        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            staged: [],
            ahead: (prev.gitStatus.ahead || 0) + 1,
          },
        };
      });

      const fallbackCount = stagedCount > 0 ? stagedCount : unstagedCount;
      setSuccessMsg(formatGitCommitBanner(res, t, fallbackCount));
      setCommitMessage('');
      // 提交后主动异步触发一次绿色刷新（拉取本地与远程图谱，使提交记录立即可见）
      void handleFullRefresh();
    } catch (err: any) {
      setError(err?.message || 'Commit failed');
      void gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
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

      // 0ms 乐观重置 ahead / behind
      gitStore.setOptimisticState(cwd, (prev) => {
        if (!prev || !prev.gitStatus) return prev;
        return {
          ...prev,
          gitStatus: {
            ...prev.gitStatus,
            ahead: 0,
            behind: 0,
          },
        };
      });

      // 主动异步触发完整刷新
      void handleFullRefresh();
    } catch (err: any) {
      setError(err?.message || 'Sync failed');
      void gitStore.scheduleRefresh(cwd, { immediate: true, forceAll: true });
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
    void copyTextToClipboard(hash).then((ok) => {
      if (ok) {
        setCopiedHash(hash);
        setTimeout(() => setCopiedHash(null), 1500);
      }
    });
  };

  // Generic copy helper with unique key (e.g. `hash-${hash}`, `msg-${hash}`, `author-${hash}`)
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const handleCopyText = (key: string, text: string) => {
    void copyTextToClipboard(text).then((ok) => {
      if (ok) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 1500);
      }
    });
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

  // 只有在确定没有任何可用子仓库，且当前分支信息确实判定为非 repo 时，才展示空占位
  if (branches && !branches.is_repo && repos.length === 0) {
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


  const renderChangesContent = () => (
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
                    onClick={handleDiscardAll}
                    title={t('git.discardAll')}
                    disabled={actionLoadingPath === 'all'}
                  >
                    ↺
                  </button>
                  <button
                    type="button"
                    class="git-icon-action-btn"
                    onClick={() => handleStage(undefined, true)}
                    title={t('git.stageAll')}
                    disabled={actionLoadingPath === 'all'}
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
  );

  const renderBranchesContent = () => (
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
          <div class="git-section-header" style={{ marginTop: '16px' }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
            <span class="git-section-title">{t('git.remote')}</span>
            <span class="git-badge-counter">{branches?.remote.length ?? 0}</span>
            <button
              type="button"
              class={'git-fetch-mini-btn' + (isFetching ? ' spinning' : '')}
              onClick={(e) => {
                e.stopPropagation();
                handleFetch(false);
              }}
              title={t('git.fetch')}
              style={{
                marginLeft: 'auto',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 6px',
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--text-secondary, #8b949e)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V2l-2.35.35z" />
              </svg>
            </button>
          </div>
          {branches && branches.remote.length > 0 && (
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
          )}
    </div>
  );

  const renderGraphContent = () => (
    <div class="git-graph-container">
          {/* Branch filter picker */}
          <div class="git-graph-filter-row">
            <span class="git-filter-label">{t('git.branches')}:</span>
            <select
              class="git-filter-select"
              value={filterBranch}
              onChange={(e) => {
                const nextBranch = (e.target as HTMLSelectElement).value;
                setFilterBranch(nextBranch);
                gitStore.scheduleRefresh(cwd, {
                  immediate: true,
                  forceAll: true,
                  filterBranch: nextBranch,
                });
              }}
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
            <div class="git-graph-rows-wrap">
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
                        toggleCommitExpanded(c);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const { x, y } = calcGitContextMenuPos(e, 200, 320);
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
                            fill={isHead ? 'var(--app-primary-background, #131314)' : row.color}
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
                            <span class="git-meta-author-group">
                              <span class="git-expanded-author">{c.author_name}</span>
                              {c.author_email && (
                                <span class="git-hover-email">&lt;{c.author_email}&gt;</span>
                              )}
                              <button
                                type="button"
                                class="git-pure-icon-btn git-copy-pure-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const authorText = c.author_email
                                    ? `${c.author_name} <${c.author_email}>`
                                    : c.author_name;
                                  handleCopyText(`author-${c.hash}`, authorText);
                                }}
                                title={
                                  copiedKey === `author-${c.hash}`
                                    ? t('git.hoverCopied')
                                    : t('git.copyAuthor')
                                }
                                aria-label={t('git.copyAuthor')}
                              >
                                {copiedKey === `author-${c.hash}` ? (
                                  <span class="git-copied-icon">✓</span>
                                ) : (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                  </svg>
                                )}
                              </button>
                            </span>
                            <span class="git-meta-time-group">
                              <span class="git-expanded-time">
                                {formatRelativeTimeI18n(c.timestamp, isZh)} ({formatCommitDateTime(c.timestamp, isZh)})
                              </span>
                            </span>
                          </div>

                          {(() => {
                            const parsedMsg = parseCommitMessage(c.message);
                            return (
                              <>
                                <div class="git-expanded-subject-row">
                                  <div class="git-expanded-subject" title={parsedMsg.subject}>
                                    {parsedMsg.subject}
                                  </div>
                                  <div class="git-expanded-subject-actions">
                                    {(() => {
                                      const webLink = getCommitWebUrl(c.hash);
                                      if (!webLink) return null;
                                      return (
                                        <a
                                          href={webLink.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          class="git-pure-icon-btn git-external-link-btn"
                                          onClick={(e) => e.stopPropagation()}
                                          title={t('git.openOnRemote', { platform: webLink.platform })}
                                          aria-label={t('git.openOnRemote', { platform: webLink.platform })}
                                        >
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                            <polyline points="15 3 21 3 21 9" />
                                            <line x1="10" y1="14" x2="21" y2="3" />
                                          </svg>
                                        </a>
                                      );
                                    })()}
                                    <button
                                      type="button"
                                      class="git-pure-icon-btn git-copy-pure-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCopyText(`msg-${c.hash}`, c.message);
                                      }}
                                      title={
                                        copiedKey === `msg-${c.hash}`
                                          ? t('git.hoverCopied')
                                          : t('git.copyMessage')
                                      }
                                      aria-label={t('git.copyMessage')}
                                    >
                                      {copiedKey === `msg-${c.hash}` ? (
                                        <span class="git-copied-icon">✓</span>
                                      ) : (
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                      )}
                                    </button>
                                  </div>
                                </div>

                                {c.message.includes('\n') && (
                                  <div class="git-expanded-body">
                                    {c.message.split('\n').slice(1).join('\n').trim()}
                                  </div>
                                )}
                              </>
                            );
                          })()}

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

                          {/* Ref Badges (Branches & Tags) */}
                          {c.refs.length > 0 && (
                            <div class="git-hover-refs-wrap">
                              {c.refs.map((r, idx) => {
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

                          {/* Expanded Bottom Bar: ⎇ short_hash [copy] | Actions Dropdown */}
                          <div class="git-expanded-bottom-bar">
                            <div class="git-hover-bottom-left">
                              <span class="git-hover-branch-icon">⎇</span>
                              <span
                                class="git-hover-hash"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyText(`hash-${c.hash}`, c.hash);
                                }}
                                title={t('git.hoverCopyHash')}
                              >
                                {c.short_hash}
                              </span>
                              <button
                                type="button"
                                class="git-pure-icon-btn git-copy-pure-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyText(`hash-${c.hash}`, c.hash);
                                }}
                                title={
                                  copiedKey === `hash-${c.hash}` || copiedHash === c.hash
                                    ? t('git.hoverCopied')
                                    : t('git.hoverCopyHash')
                                }
                                aria-label={t('git.hoverCopyHash')}
                              >
                                {copiedKey === `hash-${c.hash}` || copiedHash === c.hash ? (
                                  <span class="git-copied-icon">✓</span>
                                ) : (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                  </svg>
                                )}
                              </button>
                            </div>

                            <div class="git-expanded-bottom-right">
                              {(() => {
                                const webLink = getCommitWebUrl(c.hash);
                                const isActionOpen = actionDropdownHash === c.hash;
                                return (
                                  <div class="git-action-dropdown-wrap">
                                    <button
                                      type="button"
                                      class={`git-quick-dropdown-btn ${isActionOpen ? 'active' : ''}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActionDropdownHash((prev) => (prev === c.hash ? null : c.hash));
                                      }}
                                      title={t('git.actions')}
                                      aria-expanded={isActionOpen}
                                    >
                                      <span>{t('git.actions')}</span>
                                      <svg
                                        width="10"
                                        height="10"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2.5"
                                        class={`git-dropdown-arrow ${isActionOpen ? 'rotate-180' : ''}`}
                                      >
                                        <polyline points="6 9 12 15 18 9" />
                                      </svg>
                                    </button>

                                    {isActionOpen && (
                                      <div
                                        class="git-action-dropdown-menu"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <button
                                          type="button"
                                          class="git-dropdown-menu-item"
                                          onClick={() => {
                                            setActionDropdownHash(null);
                                            handleCheckout(c.hash);
                                          }}
                                        >
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="9 11 12 14 22 4" />
                                            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                                          </svg>
                                          <span>{t('git.ctxCheckout')}</span>
                                        </button>
                                        <button
                                          type="button"
                                          class="git-dropdown-menu-item"
                                          onClick={() => {
                                            setActionDropdownHash(null);
                                            handleCreateBranchAt(c);
                                          }}
                                        >
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <line x1="6" y1="3" x2="6" y2="15" />
                                            <circle cx="18" cy="6" r="3" />
                                            <circle cx="6" cy="18" r="3" />
                                            <path d="M18 9a9 9 0 0 1-9 9" />
                                          </svg>
                                          <span>{t('git.ctxCreateBranch')}</span>
                                        </button>
                                        <button
                                          type="button"
                                          class="git-dropdown-menu-item"
                                          onClick={() => {
                                            setActionDropdownHash(null);
                                            handleCreateTagAt(c);
                                          }}
                                        >
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                                            <line x1="7" y1="7" x2="7.01" y2="7" />
                                          </svg>
                                          <span>{t('git.ctxCreateTag')}</span>
                                        </button>
                                        <div class="git-dropdown-menu-divider" />
                                        <button
                                          type="button"
                                          class="git-dropdown-menu-item"
                                          onClick={() => {
                                            setActionDropdownHash(null);
                                            handleCherryPick(c);
                                          }}
                                        >
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <circle cx="12" cy="12" r="10" />
                                            <polyline points="12 6 12 12 16 14" />
                                          </svg>
                                          <span>{t('git.ctxCherryPick')}</span>
                                        </button>
                                        <button
                                          type="button"
                                          class="git-dropdown-menu-item"
                                          onClick={() => {
                                            setActionDropdownHash(null);
                                            handleRevert(c);
                                          }}
                                        >
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="1 4 1 10 7 10" />
                                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                          </svg>
                                          <span>{t('git.ctxRevert')}</span>
                                        </button>
                                        {webLink && (
                                          <>
                                            <div class="git-dropdown-menu-divider" />
                                            <a
                                              href={webLink.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              class="git-dropdown-menu-item"
                                              onClick={() => setActionDropdownHash(null)}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                                <polyline points="15 3 21 3 21 9" />
                                                <line x1="10" y1="14" x2="21" y2="3" />
                                              </svg>
                                              <span>{t('git.openOnRemote', { platform: webLink.platform })}</span>
                                            </a>
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
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
  );

  return (
    <div class="git-panel-root">
      {/* Multi-Repo Switcher Bar (VSCode style - 顶层常驻置顶) */}
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
              gitStore.setActiveRepoRoot(cwd, newRoot, sessionId);
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

      {/* Top Toolbar */}
      <div class="git-panel-toolbar">
        <div class="git-panel-subtabs">
          {!isMobile ? (
            <>
              <button
                type="button"
                class={'git-subtab-btn' + (subView === 'changes' || subView === 'graph' ? ' active' : '')}
                onClick={() => setSubView('changes')}
                title={t('git.graphView')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M14.5 2h-13a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5zm-12 1h11v9h-11V3zm2 2h7v1h-7V5zm0 3h7v1h-7V8z" />
                </svg>
                <span>{t('git.graphView') || 'Graph'}</span>
                {totalChangedCount > 0 && (
                  <span class="git-badge-counter badge-highlight">{totalChangedCount}</span>
                )}
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
            </>
          ) : (
            <>
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
                title={t('git.commits')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M10.5 8a2.5 2.5 0 0 1-5 0H1v-1h4.5a2.5 2.5 0 0 1 5 0H15v1h-4.5z" />
                </svg>
                <span>{t('git.commits') || 'Commits'}</span>
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
            </>
          )}
        </div>

        <button
          type="button"
          class={'git-refresh-btn' + (loading || isFetching ? ' spinning' : '')}
          onClick={handleFullRefresh}
          title={t('git.refreshAndFetch')}
          aria-label={t('git.refresh')}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V2l-2.35.35z" />
          </svg>
        </button>
      </div>

      {/* Alert / Notifications */}
      {error && (
        <div class="git-alert-banner git-alert-error" role="alert">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
            <span>{error}</span>
            {error.includes('overwritten by checkout') && (
              <div style={{ marginTop: '4px' }}>
                <button
                  type="button"
                  class="git-checkout-btn"
                  style={{ display: 'inline-block', width: 'auto', padding: '2px 8px', fontSize: '11px' }}
                  onClick={() => setSubView('changes')}
                >
                  {t('git.goToChangesToCommit')}
                </button>
              </div>
            )}
          </div>
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
  
      {/* VIEW MAIN BODY: BRANCHES OR COMBINED/STANDALONE */}
      {subView === "branches" ? (
        renderBranchesContent()
      ) : !isMobile ? (
        <div class="git-combined-view" ref={combinedViewRef}>
          <div
            class="git-combined-changes-pane"
            style={{
              height: commitsCollapsed ? "calc(100% - 32px)" : `${Math.round(splitRatio * 100)}%`,
            }}
          >
            {renderChangesContent()}
          </div>

          {!commitsCollapsed && (
            <div
              class="git-split-resizer"
              onMouseDown={handleResizerMouseDown}
              title={t('common.drag')}
            />
          )}

          <div
            class="git-combined-commits-pane"
            style={{
              height: commitsCollapsed ? "32px" : `${100 - Math.round(splitRatio * 100)}%`,
            }}
          >
            <div class="git-commits-section-header" onClick={toggleCommitsCollapse}>
              <span class="git-section-caret">{commitsCollapsed ? "▶" : "▼"}</span>
              <span class="git-section-title">{t("git.commits") || "Commits"}</span>
              <span class="git-badge-counter">{graphRows.length}</span>
              <div class="git-section-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  class={"git-section-action-btn" + (loading || isFetching ? " spinning" : "")}
                  onClick={handleFullRefresh}
                  title={t("git.refresh")}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V2l-2.35.35z" />
                  </svg>
                </button>
              </div>
            </div>
            {!commitsCollapsed && (
              <div class="git-combined-commits-body">
                {renderGraphContent()}
              </div>
            )}
          </div>
        </div>
      ) : subView === "changes" ? (
        renderChangesContent()
      ) : (
        renderGraphContent()
      )}

      {contextMenu && typeof document !== 'undefined' && createPortal(
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
              void copyTextToClipboard(contextMenu.commit.message);
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
        </div>,
        document.body,
      )}

      {/* VSCode Branch Context Menu (Portal 到 document.body 防缩放漂移) */}
      {branchContextMenu && typeof document !== 'undefined' && createPortal(
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
              void copyTextToClipboard(branchContextMenu.branch);
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
        </div>,
        document.body,
      )}
    </div>
  );
}
