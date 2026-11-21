import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import {
  ApprovalMode,
  ProjectInfo,
  ScheduleRule,
  ScheduleTask,
  ScheduleUpsertPayload,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  runScheduleNow,
  sendScheduleAiDialog,
  pickNativeDirectory,
} from '../api';
import { useT } from '../settings';
import { Select, SelectOption } from './Select';
import { ModeSelector } from './ModeSelector';
import { ModelSelector } from './ModelSelector';
import { Markdown } from './Markdown';
import { CwdPicker } from './CwdPicker';
import { ConfirmDialog } from './ConfirmDialog';
import { getPageZoom } from '../lib/pageZoom';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { isLoopbackHost, stripExtendedPathPrefix } from '../lib/displayPath';
import {
  ScheduleAiThread,
  listScheduleAiThreads,
  getActiveScheduleAiThread,
  createScheduleAiThread,
  selectScheduleAiThread,
  appendScheduleAiMessage,
  setScheduleAiThreadModel,
  removeScheduleAiThread,
} from '../lib/scheduleChatStore';

export type ScheduleEditorMode = 'calendar' | 'interval' | 'ai';
export type DayPreset = 'everyday' | 'weekdays' | 'custom_week' | 'specific_dates';
export type IntervalUnit = 'minutes' | 'hours' | 'days';
export type SchedulePermissionMode = 'auto' | 'accept_edits' | 'plan' | 'build';

interface ScheduleFormState {
  id: string | null;
  title: string;
  prompt: string;
  cwd: string;
  enabled: boolean;
  oneShot: boolean;
  sessionMode: 'isolated' | 'reuse';
  overlapPolicy: 'skip' | 'queue';
  permissionMode: SchedulePermissionMode;
  model: string | null;
  mode: ScheduleEditorMode;
  dayPreset: DayPreset;
  weekdays: number[];
  dates: string[];
  times: string[];
  intervalValue: number;
  intervalUnit: IntervalUnit;
  reuseSessionId: string | null;
}

function sanitizeSchedulePermissionMode(raw?: string | null): SchedulePermissionMode {
  const clean = (raw || '').trim();
  if (clean === 'build' || clean === 'plan' || clean === 'accept_edits') return clean;
  return 'auto';
}

function toApprovalMode(mode: SchedulePermissionMode): ApprovalMode {
  return mode === 'auto' ? 'bypass' : mode;
}

function fromApprovalMode(mode: ApprovalMode): SchedulePermissionMode {
  return mode === 'bypass' ? 'auto' : mode;
}

/** 复用侧栏项目文件夹（资源管理器）图标，代表独立选择任务工作区。 */
function ScheduleFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

interface ScheduleDialogProps {
  projects: ProjectInfo[];
  currentCwd: string;
  onClose: () => void;
}

