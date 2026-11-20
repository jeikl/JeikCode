import { useState, useEffect, useRef } from 'preact/hooks';
import { ApprovalMode } from '../api';
import { useT } from '../settings';
import { MsgKey } from '../i18n';

// Approval modes shown in the pill dropdown. Order = display order.
// The Auto mode keeps the `bypass` wire value for protocol compatibility and
// remains safety-consequential, so it is styled with a warning accent.
const MODE_OPTIONS: { val: ApprovalMode; label: MsgKey; desc: MsgKey }[] = [
  { val: 'build', label: 'mode.build', desc: 'mode.build.desc' },
  { val: 'accept_edits', label: 'mode.accept_edits', desc: 'mode.accept_edits.desc' },
  { val: 'bypass', label: 'mode.auto', desc: 'mode.auto.desc' },
  { val: 'plan', label: 'mode.plan', desc: 'mode.plan.desc' },
];

export function ModeSelector({
  value,
  disabled = false,
  globalEnabled = false,
  onToggleGlobal,
  onOpenModeSettings,
  onChange,
}: {
  value: ApprovalMode;
  disabled?: boolean;
  /** 全局开关当前状态：开启后所有会话统一使用 `value`。 */
  globalEnabled?: boolean;
  /** 切换全局开关；未提供时不渲染底部开关。 */
  onToggleGlobal?: (enabled: boolean) => void;
  /** 打开系统设置 -> Agent 模式配置。 */
  onOpenModeSettings?: () => void;
  onChange: (m: ApprovalMode) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const current = MODE_OPTIONS.find((o) => o.val === value) ?? MODE_OPTIONS[0];
  const isAuto = value === 'bypass';
  return (
    <div class="model-selector model-selector-up mode-selector" ref={ref}>
      <button
        class={'model-selector-trigger mode-selector-trigger' + (isAuto ? ' mode-bypass' : '')}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        disabled={disabled}
        type="button"
        title={t('mode.label')}
      >
        <span class="model-selector-label">{t(current.label)}</span>
        <span class="model-selector-chevron">▾</span>
      </button>
      {open && (
        <div class="model-dropdown mode-dropdown">
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.val}
              class={
                'model-item mode-item' +
                (o.val === value ? ' active' : '') +
                (o.val === 'bypass' ? ' mode-item-bypass' : '')
              }
              type="button"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                onChange(o.val);
                setOpen(false);
              }}
            >
              <span class="model-item-model">{t(o.label)}</span>
              <span class="mode-item-desc">{t(o.desc)}</span>
            </button>
          ))}
          {(onToggleGlobal || onOpenModeSettings) && (
            <div class="mode-global-row">
              <div class="mode-global-text">
                <span class="mode-global-label">{t('mode.global')}</span>
                <span class="mode-global-desc">{t('mode.global.desc')}</span>
              </div>
              <div class="mode-global-controls">
                {onOpenModeSettings && (
                  <button
                    type="button"
                    class="mode-settings-btn"
                    aria-label={t('mode.settingsBtn')}
                    title={t('mode.settingsBtn')}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onOpenModeSettings();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                )}
                {onToggleGlobal && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={globalEnabled ? 'true' : 'false'}
                    aria-label={t('mode.global')}
                    title={t('mode.global.desc')}
                    class={'mode-global-switch' + (globalEnabled ? ' on' : '')}
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (disabled) return;
                      onToggleGlobal(!globalEnabled);
                    }}
                  >
                    <span class="mode-global-knob" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
