//! 定时任务守护进程调度引擎与 HTTP API：
//! - CRUD 接口（列表、创建、更新、删除、开关、立即执行）
//! - 专属 AI 智能设置对话接口（仅在此处独立挂载 `set_schedule` 单工具，绝不进入主会话工具池）
//! - 后台单例扫描循环（本地时区计算到期时间槽，通过 `admit_chat_turn` 直接注入首轮用户提问）

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

use crate::approval_mode::ApprovalMode;
use crate::{
    admit_chat_turn, finalize_chat_task, json_error, process_chat_request, publish_global,
    AppState, ChatAdmissionMode, ChatEvent, ChatRequest, GlobalWireEvent,
};
use jeikcode_capabilities::session::SessionManager as NativeSessionManager;
use jeikcode_config::schedule::{self, Schedule, ScheduleTask};
use jeikcode_config::Config;
use jeikcode_kernel::message::Message;
use jeikcode_kernel::provider::ChatOptions;
use jeikcode_kernel::stream::StreamEvent;
use jeikcode_kernel::tool::ToolDef;
use jeikcode_telemetry::{CurrentContext, SessionMode};

/// 记录当前正在运行触发中的定时任务 ID，防止同任务在同一执行周期被并发重入
fn running_schedule_ids() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 全局任务文件读写序列化锁，避免后台引擎更新状态与用户编辑请求交错覆盖
fn schedule_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Acquire [`schedule_store_lock`] and execute blocking `schedules/*.json` I/O on the blocking pool.
async fn with_schedule_store<F, R>(f: F) -> R
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let _lock = schedule_store_lock().lock().await;
    crate::spawn_blocking_isolated(f)
        .await
        .expect("schedule store blocking task panicked")
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleTaskView {
    #[serde(flatten)]
    pub task: ScheduleTask,
    pub next_run_at: Option<i64>,
}

impl ScheduleTaskView {
    fn from_task(task: ScheduleTask) -> Self {
        let next_run_at = compute_next_run_local(&task, Local::now());
        Self { task, next_run_at }
    }
}

#[derive(Debug, Deserialize)]
pub struct ScheduleUpsertRequest {
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub cwd: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub notify: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub one_shot: Option<bool>,
    #[serde(default)]
    pub session_mode: Option<String>,
    #[serde(default)]
    pub reuse_session_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub overlap_policy: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ToggleScheduleRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct AiScheduleDialogMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct AiScheduleDialogRequest {
    #[serde(default)]
    pub messages: Vec<AiScheduleDialogMessage>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiScheduleDialogResponse {
    pub reply: String,
    pub created_tasks: Vec<ScheduleTaskView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_task: Option<ScheduleTaskView>,
}

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn slug_for_id(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = true;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() {
        "task".to_string()
    } else {
        trimmed.chars().take(28).collect()
    }
}

fn generate_task_id(title: &str) -> String {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", slug_for_id(title), &suffix[..8])
}

/// 严格校验并标准化 "HH:MM" 时间字符串
fn normalize_hhmm(raw: &str) -> Option<(u32, u32, String)> {
    let trimmed = raw.trim();
    let (h_str, m_str) = trimmed.split_once(':')?;
    let h: u32 = h_str.trim().parse().ok()?;
    let m: u32 = m_str.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m, format!("{h:02}:{m:02}")))
}

/// 严格校验并标准化 "YYYY-MM-DD" 日期字符串
fn normalize_ymd(raw: &str) -> Option<(NaiveDate, String)> {
    let parsed = NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").ok()?;
    Some((parsed, parsed.format("%Y-%m-%d").to_string()))
}

fn sanitize_schedule(sched: Schedule) -> Result<Schedule, String> {
    match sched {
        Schedule::Calendar {
            dates,
            weekdays,
            times,
        } => {
            let mut norm_dates = BTreeSet::new();
            for d in dates {
                if d.trim().is_empty() {
                    continue;
                }
                let (_, s) = normalize_ymd(&d).ok_or_else(|| {
                    format!("Invalid calendar date format (expected YYYY-MM-DD): {d}")
                })?;
                norm_dates.insert(s);
            }

            let mut norm_weekdays = BTreeSet::new();
            for wd in weekdays {
                if !(1..=7).contains(&wd) {
                    return Err(format!("Invalid weekday value (expected 1..=7): {wd}"));
                }
                norm_weekdays.insert(wd);
            }

            let mut norm_times = BTreeSet::new();
            for t in times {
                if t.trim().is_empty() {
                    continue;
                }
                let (_, _, s) = normalize_hhmm(&t)
                    .ok_or_else(|| format!("Invalid time format (expected HH:MM): {t}"))?;
                norm_times.insert(s);
            }
            if norm_times.is_empty() {
                return Err(
                    "Calendar schedule requires at least one valid HH:MM time point".to_string(),
                );
            }

            Ok(Schedule::Calendar {
                dates: norm_dates.into_iter().collect(),
                weekdays: norm_weekdays.into_iter().collect(),
                times: norm_times.into_iter().collect(),
            })
        }
        Schedule::Daily { time } => {
            let (_, _, s) =
                normalize_hhmm(&time).ok_or_else(|| format!("Invalid daily time: {time}"))?;
            Ok(Schedule::Daily { time: s })
        }
        Schedule::Weekly { weekday, time } => {
            if !(1..=7).contains(&weekday) {
                return Err(format!("Invalid weekday value (expected 1..=7): {weekday}"));
            }
            let (_, _, s) =
                normalize_hhmm(&time).ok_or_else(|| format!("Invalid weekly time: {time}"))?;
            Ok(Schedule::Weekly { weekday, time: s })
        }
        Schedule::Hourly => Ok(Schedule::Hourly),
        Schedule::Interval { every_minutes } => {
            if every_minutes == 0 {
                return Err("Interval every_minutes must be greater than 0".to_string());
            }
            Ok(Schedule::Interval { every_minutes })
        }
        Schedule::Cron { expr } => {
            if expr.split_whitespace().count() != 5 {
                return Err("Cron expression must have 5 whitespace-separated fields".to_string());
            }
            Ok(Schedule::Cron {
                expr: expr.trim().to_string(),
            })
        }
    }
}

