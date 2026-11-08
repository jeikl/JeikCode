// Chat 主视图：消息时间线渲染、流式输出、工具调用展示、输入与发送、
// 技能 / @ 提及、权限卡、会话内搜索。
//
// 数据来源只有三条：`/chat/watch`（带 seq 的会话流）、`GET /sessions`（四个拉取
// 时机）、本地意图（乐观草稿）。身份与排序契约见
// `refactor-plan/canvas-message-plan-v2.md`：记录靠 `id` 认人、靠 `seq` 排队、
// 缓存靠 `revision` 设闸门。

import { VNode } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { InputHistory, canNavigateInputHistory, inputHistoryKey } from '../lib/inputHistory';
import { resolveComposerEnterAction, resolveComposerEscapeAction, isMobileComposer, tailQueuedCard } from '../lib/composerShortcuts';
import { createTimelineFollow } from '../lib/timelineFollow';

/** First paint / page size for long transcripts. Older messages load on demand.
 *  Hard cap: a tail must not grow past this when the cut falls mid-turn.
 *  Walking back to the opening question pulls a whole tool turn into the timeline. */
const HISTORY_PAGE = 48;
/**
 * 回前台增量续传的页大小。
 *
 * `after_seq` 是实时性最高的路径：只拉“离开期间新增的行”，**不设人为上限**，
 * 有多少拿多少（漏了会让直播尾巴孤悬在断层之后）。只用一个足够大的分页值
 * 避免服务端一次返回过多，而不人为截断。
 */
const DELTA_PAGE = 2000;
/** 「立即发送」程序化停止标记的有效期：后端 /chat/stop 的 stop_and_wait 上限仅 2.5s。 */
const PROGRAMMATIC_STOP_MARK_TTL_MS = 15000;
/** A displaced turn's operation id is a stronger, longer-lived identity than
 *  the legacy session mark; slow tools can finish well after 15s. */
const DISPLACED_TERMINAL_MARK_TTL_MS = 120000;
/** Survive a refresh: a late terminal for the displaced turn must still be
 *  recognized as programmatic, not as the user stopping the replacement turn. */
const PROGRAMMATIC_STOP_STORAGE_KEY = 'jeikcode.programmaticStopMark';

function readPersistedProgrammaticStopMark(): ProgrammaticStopMark | null {
  try {
    const raw = sessionStorage.getItem(PROGRAMMATIC_STOP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProgrammaticStopMark>;
    if (
      typeof parsed?.sessionId === 'string' &&
      typeof parsed?.expiresAt === 'number' &&
      parsed.expiresAt > Date.now()
    ) {
      return {
        sessionId: parsed.sessionId,
        expiresAt: parsed.expiresAt,
        ...(typeof parsed.operationId === 'string' ? { operationId: parsed.operationId } : {}),
      };
    }
    sessionStorage.removeItem(PROGRAMMATIC_STOP_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable / malformed: fall back to the in-memory mark.
  }
  return null;
}

function persistProgrammaticStopMark(mark: ProgrammaticStopMark | null): void {
  try {
    if (mark) sessionStorage.setItem(PROGRAMMATIC_STOP_STORAGE_KEY, JSON.stringify(mark));
    else sessionStorage.removeItem(PROGRAMMATIC_STOP_STORAGE_KEY);
  } catch {
    // Best effort; the in-memory mark still covers the same tab without a refresh.
  }
}
/**
 * 上一轮 done 后，判定「转向卡是否已被内核自然发出」的宽限窗口。
 * 内核会在轮末把残留 steer 缓冲落成新一轮；若本端同期把它改回 queue 再 drain，
 * 就是一次 POST 抢占/重启那一轮（同一条回答跑两遍）。必须在窗口后再定性。
 */
const STEER_NATURAL_DRAIN_GRACE_MS = 1500;
/**
 * 页面长时间隐藏（手机后台挂起、系统休眠）后才允许失焦重连 watch。
 * 短暂失焦（截图工具、切窗口回来）绝不断开重连：重连会强制后端重放整轮事件
 * （subscribe_live_with_replay），把已画完的正文/思考再落一遍。
 */
const WATCH_REATTACH_AFTER_HIDDEN_MS = 60000;
import { postChatPrompt, stopChat, postChatSteer, admitChatSteer, cancelChatSteer, postSystemNotify, getActiveChatSessions, getChatRuntime, getChatPending, watchChatSession, SSEEvent, getSessionFreshness, SessionMetaWithProject, listProjectSessions, getModels, ModelInfo, ImageData, postLiveProvider, postLiveMode, getApprovalMode, getApprovalModeState, ApprovalMode, SessionMessage, SessionTokenUsage, SessionTurnOutline, getSkills, SkillInfo, listDir, changeDir, postConfigReload, postMcpReload, getMcpStatus, postLiveMcpTrust, postCommand, setDefaultProvider, uploadSessionFiles, type CommandResult, type UploadProgress, UserInputRequestEvent, getChatQueue, saveChatQueue, claimChatQueue, releaseChatQueue, type QueuedMessageApiItem, patchSessionMessage, deleteSessionMessage, truncateSession, type SessionMutationEvent } from '../api';
import { pullSession } from '../lib/sessionPull';
import { InlineBubbleEditor } from './InlineBubbleEditor';
import {
  estimateAllMessagesTokens,
  estimateMessageTokens,
  estimateSessionTokens,
  estimateTextTokens,
  formatTokenMetric,
  promptTokensBeforeLastUser,
  type TokenUsage,
} from '../lib/tokenEstimate';
import { formatMsgTime, formatMsgTimeFull, precedingUserTs } from '../lib/messageTime';
import { anchorForSteer, steerInsertPosition } from '../lib/steerAnchor';
import { imagesToPending, pendingImageData, sameImageSet } from '../lib/imageIdentity';
import { collectImageSrcs } from '../lib/imageGallery';
import { formatArgs } from '../lib/toolArgs';
import { detachUnfinishedTodoFromLatestAssistant, freezeTodosIntoLastAssistant } from '../lib/todoMessages';
import {
  cacheMissingSettledAssistant,
  diskHasCanvasUser,
  lastUserPlain,
  reconcileSnapshotWithCache,
} from '../lib/sessionReconcile';
import { ImageLightbox, MsgImage, imageDataUrl } from './chat/ImageLightbox';
import { UserMessageView } from './chat/UserMessageView';
import { AssistantMessageView } from './chat/AssistantMessageView';
import { QueuedMessageCard } from './chat/QueuedMessageCard';
import { StatusRow } from './chat/StatusRow';
import { NoticeCard, isCompactionDoneNotice } from './chat/NoticeCard';
import { AttachmentTray } from './chat/AttachmentTray';
import { SlashMenu } from './chat/SlashMenu';
import { AtMentionMenu } from './chat/AtMentionMenu';
import { JumpToBottomButton } from './chat/JumpToBottomButton';
import { MainTabStage } from './chat/MainTabStage';
import type { OpenDiffTab } from '../lib/openDiffTab';
import { ToolGroupView } from './chat/ToolViews';
import { messageFullText, messageText } from './chat/messageText';
import { ReasoningBlock } from './chat/ReasoningBlock';
import { SessionTodoPanel } from './chat/SessionTodoPanel';
import { highlightText } from './chat/highlight';
import { DiffStatBadge, ToolArgPreview, ToolStatusIcon } from './chat/ToolBits';
import { ConfirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import {
  loadComposerDraft,
  saveComposerDraft,
  clearComposerDraft,
  loadBubbleEditDraft,
  saveBubbleEditDraft,
  clearBubbleEditDraft,
  type BubbleEditDraft,
} from '../lib/composerDraft';
import {
  parseSlashCommand,
  buildCommandMap,
  dispatchSlashCommand,
  buildSlashMenuItems,
  formatMcpStatusText,
  FRONTEND_COMMANDS,
  type SlashHandlers,
} from '../lib/slashCommands';
import { messageSearchableFullText as searchableMessageText, textMatchesSearch, toolMatchesSearch } from '../lib/canvasSearch';
import { normalizeCanvas as normalizeCanvasRows, reduceCanvas, type CanvasAction } from '../lib/canvas/canvasStore';
import { projectCanvas } from '../lib/canvas/project';
import { isCanvasEventAction, reduceCanvasEvent, type CanvasEventAction } from '../lib/canvas/actions';
import type { CanvasRecord as Message } from '../lib/canvas/records';
import { beginModeSwitch, completeModeSwitch, failModeSwitch, initModeState, modeForSessionOrigin } from '../lib/modeSwitch';
import { buildTurnNavItems, buildTurnNavItemsFromOutline, canLoadOlder, compactTurnNavText, computeEffectiveHasOlder, filterTurnNavItems, fullerOutline, hasOlderVisibleMessages, historyCursorFor, mergeServerWithLocalOutline, remainingUnloadedTurns, removeOutlineRowsById, resolveActiveTurnId, turnNavId, turnNavScrollTop, visibleOlderRemainingCount } from '../lib/turnNav';
import { randomUUID } from '../lib/randomId';
import {
  dispatchSystemNotification,
  isWindowAway,
  recordUserManualStop,
  recordUserSteer,
  showPermissionNotice,
  terminalKindFromDone,
} from '../lib/sessionNotify';
import { createPortal, memo } from 'preact/compat';
import { Markdown } from './Markdown';
import { ModelSelector } from './ModelSelector';
import { ModeSelector } from './ModeSelector';
import { getPageZoom } from '../lib/pageZoom';
import { useBackdropDismiss } from '../lib/backdropDismiss';
import { onSoftRefresh } from '../lib/appRefresh';

// 动态懒加载非首屏必需的重型 Git / Diff 面板，削减初始 JS 主包体积，加速桌面端冷启动与弱网访问
import { dropEditorTabSnapshot, mainEditorStateKey } from '../lib/editorTabState';
import { getSavedTerminalCount } from './TerminalPanel';
import { getSavedPreviewCount } from './PreviewPanel';
import { RightInspector, isRightPanelTab, type RightPanelTab } from './RightInspectorPanel';
import {
  fetchGitFileDiff,
  fetchGitWorkingDiff,
  fetchGitRepos,
  type GitCommitItem,
  type GitCommitFile,
  type GitStatusItem,
} from '../api';
import { useT } from '../settings';
import type { MsgKey } from '../i18n';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MB,
  ACCEPTED_IMAGE_INPUT_ACCEPT,
  countPending,
  fileToImageData,
  formatUserMessageWithAttachments,
  isImageFile,
  looksLikeHeif,
  normalizeMimeType,
  type PendingAttach,
  type PendingFile,
  type PendingImage,
} from '../lib/attachments';
import {
  collectClipboardFiles,
  copyTextAndImages,
  copyTextToClipboard,
  buildCopyHtml,
} from '../lib/clipboard';
import {
  applyAtMentionSelection,
  detectAtMentionRange,
  ensureActiveDescendantVisible,
  splitAtToken,
} from '../lib/atMention';
import {
  finalizeToolsAfterTurn,
  settleToolRow,
  toolResultStatus,
  withTrailingTodoList,
  type ToolRow,
  type MsgPart,
} from '../lib/toolRows';
import {
  jsonArgString,
  resolveToolDiffPreview,
  colorizeInlineJson,
  prettyToolText,
  toolCategory,
  toolGlyph,
  toolRendersAsDiff,
  isWritingTool,
  isViewOnlyShellDiff,
  computeToolDiffStats,
  type DiffPreviewLine,
} from '../lib/toolDisplay';
import {
  applySubtaskProgress,
  settleSubtasksFromOutput,
  subtasksFromTaskArgs,
  subtaskCounts,
  taskArgsSummary,
} from '../lib/subtasks';
import {
  foldTodoToolCall,
  isTodoTool,
  liveTodoPanelItems,
  parseTodosFromOutput,
  placeArchivedTodos,
  reduceLiveTodo,
  settleLiveTodo,
  todoCallIdsFromMessages,
  todoCounts,
  type LiveTodoDocument,
  type TodoItem,
} from '../lib/todos';
import { displayPath, pathBasename, getRelativePathToProject } from '../lib/displayPath';
import { toolTouchesWorktree } from '../lib/gitRefresh';
import {
  getSessionCache,
  commitCanvasCache,
  deleteSessionCache,
  clearAllSessionCache,
  getMemorySession,
  flushPendingPersist,
  stripUnbackedProvisionalTurns,
  updateSessionCacheMeta,
} from '../lib/sessionCache';
import { gitStore, type GitProjectState } from '../lib/gitStore';
import { isInternalHistoryAssistantMessage } from '../lib/historyMessages';
import { legacyUserTextsMatch as userTextsMatch, resolveEditable, resolveInternal, resolveUserDisplayText, stripInjectedRemindersForDisplay, stripSteerEnvelopeForDisplay, visibleUserText } from '../lib/wire/legacy';
import {
  deserializeQueuedCard,
  loadQueuedFromStorage,
  mergeQueuedCardState,
  mergeQueuedIntoDraft,
  saveQueuedToStorage,
  serializeQueuedCard,
  stashSessionQueued,
  restoreSessionQueued,
} from '../lib/queuedDraft';
import { shouldApplyRevision } from '../lib/stateRevision';
import { bumpSessionSendNowEpoch, consumesProgrammaticStopMark, isCurrentSessionSendNowEpoch, isStaleProgrammaticStopFrame, isStaleTerminalForArmedTurn, isTurnHandoverProtected, runningTurnStopAliases, stopAliasAllowsNextTurn, type ProgrammaticStopMark } from '../lib/turnStop';
import { loadAppliedTodoCallIds, saveAppliedTodoCallIds } from '../lib/todoAppliedIds';
import {
  chatRecoveryPolicy,
  classifyChatDone,
  createLiveLifecycleState,
  isCurrentChatStream,
  liveDetachDisposition,
  reduceChatRecovery,
  resolveUserInputRequest,
  toolResultClearsUserInput,
  transcriptLatestUserInputIsResolved,
  transcriptToolCallIsResolved,
  stayOnNewSessionLanding,
  resumeTurnStartedAt,
  transcriptHasInFlightAssistant,
  transcriptHasOpenUserTurn,
  sessionAssignedClaimsLocalTurn,
  shouldKeepCachedTranscript,
  shouldClearCanvasOnSwitch,
  thisTabOwnsTurn,
  shouldLockSendAsDetached,
  isWatchTurnActivationEvent,
  resolveTokenCache,
  formatCacheHitRate,
  createTokenCacheState,
  resetTokenCacheState,
  estimateLocalCached,
  estimateCacheFromHistoryPrompt,
  type TokenCacheState,
  estimatePrefixCached,
  clampCachedToPrompt,
  isStackedTurnBillingUsage,
  userMessageAlreadyOnCanvas,
  findPaintedUserRow,
  queueCardAlreadyDelivered,
  queueCardAlreadyOnCanvas,
  queueCardPresentInOutline,
  steerCardBubbleOnCanvas,
  findPendingSelfEchoIndex,
  dropSnapshotDuplicates,
  mergeAuthoritativeTail,
  findCausalGap,
  type ChatRecoveryEvent,
  type ChatRecoveryState,
} from '../lib/chatTerminal';
import {
  formatTurnElapsed,
  isSteerUserMessage,
  resumeTurnClockEpoch,
  rootTurnUserTs,
  stampLastAssistantElapsed,
  turnDurationMs,
  turnTotalElapsedMs,
} from '../lib/turnTimer';
import { resolveLiveElapsedAnchor, standaloneStatusMode } from '../lib/compactionPhase';
import {
  acknowledgeLiveSteers,
  dropFoldedQueuedCards,
  pendingSteersToDraft,
  resolveLingeringSteers,
  type PendingLiveSteer,
} from '../lib/liveSteer';
import { onGlobalEvent } from '../lib/globalEvents';
import { SessionStore } from '../lib/canvas/sessionStore';
import { SessionStoreMap } from '../lib/canvas/sessionStoreMap';
import { resolveSessionLifecycle } from '../lib/sessionLifecycle';
import {
  isRunningProofFrame,
  resolveRuntimeBusyAction,
  serverRuntimeRunning,
} from '../lib/serverRuntime';
import {
  acceptReplayFrame,
  createReplayFold,
  needsReplayDedup as needsReplayDedupFromFrame,
  replayFrameAnchor,
  replayFrameOnCanvas,
} from '../lib/replayFold';
import {
  bindUserMessageIdentity,
  foldLiveTodo,
  hydrateSession,
  paintAssistantReasoning,
  paintAssistantText,
  paintAssistantNotice,
  paintCachedAssistantDelta,
  paintUserMessage,
  placeRecoveredTurnUsers,
  mergeOlderMessages,
  cachedHeadIsContiguous,
  resolveHistoryOffset,
  isTransientAdvisoryText,
  stampUserClientInputId,
  stampUserSourceIndex,
  visibleToolChunk,
  withAssistantIdentity,
  type TurnUserAnchor,
} from '../lib/sessionProjection';
import {
  clearStreamCursor,
  readStreamCursor,
  resolveAfterSeq,
  writeStreamCursor,
} from '../lib/streamCursor';
import {
  lastAssistantTextLen,
  ownsRunningLocalSend,
  shouldAdoptAuthoritativeTail,
  tailAssistantHasUnresolvedTools,
} from '../lib/chatSettle';

/**
 * Freeze a todo snapshot onto the last assistant message's trailing `todo_list`
 * part. Used when the user starts the next turn (sticky → history) and when
 * caching a session that still has a live sticky panel.
 */

import { resolveSendNowSteerAction, type QueuedMessage } from '../lib/queuedMessage';

/** Concatenate all text segments (error-detection, skill-title, search, etc.). */
/** 图片集合相等（纯图片 / 空文本卡片无法用文本判定身份时使用）。 */

type SessionTokenSnapshot = {
  tokens: TokenUsage;
  cacheState: TokenCacheState;
  /** True when the snapshot came from provider telemetry or persisted server usage. */
  authoritative: boolean;
  /** Set by a committed compaction until the next REAL usage frame. A persisted
   *  turn stat can still report the pre-compaction size; this lets the smaller,
   *  newer compaction value win instead of snapping the meter back. */
  compacted?: boolean;
};

type RuntimeAuthoritySnapshot = {
  runtime: { running?: boolean; turn_id?: string | null } | null;
  running: boolean;
};

interface PermissionRequestEvent {
  type: 'permission_request';
  session_id: string;
  approval_id: string;
  tool_name: string;
  reason: string;
  call_id: string;
  arguments: unknown;
}

interface ChatProps {
  sessionId: string | null;
  /** 回传会话 id。`claimView=false` 表示只做侧栏/列表对齐，绝不切换当前视图
   *  （用户在 POST 飞行期间已切到别的会话时必须用这个模式，否则视图会被拽回）。 */
  onSessionId: (id: string, opts?: { claimView?: boolean }) => void;
  cwd: string;
  onPermission: (req: PermissionRequestEvent) => void;
  /** 审批已被解决时通知 App 清掉 /chat 的审批卡片：传 call_id 仅在匹配时清（工具已执行），
   *  传 null 则无条件清（回合 done/stopped/error 或用户中止——此时不可能再有待批准项）。 */
  onPermissionResolved?: (callId: string | null) => void;
  /** Metadata of the currently-active session (for loading history) */
  activeSession?: SessionMetaWithProject | null;
  /** 刷新后正按 URL 短 id 还原会话；为 true 时抑制新建落地页，避免闪屏。 */
  restoring?: boolean;
  /** /live turn 完成后通知 App 刷新侧栏列表（session 已落盘，列表需更新）。 */
  onTurnDone?: () => void;
  /** /live 回合运行态变化：侧栏/标题头转圈，与 `--host` 的 /chat/active 一致。 */
  onTurnRunningChange?: (sessionId: string | null, running: boolean) => void;
  /** 首条消息发出瞬间上报标题（取消息前 10 字），供 App 乐观插入侧栏，
   *  让会话即时出现；待后端落盘并自动命名后，列表刷新会换成真实标题。 */
  onOptimisticSession?: (title: string) => void;
  /** 打开工作目录选择器（cwd 面包屑已从顶栏移到输入框下方，由本组件渲染）。 */
  onOpenCwd?: () => void;
  /** 另一端（TUI /cd、worktree、其他 webui tab）切了工作目录：实时流送来 working_dir
   *  事件时上报新路径，供 App 更新 cwd 面包屑 + 侧栏目录过滤。 */
  onCwdChanged?: (dir: string) => void;
  /** AI 自动命名了当前会话：实时流送来 session_renamed 事件时上报新名称，
   *  供 App 更新顶部标题头，无需再发请求拉取会话列表。 */
  onSessionRenamed?: (name: string) => void;
  /** 上报是否处于落地（空对话）态，供 App 决定是否显示会话标题头。 */
  onLanding?: (landing: boolean) => void;
  /** 侧栏「技能」菜单选中的技能：变化时把 `/name ` 插入输入框。 */
  skillInsert?: { name: string; seq: number } | null;
  /** 打开会话侧栏（/sessions 命令）。 */
  onOpenSidebar?: () => void;
  /** 开始新会话（/new 命令）。 */
  onNewSession?: () => void;
  diffTabs?: any[];
  setDiffTabs?: (tabs: any[] | ((prev: any[]) => any[])) => void;
  activeMainTabId?: string;
  setActiveMainTabId?: (id: string) => void;
  /** 顶部导航栏模型选择器挂载槽 */
  topModelSlot?: HTMLElement | null;
  /** 打开模型配置（和模型选择框绑在一起）。 */
  onOpenModelConfig?: () => void;
  /** 当前会话的审批 / 提问，交给右下角通知栈，而不是居中弹层。 */
  onLiveReview?: (review: {
    sessionId: string | null;
    permission: { runtime_instance_id: string; generation: number; request_id: number; tool_name: string; reason: string; call_id: string; arguments: unknown } | null;
    userInput: UserInputRequestEvent | null;
  }) => void;
  /** 通知栈提交后清掉本会话的实时卡片。 */
  onBindReviewDismiss?: (fns: {
    permission: (runtimeInstanceId: string, generation: number, requestId: number, callId: string) => void;
    userInput: () => void;
  }) => void;
}


// Mirror of the TUI's `display_tool_name` (event_loop/mod.rs): MCP wire names
// `mcp__server__tool` render as `mcp · server · tool`; everything else is
// snake_case → PascalCase (`read_file` → `ReadFile`). Keeps the webui's tool
// headers identical to the terminal instead of showing raw `mcp__…` names.

// 识别「技能/文档型」用户消息：首个非空字符是 markdown 标题、且内容较长。
// TUI 调用 /skill 时会把整段 SKILL.md 模板塞进用户消息，webui 历史里会把它
// 渲染成一大坨原文；命中则返回标题文本用作折叠徽章标签，否则返回 null（普通气泡）。


export function Chat({
  sessionId,
  onSessionId,
  cwd,
  onPermission,
  onPermissionResolved,
  activeSession,
  restoring,
  onTurnDone,
  onTurnRunningChange,
  onOptimisticSession,
  onOpenCwd,
  onCwdChanged,
  onLanding,
  skillInsert,
  onSessionRenamed,
  onOpenSidebar,
  onNewSession,
  diffTabs: externalDiffTabs,
  setDiffTabs: externalSetDiffTabs,
  activeMainTabId: externalActiveMainTabId,
  setActiveMainTabId: externalSetActiveMainTabId,
  topModelSlot,
  onOpenModelConfig,
  onLiveReview,
  onBindReviewDismiss,
}: ChatProps) {
  const t = useT();
  const [messages, setMessagesState] = useState<Message[]>([]);
  const activeStoreRef = useRef<SessionStore<Message> | null>(null);
  if (!activeStoreRef.current) activeStoreRef.current = new SessionStore<Message>();
  /**
   * 画布唯一写入口。
   *
   * 所有 `setMessages(updater)` 先执行调用方逻辑，再按 `id` 归一：
   * 同一条消息只保留一个位置，后到帧只更新内容、绝不叠加。这是重放/竞态/
   * 跨端回写共用的唯一收敛点 —— 任何调用点都不需要自己再判重。
   */
  const setMessages = useCallback(
    (action: CanvasAction<Message> | CanvasEventAction) => {
      activeStoreRef.current!.replace(messagesRef.current);
      const next = activeStoreRef.current!.dispatch(action);
      // 最后一道防线：任何动作都不得把画布状态写成非数组，否则下一次 render
      // 在遍历 `messages` 时会抛 "is not iterable"，整页崩坏且无法发送。
      if (!Array.isArray(next)) return;
      messagesRef.current = next;
      setMessagesState(next);
    },
    [],
  );
  const initialDraft = loadComposerDraft(sessionId);
  const [input, setInput] = useState(() => initialDraft?.text ?? '');
  const inputRef = useRef(input);
  inputRef.current = input;
  const [busy, setBusy] = useState(false);
  const [globalPreviewImage, setGlobalPreviewImage] = useState<string | null>(null);
  // 当前会话可切换的全部图片（灯箱「上一张 / 下一张」的数据源）。
  const [previewGallery, setPreviewGallery] = useState<string[]>([]);

  const collectCurrentSessionImages = useCallback((currentSrc?: string): string[] => {
    const roots = typeof document !== 'undefined'
      ? [
          document.querySelector('.messages-container'),
          ...Array.from(document.querySelectorAll('.input-thumbs, .inline-bubble-editor-attachments')),
        ]
      : [];
    const extraSrcs = pendingAttachRef.current
      .filter((item): item is PendingImage => item.kind === 'image' && !!item.image?.data)
      .map((item) => imageDataUrl(item.image));
    return collectImageSrcs(roots, currentSrc, extraSrcs);
  }, []);

  // 全局图片大图预览监听：捕获来自 Markdown/助理回复/附件中的任意图片点击
  useEffect(() => {
    const handleImg = (e: Event) => {
      const src = (e as CustomEvent<{ src?: string }>).detail?.src;
      if (!src) return;
      // 按画布与输入框 DOM 顺序收齐本会话图片（含用户附件、输入区待发图片与 Markdown 渲染图），
      // 并保证刚点开的这张一定在列表里，灯箱才能在电脑端与手机端都正确显示左右切换按钮。
      setPreviewGallery(collectCurrentSessionImages(src));
      setGlobalPreviewImage(src);
    };
    window.addEventListener('jeikcode:preview:image', handleImg);
    return () => window.removeEventListener('jeikcode:preview:image', handleImg);
  }, [collectCurrentSessionImages]);
  // Mirror of `busy` in a ref so pushCommandNotice can read it synchronously
  // without a stale closure (refs always reflect the latest render value).
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Last content event (text/tool/user), not the 15s keepalive. Catch-up reads
  // the saved transcript when this goes quiet while the cursor is still blinking.
  const lastLiveContentRef = useRef<number>(Date.now());
  // Live turn stopwatch: epoch when the latest user message started this turn.
  // startTurnClock is idempotent so tool rounds / thinking / partial assistant
  // chunks do NOT reset to 0. Cleared (and stamped onto the last assistant
  // message) when the turn's final body returns / is cancelled.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);
  const turnStartedAtBySessionRef = useRef<Map<string, number>>(new Map());
  /** A real terminal ended the previous task. The next clock start must treat the
   *  following user row as a NEW root, even when it is a steer card. A programmatic
   *  stop (send-now while the turn is running) deliberately does NOT set this. */
  const terminalSeenBySessionRef = useRef<Set<string>>(new Set());
  const terminalAtBySessionRef = useRef<Map<string, number>>(new Map());
  const [nowMs, setNowMs] = useState(() => Date.now());

  const STEER_STORAGE_PREFIX = 'jeikcode:pending_steers:';
  const CLOCK_STORAGE_PREFIX = 'jeikcode:turn_clock:';

  function getStoredSteers(sid: string): PendingLiveSteer[] {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return [];
      const raw = window.sessionStorage.getItem(STEER_STORAGE_PREFIX + sid);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function setStoredSteers(sid: string, steers: PendingLiveSteer[]) {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      if (steers.length > 0) window.sessionStorage.setItem(STEER_STORAGE_PREFIX + sid, JSON.stringify(steers));
      else window.sessionStorage.removeItem(STEER_STORAGE_PREFIX + sid);
    } catch {}
  }

  function getStoredTurnClock(sid: string): number | null {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return null;
      const raw = window.sessionStorage.getItem(CLOCK_STORAGE_PREFIX + sid);
      const val = raw ? Number(raw) : null;
      return val && Number.isFinite(val) ? val : null;
    } catch { return null; }
  }
  function setStoredTurnClock(sid: string, ts: number | null) {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      if (ts != null) window.sessionStorage.setItem(CLOCK_STORAGE_PREFIX + sid, String(ts));
      else window.sessionStorage.removeItem(CLOCK_STORAGE_PREFIX + sid);
    } catch {}
  }

  // 当前会话的权威工作目录：优先使用当前会话自身的 working_dir，回退到传入的全局 cwd。
  // 防止多项目切换或新建会话时由于外层 cwd 暂时漂移导致把当前会话的消息发往错误目录。
  const effectiveWorkingDir =
    (activeSession && activeSession.id === sessionId && activeSession.working_dir)
      ? activeSession.working_dir
      : cwd;
  /** Mark an AUTHORITATIVE turn terminal (done/stopped/error), NOT a programmatic
   *  send-now stop. It tells the next clock start that the previous task completed. */
  function markTurnTerminal(sid?: string | null) {
    if (!sid) return;
    terminalSeenBySessionRef.current.add(sid);
    terminalAtBySessionRef.current.set(sid, Date.now());
  }

  function startTurnClock(sessionId?: string | null, explicitStartTs?: number) {
    // 同一 turn 内（含中途 steer / 立即发送的方向改变）绝不重置计时器。
    // 只有真正的 turn 终态会经由 finishTurnClock 清空 epoch，下一 turn 才会重新计时。
    if (turnStartedAtRef.current != null) return;
    const now = Date.now();
    const targetId = sessionId ?? activeIdRef.current;
    const afterTerminal = !!targetId && terminalSeenBySessionRef.current.has(targetId);
    const terminalAt = targetId ? terminalAtBySessionRef.current.get(targetId) : undefined;
    let epoch = explicitStartTs;
    if (epoch == null && targetId && !afterTerminal) {
      const stored = getStoredTurnClock(targetId);
      if (stored && stored > 0 && stored <= now) epoch = stored;
    }
    if (epoch == null) {
      // 中途 steer（没有经过终态）要穿透到本轮最初提问；
      // 已经经过真实终态时，下一条 user（即使仍带 steer 标记）就是新任务的根。
      const lastUserTs = rootTurnUserTs(messagesRef.current, messagesRef.current.length, {
        penetrateSteers: !afterTerminal,
      });
      if (lastUserTs && Number.isFinite(lastUserTs) && lastUserTs > 0 && lastUserTs <= now) {
        epoch = afterTerminal ? Math.max(lastUserTs, terminalAt ?? 0) : lastUserTs;
      } else if (!afterTerminal && transcriptHasOpenUserTurn(messagesRef.current)) {
        epoch = resumeTurnClockEpoch(now, lastUserTs);
      }
    }
    if (epoch == null && afterTerminal && terminalAt) epoch = terminalAt;
    if (epoch == null || epoch > now) epoch = now;
    turnStartedAtRef.current = epoch;
    if (targetId) {
      turnStartedAtBySessionRef.current.set(targetId, epoch);
      setStoredTurnClock(targetId, epoch);
      // The new task owns the clock now; a later steer inside it continues it.
      terminalSeenBySessionRef.current.delete(targetId);
      terminalAtBySessionRef.current.delete(targetId);
    }
    setTurnStartedAt(epoch);
  }
  function adoptTurnUserTs(ts?: number, force = false) {
    if (ts == null || !Number.isFinite(ts) || ts <= 0) return;
    const now = Date.now();
    const effectiveTs = ts > now ? now : ts;
    if (force || turnStartedAtRef.current == null || effectiveTs < turnStartedAtRef.current) {
      turnStartedAtRef.current = effectiveTs;
      setTurnStartedAt(effectiveTs);
      const sid = activeIdRef.current;
      if (sid) {
        turnStartedAtBySessionRef.current.set(sid, effectiveTs);
        setStoredTurnClock(sid, effectiveTs);
      }
    }
  }
  function finishTurnClock(opts?: { stamp?: boolean; sessionId?: string | null }) {
    const started = turnStartedAtRef.current;
    const targetId = opts?.sessionId ?? activeIdRef.current;
    if (targetId && opts?.stamp !== false) {
      turnStartedAtBySessionRef.current.delete(targetId);
      setStoredTurnClock(targetId, null);
    }
    turnStartedAtRef.current = null;
    setTurnStartedAt(null);
    if (started == null || opts?.stamp === false) return;
    const totalElapsed = Date.now() - started;
    const stamped = stampLastAssistantElapsed(messagesRef.current, totalElapsed, Date.now(), { overwrite: true });
    messagesRef.current = stamped;
    if (targetId) {
      messageCacheRef.current.set(targetId, stamped);
    }
    setMessages({ type: 'replace', rows: stamped });
  }
  function setBusyAndClock(next: boolean, explicitStartTs?: number, opts?: { stamp?: boolean }) {
    if (next) {
      startTurnClock(undefined, explicitStartTs);
      lastLiveContentRef.current = Date.now();
    } else finishTurnClock(opts);
    busyRef.current = next;
    setBusy(next);
  }

  /**
   * 服务端已确认「这个会话有回合 / 运行时控制器在跑」时点亮运行态。
   * 与 `deliver` / `steered` 的口径一致：只点亮本端视图或后台会话集合，绝不把
   * 其他会话的运行态写进当前视图的 busy。
   */
  function armRunningForSession(sid: string, explicitStartTs?: number) {
    if (!sid) return;
    localTurnSessionsRef.current.add(sid);
    if (activeIdRef.current !== sid) {
      if (!backgroundRunningSessionsRef.current.has(sid)) {
        backgroundRunningSessionsRef.current.add(sid);
        onTurnRunningChange?.(sid, true);
      }
      // A background loop that starts after an authoritative idle observation
      // must not be left without a watcher until the user switches back. The
      // old branch only marked the sidebar running and never reattached the
      // stream, so late steer/tool frames were invisible.
      const bgHash =
        projectHashBySessionRef.current.get(sid) ||
        viewedProjectHashRef.current ||
        '';
      const bgWatcher = sessionWatchersRef.current.get(sid);
      const bgWatcherAlive = !!bgWatcher && !bgWatcher.signal.aborted;
      if (bgHash && !bgWatcherAlive) {
        startDetachedHistoryPoll(bgHash, sid, sessionGenerationRef.current, { background: true });
      }
      return;
    }
    liveLifecycleRef.current = { running: true, terminalConsumed: false };
    const fgHash =
      projectHashBySessionRef.current.get(sid) ||
      activeSession?.project_hash ||
      viewedProjectHashRef.current ||
      '';
    const fgWatcher = sessionWatchersRef.current.get(sid);
    const fgWatcherAlive = !!fgWatcher && !fgWatcher.signal.aborted;
    const hasForegroundPost =
      abortRef.current !== null || activeStreamRequestIdRef.current !== null;
    if (fgHash && !fgWatcherAlive && !hasForegroundPost && canvasReadySessionIdRef.current === sid) {
      startDetachedHistoryPoll(fgHash, sid, sessionGenerationRef.current);
    }
    if (busyRef.current) return; // 已经在运行态：不重复广播。
    onTurnRunningChange?.(sid, true);
    setBusyAndClock(true, explicitStartTs);
    busyRef.current = true;
  }

  /**
   * 应用一次服务端权威运行态快照（`GET /chat/runtime`）。
   *
   * 只做两件事：把 busy 点亮，或在服务端确认空闲且没有在途 POST / 停止防抖
   * 时收尾。这里不是轮询入口：调用点只有会话装载/切换、页面重新可见或回到前台、
   * 以及终态确认这些「边沿」；运行中的后续变化由 activity 推送与直播帧自愈承担。
   */
  function applyServerRuntime(
    sid: string,
    runtime: {
      running?: boolean;
      turn_id?: string | null;
      status?: string | null;
      phase?: string | null;
      phase_started_at?: number | null;
      owner?: string | null;
      revision?: number;
      started_at?: number | null;
      compaction_started_at?: number | null;
    } | null | undefined,
    opts?: { ensureIdleWatch?: boolean },
  ) {
    if (!sid || activeIdRef.current !== sid) return;
    if (typeof runtime?.revision === 'number') {
      const known = runtimeRevisionBySessionRef.current.get(sid) ?? -1;
      if (runtime.revision < known) return;
      runtimeRevisionBySessionRef.current.set(sid, runtime.revision);
      markRuntimeAuthoritative(sid);
    }
    const compacting =
      runtime?.phase === 'compacting' || runtime?.status === 'compacting';
    if (compacting && runtime?.running !== false) {
      // 刷新/重新聚焦后由服务端恢复压缩阶段：标记与计时起点必须一起恢复。
      setSessionCompacting(
        sid,
        true,
        runtime.phase_started_at ?? runtime.compaction_started_at ?? runtime.started_at ?? undefined,
      );
    } else if (
      runtime &&
      runtime.running === false &&
      abortRef.current === null &&
      activeStreamRequestIdRef.current === null
    ) {
      // 只有权威空闲才结束压缩。在途 POST 尚未 admit 时旧快照仍报 idle，
      // 不能据此把刚点下的压缩标记抹掉。
      setSessionCompacting(sid, false);
    } else if (
      runtime &&
      Object.prototype.hasOwnProperty.call(runtime, 'phase') &&
      abortRef.current === null &&
      activeStreamRequestIdRef.current === null
    ) {
      // 新 daemon 显式返回 phase（null 也表示“当前不在压缩”）。revision 闸门
      // 已经保证旧快照不会覆盖刚点下的压缩意图；这里可以安全结束幽灵标记。
      setSessionCompacting(sid, false);
    }
    const running = serverRuntimeRunning(runtime);
    if (running) {
      suppressedIdleBySessionRef.current.delete(sid);
      clearTrailingHandoverIdleVerify(sid);
      if (runtime?.turn_id) {
        noteTurnOperation(sid, runtime.turn_id);
      }
    }
    const noForeground =
      abortRef.current === null && activeStreamRequestIdRef.current === null;
    const pendingHandover = isSessionTurnHandoverProtected(sid);
    const guarded = isSessionInManualStopGuard(sid);
    const action = resolveRuntimeBusyAction({
      serverRunning: running,
      busy: busyRef.current,
      hasForegroundSend: !noForeground,
      hasPendingTurnHandover: pendingHandover,
      inManualStopGuard: guarded,
    });
    if (action === 'arm') {
      armRunningForSession(
        sid,
        runtime?.compaction_started_at ?? runtime?.started_at ?? undefined,
      );
      return;
    }
    if (action === 'settle') {
      suppressedIdleBySessionRef.current.delete(sid);
      clearTrailingHandoverIdleVerify(sid);
      settleBusyFromAuthority(sid);
      return;
    }
    if (!running && pendingHandover && noForeground && !guarded) {
      // 本次权威查询为 idle，但当前正处于交接/未见首帧保护窗口而暂缓收尾：
      // 记录并在交接结束后做一次尾随复核，防止再无后续 activity 导致按钮与队列死锁。
      suppressedIdleBySessionRef.current.add(sid);
      scheduleTrailingHandoverIdleVerify(sid, 300);
      return;
    }
    if (!running && opts?.ensureIdleWatch && noForeground && !guarded && !pendingHandover) {
      settleBusyFromAuthority(sid);
    }
  }

  /**
   * 异步广播 `activity(running: false)` 没有 operation_id，在跨 SSE 流并发下可能晚于
   * 新回合 `/chat/watch` 的首帧到达（此时 `!frameSeen` 保护已解除）。
   * 收尾前向服务端 `/chat/runtime` 做一次权威确认，杜绝旧回合迟到广播误杀新回合。
   */
  function confirmActivityIdleFromAuthority(sid: string, opts?: { ensureIdleWatch?: boolean }) {
    if (!sid) return;
    const confirmGen = sessionGenerationRef.current;
    const confirmOp = currentOperationBySessionRef.current.get(sid) ?? null;
    void fetchRuntimeAuthority(sid)
      .then(({ runtime, running }) => {
        if (sessionGenerationRef.current !== confirmGen) return;
        // A newer operation owns the session now: this response belongs to the
        // displaced turn and must not settle/arm the replacement.
        if ((currentOperationBySessionRef.current.get(sid) ?? null) !== confirmOp) return;
        if (activeIdRef.current === sid) {
          applyServerRuntime(sid, runtime ?? { running }, opts);
          return;
        }
        if (running) {
          suppressedIdleBySessionRef.current.delete(sid);
          clearTrailingHandoverIdleVerify(sid);
          return;
        }
        if (isSessionTurnHandoverProtected(sid)) {
          suppressedIdleBySessionRef.current.add(sid);
          scheduleTrailingHandoverIdleVerify(sid, 300);
          return;
        }
        settleBackgroundSessionFromAuthority(sid);
      })
      .catch(() => {});
  }

  function settleBackgroundSessionFromAuthority(targetSid: string) {
    if (!targetSid || activeIdRef.current === targetSid) return;
    backgroundRunningSessionsRef.current.delete(targetSid);
    localTurnSessionsRef.current.delete(targetSid);
    onTurnRunningChange?.(targetSid, false);
    sessionWatchersRef.current.get(targetSid)?.abort();
    sessionWatchersRef.current.delete(targetSid);
    localActiveStreamsBySessionRef.current.delete(targetSid);
    const ph =
      projectHashBySessionRef.current.get(targetSid) ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (ph) void syncSessionCacheFromDisk(ph, targetSid);
  }

  /** 服务端确认空闲后的统一收尾：停表、释放运行集、落盘并重新挂上待机 watch。 */
  function settleBusyFromAuthority(sid: string) {
    if (!sid) return;
    localTurnSessionsRef.current.delete(sid);
    backgroundRunningSessionsRef.current.delete(sid);
    const ph =
      projectHashBySessionRef.current.get(sid) ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (ph) {
      settleToIdleWatch(ph, sid, sessionGenerationRef.current);
    } else {
      setBusyAndClock(false);
      busyRef.current = false;
      onTurnRunningChange?.(sid, false);
    }
  }
  const [chatRecovery, setChatRecovery] = useState<ChatRecoveryState>('ready');
  const chatRecoveryRef = useRef<ChatRecoveryState>('ready');
  chatRecoveryRef.current = chatRecovery;
  const recoveryPolicy = chatRecoveryPolicy(chatRecovery);

  useEffect(() => {
    if (!busy || turnStartedAt == null) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy, turnStartedAt]);

  function transitionChatRecovery(event: ChatRecoveryEvent): ChatRecoveryState {
    const next = reduceChatRecovery(chatRecoveryRef.current, event);
    chatRecoveryRef.current = next;
    setChatRecovery(next);
    return next;
  }
  // True for the entire duration of a /compact postCommand await so sendMessage
  // can refuse to fire while the session .json is being rewritten on disk.
  const compactingRef = useRef(false);
  const compactingSessionsRef = useRef<Set<string>>(new Set());
  /** sync 模式 /compact 的“正在压缩”占位行：提交完成后再撤回，
   *  真正的标记由提交成功的 `/live` Warning 提供。 */
  const compactPendingNoteRef = useRef<Message | null>(null);
  // AI 执行中输入的消息排队于此，待当前回合 done 后依次自动发送（对齐 VSCode 插件）。
  // 初始化即从硬盘（localStorage）中水合恢复当前会话的队列消息（含未消费的转向消息），
  // 杜绝刷新页面时卡片瞬间丢失。
  const [queued, setQueuedState] = useState<QueuedMessage[]>(() => {
    try {
      const sid = sessionId;
      if (sid) {
        const map = loadQueuedFromStorage<QueuedMessage>();
        return map.get(sid) ?? [];
      }
    } catch {}
    return [];
  });
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  /**
   * 需要接管键盘焦点的待发卡片 id：用户在输入框按回车生成卡片后，卡片按钮
   * 立刻获得焦点，方向键即可在「转向 / 立即发送 / 取消」之间移动、回车即点击。
   */
  const [focusCardId, setFocusCardId] = useState<string | null>(null);
  const queuedBySessionRef = useRef<Map<string, QueuedMessage[]>>(loadQueuedFromStorage());
  // 「立即发送」发起的程序化停止标记：命中后旧回合的 stopped 终态不得再把其余排队卡片回吐到输入框。
  const programmaticStopMarkRef = useRef<ProgrammaticStopMark | null>(null);
  /** Daemon capability list from the last session detail. New daemons advertise
   *  `terminal_operation_id`; the local stop mark is only a legacy fallback. */
  const serverCapsRef = useRef<string[]>([]);
  // Refresh during the stop → start transition loses the in-memory mark. Restore
  // it once so a late terminal for the displaced turn is still classified as
  // programmatic, not as the user stopping the replacement turn.
  useEffect(() => {
    if (!programmaticStopMarkRef.current) {
      programmaticStopMarkRef.current = readPersistedProgrammaticStopMark();
    }
  }, []);
  // Client correlation id of the turn currently owning each session. The
  // daemon stamps terminal frames with the same id; a late terminal from a
  // displaced turn is ignored instead of clearing the replacement turn.
  const currentOperationBySessionRef = useRef<Map<string, string>>(new Map());
  /** 执行态 revision 闸门：只接受更高的 runtime_activity / /chat/runtime 快照。 */
  const runtimeRevisionBySessionRef = useRef<Map<string, number>>(new Map());
  /** 该会话已从服务端拿到带 revision 的执行态；只有这类会话才忽略旧 activity。 */
  const runtimeAuthoritativeBySessionRef = useRef<Set<string>>(new Set());
  /** Forces the queue-drain effect to re-evaluate once runtime authority lands. */
  const [runtimeAuthorityEpoch, setRuntimeAuthorityEpoch] = useState(0);
  const runtimeAuthorityFetchRef = useRef<Map<string, Promise<RuntimeAuthoritySnapshot>>>(new Map());
  function markRuntimeAuthoritative(sid: string) {
    if (runtimeAuthoritativeBySessionRef.current.has(sid)) return;
    runtimeAuthoritativeBySessionRef.current.add(sid);
    setRuntimeAuthorityEpoch((epoch) => epoch + 1);
  }
  function fetchRuntimeAuthority(sid: string): Promise<RuntimeAuthoritySnapshot> {
    const key = `${sid}|${currentOperationBySessionRef.current.get(sid) ?? ''}`;
    const existing = runtimeAuthorityFetchRef.current.get(key);
    if (existing) return existing;
    const promise = getChatRuntime(sid)
      .then((runtime) => ({ runtime, running: serverRuntimeRunning(runtime) }))
      .catch(() => getActiveChatSessions()
        .then((actives) => ({ runtime: null, running: actives.includes(sid) }))
        .catch(() => ({ runtime: null, running: false })))
      .finally(() => {
        if (runtimeAuthorityFetchRef.current.get(key) === promise) {
          runtimeAuthorityFetchRef.current.delete(key);
        }
      });
    runtimeAuthorityFetchRef.current.set(key, promise);
    return promise;
  }
  function noteTurnOperation(sid: string | null | undefined, operationId: string | null | undefined) {
    if (!sid || !operationId) return;
    currentOperationBySessionRef.current.set(sid, operationId);
  }
  function isTerminalFromOtherTurn(
    event: { operation_id?: string; session_id?: string },
    sid: string | null | undefined,
  ): boolean {
    const operationId = event.operation_id;
    // Legacy daemons do not stamp terminals: keep the previous classification.
    if (!operationId) return false;
    const target = sid ?? event.session_id;
    const current = target ? currentOperationBySessionRef.current.get(target) : undefined;
    if (!current) return false;
    return current !== operationId;
  }
  /** 本实例正在 HTTP 飞行中（尚未被服务端 `/chat/queue` 确认）的卡片身份集合。
   *  仅对这些由本标签页发起且在途的卡片做防闪烁保留；其它端撤回（Esc/取消）或已消费的卡片
   *  一旦从服务端队列消失，收到 `queue_updated` 时必须立即从本端同步移除。 */
  const localUnsyncedQueueIdsRef = useRef<Set<string>>(new Set());
  /** One deterministic replay of a server-owned `steering` card per page. */
  const steerReplayAttemptedRef = useRef<Set<string>>(new Set());
  function queueCardSyncKey(item: { id: number | string; clientInputId?: string }): string {
    return item.clientInputId || String(item.id);
  }
  /**
   * 队列三处一致性写入的唯一出口：内存会话映射 + localStorage + 后端 `/chat/queue`。
   * 任何队列变更都必须走这里，否则刷新/换端时后端旧副本会把已出队的卡片复活。
   */
  function persistSessionQueue(sid: string, next: QueuedMessage[]) {
    if (next.length > 0) {
      queuedBySessionRef.current.set(sid, [...next]);
    } else {
      queuedBySessionRef.current.delete(sid);
    }
    saveQueuedToStorage(queuedBySessionRef.current);
    const inFlightKeys = next.map(queueCardSyncKey);
    for (const key of inFlightKeys) localUnsyncedQueueIdsRef.current.add(key);
    const baseRevision = queueRevisionBySessionRef.current.get(sid);
    // Never issue an unconditional whole-list write while the server snapshot is
    // still loading. The next authoritative queue read will merge and flush these
    // local changes with its revision.
    if (baseRevision === undefined) {
      refreshQueuedFromServer(sid);
      return;
    }
    void saveChatQueue(
      sid,
      next.map(serializeQueuedCard) as QueuedMessageApiItem[],
      baseRevision,
    )
      .then((result) => {
        queueRevisionBySessionRef.current.set(sid, result.revision);
        if (result.conflict) {
          // Keep local mutations marked until the conflict snapshot has merged
          // them and a CAS retry succeeds.
          refreshQueuedFromServer(sid);
        } else {
          for (const key of inFlightKeys) localUnsyncedQueueIdsRef.current.delete(key);
        }
      })
      .catch(() => {});
  }

  function setQueuedLocal(next: QueuedMessage[]) {
    queuedRef.current = next;
    const sid = activeIdRef.current;
    if (sid) {
      if (next.length > 0) queuedBySessionRef.current.set(sid, [...next]);
      else queuedBySessionRef.current.delete(sid);
      saveQueuedToStorage(queuedBySessionRef.current);
    }
    setQueuedState(next);
  }

  /**
   * 定向更新某个会话的队列：前台就是该会话时走响应式 `setQueued`，否则只改该会话缓存；
   * 两条路都会镜像到 localStorage 与后端 `/chat/queue`，保证跨会话操作后三处依旧一致。
   */
  function updateQueuedForSession(
    sid: string | null | undefined,
    updater: (items: QueuedMessage[]) => QueuedMessage[],
  ) {
    if (!sid) return;
    if (activeIdRef.current === sid) {
      setQueued(updater);
      return;
    }
    persistSessionQueue(sid, updater(queuedBySessionRef.current.get(sid) ?? []));
  }

  function setQueued(
    update: QueuedMessage[] | ((current: QueuedMessage[]) => QueuedMessage[]),
  ) {
    // SSE callbacks can run before Preact commits the next render. Keep the ref
    // authoritative synchronously so a reconnect snapshot cannot miss a just-
    // queued message and accidentally drain it under an unknown terminal.
    const next = typeof update === 'function' ? update(queuedRef.current) : update;
    queuedRef.current = next;
    const sid = activeIdRef.current;
    if (sid) persistSessionQueue(sid, next);
    setQueuedState(next);
  }

  /**
   * 权威卡片队列落地（跨端广播 / 本会话 `queue_updated` 帧）。
   *
   * 卡片生命周期（创建 → 点转向 → 转为用户气泡 / 按 Esc 取消）必须在每个端一致可见，
   * 但队列的真相在后端：收到信号后拉一次全量，本地只做两件事：
   * 1. 丢掉已进入正文的卡片（已消费的转向不能复活）；
   * 2. 仅保留本标签页自己仍在 HTTP 飞行中（尚未落到服务端 `/chat/queue`）的卡片；
   *    对端已撤回（Esc/取消）或已消费的 `steer` 卡片必须立即移除。
   * 只写本地三处（内存映射 / localStorage / 前台 state），**不回写后端** ——
   * 否则“广播 → 回写 → 再广播”会回声。
   */
  function applyServerQueue(
    sid: string,
    serverItems: QueuedMessageApiItem[] | null | undefined,
    opts?: { hydration?: boolean },
  ) {
    if (!sid || !Array.isArray(serverItems)) return;
    const isCurrentView = activeIdRef.current === sid;
    const known = [
      ...(isCurrentView ? messagesRef.current : []),
      ...(messageCacheRef.current.get(sid) ?? []),
    ];
    // The server queue is authoritative except for this tab's unconfirmed writes.
    const local = isCurrentView ? queuedRef.current : (queuedBySessionRef.current.get(sid) ?? []);
    const items = (serverItems.map(deserializeQueuedCard) as unknown as QueuedMessage[]).filter(
      (item) => !queuedCardOnCanvas(known, item, sid) && !steerCardAlreadyFolded(item, sid, known),
    );
    const localByKey = new Map<string, QueuedMessage>();
    for (const card of local) {
      if (card.clientInputId) localByKey.set(card.clientInputId, card);
      localByKey.set(String(card.id), card);
    }

    const mergedServerItems = items.map((serverCard) => {
      const match = (serverCard.clientInputId ? localByKey.get(serverCard.clientInputId) : undefined)
        ?? localByKey.get(String(serverCard.id));
      if (!match) return serverCard;
      const localMutationInFlight = [
        queueCardSyncKey(match),
        match.clientInputId,
        String(match.id),
      ].some((key) => !!key && localUnsyncedQueueIdsRef.current.has(key));
      // Only an unconfirmed mutation in this tab may outrank the server.
      // After refresh, the revisioned server snapshot decides whether a steer
      // was accepted or must return to the ordinary queue state.
      const ranked = mergeQueuedCardState(serverCard, match, localMutationInFlight);
      const images =
        serverCard.images && serverCard.images.length > 0
          ? serverCard.images
          : match.images;
      return images && images.length > 0 ? { ...ranked, images } : ranked;
    });
    // Once the server confirms steering/steer, its queue record is authoritative.
    // Drop the local unsynced marker so no whole-list echo is written back.
    for (const item of mergedServerItems) {
      if (item.kind === 'steering' || item.kind === 'steer') {
        localUnsyncedQueueIdsRef.current.delete(queueCardSyncKey(item));
      }
    }
    const serverIds = new Set(mergedServerItems.map((item) => String(item.id)));
    const serverClientIds = new Set(
      mergedServerItems.map((item) => item.clientInputId).filter((id): id is string => !!id),
    );
    const next = [
      ...mergedServerItems,
      ...local.filter(
        (item) =>
          !serverIds.has(String(item.id)) &&
          (!item.clientInputId || !serverClientIds.has(item.clientInputId)) &&
          !queuedCardOnCanvas(known, item, sid) &&
          !steerCardAlreadyFolded(item, sid, known) &&
          localUnsyncedQueueIdsRef.current.has(queueCardSyncKey(item)),
      ),
    ];
    if (next.length > 0) queuedBySessionRef.current.set(sid, next);
    else queuedBySessionRef.current.delete(sid);
    saveQueuedToStorage(queuedBySessionRef.current);
    const unsynced = next.filter((item) =>
      localUnsyncedQueueIdsRef.current.has(queueCardSyncKey(item)),
    );
    const revision = queueRevisionBySessionRef.current.get(sid);
    if (unsynced.length > 0 && revision === undefined) {
      refreshQueuedFromServer(sid);
    } else if (unsynced.length > 0) {
      const persisted = serverItems.map(deserializeQueuedCard) as unknown as QueuedMessage[];
      for (const localCard of unsynced) {
        const index = persisted.findIndex((item) =>
          (localCard.clientInputId && item.clientInputId === localCard.clientInputId) ||
          String(item.id) === String(localCard.id),
        );
        if (index < 0) {
          persisted.push(localCard);
          continue;
        }
        const serverCard = persisted[index]!;
        const kindRank = (kind: QueuedMessage['kind']) =>
          kind === 'steer' ? 2 : kind === 'steering' ? 1 : 0;
        persisted[index] = {
          ...serverCard,
          ...(kindRank(localCard.kind) > kindRank(serverCard.kind) ? { kind: localCard.kind } : {}),
          ...(localCard.images?.length && !serverCard.images?.length ? { images: localCard.images } : {}),
        };
      }
      const keys = unsynced.map(queueCardSyncKey);
      void saveChatQueue(
        sid,
        persisted.map(serializeQueuedCard) as QueuedMessageApiItem[],
        queueRevisionBySessionRef.current.get(sid),
      )
        .then((result) => {
          queueRevisionBySessionRef.current.set(sid, result.revision);
          if (result.conflict) {
            refreshQueuedFromServer(sid);
          } else {
            for (const key of keys) localUnsyncedQueueIdsRef.current.delete(key);
          }
        })
        .catch(() => {});
    }
    if (isCurrentView) {
      queuedRef.current = next;
      setQueuedState(next);
    }
    if (opts?.hydration) {
      // The queue record is the durable intent. Replaying its submission is
      // deterministic and idempotent on the server; no local intent key needed.
      replayServerSteeringCards(sid, next.filter((item) => item.kind === 'steering'));
    }
  }

  /** Replay one server-recorded `steering` admission per page identity. */
  function replayServerSteeringCards(sid: string, cards: QueuedMessage[]) {
    for (const card of cards) {
      const key = queueCardSyncKey(card);
      if (steerReplayAttemptedRef.current.has(key)) continue;
      steerReplayAttemptedRef.current.add(key);
      void handleSteerQueuedMessage({ ...card, kind: 'queue' }, { silentFailure: true });
    }
  }

  /** 按后端队列拉取并落地（只用于 `queue_updated` 这类轻量失效信号）。 */
  function refreshQueuedFromServer(sid: string) {
    if (!sid) return;
    void getChatQueue(sid)
      .then((snapshot) => {
        const known = queueRevisionBySessionRef.current.get(sid) ?? 0;
        if (!shouldApplyRevision(known, snapshot.revision)) return;
        queueRevisionBySessionRef.current.set(sid, snapshot.revision);
        applyServerQueue(sid, snapshot.items);
      })
      .catch(() => {});
  }

  /**
   * 上一轮结束后仍留在队列里的 `steer`/`steering` 卡片：可能是内核正把它落成
   * 新一轮的“自然发出”，也可能真的没被消费。延迟一拍再判定，避免本端 drain
   * 与内核抢同一句话（同一条回答跑两遍）。
   * - 会话重新跑起来 / 气泡已在画布上 → 卡片销毁；
   * - 否则降级为普通排队卡，由 drain 接管，保证不会被默默丢掉。
   */
  function resolveLingeringSteerCards(sid: string) {
    if (!sid) return;
    const isCurrentView = activeIdRef.current === sid;
    const items = isCurrentView ? queuedRef.current : (queuedBySessionRef.current.get(sid) ?? []);
    const lingering = items.filter((item) => item.kind === 'steer' || item.kind === 'steering');
    if (lingering.length === 0) return;
    const running =
      (isCurrentView && busyRef.current) ||
      localTurnSessionsRef.current.has(sid) ||
      backgroundRunningSessionsRef.current.has(sid);
    const known = [
      ...(isCurrentView ? messagesRef.current : []),
      ...(messageCacheRef.current.get(sid) ?? []),
    ];
    const isOnCanvas = (item: QueuedMessage): boolean => {
      // Identity first; if the reconnect lost the client-id ↔ kernel-id mapping,
      // fall back to the exact steer text/image/time match so an already-sent
      // bubble does not leave a ghost card at the tail.
      return steerCardBubbleOnCanvas(known, item);
    };
    updateQueuedForSession(sid, (list) => resolveLingeringSteers(list, running, isOnCanvas));
  }
  // Stop restores the queue into the composer. Block one drain so a busy→idle
  // render cannot send those messages before the cleared queue commits.
  const blockQueueDrainRef = useRef(false);
  // A deferred disk catch-up for the previous tail. The old terminal skips it
  // while the next steer/queued turn is starting; if that next turn fails or
  // stalls, this timer (guarded by busy/local-turn) recovers the tail without
  // waiting for a manual refresh.
  const deferredReconcileTimerRef = useRef<number | null>(null);
  // Last authoritative user-prompt id per session. A synthetic terminal
  // (`watch_closed`) has no daemon message_id; anchor its notice to the turn's
  // own prompt instead of whatever assistant happens to be newest.
  const turnUserAnchorBySessionRef = useRef<Map<string, string>>(new Map());
  // Inputs accepted by the live runtime as in-turn steers but not yet folded at
  // a kernel round boundary. Unlike `queued`, these already belong to the active
  // turn and must be recovered if that turn is cancelled before acknowledgement.
  const [pendingSteers, setPendingSteersState] = useState<PendingLiveSteer[]>([]);
  const pendingSteersRef = useRef(pendingSteers);
  pendingSteersRef.current = pendingSteers;
  const pendingSteersBySessionRef = useRef(new Map<string, PendingLiveSteer[]>());
  // 已被内核 fold（`steered` 回执）的转向指纹，保留到本回合终态。
  // 终态判断排队卡是否已经并入本轮时必须先看这份账本：画布可能因刷新/缓存落后丢了气泡，
  // 但内核确实已经消费过这条转向；只看画布会把它当成未发送再 drain 一遍，
  // 模型会对同一条指令回答两次（表现为结算后最新回答重复一份）。
  const foldedSteersBySessionRef = useRef(
    new Map<string, Array<{ text: string; images?: ImageData[]; clientInputId?: string }>>(),
  );
  function setPendingSteers(
    update: PendingLiveSteer[] | ((current: PendingLiveSteer[]) => PendingLiveSteer[]),
  ) {
    const next = typeof update === 'function' ? update(pendingSteersRef.current) : update;
    pendingSteersRef.current = next;
    const sid = activeIdRef.current;
    if (sid) {
      if (next.length > 0) {
        pendingSteersBySessionRef.current.set(sid, [...next]);
        setStoredSteers(sid, next);
      } else {
        pendingSteersBySessionRef.current.delete(sid);
        setStoredSteers(sid, []);
      }
    }
    setPendingSteersState(next);
  }
  function restorePendingSteers(includeSubmitting = true) {
    const pending = pendingSteersRef.current.filter(
      (item) => includeSubmitting || item.confirmed,
    );
    if (pending.length === 0) return;
    const draft = pendingSteersToDraft(pending);
    const pendingIds = new Set(pending.map((item) => item.id));
    setMessages({ type: 'removeWhere', predicate: (message) =>
      message.pendingSteerId !== undefined && pendingIds.has(message.pendingSteerId),
    });
    setInput((current) => [draft.text, current].filter(Boolean).join('\n'));
    setPendingAttach((current) => [...imagesToPending(draft.images), ...current]);
    setPendingSteers((current) => current.filter((item) => !pendingIds.has(item.id)));
    showToast(t('chat.steerRecovered'), 'info');
  }
  const [tokens, setTokens] = useState<TokenUsage | null>(null);
  const tokensRef = useRef<TokenUsage | null>(null);
  tokensRef.current = tokens;
  const tokenCacheRef = useRef(createTokenCacheState());
  const tokenUsageCacheRef = useRef<Map<string, SessionTokenSnapshot>>(new Map());
  /** Blocks token snapshots from bleeding across a session switch render. */
  const tokenSaveGenerationRef = useRef(0);
  const tokensAuthoritativeRef = useRef(false);
  const lastUserTokensRef = useRef(0);
  const [showTokenDetails, setShowTokenDetails] = useState(false);
  const tokenPopoverRef = useRef<HTMLDivElement>(null);

  const applyAuthoritativeTokenUsage = (usage: {
    prompt: number;
    completion: number;
    total: number;
    cached?: number;
    reasoning?: number;
  }) => {
    const resolved = resolveTokenCache(
      { prompt: usage.prompt, cached: usage.cached },
      tokenCacheRef.current,
    );
    tokenCacheRef.current = resolved.nextState;
    tokensAuthoritativeRef.current = true;
    setTokens({
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.total,
      cached: resolved.cached,
      cached_estimated: resolved.cached_estimated,
      reasoning: usage.reasoning ?? 0,
    });
  };

  const mergeLocalTokens = (
    prev: TokenUsage | null,
    next: { prompt: number; completion: number; total: number; reasoning?: number },
  ): TokenUsage => {
    tokensAuthoritativeRef.current = false;
    const local = estimateLocalCached(tokenCacheRef.current, next.prompt, prev);
    return {
      prompt: next.prompt,
      completion: next.completion,
      total: next.total,
      cached: local.cached,
      cached_estimated: local.cached_estimated,
      reasoning: next.reasoning ?? prev?.reasoning ?? 0,
    };
  };

  const resetTokenTelemetry = () => {
    tokenCacheRef.current = createTokenCacheState();
    tokensAuthoritativeRef.current = false;
    setTokens(null);
  };

  const sessionTokensRunning = (sid: string) =>
    busyRef.current
    || localTurnSessionsRef.current.has(sid)
    || backgroundRunningSessionsRef.current.has(sid);

  const saveTokenSnapshot = (sid: string, authoritative = tokensAuthoritativeRef.current) => {
    if (!tokensRef.current) return;
    const prev = tokenUsageCacheRef.current.get(sid);
    tokenUsageCacheRef.current.set(sid, {
      tokens: { ...tokensRef.current },
      cacheState: { ...tokenCacheRef.current },
      authoritative,
      // 真实 usage 入场才清除压缩标记；本地估算必须保留，否则压缩后的低值
      // 会在下一次 tokens effect 里被自己抹掉。
      ...(authoritative ? { compacted: false } : prev?.compacted ? { compacted: true } : {}),
    });
  };

  /**
   * 写缓存时应该落的 token 度量。
   *
   * 旧代码把 `tokensAuthoritativeRef.current`（boolean）传给了 `tokenUsage` 参数，
   * 缓存里存的一直是 `true/false`，刷新后只能重算估算值。这里统一取本会话的
   * 真实快照；没有快照时为 `null`（显式清空，避免把别的会话的度量写进来）。
   */
  const cachedTokenUsageFor = (sid: string | null | undefined) =>
    sid ? (tokenUsageCacheRef.current.get(sid)?.tokens ?? null) : null;

  const applyTokenUsage = (
    usage: TokenUsage,
    cacheState?: TokenCacheState,
    authoritative = tokensAuthoritativeRef.current,
  ) => {
    if (cacheState) tokenCacheRef.current = { ...cacheState };
    tokensAuthoritativeRef.current = authoritative;
    setTokens({ ...usage });
  };

  const applyServerTokenUsage = (usage: SessionTokenUsage) => {
    // Same formula as the live `tokens` event: last-request prompt + completion.
    // Never take a larger persisted `total` — that used to be turn-billing sum.
    const prompt = Math.max(0, usage.prompt);
    const completion = Math.max(0, usage.completion);
    const cached = clampCachedToPrompt(usage.cached, prompt);
    const cacheState: TokenCacheState = {
      lastPrompt: prompt,
      providerReportsCache: cached > 0 && !usage.cached_estimated,
    };
    applyTokenUsage({
      prompt,
      completion,
      total: prompt + completion,
      cached,
      cached_estimated: Boolean(usage.cached_estimated),
      reasoning: 0,
    }, cacheState, true);
  };

  const applySessionTokens = (
    sid: string | null,
    messages: Message[],
    serverUsage?: SessionTokenUsage | null,
  ) => {
    if (!sid) {
      resetTokenTelemetry();
      return;
    }
    const mem = tokenUsageCacheRef.current.get(sid);
    const running = sessionTokensRunning(sid);

    // A just-committed compaction is NEWER than the persisted turn stat, which
    // still describes the pre-compaction context. Never let that stale (larger)
    // number snap the footer back; the next real usage frame replaces this.
    if (mem?.compacted && serverUsage && serverUsage.total > (mem.tokens.total ?? 0)) {
      applyTokenUsage(mem.tokens, mem.cacheState, false);
      return;
    }

    if (serverUsage && (serverUsage.prompt > 0 || serverUsage.total > 0)) {
      // Persisted turn stats are the idle baseline. During an active turn only
      // prefer in-memory telemetry when it is authoritative and ahead of disk.
      if (running && mem?.authoritative && (mem.tokens.total ?? 0) > serverUsage.total) {
        applyTokenUsage(mem.tokens, mem.cacheState, true);
        return;
      }
      // Older daemons restored turn-cumulative billing (every LLM round summed)
      // as occupancy. That is a different 口径 from the live last-frame
      // (prompt+completion of the last request). Ignore the stacked payload
      // rather than paint 1.7M; fall through to occupancy from messages/mem.
      const windowLimit = serverUsage.ctx_window ?? null;
      if (!isStackedTurnBillingUsage(serverUsage, windowLimit)) {
        applyServerTokenUsage(serverUsage);
        saveTokenSnapshot(sid, true);
        return;
      }
    }

    if (mem && (running || mem.authoritative || mem.compacted)) {
      applyTokenUsage(mem.tokens, mem.cacheState, mem.authoritative);
      return;
    }

    if (messages.length > 0) {
      const est = estimateSessionTokens(messages);
      applyTokenUsage(est.tokens, est.cacheState, false);
      return;
    }
    resetTokenTelemetry();
  };

  useEffect(() => {
    if (!showTokenDetails) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tokenPopoverRef.current && !tokenPopoverRef.current.contains(e.target as Node)) {
        setShowTokenDetails(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTokenDetails(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showTokenDetails]);

  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [historyHint, setHistoryHint] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const isCompactingRef = useRef(false);
  isCompactingRef.current = isCompacting;
  /** 当前会话压缩 pass 的墙钟起点：计时器在压缩期间必须锚定它，而不是上一轮提问。 */
  const [compactionStartedAt, setCompactionStartedAt] = useState<number | null>(null);
  const compactionStartedAtBySessionRef = useRef<Map<string, number>>(new Map());

  function setSessionCompacting(
    targetSid: string | null | undefined,
    compacting: boolean,
    startedAt?: number | null,
  ) {
    if (!targetSid) return;
    let phaseStartedAt: number | null = null;
    if (compacting) {
      // 同一 pass 的重复事件（activity / session_status / runtime 恢复）保留最早起点。
      const known = compactionStartedAtBySessionRef.current.get(targetSid);
      phaseStartedAt = startedAt ?? known ?? Date.now();
      compactionStartedAtBySessionRef.current.set(targetSid, phaseStartedAt);
      compactingSessionsRef.current.add(targetSid);
      // 推送帧（activity / session_status）不带起点时先用收到时刻顶上，同时做一次
      // 边沿对齐把权威的 `compaction_started_at` 拉回来（回放或晚连时修正偏差）。
      if (startedAt == null && known == null) {
        void getChatRuntime(targetSid)
          .then((runtime) => {
            if (!compactingSessionsRef.current.has(targetSid)) return;
            const authStart = runtime.compaction_started_at ?? runtime.started_at;
            if (typeof authStart === 'number' && authStart > 0) {
              compactionStartedAtBySessionRef.current.set(targetSid, authStart);
              if ((activeIdRef.current ?? sessionId) === targetSid) {
                setCompactionStartedAt(authStart);
              }
            }
          })
          .catch(() => {});
      }
    } else {
      compactionStartedAtBySessionRef.current.delete(targetSid);
      compactingSessionsRef.current.delete(targetSid);
    }
    const currentSid = activeIdRef.current ?? sessionId;
    if (currentSid === targetSid) {
      setIsCompacting(compacting);
      setCompactionStartedAt(compacting ? phaseStartedAt : null);
      compactingRef.current = compacting;
      isCompactingRef.current = compacting;
    }
  }
  const [activeTodos, setActiveTodos] = useState<TodoItem[] | null>(null);
  const activeTodosRef = useRef<TodoItem[] | null>(null);
  activeTodosRef.current = activeTodos;
  /** Server-assigned monotonic todo revision per session. A lower snapshot never wins. */
  const todoRevisionBySessionRef = useRef(new Map<string, number>());
  /** Last queue revision observed from `/chat/queue`; guards stale whole-list writes. */
  const queueRevisionBySessionRef = useRef(new Map<string, number>());
  const activeTodosBySessionRef = useRef<Map<string, TodoItem[]>>(new Map());
  // 每个会话一份实时清单。revision 是总线上最后一次 todo 调用，重放同一调用不会改文档。
  const todoLiveBySessionRef = useRef<Map<string, LiveTodoDocument>>(new Map());
  /**
   * 实时清单的本地版本号：每写入一次 +1。
   *
   * 服务端权威清单是异步取回的；只有版本号在请求期间未变，才允许用它整表覆盖。
   * 否则会用一份更旧的快照回滚刚刚落地的实时帧 —— 这是并发控制，不是防抖。
   */
  const todoLiveEpochRef = useRef<Map<string, number>>(new Map());
  function todoLiveEpoch(sessionId: string | null | undefined): number {
    return (sessionId && todoLiveEpochRef.current.get(sessionId)) || 0;
  }
  function bumpTodoLiveEpoch(sessionId: string | null | undefined) {
    if (!sessionId) return;
    todoLiveEpochRef.current.set(sessionId, todoLiveEpoch(sessionId) + 1);
  }
  // 幂等键必须跨刷新存活：/chat/watch 会重放整轮事件，而 todowrite 的 plan/批量 add 是
  // 整表替换（todos.ts），重复折叠会把最新清单打回旧状态。直接从 localStorage 水合恢复。
  const todoAppliedCallIdsRef = useRef<Map<string, Set<string>>>(loadAppliedTodoCallIds());
  function persistAppliedTodoIds() {
    saveAppliedTodoCallIds(todoAppliedCallIdsRef.current);
  }
  /**
   * 幂等键种子：只做"并入"，绝不覆盖。
   * 种子来源（画布窗口内的 todo 调用）天然看不到窗口外的历史 plan，覆盖式种子会把
   * 持久化下来的保护集合冲掉，重放又能把已完成清单打回旧状态。
   */
  function seedAppliedTodoIds(sessionId: string | null | undefined, ids: Iterable<string | null | undefined>) {
    if (!sessionId) return;
    const applied = appliedTodoIdsFor(sessionId);
    let changed = false;
    for (const id of ids) {
      if (id && !applied.has(id)) {
        applied.add(id);
        changed = true;
      }
    }
    if (changed) persistAppliedTodoIds();
  }
  function areTodosEqual(
    a: Array<{ content: string; status: string }> | null | undefined,
    b: Array<{ content: string; status: string }> | null | undefined,
  ): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const itemA = a[i];
      const itemB = b[i];
      if (!itemA || !itemB) return false;
      if (itemA.content !== itemB.content || itemA.status !== itemB.status) return false;
    }
    return true;
  }

  function applySessionStickyTodos(sessionId: string | null | undefined, items: TodoItem[] | null) {
    const sticky = items && items.length > 0 ? items.map((i) => ({ ...i })) : null;
    const current = activeTodosRef.current;
    if (sessionId) {
      if (sticky) activeTodosBySessionRef.current.set(sessionId, sticky);
      else {
        // 关键防线：清单全完成时**绝不能**清空幂等键。那正是最容易被重放覆盖的时刻
        // （旧 plan 一重折就把打钩状态打回原形并定格）。新计划自带新 callId，无需清空。
        activeTodosBySessionRef.current.delete(sessionId);
      }
    }
    // 会话隔离硬约束：后台会话的晚到响应只更新 per-session 缓存，绝不写当前视图。
    // 否则 A 会话的 todo 会串进正在查看的 B 会话面板与缓存。
    if (sessionId && sessionId !== activeIdRef.current) return;
    // 关键防抖：全量比对（数量、内容、状态）。若完全相等，直接跳过，杜绝任何 DOM 抖动闪烁！
    if (areTodosEqual(current, sticky)) return;
    // 只要有任何一处不一致（无论是数量变化还是状态变动），直接以服务端为权威整体覆盖并反写缓存，干脆快速！
    setActiveTodos(sticky);
    activeTodosRef.current = sticky;
    if (sessionId) {
      scheduleCanvasCacheSave();
    }
  }

  /**
   * 转录被物理回退（回溯 / 删除整轮 / 删除回答 / 停止回落）之后重新对齐清单。
   *
   * 旧策略是一刀切清空：同一轮内建立又删除时没错，但跨轮次会误杀 —— A 轮建立的计划
   * 若只在 steer 之后被改过几项，回溯掉 steer 之后的消息不该把 A 轮的计划一起清掉。
   * 现在后端按「剩余转录」重新推导 todo 板（derive_current_todos），前端直接拉回权威清单：
   * 该操作消息之前的动作原样保留，被删掉的动作自然消失；整轮删完则为空（与旧行为等价）。
   *
   * 不动幂等键：被删行的 callId 留着无害（防旧帧重放），剩余行仍需保护。
   */
  function resyncTodosAfterMutation(sessionId: string | null | undefined) {
    if (!sessionId) return;
    const hash =
      projectHashBySessionRef.current.get(sessionId) ||
      (sessionId === activeIdRef.current ? viewedProjectHashRef.current : null) ||
      activeSession?.project_hash ||
      '';
    if (!hash) {
      // 拿不到 project hash（极早期）→ 先清本地文档，下次会话加载以服务端为准重建。
      writeLiveTodo(sessionId, null);
      return;
    }
    void pullSession({ projectHash: hash, sessionId, mode: 'snapshot', limit: 1 })
      .then((detail) => {
        const items = Array.isArray(detail?.todos) ? detail.todos : [];
        applyAuthoritativeTodos(sessionId, items, undefined, detail?.todos_revision);
      })
      .catch(() => {
        writeLiveTodo(sessionId, null);
      });
  }
  function adoptStickyFromMessages(
    sessionId: string | null | undefined,
    messages: Message[],
    stashed?: TodoItem[] | null,
    authoritativeTodos?: TodoItem[] | null,
  ) {
    const surface = hydrateSession(messages, authoritativeTodos, stashed);
    applySessionStickyTodos(sessionId, surface.todos);
    if (sessionId) {
      bumpTodoLiveEpoch(sessionId);
      const hydrated = reduceLiveTodo(null, { type: 'hydrate', items: surface.todos ?? [] });
      if (hydrated) todoLiveBySessionRef.current.set(sessionId, hydrated);
      else todoLiveBySessionRef.current.delete(sessionId);
    }
    if (!sessionId) return;
    seedAppliedTodoIds(sessionId, surface.appliedTodoIds);
  }
  /**
   * 以服务端 `todos` 为唯一权威，整表覆盖本地实时清单。
   *
   * `todos` 来自会话唯一的 `TodoBoard`（工具每次执行同步提交），不是滞后的磁盘快照：
   *  - 有任何一项不同 → 整体替换；
   *  - 空表同样是权威 —— 全部完成已关闭 / 已回溯，必须清空面板与缓存。
   *
   * `requestEpoch` 是发起请求时的本地版本号：期间若有实时帧推进了清单，这份响应
   * 已经过期，丢弃（避免旧快照回滚新状态）。
   */
  function applyAuthoritativeTodos(
    sessionId: string | null | undefined,
    items: TodoItem[] | null | undefined,
    requestEpoch?: number,
    revision?: number,
  ): boolean {
    if (!sessionId) return false;
    if (requestEpoch !== undefined && todoLiveEpoch(sessionId) !== requestEpoch) return false;
    if (!Array.isArray(items)) return false;
    // 版本仲裁：服务端是唯一写入者，低 revision 的晚到快照绝不能回滚高版本。
    if (typeof revision === 'number') {
      const current = todoRevisionBySessionRef.current.get(sessionId) ?? 0;
      if (!shouldApplyRevision(current, revision)) return false;
      todoRevisionBySessionRef.current.set(sessionId, revision);
    }
    writeLiveTodo(sessionId, reduceLiveTodo(null, { type: 'hydrate', items }));
    return true;
  }
  function liveTodoDoc(sessionId: string | null | undefined): LiveTodoDocument | null {
    if (sessionId) {
      const stored = todoLiveBySessionRef.current.get(sessionId);
      if (stored) return stored;
    }
    const items = sessionId
      ? activeTodosBySessionRef.current.get(sessionId) ?? null
      : activeTodosRef.current;
    if (!items || items.length === 0) return null;
    return { items, revision: null, resultApplied: false };
  }
  function writeLiveTodo(sessionId: string | null | undefined, doc: LiveTodoDocument | null) {
    bumpTodoLiveEpoch(sessionId);
    if (sessionId) {
      if (doc) todoLiveBySessionRef.current.set(sessionId, doc);
      else todoLiveBySessionRef.current.delete(sessionId);
    }
    const items = doc?.items ?? null;
    if (!sessionId || sessionId === activeIdRef.current) {
      applySessionStickyTodos(sessionId, items);
      return;
    }
    if (items && items.length > 0) activeTodosBySessionRef.current.set(sessionId, items);
    else activeTodosBySessionRef.current.delete(sessionId);
  }
  /** 最终停止且正文已经落地。只有全部勾完才贴到最后一条助手消息，然后清掉实时清单。 */
  function commitActiveTodosIntoLastAssistant() {
    const sid = activeIdRef.current;
    if (!sid) return;
    const doc = liveTodoDoc(sid);
    const settled = settleLiveTodo(doc);
    if (!settled.archive) return;
    const next = placeArchivedTodos(messagesRef.current, settled.archive, doc?.revision ?? null);
    messagesRef.current = next;
    messageCacheRef.current.set(sid, next);
    writeLiveTodo(sid, settled.next);
    // 归档会把 todo 面板从输入区搬进正文：高度变化必须走阅读锚点事务，
    // 否则浏览器按像素保留 scrollTop，滚动条会自己跳到中间。
    timelineFollowRef.current?.beginSwap();
    setMessages({ type: 'replace', rows: next });
    timelineFollowRef.current?.endSwap();
  }
  function archiveBackgroundTodos(sessionId: string) {
    if (!sessionId || sessionId === activeIdRef.current) return;
    const doc = liveTodoDoc(sessionId);
    const settled = settleLiveTodo(doc);
    if (!settled.archive) return;
    const cached = messageCacheRef.current.get(sessionId);
    if (cached) {
      messageCacheRef.current.set(
        sessionId,
        placeArchivedTodos(cached, settled.archive, doc?.revision ?? null),
      );
    }
    writeLiveTodo(sessionId, settled.next);
  }
  function appliedTodoIdsFor(sessionId: string | null | undefined): Set<string> {
    if (!sessionId) return new Set();
    let ids = todoAppliedCallIdsRef.current.get(sessionId);
    if (!ids) {
      ids = new Set();
      todoAppliedCallIdsRef.current.set(sessionId, ids);
    }
    return ids;
  }
  // Auxiliary persistence failures belong to application chrome, not the
  // assistant transcript. Replacing this value also deduplicates repeated
  // failures for the same session/path.
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  // 正在拉取某会话历史：用于抑制落地页，避免切到「有内容的会话」时先闪一下落地页。
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const providerPinnedRef = useRef(false);
  const NEW_SESSION_PROVIDER_KEY = '__new__';
  const providerCacheRef = useRef(new Map<string, string>());
  const NEW_SESSION_MODE_KEY = '__new__';
  const modeCacheRef = useRef(new Map<string, ApprovalMode>());
  const effortCacheRef = useRef(new Map<string, { effort: string | null; budget: number | null }>());
  const [sessionEffort, setSessionEffort] = useState<string | null | undefined>(undefined);
  const [sessionBudget, setSessionBudget] = useState<number | null | undefined>(undefined);
  const rememberSessionEffort = useCallback(
    (sid: string | null, effort: string | null, budget: number | null) => {
      setSessionEffort(effort);
      setSessionBudget(budget);
      if (sid) {
        effortCacheRef.current.set(sid, { effort, budget });
        const hash = projectHashBySessionRef.current.get(sid) || viewedProjectHashRef.current;
        if (hash) {
          updateSessionCacheMeta(hash, sid, { reasoningEffort: effort, thinkingBudget: budget });
        }
      }
    },
    [],
  );
  const restoreSessionEffort = useCallback(
    (sid: string | null, fallback: { effort?: string | null; budget?: number | null } | null) => {
      const cached = sid ? effortCacheRef.current.get(sid) : undefined;
      if (cached) {
        setSessionEffort(cached.effort);
        setSessionBudget(cached.budget);
        return;
      }
      // 会话自己存过强度就用它；否则回退到 provider 继承（undefined）。
      setSessionEffort(fallback?.effort ?? undefined);
      setSessionBudget(fallback?.budget ?? undefined);
    },
    [],
  );
  const modeCacheKey = useCallback(
    (sid: string | null) => sid ?? NEW_SESSION_MODE_KEY,
    [],
  );
  const restoreModeForSession = useCallback(
    (sid: string | null, fallbackMode?: ApprovalMode | null, isProtocol?: boolean) => {
      if (isProtocol) {
        nativeModeRef.current = 'bypass';
        setModeState(initModeState('bypass'));
        return;
      }
      const cached = modeCacheRef.current.get(modeCacheKey(sid));
      if (cached) {
        nativeModeRef.current = cached;
        setModeState(initModeState(cached));
        return;
      }
      if (fallbackMode) {
        modeCacheRef.current.set(modeCacheKey(sid), fallbackMode);
        nativeModeRef.current = fallbackMode;
        setModeState(initModeState(fallbackMode));
        return;
      }
      if (sid) {
        getApprovalMode(sid)
          .then((m) => {
            if (activeIdRef.current === sid) {
              modeCacheRef.current.set(modeCacheKey(sid), m);
              nativeModeRef.current = m;
              setModeState(initModeState(m));
            }
          })
          .catch(() => {});
      }
    },
    [modeCacheKey],
  );
  const localTurnSessionsRef = useRef(new Set<string>());
  const backgroundRunningSessionsRef = useRef(new Set<string>());
  /** Project bucket for a session we may finish off-screen. */
  const projectHashBySessionRef = useRef(new Map<string, string>());
  const backgroundFinishTimerRef = useRef<number | null>(null);
  const defaultProviderName = useCallback(
    () => modelCatalog.find((m) => m.is_default)?.provider
      ?? modelCatalog[0]?.provider
      ?? null,
    [modelCatalog],
  );
  const providerCacheKey = useCallback(
    (sid: string | null) => sid ?? NEW_SESSION_PROVIDER_KEY,
    [],
  );
  const restoreProviderForSession = useCallback(
    (sid: string | null, fallbackPreferred?: string | null) => {
      const cached = providerCacheRef.current.get(providerCacheKey(sid));
      if (cached) {
        setProvider(cached);
        providerPinnedRef.current = true;
        return;
      }
      if (fallbackPreferred) {
        setProvider(fallbackPreferred);
        providerCacheRef.current.set(providerCacheKey(sid), fallbackPreferred);
        providerPinnedRef.current = true;
        return;
      }
      setProvider(defaultProviderName());
      providerPinnedRef.current = false;
    },
    [defaultProviderName, providerCacheKey],
  );
  const followDefaultProvider = useCallback(
    (name: string) => {
      if (providerPinnedRef.current) return;
      // 只有在空会话落地页（无消息、无历史）时才跟随全局默认模型！已有会话坚决不跟随！
      const isNewLanding =
        !activeIdRef.current ||
        (activeSession?.id === activeIdRef.current &&
          (activeSession?.message_count ?? 0) === 0 &&
          messagesRef.current.length === 0);
      if (!isNewLanding) return;
      setProvider(name);
    },
    [activeSession],
  );

  useEffect(() => {
    let active = true;
    const fetchCatalog = () => {
      getModels()
        .then((m) => {
          if (active) setModelCatalog(m);
        })
        .catch(() => {});
    };
    fetchCatalog();

    window.addEventListener('jeikcode:config-reloaded', fetchCatalog);
    window.addEventListener('jeikcode:reload-models', fetchCatalog);
    return () => {
      active = false;
      window.removeEventListener('jeikcode:config-reloaded', fetchCatalog);
      window.removeEventListener('jeikcode:reload-models', fetchCatalog);
    };
  }, [provider]);

  const activeModelMeta = modelCatalog.find((m) => m.provider === provider)
    ?? modelCatalog.find((m) => m.is_default)
    ?? modelCatalog[0];
  const contextLimit = activeModelMeta?.context_window;
  // 审批模式（build / accept_edits / bypass / plan）。进程级 runtime 状态，
  // 由 /live snapshot + 'mode' 事件同步，切换调 postLiveMode（当前回合立即生效）。
  // confirmedMode 是 daemon 已确认值。--host 新建会话默认 Build；协议会话观察时显示 Auto。
  const [modeState, setModeState] = useState(() => initModeState('build' as ApprovalMode));
  /** 全局模式开关（默认关闭）。开启后所有会话统一跟随 `modeState.confirmedMode`。 */
  const [globalModeEnabled, setGlobalModeEnabled] = useState(false);
  const globalModeRef = useRef(false);
  globalModeRef.current = globalModeEnabled;
  /** 由渲染作用域赋值；事件处理器通过 ref 调用以拿到最新闭包。 */
  const applyOwnSessionModeRef = useRef<(sid: string) => void>(() => {});
  const nativeModeRef = useRef<ApprovalMode>('build');
  const protocolSessionRef = useRef(false);
  const [pendingAttach, setPendingAttach] = useState<PendingAttach[]>(() =>
    initialDraft?.images ? imagesToPending(initialDraft.images) : [],
  );
  const pendingAttachRef = useRef(pendingAttach);
  pendingAttachRef.current = pendingAttach;
  const initialBubbleDraft = sessionId ? loadBubbleEditDraft(sessionId) : null;
  const [editingSourceIndex, setEditingSourceIndex] = useState<number | null>(() =>
    initialBubbleDraft?.sourceIndex ?? null,
  );
  const [bubbleEditDraft, setBubbleEditDraft] = useState<BubbleEditDraft | null>(() => initialBubbleDraft);
  const isFirstMountRef = useRef(true);
  const nativeFileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    body: string;
    danger?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    icon?: string;
    onConfirm: () => Promise<void> | void;
  }>({
    open: false,
    title: '',
    body: '',
    onConfirm: () => {},
  });
  const [slashSkills, setSlashSkills] = useState<SkillInfo[] | null>(null);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  // The /skills command opens a pure skills browser (no commands). Set while that
  // browser is showing; cleared as soon as the user types (normal mixed filtering).
  const [slashSkillsOnly, setSlashSkillsOnly] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atIndex, setAtIndex] = useState(0);
  const [atItems, setAtItems] = useState<{ name: string; is_dir: boolean }[]>([]);
  const [atLoading, setAtLoading] = useState(false);
  // Pending structured input from either transport. The event's optional session_id
  // selects `/chat/user-input`; legacy live requests used the bound `/live` runtime.
  const [userInputReq, setUserInputReq] = useState<UserInputRequestEvent | null>(null);
  useEffect(() => {
    onBindReviewDismiss?.({
      // /live permission cards were retired with the live transport; /chat uses
      // the `onPermission` prop and `/chat/permission` instead.
      permission: () => {},
      userInput: () => setUserInputReq(null),
    });
  }, [onBindReviewDismiss]);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string | null>(null);
  /** 专用于跟踪当前正在活跃接收 streamChat 的本地请求 ID（UUID），防止被后台查询异步改写的 requestIdRef 干扰 */
  const activeStreamRequestIdRef = useRef<string | null>(null);
  /** 按会话隔离本端发起的活跃本地流，切会话时保留控制器并在切回时无缝接管，杜绝双流并行与重放重叠 */
  const localActiveStreamsBySessionRef = useRef<Map<string, {
    abortController: AbortController;
    requestId: string;
    /** `/chat/watch` 观察流注册的条目：只代表“看见它在跑”，不代表本端拥有回合。 */
    watchOnly?: boolean;
  }>>(new Map());
  /** 按会话隔离待去重自身用户消息 echo */
  const pendingSelfEchoBySessionRef = useRef<Map<string, Array<{ id: string; text: string }>>>(new Map());
  /** 会话切入时的画布就绪标记：当前会话内存缓存已完全同步落入 messagesRef.current 和 state 后标记为该 sessionId */
  const canvasReadySessionIdRef = useRef<string | null>(null);
  /** 挂载就绪前的推流暂存队列（按 sessionId 隔离） */
  const preMountStreamBufferRef = useRef<Map<string, Array<{ frame: SSEEvent; opts?: any }>>>(new Map());

  function flushPreMountStreamBuffer(sid: string | null) {
    if (!sid || activeIdRef.current !== sid) return;
    const buffer = preMountStreamBufferRef.current.get(sid);
    if (!buffer || buffer.length === 0) return;
    preMountStreamBufferRef.current.delete(sid);
    for (const item of buffer) {
      if (item.frame.type === 'text' || item.frame.type === 'reasoning') {
        ensureAssistantBubbleForWatch();
      }
      handleEvent(item.frame, item.opts);
    }
    timelineFollow.changed();
  }
  const liveLifecycleRef = useRef(createLiveLifecycleState());
  const bottomRef = useRef<HTMLDivElement>(null);
  // Scroll container + "am I at the bottom?" tracking. Auto-follow during streaming
  // ONLY while the user is at the bottom; scrolling up releases the follow so history
  // stays put. A ref (not state) avoids re-rendering on every scroll event.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // One-shot layout settle for the initial tail. Async Markdown/tool-card
  // expansion can finish after the first bottom write; do not keep re-pinning
  // after the user starts loading older history.
  const initialPinPendingRef = useRef(false);
  const [showJumpBtn, setShowJumpBtn] = useState(false);
  const timelineFollowRef = useRef<ReturnType<typeof createTimelineFollow> | null>(null);
  if (!timelineFollowRef.current) {
    timelineFollowRef.current = createTimelineFollow(atBottomRef, setShowJumpBtn);
  }
  const timelineFollow = timelineFollowRef.current;
  const attachTimeline = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    timelineFollow.attach(node);
  }, [timelineFollow]);
  useEffect(() => () => timelineFollow.dispose(), [timelineFollow]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHistoryRef = useRef(new InputHistory());
  const historyProject = activeSession?.id === sessionId
    ? activeSession.project_hash || effectiveWorkingDir || '' : effectiveWorkingDir || '';
  const historyContext = inputHistoryKey(historyProject, sessionId);
  const pendingHistoryCaretRef = useRef<{ context: string; value: string; position: number } | null>(null);
  useLayoutEffect(() => {
    inputHistoryRef.current.switchContext(historyContext);
    pendingHistoryCaretRef.current = null;
    return () => { pendingHistoryCaretRef.current = null; };
  }, [historyContext]);
  useLayoutEffect(() => {
    const pending = pendingHistoryCaretRef.current;
    pendingHistoryCaretRef.current = null;
    const ta = textareaRef.current;
    if (!pending || !ta || pending.context !== historyContext || pending.value !== input) return;
    ta.setSelectionRange(pending.position, pending.position);
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input, historyContext]);

  // 首次挂载时如果恢复了草稿，自适应调整 textarea 高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && input) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, []);

  // 实时持久化当前活动会话的输入框草稿（文字与图片附件），确保刷新或重启页面后不丢失
  useEffect(() => {
    if (activeIdRef.current === sessionId) {
      saveComposerDraft(sessionId, {
        text: input,
        images: pendingImageData(pendingAttach),
      });
    }
  }, [input, pendingAttach, sessionId]);
  const slashRef = useRef<HTMLDivElement>(null);
  const atRef = useRef<HTMLDivElement>(null);
  // 当前 Chat 正在显示的会话 id。用于区分「外部切换会话(需重置+加载历史)」
  // 与「本次新建会话首条消息完成后自己拿到的 id(不应重置)」。
  const activeIdRef = useRef<string | null>(null);
  // Distinguish async work from A -> B -> A session switches. Comparing only
  // the session id would let the first A's late active-check/cancel result
  // mutate the replacement A view.
  const sessionGenerationRef = useRef(0);
  const renderedSessionIdRef = useRef(sessionId);
  if (renderedSessionIdRef.current !== sessionId) {
    // Advance during render, before a passive effect can abort the old reader.
    // An accepted first-turn `done` pre-binds activeIdRef to its new id, so that
    // normal null -> canonical-id prop update does not invalidate its own tail.
    if (activeIdRef.current !== sessionId) sessionGenerationRef.current += 1;
    renderedSessionIdRef.current = sessionId;
  }
  // 已为哪个 sessionId 触发过历史加载（或它是本 Chat 自建的会话）。用于避免
  // project_hash 迟到（刷新后由 App 异步回填）导致的重复加载 / 覆盖当前对话。
  const loadedForRef = useRef<string | null>(null);
  const historyOffsetRef = useRef(0);
  const historyTotalRef = useRef(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyOffsetBySessionRef = useRef<Map<string, number>>(new Map());
  const historyTotalBySessionRef = useRef<Map<string, number>>(new Map());
  const hasOlderBySessionRef = useRef<Map<string, boolean>>(new Map());
  const [turnOutline, setTurnOutline] = useState<SessionTurnOutline[]>([]);
  const turnOutlineRef = useRef(turnOutline);
  turnOutlineRef.current = turnOutline;
  const turnOutlineBySessionRef = useRef<Map<string, SessionTurnOutline[]>>(new Map());
  /** Stable turn-nav id pending a scroll-jump after older history loads. */
  const pendingJumpIdRef = useRef<string | null>(null);
  // While another client (OpenAI API) owns `/chat/active`:
  // 1) `GET /chat/watch` reattaches to the live event bus (real-time progress)
  // 2) light history poll as a fallback for events missed before join
  const detachedPollTimerRef = useRef<number | null>(null);
  const detachedWatchAbortRef = useRef<AbortController | null>(null);
  const sessionWatchersRef = useRef<Map<string, AbortController>>(new Map());
  // 终端收尾/停止屏障：记录刚刚收尾结束或手动停止的会话与其保护截止时间戳。
  // 设立 2.5 秒的屏障，防止刚结算/被 stop 的后端任务在短暂退出期内重放旧 user/残余事件给新的 idle watch，
  // 导致会话状态被错误“弹回”忙碌(busy)状态。
  const terminalSettleGuardUntilRef = useRef<Map<string, number>>(new Map());
  function markSessionTerminalSettled(sid: string) {
    if (!sid) return;
    terminalSettleGuardUntilRef.current.set(sid, Date.now() + 2500);
  }
  function markSessionManuallyStopped(sid: string) {
    if (!sid) return;
    recordUserManualStop(sid);
    markSessionTerminalSettled(sid);
  }
  function isSessionTerminalSettled(sid: string): boolean {
    if (!sid) return false;
    const until = terminalSettleGuardUntilRef.current.get(sid);
    if (!until) return false;
    if (Date.now() > until) {
      terminalSettleGuardUntilRef.current.delete(sid);
      return false;
    }
    return true;
  }
  function isSessionInManualStopGuard(sid: string): boolean {
    return isSessionTerminalSettled(sid);
  }
  function clearManualStopGuard(sid: string) {
    if (sid) terminalSettleGuardUntilRef.current.delete(sid);
  }
  /**
   * 「立即发送」停掉的旧回合，其 `stopped` 终态可能晚于新一轮的首帧到达。
   * 它属于被换掉的那一轮，绝不能收尾当前连接 / 把 busy 清回发送箭头（否则 agent
   * 明明在跑，按钮却是可发送状态）。帧本身也不能作废这个标记（见 handleEvent）。
   */
  function isStaleProgrammaticStop(frame: SSEEvent, sid: string): boolean {
    return isStaleProgrammaticStopFrame(
      programmaticStopMarkRef.current,
      frame,
      sid,
      Date.now(),
    );
  }
  function stopDetachedHistoryPoll(targetSid?: string) {
    if (detachedPollTimerRef.current != null) {
      window.clearInterval(detachedPollTimerRef.current);
      detachedPollTimerRef.current = null;
    }
    if (targetSid) {
      sessionWatchersRef.current.get(targetSid)?.abort();
      sessionWatchersRef.current.delete(targetSid);
      localActiveStreamsBySessionRef.current.delete(targetSid);
    } else {
      for (const ctrl of sessionWatchersRef.current.values()) {
        ctrl.abort();
      }
      sessionWatchersRef.current.clear();
      if (detachedWatchAbortRef.current) {
        detachedWatchAbortRef.current.abort();
        detachedWatchAbortRef.current = null;
      }
    }
    // 一并清待机 watch：升级时它的 abort 已交给 detachedWatchAbortRef（上方
    // 已 abort），纯空闲态时仅存在于 idleWatchAbortRef，这里兜底。
    stopIdleWatch();
  }
  function stopBackgroundFinishWatch() {
    if (backgroundFinishTimerRef.current != null) {
      window.clearInterval(backgroundFinishTimerRef.current);
      backgroundFinishTimerRef.current = null;
    }
  }
  /** Sessions left mid-turn. Their SSE was aborted, so `done` never arrives
   *  here — poll `/chat/active` and, once the daemon drops them, swap the
   *  partial cache for the persisted transcript and stop the sidebar spinner. */
  function ensureBackgroundFinishWatch() {
    if (backgroundFinishTimerRef.current != null) return;
    const tick = async () => {
      const away = new Set<string>();
      for (const id of backgroundRunningSessionsRef.current) away.add(id);
      for (const id of localTurnSessionsRef.current) away.add(id);
      const viewed = activeIdRef.current;
      if (viewed) away.delete(viewed);
      if (away.size === 0) {
        stopBackgroundFinishWatch();
        return;
      }
      let active: string[] = [];
      try {
        active = await getActiveChatSessions();
      } catch {
        return;
      }
      for (const id of away) {
        if (active.includes(id)) continue;
        if (activeIdRef.current === id) continue;
        backgroundRunningSessionsRef.current.delete(id);
        localTurnSessionsRef.current.delete(id);
        onTurnRunningChange?.(id, false);
        const hash = projectHashBySessionRef.current.get(id) || viewedProjectHashRef.current || activeSession?.project_hash;
        if (!hash) continue;
        try {
          const session = await pullSession({ projectHash: hash, sessionId: id, mode: 'snapshot', limit: HISTORY_PAGE });
          if (activeIdRef.current === id) continue;
          if (!session || !Array.isArray(session.messages)) continue;
          const loaded = sessionMessagesToDisplay(session.messages, session.offset ?? 0, session.pinned_user_index);
          const cached = messageCacheRef.current.get(id);
          // 纯净真相源：后台会话跑完后若内存已有完整状态，保持内存真相源，绝不用截断切片覆盖已展开的历史
          if (!cached || cached.length === 0) {
            messageCacheRef.current.set(id, loaded);
          }
          const surface = hydrateSession(
            loaded,
            // undefined = 服务端明确回答“本回合没有计划”，不能当成“未知”去回退本地遗留文档。
            Array.isArray(session.todos) ? session.todos : [],
            activeTodosBySessionRef.current.get(id),
          );
          writeLiveTodo(id, reduceLiveTodo(null, { type: 'hydrate', items: surface.todos ?? [] }));
          seedAppliedTodoIds(id, surface.appliedTodoIds);
        } catch {
          /* return path refetches disk */
        }
      }
    };
    void tick();
    backgroundFinishTimerRef.current = window.setInterval(() => {
      void tick();
    }, 8000);
  }
  function ensureAssistantBubbleForWatch(targetId?: string, targetSid?: string) {
    if (targetSid && activeIdRef.current !== targetSid) return;
    setMessages({ type: 'assistant_placeholder', messageId: targetId });
  }
  /** 这条 watch 对应的页偏移。正在看的会话用实时偏移，后台会话用切走时记下的偏移。 */
  function watchReplayOffset(sessionId: string): number {
    if (activeIdRef.current === sessionId) return historyOffsetRef.current;
    return historyOffsetBySessionRef.current.get(sessionId) ?? 0;
  }
  /** 判断回放帧是否已经在当前页上：前台看画布，后台看该会话缓存。 */
  function watchReplayCanvas(sessionId: string): Message[] {
    if (activeIdRef.current === sessionId) return messagesRef.current;
    return messageCacheRef.current.get(sessionId) ?? [];
  }
  /**
   * 「新一轮已投递但还没吐任何帧」的窗口：此时到达的终态是**上一回合的缓存终态**
   * （`/chat/watch` 对判定空闲的会话会补发 `session_terminal`）。它绝不能当作
   * 本轮终态去清 busy / 收尾连接，否则按钮会变回发送箭头而 agent 仍在跑。
   */
  const turnArmedAtRef = useRef<Map<string, number>>(new Map());
  const turnFrameSeenRef = useRef<Set<string>>(new Set());
  /** 「立即发送」从停止旧回合到新回合投递落定期间的交接窗口，防止旧回合滞后空闲广播误杀新回合。 */
  const sendNowHandoverBySessionRef = useRef<Map<string, number>>(new Map());
  const sendNowEpochBySessionRef = useRef<Map<string, number>>(new Map());
  /** 交接/未见首帧窗口期间曾暂缓过一次权威 idle 结论：窗口退出后必须做一次尾随复核。 */
  const suppressedIdleBySessionRef = useRef<Set<string>>(new Set());
  const handoverIdleVerifyTimersRef = useRef<Map<string, number>>(new Map());
  function clearTrailingHandoverIdleVerify(sid?: string | null) {
    if (!sid) {
      for (const timer of handoverIdleVerifyTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      handoverIdleVerifyTimersRef.current.clear();
      return;
    }
    const existing = handoverIdleVerifyTimersRef.current.get(sid);
    if (existing != null) {
      window.clearTimeout(existing);
      handoverIdleVerifyTimersRef.current.delete(sid);
    }
  }
  function scheduleTrailingHandoverIdleVerify(sid: string | null | undefined, delayMs = 300) {
    if (!sid) return;
    clearTrailingHandoverIdleVerify(sid);
    const verifyGen = sessionGenerationRef.current;
    const timer = window.setTimeout(() => {
      handoverIdleVerifyTimersRef.current.delete(sid);
      const now = Date.now();
      const handoverUntil = sendNowHandoverBySessionRef.current.get(sid);
      if (handoverUntil != null && now <= handoverUntil) {
        // stopRunningTurn -> deliver 仍在进行中：继续等待交接完成。
        scheduleTrailingHandoverIdleVerify(sid, 250);
        return;
      }
      sendNowHandoverBySessionRef.current.delete(sid);
      const hasInFlightPost =
        activeIdRef.current === sid &&
        (abortRef.current !== null || activeStreamRequestIdRef.current !== null);
      if (hasInFlightPost) {
        scheduleTrailingHandoverIdleVerify(sid, 250);
        return;
      }
      // POST /chat 在返回 202 前已完成 active_chats.admit：此刻若服务端仍报 running:false，
      // 证明新回合要么未投递（如 409 重试耗尽）、要么已在吐首帧前异常退出，必须解除武装并结算空闲。
      const finishIfTrulyIdle = (running: boolean, turnId?: string | null) => {
        if (running) {
          suppressedIdleBySessionRef.current.delete(sid);
          if (activeIdRef.current === sid && sessionGenerationRef.current === verifyGen) {
            applyServerRuntime(sid, { running: true, turn_id: turnId });
          }
          return;
        }
        const refreshedHandover = sendNowHandoverBySessionRef.current.get(sid);
        if (refreshedHandover != null && Date.now() <= refreshedHandover) return;
        if (
          activeIdRef.current === sid &&
          (abortRef.current !== null || activeStreamRequestIdRef.current !== null)
        ) {
          return;
        }
        suppressedIdleBySessionRef.current.delete(sid);
        disarmTurn(sid);
        if (programmaticStopMarkRef.current?.sessionId === sid) {
          programmaticStopMarkRef.current = null;
          persistProgrammaticStopMark(null);
        }
        if (activeIdRef.current === sid) {
          if (sessionGenerationRef.current !== verifyGen) return;
          applyServerRuntime(sid, { running: false }, { ensureIdleWatch: true });
        } else {
          settleBackgroundSessionFromAuthority(sid);
        }
      };
      void getChatRuntime(sid)
        .then((runtime) => finishIfTrulyIdle(serverRuntimeRunning(runtime), runtime?.turn_id))
        .catch(() => {
          void getActiveChatSessions()
            .then((actives) => finishIfTrulyIdle(actives.includes(sid)))
            .catch(() => {});
        });
    }, delayMs);
    handoverIdleVerifyTimersRef.current.set(sid, timer);
  }
  function beginSendNowHandover(sid: string | null | undefined, ttlMs = 15_000): number {
    const epoch = bumpSessionSendNowEpoch(sendNowEpochBySessionRef.current, sid);
    if (sid) sendNowHandoverBySessionRef.current.set(sid, Date.now() + ttlMs);
    return epoch;
  }
  function isSendNowEpochAlive(sid: string | null | undefined, epoch: number): boolean {
    return isCurrentSessionSendNowEpoch(sendNowEpochBySessionRef.current, sid, epoch);
  }
  function endSendNowHandover(sid: string | null | undefined) {
    if (sid) sendNowHandoverBySessionRef.current.delete(sid);
  }
  function armTurn(sid: string | null | undefined) {
    if (!sid) return;
    turnArmedAtRef.current.set(sid, Date.now());
    turnFrameSeenRef.current.delete(sid);
  }
  function disarmTurn(sid: string | null | undefined) {
    if (!sid) return;
    turnArmedAtRef.current.delete(sid);
    turnFrameSeenRef.current.delete(sid);
  }
  function markTurnFrameSeen(sid: string) {
    if (turnArmedAtRef.current.has(sid)) {
      turnFrameSeenRef.current.add(sid);
      suppressedIdleBySessionRef.current.delete(sid);
      clearTrailingHandoverIdleVerify(sid);
    }
  }
  function isTerminalForArmedTurnWithoutFrames(sid: string): boolean {
    return isStaleTerminalForArmedTurn({
      armedAt: turnArmedAtRef.current.get(sid),
      frameSeen: turnFrameSeenRef.current.has(sid),
      now: Date.now(),
    });
  }
  function isSessionTurnHandoverProtected(sid: string | null | undefined): boolean {
    if (!sid) return false;
    const now = Date.now();
    const handoverUntil = sendNowHandoverBySessionRef.current.get(sid);
    if (handoverUntil != null && now > handoverUntil) {
      sendNowHandoverBySessionRef.current.delete(sid);
    }
    return isTurnHandoverProtected({
      sessionId: sid,
      now,
      sendNowUntil: sendNowHandoverBySessionRef.current.get(sid),
      armedAt: turnArmedAtRef.current.get(sid),
      frameSeen: turnFrameSeenRef.current.has(sid),
      mark: programmaticStopMarkRef.current,
    });
  }
  /** 该会话是否有一条**新的本地回合**正在投递/运行（旧终态与磁盘对账不得收尾它）。 */
  function isLocalTurnInFlight(sid: string | null | undefined): boolean {
    if (!sid) return false;
    return (
      localTurnSessionsRef.current.has(sid) ||
      backgroundRunningSessionsRef.current.has(sid) ||
      localActiveStreamsBySessionRef.current.has(sid)
    );
  }
  /**
   * 本端是否仍持有一条真正在收发的**发送**流。
   *
   * 权威磁盘对账只能被「本端确实还在发」否决；`/chat/watch` 观察流条目与后台观测
   * 集合断网后永远收不到终态，拿它们当依据会让收尾永久无法发生（停止按钮常亮）。
   */
  function hasRunningLocalSend(sid: string | null | undefined): boolean {
    if (!sid) return false;
    return ownsRunningLocalSend(localActiveStreamsBySessionRef.current.get(sid));
  }
  /** Identity first: a persisted outline id matches exactly. Text is only the
   *  legacy fallback for rows written before ids. */
  function outlineMatchesPrompt(
    turn: SessionTurnOutline,
    content: string,
    messageId?: string,
  ): boolean {
    if (messageId && turn.id) return turn.id === messageId;
    const raw = turn.label ?? (turn as { text?: string }).text ?? '';
    return userTextsMatch(raw, content);
  }

  /** 回放帧的提问是否落在折叠线以上（右栏大纲里它的绝对下标早于当前窗口起点）。 */
  function replayQueryAboveFold(sessionId: string, event: SSEEvent): boolean {
    if (event.type !== 'user' || typeof event.content !== 'string') return false;
    const storedOutline = turnOutlineBySessionRef.current.get(sessionId);
    const outline =
      storedOutline && storedOutline.length > 0
        ? storedOutline
        : sessionId === activeIdRef.current
          ? turnOutlineRef.current
          : [];
    if (outline.length === 0) return false;
    const hit = [...outline].reverse().find((turn) =>
      outlineMatchesPrompt(turn, event.content!, event.message_id ?? event.client_input_id),
    );
    return !!hit && hit.index < watchReplayOffset(sessionId);
  }

  /** 回放里被页切掉的提问插回这一轮前面，再画后面的帧。 */
  function placeReplayUsers(
    sessionId: string,
    accepted: { placeUsers: Array<{ type: string; content?: string; created_at?: number; message_id?: string; client_input_id?: string }>; before?: { messageId?: string; toolId?: string } },
  ) {
    if (accepted.placeUsers.length === 0) return;
    const base = watchReplayCanvas(sessionId);
    const offset = watchReplayOffset(sessionId);
    // 回放帧只带内容、不带绝对下标：用右栏大纲把它补上。被折叠线切掉的开场提问
    // 只有靠这个下标才能回到真实顺序位置，否则会落在折叠线（~48 行）附近，随后又
    // 被 mergeOlderMessages 当成“无下标在途消息”排到末尾。
    const storedOutline = turnOutlineBySessionRef.current.get(sessionId);
    const outline =
      storedOutline && storedOutline.length > 0
        ? storedOutline
        : sessionId === activeIdRef.current
          ? turnOutlineRef.current
          : [];
    const withIndex = accepted.placeUsers
      .map((event) => {
        if (event.type !== 'user' || typeof event.content !== 'string') return event;
        const hit = [...outline]
          .reverse()
          .find((turn) => outlineMatchesPrompt(turn, event.content!, event.message_id ?? event.client_input_id));
        return hit ? { ...event, source_index: hit.index } : event;
      })
      .filter((event) => {
        if (event.type !== 'user') return true;
        const srcIdx = (event as { source_index?: number }).source_index;
        // 窗口连续性契约：当 `srcIdx < offset`（开场提问落在折叠线之上）且当前窗口 `[offset..]`
        // 内已经存在排在它之后的其它用户提问（`m.sourceIndex > srcIdx`，如中途转向或后续轮次）时，
        // `srcIdx` 及其回答段属于尚未加载的更早分页，不能跨过中间未加载段塞进当前窗口。
        if (
          typeof srcIdx === 'number' &&
          srcIdx < offset &&
          base.some(
            (m) => m.role === 'user' && (m.sourceIndex == null || m.sourceIndex > srcIdx),
          )
        ) {
          return false;
        }
        return true;
      });
    if (withIndex.length === 0) return;
    const placed = placeRecoveredTurnUsers(base, withIndex, accepted.before);
    if (placed === base) return;
    messageCacheRef.current.set(sessionId, placed);
    if (activeIdRef.current === sessionId) {
      messagesRef.current = placed;
      setMessages({ type: 'replace', rows: placed });
    }
  }
  /** Restore Build / AcceptEdits / Plan approval (and user-input) cards after
   *  refresh or session switch. Auto never parks; only non-Auto modes emit these. */
  function restorePendingInteractive(loadId: string, loadGeneration: number) {
    void getChatPending(loadId)
      .then((pending) => {
        if (
          activeIdRef.current !== loadId ||
          sessionGenerationRef.current !== loadGeneration
        ) {
          return;
        }
        if (pending.permission) {
          const auto =
            nativeModeRef.current === 'bypass' || modeState.confirmedMode === 'bypass';
          if (
            !auto
            && !transcriptToolCallIsResolved(messagesRef.current, pending.permission.call_id)
          ) {
            updateToolInLastAssistant(pending.permission.call_id, {
              status: 'waiting_approval',
            });
            onPermission(pending.permission as PermissionRequestEvent);
          }
        }
        if (pending.user_input && !transcriptLatestUserInputIsResolved(messagesRef.current)) {
          setUserInputReq(pending.user_input);
        }
      })
      .catch(() => {
        /* watch replay is the primary path; pending is a backup */
      });
  }

  /**
   * `/chat/watch` 的唯一帧处理管线（供活跃重连 `startDetachedHistoryPoll` 与
   * 空闲待机 `startIdleWatch` 共用）。
   *
   * 统一负责：
   * 1. `session_start` 能力协商与初始游标落盘；
   * 2. `not_active / watch_closed` 合成结束信号拦截；
   * 3. `acceptReplayFrame` 折叠线过滤与页外提问归位（`placeReplayUsers`）；
   * 4. 流空间游标推进、跨轮陈旧终态过滤、首屏未就绪帧缓冲（`preMountStreamBufferRef`）；
   * 5. 前台 `handleEvent` / `steerAnchor` 追踪，以及后台会话 `applyEventToSessionCache`。
   */
  function createWatchEventHandler(params: {
    loadId: string;
    attachNeedsDedup: boolean;
    loadGeneration?: number;
    onValidEvent?: () => void;
    onSyntheticDisconnect?: () => void;
    onBeforeForegroundFrame?: (frame: SSEEvent) => 'proceed' | 'skip' | 'handled';
    onForegroundTerminal: () => void;
    onBackgroundTerminal: () => void;
  }): (event: SSEEvent) => void {
    const fold = createReplayFold();
    let steerAnchor: TurnUserAnchor | undefined;

    return (event: SSEEvent) => {
      params.onValidEvent?.();
      // 握手帧带 cursor。回放帧的 seq 要等决定落笔后再推进：
      // 折叠线以上先按住的帧如果提前记账，断线重连会把还没画上的新回合跳过。
      if (event.type === 'session_start') {
        if (Array.isArray(event.caps)) {
          serverCapsRef.current = event.caps;
        }
        writeStreamCursor(params.loadId, event.cursor);
        return;
      }
      // Ignore synthetic done events from clean idle/watch disconnects.
      if (
        event.type === 'done' &&
        ((event as { stop_reason?: string }).stop_reason === 'not_active' ||
          (event as { stop_reason?: string }).stop_reason === 'watch_closed')
      ) {
        params.onSyntheticDisconnect?.();
        return;
      }

      // 折叠线以上的工具/正文先按住。被页切掉的提问插回这一轮前面，不能丢掉，也不能补到回答下面。
      const accepted = acceptReplayFrame(
        fold,
        event,
        watchReplayOffset(params.loadId),
        (candidate) => replayFrameOnCanvas(watchReplayCanvas(params.loadId), candidate),
        transcriptHasOpenUserTurn(watchReplayCanvas(params.loadId)),
        (candidate) => replayQueryAboveFold(params.loadId, candidate),
        true,
        serverCapsRef.current.includes('explicit_replay'),
      );
      placeReplayUsers(params.loadId, accepted);
      for (const frame of accepted.paint) {
        if (typeof frame.seq === 'number') {
          const prevSeq = readStreamCursor(params.loadId)?.seq ?? 0;
          if (frame.seq > prevSeq) writeStreamCursor(params.loadId, frame.seq);
        }
        const frameIsTerminal =
          frame.type === 'done' || frame.type === 'stopped' || frame.type === 'error';
        // 新一轮刚投递、这轮还没吐过任何帧：此时到达的终态属于上一回合。
        if (
          frameIsTerminal &&
          (isTerminalForArmedTurnWithoutFrames(params.loadId) ||
            isTerminalFromOtherTurn(frame, params.loadId))
        ) {
          continue;
        }
        if (!frameIsTerminal) markTurnFrameSeen(params.loadId);
        const isCurrentView = activeIdRef.current === params.loadId;
        if (!isCurrentView) {
          // 会话在后台运行时，总线推流实时反哺进会话专属缓存 messageCacheRef。
          applyEventToSessionCache(params.loadId, frame);
          if (frameIsTerminal) {
            if (isStaleProgrammaticStop(frame, params.loadId)) continue;
            disarmTurn(params.loadId);
            params.onBackgroundTerminal();
            sessionWatchersRef.current.delete(params.loadId);
            localActiveStreamsBySessionRef.current.delete(params.loadId);
            backgroundRunningSessionsRef.current.delete(params.loadId);
            localTurnSessionsRef.current.delete(params.loadId);
            onTurnRunningChange?.(params.loadId, false);
            archiveBackgroundTodos(params.loadId);
          }
          continue;
        }

        if (
          params.loadGeneration !== undefined &&
          sessionGenerationRef.current !== params.loadGeneration &&
          activeIdRef.current !== params.loadId
        ) {
          applyEventToSessionCache(params.loadId, frame);
          continue;
        }
        if (canvasReadySessionIdRef.current !== params.loadId) {
          // 关键架构保证：内存尚未完全装载落定！推流事件进入预挂载缓冲队列，严格排队等候，绝不抢跑！
          let buf = preMountStreamBufferRef.current.get(params.loadId);
          if (!buf) {
            buf = [];
            preMountStreamBufferRef.current.set(params.loadId, buf);
          }
          buf.push({
            frame,
            opts: {
              requireReplayDedup: needsReplayDedup(frame, params.attachNeedsDedup),
              repeatUserAfterSettled: false,
              steerAnchor: frame.type === 'steered' ? steerAnchor : undefined,
            },
          });
          steerAnchor = frame.type === 'steered' ? undefined : (anchorForSteer(frame) ?? steerAnchor);
          continue;
        }
        if (params.onBeforeForegroundFrame) {
          const gate = params.onBeforeForegroundFrame(frame);
          if (gate === 'skip') continue;
          if (gate === 'handled') {
            timelineFollow.changed();
            continue;
          }
        }
        if (activeIdRef.current !== params.loadId) {
          applyEventToSessionCache(params.loadId, frame);
          continue;
        }
        if (frame.type === 'text' || frame.type === 'reasoning') {
          ensureAssistantBubbleForWatch(frame.message_id, params.loadId);
        }
        handleEvent(frame, {
          requireReplayDedup: needsReplayDedup(frame, params.attachNeedsDedup),
          repeatUserAfterSettled: false,
          steerAnchor: frame.type === 'steered' ? steerAnchor : undefined,
          targetSid: params.loadId,
        });
        // 记账：这一帧落到哪条助手行 —— 下一个 steered 要插在它后面。
        // 无身份帧（如 tokens / artifact_* / warning）必须沿用上一条有效锚点，绝不能清空。
        steerAnchor = frame.type === 'steered' ? undefined : (anchorForSteer(frame) ?? steerAnchor);
        timelineFollow.changed();
        if (frameIsTerminal) {
          if (isStaleProgrammaticStop(frame, params.loadId)) continue;
          disarmTurn(params.loadId);
          params.onForegroundTerminal();
        }
      }
    };
  }

  function startDetachedHistoryPoll(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
    opts?: { localReattach?: boolean; background?: boolean },
  ) {
    // 同一会话只允许一条实时订阅。待机 watch（standby）在 daemon admit 时会被转成
    // live 订阅；若这里不复位它，重连后会与它并行收到同一批实时帧。实时帧不带 seq，
    // 画布按直播增量无条件追加 —— 直接表现为正文重复。
    // 只在「这条 watch 属于当前视图」时复位：待机 watch 永远跟随当前视图，后台会话的
    // detached watch 不能误杀它，否则当前视图会失去推送唤醒。
    if (activeIdRef.current === loadId) stopIdleWatch();
    // 针对指定会话先停止其既有 watcher，但绝不误杀其他正在后台运行的会话流！
    sessionWatchersRef.current.get(loadId)?.abort();
    sessionWatchersRef.current.delete(loadId);

    // Show running UI; send stays locked via recovery / requestId for foreign turns.
    // 后台会话（用户已切走，只订阅推流写缓存）绝不污染当前视图的 busy / 时钟状态。
    if (!opts?.background) {
      setBusyAndClock(true);
      busyRef.current = true;
    }
    // Disk (or the in-memory cache) stays on screen. Watch replay is a delta:
    // events already painted are skipped, and only the unpainted suffix is
    // appended. Deleting the trailing assistant here is what made a refresh
    // drop the in-flight turn and leave only the steer card.
    // 后台会话没有前台画布，幂等键必须从该会话自己的缓存取，不能读当前视图的 messagesRef。
    const todoSeedCanvas =
      activeIdRef.current === loadId ? messagesRef.current : (messageCacheRef.current.get(loadId) ?? []);
    seedAppliedTodoIds(loadId, todoCallIdsFromMessages(todoSeedCanvas));
    // Backup path: explicit pending query restores approval cards even if the
    // watch stream drops the edge event (or a mid-turn race loses the snapshot).
    restorePendingInteractive(loadId, loadGeneration);

    // Live reattach via event bus fan-out.
    const watchAbort = new AbortController();
    detachedWatchAbortRef.current = watchAbort;
    sessionWatchersRef.current.set(loadId, watchAbort);
    localActiveStreamsBySessionRef.current.set(loadId, {
      abortController: watchAbort,
      requestId: loadId,
      // 观察流不是本端回合：它断网后永远不会更新，不能用来否决服务端的权威空闲结论。
      watchOnly: true,
    });

    const effectiveProjectHash =
      projectHash ||
      activeSession?.project_hash ||
      viewedProjectHashRef.current ||
      projectHashBySessionRef.current.get(loadId) ||
      '';

    // 活跃会话切回对账：画布仅在本地为空时用快照垫底（避免滞后磁盘尾部覆盖在途内容）；
    // todo 清单则一律以服务端 TodoBoard 为准整表覆盖 —— 它与画布不同，不是磁盘快照，
    // 而是工具每次执行同步提交的实时真值。
    if (effectiveProjectHash) {
      const todoEpochAtPull = todoLiveEpoch(loadId);
      pullSession({ projectHash: effectiveProjectHash, sessionId: loadId, mode: 'snapshot', limit: HISTORY_PAGE }).then((detail) => {
        if (
          activeIdRef.current === loadId &&
          sessionGenerationRef.current === loadGeneration &&
          (busyRef.current ||
            backgroundRunningSessionsRef.current.has(loadId) ||
            localTurnSessionsRef.current.has(loadId))
        ) {
          // 重连必须用服务端权威整表覆盖本地清单（含空表清空）。旧实现在“本地已有清单”时
          // 直接丢弃服务端结果，导致断网期间推进的 todo 永远追不回来。
          applyAuthoritativeTodos(loadId, detail?.todos, todoEpochAtPull, detail?.todos_revision);
          if (detail && Array.isArray(detail.messages) && detail.messages.length > 0 && messagesRef.current.length === 0) {
            const loaded = sessionMessagesToDisplay(detail.messages, detail.offset ?? 0, detail.pinned_user_index, { running: true });
            adoptAuthoritativeDiskTail(effectiveProjectHash, loadId, loaded, detail.offset ?? 0, detail, todoEpochAtPull);
          }
        }
      }).catch(() => {});
    }
    // 本端是否已收到终态；决定流正常关闭后要不要补一次磁盘对账。
    let terminalSeen = false;
    // 最后一帧（不含 15s 心跳）的时间。观察流在半开/待机状态下只有心跳，
    // 终态帧可能永远到不了（手机挂起、daemon 重启、回放缓冲已随回合清空）。
    let lastFrameAt = Date.now();

    // 带游标自愈推流循环 (Self-Healing Stream with Cursor)：
    // 彻底解决网络颠簸、TCP假死超时或无报错静默断流导致的“推流停止卡住”顽疾。
    const runStreamWithAutoRecovery = async () => {
      let retryCount = 0;
      const maxRetries = 5;

      while (!terminalSeen && !watchAbort.signal.aborted) {
        if (
          sessionGenerationRef.current !== loadGeneration &&
          !backgroundRunningSessionsRef.current.has(loadId)
        ) {
          break;
        }

        // 每次重连重新判断折叠线。游标已经越过页外前缀时，不会再把它们补进画布。
        // 注意：画布上的 Message.seq 是磁盘 DisplayRecord.seq，与 SSE ReplayLog 游标分属不同坐标系；
        // 新文档无流游标时必须走 undefined 全量幂等补发，绝不能传 -1 或拿画布 seq 充当 after_seq
        // （传 -1 会导致服务端抛弃正在运行回合的全部思考块与工具开始帧，引发异地/刷新时工具空参及思考丢失！）。
        const attachCursor = readStreamCursor(loadId);
        const attachAfterSeq = attachCursor ? attachCursor.seq : undefined;
        const attachNeedsDedup = attachAfterSeq === undefined;

        try {
          await watchChatSession(
            loadId,
            createWatchEventHandler({
              loadId,
              attachNeedsDedup,
              onValidEvent: () => {
                retryCount = 0; // 成功收到有效事件立即重置重试计数器
                lastFrameAt = Date.now();
              },
              onSyntheticDisconnect: () => {
                // 若当前连接已被新回合的新 watcher 取代，或正处于「立即发送」交接/未吐帧保护期，
                // 绝不能清理继任者的 watcher 或熄灭 busy。
                if (
                  watchAbort.signal.aborted ||
                  sessionWatchersRef.current.get(loadId) !== watchAbort
                ) {
                  terminalSeen = true;
                  return;
                }
                if (isSessionTurnHandoverProtected(loadId)) {
                  return;
                }
                terminalSeen = true;
                sessionWatchersRef.current.delete(loadId);
                localActiveStreamsBySessionRef.current.delete(loadId);
                backgroundRunningSessionsRef.current.delete(loadId);
                localTurnSessionsRef.current.delete(loadId);
                onTurnRunningChange?.(loadId, false);
                archiveBackgroundTodos(loadId);
                if (activeIdRef.current === loadId) {
                  setBusyAndClock(false);
                  busyRef.current = false;
                  settleToIdleWatch(effectiveProjectHash, loadId, sessionGenerationRef.current);
                  void syncSessionCacheFromDisk(effectiveProjectHash, loadId);
                }
              },
              onForegroundTerminal: () => {
                terminalSeen = true;
                sessionWatchersRef.current.delete(loadId);
                localActiveStreamsBySessionRef.current.delete(loadId);
                settleToIdleWatch(effectiveProjectHash, loadId, sessionGenerationRef.current);
              },
              onBackgroundTerminal: () => {
                terminalSeen = true;
              },
            }),
            watchAbort.signal,
            { afterSeq: attachAfterSeq },
          );
        } catch (err: any) {
          if (err?.name === 'AbortError' || watchAbort.signal.aborted) break;
        }

        // 终态达成或被主动终止：正常退出自愈循环
        if (terminalSeen || watchAbort.signal.aborted) break;

        // 走到这里说明推流意外中断（未收终态 EOF、假死超时被看门狗中断或网络抖动）
        // 快速探针：检查后端该会话是否仍在运行
        try {
          const actives = await getActiveChatSessions();
          if (!actives.includes(loadId)) {
            // 后端该回合已收尾（说明是在最终完成阶段断开），退出循环走磁盘对账
            break;
          }
        } catch {
          // 探针网络异常，继续尝试重连
        }

        if (watchAbort.signal.aborted) break;

        retryCount += 1;
        if (retryCount > maxRetries) {
          break; // 超过重试上限，降级到磁盘对账
        }

        // 指数退避：第一次 100ms 极速自愈，后续 300ms, 600ms, 1200ms...
        const delay = Math.min(100 * Math.pow(2, retryCount - 1), 2000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // 无论何种非正常退出（重试耗尽或后端收尾中断），若尚未送达终态，立刻做权威磁盘历史对账兜底
      if (!terminalSeen && !watchAbort.signal.aborted) {
        sessionWatchersRef.current.delete(loadId);
        localActiveStreamsBySessionRef.current.delete(loadId);
        settleDiskCatchUp(effectiveProjectHash, loadId);
        if (effectiveProjectHash) {
          startDetachedTick(effectiveProjectHash, loadId, loadGeneration);
        }
      }
    };

    // 静默看门狗：本端仍认为回合在跑，却超过 30s 没收到任何帧时，先向后端确认会话是否仍在运行。
    // 若后端仍在运行（例如超长代码生成静默期），保持 busy 与当前画布不动，绝不用旧磁盘快照抹掉在途内容！
    // 只有后端已明确空闲时，才拉取磁盘权威快照并收尾。
    const silenceProbe = window.setInterval(() => {
      if (terminalSeen || watchAbort.signal.aborted || !effectiveProjectHash) return;
      if (Date.now() - lastFrameAt < 30000) return;
      lastFrameAt = Date.now();
      getActiveChatSessions()
        .then((active) => {
          if (terminalSeen || watchAbort.signal.aborted) return;
          if (!Array.isArray(active) || !active.includes(loadId)) {
            terminalSeen = true;
            settleToIdleWatch(effectiveProjectHash, loadId, sessionGenerationRef.current);
            void syncSessionCacheFromDisk(effectiveProjectHash, loadId);
          }
        })
        .catch(() => {});
    }, 10000);

    void runStreamWithAutoRecovery().finally(() => {
      window.clearInterval(silenceProbe);
    });
  }
  // ── Detached tick ── 2s 兜底:watch 实时流连着时只 append-only 补帧 (不抹
  // 流式增量),watch 断开时整体替换;同时监测 stillActive 终结回合。供
  // startDetachedHistoryPoll (切入已活跃会话) 与 startIdleWatch (原地升级)
  // 共用。
  /**
   * 采用磁盘权威尾部：把结算后的磁盘切片安全拼进画布/缓存。
   *
   * 只替换「切片覆盖到的尾部」：早于切片起点的更早历史、以及尚未落盘的乐观提问 /
   * 新回合都原样保留（`spliceAuthoritativeDiskTail` + `mergeDiskWithUnpersistedTail`）。
   * 终态对账与断流兜底共用这一条路径，避免两边各修一半。
   */
  /**
   * 画布被权威尾部整段替换/裁剪后，分页游标必须跟着画布走。
   *
   * 游标（historyOffset）的语义是「连续加载到的头部」。它一旦比画布实际头部
   * 更靠前，右栏点更早的提问就会被判成“已加载”而不再拉取（死链），
   * “加载更早消息”按钮也会连带消失。这里以画布上最小的绝对下标重新对齐。
   */
  function resyncHistoryCursor(
    sid: string,
    messages: Message[],
    turns?: SessionTurnOutline[] | null,
  ) {
    const outline = turns && turns.length > 0
      ? turns
      : (turnOutlineBySessionRef.current.get(sid) ?? []);
    const cursor = historyCursorFor(messages, outline);
    if (!cursor) return;
    historyOffsetBySessionRef.current.set(sid, cursor.offset);
    hasOlderBySessionRef.current.set(sid, cursor.hasOlder);
    if (activeIdRef.current === sid) {
      historyOffsetRef.current = cursor.offset;
      setHasOlder(cursor.hasOlder);
    }
  }

  /** 记录某会话已见过的最大 revision（只许前进）。 */
  function noteCacheRevision(sid: string | null | undefined, revision?: number | null) {
    if (!sid || typeof revision !== 'number' || !Number.isFinite(revision)) return;
    const current = cacheRevisionBySessionRef.current.get(sid) ?? 0;
    if (revision >= current) cacheRevisionBySessionRef.current.set(sid, revision);
  }

  function adoptAuthoritativeDiskTail(
    hash: string,
    sid: string,
    diskTail: Message[],
    diskOffset: number,
    meta: {
      todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
      todos_revision?: number;
      turns?: SessionTurnOutline[];
      token_usage?: SessionTokenUsage | null;
      revision?: number;
      message_count?: number;
    },
    todoEpochAtPull?: number,
  ): { messages: Message[]; keptUnpersistedTail: boolean } {
    const canvas = activeIdRef.current === sid
      ? messagesRef.current
      : (messageCacheRef.current.get(sid) ?? []);
    // 关键根因防线：若版本发生跃迁（离开期间在别处执行了编辑/删除/回溯/分支截断），
    // 或者当前画布与磁盘切片之间存在因果断层（例如画布停在开场白 a，而磁盘切片从 222 开始），
    // 本地旧历史必须作废，绝不能把已删除/已回溯的旧消息重新拼回！直接以磁盘权威切片为基准！
    const knownRevision = cacheRevisionBySessionRef.current.get(sid) ?? 0;
    const revisionAdvanced =
      typeof meta.revision === 'number' &&
      knownRevision > 0 &&
      meta.revision > knownRevision;
    const hasCausalGap = revisionAdvanced || (canvas.length > 0 && !cachedHeadIsContiguous(canvas, diskOffset));
    const merged = hasCausalGap ? diskTail : mergeAuthoritativeTail(diskTail, canvas, diskOffset);
    // 关键保全：若本地画布尾部持有尚未落盘的新提问（如「立即发送」刚画上的 bq 或本端在途 POST 提问），
    // 即使上一回合由于停止/回溯导致了版本跃迁，也绝对不能把这颗属于新回合的提问气泡抹掉！
    const unpersistedLocalUser = (() => {
      const last = canvas[canvas.length - 1];
      if (last && last.role === 'user' && !diskTail.some((d) => d.id === last.id)) {
        return last;
      }
      return undefined;
    })();

    // 保全本地尚未在磁盘落盘的系统命令通知（如压缩完成提示通知）
    const unpersistedLocalNotices = canvas.filter(
      (m) => m.role === 'system' && m.id && !diskTail.some((d) => d.id === m.id),
    );

    let clean = merged;
    if (unpersistedLocalUser && !clean.some((m) => m.id === unpersistedLocalUser.id)) {
      clean = [...clean, unpersistedLocalUser];
    }
    for (const note of unpersistedLocalNotices) {
      if (!clean.some((m) => m.id === note.id)) {
        clean = [...clean, note];
      }
    }
    messageCacheRef.current.set(sid, clean);
    noteCacheRevision(sid, meta.revision);
    // The disk/catch-up outline may predate the current turn's pending steer.
    // Compute the merged rail once and use the SAME result for cache + canvas;
    // writing raw `meta.turns` here made the title appear and then vanish on the
    // next refresh.
    const localTurnsBeforeCatchUp = turnOutlineBySessionRef.current.get(sid) ?? [];
    const mergedTurnsForCatchUp = mergeServerWithLocalOutline(
      meta.turns ?? [],
      localTurnsBeforeCatchUp,
    );
    // 权威反写缓存：必须带上历史偏移与总数，杜绝 IndexedDB 缓存保留旧的 0 偏移！
    commitCanvasCache(hash, sid, {
      messages: clean,
      todos: meta.todos,
      todoRevision: meta.todos_revision ?? 0,
      turns: mergedTurnsForCatchUp,
      tokenUsage: meta.token_usage,
      revision: meta.revision,
      historyOffset: hasCausalGap ? diskOffset : undefined,
      historyTotal: meta.message_count,
    });
    // 对账可能把画布裁回尾部窗口：游标必须随之归位，否则更早的提问会变成死链。
    resyncHistoryCursor(sid, clean, meta.turns);
    if (activeIdRef.current === sid) {
      messagesRef.current = clean;
      // 磁盘对账会整表替换画布：锚定阅读位置，避免终态时滚动条跳走。
      timelineFollowRef.current?.beginSwap();
      commitActiveTodosIntoLastAssistant();
      setMessages({ type: 'replace', rows: clean });
      timelineFollowRef.current?.endSwap();
      if (meta.turns && meta.turns.length > 0) {
        // Even on a causal gap, the disk outline may be a tail window that
        // predates the current pending steer. Merge unconditionally: identity
        // rows from the server win, while provisional/newer local rows survive.
        turnOutlineBySessionRef.current.set(sid, mergedTurnsForCatchUp);
        setTurnOutline(mergedTurnsForCatchUp);
      }
      if (meta.token_usage) {
        applySessionTokens(sid, clean, meta.token_usage);
      }
      // 服务端 board 是清单唯一真值（工具每次执行同步提交），不是滞后的磁盘快照：
      // 运行中同样整表覆盖，空表 = 权威清空（全部完成已关闭 / 已回溯）。
      // 响应期间若有实时帧推进了清单，epoch 已变化，本次响应直接丢弃。
      applyAuthoritativeTodos(sid, meta.todos, todoEpochAtPull, meta.todos_revision);
      pruneDeliveredQueuedCards(sid, clean);
    }
    return { messages: clean, keptUnpersistedTail: clean.length !== diskTail.length };
  }

  /**
   * 服务端已确认没有回合在跑：画布上仍挂着的 pending / waiting 工具行不会再有结果帧
   * （daemon 重启、回放缓冲已随回合清空、或结果帧丢在断网期）。标成 incomplete，
   * 绝不让它继续转圈；真正的结果出现在磁盘上时会被权威对账替换。
   */
  function finalizeOrphanPendingTools(sid: string) {
    const settle = (list: Message[]): Message[] => {
      let changed = false;
      const next = list.map((message) => {
        if (message.role !== 'assistant') return message;
        const parts = finalizeToolsAfterTurn(message.parts, { keepAwaitingBashDecision: false });
        if (parts === message.parts) return message;
        changed = true;
        return { ...message, parts };
      });
      return changed ? next : list;
    };
    const cached = messageCacheRef.current.get(sid);
    if (cached) messageCacheRef.current.set(sid, settle(cached));
    if (activeIdRef.current === sid) {
      const next = settle(messagesRef.current);
      if (next !== messagesRef.current) {
        messagesRef.current = next;
        setMessages({ type: 'replace', rows: next });
      }
    }
  }

  /**
   * 服务端已权威空闲：清掉本端所有“仍在运行”的残影。
   *
   * `backgroundRunningSessions` 与观察流条目只是“看见它跑过”的本地笔记：手机断网
   * 后它们永远收不到终态。留着就会让 `settleToIdleWatch` / `catchUpFromDisk` 一直
   * 早退，表现就是停止按钮与僵尸工具行永久保留，直到另一台设备发下一条消息把状态冲开。
   */
  function settleSessionRunningState(sid: string) {
    localTurnSessionsRef.current.delete(sid);
    backgroundRunningSessionsRef.current.delete(sid);
    const stream = localActiveStreamsBySessionRef.current.get(sid);
    if (!stream || stream.watchOnly) {
      localActiveStreamsBySessionRef.current.delete(sid);
    }
    const watcher = sessionWatchersRef.current.get(sid);
    if (watcher) {
      watcher.abort();
      sessionWatchersRef.current.delete(sid);
    }
    setBusyAndClock(false);
    busyRef.current = false;
    liveLifecycleRef.current = { running: false, terminalConsumed: true };
    onTurnRunningChange?.(sid, false);
    // 没有回合在跑了：残留的 pending 工具行不会再有结果帧，收尾成 incomplete。
    finalizeOrphanPendingTools(sid);
  }

  /** Live tokens win. Disk is touched only after the stream goes quiet, and
   *  only the transcript body is read when the file size or mtime changed. */
  async function catchUpFromDisk(
    hash: string,
    id: string,
    opts?: { force?: boolean },
  ): Promise<boolean | null> {
    // force：回合收尾（终态到达 / 用户停止）时的一次性对账，必须跳过“流刚吐过内容”的
    // 静默守卫，否则最后一段正文永远补不回来（表现为通知已响、正文要刷新/失焦才出现）。
    const force = opts?.force === true;
    if (!force && Date.now() - lastLiveContentRef.current < 1500) return null;
    const fresh = await getSessionFreshness(hash, id);
    const sig = `${fresh.bytes}:${fresh.mtime_ms}`;
    // Right after Send, /chat/active and the file can still say "idle" for a
    // moment. Trusting that flips the button back to the send arrow while the
    // turn is already running.
    const sinceSend = turnStartedAtRef.current == null
      ? Number.POSITIVE_INFINITY
      : Date.now() - turnStartedAtRef.current;
    if (!force && !fresh.running && sinceSend < 2500) return true;
    if (sig === freshnessSigRef.current) {
      // 文件没变但会话已经停了：上次轮询还在跑，这次不能因为签名相同就留下计时器和画板。
      if (!fresh.running && activeIdRef.current === id && busyRef.current) {
        if (isSessionTurnHandoverProtected(id)) {
          return true;
        }
        // 新一轮已经在投递/运行（自动 drain 的 steer、立即发送的新回合）：
        // 这份“空闲”签名来自尚未登记新回合的磁盘，绝不能据此清掉 busy。
        if (hasRunningLocalSend(id)) return true;
        settleSessionRunningState(id);
        transitionChatRecovery({ type: 'authoritative_terminal' });
        commitActiveTodosIntoLastAssistant();
      }
      return fresh.running;
    }
    freshnessSigRef.current = sig;

    // ── 核心架构铁律：推流运行期间 (fresh.running)，后续内容完全由自然推流增量画到画布 ──
    // 严禁在此期间去读磁盘并调用任何模糊合并算法覆盖/重写画布，彻底杜绝历史被重复追加与撕裂！
    if (fresh.running) {
      return true;
    }

    const todoEpochAtPull = todoLiveEpoch(id);
    const detail = await pullSession({ projectHash: hash, sessionId: id, mode: 'snapshot', limit: HISTORY_PAGE });
    if (activeIdRef.current !== id || !detail || !Array.isArray(detail.messages)) {
      // 本次对账没落地（离线 / 切走了会话 / 解析失败）：绝不要留下签名，
      // 否则下一次会以为“文件没变”而永久跳过读盘，尾段再也补不回来。
      freshnessSigRef.current = '';
      return null;
    }
    const disk = sessionMessagesToDisplay(detail.messages, detail.offset ?? 0, detail.pinned_user_index);
    const canvas = messagesRef.current;
    const diskHasUser = diskHasCanvasUser(disk, canvas);
    const diskSettled = diskHasUser && !transcriptHasInFlightAssistant(disk) && !fresh.running;
    // 断线重连时画布永远非空：只要服务端已结算，就必须用磁盘权威尾部校正画布。
    // 否则断流期间丢掉的 tool_result / 末段正文会永久停在「运行中」（只能靠刷新或手动停止恢复）。
    if (shouldAdoptAuthoritativeTail({
      running: fresh.running,
      diskHasUser,
      diskSettled,
      canvasInFlight: transcriptHasInFlightAssistant(canvas),
      // 被收尾成 incomplete 的僵尸工具行也要允许磁盘权威结果把它整行换掉。
      canvasUnresolvedTools: tailAssistantHasUnresolvedTools(canvas),
      diskLastTextLen: lastAssistantTextLen(disk),
      canvasLastTextLen: lastAssistantTextLen(canvas),
    })) {
      adoptAuthoritativeDiskTail(hash, id, disk, detail.offset ?? 0, detail, todoEpochAtPull);
    }
    if (isSessionTurnHandoverProtected(id)) {
      return true;
    }
    // 旧回合的终态对账绝不能收尾已经在跑的新回合（否则按钮变回发送箭头）。
    // 只认本端真正在收发的发送流：观察流条目断网后永不更新，不能拿来否决权威空闲。
    if (hasRunningLocalSend(id)) return true;
    // 会话已停就收尾：停表、把本轮勾完的清单冻到尾部。
    // 服务端在空闲时不会再把已完成清单当作活跃画板返回，这里也不能把那份历史清单贴回输入框上方。
    settleSessionRunningState(id);
    transitionChatRecovery({ type: 'authoritative_terminal' });
    commitActiveTodosIntoLastAssistant();
    // 服务端 board 是唯一真值：整表覆盖（空表 = 权威清空）。部分完成（中途 Stop）会
    // 原样返回全量清单，不能被“全完成才保留”的展示过滤掉。
    applyAuthoritativeTodos(id, detail.todos, todoEpochAtPull, detail.todos_revision);
    seedAppliedTodoIds(id, todoCallIdsFromMessages(messagesRef.current));
    return fresh.running;
  }

  /**
   * 回合收尾的一次性磁盘对账（终态到达、用户停止、或视图流未送终态即关闭）。
   *
   * 画布只靠 `/chat/watch` 一条流推进，而终态通知是另一套轮询（`/chat/active`）发出的——
   * 因此“右下角已提示完成、最后一段正文却要刷新/失焦才出现”的根因就是：流可能没把尾段
   * 或终态送到，而画布路径此前从不回读磁盘。磁盘是回合结算后的权威，这里强制拉取一次
   * （仍在运行时按 800ms 重试至多 3 次），把尾段正文与 busy/看门狗状态一次性对齐。
   */
  /**
   * 磁盘历史增量对账：直接拉取磁盘权威 transcript 并更新会话内存缓存与持久化缓存。
   * 如果该会话正好在屏幕上呈现，同步平滑更新画布、大纲与状态，彻底杜绝“通知响了/会话切回却卡在旧命令转圈”的断层。
   */
  const syncSessionCacheFromDisk = useCallback(async (hash: string, sid: string): Promise<boolean> => {
    if (!hash || !sid) return false;
    // 上一回合的终态绝不能把旧磁盘尾部对账到本端正在发送的新回合上。
    // 只认真正在收发的发送流：观察流条目断网后永不更新，不能拦住后台缓存自愈。
    if (hasRunningLocalSend(sid)) return true;
    try {
      const todoEpochAtPull = todoLiveEpoch(sid);
      const detail = await pullSession({ projectHash: hash, sessionId: sid, mode: 'snapshot', limit: HISTORY_PAGE });
      if (!detail || !Array.isArray(detail.messages)) return false;
      if (Array.isArray(detail.caps)) serverCapsRef.current = detail.caps;
      const loaded = sessionMessagesToDisplay(detail.messages, detail.offset ?? 0, detail.pinned_user_index);
      // 立即发送会先把用户气泡画上。停止触发的这次对账往往早于落盘，
      // 直接覆盖会把气泡抹掉，直到刷新才从磁盘重新出现——
      // 拼接时由 `mergeDiskWithUnpersistedTail` 保留未落盘的尾巴。
      const { keptUnpersistedTail } = adoptAuthoritativeDiskTail(
        hash,
        sid,
        loaded,
        detail.offset ?? 0,
        detail,
        todoEpochAtPull,
      );
      if (activeIdRef.current === sid) {
        const hasLocalSend =
          abortRef.current !== null ||
          activeStreamRequestIdRef.current !== null ||
          localTurnSessionsRef.current.has(sid) ||
          backgroundRunningSessionsRef.current.has(sid);
        if (!keptUnpersistedTail && !hasLocalSend) {
          setBusyAndClock(false);
          busyRef.current = false;
        }
        // 画布、大纲、token、sticky 清单已由 adoptAuthoritativeDiskTail 统一落定。
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  function settleDiskCatchUp(projectHash: string, sid: string) {
    if (!projectHash || !sid) return;
    const attempt = (delay: number, triesLeft: number) => {
      window.setTimeout(() => {
        void syncSessionCacheFromDisk(projectHash, sid)
          .catch(() => {
            if (triesLeft > 0) attempt(1600, triesLeft - 1);
          });
      }, delay);
    };
    attempt(0, 3);
  }

  function startDetachedTick(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
  ) {
    if (detachedPollTimerRef.current != null) {
      window.clearInterval(detachedPollTimerRef.current);
      detachedPollTimerRef.current = null;
    }
    const tick = async () => {
      if (
        activeIdRef.current !== loadId ||
        sessionGenerationRef.current !== loadGeneration
      ) {
        stopDetachedHistoryPoll(loadId);
        return;
      }
      try {
        const stillActive = await catchUpFromDisk(projectHash, loadId);
        if (
          activeIdRef.current !== loadId ||
          sessionGenerationRef.current !== loadGeneration
        ) {
          stopDetachedHistoryPoll(loadId);
          return;
        }
        if (stillActive === null || stillActive) return;
        {
          transitionChatRecovery({ type: 'authoritative_terminal' });
          const loadedDone = messagesRef.current;
          messageCacheRef.current.set(loadId, loadedDone);
          commitActiveTodosIntoLastAssistant();
          // 回空闲态重新待机,让下一个 API turn 仍能被推到(watch 中途死掉时
          // 由 tick 兜底检测到回合结束,同样要重挂 idle watch)。
          settleToIdleWatch(projectHash, loadId, loadGeneration);
        }
      } catch {
        // Keep polling.
      }
    };
    detachedPollTimerRef.current = window.setInterval(() => {
      void tick();
    }, 8000);
  }
  // 空闲态（已就绪、非 busy）维持待机 watch 连接
  // 让 daemon 在 API/native turn admit 的瞬间把该连接接入 fan-out
  // （event-driven push），避免「停留在会话上、对端起 turn 后 WebUI 无感知
  // 只能刷新才看见」。收到首个 turn 事件即原地升级为观察模式渲染，共用同一
  // watch 连接（无事件丢失），done 退回空闲并重新进入待机。
  const idleWatchAbortRef = useRef<AbortController | null>(null);
  const idleWatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleWatchFlashDisconnectsRef = useRef<Map<string, { count: number; lastFailedAt: number }>>(new Map());
  function stopIdleWatch() {
    if (idleWatchTimerRef.current) {
      clearTimeout(idleWatchTimerRef.current);
      idleWatchTimerRef.current = null;
    }
    if (idleWatchAbortRef.current) {
      idleWatchAbortRef.current.abort();
      idleWatchAbortRef.current = null;
    }
  }
  // 回合结束（done/stopped/error）后回到空闲待机态:清掉 detached 状态并立即
  // 重新挂上 idle watch,让下一个 API turn 一 admit 就被 push 过来。
  // 必须在同一同步块里把 busyRef 同步清掉——`setBusy` 是异步的,直接调
  // `startIdleWatch` 会被上一轮的 `busyRef.current === true` 入口守卫挡掉,
  // 导致第一轮结束后 watch 失联、第二轮无法同步。
  function scheduleDeferredReconcile(
    projectHash: string,
    loadId: string,
    delayMs = 5000,
  ) {
    if (!projectHash || !loadId) return;
    if (deferredReconcileTimerRef.current != null) {
      window.clearTimeout(deferredReconcileTimerRef.current);
    }
    deferredReconcileTimerRef.current = window.setTimeout(() => {
      deferredReconcileTimerRef.current = null;
      if (activeIdRef.current !== loadId && !messageCacheRef.current.has(loadId)) return;
      // A live next turn owns the canvas; its own terminal will reconcile.
      // Re-arm instead of giving up: a hung turn that never emits a terminal
      // must still recover the previous tail once it is finally cleared.
      if (busyRef.current || isLocalTurnInFlight(loadId)) {
        scheduleDeferredReconcile(projectHash, loadId, delayMs);
        return;
      }
      settleDiskCatchUp(projectHash, loadId);
    }, delayMs);
  }

  function settleToIdleWatch(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
  ) {
    // The next turn (auto-drained steer / send-now) may already own the stream.
    // Never let the previous terminal's idle settlement abort it or clear busy.
    if (
      localTurnSessionsRef.current.has(loadId) ||
      backgroundRunningSessionsRef.current.has(loadId)
    ) {
      return;
    }
    sessionWatchersRef.current.get(loadId)?.abort();
    sessionWatchersRef.current.delete(loadId);
    localActiveStreamsBySessionRef.current.delete(loadId);
    stopDetachedHistoryPoll(loadId);
    pendingSelfEchoRef.current = [];
    if (requestIdRef.current === loadId) requestIdRef.current = null;
    // 观察结束回空闲:recovery 状态机复位,否则 allowSend/allowQueueDrain 会一直
    // 停在 detached_active(false),输入框被锁住。
    transitionChatRecovery({ type: 'authoritative_terminal' });
    backgroundRunningSessionsRef.current.delete(loadId);
    localTurnSessionsRef.current.delete(loadId);
    onTurnRunningChange?.(loadId, false);
    setHistoryHint(null);
    setBusyAndClock(false);
    busyRef.current = false;
    markSessionTerminalSettled(loadId);
    commitActiveTodosIntoLastAssistant();
    const currentOutline =
      turnOutlineBySessionRef.current.get(loadId) ??
      (turnOutlineRef.current.length > 0 ? turnOutlineRef.current : []);
    // 回合结束进入待机：输入框上方已归档沉淀，持久化缓存写入 null，绝不残留脏待办。
    // 用 L1 全量画布 ∪ 当前窗口，避免温切换的 48 条窗口把更早历史从 L2 截断。
    const payload = canvasCachePayload(loadId);
    commitCanvasCache(projectHash, loadId, {
      messages: payload.messages,
      todos: null,
      turns: currentOutline,
      tokenUsage: cachedTokenUsageFor(loadId),
      historyOffset: payload.offset,
      historyTotal: payload.total,
      revision: cacheRevisionBySessionRef.current.get(loadId),
      phase: 'terminal',
      operationId: null,
      lastSeq: null,
    });
    // API turn 已落盘:通知 App 刷新侧栏(消息数/自动命名标题),新建会话才会出现。
    onTurnDone?.();
    startIdleWatch(projectHash, loadId, loadGeneration);
    // 终态已到：磁盘已结算，强制对账一次，补回流里可能丢掉（或被去重吞掉）的尾段正文。
    // 但若队列里还有待发的 steer/queue，下一回合马上会被 drain 发出；此时先去
    // 对账旧磁盘会把新回合的乐观气泡/首个 loop 覆盖掉（用户气泡消失 + 新 loop
    // 被接到上一轮下面）。让新回合自己的终态再做一次权威对账。
    const targetQueued =
      loadId === activeIdRef.current
        ? queuedRef.current
        : (queuedBySessionRef.current.get(loadId) ?? []);
    const hasQueuedNextTurn = targetQueued.some(
      (item) => item.kind === 'queue' || item.kind === 'steer' || item.kind === 'steering',
    );
    if (!hasQueuedNextTurn) {
      settleDiskCatchUp(projectHash, loadId);
    } else {
      // If the queued/steer turn never starts (or dies without a terminal),
      // recover the previous tail once it is safe. The callback re-checks
      // busy/local-turn, so a healthy new turn is never clobbered.
      scheduleDeferredReconcile(projectHash, loadId);
    }
  }
  function startIdleWatch(
    projectHash: string,
    loadId: string,
    loadGeneration: number,
    opts?: { replayIfLive?: boolean },
  ) {
    // 该会话已经有实时订阅（detached watch）在跑：待机 watch 必须让位。
    // 否则 standby 在 admit 时会被 daemon 转成 live，两条连接同时收帧；实时帧
    // 不带 seq，画布会无条件追加，造成正文重复。
    const liveWatcher = sessionWatchersRef.current.get(loadId);
    if (liveWatcher && !liveWatcher.signal.aborted) return;
    if (
      idleWatchAbortRef.current &&
      !idleWatchAbortRef.current.signal.aborted
    ) {
      return;
    }
    // 熔断保护检查：若该会话短时间内连续闪断（>= 3次），且处于 30 秒冷却期内，跳过自动重连
    const flashRecord = idleWatchFlashDisconnectsRef.current.get(loadId);
    if (flashRecord && flashRecord.count >= 3 && Date.now() - flashRecord.lastFailedAt < 30000) {
      return;
    }
    stopIdleWatch();
    const abort = new AbortController();
    idleWatchAbortRef.current = abort;
    let activated = false;
    let terminalSeen = false;
    const connectedAt = Date.now();
    // 待机连接不会补发（standby=true），直接按「无历史」握手；replayIfLive 的重连才续传。
    const idleAfterSeq = opts?.replayIfLive === true
      ? resolveAfterSeq(readStreamCursor(loadId), messagesRef.current.length === 0)
      : -1;
    const idleNeedsDedup = idleAfterSeq === undefined;
    void watchChatSession(
      loadId,
      createWatchEventHandler({
        loadId,
        attachNeedsDedup: idleNeedsDedup,
        loadGeneration,
        onBeforeForegroundFrame: (frame) => {
          if (activated) return 'proceed';
          let skipSecondHandle = false;
          if (frame.type === 'user') {
            const cleanText = visibleUserText(frame.content).trim();
            const userId = frame.message_id ?? frame.client_input_id;
            // 身份优先：带关联键或消息 id 时只看“这一行是否已在画布上”，不再用文本启发式——
            // 否则用户连发两条一模一样的提问时，第二条帧会被误判为旧帧而漏激活。
            const alreadyPresent = userId
              ? messagesRef.current.some(
                  (m) => m.role === 'user' && (m.id === userId || m.clientInputId === userId),
                )
              : messagesRef.current.some((m) => {
                  if (m.role !== 'user') return false;
                  return m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text, cleanText));
                });
            if (alreadyPresent) {
              // 关键防线：该用户提问早已存在于当前画布上，纯属后端重放的旧提问帧，坚决不能误激活为新轮次！
              return 'skip';
            }
            // 确认为画布上尚未存在的全新用户提问：立即解除上一轮结算/停止的 2.5s 防抖屏障，
            // 防止连发提问、队列自动 drain 或立即发送时异地实例把新提问气泡静默丢弃！
            clearManualStopGuard(loadId);
            handleEvent(frame);
            skipSecondHandle = true;
          } else if (frame.type === 'steered') {
            clearManualStopGuard(loadId);
          } else if (isSessionInManualStopGuard(loadId)) {
            // 用户刚手动点击了停止或会话刚完成终端结算，后端正在退出期间可能重放残余事件，坚决不能误激活为新轮次！
            return 'skip';
          } else if (!isWatchTurnActivationEvent(frame.type)) {
            return 'skip';
          }
          activated = true;
          idleWatchFlashDisconnectsRef.current.delete(loadId);
          idleWatchAbortRef.current = null;
          detachedWatchAbortRef.current = abort;
          sessionWatchersRef.current.set(loadId, abort);
          transitionChatRecovery({ type: 'active_check_succeeded', active: true });
          requestIdRef.current = loadId;
          setBusyAndClock(true);
          busyRef.current = true;
          // A remote turn preserves the reader's current follow intent.
          seedAppliedTodoIds(loadId, todoCallIdsFromMessages(messagesRef.current));
          // Backup: restore Build/AcceptEdits/Plan approval cards mid-turn.
          restorePendingInteractive(loadId, loadGeneration);
          // API turn 已 admit(会话已建):通知 App 刷新侧栏,让新建会话实时出现。
          onTurnDone?.();
          return skipSecondHandle ? 'handled' : 'proceed';
        },
        onForegroundTerminal: () => {
          terminalSeen = true;
          // 游标会话级递增，跨回合不清（清了就没法续传断线期间的内容）。
          idleWatchFlashDisconnectsRef.current.delete(loadId);
          // 回合结束:回空闲态重新待机,保证下一个 API turn 一 admit 就被推到。
          settleToIdleWatch(projectHash, loadId, loadGeneration);
        },
        onBackgroundTerminal: () => {
          terminalSeen = true;
        },
      }),
      abort.signal,
      // 刷新时 /chat/active 可能还没标上这个会话。standby 会跳过已经在跑的回放，
      // 思考和正文要等下一次落盘。第一次连接先要完整回放；回合真的空闲时服务端
      // 没有回放缓冲，仍然只是待机。
      { standbyOnly: opts?.replayIfLive !== true, afterSeq: idleAfterSeq },
    ).then(() => {
      // 连接在未收到终端事件的情况下被服务端关闭(Live-dying 竞态 / daemon
      // 重启 / 网络断)。若当前还是这条连接的 controller,说明没人接手——
      // 回到空闲态重新待机,别让下一个 turn 失联。
      if (idleWatchAbortRef.current === abort || detachedWatchAbortRef.current === abort) {
        idleWatchAbortRef.current = null;
        if (activated && !terminalSeen) {
          idleWatchFlashDisconnectsRef.current.delete(loadId);
          settleToIdleWatch(projectHash, loadId, loadGeneration);
        } else {
          // 本端自己的 turn 刚结束:busy 可能尚未复位(流关闭与 /chat done 处理
          // 竞态),直接绕过 busy 守卫重新待机;待机连接不会干扰 busy 状态管理。
          busyRef.current = false;
          const duration = Date.now() - connectedAt;
          if (duration > 3000) {
            idleWatchFlashDisconnectsRef.current.delete(loadId);
          }
          const isFlash = duration <= 3000;
          if (isFlash) {
            const cur = idleWatchFlashDisconnectsRef.current.get(loadId) ?? { count: 0, lastFailedAt: 0 };
            cur.count += 1;
            cur.lastFailedAt = Date.now();
            idleWatchFlashDisconnectsRef.current.set(loadId, cur);
            if (cur.count >= 3) {
              console.warn(`[watch] Idle watch circuit breaker triggered for ${loadId} after ${cur.count} consecutive flash disconnects.`);
              return;
            }
          }
          const retryDelay = isFlash ? 1000 : 200;
          idleWatchTimerRef.current = setTimeout(() => {
            idleWatchTimerRef.current = null;
            if (activeIdRef.current === loadId && sessionGenerationRef.current === loadGeneration) {
              startIdleWatch(projectHash, loadId, loadGeneration);
            }
          }, retryDelay);
        }
      }
    }).catch((err) => {
      if (err?.name === 'AbortError') return;
      // 静默失败：不阻塞空闲态使用，下一次会话聚焦/刷新会重建。
    });
  }
  // Cache of session messages, used to preserve in-progress streaming turns when switching sessions.
  const messageCacheRef = useRef<SessionStoreMap<Message>>(new SessionStoreMap<Message>());
  /** 每个会话已水合到的后端 revision；写缓存前用它做闸门，旧快照不得覆盖新快照。 */
  const cacheRevisionBySessionRef = useRef<Map<string, number>>(new Map());
  // Mirror of messages state to read the latest value without dependency tracking.
  // Active canvas rows are owned by SessionStore. Every existing
  // `messagesRef.current` read/write therefore converges on the store even on
  // paths that intentionally skip React state (background reconcile).
  const messagesRef = useRef<{ current: Message[] }>({
    get current() {
      return activeStoreRef.current!.current;
    },
    set current(rows: Message[]) {
      activeStoreRef.current!.replace(rows);
    },
  }).current;
  /** Live text deltas batched into one render per animation frame (C3-lite). */
  const pendingTextRef = useRef<Array<{
    content: string;
    messageId?: string;
    partId?: string;
    partRev?: number;
    recordSeq?: number;
  }>>([]);
  const pendingTextSessionIdRef = useRef<string | null>(null);
  const textRafRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      stopDetachedHistoryPoll();
      stopBackgroundFinishWatch();
      clearTrailingHandoverIdleVerify();
      runtimeAuthorityFetchRef.current.clear();
      if (textRafRef.current != null) {
        window.cancelAnimationFrame(textRafRef.current);
        textRafRef.current = null;
        pendingTextRef.current = [];
        pendingTextSessionIdRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    onLiveReview?.({
      sessionId: sessionId ?? activeIdRef.current,
      permission: null,
      userInput: userInputReq,
    });
  }, [onLiveReview, sessionId, userInputReq]);
  // 跨实例增量：待交互卡在别处被解决时，同步清掉本画布的待批准/待回答状态；同步压缩状态。
  // 同时监听全局 activity 终态：当后台会话结束时，即时在后台同步磁盘最新历史并刷新该会话缓存。
  useEffect(
    () =>
      onGlobalEvent((event) => {
        if (event.type === 'sync') {
          const sid = activeIdRef.current;
          if (sid) {
            restorePendingInteractive(sid, sessionGenerationRef.current);
          }
          return;
        }
        // 会话被删除（任意端）：该会话的全部本地派生状态必须一起消失，
        // 否则 L1 画布 / watcher / 队列 / 转向卡会在下一次切回时“复活”。
        if (event.type === 'session_deleted') {
          const sid = event.session_id;
          sessionWatchersRef.current.get(sid)?.abort();
          sessionWatchersRef.current.delete(sid);
          localActiveStreamsBySessionRef.current.delete(sid);
          localTurnSessionsRef.current.delete(sid);
          backgroundRunningSessionsRef.current.delete(sid);
          messageCacheRef.current.delete(sid);
          cacheRevisionBySessionRef.current.delete(sid);
          runtimeRevisionBySessionRef.current.delete(sid);
          runtimeAuthoritativeBySessionRef.current.delete(sid);
          activeTodosBySessionRef.current.delete(sid);
          todoLiveBySessionRef.current.delete(sid);
          queuedBySessionRef.current.delete(sid);
          pendingSteersBySessionRef.current.delete(sid);
          turnOutlineBySessionRef.current.delete(sid);
          historyOffsetBySessionRef.current.delete(sid);
          historyTotalBySessionRef.current.delete(sid);
          hasOlderBySessionRef.current.delete(sid);
          turnStartedAtBySessionRef.current.delete(sid);
          tokenUsageCacheRef.current.delete(sid);
          clearStreamCursor(sid);
          void deleteSessionCache(event.project_hash, sid);
          onTurnRunningChange?.(sid, false);
          if (activeIdRef.current === sid) {
            messagesRef.current = [];
            setMessages({ type: 'replace', rows: [] });
            setBusyAndClock(false);
          }
          return;
        }
        // 一条展示记录刚写盘：它未必推进 snapshot 的 cache_epoch，不能用
        // revision 闸门判断；直接做一次定向磁盘尾部对账（通知/压缩边界）。
        if (event.type === 'display_appended') {
          const sid = event.session_id;
          const hash =
            projectHashBySessionRef.current.get(sid) ??
            (sid === activeIdRef.current ? activeSession?.project_hash : undefined) ??
            viewedProjectHashRef.current ??
            '';
          if (!hash) return;
          if (activeIdRef.current === sid) {
            void syncSessionCacheFromDisk(hash, sid);
          } else {
            messageCacheRef.current.delete(sid);
            turnOutlineBySessionRef.current.delete(sid);
            historyOffsetBySessionRef.current.delete(sid);
            historyTotalBySessionRef.current.delete(sid);
            hasOlderBySessionRef.current.delete(sid);
            void deleteSessionCache(hash, sid);
          }
          return;
        }
        // 会话转录被变更（编辑 / 删除单条 / 回溯）：按 revision 收敛。
        // 绝不用增量帧把 mutation 套到画布上——那正是多端互相污染的老路。
        if (event.type === 'session_mutated') {
          const sid = event.session_id;
          const known = cacheRevisionBySessionRef.current.get(sid) ?? 0;
          if (event.revision < known) return;
          // This tab already applied the mutation at this revision (canvas +
          // cache + outline written together). A redundant full refetch would
          // only cause flicker and can race a newer local edit.
          if (event.revision > 0 && event.revision === known) return;
          cacheRevisionBySessionRef.current.set(sid, event.revision);
          const hash =
            projectHashBySessionRef.current.get(sid) ??
            (sid === activeIdRef.current ? activeSession?.project_hash : undefined) ??
            viewedProjectHashRef.current ??
            '';
          if (activeIdRef.current === sid) {
            // 前台：压缩完成/通知落盘也会走 mutation，必须立刻对齐磁盘尾部。
            // `syncSessionCacheFromDisk` 自己会拒绝仍在本地发送的回合，因此
            // 不能再因为 `busyRef`（压缩期间同样为 true）而跳过。
            if (hash) void syncSessionCacheFromDisk(hash, sid);
          } else {
            // 后台：丢掉可能已过期的 L1/L2 与派生大纲，下次切回走一次真拉取。
            messageCacheRef.current.delete(sid);
            // A deleted/rewritten branch must not survive in the rail cache:
            // its indices point at rows that no longer exist.
            turnOutlineBySessionRef.current.delete(sid);
            historyOffsetBySessionRef.current.delete(sid);
            historyTotalBySessionRef.current.delete(sid);
            hasOlderBySessionRef.current.delete(sid);
            if (hash) void deleteSessionCache(hash, sid);
          }
          return;
        }
        // 另一个实例刚弹出了待交互卡：对当前会话做一次定向 pending 拉取
        // （单会话、小请求），避免本实例漏帧而永久看不到卡片。
        if (event.type === 'review_asked') {
          const sid = activeIdRef.current;
          if (sid && event.session_id === sid) {
            restorePendingInteractive(sid, sessionGenerationRef.current);
          }
          return;
        }
        // 其它端刚改了该会话的待发卡片（创建 / 点转向 / 取消 / 已被内核消费）：
        // 拉一次单会话队列并就地落地 —— 卡片的三个阶段都要跨端一致。
        if (event.type === 'queue_updated') {
          refreshQueuedFromServer(event.session_id);
          return;
        }
        // 其它端把中途转向并入了正在跑的回合：把这条提问提前写进该会话的
        // 本地画布缓存（活跃视图由 /chat/watch 的 `steered` 帧负责归位落笔），
        // 这样切过去或冷启动时用户气泡已经在里面。
        if (event.type === 'steer_folded') {
          const sid = event.session_id;
          if (!sid) return;
          // 1) 画布与缓存幂等落笔：`foldSteeredInputs` 按 `steerId` 严格幂等。
          // 即使当前处于活跃视图，当 `/chat/watch` 因重连或待机切换漏掉 `steered` 帧时，
          // 全局 `steer_folded` 也能立即将转向卡片消费并落地为用户气泡（不再卡死在待发区）。
          foldSteeredInputs(
            event.inputs ?? [],
            event.client_input_ids,
            sid,
            event.timestamps,
            {
              skipQueued: true,
              seq: (event as { seq?: number }).seq,
              ...(event.anchor_message_id
                ? { replay: true, anchor: { messageId: event.anchor_message_id, authoritative: true } }
                : {}),
            },
          );
          // 2) 卡片队列清理（纯本地回写，不触发 saveChatQueue 避免回声）：
          const cachedQueue = activeIdRef.current === sid
            ? queuedRef.current
            : (queuedBySessionRef.current.get(sid) ?? []);
          const foldedInputs = (event.inputs ?? []).map((input, idx) => {
            const cid = event.client_input_ids?.[idx] ?? input.message_id ?? null;
            const localCard = cid
              ? cachedQueue.find(
                  (card) => card.clientInputId === cid || String(card.id) === cid,
                )
              : undefined;
            return {
              text: input.text,
              // 广播不带图片本体：本端折叠优先用队列卡片；跨端/刷新后由展示转录对账补齐。
              images: localCard?.images ?? [],
            };
          });
          const candidateIds = (event.inputs ?? []).map(
            (input, idx) => event.client_input_ids?.[idx] ?? input.message_id ?? null,
          );
          const prunedQueue = dropFoldedQueuedCards(
            cachedQueue,
            foldedInputs,
            candidateIds,
          );
          if (prunedQueue !== cachedQueue) {
            if (prunedQueue.length > 0) queuedBySessionRef.current.set(sid, prunedQueue);
            else queuedBySessionRef.current.delete(sid);
            saveQueuedToStorage(queuedBySessionRef.current);
            if (activeIdRef.current === sid) {
              queuedRef.current = prunedQueue;
              setQueuedState(prunedQueue);
            }
          }
          return;
        }
        // 模型配置（会话模型 / 提供商 / 模型 id / 思考强度 / 预算）在任意实例变更：
        // 各端只改自己的会话缓存与下拉框，绝不回写后端（避免回声）。
        if (event.type === 'model_config') {
          const sid = event.session_id ?? null;
          const isActive = sid != null && activeIdRef.current === sid;
          const hash = sid
            ? (projectHashBySessionRef.current.get(sid) ?? (isActive ? viewedProjectHashRef.current : null))
            : null;
          if (event.provider) {
            const provider = event.provider;
            if (sid) {
              providerCacheRef.current.set(sid, provider);
              if (hash) updateSessionCacheMeta(hash, sid, { preferredModel: provider });
              if (isActive) {
                setProvider(provider);
                providerPinnedRef.current = true;
              }
            } else if (activeIdRef.current == null && !providerPinnedRef.current) {
              // 新会话默认模型变了（尚未进入具体会话/尚未固定选择）。
              setProvider(provider);
            }
          }
          if (event.effort) {
            const effort = event.effort.reasoning_effort ?? null;
            const budget = event.effort.thinking_budget ?? null;
            if (sid) {
              effortCacheRef.current.set(sid, { effort, budget });
              if (hash) {
                updateSessionCacheMeta(hash, sid, { reasoningEffort: effort, thinkingBudget: budget });
              }
              if (isActive) {
                setSessionEffort(effort);
                setSessionBudget(budget);
              }
            } else {
              // 无会话作用域 = 模型默认强度变了：当前会话自己没有显式覆盖时才跟随，
              // 否则它的会话级选择优先（下一轮仍按会话元数据生效）。
              const activeSid = activeIdRef.current;
              if (!activeSid || !effortCacheRef.current.has(activeSid)) {
                setSessionEffort(effort);
                setSessionBudget(budget);
              }
            }
          }
          return;
        }
        if (event.type === 'runtime_activity') {
          const sid = event.session_id;
          const known = runtimeRevisionBySessionRef.current.get(sid) ?? -1;
          if (event.revision < known) return;
          runtimeRevisionBySessionRef.current.set(sid, event.revision);
          markRuntimeAuthoritative(sid);
          if (event.phase === 'compacting' && event.running !== false) {
            setSessionCompacting(sid, true, event.phase_started_at ?? undefined);
          } else {
            // 新 daemon 的阶段快照是权威：phase 缺失即“已结束压缩”。
            setSessionCompacting(sid, false);
          }
          if (activeIdRef.current === sid) {
            if (event.running) {
              armRunningForSession(
                sid,
                event.phase === 'compacting' ? event.phase_started_at ?? undefined : undefined,
              );
            } else {
              confirmActivityIdleFromAuthority(sid, { ensureIdleWatch: true });
            }
          } else if (!event.running) {
            confirmActivityIdleFromAuthority(sid);
          }
          return;
        }
        if (event.type === 'activity') {
          const sid = activeIdRef.current;
          const targetSid = event.session_id;
          if (targetSid) {
            // 新 daemon 的 runtime_activity 已按 revision 处理阶段；旧 activity
            // 只服务旧客户端协议，不能倒灌覆盖新快照。
            if (!runtimeAuthoritativeBySessionRef.current.has(targetSid)) {
              // `status` 是可选阶段字段：缺失只代表这次 activity 不携带阶段变化
              // （loop/goal 进度、用户回声、转向受理…），不能当成“压缩结束”。
              // 结束压缩必须由显式非 compacting 状态或权威 idle 驱动。
              const status = event.status;
              if (status === 'compacting') {
                setSessionCompacting(targetSid, true);
              } else if (status != null || event.running === false) {
                setSessionCompacting(targetSid, false);
              }
            }
          }
          if (sid && targetSid === sid) {
            // 服务端 `activity` 推送：running:true 立即点亮；running:false 或带 terminal 时，
            // 因为跨 SSE 连接下旧回合的空闲广播可能晚于新回合首帧到达，必须经由
            // `GET /chat/runtime` 做一次权威确认后再 settle，彻底根除迟到帧误杀新回合。
            const settledRunning = event.running === true && !event.terminal;
            const noForeground =
              abortRef.current === null && activeStreamRequestIdRef.current === null;
            const pendingHandover = isSessionTurnHandoverProtected(sid);
            const guarded = isSessionInManualStopGuard(sid);
            const action = resolveRuntimeBusyAction({
              serverRunning: settledRunning,
              busy: busyRef.current,
              hasForegroundSend: !noForeground,
              hasPendingTurnHandover: pendingHandover,
              inManualStopGuard: guarded,
            });
            if (action === 'arm') {
              armRunningForSession(sid);
            } else if (
              action === 'settle' ||
              (event.terminal && noForeground && !guarded && !pendingHandover)
            ) {
              confirmActivityIdleFromAuthority(sid, {
                ensureIdleWatch: Boolean(event.terminal),
              });
            }
          }
          if (!event.running || event.terminal) {
            // 后台会话同样经权威确认后收敛，避免跨会话切换瞬间旧回合迟到广播误杀新回合。
            if (activeIdRef.current !== targetSid && !isSessionTurnHandoverProtected(targetSid)) {
              confirmActivityIdleFromAuthority(targetSid);
            }
          }
        }
        if (event.type !== 'review_resolved' || event.request_id == null) return;
        setUserInputReq((cur) =>
          cur && cur.request_id === event.request_id ? null : cur,
        );
      }),
    [activeSession?.project_hash, onTurnRunningChange, syncSessionCacheFromDisk],
  );

  /**
   * 服务端权威运行态的「边沿」对齐：没有定时轮询。
   *
   * 运行中的状态变化完全由推送承担（`activity` 广播 + 直播帧自愈 + 终态帧）；
   * 这里只在会话装载/切换、页面重新可见、窗口回到前台、网络恢复这些边沿上
   * 各拉一次 `GET /chat/runtime`，用于补上「页面不在场」期间错过的事件。
   */
  useEffect(() => {
    const sid = sessionId ?? activeIdRef.current;
    if (!sid || loading) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const runtime = await getChatRuntime(sid);
        if (cancelled) return;
        applyServerRuntime(sid, runtime);
      } catch {
        /* 旧 daemon / 离线：保持事件驱动判定，不刷屏重试。 */
      }
    };
    void refresh();
    const onWake = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    // L2 写入合并后，页面隐藏/卸载前必须强制冲刷，否则最后一次画布状态会丢。
    const flushOnHide = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        void flushPendingPersist();
      }
    };
    const flushOnUnload = () => {
      void flushPendingPersist();
    };
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('beforeunload', flushOnUnload);

    return () => {
      cancelled = true;
      void flushPendingPersist();
      document.removeEventListener('visibilitychange', flushOnHide);
      window.removeEventListener('pagehide', flushOnUnload);
      window.removeEventListener('beforeunload', flushOnUnload);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, loading]);

  /** Project hash for the session on screen, including before App metadata arrives. */
  const viewedProjectHashRef = useRef<string | null>(activeSession?.project_hash ?? null);
  /** Last freshness signature we already parsed. Unchanged files are not read. */
  const freshnessSigRef = useRef('');
  /** Snapshot of a finished transcript. Ignore a leftover `state.running=true`
   * in the same reconnect replay so a completed session does not steal the
   * sidebar spinner or arm the stop button. */
  const liveIdleSnapshotRef = useRef(false);
  /** User echo held because it repeated the previous prompt during an idle
   *  snapshot. Released only when a delta is not already painted, so a
   *  finished turn's thinking replay cannot open a second bubble. */
  const heldDuplicateUserRef = useRef<string | null>(null);
  /** Once an idle-snapshot delta is recognized as more of the current
   *  assistant, a later token must not be treated as the next turn. */
  const replayBoundToAssistantRef = useRef(false);
  // 是否已为「当前会话」上报过乐观侧栏条目。每次切换/新建会话时复位，
  // 避免同一会话第二条消息（尤其 sync 路径本地不落消息）重复上报、改写标题。
  const optimisticFiredRef = useRef(false);
  // Sync path: text of a message THIS tab just optimistically appended (so the
  // view leaves the "new conversation" landing page instantly instead of waiting
  // for the server `user` echo, which only arrives after VL preprocessing). The
  // matching self-echo is deduped in the `user` case so we don't render it twice.
  // Turns are serialized (hub `turn_active`), so the next `user` echo after a send
  // is this tab's own; a peer's message (different text, or after the ref clears)
  // still appends normally.
  const pendingSelfEchoRef = useRef<Array<{ id: string; text: string }>>([]);
  // Artifact (code block) streaming: the daemon's ArtifactDetector strips fenced
  // code blocks from TextDelta and emits them as artifact_start / content / end.
  // Stream the reconstructed fence incrementally so a mid-turn cancel still
  // keeps whatever code already arrived (buffering until artifact_end used to
  // swallow the whole block).
  const artifactOpenRef = useRef(false);
  const artifactFenceLenRef = useRef(3);
  const artifactOpenBySessionRef = useRef<Map<string, number>>(new Map());

  // 切换/恢复会话时重置画布并加载历史。依赖 project_hash：刷新后 sessionId 先于
  // 元数据就绪，此时只显示提示；待 App 从会话列表回填 project_hash，本 effect 因
  // 依赖变化重跑，再真正拉取历史。
  useEffect(() => {
    // 会话 id 变化（外部切换 / 新建按钮）才重置画布。本 Chat 自建会话首条消息完成后
    // sessionId 变成自己的 id（activeIdRef 已同步），不重置，以免清空刚看到的对话。
    if (sessionId !== activeIdRef.current) {
      blockQueueDrainRef.current = true;
      const prevId = activeIdRef.current;
      if (!isFirstMountRef.current) {
        saveComposerDraft(prevId, {
          text: inputRef.current,
          images: pendingImageData(pendingAttachRef.current),
        });
      } else {
        isFirstMountRef.current = false;
      }
      if (prevId && provider) {
        providerCacheRef.current.set(prevId, provider);
      }
      if (prevId) {
        modeCacheRef.current.set(prevId, modeState.confirmedMode);
      }
      if (pendingSteersRef.current.length > 0 && prevId) {
        pendingSteersBySessionRef.current.set(prevId, [...pendingSteersRef.current]);
      }
      if (prevId) {
        stashSessionQueued(queuedBySessionRef.current, prevId, queuedRef.current);
      }
      if (prevId) {
        if (turnOutlineRef.current.length > 0) {
          turnOutlineBySessionRef.current.set(prevId, turnOutlineRef.current);
        } else {
          turnOutlineBySessionRef.current.delete(prevId);
        }
        historyOffsetBySessionRef.current.set(prevId, historyOffsetRef.current);
        historyTotalBySessionRef.current.set(prevId, historyTotalRef.current);
        const prevHasOlder = historyOffsetRef.current > 0 || hasOlder;
        hasOlderBySessionRef.current.set(prevId, prevHasOlder);
      }
      const detachedController = abortRef.current;
      // Prefer the ref: disk settlement writes it immediately, while React
      // state can still be the longer partial canvas from before the turn ended.
      const leavingMessages = messagesRef.current.length > 0 ? messagesRef.current : messages;
      const prevWasRunning = !!(prevId && (
        busyRef.current ||
        localTurnSessionsRef.current.has(prevId) ||
        backgroundRunningSessionsRef.current.has(prevId)
      ));
      if (
        prevId &&
        activeSession?.id === prevId &&
        activeSession.project_hash
      ) {
        projectHashBySessionRef.current.set(prevId, activeSession.project_hash);
      }
      if (prevId && leavingMessages.length > 0) {
        const sticky = activeTodosRef.current;
        const allDone = !!(sticky && sticky.length > 0 && sticky.every((t) => t.status === 'completed'));
        let cached: Message[];
        if (sticky && sticky.length > 0 && prevWasRunning) {
          // 回合还在跑：勾完也不归档，切回来画板还在。
          activeTodosBySessionRef.current.set(prevId, sticky);
          cached = detachUnfinishedTodoFromLatestAssistant(leavingMessages);
        } else if (allDone && sticky) {
          const doc = liveTodoDoc(prevId);
          cached = placeArchivedTodos(leavingMessages, sticky, doc?.revision ?? null);
          writeLiveTodo(prevId, null);
        } else if (sticky && sticky.length > 0) {
          activeTodosBySessionRef.current.set(prevId, sticky);
          cached = detachUnfinishedTodoFromLatestAssistant(leavingMessages);
        } else {
          activeTodosBySessionRef.current.delete(prevId);
          cached = detachUnfinishedTodoFromLatestAssistant(leavingMessages);
        }
        // Stamp the leaving session's live stopwatch into its cache ONLY when it
        // is already settled. Stamping elapsedMs onto an in-flight streaming
        // assistant row makes it look like a settled historical turn on return,
        // causing replayed prompts to append after it with a ghost Working row!
        if (turnStartedAtRef.current != null) {
          turnStartedAtBySessionRef.current.set(prevId, turnStartedAtRef.current);
          if (!prevWasRunning) {
            cached = stampLastAssistantElapsed(cached, Date.now() - turnStartedAtRef.current, undefined, { overwrite: true });
          }
        }
        messageCacheRef.current.set(prevId, cached);
      } else if (prevId) {
        if (turnStartedAtRef.current != null) {
          turnStartedAtBySessionRef.current.set(prevId, turnStartedAtRef.current);
        }
        const sticky = activeTodosRef.current;
        if (sticky && sticky.length > 0 && (prevWasRunning || sticky.some((t) => t.status !== 'completed'))) {
          activeTodosBySessionRef.current.set(prevId, sticky);
        }
      }

      // Invalidate in-flight /chat event handlers for the session we are leaving
      // (isCurrentChatStream checks generation). Do this BEFORE rebinding ids so
      // a late SSE chunk cannot paint into the destination session. Capture the
      // post-bump generation for async switch callbacks (A→B→A races).
      sessionGenerationRef.current += 1;
      freshnessSigRef.current = '';
      const switchGeneration = sessionGenerationRef.current;
      if (prevId && tokensRef.current) {
        saveTokenSnapshot(prevId, tokensAuthoritativeRef.current);
      }
      tokenSaveGenerationRef.current = switchGeneration;
      resetTokenTelemetry();
      if (prevId && abortRef.current && activeStreamRequestIdRef.current) {
        localActiveStreamsBySessionRef.current.set(prevId, {
          abortController: abortRef.current,
          requestId: activeStreamRequestIdRef.current,
        });
      }
      if (prevId && pendingSelfEchoRef.current.length > 0) {
        pendingSelfEchoBySessionRef.current.set(prevId, [...pendingSelfEchoRef.current]);
      } else if (prevId) {
        pendingSelfEchoBySessionRef.current.delete(prevId);
      }
      if (textRafRef.current != null) {
        window.cancelAnimationFrame(textRafRef.current);
        textRafRef.current = null;
      }
      flushPendingText();
      pendingTextRef.current = [];
      pendingTextSessionIdRef.current = null;
      activeIdRef.current = sessionId;
      canvasReadySessionIdRef.current = null;
      if (sessionId) {
        preMountStreamBufferRef.current.set(sessionId, []);
      }
      const nextCompacting = sessionId ? compactingSessionsRef.current.has(sessionId) : false;
      setIsCompacting(nextCompacting);
      setCompactionStartedAt(
        nextCompacting && sessionId
          ? compactionStartedAtBySessionRef.current.get(sessionId) ?? null
          : null,
      );
      compactingRef.current = nextCompacting;
      isCompactingRef.current = nextCompacting;
      restoreProviderForSession(
        sessionId,
        activeSession?.id === sessionId ? activeSession.preferred_model : null,
      );
      restoreSessionEffort(
        sessionId,
        activeSession?.id === sessionId
          ? { effort: activeSession.reasoning_effort, budget: activeSession.thinking_budget }
          : null,
      );
      restoreModeForSession(
        sessionId,
        activeSession?.id === sessionId ? (activeSession.approval_mode as ApprovalMode) : null,
      );
      // 全局开关开启时，所有会话共用同一个模式：忽略会话级缓存/元数据，
      // 直接沿用当前已确认的全局模式，避免切回旧会话时退回旧值。
      if (globalModeRef.current) {
        nativeModeRef.current = modeState.confirmedMode;
        setModeState(initModeState(modeState.confirmedMode));
      }

      // 恢复新会话的输入框草稿
      const nextDraft = loadComposerDraft(sessionId);
      setInput(nextDraft?.text ?? '');
      setPendingAttach(nextDraft?.images ? imagesToPending(nextDraft.images) : []);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        if (nextDraft?.text) {
          window.requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
            }
          });
        }
      }

      // 恢复新会话的气泡编辑草稿
      const nextBubbleDraft = sessionId ? loadBubbleEditDraft(sessionId) : null;
      setBubbleEditDraft(nextBubbleDraft);
      setEditingSourceIndex(nextBubbleDraft?.sourceIndex ?? null);
      const stashedSteers = sessionId
        ? (pendingSteersBySessionRef.current.get(sessionId) || getStoredSteers(sessionId))
        : undefined;
      if (stashedSteers?.length && sessionId) {
        setPendingSteers(stashedSteers);
      } else {
        setPendingSteers([]);
      }
      loadedForRef.current = null;
      const openFence = sessionId ? artifactOpenBySessionRef.current.get(sessionId) : undefined;
      artifactOpenRef.current = openFence != null;
      artifactFenceLenRef.current = openFence || 3;
      if (!prevWasRunning && prevId) {
        sessionWatchersRef.current.get(prevId)?.abort();
        sessionWatchersRef.current.delete(prevId);
      }
      stopIdleWatch();
      optimisticFiredRef.current = false;
      const restoredActiveStream = sessionId ? localActiveStreamsBySessionRef.current.get(sessionId) : undefined;
      if (restoredActiveStream && !restoredActiveStream.abortController.signal.aborted) {
        abortRef.current = restoredActiveStream.abortController;
        activeStreamRequestIdRef.current = restoredActiveStream.requestId;
      } else {
        abortRef.current = null;
        activeStreamRequestIdRef.current = null;
        if (sessionId) localActiveStreamsBySessionRef.current.delete(sessionId);
      }
      pendingSelfEchoRef.current = sessionId
        ? (pendingSelfEchoBySessionRef.current.get(sessionId) ?? [])
        : [];
      // An existing session stays send-locked until `/chat/active` proves it
      // has no detached operation. Its canonical id is already a safe stop
      // alias, including while the discovery request is pending or unavailable.
      requestIdRef.current = sessionId;
      transitionChatRecovery({ type: 'session_switch', hasSession: sessionId !== null });
      // 离开会话时，不再粗暴 abort 正在运行中的后台会话读者流！
      // 后台流在存活状态下继续接收事件并通过 applyEventToSessionCache 实时同步进缓存，
      // 彻底消除切回会话时正文丢失、状态断层的顽疾。
      // （仅在用户主动点击「停止」按钮时才显式 abort）
      if (prevWasRunning && prevId) {
        backgroundRunningSessionsRef.current.add(prevId);
        onTurnRunningChange?.(prevId, true);
        ensureBackgroundFinishWatch();
      }
      const cached = sessionId ? messageCacheRef.current.get(sessionId) : undefined;
      const destRunning = !!(
        sessionId &&
        (backgroundRunningSessionsRef.current.has(sessionId) ||
          localTurnSessionsRef.current.has(sessionId))
      );
      const destElapsed = destRunning
        ? [...(cached ?? [])].reverse().find((m) => m.role === 'assistant')?.elapsedMs
        : undefined;
      liveLifecycleRef.current = destRunning
        ? { running: true, terminalConsumed: false }
        : createLiveLifecycleState();
      finishTurnClock({ stamp: false });
      if (destRunning) {
        const sessionStarted = sessionId ? turnStartedAtBySessionRef.current.get(sessionId) : undefined;
        // Fallback to the root user message's send timestamp (penetrating steers) if stashed clock is absent
        const lastUserTs = rootTurnUserTs(cached ?? [], (cached ?? []).length);
        const started = sessionStarted ?? lastUserTs ?? resumeTurnStartedAt(Date.now(), destElapsed);
        if (sessionId) {
          turnStartedAtBySessionRef.current.set(sessionId, started);
        }
        turnStartedAtRef.current = started;
        setTurnStartedAt(started);
        busyRef.current = true;
        setBusy(true);
      } else {
        // Do NOT eagerly delete turnStartedAtBySessionRef here if the session might still be active
        // or reconnecting via detached watch; only reset when truly idle or terminal
        busyRef.current = false;
        setBusy(false);
      }
      // 恢复该会话暂存的排队消息（含等待当前步骤完成的转向卡片）。
      // 关键防线：只有内容已经正式作为用户提问出现在历史中的卡片（已落盘/已渲染），才需要剔除；
      // 尚在内核缓冲区排队等待当前步骤完成的转向卡片（kind === 'steer'），必须屹立不倒，继续展示「转向已排队」和取消按钮！
      const allKnown = [
        ...messagesRef.current,
        ...(sessionId ? (messageCacheRef.current.get(sessionId) ?? []) : []),
      ];
      // Identity first; steer cards additionally fall back to exact text/image
      // because a reconnect may lose the client-id ↔ kernel-id mapping.
      const queuedItemOnCanvas = (item: QueuedMessage) => queuedCardOnCanvas(allKnown, item, sessionId);

      const stashedQueued = restoreSessionQueued(queuedBySessionRef.current, sessionId).filter(
        (item) => !queuedItemOnCanvas(item),
      );
      setQueuedLocal(stashedQueued);
      // 异步与后端同步队列（跨设备/换手机打开该会话时无缝同步恢复）。
      // 后端是“哪些卡片真的会被发送”的权威：本地存储里已被对端消费的旧卡片
      // 必须在这里被剔除，否则刷新/冷启动会把已转向成功的卡片复活并再发一次。
      if (sessionId) {
        const queueSid = sessionId;
        const queueGeneration = sessionGenerationRef.current;
        void getChatQueue(queueSid).then((snapshot) => {
          if (
            activeIdRef.current !== queueSid ||
            sessionGenerationRef.current !== queueGeneration
          ) {
            return;
          }
          const known = queueRevisionBySessionRef.current.get(queueSid) ?? 0;
          if (!shouldApplyRevision(known, snapshot.revision)) return;
          queueRevisionBySessionRef.current.set(queueSid, snapshot.revision);
          applyServerQueue(queueSid, snapshot.items, { hydration: true });
        });
      }
      setUserInputReq(null);
      onPermissionResolved?.(null);
      applySessionStickyTodos(
        sessionId,
        sessionId ? activeTodosBySessionRef.current.get(sessionId) ?? null : null,
      );
      timelineFollow.reset();
      if (cached && cached.length > 0) {
        const cleanCached = cached;
        if (sessionId) messageCacheRef.current.set(sessionId, cleanCached);

        messagesRef.current = cleanCached;
        setMessages({ type: 'replace', rows: cleanCached });
        canvasReadySessionIdRef.current = sessionId;
        flushPreMountStreamBuffer(sessionId);
        pinTimelineToBottom();
      } else {
        // 新建会话（sessionId === null）时，上一个会话的回合可能还在跑：
        // 此时画布上就是那一轮的乐观提问 + Working。旧实现用 sessionId 判活跃，
        // sessionId 为 null 时恒为 false → 直接清屏，把正在跑的画布抹成空白，
        // 看起来就是“老会话记录被清空，只剩用户气泡和 Working”。
        // 活跃判定必须看**来源会话**（prevId），不是看即将进入的新会话。
        const sourceSid = prevId ?? sessionId;
        const sourceActive = !!(
          sourceSid &&
          (localTurnSessionsRef.current.has(sourceSid) ||
            backgroundRunningSessionsRef.current.has(sourceSid))
        );
        if (shouldClearCanvasOnSwitch({
          targetSessionId: sessionId,
          sourceSessionId: sourceSid,
          canvasLen: messagesRef.current.length,
          sourceActive,
        })) {
          messagesRef.current = [];
          setMessages({ type: 'replace', rows: [] });
          atBottomRef.current = true;
          setShowJumpBtn(false);
          const el = scrollRef.current;
          if (el) el.scrollTop = 0;
        }
        canvasReadySessionIdRef.current = sessionId;
        flushPreMountStreamBuffer(sessionId);
      }

      cancelTurnNavScroll();
      setTurnNavQuery('');
      setActiveTurnId(null);
      turnNavPinUntilRef.current = 0;
      const cachedOffset = sessionId ? (historyOffsetBySessionRef.current.get(sessionId) ?? 0) : 0;
      const cachedTotal = sessionId ? (historyTotalBySessionRef.current.get(sessionId) ?? 0) : 0;
      const cachedOutline = sessionId ? turnOutlineBySessionRef.current.get(sessionId) : undefined;
      const firstTurnIdx = cachedOutline?.[0]?.index ?? 0;
      const cachedHasOlder = sessionId
        ? hasOlderVisibleMessages({
            offset: cachedOffset,
            firstTurnIndex: firstTurnIdx,
            canvasHasFirstTurn: cached?.some((m) => typeof m.sourceIndex === 'number' && m.sourceIndex <= firstTurnIdx),
            // 身份优先：优先用画布首行的 seq 对账，而不是缓存里粘着的 hasOlder。
            oldestSeq: cached?.[0]?.seq,
          })
        : false;
      setHasOlder(cachedHasOlder);
      setLoadingOlder(false);
      historyOffsetRef.current = cachedOffset;
      historyTotalRef.current = cachedTotal;
      pendingJumpIdRef.current = null;
      const nextOutline = fullerOutline(
        cachedOutline,
        sessionId ? turnOutlineBySessionRef.current.get(sessionId) : undefined,
      );
      setTurnOutline(nextOutline);
      if (sessionId && nextOutline.length > 0) {
        turnOutlineBySessionRef.current.set(sessionId, nextOutline);
      }

      // bot review P2: 切换会话时重置搜索状态与图片灯箱,避免残留关键词或上一会话隐藏预览串台。
      setSearch('');
      setMatchIdx(0);
      setGlobalPreviewImage(null);
      setPreviewGallery([]);
      setHistoryHint(null);
      setPersistenceWarning(null);
      applySessionTokens(sessionId, cached && cached.length > 0 ? cached : []);
      // 切到有内容的历史会话才进「加载中」抑制落地页。新建/draft（message_count=0）
      // 以及元数据尚未对齐的 id 必须保持落地，否则会闪一下空聊天框再跳回落地页。
      setLoading(
        sessionId != null &&
          !cached &&
          !stayOnNewSessionLanding({ sessionId, activeSession }),
      );
    }

    if (!sessionId) {
      requestIdRef.current = null;
      return;
    }
    // 已为该会话加载过历史（或它是本 Chat 自建会话）→ 不重复加载、不覆盖。
    if (loadedForRef.current === sessionId) return;

    // ── 架构核心改进：会话来回切换（Warm Switch）属于内存热切换，绝不算冷启动！──
    // 只要当前会话在内存缓存中已有数据，0ms 瞬间恢复画布，完全不需要等待 project_hash 或向后台发网络请求（getSession），
    // 极大减轻后台与磁盘 I/O 压力，消除切会话时的多余闪烁与重绘，彻底拔除老架构将内存缓存阻塞在 projectHash 门禁后的隐患！
    const cached = messageCacheRef.current.get(sessionId);
    if (cached && cached.length > 0) {
      loadedForRef.current = sessionId;
      const effectiveHash =
        activeSession?.project_hash ||
        projectHashBySessionRef.current.get(sessionId) ||
        viewedProjectHashRef.current ||
        '';
      if (effectiveHash) projectHashBySessionRef.current.set(sessionId, effectiveHash);

      setLoading(false);
      // 热切回以内存为唯一真相源，但缓存里可能残留历史清理前的重复节点；
      // 上屏前清洗并回写，保证下一轮终态对账基于干净画布拼接（重复不会累积）。
      const cleanCached = cached;
      messageCacheRef.current.set(sessionId, cleanCached);

      messagesRef.current = cleanCached;
      setMessages({ type: 'replace', rows: cleanCached });
      canvasReadySessionIdRef.current = sessionId;
      flushPreMountStreamBuffer(sessionId);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      timelineFollow.jump();

      const cachedTurns = turnOutlineBySessionRef.current.get(sessionId);
      if (cachedTurns && cachedTurns.length > 0) {
        setTurnOutline(cachedTurns);
      }
      const firstTurnIdx = cachedTurns?.[0]?.index ?? 0;

      const savedOffset = historyOffsetBySessionRef.current.get(sessionId) ?? 0;
      const savedTotal = historyTotalBySessionRef.current.get(sessionId) ?? 0;
      const savedHasOlder =
        hasOlderVisibleMessages({ offset: savedOffset, firstTurnIndex: firstTurnIdx, canvasHasFirstTurn: cached?.some((m) => typeof m.sourceIndex === 'number' && m.sourceIndex <= firstTurnIdx) }) ||
        (hasOlderBySessionRef.current.get(sessionId) === true) ||
        (activeSession?.id === sessionId && (activeSession.message_count ?? 0) > cached.length);
      historyOffsetRef.current = savedOffset;
      historyTotalRef.current = savedTotal;
      setHasOlder(savedHasOlder);
      // Keep the per-session cursor/flag in sync with the trimmed canvas; the
      // old code left the full-history offset (often 0) here, so the next warm
      // switch thought everything was loaded and never offered "load earlier".
      historyOffsetBySessionRef.current.set(sessionId, savedOffset);
      hasOlderBySessionRef.current.set(sessionId, savedHasOlder);
      const cachedProv =
        providerCacheRef.current.get(sessionId) ||
        (activeSession?.id === sessionId ? activeSession.preferred_model : null);
      if (cachedProv) {
        setProvider(cachedProv);
        providerPinnedRef.current = true;
      }
      const cachedMode =
        modeCacheRef.current.get(sessionId) ||
        (activeSession?.id === sessionId ? (activeSession.approval_mode as ApprovalMode) : null);
      if (globalModeRef.current) {
        // 全局开关开启：所有会话共用同一模式，忽略会话级残留。
        nativeModeRef.current = modeState.confirmedMode;
        setModeState(initModeState(modeState.confirmedMode));
      } else if (cachedMode) {
        nativeModeRef.current = cachedMode;
        setModeState(initModeState(cachedMode));
      } else {
        getApprovalMode(sessionId)
          .then((current) => {
            if (activeIdRef.current === sessionId) {
              modeCacheRef.current.set(sessionId, current);
              nativeModeRef.current = current;
              setModeState(initModeState(current));
            }
          })
          .catch(() => {});
      }
      const localLifecycle = resolveSessionLifecycle({
        serverActive: false,
        localTurn: localTurnSessionsRef.current.has(sessionId),
        backgroundTurn: backgroundRunningSessionsRef.current.has(sessionId),
      });
      const enterRunningSession = () => {
        setBusyAndClock(true);
        busyRef.current = true;
        requestIdRef.current = sessionId;
        backgroundRunningSessionsRef.current.add(sessionId);
        startDetachedHistoryPoll(effectiveHash, sessionId, sessionGenerationRef.current);
        const cachedTodos = activeTodosBySessionRef.current.get(sessionId);
        applySessionStickyTodos(sessionId, cachedTodos ?? null);
      };
      const enterIdleSession = () => {
        setBusyAndClock(false);
        busyRef.current = false;
        // 关键根因修复：切入空闲会话时，保留本会话内存中的未完成清单与画板，并静默拉取磁盘最新消息！
        const cachedTodos = activeTodosBySessionRef.current.get(sessionId);
        applySessionStickyTodos(sessionId, cachedTodos ?? null);
        if (effectiveHash) {
          void syncSessionCacheFromDisk(effectiveHash, sessionId);
        }
        startIdleWatch(effectiveHash, sessionId, sessionGenerationRef.current);
      };
      if (localLifecycle.phase === 'live') {
        enterRunningSession();
      } else {
        // A stale IndexedDB canvas must not decide that the session is idle. A
        // new browser/tab has no local running refs, but the daemon may already
        // be streaming this turn; ask `/chat/active` before attaching standby.
        const checkSid = sessionId;
        const checkGen = sessionGenerationRef.current;
        void getActiveChatSessions()
          .then((actives) => {
            if (activeIdRef.current !== checkSid || sessionGenerationRef.current !== checkGen) return;
            const lifecycle = resolveSessionLifecycle({
              serverActive: actives.includes(checkSid),
            });
            if (lifecycle.phase === 'live') enterRunningSession();
            else enterIdleSession();
          })
          .catch(() => enterIdleSession());
      }
      return;
    }

    const projectHash = activeSession?.project_hash;
    const hideLoadChrome = stayOnNewSessionLanding({ sessionId, activeSession });
    if (hideLoadChrome) {
      setHistoryHint(null);
      setLoading(false);
    }
    if (!projectHash || !activeSession || activeSession.id !== sessionId) {
      // 0ms 离线首屏加速：在 projectHash / activeSession 尚在远程解析期间，优先按 sessionId
      // 从本地 IndexedDB 0ms 秒出历史画布，彻底拔除等待网络解析导致的前置空白！
      if (!hideLoadChrome && sessionId && !messageCacheRef.current.has(sessionId)) {
        const earlySid = sessionId;
        const earlyGen = sessionGenerationRef.current;
        void getSessionCache('', earlySid).then((idb) => {
          if (
            idb &&
            idb.messages.length > 0 &&
            activeIdRef.current === earlySid &&
            sessionGenerationRef.current === earlyGen
          ) {
            if (!messageCacheRef.current.has(earlySid)) {
              const clean = idb.messages;
              messageCacheRef.current.set(earlySid, clean);
              messagesRef.current = clean;
              setMessages({ type: 'replace', rows: clean });
              setLoading(false);
              noteCacheRevision(earlySid, idb.revision);
              if (idb.projectHash) {
                projectHashBySessionRef.current.set(earlySid, idb.projectHash);
              }
              if (idb.turns && idb.turns.length > 0) {
                const nextOutline = fullerOutline(
                  idb.turns,
                  turnOutlineBySessionRef.current.get(earlySid),
                );
                turnOutlineBySessionRef.current.set(earlySid, nextOutline);
                setTurnOutline(nextOutline);
              }
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
              timelineFollow.jump();
            }
          }
        });
      }
      return;
    }

    // 标记已为该会话发起加载，避免并发/重复。
    loadedForRef.current = sessionId;
    if (projectHash) projectHashBySessionRef.current.set(sessionId, projectHash);

    // ── 冷启动优化：优先从 IndexedDB 异步直出首屏（1~3ms），杜绝白屏与加载中等待 ──
    const loadId = sessionId;
    const loadGeneration = sessionGenerationRef.current;
    if (!hideLoadChrome) {
      getSessionCache(projectHash, loadId).then((idb) => {
        const cursorSeq = readStreamCursor(loadId)?.seq;
        const cacheSeqBehind =
          typeof idb?.lastSeq === 'number' &&
          typeof cursorSeq === 'number' &&
          idb.lastSeq < cursorSeq;
        if (idb && !cacheSeqBehind && idb.messages.length > 0 && activeIdRef.current === loadId && sessionGenerationRef.current === loadGeneration) {
          if (!messageCacheRef.current.has(loadId)) {
            const cleanIdbMessages = idb.messages;
            messageCacheRef.current.set(loadId, cleanIdbMessages);
            messagesRef.current = cleanIdbMessages;
            setMessages({ type: 'replace', rows: cleanIdbMessages });
            setLoading(false);
            noteCacheRevision(loadId, idb.revision);
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            timelineFollow.jump();
          }
          const cachedTurns = stripUnbackedProvisionalTurns(idb.turns, idb.messages) ?? [];
          if (cachedTurns.length > 0) {
            const nextOutline = fullerOutline(
              cachedTurns,
              turnOutlineBySessionRef.current.get(loadId),
            );
            turnOutlineRef.current = nextOutline;
            turnOutlineBySessionRef.current.set(loadId, nextOutline);
            setTurnOutline(nextOutline);
          }
          if (idb.historyOffset !== undefined) {
            const diskOffset = idb.historyOffset;
            const diskTotal = idb.historyTotal ?? (idb.messages.length + diskOffset);
            const firstTurnIdx = idb.turns?.[0]?.index ?? 0;
            const olderExists = hasOlderVisibleMessages({ offset: diskOffset, firstTurnIndex: firstTurnIdx });
            historyOffsetRef.current = diskOffset;
            historyTotalRef.current = diskTotal;
            setHasOlder(olderExists);
            historyOffsetBySessionRef.current.set(loadId, diskOffset);
            historyTotalBySessionRef.current.set(loadId, diskTotal);
            hasOlderBySessionRef.current.set(loadId, olderExists);
          }
          // 缓存里的待办只是首屏垫底：只有缓存 revision 不低于已知服务端 revision 时才可用。
          // 刷新后内存 epoch 归零，不能再用它判断新鲜度（否则旧 todo 会无条件回流）。
          const knownTodoRevision = todoRevisionBySessionRef.current.get(loadId) ?? 0;
          const cachedTodoRevision =
            typeof idb.todoRevision === 'number' ? idb.todoRevision : 0;
          if (shouldApplyRevision(knownTodoRevision, cachedTodoRevision)) {
            if (idb.todos && idb.todos.length > 0 && idb.todos.some((t: any) => t.status !== 'completed')) {
              applySessionStickyTodos(loadId, idb.todos);
            } else {
              applySessionStickyTodos(loadId, null);
            }
            todoRevisionBySessionRef.current.set(
              loadId,
              Math.max(knownTodoRevision, cachedTodoRevision),
            );
          }
          // Queue state is hydrated from localStorage and then reconciled with
          // `/chat/queue`; the canvas cache can predate a steer state transition.
          if (idb.approvalMode) {
            modeCacheRef.current.set(loadId, idb.approvalMode as ApprovalMode);
            if (activeIdRef.current === loadId && !modeState.pendingMode) {
              nativeModeRef.current = idb.approvalMode as ApprovalMode;
              setModeState(initModeState(idb.approvalMode as ApprovalMode));
            }
          }
          if (idb.preferredModel) {
            providerCacheRef.current.set(loadId, idb.preferredModel);
            if (activeIdRef.current === loadId) {
              setProvider(idb.preferredModel);
              providerPinnedRef.current = true;
            }
          }
          if (idb.reasoningEffort !== undefined || idb.thinkingBudget !== undefined) {
            rememberSessionEffort(
              loadId,
              (idb.reasoningEffort as string | null) ?? null,
              (idb.thinkingBudget as number | null) ?? null,
            );
          }
          if (idb.tokenUsage) {
            if (idb.compacted) {
              // 压缩后的占用比磁盘里最后一条 assistant 的 usage 更新：先恢复快照，
              // applySessionTokens 的 compacted 守卫才会拒绝被压缩前的旧值覆盖。
              tokenUsageCacheRef.current.set(loadId, {
                tokens: idb.tokenUsage,
                cacheState: {
                  lastPrompt: idb.tokenUsage.prompt ?? 0,
                  providerReportsCache: false,
                },
                authoritative: false,
                compacted: true,
              });
            }
            applySessionTokens(loadId, idb.messages, idb.tokenUsage);
          }
        }
      });
      if (!messageCacheRef.current.has(loadId)) {
        setLoading(true);
      }
    }
    const todoEpochAtLoad = todoLiveEpoch(loadId);
    Promise.allSettled([
      pullSession({ projectHash, sessionId: loadId, mode: 'snapshot', limit: HISTORY_PAGE }),
      getActiveChatSessions(),
      getChatRuntime(loadId),
    ])
      .then(([sessionResult, activeResult, runtimeResult]) => {
        // Generation also covers A -> B -> A; id equality alone is insufficient.
        if (
          activeIdRef.current !== loadId ||
          sessionGenerationRef.current !== loadGeneration
        ) return;

        const hydratedRuntime = runtimeResult.status === 'fulfilled' ? runtimeResult.value : null;
        const knownRuntimeRevision = runtimeRevisionBySessionRef.current.get(loadId) ?? -1;
        const hydratedRevision = typeof hydratedRuntime?.revision === 'number'
          ? hydratedRuntime.revision
          : -1;
        if (hydratedRevision >= knownRuntimeRevision) {
          runtimeRevisionBySessionRef.current.set(loadId, hydratedRevision);
          if (typeof hydratedRuntime?.revision === 'number') {
            markRuntimeAuthoritative(loadId);
          }
        }
        const hydratedCompacting =
          hydratedRuntime?.phase === 'compacting' || hydratedRuntime?.status === 'compacting';
        if (hydratedCompacting) {
          setSessionCompacting(
            loadId,
            true,
            hydratedRuntime.phase_started_at ??
              hydratedRuntime.compaction_started_at ??
              hydratedRuntime.started_at ??
              undefined,
          );
        } else if (
          hydratedRuntime &&
          hydratedRevision >= knownRuntimeRevision &&
          Object.prototype.hasOwnProperty.call(hydratedRuntime, 'phase') &&
          abortRef.current === null &&
          activeStreamRequestIdRef.current === null
        ) {
          // 同一/更高 revision 的权威快照明确表示“不在压缩”：清掉切会话后
          // 可能残留的本地阶段。更旧的快照（< known）不得覆盖刚点下的压缩。
          setSessionCompacting(loadId, false);
        }
        if (hydratedRuntime?.turn_id && serverRuntimeRunning(hydratedRuntime)) {
          noteTurnOperation(loadId, hydratedRuntime.turn_id);
        }

        let nextHint: string | null = null;
        let resumeClockFrom: number | undefined;
        const currentCached = messageCacheRef.current.get(loadId);
        const runtimeIsRunning = serverRuntimeRunning(hydratedRuntime);
        const serverActive =
          activeResult.status === 'fulfilled'
            ? activeResult.value.includes(loadId) || runtimeIsRunning
            : runtimeIsRunning ? true : null;
        if (serverActive === false) {
          localTurnSessionsRef.current.delete(loadId);
          backgroundRunningSessionsRef.current.delete(loadId);
          onTurnRunningChange?.(loadId, false);
        }
        if (sessionResult.status === 'fulfilled' && sessionResult.value && Array.isArray(sessionResult.value.messages)) {
          serverCapsRef.current = sessionResult.value.caps ?? [];
          // 能力协商：新 daemon 声明 `id` 后，前端关闭所有文本兜底。
          // 能力协商已收编为身份唯一，无需再写全局开关。
          const preferred = sessionResult.value.preferred_model;
          if (preferred) {
            setProvider(preferred);
            providerCacheRef.current.set(loadId, preferred);
            providerPinnedRef.current = true;
          } else {
            const cachedProv =
              providerCacheRef.current.get(loadId) ||
              (activeSession?.id === loadId ? activeSession.preferred_model : null);
            if (cachedProv) {
              setProvider(cachedProv);
              providerPinnedRef.current = true;
            } else {
              restoreProviderForSession(loadId);
            }
          }
          if (
            !effortCacheRef.current.has(loadId) &&
            (sessionResult.value.reasoning_effort !== undefined ||
              sessionResult.value.thinking_budget !== undefined)
          ) {
            rememberSessionEffort(
              loadId,
              sessionResult.value.reasoning_effort ?? null,
              sessionResult.value.thinking_budget ?? null,
            );
          }
          // 无论当前会话是否处于实时推流（serverActive），服务端的全局元数据（大纲、总数、偏移）
          // 始终具有权威完整性，必须立刻更新！不能锁在 canvasEmpty / serverActive 门禁内部，
          // 否则异地冷启动接入运行中会话时大纲会丢失（退化为仅有推流的 3-5 条）且无法向上加载历史！
          const totalOnDisk = sessionResult.value.message_count ?? (sessionResult.value.messages.length + (sessionResult.value.offset ?? 0));
          const diskOffset = sessionResult.value.offset ?? 0;
          const cachedTotal = historyTotalBySessionRef.current.get(loadId) ?? 0;
          // A shrinking transcript means compaction renumbered the snapshot array.
          // Cached source indices are from the OLD array: merging them by index is
          // what produced "old question below later answers". Fall back to the
          // authoritative tail instead of mixing two coordinate systems.
          const cacheShrank = cachedTotal > 0 && totalOnDisk > 0 && totalOnDisk < cachedTotal;
          // A cache that ends before the disk tail leaves an unrendered hole when
          // spliced. On an idle session, prefer the authoritative tail instead.
          const cacheHasGap =
            !!currentCached &&
            currentCached.length > 0 &&
            !cachedHeadIsContiguous(currentCached, diskOffset);
          // The API always answers with the 48-row tail offset. If L2 already holds
          // earlier pages, keep its cursor; otherwise "load earlier" fetches rows
          // already on screen and silently adds nothing.
          const effectiveOffset = cacheShrank || cacheHasGap
            ? diskOffset
            : resolveHistoryOffset({
                cachedMessages: currentCached,
                cachedOffset: historyOffsetBySessionRef.current.get(loadId),
                diskOffset,
              });
          const firstTurnIdx = sessionResult.value.turns?.[0]?.index ?? 0;
          const diskHeadSeq = oldestDisplaySeq(sessionResult.value.messages ?? []);
          const effectiveOlderExists = computeEffectiveHasOlder({
            offset: effectiveOffset,
            firstTurnIndex: firstTurnIdx,
            oldestSeq: sessionResult.value.cursor?.oldest_seq ?? diskHeadSeq,
            firstTurnSeq: sessionResult.value.turns?.[0]?.seq,
            canvasHeadSeq: oldestDisplaySeq(currentCached ?? []),
            pageHeadSeq: diskHeadSeq,
            hasCanvasRows: (currentCached?.length ?? 0) > 0,
          });
          historyTotalRef.current = totalOnDisk;
          historyOffsetRef.current = effectiveOffset;
          setHasOlder(effectiveOlderExists);
          historyOffsetBySessionRef.current.set(loadId, effectiveOffset);
          historyTotalBySessionRef.current.set(loadId, totalOnDisk);
          hasOlderBySessionRef.current.set(loadId, effectiveOlderExists);
          const serverRevision = sessionResult.value.revision ?? 0;
          const cachedEntry = getMemorySession(projectHash, loadId);
          const cachedRevision =
            cacheRevisionBySessionRef.current.get(loadId) ??
            cachedEntry?.revision ??
            0;
          const cacheStale =
            serverRevision > 0 && cachedRevision > 0 && cachedRevision < serverRevision;
          const cursorSeq = readStreamCursor(loadId)?.seq;
          // L1 内存画布 `currentCached` 与 `streamCursor` 同步逐帧推进；只有无 L1 缓存、
          // 仅凭 L2 快照恢复时才检查 `cachedEntry.lastSeq < cursorSeq`。
          const cacheSeqBehind =
            (!currentCached || currentCached.length === 0) &&
            typeof cachedEntry?.lastSeq === 'number' &&
            typeof cursorSeq === 'number' &&
            cachedEntry.lastSeq < cursorSeq;
          noteCacheRevision(loadId, serverRevision);

          if (sessionResult.value.turns && sessionResult.value.turns.length > 0) {
            // 服务端大纲来源是显示日志：显示日志要等 turn_complete 才落盘；
            // 运行中 API 会用 admitted user 临时补一条，但终态前后仍有短暂窗口。
            // 本地缓存的大纲是唯一不会晚到的那份，冷启动必须合并而不是替换。
            // 关键：若缓存已发生版本变异或因果断层，旧大纲不可信，直接采用服务端最新权威大纲！
            const mergedTurns = cacheStale || cacheShrank || cacheHasGap
              ? sessionResult.value.turns
              : mergeServerWithLocalOutline(
                  sessionResult.value.turns,
                  turnOutlineBySessionRef.current.get(loadId) ?? [],
                );
            turnOutlineRef.current = mergedTurns;
            setTurnOutline(mergedTurns);
            turnOutlineBySessionRef.current.set(loadId, mergedTurns);
          }

          // Live reconnect restores from the /live snapshot. Disk history can
          // race that snapshot (stale, missing in-flight turns) and must not
          // overlay a canvas that already has turns. If the live projection is
          // empty (view-only hub snapshot) the canvas is also empty — then disk
          // is the recovery path after switching away and back.
          // When serverActive === false, the turn finished while away; disk history
          // is authoritative and must replace any stale in-flight cache.
          const canvasEmpty =
            messagesRef.current.length === 0 &&
            !(currentCached && currentCached.length > 0);
          {
            const loaded = sessionMessagesToDisplay(
              sessionResult.value.messages,
              diskOffset,
              sessionResult.value.pinned_user_index,
              { running: serverActive === true },
            );
            const canUseCache =
              !cacheShrank && !cacheHasGap && !cacheStale && !cacheSeqBehind && !!currentCached && currentCached.length > 0;
            let displayMessages: Message[] = canUseCache ? currentCached! : loaded;

            if (canUseCache) {
              // A finished session's disk tail is authoritative. ALWAYS splice it
              // into the cached head when the server says idle: the cache may be
              // a complete answer from an earlier visit, yet miss every turn that
              // landed afterwards. Only checking `lastAssistantHasAnswer` left the
              // canvas stuck on the old 48-row window after a refresh.
              if (serverActive === false) {
                // 磁盘尾部是结算后的权威，但「磁盘还没落盘的最后一问」只存在于画布缓存里：
                // 刚发出的提问、刚被内核 fold 的中途转向（它要等回合终态才写进 display 日志）、
                // 以及新一轮 loop 已流出的正文。`mergeAuthoritativeTail` 在磁盘未覆盖尾部时
                // 不会先 splice，避免当前提问被窗口判断丢掉、只剩上一轮和孤立回答。
                const rescued = mergeAuthoritativeTail(loaded, currentCached!, diskOffset);
                displayMessages = rescued;
                messagesRef.current = displayMessages;
                messageCacheRef.current.set(loadId, displayMessages);
                setMessages({ type: 'replace', rows: displayMessages });
              } else {
                // 运行中：缓存可能停在很久以前（离开期间 B 又跑完了多个回合，其中还包括
                // 限流/断链等异常后的重试）。此时绝不能“只用缓存”—— 磁盘尾部必须增量并入，
                // 否则回来后只剩当前正在渲染的尾巴，中间整段消失。
                // 缓存里未落盘的当前回合行由 `mergeAuthoritativeTail` 以 overlay tail 保留。
                displayMessages = mergeAuthoritativeTail(loaded, currentCached!, diskOffset);
                messagesRef.current = displayMessages;
                messageCacheRef.current.set(loadId, displayMessages);
                setMessages({ type: 'replace', rows: displayMessages });
                // Never resurrect a stream cursor from L2: it belongs to a previous
                // page document and may sit ahead of a partially flushed canvas.
                // A new document must replay from the server and dedupe by identity;
                // restoring the cached high-water mark skipped already-rendered SSE
                // text on fast refreshes.
                if (atBottomRef.current) {
                  timelineFollow.jump();
                }
              }
              // 懒补页：首次加载只保证当前窗口与已展开内容的完整性，
              // 跨回合的因果缺口留给用户动作（点大纲 / 点向上展开）时补，
              // 避免弱网下首屏多拉几十 KB。
              canvasReadySessionIdRef.current = loadId;
              flushPreMountStreamBuffer(loadId);
              if (projectHash && findCausalGap(displayMessages, 24)) {
                scheduleGapBackfill(projectHash, loadId);
              }
            } else if (loaded.length > 0) {
              // 未采用本地缓存（冷启动或存在因果断层 `cacheHasGap` / `cacheShrank` / `cacheStale`）：
              // 画布已重置为磁盘快照 `loaded`，旧的流空间游标不再对应当前画布，必须清除，
              // 让 `/chat/watch` 用完整快照按画布身份幂等补齐在途工具，杜绝跳过在途 `ToolCallStarted` 产生无参空工具！
              clearStreamCursor(loadId);
              displayMessages = loaded;
              messagesRef.current = displayMessages;
              messageCacheRef.current.set(loadId, displayMessages);
              setMessages({ type: 'replace', rows: displayMessages });
              canvasReadySessionIdRef.current = loadId;
              flushPreMountStreamBuffer(loadId);
              pinTimelineToBottom();
            } else {
              clearStreamCursor(loadId);
              canvasReadySessionIdRef.current = loadId;
              flushPreMountStreamBuffer(loadId);
            }
            // Persist the FULL rendered window, never just the 48-row tail we
            // happened to fetch. Saving `loaded` here truncated the L2 cache on
            // every refresh; the next cold start then had only 48 rows left.
            if (displayMessages.length > 0) {
              pruneDeliveredQueuedCards(loadId, displayMessages);
              commitCanvasCache(projectHash, loadId, {
                messages: displayMessages,
                todos: sessionResult.value.todos,
                todoRevision: sessionResult.value.todos_revision ?? 0,
                turns: turnOutlineBySessionRef.current.get(loadId) ?? sessionResult.value.turns,
                tokenUsage: sessionResult.value.token_usage,
                historyOffset: effectiveOffset,
                historyTotal: totalOnDisk,
                revision: sessionResult.value.revision,
              });
            }
            // 服务端 board 是清单唯一真值：整表覆盖（空表 = 权威清空）。
            // 运行中也不能用“本地已有清单”挡住权威 —— 那正是断网重连后停在旧计划的原因。
            const turnStillRunning =
              serverActive === true ||
              localTurnSessionsRef.current.has(loadId) ||
              backgroundRunningSessionsRef.current.has(loadId);
            applyAuthoritativeTodos(
              loadId,
              sessionResult.value.todos,
              todoEpochAtLoad,
              sessionResult.value.todos_revision,
            );
            if (!turnStillRunning) {
              // 运行中决不能提前将 displayMessages 里的在途 todo 调用塞进 seedAppliedTodoIds，
              // 否则 /chat/watch 随后的实时重放会被当成已消费跳过，导致面板卡在初始 0/N 状态！
              seedAppliedTodoIds(loadId, todoCallIdsFromMessages(displayMessages));
            }
            applySessionTokens(loadId, displayMessages, sessionResult.value.token_usage ?? undefined);
            resumeClockFrom = [...displayMessages].reverse().find((m) => m.role === 'user')?.ts;
          }
          const origin = sessionResult.value.origin;
          protocolSessionRef.current = origin === 'protocol';
          const sessionMode = sessionResult.value.approval_mode;
          if (!modeState.pendingMode && globalModeRef.current) {
            // 全局开关开启：不读会话级记录，统一沿用当前全局模式。
            nativeModeRef.current = modeState.confirmedMode;
            setModeState(initModeState(modeState.confirmedMode));
          } else if (!modeState.pendingMode) {
            const targetMode = sessionMode
              ? sessionMode
              : origin === 'protocol'
              ? modeForSessionOrigin(origin)
              : modeCacheRef.current.get(loadId)
              ?? (activeSession?.id === loadId ? (activeSession.approval_mode as ApprovalMode) : null)
              ?? 'build';
            nativeModeRef.current = targetMode;
            setModeState(initModeState(targetMode));
            modeCacheRef.current.set(loadId, targetMode);
          }
        } else {
          // Draft / brand-new empty sessions 404 on disk until first persist —
          // that is not "continue a historical session".
          const isEmptyNew =
            activeSession?.id === loadId && (activeSession?.message_count ?? 0) === 0;
          loadedForRef.current = isEmptyNew ? loadId : null;
          if (isEmptyNew) {
            protocolSessionRef.current = false;
            getApprovalMode(loadId)
              .then((current) => {
                if (activeIdRef.current === loadId) {
                  modeCacheRef.current.set(loadId, current);
                  nativeModeRef.current = current;
                  setModeState(initModeState(current));
                }
              })
              .catch(() => {
                setModeState(initModeState(nativeModeRef.current));
              });
          }
          if (!isEmptyNew) {
            nextHint = t('chat.continueSession', { id: loadId.slice(0, 8) });
          }
          canvasReadySessionIdRef.current = loadId;
          flushPreMountStreamBuffer(loadId);
        }

        if (activeResult.status === 'fulfilled' || serverRuntimeRunning(hydratedRuntime)) {
          const active =
            (activeResult.status === 'fulfilled' && activeResult.value.includes(loadId)) ||
            serverRuntimeRunning(hydratedRuntime);
          const isLocalTurn = localTurnSessionsRef.current.has(loadId);
          const ownsTurn = thisTabOwnsTurn({ isLiveSession: false, isLocalTurn });
          transitionChatRecovery({
            type: 'active_check_succeeded',
            active: shouldLockSendAsDetached({ turnActive: active, thisTabOwnsTurn: ownsTurn }),
          });
          if (active) {
            backgroundRunningSessionsRef.current.add(loadId);
            onTurnRunningChange?.(loadId, true);
            liveIdleSnapshotRef.current = false;
            heldDuplicateUserRef.current = null;
            liveLifecycleRef.current = { running: true, terminalConsumed: false };
            const compactionResumeTs =
              hydratedRuntime?.phase === 'compacting' || hydratedRuntime?.status === 'compacting'
                ? hydratedRuntime.phase_started_at ??
                  hydratedRuntime.compaction_started_at ??
                  hydratedRuntime.started_at ??
                  undefined
                : undefined;
            const effectiveResumeTs =
              compactionResumeTs ??
              resumeClockFrom ??
              [...messagesRef.current].reverse().find((m) => m.role === 'user')?.ts;
            setBusyAndClock(true, effectiveResumeTs);
            busyRef.current = true;
            requestIdRef.current = loadId;
            if (effectiveResumeTs) {
              adoptTurnUserTs(effectiveResumeTs, true);
            }
              // 彻底贯彻后台推送机制：只要后台处于活跃中，连入后台推送流（/chat/watch），
              // 让后台把离开期间积累的 Replay 快照和后续实时事件（工具调用、thinking等）源源不断推给前台。
              // 仅当当前页面持有在途 POST /chat 或已有存活的 watcher 时跳过重复建连。
              const activeWatcher = sessionWatchersRef.current.get(loadId);
              const hasLocalActiveStream =
                abortRef.current !== null ||
                activeStreamRequestIdRef.current !== null ||
                (!!activeWatcher && !activeWatcher.signal.aborted);
              if (!hasLocalActiveStream) {
                startDetachedHistoryPoll(projectHash, loadId, loadGeneration, {
                  localReattach: ownsTurn,
                });
              }
          } else if (!active) {
            // 关键防线：只有当前页面真实持有正在发送的 HTTP 传输流时才保持 busy；
            // 若服务端已明确返回会话空闲（!active），绝不能因残留的状态集合盲目死锁在 busy 停止态！
            const isLocalActiveInFlight =
              (abortRef.current !== null && !abortRef.current.signal.aborted) ||
              (activeStreamRequestIdRef.current !== null && activeIdRef.current === loadId);
            if (isLocalActiveInFlight) {
              setBusyAndClock(true);
              busyRef.current = true;
            } else {
              localTurnSessionsRef.current.delete(loadId);
              backgroundRunningSessionsRef.current.delete(loadId);
              onTurnRunningChange?.(loadId, false);
              liveLifecycleRef.current = createLiveLifecycleState();
              setBusyAndClock(false);
              busyRef.current = false;
              if (requestIdRef.current === loadId) requestIdRef.current = null;
              onTurnDone?.();
              // 服务端已完结：拉取最新落盘记录，消除断连重入时最后一条正文未显示问题
              void syncSessionCacheFromDisk(projectHash, loadId);
            }
          } else if (requestIdRef.current === loadId) {
            requestIdRef.current = null;
          }
        } else {
          // `/chat` has no stream reattach endpoint. The registry is authoritative
          // when available; if discovery fails, keep the canonical stop alias and
          // fail closed instead of allowing a possibly concurrent send.
          requestIdRef.current = loadId;
          transitionChatRecovery({ type: 'active_check_failed' });
          setBusyAndClock(false);
          nextHint = t('chat.activeCheckFailed', { error: String(activeResult.reason) });
          // Allow a later metadata/session refresh to retry discovery.
          loadedForRef.current = null;
        }

        setHistoryHint(nextHint);
        setLoading(false);
        // 空闲态（非 active）：维持待机 watch，收到对端 turn 推送即升级。
        // 关键防线：若本页面正在执行本地发送主流（abortRef/activeStream 存在，或 localTurnSessions 包含本会话），
        // 坚决杜绝创建任何待机 watch 连接，彻底斩断双流并行与撕裂隐患！
        if (
          activeResult.status === 'fulfilled' &&
          !activeResult.value.includes(loadId) &&
          abortRef.current === null &&
          activeStreamRequestIdRef.current === null &&
          !localActiveStreamsBySessionRef.current.has(loadId) &&
          !localTurnSessionsRef.current.has(loadId)
        ) {
          startIdleWatch(projectHash, loadId, loadGeneration, { replayIfLive: true });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, activeSession?.project_hash]);

  // History responses may arrive after the user starts reading: only the
  // session reset (above), or an explicit jump/send, may re-enable following.
  const pinTimelineToBottom = () => {
    initialPinPendingRef.current = true;
    timelineFollow.changed();
  };
  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') =>
    timelineFollow.jump({ smooth: behavior === 'smooth' });
  useEffect(() => {
    timelineFollow.changed();
    // Markdown/tool cards can grow after Preact's commit without a second
    // ResizeObserver tick (notably remote cold starts). Settle ONLY the initial
    // tail; never re-pin 350ms after an older-history prepend, which would
    // destroy the reader's top anchor.
    if (!initialPinPendingRef.current) return;
    const settle = window.setTimeout(() => {
      if (!initialPinPendingRef.current) return;
      initialPinPendingRef.current = false;
      timelineFollow.changed();
    }, 350);
    return () => window.clearTimeout(settle);
  }, [messages, tokens, timelineFollow]);

  // 消息变化且当前无精确 tokens（如切会话、加载历史）时，根据消息或内存快照恢复 tokens。
  useEffect(() => {
    const sid = activeIdRef.current;
    if (!sid || tokens || messages.length === 0) return;
    applySessionTokens(sid, messages);
  }, [messages, tokens, sessionId]);

  // 同 session 内 tokens 变化时写入内存快照（切换回来在 getSession 返回前也能恢复）。
  useEffect(() => {
    const sid = activeIdRef.current;
    if (!sid || !tokens || sessionId !== sid) return;
    if (sessionGenerationRef.current !== tokenSaveGenerationRef.current) return;
    const prev = tokenUsageCacheRef.current.get(sid);
    if (!tokensAuthoritativeRef.current && !sessionTokensRunning(sid)) {
      // Idle non-authoritative deltas must not replace a persisted authoritative snapshot.
      if (prev?.authoritative) return;
    }
    saveTokenSnapshot(sid, tokensAuthoritativeRef.current);
  }, [tokens, sessionId]);

  // ── 空闲智能预热器 (Idle Prefetcher)：当前无会话运行/打字时，静默预加载前 3~5 个高频会话 ──
  useEffect(() => {
    const curHash = activeSession?.project_hash || projectHashBySessionRef.current.get(sessionId || '') || viewedProjectHashRef.current;
    if (!curHash || loading || busy) return;
    let timer: number | null = null;
    let cancelled = false;

    timer = window.setTimeout(async () => {
      if (cancelled || busy || !curHash) return;
      try {
        const projectSessions = await listProjectSessions(curHash);
        const candidates = (projectSessions || []).slice(0, 5);
        for (const cand of candidates) {
          if (cancelled || busy) break;
          if (cand.id === sessionId) continue;
          if (messageCacheRef.current.has(cand.id)) continue;
          const existing = await getSessionCache(curHash, cand.id);
          if (existing) continue;

          // 随机 5~10 秒延迟加载一个，防网络与 I/O 拥塞
          const delay = 5000 + Math.random() * 5000;
          await new Promise((r) => setTimeout(r, delay));
          if (cancelled || busy) break;

          const res = await pullSession({ projectHash: curHash, sessionId: cand.id, mode: 'snapshot', limit: HISTORY_PAGE });
          if (res && Array.isArray(res.messages)) {
            const loaded = sessionMessagesToDisplay(res.messages, res.offset ?? 0, res.pinned_user_index);
            messageCacheRef.current.set(cand.id, loaded);
            commitCanvasCache(curHash, cand.id, {
              messages: loaded,
              todos: res.todos,
              turns: res.turns,
              tokenUsage: res.token_usage,
              revision: res.revision,
            });
          }
        }
      } catch {}
    }, 4000);

    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activeSession?.project_hash, sessionId, loading, busy]);

  // Ctrl + F5 强制清理所有本地会话缓存
  useEffect(() => {
    const onHardReload = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'F5') {
        void clearAllSessionCache();
      }
    };
    window.addEventListener('keydown', onHardReload);
    return () => window.removeEventListener('keydown', onHardReload);
  }, []);

  // 页面进入隐藏（切后台/挂起）的时刻；仅用于判定失焦重进是否需要重连 watch。
  const pageHiddenSinceRef = useRef<number | null>(null);
  /**
   * 离开前台那一刻的会话上下文（会话 id + 当时的游标）。
   *
   * 回前台时用它确认“还是同一会话”，然后直接把画布的因果缺口补干净：
   * 用户离开期间服务端可能跑完多个回合、窗口已经往后滑，只靠缓存 + 最新窗口
   * 会留下“离开前那一段 → 最新一轮”的断层。补多了没关系（合并按身份去重 / 按位次
   * 插入，自然折叠），补少了才是可见的丢内容。
   */
  const awayPageRef = useRef<{
    sid: string;
    offset: number;
    total: number;
    headSeq?: number;
  } | null>(null);
  // A separate flag survives the focus-before-visibility ordering on mobile:
  // idle sessions still get one disk catch-up after ANY hidden period, even if
  // the hidden timestamp was never observed.
  const pageWasHiddenRef = useRef(false);
  // 断网期间服务端可能已经追加了新消息；恢复联网后即使本地会话是空闲态，
  // 也必须做一次磁盘权威尾部对账，不能只依赖 active/watch 分支。
  const networkOfflineRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const initialSid = activeIdRef.current;
    if (!modeCacheRef.current.has(initialSid || '')) {
      getApprovalModeState(initialSid || undefined)
        .then((current) => {
          if (cancelled) return;
          setGlobalModeEnabled(current.global);
          if (protocolSessionRef.current) return;
          if (initialSid && modeCacheRef.current.has(initialSid)) return;
          nativeModeRef.current = current.mode;
          setModeState(initModeState(current.mode));
          if (initialSid) modeCacheRef.current.set(initialSid, current.mode);
        })
        .catch(() => {});
    } else {
      // 缓存命中也要对齐全局开关（例如刷新前已开启全局）。
      getApprovalModeState(initialSid || undefined)
        .then((current) => {
          if (!cancelled) setGlobalModeEnabled(current.global);
        })
        .catch(() => {});
    }

    const applyIncomingMode = (nextMode: ApprovalMode) => {
      if (cancelled || protocolSessionRef.current) return;
      setModeState((cur) => {
        if (cur.pendingMode || cur.confirmedMode === nextMode) return cur;
        nativeModeRef.current = nextMode;
        if (nextMode === 'bypass') {
          onPermissionResolved?.(null);
        }
        return initModeState(nextMode);
      });
    };

    // 远程模式变更：无论当前视口在哪，都先落地到会话级缓存（内存 + IndexedDB），
    // 这样切回该会话时立即命中，不会退回旧值。广播是低频事件，写一次可忽略不计。
    const persistRemoteMode = (sid: string | null | undefined, mode: ApprovalMode) => {
      if (!sid) return;
      modeCacheRef.current.set(sid, mode);
      const hash = projectHashBySessionRef.current.get(sid) || viewedProjectHashRef.current;
      if (hash) updateSessionCacheMeta(hash, sid, { approvalMode: mode });
    };

    const handleCustomEvent = (e: Event) => {
      const detail = (e as CustomEvent<ApprovalMode | { mode: ApprovalMode; session_id?: string }>).detail;
      const mode = typeof detail === 'string' ? detail : detail?.mode;
      const targetSessionId = typeof detail === 'object' ? detail?.session_id : undefined;
      if (targetSessionId && mode) persistRemoteMode(targetSessionId, mode);
      if (!targetSessionId || targetSessionId === activeIdRef.current) {
        if (mode) applyIncomingMode(mode);
      }
    };

    const handleRemoteSessionMode = (e: Event) => {
      const detail = (e as CustomEvent<{ session_id?: string | null; mode: ApprovalMode }>).detail;
      if (!detail || !detail.mode) return;
      persistRemoteMode(detail.session_id, detail.mode);
      if (!detail.session_id || detail.session_id === activeIdRef.current) {
        applyIncomingMode(detail.mode);
      }
    };

    // 全局开关播：开启时所有会话统一跟随广播模式；关闭时把当前会话恢复成
    // 自己的模式（向服务端定向拉一次，成本极小，不会轮询）。
    const handleGlobalModeSwitch = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean; mode: ApprovalMode }>).detail;
      if (!detail) return;
      setGlobalModeEnabled(!!detail.enabled);
      if (detail.enabled) {
        if (detail.mode) applyIncomingMode(detail.mode);
        return;
      }
      const sid = activeIdRef.current;
      if (!sid) return;
      // 恢复本会话自己的模式。优先用本地已知值（0 请求），只有在缓存与会话
      // 元数据都缺失时才拉一次，避免「关闭全局」引发多端请求风暴。
      applyOwnSessionModeRef.current(sid);
    };

    window.addEventListener('jeikcode:approval_mode_changed', handleCustomEvent);
    window.addEventListener('jeikcode:session_mode_changed', handleRemoteSessionMode);
    window.addEventListener('jeikcode:mode_global_changed', handleGlobalModeSwitch);

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('jeikcode_approval_mode');
        bc.onmessage = (ev) => {
          if (ev.data?.type === 'mode' && ev.data.mode) {
            if (typeof ev.data.global === 'boolean') {
              setGlobalModeEnabled(ev.data.global);
            }
            persistRemoteMode(ev.data.session_id, ev.data.mode);
            if (!ev.data.session_id || ev.data.session_id === activeIdRef.current) {
              applyIncomingMode(ev.data.mode);
            }
          }
        };
      }
    } catch {
      // ignore
    }

    const refreshOnFocus = () => {
      if (document.visibilityState !== 'visible') {
        // Record the FIRST hidden instant. Some mobile webviews fire `focus`
        // before `visibilitychange` on return; overwriting this timestamp here
        // made a 10-minute background look like a 0ms blur, so an idle session
        // skipped its disk catch-up while a running session still reattached.
        if (pageHiddenSinceRef.current == null) {
          pageHiddenSinceRef.current = Date.now();
          // 记下离开前的页上下文：回来时按它补历史（补多无妨）。
          const awaySid = activeIdRef.current;
          awayPageRef.current = awaySid
            ? {
                sid: awaySid,
                offset: historyOffsetRef.current,
                total: historyTotalRef.current,
                headSeq: messagesRef.current[0]?.seq,
              }
            : null;
        }
        pageWasHiddenRef.current = true;
        return;
      }
      const wasHidden = pageWasHiddenRef.current;
      pageWasHiddenRef.current = false;
      const hiddenForLong =
        pageHiddenSinceRef.current != null &&
        Date.now() - pageHiddenSinceRef.current >= WATCH_REATTACH_AFTER_HIDDEN_MS;
      pageHiddenSinceRef.current = null;
      // `online` may fire without a matching `offline` in some mobile webviews.
      // Keep the flag until a visible, actually-online wakeup consumes it.
      const recoveredFromOffline =
        networkOfflineRef.current &&
        (typeof navigator === 'undefined' || navigator.onLine !== false);
      if (recoveredFromOffline) networkOfflineRef.current = false;
      {
        getApprovalModeState(activeIdRef.current ?? undefined)
          .then((current) => {
            if (cancelled) return;
            setGlobalModeEnabled(current.global);
            applyIncomingMode(current.mode);
          })
          .catch(() => {});

        const sid = activeIdRef.current;
        const projectHash =
          (sid ? projectHashBySessionRef.current.get(sid) : undefined) ||
          viewedProjectHashRef.current ||
          activeSession?.project_hash;
        if (sid && projectHash) {
          // 手机/移动端切回前台：静默检测后端会话是否活跃，无缝自动恢复断开的 watch 连接
          getActiveChatSessions()
            .then((activeSessions) => {
              if (cancelled || activeIdRef.current !== sid) return;
              const isRunning = Array.isArray(activeSessions) && activeSessions.includes(sid);
              if (isRunning) {
                // 关键防线：本会话的 watch 通道仍然健在时绝不再订阅一次。
                // 关键根因修复：移动端或熄屏切后台 (wasHidden / recoveredFromOffline) 时，
                // 底层 TCP/SSE 极大概率已被系统静默关闭，但 AbortController 绝不会自动变成 aborted。
                // 若此时盲目依靠 watcherAlive 直接 return，就会陷入“左上角转圈、右下角停止态、
                // 画面永久卡住不拉最新”的僵死连接灾难！
                // 只要页面经历过隐藏/离线，旧连接必定不可信，必须强制重新水合最新快照并订阅！
                const watcher = sessionWatchersRef.current.get(sid);
                const watcherAlive = !!watcher && !watcher.signal.aborted;
                const connectionDoubtful = wasHidden || recoveredFromOffline || hiddenForLong;
                if (watcherAlive && !connectionDoubtful) return;
                if (
                  connectionDoubtful ||
                  (abortRef.current === null &&
                    activeStreamRequestIdRef.current === null &&
                    !localTurnSessionsRef.current.has(sid))
                ) {
                  startDetachedHistoryPoll(projectHash, sid, sessionGenerationRef.current);
                }
              } else {
                // 后台切回时服务端已空闲：本端所有“运行中”都只是断网/挂起期间的残影。
                // 必须连「观察流仍挂着」「恢复态仍允许停止」一起收尾 —— 否则停止按钮与
                // 僵尸工具行会一直保留，直到另一台设备发下一条消息把状态冲开。
                const attachedWatcher = sessionWatchersRef.current.get(sid);
                const staleLiveState =
                  busyRef.current ||
                  localTurnSessionsRef.current.has(sid) ||
                  backgroundRunningSessionsRef.current.has(sid) ||
                  liveLifecycleRef.current.running ||
                  chatRecoveryPolicy(chatRecoveryRef.current).allowStop ||
                  (!!attachedWatcher && !attachedWatcher.signal.aborted);
                if (staleLiveState) {
                  const away = awayPageRef.current;
                  awayPageRef.current = null;
                  settleSessionRunningState(sid);
                  transitionChatRecovery({ type: 'authoritative_terminal' });
                  // 停止通道已经不可达；直接向服务端同步最新权威快照，拉回最新轮次并对齐画布！
                  void syncSessionCacheFromDisk(projectHash, sid);
                } else if (hiddenForLong || wasHidden || recoveredFromOffline) {
                  // 单通道唤醒对账：优先尝试 after_seq 增量（无新增时 0 渲染），
                  // 游标或版本不满足时自动降级为一次权威磁盘快照（内含大纲与 token），
                  // 避免 snapshot + delta + outline 三路并发争抢写画布。
                  void restoreAwayPage(projectHash, sid).catch(() => {});
                } else {
                  // 普通窗口聚焦：执行一次权威快照同步，确保离开期间服务端跑完的新轮次立即上屏！
                  void syncSessionCacheFromDisk(projectHash, sid);
                }
                if (staleLiveState || hiddenForLong) {
                  // 挂起/断网后待机 watch 多半已被系统戒断：强制重挂，
                  // 否则对端新回合永远推不过来（不拉新量）。
                  stopIdleWatch();
                  startIdleWatch(projectHash, sid, sessionGenerationRef.current, { replayIfLive: true });
                } else if (recoveredFromOffline) {
                  // Same recovery must also re-arm the standby watch if the
                  // offline period silently killed it; startIdleWatch no-ops
                  // when a live/idle watcher is already healthy.
                  startIdleWatch(projectHash, sid, sessionGenerationRef.current, { replayIfLive: true });
                }
              }
            })
            .catch(() => {
              // The active-session probe can fail on a flaky reconnect; the
              // offline/hidden catch-up must still run so an idle tab gets its tail.
              if (recoveredFromOffline || hiddenForLong || wasHidden) {
                void syncSessionCacheFromDisk(projectHash, sid);
              }
            });
        }
      }
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);
    // 应用内软刷新：重新对账当前会话的磁盘尾部/大纲，但绝不重建组件树。
    // 数据刷新完成后把焦点交还输入框（刷新按钮是用户主动点击，不抢其它输入）。
    const unsubscribeSoftRefresh = onSoftRefresh(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      refreshOnFocus();
      const sid = activeIdRef.current;
      const hash =
        (sid ? projectHashBySessionRef.current.get(sid) : undefined) ||
        viewedProjectHashRef.current;
      if (sid && hash) void refreshOutline(hash, sid);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        if (document.querySelector('.modal-overlay, .confirm-modal-overlay')) return;
        ta.focus({ preventScroll: true });
      });
    });
    // 手机网络恢复不一定伴随 focus/visibility（熄屏直起、地铁出隧道）：
    // 必须在 online 时走同一条唤醒自愈，否则断网期间的半开连接会让会话永远停在运行中。
    const onOffline = () => {
      networkOfflineRef.current = true;
    };
    const onOnline = () => {
      // Set explicitly too: some embedded webviews restore the network without
      // emitting `offline`, and an idle session still needs one disk catch-up.
      // Keep it pending when hidden; visibilitychange will consume it later.
      networkOfflineRef.current = true;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      refreshOnFocus();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      window.removeEventListener('jeikcode:approval_mode_changed', handleCustomEvent);
      window.removeEventListener('jeikcode:session_mode_changed', handleRemoteSessionMode);
      window.removeEventListener('jeikcode:mode_global_changed', handleGlobalModeSwitch);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      unsubscribeSoftRefresh();
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      try {
        bc?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  // 斜杠菜单：点击外部关闭
  useEffect(() => {
    if (!slashOpen) return;
    const h = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) {
        setSlashOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [slashOpen]);

  // @ 菜单：点击外部关闭
  useEffect(() => {
    if (!atOpen) return;
    const h = (e: MouseEvent) => {
      if (atRef.current && !atRef.current.contains(e.target as Node)) {
        setAtOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [atOpen]);

  // @ 文件菜单：把 @ 后文本拆成「目录段 + 过滤词」，以支持进入子目录 / 返回上级。
  // 例如 "examples/fo" → 列 cwd/examples 的内容，并按前缀 "fo" 过滤。
  const { scopeDir: atDirPart, filter: atFilter } = splitAtToken(atQuery);
  const atTargetDir =
    atDirPart === ''
      ? effectiveWorkingDir
      : atDirPart.startsWith('/') || atDirPart.startsWith('~')
        ? atDirPart
        : effectiveWorkingDir.replace(/\/+$/, '') + '/' + atDirPart;

  // 目录变化（cwd 切换 / 进入子目录）时重新拉取；仅过滤词变化不触发。后端会 canonicalize `..`。
  useEffect(() => {
    if (!atOpen) return;
    let cancelled = false;
    setAtLoading(true);
    listDir(atTargetDir)
      .then((r) => {
        if (cancelled) return;
        const items: { name: string; is_dir: boolean }[] = [];
        for (const d of r.dirs) items.push({ name: d, is_dir: true });
        if (r.files) for (const f of r.files) items.push({ name: f, is_dir: false });
        items.sort((a, b) => a.name.localeCompare(b.name));
        setAtItems(items);
      })
      .catch(() => { if (!cancelled) setAtItems([]); })
      .finally(() => { if (!cancelled) setAtLoading(false); });
    return () => { cancelled = true; };
  }, [atOpen, atTargetDir]);

  // 菜单可见行：进入子目录后首行为「..」返回上级（仅无过滤词时展示）；其余按过滤词前缀匹配。
  const atRows: { name: string; is_dir: boolean; up?: boolean }[] = [];
  if (atDirPart && atFilter === '') atRows.push({ name: '..', is_dir: true, up: true });
  for (const it of atItems) {
    if (it.name.toLowerCase().startsWith(atFilter.toLowerCase())) atRows.push(it);
  }

  useEffect(() => {
    if (!atOpen) return;
    requestAnimationFrame(() => {
      const container = atRef.current;
      const active = container?.querySelector<HTMLButtonElement>('.at-row.active');
      if (container && active) ensureActiveDescendantVisible(container, active);
    });
  }, [atIndex, atOpen, atRows.length]);

  // ── 遗留的 /live 实时流逻辑已彻底退役，统一收敛至 Single Event Bus (/chat/watch) ──


  // 同步模式已移除。画布只走 /chat + /chat/watch 这一条链路。
  // 旧书签里的 ?sync=1 不再打开第二条实时流，挂载时清掉。
  useEffect(() => {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('sync')) return;
      url.searchParams.delete('sync');
      history.replaceState(history.state, '', url.toString());
    } catch { /* URL/history 不可用时忽略 */ }
  }, []);

  // ── Shared history → display conversion (reused by session load AND live snapshot) ──
  function sessionMessagesToDisplay(
    msgs: SessionMessage[],
    sourceOffset = 0,
    pinnedUserIndex?: number,
    opts?: { running?: boolean },
  ): Message[] {
    // Wire-boundary guard: a failed/partial pull must never reach `.entries()`
    // and take down the whole chat render.
    if (!Array.isArray(msgs)) return [];
    const loaded: Message[] = [];
    // Running session-level todo list across turns.
    // Baseline is the last full plan; subsequent actions fold over it.
    let sessionTodoList: TodoItem[] = [];
    // 未完成清单跨大轮保留。只有全部完成时才贴到当前最后一条助手消息，然后清空，下一轮从空清单开始。
    const closeCompletedTurnTodos = () => {
      if (opts?.running) return;
      const list = sessionTodoList;
      const isAllDone = list.length > 0 && list.every((t) => t.status === 'completed');
      if (!isAllDone) return;
      sessionTodoList = [];
      for (let i = loaded.length - 1; i >= 0; i--) {
        if (loaded[i]!.role !== 'assistant') continue;
        loaded[i] = {
          ...loaded[i]!,
          parts: withTrailingTodoList(loaded[i]!.parts, list),
        };
        break;
      }
    };
    const pinned = typeof pinnedUserIndex === 'number';
    for (const [rawIndex, msg] of msgs.entries()) {
      const sourceIndex = pinned && rawIndex === 0
        ? pinnedUserIndex
        : sourceOffset + (pinned ? rawIndex - 1 : rawIndex);
      const displayOrigin = msg.internal_origin ?? msg.internalOrigin;
      const readOnly = resolveEditable(msg) === false ? true : undefined;
      if (msg.role === 'user') {
        const internal = resolveInternal(msg);
        if (!internal) closeCompletedTurnTodos();
        if (internal) continue;
        const rawContent = msg.content ?? '';
        const isSteer = isSteerUserMessage({ role: 'user', content: rawContent });
        // Server text wins. The legacy adapter is the only place that parses
        // protocol strings, and only when `display_text` is absent.
        const visible = resolveUserDisplayText(msg);
        if (!visible && !(msg.images && msg.images.length)) continue;
        // 身份优先：同 id 才是同一条提问；位置不再参与判重。
        const lastLoaded = loaded[loaded.length - 1];
        const isDuplicateUser =
          lastLoaded &&
          lastLoaded.role === 'user' &&
          !!lastLoaded.id &&
          !!msg.id &&
          lastLoaded.id === msg.id;
        if (isDuplicateUser) {
          continue;
        }
        loaded.push({
          role: 'user',
          parts: [{ kind: 'text', text: visible }],
          images: msg.images && msg.images.length ? msg.images : undefined,
          ts: msg.created_at,
          isSteer: isSteer ? true : undefined,
          sourceIndex,
          // P0: the server's display-order seq is the ONLY order key. `sourceIndex`
          // stays as a pagination cursor for older daemons that do not send seq.
          seq: msg.seq,
          turnId: msg.turn_id,
          id: msg.id,
          clientInputId: msg.client_input_id,
          readOnly,
          pendingInput: displayOrigin === 'pending_input' || undefined,
        });
      } else if (msg.role === 'assistant') {
        if (isInternalHistoryAssistantMessage(msg)) continue;
        const origin = displayOrigin;
        if (origin === 'turn_diagnostic') {
          const text = (msg.content ?? '').trim();
          // 旧版本把重试/存活提示写进 display.jsonl；它们不是转录记录，
          // 刷新后重新投影会永久粘在最新回答下面。压缩边界等真正的持久
          // 通知不匹配这些重试文案，必须保留。
          if (text && !isTransientAdvisoryText(text)) {
            // 诊断/压缩标记是只读通知，不是模型回答：必须落成 system 行。
            // 旧实现把它伪装成 assistant 行，刷新后看起来就像回答正文的一部分。
            loaded.push({
              role: 'system',
              parts: [{ kind: 'notice', text }],
              ts: msg.created_at,
              id: msg.id,
              sourceIndex,
              seq: msg.seq,
            });
          }
          continue;
        }
        // Text comes first (the LLM speaks, then calls tools), so the part
        // order for a persisted round is [reasoning?, text, tool, tool, …].
        // 段编号必须与线协议一致（`{轮id}:{段序}:{类型}`，段序「类型变化才 +1」）：
        // 有思考时正文是 2，没思考时正文是 1。补上编号后，回放帧能按 id 精确对号
        // 入座（而不需要拿文本拼接去猜），且压缩/重写历史也不会让路由失效。
        const parts: MsgPart[] = [];
        if (msg.reasoning) {
          parts.push({
            kind: 'reasoning',
            text: msg.reasoning,
            ...(msg.id ? { id: `${msg.id}:1:reasoning` } : {}),
          });
        }
        if (msg.content) {
          parts.push({
            kind: 'text',
            text: msg.content,
            ...(msg.id ? { id: `${msg.id}:${msg.reasoning ? 2 : 1}:text` } : {}),
          });
        }
        for (const tc of msg.tool_calls ?? []) {
          const rawArgs = tc.arguments || tc.display || '';
          // Rebuild parallel subagent panel for `task` (same as live tool_start).
          const subtasks =
            tc.name === 'task' ? subtasksFromTaskArgs(rawArgs) ?? undefined : undefined;
          parts.push({
            kind: 'tool',
            tool: {
              id: tc.id,
              name: tc.name,
              // Keep raw JSON for expand/debug, but UI prefers subtasks panel.
              args: rawArgs,
              // A cold-start slice can contain a tool call whose result is not in
              // this page yet. On an explicitly running snapshot, start pending;
              // historical slices keep the legacy done default so old completed
              // turns are not downgraded to Incomplete. A real tool_result below
              // still overrides both states.
              status: opts?.running ? 'pending' : 'done',
              ...(subtasks ? { subtasks } : {}),
            },
          });
          if (isTodoTool(tc.name)) {
            sessionTodoList = foldTodoToolCall(sessionTodoList, tc.name, rawArgs) ?? [];
          }
        }
        loaded.push({
          role: 'assistant',
          parts,
          ts: msg.created_at,
          elapsedMs: msg.elapsed_ms,
          sourceIndex,
          seq: msg.seq,
          turnId: msg.turn_id,
          id: msg.id,
          readOnly,
        });
      } else if (msg.role === 'tool' && msg.tool_result) {
        const result = msg.tool_result;
        // Prefer full `content` over truncated `summary` so history reload still
        // shows multi-line SQL/table output (API always sends both).
        const output =
          (msg.content && msg.content.length > 0 ? msg.content : null) ??
          result.summary ??
          '';
        let todoResult = false;
        outer: for (let i = loaded.length - 1; i >= 0; i--) {
          const m = loaded[i];
          if (m.role !== 'assistant') continue;
          for (const p of m.parts) {
            if (p.kind === 'tool' && p.tool.id === result.call_id) {
              p.tool.output = output;
              p.tool.status = toolResultStatus(result.success, output, p.tool.name);
              todoResult = isTodoTool(p.tool.name);
              // Same settle rule as the live `tool_result` path (history + live must
              // share one reconciliation rule, or the two views disagree).
              const settledSubtasks = settleSubtasksFromOutput(p.tool, output);
              if (settledSubtasks) p.tool.subtasks = settledSubtasks.subtasks;
              break outer;
            }
          }
        }
        if (todoResult) {
          const authoritative = parseTodosFromOutput(output);
          if (authoritative && authoritative.length > 0) {
            sessionTodoList = authoritative;
          }
        }
      }
      // system messages: skip
    }
    closeCompletedTurnTodos();
    return loaded;
  }

  /** 往前补页时，首屏钉住的那条提问已经在画布上，按 id / 绝对下标严格去重并按时序升序对齐。 */
  function prependOlderMessages(prev: Message[], older: Message[]): Message[] {
    return mergeOlderMessages(prev, older);
  }

  // ── Live SSE adapter: map LiveWireEvent → SSEEvent (for variants that overlap) ──

  function flushHeldDuplicateUser(text: string) {
    const userText = visibleUserText(text) || text;
    const isSteer = isSteerUserMessage({ role: 'user', content: text });
    const now = Date.now();
    rememberTurnOutline(userText, nextTurnNavIndex(), nextOutlineOrdinal());
    setMessages({
      type: 'user',
      text: userText,
      ts: now,
      row: { ts: now, ...(isSteer ? { isSteer: true } : {}) },
    });
  }

  // ── Live event handler ──

  // ── Sync mode removed as obsolete / redundant ──

  // Identity stamping (`withAssistantIdentity`) lives in the projection module so the
  // background-cache path (`applyEventToSessionCache`) and this live path share one contract.

  function needsReplayDedup(
    frame: SSEEvent & { seq?: number; part_rev?: number; replay?: boolean },
    attachNeedsDedup: boolean,
  ): boolean {
    return needsReplayDedupFromFrame(frame, attachNeedsDedup);
  }

  function flushPendingText() {
    if (textRafRef.current != null) {
      window.cancelAnimationFrame(textRafRef.current);
      textRafRef.current = null;
    }
    const textSid = pendingTextSessionIdRef.current;
    const items = pendingTextRef.current;
    if (items.length === 0) return;
    pendingTextRef.current = [];
    pendingTextSessionIdRef.current = null;
    // 会话防串染守卫：若文字缓冲所属会话不属于当前可见画布，立即重定向到后台会话缓存，绝不污染新会话画布！
    if (textSid && activeIdRef.current !== textSid) {
      for (const item of items) {
        applyEventToSessionCache(textSid, {
          type: 'text',
          content: item.content,
          message_id: item.messageId,
          part_id: item.partId,
          part_rev: item.partRev,
        } as any);
      }
      return;
    }
    setMessages({ type: 'text_batch', items });
  }

  function appendToLastAssistant(
    content: string,
    opts?: { skipReplayDedup?: boolean; requireReplayDedup?: boolean },
    ids?: { messageId?: string; partId?: string; partRev?: number; seq?: number },
    targetSid?: string,
  ) {
    const replay = opts?.requireReplayDedup === true && opts?.skipReplayDedup !== true;
    if (replay) {
      // Replay frames must keep their wire order: flush live deltas first.
      flushPendingText();
      if (targetSid && activeIdRef.current !== targetSid) {
        applyEventToSessionCache(targetSid, {
          type: 'text',
          content,
          message_id: ids?.messageId,
          part_id: ids?.partId,
          part_rev: ids?.partRev,
        } as any);
        return;
      }
      setMessages({
        type: 'text',
        content,
        replay: true,
        messageId: ids?.messageId,
        partId: ids?.partId,
        partRev: ids?.partRev,
      });
      return;
    }
    pendingTextSessionIdRef.current = targetSid ?? activeIdRef.current;
    pendingTextRef.current.push({
      content,
      messageId: ids?.messageId,
      partId: ids?.partId,
      partRev: ids?.partRev,
    });
    if (textRafRef.current == null) {
      textRafRef.current = window.requestAnimationFrame(() => {
        textRafRef.current = null;
        flushPendingText();
      });
    }
  }

  // 命令输出以独立 system 消息追加进转录，与 assistant 消息分离。
  // 若流式 assistant 回复正在进行（busy），把 notice 插到它之前，
  // 确保 appendToLastAssistant 始终以真正的 assistant 气泡为最后一条。
  //
  // 插入位置不是永久身份：磁盘对账会用权威切片重建画布，没有身份的通知行
  // 会被当成“未落盘直播尾巴”拖到会话末尾（压缩标记逐轮跑到尾部就是这个）。
  // 通知是本地瞬态记录，但必须带一个落在锚点之后的 seq：既不需要 anchorId，
  // 也能在权威切片合并时留在原来的轮次。
  function noticeSeqFrom(msgs: Message[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const seq = msgs[i]!.seq;
      if (typeof seq === 'number') return seq + 0.5;
    }
    return msgs.length;
  }

  /** 同一次压缩的完成提示可能同时来自服务端 warning 与本地兜底：
   *  只检查最近的 turn 边界（遇到 user 行即停），跨 turn 的真实历史标记
   *  不参与去重，否则多次压缩会被吞成一条。 */
  function hasRecentCompactionNotice(msgs: Message[]): boolean {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === 'user') return false;
      if (
        Array.isArray(m.parts) &&
        m.parts.some((p) => p.kind === 'notice' && isCompactionDoneNotice(p.text))
      ) {
        return true;
      }
    }
    return false;
  }

  function pushCommandNotice(text: string, opts?: { forceTail?: boolean }) {
    const last = messagesRef.current[messagesRef.current.length - 1];
    setMessages({
      type: 'system',
      text,
      id: 'notice-' + randomUUID(),
      // 压缩标记是轮次边界事实，必须落在尾部，不能因为 compact 期间 busy=true
      // 被当成“流式回答前的提示”插到回答上方。
      beforeLastAssistant:
        !opts?.forceTail && !!last && last.role === 'assistant' && busyRef.current,
    });
    const currentSid = sessionId ?? activeIdRef.current;
    if (currentSid) {
      messageCacheRef.current.set(currentSid, messagesRef.current);
      scheduleCanvasCacheSave();
    }
  }

  /** sync 模式：压缩已提交（或已失败），撤回临时的“正在压缩…”占位行。 */
  function retireCompactPendingNotice() {
    const note = compactPendingNoteRef.current;
    if (!note) return;
    compactPendingNoteRef.current = null;
    setMessages({ type: 'removeWhere', predicate: (message) => message === note });
  }

  const slashCommandMap = useMemo(() => buildCommandMap(FRONTEND_COMMANDS), []);
  // Right-rail derivation only changes when the set of user rows changes, not
  // on every streamed text/reasoning token. The signature is cheap; the full
  // outline rebuild (label stripping + maps) is what we avoid.
  const userRowsSignature = useMemo(() => {
    let count = 0;
    let last: Message | undefined;
    for (const m of messages) {
      if (m.role === 'user') {
        count += 1;
        last = m;
      }
    }
    return `${count}:${last?.id ?? ''}:${last?.seq ?? ''}:${last?.sourceIndex ?? ''}`;
  }, [messages]);

  const turnNavItems = useMemo(
    () => {
      const rows = messagesRef.current;
      if (turnOutline.length > 0) {
        // The outline only carries a short label. Resolve the full question from
        // the loaded canvas messages so hover/search still see the whole text;
        // unloaded turns fall back to the label until their page is fetched.
        const fullByIndex = new Map<number, string>();
        const indexByMessageId = new Map<string, number>();
        for (const m of rows) {
          if (m.role !== 'user' || m.sourceIndex == null) continue;
          fullByIndex.set(m.sourceIndex, messageText(m));
          if (m.id) indexByMessageId.set(m.id, m.sourceIndex);
          // Pending/optimistic outlines may carry the client correlation id
          // while the canvas row is identified by its persisted message id (or
          // vice versa). Both map to the same physical anchor.
          if (m.clientInputId) indexByMessageId.set(m.clientInputId, m.sourceIndex);
        }
        return buildTurnNavItemsFromOutline(turnOutline)
          .map((item) => {
            // Identity first: the canvas row is the physical anchor. A stale
            // provisional outline index must never place the rail entry
            // somewhere the bubble is not.
            const resolved = item.messageId ? indexByMessageId.get(item.messageId) : undefined;
            if (resolved == null || resolved === item.index) {
              const fullText = fullByIndex.get(item.index);
              return fullText ? { ...item, fullText } : item;
            }
            const fullText = fullByIndex.get(resolved) ?? fullByIndex.get(item.index);
            return {
              ...item,
              id: turnNavId(item.messageId, resolved),
              index: resolved,
              ...(fullText ? { fullText } : {}),
            };
          })
          .sort((a, b) => a.index - b.index);
      }
      return buildTurnNavItems(
        rows.map((m) => ({
          role: m.role,
          text: messageText(m),
          sourceIndex: m.sourceIndex,
          id: m.id ?? m.clientInputId,
        })),
        historyOffsetRef.current,
      );
    },
    [turnOutline, userRowsSignature],
  );
  // 加载按钮只报「还没上画布的提问数」。旧口径把 tool/tool_result 原始行
  // 也算进去，长回合会显示成「还剩 568 条消息」，与用户看到的卡片数量严重不符。
  const unloadedTurnCount = useMemo(
    () => remainingUnloadedTurns(turnOutline, messagesRef.current),
    [turnOutline, userRowsSignature],
  );
  const [turnNavQuery, setTurnNavQuery] = useState('');
  const filteredTurnNavItems = useMemo(
    () => filterTurnNavItems(turnNavItems, turnNavQuery),
    [turnNavItems, turnNavQuery],
  );
  const [activeTurnId, setActiveTurnIdState] = useState<string | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const turnNavItemsRef = useRef(turnNavItems);
  turnNavItemsRef.current = turnNavItems;
  const turnNavPinUntilRef = useRef(0);
  const turnNavScrollCleanupRef = useRef<(() => void) | null>(null);
  /** Absolute turn offsets are scroll-invariant; only re-measure when the
   *  transcript height or the outline changes. Avoids O(turns) forced layout
   *  on every scroll event while the reader browses history. */
  const turnNavOffsetCacheRef = useRef<{ key: string; tops: Map<string, number> }>({
    key: '',
    tops: new Map(),
  });

  // Track whether the current workspace has any git repositories (single repo or multi-repo)
  const [hasGitRepos, setHasGitRepos] = useState<boolean>(false);
  const hasGitReposRef = useRef<boolean>(false);

  useEffect(() => {
    let unmounted = false;
    if (!effectiveWorkingDir) {
      setHasGitRepos(false);
      hasGitReposRef.current = false;
      return;
    }
    fetchGitRepos(effectiveWorkingDir)
      .then((res) => {
        if (unmounted) return;
        const hasGit = Array.isArray(res.repos) && res.repos.length > 0;
        setHasGitRepos(hasGit);
        hasGitReposRef.current = hasGit;
      })
      .catch(() => {
        if (!unmounted) {
          setHasGitRepos(false);
          hasGitReposRef.current = false;
        }
      });
    return () => {
      unmounted = true;
    };
  }, [effectiveWorkingDir]);

  // Right Inspector Panel: Multi-tab ('questions' | 'git' | 'terminal' | 'preview'), resizable, collapsible
  const [rightPanelTab, setRightPanelTabState] = useState<RightPanelTab>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:right-panel-tab');
      if (isRightPanelTab(saved)) return saved;
    } catch {}
    return 'questions';
  });
  const setRightPanelTab = (tab: RightPanelTab) => {
    setRightPanelTabState(tab);
    try {
      localStorage.setItem('jeikcode:right-panel-tab', tab);
    } catch {}
  };

  // 游标眼睛按钮悬停拖拽自动选中与打开
  const [eyeDragOver, setEyeDragOver] = useState(false);
  // 悬停只高亮、不展开：展开会立刻卸载浮动条并改变落点，真正的 drop 会落到别处
  //（甚至冒泡到主舞台打开主编辑区）。展开与打开统一放到 drop 里做。
  const handleEyeDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    setEyeDragOver(true);
  };
  const handleEyeDragLeave = () => {
    setEyeDragOver(false);
  };
  const handleEyeDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEyeDragOver(false);
    setRightPanelTab('preview');
    setRightPanelCollapsed(false);
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath) {
        window.dispatchEvent(
          new CustomEvent('jeikcode:preview:open_file', {
            detail: typeof data === 'object' && data?.filePath ? data : { filePath: targetPath },
          }),
        );
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            window.dispatchEvent(
              new CustomEvent('jeikcode:preview:open_file', {
                detail: { filePath: p, fileName: file.name },
              }),
            );
          }
        }
      }
    } catch {}
  };

  // 拖拽在别处结束或被取消时，眼睛按钮可能已卸载收不到 dragleave：统一兜底清高亮。
  useEffect(() => {
    const reset = () => setEyeDragOver(false);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, []);

  // 中间主区域拖拽文件支持（彻底杜绝桌面端与浏览器拖动时鼠标出现禁止/被Ban警告）
  const handleMainStageDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const handleMainStageDrop = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const raw = e.dataTransfer?.getData('application/jeikcode-tab');
      const data = raw ? JSON.parse(raw) : (window as any).__jeikcode_dragged_tab;
      const targetPath = data?.filePath || e.dataTransfer?.getData('text/plain');
      if (targetPath && typeof targetPath === 'string' && targetPath.trim()) {
        window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: targetPath.trim() } }));
        return;
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          const p = (file as any).path || file.name;
          if (p) {
            window.dispatchEvent(new CustomEvent('jeikcode:open_file', { detail: { path: p } }));
          }
        }
      }
    } catch {}
  };

  const [rightPanelCollapsed, setRightPanelCollapsedState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:right-panel-collapsed');
      if (saved === 'false') return false;
      // 默认收起：用浮动入口打开 Git / 提问历史，避免一进会话就把主栏拆成两列
      return true;
    } catch {}
    return true;
  });
  const setRightPanelCollapsed = (val: boolean) => {
    setRightPanelCollapsedState(val);
    try {
      localStorage.setItem('jeikcode:right-panel-collapsed', String(val));
    } catch {}
  };

  // 监听全局切右侧面板 Tab 事件 (如 AI 画布点击文件链接自动切至 preview 眼睛标签并展开)
  useEffect(() => {
    const handleSwitchRightTab = (e: CustomEvent<string>) => {
      const tab = e.detail;
      if (isRightPanelTab(tab)) {
        setRightPanelTab(tab);
        setRightPanelCollapsed(false);
      }
    };
    window.addEventListener('jeikcode:switch_right_tab', handleSwitchRightTab as EventListener);
    return () => window.removeEventListener('jeikcode:switch_right_tab', handleSwitchRightTab as EventListener);
  }, []);

  const [rightPanelWidth, setRightPanelWidthState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('jeikcode:right-panel-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (parsed >= 200 && parsed <= 1200) return parsed;
      }
    } catch {}
    return 480;
  });

  // 浮动 Git / 提问入口：自由拖到视口任意位置，记忆 left/top。
  const [widgetPos, setWidgetPos] = useState<{ left: number; top: number }>(() => {
    try {
      const raw = localStorage.getItem('jeikcode:floating-widget-pos');
      if (raw) {
        const parsed = JSON.parse(raw) as { left?: number; top?: number };
        if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          return { left: parsed.left as number, top: parsed.top as number };
        }
      }
      const legacyTop = localStorage.getItem('jeikcode:floating-widget-top');
      if (legacyTop) {
        const top = parseInt(legacyTop, 10);
        if (Number.isFinite(top)) {
          const zoom = getPageZoom() || 1.0;
          const left = typeof window !== 'undefined' ? Math.max(8, Math.round(window.innerWidth / zoom) - 52) : 8;
          return { left, top };
        }
      }
    } catch {}
    const zoom = getPageZoom() || 1.0;
    const left = typeof window !== 'undefined' ? Math.max(8, Math.round(window.innerWidth / zoom) - 52) : 8;
    return { left, top: 130 };
  });
  const widgetPosRef = useRef(widgetPos);
  widgetPosRef.current = widgetPos;

  const handleWidgetMouseDown = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const point = 'touches' in e ? (e as TouchEvent).touches[0] : (e as MouseEvent);
    if (!point) return;
    const startX = point.clientX;
    const startY = point.clientY;
    const start = widgetPosRef.current;
    const rail = (e.currentTarget as HTMLElement).closest('.draggable-floating-widget') as HTMLElement | null;
    const railW = rail?.offsetWidth ?? 40;
    const railH = rail?.offsetHeight ?? 88;

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const cur = 'touches' in moveEv ? (moveEv as TouchEvent).touches[0] : (moveEv as MouseEvent);
      if (!cur) return;
      const zoom = getPageZoom() || 1.0;
      const maxLeft = Math.max(8, Math.round(window.innerWidth / zoom) - railW - 8);
      const maxTop = Math.max(48, Math.round(window.innerHeight / zoom) - railH - 8);
      const left = Math.max(8, Math.min(maxLeft, start.left + (cur.clientX - startX) / zoom));
      const top = Math.max(48, Math.min(maxTop, start.top + (cur.clientY - startY) / zoom));
      setWidgetPos({ left, top });
    };

    const onEnd = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove as any);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove as any);
      window.removeEventListener('touchend', onEnd);
      try {
        localStorage.setItem('jeikcode:floating-widget-pos', JSON.stringify(widgetPosRef.current));
      } catch {}
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove as any);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove as any, { passive: false });
    window.addEventListener('touchend', onEnd);
  };

  useEffect(() => {
    const clamp = () => {
      const railW = 40;
      const railH = 96;
      const zoom = getPageZoom() || 1.0;
      setWidgetPos((p) => {
        const maxLeft = Math.max(8, Math.round(window.innerWidth / zoom) - railW - 8);
        const maxTop = Math.max(48, Math.round(window.innerHeight / zoom) - railH - 8);
        const left = Math.max(8, Math.min(maxLeft, p.left));
        const top = Math.max(48, Math.min(maxTop, p.top));
        if (left === p.left && top === p.top) return p;
        return { left, top };
      });
    };
    window.addEventListener('resize', clamp);
    window.addEventListener('jeikcode:zoom_change', clamp);
    clamp();
    return () => {
      window.removeEventListener('resize', clamp);
      window.removeEventListener('jeikcode:zoom_change', clamp);
    };
  }, []);

  const setRightPanelWidth = (w: number) => {
    const clamped = Math.max(200, Math.min(1200, Math.round(w)));
    setRightPanelWidthState(clamped);
  };


  // Git refresh trigger (incremented when turn finishes, branch switches,
  // or a tool that can change the worktree / index has just finished).
  const [gitRefreshTrigger, setGitRefreshTrigger] = useState(0);
  const scheduleGitRefresh = (immediate = false) => {
    gitStore.scheduleRefresh(effectiveWorkingDir, { immediate });
    setGitRefreshTrigger((n) => n + 1);
  };

  // 终端活跃标签页数量与预览/差异标签页数量（角标与提问历史对齐）
  const [terminalCount, setTerminalCount] = useState<number>(() =>
    getSavedTerminalCount(effectiveWorkingDir || cwd),
  );
  const [previewCount, setPreviewCount] = useState<number>(() =>
    getSavedPreviewCount(effectiveWorkingDir || cwd),
  );
  useEffect(() => {
    setTerminalCount(getSavedTerminalCount(effectiveWorkingDir || cwd));
    setPreviewCount(getSavedPreviewCount(effectiveWorkingDir || cwd));
  }, [effectiveWorkingDir, cwd]);
  useEffect(() => {
    const handleRemoteUpdate = () => {
      setTerminalCount(getSavedTerminalCount(effectiveWorkingDir || cwd));
    };
    window.addEventListener('jeikcode:terminal:remote_updated', handleRemoteUpdate);
    return () => {
      window.removeEventListener('jeikcode:terminal:remote_updated', handleRemoteUpdate);
    };
  }, [effectiveWorkingDir, cwd]);

  // 订阅项目全局 Git 状态，计算未提交代码更改数量（对齐提问历史角标）
  const [gitProjectState, setGitProjectState] = useState<GitProjectState>(() =>
    gitStore.getState(effectiveWorkingDir),
  );
  useEffect(() => {
    setGitProjectState(gitStore.getState(effectiveWorkingDir));
    if (effectiveWorkingDir) {
      gitStore.scheduleRefresh(effectiveWorkingDir, { immediate: true });
    }
    return gitStore.subscribe(effectiveWorkingDir, setGitProjectState);
  }, [effectiveWorkingDir]);

  const gitChangedCount = useMemo(() => {
    if (!gitProjectState || !gitProjectState.gitStatus) return 0;
    const staged = gitProjectState.gitStatus.staged?.length ?? 0;
    const unstaged = gitProjectState.gitStatus.unstaged?.length ?? 0;
    const untracked = gitProjectState.gitStatus.untracked?.length ?? 0;
    return staged + unstaged + untracked;
  }, [gitProjectState]);

  // Auto-refresh Git state whenever turnNavItems length changes or turns complete
  useEffect(() => {
    setGitRefreshTrigger((n) => n + 1);
  }, [turnNavItems.length]);

  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      setGitRefreshTrigger((n) => n + 1);
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  const stageRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  // 拖动期间只改舞台的 CSS 变量，不动 state：Chat 是巨型组件，若每个 pointermove
  // 都 setState，会把整条时间线重渲染几十次并反复强制布局。松手才提交一次。
  const handleResizerPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const handle = e.currentTarget as HTMLElement | null;
    let lastWidth = Math.max(
      200,
      Math.min(1200, Math.round(stage.getBoundingClientRect().right - e.clientX)),
    );
    isResizingRef.current = true;
    handle?.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const apply = (clientX: number) => {
      const rect = stage.getBoundingClientRect();
      lastWidth = Math.max(200, Math.min(1200, Math.round(rect.right - clientX)));
      stage.style.setProperty('--right-panel-width', `${lastWidth}px`);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (isResizingRef.current) apply(moveEvent.clientX);
    };

    const finish = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      handle?.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      setRightPanelWidth(lastWidth);
      try {
        localStorage.setItem('jeikcode:right-panel-width', String(lastWidth));
      } catch {}
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };

  // 面板宽度走 CSS 变量而不是 JSX style：拖动中即使因流式输出重渲染，
  // 也不会把正在拖的宽度覆盖回旧值。
  useEffect(() => {
    if (isResizingRef.current) return;
    stageRef.current?.style.setProperty('--right-panel-width', `${rightPanelWidth}px`);
  });

  const isRightPanelVisible = !rightPanelCollapsed;

  // Open Diff Tabs (VSCode style tabs for inspecting commit file diffs)
  const [internalDiffTabs, setInternalDiffTabs] = useState<OpenDiffTab[]>([]);
  const diffTabs = externalDiffTabs ?? internalDiffTabs;
  const setDiffTabs = externalSetDiffTabs ?? setInternalDiffTabs;

  const [internalActiveMainTabId, setInternalActiveMainTabId] = useState<string>('chat');
  const activeMainTabId = externalActiveMainTabId ?? internalActiveMainTabId;
  useEffect(() => { timelineFollow.changed(); }, [activeMainTabId, timelineFollow]);
  const setActiveMainTabId = externalSetActiveMainTabId ?? setInternalActiveMainTabId;

  const handleOpenFileDiff = async (commit: GitCommitItem, file: GitCommitFile, repoRoot?: string) => {
    const projectRoot = effectiveWorkingDir || cwd || '';
    const fullRelativePath = getRelativePathToProject(file.path, repoRoot, projectRoot);
    const tabId = `${commit.short_hash}:${fullRelativePath}`;
    const targetCwd = repoRoot || cwd;
    const existing = diffTabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveMainTabId(tabId);
      return;
    }

    const fileName = file.path.split('/').pop() || file.path;
    const newTab: OpenDiffTab = {
      id: tabId,
      commitHash: commit.hash,
      commitShortHash: commit.short_hash,
      commitMessage: commit.message,
      filePath: fullRelativePath,
      fileName,
      fileStatus: file.status,
      diffText: '',
      loading: true,
    };

    setDiffTabs((prev: OpenDiffTab[]) => [...prev, newTab]);
    setActiveMainTabId(tabId);

    try {
      const res = await fetchGitFileDiff(commit.hash, file.path, targetCwd);
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) => (t.id === tabId ? { ...t, diffText: res.diff, loading: false } : t))
      );
    } catch (err: any) {
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) =>
          t.id === tabId ? { ...t, diffText: `Error: ${err?.message || 'Failed to load diff'}`, loading: false } : t
        )
      );
    }
  };

  const handleOpenWorkingDiff = async (file: GitStatusItem, staged: boolean, repoRoot?: string) => {
    const projectRoot = effectiveWorkingDir || cwd || '';
    const fullRelativePath = getRelativePathToProject(file.path, repoRoot, projectRoot);
    const tabId = `working:${staged ? 'staged' : 'unstaged'}:${fullRelativePath}`;
    const targetCwd = repoRoot || cwd;
    const existing = diffTabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveMainTabId(tabId);
      return;
    }

    const fileName = file.path.split('/').pop() || file.path;
    const newTab: OpenDiffTab = {
      id: tabId,
      commitHash: staged ? 'STAGED' : 'WORKING',
      commitShortHash: staged ? 'Staged' : 'Working Tree',
      commitMessage: staged ? t('git.stagedChanges') : t('git.workingTree'),
      filePath: fullRelativePath,
      fileName,
      fileStatus: file.status === '?' ? 'U' : file.status,
      diffText: '',
      loading: true,
    };

    setDiffTabs((prev: OpenDiffTab[]) => [...prev, newTab]);
    setActiveMainTabId(tabId);

    try {
      const res = await fetchGitWorkingDiff(file.path, staged, targetCwd);
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) => (t.id === tabId ? { ...t, diffText: res.diff, loading: false } : t))
      );
    } catch (err: any) {
      setDiffTabs((prev: OpenDiffTab[]) =>
        prev.map((t: OpenDiffTab) =>
          t.id === tabId ? { ...t, diffText: `Error: ${err?.message || 'Failed to load diff'}`, loading: false } : t
        )
      );
    }
  };

  const handleCloseDiffTab = (tabId: string) => {
    const closing = diffTabs.find((t: OpenDiffTab) => t.id === tabId);
    if (closing?.type === 'editor' && closing.filePath) {
      dropEditorTabSnapshot(mainEditorStateKey(closing.filePath));
    }
    setDiffTabs((prev: OpenDiffTab[]) => {
      const next = prev.filter((t: OpenDiffTab) => t.id !== tabId);
      if (activeMainTabId === tabId) {
        if (next.length > 0) {
          setActiveMainTabId(next[next.length - 1]!.id);
        } else {
          setActiveMainTabId('chat');
        }
      }
      return next;
    });
  };
  function setActiveTurnId(id: string | null) {
    activeTurnIdRef.current = id;
    setActiveTurnIdState(id);
  }
  function syncTurnNavFromScroll() {
    if (Date.now() < turnNavPinUntilRef.current) return;
    const root = scrollRef.current;
    const items = turnNavItemsRef.current;
    if (!root || items.length === 0) return;
    const rootRect = root.getBoundingClientRect();
    const cacheKey = `${root.scrollHeight}|${items.length}`;
    if (turnNavOffsetCacheRef.current.key !== cacheKey) {
      turnNavOffsetCacheRef.current = { key: cacheKey, tops: new Map() };
    }
    const tops = turnNavOffsetCacheRef.current.tops;
    const next = resolveActiveTurnId(
      items,
      (id) => {
        const cached = tops.get(id);
        if (cached !== undefined) return cached;
        const el = root.querySelector(`[data-turn-nav="${id}"]`);
        if (!el) return undefined;
        const top = el.getBoundingClientRect().top - rootRect.top + root.scrollTop;
        tops.set(id, top);
        return top;
      },
      { scrollTop: root.scrollTop, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight },
    );
    if (next && next !== activeTurnIdRef.current) setActiveTurnId(next);
  }
  function rememberTurnOutline(
    text: string,
    index: number,
    ordinal: number,
    id?: string,
    targetSid?: string,
  ) {
    const clean = stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(text));
    const compact = compactTurnNavText(clean);
    if (!compact) return;
    const sid = targetSid ?? activeIdRef.current ?? sessionId;
    const entry: SessionTurnOutline = {
      ordinal,
      index,
      label: compact,
      provisional: true,
      ...(id ? { id } : {}),
    };
    const merge = (prev: SessionTurnOutline[]): SessionTurnOutline[] => {
      // 身份优先：同一落盘 id 只允许一条；index 只是“这次没拿到 id”时的兜底。
      if (id) {
        const idx = prev.findIndex((item) => item.id === id);
        if (idx >= 0) {
          const existing = prev[idx]!;
          // The durable pending projection is now superseded by the persisted
          // row: clear the badge without changing the already-rendered anchor.
          if (!existing.pending) return prev;
          const next = prev.slice();
          next[idx] = {
            ...existing,
            pending: false,
            provisional: true,
            ...(compact.length > existing.label.length ? { label: compact } : {}),
          };
          return next;
        }
      }
      if (!id && prev.some((item) => item.index === index)) return prev;
      return [...prev, entry].sort((a, b) => a.index - b.index);
    };
    if (!sid) {
      setTurnOutline((prev) => merge(prev));
      return;
    }
    const isActive = sid === activeIdRef.current;
    if (isActive) {
      setTurnOutline((prev) => {
        const next = merge(prev);
        // Keep the ref/map in lockstep with state so cache writes in the same
        // tick already contain this row (the old 800ms debounce could race).
        turnOutlineRef.current = next;
        turnOutlineBySessionRef.current.set(sid, next);
        return next;
      });
      return;
    }
    const prev = turnOutlineBySessionRef.current.get(sid) ?? [];
    const next = merge(prev);
    if (next !== prev) turnOutlineBySessionRef.current.set(sid, next);
  }

  /** A folded steer supersedes its durable pending input row. */
  function forgetPendingTurnOutline(
    targetSid: string | null | undefined,
    inputId: string | null | undefined,
  ) {
    if (!inputId) return;
    const sid = targetSid ?? activeIdRef.current ?? sessionId;
    if (!sid) return;
    const remove = (prev: SessionTurnOutline[]) =>
      prev.filter((turn) => !(turn.pending === true && turn.id === inputId));
    if (sid === activeIdRef.current) {
      setTurnOutline((prev) => {
        const next = remove(prev);
        if (next.length === prev.length) return prev;
        turnOutlineRef.current = next;
        turnOutlineBySessionRef.current.set(sid, next);
        return next;
      });
      return;
    }
    const prev = turnOutlineBySessionRef.current.get(sid) ?? [];
    const next = remove(prev);
    if (next.length !== prev.length) {
      turnOutlineBySessionRef.current.set(sid, next);
    }
  }

  /** Cancelling a steer retires its local provisional outline immediately. */
  function forgetCancelledSteerOutline(
    targetSid: string | null | undefined,
    q: QueuedMessage,
  ) {
    const sid = targetSid ?? activeIdRef.current ?? sessionId;
    if (!sid) return;
    const ids = new Set<string>();
    if (q.clientInputId) ids.add(q.clientInputId);
    if (q.id != null) ids.add(String(q.id));
    if (ids.size === 0) return;
    const remove = (prev: SessionTurnOutline[]) => removeOutlineRowsById(
      prev,
      ids,
      (turn) => turn.provisional === true || turn.pending === true,
    );
    if (sid === activeIdRef.current) {
      setTurnOutline((prev) => {
        const next = remove(prev);
        if (next === prev) return prev;
        turnOutlineRef.current = next;
        turnOutlineBySessionRef.current.set(sid, next);
        return next;
      });
      return;
    }
    const prev = turnOutlineBySessionRef.current.get(sid) ?? [];
    const next = remove(prev);
    if (next !== prev) turnOutlineBySessionRef.current.set(sid, next);
  }

  /** A real user echo/persisted row supersedes its pending-input projection. */
  function clearPendingInputFlag(rows: Message[], id: string | null | undefined): Message[] {
    if (!id) return rows;
    let changed = false;
    const next = rows.map((message) => {
      if (
        message.role === 'user' &&
        message.pendingInput &&
        (message.id === id || message.clientInputId === id)
      ) {
        changed = true;
        return { ...message, pendingInput: undefined };
      }
      return message;
    });
    return changed ? next : rows;
  }

  function nextTurnNavIndex(current: Message[] = messagesRef.current): number {
    let next = historyTotalRef.current;
    for (const message of current) {
      if (message.sourceIndex != null) next = Math.max(next, message.sourceIndex + 1);
    }
    for (const item of turnNavItemsRef.current) next = Math.max(next, item.index + 1);
    return next;
  }

  /** Oldest server display seq on the canvas (legacy rows may have none). */
  function oldestDisplaySeq(rows: Array<{ seq?: number }>): number | undefined {
    for (const row of rows) {
      if (typeof row.seq === 'number') return row.seq;
    }
    return undefined;
  }

  function nextOutlineOrdinal(): number {
    const outline = turnNavItemsRef.current;
    return (outline[outline.length - 1]?.ordinal ?? -1) + 1;
  }

  function foldSteeredInputs(
    inputs: { text: string; images?: ImageData[]; message_id?: string; created_at?: number }[],
    clientInputIds?: Array<string | null>,
    targetSessionId?: string,
    timestamps?: Array<number | null | undefined>,
    opts?: { replay?: boolean; anchor?: TurnUserAnchor; skipQueued?: boolean; seq?: number },
  ) {
    const steeredInputs = (inputs ?? []).map((input) => ({
      text: stripSteerEnvelopeForDisplay(input.text || ''),
      images: input.images ?? [],
      // 内核回传的落盘消息 id（优先于本地 client id，让 id 收敛不依赖文本启发）
      messageId: input.message_id,
    }));
    if (steeredInputs.length === 0) return;

    const sid = targetSessionId || activeIdRef.current;
    const isCurrentView = !!sid && activeIdRef.current === sid;
    // The kernel folded these inputs: retire the durable pending projection by
    // the same client id (the persisted row carries its own kernel id).
    for (let i = 0; i < steeredInputs.length; i++) {
      forgetPendingTurnOutline(sid, clientInputIds?.[i] ?? null);
      forgetPendingTurnOutline(sid, steeredInputs[i]?.messageId ?? null);
    }

    // 1. 从排队消息 queued 中移除已被内核 fold 的转向消息，并暂存其携带的多模态原图
    const matchedQueuedItems: (QueuedMessage | undefined)[] = [];
    const updateQueuedList = (prevQueued: QueuedMessage[]): QueuedMessage[] => {
      let nextQueued = prevQueued.slice();
      for (let i = 0; i < steeredInputs.length; i++) {
        const s = steeredInputs[i];
        const clean = s.text.trim();
        const cid = clientInputIds?.[i];
        // Prefer stable identity. Text is only a fallback when exactly one card matches.
        let matchIdx = cid ? nextQueued.findIndex((q) => q.clientInputId === cid) : -1;
        if (matchIdx < 0) {
          const textMatches = nextQueued
            .map((q, index) => ({ q, index }))
            .filter(({ q }) => q.text.trim() === clean);
          if (textMatches.length === 1) matchIdx = textMatches[0]!.index;
        }
        if (matchIdx >= 0) {
          matchedQueuedItems.push(nextQueued[matchIdx]);
          nextQueued.splice(matchIdx, 1);
        } else {
          matchedQueuedItems.push(undefined);
        }
      }
      return nextQueued;
    };

    if (sid && opts?.skipQueued) {
      // 跨端广播回写缓存时：只借本地卡片补齐原图/时间戳，不修改也不回写队列 ——
      // 队列真相在后端，此时回写可能把对端刚落地的卡片覆盖掉。
      updateQueuedList(queuedBySessionRef.current.get(sid) ?? []);
    } else {
      if (sid) {
        updateQueuedForSession(sid, updateQueuedList);
      }
      if (isCurrentView) {
        setQueued(updateQueuedList);
      }
    }

    // 2. 将转向消息作为真实普通用户消息发送并追加到会话中，并在其后紧跟新的 assistant 占位
    const foldIntoMessageList = (prev: Message[]): Message[] => {
      let next = prev.slice();
      // A pending-input bubble (admitted but not folded) is replaced by the
      // persisted steer row; never leave both on the canvas.
      const pendingIds = new Set<string>();
      for (const inputId of clientInputIds ?? []) if (inputId) pendingIds.add(inputId);
      for (const s of steeredInputs) if (s.messageId) pendingIds.add(s.messageId);
      if (pendingIds.size > 0) {
        next = next.filter(
          (message) =>
            !(message.role === 'user' && message.pendingInput && message.id && pendingIds.has(message.id)),
        );
      }
      const now = Date.now();
      // 回放 / 跨流广播补回的转向：只在「锚点之后没有任何助手内容」时才插回中间。
      // 锚点自身不可靠（它只是上一条真正上屏的帧），一旦后面还跟着同一批工具卡 /
      // 同一轮回答，插进去就会把 `Read / Read` 劈成两段——两台端因此渲染出不同顺序。
      // 定位不到或会劈开助手段时一律追加到尾部：晚一位可以接受，插中间是可见错误。
      let insertion = steerInsertPosition(next, opts?.anchor, opts?.replay === true);
      for (let i = 0; i < steeredInputs.length; i++) {
        const s = steeredInputs[i];
        let cleanText = s.text.trim();
        const matchedItem = matchedQueuedItems[i];
        // 优先保留多模态原图（避免纯文本模型经过 VL 预处理后丢失图片实体展示）
        const resolvedImages = (s.images && s.images.length > 0)
          ? s.images
          : (matchedItem?.images && matchedItem.images.length > 0)
            ? matchedItem.images
            : undefined;

        // 若为纯图片转向，剥离占位文案，直接以纯图片气泡展示
        if (
          (cleanText === '（用户附加了新的图片）' || cleanText === '(The user attached image(s))') &&
          resolvedImages &&
          resolvedImages.length > 0
        ) {
          cleanText = '';
        }

        if (!cleanText && (!resolvedImages || resolvedImages.length === 0)) continue;

        const steerId = s.messageId ?? clientInputIds?.[i] ?? undefined;
        const alreadyPresent = !!steerId && next.some(
          (m) => m.role === 'user' && (m.id === steerId || m.clientInputId === steerId),
        );
        if (alreadyPresent) {
          // 乐观气泡已存在（本地发送时已画）：清 pending 标记 + 采纳落盘身份，
          // 让后续刷新/切换/回放按 id 收敛，而非回退文本启发。
          const storedId = s.messageId;
          let anchorIndex: number | undefined;
          next = next.map((m) => {
            const isMatch =
              !!steerId && m.role === 'user' && (m.id === steerId || m.clientInputId === steerId);
            if (isMatch) {
              anchorIndex = m.sourceIndex;
              const patched: Message = {
                ...m,
                images: m.images && m.images.length > 0 ? m.images : resolvedImages,
                pendingSteerId: undefined,
              };
              // 唯一性守卫：同一个落盘 id 绝不贴到第二条消息上。
              if (storedId && !next.some((other) => other.id === storedId)) {
                patched.id = storedId;
              }
              return patched;
            }
            return m.pendingSteerId ? { ...m, pendingSteerId: undefined } : m;
          });
          // 气泡在画布上不等于右栏有它：刷新/回放补齐的画布行也要补大纲。
          if (sid && anchorIndex != null) {
            rememberTurnOutline(
              cleanText || (resolvedImages && resolvedImages.length > 0 ? '[图片]' : ''),
              anchorIndex,
              nextOutlineOrdinal(),
              steerId,
              sid,
            );
          }
          continue;
        }

        const turnIndex = nextTurnNavIndex(next);
        const turnOrdinal = nextOutlineOrdinal();
        if (sid) {
          // 当前视图与后台会话都必须记大纲：后台会话切回来时不能只看到气泡、
          // 看不到右栏条目。id 是唯一身份，index 只作展示坐标。
          rememberTurnOutline(
            cleanText || '[图片]',
            turnIndex,
            turnOrdinal,
            s.messageId ?? clientInputIds?.[i] ?? undefined,
            sid,
          );
        }

        const resolvedSteerId = s.messageId ?? clientInputIds?.[i] ?? undefined;
        const resolvedClientInputId = clientInputIds?.[i] ?? s.messageId ?? undefined;
        const userRow: Message = {
          role: 'user',
          parts: [{ kind: 'text', text: cleanText }],
          images: resolvedImages,
          ts: timestamps?.[i] ?? matchedItem?.createdAt ?? now,
          isSteer: true,
          // 不写 seq：渲染顺序只认数组因果序，`seq` 仅用于分页/身份。
          // 旧实现在中间插入时捏造夹心 seq，一旦与磁盘坐标系混排就会把整段搬到开头。
          // 内核身份优先；旧 daemon 无此字段时退回本地 client id。
          id: resolvedSteerId,
          ...(resolvedClientInputId ? { clientInputId: resolvedClientInputId } : {}),
        };
        // Working is transient UI; no empty assistant row is persisted or
        // inserted. The first text/tool frame opens the real assistant row.
        if (insertion >= 0) {
          next.splice(insertion, 0, userRow);
          insertion += 1;
        } else {
          const tail = next[next.length - 1];
          if (tail && tail.role === 'assistant' && (!tail.parts || tail.parts.length === 0)) {
            next.pop();
          }
          next.push(userRow);
        }
      }
      return next;
    };

    if (isCurrentView) {
      const next = foldIntoMessageList(messagesRef.current);
      setMessages({ type: 'replace', rows: next });
      const normalizedNext = messagesRef.current;
      if (sid) {
        messageCacheRef.current.set(sid, normalizedNext);
        const ph = activeSession?.project_hash || projectHashBySessionRef.current.get(sid) || viewedProjectHashRef.current || '';
        if (ph) {
          const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []);
          commitCanvasCache(ph, sid, {
            messages: normalizedNext,
            todos: activeTodosRef.current,
            turns: currentOutline,
            tokenUsage: cachedTokenUsageFor(sid),
          });
        }
      }
    } else if (sid) {
      const msgs = messageCacheRef.current.get(sid) ?? [];
      // 注意：**不要求 msgs 非空**。另一台实例可能从未打开过该会话（缓存为空），
      // 但内核已经把这条 steer 合并进回合了 —— 若因为“没有画布”就跳过，
      // 该实例永远看不到这张转向卡（用户看到的“别的实例看不见”）。
      // 空画布时就从零开始建一份，后续冷启动/切换会以它为基础合并。
      const next = normalizeCanvasRows(foldIntoMessageList(msgs));
      messageCacheRef.current.set(sid, next);
      const ph = projectHashBySessionRef.current.get(sid) || viewedProjectHashRef.current || '';
      if (ph) {
        commitCanvasCache(ph, sid, {
          messages: next,
          turns: turnOutlineBySessionRef.current.get(sid) ?? [],
          tokenUsage: cachedTokenUsageFor(sid),
        });
      }
    }

    // 3. A folded steer is still an ACTIVE turn. If the previous loop's done
    //    already cleared busy (natural drain race), restore the running state so
    //    the button returns to stop and the new loop is not left looking idle.
    if (sid) {
      localTurnSessionsRef.current.add(sid);
      onTurnRunningChange?.(sid, true);
      if (isCurrentView) {
        liveLifecycleRef.current = { running: true, terminalConsumed: false };
        setBusyAndClock(true);
        busyRef.current = true;
      } else {
        backgroundRunningSessionsRef.current.add(sid);
      }
    }

    // 4. 消费 pendingSteers
    if (sid) {
      // 账本：内核已回执 fold 的转向（即使画布上暂时看不到它，也绝不能再投递一次）。
      const ledger = foldedSteersBySessionRef.current.get(sid) ?? [];
      for (let i = 0; i < steeredInputs.length; i++) {
        ledger.push({
          text: steeredInputs[i].text,
          images: steeredInputs[i].images.length > 0
            ? steeredInputs[i].images
            : matchedQueuedItems[i]?.images,
          clientInputId: clientInputIds?.[i] ?? steeredInputs[i].messageId ?? undefined,
        });
      }
      foldedSteersBySessionRef.current.set(sid, ledger);
      const effectiveClientIds = steeredInputs.map(
        (s, idx) => clientInputIds?.[idx] ?? s.messageId ?? null,
      );
      const curSteers = pendingSteersBySessionRef.current.get(sid) ?? [];
      const nextSteers = acknowledgeLiveSteers(curSteers, steeredInputs, effectiveClientIds);
      if (nextSteers.length > 0) {
        pendingSteersBySessionRef.current.set(sid, nextSteers);
        setStoredSteers(sid, nextSteers);
      } else {
        pendingSteersBySessionRef.current.delete(sid);
        setStoredSteers(sid, []);
      }
    }
    if (isCurrentView) {
      const effectiveClientIds = steeredInputs.map(
        (s, idx) => clientInputIds?.[idx] ?? s.messageId ?? null,
      );
      setPendingSteers((pending) => acknowledgeLiveSteers(pending, steeredInputs, effectiveClientIds));
    }
  }

  function cancelTurnNavScroll() {
    const cleanup = turnNavScrollCleanupRef.current;
    turnNavScrollCleanupRef.current = null;
    cleanup?.();
  }

  /** Scroll only the transcript container. `scrollIntoView` also scrolls outer
   * ancestors and races the bottom-follow observer during session replacement. */
  function scrollToTurnId(id: string, behavior: ScrollBehavior = 'smooth'): boolean {
    const root = scrollRef.current;
    if (!root) return false;
    const navItem = turnNavItemsRef.current.find((it) => it.id === id);
    let target = root.querySelector(`[data-turn-nav="${id}"]`);
    if (!target) {
      target = root.querySelector(`#${id}`);
    }
    // Identity fallback: a stale provisional index must not make the click
    // land on the previous question. The bubble carries the persisted id
    // (and, for optimistic rows, the client correlation id).
    if (!target && navItem?.messageId) {
      const bubbles = root.querySelectorAll('[data-message-id], [data-client-input-id]');
      for (const bubble of bubbles) {
        if (
          bubble.getAttribute('data-message-id') === navItem.messageId ||
          bubble.getAttribute('data-client-input-id') === navItem.messageId
        ) {
          target = bubble;
          break;
        }
      }
    }
    if (!target) {
      // 智能容错：若热重载中序号丢失，尝试从大纲中找到对应文本模糊命中 user 气泡
      const item = navItem;
      if (item && item.text) {
        const clean = item.text.slice(0, 15).toLowerCase();
        const bubbles = root.querySelectorAll('.user-message-wrapper');
        for (const bubble of bubbles) {
          if (bubble.textContent?.toLowerCase().includes(clean)) {
            target = bubble;
            break;
          }
        }
      }
    }
    if (!(target instanceof HTMLElement)) return false;

    cancelTurnNavScroll();
    timelineFollow.pause();
    const top = turnNavScrollTop(
      root.scrollTop,
      root.getBoundingClientRect().top,
      target.getBoundingClientRect().top,
    );
    root.scrollTo({ top, behavior });

    // 醒目视觉高亮反馈，让用户明确感知跳到了目标
    target.classList.add('is-active-search-match');
    window.setTimeout(() => target?.classList.remove('is-active-search-match'), 2000);

    let timer: number | null = null;
    const cleanup = () => {
      root.removeEventListener('scrollend', finish);
      if (timer != null) window.clearTimeout(timer);
      if (turnNavScrollCleanupRef.current === cleanup) {
        turnNavScrollCleanupRef.current = null;
      }
    };
    const finish = () => {
      cleanup();
      turnNavPinUntilRef.current = 0;
      syncTurnNavFromScroll();
    };
    root.addEventListener('scrollend', finish, { once: true });
    timer = window.setTimeout(finish, 1600);
    turnNavScrollCleanupRef.current = cleanup;
    return true;
  }

  async function ensureHistoryIncludes(
    index: number,
    opts?: { force?: boolean; recordId?: string },
  ): Promise<boolean> {
    const projectHash = activeSession?.project_hash;
    const sid = sessionId;
    if (!projectHash || !sid) return false;
    const generation = sessionGenerationRef.current;
    const prevOffset = historyOffsetRef.current;
    const force = opts?.force === true;
    if (!force && index >= prevOffset) return true;
    setLoadingOlder(true);
    try {
      const reqOffset = Math.max(0, Math.min(index, prevOffset));
      const reqLimit = Math.max(HISTORY_PAGE, prevOffset - reqOffset);
      const detail = opts?.recordId && index >= prevOffset
        ? await pullSession({ projectHash, sessionId: sid, mode: 'jump', around: opts.recordId })
        : await pullSession({
            projectHash,
            sessionId: sid,
            mode: 'older',
            offset: reqOffset,
            limit: reqLimit,
          });
      if (
        activeIdRef.current !== sid ||
        sessionGenerationRef.current !== generation
      ) return false;
      const older = sessionMessagesToDisplay(detail.messages, detail.offset ?? reqOffset);
      const newOffset = detail.offset ?? reqOffset;
      const newTotal = detail.message_count ?? historyTotalRef.current;
      const firstTurnIdx = detail.turns?.[0]?.index ?? (turnOutlineRef.current[0]?.index ?? 0);
      const nextOffsetValue = Math.min(prevOffset, newOffset);
      const olderExists = hasOlderVisibleMessages({
        offset: nextOffsetValue,
        firstTurnIndex: firstTurnIdx,
        canvasHasFirstTurn: older.some((m) => typeof m.sourceIndex === 'number' && m.sourceIndex <= firstTurnIdx),
        oldestSeq: older[0]?.seq,
      });
      historyOffsetRef.current = nextOffsetValue;
      historyTotalRef.current = newTotal;
      setHasOlder(olderExists);
      historyOffsetBySessionRef.current.set(sid, nextOffsetValue);
      historyTotalBySessionRef.current.set(sid, newTotal);
      hasOlderBySessionRef.current.set(sid, olderExists);
      if (detail.turns && detail.turns.length > 0) {
        const mergedTurns = mergeServerWithLocalOutline(detail.turns, turnOutlineRef.current);
        turnOutlineBySessionRef.current.set(sid, mergedTurns);
        setTurnOutline(mergedTurns);
      }
      // 大纲定位与向前翻页统一走 `older` 增量合并，保留画布上已有的全部后续回合与在途流式内容，
      // 严禁使用 `replace` 将画布替换成单轮切片导致其它内容全部消失！
      setMessages({ type: 'older', rows: older });
      messageCacheRef.current.set(sid, messagesRef.current);
      const payload = canvasCachePayload(sid);
      commitCanvasCache(projectHash, sid, {
        messages: payload.messages,
        turns: detail.turns,
        historyOffset: payload.offset,
        historyTotal: payload.total,
        revision: detail.revision,
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      return true;
    } catch {
      return false;
    } finally {
      if (
        activeIdRef.current === sid &&
        sessionGenerationRef.current === generation
      ) setLoadingOlder(false);
    }
  }

  async function jumpToTurn(id: string) {
    const item = turnNavItemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    // Prefer the canvas row's own absolute index when the outline still holds a
    // provisional coordinate. Otherwise the click can land on the previous
    // question (A-1) even though the target is A.
    const anchored = messagesRef.current.find((message) => {
      if (message.role !== 'user') return false;
      if (item.messageId && (message.id === item.messageId || message.clientInputId === item.messageId)) {
        return true;
      }
      return !item.messageId && message.sourceIndex === item.index;
    });
    const index = anchored?.sourceIndex ?? item.index;
    const sid = activeIdRef.current;
    const generation = sessionGenerationRef.current;
    setActiveTurnId(id);
    turnNavPinUntilRef.current = Date.now() + 1800;
    // A pending steer has no transcript bubble yet. Its outline index is a
    // synthetic insertion point, so loading history by that index lands on an
    // unrelated tool row. Anchor to the actual queue card, or keep the view at
    // the pending tail where the bubble will appear after the fold.
    if (item.pending && !anchored) {
      pendingJumpIdRef.current = null;
      const root = scrollRef.current;
      const key = item.messageId ?? '';
      const card = key
        ? root?.querySelector<HTMLElement>(
            `.user-message-wrapper.queued[data-client-input-id="${CSS.escape(key)}"]`,
          )
        : null;
      if (root) {
        timelineFollow.pause();
        const nextTop = card
          ? Math.max(
              0,
              card.getBoundingClientRect().top -
                root.getBoundingClientRect().top +
                root.scrollTop -
                24,
            )
          : root.scrollHeight;
        root.scrollTo({ top: nextTop, behavior: 'smooth' });
      }
      return;
    }
    pendingJumpIdRef.current = id;
    const busyGuard = () =>
      activeIdRef.current !== sid || sessionGenerationRef.current !== generation;
    // 判据必须是“**画布上真的有这一行**”：已在画布上时直接滚动定位，绝不发起多余拉取或替换画布！
    if (!anchored) {
      await ensureHistoryIncludes(index, { force: true, recordId: item.messageId });
    }
    if (busyGuard()) {
      if (pendingJumpIdRef.current === id) pendingJumpIdRef.current = null;
      return;
    }
    // The messages effect may already have completed the pending jump after a
    // history prepend. Otherwise try the current DOM and then bounded retries.
    if (pendingJumpIdRef.current === id && scrollToTurnId(id)) {
      pendingJumpIdRef.current = null;
      return;
    }
    for (const ms of [50, 150, 300]) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
      if (busyGuard() || pendingJumpIdRef.current !== id) return;
      if (scrollToTurnId(id)) {
        pendingJumpIdRef.current = null;
        return;
      }
    }
    // 最后一道防线：分页游标只记录「连续加载到的头部」，画布被权威尾部对账
    // 整段替换过时它会比实际画布更靠前。此时“已加载”只是游标的错觉——
    // 直接按绝对下标把那一条提问所在的回合取回来，让右栏点击永不落空。
    await ensureHistoryIncludes(index, { force: true, recordId: item.messageId });
    if (busyGuard()) return;
    for (const ms of [0, 120, 320]) {
      if (ms > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
      if (busyGuard() || pendingJumpIdRef.current !== id) return;
      if (scrollToTurnId(id)) {
        pendingJumpIdRef.current = null;
        return;
      }
    }
    // 真的定位不到（提问已被压缩/删改）：清掉 pending，绝不让后续消息变更
    // 反复拿一个不存在的锚点滚屏。
    pendingJumpIdRef.current = null;
  }
  // 提问导航取消与滚动同步由主 session-switch effect 维护大纲生命周期。
  useEffect(() => () => cancelTurnNavScroll(), []);
  useEffect(() => {
    const id = requestAnimationFrame(() => syncTurnNavFromScroll());
    return () => cancelAnimationFrame(id);
  }, [turnNavItems]);

  // After older messages load (or any messages change), scroll to the pending
  // turn-jump target that couldn't be resolved immediately.
  useEffect(() => {
    const id = pendingJumpIdRef.current;
    if (id == null) return;
    if (!scrollToTurnId(id)) return;
    pendingJumpIdRef.current = null;
  }, [messages]);

  /**
   * 回前台增量续传（#1）：有可信游标 + total 对得上时，只拉 `seq > lastSeq` 的新增行。
   *
   * 安全守卫（三条，任一不满足就降级全量，绝不静默跳帧）：
   * 1. 游标必须属于同一 daemon 纪元（游标读取时已校验）；
   * 2. 新增行数 + 已知行数必须等于服务端 `cursor.total`（对不上说明会话被
   *    truncate/压缩过，游标不可信）；
   * 3. 返回 0 行但 total 变大 → 增量失效，降级全量。
   *
   * 成功时只把新增行按身份合并进画布，不重画整表；失败返回 false 由调用方走全量。
   */
  async function syncSessionDelta(hash: string, sid: string): Promise<boolean> {
    const cached = messageCacheRef.current.get(sid);
    if (!cached || cached.length === 0) return false;
    // 画布尾部若有尚未落盘的本地行（乐观提问 / 在途工具或流式助手），必须走 snapshot 权威尾部合并。
    if (transcriptHasOpenUserTurn(cached) || transcriptHasInFlightAssistant(cached)) {
      return false;
    }
    const lastRow = cached[cached.length - 1];
    // 末行必须带有服务端落盘下标与单调 seq（排除本地 normalizeCanvas 合成的临时 seq）。
    if (typeof lastRow?.sourceIndex !== 'number' || typeof lastRow?.seq !== 'number') {
      return false;
    }
    const lastDisplaySeq = lastRow.seq;
    const knownTotal = historyTotalRef.current;
    const knownRevision =
      cacheRevisionBySessionRef.current.get(sid) ?? getMemorySession(hash, sid)?.revision ?? 0;
    try {
      const todoEpochAtPull = todoLiveEpoch(sid);
      const detail = await pullSession({
        projectHash: hash,
        sessionId: sid,
        mode: 'delta',
        afterSeq: lastDisplaySeq,
        // 离开期间可能新增几百行（极端情况 500+ 轮）。一次多拿一些，
        // 剩下的缺口交给 `backfillCausalGaps` 并行补；两段都按身份插入，
        // 不会重复也不会错位。
        limit: DELTA_PAGE,
      });
      if (activeIdRef.current !== sid) return false;
      // 守卫 1：服务端 revision 发生变化（编辑 / 删除 / 回溯 / 压缩）→ 游标失效，降级全量快照。
      if (
        typeof detail.revision === 'number' &&
        knownRevision > 0 &&
        detail.revision !== knownRevision
      ) {
        return false;
      }
      const total = detail.cursor?.total ?? detail.message_count ?? -1;
      const rows = detail.messages ?? [];
      // 守卫 2：会话被回退/压缩过 → total 变小或对不上，游标不可信。
      if (total >= 0 && total < knownTotal) return false;
      if (detail.turns && detail.turns.length > 0) {
        const mergedTurns = mergeServerWithLocalOutline(detail.turns, turnOutlineRef.current);
        turnOutlineRef.current = mergedTurns;
        turnOutlineBySessionRef.current.set(sid, mergedTurns);
        setTurnOutline(mergedTurns);
      }
      if (detail.todos !== undefined) {
        // 唤醒对账同样以服务端 board 为准（含空表清空）；即使没有新消息也要对齐。
        applyAuthoritativeTodos(sid, detail.todos, todoEpochAtPull, detail.todos_revision);
      }
      if (rows.length === 0) {
        // 没有新内容：total 一致就算成功（零渲染），否则降级。
        return total < 0 || total === knownTotal;
      }
      if (!Array.isArray(rows) || rows.length === 0) return false;
      const appended = sessionMessagesToDisplay(rows, detail.offset ?? 0);
      if (appended.length === 0) return true;
      setMessages({ type: 'older', rows: appended });
      const next = messagesRef.current;
      messageCacheRef.current.set(sid, next);
      const nextTotal = total >= 0 ? total : knownTotal + appended.length;
      historyTotalRef.current = nextTotal;
      historyTotalBySessionRef.current.set(sid, nextTotal);
      noteCacheRevision(sid, detail.revision);
      if (detail.token_usage) {
        applySessionTokens(sid, next, detail.token_usage);
      }
      commitCanvasCache(hash, sid, {
        messages: next,
        todos: detail.todos,
        todoRevision: detail.todos_revision ?? 0,
        turns: turnOutlineRef.current,
        tokenUsage: detail.token_usage,
        historyTotal: nextTotal,
        revision: detail.revision,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 回前台 / 离线恢复的单通道对账入口：
   * 1. 优先尝试 `after_seq` 增量续传（无新增时 0 渲染，有新增时顺带更新大纲与缓存）；
   * 2. 游标或版本不满足时降级为一次权威磁盘快照（`syncSessionCacheFromDisk`）；
   * 3. 若用户未手动跳转过历史，将跨回合因果缺口补齐推迟到空闲时段并行完成。
   */
  async function restoreAwayPage(hash: string, sid: string): Promise<void> {
    const away = awayPageRef.current;
    awayPageRef.current = null;
    if (activeIdRef.current !== sid) return;
    // 增量续传（#1）是实时路径：只拉离开期间新增的行，必须**先完成、不延后**。
    const deltaOk = await syncSessionDelta(hash, sid).catch(() => false);
    if (!deltaOk) {
      // 游标不可信（纪元/版本变化 / total 对不上 / 含未落盘尾巴）→ 降级为常规全量对账。
      await syncSessionCacheFromDisk(hash, sid).catch(() => {});
    }
    // 历史缺口补齐是“锦上添花”，但有两个前提：
    // 1. 用户没有手动跳转过历史（跳转后的画布本来就分两段，那是用户意图，不是缺口）；
    // 2. 推到空闲时段，不阻塞上面的实时路径与首屏。
    // 判定用身份：画布首行与离开前首行仍一致 → 用户没动过历史。
    const headNow = messagesRef.current[0]?.seq;
    const headUnchanged =
      !away ||
      away.sid !== sid ||
      typeof away.headSeq !== 'number' ||
      typeof headNow !== 'number' ||
      headNow === away.headSeq;
    if (headUnchanged) scheduleGapBackfill(hash, sid);
  }

  /** 把缺口补齐推到空闲时段：不阻塞首次渲染与直播上屏。 */
  function scheduleGapBackfill(hash: string, sid: string): void {
    const run = () => {
      if (activeIdRef.current !== sid) return;
      void backfillCausalGaps(hash, sid).catch(() => {});
    };
    const ric = (globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === 'function') ric(run, { timeout: 1500 });
    else setTimeout(run, 120);
  }

  /** 大纲新鲜性：回前台/恢复网络时重新拉一次服务端大纲（只用元数据，不拉正文）。 */
  async function refreshOutline(hash: string, sid: string): Promise<void> {
    const detail = await pullSession({ projectHash: hash, sessionId: sid, mode: 'outline' });
    if (activeIdRef.current !== sid) return;
    if (!detail.turns || detail.turns.length === 0) return;
    const mergedTurns = mergeServerWithLocalOutline(detail.turns, turnOutlineRef.current);
    turnOutlineRef.current = mergedTurns;
    turnOutlineBySessionRef.current.set(sid, mergedTurns);
    setTurnOutline(mergedTurns);
  }

  /**
   * 按因果缺口补页（有界循环，最多 4 页）。
   *
   * 性能要点：
   * 1. **并行取页**：缺口大小已知，按 offset 同时发多个 `older` 请求，
   *    把 k 轮 RTT 压成 1 轮（串行时 4 页就是 4 个往返）；
   * 2. **一次性落屏**：所有页合并去重后只 `setMessages` 一次、只写一次缓存，
   *    避免每页触发一次渲染/布局与 IndexedDB 写入；
   * 3. **有界**：单次最多补 400 行、最多两轮，且每轮都有“没新增就停”的守卫。
   */
  async function backfillCausalGaps(hash: string, sid: string): Promise<void> {
    // 缺口上限：常规会话 400 行足够；极长会话（500+ 轮）一次断开可能出现
    // 上千行的缺口，提到 2000 行才能一次补齐。只按**实际缺口大小**取，
    // 没缺口时零请求，不会凭空多拉。
    const MAX_ROWS = 2000;
    /** 单个并行请求的页大小：并行页越多越吃连接数，取大页减少并发数。 */
    const PAGE = 200;
    for (let round = 0; round < 2; round += 1) {
      if (activeIdRef.current !== sid) return;
      const gap = findCausalGap(messagesRef.current, 24);
      if (!gap || gap.after <= gap.before + 1) return;
      const missing = Math.min(gap.after - gap.before - 1, MAX_ROWS);
      const start = gap.before + 1;
      const requests: Promise<{ offset: number; rows: any[] }>[] = [];
      for (let offset = start; offset < start + missing; offset += PAGE) {
        const limit = Math.min(PAGE, start + missing - offset);
        requests.push(
          pullSession({ projectHash: hash, sessionId: sid, mode: 'older', offset, limit })
            .then((detail) => ({ offset: detail.offset ?? offset, rows: detail.messages ?? [] }))
            .catch(() => ({ offset, rows: [] as any[] })),
        );
      }
      const pages = await Promise.all(requests);
      if (activeIdRef.current !== sid) return;
      const seen = new Set<string>();
      const filled: Message[] = [];
      for (const page of pages.sort((a, b) => a.offset - b.offset)) {
        for (const row of sessionMessagesToDisplay(page.rows, page.offset)) {
          if (row.id) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
          }
          filled.push(row);
        }
      }
      if (filled.length === 0) return; // 已到磁盘开头
      const before = messagesRef.current.length;
      setMessages({ type: 'older', rows: filled });
      messageCacheRef.current.set(sid, messagesRef.current);
      // 大缺口可能跨多轮：只有真的还在增长时才继续，否则立即退出。
      if (messagesRef.current.length === before) return;
    }
  }

  // Reload one session's transcript from disk into the view, guarded against a
  // session switch racing the async fetch. Mirrors the session-load effect's activeIdRef guard.
  async function loadOlderMessages() {
    const projectHash = activeSession?.project_hash;
    const id = sessionId;
    if (!projectHash || !id || loadingOlder) return;
    // 注意：这里**不调 backfillCausalGaps**。
    // 「向上展开」本身就是从当前首行往前翻一页；再并发补“因果缺口”会用另一套
    // offset 写同一张画布，两者互相覆盖，表现为消息篡位/重复/缺失。
    // 缺口补齐只保留“回前台空闲时段”那一条路径。
    // 偏移量可能已经归零（画布头部就在会话开头），但只要首行带服务端 seq，
    // 仍可用 `before_seq` 真正往前翻。旧实现直接 return，于是「向上展开」变成
    // 一个点了没反应的幽灵按钮。
    const headSeqNow = messagesRef.current[0]?.seq;
    if (!canLoadOlder({ hasOlder: true, offset: historyOffsetRef.current, headSeq: headSeqNow })) return;
    // Loading history is reader intent: stop the bottom-follow and keep the
    // pre-prepend reading anchor instead of letting the 350ms initial settle
    // pull the transcript back to the tail.
    initialPinPendingRef.current = false;
    timelineFollow.pause();
    const generation = sessionGenerationRef.current;
    const prevOffset = historyOffsetRef.current;
    const page = prevOffset > 0 ? Math.min(HISTORY_PAGE, prevOffset) : HISTORY_PAGE;
    const nextOffset = Math.max(0, prevOffset - page);

    // Warm switch trims the DOM to the active window but keeps the full canvas
    // in L1. Expand instantly from that in-memory copy before touching the disk:
    // this is the "早先历史在内存中完整保留，展开时 0ms 补齐" contract, and it
    // also avoids a disk page whose boundary could split tool calls from results.
    let cachedFull = messageCacheRef.current.get(id);
    // A session switch can leave L1 with only the 42-row active window while L2
    // still has the complete 179-row canvas. Hydrate from IndexedDB before the
    // network fallback so offline "load earlier" keeps working instead of
    // ending in Failed to fetch with a half-filled transcript.
    const cachedIdb = await getSessionCache(projectHash, id, { preferPersisted: true });
    if (cachedIdb?.messages?.length && (!cachedFull || cachedIdb.messages.length > cachedFull.length)) {
      cachedFull = cachedIdb.messages;
      messageCacheRef.current.set(id, cachedFull);
    }
    if (cachedFull && cachedFull.length > 0) {
      const cachedOlder = cachedFull.filter(
        (m) => typeof m.sourceIndex === 'number' && m.sourceIndex >= nextOffset && m.sourceIndex < prevOffset,
      );
      if (cachedOlder.length > 0) {
        const earliest = Math.min(...cachedOlder.map((m) => m.sourceIndex!));
        const firstTurnIdx = turnOutlineRef.current[0]?.index ?? 0;
        const olderExists = hasOlderVisibleMessages({
          offset: earliest,
          firstTurnIndex: firstTurnIdx,
          canvasHasFirstTurn:
            messagesRef.current.some(
              (m) => typeof m.sourceIndex === 'number' && m.sourceIndex <= firstTurnIdx,
            ) ||
            cachedOlder.some(
              (m) => typeof m.sourceIndex === 'number' && m.sourceIndex <= firstTurnIdx,
            ),
        });
        const root = scrollRef.current;
        const prevHeight = root?.scrollHeight ?? 0;
        const prevTop = root?.scrollTop ?? 0;
        const beforeLen = messagesRef.current.length;
        setMessages({ type: 'older', rows: cachedOlder });
        if (messagesRef.current.length === beforeLen) {
          // 这一页全部是画布已有的行（同步异常导致游标与画布错位）：
          // 再点也只会闪一下 —— 直接收起入口，绝不留下幽灵按钮。
          setHasOlder(false);
          hasOlderBySessionRef.current.set(id, false);
          return;
        }
        historyOffsetRef.current = earliest;
        setHasOlder(olderExists);
        historyOffsetBySessionRef.current.set(id, earliest);
        hasOlderBySessionRef.current.set(id, olderExists);
        requestAnimationFrame(() => {
          if (activeIdRef.current !== id || sessionGenerationRef.current !== generation) return;
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
        });
        return;
      }
    }

    setLoadingOlder(true);
    const root = scrollRef.current;
    const prevHeight = root?.scrollHeight ?? 0;
    const prevTop = root?.scrollTop ?? 0;
    const beforeLen = messagesRef.current.length;
    try {
      // Prefer the identity-first cursor. `seq` comes from the server and is
      // stable across pinned/paged windows; fall back to offset for old daemons.
      const headSeq = messagesRef.current[0]?.seq;
      let detail = headSeq != null && headSeq > 0
        ? await pullSession({ projectHash, sessionId: id, mode: 'older', beforeSeq: headSeq, limit: page })
        : await pullSession({ projectHash, sessionId: id, mode: 'older', offset: nextOffset, limit: page });
      if (
        activeIdRef.current !== id ||
        sessionGenerationRef.current !== generation
      ) return;
      let older = sessionMessagesToDisplay(detail.messages, detail.offset ?? nextOffset);
      // 若按 beforeSeq 没拉到消息，但已知上一轮历史 offset 仍大于首问，说明首行 seq 游标存在偏差，自动回退按 offset 补翻一次！
      if (older.length === 0 && headSeq != null && prevOffset > 0) {
        detail = await pullSession({ projectHash, sessionId: id, mode: 'older', offset: nextOffset, limit: page });
        if (
          activeIdRef.current !== id ||
          sessionGenerationRef.current !== generation
        ) return;
        older = sessionMessagesToDisplay(detail.messages, detail.offset ?? nextOffset);
      }
      if (older.length === 0) {
        // 真的到顶了：立刻收起入口，绝不留下一个点了没反应的幽灵按钮。
        historyOffsetRef.current = 0;
        setHasOlder(false);
        hasOlderBySessionRef.current.set(id, false);
        historyOffsetBySessionRef.current.set(id, 0);
        return;
      }
      const newOffset = detail.offset ?? nextOffset;
      const newTotal = detail.message_count ?? historyTotalRef.current;
      const firstTurnIdx = detail.turns?.[0]?.index ?? (turnOutlineRef.current[0]?.index ?? 0);
      const olderHeadSeq = oldestDisplaySeq(older);
      const effectiveOlderExists = computeEffectiveHasOlder({
        offset: newOffset,
        firstTurnIndex: firstTurnIdx,
        canvasHasFirstTurn: older.some((m) => typeof m.sourceIndex === 'number' && m.sourceIndex <= firstTurnIdx),
        oldestSeq: olderHeadSeq ?? oldestDisplaySeq(detail.messages),
        firstTurnSeq: detail.turns?.[0]?.seq,
        canvasHeadSeq: oldestDisplaySeq(messagesRef.current),
        pageHeadSeq: olderHeadSeq,
      });
      historyOffsetRef.current = newOffset;
      historyTotalRef.current = newTotal;
      setHasOlder(effectiveOlderExists);
      historyOffsetBySessionRef.current.set(id, newOffset);
      historyTotalBySessionRef.current.set(id, newTotal);
      hasOlderBySessionRef.current.set(id, effectiveOlderExists);
      if (detail.turns && detail.turns.length > 0) {
        const mergedTurns = mergeServerWithLocalOutline(detail.turns, turnOutlineRef.current);
        turnOutlineBySessionRef.current.set(id, mergedTurns);
        setTurnOutline(mergedTurns);
      }
      setMessages({ type: 'older', rows: older });
      const next = messagesRef.current;
      if (next.length === beforeLen) {
        // 服务端这一页没有任何“上画布的新行”（全是重复身份）：
        // 继续显示「向上展开」只会点一次闪一次，直接判定到顶。
        historyOffsetRef.current = 0;
        setHasOlder(false);
        hasOlderBySessionRef.current.set(id, false);
        historyOffsetBySessionRef.current.set(id, 0);
        return;
      }
      messageCacheRef.current.set(id, next);
        if (projectHash) {
          commitCanvasCache(projectHash, id, {
            messages: next,
            turns: detail.turns,
            historyOffset: newOffset,
            historyTotal: newTotal,
            revision: detail.revision,
          });
        }
      requestAnimationFrame(() => {
        if (
          activeIdRef.current !== id ||
          sessionGenerationRef.current !== generation
        ) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    } catch {
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation
      ) historyOffsetRef.current = prevOffset;
    } finally {
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation
      ) setLoadingOlder(false);
    }
  }

  async function reloadSessionTranscript(id: string, projectHashOverride?: string) {
    const projectHash = projectHashOverride || activeSession?.project_hash;
    if (!projectHash) return;
    const generation = sessionGenerationRef.current;
    try {
      // 压缩/回溯会让转录变短，旧的分页 offset 可能已经越过新的尾部；
      // 再按 offset 拉取会得到空窗口，把画布清空并切回落地页。
      // 这里始终重拉权威尾部，并按响应重置 offset/total 与大纲。
      const detail = await pullSession({ projectHash, sessionId: id, mode: 'snapshot', limit: HISTORY_PAGE });
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation
      ) {
        if (!Array.isArray(detail.messages)) return;
        const loaded = sessionMessagesToDisplay(
          detail.messages,
          detail.offset ?? 0,
          detail.pinned_user_index,
        );
        const newOffset = detail.offset ?? 0;
        const newTotal = detail.message_count ?? (newOffset + loaded.length);
        // A partial/empty window for a non-empty transcript must not clear the
        // canvas: that flips the whole view into the landing layout.
        if (loaded.length === 0 && newTotal > 0) return;
        const firstTurnIdx = detail.turns?.[0]?.index ?? 0;
        const olderExists = hasOlderVisibleMessages({ offset: newOffset, firstTurnIndex: firstTurnIdx });
        historyTotalRef.current = newTotal;
        historyOffsetRef.current = newOffset;
        setHasOlder(olderExists);
        historyOffsetBySessionRef.current.set(id, newOffset);
        historyTotalBySessionRef.current.set(id, newTotal);
        hasOlderBySessionRef.current.set(id, olderExists);
        // 压缩会重排/删除转录行，旧大纲的绝对下标已经失效；但 pending steer
        // 不是“旧下标”，它必须在重载后继续存在。按 identity 合并，服务端行
        // 覆盖坐标，provisional/更晚的本地行保留。
        if (Array.isArray(detail.turns)) {
          const nextOutline = mergeServerWithLocalOutline(detail.turns, turnOutlineRef.current);
          turnOutlineRef.current = nextOutline;
          turnOutlineBySessionRef.current.set(id, nextOutline);
          setTurnOutline(nextOutline);
        }
        messagesRef.current = loaded;
        messageCacheRef.current.set(id, loaded);
        setMessages({ type: 'replace', rows: loaded });
        noteCacheRevision(id, detail.revision);
        setHistoryHint(null);
        scheduleCanvasCacheSave();
        writeLiveTodo(id, reduceLiveTodo(null, { type: 'hydrate', items: detail.todos ?? [] }));
        if (typeof detail.todos_revision === 'number') {
          todoRevisionBySessionRef.current.set(id, detail.todos_revision);
        }
        seedAppliedTodoIds(id, todoCallIdsFromMessages(loaded));
      }
    } catch { /* refresh failure is non-fatal; the notice still gives feedback */ }
  }

  // ── Shared mode / provider switch helpers ──────────────────────────────────
  // Defined in render scope (not memoized) so they always close over the latest
  // modeState / sync. Both call sites — ModeSelector.onChange / slashHandlers
  // and ModelSelector.onChange / slashHandlers — call these directly.

  /** Initiate a mode switch. onConfirmed is called with the server-confirmed
   *  mode after the backend round-trip completes (used by slash commands to
   *  emit a notice with the ACTUAL confirmed mode, not the requested one). */
  function switchMode(m: ApprovalMode, onConfirmed?: (confirmed: ApprovalMode) => void) {
    if (modeState.pendingMode) return;
    const nextState = beginModeSwitch(modeState, m);
    if (nextState === modeState) return;
    // Capture the origin session: the round-trip may outlive a view switch and
    // must never apply its result to whichever session the user moved to.
    const targetSid = sessionId ?? null;
    const stillOnTarget = () => (activeIdRef.current ?? null) === targetSid;
    // 全局开启时，切换改变的是全局模式，不写入任何会话级缓存：
    // 关掉全局后各会话必须能回到自己原来的模式。
    const writeModeCache = !globalModeRef.current;
    setModeState(nextState);
    if (!protocolSessionRef.current) nativeModeRef.current = m;
    if (targetSid && writeModeCache) {
      modeCacheRef.current.set(targetSid, m);
      const hash = projectHashBySessionRef.current.get(targetSid) || viewedProjectHashRef.current;
      if (hash) updateSessionCacheMeta(hash, targetSid, { approvalMode: m });
    }
    if (m === 'bypass') {
      onPermissionResolved?.(null);
    }
    void postLiveMode(m, targetSid, undefined)
      .then((confirmed) => {
        // The cache is per-session and always authoritative for that session.
        if (targetSid && writeModeCache) {
          modeCacheRef.current.set(targetSid, confirmed);
          const hash =
            projectHashBySessionRef.current.get(targetSid) || viewedProjectHashRef.current;
          if (hash) updateSessionCacheMeta(hash, targetSid, { approvalMode: confirmed });
        }
        if (!stillOnTarget()) return;
        setModeState((cur) => completeModeSwitch(cur, confirmed));
        onConfirmed?.(confirmed);
        if (confirmed === 'bypass') {
          onPermissionResolved?.(null);
        }
        // Backend may reject (runtime busy) and echo the previous mode — surface that.
        if (confirmed !== m) {
          showToast(
            t('cmd.mode.rejected', { requested: m, confirmed }),
            'warning',
          );
        }
      })
      .catch(() => {
        if (targetSid && writeModeCache) {
          modeCacheRef.current.set(targetSid, modeState.confirmedMode);
        }
        if (!stillOnTarget()) return;
        setModeState((cur) => failModeSwitch(cur));
        showToast(t('cmd.mode.failed'), 'error');
      });
  }

  /**
   * 全局关闭后恢复该会话自己的模式。
   *
   * 优先读本地已知值（会话级缓存 → 会话列表元数据），均为 0 网络；
   * 只有两者都缺失（例如本端从未看过该会话）时才拉一次 `/approval_mode`。
   * 这样「关闭全局」的代价是一条广播帧，而不是 N 个会话的请求。
   */
  function applyOwnSessionMode(sid: string) {
    // 只用会话级缓存：会话列表元数据在全局开启期间被服务端报成了全局值，
    // 此刻读它会拿到刚刚失效的全局模式。缓存缺失时多拉一次，依然是一次小请求。
    const local = modeCacheRef.current.get(sid) ?? null;
    if (local) {
      if (activeIdRef.current !== sid) return;
      nativeModeRef.current = local;
      setModeState(initModeState(local));
      return;
    }
    getApprovalModeState(sid)
      .then((cur) => {
        if (activeIdRef.current !== sid) return;
        modeCacheRef.current.set(sid, cur.mode);
        nativeModeRef.current = cur.mode;
        setModeState(initModeState(cur.mode));
      })
      .catch(() => {});
  }
  applyOwnSessionModeRef.current = applyOwnSessionMode;

  /**
   * 切换「全局」胶囊开关。
   *
   * 开启：把当前确认模式提升为全局，所有会话（含后台运行中）立即跟随；
   * 关闭：各会话恢复自己记录的模式（本地已知值即可，无需逐会话拉取）。
   * 两次都是单次 RPC + 一条广播，无轮询。
   */
  function toggleGlobalMode(enabled: boolean) {
    const previous = globalModeRef.current;
    if (previous === enabled) return;
    setGlobalModeEnabled(enabled);
    const targetSid = sessionId ?? null;
    const requested = modeState.confirmedMode;
    void postLiveMode(requested, targetSid, enabled)
      .then((confirmed) => {
        setModeState(initModeState(confirmed));
        nativeModeRef.current = confirmed;
        if (enabled) return;
        // 关闭全局：恢复当前会话自己的模式（服务端已按会话重下发）。
        if (targetSid) applyOwnSessionMode(targetSid);
      })
      .catch(() => {
        setGlobalModeEnabled(previous);
        showToast(t('cmd.mode.failed'), 'error');
      });
  }

  /** Switch the active provider and notify the backend immediately so default model persists and syncs. */
  function switchProvider(name: string) {
    providerPinnedRef.current = true;
    providerCacheRef.current.set(providerCacheKey(sessionId), name);
    const targetSid = sessionId ?? null;
    if (targetSid) {
      const hash = projectHashBySessionRef.current.get(targetSid) || viewedProjectHashRef.current;
      if (hash) updateSessionCacheMeta(hash, targetSid, { preferredModel: name });
    }
    const previous = provider;
    setProvider(name);
    void postLiveProvider(name, sessionId).then((res) => {
      if (res.ok) return;
      if (res.activeTurn) {
        showToast(t('cmd.model.deferred'), 'warning');
        return;
      }
      setProvider(previous);
      providerPinnedRef.current = false;
      if (previous) {
        providerCacheRef.current.set(providerCacheKey(sessionId), previous);
      } else {
        providerCacheRef.current.delete(providerCacheKey(sessionId));
      }
      showToast(res.error ?? t('cmd.model.syncBusy'), 'error');
    }).catch((error) => {
      setProvider(previous);
      providerPinnedRef.current = false;
      if (previous) {
        providerCacheRef.current.set(providerCacheKey(sessionId), previous);
      } else {
        providerCacheRef.current.delete(providerCacheKey(sessionId));
      }
      setHistoryHint(t('chat.connError', { msg: String(error) }));
    });
  }

  const slashHandlers: SlashHandlers = useMemo(
    () => ({
      // setMode: 委托给 switchMode；notice 用后端确认的模式（非请求的模式）。
      setMode: (m) => {
        switchMode(m, (confirmed) => showToast(t('cmd.mode.done', { mode: confirmed }), 'info'));
      },
      // openModelPicker: ModelSelector 是自包含组件，无法从外部以编程方式打开。
      openModelPicker: () => { showToast(t('cmd.model.openHint'), 'info'); },
      // setProvider: 委托给 switchProvider（实时同步 + 本地状态）。
      setProvider: (name) => {
        switchProvider(name);
      },
      // changeDir: 直接调 api.ts 的 changeDir（POST /cd），并把新目录上报给 App。
      changeDir: async (path) => {
        const res = await changeDir(path);
        if (res.success) {
          onCwdChanged?.(res.current_dir);
          pushCommandNotice(t('cmd.cd.done', { dir: res.current_dir }));
        } else {
          pushCommandNotice(res.message);
        }
      },
      // openSessionSidebar: 侧栏开关状态在 App，Chat 无此 prop。
      openSessionSidebar: () => { onOpenSidebar?.(); },
      openNewSession: () => { onNewSession?.(); },
      clearScreen: () => { pushCommandNotice(t('cmd.clear.desc')); },
      // reloadConfig: POST /config/reload（服务端同时重挂 MCP / skills）。
      reloadConfig: async () => {
        await postConfigReload();
        pushCommandNotice(t('cmd.reload.done'));
      },
      mcpCommand: async (arg) => {
        const sub = arg.trim().toLowerCase();
        const tt = t as (k: string, p?: Record<string, string | number>) => string;
        try {
          if (sub === 'reload' || sub === 'refresh') {
            await postMcpReload();
            const status = await getMcpStatus();
            pushCommandNotice(`${t('cmd.mcp.reload.done')}\n${formatMcpStatusText(status.servers, status.blocked, tt)}`);
            return;
          }
          if (sub === 'trust') {
            const result = await postLiveMcpTrust();
            if (result.ok) {
              try { await postMcpReload(); } catch { /* older daemon */ }
              const status = await getMcpStatus();
              pushCommandNotice(`${t('cmd.mcp.trust.ok')}\n${formatMcpStatusText(status.servers, status.blocked, tt)}`);
            } else {
              pushCommandNotice(t('cmd.mcp.trust.failed', { error: result.error ?? 'trust failed' }));
            }
            return;
          }
          const status = await getMcpStatus();
          pushCommandNotice(formatMcpStatusText(status.servers, status.blocked, tt));
        } catch (e) {
          pushCommandNotice(t('cmd.mcp.reload.failed', { error: e instanceof Error ? e.message : String(e) }));
        }
      },
      openSlashSkillsMenu: () => {
        // Open a pure SKILLS browser (not the full '/' command list — that's what
        // made running /skills look like it "reset to /"). Input stays '/', but the
        // menu shows only skills; typing anything drops back to normal filtering.
        // Trigger the skills fetch if it hasn't been loaded yet.
        setInput('/');
        setSlashQuery('');
        setSlashIndex(0);
        setSlashSkillsOnly(true);
        if (slashSkills === null && !slashLoading) {
          setSlashLoading(true);
          getSkills()
            .then(setSlashSkills)
            .catch(() => setSlashSkills([]))
            .finally(() => setSlashLoading(false));
        }
        setSlashOpen(true);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(1, 1);
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
        });
      },
      notice: (text) => pushCommandNotice(text),
      submitPrompt: (text) => {
        if (busyRef.current) {
          setQueued((q) => [
            ...q,
            {
              id: randomUUID(),
              text,
              approvalMode: modeState.confirmedMode,
              kind: 'queue' as const,
            },
          ]);
          return;
        }
        return deliver(text, [], modeState.confirmedMode).then(() => undefined);
      },
      execServerCommand: async (command, arg) => {
        const SESSION_MUTATING = new Set(['undo', 'compact']);
        if (SESSION_MUTATING.has(command)) {
          if (busyRef.current) { showToast(t('cmd.session.busy'), 'warning'); return; }
        }
        const isCompact = command === 'compact';
        // 命令受理期间的会话身份必须冻结：压缩/回溯期间切换会话不能让回执
        // 去重载另一个会话（也不能拿另一个项目的 project_hash 去拉历史）。
        const compactSid = sessionId ?? activeIdRef.current;
        const compactHash = activeSession?.project_hash;
        if (isCompact) {
          // 本地压缩意图先占一个更高的 revision：服务器尚未 admit 时的旧快照
          // （phase=null）不得把用户刚点下的压缩标记抹掉；真正的 start 事件
          // 会以同一/更高 revision 覆盖它。
          if (compactSid) {
            runtimeRevisionBySessionRef.current.set(
              compactSid,
              (runtimeRevisionBySessionRef.current.get(compactSid) ?? 0) + 1,
            );
          }
          setSessionCompacting(compactSid, true, Date.now());
          setBusyAndClock(true, Date.now());
          busyRef.current = true;
          if (compactSid) {
            localTurnSessionsRef.current.add(compactSid);
            onTurnRunningChange?.(compactSid, true);
          }
        }
        try {
          let res: CommandResult;
          try {
            res = await postCommand({
              command,
              arg,
              session_id: compactSid ?? undefined,
              working_dir: effectiveWorkingDir ?? undefined,
              project_hash: compactHash ?? undefined,
              provider: provider ?? undefined,
            });
          } catch (e) {
            if (isCompact) setSessionCompacting(compactSid, false);
            if (isCompact) retireCompactPendingNotice();
            pushCommandNotice(t('chat.connError', { msg: e instanceof Error ? e.message : String(e) }));
            return;
          }
          if (res.kind === 'error') {
            if (isCompact) setSessionCompacting(compactSid, false);
            if (isCompact) retireCompactPendingNotice();
            pushCommandNotice(res.message);
            return;
          }
          if (res.kind === 'undo') {
            if (res.undone > 0 && compactSid) await reloadSessionTranscript(compactSid, compactHash);
            pushCommandNotice(res.undone > 0 ? t('cmd.undo.done', { n: res.undone }) : t('cmd.undo.none'));
            return;
          }
          if (res.kind === 'remember') { pushCommandNotice(t('cmd.remember.done', { scope: res.scope })); return; }
          if (res.kind === 'forget') { pushCommandNotice(t('cmd.forget.done', { n: res.removed.length })); return; }
          if (res.kind === 'memory') {
            const lines = [...res.global.map((e) => `[global] ${e}`), ...res.project.map((e) => `[project] ${e}`)];
            pushCommandNotice(lines.length ? `${t('cmd.memory.header')}\n${lines.join('\n')}` : t('cmd.memory.empty'));
            return;
          }
          if (res.kind === 'compact') {
            setSessionCompacting(compactSid, false);
            retireCompactPendingNotice();
            if (res.applied) {
              if (compactSid) await reloadSessionTranscript(compactSid, compactHash);
              const alreadyHasNotice = hasRecentCompactionNotice(messagesRef.current);
              if (!alreadyHasNotice) {
                pushCommandNotice(
                  t('cmd.compact.done', { n: res.removed_messages, before: res.before_tokens, after: res.after_tokens }),
                  { forceTail: true },
                );
              }
              tokenCacheRef.current = resetTokenCacheState(res.after_tokens);
              setTokens({ prompt: res.after_tokens, completion: 0, total: res.after_tokens, cached: 0, cached_estimated: false });
              // 压缩后的占用必须成为本会话的当前事实：内存快照 + 缓存都要落，
              // 否则刷新/切走再回来会被压缩前的旧 usage 覆盖。
              if (compactSid) {
                const compactCacheState = { lastPrompt: res.after_tokens, providerReportsCache: false };
                tokenUsageCacheRef.current.set(compactSid, {
                  tokens: {
                    prompt: res.after_tokens,
                    completion: 0,
                    total: res.after_tokens,
                    cached: 0,
                    cached_estimated: false,
                    reasoning: 0,
                  },
                  cacheState: compactCacheState,
                  authoritative: false,
                  compacted: true,
                });
                tokenCacheRef.current = { ...compactCacheState };
                scheduleCanvasCacheSave();
              }
            } else {
              pushCommandNotice(t('cmd.compact.none'), { forceTail: true });
            }
            return;
          }
          if (res.kind === 'context') {
            pushCommandNotice(
              t('cmd.context.body', {
                used: res.used_tokens, msgs: res.total_messages,
                pct: Math.round(res.utilization * 100),
                window: res.ctx_window, name: res.ctx_name,
              })
            );
            tokenCacheRef.current = resetTokenCacheState(res.used_tokens);
            setTokens({ prompt: res.used_tokens, completion: 0, total: res.used_tokens, cached: 0, cached_estimated: false });
            return;
          }
          if (res.kind === 'whoami') {
            pushCommandNotice(res.logged_in
              ? t('cmd.whoami.body', { name: res.name ?? res.username ?? '', user: res.username ?? '', email: res.email ?? '—' })
              : t('cmd.whoami.none'));
            return;
          }
          if (res.kind === 'status') {
            pushCommandNotice(res.text);
            return;
          }
          if (res.kind === 'config') { pushCommandNotice(t('cmd.config.body', { path: res.path, provider: res.provider || '—' })); return; }
          if (res.kind === 'diff') { pushCommandNotice(res.stat.trim() ? res.stat : t('cmd.diff.clean')); return; }
          if (res.kind === 'cost') { pushCommandNotice(t('cmd.cost.body', { tokens: res.total_tokens, turns: res.turn_count })); return; }
          if (res.kind === 'todo') {
            if (!res.items.length) { pushCommandNotice(t('cmd.todo.empty')); return; }
            const mark = (s: string) => (s === 'completed' ? '[√]' : s === 'in_progress' ? '[~]' : '[ ]');
            pushCommandNotice(`${t('cmd.todo.header')}\n${res.items.map((i) => `${mark(i.status)} ${i.content}`).join('\n')}`);
            return;
          }
        } finally {
          if (isCompact) {
            setSessionCompacting(compactSid, false);
            retireCompactPendingNotice();
            // 手动压缩不是模型回答回合，不能把压缩耗时盖到上一条 assistant 的 elapsedMs 上。
            setBusyAndClock(false, undefined, { stamp: false });
            busyRef.current = false;
            if (compactSid) {
              localTurnSessionsRef.current.delete(compactSid);
              onTurnRunningChange?.(compactSid, false);
            }
          }
        }
      },
      initProject: () => {
        setConfirmModal({
          open: true,
          title: t('confirm.initTitle'),
          body: t('confirm.initBody'),
          icon: '🗺️',
          danger: false,
          confirmLabel: t('confirm.confirmedBtn'),
          cancelLabel: t('common.cancel'),
          onConfirm: async () => {
            setRightPanelCollapsed(false);
            setRightPanelTab('terminal');
            requestAnimationFrame(() => {
              window.dispatchEvent(
                new CustomEvent('jeikcode:terminal:run_command', {
                  detail: {
                    command: 'jeikcode init --force',
                  },
                })
              );
            });
          },
        });
      },
      t,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, modeState, onCwdChanged, slashSkills, slashLoading, sessionId, cwd, activeSession, provider, messages.length],
  );

  // Append a non-fatal advisory as its OWN notice part (never merged into a text run,
  // never styled as an error). Mirrors appendToLastAssistant's last-assistant guard.
  function pushNoticeToLastAssistant(text: string, messageId?: string) {
    const noticeId = messageId ? `notice-${messageId}` : `notice-${randomUUID()}`;
    setMessages({ type: 'notice', text, targetId: messageId, id: noticeId });
    const currentSid = sessionId ?? activeIdRef.current;
    if (currentSid) {
      messageCacheRef.current.set(currentSid, messagesRef.current);
    }
  }

  function pushRateLimitedToLastAssistant(text: string, targetId?: string) {
    // `targetId` is the assistant round this card belongs to; `id` is the card's
    // own row identity. The old code reused the target id as the new row id,
    // which guaranteed no anchor match and always appended a tail row.
    const rlId = targetId ? `rl-${targetId}` : `rl-${randomUUID()}`;
    setMessages({ type: 'rate_limited', text, targetId, id: rlId });
    const currentSid = sessionId ?? activeIdRef.current;
    if (currentSid) messageCacheRef.current.set(currentSid, messagesRef.current);
  }

  function updateToolInLastAssistant(
    id: string,
    update: Partial<ToolRow>,
    /** Optional second pass: derive extra fields from the CURRENT row (e.g. settle
     *  subtask rows from the authoritative tool output). Return undefined for no-op. */
    derive?: (tool: ToolRow) => Partial<ToolRow> | undefined,
  ) {
    setMessages({ type: 'tool_update', id, update, derive });
  }

  function finalizePendingToolsOnCanvas() {
    const follow = timelineFollowRef.current;
    follow?.beginSwap();
    setMessages({ type: 'finalize_tools' });
    follow?.endSwap();
  }

  function closeOpenArtifactFence() {
    if (!artifactOpenRef.current) return;
    artifactOpenRef.current = false;
    const fenceLen = artifactFenceLenRef.current || 3;
    const marker = '`'.repeat(fenceLen);
    appendToLastAssistant('\n' + marker + '\n', { skipReplayDedup: true });
    artifactFenceLenRef.current = 3;
    if (activeIdRef.current) artifactOpenBySessionRef.current.delete(activeIdRef.current);
  }

  function addToolToLastAssistant(tool: ToolRow, messageId?: string) {
    setMessages({ type: 'tool_start', tool, messageId });
  }

  /**
   * 对标 opencode 多会话后台推送体系：
   * 当用户切到其他会话时，本会话的流式读者在后台持续存活并接收事件，
   * 实时将事件（text, reasoning, tool_start, tool_output, tool_result, done）沉淀进对应会话的缓存字典中。
   * 彻底实现：后台任务完成后切回会话，最后一条正文与工具结果 0ms 纯内存即现，无需刷新，绝不丢失！
   */
  function applyEventToSessionCache(targetSid: string, event: SSEEvent) {
    if (event.type === 'steered') {
      foldSteeredInputs(
        event.inputs ?? [],
        event.client_input_ids,
        targetSid,
        (event as any).timestamps,
        {
          seq: (event as { seq?: number }).seq,
          ...(anchorForSteer(event) ? { replay: true, anchor: anchorForSteer(event) } : {}),
        },
      );
      return;
    }
    if (event.type === 'context_compacted') {
      // No usage event follows a compaction: refresh the background session's
      // cached context meter immediately so switching back never shows the
      // pre-compaction number.
      const prompt = Math.max(0, event.tokens);
      tokenUsageCacheRef.current.set(targetSid, {
        tokens: {
          prompt,
          completion: 0,
          total: prompt,
          cached: 0,
          cached_estimated: false,
          reasoning: 0,
        },
        cacheState: {
          lastPrompt: prompt,
          providerReportsCache: false,
        },
        authoritative: false,
        compacted: true,
      });
      return;
    }
    const msgs = messageCacheRef.current.get(targetSid);
    if (!msgs || msgs.length === 0) return;
    if (event.type === 'display_notice') {
      messageCacheRef.current.set(
        targetSid,
        reduceCanvasEvent(msgs, {
          type: 'authoritative_notice',
          id: event.id,
          seq: event.display_seq,
          text: event.text,
          ts: event.created_at,
        }),
      );
      return;
    }
    if (event.type === 'user_identified') {
      turnUserAnchorBySessionRef.current.set(targetSid, event.message_id);
      const alreadyOnCache = msgs.some(
        (m) => m.role === 'user' && (m.id === event.message_id || m.clientInputId === event.message_id),
      );
      if (!alreadyOnCache && event.message_id) {
        const bgQueued = queuedBySessionRef.current.get(targetSid) ?? [];
        const matchedSteer = bgQueued.find(
          (item) =>
            item.clientInputId === event.message_id &&
            (item.kind === 'steer' || item.kind === 'steering'),
        );
        if (matchedSteer) {
          foldSteeredInputs(
            [{ text: matchedSteer.text, images: matchedSteer.images, message_id: event.message_id }],
            [matchedSteer.clientInputId ?? null],
            targetSid,
            [matchedSteer.createdAt],
          );
          return;
        }
      }
      messageCacheRef.current.set(targetSid, bindUserMessageIdentity(msgs, event.message_id));
      return;
    }
    if (event.type === 'text') {
      // 与前台 `handleEvent` 同一个 reducer：身份盖章 / 段合并 / 去重规则完全一致，
      // 否则切回会话时同一帧会得到与实时渲染不同的结果。
      messageCacheRef.current.set(targetSid, reduceCanvasEvent(msgs, {
        type: 'text',
        content: event.content,
        replay: (event as { replay?: boolean }).replay === true,
        messageId: event.message_id,
        partId: event.part_id,
        partRev: event.part_rev,
      }));
      return;
    }
    if (event.type === 'artifact_start') {
      if (event.id?.startsWith('file-')) {
        artifactOpenBySessionRef.current.delete(targetSid);
        return;
      }
      const lang = (event.language ?? '').trim();
      const fenceLen = typeof event.fence_len === 'number' && event.fence_len >= 3 ? event.fence_len : 3;
      const marker = '`'.repeat(fenceLen);
      const fence = (lang ? marker + lang : marker) + '\n';
      const lastMsg = msgs[msgs.length - 1];
      let prefix = '';
      if (lastMsg && lastMsg.role === 'assistant') {
        const lastPart = lastMsg.parts[lastMsg.parts.length - 1];
        if (lastPart && lastPart.kind === 'text' && lastPart.text && !lastPart.text.endsWith('\n')) {
          prefix = '\n';
        }
      }
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', prefix + fence));
      artifactOpenBySessionRef.current.set(targetSid, fenceLen);
      return;
    }
    if (event.type === 'artifact_content') {
      if (event.id?.startsWith('file-')) return;
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', event.content));
      return;
    }
    if (event.type === 'artifact_end') {
      if (event.id?.startsWith('file-')) {
        artifactOpenBySessionRef.current.delete(targetSid);
        return;
      }
      const fenceLen = artifactOpenBySessionRef.current.get(targetSid) || 3;
      const marker = '`'.repeat(fenceLen);
      messageCacheRef.current.set(targetSid, paintCachedAssistantDelta(msgs, 'text', '\n' + marker + '\n'));
      artifactOpenBySessionRef.current.delete(targetSid);
      return;
    }
    if (event.type === 'reasoning') {
      messageCacheRef.current.set(targetSid, reduceCanvasEvent(msgs, {
        type: 'reasoning',
        content: event.content,
        replay: (event as { replay?: boolean }).replay === true,
        messageId: event.message_id,
        partId: event.part_id,
        partRev: event.part_rev,
      }));
      return;
    }
    if (event.type === 'warning') {
      messageCacheRef.current.set(
        targetSid,
        paintAssistantNotice(msgs, t('chat.warning', { msg: event.message }), event.message_id)
      );
      return;
    }
    if (event.type === 'user') {
      if (event.internal === true) return;
      const userText = event.display_text ?? visibleUserText(event.content);
      const hasImages = Array.isArray(event.images) && event.images.length > 0;
      if (!userText && !hasImages) return;
      const created = event.created_at && event.created_at > 0 ? event.created_at : Date.now();
      const knownUserId = event.message_id ?? event.client_input_id;
      noteTurnOperation(targetSid, knownUserId);
      if (
        knownUserId &&
        msgs.some((m) => m.role === 'user' && (m.id === knownUserId || m.clientInputId === knownUserId))
      ) {
        return;
      }
      // `/chat/watch` 续传会在头部重发本轮最初的 `opening_user`（如 16:45）。若后台缓存窗口已经
      // 包含更新的用户提问（如 16:56 的转向）或该提问在大纲里位于窗口偏移之上，绝不能把它当成
      // 新消息追加到缓存末尾（否则切回会话时 16:45 会倒挂在 16:56 下方）。
      const backgroundOutline = turnOutlineBySessionRef.current.get(targetSid) ?? [];
      const bgOffset = historyOffsetBySessionRef.current.get(targetSid) ?? 0;
      const outlineHit = [...backgroundOutline]
        .reverse()
        .find((turn) => outlineMatchesPrompt(turn, event.content, knownUserId));
      if (outlineHit && outlineHit.index < bgOffset) {
        return;
      }
      let nextIndex = outlineHit?.index ?? (historyTotalBySessionRef.current.get(targetSid) ?? 0);
      if (outlineHit == null) {
        for (const message of msgs) {
          if (message.sourceIndex != null) nextIndex = Math.max(nextIndex, message.sourceIndex + 1);
        }
      }
      const painted = paintUserMessage(msgs, event.content, created, () => ({
        role: 'user' as const,
        parts: [{ kind: 'text', text: userText }],
        ts: created,
        sourceIndex: nextIndex,
        // 新后端回声直接带落盘 id；后台缓存也必须带上，切回时才能按 id 收敛。
        ...(event.message_id ? { id: event.message_id } : {}),
      }), { clientInputId: knownUserId });
      messageCacheRef.current.set(
        targetSid,
        clearPendingInputFlag(painted, knownUserId),
      );
      // 后台会话的右栏也必须跟着画布走：否则切回来时导航缺最新提问。
      const backgroundOrdinal = backgroundOutline.length > 0
        ? Math.max(...backgroundOutline.map((item) => item.ordinal ?? 0)) + 1
        : 0;
      rememberTurnOutline(
        userText || (hasImages ? '[图片]' : ''),
        nextIndex,
        backgroundOrdinal,
        knownUserId,
        targetSid,
      );
      return;
    }
    if (event.type === 'tool_result' && isTodoTool(event.name)) {
      const fromOutput = parseTodosFromOutput(event.output);
      if (fromOutput && fromOutput.length > 0) {
        writeLiveTodo(
          targetSid,
          reduceLiveTodo(liveTodoDoc(targetSid), { type: 'result', callId: event.id, items: fromOutput }),
        );
      }
    } else if (event.type === 'tool_start' && isTodoTool(event.name)) {
      const argsStr = formatArgs(event.arguments);
      if (argsStr) {
        const appliedIds = appliedTodoIdsFor(targetSid);
        const curTodos = activeTodosBySessionRef.current.get(targetSid) ?? null;
        const nextTodos = foldLiveTodo({
          state: curTodos,
          remembered: curTodos,
          name: event.name,
          args: argsStr,
          callId: event.id,
          appliedIds,
        });
        // 后台会话的折叠同样要落盘幂等键（跨会话重放也不能把清单打回旧状态）。
        persistAppliedTodoIds();
        if (nextTodos && nextTodos.length > 0) {
          writeLiveTodo(
            targetSid,
            reduceLiveTodo(liveTodoDoc(targetSid), { type: 'preview', callId: event.id, items: nextTodos }),
          );
        }
      }
    }

    // 与前台 `handleEvent` 共用同一套纯 reducer（`reduceCanvasEvent`）。
    // 这里曾手写第二份工具/正文合并逻辑，正是「两台端一边 3 个工具、一边 2 个工具」
    // 的直接来源：同样的事件在两份实现里得到不同的 parts 顺序与去重结果。
    let next: Message[] = msgs;

    switch (event.type) {
      case 'tool_start': {
        const argsStr = formatArgs(event.arguments);
        const subtasks = event.name === 'task' ? subtasksFromTaskArgs(argsStr) ?? undefined : undefined;
        next = reduceCanvasEvent(next, {
          type: 'tool_start',
          tool: {
            id: event.id,
            name: event.name,
            args: argsStr,
            status: 'pending',
            ...(subtasks ? { subtasks } : {}),
          },
          messageId: event.message_id,
        });
        break;
      }
      case 'tool_output':
        if (!event.id) break;
        next = reduceCanvasEvent(next, {
          type: 'tool_output',
          id: event.id,
          chunk: event.chunk ?? '',
          replay: (event as { replay?: boolean }).replay === true,
        });
        break;
      case 'tool_finished':
        next = reduceCanvasEvent(next, { type: 'tool_finished', id: event.id, success: event.success });
        break;
      case 'tool_progress':
        next = reduceCanvasEvent(next, { type: 'tool_progress', id: event.id, progress: event.progress });
        break;
      case 'tool_result':
        next = reduceCanvasEvent(next, {
          type: 'tool_result',
          id: event.id,
          name: event.name,
          output: event.output,
          success: event.success,
        });
        break;
      case 'done':
      case 'stopped':
      case 'error': {
        const openFence = artifactOpenBySessionRef.current.get(targetSid);
        if (openFence) {
          artifactOpenBySessionRef.current.delete(targetSid);
          const marker = '`'.repeat(openFence);
          const msgsAfter = messageCacheRef.current.get(targetSid);
          if (msgsAfter && msgsAfter.length > 0) {
            messageCacheRef.current.set(
              targetSid,
              paintCachedAssistantDelta(msgsAfter, 'text', '\n' + marker + '\n')
            );
          }
        }
        backgroundRunningSessionsRef.current.delete(targetSid);
        localTurnSessionsRef.current.delete(targetSid);
        onTurnRunningChange?.(targetSid, false);
        const liveDoc = liveTodoDoc(targetSid);
        const settled = settleLiveTodo(liveDoc);
        if (settled.archive) {
          next = placeArchivedTodos(next, settled.archive, liveDoc?.revision ?? null);
          writeLiveTodo(targetSid, settled.next);
        }
        messageCacheRef.current.set(targetSid, next);
        const ph = projectHashBySessionRef.current.get(targetSid) || viewedProjectHashRef.current || activeSession?.project_hash || '';
        if (ph) {
          void syncSessionCacheFromDisk(ph, targetSid);
        }
        const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((p) => p.length > 0).pop() ?? '';
        const sessionName = activeSession?.name || folder || 'JeikCode';
        const previewText = event.type === 'error' ? (event.message || 'Error occurred') : 'Task completed';
        dispatchSystemNotification({
          title: sessionName,
          body: previewText,
          sessionId: targetSid,
          tag: `${targetSid}:done`,
          postSystemNotifyFn: postSystemNotify,
        });
        break;
      }
    }
    if (next !== msgs) messageCacheRef.current.set(targetSid, next);
  }

  /**
   * 画布反哺缓存（防抖 800ms）。
   *
   * 断点续传只保证「不再重发已画过的帧」，它不负责把画布存下来：如果画布不落缓存，
   * 刷新后画布会退回旧缓存，而游标却已超前 —— 服务器就只补新帧，中间那段直接丢。
   * 所以每处理完一帧就排队一次缓存写入（L1 同步、L2 异步），回合收尾另有强制写入。
   */
  const canvasCacheTimerRef = useRef<number | null>(null);
  /**
   * Persist the UNION of the full L1 canvas and the visible window.
   *
   * A warm switch trims the DOM to its 48-message active window but keeps the
   * full history in `messageCacheRef`. Saving only `messagesRef` overwrote L2
   * with that window on every debounce/turn-end, so the next cold start lost
   * the earlier history all over again. Merge both views instead.
   */
  function canvasCachePayload(target: string): {
    messages: Message[];
    offset: number;
    total: number;
  } {
    const active = activeIdRef.current === target;
    const cached = messageCacheRef.current.get(target);
    // 压缩中的“正在压缩…”占位行是瞬态，绝不能落盘成历史。
    const pendingCompact = compactPendingNoteRef.current;
    const display = active
      ? (pendingCompact
          ? messagesRef.current.filter((m) => m !== pendingCompact)
          : messagesRef.current)
      : [];
    const messages = active
      ? (cached && cached.length > 0 ? mergeOlderMessages(display, cached) : display)
      : (cached ?? []);
    return {
      messages,
      offset:
        historyOffsetBySessionRef.current.get(target) ??
        (active ? historyOffsetRef.current : 0),
      total:
        historyTotalBySessionRef.current.get(target) ??
        (active ? historyTotalRef.current : 0),
    };
  }

  function scheduleCanvasCacheSave() {
    if (canvasCacheTimerRef.current != null) return;
    canvasCacheTimerRef.current = window.setTimeout(() => {
      canvasCacheTimerRef.current = null;
      const target = activeIdRef.current ?? sessionId;
      if (!target) return;
      const hash =
        projectHashBySessionRef.current.get(target) ??
        activeSession?.project_hash ??
        viewedProjectHashRef.current ??
        '';
      if (!hash) return;
      const outline =
        turnOutlineRef.current.length > 0
          ? turnOutlineRef.current
          : turnOutlineBySessionRef.current.get(target) ?? [];
      const payload = canvasCachePayload(target);
      const tokenSnapshot = tokenUsageCacheRef.current.get(target);
      // 缓存必须按 target 会话取状态：禁止把当前视图的 todos 写进后台会话缓存。
      const cacheTodos =
        activeTodosBySessionRef.current.get(target) ??
        (target === activeIdRef.current ? activeTodosRef.current : null);
      commitCanvasCache(hash, target, {
        messages: payload.messages,
        todos: cacheTodos,
        todoRevision: todoRevisionBySessionRef.current.get(target) ?? 0,
        queue: queuedBySessionRef.current.get(target) ?? null,
        queueRevision: queueRevisionBySessionRef.current.get(target) ?? 0,
        turns: outline,
        tokenUsage: tokenSnapshot?.tokens ?? null,
        // 快照存在时总是显式写入布尔值：真实 usage 后为 false（清除压缩标记），
        // 刚压缩后为 true（刷新时优先于服务端压缩前的旧 usage）。
        ...(tokenSnapshot ? { compacted: tokenSnapshot.compacted === true } : {}),
        historyOffset: payload.offset,
        historyTotal: payload.total,
        revision: cacheRevisionBySessionRef.current.get(target),
        phase: busyRef.current ? 'live' : 'terminal',
        operationId: currentOperationBySessionRef.current.get(target) ?? null,
      });
    }, 800);
  }

  // 画布不是只由 SSE 推进：命令提示、压缩完成、停止提示都是本地提交。
  // 没有后续事件时旧的 event-driven 保存永远轮不到它们，刷新就会退回旧缓存。
  useEffect(() => {
    // Keep the debounced snapshot alive during streaming: a refresh mid-turn
    // has no display-log rows yet, so the local cache is the only source of the
    // already-rendered tail until the turn terminal writes the transcript.
    if (loading) return;
    scheduleCanvasCacheSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, turnOutline, loading]);

  /**
   * 直播内容帧本身就是「服务端正在本会话执行」的证据：任何一次过早收尾把 busy
   * 清掉后，下一帧都会把它点亮回来。回放帧不参与（它们只补历史；否则用户刚按下
   * 停止，重连重放会立刻把红方块点亮回去）。
   */
  function noteRunningProofFrame(
    event: SSEEvent,
    opts?: { requireReplayDedup?: boolean },
  ) {
    const explicitReplay = (event as { replay?: boolean }).replay;
    const replay =
      explicitReplay === true ||
      (explicitReplay === undefined && opts?.requireReplayDedup === true);
    if (!isRunningProofFrame(event.type, replay)) return;
    if (busyRef.current) return;
    const sid =
      (event as { session_id?: string }).session_id ??
      activeIdRef.current ??
      sessionId ??
      null;
    // 只点亮当前视图：后台会话的运行态由 activity / 侧栏自己的通道维护。
    if (!sid || sid !== activeIdRef.current) return;
    if (event.type === 'user' || event.type === 'steered') {
      clearManualStopGuard(sid);
    }
    // 用户刚点过停止 / 刚结算完：2.5s 防抖窗口内不让残留旧帧把它弹回去。
    if (isSessionInManualStopGuard(sid)) return;
    if (isTerminalFromOtherTurn(event as { operation_id?: string; session_id?: string }, sid)) return;
    armRunningForSession(sid);
  }

  /** @param opts.observerOnly Reserved for pure third-party observers that must
   *  not own interactive modals. /chat/watch reattach after refresh MUST call
   *  without this flag so Build-mode permission_request is restored. */
  function handleEvent(
    event: SSEEvent,
    opts?: {
      observerOnly?: boolean;
      requireReplayDedup?: boolean;
      repeatUserAfterSettled?: boolean;
      steerAnchor?: TurnUserAnchor;
      targetSid?: string;
    },
  ) {
    if (opts?.targetSid && activeIdRef.current !== opts.targetSid) {
      applyEventToSessionCache(opts.targetSid, event);
      return;
    }
    const observerOnly = opts?.observerOnly === true;
    const requireReplayDedup = opts?.requireReplayDedup === true;
    if (event.type !== 'text') {
      flushPendingText();
    }
    noteRunningProofFrame(event, opts);
    switch (event.type) {
      case 'runtime_info':
        setProvider(event.provider);
        break;
      case 'session_assigned':
        // Bind a brand-new `/chat` conversation before model/provider work can
        // fail or the SSE transport can disappear. Mark the current canvas as
        // already loaded so the App state update cannot replace the optimistic
        // first turn with an empty history fetch.
        // Watch replay also emits this event. Only the tab that already owns
        // POST /chat may claim the turn; an observer or a refresh must keep
        // receiving the rest of the replay.
        {
          const previousId = activeIdRef.current;
          const claim = sessionAssignedClaimsLocalTurn({
            ownsOpenStream:
              abortRef.current !== null || activeStreamRequestIdRef.current !== null,
            previousIdIsLocalTurn: !!(
              previousId && localTurnSessionsRef.current.has(previousId)
            ),
          });
          if (claim) localTurnSessionsRef.current.add(event.session_id);
          // 后台 watcher 的 replay 同样会带 session_assigned。只有事件会话就是当前视图
          // （落地页尚无视图且 App 也没有选中别的会话才算）时才允许认领画布/session id；
          // 用户已切到别的会话时认领会把视图拽回、并把该会话的画布搬进另一个会话的缓存。
          const viewingThisSession =
            previousId === event.session_id ||
            (!previousId && (!sessionId || sessionId === event.session_id));
          if (viewingThisSession) {
            if (previousId && previousId !== event.session_id && messageCacheRef.current.has(previousId)) {
              const cached = messageCacheRef.current.get(previousId);
              if (cached) messageCacheRef.current.set(event.session_id, cached);
            }
            activeIdRef.current = event.session_id;
            loadedForRef.current = event.session_id;
            onSessionId(event.session_id);
          } else {
            onSessionId(event.session_id, { claimView: false });
          }
        }
        break;
      case 'command_output':
        pushCommandNotice(event.text);
        break;
      case 'session_renamed':
        if (!activeIdRef.current || event.session_id === activeIdRef.current) {
          onSessionRenamed?.(event.name);
        }
        break;

      case 'user': {
        // Fan-out / `/chat/watch` admitted-user event. Own `/chat` turns also
        // receive this on the primary SSE after we added fanout — must not
        // re-append or drop the optimistic empty assistant (that made text /
        // reasoning appends no-op while sticky todos still updated).
        if (event.internal === true) break;
        // Server text first; `visibleUserText` only parses protocol strings for
        // legacy daemons that do not send `display_text`.
        const userText = event.display_text ?? visibleUserText(event.content);
        // The user echo carries the client correlation id (= persisted message
        // id). Bind it so a terminal from this turn is accepted by id.
        noteTurnOperation(
          event.session_id ?? sessionId ?? activeIdRef.current,
          event.client_input_id ?? event.message_id,
        );
        const hasImages = Array.isArray(event.images) && event.images.length > 0;
        // 关键防呆拦截：若既无可见文本也无图片附件，绝不能画空气泡！
        if (!userText && !hasImages) {
          break;
        }
        // 优先按服务端回传的客户端关联键精确认领（`/chat` 的 `request_id`）；
        // 无 id（legacy / 第三方端）才退化为文本比对。
        const echoIdx = findPendingSelfEchoIndex(pendingSelfEchoRef.current, event);
        if (echoIdx >= 0) {
          pendingSelfEchoRef.current.splice(echoIdx, 1);
          // 乐观气泡此刻才拿到服务端身份：把关联键盖到那一行上。否则断线重连时回放的
          // 同一条提问会因“行上没有身份”被当成新消息再画一份。
          if (event.client_input_id || event.message_id) {
            setMessages({
              type: 'bind_user',
              clientInputId: event.client_input_id,
              messageId: event.message_id,
            });
            const echoSid = sessionId ?? activeIdRef.current;
            if (echoSid) messageCacheRef.current.set(echoSid, messagesRef.current);
          }
          break;
        }
        // 身份优先：同一条提问已经在画布上（编辑后的行 / 回放 / 跨端回声）绝不能再画第二份。
        // 编辑会保留原 id 改写正文，而重连回放帧可能仍携带**旧正文**；只按
        // `client_input_id` 判重时，缺该字段的回放帧会把旧提问叠加到编辑后的行下面。
        const knownUserId = event.message_id ?? event.client_input_id;
        if (
          knownUserId
          && messagesRef.current.some(
            (m) => m.role === 'user' && (m.id === knownUserId || m.clientInputId === knownUserId),
          )
        ) {
          break;
        }
        const userTs =
          event.created_at && Number.isFinite(event.created_at) && event.created_at > 0
            ? event.created_at
            : Date.now();
        adoptTurnUserTs(userTs, event.created_at != null && event.created_at > 0);
        // 长回合切回/重连时，`/chat/watch` 会在回放头部补发本轮开场提问 `opening_user`（如 16:45）。
        // 若该提问已经退到当前 48 行尾窗折叠线之上（`outlineHit.index < historyOffsetRef.current`），
        // 绝不能把它当成新消息再次贴到画布最底部重走一遍发送流程！
        const targetSidForUser = event.session_id ?? sessionId ?? activeIdRef.current ?? '';
        const activeOutline =
          (targetSidForUser ? turnOutlineBySessionRef.current.get(targetSidForUser) : undefined) ??
          turnOutlineRef.current;
        const outlineHit = [...activeOutline]
          .reverse()
          .find((turn) => outlineMatchesPrompt(turn, event.content, knownUserId));
        if (outlineHit && outlineHit.index < historyOffsetRef.current) {
          break;
        }
        const userDelta = estimateTextTokens(userText);
        lastUserTokensRef.current = userDelta;
        if (userDelta > 0) {
          setTokens((prev) => mergeLocalTokens(prev, {
            prompt: (prev?.prompt ?? 0) + userDelta,
            completion: prev?.completion ?? 0,
            total: (prev?.total ?? 0) + userDelta,
            reasoning: 0,
          }));
        }
        const turnIndex = nextTurnNavIndex();
        rememberTurnOutline(
          userText,
          turnIndex,
          nextOutlineOrdinal(),
          event.message_id ?? event.client_input_id,
        );
        const userReplay =
          (event as { replay?: boolean }).replay === true || requireReplayDedup;
        setMessages({
          type: 'user',
          text: userText,
          ts: userTs,
          row: {
            images: event.images && event.images.length > 0 ? event.images : undefined,
            ts: userTs,
            ...(event.message_id ? { id: event.message_id } : {}),
            ...(event.editable === false ? { readOnly: true } : {}),
          },
          clientInputId: event.client_input_id,
          repeatAfterSettled: opts?.repeatUserAfterSettled ?? false,
          replay: userReplay,
          promoteId: event.message_id ?? event.client_input_id,
        });
        break;
      }

      case 'steered': {
        foldSteeredInputs(
          event.inputs ?? [],
          event.client_input_ids,
          undefined,
          (event as any).timestamps,
          {
            // 带 replay 标志的才是回放帧；只有未声明 explicit_replay 的旧 daemon
            // 才用 seq 兜底。新 daemon 的 live 帧同样带 seq，不能推断。
            replay: (event as { replay?: boolean }).replay === true
              || (!serverCapsRef.current.includes('explicit_replay')
                && (event as { replay?: boolean }).replay === undefined
                && typeof (event as { seq?: number }).seq === 'number'),
            anchor: anchorForSteer(event) ?? opts?.steerAnchor,
            seq: (event as { seq?: number }).seq,
          },
        );
        break;
      }

      case 'user_identified': {
        // 轮末残留 steer 经内核 drain_pending 作为新回合自然发出时，内核不发 Steered，
        // 仅发 UserMessage -> user_identified。若画布尚无该气泡而队列中挂着同 id 转向卡，
        // 必须在此立即就地升级为用户气泡并记入大纲，否则会出现“大纲有、气泡消失、新轮合入旧轮”。
        if (event.message_id) {
          const alreadyOnCanvas = messagesRef.current.some(
            (m) => m.role === 'user' && (m.id === event.message_id || m.clientInputId === event.message_id),
          );
          if (!alreadyOnCanvas) {
            const matchedSteer = queuedRef.current.find(
              (item) => item.clientInputId === event.message_id,
            );
            if (matchedSteer) {
              foldSteeredInputs(
                [{ text: matchedSteer.text, images: matchedSteer.images, message_id: event.message_id }],
                [matchedSteer.clientInputId ?? null],
                activeIdRef.current ?? sessionId ?? undefined,
                [matchedSteer.createdAt],
              );
            }
          }
        }
        // 身份回传：把乐观用户气泡绑定到落盘消息 id（刷新/切换/回放时按 id 收敛，
        // 不再回退文本启发）。受唯一性守卫保护，幂等。
        setMessages({
          type: 'bind_user',
          messageId: event.message_id,
          clearPendingId: event.message_id,
        });
        // 回放里被折叠线切掉的提问没有下标：用右栏大纲（磁盘显示空间）的同名条目补上。
        // 显示下标只能来自大纲：内核快照下标（wire 不再下发）与它是两套坐标，压缩前缀、
        // 过滤掉的 system-reminder、presentation 行都会让两者相差几十到几百，混用会让
        // 新提问的页码/跳转/改写定位整体错位。大纲还没有这一轮时保留发送时的
        // 显示空间猜测值，等下一次权威大纲到达再收敛。
        let outlineIndex: number | undefined;
        if (turnOutlineRef.current.length > 0) {
          const row = messagesRef.current.find((m) => m.role === 'user' && m.id === event.message_id);
          const rowText = visibleUserText(
            row?.parts.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '',
          );
          if (rowText || event.message_id) {
            outlineIndex = [...turnOutlineRef.current]
              .reverse()
              .find((turn) => outlineMatchesPrompt(turn, rowText, event.message_id))?.index;
          }
        }
        setMessages({
          type: 'stamp_user_source',
          messageId: event.message_id,
          sourceIndex: outlineIndex,
        });
        if (activeIdRef.current) {
          turnUserAnchorBySessionRef.current.set(activeIdRef.current, event.message_id);
        }
        const identifiedSid = sessionId ?? activeIdRef.current;
        if (identifiedSid) messageCacheRef.current.set(identifiedSid, messagesRef.current);
        break;
      }

      case 'text': {
        appendToLastAssistant(
          event.content,
          { requireReplayDedup },
          { messageId: event.message_id, partId: event.part_id, partRev: event.part_rev },
          opts?.targetSid,
        );
        const textDelta = estimateTextTokens(event.content);
        if (textDelta > 0) {
          setTokens((prev) => mergeLocalTokens(prev, {
            prompt: prev?.prompt ?? 0,
            completion: (prev?.completion ?? 0) + textDelta,
            total: (prev?.total ?? 0) + textDelta,
          }));
        }
        break;
      }

      case 'reasoning': {
        // Thinking / chain-of-thought stream — collapsible block in the UI.
        setMessages({
          type: 'reasoning',
          content: event.content,
          replay: requireReplayDedup,
          messageId: event.message_id,
          partId: event.part_id,
          partRev: event.part_rev,
        });
        const rDelta = estimateTextTokens(event.content);
        if (rDelta > 0) {
          setTokens((prev) => mergeLocalTokens(prev, {
            prompt: prev?.prompt ?? 0,
            completion: (prev?.completion ?? 0) + rDelta,
            total: (prev?.total ?? 0) + rDelta,
            reasoning: (prev?.reasoning ?? 0) + rDelta,
          }));
        }
        break;
      }

      case 'tool_start': {
        const argsStr = formatArgs(event.arguments);
        const subtasks =
          event.name === 'task' ? subtasksFromTaskArgs(argsStr) ?? undefined : undefined;
        addToolToLastAssistant({
          id: event.id,
          name: event.name,
          args: argsStr,
          status: 'pending',
          ...(subtasks ? { subtasks } : {}),
        }, event.message_id);
        if (isTodoTool(event.name)) {
          const appliedIds = appliedTodoIdsFor(activeIdRef.current);
          setActiveTodos((cur) => {
            const next = foldLiveTodo({
              state: cur,
              remembered: activeTodosRef.current,
              name: event.name,
              args: argsStr,
              callId: event.id,
              appliedIds,
            });
            // 折叠消费了 callId → 立即落盘，刷新后仍能挡住同一帧的重放。
            persistAppliedTodoIds();
            const sid = activeIdRef.current;
            const doc = reduceLiveTodo(
              liveTodoDoc(sid),
              next && next.length > 0
                ? { type: 'preview', callId: event.id, items: next }
                : { type: 'clear' },
            );
            if (sid) {
              bumpTodoLiveEpoch(sid);
              if (doc) todoLiveBySessionRef.current.set(sid, doc);
              else todoLiveBySessionRef.current.delete(sid);
              if (doc) activeTodosBySessionRef.current.set(sid, doc.items);
              else activeTodosBySessionRef.current.delete(sid);
            }
            activeTodosRef.current = doc?.items ?? null;
            return doc?.items ?? null;
          });
        }
        break;
      }

      case 'tool_output': {
        if (!event.id) break;
        const structuredReplay = (event as { replay?: boolean }).replay === true;
        const legacyReplay = !structuredReplay
          && (event as { replay?: boolean }).replay === undefined
          && requireReplayDedup;
        setMessages({
          type: 'tool_output',
          id: event.id,
          chunk: event.chunk ?? '',
          replay: structuredReplay,
          legacyReplay,
        });
        break;
      }

      case 'tool_progress':
        setMessages({ type: 'tool_progress', id: event.id, progress: event.progress });
        break;

      case 'tool_finished': {
        // 执行已返回 → 先把该行状态落定。权威 `tool_result` 仍按整批发射顺序到达，
        // 所以长批次里的短工具原本要陪着长工具一起“运行中”；这里只动状态，
        // output / duration_ms 仍由权威帧负责。
        updateToolInLastAssistant(event.id, {}, (tool) => settleToolRow(tool, event.success));
        break;
      }

      case 'tool_result': {
        setMessages({
          type: 'tool_result',
          id: event.id,
          name: event.name,
          output: event.output,
          success: event.success,
          durationMs: event.duration_ms,
        });
        if (isTodoTool(event.name)) {
          const authoritativeFromOutput = parseTodosFromOutput(event.output);
          if (authoritativeFromOutput && authoritativeFromOutput.length > 0) {
            writeLiveTodo(
              activeIdRef.current,
              reduceLiveTodo(liveTodoDoc(activeIdRef.current), {
                type: 'result',
                callId: event.id,
                items: authoritativeFromOutput,
              }),
            );
          } else {
            // 兜底回退：若输出中没有标准清单格式，再使用本地折叠
            let foundToolPart: ToolRow | undefined;
            for (let i = messagesRef.current.length - 1; i >= 0; i--) {
              const m = messagesRef.current[i];
              if (m.role === 'assistant' && m.parts) {
                const tp = m.parts.find((p) => p.kind === 'tool' && 'tool' in p && p.tool?.id === event.id);
                if (tp && 'tool' in tp && tp.tool) {
                  foundToolPart = tp.tool;
                  break;
                }
              }
            }
            if (foundToolPart?.args) {
              const toolArgs = foundToolPart.args;
              const appliedIds = appliedTodoIdsFor(activeIdRef.current);
              setActiveTodos((cur) => {
                const next = foldLiveTodo({
                  state: cur,
                  remembered: activeTodosRef.current,
                  name: event.name,
                  args: toolArgs,
                  callId: event.id,
                  appliedIds,
                });
                // 折叠消费了 callId → 立即落盘，刷新后仍能挡住同一帧的重放。
                persistAppliedTodoIds();
                const sid = activeIdRef.current;
                const doc = reduceLiveTodo(
                  liveTodoDoc(sid),
                  next && next.length > 0
                    ? { type: 'result', callId: event.id, items: next }
                    : { type: 'clear' },
                );
                if (sid) {
                  bumpTodoLiveEpoch(sid);
                  if (doc) todoLiveBySessionRef.current.set(sid, doc);
                  else todoLiveBySessionRef.current.delete(sid);
                  if (doc) activeTodosBySessionRef.current.set(sid, doc.items);
                  else activeTodosBySessionRef.current.delete(sid);
                }
                activeTodosRef.current = doc?.items ?? null;
                return doc?.items ?? null;
              });
            }
          }
        }
        // 改文件或跑 shell（含 git add / commit）结束后立刻刷新 Git 面板与资源管理器，
        // 不等整轮对话结束。连续工具合并成一次请求。
        if (toolTouchesWorktree(event.name)) {
          scheduleGitRefresh();
          try {
            window.dispatchEvent(new CustomEvent('jeikcode:worktree_touch'));
          } catch {}
        }
        // 工具已执行完 → 其审批必已解决，清掉 /chat 残留的同 call_id 审批卡片。
        onPermissionResolved?.(event.id);
        if (toolResultClearsUserInput(event.name)) {
          setUserInputReq(null);
        }
        // Tool output is folded into the next provider usage event. Do not bump
        // prompt locally — that inflates the footer and poisons session snapshots.
        break;
      }

      case 'tokens': {
        const resolved = resolveTokenCache(
          { prompt: event.prompt, cached: event.cached },
          tokenCacheRef.current,
        );
        tokenCacheRef.current = resolved.nextState;
        tokensAuthoritativeRef.current = true;
        setTokens((prev) => ({
          prompt: event.prompt,
          completion: event.completion,
          total: event.total,
          cached: resolved.cached,
          cached_estimated: resolved.cached_estimated,
          reasoning: prev?.reasoning ?? 0,
        }));
        break;
      }

      case 'permission_request':
        // Always mark the tool row; restore the modal unless a pure observer
        // explicitly opts out (reattach/watch must NOT pass observerOnly — that
        // previously deadlocked Build turns after refresh).
        if (
          nativeModeRef.current === 'bypass'
          || modeState.confirmedMode === 'bypass'
          || transcriptToolCallIsResolved(messagesRef.current, event.call_id)
        ) {
          break;
        }
        updateToolInLastAssistant(event.call_id, {
          status: 'waiting_approval',
        });
        if (!observerOnly) {
          onPermission(event as PermissionRequestEvent);
        }
        // 只在需要人工审批（Build / Accept Edits / Plan）且窗口不在前台时弹系统通知。
        // Auto 下每次 MCP / 工具执行的审批请求都不能响；前台看着时也不响。
        if (
          !observerOnly &&
          showPermissionNotice(modeState.confirmedMode) &&
          isWindowAway()
        ) {
          const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '';
          const sessionName = activeSession?.name || folder || 'JeikCode';
          const sid = (event as any).session_id || activeIdRef.current;
          dispatchSystemNotification({
            title: t('notify.review.title'),
            body: t('notify.review.body', { session: sessionName, detail: event.tool_name }),
            sessionId: sid,
            tag: `${sid}:review:${event.call_id}`,
            approvalId: event.approval_id,
            postSystemNotifyFn: postSystemNotify,
          });
        }
        break;

      case 'user_input_request':
        if (observerOnly) break;
        setUserInputReq(event);
        {
          const folder = (effectiveWorkingDir ?? '').split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '';
          const sessionName = activeSession?.name || folder || 'JeikCode';
          const sid = (event as any).session_id || activeIdRef.current;
          const detail = (event as any).question || (event as any).header || 'Input requested';
          dispatchSystemNotification({
            title: t('notify.ask.title'),
            body: t('notify.ask.body', { session: sessionName, detail }),
            sessionId: sid,
            tag: `${sid}:ask:${(event as any).request_id}`,
            postSystemNotifyFn: postSystemNotify,
          });
        }
        break;

      case 'done': {
        const doneSid = event.session_id || activeIdRef.current || sessionId;
        // A terminal stamped for a displaced turn must never settle the turn
        // that replaced it. Legacy daemons send no id; their behaviour is kept.
        if (isTerminalFromOtherTurn(event, doneSid)) break;
        const isProgrammaticDone = isStaleProgrammaticStopFrame(
          programmaticStopMarkRef.current,
          {
            type: 'done',
            stop_reason: event.stop_reason,
            operation_id: event.operation_id,
          },
          doneSid,
          Date.now(),
        );

        // 标记这是本 Chat 自己产生的会话 id，避免下面的 useEffect 误把当前对话清空，
        // 并标记其历史「已就位」（就是当前画布），防止 project_hash 回填后重新加载覆盖。
        if (event.session_id) {
          activeIdRef.current = event.session_id;
          loadedForRef.current = event.session_id;
          onSessionId(event.session_id);
        }
        if (event.tokens) {
          if (typeof event.tokens === 'number' && event.tokens > 0) {
            setTokens((prev) => ({
              prompt: prev?.prompt ?? 0,
              completion: prev?.completion ?? (event.tokens as number),
              total: Math.max(prev?.total ?? 0, event.tokens as number),
              cached: prev?.cached ?? 0,
              reasoning: prev?.reasoning ?? 0,
            }));
          } else if (typeof event.tokens === 'object') {
            const tok = event.tokens as any;
            if (typeof tok.total === 'number' && tok.total > 0) {
              const prompt = tok.prompt ?? tok.input ?? 0;
              applyAuthoritativeTokenUsage({
                prompt,
                completion: tok.completion ?? tok.output ?? 0,
                total: tok.total,
                cached: tok.cached ?? tok.cached_input,
                reasoning: tok.reasoning ?? 0,
              });
            }
          }
        }
        const terminal = classifyChatDone({
          stopReason: event.stop_reason,
          message: event.message,
        });
        // A terminal may only end the *current* loop. If a steer was folded into
        // this turn (or a queue card is waiting), the kernel/live drain starts the
        // next loop immediately; clearing busy here makes the send button flash
        // back to play while a tool is still running. Keep the stop state and
        // verify `/chat/active` shortly after.
        const foldedLedger = event.session_id
          ? (foldedSteersBySessionRef.current.get(event.session_id) ?? [])
          : [];
        const continuationSid = event.session_id || doneSid;
        const hasContinuation =
          queuedRef.current.length > 0 ||
          (continuationSid
            ? (queuedBySessionRef.current.get(continuationSid)?.length ?? 0) > 0
            : false) ||
          (continuationSid
            ? (pendingSteersBySessionRef.current.get(continuationSid)?.length ?? 0) > 0
            : false) ||
          foldedLedger.length > 0;
        if (isProgrammaticDone) {
          // 「立即发送」停掉的旧回合终态：新回合已经接手。绝不能清 busy / 删 localTurn /
          // 回吐队列 / 弹通知；标记必须保留到 TTL，让紧随其后的 legacy `stopped` 也被
          // 同一条规则吞掉。旧实现会在这里先清标记，导致随后到达的 stopped 按“用户停止”
          // 处理，把正在跑的新回合按钮清回发送箭头。
        } else if (terminal.discardQueued) {
          // 异常终端 / 被取消：停止自动 drain。
          // 只有真正异常的终态（预算耗尽 / 循环保护 / provider 失败 / 超时）才弹黄色
          // 未完成提示；`cancelled` / 用户主动停止（停止按钮、立即发送交接、撞上回合
          // 边界的转向），属预期收尾，绝不能再冒充“回合未完成”。
          blockQueueDrainRef.current = true;
          const isManualStopped = isSessionInManualStopGuard(continuationSid || event.session_id || '');
          if (terminal.kind === 'incomplete' && !isManualStopped && event.stop_reason !== 'cancelled') {
            // Anchor to the terminal's own assistant/user row; a late done from
            // the previous turn must not land on the next turn's answer tail.
            const noticeAnchor =
              event.message_id ??
              (doneSid ? turnUserAnchorBySessionRef.current.get(doneSid) : undefined);
            pushNoticeToLastAssistant(
              t('chat.incomplete', { msg: terminal.detail }),
              noticeAnchor,
            );
          }
          transitionChatRecovery({ type: 'authoritative_terminal' });
          localTurnSessionsRef.current.delete(event.session_id);
          backgroundRunningSessionsRef.current.delete(event.session_id);
          onTurnRunningChange?.(event.session_id, false);
          turnStartedAtBySessionRef.current.delete(event.session_id);
          setSessionCompacting(event.session_id, false);
          setBusyAndClock(false);
          markTurnTerminal(event.session_id);
          if (event.session_id) {
            markSessionTerminalSettled(event.session_id);
          }
          // A failed/hung next turn must not leave the previous tail skipped
          // forever. User cancellation is excluded because the rollback path
          // intentionally keeps the truncated canvas.
          if (event.session_id && event.stop_reason !== 'cancelled') {
            const reconcileHash =
              projectHashBySessionRef.current.get(event.session_id) ||
              (event.session_id === activeIdRef.current ? activeSession?.project_hash : undefined) ||
              '';
            scheduleDeferredReconcile(reconcileHash, event.session_id, 500);
          }
        } else {
          // ── 正常交互完成 (Normal Turn Completion) ──
          // 无论是否存在任何标记，只要是正常完成，100% 绝对无条件终结计时器并收尾待办，
          // 彻底阻断任何“误判结束为假运行计时器一直叠加”的可能！
          programmaticStopMarkRef.current = null;
          persistProgrammaticStopMark(null);
          transitionChatRecovery({ type: 'authoritative_terminal' });
          // Busy is owned by the daemon, not by local queue/steer bookkeeping.
          // A `done` for an intermediate round can arrive while the agent loop
          // is still running; keep the stop button until `/chat/active` confirms
          // the session is actually idle.
          const settleSid = event.session_id || doneSid;
          const settleGen = sessionGenerationRef.current;
          const settleHash =
            projectHashBySessionRef.current.get(settleSid || '') ||
            (settleSid === activeIdRef.current ? activeSession?.project_hash : undefined) ||
            '';
          const finishTerminal = () => {
            if (settleSid) {
              localTurnSessionsRef.current.delete(settleSid);
              backgroundRunningSessionsRef.current.delete(settleSid);
              onTurnRunningChange?.(settleSid, false);
              turnStartedAtBySessionRef.current.delete(settleSid);
            }
            setSessionCompacting(settleSid, false);
            setBusyAndClock(false);
            busyRef.current = false;
            markTurnTerminal(settleSid);
            if (settleSid) {
              markSessionTerminalSettled(settleSid);
              settleToIdleWatch(settleHash, settleSid, settleGen);
            }
          };
          if (!settleSid) {
            finishTerminal();
          } else {
            // 服务端权威口径：`/chat/runtime` 同时覆盖 /chat 占用、live 回合与
            // `/loop`·`/goal` 控制器。只看 `/chat/active` 会在 loop 的 wakeup
            // 间隙误判空闲，把运行态熄灭（只能刷新恢复）。
            const ensureLiveWatcherOnContinuation = () => {
              const w = sessionWatchersRef.current.get(settleSid);
              const wAlive = !!w && !w.signal.aborted;
              const hasFgPost =
                activeIdRef.current === settleSid &&
                (abortRef.current !== null || activeStreamRequestIdRef.current !== null);
              if (!wAlive && !hasFgPost && settleHash) {
                startDetachedHistoryPoll(settleHash, settleSid, settleGen, {
                  background: activeIdRef.current !== settleSid,
                });
              }
            };
            const confirmIdle = (attempt: number) => {
              void getChatRuntime(settleSid)
                .then((runtime) => {
                  if (sessionGenerationRef.current !== settleGen) return;
                  if (serverRuntimeRunning(runtime)) {
                    // 新一轮/续轮已经接管：保留停止态，并确保观察流已重连（上一轮 done 会关闭旧流）。
                    ensureLiveWatcherOnContinuation();
                    if (attempt > 0) window.setTimeout(() => confirmIdle(attempt - 1), 450);
                    return;
                  }
                  finishTerminal();
                })
                .catch(() => {
                  // 旧 daemon 没有 /chat/runtime：退回 /chat/active 的既有口径。
                  void getActiveChatSessions()
                    .then((actives) => {
                      if (sessionGenerationRef.current !== settleGen) return;
                      if (actives.includes(settleSid)) {
                        ensureLiveWatcherOnContinuation();
                        if (attempt > 0) window.setTimeout(() => confirmIdle(attempt - 1), 450);
                        return;
                      }
                      finishTerminal();
                    })
                    .catch(finishTerminal);
                });
            };
            confirmIdle(1);
          }

          // 未被回合内并入的转向消息，还原为普通排队消息，回合结束后由 drain 自动发送；
          // 但已并入正文（文本/图片命中画布）的卡片必须直接销毁，绝不复活成 queue。
          // 画布不是唯一依据：刷新/缓存落后会把已并入的气泡弄丢，此时要以内核回执账本为准，
          // 否则同一条转向会被当成未发送再跑一轮（重复回答）。
          const matchesFoldedSteer = (item: QueuedMessage): boolean =>
            foldedLedger.some(
              (folded) =>
                !!item.clientInputId &&
                !!folded.clientInputId &&
                item.clientInputId === folded.clientInputId,
            );
          setQueued((q) => q.filter((item) => {
              if (item.kind !== 'steer' && item.kind !== 'steering') return true;
              if (matchesFoldedSteer(item)) return false;
              const merged = messagesRef.current.some((m) => {
                if (m.role !== 'user') return false;
                // Identity first: a card with a correlation id never falls back
                // to text (same-text prompts are legitimate distinct sends).
                if (item.clientInputId) {
                  return m.id === item.clientInputId || m.clientInputId === item.clientInputId;
                }
                if (item.images && item.images.length > 0 && sameImageSet(m.images, item.images)) return true;
                const clean = visibleUserText(item.text).trim();
                return !!clean && m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text, clean));
              });
              return !merged;
            }));
          // 「自然发出」：上一轮结束后内核会把这个转向从缓冲落成新一轮（用户气泡由
          // `user` 回显画出）。此刻若立刻改回 queue 再 drain，就是本端用一次 POST
          // 抢占/重启那一轮 —— 表现就是同一条回答被跑两遍。延迟一拍再判定：
          // 期间会话重新跑起来或气泡出现 → 卡片销毁；真的没被消费 → 才降级排队。
          const drainSid = event.session_id || doneSid;
          if (drainSid) {
            window.setTimeout(() => resolveLingeringSteerCards(drainSid), STEER_NATURAL_DRAIN_GRACE_MS);
          }
          if (event.session_id) foldedSteersBySessionRef.current.delete(event.session_id);
        }

        closeOpenArtifactFence();
        finalizePendingToolsOnCanvas();
        commitActiveTodosIntoLastAssistant();
        const donePh = activeSession?.project_hash || (doneSid ? projectHashBySessionRef.current.get(doneSid) : '') || '';
        if (doneSid && donePh) {
          const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(doneSid) ?? []);
          commitCanvasCache(donePh, doneSid, {
            messages: messagesRef.current,
            todos: activeTodosRef.current,
            turns: currentOutline,
            tokenUsage: cachedTokenUsageFor(doneSid),
          });
        }
        onPermissionResolved?.(null); // 回合结束：兜底清掉任何残留审批卡片
        setUserInputReq(null);

        // 前台正看着这个会话时不发。最小化或窗口不在前台时，即使还选中它也发。
        // 标签与通知坞的完成边一致，守护进程 8 秒内只弹一条。
        // 只有真正的完成才通知：手动停止 / steer / 立即发送导致的 stopped 一律不响。
        const doneKind = terminalKindFromDone((event as { stop_reason?: string }).stop_reason);
        // 只有真正的回合结束才进入通知判定：
        // - programmatic stop（立即发送/停止）不算；
        // - stopped / cancelled 不算；
        // - 本会话还有排队或待发转向 → 紧接着会有下一轮，不算最终结束。
        const notifySid = event.session_id || doneSid;
        if (!isProgrammaticDone && doneKind !== 'stopped' && !hasContinuation && notifySid) {
          window.dispatchEvent(
            new CustomEvent('jeikcode:terminal', {
              detail: { sessionId: notifySid, kind: doneKind },
            }),
          );
        }
        break;
      }

      case 'queue_updated': {
        // 本会话待发卡片的权威全量：创建 / 点转向 / 取消 / 被内核消费都在内。
        applyServerQueue(event.session_id, event.items);
        break;
      }

      case 'session_status': {
        const targetSid = event.session_id ?? activeIdRef.current ?? sessionId;
        const status = (event as { status?: string }).status;
        if (status === 'compacting') {
          setSessionCompacting(targetSid, true);
        } else if (!targetSid || !runtimeAuthoritativeBySessionRef.current.has(targetSid)) {
          // 旧协议没有 revision：只接受非回放帧结束阶段，避免重连回放里
          // 上一轮的 `idle/running` 把当前压缩标记误清。新协议的阶段由
          // `runtime_activity` 单独负责，这里不再参与。
          if ((event as { replay?: boolean }).replay !== true) {
            setSessionCompacting(targetSid, false);
          }
        }
        break;
      }

      case 'stopped': {
        const stoppedSid = event.session_id ?? activeIdRef.current ?? sessionId;
        if (isTerminalFromOtherTurn(event, stoppedSid)) break;
        const isProgrammaticStopped = consumesProgrammaticStopMark(
          programmaticStopMarkRef.current,
          stoppedSid,
          Date.now(),
          event.operation_id,
        );

        if (isProgrammaticStopped) {
          // 程序化停止（排队卡「立即发送」）：本次 stopped 是本端为换发新消息而主动触发的，
          // 其余排队卡片与已投递的转向必须原地保留。新消息紧随其后作为新回合投递，
          // 绝不能关闭 busy 状态（保持红色正方形可停止按钮），绝不弹任何已停止黄色通知！
        } else {
          transitionChatRecovery({ type: 'authoritative_terminal' });
          setSessionCompacting(stoppedSid, false);
          if (activeIdRef.current) {
            backgroundRunningSessionsRef.current.delete(activeIdRef.current);
            localTurnSessionsRef.current.delete(activeIdRef.current);
            onTurnRunningChange?.(activeIdRef.current, false);
            turnStartedAtBySessionRef.current.delete(activeIdRef.current);
          }
          setBusyAndClock(false);
          markTurnTerminal(stoppedSid);
          void restoreQueuedToComposer(); // 用户主动停止：排队内容回到输入框，而不是丢掉
        }
        // Cancelled/stopped turns preserve their partial context in the
        // daemon (WebUI turns force keep_interrupted_context), so the folded
        // steers are durable. Keep the ledger; `done` clears it when the next
        // turn settles, and `handleSendImmediately` resolves by id.
        closeOpenArtifactFence();
        finalizePendingToolsOnCanvas();
        commitActiveTodosIntoLastAssistant();
        onPermissionResolved?.(null);
        setUserInputReq(null);
        break;
      }

      case 'error':
        if (isTerminalFromOtherTurn(event, activeIdRef.current ?? sessionId)) break;
        closeOpenArtifactFence();
        // 压缩失败也走 Error：临时“正在压缩…”行同样要撤回。
        retireCompactPendingNotice();
        {
          const errorText = t('chat.error', { msg: event.message });
          const anchor =
            event.message_id ??
            (activeIdRef.current
              ? turnUserAnchorBySessionRef.current.get(activeIdRef.current)
              : undefined);
          const anchorIsUser =
            !!anchor && messagesRef.current.some((m) => m.role === 'user' && m.id === anchor);
          if (anchorIsUser) {
            // A provider failure before the first assistant boundary: keep the
            // notice under its own prompt instead of the newest answer.
            pushNoticeToLastAssistant(errorText, anchor);
          } else {
            appendToLastAssistant(
              '\n\n' + errorText,
              undefined,
              { messageId: anchor },
            );
          }
        }
        transitionChatRecovery({ type: 'authoritative_terminal' });
        if (activeIdRef.current) {
          backgroundRunningSessionsRef.current.delete(activeIdRef.current);
          localTurnSessionsRef.current.delete(activeIdRef.current);
          onTurnRunningChange?.(activeIdRef.current, false);
          turnStartedAtBySessionRef.current.delete(activeIdRef.current);
        }
        setBusyAndClock(false);
        markTurnTerminal(activeIdRef.current ?? sessionId);
        if (activeIdRef.current) foldedSteersBySessionRef.current.delete(activeIdRef.current);
        // Recover the previous tail after the failed turn settles. The timer
        // re-checks busy/local-turn, so it cannot clobber a surviving new turn.
        {
          const errorSid = activeIdRef.current || sessionId;
          const reconcileHash =
            activeSession?.project_hash ||
            (errorSid ? projectHashBySessionRef.current.get(errorSid) : undefined) ||
            '';
          if (errorSid) scheduleDeferredReconcile(reconcileHash, errorSid, 500);
        }
        finalizePendingToolsOnCanvas();
        commitActiveTodosIntoLastAssistant();
        blockQueueDrainRef.current = true; // 出错时暂停自动 drain，但保留排队消息不丢失
        onPermissionResolved?.(null);
        setUserInputReq(null);
        break;

      case 'warning': {
        // 压缩完成标记是轮次边界，必须落成独立 system 行（渲染为紫色分隔条），
        // 不能包上 `[警告: …]` 塞进最后一条 assistant 气泡。
        if (isCompactionDoneNotice(event.message)) {
          if (!hasRecentCompactionNotice(messagesRef.current)) {
            pushCommandNotice(event.message, { forceTail: true });
          }
        } else {
          // 非致命提示：渲染成淡色 notice 行 —— 不染红、不并进
          // 回复文本、不结束回合（任务继续）。对齐 TUI 的黄色 "!" 提示。
          pushNoticeToLastAssistant(t('chat.warning', { msg: event.message }), event.message_id);
        }
        // /live path: a compaction notice carries the post-compaction token count.
        if (typeof event.tokens_after === 'number') {
          // 真正标记已上屏，临时的“正在压缩…”行不再需要。
          retireCompactPendingNotice();
          const prompt = Math.max(0, event.tokens_after);
          const cacheState = {
            lastPrompt: prompt,
            providerReportsCache: false,
          };
          applyTokenUsage(
            { prompt, completion: 0, total: prompt, cached: 0, cached_estimated: false, reasoning: 0 },
            cacheState,
            false,
          );
          if (activeIdRef.current) {
            tokenUsageCacheRef.current.set(activeIdRef.current, {
              tokens: {
                prompt,
                completion: 0,
                total: prompt,
                cached: 0,
                cached_estimated: false,
                reasoning: 0,
              },
              cacheState,
              authoritative: false,
              compacted: true,
            });
          }
          setSessionCompacting(
            (event as { session_id?: string }).session_id ?? activeIdRef.current,
            false,
          );
        }
        break;
      }

      case 'context_compacted': {
        // Compaction changed the context WITHOUT a usage frame: update the footer
        // meter right away instead of waiting for the next model response.
        retireCompactPendingNotice();
        const prompt = Math.max(0, event.tokens);
        const cacheState = {
          lastPrompt: prompt,
          providerReportsCache: false,
        };
        applyTokenUsage(
          { prompt, completion: 0, total: prompt, cached: 0, cached_estimated: false, reasoning: 0 },
          cacheState,
          false,
        );
        if (activeIdRef.current) {
          tokenUsageCacheRef.current.set(activeIdRef.current, {
            tokens: {
              prompt,
              completion: 0,
              total: prompt,
              cached: 0,
              cached_estimated: false,
              reasoning: 0,
            },
            cacheState,
            authoritative: false,
            compacted: true,
          });
        }
        // The daemon also sends SessionStatus("running"), but clear here too so a
        // dropped status frame can never leave the shimmer stuck on "Compacting...".
        setSessionCompacting(activeIdRef.current ?? sessionId, false);
        break;
      }

      case 'display_notice': {
        // 已落盘的显示通知（如手动压缩边界）：按显示日志分配的权威 `display_seq`
        // 摆成一条独立 system 行，并按 `id` 与后续磁盘重拉幂等合并。
        retireCompactPendingNotice();
        setMessages({
          type: 'authoritative_notice',
          id: event.id,
          seq: event.display_seq,
          text: event.text,
          ts: event.created_at,
        });
        const noticeSid = event.session_id ?? activeIdRef.current ?? sessionId;
        if (noticeSid) {
          messageCacheRef.current.set(noticeSid, messagesRef.current);
          scheduleCanvasCacheSave();
        }
        break;
      }

      case 'persistence_warning':
        setPersistenceWarning(event.message);
        break;

      case 'rate_limited': {
        // 限流暂停：渲染成暗色中性卡片，非红色 error 样式；保留已完成内容，不结束回合。
        // auto_resuming=true → WaitAndRetry (kernel will sleep then retry)
        // A provider quota verdict carries window data (reset time and/or a
        // window label); a generic 429 carries neither. Only claim
        // "window exhausted" when those fields are present.
        const time = event.reset_at_display;
        const hasQuotaWindow = !!time || !!event.reset_label;
        const secs = event.secs_until_reset;
        // Bare compact h/m/s (locale-neutral), then wrap in a localized suffix so the
        // English notice doesn't leak a Chinese "（还有 …）" fragment.
        const durRaw = secs == null ? '' :
          secs >= 3600 ? `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m` :
          secs >= 60 ? `${Math.floor(secs / 60)}m` : `${secs}s`;
        const dur = durRaw ? t('chat.rateLimited.remaining', { dur: durRaw }) : '';
        let text: string;
        if (event.auto_resuming) {
          text = t('chat.rateLimited.waiting', { secs: String(event.secs_until_reset ?? 0) });
        } else if (!hasQuotaWindow) {
          // Generic 429: surface the provider's own reason when present.
          const reason = event.server_message?.trim() ? `：${event.server_message.trim()}` : '';
          text = `${t('chat.rateLimited.generic')}${reason}${dur} · ${t('chat.rateLimited.hint')}`;
        } else if (time) {
          text = `${t('chat.rateLimited.paused', { time })} · ${t('chat.rateLimited.hint')}`;
        } else {
          text = `${t('chat.rateLimited.pausedNoTime')}${dur} · ${t('chat.rateLimited.hint')}`;
        }
        pushRateLimitedToLastAssistant(text, event.message_id);
        break;
      }

      // Artifact events: the daemon's ArtifactDetector strips fenced code blocks
      // (and HTML/SVG) from TextDelta and emits them as separate artifact_* events.
      // Without handling these, the code content is silently lost in the WebUI.
      case 'artifact_start': {
        if (event.id?.startsWith('file-')) {
          artifactOpenRef.current = false;
          break;
        }
        const lang = (event.language ?? '').trim();
        const fenceLen = typeof event.fence_len === 'number' && event.fence_len >= 3
          ? event.fence_len
          : 3;
        const marker = '`'.repeat(fenceLen);
        const fence = (lang ? marker + lang : marker) + '\n';
        // 关键防御：确保代码块开启围栏始终独立成行，杜绝与前置文本粘连导致代码块被炸开为正文
        const curMessages = messagesRef.current;
        const lastMsg = curMessages[curMessages.length - 1];
        let prefix = '';
        if (lastMsg && lastMsg.role === 'assistant') {
          const lastPart = lastMsg.parts[lastMsg.parts.length - 1];
          if (lastPart && lastPart.kind === 'text' && lastPart.text && !lastPart.text.endsWith('\n')) {
            prefix = '\n';
          }
        }
        appendToLastAssistant(prefix + fence, {
          skipReplayDedup: true,
        });
        artifactOpenRef.current = true;
        artifactFenceLenRef.current = fenceLen;
        if (activeIdRef.current) artifactOpenBySessionRef.current.set(activeIdRef.current, fenceLen);
        break;
      }
      case 'artifact_content': {
        if (event.id?.startsWith('file-')) break;
        appendToLastAssistant(event.content, { skipReplayDedup: true });
        break;
      }
      case 'artifact_end': {
        if (event.id?.startsWith('file-')) {
          artifactOpenRef.current = false;
          break;
        }
        if (artifactOpenRef.current) {
          const fenceLen = artifactFenceLenRef.current || 3;
          const marker = '`'.repeat(fenceLen);
          appendToLastAssistant('\n' + marker + '\n', { skipReplayDedup: true });
        }
        artifactOpenRef.current = false;
        artifactFenceLenRef.current = 3;
        if (activeIdRef.current) artifactOpenBySessionRef.current.delete(activeIdRef.current);
        break;
      }
      case 'session_mutation': {
        const mutation = event as SessionMutationEvent;
        // 会话变更改写了权威转录：本会话的续传游标立即作废（两条流都作废），
        // 否则带旧游标重连会把变更前发出的旧帧补回来 —— 已删内容会复活。
        clearStreamCursor(mutation.session_id);
        // 删除/回溯物理改写了转录尾部：后端已按剩余转录重推 todo 板，
        // 前端拉回权威清单 —— 更早轮次建立/修改过的项不能被误杀。
        // （patch 是原地改文本，不动清单）
        if (
          mutation.action === 'delete' ||
          mutation.action === 'truncate' ||
          (mutation.action === 'patch' && mutation.truncate_after)
        ) {
          resyncTodosAfterMutation(mutation.session_id);
        }
        if (
          mutation.action === 'truncate' ||
          (mutation.action === 'patch' && mutation.truncate_after)
        ) {
          clearFutureInputsAfterRewrite(mutation.session_id);
        }
        // Mutation events carry the persisted message id. Prefer it over the
        // numeric source_index: the event's source_index is a KERNEL snapshot
        // index, while the canvas stores a DISPLAY-list index (compacted prefix
        // / filtered system rows make them diverge). Fail closed when an id is
        // present but missing instead of editing/deleting a neighbouring row.
        const mutationRowIndex = (rows: Message[]): number => {
          if (mutation.message_id) {
            return rows.findIndex((m) => m.id === mutation.message_id);
          }
          return mutation.source_index != null
            ? rows.findIndex((m) => m.sourceIndex === mutation.source_index)
            : -1;
        };
        const truncateRowIndex = (rows: Message[]): number => {
          if (mutation.target_message_id) {
            // The originating tab has already optimistically truncated; if the
            // row is gone, do not fall back to the snapshot index and cut extra.
            return rows.findIndex((m) => m.id === mutation.target_message_id);
          }
          return mutation.target_index != null
            ? rows.findIndex((m) => (m.sourceIndex ?? 0) >= mutation.target_index!)
            : -1;
        };
        const mutationMatches = (m: Message): boolean =>
          mutation.message_id
            ? m.id === mutation.message_id
            : mutation.source_index != null && m.sourceIndex === mutation.source_index;
        const truncateMatches = (m: Message): boolean =>
          mutation.target_message_id
            ? m.id === mutation.target_message_id
            : mutation.target_index != null && (m.sourceIndex ?? 0) >= mutation.target_index!;
        let mutatedDisplayIndex: number | undefined;
        // Update cached session in memory if exists
        const cached = messageCacheRef.current.get(mutation.session_id);
        let updatedCached: Message[] | undefined = undefined;
        if (cached) {
          const nextCached = cached.slice();
          if (mutation.action === 'patch') {
            const idx = mutationRowIndex(nextCached);
            if (idx !== -1) {
              nextCached[idx] = {
                ...nextCached[idx],
                parts: [{ kind: 'text', text: mutation.text ?? '' }],
                images: mutation.images,
              };
              if (mutation.truncate_after) {
                // Rewrite removes every later message from the context/canvas.
                mutatedDisplayIndex = nextCached[idx]?.sourceIndex;
                const truncated = nextCached.slice(0, idx + 1);
                messageCacheRef.current.set(mutation.session_id, truncated);
                updatedCached = truncated;
              } else {
                messageCacheRef.current.set(mutation.session_id, nextCached);
                updatedCached = nextCached;
              }
            }
          } else if (mutation.action === 'delete') {
            const idx = mutationRowIndex(nextCached);
            if (idx !== -1) {
              mutatedDisplayIndex = nextCached[idx]?.sourceIndex;
              if (mutation.delete_turn) {
                let end = idx + 1;
                while (end < nextCached.length && nextCached[end]?.role !== 'user') {
                  end += 1;
                }
                nextCached.splice(idx, end - idx);
              } else {
                nextCached.splice(idx, 1);
              }
              messageCacheRef.current.set(mutation.session_id, nextCached);
              updatedCached = nextCached;
            }
          } else if (mutation.action === 'truncate') {
            const idx = truncateRowIndex(nextCached);
            if (idx !== -1) {
              mutatedDisplayIndex = nextCached[idx]?.sourceIndex;
              const nextTruncated = nextCached.slice(0, idx);
              messageCacheRef.current.set(mutation.session_id, nextTruncated);
              updatedCached = nextTruncated;
            }
          }
        }

        // Resolve the DISPLAY-space index synchronously for the outline prune:
        // a setMessages updater runs later, so it cannot feed the code below.
        if (
          mutatedDisplayIndex == null &&
          mutation.session_id === activeIdRef.current
        ) {
          const activeRows = messagesRef.current;
          const activeIdx = mutation.action === 'truncate'
            ? truncateRowIndex(activeRows)
            : mutationRowIndex(activeRows);
          if (activeIdx >= 0) {
            mutatedDisplayIndex = activeRows[activeIdx]?.sourceIndex;
          }
        }

        // If this mutation belongs to the currently active session on screen:
        if (mutation.session_id === activeIdRef.current) {
          if (mutation.action === 'patch') {
            const patchIdx = mutationRowIndex(messagesRef.current);
            if (patchIdx >= 0) mutatedDisplayIndex ??= messagesRef.current[patchIdx]?.sourceIndex;
            setMessages({
              type: 'replace_match',
              match: mutationMatches,
              update: (row) => ({
                ...row,
                parts: [{ kind: 'text', text: mutation.text ?? '' }],
                images: mutation.images,
              }),
            });
            if (mutation.truncate_after) {
              setMessages({ type: 'truncate_match', match: mutationMatches, inclusive: true });
            }
            if (mutation.truncate_after && mutatedDisplayIndex != null) {
              const editedLabel = compactTurnNavText(
                stripSteerEnvelopeForDisplay(
                  stripInjectedRemindersForDisplay(mutation.text ?? ''),
                ),
              );
              const filteredTurns = turnOutlineRef.current
                .filter((turn) => turn.index <= mutatedDisplayIndex!)
                .map((turn) =>
                  turn.index === mutatedDisplayIndex ? { ...turn, label: editedLabel } : turn,
                );
              turnOutlineRef.current = filteredTurns;
              turnOutlineBySessionRef.current.set(mutation.session_id, filteredTurns);
              setTurnOutline(filteredTurns);
            }
          } else if (mutation.action === 'delete') {
            const deleteIdx = mutationRowIndex(messagesRef.current);
            if (deleteIdx !== -1) {
              mutatedDisplayIndex ??= messagesRef.current[deleteIdx]?.sourceIndex;
              if (mutation.delete_turn) {
                let end = deleteIdx + 1;
                while (end < messagesRef.current.length && messagesRef.current[end]?.role !== 'user') {
                  end += 1;
                }
                const removed = new Set(messagesRef.current.slice(deleteIdx, end));
                setMessages({ type: 'removeWhere', predicate: (row) => removed.has(row) });
              } else {
                const removed = messagesRef.current[deleteIdx];
                setMessages({ type: 'removeWhere', predicate: (row) => row === removed });
              }
            }
            // A missing display index means this tab already applied the
            // mutation optimistically (or has no such row); never fall back to
            // the kernel snapshot index and prune the wrong outline entries.
            const deletedOutlineIndex = mutatedDisplayIndex;
            if (mutation.delete_turn && deletedOutlineIndex != null) {
              const filteredTurns = turnOutlineRef.current.filter((t) => t.index !== deletedOutlineIndex);
              turnOutlineRef.current = filteredTurns;
              turnOutlineBySessionRef.current.set(mutation.session_id, filteredTurns);
              setTurnOutline(filteredTurns);
            }
          } else if (mutation.action === 'truncate') {
            const cutIdx = truncateRowIndex(messagesRef.current);
            if (cutIdx !== -1) mutatedDisplayIndex ??= messagesRef.current[cutIdx]?.sourceIndex;
            // 守卫：如果本端正在执行该会话的新回合，绝不能被旧回溯的残余 SSE 广播抹杀新回合画布！
            if (activeIdRef.current === mutation.session_id && (busyRef.current || hasRunningLocalSend(mutation.session_id))) {
              // 新一轮已经在投递/运行中，跳过破坏性截断
            } else {
              setMessages({ type: 'truncate_match', match: truncateMatches });
            }
            const truncatedOutlineIndex = mutatedDisplayIndex;
            if (truncatedOutlineIndex != null) {
              const filteredTurns = turnOutlineRef.current.filter((t) => t.index < truncatedOutlineIndex);
              turnOutlineRef.current = filteredTurns;
              turnOutlineBySessionRef.current.set(mutation.session_id, filteredTurns);
              setTurnOutline(filteredTurns);
            }
          }
        }

        // 非当前视图的会话同样要修剪大纲：否则下次热切回时会带着指向已删行 /
        // 已截断之后的大纲条目，点击这些条目自然无法命中锚点（跳转落空）。
        if (mutation.session_id !== activeIdRef.current) {
          const cachedOutline = turnOutlineBySessionRef.current.get(mutation.session_id);
          if (cachedOutline) {
            const deleteIndex = mutatedDisplayIndex;
            const truncateIndex = mutatedDisplayIndex;
            const patchTruncateIndex = mutatedDisplayIndex;
            const editedLabel =
              mutation.action === 'patch' && mutation.truncate_after
                ? compactTurnNavText(
                    stripSteerEnvelopeForDisplay(
                      stripInjectedRemindersForDisplay(mutation.text ?? ''),
                    ),
                  )
                : '';
            const pruned =
              mutation.action === 'delete' && deleteIndex != null
                ? cachedOutline.filter((t) => t.index !== deleteIndex)
                : mutation.action === 'truncate' && truncateIndex != null
                  ? cachedOutline.filter((t) => t.index < truncateIndex)
                  : mutation.action === 'patch' &&
                      mutation.truncate_after &&
                      patchTruncateIndex != null
                    ? cachedOutline
                        .filter((t) => t.index <= patchTruncateIndex)
                        .map((t) =>
                          t.index === patchTruncateIndex
                            ? { ...t, label: editedLabel }
                            : t,
                        )
                    : cachedOutline;
            if (pruned !== cachedOutline) {
              turnOutlineBySessionRef.current.set(mutation.session_id, pruned);
            }
          }
        }

        // 同步持久化写入 IndexedDB (确保异地/后台实例及离线存储实时一致)
        if (updatedCached) {
          const ph =
            activeSession?.project_hash ||
            projectHashBySessionRef.current.get(mutation.session_id) ||
            viewedProjectHashRef.current ||
            '';
          if (ph) {
            const currentOutline =
              mutation.session_id === activeIdRef.current
                ? turnOutlineRef.current
                : turnOutlineBySessionRef.current.get(mutation.session_id) ?? [];
            commitCanvasCache(ph, mutation.session_id, {
              messages: updatedCached,
              // 待办是**视图级实时状态**：只有变更发生在当前会话时才能写；
              // 后台会话不传 = 保留它自己缓存里的清单，绝不串台。
              todos: mutation.session_id === activeIdRef.current ? activeTodosRef.current : undefined,
              turns: currentOutline,
              tokenUsage: cachedTokenUsageFor(mutation.session_id),
              revision: mutation.revision,
            });
            // This tab already applied the mutation and wrote the cache at this
            // revision. The global `session_mutated` signal is now idempotent —
            // it must not trigger a redundant full refetch.
            cacheRevisionBySessionRef.current.set(mutation.session_id, mutation.revision);
          }
        }
        break;
      }

      default:
        // Ignore tool_batch, etc.
        break;
    }
    // 反哺缓存：断点续传的游标只负责「新帧」，画布本身必须同步落进 L1/L2 缓存 ——
    // 否则刷新后「画布来自旧缓存 + 游标已超前」会把中间那段内容整段跳过（丢帧）。
    // 流式期间不落盘（W5）：终态/空闲时由 messages effect 统一提交。
    if (!busyRef.current) scheduleCanvasCacheSave();
  }

  // 实际投递一条消息（同步 / 常规两条路径）；busy 由各自的事件流复位。
  async function deliver(
    text: string,
    images: ImageData[],
    approvalMode: ApprovalMode = modeState.confirmedMode,
    onAccepted?: (acceptedSessionId?: string) => void,
    overrideProvider?: string,
    opts?: {
      alreadyOnCanvas?: boolean;
      preserveCanvasOnBusy?: boolean;
      jumpToBottom?: boolean;
      /** Reuse the identity already painted on the optimistic user row. */
      requestId?: string;
    },
  ): Promise<'ok' | 'busy' | 'error'> {
    // A new send must see the painted streaming tail before it changes the canvas.
    flushPendingText();
    if (!chatRecoveryPolicy(chatRecoveryRef.current).allowSend) {
      // 输入态反馈是瞬时的，不能落成画布系统消息（否则会永久粘在最新回答下面）。
      showToast(
        chatRecoveryRef.current === 'detached_active'
          ? t('chat.detachedSendBlocked')
          : t('chat.recoveryBlocked'),
        'warning',
      );
      return 'error';
    }
    // 画到上一条消息尾部只发生在正式 stop 且全部勾完之后，不在发送下一条时提前归档。
    if (sessionId) idleWatchFlashDisconnectsRef.current.delete(sessionId);
    // Actually sending a message re-engages auto-follow when the user asked for
    // it. Queue cards drained in the background must NOT yank a reader who is
    // scrolled up; the explicit jump fires only for real sends.
    if (opts?.jumpToBottom !== false) timelineFollow.jump();

    // 后台静默检测 Git 仓库支持情况（更新 hasGitRepos 标识，严格保留用户当前选择的右侧面板游标/Tab，禁止重置）
    if (effectiveWorkingDir) {
      fetchGitRepos(effectiveWorkingDir)
        .then((res) => {
          const hasGit = Array.isArray(res.repos) && res.repos.length > 0;
          hasGitReposRef.current = hasGit;
          setHasGitRepos(hasGit);
        })
        .catch(() => {
          hasGitReposRef.current = false;
          setHasGitRepos(false);
        });
    }
    // 本会话首条消息：用消息前 10 字做临时标题，立刻通知 App 乐观插入侧栏，
    // 让会话「一发送就出现在左侧」。回合 done 后列表刷新会换成后端自动命名。
    if (!optimisticFiredRef.current && messages.length === 0) {
      optimisticFiredRef.current = true;
      const title = text.split('\n')[0]?.trim() ?? '';
      if (title) onOptimisticSession?.(title);
    }

    const turnOwnerSid = activeIdRef.current ?? sessionId;
    if (turnOwnerSid) {
      clearManualStopGuard(turnOwnerSid);
      stopDetachedHistoryPoll(turnOwnerSid);
    } else {
      stopDetachedHistoryPoll();
    }
    stopIdleWatch();
    // 新回合已进入投递：程序化停止（立即发送）的抑制标记到此为止，绝不能影响后续真实的用户停止。
    // 立即发送要等 stopped 先吃掉标记；这里提前清掉会让终态把其余排队卡片回吐到输入框。
    if (!opts?.alreadyOnCanvas) {
      programmaticStopMarkRef.current = null;
      persistProgrammaticStopMark(null);
    }
    const now = Date.now();
    // 乐观气泡的身份：`POST /chat` 的 `request_id` 就是后端落盘的消息 id。
    // 在画之前就铸造，画布从第一帧起就能按 id 判重（不必等回声/身份帧）。
    // Not crypto.randomUUID(): unavailable on http://LAN-IP (non-secure context).
    const requestId = opts?.requestId ?? randomUUID();
    // Bind this turn's terminal frames to the request id the daemon echoes.
    noteTurnOperation(turnOwnerSid, requestId);
    // Idempotent on purpose: a mid-turn steer / send-now is a direction change and
    // keeps the continuous work timer. A real terminal clears the epoch first, so a
    // genuinely new turn still starts a fresh clock here.
    setBusyAndClock(true, now);
    busyRef.current = true;
    // 新回合开始投递：进入“已投递、尚未吐帧”的窗口，用于识别上一回合的缓存终态。
    armTurn(turnOwnerSid);
    if (turnOwnerSid) {
      localTurnSessionsRef.current.add(turnOwnerSid);
      onTurnRunningChange?.(turnOwnerSid, true);
    }
    // 关键根因修复：发送消息时保留当前未完成的清单，绝不无脑清空成 null，彻底消灭发送时的闪烁！

    // Push the user row only. Working is rendered from `busy`; the first
    // streamed frame opens the assistant record.
    // 立即发送在点击时已经画过用户气泡：这里只补一个空的 assistant，避免再叠一条。
    const turnIndex = nextTurnNavIndex();
    const cleanText = visibleUserText(text).trim();
    // Identity first. A send-now bubble already carries the requestId; matching by
    // text alone can claim the PREVIOUS turn's same-text prompt after a disk
    // reconcile dropped the optimistic row (hidden bubble + duplicate answer).
    const paintedRow = opts?.alreadyOnCanvas === true
      ? findPaintedUserRow(messagesRef.current, opts?.requestId, cleanText, images)
      : undefined;
    const paintedAlready = !!paintedRow;
    if (!paintedAlready) rememberTurnOutline(cleanText || (images.length > 0 ? '[图片]' : ''), turnIndex, nextOutlineOrdinal(), requestId);
    if (!paintedAlready) {
      setMessages({
        type: 'optimistic_user',
        requestId,
        row: {
          role: 'user',
          parts: [{ kind: 'text', text: cleanText }],
          images: images.length ? images : undefined,
          ts: now,
          id: requestId,
        },
      });
    }
    if (paintedAlready && !opts?.requestId) {
      // Legacy caller (no pre-minted identity): stamp the painted row with this
      // POST's request_id. New send-now calls already painted the id, so this
      // text-based fallback must never repurpose a DIFFERENT same-text row.
      const lastUser = [...messagesRef.current].reverse().find((row) => row.role === 'user');
      const matches = lastUser
        ? cleanText
          ? lastUser.parts.some((part) => part.kind === 'text' && userTextsMatch(part.text || '', cleanText))
          : images.length > 0 && sameImageSet(lastUser.images, images)
        : false;
      if (matches && lastUser) {
        setMessages({ type: 'stamp_user_identity', requestId, match: (row) => row === lastUser });
      }
    }
    const next = messagesRef.current;
    const targetSid = sessionId ?? activeIdRef.current;
    if (targetSid) {
      messageCacheRef.current.set(targetSid, next);
      const targetPh = activeSession?.project_hash || projectHashBySessionRef.current.get(targetSid) || '';
      if (targetPh) {
        const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(targetSid) ?? []);
        commitCanvasCache(targetPh, targetSid, {
          messages: next,
          todos: activeTodosRef.current,
          turns: currentOutline,
          tokenUsage: cachedTokenUsageFor(targetSid),
        });
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    requestIdRef.current = requestId;
    activeStreamRequestIdRef.current = requestId;
    const requestGeneration = sessionGenerationRef.current;
    if (turnOwnerSid) {
      localActiveStreamsBySessionRef.current.set(turnOwnerSid, {
        abortController: controller,
        requestId,
      });
    }
    // Fan-out / primary SSE User echo: register optimistic text so handleEvent
    // does not append a second user bubble.
    pendingSelfEchoRef.current.push({ id: requestId, text });
    let boundSessionId = sessionId ?? activeIdRef.current;
    let acceptedWithoutSession = false;
    let keepStopAlias = false;
    let deliveryOutcome: 'ok' | 'busy' | 'error' = 'ok';

    /** A claimed queue card must not disappear when admission fails. Release the
     *  tombstone, restore the card, and let the paused drain retry it. */
    const restoreClaimedQueueCard = async (sid?: string | null) => {
      const claimId = opts?.requestId;
      const restored: QueuedMessage = {
        id: randomUUID(),
        text,
        images,
        approvalMode,
        kind: 'queue',
        // 沿用本次 POST 的 request_id：乐观气泡 → 队列卡片 → 最终提问必须是同一个身份，
        // 否则 drain 只能按文本判定“是否已投递”，旧缓存里的同名行会把卡片静默吃掉。
        clientInputId: claimId ?? requestId,
        createdAt: Date.now(),
      };
      // Restore the server card atomically with the tombstone removal; a plain
      // release would leave a window where another tab could claim it again.
      if (sid && claimId) {
        await releaseChatQueue(sid, claimId, serializeQueuedCard(restored) as QueuedMessageApiItem);
      }
      setQueued((prev) => {
        if (prev.some((q) => (claimId ? q.clientInputId === claimId : q.text === text))) {
          return prev;
        }
        return [...prev, restored];
      });
    };

    try {
      const targetProvider = overrideProvider || provider || undefined;
      const body = {
        message: text,
        ...(turnOwnerSid ? { session_id: turnOwnerSid } : {}),
        request_id: requestId,
        ...(effectiveWorkingDir ? { working_dir: effectiveWorkingDir } : {}),
        ...(targetProvider ? { provider: targetProvider } : {}),
        ...(images.length ? { images } : {}),
        approval_mode: approvalMode,
      };

      const ack = await postChatPrompt(body, controller.signal);
      const effectiveSid = ack.session_id || boundSessionId || turnOwnerSid;
      // 认领画布/视图只在「这条 turn 仍属于当前视图」时成立：落地页（activeIdRef 为空）
      // 或仍停在这条 turn 所属会话。用户在 POST 飞行期间切走后，绝不能把 activeIdRef /
      // onSessionId 抢回来（视图被拽回 + 画布冻结），更不能把目的会话的画布写进这条 turn
      // 的缓存（跨会话污染）。此时按后台回合处理：只对齐侧栏、订阅推流写缓存。
      const stillViewingTurn =
        !activeIdRef.current ||
        activeIdRef.current === turnOwnerSid ||
        activeIdRef.current === effectiveSid;
      if (effectiveSid) {
        boundSessionId = effectiveSid;
        localTurnSessionsRef.current.add(effectiveSid);
        if (stillViewingTurn) {
          activeIdRef.current = effectiveSid;
          loadedForRef.current = effectiveSid;
          messageCacheRef.current.set(effectiveSid, messagesRef.current);
          // 新会话首发：屏幕上已经画好了乐观提问，画布就是就绪态。
          // 必须在这里落定 canvasReady 并冲刷预挂载队列 —— 否则后续推流帧会一直
          // 压在 preMountStreamBuffer 里，直到终态磁盘对账才一次性倒出，表现就是
          // “非流式：Working 转到底，结束时中间过程与正文啪地全部出现”。模型响应
          // 越快、回放帧越集中，这个现象越明显（新会话窗口首条消息最常见）。
          canvasReadySessionIdRef.current = effectiveSid;
          flushPreMountStreamBuffer(effectiveSid);
          // 新会话首发时 turnOwnerSid 还是 null，这里补上“已投递未吐帧”的窗口标记。
          armTurn(effectiveSid);
        } else if (!messageCacheRef.current.has(effectiveSid)) {
          // 切走后缓存可能还是空的（落地页首发后立刻切走，切换块因 prevId 为空未落盘）。
          // 用本轮的乐观提问补一个起点，否则 applyEventToSessionCache 会把后续推流帧整体丢弃。
          messageCacheRef.current.set(effectiveSid, [
            {
              role: 'user' as const,
              parts: [{ kind: 'text' as const, text }],
              images: images.length ? images : undefined,
              ts: now,
              // 右栏锚点身份 = 绝对下标；新会话的首条提问下标为 0。
              sourceIndex: historyTotalBySessionRef.current.get(effectiveSid) ?? 0,
            },
            { role: 'assistant' as const, parts: [] },
          ]);
        }
        onSessionId(effectiveSid, { claimView: stillViewingTurn });
        onTurnRunningChange?.(effectiveSid, true);
      }
      if (!sessionId || acceptedWithoutSession) {
        acceptedWithoutSession = false;
        if (boundSessionId) onAccepted?.(boundSessionId);
      }
      // 单事件总线架构：提问由后端承认（202 Accepted）并自动发布至广播总线，
      // 前端统一由 watchChatSession 接收全量实时事件与回放，彻底杜绝双流竞态。
      const currentProjectHash =
        activeSession?.project_hash ||
        viewedProjectHashRef.current ||
        (effectiveSid ? projectHashBySessionRef.current.get(effectiveSid) : undefined) ||
        '';
      if (effectiveSid) {
        startDetachedHistoryPoll(currentProjectHash, effectiveSid, sessionGenerationRef.current, {
          background: !stillViewingTurn,
        });
      }
    } catch (err: unknown) {
      const stillCurrent =
        !controller.signal.aborted &&
        (!boundSessionId || !activeIdRef.current || activeIdRef.current === boundSessionId) &&
        (activeStreamRequestIdRef.current === requestId ||
          requestIdRef.current === requestId ||
          (boundSessionId && requestIdRef.current === boundSessionId) ||
          isCurrentChatStream(
            requestId,
            requestGeneration,
            requestIdRef.current,
            sessionGenerationRef.current,
            controller.signal.aborted,
          ));
      const aborted = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      const isConflict =
        (err as any)?.status === 409 ||
        (err as any)?.code === 'session_busy' ||
        msg.includes('409') ||
        msg.includes('Conflict') ||
        msg.includes('session_busy') ||
        msg.includes('already has an active chat operation');
      deliveryOutcome = isConflict ? 'busy' : 'error';
      if (!aborted && stillCurrent && isConflict && opts?.preserveCanvasOnBusy) {
        // 气泡已经在画布上。撤回再退回队列会让它消失，直到刷新才从磁盘回来。
        keepStopAlias = true;
        blockQueueDrainRef.current = true;
        setBusyAndClock(true);
        busyRef.current = true;
        if (turnOwnerSid) {
          backgroundRunningSessionsRef.current.add(turnOwnerSid);
          onTurnRunningChange?.(turnOwnerSid, true);
        }
        return 'busy';
      }
      if (!aborted && stillCurrent) {
        keepStopAlias = true;
        transitionChatRecovery({ type: 'transport_lost' });
        if (isConflict) {
          // 409 Conflict：目标会话当前正在运行其他轮次，绝不能作为连接错误打在助手气泡里！
          // 撤回乐观追加的空 assistant 和 user 气泡，并把未成功发送的消息退回排队队列，保证用户输入不丢失且绝不产生幽灵双份！
          const optimisticRows = messagesRef.current;
          const removeRows = new Set<Message>();
          const tail = optimisticRows[optimisticRows.length - 1];
          if (tail?.role === 'assistant' && (!tail.parts || tail.parts.length === 0)) {
            removeRows.add(tail);
          }
          const userTail = optimisticRows[optimisticRows.length - 1 - (tail && removeRows.has(tail) ? 1 : 0)];
          if (userTail?.role === 'user') {
            const cleanLast = userTail.parts?.filter((p) => p.kind === 'text').map((p) => p.text || '').join('') ?? '';
            if (cleanLast.trim() === text.trim()) removeRows.add(userTail);
          }
          setMessages({ type: 'removeWhere', predicate: (row) => removeRows.has(row) });
          const next = messagesRef.current;
          const currentSid = boundSessionId || turnOwnerSid || activeIdRef.current;
          if (currentSid) {
            messageCacheRef.current.set(currentSid, next);
            const ph = activeSession?.project_hash || projectHashBySessionRef.current.get(currentSid) || '';
            if (ph) {
              const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(currentSid) ?? []);
              commitCanvasCache(ph, currentSid, {
                messages: next,
                todos: activeTodosRef.current,
                turns: currentOutline,
                tokenUsage: cachedTokenUsageFor(currentSid),
              });
            }
          }
          await restoreClaimedQueueCard(boundSessionId || turnOwnerSid || activeIdRef.current);
          // The card itself is the feedback. Do not append a system notice for
          // an automatic drain / refreshed send that raced a still-running turn;
          // that notice was pure noise (and duplicated the card's 排队中 label).
        } else {
          appendToLastAssistant('\n\n' + t('chat.connError', { msg }));
          if (opts?.requestId) {
            await restoreClaimedQueueCard(boundSessionId || turnOwnerSid || activeIdRef.current);
          }
        }
      }
      if (stillCurrent) {
        const errorSid = boundSessionId || turnOwnerSid || activeIdRef.current;
        if (errorSid) {
          // A 409 means the backend turn is STILL RUNNING: keep its live watcher
          // (or attach one below). Aborting it here was why a refreshed page
          // queued a card, never saw the terminal, and needed a second refresh.
          if (!isConflict) {
            sessionWatchersRef.current.get(errorSid)?.abort();
            sessionWatchersRef.current.delete(errorSid);
          }
          // The POST that 409'd did NOT start a local turn. Its local marker is
          // stale; `settleToIdleWatch` guards on this set and would otherwise
          // ignore the watcher's terminal, freezing the restored card.
          localTurnSessionsRef.current.delete(errorSid);
          localActiveStreamsBySessionRef.current.delete(errorSid);
          pendingSelfEchoBySessionRef.current.delete(errorSid);
        }
        pendingSelfEchoRef.current = pendingSelfEchoRef.current.filter((p) => p.id !== requestId);
        if (isConflict) {
          // 会话仍处于活跃执行中，维持 busy 状态与看门狗，安全挂起自动 drain。
          // After a refresh there may be no watcher yet: attach one so the
          // running turn's terminal wakes the drain without another refresh.
          if (errorSid && !sessionWatchersRef.current.has(errorSid)) {
            const ph =
              activeSession?.project_hash ||
              projectHashBySessionRef.current.get(errorSid) ||
              viewedProjectHashRef.current ||
              '';
            startDetachedHistoryPoll(ph, errorSid, sessionGenerationRef.current);
          }
          setBusyAndClock(true);
          busyRef.current = true;
          if (turnOwnerSid) {
            // Do NOT mark a current-view conflict as a background-running session.
            // `settleToIdleWatch` guards on that set and would ignore the watcher's
            // terminal, leaving the restored queue card stuck until a refresh.
            onTurnRunningChange?.(turnOwnerSid, true);
          }
        } else {
          disarmTurn(turnOwnerSid);
          setBusyAndClock(false);
          if (turnOwnerSid) {
            localTurnSessionsRef.current.delete(turnOwnerSid);
            onTurnRunningChange?.(turnOwnerSid, false);
          }
        }
        blockQueueDrainRef.current = true; // 连接错误或并发冲突：暂停自动 drain，但坚决保留排队与转向消息不丢失
        // 中止/连接错误时流被掐断，不会再有 done/stopped 事件 → 兜底清掉审批卡片，
        // 否则点「停止」时若正挂着审批卡片，它会一直残留。
        onPermissionResolved?.(null);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (activeStreamRequestIdRef.current === requestId) activeStreamRequestIdRef.current = null;
      if (turnOwnerSid && localActiveStreamsBySessionRef.current.get(turnOwnerSid)?.abortController === controller) {
        localActiveStreamsBySessionRef.current.delete(turnOwnerSid);
      }
      if (
        requestIdRef.current === requestId &&
        sessionGenerationRef.current === requestGeneration &&
        !keepStopAlias
      ) requestIdRef.current = null;
    }
    return deliveryOutcome;
  }

  /**
   * 发送一条消息。
   *
   * `options.asSteerCard`（Ctrl/Cmd+Enter）：在回合执行中不直接发送，而是落成
   * 待发卡片并立即执行「转向」，让插话无需鼠标介入。
   */
  async function sendMessage(explicitText?: string | Event, options?: { asSteerCard?: boolean }) {
    const rawText = typeof explicitText === 'string' ? explicitText : input;
    const currentTargetSid = sessionId ?? activeIdRef.current;
    if (currentTargetSid) {
      clearManualStopGuard(currentTargetSid);
    }
    const originalInput = rawText;
    const submittedContext = historyContext;
    const recordAcceptedInput = (acceptedSessionId?: string) => inputHistoryRef.current.record(
      !sessionId && acceptedSessionId ? inputHistoryKey(historyProject, acceptedSessionId) : submittedContext,
      originalInput,
    );
    const text = rawText.trim();
    const attach = pendingAttach;
    const images = pendingImageData(attach);
    const files = attach.filter((item): item is PendingFile => item.kind === 'file');
    if (modeState.pendingMode) return;
    if (uploading) return;
    if (!text && attach.length === 0) return;

    // 斜杠命令拦截：命中已知命令则执行且不作为聊天发送。带附件时不拦截。
    if (attach.length === 0) {
      const parsed = parseSlashCommand(text);
      if (parsed && slashCommandMap.has(parsed.name)) {
        setInput('');
        setPendingAttach([]);
        clearComposerDraft(activeIdRef.current || sessionId);
        clearComposerDraft(null);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setSlashOpen(false);
        setHistoryHint(null);
        // 命令执行后仍然回到主输入框，保证连续输入不中断；
        // 若命令本身打开了弹窗，弹窗的 focus 会在这之后接管。
        focusComposerSoon();
        try {
          const result = await dispatchSlashCommand(text, slashCommandMap, slashHandlers);
          if (result.handled) recordAcceptedInput();
        } catch (e) {
          pushCommandNotice(t('chat.connError', { msg: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }
    }

    if (!chatRecoveryPolicy(chatRecoveryRef.current).allowSend) {
      showToast(
        chatRecoveryRef.current === 'detached_active'
          ? t('chat.detachedSendBlocked')
          : t('chat.recoveryBlocked'),
        'warning',
      );
      return;
    }

    let messageText = text;
    if (files.length > 0) {
      if (!effectiveWorkingDir) {
        setAttachError(t('attach.noCwd'));
        return;
      }
      setAttachError(null);
      setInput('');
      setPendingAttach([]);
      clearComposerDraft(activeIdRef.current || sessionId);
      clearComposerDraft(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      // 立即发送（非排队）时把焦点还给输入框；排队/转向路径保持既有卡片焦点设计。
      if (!busy && !isCompacting) focusComposerSoon();
      setUploading(true);
      try {
        const paths = await uploadSessionFiles(
          effectiveWorkingDir,
          files.map((item) => item.file),
          setUploadProgress,
        );
        messageText = formatUserMessageWithAttachments(text, paths);
      } catch (error) {
        setPendingAttach((current) => {
          if (current.length === 0) return attach;
          const seen = new Set(current.map((item) => item.id));
          return [...attach.filter((item) => !seen.has(item.id)), ...current];
        });
        setInput((current) => current.trim() ? current : text);
        setAttachError(t('attach.uploadFailed', { msg: error instanceof Error ? error.message : String(error) }));
        setUploading(false);
        setUploadProgress(null);
        return;
      }
      setUploading(false);
      setUploadProgress(null);
    } else {
      // 清空输入框（无论立即发送还是排队）。有文件时已在上传开始时清过，避免覆盖用户新输入。
      setInput('');
      setPendingAttach([]);
      clearComposerDraft(activeIdRef.current || sessionId);
      clearComposerDraft(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      // 立即发送（非排队）时把焦点还给输入框；排队/转向路径保持既有卡片焦点设计。
      if (!busy && !isCompacting) focusComposerSoon();
    }
    setHistoryHint(null);

    const userDelta = estimateTextTokens(messageText);
    lastUserTokensRef.current = userDelta;
    if (userDelta > 0) {
      setTokens((prev) => mergeLocalTokens(prev, {
        prompt: (prev?.prompt ?? 0) + userDelta,
        completion: prev?.completion ?? 0,
        total: (prev?.total ?? 0) + userDelta,
        reasoning: 0,
      }));
    }

    if (busy || isCompacting) {
      const card: QueuedMessage = {
        id: randomUUID(),
        text: messageText,
        images: images.length ? images : undefined,
        approvalMode: modeState.confirmedMode,
        kind: 'queue',
        // Stable identity: the atomic queue-claim key AND the eventual prompt id.
        clientInputId: randomUUID(),
        createdAt: Date.now(),
      };
      setQueued((q) => [...q, card]);
      recordAcceptedInput(); // Accepted into this session's next-turn queue.
      if (options?.asSteerCard) {
        // Ctrl+Enter：卡片落地的瞬间就替用户点下「转向」，无需再动鼠标。
        setFocusCardId(null);
        void handleSteerQueuedMessage(card);
        return;
      }
      // 普通回车：把键盘焦点交给卡片按钮，方向键切换动作、回车即点击。
      setFocusCardId(queueCardSyncKey(card));
      return;
    }

    // 立即发送：无论此前是否因上传/短暂忙碌跳过了首帧聚焦，这里都确保
    // 键盘焦点回到主输入框；排队/转向路径在上面的分支已 return，不受影响。
    focusComposerSoon();
    await deliver(messageText, images, modeState.confirmedMode, recordAcceptedInput);
  }

  // 当前回合结束(done)后，依次发送仍在排队的消息。已转向的消息由内核在下一步并入本轮，不再另开一回合。
  useEffect(() => {
    if (blockQueueDrainRef.current) {
      blockQueueDrainRef.current = false;
      return;
    }
    const currentSid = activeIdRef.current || sessionId;
    // 视图切换尚未落定时不要 drain：否则会把旧会话的排队卡按当前输入发出去。
    if (sessionId && currentSid && sessionId !== currentSid) return;
    const isSessionLoading = loading || (currentSid != null && loadedForRef.current !== currentSid);
    const isSessionRunning =
      busy ||
      isCompacting ||
      (currentSid != null && (
        backgroundRunningSessionsRef.current.has(currentSid) ||
        localTurnSessionsRef.current.has(currentSid) ||
        compactingSessionsRef.current.has(currentSid)
      ));
    // Hydration restores local cards before the server runtime snapshot lands.
    // Draining in that window can claim a card while the turn is actually busy,
    // then lose it when the page refreshes again. Only an authoritative runtime
    // snapshot may open the drain gate.
    const runtimeAuthoritative = !!currentSid
      && runtimeAuthoritativeBySessionRef.current.has(currentSid);
    if (
      isSessionRunning ||
      !runtimeAuthoritative ||
      queued.length === 0 ||
      modeState.pendingMode ||
      isSessionLoading ||
      !chatRecoveryPolicy(chatRecoveryRef.current).allowQueueDrain
    ) return;

    // 身份优先：不仅检查当前 messages，还检查 messageCacheRef 中的完整缓存。
    // A historical same-text prompt is NOT this card; legacy no-id cards only
    // match a row created at/after the card.
    const allKnownMessages = [
      ...messages,
      ...(currentSid ? (messageCacheRef.current.get(currentSid) ?? []) : []),
    ];
    const itemOnCanvas = (item: QueuedMessage) => queueCardAlreadyOnCanvas(allKnownMessages, item);

    const alreadyDelivered = queued.filter((item) => !item.forceSend && itemOnCanvas(item));
    if (alreadyDelivered.length > 0) {
      setQueued((current) => current.filter((item) => item.forceSend || !itemOnCanvas(item)));
      return;
    }

    const next = queuedRef.current.find((item) => item.kind === 'queue' && item.forceSend)
      ?? queuedRef.current.find((item) => item.kind === 'queue');
    if (!next) return;
    if (!next.forceSend && itemOnCanvas(next)) {
      setQueued((current) => current.filter((item) => item.id !== next.id));
      return;
    }
    void dispatchQueuedCard(next);
    // deliver 为组件内函数声明，闭包始终取最新渲染值；仅以 busy/queued 触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isCompacting, queued, messages, loading, modeState.pendingMode, chatRecovery, runtimeAuthorityEpoch]);

  /** Stop / 外部停止：把还没发出去的队列（含尚未确认的转向）整段还回输入框。 */
  async function restoreQueuedToComposer() {
    const items = queuedRef.current;
    if (items.length === 0) return;
    blockQueueDrainRef.current = true;
    const steerItems = items.filter((item) => item.kind === 'steer' || item.kind === 'steering');
    if (steerItems.length > 0) {
      const targetSid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
      if (targetSid) {
        // Await the id-precise cancellations before restoring the text. Firing
        // them in the background let a fast re-send be matched and removed by
        // the still-pending cancel (the "steer gets swallowed" bug).
        await Promise.all(steerItems.map((item) => cancelChatSteer(
          targetSid,
          item.clientInputId ? undefined : item.text,
          item.clientInputId,
        ).catch(() => undefined)));
      }
    }
    setQueued([]);
    setInput((current) => mergeQueuedIntoDraft(items, current, []).text);
    const queuedImages = items.flatMap((item) => item.images ?? []);
    if (queuedImages.length > 0) {
      setPendingAttach((current) => [
        ...current,
        ...imagesToPending(queuedImages),
      ]);
    }
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
      }
    }, 0);
  }

  /** 用户点击排队消息上的 × 撤回：从队列移除并完整回填文字与全部图片到输入框，避免输入前功尽弃。 */
  async function handleCancelQueuedMessage(q: QueuedMessage) {
    localUnsyncedQueueIdsRef.current.delete(queueCardSyncKey(q));
    if (q.clientInputId) localUnsyncedQueueIdsRef.current.delete(q.clientInputId);
    localUnsyncedQueueIdsRef.current.delete(String(q.id));
    // 关键防线：如果该消息已经作为转向投递给了后端（kind === 'steer' 或 'steering'），
    // 必须立即通知后端撤回内核缓冲区中的该转向，防止下一小步或下一轮被执行！
    if (q.kind === 'steer' || q.kind === 'steering') {
      const targetSid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
      if (targetSid) {
        // Identity first. The old text-only cancel used substring matching and
        // could remove the user's next re-send of the same prompt.
        await cancelChatSteer(
          targetSid,
          q.clientInputId ? undefined : q.text,
          q.clientInputId,
        ).catch(() => undefined);
      }
    }

    const cancelKey = queueCardSyncKey(q);
    setQueued((arr) => arr.filter((item) => queueCardSyncKey(item) !== cancelKey));
    const targetSid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
    forgetCancelledSteerOutline(targetSid, q);
    if (targetSid) {
      const currentList = queuedBySessionRef.current.get(targetSid) ?? [];
      const updatedList = currentList.filter((item) => queueCardSyncKey(item) !== cancelKey);
      if (updatedList.length > 0) {
        queuedBySessionRef.current.set(targetSid, updatedList);
      } else {
        queuedBySessionRef.current.delete(targetSid);
      }
      saveQueuedToStorage(queuedBySessionRef.current);
      void saveChatQueue(
        targetSid,
        updatedList.map(serializeQueuedCard) as QueuedMessageApiItem[],
        queueRevisionBySessionRef.current.get(targetSid),
      )
        .then((result) => {
          queueRevisionBySessionRef.current.set(targetSid, result.revision);
          if (result.conflict) refreshQueuedFromServer(targetSid);
        })
        .catch(() => {});
    }

    if (q.text) {
      setInput((current) => (current.trim() ? `${q.text}\n${current}` : q.text));
    }

    if (q.images && q.images.length > 0) {
      const restoredImages: PendingAttach[] = q.images.map((img, idx) => ({
        id: `restored-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'image' as const,
        image: img,
      }));
      setPendingAttach((current) => [...current, ...restoredImages]);
    }

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
      }
    }, 0);
  }

  /**
   * Steer a queued follow-up into the running turn.
   * The daemon does not cancel the in-flight model call or tool batch; the kernel
   * folds the text (plus a short course-correction note) in at the next step.
   */
  async function handleSteerQueuedMessage(
    q: QueuedMessage,
    opts?: { silentFailure?: boolean },
  ): Promise<boolean> {
    if (q.kind !== 'queue') return false;
    // request id is an admission alias before session_assigned lands on a new chat.
    const sid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
    if (sid) {
      recordUserSteer(sid);
    }
    if (!sid) {
      if (!opts?.silentFailure) pushCommandNotice(t('chat.steerFailed', { msg: 'no session' }));
      return false;
    }
    const targetSid = sid;
    // 客户端关联键：随卡片持久化，刷新后与内核回传的 client_input_ids 对账。
    const clientInputId = q.clientInputId ?? randomUUID();
    const updateTargetQueued = (
      updater: (item: QueuedMessage) => QueuedMessage,
      opts?: { localOnly?: boolean },
    ) => {
      const targetKey = queueCardSyncKey(q);
      const applyTo = (items: QueuedMessage[]) =>
        items.map((item) => (queueCardSyncKey(item) === targetKey ? updater(item) : item));
      if (opts?.localOnly) {
        // `steering` 只是 `postChatSteer` 飞行几十毫秒的本端过渡态，只改本地响应式状态，
        // 不触发 `saveChatQueue` 网络请求，彻底消除与落定后 `kind: 'steer'` 的并发 POST 乱序竞态。
        if (activeIdRef.current === targetSid || queuedRef.current.some((item) => queueCardSyncKey(item) === targetKey)) {
          const next = applyTo(queuedRef.current);
          queuedRef.current = next;
          if (targetSid) {
            if (next.length > 0) queuedBySessionRef.current.set(targetSid, [...next]);
            else queuedBySessionRef.current.delete(targetSid);
            saveQueuedToStorage(queuedBySessionRef.current);
          }
          setQueuedState(next);
          return;
        }
        const next = applyTo(queuedBySessionRef.current.get(targetSid) ?? []);
        if (next.length > 0) queuedBySessionRef.current.set(targetSid, [...next]);
        else queuedBySessionRef.current.delete(targetSid);
        saveQueuedToStorage(queuedBySessionRef.current);
        return;
      }
      // 卡片就在当前视图里时走响应式更新：新建会话的 request id 别名尚未绑定
      // session id，此刻 activeIdRef 仍为空，卡片状态不能只写进后台持久化副本。
      if (activeIdRef.current === targetSid || queuedRef.current.some((item) => queueCardSyncKey(item) === targetKey)) {
        setQueued(applyTo);
        return;
      }
      // 定向更新目标会话队列：前台/后台两态与 localStorage、后端 `/chat/queue` 三处同步。
      persistSessionQueue(targetSid, applyTo(queuedBySessionRef.current.get(targetSid) ?? []));
    };

    updateTargetQueued((item) => ({ ...item, kind: 'steering' as const, clientInputId }), {
      localOnly: true,
    });
    localUnsyncedQueueIdsRef.current.add(clientInputId);
    localUnsyncedQueueIdsRef.current.add(String(q.id));
    try {
      // Persist the intent first so a reload cannot strand a click that never
      // reached the daemon. A failed queue write still allows the POST below,
      // whose server fallback also records the steering card.
      await admitChatSteer(
        targetSid,
        q.text,
        q.images,
        clientInputId,
        q.createdAt ?? Date.now(),
        q.approvalMode,
      );
      // Admission made the server queue authoritative; never echo this card
      // back through /chat/queue from the generic unsynced reconciler.
      localUnsyncedQueueIdsRef.current.delete(clientInputId);
      localUnsyncedQueueIdsRef.current.delete(String(q.id));
      await postChatSteer(
        targetSid,
        q.text,
        q.images,
        clientInputId,
        q.createdAt ?? Date.now(),
        q.approvalMode,
      );
      // 成功投递后，卡片保留并更新为 'steer' 状态（展示「转向已排队 · 等待当前步骤完成」与取消按钮）！
      // 状态转换只做本地展示；服务端 /chat/steer 已原子更新队列，避免并发整表写回。
      updateTargetQueued((item) => ({ ...item, kind: 'steer' as const }), { localOnly: true });
      // Keep the pending rail row alive immediately; waiting for the next
      // detail poll made the title flash/disappear while the model was thinking.
      if (!turnOutlineRef.current.some((turn) => turn.id === clientInputId)) {
        rememberTurnOutline(
          q.text || (q.images?.length ? '[图片]' : ''),
          nextTurnNavIndex(),
          nextOutlineOrdinal(),
          clientInputId,
          targetSid,
        );
      }
      // 服务端已把转向收进运行中的回合 —— 这是「会话仍在干活」的权威证据，
      // 立即点亮运行态，避免上一轮终态把按钮误切回发送箭头。
      armRunningForSession(targetSid);
      return true;
    } catch (error) {
      // A reload/network abort may leave the server-owned `steering` record
      // intact. Never overwrite it with a stale whole-list write here; the
      // daemon already demotes genuine rejections and broadcasts the new queue.
      updateTargetQueued(
        (item) => (item.kind === 'steering' ? { ...item, kind: 'queue' as const } : item),
        { localOnly: true },
      );
      forgetCancelledSteerOutline(targetSid, { ...q, clientInputId });
      if (!opts?.silentFailure) {
        pushCommandNotice(t('chat.steerFailed', { msg: error instanceof Error ? error.message : String(error) }));
      }
      return false;
    } finally {
      localUnsyncedQueueIdsRef.current.delete(clientInputId);
      localUnsyncedQueueIdsRef.current.delete(String(q.id));
    }
  }

  /**
   * 停止运行中的回合：WebUI「停止」按钮与排队卡「立即发送」共用的唯一停止通道。
   *
   * 别名策略见 `runningTurnStopAliases`：本端回合被 /chat admit（202 已受理）之后 requestIdRef
   * 即被清空，会话 id 才是长期有效的停止别名，只认 request id 会让停止被整体跳过。
   * 后端 /chat/stop 经由 stop_and_wait 同步等待上一回合完全退出注册表，await 返回即代表槽位已释放，
   * 调用方可以 0 延迟发起新的投递（绝不 409 抢跑）。
   */
  async function stopRunningTurn(currentSid: string | null, requestAlias: string | null): Promise<boolean> {
    const stopPromises: Promise<boolean>[] = runningTurnStopAliases({
      requestAlias,
      sessionId: currentSid,
    }).map((alias) => stopChat(alias).then((result) => stopAliasAllowsNextTurn(result), () => false));
    if (stopPromises.length === 0) return true; // 无停止目标：本就空闲
    const results = await Promise.all(stopPromises);
    return results.every(Boolean);
  }

  /**
   * 队列卡片的唯一投递出口：出队（内存 / localStorage / 后端三处同步）后立刻作为新回合发出。
   * 卡片随消息真正成为正文而自然销毁——drain 自动发送与「立即发送」共用此通道。
   */
  async function dispatchQueuedCard(item: QueuedMessage) {
    const itemKey = queueCardSyncKey(item);
    // 以 ref 为准做去重：两个投递入口可能在同一批渲染里竞争同一张卡片。
    if (!queuedRef.current.some((entry) => queueCardSyncKey(entry) === itemKey)) return;
    const sid = activeIdRef.current ?? sessionId;
    // Stable identity: claim key == eventual prompt id. Legacy cards fall back
    // to their local id so two tabs still share one key.
    const claimId = item.clientInputId ?? String(item.id);
    setQueued((current) => current.filter((entry) => queueCardSyncKey(entry) !== itemKey));

    if (sid) {
      let claimed: boolean | null;
      try {
        claimed = await claimChatQueue(
          sid,
          claimId,
          serializeQueuedCard({ ...item, clientInputId: claimId }) as QueuedMessageApiItem,
        );
      } catch {
        claimed = null;
      }
      if (claimed === false) {
        // Another tab already owns this card; drop the stale local copy.
        setQueued((current) => current.filter((entry) => queueCardSyncKey(entry) !== itemKey));
        return;
      }
      if (claimed === null) {
        // Transport error: restore and pause the drain rather than risk a
        // duplicate delivery on the next pass.
        blockQueueDrainRef.current = true;
        setQueued((current) => (
          current.some((entry) => queueCardSyncKey(entry) === itemKey) ? current : [item, ...current]
        ));
        return;
      }
    }

    const opts = {
      ...(item.forceSend
        ? { alreadyOnCanvas: true, preserveCanvasOnBusy: true as const }
        : {}),
      jumpToBottom: false as const,
      requestId: claimId,
    };
    const outcome = await deliver(
      item.text,
      item.images ?? [],
      item.approvalMode ?? modeState.confirmedMode,
      undefined,
      undefined,
      opts,
    );
    if (outcome === 'ok') return;
    // `deliver` already requeues a 409 card; only restore when no copy exists.
    if (queuedRef.current.some((entry) => queueCardSyncKey(entry) === claimId)) return;
    if (sid) {
      await releaseChatQueue(
        sid,
        claimId,
        serializeQueuedCard({
          ...item,
          kind: 'queue',
          forceSend: true,
          clientInputId: claimId,
        }) as QueuedMessageApiItem,
      );
    }
    blockQueueDrainRef.current = true;
    setQueued((current) => (
      current.some((entry) => queueCardSyncKey(entry) === claimId)
        ? current
        : [{ ...item, kind: 'queue', forceSend: true, clientInputId: claimId }, ...current]
    ));
  }

  /** 立即发送：点击当下就把卡片画成用户气泡，不等停止和投递的网络往返。 */
  function paintSendNowUserBubble(
    text: string,
    images: ImageData[],
    isSteer = false,
    requestId?: string,
  ) {
    const clean = visibleUserText(text).trim();
    // Identity is authoritative for send-now. A repeated identical message is a
    // real second prompt; only the SAME request id means "already painted".
    if (requestId) {
      if (messagesRef.current.some((m) => m.role === 'user' && (
        m.id === requestId || m.clientInputId === requestId
      ))) {
        return;
      }
    } else {
      // Legacy/text fallback: there is no identity to compare.
      if (clean && messagesRef.current.some((m) => (
        m.role === 'user'
        && m.parts.some((p) => p.kind === 'text' && userTextsMatch(p.text || '', clean))
      ))) {
        return;
      }
      if (!clean && images.length > 0 && messagesRef.current.some((m) => (
        m.role === 'user' && sameImageSet(m.images, images)
      ))) {
        return;
      }
    }
    const now = Date.now();
    const turnIndex = nextTurnNavIndex();
    rememberTurnOutline(clean || (images.length > 0 ? '[图片]' : ''), turnIndex, nextOutlineOrdinal(), requestId);
    const cur = messagesRef.current;
    const tail = cur[cur.length - 1];
    const base =
      tail && tail.role === 'assistant' && (!tail.parts || tail.parts.length === 0)
        ? cur.slice(0, -1)
        : cur;
    const next: Message[] = [
      ...base,
      {
        role: 'user',
        parts: [{ kind: 'text', text: clean }],
        images: images.length ? images : undefined,
        ts: now,
        isSteer: isSteer || isSteerUserMessage({ content: text }) ? true : undefined,
        // Mint the persisted identity BEFORE painting. The stop/disk reconcile can
        // run before the POST returns; without this id the optimistic row looks
        // like a duplicate of the previous same-text prompt and gets removed.
        ...(requestId ? { id: requestId, clientInputId: requestId } : {}),
      },
    ];
    setMessages({ type: 'replace', rows: next });
    const normalizedNext = messagesRef.current;
    const sid = activeIdRef.current ?? sessionId;
    if (sid) {
      messageCacheRef.current.set(sid, normalizedNext);
      const ph = activeSession?.project_hash || projectHashBySessionRef.current.get(sid) || viewedProjectHashRef.current || '';
      if (ph) {
        const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []);
        commitCanvasCache(ph, sid, {
          messages: normalizedNext,
          todos: activeTodosRef.current,
          turns: currentOutline,
          tokenUsage: cachedTokenUsageFor(sid),
        });
      }
    }
    timelineFollow.jump();
  }

  /** 这张待发/转向卡是否已经被内核并入本轮（画布气泡、会话大纲或内核回执账本命中）。 */
  function queuedCardOnCanvas(
    messages: Message[],
    item: QueuedMessage,
    sid: string | null = activeIdRef.current ?? sessionId ?? null,
  ): boolean {
    const cid = item.clientInputId;
    if (cid) {
      const outline = (sid ? turnOutlineBySessionRef.current.get(sid) : undefined) ?? turnOutlineRef.current;
      if (queueCardPresentInOutline(outline, cid)) return true;
    }
    return queueCardAlreadyOnCanvas(messages, item)
      || steerCardBubbleOnCanvas(messages, item);
  }

  /** 当权威转录与大纲水合完成后，淘汰本地队列中实际已落盘/已并入的陈旧卡片。 */
  function pruneDeliveredQueuedCards(sid: string, messages: Message[]) {
    if (!sid) return;
    const isCurrentView = activeIdRef.current === sid;
    const currentList = isCurrentView ? queuedRef.current : (queuedBySessionRef.current.get(sid) ?? []);
    if (currentList.length === 0) return;
    const filtered = currentList.filter(
      (item) => !queuedCardOnCanvas(messages, item, sid) && !steerCardAlreadyFolded(item, sid, messages),
    );
    if (filtered.length !== currentList.length) {
      updateQueuedForSession(sid, () => filtered);
    }
  }

  function steerCardAlreadyFolded(
    q: QueuedMessage,
    sid: string | null,
    known: Message[] = messagesRef.current,
  ): boolean {
    const folded = sid ? (foldedSteersBySessionRef.current.get(sid) ?? []) : [];
    const onCanvas = steerCardBubbleOnCanvas(known, q);
    const alreadyFolded = folded.some((entry) =>
      q.clientInputId
        ? entry.clientInputId === q.clientInputId
        : entry.text.trim() === q.text.trim(),
    );
    return onCanvas || alreadyFolded;
  }

  /** 只回收卡片（内存 / localStorage / 后端三处），不碰输入框。 */
  function retireQueuedCard(q: QueuedMessage, sid: string | null) {
    const key = queueCardSyncKey(q);
    if (queuedRef.current.some((item) => queueCardSyncKey(item) === key)) {
      setQueued((items) => items.filter((item) => queueCardSyncKey(item) !== key));
    } else if (sid) {
      updateQueuedForSession(sid, (items) => items.filter((item) => queueCardSyncKey(item) !== key));
    }
  }

  /** 等待正在投递的转向卡落定（steering → steer / queue），返回最新卡片。 */
  async function waitForSteerCardSettled(
    cardKey: string,
    timeoutMs = 8000,
  ): Promise<QueuedMessage | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = queuedRef.current.find((item) => queueCardSyncKey(item) === cardKey) ?? null;
      if (!current) return null;
      if (current.kind !== 'steering' || Date.now() >= deadline) return current;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
  }

  /**
   * 立即发送 = 卡片立刻变成用户气泡，停掉当前回合，再把这条消息作为新回合发出。
   * 右下角「已停止」通知仍被抑制。槽位一时没松开就短重试；气泡不再等到刷新才出现。
   */
  async function handleSendImmediately(q: QueuedMessage) {
    const viewSid = activeIdRef.current ?? sessionId ?? null;
    const currentSid = viewSid;
    const isSteerCard =
      q.kind === 'steer' || q.kind === 'steering' || isSteerUserMessage({ content: q.text });
    // Capture this BEFORE we set busy below: a running turn means the user is
    // changing direction (keep the continuous timer); an already-stopped turn
    // means the previous task completed (start a fresh clock).
    const wasRunning =
      busyRef.current ||
      (!!currentSid && (
        localTurnSessionsRef.current.has(currentSid) ||
        backgroundRunningSessionsRef.current.has(currentSid)
      ));

    // The queue drain may already have delivered this card as the next turn while
    // the stale card stayed visible (or came back from the server queue). Do not
    // stop the running turn and send the SAME text a second time. A matching user
    // row created AFTER the card was queued is the proof.
    if (!isSteerCard && !q.forceSend) {
      const latestUser = [...messagesRef.current].reverse().find((m) => m.role === 'user');
      const latestText = latestUser?.parts
        ?.filter((part) => part.kind === 'text')
        .map((part) => part.text || '')
        .join('') ?? '';
      if (queueCardAlreadyDelivered({
        running: wasRunning,
        latestUserTs: latestUser?.ts,
        cardCreatedAt: q.createdAt,
        sameIdentity: !!q.clientInputId && latestUser?.id === q.clientInputId,
        sameText: !q.clientInputId && userTextsMatch(visibleUserText(latestText), visibleUserText(q.text)),
      })) {
        setQueued((items) => items.filter((item) => queueCardSyncKey(item) !== queueCardSyncKey(q)));
        if (!currentSid) return;
        updateQueuedForSession(currentSid, (items) => items.filter((item) => queueCardSyncKey(item) !== queueCardSyncKey(q)));
        return;
      }
    }

    // 「立即发送」对转向卡的服务端裁决（唯一决策点）：
    // - folded：已经并入正文 → 只回收卡片，绝不重复投递；
    // - queue：还没投递过 → 先问 /chat/steer，服务端受理就并入当前回合；
    //   只有它明确拒绝（没有可转向的回合）才回退「停止 + 新回合投递」；
    // - steer / steering：内核缓冲区里已经排着这条转向。send-now 的语义是
    //   「别等下一步，现在发」，因此必须先撤销那条排队转向，否则同一条指令
    //   会执行两次（转向一次 + 新回合一次）。
    if (isSteerCard) {
      let effectiveKind = q.kind;
      if (effectiveKind === 'steering') {
        const settled = await waitForSteerCardSettled(queueCardSyncKey(q));
        if (!settled) return; // 卡片已被消费 / 撤掉
        effectiveKind = settled.kind;
      }
      const action = resolveSendNowSteerAction({
        kind: effectiveKind,
        folded: steerCardAlreadyFolded(q, currentSid),
      });
      if (action === 'retire') {
        retireQueuedCard(q, currentSid);
        return;
      }
      if (action === 'steer') {
        const steered = await handleSteerQueuedMessage(
          { ...q, kind: 'queue' },
          { silentFailure: true },
        );
        if (steered) return;
      } else {
        const sid = sessionId ?? activeIdRef.current ?? requestIdRef.current;
        if (sid) {
          await cancelChatSteer(
            sid,
            q.clientInputId ? undefined : q.text,
            q.clientInputId,
          ).catch(() => undefined);
        }
        // 撤销与内核 fold 可能赛跑：若这条转向在这期间已经并入正文，只回收卡片。
        if (steerCardAlreadyFolded(q, currentSid)) {
          retireQueuedCard(q, currentSid);
          return;
        }
      }
    }

    // Claim the card BEFORE stopping the running turn. If another tab already
    // owns it, this tab must not stop the turn or send a duplicate.
    const claimId = q.clientInputId ?? String(q.id);
    if (currentSid) {
      let claimed: boolean;
      try {
        claimed = await claimChatQueue(
          currentSid,
          claimId,
          serializeQueuedCard({ ...q, clientInputId: claimId }) as QueuedMessageApiItem,
        );
      } catch {
        // Transport error: keep the card and the running turn untouched.
        return;
      }
      if (!claimed) {
        if (queuedRef.current.some((item) => queueCardSyncKey(item) === queueCardSyncKey(q))) {
          setQueued((items) => items.filter((item) => queueCardSyncKey(item) !== queueCardSyncKey(q)));
        } else {
          updateQueuedForSession(currentSid, (items) => items.filter((item) => queueCardSyncKey(item) !== queueCardSyncKey(q)));
        }
        return;
      }
    }

    const targetIds = [currentSid, sessionId, activeIdRef.current, requestIdRef.current].filter(Boolean) as string[];
    for (const sid of targetIds) {
      clearManualStopGuard(sid);
      recordUserManualStop(sid);
      recordUserSteer(sid);
    }

    if (queuedRef.current.some((item) => queueCardSyncKey(item) === queueCardSyncKey(q))) {
      setQueued((items) => items.filter((item) => queueCardSyncKey(item) !== queueCardSyncKey(q)));
    } else if (currentSid) {
      updateQueuedForSession(currentSid, (items) => items.filter((item) => queueCardSyncKey(item) !== queueCardSyncKey(q)));
    }

    // 1. 「立即发送」会把当前 turn 换掉。标记必须绑定旧 operation id：
    // 新 daemon 的 done/stopped 都带 operation_id，只有旧回合的终态能被吞掉；
    // 新回合的终态即使在同一 session 也会因 operation_id 不同而正常收尾。
    if (viewSid) {
      const knownOperationId = currentOperationBySessionRef.current.get(viewSid);
      const supportsTerminalOperationId =
        !!knownOperationId || serverCapsRef.current.includes('terminal_operation_id');
      const displacedOperationId = supportsTerminalOperationId
        ? (knownOperationId ?? requestIdRef.current ?? undefined)
        : undefined;
      const mark = {
        sessionId: viewSid,
        expiresAt:
          Date.now() +
          (displacedOperationId
            ? DISPLACED_TERMINAL_MARK_TTL_MS
            : PROGRAMMATIC_STOP_MARK_TTL_MS),
        ...(displacedOperationId ? { operationId: displacedOperationId } : {}),
      };
      programmaticStopMarkRef.current = mark;
      persistProgrammaticStopMark(mark);
    } else {
      programmaticStopMarkRef.current = null;
      persistProgrammaticStopMark(null);
    }

    const sendNowEpoch = beginSendNowHandover(currentSid);

    // 2. 关键：立即发送时保持/确立全局运行中（busy）状态，发送按钮立即呈现红色可停止方块。
    //    回合仍在跑 = 中途改变方向，保留连续工作计时器；
    //    回合已经 stop = 上一任务完成，新回合从此刻重新计时。
    setBusyAndClock(true, wasRunning ? undefined : Date.now());
    busyRef.current = true;
    if (currentSid) {
      localTurnSessionsRef.current.add(currentSid);
      onTurnRunningChange?.(currentSid, true);
    }

    // 3. 内核排队的转向已在上面按 identity 撤销（见 steer 分支）。
    //    这里不再用纯文本二次撤销：文本匹配可能误删同样内容的另一条转向。

    // A standalone new turn carries the user's plain text. The steer envelope
    // is a mid-turn instruction marker; it must not be replayed as a new turn.
    const text = q.text;
    const images = q.images ?? [];
    const mode = q.approvalMode ?? modeState.confirmedMode;

    // 4. 0ms 瞬间在画布绘制新用户气泡（带上 isSteer 标记，确保计时器向后穿透继承）。
    //    在落笔前先冲刷未上屏的文本缓冲并断开旧回合的观察流，防止 `stopRunningTurn`
    //    等待期间旧回合的残余尾流写到新用户气泡上方或下方。
    flushPendingText();
    if (currentSid) {
      sessionWatchersRef.current.get(currentSid)?.abort();
      sessionWatchersRef.current.delete(currentSid);
    }
    const requestId = claimId;
    paintSendNowUserBubble(text, images, isSteerCard, requestId);

    let deliveredNewTurn = false;
    try {
      // 5. 停掉旧回合，并确保旧回合的挂起工具/代码块在当前画布上干净收尾
      await stopRunningTurn(currentSid, requestIdRef.current);
      if (!isSendNowEpochAlive(currentSid, sendNowEpoch)) return;
      closeOpenArtifactFence();
      finalizePendingToolsOnCanvas();

      // 6. 投递新回合
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!isSendNowEpochAlive(currentSid, sendNowEpoch)) return;
        if (attempt > 0) {
          const released = await stopRunningTurn(currentSid, requestIdRef.current);
          if (!isSendNowEpochAlive(currentSid, sendNowEpoch)) return;
          if (!released) {
            await new Promise((resolve) => window.setTimeout(resolve, 200));
            continue;
          }
        }
        const outcome = await deliver(text, images, mode, undefined, undefined, {
          alreadyOnCanvas: true,
          preserveCanvasOnBusy: true,
          requestId,
        });
        if (outcome === 'ok') {
          deliveredNewTurn = true;
          setBusyAndClock(true);
          busyRef.current = true;
          return;
        }
        if (outcome === 'error') {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
      if (!isSendNowEpochAlive(currentSid, sendNowEpoch)) return;
      const card: QueuedMessage = { ...q, kind: 'queue', forceSend: true, clientInputId: requestId };
      if (currentSid) {
        await releaseChatQueue(
          currentSid,
          requestId,
          serializeQueuedCard(card) as QueuedMessageApiItem,
        );
      }
      // 复位 blockQueueDrainRef：一旦仍在收尾的旧回合最终结束，允许 drain 立即自动发出该 forceSend 卡，绝不死锁。
      blockQueueDrainRef.current = false;
      setQueued((current) => (
        current.some((entry) => queueCardSyncKey(entry) === requestId)
          ? current
          : [...current, card]
      ));
    } finally {
      endSendNowHandover(currentSid);
      if (currentSid && isSendNowEpochAlive(currentSid, sendNowEpoch)) {
        if (!deliveredNewTurn) {
          // 未能成功启动新回合（例如 5 次 409 后退回 forceSend 卡，而最后一次等待窗口内旧回合已结束）：
          // 立即复核运行态，若服务端已空闲则立刻复位 busy 并唤醒自动 drain。
          scheduleTrailingHandoverIdleVerify(currentSid, 0);
        } else if (suppressedIdleBySessionRef.current.has(currentSid)) {
          // 交接期间曾压住过一次权威 idle：安排一次尾随复核，防止新回合首帧前异常秒退导致按钮常亮。
          scheduleTrailingHandoverIdleVerify(currentSid, 250);
        }
      }
    }
  }

  function handleBubbleDraftChange(
    sourceIndex: number,
    text: string,
    images: ImageData[],
    selectedModel?: string,
  ) {
    if (
      bubbleEditDraft &&
      bubbleEditDraft.sourceIndex === sourceIndex &&
      bubbleEditDraft.text === text &&
      bubbleEditDraft.selectedModel === selectedModel &&
      (bubbleEditDraft.images?.length ?? 0) === (images?.length ?? 0)
    ) {
      return;
    }
    const draft: BubbleEditDraft = {
      sourceIndex,
      text,
      images,
      selectedModel,
    };
    setBubbleEditDraft(draft);
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    if (sid) {
      saveBubbleEditDraft(sid, draft);
    }
  }

  /** A mutation whose target was drained by compaction: say so instead of a raw 404. */
  function mutationTargetCompacted(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    // 只认**明确的压缩/已不存在的语义**，绝不再把普通的未找到当成“已被压缩”。
    return /compacted|drained|out of context|已被压缩/i.test(message) && !/not found|未找到/i.test(message);
  }

  /**
   * Edit/rewind removes every message after the edited prompt. Queued cards and
   * un-folded steers are future context too: drop them from memory, localStorage
   * and the daemon queue so a later drain cannot resurrect a removed branch.
   */
  function clearFutureInputsAfterRewrite(sid: string) {
    const queuedForSession = queuedBySessionRef.current.get(sid) ?? [];
    if (
      queuedForSession.length > 0 ||
      (activeIdRef.current === sid && queuedRef.current.length > 0)
    ) {
      persistSessionQueue(sid, []);
      if (activeIdRef.current === sid) setQueued([]);
    }
    pendingSteersBySessionRef.current.delete(sid);
    setStoredSteers(sid, []);
    if (activeIdRef.current === sid) setPendingSteers([]);
  }

  async function handleSaveRewrite(
    sourceIndex: number,
    newText: string,
    newImages: ImageData[],
    messageId?: string,
  ) {
    if (busyRef.current) {
      showToast(t('cmd.session.busy'), 'error');
      return;
    }
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const targetMsg = messagesRef.current.find((m) =>
      messageId
        ? m.role === 'user' && (m.id === messageId || m.clientInputId === messageId)
        : m.sourceIndex === sourceIndex,
    );
    const targetIndex = targetMsg?.sourceIndex ?? sourceIndex;
    const expectedText = targetMsg ? messageText(targetMsg) : undefined;

    setConfirmModal({
      open: true,
      title: t('confirm.rewriteTitle'),
      body: t('confirm.rewriteDesc'),
      danger: false,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        try {
          const result = await patchSessionMessage(effectiveHash, sid, targetIndex, {
            text: newText,
            images: newImages,
            expected_text: expectedText,
            expected_message_id: targetMsg?.id ?? messageId,
            expected_role: 'user',
            // Edit = rewrite: the edited prompt becomes the tail of the model
            // context; every later message is removed by the daemon atomically.
            truncate_after: true,
          });
          // 乐观更新：画布与内存缓存同步截断到被编辑的提问（含）。
          const targetMatches = (m: Message): boolean =>
            targetMsg?.id
              ? m.id === targetMsg.id || m.clientInputId === targetMsg.id
              : m.sourceIndex === targetIndex;
          setMessages({
            type: 'replace_match',
            match: targetMatches,
            update: (row) => ({
              ...row,
              parts: [{ kind: 'text', text: newText }],
              images: newImages.length ? newImages : undefined,
            }),
          });
          setMessages({ type: 'truncate_match', match: targetMatches, inclusive: true });
          const nextMessages = messagesRef.current;
          messageCacheRef.current.set(sid, nextMessages);
          // Outline converges by identity: keep the edited turn and everything
          // before it, refresh its label, drop every later anchor.
          const editedLabel = compactTurnNavText(
            stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(newText)),
          );
          const baseOutline =
            turnOutlineRef.current.length > 0
              ? turnOutlineRef.current
              : (turnOutlineBySessionRef.current.get(sid) ?? []);
          const nextOutline = baseOutline
            .filter((turn) => turn.index <= sourceIndex)
            .map((turn) =>
              turn.index === sourceIndex || (targetMsg?.id && turn.id === targetMsg.id)
                ? { ...turn, label: editedLabel }
                : turn,
            );
          turnOutlineRef.current = nextOutline;
          turnOutlineBySessionRef.current.set(sid, nextOutline);
          setTurnOutline(nextOutline);
          clearStreamCursor(sid);
          clearFutureInputsAfterRewrite(sid);
          // 权威反向灌入缓存：同步覆盖 L1 内存和 L2 IndexedDB，并锁定 revision，
          // 让随后到达的 session_mutated 成为幂等信号而不是再次全量重拉。
          commitCanvasCache(effectiveHash, sid, {
            messages: nextMessages,
            todos: activeTodosRef.current,
            turns: nextOutline,
            tokenUsage: cachedTokenUsageFor(sid),
            revision: result.revision,
          });
          cacheRevisionBySessionRef.current.set(sid, result.revision);
          setEditingSourceIndex(null);
          setBubbleEditDraft(null);
          clearBubbleEditDraft(sid);
        } catch (e) {
          showToast(
            mutationTargetCompacted(e)
              ? t('chat.messageCompacted')
              : t('common.error') + ': ' + (e instanceof Error ? e.message : String(e)),
            'error',
          );
        }
      },
    });
  }

  function handleRollbackSubmit(
    sourceIndex: number,
    newText: string,
    newImages: ImageData[],
    tempModel?: string,
    messageId?: string,
  ) {
    if (busyRef.current) {
      showToast(t('cmd.session.busy'), 'error');
      return;
    }
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      'default';
    if (!sid) return;

    const targetMsg = messagesRef.current.find((m) =>
      messageId
        ? m.role === 'user' && (m.id === messageId || m.clientInputId === messageId)
        : m.sourceIndex === sourceIndex,
    );
    const targetIndex = targetMsg?.sourceIndex ?? sourceIndex;
    const expectedText = targetMsg ? messageText(targetMsg) : undefined;

    setConfirmModal({
      open: true,
      title: t('confirm.rollbackTitle'),
      body: t('confirm.rollbackDesc'),
      danger: true,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        let mutationRevision: number | undefined;
        try {
          const result = await truncateSession(effectiveHash, sid, {
            target_index: targetIndex,
            target_message_id: targetMsg?.id ?? messageId,
            expected_text: expectedText,
            expected_role: 'user',
            inclusive: false,
          });
          if (result.notFound) {
            showToast(t('chat.messageCompacted'), 'error');
            return;
          }
          mutationRevision = result.revision;
        } catch (e) {
          showToast(
            mutationTargetCompacted(e)
              ? t('chat.messageCompacted')
              : t('common.error') + ': ' + (e instanceof Error ? e.message : String(e)),
            'error',
          );
          return;
        }
        // 回溯删掉了后续 agent 消息：清单回退到这些动作发生之前（不是全清）。
        resyncTodosAfterMutation(sid);
        clearFutureInputsAfterRewrite(sid);
        clearStreamCursor(sid);
        // 乐观截断：画布与内存缓存同步截断！
        const targetMatches = (m: Message): boolean =>
          targetMsg?.id
            ? m.id === targetMsg.id || m.clientInputId === targetMsg.id
            : m.sourceIndex === targetIndex;
        // 原地改写该提问正文并保留（inclusive: true），绝不将首问截断成空数组 [] 导致落地页闪烁！
        setMessages({
          type: 'replace_match',
          match: targetMatches,
          update: (row) => ({
            ...row,
            parts: [{ kind: 'text', text: newText }],
            images: newImages.length ? newImages : undefined,
          }),
        });
        setMessages({ type: 'truncate_match', match: targetMatches, inclusive: true });
        const truncated = messagesRef.current;
        messageCacheRef.current.set(sid, truncated);
        // 权威反向灌入缓存
        const editedLabel = compactTurnNavText(
          stripSteerEnvelopeForDisplay(stripInjectedRemindersForDisplay(newText)),
        );
        const baseOutline = turnOutlineRef.current.length > 0
          ? turnOutlineRef.current
          : (turnOutlineBySessionRef.current.get(sid) ?? []);
        const filteredTurns = baseOutline
          .filter((t) => t.index <= sourceIndex)
          .map((t) => (t.index === sourceIndex || (targetMsg?.id && t.id === targetMsg.id) ? { ...t, label: editedLabel } : t));
        turnOutlineRef.current = filteredTurns;
        turnOutlineBySessionRef.current.set(sid, filteredTurns);
        setTurnOutline(filteredTurns);
        commitCanvasCache(effectiveHash, sid, {
          messages: truncated,
          todos: activeTodosRef.current,
          turns: filteredTurns,
          tokenUsage: cachedTokenUsageFor(sid),
          ...(mutationRevision !== undefined ? { revision: mutationRevision } : {}),
        });
        if (mutationRevision !== undefined) {
          cacheRevisionBySessionRef.current.set(sid, mutationRevision);
        }
        setEditingSourceIndex(null);
        setBubbleEditDraft(null);
        clearBubbleEditDraft(sid);
        // 提问已在画布上就绪，直接向后端发送新一轮
        window.setTimeout(() => {
          void deliver(newText, newImages, modeState.confirmedMode, undefined, tempModel, {
            alreadyOnCanvas: true,
            requestId: targetMsg?.id,
          });
        }, 50);
      },
    });
  }

  function handleDeleteUserMessage(sourceIndex: number, expectedText?: string, messageId?: string) {
    if (busyRef.current) {
      showToast(t('cmd.session.busy'), 'error');
      return;
    }
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const targetMsg = messagesRef.current.find((m) =>
      messageId
        ? m.role === 'user' && (m.id === messageId || m.clientInputId === messageId)
        : m.sourceIndex === sourceIndex,
    );
    const targetIndex = targetMsg?.sourceIndex ?? sourceIndex;
    const expected = expectedText || (targetMsg ? messageText(targetMsg) : undefined);

    setConfirmModal({
      open: true,
      title: t('confirm.deleteTurnTitle'),
      body: t('confirm.deleteTurnDesc'),
      danger: true,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        let missing = false;
        let mutationRevision: number | undefined;
        try {
          const result = await deleteSessionMessage(effectiveHash, sid, targetIndex, {
            delete_turn: true,
            expected_text: expected,
            expected_message_id: targetMsg?.id ?? messageId,
            expected_role: 'user',
          });
          missing = result.notFound === true;
          mutationRevision = result.revision;
          if (!missing) {
            // 删除整轮 agent 消息：清单回退到这些动作发生之前（不是全清）。
            resyncTodosAfterMutation(sid);
          }
        } catch (err) {
          missing = mutationTargetCompacted(err);
          console.warn('[Chat] Failed to delete session turn on backend:', err);
        }
        if (missing) {
          showToast(t('chat.messageCompacted'), 'error');
          return;
        }
        let nextMessages: Message[] = messagesRef.current;
        const targetMatches = (m: Message): boolean =>
          messageId
            ? m.id === messageId || m.clientInputId === messageId
            : m.sourceIndex === targetIndex;
        const idx = messagesRef.current.findIndex(targetMatches);
        if (idx !== -1) {
          let end = idx + 1;
          while (end < messagesRef.current.length && messagesRef.current[end]?.role !== 'user') {
            end += 1;
          }
          const removed = new Set(messagesRef.current.slice(idx, end));
          setMessages({ type: 'removeWhere', predicate: (row) => removed.has(row) });
          nextMessages = messagesRef.current;
          messageCacheRef.current.set(sid, nextMessages);
        }
        // 权威反向灌入缓存：同步覆盖 L1 内存和 L2 IndexedDB 与轮次导航！
        const currentOutline = (turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []))
          .filter((t) => t.index !== sourceIndex);
        turnOutlineRef.current = currentOutline;
        turnOutlineBySessionRef.current.set(sid, currentOutline);
        setTurnOutline(currentOutline);
        commitCanvasCache(effectiveHash, sid, {
          messages: nextMessages,
          todos: activeTodosRef.current,
          turns: currentOutline,
          tokenUsage: cachedTokenUsageFor(sid),
          ...(mutationRevision !== undefined ? { revision: mutationRevision } : {}),
        });
        if (mutationRevision !== undefined) {
          cacheRevisionBySessionRef.current.set(sid, mutationRevision);
        }
        if (editingSourceIndex === sourceIndex) {
          setEditingSourceIndex(null);
          setBubbleEditDraft(null);
          clearBubbleEditDraft(sid);
        }
      },
    });
  }

  function handleRegenerateAssistant(sourceIndex: number, assistantOrigIdx: number, assistantMessageId?: string) {
    if (busyRef.current) {
      showToast(t('cmd.session.busy'), 'error');
      return;
    }
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const assistantMsg = assistantMessageId
      ? messagesRef.current.find((m) => m.id === assistantMessageId)
      : messagesRef.current[assistantOrigIdx];
    const assistantIdx = assistantMsg ? messagesRef.current.indexOf(assistantMsg) : assistantOrigIdx;
    // Find preceding user message
    let userMsgIdx = -1;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messagesRef.current[i]?.role === 'user') {
        userMsgIdx = i;
        break;
      }
    }
    if (userMsgIdx === -1) return;
    const userMsg = messagesRef.current[userMsgIdx]!;
    const userText = messageText(userMsg);
    const userImages = userMsg.images ?? [];
    const userSourceIndex = userMsg.sourceIndex ?? userMsgIdx;

    setConfirmModal({
      open: true,
      title: t('confirm.rollbackTitle'),
      body: t('confirm.rollbackDesc'),
      danger: false,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        let mutationRevision: number | undefined;
        try {
          const result = await truncateSession(effectiveHash, sid, {
            target_index: userSourceIndex,
            target_message_id: userMsg.id,
            expected_text: userText,
            expected_role: 'user',
            inclusive: false,
          });
          if (result.notFound) {
            showToast(t('chat.messageCompacted'), 'error');
            return;
          }
          mutationRevision = result.revision;
        } catch (e) {
          showToast(
            mutationTargetCompacted(e)
              ? t('chat.messageCompacted')
              : t('common.error') + ': ' + (e instanceof Error ? e.message : String(e)),
            'error',
          );
          return;
        }
        // 重新生成 = 回溯这一轮：清单回退到这些动作发生之前（不是全清）。
        resyncTodosAfterMutation(sid);
        clearFutureInputsAfterRewrite(sid);
        clearStreamCursor(sid);
        let nextMessages: Message[] = messagesRef.current;
        const userMatches = (m: Message): boolean =>
          (!!userMsg.id && m.id === userMsg.id) || m.sourceIndex === userSourceIndex;
        setMessages({ type: 'truncate_match', match: userMatches });
        nextMessages = messagesRef.current;
        messageCacheRef.current.set(sid, nextMessages);
        // 权威反向灌入缓存
        const baseOutline = turnOutlineRef.current.length > 0
          ? turnOutlineRef.current
          : (turnOutlineBySessionRef.current.get(sid) ?? []);
        const userTurnIndex = userMsg.id
          ? baseOutline.find((turn) => turn.id && turn.id === userMsg.id)?.index
          : undefined;
        const cutTurnIndex = userTurnIndex ?? sourceIndex;
        const filteredTurns = baseOutline.filter((t) => t.index < cutTurnIndex);
        turnOutlineRef.current = filteredTurns;
        turnOutlineBySessionRef.current.set(sid, filteredTurns);
        setTurnOutline(filteredTurns);
        commitCanvasCache(effectiveHash, sid, {
          messages: nextMessages ?? messagesRef.current,
          todos: activeTodosRef.current,
          turns: filteredTurns,
          tokenUsage: cachedTokenUsageFor(sid),
          ...(mutationRevision !== undefined ? { revision: mutationRevision } : {}),
        });
        if (mutationRevision !== undefined) {
          cacheRevisionBySessionRef.current.set(sid, mutationRevision);
        }
        window.setTimeout(() => {
          void deliver(userText, userImages, modeState.confirmedMode);
        }, 100);
      },
    });
  }

  function handleDeleteAssistantMessage(sourceIndex: number, origIdx: number, messageId?: string) {
    if (busyRef.current) {
      showToast(t('cmd.session.busy'), 'error');
      return;
    }
    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (!sid || !effectiveHash) return;

    const targetMsg = messageId
      ? messagesRef.current.find((m) => m.id === messageId)
      : messagesRef.current[origIdx];
    const targetIdx = targetMsg ? messagesRef.current.indexOf(targetMsg) : origIdx;
    // 优先提取助手正文文本进行精准对齐，兜底采用全文（包含思考过程）
    const mainText = targetMsg?.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n').trim();
    const expected = mainText || (targetMsg ? messageText(targetMsg).trim() : undefined);

    // 向上寻找前置 user 消息以确定该轮次助手的起点坐标
    let userSourceIndex: number | undefined;
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (messagesRef.current[i]?.role === 'user') {
        userSourceIndex = messagesRef.current[i]?.sourceIndex;
        break;
      }
    }
    const resolvedIndex = targetMsg?.sourceIndex ?? (userSourceIndex != null ? userSourceIndex + 1 : sourceIndex);

    setConfirmModal({
      open: true,
      title: t('confirm.deleteTitle'),
      body: t('confirm.deleteDesc'),
      danger: true,
      confirmLabel: t('confirm.confirmBtn'),
      cancelLabel: t('common.cancel'),
      onConfirm: async () => {
        let missing = false;
        let mutationRevision: number | undefined;
        try {
          const result = await deleteSessionMessage(effectiveHash, sid, resolvedIndex, {
            delete_turn: false,
            expected_text: expected,
            expected_message_id: targetMsg?.id,
            expected_role: 'assistant',
          });
          missing = result.notFound === true;
          mutationRevision = result.revision;
          if (!missing) {
            // 删除 agent 轮次消息：清单回退到这些动作发生之前（不是全清）。
            resyncTodosAfterMutation(sid);
          }
        } catch (err) {
          missing = mutationTargetCompacted(err);
          console.warn('[Chat] Failed to delete assistant message on backend:', err);
        }
        if (missing) {
          showToast(t('chat.messageCompacted'), 'error');
          return;
        }
        let nextMessages: Message[] = messagesRef.current;
        const targetMatches = (m: Message): boolean =>
          (!!targetMsg?.id && m.id === targetMsg.id) ||
          (targetMsg?.sourceIndex != null && m.sourceIndex === targetMsg.sourceIndex);
        setMessages({ type: 'removeWhere', predicate: targetMatches });
        nextMessages = messagesRef.current;
        messageCacheRef.current.set(sid, nextMessages);
        // 权威反向灌入缓存
        const currentOutline = turnOutlineRef.current.length > 0 ? turnOutlineRef.current : (turnOutlineBySessionRef.current.get(sid) ?? []);
        commitCanvasCache(effectiveHash, sid, {
          messages: nextMessages,
          todos: activeTodosRef.current,
          turns: currentOutline,
          tokenUsage: cachedTokenUsageFor(sid),
          ...(mutationRevision !== undefined ? { revision: mutationRevision } : {}),
        });
        if (mutationRevision !== undefined) {
          cacheRevisionBySessionRef.current.set(sid, mutationRevision);
        }
      },
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;

    // 回车语义统一由 composerShortcuts 判定：Ctrl/Cmd+Enter 落成待发卡片并立即
    // 转向；Shift+Enter 换行；触屏软键盘的回车是真实换行；其余为发送。
    const enterAction = resolveComposerEnterAction({
      key: e.key,
      defaultPrevented: e.defaultPrevented,
      isComposing: e.isComposing,
      keyCode: e.keyCode,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      mobile: isMobileComposer(),
    });

    // 斜杠菜单导航（使用与渲染层一致的合并列表：本地命令 + 远程技能）
    if (slashOpen) {
      const mergedItems = buildSlashMenuItems(FRONTEND_COMMANDS, slashSkills ?? [], slashQuery, t as (k: string) => string, slashSkillsOnly);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, mergedItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && mergedItems.length > 0) {
        e.preventDefault();
        const selected = mergedItems[slashIndex];
        const cmdDef = selected.kind === 'command' ? FRONTEND_COMMANDS.find((c) => c.name === selected.name) : undefined;
        // 如果是无必选参数的命令（如 /init, /plan, /build, /new, /clear 等），按下回车直接执行
        if (selected.kind === 'command' && cmdDef && !cmdDef.argHint) {
          setSlashOpen(false);
          setInput('');
          void sendMessage(`/${selected.name}`);
          return;
        }
        insertSkill(selected.name);
        return;
      }
      if (e.key === 'Escape') {
        setSlashOpen(false);
        return;
      }
    }

    // @ 菜单导航
    if (atOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtIndex((i) => Math.min(i + 1, atRows.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Enter/Tab：目录→进入，文件→选定。Tab 便于逐级深入。
      if ((e.key === 'Enter' || e.key === 'Tab') && atRows.length > 0) {
        e.preventDefault();
        chooseAtRow(atRows[Math.min(atIndex, atRows.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        setAtOpen(false);
        return;
      }
    }

    if (canNavigateInputHistory({
      key: e.key, defaultPrevented: e.defaultPrevented, isComposing: e.isComposing,
      keyCode: e.keyCode, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      shiftKey: e.shiftKey, currentTarget: textareaRef.current,
    })) {
      inputHistoryRef.current.switchContext(historyContext);
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      const next = inputHistoryRef.current.navigate(direction, input);
      if (next !== null) {
        e.preventDefault();
        const position = direction === 'up' ? 0 : next.length;
        if (next === input) {
          textareaRef.current?.setSelectionRange(position, position);
        } else {
          pendingHistoryCaretRef.current = { context: historyContext, value: next, position };
          setInput(next);
        }
        return;
      }
    }

    if (enterAction === 'steer-card') {
      // Ctrl/Cmd+Enter：落成待发卡片并立即自动转向，无需再点一次「转向」。
      e.preventDefault();
      setSlashOpen(false);
      setAtOpen(false);
      void sendMessage(undefined, { asSteerCard: true });
      return;
    }
    if (enterAction === 'send') {
      e.preventDefault();
      sendMessage();
      return;
    }
    if (e.key === 'Escape') {
      const escapeAction = resolveComposerEscapeAction({
        defaultPrevented: e.defaultPrevented,
        pendingCardCount: queuedRef.current.length,
        busy: busyRef.current || busy || isCompacting,
      });
      if (escapeAction === 'cancel-card') {
        const tail = tailQueuedCard(queuedRef.current);
        if (tail) {
          e.preventDefault();
          handleCancelQueuedMessage(tail);
          return;
        }
      } else if (escapeAction === 'stop-and-restore') {
        e.preventDefault();
        void handleStopAndRestoreLastUserMessage();
        return;
      }
    }
  }

  /**
   * 发送后把键盘焦点还给主输入框，保证可以连续输入。
   * 弹窗/确认框已打开时不抢焦点；排队/转向卡片的聚焦逻辑完全不受影响。
   */
  function focusComposerSoon() {
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      if (document.querySelector('.modal-overlay, .confirm-modal-overlay')) return;
      ta.focus({ preventScroll: true });
    });
  }

  /**
   * 把键盘焦点交回输入框；带字符时把该字符一并送回输入框，
   * 避免卡片按钮抢走焦点后用户敲的字被吞掉。
   */
  function returnFocusToComposer(typedChar?: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    if (!typedChar) return;
    try {
      // insertText 会派发 input 事件，输入框的 onInput 随即把字符并入草稿。
      document.execCommand('insertText', false, typedChar);
    } catch {
      // 少数环境禁用 execCommand：至少保证焦点已经回到输入框。
    }
  }

  /** 把焦点送进指定待发卡片的动作区（方向键可达）。 */
  function focusQueuedCardActions(cardId: string) {
    const container = document.querySelector(`[data-queued-card-actions="${CSS.escape(cardId)}"]`);
    if (!container) return;
    const button = container.querySelector<HTMLButtonElement>('button[data-action]:not(:disabled)');
    button?.focus();
  }

  // 输入框为空时，方向键直接进入最新待发卡片的动作区；
  // 草稿非空时左右键仍然只负责移动光标。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const ta = textareaRef.current;
      if (!ta || document.activeElement !== ta) return;
      if (ta.value.length > 0) return;
      const target = tailQueuedCard(queuedRef.current);
      if (!target) return;
      e.preventDefault();
      focusQueuedCardActions(queueCardSyncKey(target));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function handleStop(options?: { skipDiskCatchUp?: boolean } | unknown) {
    const skipCatchUp = Boolean(options && typeof options === 'object' && 'skipDiskCatchUp' in options && (options as { skipDiskCatchUp?: boolean }).skipDiskCatchUp);
    const currentSid = sessionId ?? activeIdRef.current;
    const requestAlias = requestIdRef.current;
    // 停止流程里有 await（排队回填 / 停止 RPC）。用户完全可以在那个窗口里发出下一条
    // 消息并建立新的 POST 流与观察流；若在 await 之后再读 abortRef / sessionWatchers
    // 再 abort，被掐死的就是**新回合**：服务端已经 admit，客户端却没有订阅，
    // 表现就是「只显示 Working、模型输出不渲染、过一会儿才一次性出现」。
    // 因此所有“掐流”动作必须在第一个 await 之前完成，且只针对这里捕获到的旧句柄。
    const streamAtStop = abortRef.current;
    const requestIdAtStop = activeStreamRequestIdRef.current;
    // 停止前先判断“这是不是本端自己的回合”：本端持有发送流时，停下去后时间线
    // 立刻收尾、按钮复位，再追加一条“已请求停止”只会变成尾部噪音（而且对账会
    // 把它留成历史行）。只有停的是 TUI/其他标签页拥有的回合才需要文字回执。
    const localStreamEntry = currentSid
      ? localActiveStreamsBySessionRef.current.get(currentSid)
      : undefined;
    const ownStream =
      abortRef.current !== null ||
      (!!localStreamEntry && localStreamEntry.watchOnly !== true);
    /**
     * await 期间用户可能已经发出了新回合。它的运行态（busy / localTurnSessions /
     * 观察流）是新一轮的唯一真相，绝不能被本次停止的收尾阶段抹掉。
     * 判定只看身份：同会话的流条目被换成了另一个对象，就说明新回合已经接管。
     */
    const stopWasSuperseded = (): boolean => {
      if (!currentSid) return false;
      const nowStream = localActiveStreamsBySessionRef.current.get(currentSid);
      return nowStream !== undefined && nowStream !== localStreamEntry;
    };
    // 用户主动停止：按会话精准递增代数并复位抑制标记与交接保护，绝不误取消其他会话的立即发送。
    bumpSessionSendNowEpoch(sendNowEpochBySessionRef.current, currentSid);
    if (requestAlias && requestAlias !== currentSid) {
      bumpSessionSendNowEpoch(sendNowEpochBySessionRef.current, requestAlias);
    }
    programmaticStopMarkRef.current = null;
    persistProgrammaticStopMark(null);
    if (currentSid) {
      setSessionCompacting(currentSid, false);
      suppressedIdleBySessionRef.current.delete(currentSid);
      clearTrailingHandoverIdleVerify(currentSid);
      endSendNowHandover(currentSid);
      disarmTurn(currentSid);
      markSessionManuallyStopped(currentSid);
      sessionWatchersRef.current.get(currentSid)?.abort();
      sessionWatchersRef.current.delete(currentSid);
      localActiveStreamsBySessionRef.current.delete(currentSid);
      localTurnSessionsRef.current.delete(currentSid);
      backgroundRunningSessionsRef.current.delete(currentSid);
      onTurnRunningChange?.(currentSid, false);
    }
    if (requestAlias && requestAlias !== currentSid) {
      setSessionCompacting(requestAlias, false);
      suppressedIdleBySessionRef.current.delete(requestAlias);
      clearTrailingHandoverIdleVerify(requestAlias);
      endSendNowHandover(requestAlias);
      disarmTurn(requestAlias);
      markSessionManuallyStopped(requestAlias);
      localActiveStreamsBySessionRef.current.delete(requestAlias);
      localTurnSessionsRef.current.delete(requestAlias);
      backgroundRunningSessionsRef.current.delete(requestAlias);
      onTurnRunningChange?.(requestAlias, false);
    }
    // 掐流动作放在第一个 await 之前：此刻仍属旧回合，新回合不可能已经建好观察流。
    stopDetachedHistoryPoll(currentSid ?? undefined);
    stopIdleWatch();
    await restoreQueuedToComposer();
    // 只掐断停止时捕获的那条旧流；新回合（如果用户已经发了）的句柄绝不能碰。
    localStreamEntry?.abortController.abort();
    streamAtStop?.abort();
    if (abortRef.current === streamAtStop) abortRef.current = null;
    if (activeStreamRequestIdRef.current === requestIdAtStop) activeStreamRequestIdRef.current = null;
    if (requestIdRef.current === requestAlias) requestIdRef.current = null;

    // 乐观立即复位界面状态：红色停止方块立刻变回白蓝色发送箭头，提供确定的即时反馈
    // 若新回合已经接管，保留它自己的运行态。
    if (!stopWasSuperseded()) {
      setBusyAndClock(false);
      busyRef.current = false;
    }
    transitionChatRecovery({ type: 'stop_succeeded' });
    onPermissionResolved?.(null);
    if (!ownStream && (currentSid || requestAlias)) {
      // 停止确认只是输入态反馈，展示成 toast；绝不能写进转录流、粘在回答下面。
      showToast(t('chat.detachedStopped'), 'info');
    }

    try {
      await stopRunningTurn(currentSid, requestAlias);
    } catch (error) {
      pushNoticeToLastAssistant(t('chat.cancelFailed', { error: String(error) }));
    } finally {
      finalizePendingToolsOnCanvas();
      const superseded = stopWasSuperseded();
      // 强制确保终态归位，防止任何意外残留状态；但新回合已经接管时不能抹掉它的运行态。
      if (!superseded) {
        setBusyAndClock(false);
        busyRef.current = false;
      }
      transitionChatRecovery({ type: 'stop_succeeded' });
      if (currentSid && !superseded) {
        backgroundRunningSessionsRef.current.delete(currentSid);
        localTurnSessionsRef.current.delete(currentSid);
        onTurnRunningChange?.(currentSid, false);
      }
      if (requestAlias) {
        backgroundRunningSessionsRef.current.delete(requestAlias);
        localTurnSessionsRef.current.delete(requestAlias);
        onTurnRunningChange?.(requestAlias, false);
      }
      const projectHash =
        activeSession?.project_hash ||
        viewedProjectHashRef.current ||
        (currentSid ? projectHashBySessionRef.current.get(currentSid) : undefined) ||
        '';
      const loadGeneration = sessionGenerationRef.current;
      if (projectHash && currentSid && !skipCatchUp && !superseded) {
        startIdleWatch(projectHash, currentSid, loadGeneration);
        // 停止通道已 await 后端真实释放（快照已落盘）：立刻磁盘对账一次，
        // 把被 abort 掉的那条流可能丢掉的最后一段正文补回画布（无需刷新/失焦）。
        settleDiskCatchUp(projectHash, currentSid);
      }
    }
  }

  /**
   * 纯播放状态下按 Esc 取消：停止当前回合，并将本轮用户消息（正文/转向消息及附件）无损回落到输入框。
   */
  async function handleStopAndRestoreLastUserMessage() {
    const currentMsgs = messagesRef.current;
    let lastUserIdx = -1;
    for (let i = currentMsgs.length - 1; i >= 0; i--) {
      if (currentMsgs[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) {
      void handleStop();
      return;
    }

    const lastUserMsg = currentMsgs[lastUserIdx];
    const userText = stripSteerEnvelopeForDisplay(messageText(lastUserMsg));
    const userImages = lastUserMsg.images ?? [];
    const sourceIndex = lastUserMsg.sourceIndex ?? lastUserIdx;

    // 1. 停止当前正在发送/播放的消息（跳过自动磁盘补回，防止刚撤回的消息被重新读出）
    await handleStop({ skipDiskCatchUp: true });

    // 2. 从画布与缓存中移除未完成的这轮
    const rolledBackMsgs = messagesRef.current.slice(0, lastUserIdx);
    messagesRef.current = rolledBackMsgs;
    setMessages({ type: 'replace', rows: rolledBackMsgs });

    const sid = activeIdRef.current || sessionId || activeSession?.id;
    const effectiveHash =
      projectHashBySessionRef.current.get(sid || '') ||
      viewedProjectHashRef.current ||
      activeSession?.project_hash ||
      '';
    if (sid && effectiveHash) {
      // 回落到输入框 = 物理回退这一轮：清单回退到这些动作发生之前（不是全清）。
      resyncTodosAfterMutation(sid);
      messageCacheRef.current.set(sid, rolledBackMsgs);
      const filteredOutline = turnOutlineRef.current.filter(
        (t) => t.index !== sourceIndex && t.index < sourceIndex,
      );
      turnOutlineRef.current = filteredOutline;
      turnOutlineBySessionRef.current.set(sid, filteredOutline);
      setTurnOutline(filteredOutline);
      // 不在这里写缓存：回溯是服务端 mutation，本地乐观截断只影响当前画布。
      // 服务端会广播 `session_mutated{revision}`，届时按 revision 重新水合；
      // 失败时缓存仍是变更前的权威快照（刷新即可恢复真相）。
      void truncateSession(effectiveHash, sid, {
        target_index: sourceIndex,
        target_message_id: lastUserMsg.id,
        inclusive: false,
      }).catch(() => {});
    }

    // 3. 消息无损回落到输入框
    if (userText) {
      setInput((current) => (current.trim() ? `${userText}\n${current}` : userText));
    }
    if (userImages.length > 0) {
      setPendingAttach((current) => [...current, ...imagesToPending(userImages)]);
    }
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
      }
    }, 0);
  }

  // 从光标前的 / 替换为选中的技能名。
  function insertSkill(name: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const after = ta.value.slice(pos);
    const slashIdx = before.lastIndexOf('/');
    const next = before.slice(0, slashIdx) + `/${name} ` + after;
    setInput(next);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = slashIdx + name.length + 2;
      ta.setSelectionRange(newPos, newPos);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
  }

  // 把当前 @ 段替换为相对路径 rel，不自动追加空格，目录可继续下钻补全。
  function setAtMention(rel: string, isDir: boolean) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? ta.value.length;
    const range = detectAtMentionRange(ta.value, pos);
    if (!range) return;
    const next = applyAtMentionSelection(ta.value, range, rel, isDir);
    setInput(next.text);
    setAtOpen(next.keepOpen);
    setAtQuery(next.query);
    if (next.keepOpen) setAtItems([]);
    setAtIndex(0);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(next.cursor, next.cursor);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
  }

  // 选择 @ 菜单某一行：「..」仍用于返回上级；目录/文件都插入完整相对路径。
  function chooseAtRow(row: { name: string; is_dir: boolean; up?: boolean }) {
    if (row.up) {
      const trimmed = atDirPart.replace(/\/+$/, '');
      const idx = trimmed.lastIndexOf('/');
      const parent = idx >= 0 ? trimmed.slice(0, idx + 1) : '';
      const ta = textareaRef.current;
      if (!ta) return;
      const range = detectAtMentionRange(ta.value, ta.selectionStart ?? ta.value.length);
      if (!range) return;
      const nextText = ta.value.slice(0, range.start) + `@${parent}` + ta.value.slice(range.end);
      setInput(nextText);
      setAtQuery(parent);
      setAtIndex(0);
      requestAnimationFrame(() => {
        ta.focus();
        const cursor = range.start + 1 + parent.length;
        ta.setSelectionRange(cursor, cursor);
      });
    } else {
      setAtMention(atDirPart + row.name + (row.is_dir ? '/' : ''), row.is_dir);
    }
  }

  // Auto-resize textarea + slash-command + @-mention detection
  function handleInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    const val = ta.value;
    inputHistoryRef.current.edit(val);
    pendingHistoryCaretRef.current = null;
    setInput(val);
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';

    const pos = ta.selectionStart ?? val.length;
    const before = val.slice(0, pos);

    // 检测光标前是否有 /（行首 或 空格后）
    const slashIdx = before.lastIndexOf('/');
    if (slashIdx >= 0 && (slashIdx === 0 || before[slashIdx - 1] === ' ')) {
      const query = before.slice(slashIdx + 1);
      if (!query.includes(' ') && query.length <= 30) {
        if (slashSkills === null && !slashLoading) {
          setSlashLoading(true);
          getSkills()
            .then(setSlashSkills)
            .catch(() => setSlashSkills([]))
            .finally(() => setSlashLoading(false));
        }
        setAtOpen(false);
        setSlashQuery(query);
        setSlashIndex(0);
        setSlashOpen(true);
        // Any real keystroke exits the pure-skills browser → normal mixed filtering.
        setSlashSkillsOnly(false);
        return;
      }
    }

    // 检测光标前是否有 @（行首 或 空格后）。@ 后文本可含 "/" 以进入子目录；
    // 实际列目录/过滤由派生的 atTargetDir + useEffect 处理（见上）。
    const atRange = detectAtMentionRange(val, pos);
    if (atRange) {
      const query = atRange.token;
      if (query.length <= 120) {
        setSlashOpen(false);
        setAtQuery(query);
        setAtIndex(0);
        setAtOpen(true);
        return;
      }
    }

    setSlashOpen(false);
    setAtOpen(false);
  }

  // 在 textarea 光标处插入文本（skill 命令 / 文件路径），并复位高度、聚焦。
  // 若 `replaceSkill` 为 true，先清空输入框再插入，避免反复选择技能时累加。
  function insertAtCursor(text: string, replaceSkill = false) {
    const ta = textareaRef.current;
    if (replaceSkill) {
      setInput(text);
    } else if (!ta) {
      setInput((v) => v + text);
    } else {
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      setInput(ta.value.slice(0, start) + text + ta.value.slice(end));
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = replaceSkill ? text.length : (ta?.selectionStart ?? el.value.length) + text.length;
      el.setSelectionRange(pos, pos);
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    });
  }

  // 追加本地附件（粘贴 / 拖拽 / 文件选择）：图片立刻转成预览用 base64，
  // 其它文件只挂在输入框里，等用户点发送才写入 .jeikcode_store。
  async function addLocalFiles(files: File[] | FileList) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    // 部分 webview / 剪贴板给出的 HEIC 既无 MIME 也无图片扩展名，只能按字节判定
    const undecided = arr.filter((f) => !isImageFile(f) && !normalizeMimeType(f.type));
    const heifBlobs = new Set(
      (await Promise.all(undecided.map(async (f) => ((await looksLikeHeif(f)) ? f : null)))).filter(
        (f): f is File => f !== null,
      ),
    );
    const isImageAttachment = (f: File) => isImageFile(f) || heifBlobs.has(f);
    const imageFiles = arr.filter(isImageAttachment);
    const otherFiles = arr.filter((f) => !isImageAttachment(f));
    const oversizedImages = imageFiles.filter((f) => f.size > MAX_IMAGE_BYTES);
    const allowedImages = imageFiles.filter((f) => f.size <= MAX_IMAGE_BYTES);
    const parsedResults = await Promise.all(
      allowedImages.map(async (file) => ({ file, image: await fileToImageData(file) })),
    );
    // 浏览器解不开的格式（如 Windows Chrome 上的 HEIC/TIFF）会被丢弃：必须明确告知用户，
    // 否则表现为“上传了但什么都没发生”；也绝不能把原始字节错标 MIME 发给模型（那是坏图）。
    const undecodable = parsedResults.filter((r) => !r.image).map((r) => r.file);
    const parsed = parsedResults.map((r) => r.image).filter((x): x is ImageData => x !== null);
    if (oversizedImages.length > 0) {
      setAttachError(t('attach.tooLarge', { mb: String(MAX_IMAGE_MB) }));
    } else if (undecodable.length > 0) {
      setAttachError(t('attach.undecodable', { name: undecodable[0].name }));
    } else {
      setAttachError(null);
    }
    const counts = countPending(pendingAttach);
    const nextImages = parsed.slice(0, Math.max(0, MAX_IMAGES - counts.images));
    const added: PendingAttach[] = [
      ...nextImages.map((image) => ({ id: randomUUID(), kind: 'image' as const, image })),
      ...otherFiles.map((file) => ({
        id: randomUUID(),
        kind: 'file' as const,
        name: file.name || 'upload.bin',
        size: file.size,
        file,
      })),
    ];
    if (added.length) setPendingAttach((prev) => [...prev, ...added]);
  }

  function removePendingAttach(id: string) {
    setPendingAttach((prev) => prev.filter((item) => item.id !== id));
  }

  // 粘贴图文/文件：QQ/Telegram 风格 — 图片进缩略图，其它文件进附件图标，文字进输入框。
  // HTTP `--host`（局域网/公网 IP）下复制走 text/html data-URL，这里一并还原成文件。
  function handlePaste(e: ClipboardEvent) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = collectClipboardFiles(dt);
    if (files.length === 0) return;
    e.preventDefault();
    void addLocalFiles(files);
    const pastedText = dt.getData('text/plain');
    if (pastedText) insertAtCursor(pastedText);
  }

  // 输入框文字全选复制时，自动协同打包全部多媒体附件与文本，下次粘贴无缝还原多图+文本
  function handleInputCopy(e: ClipboardEvent) {
    const ta = textareaRef.current || (e.target as HTMLTextAreaElement);
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const val = ta.value ?? '';
    const isAllSelected = (val.length > 0 && start === 0 && end >= val.length) || (val.length === 0);

    const attachedImages = pendingImageData(pendingAttach);
    if (isAllSelected && attachedImages.length > 0) {
      e.preventDefault();
      const dataUrls = attachedImages.map((img) => `data:${img.media_type};base64,${img.data}`);
      const html = buildCopyHtml(dataUrls, val);
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', val);
        e.clipboardData.setData('text/html', html);
      }
      void copyTextAndImages(val, attachedImages);
      showToast(t('copy.copiedWithMedia'), 'info');
    }
  }

  function handleDragOver(e: DragEvent) {
    if (![...Array.from(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }

  function handleDragLeave(e: DragEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).contains(next)) return;
    setDragOver(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) void addLocalFiles(files);
  }

  const lastIdx = messages.length - 1;

  // 会话内搜索: Cmd/Ctrl+F 呼出浮动搜索框,Esc/× 关闭;输入关键词改变字符背景并高亮,
  // Enter/Shift+Enter(或 ↑/↓)在匹配消息间跳转并滚动定位(反查定位)。关闭态
  // 完全不占布局空间,不挤压消息区。仅前端,不动后端。
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTrim = search.trim().toLowerCase();
  // 不过滤时间线，而是展示完整消息流
  const visibleMessages = useMemo(
    () => projectCanvas(messages).map((m, origIdx) => ({ msg: m, origIdx })),
    [messages],
  );
  const lastVisibleIdx = visibleMessages.length - 1;
  // 全量内容搜索：涵盖用户提问、深度思考、正文文本、工具输入输出、通知错误等纯对话内所有元素
  // 工具行与渲染层共用 `lib/canvasSearch` 的提取口径，计数与高亮才不会分裂。
  function messageSearchableFullText(m: Message): string {
    return searchableMessageText(m);
  }

  // 计算匹配的原始消息索引列表
  const matchPositions = useMemo(() => {
    if (!searchOpen || !searchTrim) return [];
    const positions: number[] = [];
    messages.forEach((m, idx) => {
      if (messageSearchableFullText(m).includes(searchTrim)) {
        positions.push(idx);
      }
    });
    return positions;
  }, [messages, searchTrim, searchOpen]);
  // 匹配消息 origIdx → DOM 节点,供 ↑/↓/Enter 滚动定位。每次渲染重填。
  const matchRefs = useRef<Record<number, HTMLElement | null>>({});
  const [matchIdx, setMatchIdxState] = useState(0);
  // P3 修复: 用 ref 镜像 matchIdx,让事件处理器在快速连击时永远读到最新值
  const matchIdxRef = useRef(0);
  const setMatchIdx = (v: number) => { matchIdxRef.current = v; setMatchIdxState(v); };
  const closeSearch = () => { setSearch(''); setMatchIdx(0); setSearchOpen(false); };
  // 搜索导航 helper: 对标浏览器原生体验的精准容器居中平滑滚动与思考自动展开
  const navMatch = (delta: number) => {
    const n = matchPositions.length;
    if (n === 0) return;
    const newIdx = (matchIdxRef.current + delta + n) % n;
    setMatchIdx(newIdx);
    const targetOrigIdx = matchPositions[newIdx];
    const node = matchRefs.current[targetOrigIdx];
    const container = scrollRef.current;
    if (node && container) {
      timelineFollow.pause();

      // 如果当前消息包含思考过程且命中了思考内容，自动展开思考块
      const reasoningBtn = node.querySelector<HTMLButtonElement>('.reasoning-toggle');
      if (reasoningBtn && reasoningBtn.getAttribute('aria-expanded') === 'false') {
        const targetMsg = messages[targetOrigIdx];
        if (targetMsg?.parts.some((p) => p.kind === 'reasoning' && p.text.toLowerCase().includes(searchTrim))) {
          reasoningBtn.click();
        }
      }

      // 精准聚焦定位：优先把命中行中的具体高亮标记 (<mark>) 或展开工具行直接居中！
      // 避免当整条 assistant 回复很长时，只把消息气泡顶部居中，而下方的具体关键词行停留在视口之外。
      requestAnimationFrame(() => {
        const activeMark = node.querySelector<HTMLElement>('.msg-search-highlight');
        const scrollTarget = activeMark || node;
        const containerRect = container.getBoundingClientRect();
        const targetRect = scrollTarget.getBoundingClientRect();
        const targetTop =
          container.scrollTop +
          (targetRect.top - containerRect.top) -
          (container.clientHeight / 2 - targetRect.height / 2);
        container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });

        // 如果命中的关键词在带有内部滚动条的工具输出 pre 框内，同步将 pre 内部滚动到该标记
        const preParent = activeMark?.closest<HTMLPreElement>('.tool-terminal-out, pre');
        if (preParent && activeMark) {
          const preRect = preParent.getBoundingClientRect();
          const markPreTop =
            preParent.scrollTop +
            (targetRect.top - preRect.top) -
            (preParent.clientHeight / 2 - targetRect.height / 2);
          preParent.scrollTo({ top: Math.max(0, markPreTop), behavior: 'smooth' });
        }
      });
    }
  };

  // Cmd/Ctrl+F 打开搜索并聚焦;Esc 关闭。绑定在 window 层级,焦点在输入框/按钮/
  // 消息气泡时都生效;阻止浏览器默认查找以免误触原生 UI。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') {
        if (activeMainTabId !== 'chat') return;
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.code-editor-root, .file-explorer-root, .terminal-panel-root, .xterm')) return;
        if (messages.length === 0) return;
        e.preventDefault();
        setSearchOpen(true);
        // 下一帧再聚焦,等 input 挂载。
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (e.key === 'Escape') {
        if (searchOpen) {
          e.preventDefault();
          closeSearch();
          return;
        }
        if (confirmModal.open || editingSourceIndex != null) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        if (activeMainTabId !== 'chat') return;

        const escapeAction = resolveComposerEscapeAction({
          defaultPrevented: e.defaultPrevented,
          pendingCardCount: queuedRef.current.length,
          busy: busyRef.current || busy,
        });
        if (escapeAction === 'cancel-card') {
          const tail = tailQueuedCard(queuedRef.current);
          if (tail) {
            e.preventDefault();
            handleCancelQueuedMessage(tail);
            return;
          }
        } else if (escapeAction === 'stop-and-restore') {
          e.preventDefault();
          void handleStopAndRestoreLastUserMessage();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, messages.length, activeMainTabId]);

  // 落地态：对话为空就用 claude.ai 风格的居中落地页（无论是否已有 session id —
  // 新建会话、空的同步会话、空的历史会话都适用）。
  // 抑制条件：正在运行（isExecuting，绝对不允许把跑中的会话切成空白落地页）、正在拉历史（loading）、
  // restoring（刷新还原中）、已有 historyHint（无法加载、提示去 TUI/磁盘续聊）。
  const isExecuting = busy || busyRef.current || (activeIdRef.current ? (
    localTurnSessionsRef.current.has(activeIdRef.current) ||
    backgroundRunningSessionsRef.current.has(activeIdRef.current)
  ) : false);
  const landing = messages.length === 0 && !isExecuting && !historyHint && !restoring && !loading && activeMainTabId === 'chat';

  // 上报落地态给 App（决定是否显示会话标题头）。
  useEffect(() => {
    onLanding?.(landing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing]);

  // 刷新/恢复完成后把首帧焦点交还对话输入框。终端面板只在用户主动打开时聚焦；
  // 这里做最后兜底：只要焦点还停在 body，就在首屏稳定后聚焦输入框。
  // 只执行一次，之后用户切会话/点终端都不再被本 effect 抢焦点。
  const initialComposerFocusPendingRef = useRef(true);
  useEffect(() => {
    if (!initialComposerFocusPendingRef.current || restoring || activeMainTabId !== 'chat') return;
    let cancelled = false;
    let attempts = 0;
    let raf = 0;
    const tryFocus = () => {
      if (cancelled || !initialComposerFocusPendingRef.current) return;
      const ta = textareaRef.current;
      if (!ta) {
        // 落地页与常规页会择一挂载同一个 inputBox：给首屏切换几帧时间。
        if (attempts++ < 12) raf = requestAnimationFrame(tryFocus);
        return;
      }
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== document.body && activeEl !== document.documentElement) {
        // 用户/其它面板（例如终端）已经明确拿住焦点，绝不抢。
        initialComposerFocusPendingRef.current = false;
        return;
      }
      initialComposerFocusPendingRef.current = false;
      ta.focus({ preventScroll: true });
    };
    raf = requestAnimationFrame(tryFocus);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [restoring, landing, sessionId, messages.length, activeMainTabId]);

  // 侧栏「技能」菜单选中 → 把 `/name ` 插入输入框（按 seq 去重，避免重复插入）。
  // replaceSkill=true 会先清除已有的技能前缀，避免反复选择时累加。
  const lastSkillSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (!skillInsert) return;
    if (lastSkillSeqRef.current === skillInsert.seq) return;
    lastSkillSeqRef.current = skillInsert.seq;
    insertAtCursor(`/${skillInsert.name} `, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillInsert]);

  // 落地页副标题：项目名 + 缩写路径（剥掉 Windows `\\?\` 扩展前缀）。
  const projName = pathBasename(effectiveWorkingDir);
  const projPath = displayPath(effectiveWorkingDir);

  // 输入框只渲染一份，按落地/常规两处择一挂载（避免两个 textarea 抢同一 ref）。
  // 用函数返回新 VNode：两个分支切换时绝不能复用同一个 VNode 实例，
  // 否则 Preact 可能把旧 DOM 节点搬到新父节点，造成输入区透明/内容重叠。
  const renderInputBox = () => (
    <div
      class={'input-box' + (dragOver ? ' drag-over' : '')}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div class="input-drop-hint" aria-hidden="true">{t('attach.dropHint')}</div>
      )}
      {uploading && uploadProgress && (
        <div class="input-upload-progress" role="status">
          <div class="input-upload-progress-label">
            {t('attach.uploading', {
              name: uploadProgress.fileName,
              current: String(uploadProgress.current),
              total: String(uploadProgress.total),
              percent: String(uploadProgress.percent),
            })}
          </div>
          <div class="input-upload-progress-track">
            <div
              class="input-upload-progress-fill"
              style={{ width: `${uploadProgress.percent}%` }}
            />
          </div>
        </div>
      )}
      {attachError && (
        <div class="input-attach-error" role="alert">
          <span>{attachError}</span>
          <button
            class="input-attach-error-close"
            onClick={() => setAttachError(null)}
            aria-label={t('attach.dismissError')}
          >
            ×
          </button>
        </div>
      )}
      <AttachmentTray attach={pendingAttach} onRemove={removePendingAttach} />
      {atOpen && (
        <AtMentionMenu
          rows={atRows}
          loading={atLoading}
          index={atIndex}
          dirPart={atDirPart}
          menuRef={atRef}
          onHover={setAtIndex}
          onChoose={chooseAtRow}
        />
      )}
      {slashOpen && (
        <SlashMenu
          skills={slashSkills ?? []}
          query={slashQuery}
          skillsOnly={slashSkillsOnly}
          index={slashIndex}
          onHover={setSlashIndex}
          onSelect={insertSkill}
        />
      )}
      {/* 文本输入框主体：靠左对齐，单行起步随输入多行自适应 */}
      <textarea
        ref={textareaRef}
        class="message-input"
        rows={1}
        placeholder={t('chat.inputPlaceholder')}
        value={input}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCopy={handleInputCopy}
      />

      {/* 底部功能栏：左侧上传附件，右侧紧凑元数据 + 模式选择 + 发送控制 */}
      <div class="input-footer">
        <div class="input-footer-primary">
          <input
            ref={nativeFileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_IMAGE_INPUT_ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              if (input.files && input.files.length) {
                void addLocalFiles(input.files);
              }
              input.value = '';
            }}
          />
          <button
            type="button"
            class="btn-native-upload"
            onClick={() => nativeFileInputRef.current?.click()}
            title={t('chat.attachFiles')}
            aria-label={t('chat.attachFiles')}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
        </div>

        <div class="input-footer-actions">
          {tokens && (
            <div class="composer-meta-group">
              {(() => {
                const prompt = tokens.prompt ?? 0;
                const completion = tokens.completion ?? 0;
                const cached = tokens.cached ?? 0;
                const isEstimated = Boolean(tokens.cached_estimated);
                const reasoning = tokens.reasoning ?? 0;
                const total = tokens.total ?? (prompt + completion);
                const stepPct = formatCacheHitRate(cached, prompt, isEstimated);
                const cachedPct = stepPct;
                const pctOfLimit = contextLimit && contextLimit > 0 ? Math.min(100, Math.round((total / contextLimit) * 100)) : null;
                const billable = completion + Math.max(0, prompt - cached);

                const promptStr = prompt.toLocaleString();
                const completionStr = completion.toLocaleString();
                const cachedStr = cached.toLocaleString();
                const reasoningStr = reasoning.toLocaleString();
                const totalStr = total.toLocaleString();
                const limitStr = contextLimit ? contextLimit.toLocaleString() : null;
                const billableStr = billable.toLocaleString();

                const tooltipLines: string[] = [
                  t('tokens.tooltipTitle'),
                  '──────────────────────────────',
                  `${t('tokens.inputLabel')}: ${promptStr}`,
                ];
                if (cached > 0) {
                  if (isEstimated) {
                    tooltipLines.push(`⚡ ${t('tokens.estimatedCache')}: ${cachedStr} (${stepPct} ${t('tokens.estBadge')})`);
                  } else {
                    tooltipLines.push(`⚡ ${t('tokens.onlineCacheHit')}: ${cachedStr} (${stepPct} ${t('tokens.hitBadge')})`);
                  }
                }
                if (reasoning > 0) {
                  tooltipLines.push(`💭 ${t('tokens.reasoningTooltip', { n: reasoningStr })}`);
                }
                tooltipLines.push(
                  `📤 ${t('tokens.outputLabel')}: ${completionStr}`,
                  `🎯 ${t('tokens.totalTooltip', { total: totalStr })}`,
                );
                if (contextLimit) {
                  tooltipLines.push(
                    t('tokens.totalLimitTooltip', {
                      total: totalStr,
                      limit: limitStr ?? '',
                      pct: pctOfLimit ?? 0,
                    }),
                  );
                }
                tooltipLines.push(`💡 ${t('tokens.billableTokens')}: ${billableStr}`);

                return (
                  <div class="composer-tokens-anchor">
                    <button
                      type="button"
                      class={'footer-tokens composer-compact-tokens' + (showTokenDetails ? ' is-active' : '')}
                      title={tooltipLines.join('\n')}
                      aria-label={t('tokens.popoverTitle')}
                      aria-haspopup="dialog"
                      aria-expanded={showTokenDetails}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowTokenDetails((v) => !v);
                      }}
                    >
                      <span class="token-pill token-cached is-green">
                        <span class="token-icon">⚡</span>
                        <span>{cachedPct != null ? cachedPct : formatTokenMetric(cached)}</span>
                      </span>
                      <span class="token-pill token-total">
                        <span class="token-icon">🎯</span>
                        <span>{formatTokenMetric(total)}{contextLimit ? `/${formatTokenMetric(contextLimit)}` : ''}</span>
                      </span>
                    </button>

                    {showTokenDetails && (
                      <div
                        class="token-details-popover"
                        ref={tokenPopoverRef}
                        role="dialog"
                        aria-label={t('tokens.popoverTitle')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div class="token-popover-header">
                          <div class="token-popover-title">
                            <span class="token-popover-icon">📊</span>
                            <span>{t('tokens.popoverTitle')}</span>
                          </div>
                          <button
                            type="button"
                            class="token-popover-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowTokenDetails(false);
                            }}
                            title={t('tokens.close')}
                            aria-label={t('tokens.close')}
                          >
                            ✕
                          </button>
                        </div>

                        {contextLimit && (
                          <div class="token-popover-progress-box">
                            <div class="token-popover-progress-labels">
                              <span class="token-popover-progress-title">
                                <span class="token-popover-progress-icon" aria-hidden="true">📝</span>
                                {t('tokens.contextProgressTitle')}
                              </span>
                              <span class="token-popover-progress-val">
                                {totalStr} / {limitStr}
                              </span>
                            </div>
                            <div class="token-popover-progress-track">
                              <div
                                class="token-popover-progress-fill"
                                style={{
                                  width: `${Math.min(100, Math.max(2, pctOfLimit ?? 0))}%`,
                                  backgroundColor:
                                    (pctOfLimit ?? 0) > 85
                                      ? '#ef4444'
                                      : (pctOfLimit ?? 0) > 65
                                      ? '#f59e0b'
                                      : 'var(--app-brand-accent, #10a37f)',
                                }}
                              />
                              <span class="token-popover-progress-pct">{pctOfLimit}%</span>
                            </div>
                          </div>
                        )}

                        <div class="token-popover-grid">
                          <div class="token-popover-row">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">📥</span>
                              <span class="token-row-label">{t('tokens.inputLabel')}</span>
                            </div>
                            <span class="token-popover-row-val">{promptStr}</span>
                          </div>

                          {cached > 0 && (
                            <div class="token-popover-row is-cached">
                              <div class="token-popover-row-left">
                                <span class="token-row-icon">⚡</span>
                                <span class="token-row-label">
                                  {isEstimated ? t('tokens.estimatedCache') : t('tokens.onlineCacheHit')}
                                </span>
                              </div>
                              <div class="token-popover-row-val-group">
                                <span class="token-popover-row-val">{cachedStr}</span>
                                <span class="token-popover-row-badge">
                                  {stepPct} {isEstimated ? t('tokens.estBadge') : t('tokens.hitBadge')}
                                </span>
                              </div>
                            </div>
                          )}

                          <div class="token-popover-row">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">📤</span>
                              <span class="token-row-label">{t('tokens.outputLabel')}</span>
                            </div>
                            <div class="token-popover-row-val-group">
                              <span class="token-popover-row-val">{completionStr}</span>
                              {reasoning > 0 && (
                                <span class="token-popover-row-sub">
                                  {t('tokens.contentReasoning', { content: Math.max(0, completion - reasoning).toLocaleString(), reasoning: reasoningStr })}
                                </span>
                              )}
                            </div>
                          </div>

                          <div class="token-popover-row is-billable">
                            <div class="token-popover-row-left">
                              <span class="token-row-icon">💡</span>
                              <span class="token-row-label">{t('tokens.billableTokens')}</span>
                            </div>
                            <span class="token-popover-row-val">{billableStr}</span>
                          </div>
                        </div>

                        {sessionId && (
                          <button
                            type="button"
                            class="token-popover-compact"
                            disabled={busy || isCompacting}
                            title={busy ? t('cmd.session.busy') : t('tokens.compactAction')}
                            onClick={(e) => {
                              e.stopPropagation();
                              // 压缩会整段替换转录并重排输入区：先收起带 backdrop-filter
                              // 的浮层，避免 WebView2 残留合成层遮住输入区/造成重叠。
                              setShowTokenDetails(false);
                              // Same path as the `/compact` slash command: the HIGH-QUALITY
                              // compaction (recent window kept verbatim + anchored LLM
                              // summary + verbatim artifact archive), not the cheap stub.
                              void slashHandlers.execServerCommand('compact', '');
                            }}
                          >
                            <span class="token-compact-icon" aria-hidden="true">🗜️</span>
                            <span>{t('tokens.compactAction')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          <ModeSelector
            value={modeState.displayMode}
            disabled={Boolean(modeState.pendingMode)}
            globalEnabled={globalModeEnabled}
            onToggleGlobal={toggleGlobalMode}
            onChange={(m) => switchMode(m)}
          />
          <div class="input-turn-controls">
            {busy || isCompacting || recoveryPolicy.allowStop ? (
              <>
                {recoveryPolicy.allowSend && (input.trim() || pendingAttach.length > 0) && (
                  <button
                    class="btn-send"
                    onClick={sendMessage}
                    disabled={Boolean(modeState.pendingMode) || uploading}
                    title={`${t('chat.queue')} · ${t('chat.steerCardShortcut')}`}
                    aria-label={t('chat.queue')}
                  >
                    ↑
                  </button>
                )}
                <button class="btn-stop" onClick={() => void handleStop()} title={t('chat.stop')} aria-label={t('chat.stop')}>
                  <span class="stop-square" />
                </button>
              </>
            ) : (
              <button
                class="btn-send"
                onClick={sendMessage}
                disabled={!recoveryPolicy.allowSend || Boolean(modeState.pendingMode) || uploading || (!input.trim() && pendingAttach.length === 0)}
                title={recoveryPolicy.allowSend ? t('chat.send') : t('chat.recoveryBlocked')}
                aria-label={recoveryPolicy.allowSend ? t('chat.send') : t('chat.recoveryBlocked')}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // 落地页快捷提示胶囊：点击把文本填入输入框并聚焦（不自动发送，便于二次编辑）。
  const quickChips: { label: string; insert: string }[] = [
    { label: t('chat.chipReview'), insert: '/review ' },
    { label: t('chat.chipExplain'), insert: t('chat.chipExplain') },
    { label: t('chat.chipTest'), insert: t('chat.chipTest') },
  ];
  function fillInput(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const pos = text.length;
      ta.setSelectionRange(pos, pos);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    });
  }

  const topModelChrome = (() => {
    const slot = topModelSlot || (typeof document !== 'undefined' ? document.getElementById('top-nav-model-slot') : null);
    if (!slot) return null;
    return createPortal(
      <div class="top-model-row">
        <ModelSelector
          value={provider}
          onChange={(p) => switchProvider(p)}
          onDefaultChange={followDefaultProvider}
          sessionId={sessionId ?? activeIdRef.current}
          sessionEffort={sessionEffort}
          sessionBudget={sessionBudget}
          onEffortChange={(effort, budget) =>
            rememberSessionEffort(sessionId ?? activeIdRef.current, effort, budget)
          }
          direction="down"
          onOpenModelConfig={onOpenModelConfig}
        />
      </div>,
      slot,
    );
  })();

  if (landing) {
    return (
      <>
        <div
          ref={stageRef}
          class={'chat-stage' + (isRightPanelVisible ? ' has-right-panel' : '')}
          onDragOver={handleMainStageDragOver as any}
          onDrop={handleMainStageDrop as any}
        >
          <div class="chat-main-column">
            <div class="chat-landing">
              <div class="landing-inner">
                <div class="landing-brand">
                  <span class="landing-brand-name">JeikCode</span>
                </div>
                <div class="landing-tagline">{t('chat.greeting')}</div>
                {cwd && (
                  <div class="landing-cwd" title={cwd}>
                    <span class="landing-cwd-label">
                      {t('chat.sessionCwd', { path: '' }).trim()}
                    </span>
                    <span class="landing-cwd-path">{cwd}</span>
                  </div>
                )}
                <div class="landing-input">
                  {renderInputBox()}
                </div>
                <div class="landing-chips">
                  {quickChips.map((c) => (
                    <button key={c.label} class="landing-chip" onClick={() => fillInput(c.insert)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 右侧检查器：面板 + 折叠浮动条（两个画布共用同一实现，禁止再内联复制） */}
          <RightInspector
            tab={rightPanelTab}
            onTabChange={setRightPanelTab}
            onSelectTab={(next) => {
              setRightPanelTab(next);
              setRightPanelCollapsed(false);
            }}
            collapsed={rightPanelCollapsed}
            onCollapse={() => setRightPanelCollapsed(true)}
            counts={{
              questions: turnNavItems.length,
              git: gitChangedCount,
              terminal: terminalCount,
              preview: previewCount,
            }}
            onResizeStart={handleResizerPointerDown}
            turnNav={{
              items: turnNavItems,
              filtered: filteredTurnNavItems,
              activeId: activeTurnId,
              query: turnNavQuery,
              onQueryChange: setTurnNavQuery,
              onJump: jumpToTurn,
            }}
            git={{
              cwd: effectiveWorkingDir,
              sessionId: activeSession?.id || sessionId || undefined,
              refreshTrigger: gitRefreshTrigger,
              onBranchChanged: () => {
                setGitRefreshTrigger((n) => n + 1);
                onCwdChanged?.(effectiveWorkingDir || '');
              },
              onOpenFileDiff: handleOpenFileDiff,
              onOpenWorkingDiff: handleOpenWorkingDiff,
            }}
            workingDir={effectiveWorkingDir || cwd}
            onTerminalCountChange={setTerminalCount}
            onPreviewCountChange={setPreviewCount}
            eyeDragOver={eyeDragOver}
            onEyeDragOver={handleEyeDragOver}
            onEyeDragLeave={handleEyeDragLeave}
            onEyeDrop={handleEyeDrop}
            rail={{
              top: widgetPos.top,
              left: widgetPos.left,
              onDragStart: handleWidgetMouseDown,
            }}
          />
        </div>

        {topModelChrome}
        {globalPreviewImage && (
          <ImageLightbox
            src={globalPreviewImage}
            images={previewGallery}
            onNavigate={setGlobalPreviewImage}
            onClose={() => {
              setGlobalPreviewImage(null);
              setPreviewGallery([]);
            }}
          />
        )}
        {confirmModal.open && (
          <ConfirmDialog
            title={confirmModal.title}
            body={confirmModal.body}
            confirmLabel={confirmModal.confirmLabel ?? t('confirm.confirmBtn')}
            cancelLabel={confirmModal.cancelLabel ?? t('common.cancel')}
            danger={confirmModal.danger ?? true}
            icon={confirmModal.icon}
            onConfirm={confirmModal.onConfirm}
            onClose={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
          />
        )}
      </>
    );
  }

  // The live document is cleared by terminal settlement. Do not hide a fully
  // completed list earlier: the model may still be running and can update it.
  const panelItems = liveTodoPanelItems(activeTodos);
  const stickyTodoPanel = panelItems
    ? <SessionTodoPanel items={panelItems} />
    : null;

  // 「向上展开」只有在真能翻页时才渲染：可见性与动作共用 `canLoadOlder`，
  // 绝不再出现「到顶了还显示还有 N 条、点下去没反应」的幽灵卡片。
  const canPageOlder = canLoadOlder({
    hasOlder,
    offset: historyOffsetRef.current,
    headSeq: messages[0]?.seq,
  });

  return (
    <>
      <div
        ref={stageRef}
        class={'chat-stage' + (isRightPanelVisible ? ' has-right-panel' : '') + (activeMainTabId !== 'chat' ? ' is-editor-mode' : '')}
        onDragOver={handleMainStageDragOver as any}
        onDrop={handleMainStageDrop as any}
      >
      {/* Main chat / editor stage column */}
      <div class="chat-main-column">
        {/* Message timeline */}
        <div
          class="messages-container"
          tabIndex={-1}
          ref={attachTimeline}
          style={activeMainTabId !== 'chat' ? { display: 'none' } : undefined}
          onScroll={syncTurnNavFromScroll}
        >
        <div class="timeline-inner">
        {messages.length === 0 && !historyHint && !restoring && (loading || isExecuting) && (
          <div class="messages-empty messages-loading" role="status" aria-live="polite">
            <span class="codex-shimmer-status">{t('chat.loadingOlder')}</span>
          </div>
        )}

        {messages.length === 0 && historyHint && (
          <div class="messages-empty">
            <div>
              {historyHint}
              <div class="sub">{t('chat.continueHint')}</div>
            </div>
          </div>
        )}

        {messages.length > 0 && historyHint && (
          <div class="history-banner" role="status">
            {historyHint}
          </div>
        )}

        {hasOlder && canPageOlder && (() => {
          // 只报「还没上画布的提问数」；已到顶时计数归零，绝不出现“还有 3 个”却点不动。
          const remaining = Math.max(0,
            turnOutline.length > 0
              ? unloadedTurnCount
              : visibleOlderRemainingCount(
                  historyOffsetRef.current,
                  turnOutlineRef.current[0]?.index,
                ),
          );
          return (
            <div class="history-load-older">
              <button
                type="button"
                class="history-load-older-btn"
                disabled={loadingOlder}
                onClick={() => void loadOlderMessages()}
              >
                {loadingOlder
                  ? t('chat.loadingOlder')
                  : remaining > 0
                    ? t('chat.loadOlder', { n: String(remaining) })
                    : t('chat.loadOlderNoCount')}
              </button>
            </div>
          );
        })()}

        {(() => {
          // Pre-compute per-turn text for assistant messages: collect all text
          // from consecutive assistant messages between two user messages, so
          // the copy button can copy the entire LLM turn (not just one chunk).
          // system messages are transparent — they don't end an assistant turn.
          const turnTexts = new Map<number, string>();
          // 计算每个回合的文本（区分最后回答与全部正文），供复制按钮使用。
          const turnLastTexts = new Map<number, string>();
          const turnAllTexts = new Map<number, string>();
          {
            let start = -1;
            let textParts: string[] = [];
            let fallbackParts: string[] = [];
            let lastToolName: string | null = null;
            for (let i = 0; i < messages.length; i++) {
              if (messages[i].role === 'assistant') {
                if (start < 0) start = i;
                for (const p of messages[i].parts) {
                  if (p.kind === 'text' && p.text.trim()) {
                    textParts.push(p.text);
                  } else if (p.kind === 'tool' && p.tool?.name) {
                    lastToolName = p.tool.name;
                  }
                }
                const raw = messageFullText(messages[i]);
                if (raw) fallbackParts.push(raw);
              } else if (messages[i].role === 'user') {
                // Only a user message ends the current assistant turn.
                if (start >= 0) {
                  const targetList = textParts.length > 0 ? textParts : fallbackParts;
                  let lastText = targetList.length > 0 ? targetList[targetList.length - 1] : '';
                  // Todo 打勾拦截智能回锚（防误杀严密判定）：
                  // 1. 本轮以 TodoWrite 工具收尾；
                  // 2. 打勾前正文长度严格大于打勾后；
                  // 3. 打勾前正文达到实质性规模（>= 150 字符）或字数是后者的 2 倍以上。
                  if (targetList.length >= 2 && lastToolName && isTodoTool(lastToolName)) {
                    const post = targetList[targetList.length - 1];
                    const pre = targetList[targetList.length - 2];
                    const isAsymmetric = pre.trim().length > post.trim().length && (pre.trim().length >= 150 || pre.trim().length >= post.trim().length * 2);
                    if (isAsymmetric) {
                      lastText = pre;
                    }
                  }
                  const allText = targetList.join('\n\n');
                  for (let j = start; j < i; j++) {
                    turnLastTexts.set(j, lastText);
                    turnAllTexts.set(j, allText);
                  }
                  start = -1;
                  textParts = [];
                  fallbackParts = [];
                  lastToolName = null;
                }
              }
              // role === 'system': transparent — do not flush the turn.
            }
            // Flush the last turn
            if (start >= 0) {
              const targetList = textParts.length > 0 ? textParts : fallbackParts;
              let lastText = targetList.length > 0 ? targetList[targetList.length - 1] : '';
              if (targetList.length >= 2 && lastToolName && isTodoTool(lastToolName)) {
                const post = targetList[targetList.length - 1];
                const pre = targetList[targetList.length - 2];
                const isAsymmetric = pre.trim().length > post.trim().length && (pre.trim().length >= 150 || pre.trim().length >= post.trim().length * 2);
                if (isAsymmetric) {
                  lastText = pre;
                }
              }
              const allText = targetList.join('\n\n');
              for (let j = start; j < messages.length; j++) {
                turnLastTexts.set(j, lastText);
                turnAllTexts.set(j, allText);
              }
            }
          }

          // Helper: skip system messages when looking for the "next role".
          // Needed so a trailing system notice doesn't hide the copy button
          // on the real last AI reply of the turn.
          function nextNonSystemRole(from: number): string | undefined {
            for (let k = from; k < messages.length; k++) {
              if (messages[k].role !== 'system') return messages[k].role;
            }
            return undefined;
          }

          return visibleMessages.map(({ msg, origIdx }, idx) => {
            const isLast = idx === lastVisibleIdx;
            const setMatchRef = (el: HTMLElement | null) => { matchRefs.current[origIdx] = el; };
            const timeLabel = formatMsgTime(msg.ts, t);
            const timeFull = formatMsgTimeFull(msg.ts);
            const isActiveSearchMatch = searchOpen && searchTrim ? (origIdx === matchPositions[matchIdx]) : false;

            if (msg.role === 'user') {
              // 锚点身份 = 绝对转录下标（与右栏大纲同一口径）。
              // 序号在多页加载后会漂移，绝不能拿来拼 DOM id。
              const turnIndex = msg.sourceIndex ?? historyOffsetRef.current + origIdx;
              // The DOM anchor MUST use this row's own absolute index. Looking up
              // a nav item by index and borrowing its id made a one-off outline
              // index rewrite the bubble's data-turn-nav to the previous turn.
              const anchorId = turnNavId(msg.id ?? msg.clientInputId, turnIndex);
              const readOnlyBubble = msg.readOnly === true || busy;
              const isEditing = !readOnlyBubble && editingSourceIndex === turnIndex;
              const hasActiveDraft = isEditing && bubbleEditDraft?.sourceIndex === turnIndex;
              return (
                <UserMessageView
                  key={anchorId ?? turnIndex}
                  msg={msg}
                  anchorId={anchorId}
                  turnNavIdx={turnIndex}
                  searchRef={setMatchRef}
                  timeLabel={timeLabel}
                  timeFull={timeFull}
                  search={search}
                  isActiveSearchMatch={isActiveSearchMatch}
                  isEditing={isEditing}
                  draftText={hasActiveDraft ? bubbleEditDraft.text : undefined}
                  draftImages={hasActiveDraft ? bubbleEditDraft.images : undefined}
                  draftModel={hasActiveDraft ? bubbleEditDraft.selectedModel : undefined}
                  onDraftChange={(draftText, draftImages, draftModel) => {
                    handleBubbleDraftChange(turnIndex, draftText, draftImages, draftModel);
                  }}
                  onStartEdit={readOnlyBubble ? undefined : () => {
                    const initDraft: BubbleEditDraft = {
                      sourceIndex: turnIndex,
                      messageId: msg.id,
                      text: messageText(msg),
                      images: msg.images || [],
                      selectedModel: provider || defaultProviderName() || undefined,
                    };
                    setEditingSourceIndex(turnIndex);
                    setBubbleEditDraft(initDraft);
                    const sid = activeIdRef.current || sessionId || activeSession?.id;
                    if (sid) saveBubbleEditDraft(sid, initDraft);
                  }}
                  onCancelEdit={() => {
                    setEditingSourceIndex(null);
                    setBubbleEditDraft(null);
                    const sid = activeIdRef.current || sessionId || activeSession?.id;
                    if (sid) clearBubbleEditDraft(sid);
                  }}
                  onSaveRewrite={readOnlyBubble ? undefined : (newText, newImages) => void handleSaveRewrite(turnIndex, newText, newImages, msg.id)}
                  onRollbackSubmit={readOnlyBubble ? undefined : (newText, newImages, tempModel) => void handleRollbackSubmit(turnIndex, newText, newImages, tempModel, msg.id)}
                  onDelete={readOnlyBubble ? undefined : () => void handleDeleteUserMessage(turnIndex, messageText(msg), msg.id)}
                  models={modelCatalog}
                  currentModel={provider || defaultProviderName() || ''}
                  disabled={busy}
                  cwd={effectiveWorkingDir || cwd}
                />
              );
            }

            // system messages render as a standalone notice row (no copy button,
            // no turn grouping, no streaming cursor). Compaction completion is a
            // transcript BOUNDARY, not a message: render it as a slim divider marker
            // so it cannot look like part of the assistant answer above it.
            if (msg.role === 'system') {
              const fullText = msg.parts.map((p) => (p.kind === 'notice' ? p.text : '')).join('');
              if (isCompactionDoneNotice(fullText)) {
                return (
                  <div
                    key={msg.id ?? origIdx}
                    id={msg.id}
                    ref={setMatchRef}
                    role="note"
                    class={
                      'compaction-marker-row' +
                      (isActiveSearchMatch ? ' is-active-search-match' : '')
                    }
                  >
                    <span class="compaction-marker-line" aria-hidden="true" />
                    <span class="compaction-marker-text">{highlightText(fullText, search)}</span>
                    <span class="compaction-marker-line" aria-hidden="true" />
                  </div>
                );
              }
              return (
                <NoticeCard
                  key={msg.id ?? origIdx}
                  text={fullText}
                  search={search}
                  className={`command-output ${isActiveSearchMatch ? 'is-active-search-match' : ''}`}
                  searchRef={setMatchRef}
                />
              );
            }

            // Determine if this assistant message is the last one in the current
            // turn (i.e. the next NON-SYSTEM message is a user message, or there
            // are no more non-system messages). Only the last assistant message in
            // a turn gets the copy button, so one user turn → one copy button.
            // 用 origIdx(原数组索引)查 turnTexts 与判断 isLastInTurn,
            // 因为这两者是基于完整 messages 序列算的。
            const nextRole = nextNonSystemRole(origIdx + 1);
            const isLastInTurn = nextRole === 'user' || nextRole === undefined;
            const userTs = precedingUserTs(messages, origIdx);
            // Live bubble: wall-clock from this turn's user send → now.
            // Intermediate tool results / thinking must not restart the clock.
            const currentSidForRow = sessionId ?? activeIdRef.current ?? '';
            const isCompactingRow =
              isCompacting || (!!currentSidForRow && compactingSessionsRef.current.has(currentSidForRow));
            const liveFromUser =
              isLastInTurn && busy && isLast
                ? turnDurationMs(
                    resolveLiveElapsedAnchor({
                      compacting: isCompactingRow,
                      compactionStartedAt,
                      turnStartedAt,
                      userTs,
                      now: nowMs,
                    }),
                    nowMs,
                  )
                : undefined;
            const doneTotal = isLastInTurn && !busy
              ? turnTotalElapsedMs(userTs, msg.ts, msg.elapsedMs)
              : undefined;

            return (
              <AssistantMessageView
                key={msg.id ?? origIdx}
                msg={msg}
                isLast={isLast}
                busy={busy}
                lastIdx={lastIdx}
                isLastInTurn={isLastInTurn}
                turnLastText={turnLastTexts.get(origIdx) ?? ''}
                turnAllText={turnAllTexts.get(origIdx) ?? ''}
                searchRef={setMatchRef}
                timeLabel={isLastInTurn ? timeLabel : undefined}
                timeFull={isLastInTurn ? timeFull : undefined}
                liveElapsedMs={liveFromUser}
                turnTotalMs={doneTotal}
                isCompacting={isCompactingRow}
                search={search}
                isActiveSearchMatch={isActiveSearchMatch}
                onRegenerate={msg.readOnly !== true && isLastInTurn && !busy ? () => void handleRegenerateAssistant(msg.sourceIndex ?? origIdx, origIdx, msg.id) : undefined}
                onDelete={msg.readOnly !== true && isLastInTurn && !busy ? () => void handleDeleteAssistantMessage(msg.sourceIndex ?? origIdx, origIdx, msg.id) : undefined}
                cwd={effectiveWorkingDir || cwd}
              />
            );
          });
        })()}

        {/* Working / Compacting is transient UI, not a canvas record: the standalone
            row is only the fallback for the case where the streaming assistant bubble
            cannot carry the marker itself. Rendering both produced two
            "Compacting..." lines. */}
        {(() => {
          const currentSid = sessionId ?? activeIdRef.current ?? '';
          const isCompactingCurrent =
            isCompacting || (!!currentSid && compactingSessionsRef.current.has(currentSid));
          // 压缩标记由「最后一行」的 assistant shimmer 承担；Working 判据则要
          // 跳过末尾 system 通知（如折叠提示），绝不能因一条通知画出幽灵 Working。
          const lastVisibleRole = visibleMessages[visibleMessages.length - 1]?.msg.role;
          let lastRole: 'user' | 'assistant' | 'system' | undefined;
          for (let i = visibleMessages.length - 1; i >= 0; i--) {
            const role = visibleMessages[i]?.msg.role;
            if (role !== 'system') {
              lastRole = role;
              break;
            }
          }
          const mode = standaloneStatusMode({
            compacting: isCompactingCurrent,
            busy,
            lastVisibleRole,
            lastRole,
          });
          if (!mode) return null;
          const lastUserTs = [...messages].reverse().find((m) => m.role === 'user')?.ts;
          const statusElapsedMs = busy
            ? turnDurationMs(
                resolveLiveElapsedAnchor({
                  compacting: isCompactingCurrent,
                  compactionStartedAt,
                  turnStartedAt,
                  userTs: lastUserTs,
                  now: nowMs,
                }),
                nowMs,
              )
            : undefined;
          return <StatusRow mode={mode} liveElapsedMs={statusElapsedMs} />;
        })()}

        {/* 排队中的消息：执行中输入、待当前回合结束后自动发送，卡片下方提供立即发送、转向、取消按钮。 */}
        {queued.map((q) => (
          <QueuedMessageCard
            key={`q-${queueCardSyncKey(q)}`}
            q={q}
            focusCardId={focusCardId}
            onAutoFocusDone={() => setFocusCardId(null)}
            onSteer={() => void handleSteerQueuedMessage(q)}
            onSendNow={() => void handleSendImmediately(q)}
            onCancel={() => handleCancelQueuedMessage(q)}
            onReturnToComposer={(typedChar) => returnFocusToComposer(typedChar)}
          />
        ))}

        {pendingSteers.some((item) => item.confirmed) && (
          <div class="steer-pending-status" role="status">
            {t('chat.steerPending', {
              count: pendingSteers.filter((item) => item.confirmed).length,
            })}
          </div>
        )}

        <div ref={bottomRef} />
        </div>
      </div>

      {/* Jump-to-bottom: anchored inside the chat column (never over the
          inspector panel or the composer) and only on the chat tab. */}
      {showJumpBtn && activeMainTabId === 'chat' && (
        <JumpToBottomButton
          visible={showJumpBtn}
          busy={busy}
          onClick={() => scrollToBottom('smooth')}
        />
      )}

      <MainTabStage
        tabs={diffTabs}
        activeTabId={activeMainTabId}
        cwd={cwd}
        onCloseTab={handleCloseDiffTab}
      />
      </div>

      {/* 右侧检查器：面板 + 折叠浮动条（两个画布共用同一实现，禁止再内联复制） */}
      <RightInspector
        tab={rightPanelTab}
        onTabChange={setRightPanelTab}
        onSelectTab={(next) => {
          setRightPanelTab(next);
          setRightPanelCollapsed(false);
        }}
        collapsed={rightPanelCollapsed}
        onCollapse={() => setRightPanelCollapsed(true)}
        counts={{
          questions: turnNavItems.length,
          git: gitChangedCount,
          terminal: terminalCount,
          preview: previewCount,
        }}
        onResizeStart={handleResizerPointerDown}
        turnNav={{
          items: turnNavItems,
          filtered: filteredTurnNavItems,
          activeId: activeTurnId,
          query: turnNavQuery,
          onQueryChange: setTurnNavQuery,
          onJump: jumpToTurn,
        }}
        git={{
          cwd: effectiveWorkingDir,
          sessionId: activeSession?.id || sessionId || undefined,
          refreshTrigger: gitRefreshTrigger,
          onBranchChanged: () => {
            setGitRefreshTrigger((n) => n + 1);
            onCwdChanged?.(effectiveWorkingDir || '');
          },
          onOpenFileDiff: handleOpenFileDiff,
          onOpenWorkingDiff: handleOpenWorkingDiff,
        }}
        workingDir={effectiveWorkingDir || cwd}
        onTerminalCountChange={setTerminalCount}
        onPreviewCountChange={setPreviewCount}
        eyeDragOver={eyeDragOver}
        onEyeDragOver={handleEyeDragOver}
        onEyeDragLeave={handleEyeDragLeave}
        onEyeDrop={handleEyeDrop}
        rail={{
          top: widgetPos.top,
          left: widgetPos.left,
          onDragStart: handleWidgetMouseDown,
        }}
      />

      {/* 浮动搜索框:默认隐藏,Cmd/Ctrl+F 呼出,Esc/× 关闭。仿浏览器 Find-in-page 样式:
          长条胶囊、无图标、右侧依次 ↑ ↓ ×。position:absolute 钉在容器右上角,不占布局空间。
          Enter/↓ 下一条,Shift+Enter/↑ 上一条;零匹配时计数显示提示,导航按钮隐藏。 */}
      {searchOpen && messages.length > 0 && (
        <div class="msg-search-float" role="search" aria-label={t('chat.searchPlaceholder')}>
          <input
            class="msg-search-input"
            // type="text" 而非 "search"——后者在 Firefox 仍显示默认清除按钮,
            // 与自定义 × 重复。type="text" 全浏览器一致,清除仅走自定义路径。
            type="text"
            ref={searchInputRef}
            value={search}
            placeholder={t('chat.searchPlaceholder')}
            onInput={(e) => { setSearch((e.target as HTMLInputElement).value); setMatchIdx(0); }}
            onKeyDown={(e) => {
              // Enter/↓ = 下一条;Shift+Enter/↑ = 上一条。输入框内 ↑/↓ 不移动光标
              // (单行输入无光标位置歧义),直接在匹配间跳转。
              if (e.key === 'Enter') {
                if (searchTrim && matchPositions.length > 0) {
                  e.preventDefault();
                  navMatch(e.shiftKey ? -1 : 1);
                }
              } else if (e.key === 'ArrowDown' && searchTrim && matchPositions.length > 0) {
                e.preventDefault();
                navMatch(1);
              } else if (e.key === 'ArrowUp' && searchTrim && matchPositions.length > 0) {
                e.preventDefault();
                navMatch(-1);
              }
            }}
            aria-label={t('chat.searchPlaceholder')}
          />
          <span class="msg-search-count">
            {searchTrim
              ? (matchPositions.length > 0
                  ? `${matchIdx + 1}/${matchPositions.length}`
                  : t('chat.searchNoMatch'))
              : ''}
          </span>
          <button
            class="msg-search-nav"
            onClick={() => navMatch(-1)}
            title={t('chat.searchPrev')}
            aria-label={t('chat.searchPrev')}
            type="button"
            disabled={!searchTrim || matchPositions.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
          <button
            class="msg-search-nav"
            onClick={() => navMatch(1)}
            title={t('chat.searchNext')}
            aria-label={t('chat.searchNext')}
            type="button"
            disabled={!searchTrim || matchPositions.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
          </button>
          <button
            class="msg-search-close"
            onClick={closeSearch}
            title={t('chat.searchClose')}
            aria-label={t('chat.searchClose')}
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Floating input */}
      {persistenceWarning && (
        <div class="persistence-warning" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{persistenceWarning}</span>
          <button
            type="button"
            class="persistence-warning-dismiss"
            aria-label={t('common.dismiss')}
            onClick={() => setPersistenceWarning(null)}
          >
            ×
          </button>
        </div>
      )}
      {historyHint && (
        <div class="persistence-warning history-hint-warning" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{historyHint}</span>
          <button
            type="button"
            class="persistence-warning-dismiss"
            aria-label={t('common.dismiss')}
            onClick={() => setHistoryHint(null)}
          >
            ×
          </button>
        </div>
      )}
      {activeMainTabId === 'chat' && (
        <div class="input-container">
          <div class="input-wrap">
            {stickyTodoPanel}
            {renderInputBox()}
          </div>
        </div>
      )}
      </div>
      {topModelChrome}
      {globalPreviewImage && (
        <ImageLightbox
          src={globalPreviewImage}
          images={previewGallery}
          onNavigate={setGlobalPreviewImage}
          onClose={() => {
            setGlobalPreviewImage(null);
            setPreviewGallery([]);
          }}
        />
      )}
      {confirmModal.open && (
        <ConfirmDialog
          title={confirmModal.title}
          body={confirmModal.body}
          confirmLabel={confirmModal.confirmLabel ?? t('confirm.confirmBtn')}
          cancelLabel={confirmModal.cancelLabel ?? t('common.cancel')}
          danger={confirmModal.danger ?? true}
          icon={confirmModal.icon}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
        />
      )}
    </>
  );
}
