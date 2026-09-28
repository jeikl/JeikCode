import type { GitCommitItem } from '../api';

export const GRAPH_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
  '#e11d48', // rose
];

export interface GraphPath {
  d: string;
  color: string;
  isMerge?: boolean;
}

export interface GraphRow {
  commit: GitCommitItem;
  lane: number;
  color: string;
  cx: number;
  cy: number;
  paths: GraphPath[];
  maxLanes: number;
}

export const ROW_HEIGHT = 48;
export const LANE_WIDTH = 16;
export const LANE_OFFSET = 14;

/**
 * Computes the swimlane layout and SVG connection paths for a sequence of commits.
 * Returns an array of GraphRow aligned with the input commits.
 */
export function buildGitGraph(commits: GitCommitItem[]): GraphRow[] {
  if (!commits || commits.length === 0) return [];

  // activeLanes keeps track of which commit hash is expected next in each lane slot
  const activeLanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let globalMaxLanes = 1;

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!;
    const hash = commit.hash;

    // 1. Determine which lane this commit occupies
    let lane = activeLanes.indexOf(hash);
    let isNewLane = false;

    if (lane === -1) {
      // Find first empty slot or append
      const emptySlot = activeLanes.indexOf(null);
      if (emptySlot !== -1) {
        lane = emptySlot;
      } else {
        lane = activeLanes.length;
      }
      isNewLane = true;
    }

    activeLanes[lane] = hash;
    const color = GRAPH_PALETTE[lane % GRAPH_PALETTE.length]!;

    const cx = LANE_OFFSET + lane * LANE_WIDTH;
    const cy = ROW_HEIGHT / 2;

    const paths: GraphPath[] = [];

    // Pass-through lines for other active lanes that continue through this row
    for (let l = 0; l < activeLanes.length; l++) {
      if (l !== lane && activeLanes[l] !== null) {
        const lx = LANE_OFFSET + l * LANE_WIDTH;
        const lColor = GRAPH_PALETTE[l % GRAPH_PALETTE.length]!;
        paths.push({
          d: `M ${lx} 0 L ${lx} ${ROW_HEIGHT}`,
          color: lColor,
        });
      }
    }

    // Line from top into this commit if it was already expected in activeLanes
    if (!isNewLane) {
      paths.push({
        d: `M ${cx} 0 L ${cx} ${cy}`,
        color,
      });
    }

    // 2. Update activeLanes for parents
    const parents = commit.parents;

    if (parents.length === 0) {
      // Root commit - frees the lane
      activeLanes[lane] = null;
    } else {
      const primaryParent = parents[0]!;

      // Check if primary parent is already in another lane
      const existingPrimaryLane = activeLanes.indexOf(primaryParent);
      if (existingPrimaryLane !== -1 && existingPrimaryLane !== lane) {
        // Merge into existing lane
        const px = LANE_OFFSET + existingPrimaryLane * LANE_WIDTH;
        paths.push({
          d: `M ${cx} ${cy} C ${cx} ${cy + 14}, ${px} ${ROW_HEIGHT - 10}, ${px} ${ROW_HEIGHT}`,
          color,
          isMerge: true,
        });
        activeLanes[lane] = null;
      } else {
        activeLanes[lane] = primaryParent;
        paths.push({
          d: `M ${cx} ${cy} L ${cx} ${ROW_HEIGHT}`,
          color,
        });
      }

      // Additional parents (merge commit)
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p]!;
        let parentLane = activeLanes.indexOf(parentHash);

        if (parentLane === -1) {
          const emptySlot = activeLanes.indexOf(null);
          if (emptySlot !== -1) {
            parentLane = emptySlot;
          } else {
            parentLane = activeLanes.length;
          }
          activeLanes[parentLane] = parentHash;
        }

        const px = LANE_OFFSET + parentLane * LANE_WIDTH;
        const pColor = GRAPH_PALETTE[parentLane % GRAPH_PALETTE.length]!;
        paths.push({
          d: `M ${cx} ${cy} C ${cx} ${cy + 16}, ${px} ${ROW_HEIGHT - 10}, ${px} ${ROW_HEIGHT}`,
          color: pColor,
          isMerge: true,
        });
      }
    }

    // Track max lane width needed
    const currentActiveCount = activeLanes.reduce((acc, cur, idx) => (cur !== null ? idx + 1 : acc), 0);
    const lanesUsed = Math.max(lane + 1, currentActiveCount, 1);
    if (lanesUsed > globalMaxLanes) {
      globalMaxLanes = lanesUsed;
    }

    rows.push({
      commit,
      lane,
      color,
      cx,
      cy,
      paths,
      maxLanes: lanesUsed,
    });
  }

  // Update maxLanes across all rows for consistent SVG width
  for (const r of rows) {
    r.maxLanes = globalMaxLanes;
  }

  return rows;
}

/** Formats a relative timestamp (e.g. "2h ago", "3d ago", "just now"). */
export function formatRelativeTime(epochSecs: number): string {
  if (!epochSecs || epochSecs <= 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - epochSecs);

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}
