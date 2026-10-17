import { useState, useEffect } from 'preact/hooks';
import { ProjectInfo, saveGitBinding, getGitBinding, testGitBinding } from '../api';
import { useT, useSettings } from '../settings';
import { Select, SelectOption } from './Select';
import { ModelSelector } from './ModelSelector';

/** 支持的 Git 托管平台渠道类型 */
export type GitPlatformChannel = 'github' | 'gitlab' | 'gitee' | 'gitea' | 'custom_git';

/** 支持的工作同步模式 */
export type GitSyncMode = 'webhook' | 'polling';

/** 单个渠道的元数据定义 */
export interface GitChannelMeta {
  id: GitPlatformChannel;
  nameKey: string;
  descKey: string;
  badge?: string;
  defaultApiBase?: string;
  supportsSelfHosted: boolean;
  tokenName: string;
  tokenPlaceholder: string;
  tokenHintKey: string;
  repoLabelKey: string;
  repoPlaceholder: string;
  repoHintKey: string;
}

export const GIT_CHANNELS: GitChannelMeta[] = [
  {
    id: 'github',
    nameKey: 'gitWebhook.chGithub',
    descKey: 'gitWebhook.chGithubDesc',
    supportsSelfHosted: false,
    tokenName: 'GitHub Personal Access Token (PAT)',
    tokenPlaceholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGithub',
    repoLabelKey: 'gitWebhook.repoLabelGithub',
    repoPlaceholder: 'owner/repo (例如: jeikl/JeikCode)',
    repoHintKey: 'gitWebhook.repoHintGithub',
  },
  {
    id: 'gitlab',
    nameKey: 'gitWebhook.chGitlab',
    descKey: 'gitWebhook.chGitlabDesc',
    badge: 'Self-hosted & Cloud',
    supportsSelfHosted: true,
    defaultApiBase: 'https://gitlab.com/api/v4',
    tokenName: 'GitLab Personal Access Token',
    tokenPlaceholder: 'glpat-xxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGitlab',
    repoLabelKey: 'gitWebhook.repoLabelGitlab',
    repoPlaceholder: 'group/subgroup/project (例如: my-team/backend-svc)',
    repoHintKey: 'gitWebhook.repoHintGitlab',
  },
  {
    id: 'gitee',
    nameKey: 'gitWebhook.chGitee',
    descKey: 'gitWebhook.chGiteeDesc',
    supportsSelfHosted: false,
    tokenName: 'Gitee 私人令牌 (Private Token)',
    tokenPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGitee',
    repoLabelKey: 'gitWebhook.repoLabelGitee',
    repoPlaceholder: 'owner/repo (例如: myorg/myrepo)',
    repoHintKey: 'gitWebhook.repoHintGitee',
  },
  {
    id: 'gitea',
    nameKey: 'gitWebhook.chGitea',
    descKey: 'gitWebhook.chGiteaDesc',
    badge: 'Self-hosted',
    supportsSelfHosted: true,
    defaultApiBase: 'https://gitea.example.com/api/v1',
    tokenName: 'Gitea Access Token',
    tokenPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGitea',
    repoLabelKey: 'gitWebhook.repoLabelGitea',
    repoPlaceholder: 'owner/repo (例如: org/repo)',
    repoHintKey: 'gitWebhook.repoHintGitea',
  },
  {
    id: 'custom_git',
    nameKey: 'gitWebhook.chCustom',
    descKey: 'gitWebhook.chCustomDesc',
    badge: 'Generic / CLI',
    supportsSelfHosted: true,
    tokenName: 'Git HTTP/SSH Auth Token / Key',
    tokenPlaceholder: 'Token / Password / Key',
    tokenHintKey: 'gitWebhook.patHintCustom',
    repoLabelKey: 'gitWebhook.repoLabelCustom',
    repoPlaceholder: 'https://git.internal.corp/repo.git',
    repoHintKey: 'gitWebhook.repoHintCustom',
  },
];

/** Webhook 模式配置 */
export interface WebhookConfig {
  payloadUrl: string;
  secret: string;
}

/** 轮询模式配置 */
export interface PollingConfig {
  intervalSeconds: number;
  onlyActivePr: boolean;
}

