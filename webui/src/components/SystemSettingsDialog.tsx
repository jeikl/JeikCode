import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getDesktopSettings, postDesktopSettings, getHealth, type DesktopSettings } from '../api';
import { bakedAppVersion, normalizeAppVersion } from '../lib/appVersion';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { useSettings } from '../settings';
import { ModelConfigView } from './SettingsDialogs';

interface SystemSettingsDialogProps {
  onClose: () => void;
  initialTab?: TabKey;
}

type TabKey = 'models' | 'desktop' | 'about';

interface ModuleTab {
  key: TabKey;
  labelKey: string;
  defaultLabel: string;
  icon: string;
}

export function SystemSettingsDialog({ onClose, initialTab }: SystemSettingsDialogProps) {
  const { t, escUndoEnabled, setEscUndoEnabled } = useSettings();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab || 'models');
  const [closeAction, setCloseAction] = useState<'ask' | 'tray' | 'quit'>('ask');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [appVersion, setAppVersion] = useState(bakedAppVersion());

  // 遮罩空白处点击关闭：避免弹窗内拖拽划词时被误判为外部点击而秒关。
  const backdropDismiss = useBackdropDismiss(onClose);

  const tabs: ModuleTab[] = [
    { key: 'models', labelKey: 'settings.tabModels', defaultLabel: '模型与配置', icon: '⚡' },
    { key: 'desktop', labelKey: 'settings.tabDesktop', defaultLabel: '行为与快捷键', icon: '⌨️' },
    { key: 'about', labelKey: 'settings.tabAbout', defaultLabel: '关于与版本', icon: 'ℹ️' },
  ];

  useEffect(() => {
    let cancelled = false;
    getDesktopSettings()
      .then((res) => {
        if (!cancelled && res.close_action) {
          setCloseAction(res.close_action);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((info) => {
        if (cancelled) return;
        const running = normalizeAppVersion(info.version);
        if (running) setAppVersion(running);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSaveDesktopSettings() {
    if (saving) return;
    setSaving(true);
    setSavedSuccess(false);
    try {
      await postDesktopSettings({ close_action: closeAction });
      setSavedSuccess(true);
      window.setTimeout(() => setSavedSuccess(false), 2000);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

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
                  {t('settings.tabDesktop') || '行为与快捷键'}
                </h4>

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