fn sanitize_permission_mode(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("auto") {
        "build" => "build".to_string(),
        "plan" => "plan".to_string(),
        "accept_edits" => "accept_edits".to_string(),
        _ => "auto".to_string(),
    }
}

fn sanitize_session_mode(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("isolated") {
        "reuse" => "reuse".to_string(),
        _ => "isolated".to_string(),
    }
}

fn sanitize_overlap_policy(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("skip") {
        "queue" => "queue".to_string(),
        _ => "skip".to_string(),
    }
}

fn cron_field_matches(field: &str, value: u32, is_dow: bool) -> bool {
    let field = field.trim();
    if field == "*" {
        return true;
    }
    for part in field.split(',') {
        let part = part.trim();
        let (range_part, step) = if let Some((r, s)) = part.split_once('/') {
            let Ok(step) = s.trim().parse::<u32>() else {
                continue;
            };
            if step == 0 {
                continue;
            }
            (r.trim(), Some(step))
        } else {
            (part, None)
        };

        let norm_val = if is_dow && value == 0 { 7 } else { value };
        if range_part == "*" {
            if step.is_none_or(|s| norm_val % s == 0) {
                return true;
            }
            continue;
        }
        if let Some((a, b)) = range_part.split_once('-') {
            let (Ok(start), Ok(end)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) else {
                continue;
            };
            let start = if is_dow && start == 0 { 7 } else { start };
            let end = if is_dow && end == 0 { 7 } else { end };
            if norm_val >= start && norm_val <= end {
                if step.is_none_or(|s| (norm_val - start) % s == 0) {
                    return true;
                }
            }
            continue;
        }
        if let Ok(exact) = range_part.parse::<u32>() {
            let exact = if is_dow && exact == 0 { 7 } else { exact };
            if norm_val == exact {
                return true;
            }
        }
    }
    false
}

fn cron_matches(expr: &str, dt: chrono::DateTime<Local>) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    // 统一将周日映射为 7（同时支持 0 或 7）
    let dow = dt.weekday().number_from_monday();
    let dow_match = cron_field_matches(parts[4], dow, true)
        || (dow == 7 && cron_field_matches(parts[4], 0, true));
    cron_field_matches(parts[0], dt.minute(), false)
        && cron_field_matches(parts[1], dt.hour(), false)
        && cron_field_matches(parts[2], dt.day(), false)
        && cron_field_matches(parts[3], dt.month(), false)
        && dow_match
}

/// 判定给定任务在本地当前时间点是否到达触发槽位；若命中则返回本槽位去重键
fn is_task_due_at(task: &ScheduleTask, now: chrono::DateTime<Local>) -> Option<String> {
    if !task.enabled {
        return None;
    }
    let today_str = now.format("%Y-%m-%d").to_string();
    let hhmm_str = now.format("%H:%M").to_string();
    let wd = now.weekday().number_from_monday() as u8;

    let slot = match &task.schedule {
        Schedule::Calendar {
            dates,
            weekdays,
            times,
        } => {
            let time_hit = times.iter().any(|t| {
                normalize_hhmm(t).is_some_and(|(h, m, _)| h == now.hour() && m == now.minute())
            });
            if !time_hit {
                return None;
            }
            let day_hit = if dates.is_empty() && weekdays.is_empty() {
                true
            } else {
                dates.iter().any(|d| d.trim() == today_str) || weekdays.contains(&wd)
            };
            if !day_hit {
                return None;
            }
            format!("cal:{today_str} {hhmm_str}")
        }
        Schedule::Daily { time } => {
            let (h, m, _) = normalize_hhmm(time)?;
            if now.hour() != h || now.minute() != m {
                return None;
            }
            format!("daily:{today_str} {hhmm_str}")
        }
        Schedule::Weekly { weekday, time } => {
            let (h, m, _) = normalize_hhmm(time)?;
            if wd != *weekday || now.hour() != h || now.minute() != m {
                return None;
            }
            format!("weekly:{today_str} {hhmm_str}")
        }
        Schedule::Hourly => {
            if now.minute() != 0 {
                return None;
            }
            format!("hourly:{today_str} {:02}:00", now.hour())
        }
        Schedule::Interval { every_minutes } => {
            if *every_minutes == 0 {
                return None;
            }
            let anchor = task.last_run_at.unwrap_or(task.created_at);
            let elapsed = now.timestamp() - anchor;
            if elapsed < (*every_minutes as i64) * 60 {
                return None;
            }
            format!("int:{today_str} {hhmm_str}")
        }
        Schedule::Cron { expr } => {
            if !cron_matches(expr, now) {
                return None;
            }
            format!("cron:{today_str} {hhmm_str}")
        }
    };

    if task.last_fired_slot.as_deref() == Some(slot.as_str()) {
        return None;
    }
    Some(slot)
}

