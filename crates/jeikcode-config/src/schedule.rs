use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Schedule {
    /// 复合日历规则：日期列表 × 星期多选 × 多时间点正交组合（守护进程按本地时区精确调度）
    Calendar {
        #[serde(default)]
        dates: Vec<String>, // "YYYY-MM-DD" 列表
        #[serde(default)]
        weekdays: Vec<u8>, // 1..=7 (1=周一 .. 7=周日)
        #[serde(default)]
        times: Vec<String>, // "HH:MM" 列表
    },
    Daily {
        time: String,
    }, // "HH:MM"
    Weekly {
        weekday: u8,
        time: String,
    }, // weekday 1..=7 (1=Mon)
    Hourly,
    Interval {
        every_minutes: u32,
    },
    Cron {
        expr: String,
    },
}

impl Default for Schedule {
    fn default() -> Self {
        Self::Calendar {
            dates: Vec::new(),
            weekdays: Vec::new(),
            times: vec!["09:00".to_string()],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub cwd: String,
    pub schedule: Schedule,
    #[serde(default = "default_mode")]
    pub permission_mode: String, // "auto" | "accept_edits" | "plan"
    #[serde(default = "default_notify")]
    pub notify: String, // "off" | "important" | "all"
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 是否为一次性任务：触发运行一次后自动关闭 `enabled`
    #[serde(default)]
    pub one_shot: bool,
    /// 会话归档模式："isolated"（每次新建带时间戳独立会话）| "reuse"（复用同一会话延续上下文）
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    /// 复用会话模式下绑定的已有会话 ID
    #[serde(default)]
    pub reuse_session_id: Option<String>,
    /// 最近一次触发所使用/创建的会话 ID
    #[serde(default)]
    pub last_session_id: Option<String>,
    /// 可选专属模型/Provider 配置名（为空时使用系统当前默认模型）
    #[serde(default)]
    pub model: Option<String>,
    /// 防重入策略："skip"（运行中跳过本次触发）| "queue"（复用会话忙时入队）
    #[serde(default = "default_overlap_policy")]
    pub overlap_policy: String,
    /// 最近已触发的分钟级槽位标记（如 "2026-11-19 09:30"），避免同槽位重复触发
    #[serde(default)]
    pub last_fired_slot: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
}

impl Default for ScheduleTask {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            prompt: String::new(),
            cwd: String::new(),
            schedule: Schedule::default(),
            permission_mode: default_mode(),
            notify: default_notify(),
            enabled: true,
            one_shot: false,
            session_mode: default_session_mode(),
            reuse_session_id: None,
            last_session_id: None,
            model: None,
            overlap_policy: default_overlap_policy(),
            last_fired_slot: None,
            created_at: 0,
            last_run_at: None,
            last_status: None,
        }
    }
}

fn default_mode() -> String {
    "auto".into()
}
fn default_notify() -> String {
    "important".into()
}
fn default_session_mode() -> String {
    "isolated".into()
}
fn default_overlap_policy() -> String {
    "skip".into()
}
fn default_true() -> bool {
    true
}

pub fn schedules_root() -> PathBuf {
    crate::config::Config::config_dir().join("schedules")
}

/// A task id is used verbatim to build its on-disk `<id>.json` path, so it must
/// not be able to escape the schedules directory. Ids minted by `build_task`
/// (slug + uuid) are always in-shape, but `load`/`remove`/`enable`/`disable`/`run`
/// take an id straight from an untrusted CLI argument. Accept only a conservative
/// filename-safe alphabet and explicitly reject path separators and `..`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id != ".."
        && !id.contains("..")
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn task_path_in(root: &std::path::Path, id: &str) -> std::io::Result<PathBuf> {
    if !valid_id(id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid scheduled task id {id:?}"),
        ));
    }
    Ok(root.join(format!("{id}.json")))
}

fn save_in(root: &std::path::Path, task: &ScheduleTask) -> std::io::Result<()> {
    use std::io::Write;
    let path = task_path_in(root, &task.id)?;
    std::fs::create_dir_all(root)?;
    let bytes = serde_json::to_vec_pretty(task)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // 采用同目录临时文件原子替换，防止并发读写或意外中断撕裂任务配置
    let mut tmp = tempfile::NamedTempFile::new_in(root)?;
    tmp.write_all(&bytes)?;
    tmp.persist(&path).map_err(|e| e.error)?;
    Ok(())
}

fn load_in(root: &std::path::Path, id: &str) -> std::io::Result<ScheduleTask> {
    let bytes = std::fs::read(task_path_in(root, id)?)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn list_in(root: &std::path::Path) -> Vec<ScheduleTask> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(t) = serde_json::from_slice::<ScheduleTask>(&bytes) {
                out.push(t); // corrupt files are skipped
            }
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    out
}

