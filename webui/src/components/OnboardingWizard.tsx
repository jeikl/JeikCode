// First-run wizard for the desktop shell. The TUI already asks for language
// and a model; the desktop window previously opened a blank chat.

import { useState } from 'preact/hooks';
import { Lang, languageOptions } from '../i18n';
import { useSettings } from '../settings';
import { markOnboardingDone } from '../lib/onboarding';

export { onboardingDone, markOnboardingDone } from '../lib/onboarding';

export function OnboardingWizard({
  onConfigureModel,
  onClose,
}: {
  onConfigureModel: () => void;
  onClose: () => void;
}) {
  const { lang, setLang, t } = useSettings();
  const [step, setStep] = useState<1 | 2>(1);
  const [choice, setChoice] = useState<Lang>(lang);
  const [saving, setSaving] = useState(false);
  const [languageError, setLanguageError] = useState(false);

  function finish() {
    markOnboardingDone();
    onClose();
  }

  async function saveChoice(value: Lang, advance = false) {
    if (saving) return;
    setSaving(true);
    setLanguageError(false);
    try {
      await setLang(value);
      if (advance) setStep(2);
    } catch {
      setLanguageError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="modal-overlay" role="presentation">
      <div class="modal-card onboarding-card" role="dialog" aria-labelledby="onboarding-title">
        <div class="modal-header">
          <h3 id="onboarding-title">{t('onboarding.title')}</h3>
        </div>
        {step === 1 ? (
          <div class="modal-body onboarding-body">
            <p>{t('onboarding.language')}</p>
            <div class="onboarding-lang-row" role="radiogroup" aria-label={t('settings.language')}>
              {languageOptions.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={choice === value}
                  class={'onboarding-lang' + (choice === value ? ' active' : '')}
                  disabled={saving}
                  onClick={() => { setChoice(value); void saveChoice(value); }}
                >
                  {label}
                </button>
              ))}
            </div>
            {languageError && <p role="alert">{t('settings.languageSaveFailed')}</p>}
          </div>
        ) : (
          <div class="modal-body onboarding-body">
            <h4>{t('onboarding.modelTitle')}</h4>
            <p>{t('onboarding.modelBody')}</p>
          </div>
        )}
        <div class="modal-footer">
          {step === 1 ? (
            <button type="button" class="btn btn-primary" disabled={saving} onClick={() => void saveChoice(choice, true)}>
              {t('onboarding.next')}
            </button>
          ) : (
            <>
              <button type="button" class="btn btn-secondary" onClick={finish}>
                {t('onboarding.skip')}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                onClick={() => {
                  markOnboardingDone();
                  onClose();
                  onConfigureModel();
                }}
              >
                {t('onboarding.configure')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