/// 按本地时区推算任务下一次触发时间（秒级 Epoch）
pub fn compute_next_run_local(task: &ScheduleTask, now: chrono::DateTime<Local>) -> Option<i64> {
    let now_ts = now.timestamp();
    match &task.schedule {
        Schedule::Interval { every_minutes } => {
            if *every_minutes == 0 {
                return None;
            }
            let anchor = task.last_run_at.unwrap_or(task.created_at.max(now_ts));
            let next = anchor + (*every_minutes as i64) * 60;
            Some(if next > now_ts { next } else { now_ts + 15 })
        }
        Schedule::Hourly => {
            let cur_min = now.minute() as i64;
            let cur_sec = now.second() as i64;
            Some(now_ts + (3600 - cur_min * 60 - cur_sec))
        }
        Schedule::Daily { time } => {
            let (h, m, _) = normalize_hhmm(time)?;
            let target_time = NaiveTime::from_hms_opt(h, m, 0)?;
            for offset in 0..=2 {
                let d = now
                    .date_naive()
                    .checked_add_days(chrono::Days::new(offset))?;
                let ndt = NaiveDateTime::new(d, target_time);
                if let Some(dt) = Local.from_local_datetime(&ndt).earliest() {
                    if dt.timestamp() > now_ts {
                        return Some(dt.timestamp());
                    }
                }
            }
            None
        }
        Schedule::Weekly { weekday, time } => {
            let (h, m, _) = normalize_hhmm(time)?;
            let target_time = NaiveTime::from_hms_opt(h, m, 0)?;
            for offset in 0..=8 {
                let d = now
                    .date_naive()
                    .checked_add_days(chrono::Days::new(offset))?;
                if d.weekday().number_from_monday() as u8 != *weekday {
                    continue;
                }
                let ndt = NaiveDateTime::new(d, target_time);
                if let Some(dt) = Local.from_local_datetime(&ndt).earliest() {
                    if dt.timestamp() > now_ts {
                        return Some(dt.timestamp());
                    }
                }
            }
            None
        }
        Schedule::Calendar {
            dates,
            weekdays,
            times,
        } => {
            let mut parsed_times: Vec<(u32, u32)> = times
                .iter()
                .filter_map(|t| normalize_hhmm(t).map(|(h, m, _)| (h, m)))
                .collect();
            parsed_times.sort();
            parsed_times.dedup();
            if parsed_times.is_empty() {
                return None;
            }
            let parsed_dates: BTreeSet<NaiveDate> = dates
                .iter()
                .filter_map(|d| normalize_ymd(d).map(|(nd, _)| nd))
                .collect();
            let only_dates = !parsed_dates.is_empty() && weekdays.is_empty();
            let max_date = parsed_dates.iter().next_back().copied();

            for offset in 0..=366u64 {
                let d = now
                    .date_naive()
                    .checked_add_days(chrono::Days::new(offset))?;
                if only_dates && max_date.is_some_and(|m| d > m) {
                    break;
                }
                let wd = d.weekday().number_from_monday() as u8;
                let day_hit = if parsed_dates.is_empty() && weekdays.is_empty() {
                    true
                } else {
                    parsed_dates.contains(&d) || weekdays.contains(&wd)
                };
                if !day_hit {
                    continue;
                }
                for &(h, m) in &parsed_times {
                    let Some(target_time) = NaiveTime::from_hms_opt(h, m, 0) else {
                        continue;
                    };
                    let ndt = NaiveDateTime::new(d, target_time);
                    if let Some(dt) = Local.from_local_datetime(&ndt).earliest() {
                        if dt.timestamp() > now_ts {
                            return Some(dt.timestamp());
                        }
                    }
                }
            }
            None
        }
        Schedule::Cron { expr } => {
            // 向前最多扫描 30 天内最近匹配的分钟（步长 60s）
            let start_min = (now_ts / 60 + 1) * 60;
            for step in 0..(30 * 24 * 60) {
                let ts = start_min + step * 60;
                if let Some(dt) = Local.timestamp_opt(ts, 0).earliest() {
                    if cron_matches(expr, dt) {
                        return Some(ts);
                    }
                }
            }
            None
        }
    }
}

/// 决定任务生效的工作目录，若任务自带 `cwd` 则校验并优先使用
fn resolve_task_working_dir(state: &AppState, task: &ScheduleTask) -> Result<PathBuf, String> {
    let trimmed = task.cwd.trim();
    if trimmed.is_empty() {
        return Ok(state.bind_working_dir.clone());
    }
    let raw = PathBuf::from(trimmed);
    let canon = jeikcode_capabilities::pathnorm::canonicalize(&raw)
        .unwrap_or_else(|_| jeikcode_capabilities::pathnorm::strip_verbatim_path(&raw));
    let norm = crate::normalize_working_dir_case(canon);
    if !norm.is_dir() {
        return Err(format!("Workspace directory does not exist: {}", trimmed));
    }
    Ok(norm)
}

/// 根据任务执行策略确定目标会话 ID（独立新建 或 复用已有）
fn resolve_target_session_id(task: &ScheduleTask, working_dir: &std::path::Path) -> String {
    if task.session_mode == "reuse" {
        if let Some(existing_id) = task
            .reuse_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mgr = NativeSessionManager::for_project(working_dir);
            if mgr.read_meta(existing_id).is_ok()
                || matches!(crate::resolve_session_by_id(existing_id), Ok(Some(_)))
            {
                return existing_id.to_string();
            }
        }
    }
    uuid::Uuid::new_v4().to_string()
}

/// 核心触发器：将定时任务作为首轮用户提问派发执行（支持即时试跑与后台定时器调用）
async fn dispatch_schedule_task(
    state: &AppState,
    task_id: &str,
    fired_slot: Option<String>,
    is_manual: bool,
) -> Result<ScheduleTaskView, (StatusCode, String)> {
    // 1. 先检查并占位运行锁，防止重复并发执行同一任务
    {
        let mut guard = running_schedule_ids().lock().await;
        if guard.contains(task_id) && fired_slot.is_some() {
            return Err((
                StatusCode::CONFLICT,
                "Scheduled task is already executing".to_string(),
            ));
        }
        guard.insert(task_id.to_string());
    }

    let result = dispatch_schedule_task_inner(state, task_id, fired_slot, is_manual).await;
    if result.is_err() {
        running_schedule_ids().lock().await.remove(task_id);
    }
    result
}