fn remove_in(root: &std::path::Path, id: &str) -> std::io::Result<()> {
    match std::fs::remove_file(task_path_in(root, id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub fn save(task: &ScheduleTask) -> std::io::Result<()> {
    save_in(&schedules_root(), task)
}
pub fn load(id: &str) -> std::io::Result<ScheduleTask> {
    load_in(&schedules_root(), id)
}
pub fn list() -> Vec<ScheduleTask> {
    list_in(&schedules_root())
}
pub fn remove(id: &str) -> std::io::Result<()> {
    remove_in(&schedules_root(), id)
}

/// Next fire time (epoch secs) for simple frequencies. `Cron` returns None in
/// phase 1 (its real firing is the phase-2 OS scheduler). Uses naive local-less
/// UTC arithmetic; day/hour rollover only (no DST handling — acceptable for the
/// list display, exact firing is the OS scheduler's job in phase 2).
pub fn next_run(schedule: &Schedule, now_epoch_secs: i64) -> Option<i64> {
    fn hhmm(s: &str) -> Option<(i64, i64)> {
        let (h, m) = s.split_once(':')?;
        Some((h.parse().ok()?, m.parse().ok()?))
    }
    match schedule {
        Schedule::Calendar { times, .. } => {
            let day = now_epoch_secs.div_euclid(86400) * 86400;
            let mut best: Option<i64> = None;
            for t in times {
                if let Some((h, m)) = hhmm(t) {
                    let target = day + h * 3600 + m * 60;
                    let candidate = if target > now_epoch_secs {
                        target
                    } else {
                        target + 86400
                    };
                    best = Some(match best {
                        Some(cur) => cur.min(candidate),
                        None => candidate,
                    });
                }
            }
            best
        }
        Schedule::Interval { every_minutes } => {
            (*every_minutes > 0).then(|| now_epoch_secs + (*every_minutes as i64) * 60)
        }
        Schedule::Hourly => {
            let secs_into_hour = now_epoch_secs.rem_euclid(3600);
            Some(now_epoch_secs + (3600 - secs_into_hour))
        }
        Schedule::Daily { time } => {
            let (h, m) = hhmm(time)?;
            let day = now_epoch_secs.div_euclid(86400) * 86400;
            let target = day + h * 3600 + m * 60;
            Some(if target > now_epoch_secs {
                target
            } else {
                target + 86400
            })
        }
        Schedule::Weekly { time, .. } => {
            // Phase 1 approximation: next day-boundary match of the time; exact
            // weekday alignment is delegated to the OS scheduler (phase 2).
            let (h, m) = hhmm(time)?;
            let day = now_epoch_secs.div_euclid(86400) * 86400;
            let target = day + h * 3600 + m * 60;
            Some(if target > now_epoch_secs {
                target
            } else {
                target + 86400
            })
        }
        Schedule::Cron { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ScheduleTask {
        ScheduleTask {
            id: "t1".into(),
            title: "Daily brief".into(),
            prompt: "summarize".into(),
            cwd: "/tmp/proj".into(),
            schedule: Schedule::Daily {
                time: "09:00".into(),
            },
            permission_mode: "plan".into(),
            notify: "important".into(),
            enabled: true,
            created_at: 0,
            last_run_at: None,
            last_status: None,
            ..Default::default()
        }
    }

    #[test]
    fn task_json_roundtrips() {
        let t = sample();
        let json = serde_json::to_string(&t).unwrap();
        let back: ScheduleTask = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "t1");
        assert!(matches!(back.schedule, Schedule::Daily { .. }));
        assert_eq!(back.permission_mode, "plan");
    }

    #[test]
    fn store_save_load_list_remove_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        save_in(root, &sample()).unwrap();
        assert_eq!(load_in(root, "t1").unwrap().title, "Daily brief");
        assert_eq!(list_in(root).len(), 1);
        remove_in(root, "t1").unwrap();
        assert!(list_in(root).is_empty());
    }

    #[test]
    fn store_rejects_ids_that_escape_the_schedules_dir() {
        use std::io::ErrorKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for bad in ["../evil", "a/b", "a\\b", "foo/../bar", "..", ""] {
            // remove/enable/disable/run and save all flow through these helpers,
            // so a crafted id must be rejected before it can touch the filesystem.
            assert_eq!(
                remove_in(root, bad).unwrap_err().kind(),
                ErrorKind::InvalidInput,
                "remove should reject id {bad:?}"
            );
            assert_eq!(
                load_in(root, bad).unwrap_err().kind(),
                ErrorKind::InvalidInput,
                "load should reject id {bad:?}"
            );
            let mut task = sample();
            task.id = bad.to_string();
            assert_eq!(
                save_in(root, &task).unwrap_err().kind(),
                ErrorKind::InvalidInput,
                "save should reject id {bad:?}"
            );
        }
        // A traversal id must not have written anything outside the store.
        assert!(!tmp.path().parent().unwrap().join("evil.json").exists());
    }

    #[test]
    fn store_accepts_slug_and_uuid_shaped_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut task = sample();
        task.id = "daily-brief_2026.01-9f8e7d6c".into();
        save_in(root, &task).unwrap();
        assert_eq!(load_in(root, &task.id).unwrap().id, task.id);
        remove_in(root, &task.id).unwrap();
    }

    #[test]
    fn next_run_daily_is_today_or_tomorrow_at_time() {
        // 2026-07-31 08:00:00 UTC = 1785657600 ; daily 09:00 → same day 09:00
        let now = 1785657600;
        let nr = next_run(
            &Schedule::Daily {
                time: "09:00".into(),
            },
            now,
        )
        .unwrap();
        assert!(nr > now && nr - now <= 24 * 3600);
    }

    #[test]
    fn next_run_cron_is_none_in_phase1() {
        assert_eq!(
            next_run(
                &Schedule::Cron {
                    expr: "0 9 * * *".into()
                },
                0
            ),
            None
        );
    }

    #[test]
    fn default_task_uses_auto_mode_and_calendar_roundtrips() {
        let mut t = ScheduleTask::default();
        assert_eq!(t.permission_mode, "auto");
        assert_eq!(t.session_mode, "isolated");
        assert!(!t.one_shot);
        t.id = "cal-1".into();
        t.title = "Inspect".into();
        t.schedule = Schedule::Calendar {
            dates: vec!["2026-11-20".into()],
            weekdays: vec![1, 3, 5],
            times: vec!["09:30".into(), "18:00".into()],
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: ScheduleTask = serde_json::from_str(&json).unwrap();
        assert_eq!(back.permission_mode, "auto");
        assert_eq!(back.schedule, t.schedule);
    }
}
