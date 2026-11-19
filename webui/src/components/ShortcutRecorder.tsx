import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../settings';

/**
 * Global-shortcut capture.
 *
 * The user clicks the field, then presses a combo. All currently held modifiers
 * are rendered as kbd caps, and the final non-modifier key commits the full
 * accelerator (`Ctrl+Alt+J`). Backspace/Delete clears; Escape cancels capture.
 * The desktop shell validates/registers the accelerator and persists it.
 */
export function ShortcutRecorder({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef(false);
  recordingRef.current = recording;

  const isDesktopShell = (): boolean => {
    if (typeof window === 'undefined') return false;
    return Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__)
      || window.location.hostname === 'tauri.localhost'
      || window.location.protocol === 'tauri:';
  };

  // OS-global shortcuts intercept keydown before the WebView. Suspend the
  // registered combo while recording so it (and colliding combos) can be
  // captured; resume from the persisted value when recording ends.
  const desktopAction = (name: 'suspend_shortcut' | 'resume_shortcut') => {
    if (!isDesktopShell()) return;
    try {
      window.open(`http://tauri.localhost/__desktop_action/${name}`, '_blank');
    } catch {
      /* ignore */
    }
  };

  const startRecording = () => {
    if (disabled || recordingRef.current) return;
    recordingRef.current = true;
    setRecording(true);
    desktopAction('suspend_shortcut');
  };

  const stopRecording = () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    desktopAction('resume_shortcut');
  };

  useEffect(() => {
    return () => {
      if (recordingRef.current) desktopAction('resume_shortcut');
    };
  }, []);

  useEffect(() => {
    if (!recording) setHeld([]);
  }, [recording]);

  const modifierLabels = (event: KeyboardEvent): string[] => {
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    return parts;
  };

  const keyLabel = (event: KeyboardEvent): string => {
    const code = event.code;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (code === 'Space') return 'Space';
    if (code.startsWith('Arrow')) return code;
    if (
      ['Enter', 'Tab', 'Escape', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(code)
    ) {
      return code;
    }
    if (/^[A-Za-z0-9]$/.test(event.key)) return event.key.toUpperCase();
    return '';
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!recording || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') {
      stopRecording();
      return;
    }
    if (event.code === 'Backspace' || event.code === 'Delete') {
      setHeld([]);
      onChange('');
      stopRecording();
      return;
    }
    const modifiers = modifierLabels(event);
    const key = keyLabel(event);
    if (!key) {
      // Pure modifier press: keep the preview alive until the real key lands.
      setHeld(modifiers);
      return;
    }
    if (modifiers.length === 0 && !/^F\d+$/.test(key)) {
      // Plain typing is not a global shortcut; keep recording and show the
      // currently held keys so the user understands what is missing.
      setHeld([key]);
      return;
    }
    const combo = [...modifiers, key].join('+');
    setHeld([...modifiers, key]);
    onChange(combo);
    stopRecording();
  };

  const caps = recording
    ? held.length > 0
      ? held
      : []
    : value.split('+').filter(Boolean);

  return (
    <div class="shortcut-recorder-row">
      <div
        ref={boxRef}
        class={'shortcut-recorder' + (recording ? ' is-recording' : '') + (disabled ? ' is-disabled' : '')}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('settings.shortcutRecord')}
        onClick={() => {
          if (disabled) return;
          startRecording();
          boxRef.current?.focus();
        }}
        onFocus={() => {
          if (!disabled) startRecording();
        }}
        onBlur={() => stopRecording()}
        onKeyDown={(event) => onKeyDown(event as unknown as KeyboardEvent)}
        onKeyUp={(event) => {
          if (!recording) return;
          setHeld(modifierLabels(event as unknown as KeyboardEvent));
        }}
      >
        <span class="shortcut-caps">
          {caps.length > 0 ? (
            caps.map((part, index) => (
              <kbd class="shortcut-cap" key={`${part}-${index}`}>
                {part}
              </kbd>
            ))
          ) : (
            <span class="shortcut-placeholder">
              {recording ? t('settings.shortcutRecording') : t('settings.shortcutRecord')}
            </span>
          )}
          {recording && <span class="shortcut-recording-dot" aria-hidden="true" />}
        </span>
        {value && !disabled && (
          <button
            type="button"
            class="shortcut-clear"
            title={t('settings.shortcutClear')}
            aria-label={t('settings.shortcutClear')}
            onClick={(event) => {
              event.stopPropagation();
              onChange('');
              stopRecording();
            }}
          >
            ×
          </button>
        )}
      </div>
      <div class="shortcut-hint">
        {disabled ? t('settings.shortcutDesktopOnly') : t('settings.shortcutHint')}
      </div>
    </div>
  );
}