async fn dispatch_schedule_task_inner(
    state: &AppState,
    task_id: &str,
    fired_slot: Option<String>,
    is_manual: bool,
) -> Result<ScheduleTaskView, (StatusCode, String)> {
    let tid = task_id.to_string();
    let task = with_schedule_store(move || {
        schedule::load(&tid).map_err(|e| (StatusCode::NOT_FOUND, format!("Task not found: {e}")))
    })
    .await?;

    if task.prompt.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Scheduled task prompt cannot be empty".to_string(),
        ));
    }

    let working_dir =
        resolve_task_working_dir(state, &task).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let local_now = Local::now();
    // 严格遵守：{定时任务名}-{时分秒 年-月-日}
    let timestamp_str = local_now.format("%H:%M:%S %Y-%m-%d").to_string();
    let session_title = format!("{}-{}", task.title.trim(), timestamp_str);

    let session_id = resolve_target_session_id(&task, &working_dir);
    let session_busy = state.is_session_active(&session_id).await;

    if session_busy {
        if task.session_mode == "reuse" && task.overlap_policy == "queue" {
            // 若目标复用会话正在运行且配置为入队，将本次提问压入待发队列并更新时间戳标题
            state.push_to_session_queue(&session_id, &task.prompt).await;
            let wd_clone = working_dir.clone();
            let sid_clone = session_id.clone();
            let title_clone = session_title.clone();
            let _ = crate::spawn_blocking_isolated(move || {
                let mgr = NativeSessionManager::for_project(&wd_clone);
                let now_ms = jeikcode_capabilities::session::now_ms();
                let _ = mgr.update_meta(&sid_clone, |meta| {
                    meta.origin = jeikcode_capabilities::session::SessionOrigin::Scheduled;
                    meta.name = title_clone;
                    meta.user_renamed = true;
                    meta.updated_at = now_ms;
                });
                crate::publish_session_upsert(&wd_clone, &sid_clone);
            })
            .await;

            let tid = task_id.to_string();
            let sid_for_store = session_id.clone();
            let updated_task = with_schedule_store(move || {
                let mut fresh = schedule::load(&tid).unwrap_or(task);
                if let Some(slot) = fired_slot {
                    fresh.last_fired_slot = Some(slot);
                }
                fresh.last_run_at = Some(now_epoch_secs());
                fresh.last_session_id = Some(sid_for_store);
                fresh.last_status = Some("queued".to_string());
                if fresh.one_shot {
                    fresh.enabled = false;
                }
                let _ = schedule::save(&fresh);
                fresh
            })
            .await;
            running_schedule_ids().lock().await.remove(task_id);
            publish_global(GlobalWireEvent::SchedulesUpdated);
            return Ok(ScheduleTaskView::from_task(updated_task));
        } else if !is_manual || task.session_mode == "reuse" {
            return Err((
                StatusCode::CONFLICT,
                "Scheduled task target session is busy".to_string(),
            ));
        }
    }

    let approval_mode = match task.permission_mode.as_str() {
        "build" => ApprovalMode::Build,
        "plan" => ApprovalMode::Plan,
        "accept_edits" => ApprovalMode::AcceptEdits,
        _ => ApprovalMode::Auto,
    };

    let chat_req = ChatRequest {
        message: task.prompt.clone(),
        working_dir: Some(working_dir.clone()),
        provider: task.model.clone().filter(|s| !s.trim().is_empty()),
        session_id: Some(session_id.clone()),
        request_id: Some(format!(
            "req_sched_{}_{}",
            task.id,
            local_now.timestamp_millis()
        )),
        images: vec![],
        approval_mode: Some(approval_mode),
        extra_system_append: None,
        session_title: Some(session_title),
        is_scheduled: true,
    };

    let admitted = admit_chat_turn(state, chat_req, ChatAdmissionMode::RejectIfBusy, None)
        .await
        .map_err(|e| (StatusCode::CONFLICT, format!("Could not admit turn: {e:?}")))?;

    let crate::AdmittedChatTurn {
        request: chat_req,
        operation_id,
        session_id: admitted_session_id,
        cancellation: cancel_token,
        mut rx,
        fan_tx,
        terminal_sent,
        ..
    } = admitted;

    // 先落盘触发记录与 one_shot 自动关闭状态并广播
    let tid = task_id.to_string();
    let sid_for_store = admitted_session_id.clone();
    let task = with_schedule_store(move || {
        let mut fresh = schedule::load(&tid).unwrap_or(task);
        if let Some(slot) = fired_slot {
            fresh.last_fired_slot = Some(slot);
        }
        fresh.last_run_at = Some(now_epoch_secs());
        fresh.last_session_id = Some(sid_for_store.clone());
        if fresh.session_mode == "reuse" {
            fresh.reuse_session_id = Some(sid_for_store);
        }
        fresh.last_status = Some("running".to_string());
        if fresh.one_shot {
            fresh.enabled = false;
        }
        schedule::save(&fresh).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Save task failed: {e}"),
            )
        })?;
        Ok::<_, (StatusCode, String)>(fresh)
    })
    .await?;
    publish_global(GlobalWireEvent::SchedulesUpdated);

    let cleanup_chats = state.active_chats.clone();
    let cleanup_op = operation_id.clone();
    let task_sid = admitted_session_id.clone();
    let mcp_pool = state.mcp_pool.clone();
    let telemetry = state.telemetry.clone();
    let pending_permissions = state.pending_permissions.clone();
    let pending_user_inputs = state.pending_user_inputs.clone();
    let tid_for_spawn = task.id.clone();

    let ctx = CurrentContext {
        mode: Some(SessionMode::Channel),
        session_id: uuid::Uuid::parse_str(&admitted_session_id).ok(),
        ..CurrentContext::current()
    };

    // 派发后台推理执行与完成监听，结束后同步更新任务状态并全局广播
    tokio::spawn(async move {
        let inner_tx = fan_tx.clone();
        let inner_chats = cleanup_chats.clone();
        let inner_op = cleanup_op.clone();
        let inner_terminal = terminal_sent.clone();
        let inner = tokio::spawn(async move {
            CurrentContext::scope(ctx, || async move {
                process_chat_request(
                    chat_req,
                    inner_tx,
                    cancel_token,
                    inner_op,
                    inner_chats,
                    mcp_pool,
                    telemetry,
                    pending_permissions,
                    pending_user_inputs,
                    false, // 定时任务无交互式权限阻断
                    false, // 定时任务无交互式提问阻断
                    inner_terminal,
                    false, // WebUI 标准会话渲染
                    Some(approval_mode),
                )
                .await
            })
            .await
        });

        finalize_chat_task(
            inner,
            &fan_tx,
            &cleanup_chats,
            &cleanup_op,
            &task_sid,
            &terminal_sent,
        )
        .await;

        let mut final_status = "ok".to_string();
        while let Some(evt) = rx.recv().await {
            match evt {
                ChatEvent::Done { .. } => {
                    final_status = "ok".to_string();
                    break;
                }
                ChatEvent::Error { .. } => {
                    final_status = "error".to_string();
                    break;
                }
                ChatEvent::Stopped => {
                    final_status = "stopped".to_string();
                    break;
                }
                _ => {}
            }
        }

        let tid_store = tid_for_spawn.clone();
        with_schedule_store(move || {
            if let Ok(mut fresh) = schedule::load(&tid_store) {
                fresh.last_status = Some(final_status);
                let _ = schedule::save(&fresh);
            }
        })
        .await;
        running_schedule_ids().lock().await.remove(&tid_for_spawn);
        publish_global(GlobalWireEvent::SchedulesUpdated);
    });

    Ok(ScheduleTaskView::from_task(task))
}

