import { useState, useEffect, useRef } from 'preact/hooks';
import { ProjectInfo, saveGitBinding, getGitBinding, getRemoteAccess, testGitBinding, generateGitHubAppToken } from '../api';
import { useT, useSettings } from '../settings';
import { messages, type Lang } from '../i18n';
import { Select, SelectOption } from './Select';
import { ModelSelector } from './ModelSelector';
import { getPageZoom } from '../lib/pageZoom';
import { useBackdropDismiss } from '../lib/backdropDismiss';

/** 支持的 Git 托管平台渠道类型 */
export type GitPlatformChannel = 'github' | 'gitlab' | 'gitee' | 'gitea' | 'custom_git';

/** 支持的工作同步模式 */
export type GitSyncMode = 'webhook' | 'polling';

/** 单个渠道的元数据定义 */
export interface GitChannelMeta {
  id: GitPlatformChannel;
  nameKey: string;
  descKey: string;
  statusType: 'active' | 'beta';
  statusBadgeKey: string;
  defaultApiBase?: string;
  supportsSelfHosted: boolean;
  tokenNameKey: string;
  tokenPlaceholder: string;
  tokenHintKey: string;
  repoLabelKey: string;
  repoSampleKey: string;
  repoHintKey: string;
}

export const GIT_CHANNELS: GitChannelMeta[] = [
  {
    id: 'github',
    nameKey: 'gitWebhook.chGithub',
    descKey: 'gitWebhook.chGithubDesc',
    statusType: 'active',
    statusBadgeKey: 'gitWebhook.badgeActive',
    supportsSelfHosted: false,
    tokenNameKey: 'gitWebhook.tokenGithub',
    tokenPlaceholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGithub',
    repoLabelKey: 'gitWebhook.repoLabelGithub',
    repoSampleKey: 'gitWebhook.sampleGithub',
    repoHintKey: 'gitWebhook.repoHintGithub',
  },
  {
    id: 'gitlab',
    nameKey: 'gitWebhook.chGitlab',
    descKey: 'gitWebhook.chGitlabDesc',
    statusType: 'beta',
    statusBadgeKey: 'gitWebhook.badgeBeta',
    supportsSelfHosted: true,
    defaultApiBase: 'https://gitlab.com/api/v4',
    tokenNameKey: 'gitWebhook.tokenGitlab',
    tokenPlaceholder: 'glpat-xxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGitlab',
    repoLabelKey: 'gitWebhook.repoLabelGitlab',
    repoSampleKey: 'gitWebhook.sampleGitlab',
    repoHintKey: 'gitWebhook.repoHintGitlab',
  },
  {
    id: 'gitee',
    nameKey: 'gitWebhook.chGitee',
    descKey: 'gitWebhook.chGiteeDesc',
    statusType: 'beta',
    statusBadgeKey: 'gitWebhook.badgeBeta',
    supportsSelfHosted: false,
    tokenNameKey: 'gitWebhook.tokenGitee',
    tokenPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGitee',
    repoLabelKey: 'gitWebhook.repoLabelGitee',
    repoSampleKey: 'gitWebhook.sampleGitee',
    repoHintKey: 'gitWebhook.repoHintGitee',
  },
  {
    id: 'gitea',
    nameKey: 'gitWebhook.chGitea',
    descKey: 'gitWebhook.chGiteaDesc',
    statusType: 'beta',
    statusBadgeKey: 'gitWebhook.badgeBeta',
    supportsSelfHosted: true,
    defaultApiBase: 'https://gitea.example.com/api/v1',
    tokenNameKey: 'gitWebhook.tokenGitea',
    tokenPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHintKey: 'gitWebhook.patHintGitea',
    repoLabelKey: 'gitWebhook.repoLabelGitea',
    repoSampleKey: 'gitWebhook.sampleGitea',
    repoHintKey: 'gitWebhook.repoHintGitea',
  },
  {
    id: 'custom_git',
    nameKey: 'gitWebhook.chCustom',
    descKey: 'gitWebhook.chCustomDesc',
    statusType: 'beta',
    statusBadgeKey: 'gitWebhook.badgeBeta',
    supportsSelfHosted: true,
    tokenNameKey: 'gitWebhook.tokenCustom',
    tokenPlaceholder: 'Token / Password / Key',
    tokenHintKey: 'gitWebhook.patHintCustom',
    repoLabelKey: 'gitWebhook.repoLabelCustom',
    repoSampleKey: 'gitWebhook.sampleCustom',
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
  enabled: boolean;
  lastEnabledState?: boolean;
  channel: GitPlatformChannel;
  syncMode: GitSyncMode;
  repoIdentifier: string;
  accessToken: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppPrivateKeyPath?: string;
  tokenExpiresAt?: number;
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

export function getDefaultReviewPrompt(lang?: string): string {
  if (lang && lang in messages && messages[lang as Lang]?.['gitWebhook.defaultReviewPrompt']) {
    return messages[lang as Lang]!['gitWebhook.defaultReviewPrompt'];
  }
  return messages.en['gitWebhook.defaultReviewPrompt'];
}

function generateRandomSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'whsec_';
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const GLOBAL_LAST_WEBHOOK_HOST_KEY = 'jeikcode:last_webhook_host';

/**
 * 规范化用户输入的 Webhook Host / Domain：
 * 1. 允许并欢迎输入冒号与斜杠（例如 https://junge.junv.top 或 http://127.0.0.1:13460）
 * 2. 自动将中文全角冒号（：）、全角斜杠（／）与中文输入法按 / 键常打出的顿号（、）智能转为半角标准符号，免去频繁切换输入法的烦恼
 * 3. 若用户误粘贴了完整的 /api/webhooks/git 或 /api/webhooks/github 后缀，自动予以剥离
 * 4. 严禁在用户正在输入时强行截断末尾斜杠，保证手动敲入 http:// 或 https:// 时绝对畅通无阻！
 */
export function normalizeWebhookHost(host: string): string {
  if (!host) return '';
  return host
    .replace(/：/g, ':')
    .replace(/[／、]/g, '/')
    .replace(/\/api\/webhooks\/(git|github)\/?$/i, '');
}

export function stripWebhookSuffix(url: string): string {
  return normalizeWebhookHost(url);
}

export function stripHostPortAndSuffix(url: string): string {
  let clean = normalizeWebhookHost(url);
  // 剥离末尾可能误输入的端口号（如 :13460 或 :13461），因为右侧蓝字徽章已固定绑定当前端口
  clean = clean.replace(/:\d+\/?$/i, '').replace(/\/+$/, '');
  return clean;
}

/**
 * 校验 Webhook Host / Domain 是否为有效输入（排除单纯残留的 https:、http: 协议残缺文本）
 */
export function isValidWebhookHost(host: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h === 'http:' || h === 'https:' || h === 'http:/' || h === 'https:/' || h === 'http://' || h === 'https://') {
    return false;
  }
  const withoutProto = h.replace(/^https?:\/\//i, '').trim();
  return Boolean(withoutProto);
}

/**
 * 获取全局记住的 Webhook 域名/主机（单实例跨项目继承，避免重复配置）
 */
export function getLastWebhookHost(): string {
  if (typeof window === 'undefined') return '';
  try {
    const saved = localStorage.getItem(GLOBAL_LAST_WEBHOOK_HOST_KEY);
    if (saved && isValidWebhookHost(saved)) {
      return saved;
    }
    // 自动扫描已有的其他项目配置，发现并自动提取已配置过的合法域名作为种子
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('jeikcode_git_binding_')) {
        const item = localStorage.getItem(key);
        if (item) {
          const parsed = JSON.parse(item);
          const url = parsed.webhook?.payloadUrl || parsed.webhookUrl || '';
          const clean = normalizeWebhookHost(url).replace(/\/+$/, '');
          if (clean && isValidWebhookHost(clean)) {
            localStorage.setItem(GLOBAL_LAST_WEBHOOK_HOST_KEY, clean);
            return clean;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * 记忆最新配置的 Webhook 域名/主机
 */
export function setLastWebhookHost(host: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = normalizeWebhookHost(host.trim()).replace(/\/+$/, '');
    if (clean && isValidWebhookHost(clean)) {
      localStorage.setItem(GLOBAL_LAST_WEBHOOK_HOST_KEY, clean);
    } else if (!clean || !isValidWebhookHost(clean)) {
      localStorage.removeItem(GLOBAL_LAST_WEBHOOK_HOST_KEY);
    }
  } catch {
    // ignore
  }
}

export function getFullWebhookUrl(hostOrUrl: string): string {
  const clean = normalizeWebhookHost(hostOrUrl.trim()).replace(/\/+$/, '');
  if (!clean) return '';
  return `${clean}/api/webhooks/git`;
}

export function getProjectGitConfig(projectHash: string, lang?: string): GitAdapterConfig {
  // 默认继承全局记住的 Webhook 域名，保持项目独立且可随时编辑
  const defaultUrl = getLastWebhookHost();

  const defaultPrompt = getDefaultReviewPrompt(lang);

  const defaultConfig: GitAdapterConfig = {
    enabled: false,
    lastEnabledState: false,
    channel: 'github',
    syncMode: 'webhook',
    repoIdentifier: '',
    accessToken: '',
    githubAppId: '',
    githubAppPrivateKey: '',
    githubAppPrivateKeyPath: '',
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
      // 向后平滑兼容原有单一 GitHub 格式，若之前存的是默认 localhost/127.0.0.1 则重置为空
      const repoId = parsed.repoIdentifier || parsed.repoFullName || '';
      const pat = parsed.accessToken || parsed.githubPat || '';
      const secret = parsed.webhook?.secret || parsed.secret || generateRandomSecret();
      let payloadUrl = parsed.webhook?.payloadUrl || parsed.webhookUrl || '';
      // 只要是有效输入（包含 127.0.0.1、localhost、反代公网域名），均完整保留
      if (!isValidWebhookHost(payloadUrl)) {
        payloadUrl = getLastWebhookHost();
      }

      const ch = parsed.channel || defaultConfig.channel;
      const isGithub = ch === 'github';
      // 核心安全防线：只有在 GitHub App 模式下才允许开启，PAT 模式强制禁用且无法开启
      const hasAppCreds = Boolean(
        parsed.githubAppId || parsed.github_app_id ||
        parsed.githubAppPrivateKey || parsed.github_app_private_key ||
        parsed.githubAppPrivateKeyPath || parsed.github_app_private_key_path
      );
      const isAppMode = isGithub && hasAppCreds;
      const isEnabled = isAppMode ? (parsed.enabled ?? false) : false;
      const lastEnabled = isAppMode ? (parsed.lastEnabledState ?? parsed.last_enabled_state ?? isEnabled) : false;

      return {
        ...defaultConfig,
        ...parsed,
        enabled: isEnabled,
        lastEnabledState: lastEnabled,
        repoIdentifier: repoId,
        accessToken: pat,
        githubAppId: parsed.githubAppId || parsed.github_app_id || '',
        githubAppPrivateKey: parsed.githubAppPrivateKey || parsed.github_app_private_key || '',
        githubAppPrivateKeyPath: parsed.githubAppPrivateKeyPath || parsed.github_app_private_key_path || '',
        tokenExpiresAt: parsed.tokenExpiresAt || parsed.token_expires_at || undefined,
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

/**
 * 构造一份干净的标准驼峰 API 载荷（彻底剔除任何残留的下划线字段，防止 Serde 因 duplicate field 抛出 HTTP 422 错误）
 */
export function toCleanApiPayload(config: GitAdapterConfig, projectHash: string): any {
  const cleanPayload = config.webhook?.payloadUrl
    ? normalizeWebhookHost(config.webhook.payloadUrl).replace(/\/+$/, '')
    : '';

  const isGithub = (config.channel || 'github') === 'github';
  const hasAppCreds = Boolean(
    config.githubAppId?.trim() || config.githubAppPrivateKey || config.githubAppPrivateKeyPath?.trim()
  );
  const isAppMode = isGithub && hasAppCreds;
  const safeEnabled = isAppMode ? Boolean(config.enabled) : false;
  const safeLastEnabled = isAppMode ? Boolean(config.lastEnabledState) : false;

  return {
    projectHash,
    enabled: safeEnabled,
    lastEnabledState: safeLastEnabled,
    channel: config.channel || 'github',
    syncMode: config.syncMode || 'webhook',
    repoIdentifier: (config.repoIdentifier || '').trim(),
    accessToken: (config.accessToken || '').trim(),
    githubAppId: config.githubAppId?.trim() || undefined,
    githubAppPrivateKey: config.githubAppPrivateKey || undefined,
    githubAppPrivateKeyPath: config.githubAppPrivateKeyPath?.trim() || undefined,
    tokenExpiresAt: config.tokenExpiresAt || undefined,
    customApiBase: (config.customApiBase || '').trim(),
    webhook: {
      payloadUrl: cleanPayload,
      secret: config.webhook?.secret || '',
    },
    polling: {
      intervalSeconds: Number(config.polling?.intervalSeconds) || 60,
      onlyActivePr: config.polling?.onlyActivePr !== false,
    },
    events: {
      pullRequest: config.events?.pullRequest !== false,
      issueComment: config.events?.issueComment !== false,
      push: Boolean(config.events?.push),
    },
    triggerKeyword: (config.triggerKeyword !== undefined ? config.triggerKeyword : '@bot').trim(),
    autoReviewNewPr: config.autoReviewNewPr !== false,
    updateExistingComment: config.updateExistingComment !== false,
    reviewPromptTemplate: config.reviewPromptTemplate || '',
    reviewModel: config.reviewModel || undefined,
    lang: config.lang || undefined,
  };
}

export async function saveProjectGitConfig(projectHash: string, config: GitAdapterConfig): Promise<{ success: boolean; error?: string }> {
  const cleanPayload = config.webhook?.payloadUrl
    ? normalizeWebhookHost(config.webhook.payloadUrl).replace(/\/+$/, '')
    : '';
  const clean = toCleanApiPayload(config, projectHash);

  try {
    localStorage.setItem(`jeikcode_git_binding_${projectHash}`, JSON.stringify(clean));
    if (cleanPayload) {
      setLastWebhookHost(cleanPayload);
    }
  } catch {
    // ignore
  }
  // 异步同步到后端持久化文件 (~/.jeikcode/git-bindings.json)
  return saveGitBinding(clean);
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
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [calcLoading, setCalcLoading] = useState(false);

  // 动态响应页面/浏览器缩放与视口尺寸变动，自适应计算弹窗最大高度与居中边界，彻底防止大比例缩放下被遮挡
  const [modalAdaptiveStyle, setModalAdaptiveStyle] = useState<{ maxHeight?: string; width?: string }>({});

  // 遮罩空白处点击关闭：仅在「按下」与「松开」都落在遮罩本身时生效，避免拖拽划词误关。
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    function computeAdaptiveBounds() {
      if (typeof window === 'undefined') return;
      const zoom = getPageZoom() || 1.0;
      const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;

      // 缩放校正后的有效可用视口高度与宽度
      const effectiveVh = vh / zoom;
      const effectiveVw = vw / zoom;

      // 移动端视口（<= 768px）自适应委托给 CSS 底部抽屉与响应式样式，不内联写死像素宽高
      if (effectiveVw <= 768) {
        setModalAdaptiveStyle({});
        return;
      }

      // 上下各预留 24px、左右各预留 20px 安全边距，让弹窗无论如何缩放均居中保持完整可见
      const safeMaxHeight = Math.max(340, Math.floor(effectiveVh - 48));
      const safeWidth = Math.min(860, Math.max(320, Math.floor(effectiveVw - 40)));

      setModalAdaptiveStyle({
        maxHeight: `${safeMaxHeight}px`,
        width: `${safeWidth}px`,
      });
    }

    computeAdaptiveBounds();
    window.addEventListener('resize', computeAdaptiveBounds);
    window.addEventListener('jeikcode:zoom_change', computeAdaptiveBounds);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', computeAdaptiveBounds);
      window.visualViewport.addEventListener('scroll', computeAdaptiveBounds);
    }
    return () => {
      window.removeEventListener('resize', computeAdaptiveBounds);
      window.removeEventListener('jeikcode:zoom_change', computeAdaptiveBounds);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', computeAdaptiveBounds);
        window.visualViewport.removeEventListener('scroll', computeAdaptiveBounds);
      }
    };
  }, []);

  // 动态同步右上角实际监听端口（默认 13460）
  const [livePort, setLivePort] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.location.port) {
      return window.location.port;
    }
    return '13460';
  });

  useEffect(() => {
    getRemoteAccess()
      .then((st) => {
        if (st && st.port) {
          setLivePort(String(st.port));
        }
      })
      .catch(() => {});
  }, []);

  const activeChannelMeta = GIT_CHANNELS.find((c) => c.id === config.channel) || GIT_CHANNELS[0];

  useEffect(() => {
    // 从后端拉取最新持久化配置（支持跨浏览器/清除缓存后恢复）
    getGitBinding(project.hash).then((remote) => {
      if (remote && remote.channel) {
        setConfig((prev) => {
          const rawRemotePayload = remote.webhook?.payloadUrl || remote.webhook?.payload_url || '';
          const cleanRemotePayload = normalizeWebhookHost(rawRemotePayload).replace(/\/+$/, '');
          // 关键修复：项目已有的配置绝对优先，绝不被继承值覆盖！
          const effectivePayload = cleanRemotePayload || prev.webhook.payloadUrl || getLastWebhookHost();

          // 核心防线：绝不能拿远端的空值冲掉本地刚填好或已存的有效数据！
          const effectiveToken = (remote.accessToken && remote.accessToken.trim()) ||
                                 (remote.access_token && remote.access_token.trim()) ||
                                 prev.accessToken;
          const effectiveRepo = (remote.repoIdentifier && remote.repoIdentifier.trim()) ||
                                (remote.repo_identifier && remote.repo_identifier.trim()) ||
                                prev.repoIdentifier;
          const effectiveAppId = remote.githubAppId || remote.github_app_id || prev.githubAppId;
          const effectiveKeyPath = remote.githubAppPrivateKeyPath || remote.github_app_private_key_path || prev.githubAppPrivateKeyPath;
          const effectiveKey = remote.githubAppPrivateKey || remote.github_app_private_key || prev.githubAppPrivateKey;
          const effectiveExp = remote.tokenExpiresAt || remote.token_expires_at || prev.tokenExpiresAt;
          const effectivePrompt = (remote.reviewPromptTemplate && remote.reviewPromptTemplate.trim()) ||
                                  (remote.review_prompt_template && remote.review_prompt_template.trim()) ||
                                  prev.reviewPromptTemplate;

          const ch = remote.channel || prev.channel || 'github';
          const isGithub = ch === 'github';
          const hasAppCreds = Boolean(
            effectiveAppId || effectiveKeyPath || effectiveKey
          );
          const isAppMode = isGithub && hasAppCreds;
          const safeEnabled = isAppMode ? (remote.enabled ?? prev.enabled ?? false) : false;
          const safeLastEnabled = isAppMode ? (remote.lastEnabledState ?? remote.last_enabled_state ?? prev.lastEnabledState ?? false) : false;

          return {
            ...prev,
            ...remote,
            enabled: safeEnabled,
            lastEnabledState: safeLastEnabled,
            accessToken: effectiveToken,
            repoIdentifier: effectiveRepo,
            githubAppId: effectiveAppId,
            githubAppPrivateKeyPath: effectiveKeyPath,
            githubAppPrivateKey: effectiveKey,
            tokenExpiresAt: effectiveExp,
            reviewPromptTemplate: effectivePrompt,
            webhook: {
              ...prev.webhook,
              ...(remote.webhook || {}),
              payloadUrl: effectivePayload,
            },
            events: {
              ...prev.events,
              ...(remote.events || {}),
            },
          };
        });
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

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
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

  const handleSave = async () => {
    const isGithub = config.channel === 'github';
    const hasAppCreds = Boolean(
      config.githubAppId?.trim() || config.githubAppPrivateKey || config.githubAppPrivateKeyPath?.trim()
    );
    const isAppMode = isGithub && hasAppCreds;
    const configToSave = {
      ...config,
      enabled: isAppMode ? config.enabled : false,
      lastEnabledState: isAppMode ? config.lastEnabledState : false,
      lang,
    };
    try {
      const res = await saveProjectGitConfig(project.hash, configToSave);
      if (res && res.success === false) {
        showToast(res.error || t('gitWebhook.saveFailedBackend'), 'error');
        return;
      }
      showToast(t('gitWebhook.saveSuccess'), 'success');
      if (onSaved) onSaved(configToSave);
      setTimeout(() => {
        onClose();
      }, 600);
    } catch (e: any) {
      showToast(e.message || t('gitWebhook.saveFailed'), 'error');
    }
  };

  const handleRegenerateSecret = () => {
    const newSecret = generateRandomSecret();
    setConfig((prev) => ({
      ...prev,
      webhook: { ...prev.webhook, secret: newSecret },
    }));
  };

  const handleCalcAppToken = async () => {
    const appId = Number(config.githubAppId);
    if (!appId || isNaN(appId)) {
      showToast(t('gitWebhook.appIdInvalid'), 'error');
      return;
    }
    if (!config.githubAppPrivateKeyPath && !config.githubAppPrivateKey) {
      showToast(t('gitWebhook.privateKeyRequired'), 'error');
      return;
    }
    setCalcLoading(true);
    try {
      const res = await generateGitHubAppToken({
        appId,
        privateKeyPath: config.githubAppPrivateKeyPath,
        privateKey: config.githubAppPrivateKey,
        repoIdentifier: config.repoIdentifier || 'jeikl/JeikCode',
        projectHash: project.hash,
      });
      if (res.success && res.token) {
        setConfig((prev) => ({
          ...prev,
          accessToken: res.token!,
          tokenExpiresAt: res.expiresAt || (Math.floor(Date.now() / 1000) + 3300),
        }));
        showToast(res.message || t('gitWebhook.appTokenSuccess'), 'success');
      } else {
        showToast(res.error || t('gitWebhook.calcTokenFailed'), 'error');
      }
    } catch (e: any) {
      showToast(e.message || t('gitWebhook.calcTokenFailed'), 'error');
    } finally {
      setCalcLoading(false);
    }
  };

  const handleFileChosen = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      setConfig((prev) => ({
        ...prev,
        githubAppPrivateKeyPath: (file as any).path || file.name,
        githubAppPrivateKey: content,
      }));
      showToast(t('gitWebhook.privateKeyLoaded', { name: file.name }), 'success');
    } catch (err: any) {
      showToast(t('gitWebhook.privateKeyLoadFailed', { error: err.message }), 'error');
    }
  };

  const handleResetPrompt = () => {
    const defaultPrompt = getDefaultReviewPrompt(lang);
    setConfig((prev) => ({ ...prev, reviewPromptTemplate: defaultPrompt }));
  };

  const [testing, setTesting] = useState(false);

  const handleTestOrTrigger = async () => {
    if (!config.repoIdentifier.trim()) {
      showToast(t('gitWebhook.repoPlaceholder') || 'Please specify repository', 'error');
      return;
    }
    setTesting(true);
    try {
      const payload = toCleanApiPayload(config, project.hash);
      const res = await testGitBinding(payload);
      if (res.success) {
        showToast(
          res.message ||
            (config.syncMode === 'webhook'
              ? t('gitWebhook.testSuccess')
              : t('gitWebhook.pollingSimSuccess')),
          'success'
        );
      } else {
        showToast(res.error || 'Connection failed', 'error');
      }
    } catch (e: any) {
      showToast(e.message || 'Connection test failed', 'error');
    } finally {
      setTesting(false);
    }
  };

  // 下拉框 1：托管平台渠道选项（展示加粗名称、Active/Beta 状态徽章、协议说明和格式示例）
  const channelOptions: SelectOption<GitPlatformChannel>[] = GIT_CHANNELS.map((ch) => ({
    value: ch.id,
    selectedLabel: (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
        <strong style={{ color: 'var(--app-primary-foreground)' }}>{t(ch.nameKey as any) || ch.id}</strong>
        <span class={`git-channel-status-badge ${ch.statusType}`}>{t(ch.statusBadgeKey as any)}</span>
      </div>
    ),
    label: (
      <div class="git-select-rich-option">
        <div class="git-select-rich-top">
          <span class="git-select-rich-title">{t(ch.nameKey as any) || ch.id}</span>
          <span class={`git-channel-status-badge ${ch.statusType}`}>{t(ch.statusBadgeKey as any)}</span>
        </div>
        <span class="git-select-rich-desc">{t(ch.descKey as any)}</span>
        <span class="git-select-rich-sample">{t(ch.repoSampleKey as any)}</span>
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

  const isGithubApp = config.channel === 'github';

  return (
    <div class="modal-overlay git-webhook-modal-overlay" {...backdropDismiss}>
      <div
        class="modal-card modal-card-lg git-webhook-modal-card"
        style={modalAdaptiveStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="git-adapter-title"
      >
        {/* 顶部标题栏 */}
        <div class="modal-header git-webhook-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ flexShrink: 0, color: 'var(--app-primary-foreground)' }}>
            <line x1="6" y1="3" x2="6" y2="15"></line>
            <circle cx="18" cy="6" r="3"></circle>
            <circle cx="6" cy="18" r="3"></circle>
            <path d="M18 9a9 9 0 0 1-9 9"></path>
          </svg>
          <div class="git-header-text-wrap">
            <h3 id="git-adapter-title">
              <span>{t('gitWebhook.adapterTitle')}</span>
              <span class="git-badge-tag">{t('gitWebhook.tag')}</span>
            </h3>
            <span class="modal-sub">{t('gitWebhook.adapterSub')}</span>
          </div>
          <button type="button" class="modal-close" onClick={onClose} aria-label={t('common.dismiss')}>
            ✕
          </button>
        </div>

        {/* 弹窗内容主体：弹性伸缩，内部自动滚动，底部操作栏绝不被遮蔽 */}
        <div class="modal-body git-webhook-body">
          
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

          {/* 总启用开关横幅：仅在 GitHub App 模式下允许开启，非 App 模式（如 PAT 模式）强制禁用 */}
          <div
            class={`git-enable-hero-banner ${config.enabled ? 'is-enabled' : 'is-disabled'}`}
            style={!isGithubApp ? { cursor: 'not-allowed', opacity: 0.75 } : {}}
            onClick={() => {
              if (!isGithubApp) {
                showToast(t('gitWebhook.onlyGithubAppAllowed'), 'error');
                return;
              }
              const next = !config.enabled;
              setConfig({
                ...config,
                enabled: next,
                lastEnabledState: next,
              });
            }}
          >
            <div class="git-enable-hero-left">
              <div class={`git-enable-toggle-core ${config.enabled ? 'active' : ''}`} aria-hidden="true">
                <span class="git-enable-toggle-thumb" />
              </div>
              <div class="git-enable-hero-text">
                <div class="git-enable-hero-title">
                  <strong>{t('gitWebhook.enableSwitchLabel')}</strong>
                </div>
                <span class="git-enable-hero-desc">{t('gitWebhook.enableSwitchHint')}</span>
              </div>
            </div>

            <div class={`git-enable-status-chip ${config.enabled ? 'active' : 'disabled'}`}>
              <span class="git-status-dot" />
              <span class="git-status-text">
                {!isGithubApp
                  ? t('gitWebhook.statusInactive')
                  : config.enabled
                  ? t('gitWebhook.statusActive')
                  : t('gitWebhook.statusInactive')}
              </span>
            </div>
          </div>

          {/* 适配器核心配置区：双下拉框（渠道选择 + 模式选择） */}
          <div class="git-form-section">
            <div class="git-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <span>1. {t('gitWebhook.secStrategyTitle')}</span>
              {config.channel === 'github' && (
                <div class="git-header-capsules">
                  <a
                    href="https://github.com/settings/apps/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="git-capsule-btn"
                    title={t('gitWebhook.tooltipCreateApp')}
                  >
                    🚀 {t('gitWebhook.capsuleApplyApp')}
                  </a>
                  <a
                    href="https://github.com/settings/apps"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="git-capsule-btn"
                    title={t('gitWebhook.tooltipViewAppId')}
                  >
                    🆔 {t('gitWebhook.capsuleAppId')}
                  </a>
                  <a
                    href="https://github.com/settings/apps"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="git-capsule-btn"
                    title={t('gitWebhook.tooltipGetKeyPairs')}
                  >
                    🔑 {t('gitWebhook.capsuleAppKey')}
                  </a>
                </div>
              )}
            </div>
            
            <div class="git-form-grid">
              {/* 下拉框 1：托管平台渠道 */}
              <div class="git-form-item">
                <label class="git-form-label">{t('gitWebhook.channelSection')}</label>
                <Select<GitPlatformChannel>
                  class="git-adapter-select"
                  value={config.channel}
                  options={channelOptions}
                  onChange={(ch) => {
                    const isApp = ch === 'github';
                    setConfig({
                      ...config,
                      channel: ch,
                      enabled: isApp ? config.enabled : false,
                      lastEnabledState: isApp ? config.lastEnabledState : false,
                    });
                  }}
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
                  onInput={(e) => {
                    const raw = (e.target as HTMLInputElement).value;
                    const cleanApi = raw.replace(/：/g, ':').replace(/[／、]/g, '/');
                    setConfig({ ...config, customApiBase: cleanApi });
                  }}
                />
                <span class="git-input-hint">{t('gitWebhook.customApiBaseHint')}</span>
              </div>
            )}
          </div>

          {/* 适配器第 2 区：模式专属接入参数 (Webhook 或 轮询) */}
          <div class="git-form-section">
            <div class="git-section-title">
              <span>2. {config.syncMode === 'webhook' ? t('gitWebhook.secParamWebhook') : t('gitWebhook.secParamPolling')}</span>
            </div>

            {config.syncMode === 'webhook' ? (
              <div class="git-form-grid">
                <div class="git-form-item">
                  <label class="git-form-label">{t('gitWebhook.payloadUrlLabel')}</label>
                  <div class="git-webhook-input-group">
                    <input
                      type="text"
                      class="git-group-input"
                      value={stripHostPortAndSuffix(config.webhook.payloadUrl || '')}
                      placeholder={`http(s)://yourdomain`}
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        const normalized = normalizeWebhookHost(val);
                        const cleanHost = stripHostPortAndSuffix(normalized);
                        setConfig({
                          ...config,
                          webhook: {
                            ...config.webhook,
                            payloadUrl: cleanHost,
                          },
                        });
                        // 用户编辑后，实时同步为全局默认继承项
                        if (cleanHost) {
                          setLastWebhookHost(cleanHost);
                        }
                      }}
                    />
                    <span class="git-group-addon">:{livePort}/api/webhooks/git</span>
                    <button
                      type="button"
                      class="git-group-btn"
                      onClick={() => {
                        const host = stripHostPortAndSuffix(config.webhook.payloadUrl.trim() || `http://127.0.0.1`);
                        copyToClipboard(`${host}:${livePort}/api/webhooks/git`, 'url');
                      }}
                      title={t('gitWebhook.copyFullUrlHint')}
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
                    {t('gitWebhook.pollingFilterHint')}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* 适配器第 3 区：动态绑定的仓库标识与平台认证凭据 */}
          <div class="git-form-section">
            <div class="git-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span>3. {t('gitWebhook.secAuthTitle')}</span>
              <span
                class="git-pat-status-pill"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#fbbf24',
                  background: 'rgba(245, 158, 11, 0.15)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {t('gitWebhook.patStatusPill')}
              </span>
            </div>

            {/* 独立全宽警告横幅：自适应折行，彻底杜绝穿模与挤压 */}
            <div
              class="git-pat-warning-banner"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.28)',
                borderRadius: '6px',
                padding: '8px 12px',
                margin: '6px 0 12px 0',
                fontSize: '12px',
                lineHeight: '1.5',
                color: '#fbbf24',
                wordBreak: 'break-word',
              }}
            >
              <span style={{ fontSize: '14px', flexShrink: 0, lineHeight: '1.2' }}>⚠️</span>
              <div>{t('gitWebhook.patDisabledWarning')}</div>
            </div>

            {config.channel === 'github' ? (
              <div class="git-form-grid" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div class="git-form-grid">
                  {/* GitHub 仓库全名 */}
                  <div class="git-form-item">
                    <label class="git-form-label">
                      {t(activeChannelMeta.repoLabelKey as any)} <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="text"
                      class="git-input"
                      placeholder={t(activeChannelMeta.repoSampleKey as any)}
                      value={config.repoIdentifier}
                      onInput={(e) => {
                        const raw = (e.target as HTMLInputElement).value;
                        const cleanRepo = raw.replace(/[／、]/g, '/');
                        setConfig({ ...config, repoIdentifier: cleanRepo });
                      }}
                    />
                    <span class="git-input-hint">{t(activeChannelMeta.repoHintKey as any)}</span>
                  </div>

                  {/* GitHub App ID */}
                  <div class="git-form-item">
                    <label class="git-form-label">
                      {t('gitWebhook.appIdLabel')} <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="text"
                      class="git-input"
                      placeholder={t('gitWebhook.appIdPlaceholder')}
                      value={config.githubAppId || ''}
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value.trim();
                        setConfig({ ...config, githubAppId: val });
                      }}
                    />
                    <span class="git-input-hint">{t('gitWebhook.appIdHint')}</span>
                  </div>
                </div>

                {/* GitHub App 私钥文件 (.pem) */}
                <div class="git-form-item">
                  <label class="git-form-label">
                    {t('gitWebhook.privateKeyLabel')} <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".pem,.key,.txt"
                    style={{ display: 'none' }}
                    onChange={handleFileChosen}
                  />
                  <div class="git-input-with-actions">
                    <input
                      type="text"
                      class="git-input"
                      placeholder={t('gitWebhook.privateKeyPlaceholder')}
                      value={config.githubAppPrivateKeyPath || ''}
                      onInput={(e) => {
                        const pathVal = (e.target as HTMLInputElement).value.trim();
                        setConfig({ ...config, githubAppPrivateKeyPath: pathVal });
                      }}
                    />
                    <button
                      type="button"
                      class="git-aux-btn"
                      onClick={() => fileInputRef.current?.click()}
                      title={t('gitWebhook.tooltipBrowseKey')}
                    >
                      {t('gitWebhook.browsePrivateKey')}
                    </button>
                    <button
                      type="button"
                      class="git-aux-btn git-token-calc-btn"
                      onClick={handleCalcAppToken}
                      disabled={calcLoading}
                      title={t('gitWebhook.tooltipCalcToken')}
                    >
                      {calcLoading ? '...' : t('gitWebhook.calcAppToken')}
                    </button>
                  </div>
                  <span class="git-input-hint">
                    {config.githubAppPrivateKey ? t('gitWebhook.privateKeyReady') : t('gitWebhook.privateKeyEmptyHint')}
                  </span>
                </div>

                {/* 官方 Bot 令牌激活状态横幅 */}
                {config.accessToken && (
                  <div class="git-app-status-box">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '14px' }}>🛡️</span>
                      <strong>{t('gitWebhook.appTokenActive')}</strong>
                      <span style={{ fontFamily: 'monospace', fontSize: '11px', opacity: 0.85 }}>
                        ({showToken ? config.accessToken.slice(0, 24) + '...' : '••••••••••••••••••••••••'})
                      </span>
                    </div>
                    <button
                      type="button"
                      class="git-aux-btn"
                      style={{ padding: '2px 8px', height: '24px', fontSize: '11px' }}
                      onClick={() => setShowToken(!showToken)}
                    >
                      {showToken ? t('gitWebhook.hideToken') : t('gitWebhook.showToken')}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div class="git-form-grid">
                {/* 动态 Label、Placeholder 与 Hint */}
                <div class="git-form-item">
                  <label class="git-form-label">
                    {t(activeChannelMeta.repoLabelKey as any)} <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    class="git-input"
                    placeholder={t(activeChannelMeta.repoSampleKey as any)}
                    value={config.repoIdentifier}
                    onInput={(e) => {
                      const raw = (e.target as HTMLInputElement).value;
                      const cleanRepo = raw.replace(/[／、]/g, '/');
                      setConfig({ ...config, repoIdentifier: cleanRepo });
                    }}
                  />
                  <span class="git-input-hint">{t(activeChannelMeta.repoHintKey as any)}</span>
                </div>

                {/* 动态 Token Name、Placeholder 与 Hint */}
                <div class="git-form-item">
                  <label class="git-form-label">
                    {t(activeChannelMeta.tokenNameKey as any)} <span style={{ color: '#ef4444' }}>*</span>
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
                      title={showToken ? t('gitWebhook.hideToken') : t('gitWebhook.showToken')}
                    >
                      {showToken ? '🙈' : '👁️'}
                    </button>
                  </div>
                  <span class="git-input-hint">{t(activeChannelMeta.tokenHintKey as any)}</span>
                </div>
              </div>
            )}
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
                    onInput={(e) => setConfig({ ...config, triggerKeyword: (e.target as HTMLInputElement).value })}
                  />
                </div>
                <span class="git-inline-keyword-hint">{t('gitWebhook.keywordSeparatorHint')}</span>
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
                title={t('gitWebhook.resetPrompt')}
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
        <div class="modal-footer git-webhook-footer">
          <div class="git-footer-left">
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
            {toast && <span class={`git-footer-toast ${toast.type}`}>{toast.msg}</span>}
          </div>

          <div class="git-footer-right">
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
