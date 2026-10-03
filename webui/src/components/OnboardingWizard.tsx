// First-run wizard for the desktop shell. The TUI already asks for language
// and a model; the desktop window previously opened a blank chat.

import { useState } from 'preact/hooks';
import { postLanguage } from '../api';
import { Lang } from '../i18n';
import { useSettings } from '../settings';

const DONE_KEY = 'jeikcode.onboardingDone';

export function onboardingDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboardingDone() {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function OnboardingWizard({
  onConfigureModel,
  onClose,
}: {
  onConfigureModel: () => void;
  onClose: () => void;
}) {
  const { lang, setLang, t } = useSettings();
  const [step, setStep] = useState<1 | 2>(1);
  const [choice, setChoice] = useState<Lang>(lang === 'zh' ? 'zh' : 'en');
  const [saving, setSaving] = useState(false);

  function finish() {
    markOnboardingDone();
    onClose();
  }

  async function next() {
    setSaving(true);
    setLang(choice);
    try {
      await postLanguage(choice);
    } catch {
      /* the settings store already retries on later toggles */
    }
    setSaving(false);
    setStep(2);
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
            <div class="onboarding-lang-row">
              <button
                type="button"
                class={'onboarding-lang' + (choice === 'en' ? ' active' : '')}
                onClick={() => setChoice('en')}
              >
                {t('onboarding.langEn')}
              </button>
              <button
                type="button"
                class={'onboarding-lang' + (choice === 'zh' ? ' active' : '')}
                onClick={() => setChoice('zh')}
              >
                {t('onboarding.langZh')}
              </button>
            </div>
          </div>
        ) : (
          <div class="modal-body onboarding-body">
            <h4>{t('onboarding.modelTitle')}</h4>
            <p>{t('onboarding.modelBody')}</p>
          </div>
        )}
        <div class="modal-footer">
          {step === 1 ? (
            <button type="button" class="btn btn-primary" disabled={saving} onClick={() => void next()}>
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