/// 启动 daemon 后台定时任务调度循环（每 15 秒扫盘评估一次）
pub fn start_schedule_engine(state: AppState) {
    tokio::spawn(async move {
        // 启动后短延迟等待系统初始化完成
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            let now = Local::now();
            let tasks = with_schedule_store(schedule::list).await;
            for task in tasks {
                if let Some(slot) = is_task_due_at(&task, now) {
                    let st = state.clone();
                    let tid = task.id.clone();
                    tokio::spawn(async move {
                        if let Err((code, msg)) =
                            dispatch_schedule_task(&st, &tid, Some(slot), false).await
                        {
                            if code != StatusCode::CONFLICT {
                                tracing::warn!(
                                    task_id = %tid,
                                    error = %msg,
                                    "[schedule] background trigger failed"
                                );
                                let tid_err = tid.clone();
                                with_schedule_store(move || {
                                    if let Ok(mut fresh) = schedule::load(&tid_err) {
                                        fresh.last_status = Some("error".to_string());
                                        if fresh.one_shot {
                                            fresh.enabled = false;
                                        }
                                        let _ = schedule::save(&fresh);
                                    }
                                })
                                .await;
                                publish_global(GlobalWireEvent::SchedulesUpdated);
                            }
                        }
                    });
                }
            }
        }
    });
}

// ============================================================================
// HTTP API Handlers
// ============================================================================

/// GET /api/schedules — 获取所有定时任务（附带按本地时区计算的 next_run_at）
pub async fn list_schedules_api() -> impl IntoResponse {
    let tasks = with_schedule_store(schedule::list).await;
    let views: Vec<ScheduleTaskView> = tasks.into_iter().map(ScheduleTaskView::from_task).collect();
    Json(views)
}

/// POST /api/schedules — 新建定时任务（默认 permission_mode = "auto"）
pub async fn create_schedule_api(
    State(state): State<AppState>,
    Json(req): Json<ScheduleUpsertRequest>,
) -> impl IntoResponse {
    let title = req.title.trim().to_string();
    let prompt = req.prompt.trim().to_string();
    if title.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Task title is required").into_response();
    }
    if prompt.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Task prompt is required").into_response();
    }
    let clean_schedule = match sanitize_schedule(req.schedule) {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::BAD_REQUEST, err).into_response(),
    };

    let cwd = if req.cwd.trim().is_empty() {
        state.bind_working_dir.to_string_lossy().into_owned()
    } else {
        req.cwd.trim().to_string()
    };

    let task = ScheduleTask {
        id: generate_task_id(&title),
        title,
        prompt,
        cwd,
        schedule: clean_schedule,
        permission_mode: sanitize_permission_mode(req.permission_mode.as_deref()),
        notify: req.notify.unwrap_or_else(|| "important".to_string()),
        enabled: req.enabled.unwrap_or(true),
        one_shot: req.one_shot.unwrap_or(false),
        session_mode: sanitize_session_mode(req.session_mode.as_deref()),
        reuse_session_id: req.reuse_session_id.filter(|s| !s.trim().is_empty()),
        last_session_id: None,
        model: req.model.filter(|s| !s.trim().is_empty()),
        overlap_policy: sanitize_overlap_policy(req.overlap_policy.as_deref()),
        last_fired_slot: None,
        created_at: now_epoch_secs(),
        last_run_at: None,
        last_status: None,
    };

    let task_to_save = task.clone();
    if let Err(e) = with_schedule_store(move || schedule::save(&task_to_save)).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to save scheduled task: {e}"),
        )
        .into_response();
    }

    publish_global(GlobalWireEvent::SchedulesUpdated);
    (StatusCode::CREATED, Json(ScheduleTaskView::from_task(task))).into_response()
}

/// PUT /api/schedules/:id — 编辑更新已有定时任务
pub async fn update_schedule_api(
    Path(id): Path<String>,
    Json(req): Json<ScheduleUpsertRequest>,
) -> impl IntoResponse {
    let title = req.title.trim().to_string();
    let prompt = req.prompt.trim().to_string();
    if title.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Task title is required").into_response();
    }
    if prompt.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Task prompt is required").into_response();
    }
    let clean_schedule = match sanitize_schedule(req.schedule) {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::BAD_REQUEST, err).into_response(),
    };

    let updated = match with_schedule_store(move || {
        let mut task = schedule::load(&id)
            .map_err(|_| (StatusCode::NOT_FOUND, "Task not found".to_string()))?;
        task.title = title;
        task.prompt = prompt;
        if !req.cwd.trim().is_empty() {
            task.cwd = req.cwd.trim().to_string();
        }
        task.schedule = clean_schedule;
        if let Some(pm) = req.permission_mode.as_deref() {
            task.permission_mode = sanitize_permission_mode(Some(pm));
        }
        if let Some(n) = req.notify {
            task.notify = n;
        }
        if let Some(en) = req.enabled {
            task.enabled = en;
        }
        if let Some(os) = req.one_shot {
            task.one_shot = os;
        }
        if let Some(sm) = req.session_mode.as_deref() {
            task.session_mode = sanitize_session_mode(Some(sm));
        }
        if req.reuse_session_id.is_some() {
            task.reuse_session_id = req.reuse_session_id.filter(|s| !s.trim().is_empty());
        }
        // model 允许显式清空恢复跟随默认模型
        task.model = req.model.filter(|s| !s.trim().is_empty());
        if let Some(op) = req.overlap_policy.as_deref() {
            task.overlap_policy = sanitize_overlap_policy(Some(op));
        }
        // 编辑规则后重置 slot 标记以便新规则即时生效
        task.last_fired_slot = None;

        schedule::save(&task).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to save scheduled task: {e}"),
            )
        })?;
        Ok::<_, (StatusCode, String)>(task)
    })
    .await
    {
        Ok(t) => t,
        Err((status, msg)) => return json_error(status, msg).into_response(),
    };

    publish_global(GlobalWireEvent::SchedulesUpdated);
    Json(ScheduleTaskView::from_task(updated)).into_response()
}