/** 统一的 Git 平台适配器配置结构 */
export interface GitAdapterConfig {
  channel: GitPlatformChannel;
  syncMode: GitSyncMode;
  repoIdentifier: string;
  accessToken: string;
  customApiBase: string;
  webhook: WebhookConfig;
  polling: PollingConfig;
  events: {
    pullRequest: boolean;
    issueComment: boolean;
    push: boolean;
  };
  triggerKeyword: string;
  autoReviewNewPr: boolean;
  updateExistingComment: boolean;
  reviewPromptTemplate: string;
  lang?: string;
  reviewModel?: string;
}

const DEFAULT_REVIEW_PROMPT_ZH = `你是一名专业且严谨的高级代码审查专家（JeikCode Code Reviewer）。
你将收到来自本项目的 Pull Request / Merge Request / Issue，并结合目标分支的最新代码进行深度审查。

【审查原则与核心关注点】
1. 代码与版本对齐：拉取 PR、Issue 对应仓库分支最新远程提交及 PR 最新提交到本地。基于最新版本代码与 PR/Issue 基于的仓库版本进行严谨比对审查。对于 PR 请认真审查修复方案的合理性，排查是否存在死代码、硬编码、补丁式修补等违背当前系统设计原则和 BUG 修复原则的问题。
2. 现有方案与修复状态核验：比对并核实该问题或解决方案是否已在目标分支最新方案中得到完全修复与解决（例如是否已采纳了更高级的架构模式、策略抽象或同类解法）。清晰罗列出：所有已修复的问题、对应版本号、提交哈希（Commit Hash），以及当前依旧未修复遗留的问题。
3. PR 审查与合并建议：理性评估给出是否建议合并、是否有必须修改的地方、是否有与当前仓库架构冲突之处。保持客观公正（切勿钻牛角尖硬找错；设计合理即予肯定，存在缺陷则明确指出改进方向），并按修改意见严重程度给出 P 级排序（P0 阻塞 / P1 严重 / P2 一般 / P3 建议）与改进建议。若建议合并，请清晰总结该修复方案的架构特点，并阐明建议合并的充分理由。
4. Issue 答疑与进度指引：针对 Issue，根据上述核验结论诚恳解答用户疑问，提供基于最新代码库的分析；明确说明哪些修复已经在开发主干/测试分支中推进但尚未发布，预计将在测试版还是正式版推出；对于真实存在的新缺陷，给出专业判断、复现分析与最小可行修复建议。
5. 机器人操作指令响应（如 @机器人 合并 / merge / 解决冲突并合并）：
   - 当收到合并或解决冲突指令时，核验是否存在代码冲突与破坏性缺陷；若无冲突且符合合并标准，阐述合流建议与执行摘要；若存在冲突，定位具体冲突文件并提供最小可行解决方案。`;

const DEFAULT_REVIEW_PROMPT_EN = `You are a senior, rigorous code review expert (JeikCode Code Reviewer).
You will receive Pull Requests / Merge Requests / Issues from this project, conducting in-depth reviews in conjunction with the latest codebase of the target branch.

[Review Principles & Core Focus]
1. Code & Baseline Alignment: Pull the latest commits from the target remote branch and the PR branch locally. Review against both the latest branch state and the base revision the PR/Issue was branched from. For PRs, thoroughly evaluate fix reasonableness, identifying dead code, brittle hardcoding, or superficial patches that violate architectural design and bug-fixing principles.
2. Verification Against Existing Solutions: Verify whether the issue or proposed solution is already fully addressed in the latest codebase (e.g., via higher-level design patterns or alternative architectural fixes). Itemize: all resolved issues, corresponding version tags, commit hashes, and any remaining unaddressed defects.
3. PR Evaluation & Merge Recommendation: Objectively evaluate whether to recommend merging, required revisions, and potential architectural conflicts. Remain constructive and fair (do not nitpick unnecessarily; acknowledge sound designs and give actionable guidance for defects). Sort review feedback by priority (P0 Blocker / P1 Critical / P2 Normal / P3 Suggestion). If recommending merge, summarize the architectural highlights and provide concrete merge justification.
4. Issue Inquiry & Release Tracking: For Issues, provide sincere, well-reasoned answers grounded in the current codebase based on the verification above. Clarify which fixes are in progress or in active branches awaiting release, and specify upcoming delivery targets (beta vs. stable release). For confirmed defects, provide impact analysis and concrete fix guidance.
5. Bot Command Handling (e.g. @bot merge / resolve conflicts and merge):
   - When receiving merge or conflict resolution commands, verify potential branch conflicts and breaking regressions; if clean, summarize merge execution advice; if conflicting, pinpoint conflicting hunks and provide minimal viable resolution.`;

function generateRandomSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'whsec_';
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function getProjectGitConfig(projectHash: string, lang?: string): GitAdapterConfig {
  const defaultUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/webhooks/git`
    : 'http://localhost:3000/api/webhooks/git';

  const defaultPrompt = lang === 'zh' ? DEFAULT_REVIEW_PROMPT_ZH : DEFAULT_REVIEW_PROMPT_EN;

  const defaultConfig: GitAdapterConfig = {
    channel: 'github',
    syncMode: 'webhook',
    repoIdentifier: '',
    accessToken: '',
    customApiBase: '',
    webhook: {
      payloadUrl: defaultUrl,
      secret: generateRandomSecret(),
    },
    polling: {
      intervalSeconds: 60,
      onlyActivePr: true,
    },
    events: {
      pullRequest: true,
      issueComment: true,
      push: false,
    },
    triggerKeyword: '@bot',
    autoReviewNewPr: true,
    updateExistingComment: true,
    reviewPromptTemplate: defaultPrompt,
    reviewModel: '',
  };

  try {
    const raw = localStorage.getItem(`jeikcode_git_binding_${projectHash}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 向后平滑兼容原有单一 GitHub 格式
      const repoId = parsed.repoIdentifier || parsed.repoFullName || '';
      const pat = parsed.accessToken || parsed.githubPat || '';
      const secret = parsed.webhook?.secret || parsed.secret || generateRandomSecret();
      const payloadUrl = parsed.webhook?.payloadUrl || parsed.webhookUrl || defaultUrl;

      return {
        ...defaultConfig,
        ...parsed,
        repoIdentifier: repoId,
        accessToken: pat,
        reviewModel: parsed.reviewModel || parsed.review_model || '',
        webhook: {
          payloadUrl,
          secret,
        },
        polling: {
          ...defaultConfig.polling,
          ...(parsed.polling || {}),
        },
        events: {
          ...defaultConfig.events,
          ...(parsed.events || {}),
        },
      };
    }
  } catch {
    // ignore
  }

  return defaultConfig;
}

export function saveProjectGitConfig(projectHash: string, config: GitAdapterConfig): void {
  try {
    localStorage.setItem(`jeikcode_git_binding_${projectHash}`, JSON.stringify(config));
  } catch {
    // ignore
  }
  // 异步同步到后端持久化文件 (~/.jeikcode/git-bindings.json)
  saveGitBinding({ ...config, project_hash: projectHash }).catch(() => {});
}

interface GitWebhookDialogProps {
  project: ProjectInfo;
  onClose: () => void;
  onSaved?: (config: GitAdapterConfig) => void;
}

