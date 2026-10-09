import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getModels, ModelInfo, postLiveReasoningEffort } from '../api';
import { useT } from '../settings';
import { MsgKey } from '../i18n';
import { modelAliasLabel } from '../lib/modelLabel';

function areModelsEqual(a: ModelInfo[], b: ModelInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ma = a[i];
    const mb = b[i];
    if (
      ma.provider !== mb.provider ||
      ma.model !== mb.model ||
      ma.account !== mb.account ||
      ma.is_default !== mb.is_default ||
      ma.effort_applicable !== mb.effort_applicable ||
      ma.reasoning_effort !== mb.reasoning_effort ||
      ma.thinking_budget !== mb.thinking_budget ||
      JSON.stringify(ma.reasoning_levels) !== JSON.stringify(mb.reasoning_levels)
    ) {
      return false;
    }
  }
  return true;
}

/** 提取模型归属的提供商分组名（优先 account，其次 prefix 或 provider_type）。 */
export function getProviderGroup(m: ModelInfo): string {
  if (m.account && m.account.trim()) return m.account.trim();
  if (m.provider.includes('/')) {
    const parts = m.provider.split('/');
    if (parts[0] && parts[0].trim()) return parts[0].trim();
  }
  if (m.provider_type && m.provider_type.trim()) return m.provider_type.trim();
  return 'default';
}

/** 搜索关键词高亮组件。 */
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query || !query.trim()) return <span>{text}</span>;
  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <span>{text}</span>;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <span>
      {before}
      <mark class="search-kw-highlight">{match}</mark>
      <HighlightText text={after} query={query} />
    </span>
  );
}

/** 各思考等级的默认预算数值（单位 Tokens）。 */
const DEFAULT_EFFORT_BUDGETS: Record<string, number> = {
  low: 2048,
  medium: 5120, // 5 * 1024 = 5120
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

function useNarrowScreen() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return narrow;
}

