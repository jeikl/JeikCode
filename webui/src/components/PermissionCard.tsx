// Task 14 — Tool approval modal card

import { useState } from 'preact/hooks';
import { respondPermission } from '../api';
import { useT } from '../settings';
import { formatToolPayload } from '../lib/toolDisplay';

interface PermissionRequest {
  session_id: string;
  approval_id?: string;
  tool_name: string;
  reason: string;
  call_id: string;
  arguments: unknown;
}

interface PermissionCardProps {
  req: PermissionRequest;
  onDone: () => void;
  /** Optional override for the decision action. When provided, replaces the
   *  default respondPermission call. Used by live-session approval (POST /live/permission)
   *  so the non-sync /chat path is unchanged. */
  onDecide?: (decision: 'allow' | 'deny' | 'always_allow' | 'allow_persist', toolName?: string) => Promise<void>;
  /** Corner stack instead of a blocking overlay. */
  dock?: boolean;
}

function formatArgs(args: unknown): string {
  if (typeof args === 'string') {
    return formatToolPayload(args);
  }
  try {
    return formatToolPayload(JSON.stringify(args));
  } catch {
    return String(args);
  }
}

export function PermissionCard({ req, onDone, onDecide, dock }: PermissionCardProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);

  async function decide(decision: 'allow' | 'deny' | 'always_allow' | 'allow_persist') {
    if (loading) return;
    setLoading(true);
    try {
      if (onDecide) {
        await onDecide(decision, req.tool_name);
      } else {
        if (!req.approval_id) throw new Error('missing approval identity');
        const result = await respondPermission(req.session_id, req.approval_id, decision, req.tool_name);
        if (!result.success) throw new Error('permission request is no longer pending');
      }
      onDone();
    } catch {
      // Keep the exact approval visible and actionable when delivery was not
      // confirmed. Poll/SSE reconciliation can still retire a genuinely stale
      // request, while transient transport failures remain retryable.
    } finally {
      setLoading(false);
    }
  }

  const argsDisplay = formatArgs(req.arguments);

  const card = (
      <div class="modal-card permission-card">
        <div class="modal-header permission-header">
          <span class="permission-logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <rect
                x="6.4"
                y="6.4"
                width="11.2"
                height="11.2"
                rx="2.6"
                transform="rotate(45 12 12)"
                stroke="currentColor"
                stroke-width="1.8"
              />
            </svg>
          </span>
          <h3 class="permission-title">{t('perm.title')}</h3>
          <span class="modal-tag permission-tag">{req.tool_name}</span>
        </div>

        <div class="modal-body">
          {req.reason && <p class="permission-lead">{req.reason}</p>}
          <div class="field-group">
            <span class="modal-label">{t('perm.args')}</span>
            <pre class="tool-body-row-content">{argsDisplay}</pre>
          </div>
        </div>

        <div class="modal-footer permission-footer">
          <button class="btn" disabled={loading} onClick={() => decide('deny')}>
            {t('perm.deny')}
          </button>
          <button class="btn btn-primary" disabled={loading} onClick={() => decide('allow')}>
            {t('perm.approve')}
          </button>
          <button class="btn" disabled={loading} onClick={() => decide('always_allow')}>
            {t('perm.alwaysAllow')}
          </button>
          {req.tool_name.startsWith('mcp__') && (
            <button class="btn" disabled={loading} onClick={() => decide('allow_persist')}>
              {t('perm.allowPersist')}
            </button>
          )}
        </div>
      </div>
  );
  if (dock) return <div class="notify-card">{card}</div>;
  return <div class="modal-overlay">{card}</div>;
}
