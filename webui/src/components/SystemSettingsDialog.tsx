import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import {
  getDesktopSettings,
  postDesktopSettings,
  getHealth,
  invalidateBootstrapCache,
  type ApprovalMode,
  type DesktopSettings,
} from '../api';
import { bakedAppVersion, normalizeAppVersion } from '../lib/appVersion';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { useSettings } from '../settings';
import { ModelConfigView } from './SettingsDialogs';
import { ShortcutRecorder } from './ShortcutRecorder';
import { TerminalCheckCard } from './TerminalCheckCard';

interface SystemSettingsDialogProps {
  onClose: () => void;
  initialTab?: TabKey;
  focusSection?: 'agent_mode';
}

type TabKey = 'models' | 'desktop' | 'about';

interface ModuleTab {
  key: TabKey;
  labelKey: string;
  defaultLabel: string;
  icon: string;
}

export function SystemSettingsDialog({ onClose, initialTab, focusSection }: SystemSettingsDialogProps) {
  const { t, escUndoEnabled, setEscUndoEnabled } = useSettings();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab || 'models');
  const [closeAction, setCloseAction] = useState<'ask' | 'tray' | 'quit'>('ask');
  const [agentModePolicy, setAgentModePolicy] = useState<'memory' | 'global'>('memory');
  const [agentGlobalMode, setAgentGlobalMode] = useState<ApprovalMode>('build');
  const [runtimeModelSwitch, setRuntimeModelSwitch] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [hideTaskbarIcon, setHideTaskbarIcon] = useState(false);
  const [hideTaskbarIconSupported, setHideTaskbarIconSupported] = useState(true);
  const [toggleShortcut, setToggleShortcut] = useState('Ctrl+Alt+J');
  const [desktopLoaded, setDesktopLoaded] = useState(false);
  const [aboutLoaded, setAboutLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [appVersion, setAppVersion] = useState(bakedAppVersion());
  const agentModeBoxRef = useRef<HTMLDivElement>(null);

  // 遮罩空白处点击关闭：避免弹窗内拖拽划词时被误判为外部点击而秒关。
  const backdropDismiss = useBackdropDismiss(onClose);

  const tabs: ModuleTab[] = [
    { key: 'models', labelKey: 'settings.tabModels', defaultLabel: '提供商与模型', icon: '⚡' },
    { key: 'desktop', labelKey: 'settings.tabDesktop', defaultLabel: '系统设置', icon: '⌨️' },
    { key: 'about', labelKey: 'settings.tabAbout', defaultLabel: '关于与版本', icon: 'ℹ️' },
  ];

  // 仅当用户切换到桌面设置页签时再拉取，打开模型配置时零多余请求
  useEffect(() => {
    if (activeTab !== 'desktop' || desktopLoaded) return;
    let cancelled = false;
    setLoading(true);
    getDesktopSettings()
      .then((res) => {
        if (!cancelled) {
          if (res.close_action) setCloseAction(res.close_action);
          if (res.agent_mode_policy) setAgentModePolicy(res.agent_mode_policy);
          if (res.agent_global_mode) setAgentGlobalMode(res.agent_global_mode);
          if (typeof res.runtime_model_switch === 'boolean') setRuntimeModelSwitch(res.runtime_model_switch);
          if (typeof res.autostart === 'boolean') setAutostart(res.autostart);
          if (typeof res.hide_taskbar_icon === 'boolean') setHideTaskbarIcon(res.hide_taskbar_icon);
          if (typeof res.hide_taskbar_icon_supported === 'boolean') {
            setHideTaskbarIconSupported(res.hide_taskbar_icon_supported);
          }
          if (typeof res.toggle_shortcut === 'string') setToggleShortcut(res.toggle_shortcut);
          setDesktopLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, desktopLoaded]);

  // 从模式选择器齿轮跳转过来时，加载完成后自动定位到 Agent 模式设置区块
  useEffect(() => {
    if (activeTab !== 'desktop' || focusSection !== 'agent_mode' || !desktopLoaded) return;
    agentModeBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeTab, focusSection, desktopLoaded]);

  useEffect(() => {
    if (activeTab !== 'about' || aboutLoaded) return;
    let cancelled = false;
    getHealth()
      .then((info) => {
        if (cancelled) return;
        const running = normalizeAppVersion(info.version);
        if (running) setAppVersion(running);
        setAboutLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTab, aboutLoaded]);

  async function handleSaveDesktopSettings() {
    if (saving) return;
    setSaving(true);
    setSavedSuccess(false);
    try {
      await postDesktopSettings({
        close_action: closeAction,
        agent_mode_policy: agentModePolicy,
        agent_global_mode: agentGlobalMode,
        runtime_model_switch: runtimeModelSwitch,
        autostart,
        hide_taskbar_icon: hideTaskbarIcon,
        toggle_shortcut: toggleShortcut,
      });
      invalidateBootstrapCache();
      window.dispatchEvent(
        new CustomEvent('jeikcode:mode_global_changed', {
          detail: {
            enabled: agentModePolicy === 'global',
            mode: agentModePolicy === 'global' ? agentGlobalMode : 'build',
          },
        }),
      );
      setSavedSuccess(true);
      window.setTimeout(() => setSavedSuccess(false), 2000);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  // Cross-instance alignment: another WebUI may save these settings while this
  // dialog is open. The daemon broadcasts the merged document; apply it in
  // place so the shortcut/autostart/model-switch controls never show stale state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onSettings = (event: Event) => {
      const settings = (event as CustomEvent<{ settings?: DesktopSettings }>).detail
        ?.settings;
      if (!settings) return;
      if (settings.close_action) setCloseAction(settings.close_action);
      if (settings.agent_mode_policy) setAgentModePolicy(settings.agent_mode_policy);
      if (settings.agent_global_mode) setAgentGlobalMode(settings.agent_global_mode);
      if (typeof settings.runtime_model_switch === 'boolean') {
        setRuntimeModelSwitch(settings.runtime_model_switch);
      }
      if (typeof settings.autostart === 'boolean') setAutostart(settings.autostart);
      if (typeof settings.hide_taskbar_icon === 'boolean') setHideTaskbarIcon(settings.hide_taskbar_icon);
      if (typeof settings.hide_taskbar_icon_supported === 'boolean') {
        setHideTaskbarIconSupported(settings.hide_taskbar_icon_supported);
      }
      if (typeof settings.toggle_shortcut === 'string') {
        setToggleShortcut(settings.toggle_shortcut);
      }
      setDesktopLoaded(true);
    };
    window.addEventListener('jeikcode:desktop_settings_changed', onSettings);
    return () => window.removeEventListener('jeikcode:desktop_settings_changed', onSettings);
  }, []);

  const modal = (
    <div
      class="modal-overlay system-settings-modal-overlay"
      {...backdropDismiss}
      role="dialog"
      aria-modal="true"
    >
      <div
        class="modal-card modal-card-lg system-settings-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="modal-header system-settings-header">
          <div class="system-settings-header-title">
            <span class="system-settings-header-icon" aria-hidden="true">⚙️</span>
            <h3>{t('settings.systemSettings') || '系统设置'}</h3>
          </div>
          <button
            type="button"
            class="modal-close btn btn-ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content with Left Nav & Right Body (自适应：桌面左右分栏，手机顶部横向胶囊Tab + 100%满宽内容) */}
        <div class="system-settings-body">
          {/* Module Tabs */}
          <div class="system-settings-nav" role="tablist">
            {tabs.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  type="button"
                  key={tab.key}
                  role="tab"
                  aria-selected={active}
                  class={'system-settings-tab-btn' + (active ? ' active' : '')}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span class="tab-icon" aria-hidden="true">{tab.icon}</span>
                  <span class="tab-label">{t(tab.labelKey as any) || tab.defaultLabel}</span>
                </button>
              );
            })}
          </div>

          {/* Right Module Details */}
          <div
            class={'system-settings-content' + (activeTab === 'models' ? ' is-models' : '')}
            role="tabpanel"
          >
            {activeTab === 'models' && (
              <ModelConfigView onDone={onClose} />
            )}
            {activeTab === 'desktop' && (
              <div class="system-settings-pane">
                <h4 class="system-settings-pane-title">
                  {t('settings.tabDesktop') || '系统设置'}
                </h4>

                <TerminalCheckCard />

                <div class="system-settings-card-box">
                  <div class="system-settings-box-title">
                    {t('settings.startupTitle')}
                  </div>
                  <div class="system-settings-box-desc">
                    {t('settings.startupDesc')}
                  </div>

                  <label class="system-settings-radio-label system-settings-switch-row">
                    <input
                      type="checkbox"
                      checked={autostart}
                      onChange={(e) => setAutostart((e.target as HTMLInputElement).checked)}
                    />
                    <span class="system-settings-switch-copy">
                      <span class="system-settings-switch-label">
                        {t('settings.autostartLabel')}
                      </span>
                      <span class="system-settings-inline-hint">
                        {t('settings.autostartHint')}
                      </span>
                    </span>
                  </label>

                  {hideTaskbarIconSupported && (
                    <label class="system-settings-radio-label system-settings-switch-row">
                      <input
                        type="checkbox"
                        checked={hideTaskbarIcon}
                        onChange={(e) => setHideTaskbarIcon((e.target as HTMLInputElement).checked)}
                      />
                      <span class="system-settings-switch-copy">
                        <span class="system-settings-switch-label">{t('settings.hideTaskbarIconLabel')}</span>
                        <span class="system-settings-inline-hint">{t('settings.hideTaskbarIconHint')}</span>
                      </span>
                    </label>
                  )}

                  <div class="system-settings-subtitle">
                    {t('settings.shortcutTitle')}
                  </div>
                  <div class="system-settings-box-desc system-settings-box-desc-tight">
                    {t('settings.shortcutDesc')}
                  </div>
                  <ShortcutRecorder value={toggleShortcut} onChange={setToggleShortcut} />
                </div>

                <div class="system-settings-card-box">
                  <div class="system-settings-box-title">
                    {t('settings.closeActionLabel') || '关闭主窗口时'}
                  </div>
                  <div class="system-settings-box-desc">
                    {t('settings.closeActionDesc') || '配置点击窗口右上角关闭按钮 (X) 时的默认动作'}
                  </div>

                  <div class="system-settings-radio-group">
                    <label class="system-settings-radio-label">
                      <input
                        type="radio"
                        name="close_action"
                        value="tray"
                        checked={closeAction === 'tray'}
                        onChange={() => setCloseAction('tray')}
                      />
                      <span>{t('settings.closeActionTray') || '最小化到系统托盘并在后台运行'}</span>
                    </label>

                    <label class="system-settings-radio-label">
                      <input
                        type="radio"
                        name="close_action"
                        value="quit"
                        checked={closeAction === 'quit'}
                        onChange={() => setCloseAction('quit')}
                      />
                      <span>{t('settings.closeActionQuit') || '直接退出程序并停止服务'}</span>
                    </label>

                    <label class="system-settings-radio-label">
                      <input
                        type="radio"
                        name="close_action"
                        value="ask"
                        checked={closeAction === 'ask'}
                        onChange={() => setCloseAction('ask')}
                      />
                      <span>{t('settings.closeActionAsk') || '每次询问我'}</span>
                    </label>
                  </div>
                </div>

                <div
                  ref={agentModeBoxRef}
                  class={
                    'system-settings-card-box' +
                    (focusSection === 'agent_mode' ? ' system-settings-box-highlight' : '')
                  }
                >
                  <div class="system-settings-box-title">
                    {t('settings.agentModeTitle')}
                  </div>
                  <div class="system-settings-box-desc">
                    {t('settings.agentModeDesc')}
                  </div>

                  <div class="system-settings-radio-group">
                    <label
                      class="system-settings-radio-label"
                      title={t('settings.agentModeMemoryTooltip')}
                    >
                      <input
                        type="radio"
                        name="agent_mode_policy"
                        value="memory"
                        checked={agentModePolicy === 'memory'}
                        onChange={() => setAgentModePolicy('memory')}
                      />
                      <span>{t('settings.agentModeMemory')}</span>
                    </label>

                    <label
                      class="system-settings-radio-label system-settings-agent-global-row"
                      title={t('settings.agentModeGlobalTooltip')}
                    >
                      <input
                        type="radio"
                        name="agent_mode_policy"
                        value="global"
                        checked={agentModePolicy === 'global'}
                        onChange={() => setAgentModePolicy('global')}
                      />
                      <span>{t('settings.agentModeGlobal')}</span>
                      <select
                        class="system-settings-mode-select"
                        aria-label={t('settings.agentModeGlobalSelectAria')}
                        title={t('settings.agentModeGlobalTooltip')}
                        value={agentGlobalMode}
                        onMouseDown={(e) => {
                          setAgentModePolicy('global');
                          e.stopPropagation();
                        }}
                        onChange={(e) => {
                          setAgentModePolicy('global');
                          setAgentGlobalMode((e.target as HTMLSelectElement).value as ApprovalMode);
                        }}
                      >
                        <option value="build">{t('mode.build')}</option>
                        <option value="plan">{t('mode.plan')}</option>
                        <option value="accept_edits">{t('mode.accept_edits')}</option>
                        <option value="bypass">{t('mode.auto')}</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div class="system-settings-card-box">
                  <div class="system-settings-box-title">
                    {t('settings.runtimeModelSwitchTitle')}
                  </div>
                  <div class="system-settings-box-desc">
                    {t('settings.runtimeModelSwitchDesc')}
                  </div>
                  <label class="system-settings-radio-label system-settings-switch-row">
                    <input
                      type="checkbox"
                      checked={runtimeModelSwitch}
                      onChange={(e) => setRuntimeModelSwitch((e.target as HTMLInputElement).checked)}
                    />
                    <span class="system-settings-switch-copy">
                      <span class="system-settings-switch-label">
                        {t('settings.runtimeModelSwitchLabel')}
                      </span>
                      <span class="system-settings-inline-hint">
                        {t('settings.runtimeModelSwitchHint')}
                      </span>
                    </span>
                  </label>
                </div>

                <div class="system-settings-card-box">
                  <div class="system-settings-box-title">
                    {t('settings.shortcutBehaviorTitle') || '快捷键行为'}
                  </div>
                  <div class="system-settings-box-desc">
                    {t('settings.escUndoDesc') || '开启后，ESC 可取消待发卡片、停止并回填上一条消息，或退出编辑状态。'}
                  </div>
                  <label class="system-settings-radio-label">
                    <input
                      type="checkbox"
                      checked={escUndoEnabled}
                      onChange={(e) =>
                        setEscUndoEnabled((e.target as HTMLInputElement).checked)
                      }
                    />
                    <span>{t('settings.escUndoLabel') || 'ESC 撤销上一条消息'}</span>
                  </label>
                  <div class="system-settings-esc-hint">
                    {t('settings.escUndoImmediate') || '修改后立即生效'}
                  </div>
                </div>

                <div class="system-settings-actions-row">
                  <button
                    type="button"
                    class="btn btn-primary system-settings-save-btn"
                    disabled={loading || saving}
                    onClick={handleSaveDesktopSettings}
                  >
                    {saving
                      ? (t('settings.saving') || '正在保存…')
                      : (t('settings.save') || '保存设置')}
                  </button>
                  {savedSuccess && (
                    <span class="system-settings-saved-hint">
                      ✓ {t('settings.savedSuccess') || '设置已保存'}
                    </span>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'about' && (
              <div class="system-settings-pane">
                <h4 class="system-settings-pane-title">
                  {t('settings.aboutTitle')}
                </h4>
                <div class="system-settings-card-box about-box">
                  <div class="about-hero-row">
                    <strong class="about-app-title">JeikCode</strong>
                    {appVersion && (
                      <span class="about-version-badge">v{appVersion}</span>
                    )}
                  </div>
                  <div class="about-desc">
                    {t('settings.aboutDesc')}
                  </div>
                  <div class="about-features">
                    {t('settings.aboutFeatures')}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