/// DELETE /api/schedules/:id — 物理删除定时任务
pub async fn delete_schedule_api(Path(id): Path<String>) -> impl IntoResponse {
    if let Err(e) = with_schedule_store(move || schedule::remove(&id)).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to delete scheduled task: {e}"),
        )
        .into_response();
    }
    publish_global(GlobalWireEvent::SchedulesUpdated);
    Json(json!({ "success": true })).into_response()
}

/// POST /api/schedules/:id/toggle — 即刻开启/关闭定时任务并全局广播
pub async fn toggle_schedule_api(
    Path(id): Path<String>,
    body: Option<Json<ToggleScheduleRequest>>,
) -> impl IntoResponse {
    let req_enabled = body.and_then(|b| b.0.enabled);
    let updated = match with_schedule_store(move || {
        let mut task = schedule::load(&id)
            .map_err(|_| (StatusCode::NOT_FOUND, "Task not found".to_string()))?;
        task.enabled = req_enabled.unwrap_or(!task.enabled);
        if task.enabled {
            task.last_fired_slot = None;
        }
        schedule::save(&task).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to save scheduled task: {e}"),
            )
        })?;
        Ok::<_, (StatusCode, String)>(task)
    })
    .await
    {
        Ok(t) => t,
        Err((status, msg)) => return json_error(status, msg).into_response(),
    };

    publish_global(GlobalWireEvent::SchedulesUpdated);
    Json(ScheduleTaskView::from_task(updated)).into_response()
}

/// POST /api/schedules/:id/run — 手动立即试跑定时任务
pub async fn run_schedule_now_api(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match dispatch_schedule_task(&state, &id, None, true).await {
        Ok(view) => Json(view).into_response(),
        Err((status, msg)) => json_error(status, msg).into_response(),
    }
}

// ============================================================================
// AI 专属定时任务设定对话区（工具严格隔离，仅在此端点动态注入 set_schedule）
// ============================================================================

/// 构造独立挂载的 `set_schedule` 工具定义（不会进入主会话工具池与内置提示词）
fn set_schedule_tool_def() -> ToolDef {
    ToolDef {
        name: "set_schedule".to_string(),
        description: "Create a brand new independent scheduled automation task (or update an existing one if task_id is provided). Defaults to 'auto' approval mode so background automation can execute smoothly.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Optional existing task ID to update. Omit to create a brand new independent scheduled task."
                },
                "title": {
                    "type": "string",
                    "description": "Concise descriptive title of the scheduled task."
                },
                "prompt": {
                    "type": "string",
                    "description": "The instruction prompt sent as the first user turn when the schedule triggers."
                },
                "mode": {
                    "type": "string",
                    "enum": ["calendar", "interval"],
                    "description": "'calendar' for specific times/weekdays/dates, or 'interval' for running every N minutes."
                },
                "dates": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional specific local dates in YYYY-MM-DD format. Leave empty together with weekdays for every day."
                },
                "weekdays": {
                    "type": "array",
                    "items": { "type": "integer", "minimum": 1, "maximum": 7 },
                    "description": "Optional weekday numbers: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun."
                },
                "times": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Local 24h time points in HH:MM format, e.g. [\"09:00\", \"18:30\"]. Required when mode is 'calendar'."
                },
                "every_minutes": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Trigger period in minutes (e.g. 30, 60, 1440). Required when mode is 'interval'."
                },
                "one_shot": {
                    "type": "boolean",
                    "description": "If true, automatically disable the task after it executes once."
                },
                "session_mode": {
                    "type": "string",
                    "enum": ["isolated", "reuse"],
                    "description": "'isolated' creates a new timestamped session on each execution (default); 'reuse' appends turns to the same session."
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional workspace path override. Omit to use the currently selected workspace."
                },
                "enabled": {
                    "type": "boolean",
                    "description": "Whether the scheduled task should be active immediately (default true)."
                }
            },
            "required": ["title", "prompt", "mode"]
        }),
    }
}

#[derive(Debug, Deserialize)]
struct SetScheduleToolArgs {
    #[serde(default)]
    task_id: Option<String>,
    title: String,
    prompt: String,
    mode: String,
    #[serde(default)]
    dates: Vec<String>,
    #[serde(default)]
    weekdays: Vec<u8>,
    #[serde(default)]
    times: Vec<String>,
    #[serde(default)]
    every_minutes: Option<u32>,
    #[serde(default)]
    one_shot: Option<bool>,
    #[serde(default)]
    session_mode: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

async fn execute_set_schedule_tool(
    raw_args: &str,
    default_cwd: &str,
    default_model: Option<String>,
) -> Result<ScheduleTaskView, String> {
    let args: SetScheduleToolArgs =
        serde_json::from_str(raw_args).map_err(|e| format!("Invalid tool arguments: {e}"))?;

    let title = args.title.trim().to_string();
    let prompt = args.prompt.trim().to_string();
    if title.is_empty() || prompt.is_empty() {
        return Err("Both 'title' and 'prompt' must be non-empty".to_string());
    }

    let raw_sched = match args.mode.trim().to_ascii_lowercase().as_str() {
        "interval" => Schedule::Interval {
            every_minutes: args.every_minutes.unwrap_or(60).max(1),
        },
        "calendar" => {
            let times = if args.times.is_empty() {
                vec!["09:00".to_string()]
            } else {
                args.times
            };
            Schedule::Calendar {
                dates: args.dates,
                weekdays: args.weekdays,
                times,
            }
        }
        other => return Err(format!("Unsupported schedule mode: {other}")),
    };
    let clean_schedule = sanitize_schedule(raw_sched)?;

    let cwd = args
        .cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_cwd.to_string());