export function ModelSelector({
  value,
  onChange,
  onDefaultChange,
  sessionId,
  direction = 'down',
  onOpenModelConfig,
}: {
  value: string | null;
  onChange: (p: string) => void;
  onDefaultChange?: (p: string) => void;
  sessionId?: string | null;
  direction?: 'up' | 'down';
  onOpenModelConfig?: () => void;
}) {
  const t = useT();
  const narrow = useNarrowScreen();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);

  // 搜索关键字
  const [searchQuery, setSearchQuery] = useState('');
  // 当前悬停/选中的提供商
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);

  // 本地暂存的 effort 与 budget override
  const [effortOverride, setEffortOverride] = useState<string | null | undefined>(undefined);
  const [budgetOverride, setBudgetOverride] = useState<number | null | undefined>(undefined);

  // 思考强度每一项是否展开了“自定义预算”输入框
  const [budgetChecked, setBudgetChecked] = useState<Record<string, boolean>>({});
  // 思考强度每一项输入的自定义预算数值
  const [budgetInputs, setBudgetInputs] = useState<Record<string, number>>({});

  const ref = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);

  const modelsRef = useRef(models);
  modelsRef.current = models;
  const openRef = useRef(open);
  openRef.current = open;
  const effortOpenRef = useRef(effortOpen);
  effortOpenRef.current = effortOpen;

  useEffect(() => {
    if (!open && !effortOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (open) setOpen(false);
      if (effortOpen) setEffortOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, effortOpen]);

  const [refreshing, setRefreshing] = useState(false);
  const handleManualRefresh = () => {
    setRefreshing(true);
    getModels()
      .then((next) => {
        setModels(next);
        const defaultModel = next.find((model) => model.is_default) ?? next[0];
        if (defaultModel) onDefaultChange?.(defaultModel.provider);
      })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => setRefreshing(false), 400);
      });
  };

  useEffect(() => {
    let active = true;
    const fetchLatest = () => {
      getModels()
        .then((next) => {
          if (!active) return;
          if (!areModelsEqual(modelsRef.current, next)) {
            setModels(next);
            const defaultModel = next.find((model) => model.is_default) ?? next[0];
            if (defaultModel) onDefaultChange?.(defaultModel.provider);
          }
        })
        .catch(() => {});
    };

    // 冷启动拉取一次模型列表
    fetchLatest();

    // 联动：当 jeikcode_config (reload) 或外部触发重载时静默刷新一次，彻底杜绝无脑 2s 轮询！
    const onReload = () => fetchLatest();
    window.addEventListener('jeikcode:config-reloaded', onReload);
    window.addEventListener('jeikcode:reload-models', onReload);

    return () => {
      active = false;
      window.removeEventListener('jeikcode:config-reloaded', onReload);
      window.removeEventListener('jeikcode:reload-models', onReload);
    };
  }, [onDefaultChange]);

  // 当弹窗展开时，按需静默同步一次模型列表
  useEffect(() => {
    if (open) {
      getModels()
        .then((next) => {
          if (!areModelsEqual(modelsRef.current, next)) {
            setModels(next);
          }
        })
        .catch(() => {});
    }
  }, [open]);

  // 桌面端思考强度仍是触发器下的下拉；窄屏改为 portal 底栏，由 overlay 关闭。
  useEffect(() => {
    if (!effortOpen || narrow) return;
    const h = (e: MouseEvent) => {
      if (effortRef.current && !effortRef.current.contains(e.target as Node)) {
        setEffortOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [effortOpen, narrow]);

  const current =
    models.find((m) => m.provider === value) ??
    models.find((m) => m.is_default) ??
    models[0];

  useEffect(() => {
    setEffortOverride(undefined);
    setBudgetOverride(undefined);
    // 初始化当前模型的 budget 状态
    if (current?.thinking_budget) {
      const eff = current.reasoning_effort?.toLowerCase() || 'medium';
      setBudgetChecked({ [eff]: true });
      setBudgetInputs({ [eff]: current.thinking_budget });
    } else {
      setBudgetChecked({});
      setBudgetInputs({});
    }
  }, [current?.provider, current?.thinking_budget]);

  const effort =
    effortOverride !== undefined
      ? effortOverride
      : (current?.reasoning_effort ?? null);

  const activeBudget =
    budgetOverride !== undefined
      ? budgetOverride
      : (current?.thinking_budget ?? null);

  // 提供商与模型按提供商分组
  const providerGroups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const p = getProviderGroup(m);
      const list = map.get(p) ?? [];
      list.push(m);
      map.set(p, list);
    }
    return map;
  }, [models]);

  // 根据搜索词筛选提供商和模型
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return providerGroups;
    }
    const result = new Map<string, ModelInfo[]>();
    for (const [provider, list] of providerGroups.entries()) {
      const providerMatches = provider.toLowerCase().includes(q);
      const matchedModels = list.filter((m) => {
        const alias = modelAliasLabel(m).toLowerCase();
        const wire = m.model.toLowerCase();
        return alias.includes(q) || wire.includes(q);
      });
      if (providerMatches || matchedModels.length > 0) {
        // 如果提供商名字匹配，保留其所有模型（匹配的排前面），否则仅保留匹配的模型
        if (providerMatches) {
          result.set(provider, list);
        } else {
          result.set(provider, matchedModels);
        }
      }
    }
    return result;
  }, [providerGroups, searchQuery]);

  // 打开面板时，确定初始高亮/选中的提供商
  useEffect(() => {
    if (open) {
      const currentProviderGroup = current ? getProviderGroup(current) : null;
      if (currentProviderGroup && filteredGroups.has(currentProviderGroup)) {
        setHoveredProvider(currentProviderGroup);
      } else {
        const first = filteredGroups.keys().next().value;
        setHoveredProvider(first ?? null);
      }
    }
  }, [open, filteredGroups]);

  // 保证 hoveredProvider 有效
  const activeProvider = useMemo(() => {
    if (hoveredProvider && filteredGroups.has(hoveredProvider)) {
      return hoveredProvider;
    }
    return filteredGroups.keys().next().value ?? null;
  }, [hoveredProvider, filteredGroups]);

  const activeModels = activeProvider ? filteredGroups.get(activeProvider) ?? [] : [];

  // 思考强度标准候选阶梯：默认、off、low、medium、high、xhigh、max
  const STANDARD_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
  const currentLevels = useMemo(() => {
    const set = new Set(STANDARD_LEVELS);
    if (current?.reasoning_levels && Array.isArray(current.reasoning_levels)) {
      for (const lvl of current.reasoning_levels) {
        if (lvl) set.add(lvl.toLowerCase());
      }
    }
    return Array.from(set);
  }, [current?.reasoning_levels]);

  const effortOptions = useMemo(() => {
    return [
      { val: null, label: t('effort.default'), hasBudget: false },
      ...currentLevels.map((lvl) => {
        const lower = lvl.toLowerCase();
        const hasBudget = lower !== 'off';
        const key = `effort.${lower}` as MsgKey;
        let label = lvl;
        try {
          const translated = t(key);
          if (translated && translated !== key) {
            label = translated;
          }
        } catch {
          label = lvl;
        }
        return {
          val: lower,
          label,
          hasBudget,
          defaultBudget: DEFAULT_EFFORT_BUDGETS[lower] ?? 2048,
        };
      }),
    ];
  }, [currentLevels, t]);

  const effortLabel = (v: string | null): string => {
    if (!v) return t('effort.default');
    const lower = v.toLowerCase();
    const match = effortOptions.find((x) => x.val === lower);
    let name = match ? match.label : v;
    if (activeBudget && activeBudget > 0 && lower !== 'off') {
      const k = activeBudget >= 1024 ? `${Math.round(activeBudget / 1024)}k` : `${activeBudget}`;
      return `${name} · ${k}`;
    }
    return name;
  };

  const handleSelectEffort = (
    lvl: string | null,
    budgetVal?: number | null,
    clearBudget?: boolean,
    keepOpen?: boolean,
  ) => {
    const prevEffort = effort;
    const prevBudget = activeBudget;
    setEffortOverride(lvl);
    if (lvl === 'off' || lvl === null || clearBudget) {
      setBudgetOverride(null);
    } else if (budgetVal !== undefined) {
      setBudgetOverride(budgetVal);
    }
    if (!keepOpen) setEffortOpen(false);

    if (current) {
      void postLiveReasoningEffort(
        lvl,
        current.provider,
        budgetVal ?? null,
        clearBudget,
        sessionId,
      ).catch((err) => {
        setEffortOverride(prevEffort);
        setBudgetOverride(prevBudget);
        console.error('Failed to update reasoning effort', err);
      });
    }
  };

  const handleToggleBudgetCheck = (lvl: string, e: MouseEvent) => {
    e.stopPropagation();
    const nextChecked = !budgetChecked[lvl];
    setBudgetChecked((prev) => ({ ...prev, [lvl]: nextChecked }));
    if (nextChecked) {
      const budgetVal = budgetInputs[lvl] || DEFAULT_EFFORT_BUDGETS[lvl] || 2048;
      setBudgetInputs((prev) => ({ ...prev, [lvl]: budgetVal }));
      handleSelectEffort(lvl, budgetVal, false, true);
    } else {
      handleSelectEffort(lvl, null, true, true);
    }
  };

  const handleBudgetInputChange = (lvl: string, rawVal: string) => {
    const num = parseInt(rawVal, 10);
    const val = isNaN(num) || num < 0 ? 0 : num;
    setBudgetInputs((prev) => ({ ...prev, [lvl]: val }));
  };

  const handleBudgetInputCommit = (lvl: string, overrideVal?: number) => {
    const budgetVal =
      overrideVal !== undefined
        ? overrideVal
        : (budgetInputs[lvl] !== undefined ? budgetInputs[lvl] : DEFAULT_EFFORT_BUDGETS[lvl] || 2048);
    handleSelectEffort(lvl, budgetVal, false, true);
  };

  const effortMenuList = (
    <div class="effort-menu-list">
      {effortOptions.map((o) => {
        const isCurrent =
          (!o.val && !effort) ||
          (o.val && effort && o.val.toLowerCase() === effort.toLowerCase());
        const isChecked = Boolean(o.val && budgetChecked[o.val]);
        const currentInputVal =
          o.val && budgetInputs[o.val] !== undefined
            ? budgetInputs[o.val]
            : ('defaultBudget' in o ? o.defaultBudget : undefined);

        return (
          <div
            key={o.val ?? 'default'}
            class={'effort-menu-row' + (isCurrent ? ' active' : '')}
          >
            <button
              type="button"
              class="effort-row-main-btn"
              onClick={() => {
                if (o.val === 'off') {
                  handleSelectEffort('off', 0, true);
                } else if (o.val === null) {
                  handleSelectEffort(null, null, true);
                } else if (isChecked) {
                  handleSelectEffort(o.val, currentInputVal, false);
                } else {
                  handleSelectEffort(o.val, null, true);
                }
              }}
            >
              <span class="effort-row-name">{o.label}</span>
              {isCurrent && <span class="effort-check-icon">✓</span>}
            </button>

            {o.hasBudget && o.val && (
              <div class="effort-budget-toggle-wrapper">
                <label
                  class={'effort-budget-checkbox-label' + (isChecked ? ' checked' : '')}
                  title={t('effort.budgetTooltip')}
                  onClick={(e) => handleToggleBudgetCheck(o.val!, e)}
                >
                  <input
                    type="checkbox"
                    class="effort-budget-checkbox"
                    checked={isChecked}
                    onChange={() => {}}
                  />
                  <span class="effort-budget-tag">{t('effort.budget')}</span>
                </label>

                {isChecked && (
                  <div class="effort-budget-input-popout" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="number"
                      class="effort-budget-input"
                      min="0"
                      step="1024"
                      value={currentInputVal}
                      onInput={(e) =>
                        handleBudgetInputChange(o.val!, (e.target as HTMLInputElement).value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          const raw = (e.target as HTMLInputElement).value;
                          const num = parseInt(raw, 10);
                          const val = isNaN(num) || num < 0 ? 0 : num;
                          setBudgetInputs((prev) => ({ ...prev, [o.val!]: val }));
                          handleBudgetInputCommit(o.val!, val);
                        }
                      }}
                      onBlur={(e) => {
                        const raw = (e.target as HTMLInputElement).value;
                        const num = parseInt(raw, 10);
                        const val = isNaN(num) || num < 0 ? 0 : num;
                        setBudgetInputs((prev) => ({ ...prev, [o.val!]: val }));
                        handleBudgetInputCommit(o.val!, val);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div class="model-controls">
      {/* 思考强度选择器 */}
      {current?.effort_applicable && (
        <div class={`model-selector effort-selector ${direction === 'down' ? 'model-selector-down' : 'model-selector-up'}`} ref={effortRef}>
          <button
            class={'model-selector-trigger effort-capsule-trigger' + (effortOpen ? ' is-active' : '')}
            onClick={() => {
              setEffortOpen((o) => !o);
              setOpen(false);
            }}
            type="button"
            title={t('effort.label')}
          >
            <span class="effort-prefix">{t('effort.label')}</span>
            <span class="model-selector-label effort-value-label">{effortLabel(effort)}</span>
            <span class={'model-selector-chevron' + (effortOpen ? ' rotated' : '')}>▾</span>
          </button>

          {effortOpen && !narrow && (
            <div class="model-dropdown effort-dropdown">
              {effortMenuList}
            </div>
          )}
        </div>
      )}

      {effortOpen && narrow && typeof document !== 'undefined' && createPortal(
        <div
          class="modal-overlay effort-selector-modal-overlay"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEffortOpen(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label={t('effort.label')}
        >
          <div class="modal-card effort-selector-modal-card" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span aria-hidden="true">🧠</span>
              <h3>{t('effort.label')}</h3>
              <button
                type="button"
                class="ghost-btn modal-close"
                onClick={() => setEffortOpen(false)}
                aria-label={t('settings.close')}
              >
                ×
              </button>
            </div>
            <div class="modal-body effort-selector-modal-body">
              {effortMenuList}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 模型选择器：现代胶囊触发器 */}
      <div class={`model-selector ${direction === 'down' ? 'model-selector-down' : 'model-selector-up'}`} ref={ref}>
        <button
          class={'model-selector-trigger model-capsule-trigger' + (open ? ' is-active' : '')}
          onClick={() => {
            setOpen((o) => !o);
            setEffortOpen(false);
          }}
          type="button"
          title={current ? `${modelAliasLabel(current)} (${getProviderGroup(current)})` : t('model.label')}
        >
          <span class="model-trigger-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a1 1 0 0 1 1 1v1.07A6.002 6.002 0 0 1 13.93 8H15a1 1 0 1 1 0 2h-1.07A6.002 6.002 0 0 1 9 14.93V16a1 1 0 1 1-2 0v-1.07A6.002 6.002 0 0 1 2.07 10H1a1 1 0 1 1 0-2h1.07A6.002 6.002 0 0 1 7 3.07V2a1 1 0 0 1 1-1zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>
            </svg>
          </span>
          {current ? (
            <div class="model-capsule-content">
              <span class="model-capsule-name">{modelAliasLabel(current)}</span>
              <span class="model-capsule-provider-badge">{getProviderGroup(current)}</span>
            </div>
          ) : (
            <span class="model-selector-label">{t('model.label')}</span>
          )}
          <span class={'model-selector-chevron' + (open ? ' rotated' : '')}>▾</span>
        </button>
      </div>

      {/* 顶层挂载的标准全屏遮罩居中弹窗，绝不受任何父级容器与视口边缘裁剪 */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          class="modal-overlay model-selector-modal-overlay"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label={t('model.label')}
        >
          <div class="modal-card model-selector-modal-card" onClick={(e) => e.stopPropagation()}>
            {/* 单行精炼头部：左侧图标+Model标签，中间搜索框，右侧叉叉，一行搞定 */}
            <div class="modal-header model-streamlined-header">
              <div class="model-header-title-badge">
                <span class="modal-title-icon">🎯</span>
                <span class="model-header-title-text">{t('model.label') || 'Model'}</span>
              </div>

              <div class="model-header-search-wrap">
                <span class="model-search-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                  </svg>
                </span>
                <input
                  type="text"
                  class="model-search-input"
                  placeholder={t('model.searchPlaceholder')}
                  value={searchQuery}
                  onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                  autoFocus
                />
                {searchQuery && (
                  <button
                    type="button"
                    class="model-search-clear"
                    onClick={() => setSearchQuery('')}
                    title={t('common.clear')}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* 物理刷新按钮：用户随手点按即时重新拉取最新模型列表，彻底消除定时轮询 */}
              <button
                type="button"
                class={'model-header-refresh-btn' + (refreshing ? ' is-spinning' : '')}
                onClick={handleManualRefresh}
                title={t('settings.upstreamRefresh')}
                aria-label={t('settings.upstreamRefresh')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>

              {onOpenModelConfig && (
                <button
                  type="button"
                  class="model-header-config-btn"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                    onOpenModelConfig?.();
                  }}
                  title={t('settings.menuModel')}
                  aria-label={t('settings.menuModel')}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{t('settings.menuModel')}</span>
                </button>
              )}

              <button
                type="button"
                class="modal-close-btn"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* 多级筛选级联区域 */}
            <div class="model-cascade-body">
              {/* 左栏：提供商列表 */}
              <div class="model-cascade-providers-column">
                <div class="model-column-title">
                  <span>{t('settings.providers')}</span>
                  <span class="model-count-tag">{filteredGroups.size}</span>
                </div>
                <div class="model-provider-list">
                  {Array.from(filteredGroups.keys()).map((pGroup) => {
                    const groupModels = filteredGroups.get(pGroup) ?? [];
                    const isHovered = activeProvider === pGroup;
                    const hasSelectedModel = groupModels.some(
                      (m) => m.provider === (value ?? current?.provider),
                    );

                    return (
                      <button
                        key={pGroup}
                        type="button"
                        class={
                          'model-provider-pill' +
                          (isHovered ? ' hovered' : '') +
                          (hasSelectedModel ? ' contains-active' : '')
                        }
                        onMouseEnter={() => setHoveredProvider(pGroup)}
                        onClick={() => setHoveredProvider(pGroup)}
                      >
                        <span class="model-provider-pill-left">
                          {hasSelectedModel && <span class="model-active-indicator" />}
                          <span class="model-provider-pill-name">
                            <HighlightText text={pGroup} query={searchQuery} />
                          </span>
                        </span>
                        <span class="model-provider-pill-count">{groupModels.length}</span>
                      </button>
                    );
                  })}
                  {filteredGroups.size === 0 && (
                    <div class="model-empty-hint">{t('settings.noSearchResults')}</div>
                  )}
                </div>
              </div>

              {/* 右栏：当前提供商下的所有模型列表 */}
              <div class="model-cascade-models-column">
                <div class="model-column-title">
                  <span>{activeProvider || t('model.label')}</span>
                  <span class="model-count-tag">{activeModels.length}</span>
                </div>
                <div class="model-models-list">
                  {activeModels.map((m) => {
                    const isSelected = m.provider === (value ?? current?.provider);
                    const alias = modelAliasLabel(m);
                    const wireModel = m.model;

                    return (
                      <button
                        key={m.provider}
                        type="button"
                        class={'model-cascade-item' + (isSelected ? ' selected' : '')}
                        onClick={() => {
                          onChange(m.provider);
                          setOpen(false);
                        }}
                      >
                        <div class="model-item-content">
                          <div class="model-item-main-line">
                            <span class="model-item-title">
                              <HighlightText text={alias} query={searchQuery} />
                            </span>
                            {m.is_default && <span class="model-badge-default">{t('settings.default')}</span>}
                            {m.effort_applicable && (
                              <span class="model-badge-thinking" title={t('settings.reasoningModel')}>🧠</span>
                            )}
                          </div>
                          {wireModel && wireModel !== alias && (
                            <div class="model-item-sub-line">
                              <HighlightText text={wireModel} query={searchQuery} />
                            </div>
                          )}
                        </div>
                        {isSelected && (
                          <span class="model-item-selected-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {activeModels.length === 0 && (
                    <div class="model-empty-hint">{t('settings.noModels')}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