export function GitWebhookDialog({ project, onClose, onSaved }: GitWebhookDialogProps) {
  const t = useT();
  const { lang } = useSettings();
  const [config, setConfig] = useState<GitAdapterConfig>(() => getProjectGitConfig(project.hash, lang));
  const [showToken, setShowToken] = useState(false);
  const [copyStatus, setCopyStatus] = useState<Record<string, string>>({});
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const activeChannelMeta = GIT_CHANNELS.find((c) => c.id === config.channel) || GIT_CHANNELS[0];

  useEffect(() => {
    // 从后端拉取最新持久化配置（支持跨浏览器/清除缓存后恢复）
    getGitBinding(project.hash).then((remote) => {
      if (remote && remote.channel) {
        setConfig((prev) => ({
          ...prev,
          ...remote,
          events: {
            ...prev.events,
            ...(remote.events || {}),
          },
        }));
      }
    }).catch(() => {});
  }, [project.hash]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const copyToClipboard = (text: string, fieldKey: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopyStatus((prev) => ({ ...prev, [fieldKey]: t('gitWebhook.copied') }));
      setTimeout(() => {
        setCopyStatus((prev) => ({ ...prev, [fieldKey]: '' }));
      }, 2000);
    });
  };

  const handleSave = () => {
    const configToSave = { ...config, lang };
    saveProjectGitConfig(project.hash, configToSave);
    showToast(t('gitWebhook.saveSuccess'));
    if (onSaved) onSaved(configToSave);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  const handleRegenerateSecret = () => {
    const newSecret = generateRandomSecret();
    setConfig((prev) => ({
      ...prev,
      webhook: { ...prev.webhook, secret: newSecret },
    }));
  };

  const handleResetPrompt = () => {
    const defaultPrompt = lang === 'zh' ? DEFAULT_REVIEW_PROMPT_ZH : DEFAULT_REVIEW_PROMPT_EN;
    setConfig((prev) => ({ ...prev, reviewPromptTemplate: defaultPrompt }));
  };

  const [testing, setTesting] = useState(false);

  const handleTestOrTrigger = async () => {
    if (!config.repoIdentifier.trim()) {
      showToast(t('gitWebhook.repoPlaceholder') || 'Please specify repository');
      return;
    }
    setTesting(true);
    try {
      const res = await testGitBinding(config);
      if (res.success) {
        showToast(
          res.message ||
            (config.syncMode === 'webhook'
              ? t('gitWebhook.testSuccess')
              : t('gitWebhook.pollingSimSuccess'))
        );
      } else {
        showToast(res.error || 'Connection failed');
      }
    } catch (e: any) {
      showToast(e.message || 'Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  // 下拉框 1：托管平台渠道选项（展示加粗名称、徽章、协议说明和格式示例）
  const channelOptions: SelectOption<GitPlatformChannel>[] = GIT_CHANNELS.map((ch) => ({
    value: ch.id,
    selectedLabel: (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <strong style={{ color: 'var(--app-primary-foreground)' }}>{t(ch.nameKey as any) || ch.id}</strong>
        {ch.badge && <span class="git-channel-badge">{ch.badge}</span>}
      </div>
    ),
    label: (
      <div class="git-select-rich-option">
        <div class="git-select-rich-top">
          <span class="git-select-rich-title">{t(ch.nameKey as any) || ch.id}</span>
          {ch.badge && <span class="git-channel-badge">{ch.badge}</span>}
        </div>
        <span class="git-select-rich-desc">{t(ch.descKey as any)}</span>
        <span class="git-select-rich-sample">{ch.repoPlaceholder}</span>
      </div>
    ),
  }));

  // 下拉框 2：同步触发模式选项（详细展示各自的工作原理与适用场景）
  const modeOptions: SelectOption<GitSyncMode>[] = [
    {
      value: 'webhook',
      selectedLabel: (
        <strong style={{ color: 'var(--app-primary-foreground)' }}>{t('gitWebhook.modeWebhook')}</strong>
      ),
      label: (
        <div class="git-select-rich-option">
          <div class="git-select-rich-top">
            <span class="git-select-rich-title">{t('gitWebhook.modeWebhook')}</span>
          </div>
          <span class="git-select-rich-desc">{t('gitWebhook.modeWebhookDesc')}</span>
        </div>
      ),
    },
    {
      value: 'polling',
      selectedLabel: (
        <strong style={{ color: 'var(--app-primary-foreground)' }}>{t('gitWebhook.modePolling')}</strong>
      ),
      label: (
        <div class="git-select-rich-option">
          <div class="git-select-rich-top">
            <span class="git-select-rich-title">{t('gitWebhook.modePolling')}</span>
          </div>
          <span class="git-select-rich-desc">{t('gitWebhook.modePollingDesc')}</span>
        </div>
      ),
    },
  ];

  return (
    <div class="modal-overlay git-webhook-modal-overlay" onClick={onClose}>
      <div
        class="modal-card modal-card-lg git-webhook-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="git-adapter-title"
      >
        {/* 顶部标题栏 */}
        <div class="modal-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ flexShrink: 0, color: 'var(--app-primary-foreground)' }}>
            <line x1="6" y1="3" x2="6" y2="15"></line>
            <circle cx="18" cy="6" r="3"></circle>
            <circle cx="6" cy="18" r="3"></circle>
            <path d="M18 9a9 9 0 0 1-9 9"></path>
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <h3 id="git-adapter-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>{t('gitWebhook.adapterTitle')}</span>
              <span class="git-badge-tag">{t('gitWebhook.tag')}</span>
            </h3>
            <span class="modal-sub">{t('gitWebhook.adapterSub')}</span>
          </div>
          <button type="button" class="modal-close" onClick={onClose} aria-label={t('common.dismiss')}>
            ✕
          </button>
        </div>

        {/* 弹窗内容主体 */}
        <div class="modal-body git-webhook-body" style={{ maxHeight: '74vh', overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          
          {/* 项目元信息卡片 */}
          <div class="git-project-info-banner">
            <div class="git-banner-row">
              <span class="git-banner-label">{t('gitWebhook.project')}</span>
              <strong class="git-banner-val">{project.name || 'Current'}</strong>
            </div>
            <div class="git-banner-row">
              <span class="git-banner-label">{t('gitWebhook.rootPath')}</span>
              <span class="git-banner-path" title={project.working_dir}>{project.working_dir}</span>
            </div>
          </div>

          {/* 适配器核心配置区：双下拉框（渠道选择 + 模式选择） */}
          <div class="git-form-section">
            <div class="git-section-title">
              <span>1. 适配器策略配置 (渠道与工作模式)</span>
            </div>
            
            <div class="git-form-grid">
              {/* 下拉框 1：托管平台渠道 */}
              <div class="git-form-item">
                <label class="git-form-label">{t('gitWebhook.channelSection')}</label>
                <Select<GitPlatformChannel>
                  class="git-adapter-select"
                  value={config.channel}
                  options={channelOptions}
                  onChange={(ch) => setConfig({ ...config, channel: ch })}
                />
                <span class="git-input-hint">
                  {t(activeChannelMeta.descKey as any)}
                </span>
              </div>

              {/* 下拉框 2：同步触发模式 */}
              <div class="git-form-item">
                <label class="git-form-label">{t('gitWebhook.modeSection')}</label>
                <Select<GitSyncMode>
                  class="git-adapter-select"
                  value={config.syncMode}
                  options={modeOptions}
                  onChange={(mode) => setConfig({ ...config, syncMode: mode })}
                />
                <span class="git-input-hint">
                  {config.syncMode === 'webhook' ? t('gitWebhook.modeWebhookDesc') : t('gitWebhook.modePollingDesc')}
                </span>
              </div>
            </div>

            {/* 如果所选渠道支持自建/私有化部署，展示自定义 Base URL 输入框 */}
            {activeChannelMeta.supportsSelfHosted && (
              <div class="git-form-item" style={{ marginTop: '10px' }}>
                <label class="git-form-label">{t('gitWebhook.customApiBaseLabel')}</label>
                <input
                  type="text"
                  class="git-input"
                  placeholder={activeChannelMeta.defaultApiBase || t('gitWebhook.customApiBasePlaceholder')}
                  value={config.customApiBase}
                  onInput={(e) => setConfig({ ...config, customApiBase: (e.target as HTMLInputElement).value.trim() })}
                />
                <span class="git-input-hint">{t('gitWebhook.customApiBaseHint')}</span>
              </div>
            )}
          </div>

          {/* 适配器第 2 区：模式专属接入参数 (Webhook 或 轮询) */}
          <div class="git-form-section">
            <div class="git-section-title">
              <span>2. {config.syncMode === 'webhook' ? 'Webhook 回调对接参数' : '轮询检测策略参数'}</span>
            </div>

            {config.syncMode === 'webhook' ? (
              <div class="git-form-grid">
                <div class="git-form-item">
                  <label class="git-form-label">{t('gitWebhook.payloadUrlLabel')}</label>
                  <div class="git-input-with-actions">
                    <input
                      type="text"
                      class="git-input git-readonly-input"
                      value={config.webhook.payloadUrl}
                      readOnly
                    />
                    <button
                      type="button"
                      class="git-aux-btn"
                      onClick={() => copyToClipboard(config.webhook.payloadUrl, 'url')}
                    >
                      {copyStatus['url'] || t('gitWebhook.copy')}
                    </button>
                  </div>
                  <span class="git-input-hint">{t('gitWebhook.payloadUrlHint')}</span>
                </div>

                <div class="git-form-item">
                  <label class="git-form-label">{t('gitWebhook.secretLabel')}</label>
                  <div class="git-input-with-actions">
                    <input
                      type="text"
                      class="git-input"
                      value={config.webhook.secret}
                      onInput={(e) =>
                        setConfig({
                          ...config,
                          webhook: { ...config.webhook, secret: (e.target as HTMLInputElement).value.trim() },
                        })
                      }
                    />
                    <button
                      type="button"
                      class="git-aux-btn"
                      onClick={handleRegenerateSecret}
                      title="Generate Random Secret"
                    >
                      {t('gitWebhook.random')}
                    </button>
                    <button
                      type="button"
                      class="git-aux-btn"
                      onClick={() => copyToClipboard(config.webhook.secret, 'secret')}
                    >
                      {copyStatus['secret'] || t('gitWebhook.copy')}
                    </button>
                  </div>
                  <span class="git-input-hint">{t('gitWebhook.secretHint')}</span>
                </div>
              </div>
            ) : (
              <div class="git-form-grid">
                <div class="git-form-item">
                  <label class="git-form-label">{t('gitWebhook.pollingIntervalLabel')}</label>
                  <input
                    type="number"
                    min="10"
                    max="3600"
                    class="git-input"
                    value={config.polling.intervalSeconds}
                    onInput={(e) =>
                      setConfig({
                        ...config,
                        polling: {
                          ...config.polling,
                          intervalSeconds: parseInt((e.target as HTMLInputElement).value, 10) || 60,
                        },
                      })
                    }
                  />
                  <span class="git-input-hint">{t('gitWebhook.pollingIntervalHint')}</span>
                </div>

                <div class="git-form-item" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <label class="git-switch-inline-label">
                    <input
                      type="checkbox"
                      checked={config.polling.onlyActivePr}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          polling: {
                            ...config.polling,
                            onlyActivePr: (e.target as HTMLInputElement).checked,
                          },
                        })
                      }
                    />
                    <span>{t('gitWebhook.pollingOnlyActive')}</span>
                  </label>
                  <span class="git-input-hint" style={{ marginTop: '4px' }}>
                    避免扫描已合并或已关闭的历史记录，显著降低远端 API 消耗
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* 适配器第 3 区：动态绑定的仓库标识与平台认证凭据 */}
          <div class="git-form-section">
            <div class="git-section-title">
              <span>3. 仓库标识与访问认证（由选定渠道动态驱动）</span>
            </div>
            <div class="git-form-grid">
              {/* 动态 Label、Placeholder 与 Hint */}
              <div class="git-form-item">
                <label class="git-form-label">
                  {t(activeChannelMeta.repoLabelKey as any)} <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  class="git-input"
                  placeholder={activeChannelMeta.repoPlaceholder}
                  value={config.repoIdentifier}
                  onInput={(e) => setConfig({ ...config, repoIdentifier: (e.target as HTMLInputElement).value.trim() })}
                />
                <span class="git-input-hint">{t(activeChannelMeta.repoHintKey as any)}</span>
              </div>

              {/* 动态 Token Name、Placeholder 与 Hint */}
              <div class="git-form-item">
                <label class="git-form-label">
                  {activeChannelMeta.tokenName} <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <div class="git-input-with-actions">
                  <input
                    type={showToken ? 'text' : 'password'}
                    class="git-input"
                    placeholder={activeChannelMeta.tokenPlaceholder}
                    value={config.accessToken}
                    onInput={(e) => setConfig({ ...config, accessToken: (e.target as HTMLInputElement).value.trim() })}
                  />
                  <button
                    type="button"
                    class="git-aux-btn"
                    onClick={() => setShowToken(!showToken)}
                    title={showToken ? 'Hide' : 'Show'}
                  >
                    {showToken ? '🙈' : '👁️'}
                  </button>
                </div>
                <span class="git-input-hint">{t(activeChannelMeta.tokenHintKey as any)}</span>
              </div>
            </div>
          </div>

          {/* 适配器第 4 区：订阅事件与唤醒规则 */}
          <div class="git-form-section">
            <div class="git-section-title">
              <span>4. {t('gitWebhook.sec3Title')}</span>
            </div>
            
            <div class="git-checkbox-group">
              <label class="git-checkbox-label">
                <input
                  type="checkbox"
                  checked={config.events.pullRequest}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      events: { ...config.events, pullRequest: (e.target as HTMLInputElement).checked },
                    })
                  }
                />
                <div class="git-checkbox-text">
                  <strong>{t('gitWebhook.evPrTitle')}</strong>
                  <span>{t('gitWebhook.evPrDesc')}</span>
                </div>
              </label>

              <label class="git-checkbox-label">
                <input
                  type="checkbox"
                  checked={config.events.issueComment}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      events: { ...config.events, issueComment: (e.target as HTMLInputElement).checked },
                    })
                  }
                />
                <div class="git-checkbox-text">
                  <strong>{t('gitWebhook.evCommentTitle')}</strong>
                  <span>{t('gitWebhook.evCommentDesc')}</span>
                </div>
              </label>

              <label class="git-checkbox-label">
                <input
                  type="checkbox"
                  checked={config.events.push}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      events: { ...config.events, push: (e.target as HTMLInputElement).checked },
                    })
                  }
                />
                <div class="git-checkbox-text">
                  <strong>{t('gitWebhook.evPushTitle')}</strong>
                  <span>{t('gitWebhook.evPushDesc')}</span>
                </div>
              </label>
            </div>

            {/* 审查模型与唤醒触发控制栏：单行水平并排 (模型 ➔ 思考强度 ➔ 唤醒词胶囊) */}
            <div class="git-model-trigger-panel" style={{ marginTop: '12px' }}>
              <div class="git-model-trigger-header">
                <span class="git-form-label">{t('gitWebhook.modelAndKeywordTitle')}</span>
              </div>
              
              <div class="git-model-trigger-row">
                <div class="git-model-selector-wrapper">
                  <ModelSelector
                    value={config.reviewModel || null}
                    onChange={(p) => setConfig({ ...config, reviewModel: p })}
                    direction="down"
                  />
                </div>

                <div class="git-inline-keyword-capsule">
                  <span class="git-inline-keyword-label">{t('gitWebhook.keywordInlineLabel')}:</span>
                  <input
                    type="text"
                    class="git-inline-keyword-input"
                    placeholder="@bot"
                    value={config.triggerKeyword}
                    onInput={(e) => setConfig({ ...config, triggerKeyword: (e.target as HTMLInputElement).value.trim() })}
                  />
                </div>
              </div>

              <span class="git-input-hint" style={{ marginTop: '2px', display: 'block' }}>
                {t('gitWebhook.reviewModelHint')} · {t('gitWebhook.keywordHint')}
              </span>
            </div>

            <div class="git-form-grid" style={{ marginTop: '12px' }}>
              <div class="git-form-item" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '10px' }}>
                <div>
                  <label class="git-switch-inline-label">
                    <input
                      type="checkbox"
                      checked={config.autoReviewNewPr}
                      onChange={(e) => setConfig({ ...config, autoReviewNewPr: (e.target as HTMLInputElement).checked })}
                    />
                    <span>{t('gitWebhook.autoReviewLabel')}</span>
                  </label>
                  <span class="git-input-hint" style={{ display: 'block', marginTop: '3px' }}>
                    {t('gitWebhook.autoReviewHint')}
                  </span>
                </div>

                <div>
                  <label class="git-switch-inline-label">
                    <input
                      type="checkbox"
                      checked={config.updateExistingComment}
                      onChange={(e) => setConfig({ ...config, updateExistingComment: (e.target as HTMLInputElement).checked })}
                    />
                    <span>{t('gitWebhook.updateExistingCommentLabel')}</span>
                  </label>
                  <span class="git-input-hint" style={{ display: 'block', marginTop: '3px' }}>
                    {t('gitWebhook.updateExistingCommentHint')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 适配器第 5 区：项目专属审查提示词模板 (大编辑框) */}
          <div class="git-form-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div class="git-section-title" style={{ margin: 0 }}>
                <span>5. {t('gitWebhook.sec4Title')}</span>
              </div>
              <button
                type="button"
                class="git-text-action-btn"
                onClick={handleResetPrompt}
                title="Reset to default template"
              >
                {t('gitWebhook.resetPrompt')}
              </button>
            </div>
            
            <textarea
              class="git-textarea"
              rows={10}
              placeholder={t('gitWebhook.promptPlaceholder')}
              value={config.reviewPromptTemplate}
              onInput={(e) => setConfig({ ...config, reviewPromptTemplate: (e.target as HTMLTextAreaElement).value })}
            />
            <span class="git-input-hint">
              {t('gitWebhook.promptHint')}
            </span>
          </div>

        </div>

        {/* 弹窗底部操作栏 */}
        <div class="modal-footer git-webhook-footer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--app-menu-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              class="git-test-btn"
              onClick={handleTestOrTrigger}
              disabled={testing}
            >
              {testing
                ? '...'
                : config.syncMode === 'webhook'
                ? t('gitWebhook.testBtn')
                : t('gitWebhook.pollingManualCheck')}
            </button>
            {toastMsg && <span class="git-footer-toast">{toastMsg}</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button type="button" class="git-cancel-btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" class="git-save-btn" onClick={handleSave}>
              {t('gitWebhook.saveBtn')}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