    let saved = with_schedule_store(move || {
        if let Some(tid) = args
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut existing =
                schedule::load(tid).map_err(|_| format!("Scheduled task '{tid}' not found"))?;
            existing.title = title;
            existing.prompt = prompt;
            existing.cwd = cwd;
            existing.schedule = clean_schedule;
            if let Some(os) = args.one_shot {
                existing.one_shot = os;
            }
            if let Some(sm) = args.session_mode.as_deref() {
                existing.session_mode = sanitize_session_mode(Some(sm));
            }
            if let Some(en) = args.enabled {
                existing.enabled = en;
            }
            existing.last_fired_slot = None;
            schedule::save(&existing).map_err(|e| format!("Failed to persist task: {e}"))?;
            Ok::<_, String>(existing)
        } else {
            let task = ScheduleTask {
                id: generate_task_id(&title),
                title,
                prompt,
                cwd,
                schedule: clean_schedule,
                // AI 新增定时任务默认选择 auto 模式
                permission_mode: "auto".to_string(),
                notify: "important".to_string(),
                enabled: args.enabled.unwrap_or(true),
                one_shot: args.one_shot.unwrap_or(false),
                session_mode: sanitize_session_mode(args.session_mode.as_deref()),
                reuse_session_id: None,
                last_session_id: None,
                model: default_model,
                overlap_policy: "skip".to_string(),
                last_fired_slot: None,
                created_at: now_epoch_secs(),
                last_run_at: None,
                last_status: None,
            };
            schedule::save(&task).map_err(|e| format!("Failed to persist task: {e}"))?;
            Ok(task)
        }
    })
    .await?;

    publish_global(GlobalWireEvent::SchedulesUpdated);
    Ok(ScheduleTaskView::from_task(saved))
}

async fn run_one_llm_round(
    provider: &Arc<dyn jeikcode_kernel::provider::LlmProvider>,
    messages: &[Message],
    tools: &[ToolDef],
) -> Result<(String, Vec<jeikcode_kernel::tool::ToolCall>), String> {
    const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
    let mut stream = provider
        .chat_stream(messages, tools, &ChatOptions::default())
        .await
        .map_err(|e| format!("LLM request open failed: {}", e.message))?;

    let mut text = String::new();
    let mut tool_calls = Vec::new();
    loop {
        let next = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(n) => n,
            Err(_) => return Err("LLM response timed out".to_string()),
        };
        match next {
            None => break,
            Some(StreamEvent::TextDelta(chunk)) => text.push_str(&chunk),
            Some(StreamEvent::ToolCall(tc)) => tool_calls.push(tc),
            Some(StreamEvent::Error(e)) => return Err(format!("LLM error: {}", e.message)),
            Some(StreamEvent::Done { .. }) => break,
            Some(_) => {}
        }
    }
    Ok((text, tool_calls))
}

