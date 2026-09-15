import { useState, useEffect, useRef } from 'preact/hooks';
import { getModels, ModelInfo, postLiveReasoningEffort } from '../api';
import { useT } from '../settings';
import { MsgKey } from '../i18n';
import { modelAliasLabel, modelSourceLabel } from '../lib/modelLabel';

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
      JSON.stringify(ma.reasoning_levels) !== JSON.stringify(mb.reasoning_levels)
    ) {
      return false;
    }
  }
  return true;
}

export function ModelSelector({
  value,
  onChange,
  onDefaultChange,
}: {
  value: string | null;
  onChange: (p: string) => void;
  onDefaultChange?: (p: string) => void;
}) {
  const t = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  // undefined = "show the provider's persisted value"; a string/null is a
  // local override after the user picks one (config isn't re-fetched).
  const [effortOverride, setEffortOverride] = useState<string | null | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);

  const modelsRef = useRef(models);
  modelsRef.current = models;
  const openRef = useRef(open);
  openRef.current = open;
  const effortOpenRef = useRef(effortOpen);
  effortOpenRef.current = effortOpen;

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (openRef.current || effortOpenRef.current) return;
      getModels().then((next) => {
        if (!active) return;
        if (openRef.current || effortOpenRef.current) return;
        if (!areModelsEqual(modelsRef.current, next)) {
          setModels(next);
          const defaultModel = next.find((model) => model.is_default) ?? next[0];
          if (defaultModel) onDefaultChange?.(defaultModel.provider);
        }
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onDefaultChange]);
  useEffect(() => {
    if (!open && !effortOpen) return;
    const h = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (ref.current && !ref.current.contains(tgt)) setOpen(false);
      if (effortRef.current && !effortRef.current.contains(tgt)) setEffortOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, effortOpen]);
  const current = models.find((m) => m.provider === value) ?? models.find((m) => m.is_default) ?? models[0];
  // Switching models resets the effort display back to the new model's
  // persisted value (and hides the selector entirely for non-effort models).
  useEffect(() => { setEffortOverride(undefined); }, [current?.provider]);
  const effort = effortOverride !== undefined ? effortOverride : (current?.reasoning_effort ?? null);

  const currentLevels = (current?.reasoning_levels && current.reasoning_levels.length > 0)
    ? current.reasoning_levels
    : ['low', 'medium', 'high'];

  const effortOptions: { val: string | null; label: string }[] = [
    { val: null, label: t('effort.default') },
    ...currentLevels.map((lvl) => {
      const key = `effort.${lvl.toLowerCase()}` as MsgKey;
      let label = lvl;
      try {
        const translated = t(key);
        if (translated && translated !== key) {
          label = translated;
        }
      } catch {
        label = lvl;
      }
      return { val: lvl, label };
    }),
  ];

  const effortLabel = (v: string | null): string => {
    if (!v) return t('effort.default');
    const match = effortOptions.find((x) => x.val?.toLowerCase() === v.toLowerCase());
    return match ? match.label : v;
  };
  const selectEffort = (v: string | null) => {
    const previous = effort;
    setEffortOverride(v);
    setEffortOpen(false);
    if (current) {
      void postLiveReasoningEffort(v, current.provider).catch((error) => {
        setEffortOverride(previous);
        console.error('Failed to update reasoning effort', error);
      });
    }
  };
  // 展示格式：别名（提供商/modelId）。别名=selection id，括号内=账号/线上模型 ID。
  return (
    <div class="model-controls">
      {current?.effort_applicable && (
        <div class="model-selector effort-selector model-selector-up" ref={effortRef}>
          <button
            class="model-selector-trigger"
            onClick={() => { setEffortOpen((o) => !o); setOpen(false); }}
            type="button"
            title={t('effort.label')}
          >
            <span class="effort-prefix">{t('effort.label')}</span>
            <span class="model-selector-label">{effortLabel(effort)}</span>
            <span class="model-selector-chevron">▾</span>
          </button>
          {effortOpen && (
            <div class="model-dropdown">
              {effortOptions.map((o) => (
                <button
                  key={o.val ?? 'default'}
                  class={'model-item' + (o.val === effort || (o.val?.toLowerCase() === effort?.toLowerCase()) ? ' active' : '')}
                  type="button"
                  onClick={() => selectEffort(o.val)}
                >
                  <span class="model-item-model">{o.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div class="model-selector model-selector-up" ref={ref}>
        <button class="model-selector-trigger" onClick={() => { setOpen((o) => !o); setEffortOpen(false); }} type="button">
          {current ? (
            <>
              <span class="model-selector-label">{modelAliasLabel(current)}</span>
              <span class="model-selector-provider">{modelSourceLabel(current)}</span>
            </>
          ) : (
            <span class="model-selector-label">{t('model.label')}</span>
          )}
          <span class="model-selector-chevron">▾</span>
        </button>
        {open && (
          <div class="model-dropdown">
            {models.map((m) => (
              <button
                key={m.provider}
                class={'model-item' + (m.provider === (value ?? current?.provider) ? ' active' : '')}
                type="button"
                title={`${modelAliasLabel(m)} (${modelSourceLabel(m)})`}
                onClick={() => { onChange(m.provider); setOpen(false); }}
              >
                <span class="model-item-model">{modelAliasLabel(m)}</span>
                <span class="model-item-provider">{modelSourceLabel(m)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