function normalizeDir(p: string): string {
  return stripExtendedPathPrefix(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function formatEpoch(ts: number | null | undefined, emptyLabel: string): string {
  if (!ts) return emptyLabel;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function deriveDayPreset(dates: string[], weekdays: number[]): DayPreset {
  if (dates.length > 0) return 'specific_dates';
  if (weekdays.length === 0) return 'everyday';
  const sorted = [...weekdays].sort((a, b) => a - b);
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) {
    return 'weekdays';
  }
  return 'custom_week';
}

function decomposeInterval(minutes: number): { value: number; unit: IntervalUnit } {
  const safe = Math.max(1, minutes || 60);
  if (safe % 1440 === 0) return { value: safe / 1440, unit: 'days' };
  if (safe % 60 === 0) return { value: safe / 60, unit: 'hours' };
  return { value: safe, unit: 'minutes' };
}

function taskToFormState(task: ScheduleTask): ScheduleFormState {
  let mode: ScheduleEditorMode = 'calendar';
  let dayPreset: DayPreset = 'everyday';
  let weekdays: number[] = [];
  let dates: string[] = [];
  let times: string[] = ['09:00'];
  let intervalValue = 60;
  let intervalUnit: IntervalUnit = 'minutes';

  const s = task.schedule;
  if (s.kind === 'interval') {
    mode = 'interval';
    const dec = decomposeInterval(s.every_minutes);
    intervalValue = dec.value;
    intervalUnit = dec.unit;
  } else if (s.kind === 'hourly') {
    mode = 'interval';
    intervalValue = 1;
    intervalUnit = 'hours';
  } else if (s.kind === 'daily') {
    mode = 'calendar';
    dayPreset = 'everyday';
    times = s.time ? [s.time] : ['09:00'];
  } else if (s.kind === 'weekly') {
    mode = 'calendar';
    dayPreset = 'custom_week';
    weekdays = [s.weekday];
    times = s.time ? [s.time] : ['09:00'];
  } else if (s.kind === 'calendar') {
    mode = 'calendar';
    dates = [...(s.dates || [])];
    weekdays = [...(s.weekdays || [])];
    times = s.times && s.times.length > 0 ? [...s.times] : ['09:00'];
    dayPreset = deriveDayPreset(dates, weekdays);
  }

  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd || '',
    enabled: task.enabled,
    oneShot: Boolean(task.one_shot),
    sessionMode: task.session_mode === 'reuse' ? 'reuse' : 'isolated',
    overlapPolicy: task.overlap_policy === 'queue' ? 'queue' : 'skip',
    permissionMode: sanitizeSchedulePermissionMode(task.permission_mode),
    model: task.model || null,
    mode,
    dayPreset,
    weekdays,
    dates,
    times,
    intervalValue,
    intervalUnit,
    reuseSessionId: task.reuse_session_id || null,
  };
}

function createEmptyForm(defaultCwd: string, defaultModel: string | null = null): ScheduleFormState {
  return {
    id: null,
    title: '',
    prompt: '',
    cwd: defaultCwd,
    enabled: true,
    oneShot: false,
    sessionMode: 'isolated',
    overlapPolicy: 'skip',
    // 定时任务默认选用 auto 模式，新建与打开弹窗默认进入 AI 智能设定
    permissionMode: 'auto',
    model: defaultModel,
    mode: 'ai',
    dayPreset: 'everyday',
    weekdays: [1, 2, 3, 4, 5],
    dates: [],
    times: ['09:00'],
    intervalValue: 30,
    intervalUnit: 'minutes',
    reuseSessionId: null,
  };
}

export function ScheduleDialog({ projects, currentCwd, onClose }: ScheduleDialogProps) {
  const t = useT();
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ScheduleTask | null>(null);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);

  const defaultWorkspace = useMemo(() => {
    if (currentCwd && currentCwd.trim()) return currentCwd.trim();
    return projects[0]?.working_dir || '';
  }, [currentCwd, projects]);

  const [form, setForm] = useState<ScheduleFormState>(() => createEmptyForm(defaultWorkspace));
  const [newTimeInput, setNewTimeInput] = useState('09:00');
  const [newDateInput, setNewDateInput] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // AI 内存对话区状态
  const [aiThreads, setAiThreads] = useState<ScheduleAiThread[]>(() => listScheduleAiThreads());
  const [activeThread, setActiveThread] = useState<ScheduleAiThread>(() => getActiveScheduleAiThread());
  const [aiInput, setAiInput] = useState('');
  const [aiSending, setAiSending] = useState(false);
  const aiMessagesEndRef = useRef<HTMLDivElement>(null);

  const toastTimerRef = useRef<number | null>(null);
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  };

  // 遮罩点击保护：拖拽文本框滑出弹窗绝不误关
  const backdropDismiss = useBackdropDismiss(onClose);

  // 视口缩放补偿，对齐 GitWebhookDialog 自适应风格
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1200,
    h: typeof window !== 'undefined' ? window.innerHeight : 900,
    zoom: getPageZoom(),
  }));

  useEffect(() => {
    const updateVp = () => setVp({ w: window.innerWidth, h: window.innerHeight, zoom: getPageZoom() });
    window.addEventListener('resize', updateVp);
    window.addEventListener('jeikcode:zoom-changed', updateVp);
    return () => {
      window.removeEventListener('resize', updateVp);
      window.removeEventListener('jeikcode:zoom-changed', updateVp);
    };
  }, []);

  const modalAdaptiveStyle = useMemo(() => {
    const z = vp.zoom || 1;
    const availW = Math.max(320, vp.w / z - 32);
    const availH = Math.max(400, vp.h / z - 32);
    const w = Math.min(980, availW);
    const h = Math.min(860, availH);
    return {
      width: `${Math.round(w)}px`,
      maxWidth: `${Math.round(availW)}px`,
      height: `${Math.round(h)}px`,
      maxHeight: `${Math.round(availH)}px`,
    };
  }, [vp]);

  const reloadTasks = async (preferredSelectId?: string | null) => {
    try {
      const list = await listSchedules();
      setTasks(list);
      if (preferredSelectId) {
        const hit = list.find((item) => item.id === preferredSelectId);
        if (hit) setForm(taskToFormState(hit));
      } else {
        setForm((cur) => {
          if (!cur.id) return cur;
          const updated = list.find((item) => item.id === cur.id);
          return updated ? cur : (list[0] ? taskToFormState(list[0]) : createEmptyForm(defaultWorkspace));
        });
      }
    } catch {
      // ignore initial error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    listSchedules()
      .then((list) => {
        setTasks(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const onUpdated = () => {
      void reloadTasks();
    };
    window.addEventListener('jeikcode:schedules_updated', onUpdated);
    return () => window.removeEventListener('jeikcode:schedules_updated', onUpdated);
  }, []);

  useEffect(() => {
    // 空会话不自动滚到底部，否则会把空状态标题挤出可视区；仅在有消息时跟随最新回复。
    if (form.mode === 'ai' && activeThread.messages.length > 0) {
      aiMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeThread.messages.length, aiSending, form.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cwdPickerOpen && !confirmDelete) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cwdPickerOpen, confirmDelete, onClose]);

  const currentEditingTask = useMemo(
    () => (form.id ? tasks.find((item) => item.id === form.id) ?? null : null),
    [form.id, tasks],
  );

  const summarizeSchedule = (task: ScheduleTask): string => {
    const s = task.schedule;
    if (s.kind === 'interval') {
      const dec = decomposeInterval(s.every_minutes);
      const u =
        dec.unit === 'days'
          ? t('schedules.unitDays')
          : dec.unit === 'hours'
          ? t('schedules.unitHours')
          : t('schedules.unitMinutes');
      return `${t('schedules.intervalEvery')} ${dec.value} ${u}`;
    }
    if (s.kind === 'hourly') return `1 ${t('schedules.unitHours')}`;
    if (s.kind === 'daily') return `${t('schedules.dayEveryday')} · ${s.time}`;
    if (s.kind === 'weekly') return s.time;
    if (s.kind === 'cron') return s.expr;
    const times = (s.times || []).join(', ');
    if ((s.dates || []).length > 0) return `${s.dates[0]}${s.dates.length > 1 ? ` +${s.dates.length - 1}` : ''} · ${times}`;
    if ((s.weekdays || []).length === 5 && [1, 2, 3, 4, 5].every((d) => s.weekdays.includes(d))) {
      return `${t('schedules.dayWeekdays')} · ${times}`;
    }
    if ((s.weekdays || []).length === 0) return `${t('schedules.dayEveryday')} · ${times}`;
    return times;
  };

  // 工作区下拉选项：包含现有侧边栏项目 + 如果当前任务绑定了一个独立工作区路径则额外回显但不进入侧栏
  const workspaceOptions: SelectOption<string>[] = useMemo(() => {
    const opts: SelectOption<string>[] = [];
    const seen = new Set<string>();
    for (const p of projects) {
      if (!p.working_dir) continue;
      seen.add(normalizeDir(p.working_dir));
      opts.push({
        value: p.working_dir,
        selectedLabel: (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, width: '100%' }}>
            <strong style={{ color: 'var(--app-primary-foreground)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {p.name || p.working_dir}
            </strong>
            <span class="git-input-hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {p.working_dir}
            </span>
          </div>
        ),
        label: (
          <div class="git-select-rich-option">
            <div class="git-select-rich-top">
              <span class="git-select-rich-title">{p.name || p.working_dir}</span>
            </div>
            <span class="git-select-rich-desc" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {p.working_dir}
            </span>
          </div>
        ),
      });
    }
    if (form.cwd && !seen.has(normalizeDir(form.cwd))) {
      opts.unshift({
        value: form.cwd,
        selectedLabel: (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span class="git-channel-status-badge active">{t('schedules.workspaceIsolatedTag')}</span>
            <span style={{ fontFamily: 'monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {form.cwd}
            </span>
          </div>
        ),
        label: (
          <div class="git-select-rich-option">
            <div class="git-select-rich-top">
              <span class="git-select-rich-title">{form.cwd}</span>
              <span class="git-channel-status-badge active">{t('schedules.workspaceIsolatedTag')}</span>
            </div>
            <span class="git-select-rich-desc">{t('schedules.workspaceIsolatedHint')}</span>
          </div>
        ),
      });
    }
    return opts;
  }, [projects, form.cwd, t]);

  const modeTabs: Array<{ value: ScheduleEditorMode; label: string; desc: string; badge?: string }> = useMemo(() => [
    { value: 'ai', label: t('schedules.modeAi'), desc: t('schedules.modeAiDesc'), badge: 'AI' },
    { value: 'calendar', label: t('schedules.modeCalendar'), desc: t('schedules.modeCalendarDesc') },
    { value: 'interval', label: t('schedules.modeInterval'), desc: t('schedules.modeIntervalDesc') },
  ], [t]);

  const intervalUnitOptions: SelectOption<IntervalUnit>[] = useMemo(() => [
    { value: 'minutes', label: t('schedules.unitMinutes') },
    { value: 'hours', label: t('schedules.unitHours') },
    { value: 'days', label: t('schedules.unitDays') },
  ], [t]);

  const weekdayMeta = useMemo(() => [
    { val: 1, label: t('schedules.mon') },
    { val: 2, label: t('schedules.tue') },
    { val: 3, label: t('schedules.wed') },
    { val: 4, label: t('schedules.thu') },
    { val: 5, label: t('schedules.fri') },
    { val: 6, label: t('schedules.sat') },
    { val: 7, label: t('schedules.sun') },
  ], [t]);

  // 弹出工作区选择器：本地回环直接呼起原生目录选择器，异地/失败时呼起 CwdPicker (仅赋值给任务本身，绝不写入侧栏)
  const handlePickIsolatedWorkspace = async () => {
    if (!isLoopbackHost(window.location.hostname)) {
      setCwdPickerOpen(true);
      return;
    }
    try {
      const res = await pickNativeDirectory();
      if (!res.canceled && res.path) {
        setForm((prev) => ({ ...prev, cwd: stripExtendedPathPrefix(res.path!) }));
      }
    } catch {
      setCwdPickerOpen(true);
    }
  };

  const handleAddTimePoint = () => {
    const clean = newTimeInput.trim();
    if (!/^\d{2}:\d{2}$/.test(clean)) return;
    setForm((prev) => {
      if (prev.times.includes(clean)) return prev;
      return { ...prev, times: [...prev.times, clean].sort() };
    });
  };

  const handleAddSpecificDate = () => {
    const clean = newDateInput.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return;
    setForm((prev) => {
      if (prev.dates.includes(clean)) return prev;
      return { ...prev, dates: [...prev.dates, clean].sort() };
    });
  };

  const handleDayPresetChange = (preset: DayPreset) => {
    setForm((prev) => {
      if (preset === 'everyday') return { ...prev, dayPreset: preset, weekdays: [], dates: [] };
      if (preset === 'weekdays') return { ...prev, dayPreset: preset, weekdays: [1, 2, 3, 4, 5], dates: [] };
      if (preset === 'custom_week') {
        return {
          ...prev,
          dayPreset: preset,
          weekdays: prev.weekdays.length > 0 ? prev.weekdays : [1],
          dates: [],
        };
      }
      return {
        ...prev,
        dayPreset: preset,
        weekdays: [],
        dates: prev.dates.length > 0 ? prev.dates : [newDateInput],
      };
    });
  };

  const toggleWeekday = (wd: number) => {
    setForm((prev) => {
      const exists = prev.weekdays.includes(wd);
      const next = exists ? prev.weekdays.filter((d) => d !== wd) : [...prev.weekdays, wd].sort((a, b) => a - b);
      return { ...prev, weekdays: next };
    });
  };

  const handleSave = async () => {
    const title = form.title.trim();
    const prompt = form.prompt.trim();
    if (!title || !prompt) {
      showToast(t('schedules.validationTitlePrompt'), 'error');
      return;
    }

    let scheduleRule: ScheduleRule;
    if (form.mode === 'interval') {
      const mul = form.intervalUnit === 'days' ? 1440 : form.intervalUnit === 'hours' ? 60 : 1;
      scheduleRule = { kind: 'interval', every_minutes: Math.max(1, form.intervalValue || 1) * mul };
    } else {
      if (form.times.length === 0) {
        showToast(t('schedules.validationTimeRequired'), 'error');
        return;
      }
      let dates: string[] = [];
      let weekdays: number[] = [];
      if (form.dayPreset === 'weekdays') {
        weekdays = [1, 2, 3, 4, 5];
      } else if (form.dayPreset === 'custom_week') {
        if (form.weekdays.length === 0) {
          showToast(t('schedules.validationWeekdayRequired'), 'error');
          return;
        }
        weekdays = form.weekdays;
      } else if (form.dayPreset === 'specific_dates') {
        if (form.dates.length === 0) {
          showToast(t('schedules.validationDateRequired'), 'error');
          return;
        }
        dates = form.dates;
      }
      scheduleRule = {
        kind: 'calendar',
        dates,
        weekdays,
        times: form.times,
      };
    }

    const payload: ScheduleUpsertPayload = {
      title,
      prompt,
      cwd: form.cwd || defaultWorkspace,
      schedule: scheduleRule,
      permission_mode: form.permissionMode || 'auto',
      enabled: form.enabled,
      one_shot: form.oneShot,
      session_mode: form.sessionMode,
      reuse_session_id: form.sessionMode === 'reuse' ? form.reuseSessionId : null,
      model: form.model || null,
      overlap_policy: form.overlapPolicy,
    };

    setSaving(true);
    try {
      const saved = form.id
        ? await updateSchedule(form.id, payload)
        : await createSchedule(payload);
      await reloadTasks(saved.id);
      showToast(t('schedules.saveSuccess'), 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickToggle = async (task: ScheduleTask, e: MouseEvent) => {
    e.stopPropagation();
    try {
      const updated = await toggleSchedule(task.id, !task.enabled);
      setTasks((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      if (form.id === updated.id) {
        setForm((prev) => ({ ...prev, enabled: updated.enabled }));
      }
      showToast(updated.enabled ? t('schedules.toggleOn') : t('schedules.toggleOff'), 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRunNow = async () => {
    if (!form.id || runningNow) return;
    setRunningNow(true);
    try {
      const updated = await runScheduleNow(form.id);
      await reloadTasks(updated.id);
      showToast(t('schedules.runTriggered'), 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRunningNow(false);
    }
  };

  const handleSendAiPrompt = async (overrideText?: string) => {
    const content = (overrideText ?? aiInput).trim();
    if (!content || aiSending) return;

    const updatedThread = appendScheduleAiMessage(activeThread.id, {
      role: 'user',
      content,
    });
    setActiveThread(updatedThread);
    setAiThreads(listScheduleAiThreads());
    if (!overrideText) setAiInput('');
    setAiSending(true);

    try {
      const apiMessages = updatedThread.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const res = await sendScheduleAiDialog({
        messages: apiMessages,
        model: updatedThread.model,
        cwd: form.cwd || defaultWorkspace,
      });
      const replyThread = appendScheduleAiMessage(updatedThread.id, {
        role: 'assistant',
        content: res.reply || (res.created_tasks.length > 0 ? t('schedules.aiCreatedCardTitle') : ''),
        createdTasks: res.created_tasks,
      });
      setActiveThread(replyThread);
      setAiThreads(listScheduleAiThreads());

      if (res.created_tasks && res.created_tasks.length > 0) {
        const list = await listSchedules();
        setTasks(list);
      }
    } catch (err: unknown) {
      const errThread = appendScheduleAiMessage(updatedThread.id, {
        role: 'assistant',
        content: err instanceof Error ? err.message : String(err),
        error: true,
      });
      setActiveThread(errThread);
      setAiThreads(listScheduleAiThreads());
    } finally {
      setAiSending(false);
    }
  };

  const renderStatusLabel = (status?: string | null) => {
    if (!status) return t('schedules.neverRun');
    if (status === 'running') return t('schedules.running');
    if (status === 'ok') return t('schedules.statusOk');
    if (status === 'error') return t('schedules.statusError');
    if (status === 'stopped') return t('schedules.statusStopped');
    if (status === 'queued') return t('schedules.statusQueued');
    return status;
  };

  /** 映射任务最近一次执行状态对应的语义徽标类名。 */
  const statusBadgeClass = (status?: string | null): string => {
    if (status === 'ok') return 'ok';
    if (status === 'error') return 'err';
    if (status === 'running' || status === 'queued') return 'running';
    if (status === 'stopped') return 'warn';
    return '';
  };

  return (
    <div class="modal-overlay git-webhook-modal-overlay" {...backdropDismiss}>
      <div
        class="modal-card modal-card-lg git-webhook-modal-card schedule-modal-card"
        style={modalAdaptiveStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="schedule-dialog-title"
      >
        {/* 顶部 Header */}
        <div class="modal-header git-webhook-header">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={{ flexShrink: 0, color: 'var(--app-primary-foreground)' }}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15.5 14" />
          </svg>
          <div class="git-header-text-wrap">
            <h3 id="schedule-dialog-title">
              <span>{t('schedules.dialogTitle')}</span>
              <span class="git-badge-tag">{t('schedules.dialogTag')}</span>
            </h3>
            <span class="modal-sub">{t('schedules.dialogSub')}</span>
          </div>
          <button type="button" class="modal-close" onClick={onClose} aria-label={t('common.dismiss')}>
            ✕
          </button>
        </div>

        {/* 主体双栏内容 */}
        <div class={`modal-body git-webhook-body schedule-modal-body${form.mode === 'ai' ? ' schedule-ai-mode' : ''}`}>
          {/* 左侧：独立定时任务列表 */}
          <aside class="schedule-sidebar">
            <div class="schedule-sidebar-head">
              <span class="git-section-title" style={{ margin: 0 }}>{t('schedules.taskListHeader')}</span>
              <button
                type="button"
                class="git-token-calc-btn schedule-new-btn"
                onClick={() => setForm(createEmptyForm(defaultWorkspace))}
              >
                {t('schedules.newTask')}
              </button>
            </div>

            <div class="schedule-task-list">
              {loading && tasks.length === 0 && (
                <div class="schedule-empty-box">{t('sidebar.loading')}</div>
              )}
              {!loading && tasks.length === 0 && (
                <div class="schedule-empty-box">
                  <strong>{t('schedules.emptyTasks')}</strong>
                  <span>{t('schedules.emptyHint')}</span>
                </div>
              )}
              {tasks.map((item) => {
                const isSelected = form.id === item.id && form.mode !== 'ai';
                const isRunning = item.last_status === 'running';
                return (
                  <div
                    key={item.id}
                    class={'schedule-task-card' + (isSelected ? ' active' : '') + (!item.enabled ? ' is-disabled' : '')}
                    onClick={() => setForm(taskToFormState(item))}
                  >
                    <div class="schedule-task-card-top">
                      <span class="schedule-task-card-title" title={item.title}>
                        {item.title}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={item.enabled}
                        class={'schedule-mini-switch' + (item.enabled ? ' active' : '')}
                        onClick={(e) => void handleQuickToggle(item, e as unknown as MouseEvent)}
                        title={item.enabled ? t('schedules.toggleOn') : t('schedules.toggleOff')}
                      >
                        <span class="schedule-mini-switch-thumb" />
                      </button>
                    </div>
                    <div class="schedule-task-card-meta">
                      <span>{summarizeSchedule(item)}</span>
                    </div>
                    <div class="schedule-task-card-badges">
                      {item.one_shot && <span class="schedule-pill-badge warn">{t('schedules.oneShotLabel').split('（')[0].split(' (')[0]}</span>}
                      <span class="schedule-pill-badge">
                        {item.session_mode === 'reuse' ? t('schedules.sessionModeReuse') : t('schedules.sessionModeIsolated')}
                      </span>
                      {isRunning ? (
                        <span class="schedule-pill-badge running">
                          <span class="session-item-running" style={{ marginRight: '4px' }} />
                          {t('schedules.running')}
                        </span>
                      ) : item.last_status ? (
                        <span class={'schedule-pill-badge ' + statusBadgeClass(item.last_status)}>
                          {renderStatusLabel(item.last_status)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>

          {/* 右侧：规则编辑区 / AI 对话区 */}
          <section class="schedule-main">
            {/* 顶部对称分段模式切换器 */}
            <div class="schedule-mode-bar">
              <span class="schedule-mode-bar-label">{t('schedules.modeLabel')}</span>
              <div class="schedule-mode-segmented" role="tablist" aria-label={t('schedules.modeLabel')}>
                {modeTabs.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={form.mode === tab.value}
                    class={`schedule-mode-tab ${form.mode === tab.value ? 'active' : ''}`}
                    title={tab.desc}
                    onClick={() => setForm((prev) => ({ ...prev, mode: tab.value }))}
                  >
                    <span>{tab.label}</span>
                    {tab.badge && <span class="schedule-mode-pill-badge">{tab.badge}</span>}
                  </button>
                ))}
              </div>
            </div>

            {form.mode === 'ai' ? (
              /* ========== AI 智能设置对话区（纯内存上下文 + 专属隔离工具） ========== */
              <div class="schedule-ai-pane">
                <div class="schedule-ai-topbar">
                  <div class="schedule-ai-thread-tabs">
                    {aiThreads.map((th) => (
                      <div
                        key={th.id}
                        class={'schedule-ai-tab' + (th.id === activeThread.id ? ' active' : '')}
                        onClick={() => setActiveThread(selectScheduleAiThread(th.id))}
                      >
                        <span>{t('schedules.aiThreadPrefix')} #{th.seq}</span>
                        {aiThreads.length > 1 && (
                          <button
                            type="button"
                            class="schedule-ai-tab-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = removeScheduleAiThread(th.id);
                              setActiveThread(next);
                              setAiThreads(listScheduleAiThreads());
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      class="git-aux-btn"
                      style={{ height: '28px', fontSize: '11.5px', padding: '0 8px' }}
                      onClick={() => {
                        const created = createScheduleAiThread(activeThread.model);
                        setActiveThread(created);
                        setAiThreads(listScheduleAiThreads());
                      }}
                    >
                      {t('schedules.aiNewChat')}
                    </button>
                  </div>
                  <span class="git-badge-tag">{t('schedules.aiMemoryBadge')}</span>
                </div>

                <div class="schedule-ai-messages">
                  {activeThread.messages.length === 0 ? (
                    <div class="schedule-ai-empty">
                      <strong>{t('schedules.aiEmptyTitle')}</strong>
                      <p>{t('schedules.aiEmptyDesc')}</p>
                      <div class="schedule-ai-examples">
                        {[t('schedules.aiExample1'), t('schedules.aiExample2'), t('schedules.aiExample3')].map((ex, idx) => (
                          <button
                            key={idx}
                            type="button"
                            class="git-capsule-btn schedule-ai-example-chip"
                            onClick={() => void handleSendAiPrompt(ex)}
                          >
                            {ex}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      {activeThread.messages.map((msg) => (
                        <div key={msg.id} class={'schedule-ai-msg ' + msg.role + (msg.error ? ' error' : '')}>
                          <div class="schedule-ai-msg-bubble">
                            {msg.role === 'assistant' && !msg.error ? (
                              msg.content ? (
                                <div class="schedule-ai-msg-markdown">
                                  <Markdown
                                    content={msg.content}
                                    cwd={form.cwd || defaultWorkspace}
                                    targetContext="chat"
                                  />
                                </div>
                              ) : null
                            ) : (
                              <div class="schedule-ai-msg-text">{msg.content}</div>
                            )}
                            {msg.createdTasks && msg.createdTasks.length > 0 && (
                              <div class="schedule-ai-created-list">
                                {msg.createdTasks.map((ct) => (
                                  <div key={ct.id} class="schedule-ai-created-card">
                                    <div class="schedule-ai-created-head">
                                      <span>✅ {t('schedules.aiCreatedCardTitle')}</span>
                                      <span class="git-channel-status-badge active">{ct.permission_mode.toUpperCase()}</span>
                                    </div>
                                    <div class="schedule-ai-created-body">
                                      <strong>{ct.title}</strong>
                                      <span>{summarizeSchedule(ct)} · {ct.cwd}</span>
                                    </div>
                                    <button
                                      type="button"
                                      class="git-text-action-btn"
                                      onClick={() => setForm(taskToFormState(ct))}
                                    >
                                      {t('schedules.aiInspectTask')}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {aiSending && (
                        <div class="schedule-ai-msg assistant">
                          <div class="schedule-ai-msg-bubble schedule-ai-thinking">
                            <span class="session-item-running" />
                            <span>{t('schedules.aiSending')}</span>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  <div ref={aiMessagesEndRef} />
                </div>

                <div class="schedule-ai-composer">
                  {/* 目标工作区独占一行，完整展示路径并配备资源管理器图标 */}
                  <div class="schedule-ai-workspace-row">
                    <span class="schedule-ai-workspace-label">{t('schedules.workspaceLabel')}</span>
                    <div class="schedule-ai-cwd-pill" title={form.cwd || defaultWorkspace}>
                      <span class="schedule-ai-cwd-path">{form.cwd || defaultWorkspace}</span>
                    </div>
                    <button
                      type="button"
                      class="schedule-folder-picker-btn"
                      onClick={handlePickIsolatedWorkspace}
                      title={t('schedules.addWorkspaceBtn')}
                      aria-label={t('schedules.addWorkspaceBtn')}
                    >
                      <ScheduleFolderIcon />
                    </button>
                  </div>

                  {/* 输入框 */}
                  <textarea
                    class="git-textarea schedule-ai-textarea"
                    rows={2}
                    placeholder={t('schedules.aiInputPlaceholder')}
                    value={aiInput}
                    disabled={aiSending}
                    onInput={(e) => setAiInput((e.target as HTMLTextAreaElement).value)}
                    onKeyDown={(e) => {
                      if (e.isComposing) return;
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleSendAiPrompt();
                      }
                    }}
                  />

                  {/* 底栏：左侧模型与思考强度，右侧发送按钮 */}
                  <div class="schedule-ai-bottom-bar">
                    <div class="git-model-selector-wrapper">
                      <ModelSelector
                        value={activeThread.model}
                        onChange={(m) => {
                          setScheduleAiThreadModel(activeThread.id, m);
                          setActiveThread((prev) => ({ ...prev, model: m }));
                        }}
                        direction="up"
                      />
                    </div>
                    <button
                      type="button"
                      class="git-save-btn schedule-ai-send-btn"
                      disabled={aiSending || !aiInput.trim()}
                      onClick={() => void handleSendAiPrompt()}
                    >
                      {aiSending ? t('schedules.aiSending') : t('schedules.aiSend')}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* ========== 手动配置表单（指定时间 / 间隔周期） ========== */
              <div class="schedule-form-scroll">
                {/* 总启用开关 Hero 横幅 */}
                <div
                  class={`git-enable-hero-banner ${form.enabled ? 'is-enabled' : 'is-disabled'}`}
                  onClick={() => setForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
                >
                  <div class="git-enable-hero-left">
                    <div class={`git-enable-toggle-core ${form.enabled ? 'active' : ''}`} aria-hidden="true">
                      <span class="git-enable-toggle-thumb" />
                    </div>
                    <div class="git-enable-hero-text">
                      <span class="git-enable-hero-desc">{t('schedules.enableHeroDesc')}</span>
                    </div>
                  </div>
                </div>

                {/* 对称运行时间摘要双列卡片 */}
                {currentEditingTask && (
                  <div class="schedule-run-summary-grid">
                    <div class="schedule-run-stat-card">
                      <span class="schedule-run-stat-label">{t('schedules.nextRun')}</span>
                      <div class="schedule-run-stat-value-row">
                        <span class="schedule-run-stat-value">
                          {formatEpoch(currentEditingTask.next_run_at, '—')}
                        </span>
                      </div>
                    </div>
                    <div class="schedule-run-stat-card">
                      <span class="schedule-run-stat-label">{t('schedules.lastRun')}</span>
                      <div class="schedule-run-stat-value-row">
                        {currentEditingTask.last_run_at ? (
                          <span class="schedule-run-stat-value">
                            {formatEpoch(currentEditingTask.last_run_at, '—')}
                          </span>
                        ) : !currentEditingTask.last_status ? (
                          <span class="schedule-run-stat-muted">{t('schedules.neverRun')}</span>
                        ) : null}
                        {currentEditingTask.last_status && (
                          <span class={'schedule-pill-badge ' + statusBadgeClass(currentEditingTask.last_status)}>
                            {renderStatusLabel(currentEditingTask.last_status)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* 第 1 区：基本信息与提示词 */}
                <div class="git-form-section">
                  <div class="git-section-title">1. {t('schedules.secBasicTitle')}</div>
                  <div class="git-form-item">
                    <label class="git-form-label">
                      {t('schedules.titleLabel')} <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="text"
                      class="git-input"
                      placeholder={t('schedules.titlePlaceholder')}
                      value={form.title}
                      onInput={(e) => setForm((prev) => ({ ...prev, title: (e.target as HTMLInputElement).value }))}
                    />
                  </div>
                  <div class="git-form-item">
                    <label class="git-form-label">
                      {t('schedules.promptLabel')} <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <textarea
                      class="git-textarea"
                      rows={4}
                      style={{ minHeight: '96px' }}
                      placeholder={t('schedules.promptPlaceholder')}
                      value={form.prompt}
                      onInput={(e) => setForm((prev) => ({ ...prev, prompt: (e.target as HTMLTextAreaElement).value }))}
                    />
                    <span class="git-input-hint">{t('schedules.promptHint')}</span>
                  </div>
                </div>

                {/* 第 2 区：调度时间维度配置 */}
                <div class="git-form-section">
                  <div class="git-section-title">2. {t('schedules.secTimingTitle')}</div>

                  {form.mode === 'calendar' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {/* 天维度 */}
                      <div class="git-form-item">
                        <label class="git-form-label">{t('schedules.dayDimension')}</label>
                        <div class="schedule-chip-row">
                          {(
                            [
                              ['everyday', t('schedules.dayEveryday')],
                              ['weekdays', t('schedules.dayWeekdays')],
                              ['custom_week', t('schedules.dayCustomWeek')],
                              ['specific_dates', t('schedules.daySpecificDates')],
                            ] as [DayPreset, string][]
                          ).map(([preset, label]) => (
                            <button
                              key={preset}
                              type="button"
                              class={'schedule-chip-btn' + (form.dayPreset === preset ? ' active' : '')}
                              onClick={() => handleDayPresetChange(preset)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        {form.dayPreset === 'custom_week' && (
                          <div class="schedule-chip-row" style={{ marginTop: '6px' }}>
                            {weekdayMeta.map((w) => (
                              <button
                                key={w.val}
                                type="button"
                                class={'schedule-weekday-btn' + (form.weekdays.includes(w.val) ? ' active' : '')}
                                onClick={() => toggleWeekday(w.val)}
                              >
                                {w.label}
                              </button>
                            ))}
                          </div>
                        )}

                        {form.dayPreset === 'specific_dates' && (
                          <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div class="schedule-pill-tags">
                              {form.dates.map((d) => (
                                <span key={d} class="schedule-pill-tag">
                                  <span>{d}</span>
                                  <button
                                    type="button"
                                    onClick={() => setForm((prev) => ({ ...prev, dates: prev.dates.filter((x) => x !== d) }))}
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                            <div class="git-input-with-actions">
                              <input
                                type="date"
                                class="git-input"
                                style={{ maxWidth: '180px' }}
                                value={newDateInput}
                                onInput={(e) => setNewDateInput((e.target as HTMLInputElement).value)}
                              />
                              <button type="button" class="git-aux-btn" onClick={handleAddSpecificDate}>
                                {t('schedules.addDate')}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 时间点维度 */}
                      <div class="git-form-item">
                        <label class="git-form-label">{t('schedules.timeDimension')}</label>
                        <div class="schedule-pill-tags">
                          {form.times.map((tp) => (
                            <span key={tp} class="schedule-pill-tag">
                              <span>{tp}</span>
                              <button
                                type="button"
                                onClick={() => setForm((prev) => ({ ...prev, times: prev.times.filter((x) => x !== tp) }))}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                        <div class="git-input-with-actions" style={{ marginTop: '6px' }}>
                          <input
                            type="time"
                            class="git-input"
                            style={{ maxWidth: '150px' }}
                            value={newTimeInput}
                            onInput={(e) => setNewTimeInput((e.target as HTMLInputElement).value)}
                          />
                          <button type="button" class="git-aux-btn" onClick={handleAddTimePoint}>
                            {t('schedules.addTimePoint')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* 间隔时间模式 */
                    <div class="git-form-item">
                      <label class="git-form-label">{t('schedules.intervalEvery')}</label>
                      <div class="git-input-with-actions">
                        <input
                          type="number"
                          min={1}
                          class="git-input"
                          style={{ maxWidth: '120px' }}
                          value={form.intervalValue}
                          onInput={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              intervalValue: Math.max(1, parseInt((e.target as HTMLInputElement).value, 10) || 1),
                            }))
                          }
                        />
                        <div style={{ minWidth: '130px' }}>
                          <Select
                            class="schedule-compact-select"
                            value={form.intervalUnit}
                            options={intervalUnitOptions}
                            onChange={(u) => setForm((prev) => ({ ...prev, intervalUnit: u }))}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 一次性任务开关 */}
                  <label class="git-checkbox-label" style={{ marginTop: '6px' }}>
                    <input
                      type="checkbox"
                      checked={form.oneShot}
                      onChange={(e) => setForm((prev) => ({ ...prev, oneShot: (e.target as HTMLInputElement).checked }))}
                    />
                    <div class="git-checkbox-text">
                      <strong>{t('schedules.oneShotLabel')}</strong>
                    </div>
                  </label>
                </div>

                {/* 第 3 区：工作区、会话模式与默认 auto 权限 */}
                <div class="git-form-section">
                  <div class="git-section-title">3. {t('schedules.secExecutionTitle')}</div>

                  {/* 目标工作区（隔离不污染左侧栏） */}
                  <div class="git-form-item">
                    <label class="git-form-label">{t('schedules.workspaceLabel')}</label>
                    <div class="git-input-with-actions">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Select
                          class="git-adapter-select schedule-workspace-select"
                          value={form.cwd}
                          options={workspaceOptions}
                          onChange={(v) => setForm((prev) => ({ ...prev, cwd: v }))}
                        />
                      </div>
                      <button
                        type="button"
                        class="schedule-folder-picker-btn is-form"
                        onClick={handlePickIsolatedWorkspace}
                        title={t('schedules.addWorkspaceBtn')}
                        aria-label={t('schedules.addWorkspaceBtn')}
                      >
                        <ScheduleFolderIcon />
                      </button>
                    </div>
                    <span class="git-input-hint">{t('schedules.workspaceIsolatedHint')}</span>
                  </div>

                  {/* 会话归档模式双卡（独立会话 vs 复用会话） */}
                  <div class="git-form-item" style={{ marginTop: '4px' }}>
                    <label class="git-form-label">{t('schedules.sessionModeLabel')}</label>
                    <div class="git-mode-switch-container">
                      <label
                        class={'git-mode-card' + (form.sessionMode === 'isolated' ? ' active' : '')}
                        onClick={() => setForm((prev) => ({ ...prev, sessionMode: 'isolated' }))}
                      >
                        <div class="git-mode-header">
                          <input
                            type="radio"
                            name="sched-session-mode"
                            checked={form.sessionMode === 'isolated'}
                            onChange={() => setForm((prev) => ({ ...prev, sessionMode: 'isolated' }))}
                          />
                          <strong>{t('schedules.sessionModeIsolated')}</strong>
                        </div>
                        <span class="git-mode-desc">{t('schedules.sessionModeIsolatedDesc')}</span>
                      </label>

                      <label
                        class={'git-mode-card' + (form.sessionMode === 'reuse' ? ' active' : '')}
                        onClick={() => setForm((prev) => ({ ...prev, sessionMode: 'reuse' }))}
                      >
                        <div class="git-mode-header">
                          <input
                            type="radio"
                            name="sched-session-mode"
                            checked={form.sessionMode === 'reuse'}
                            onChange={() => setForm((prev) => ({ ...prev, sessionMode: 'reuse' }))}
                          />
                          <strong>{t('schedules.sessionModeReuse')}</strong>
                        </div>
                        <span class="git-mode-desc">{t('schedules.sessionModeReuseDesc')}</span>
                      </label>
                    </div>

                    {form.sessionMode === 'reuse' && (
                      <label class="git-switch-inline-label" style={{ marginTop: '6px' }}>
                        <input
                          type="checkbox"
                          checked={form.overlapPolicy === 'queue'}
                          onChange={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              overlapPolicy: (e.target as HTMLInputElement).checked ? 'queue' : 'skip',
                            }))
                          }
                        />
                        <span>{t('schedules.queueWhenBusy')}</span>
                      </label>
                    )}
                  </div>

                  {/* 运行模式（复用主对话纯英文 ModeSelector，默认选中 Auto）与执行模型 */}
                  <div class="git-model-trigger-panel schedule-exec-panel" style={{ marginTop: '4px' }}>
                    <div class="schedule-exec-grid">
                      <div class="schedule-exec-col">
                        <div class="schedule-exec-col-head">
                          <span class="git-form-label">{t('schedules.permissionLabel')}</span>
                        </div>
                        <div class="schedule-mode-selector-wrap">
                          <ModeSelector
                            value={toApprovalMode(form.permissionMode)}
                            onChange={(m) =>
                              setForm((prev) => ({
                                ...prev,
                                permissionMode: fromApprovalMode(m),
                              }))
                            }
                          />
                        </div>
                      </div>

                      <div class="schedule-exec-col">
                        <div class="schedule-exec-col-head">
                          <span class="git-form-label">{t('schedules.modelLabel')}</span>
                          {form.model && (
                            <button
                              type="button"
                              class="git-text-action-btn"
                              onClick={() => setForm((prev) => ({ ...prev, model: null }))}
                            >
                              {t('schedules.modelFollowDefault')}
                            </button>
                          )}
                        </div>
                        <div class="schedule-model-row">
                          <div class="git-model-selector-wrapper">
                            <ModelSelector
                              value={form.model}
                              onChange={(m) => setForm((prev) => ({ ...prev, model: m }))}
                              direction="up"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* 底部操作栏 */}
        <div class="modal-footer git-webhook-footer">
          <div class="git-footer-left">
            {form.id && form.mode !== 'ai' && (
              <>
                <button
                  type="button"
                  class="git-test-btn"
                  disabled={runningNow}
                  onClick={() => void handleRunNow()}
                >
                  {runningNow ? t('schedules.running') : t('schedules.runNow')}
                </button>
                <button
                  type="button"
                  class="schedule-delete-btn"
                  onClick={() => {
                    if (currentEditingTask) setConfirmDelete(currentEditingTask);
                  }}
                >
                  {t('schedules.deleteTask')}
                </button>
              </>
            )}
            {toast ? (
              <span class={`git-footer-toast ${toast.type}`}>{toast.msg}</span>
            ) : form.mode === 'ai' ? (
              <span class="git-input-hint">{t('schedules.modeAiDesc')}</span>
            ) : null}
          </div>

          <div class="git-footer-right">
            <button type="button" class="git-cancel-btn" onClick={onClose}>
              {form.mode === 'ai' ? t('settings.close') : t('common.cancel')}
            </button>
            {form.mode !== 'ai' && (
              <button
                type="button"
                class="git-save-btn"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving
                  ? '...'
                  : form.id
                  ? t('schedules.saveTask')
                  : t('schedules.createTask')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 异地独立工作区选择弹窗（skipChangeDir=true，绝不修改侧栏或当前全局工作区） */}
      {cwdPickerOpen &&
        createPortal(
          <CwdPicker
            current={form.cwd || defaultWorkspace || '~'}
            title={t('schedules.workspaceLabel')}
            subtitle={t('schedules.workspaceIsolatedHint')}
            skipChangeDir={true}
            overlayClass="confirm-modal-overlay"
            onPick={(picked) => {
              setForm((prev) => ({ ...prev, cwd: picked }));
            }}
            onClose={() => setCwdPickerOpen(false)}
          />,
          document.body,
        )}

      {/* 删除任务二次确认框 */}
      {confirmDelete &&
        createPortal(
          <ConfirmDialog
            title={t('schedules.deleteConfirmTitle')}
            body={t('schedules.deleteConfirmBody', { title: confirmDelete.title })}
            confirmLabel={t('schedules.deleteTask')}
            cancelLabel={t('common.cancel')}
            danger={true}
            onClose={() => setConfirmDelete(null)}
            onConfirm={async () => {
              await deleteSchedule(confirmDelete.id);
              const nextTasks = await listSchedules();
              setTasks(nextTasks);
              if (form.id === confirmDelete.id) {
                setForm(nextTasks[0] ? taskToFormState(nextTasks[0]) : createEmptyForm(defaultWorkspace));
              }
              setConfirmDelete(null);
              showToast(t('schedules.deletedToast'), 'success');
            }}
          />,
          document.body,
        )}
    </div>
  );
}