/// POST /api/schedules/ai-dialog — 定时任务 AI 智能设定对话端点（纯无状态上下文，由前端内存维持对话）
pub async fn ai_schedule_dialog_api(
    State(state): State<AppState>,
    Json(req): Json<AiScheduleDialogRequest>,
) -> impl IntoResponse {
    if req.messages.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "messages cannot be empty").into_response();
    }

    let config = match Config::load(&Config::default_path()) {
        Ok(c) => c,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to load config: {e}"),
            )
            .into_response()
        }
    };

    let requested_model = req.model.as_deref().filter(|s| !s.trim().is_empty());
    let resolved_provider = crate::live_api::resolve_provider_name(&config, requested_model);
    if !config.selection_exists(&resolved_provider) {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("Model/provider '{resolved_provider}' is not configured"),
        )
        .into_response();
    }

    let default_cwd = req
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| state.bind_working_dir.to_string_lossy().into_owned());

    let working_dir_path = PathBuf::from(&default_cwd);
    let coding_cfg =
        crate::kernel_runtime::coding_config_from_runtime(&crate::live_api::chat_runtime_config(
            &config,
            &resolved_provider,
            &working_dir_path,
            state.telemetry.clone(),
        ));
    let factory = crate::runtime_host::coding_provider_factory();
    let provider = match tokio::task::spawn_blocking(move || factory.build(&coding_cfg, None)).await
    {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to initialize model provider: {e}"),
            )
            .into_response()
        }
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Provider build task panicked: {e}"),
            )
            .into_response()
        }
    };

    // 核心工具与 Agent 系统提示词严格保持英语规范（遵循 AGENTS.md 第 8 节）
    let local_now = Local::now();
    let weekday_num = local_now.weekday().number_from_monday();
    let sys_prompt = format!(
        "You are the dedicated Scheduled Task Assistant in JeikCode.\n\
        Your sole responsibility is helping the user configure and create automated scheduled tasks using the `set_schedule` tool.\n\n\
        Current local time: {} (weekday={}, where 1=Mon..7=Sun).\n\
        Default target workspace: {}\n\
        Default permission mode for scheduled tasks: auto (headless execution).\n\n\
        Rules:\n\
        1. Respond in the same language the user uses (e.g., Chinese for Chinese input, English for English input).\n\
        2. If the user's intent already includes what to run (prompt/task) and when to run it, immediately call `set_schedule` to create an independent task.\n\
        3. If critical information is missing or ambiguous (e.g., time or what the agent should actually do), briefly ask clarifying questions across multi-turn dialogue before calling `set_schedule`.\n\
        4. When interpreting relative dates like 'today' or 'tomorrow', calculate exact YYYY-MM-DD based on current local time; set `one_shot=true` if the user asks for a single one-time reminder or run.\n\
        5. Always omit `task_id` unless the user explicitly asks to modify a task ID returned earlier in this conversation.",
        local_now.format("%Y-%m-%d %H:%M:%S"),
        weekday_num,
        default_cwd
    );

    let mut kernel_msgs = vec![Message::system(sys_prompt)];
    for m in req.messages {
        let content = m.content.trim().to_string();
        if content.is_empty() {
            continue;
        }
        if m.role.eq_ignore_ascii_case("assistant") {
            kernel_msgs.push(Message::assistant(content, Vec::new()));
        } else {
            kernel_msgs.push(Message::user(content));
        }
    }

    let tools = [set_schedule_tool_def()];
    let mut created_tasks: Vec<ScheduleTaskView> = Vec::new();
    let mut final_reply = String::new();
    let explicit_model = requested_model.map(str::to_string);

    // 最多允许 3 轮工具调用迭代，保障稳健完成创建与确认回复
    for _round in 0..3 {
        let (text, tool_calls) = match run_one_llm_round(&provider, &kernel_msgs, &tools).await {
            Ok(res) => res,
            Err(err) => return json_error(StatusCode::BAD_GATEWAY, err).into_response(),
        };

        if tool_calls.is_empty() {
            final_reply = text;
            break;
        }

        kernel_msgs.push(Message::assistant(text, tool_calls.clone()));
        for tc in tool_calls {
            if tc.name == "set_schedule" {
                match execute_set_schedule_tool(&tc.arguments, &default_cwd, explicit_model.clone())
                    .await
                {
                    Ok(view) => {
                        let summary_json = json!({
                            "success": true,
                            "task_id": view.task.id,
                            "title": view.task.title,
                            "cwd": view.task.cwd,
                            "enabled": view.task.enabled,
                            "one_shot": view.task.one_shot,
                            "session_mode": view.task.session_mode,
                            "permission_mode": view.task.permission_mode,
                            "next_run_at": view.next_run_at,
                        });
                        created_tasks.push(view);
                        kernel_msgs.push(Message::tool_result(
                            tc.id,
                            summary_json.to_string(),
                            false,
                        ));
                    }
                    Err(err_msg) => {
                        kernel_msgs.push(Message::tool_result(
                            tc.id,
                            json!({ "success": false, "error": err_msg }).to_string(),
                            true,
                        ));
                    }
                }
            } else {
                kernel_msgs.push(Message::tool_result(
                    tc.id,
                    json!({ "success": false, "error": format!("Unknown tool: {}", tc.name) })
                        .to_string(),
                    true,
                ));
            }
        }
    }

    let created_task = created_tasks.last().cloned();
    Json(AiScheduleDialogResponse {
        reply: final_reply,
        created_tasks,
        created_task,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_schedule_normalizes_and_validates() {
        let sched = sanitize_schedule(Schedule::Calendar {
            dates: vec!["2026-11-20".into(), "2026-11-19".into()],
            weekdays: vec![5, 1, 5],
            times: vec!["9:5".into(), "18:00".into(), "09:05".into()],
        })
        .unwrap();
        match sched {
            Schedule::Calendar {
                dates,
                weekdays,
                times,
            } => {
                assert_eq!(dates, vec!["2026-11-19", "2026-11-20"]);
                assert_eq!(weekdays, vec![1, 5]);
                assert_eq!(times, vec!["09:05", "18:00"]);
            }
            _ => panic!("expected Calendar"),
        }

        assert!(sanitize_schedule(Schedule::Calendar {
            dates: vec![],
            weekdays: vec![],
            times: vec![],
        })
        .is_err());
        assert!(sanitize_schedule(Schedule::Interval { every_minutes: 0 }).is_err());
    }

    #[test]
    fn calendar_due_check_matches_and_deduplicates_slots() {
        let ndt = NaiveDateTime::new(
            NaiveDate::from_ymd_opt(2026, 11, 19).unwrap(), // 2026-11-19 is Thursday (weekday 4)
            NaiveTime::from_hms_opt(9, 30, 10).unwrap(),
        );
        let now = Local.from_local_datetime(&ndt).unwrap();

        let mut task = ScheduleTask {
            id: "t-due".into(),
            title: "Check".into(),
            prompt: "run check".into(),
            cwd: "/tmp".into(),
            schedule: Schedule::Calendar {
                dates: vec![],
                weekdays: vec![1, 4],
                times: vec!["09:30".into()],
            },
            ..Default::default()
        };

        let slot = is_task_due_at(&task, now);
        assert_eq!(slot.as_deref(), Some("cal:2026-11-19 09:30"));

        // 同一分钟槽位不重复触发
        task.last_fired_slot = slot;
        assert_eq!(is_task_due_at(&task, now), None);

        // 星期不匹配时返回 None
        task.last_fired_slot = None;
        task.schedule = Schedule::Calendar {
            dates: vec![],
            weekdays: vec![1, 2],
            times: vec!["09:30".into()],
        };
        assert_eq!(is_task_due_at(&task, now), None);

        // 指定具体日期可覆盖并命中；同时包含周一时会找到下周一 09:30
        task.schedule = Schedule::Calendar {
            dates: vec!["2026-11-19".into()],
            weekdays: vec![1],
            times: vec!["09:30".into()],
        };
        assert_eq!(
            is_task_due_at(&task, now).as_deref(),
            Some("cal:2026-11-19 09:30")
        );
        assert!(compute_next_run_local(&task, now).is_some());

        // 仅指定单日且已过 09:30:00 时，不存在下一次执行时间
        task.schedule = Schedule::Calendar {
            dates: vec!["2026-11-19".into()],
            weekdays: vec![],
            times: vec!["09:30".into()],
        };
        assert!(compute_next_run_local(&task, now).is_none());
    }

    #[tokio::test]
    async fn execute_set_schedule_tool_creates_independent_auto_task() {
        let _home = crate::tests::ScopedChatHome::new();
        let args = r#"{
            "title": "Daily Inspection",
            "prompt": "Check git status and tests",
            "mode": "calendar",
            "weekdays": [1, 2, 3, 4, 5],
            "times": ["09:00", "17:30"],
            "one_shot": true,
            "session_mode": "isolated"
        }"#;

        let created = execute_set_schedule_tool(args, "/tmp/demo-proj", Some("fast-model".into()))
            .await
            .expect("tool should create task");

        assert_eq!(created.task.title, "Daily Inspection");
        assert_eq!(created.task.permission_mode, "auto");
        assert_eq!(created.task.cwd, "/tmp/demo-proj");
        assert_eq!(created.task.model.as_deref(), Some("fast-model"));
        assert!(created.task.one_shot);
        assert_eq!(created.task.session_mode, "isolated");
        assert!(created.next_run_at.is_some());

        let persisted = schedule::load(&created.task.id).expect("saved on disk");
        assert_eq!(persisted.permission_mode, "auto");
    }

    #[test]
    fn sanitize_permission_mode_preserves_valid_modes_and_defaults_to_auto() {
        assert_eq!(sanitize_permission_mode(None), "auto");
        assert_eq!(sanitize_permission_mode(Some("auto")), "auto");
        assert_eq!(sanitize_permission_mode(Some("bypass")), "auto");
        assert_eq!(sanitize_permission_mode(Some("build")), "build");
        assert_eq!(
            sanitize_permission_mode(Some("accept_edits")),
            "accept_edits"
        );
        assert_eq!(sanitize_permission_mode(Some("plan")), "plan");
    }
}
