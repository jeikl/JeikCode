import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  exportRepairPacket, getRepairCapability, getRepairInfo, getRepairPreview, pickNativeDirectory,
} from '../api';
import { isLoopbackHost, stripExtendedPathPrefix } from '../lib/displayPath';
import {
  isAbsoluteRepairPath, makeRepairExportRequest, REPAIR_PACKET_FILES, repairPacketSummary,
} from '../lib/repairEvidence';
import type {
  RepairCapability, RepairCheckStatus, RepairExportResponse, RepairInfoResponse, RepairPreviewResponse,
} from '../lib/repairEvidence';
import { useT } from '../settings';
import { CwdPicker } from './CwdPicker';

interface RepairEvidenceDialogProps {
  initialSource: string;
  onClose: () => void;
}

function Detail({ label, children }: { label: string; children: ComponentChildren }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

export function RepairEvidenceDialog({ initialSource, onClose }: RepairEvidenceDialogProps) {
  const t = useT();
  const [capability, setCapability] = useState<RepairCapability | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const [sourceInput, setSourceInput] = useState(initialSource);
  const [runInput, setRunInput] = useState('');
  const [outputInput, setOutputInput] = useState('');
  const [info, setInfo] = useState<RepairInfoResponse | null>(null);
  const [inspectedAt, setInspectedAt] = useState('');
  const [preview, setPreview] = useState<RepairPreviewResponse | null>(null);
  const [acceptedDigest, setAcceptedDigest] = useState<string | null>(null);
  const [exported, setExported] = useState<RepairExportResponse | null>(null);
  const [busy, setBusy] = useState<'info' | 'preview' | 'export' | 'native' | null>(null);
  const [error, setError] = useState('');
  const [pickerTarget, setPickerTarget] = useState<'source' | 'run' | null>(null);
  const [showEscaped, setShowEscaped] = useState(false);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const available = capability?.status === 'available';
  const exporting = busy === 'export';
  const summary = useMemo(() => preview ? repairPacketSummary(preview.packet) : null, [preview]);
  const escapedJson = useMemo(
    () => preview && showEscaped ? JSON.stringify(preview.packet, null, 2) : '',
    [preview, showEscaped],
  );
  const cleanPath = (path: string) => stripExtendedPathPrefix(path.trim());

  useEffect(() => {
    let active = true;
    setCapability(null);
    setCapabilityError('');
    getRepairCapability()
      .then((result) => { if (active) setCapability(result); })
      .catch((cause: unknown) => {
        if (active) setCapabilityError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [availabilityAttempt]);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    cardRef.current?.focus();
    return () => {
      mounted.current = false;
      requestSequence.current++;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function currentRequest(sequence: number) {
    return mounted.current && sequence === requestSequence.current;
  }

  function clearReview() {
    requestSequence.current++;
    setPreview(null);
    setAcceptedDigest(null);
    setExported(null);
    setOutputInput('');
    setBusy(null);
    setError('');
    setShowEscaped(false);
  }

  function changeSource(path: string) {
    clearReview();
    setInfo(null);
    setInspectedAt('');
    setSourceInput(path);
  }

  function changeRun(path: string) {
    clearReview();
    setRunInput(path);
  }

  async function inspectSource() {
    clearReview();
    setInfo(null);
    setInspectedAt('');
    const source = cleanPath(sourceInput);
    if (!available || !isAbsoluteRepairPath(source)) {
      setError(t('repair.absoluteRootRequired'));
      return;
    }
    const sequence = ++requestSequence.current;
    setBusy('info');
    try {
      const result = await getRepairInfo(source);
      if (!currentRequest(sequence)) return;
      setInfo(result);
      setInspectedAt(new Date().toLocaleString());
    } catch (cause: unknown) {
      if (currentRequest(sequence)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentRequest(sequence)) setBusy(null);
    }
  }

  async function chooseNativeSource() {
    if (!available || !isLoopbackHost(window.location.hostname)) return;
    clearReview();
    setInfo(null);
    setInspectedAt('');
    const sequence = ++requestSequence.current;
    setBusy('native');
    try {
      const result = await pickNativeDirectory();
      if (!currentRequest(sequence)) return;
      if (!result.canceled && result.path) changeSource(result.path);
      else setError(t('repair.nativeCanceled'));
    } catch (cause: unknown) {
      if (currentRequest(sequence)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentRequest(sequence)) setBusy(null);
    }
  }

  async function loadPreview() {
    clearReview();
    const run = cleanPath(runInput);
    if (!available || !info || !isAbsoluteRepairPath(run)) {
      setError(t('repair.absoluteRunRequired'));
      return;
    }
    const sequence = ++requestSequence.current;
    setBusy('preview');
    try {
      // Refresh live source separately: the frozen packet may intentionally have an older base.
      const freshInfo = await getRepairInfo(info.source_root);
      if (!currentRequest(sequence)) return;
      const result = await getRepairPreview(freshInfo.source_root, run);
      if (!currentRequest(sequence)) return;
      setInfo(freshInfo);
      setInspectedAt(new Date().toLocaleString());
      setPreview(result);
      setRunInput(result.run_root);
    } catch (cause: unknown) {
      if (currentRequest(sequence)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentRequest(sequence)) setBusy(null);
    }
  }

  async function exportPacket() {
    if (!available || !preview || busy) return;
    const sequence = ++requestSequence.current;
    setError('');
    setExported(null);
    setBusy('export');
    try {
      const body = makeRepairExportRequest(preview, acceptedDigest, cleanPath(outputInput));
      const result = await exportRepairPacket(body);
      if (!currentRequest(sequence)) return;
      setExported(result);
      setAcceptedDigest(null);
    } catch (cause: unknown) {
      if (!currentRequest(sequence)) return;
      // A failed export may indicate changed native state; require a fresh full preview.
      setPreview(null);
      setAcceptedDigest(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentRequest(sequence)) setBusy(null);
    }
  }

  function statusLabel(status: RepairCheckStatus) {
    switch (status) {
      case 'checks_passed': return t('repair.statusChecksPassed');
      case 'not_run': return t('repair.statusNotRun');
      case 'failed': return t('repair.statusFailed');
      case 'blocked': return t('repair.statusBlocked');
      case 'timeout': return t('repair.statusTimeout');
      case 'stale_or_invalid': return t('repair.statusStale');
      default: return t('repair.unknown');
    }
  }

  return <>
    <div class="modal-overlay repair-dialog-overlay"
      aria-hidden={pickerTarget ? true : undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget && !exporting) onClose();
      }}>
      <div class="modal-card repair-evidence-card" role="dialog" aria-modal="true"
        aria-labelledby="repair-evidence-title" tabIndex={-1} ref={cardRef}
        onKeyDown={(event) => {
          if (pickerTarget || event.isComposing) return;
          if (event.key === 'Escape' && !exporting) {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), summary, [tabindex="0"]',
          )).filter((item) => item.getClientRects().length > 0);
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}>
        <div class="modal-header">
          <h3 id="repair-evidence-title">{t('repair.title')}</h3>
          <button type="button" class="ghost-btn modal-close" onClick={onClose}
            disabled={exporting} aria-label={t('settings.close')}>×</button>
        </div>
        <div class="modal-body">
          <p class="repair-intro">{t('repair.intro')}</p>
          <p class="field-hint">{t('repair.hostNotice')}</p>
          {!capability && !capabilityError && <p role="status">{t('repair.checkingCapability')}</p>}
          {(capability?.status === 'unavailable' || capabilityError) && (
            <div class="repair-notice" role="status">
              <strong>{t('repair.unavailable')}</strong>
              <p>{t('repair.accessRequired')}</p>
              <p class="repair-error-detail">{capabilityError || capability?.reason}</p>
              <button type="button" class="btn" onClick={() => setAvailabilityAttempt((value) => value + 1)}>
                {t('repair.retry')}
              </button>
            </div>
          )}

          <section class="repair-section">
            <label class="modal-label" htmlFor="repair-source">{t('repair.sourceLabel')}</label>
            <input id="repair-source" class="menu-input repair-path-input" type="text"
              value={sourceInput} disabled={!available || exporting}
              onInput={(event) => changeSource(event.currentTarget.value)}
              aria-describedby="repair-source-hint" />
            <p class="field-hint" id="repair-source-hint">{t('repair.sourceHint')}</p>
            <div class="repair-actions">
              <button type="button" class="btn" disabled={!available || exporting}
                onClick={() => { clearReview(); setPickerTarget('source'); }}>
                {t('repair.browse')}
              </button>
              {isLoopbackHost(window.location.hostname) && (
                <button type="button" class="btn" disabled={!available || !!busy}
                  onClick={chooseNativeSource}>{t('repair.nativePicker')}</button>
              )}
              <button type="button" class="btn btn-primary"
                disabled={!available || !!busy || !isAbsoluteRepairPath(cleanPath(sourceInput))}
                onClick={inspectSource}>
                {busy === 'info' ? t('repair.inspecting') : t('repair.inspect')}
              </button>
            </div>
          </section>

          {info && <>
            <section class="repair-section">
              <h4>{t('repair.sourceHeading')}</h4>
              <p class="field-hint">{inspectedAt}</p>
              <dl class="repair-metadata">
                <Detail label={t('repair.root')}><code>{info.source_root}</code></Detail>
                <Detail label={t('repair.repository')}><code>{info.source.repository}</code></Detail>
                <Detail label={t('repair.commit')}><code>{info.source.commit}</code></Detail>
                <Detail label={t('repair.tree')}><code>{info.source.tree}</code></Detail>
                <Detail label={t('repair.rawDirty')}><code>{String(info.source.dirty)}</code></Detail>
              </dl>
              <p class="field-hint">{t('repair.sourceSnapshotHint')}</p>
            </section>
            <details class="repair-section">
              <summary>{t('repair.buildHeading')}</summary>
              <dl class="repair-metadata">
                <Detail label={t('repair.binaryDigest')}>
                  <code>{info.observer_binary_sha256 || t('repair.unknown')}</code>
                </Detail>
                <Detail label={t('repair.installedMatch')}><code>unknown</code></Detail>
              </dl>
              <pre class="repair-raw" tabIndex={0}>{JSON.stringify(info.observer, null, 2)}</pre>
              <p class="field-hint">{t('repair.buildHint')}</p>
              <p class="field-hint">{info.note}</p>
            </details>
            <details class="repair-section">
              <summary>{t('repair.manualTitle')}</summary>
              <ol class="repair-manual">
                <li>{t('repair.manualSource')} <code>.jeikcode/skills/jeikcode-self-repair/SKILL.md</code></li>
                <li>{t('repair.manualSkill')} <code>jeikcode-self-repair</code></li>
                <li>{t('repair.manualCli')} <code>docs/self-repair.md</code></li>
              </ol>
            </details>
            <section class="repair-section">
              <label class="modal-label" htmlFor="repair-run">{t('repair.runLabel')}</label>
              <input id="repair-run" type="text" class="menu-input repair-path-input"
                value={runInput} disabled={exporting}
                onInput={(event) => changeRun(event.currentTarget.value)}
                aria-describedby="repair-run-hint" />
              <p class="field-hint" id="repair-run-hint">{t('repair.runHint')}</p>
              <div class="repair-actions">
                <button type="button" class="btn" disabled={exporting}
                  onClick={() => { clearReview(); setPickerTarget('run'); }}>{t('repair.browse')}</button>
                <button type="button" class="btn btn-primary"
                  disabled={!!busy || !isAbsoluteRepairPath(cleanPath(runInput))}
                  onClick={loadPreview}>
                  {busy === 'preview' ? t('repair.loadingPreview') : t('repair.loadPreview')}
                </button>
              </div>
            </section>
          </>}

          {error && <p class="repair-error-detail" role="alert">{error}</p>}

          {preview && summary && <>
            <section class="repair-section">
              <h4>{t('repair.packetHeading')}</h4>
              <dl class="repair-metadata">
                <Detail label={t('repair.root')}><code>{preview.source_root}</code></Detail>
                <Detail label={t('repair.runLabel')}><code>{preview.run_root}</code></Detail>
                <Detail label={t('repair.runId')}><code>{summary.runId || t('repair.unknown')}</code></Detail>
                <Detail label={t('repair.baseCommit')}><code>{summary.baseCommit || t('repair.unknown')}</code></Detail>
                <Detail label={t('repair.baseTree')}><code>{summary.baseTree || t('repair.unknown')}</code></Detail>
                <Detail label={t('repair.candidateStatus')}><code>{summary.candidateStatus}</code></Detail>
                <Detail label={t('repair.baselineProbe')}>{statusLabel(summary.baseline)}</Detail>
                <Detail label={t('repair.candidateProbe')}>{statusLabel(summary.candidate)}</Detail>
                <Detail label={t('repair.installedRuntime')}><code>{summary.installedRuntime}</code></Detail>
                <Detail label="SHA-256"><code>{preview.packet.sha256}</code></Detail>
              </dl>
              <p class="field-hint">{t('repair.verificationHint')}</p>
            </section>
            <section class="repair-section">
              <h4>{t('repair.fullPreview')}</h4>
              <p class="field-hint">{t('repair.previewHint')}</p>
              {REPAIR_PACKET_FILES.map((name) => (
                <details class="repair-file" key={name} open>
                  <summary><code>{name}</code></summary>
                  <pre class="repair-raw" tabIndex={0} aria-label={name}>{preview.packet.files[name]}</pre>
                </details>
              ))}
              <details class="repair-file" open={showEscaped}
                onToggle={(event) => setShowEscaped(event.currentTarget.open)}>
                <summary>{t('repair.escapedJson')}</summary>
                {showEscaped && <pre class="repair-raw" tabIndex={0}>{escapedJson}</pre>}
              </details>
            </section>
            <section class="repair-section">
              <label class="repair-accept">
                <input type="checkbox" disabled={exporting}
                  checked={acceptedDigest === preview.packet.sha256}
                  onChange={(event) => {
                    setAcceptedDigest(event.currentTarget.checked ? preview.packet.sha256 : null);
                    setExported(null);
                  }} />
                <span>{t('repair.acceptDigest')} <code>{preview.packet.sha256}</code></span>
              </label>
              <label class="modal-label" htmlFor="repair-output">{t('repair.outputLabel')}</label>
              <input id="repair-output" type="text" class="menu-input repair-path-input"
                value={outputInput} disabled={exporting}
                onInput={(event) => { setOutputInput(event.currentTarget.value); setExported(null); }}
                aria-describedby="repair-output-hint" />
              <p class="field-hint" id="repair-output-hint">{t('repair.outputHint')}</p>
              <button type="button" class="btn btn-primary repair-export-button"
                disabled={!!busy || acceptedDigest !== preview.packet.sha256 ||
                  !isAbsoluteRepairPath(cleanPath(outputInput))}
                onClick={exportPacket}>
                {exporting ? t('repair.exporting') : t('repair.exportLocal')}
              </button>
            </section>
          </>}
          {exported && <div class="repair-notice" role="status">
            <strong>{t('repair.exported')}</strong>
            <p><code>{exported.output}</code></p>
            <p>SHA-256: <code>{exported.sha256}</code></p>
          </div>}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={onClose} disabled={exporting}>
            {t('settings.close')}
          </button>
        </div>
      </div>
    </div>
    {pickerTarget && <CwdPicker selectionOnly
      current={(pickerTarget === 'source' ? sourceInput : runInput) || info?.source_root || '~'}
      title={pickerTarget === 'source' ? t('repair.sourceLabel') : t('repair.runLabel')}
      onPick={(path) => pickerTarget === 'source' ? changeSource(path) : changeRun(path)}
      onClose={() => setPickerTarget(null)} />}
  </>;
}
