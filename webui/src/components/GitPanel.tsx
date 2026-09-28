import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import { useT } from '../settings';
import {
  fetchGitBranches,
  fetchGitGraph,
  checkoutGitBranch,
  type GitBranchesResponse,
  type GitCommitItem,
} from '../api';
import {
  buildGitGraph,
  formatRelativeTime,
  ROW_HEIGHT,
  LANE_WIDTH,
  LANE_OFFSET,
} from '../lib/gitGraph';

interface GitPanelProps {
  cwd?: string;
  refreshTrigger?: number;
  onBranchChanged?: (newBranch: string) => void;
}

export function GitPanel({ cwd, refreshTrigger, onBranchChanged }: GitPanelProps) {
  const t = useT();

  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [commits, setCommits] = useState<GitCommitItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [filterBranch, setFilterBranch] = useState<'all' | string>('all');
  const [subView, setSubView] = useState<'graph' | 'branches'>('graph');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Load Git data
  const loadGitData = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    setError(null);
    try {
      const [branchRes, graphRes] = await Promise.all([
        fetchGitBranches(cwd),
        fetchGitGraph({ cwd, branch: filterBranch === 'all' ? undefined : filterBranch, limit: 80 }),
      ]);
      setBranches(branchRes);
      setCommits(graphRes.commits);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Git status');
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [cwd, filterBranch]);

  // Initial load and reload when cwd, filterBranch, or refreshTrigger changes
  useEffect(() => {
    loadGitData(false);
  }, [loadGitData, refreshTrigger]);

  // Handle branch checkout
  const handleCheckout = async (branchName: string) => {
    if (branchName === branches?.current || switching) return;
    setSwitching(branchName);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await checkoutGitBranch(branchName, cwd);
      setSuccessMsg(`${t('git.switchSuccess')} ${res.branch}`);
      onBranchChanged?.(res.branch);
      // Reload branch & graph immediately
      await loadGitData(true);
    } catch (err: any) {
      setError(err?.message || t('git.switchFailed'));
    } finally {
      setSwitching(null);
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
  const svgWidth = Math.max(36, LANE_OFFSET * 2 + maxLanes * LANE_WIDTH);

  if (loading && !branches) {
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

  const currentBranch = branches?.current || '';

  return (
    <div class="git-panel-root">
      {/* Top Toolbar */}
      <div class="git-panel-toolbar">
        <div class="git-panel-subtabs">
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
              const isPending = switching === b;
              return (
                <div
                  key={b}
                  class={'git-branch-item' + (isCurrent ? ' current' : '')}
                  onClick={() => !isCurrent && handleCheckout(b)}
                  title={isCurrent ? `${b} (${t('git.currentBranch')})` : `${t('git.checkout')} ${b}`}
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
                  {isPending && <span class="git-spinner-mini" />}
                </div>
              );
            })}
          </div>

          {/* Remote Branches Section */}
          {branches && branches.remote.length > 0 && (
            <>
              <div class="git-section-header" style={{ marginTop: '12px' }}>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
                <span class="git-section-title">{t('git.remote')}</span>
                <span class="git-badge-counter">{branches.remote.length}</span>
              </div>
              <div class="git-branch-list">
                {branches.remote.map((rb) => {
                  const isPending = switching === rb;
                  return (
                    <div
                      key={rb}
                      class="git-branch-item remote"
                      onClick={() => handleCheckout(rb)}
                      title={`${t('git.checkout')} ${rb}`}
                    >
                      <span class="git-branch-status-icon">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" opacity="0.5" aria-hidden="true">
                          <path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 3a1.75 1.75 0 1 0-1.07 3.13 4.25 4.25 0 0 1-2.93 2.12v-1.5a1.75 1.75 0 1 0-1.5 0v4.5a1.75 1.75 0 1 0 1.5 0V9.8a5.75 5.75 0 0 0 3.75-2.67A1.75 1.75 0 0 0 11.75 3zm-6.25 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm0-7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm6.25-2a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
                        </svg>
                      </span>
                      <span class="git-branch-name">{rb}</span>
                      {isPending && <span class="git-spinner-mini" />}
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
            <div class="git-graph-rows-wrap">
              {graphRows.map((row) => {
                const c = row.commit;
                const isHead = c.refs.some((r) => r.includes('HEAD'));
                const hasPill = c.refs.length > 0;

                return (
                  <div key={c.hash} class={'git-graph-row' + (isHead ? ' head-row' : '')}>
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
                            stroke-width={p.isMerge ? 1.6 : 1.8}
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
                          r={isHead ? 4.5 : 3.5}
                          fill={isHead ? 'var(--app-background, #1e1e1e)' : row.color}
                          stroke={row.color}
                          stroke-width={isHead ? 2.5 : 1.5}
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
                                <span key={rIdx} class={pillClass} title={r}>
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        <span class="git-commit-msg" title={c.message}>
                          {c.message}
                        </span>
                      </div>

                      <div class="git-commit-line2">
                        <span
                          class="git-commit-hash"
                          onClick={() => handleCopyHash(c.hash)}
                          title={`Click to copy: ${c.hash}`}
                        >
                          {copiedHash === c.hash ? 'copied!' : c.short_hash}
                        </span>
                        <span class="git-commit-author" title={c.author_email}>
                          {c.author_name}
                        </span>
                        <span class="git-commit-time">
                          {formatRelativeTime(c.timestamp)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
