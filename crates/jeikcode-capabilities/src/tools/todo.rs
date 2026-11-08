//! `todo_write` — session task list. STATELESS execute: the tool validates + echoes;
//! current state is DERIVED by folding transcript `todo_write`/`todowrite`/`todo` calls
//! ([`reduce_todos`]). Preferred shape is `actions[]` (or a single action object);
//! `action` may be omitted when the other fields uniquely determine the op.
//! `{"todos":[…]}` is resume/legacy full-list replace only. `list` is a read-only echo of
//! the current list (legacy name kept as a first-class read; never batched). Non-destructive ⇒ `Safe`.

/// Canonical name advertised to the model. `todowrite` / `todo` remain aliases so
/// old transcripts and models still fold.
pub const TODO_TOOL_NAME: &str = "todo_write";
pub const TODO_TOOL_ALIASES: &[&str] = &["todowrite", "todo"];

pub fn is_todo_tool_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(TODO_TOOL_NAME)
        || TODO_TOOL_ALIASES
            .iter()
            .any(|alias| name.eq_ignore_ascii_case(alias))
}

use super::{err, ok};
use async_trait::async_trait;
use jeikcode_kernel::message::Message;
use jeikcode_kernel::tool::{Tool, ToolContext, ToolRegistry, ToolResult};
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex, Weak};

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    fn parse(s: &str) -> Option<TodoStatus> {
        match s {
            "pending" => Some(TodoStatus::Pending),
            "in_progress" => Some(TodoStatus::InProgress),
            "completed" => Some(TodoStatus::Completed),
            _ => None,
        }
    }
}

impl std::fmt::Display for TodoStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TodoStatus::Pending => write!(f, "pending"),
            TodoStatus::InProgress => write!(f, "in_progress"),
            TodoStatus::Completed => write!(f, "completed"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

/// Terminal-safe status glyph. Unicode `[•]`/`[✓]` gated behind `unicode`; ASCII
/// `[~]`/`[x]` fallback (mirrors the spinner / hint-marker unicode gating).
pub fn todo_glyph(status: TodoStatus, unicode: bool) -> &'static str {
    match (status, unicode) {
        (TodoStatus::Pending, _) => "[ ]",
        (TodoStatus::InProgress, true) => "[\u{2022}]",
        (TodoStatus::InProgress, false) => "[~]",
        (TodoStatus::Completed, true) => "[√]",
        (TodoStatus::Completed, false) => "[√]",
    }
}

/// One line per item: `<glyph> <content>`. Empty list → "(no tasks)".
pub fn render_todos_text(todos: &[TodoItem], unicode: bool) -> String {
    if todos.is_empty() {
        return "(no tasks)".to_string();
    }
    todos
        .iter()
        .map(|t| format!("{} {}", todo_glyph(t.status, unicode), t.content))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One line per item WITH its 1-based id: `<glyph> <id>. <content>`. This is the shape the
/// TUI title cache (`parse_todo_titles_into`) reads to learn `id → title`, so an incremental
/// `todo update id=N` row can render the task NAME, not just `#N`. Empty list → "(no tasks)".
pub fn render_todos_numbered(todos: &[TodoItem], unicode: bool) -> String {
    if todos.is_empty() {
        return "(no tasks)".to_string();
    }
    todos
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{} {}. {}", todo_glyph(t.status, unicode), i + 1, t.content))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Deserialize)]
struct RawItem {
    content: String,
    status: String,
}

#[derive(Deserialize)]
struct Args {
    todos: Vec<RawItem>,
}

/// Parse + validate the full-list args. Enforces: valid status enum, non-empty
/// content, at most one `in_progress`. Returns a human-readable reason on failure
/// (fed back to the model so it can correct and resend).
pub fn parse_todos(args: &str) -> Result<Vec<TodoItem>, String> {
    let mut value: serde_json::Value = serde_json::from_str(args)
        .map_err(|e| format!("todowrite: invalid arguments: {e}. Expected {{\"todos\":[{{\"content\":\"…\",\"status\":\"pending|in_progress|completed\"}}]}}."))?;
    // Keep transcript-derived state aligned with RepairToolArgsMiddleware. The
    // kernel stores the model's original tool call before middleware rewriting,
    // so a provider that emits `{"todos":"[...]"}` must be tolerated here too:
    // live execution, TodoHook, replay, and resume all converge on parse_todos.
    // Decode exactly one layer and only for `todos`, whose public schema is an
    // array; malformed, double-stringified, or wrong-container values still fail.
    if let Some(raw) = value.get("todos").and_then(serde_json::Value::as_str) {
        if let Ok(decoded) = serde_json::from_str::<serde_json::Value>(raw) {
            if decoded.is_array() {
                value["todos"] = decoded;
            }
        }
    }
    canonicalize_todo_keys(&mut value);
    let a: Args = serde_json::from_value(value)
        .map_err(|e| format!("todowrite: invalid arguments: {e}. Expected {{\"todos\":[{{\"content\":\"…\",\"status\":\"pending|in_progress|completed\"}}]}}."))?;
    let mut out = Vec::with_capacity(a.todos.len());
    for item in a.todos {
        let content = normalize_todo_content(&item.content);
        if content.is_empty() {
            return Err("todowrite: every task needs non-empty `content`.".to_string());
        }
        let status = TodoStatus::parse(&item.status).ok_or_else(|| {
            format!(
                "todowrite: `status` must be one of pending|in_progress|completed (got `{}`).",
                item.status
            )
        })?;
        upsert_todo(&mut out, content, Some(status), None);
    }
    Ok(out)
}

/// `(completed, in_progress, total)` for a todo list. The footer progress
/// indicator renders the counts in its header. `total == 0` ⇒ caller omits
/// the indicator (no todos yet). All three counts are derived from a single
/// pass so callers don't need separate `filter` scans.
pub fn todo_counts(todos: &[TodoItem]) -> (usize, usize, usize) {
    let mut completed = 0;
    let mut in_progress = 0;
    for t in todos {
        match t.status {
            TodoStatus::Completed => completed += 1,
            TodoStatus::InProgress => in_progress += 1,
            TodoStatus::Pending => {}
        }
    }
    (completed, in_progress, todos.len())
}

/// Apply ONE incremental `todo` call (`action` or `actions[]`) to `list`.
/// `id` is the 1-based position: `add` appends (existing ids stay), `update`
/// patches in place, `insert`/`delete`/`remove` shift later ids. Malformed /
/// unknown-id / illegal-mix calls are IGNORED (the tool already returned an
/// error; derived state must stay consistent). `update` to `in_progress` first
/// clears any OTHER in_progress, so the "exactly one in_progress" invariant
/// holds regardless of the model.
pub fn apply_todo_action(list: &mut Vec<TodoItem>, args: &str) {
    let _ = try_apply_todo_args(list, args);
}

/// Outcome of applying one todowrite payload. `Unchanged` is a successful no-op
/// (e.g. update to the status the item already has) — not an error, so the model
/// should not retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    Changed,
    Unchanged,
}

/// Apply `action` / `actions[]`. `todos` full-list replace is NOT handled here
/// (that is a fold baseline / execute plan path). Malformed JSON is `Err`.
pub fn try_apply_todo_args(list: &mut Vec<TodoItem>, args: &str) -> Result<ApplyOutcome, String> {
    let mut v = serde_json::from_str::<serde_json::Value>(args)
        .map_err(|e| format!("todowrite: invalid JSON arguments: {e}"))?;
    canonicalize_todo_keys(&mut v);
    if let Some(arr) = v.get("actions").and_then(|a| a.as_array()) {
        if arr.is_empty() {
            return Err("todowrite: `actions` must be a non-empty array.".into());
        }
        let next = apply_actions_batch(list, arr)?;
        if next == *list {
            return Ok(ApplyOutcome::Unchanged);
        }
        *list = next;
        return Ok(ApplyOutcome::Changed);
    }
    if v.get("todos").is_some() {
        return Ok(ApplyOutcome::Unchanged);
    }
    let before = list.clone();
    try_apply_one_action(list, &v)?;
    if *list == before {
        Ok(ApplyOutcome::Unchanged)
    } else {
        Ok(ApplyOutcome::Changed)
    }
}

fn explicit_action(v: &serde_json::Value) -> Option<&str> {
    v.get("action").and_then(|a| a.as_str())
}

pub fn todo_action_kind(v: &serde_json::Value) -> Option<&'static str> {
    let mut v = v.clone();
    canonicalize_todo_keys(&mut v);
    action_kind(&v)
}

fn action_kind(v: &serde_json::Value) -> Option<&'static str> {
    match explicit_action(v) {
        Some("add") => Some("add"),
        Some("insert") => Some("insert"),
        Some("update") => Some("update"),
        Some("delete") | Some("remove") => Some("delete"),
        Some("clear") => Some("clear"),
        // 只读的列表动作：老形态 {\"action\":\"list\"} 仍要能被识别（TUI 详情面板靠它渲染
        // “list all”，工具侧也不该把它当未知动作拒掉）。
        Some("list") => Some("list"),
        Some(_) => None,
        None => infer_action_kind(v),
    }
}

/// When `action` is omitted, the remaining fields must uniquely determine the op.
/// `clear` is never inferred (empty `{}` is too destructive).
fn infer_action_kind(v: &serde_json::Value) -> Option<&'static str> {
    let has_id = json_id(v).is_some();
    let has_content = v
        .get("content")
        .and_then(|c| c.as_str())
        .map(normalize_todo_content)
        .is_some_and(|c| !c.is_empty());
    let has_status = action_status(v).is_some();
    // Do not treat `id` as an insert slot — that fallback is only for explicit insert.
    let has_position =
        v.get("position").is_some() || v.get("after").is_some() || v.get("after_id").is_some();
    match (has_id, has_content, has_status, has_position) {
        (false, true, _, true) => Some("insert"),
        (false, true, _, false) => Some("add"),
        (true, true, _, false) => Some("update"),
        (true, false, true, false) => Some("update"),
        (true, false, false, false) => has_only_known_action_keys(v).then_some("delete"),
        _ => None,
    }
}

/// A root object carrying action fields (rather than an `actions`/`todos`
/// container) is a legacy single-action call. Wrapping it keeps field-level
/// diagnostics reachable for a typo (`{"id":1,"stauts":"completed"}`).
fn looks_like_single_action(v: &serde_json::Value) -> bool {
    v.as_object().is_some_and(|obj| {
        obj.keys()
            .any(|key| TODO_ACTION_FIELD_KEYS.contains(&key.as_str()))
    })
}

fn unknown_or_uninferable_action(v: &serde_json::Value) -> String {
    if let Some(other) = explicit_action(v) {
        return format!(
            "`action` must be `delete` or `clear` (got `{other}`). Every other op is inferred from the fields: {{content}} adds, {{content,position}} inserts, {{id,status|content}} updates."
        );
    }
    let unknown = unknown_action_keys(v);
    let note = if unknown.is_empty() {
        String::new()
    } else {
        let listed = unknown
            .iter()
            .map(|key| format!("`{key}`"))
            .collect::<Vec<_>>()
            .join(", ");
        match unknown
            .iter()
            .find_map(|key| suggest_action_key(key).map(|known| (*key, known)))
        {
            Some((key, known)) => format!(
                "unrecognized key(s) {listed} (did you mean `{known}` instead of `{key}`?); "
            ),
            None => format!("unrecognized key(s) {listed}; "),
        }
    };
    format!(
        "{note}could not infer `action` from fields. Use {{content}} to add, {{content,position}} to insert, {{id,status}} or {{id,content}} to update, {{id}} to delete. `clear` always needs action=\"clear\""
    )
}

/// Legal `actions` mixes (id-shifting ops cannot share a batch with a different kind):
/// - `add` + `update` (add only appends; a finished plan stays in place so later
///   adds extend it instead of restarting ids)
/// - `clear` + `add` + `update` (`clear` always runs first, then add, then update)
/// - `insert` + `update` (internally: all inserts first, then updates by post-insert id)
/// - `delete` only (any order; ids are pre-batch)
/// - `clear` only / `update` only / `add` only
fn validate_actions_mix(arr: &[serde_json::Value]) -> Result<(), String> {
    let mut kinds = std::collections::BTreeSet::new();
    for (i, item) in arr.iter().enumerate() {
        match action_kind(item) {
            Some(k) => {
                kinds.insert(k);
            }
            None => {
                return Err(format!(
                    "todowrite: actions[{i}]: {}.",
                    unknown_or_uninferable_action(item).trim_end_matches('.')
                ));
            }
        }
    }
    let has = |k: &str| kinds.contains(k);
    if has("delete") && kinds.iter().any(|k| *k != "delete") {
        return Err(
            "todowrite: `delete` can only be batched with other deletes (ids would shift).".into(),
        );
    }
    if has("insert") && kinds.iter().any(|k| *k != "insert" && *k != "update") {
        return Err(
            "todowrite: `insert` can only be batched with other inserts and/or updates.".into(),
        );
    }
    if has("clear")
        && kinds
            .iter()
            .any(|k| *k != "clear" && *k != "add" && *k != "update")
    {
        return Err(
            "todowrite: `clear` can only be batched with `add` and/or `update` (`clear` runs first)."
                .into(),
        );
    }
    // `list` is read-only: it travels alone, so a batch can never imply a mutation it did
    // not ask for and the fold can treat it as a pure no-op.
    if has("list") && (kinds.len() > 1 || arr.len() > 1) {
        return Err(
            "todowrite: `list` is read-only and must be the only action (it cannot be batched)."
                .into(),
        );
    }
    Ok(())
}

fn normalize_todo_content(content: &str) -> String {
    content.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Every field a task action may carry. Also the allow-list for key repair:
/// a key that differs from one of these only by stray quoting/escaping is a
/// serialization slip, never a distinct user field.
const TODO_ACTION_FIELD_KEYS: &[&str] = &[
    "action", "id", "position", "status", "content", "after", "after_id",
];

fn is_root_todo_key(key: &str) -> bool {
    key == "actions" || key == "todos" || TODO_ACTION_FIELD_KEYS.contains(&key)
}

/// Exact-match repair for over-escaped keys.
///
/// A model/provider occasionally delivers `{"\"status\"":"in_progress"}`: after
/// JSON parsing the key is the string `"status"` — quotes included — so every
/// field lookup misses and the action falls through to the bare-`id` rule.
/// Repairing is safe because no legitimate field starts or ends with a
/// quote/backslash, and only KNOWN keys are remapped. A real typo (`stauts`)
/// is left untouched so validation can report it instead of guessing.
fn canonicalize_todo_keys(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    canonicalize_key_map(obj, is_root_todo_key);
    if let Some(items) = obj
        .get_mut("actions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for item in items {
            if let Some(item) = item.as_object_mut() {
                canonicalize_key_map(item, |key| TODO_ACTION_FIELD_KEYS.contains(&key));
            }
        }
    }
    if let Some(items) = obj
        .get_mut("todos")
        .and_then(serde_json::Value::as_array_mut)
    {
        for item in items {
            if let Some(item) = item.as_object_mut() {
                canonicalize_key_map(item, |key| key == "content" || key == "status");
            }
        }
    }
}

fn canonicalize_key_map<F>(obj: &mut serde_json::Map<String, serde_json::Value>, is_known: F)
where
    F: Fn(&str) -> bool,
{
    let repairs: Vec<(String, String)> = obj
        .keys()
        .filter_map(|original| {
            let trimmed = original
                .trim_matches(|c: char| c == '"' || c == '\\' || c.is_whitespace())
                .to_string();
            if trimmed.is_empty() || trimmed == *original {
                return None;
            }
            // Case-insensitive exact match is still deterministic; fuzzy
            // edit-distance repair is deliberately NOT done here — the error
            // path suggests it instead (`suggest_action_key`).
            let canonical = if is_known(&trimmed) {
                trimmed
            } else {
                let lower = trimmed.to_ascii_lowercase();
                TODO_ACTION_FIELD_KEYS
                    .iter()
                    .find(|known| known.eq_ignore_ascii_case(&lower))
                    .map(|known| (*known).to_string())?
            };
            is_known(&canonical).then_some((original.clone(), canonical))
        })
        .collect();
    for (original, canonical) in repairs {
        // A correctly-spelled field wins over a damaged duplicate.
        if obj.contains_key(&canonical) {
            obj.remove(&original);
        } else if let Some(value) = obj.remove(&original) {
            obj.insert(canonical, value);
        }
    }
}

fn unknown_action_keys(v: &serde_json::Value) -> Vec<&str> {
    v.as_object()
        .map(|obj| {
            obj.keys()
                .filter(|key| !TODO_ACTION_FIELD_KEYS.contains(&key.as_str()))
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default()
}

/// A bare `{id}` is a delete ONLY when nothing else is present. An unknown
/// field means the payload is malformed (usually a misspelled `status`), and
/// guessing `delete` there would silently destroy a task.
fn has_only_known_action_keys(v: &serde_json::Value) -> bool {
    v.as_object().is_some_and(|obj| {
        obj.keys()
            .all(|key| TODO_ACTION_FIELD_KEYS.contains(&key.as_str()))
    })
}

/// Nearest known field for a typo, used ONLY in the error text — never to
/// rewrite the payload. Bounded to Levenshtein distance ≤ 2 over keys of at
/// least four chars so short/ambiguous names (`id`) never get a guess.
fn suggest_action_key(key: &str) -> Option<&'static str> {
    let key = key
        .trim_matches(|c: char| c == '"' || c == '\\' || c.is_whitespace())
        .to_ascii_lowercase();
    if key.chars().count() < 4 {
        return None;
    }
    TODO_ACTION_FIELD_KEYS
        .iter()
        .copied()
        .filter(|known| known.chars().count() >= 4)
        .map(|known| (edit_distance(&key, known), known))
        .filter(|(distance, _)| *distance <= 2)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, known)| known)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = prev[j] + usize::from(ca != cb);
            cur[j + 1] = substitution.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn find_todo_index(list: &[TodoItem], content: &str) -> Option<usize> {
    list.iter().position(|item| item.content == content)
}

fn ensure_single_in_progress(list: &mut [TodoItem], idx: usize) {
    for (i, item) in list.iter_mut().enumerate() {
        if i != idx && item.status == TodoStatus::InProgress {
            item.status = TodoStatus::Pending;
        }
    }
}

fn unknown_task_id(id: u64, list: &[TodoItem]) -> String {
    let n = list.len();
    let mut msg = format!(
        "todowrite: unknown task id {id} (list has {n} item{}).",
        if n == 1 { "" } else { "s" }
    );
    if n > 0 && list.iter().all(|item| item.status == TodoStatus::Completed) {
        msg.push_str(" Every task is completed, so the next new task starts a NEW plan at id 1.");
    }
    msg
}

/// Insert / move destination as a 0-based index. `position` is 1-based rank.
fn destination_index(position: Option<usize>, len: usize) -> usize {
    match position {
        Some(p) if p <= 1 => 0,
        Some(p) if p - 1 <= len => p - 1,
        _ => len,
    }
}

/// Upsert by normalized title. Same `content` never appears twice.
/// `position` = 1-based destination rank (`insert` / re-rank). `None` keeps
/// the existing slot or appends a new item.
fn upsert_todo(
    list: &mut Vec<TodoItem>,
    content: String,
    status: Option<TodoStatus>,
    position: Option<usize>,
) -> usize {
    if let Some(old_idx) = find_todo_index(list, &content) {
        if position.is_none() {
            if let Some(next_status) = status {
                list[old_idx].status = next_status;
                if next_status == TodoStatus::InProgress {
                    ensure_single_in_progress(list, old_idx);
                }
            }
            return old_idx + 1;
        }
        let mut item = list.remove(old_idx);
        if let Some(next_status) = status {
            item.status = next_status;
        }
        let idx = destination_index(position, list.len());
        list.insert(idx, item);
        if list[idx].status == TodoStatus::InProgress {
            ensure_single_in_progress(list, idx);
        }
        return idx + 1;
    }
    let status = status.unwrap_or(TodoStatus::Pending);
    let idx = destination_index(position, list.len());
    list.insert(idx, TodoItem { content, status });
    if status == TodoStatus::InProgress {
        ensure_single_in_progress(list, idx);
    }
    idx + 1
}

/// Map an `update` id onto the list after this batch's adds.
///
/// Models use two numberings:
/// - post-add 1-based ids (`1..=new_len`)
/// - append-style ids (`visible_len+1`, `visible_len+2`…) as if each `add`
///   always appended, including when a closed plan was auto-cleared.
fn resolve_update_id(
    id: u64,
    visible_len: usize,
    add_landings: &[usize],
    new_len: usize,
) -> Option<usize> {
    let id = id as usize;
    if id == 0 {
        return None;
    }
    if !add_landings.is_empty() && id > visible_len {
        let k = id - visible_len;
        if k >= 1 && k <= add_landings.len() {
            return Some(add_landings[k - 1]);
        }
    }
    (id <= new_len).then_some(id)
}

/// Batch apply. Execution order is fixed and must not be reordered:
/// `clear` → `delete` (exclusive) → auto-clear closed plan → `add` → `insert` → `update`.
fn apply_actions_batch(
    list: &[TodoItem],
    arr: &[serde_json::Value],
) -> Result<Vec<TodoItem>, String> {
    validate_actions_mix(arr)?;
    let mut tmp = list.to_vec();
    let kinds: std::collections::BTreeSet<&str> = arr.iter().filter_map(action_kind).collect();

    if kinds.contains("clear") {
        tmp.clear();
    }

    if kinds.contains("delete") {
        let mut delete_ids: Vec<usize> = Vec::new();
        for item in arr {
            let id = json_id(item).ok_or_else(|| {
                "todowrite: `delete` needs a valid `id` (1-based task number). Example: {\"action\": \"delete\", \"id\": 1}.".to_string()
            })?;
            if id == 0 || (id as usize) > tmp.len() {
                return Err(unknown_task_id(id, &tmp));
            }
            let id = id as usize;
            if !delete_ids.contains(&id) {
                delete_ids.push(id);
            }
        }
        delete_ids.sort_unstable_by(|a, b| b.cmp(a));
        for id in delete_ids {
            tmp.remove(id - 1);
        }
        return Ok(tmp);
    }

    // Length the model last saw: after explicit `clear`, else the incoming list.
    let visible_len = tmp.len();

    let mut add_landings = Vec::new();
    let has_add = arr.iter().any(|item| action_kind(item) == Some("add"));
    // `{id, content, status}` is inferred as update, so a new-plan payload on an
    // empty list would otherwise die with "unknown task id 1 (list has 0 items)".
    let seed_updates = if list_is_seedable(&tmp) && !has_add {
        let mut v: Vec<&serde_json::Value> = arr
            .iter()
            .filter(|item| action_kind(item) == Some("update") && item_has_content(item))
            .collect();
        v.sort_by_key(|item| json_id(item).unwrap_or(u64::MAX));
        v
    } else {
        Vec::new()
    };

    if has_add || !seed_updates.is_empty() {
        // 关键修复：中间状态打完所有勾时，todolist 必须完整保留；
        // 若后续追加新任务（add），严格在既有清单末尾平滑追加，绝不断链清空！
        // 只有显式 action="clear" 才会清空清单。
        if has_add {
            for item in arr {
                if action_kind(item) == Some("add") {
                    add_landings.push(apply_add(&mut tmp, item)?);
                }
            }
        }
        for item in &seed_updates {
            add_landings.push(apply_add(&mut tmp, item)?);
        }
    }

    // 2. Inserts next (id-shifting / re-rank)
    let mut inserts: Vec<&serde_json::Value> = arr
        .iter()
        .filter(|a| action_kind(a) == Some("insert"))
        .collect();
    inserts.sort_by(|a, b| {
        let pa = insert_position(a).unwrap_or(usize::MAX);
        let pb = insert_position(b).unwrap_or(usize::MAX);
        pb.cmp(&pa)
    });
    for item in inserts {
        apply_insert(&mut tmp, item)?;
    }

    // 3. Updates last, against the list after add/insert.
    for item in arr {
        if action_kind(item) == Some("update") {
            if seed_updates.iter().any(|s| std::ptr::eq(*s, item)) {
                continue;
            }
            apply_update(&mut tmp, item, visible_len, &add_landings)?;
        }
    }

    Ok(tmp)
}

fn json_u64(x: &serde_json::Value) -> Option<u64> {
    x.as_u64()
        .or_else(|| x.as_i64().and_then(|i| u64::try_from(i).ok()))
        .or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))
}

fn json_id(v: &serde_json::Value) -> Option<u64> {
    v.get("id").and_then(json_u64)
}

fn item_has_content(v: &serde_json::Value) -> bool {
    v.get("content")
        .and_then(|c| c.as_str())
        .map(normalize_todo_content)
        .is_some_and(|c| !c.is_empty())
}

fn list_is_seedable(list: &[TodoItem]) -> bool {
    list.is_empty() || list.iter().all(|t| t.status == TodoStatus::Completed)
}

fn insert_position(v: &serde_json::Value) -> Option<usize> {
    v.get("position")
        .or_else(|| v.get("id"))
        .and_then(json_u64)
        .map(|p| p as usize)
        .or_else(|| {
            v.get("after")
                .or_else(|| v.get("after_id"))
                .and_then(json_u64)
                .map(|p| (p + 1) as usize)
        })
}

fn action_status(v: &serde_json::Value) -> Option<TodoStatus> {
    v.get("status")
        .and_then(|s| s.as_str())
        .and_then(TodoStatus::parse)
}

fn apply_add(list: &mut Vec<TodoItem>, v: &serde_json::Value) -> Result<usize, String> {
    let content = v
        .get("content")
        .and_then(|c| c.as_str())
        .map(normalize_todo_content)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "todowrite: adding a task needs non-empty `content`. Example: {\"content\": \"Implement feature X\"}.".to_string())?;
    Ok(upsert_todo(list, content, action_status(v), None))
}

fn apply_insert(list: &mut Vec<TodoItem>, v: &serde_json::Value) -> Result<usize, String> {
    let content = v
        .get("content")
        .and_then(|c| c.as_str())
        .map(normalize_todo_content)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "todowrite: inserting needs non-empty `content`. Example: {\"content\": \"Task description\", \"position\": 1}.".to_string())?;
    Ok(upsert_todo(
        list,
        content,
        action_status(v),
        insert_position(v),
    ))
}

fn apply_update(
    list: &mut Vec<TodoItem>,
    v: &serde_json::Value,
    visible_len: usize,
    add_landings: &[usize],
) -> Result<(), String> {
    let id = json_id(v).ok_or_else(|| "todowrite: updating needs a valid `id` (1-based task number). Example: {\"id\": 1, \"status\": \"in_progress\"}.".to_string())?;
    let Some(resolved) = resolve_update_id(id, visible_len, add_landings, list.len()) else {
        // Empty/closed list, or the next append slot: a content-bearing "update"
        // is a seed/add, not a missing-id error.
        if item_has_content(v)
            && (list_is_seedable(list) || id == (list.len() as u64).saturating_add(1))
        {
            apply_add(list, v)?;
            return Ok(());
        }
        return Err(unknown_task_id(id, list));
    };
    let idx = resolved - 1;
    let status = action_status(v);
    let new_content = v
        .get("content")
        .and_then(|c| c.as_str())
        .map(normalize_todo_content)
        .filter(|c| !c.is_empty());
    if status.is_none() && new_content.is_none() {
        return Err(
            "todowrite: updating needs at least one of `status` (pending|in_progress|completed) or `content`. Example: {\"id\": 1, \"status\": \"in_progress\"}.".into(),
        );
    }
    if let Some(content) = new_content {
        if let Some(other) = find_todo_index(list, &content) {
            if other != idx {
                // Title must stay unique: fold this row into the existing title.
                if let Some(st) = status {
                    list[other].status = st;
                    if st == TodoStatus::InProgress {
                        ensure_single_in_progress(list, other);
                    }
                }
                list.remove(idx);
                return Ok(());
            }
        }
        list[idx].content = content;
    }
    if let Some(st) = status {
        list[idx].status = st;
        if st == TodoStatus::InProgress {
            ensure_single_in_progress(list, idx);
        }
    }
    Ok(())
}

/// Apply a single action object. `id` is the 1-based position **at this step**
/// (left-to-right in a batch). Returns Err on schema / unknown-id so a batch
/// can roll back.
fn try_apply_one_action(list: &mut Vec<TodoItem>, v: &serde_json::Value) -> Result<(), String> {
    match action_kind(v) {
        Some("add") => apply_add(list, v).map(|_| ()),
        Some("insert") => apply_insert(list, v).map(|_| ()),
        Some("update") => {
            if list_is_seedable(list) && item_has_content(v) {
                apply_add(list, v).map(|_| ())
            } else {
                apply_update(list, v, list.len(), &[])
            }
        }
        Some("delete") => {
            let id = json_id(v)
                .ok_or_else(|| "todowrite: `delete` needs a valid `id` (1-based task number). Example: {\"action\": \"delete\", \"id\": 1}.".to_string())?;
            if id == 0 || (id as usize) > list.len() {
                return Err(unknown_task_id(id, list));
            }
            list.remove((id as usize) - 1);
            Ok(())
        }
        Some("clear") => {
            list.clear();
            Ok(())
        }
        // Read-only: the derived list must fold a `list` call as a pure no-op.
        Some("list") => Ok(()),
        _ => Err(format!("todowrite: {}", unknown_or_uninferable_action(v))),
    }
}

pub fn is_batch_plan_establishment(args: &str) -> bool {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(args) else {
        return false;
    };
    canonicalize_todo_keys(&mut v);
    if let Some(arr) = v.get("actions").and_then(|a| a.as_array()) {
        let add_count = arr
            .iter()
            .filter(|item| action_kind(item) == Some("add"))
            .count();
        return add_count >= 2;
    }
    false
}

/// Whether a todo call's args are the FULL-LIST (re)plan shape (`{"todos":[…]}`) vs the
/// incremental `{"action":…}` / `{"actions":[…]}` shape. `todowrite` accepts both — distinguished
/// by shape, NOT by tool name. A payload that carries `actions` is NEVER a plan, even if a
/// leftover `todos` field also parses (execute/apply prefer `actions`; the fold must match).
pub fn is_todo_plan(args: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(args) else {
        return false;
    };
    if v.get("actions").and_then(|a| a.as_array()).is_some() {
        return false;
    }
    parse_todos(args).is_ok()
}

/// Incremental patch shape: a single `action` or a non-absent `actions` array.
/// False for full-list `todos` plans (use [`is_todo_plan`]).
pub fn is_todo_action_args(args: &str) -> bool {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(args) else {
        return false;
    };
    canonicalize_todo_keys(&mut v);
    if is_todo_plan(args) {
        return false;
    }
    action_kind(&v).is_some() || v.get("actions").and_then(|a| a.as_array()).is_some()
}

/// Fold an ORDERED stream of `(tool_name, args)` todo-affecting calls into the current list.
/// Baseline = the LAST call carrying a valid full LIST (`{"todos":[…]}`; positions become the
/// stable 1-based ids); then every incremental `{"action":…}` call AFTER that baseline is
/// applied in order. Decided by ARG SHAPE, not tool name, so the merged `todowrite` (which
/// sends the list shape to plan and the action shape to patch) folds correctly — and a resumed
/// session's legacy `todo`-named calls fold identically. An invalid list never wipes an earlier
/// valid one; action events before the baseline are void (a re-plan resets the ids). THE single
/// source of truth for the fold — both the kernel-message reducer and the TUI panel derivation
/// use this shape rule, so live / replay / injected views never diverge.
pub fn reduce_todos<'a>(calls: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<TodoItem> {
    // Keep both names so a resumed transcript (legacy `todo` + `todowrite`) folds the same.
    let calls: Vec<(&str, &str)> = calls
        .into_iter()
        .filter(|(n, _)| is_todo_tool_name(n))
        .collect();
    let baseline = calls.iter().rposition(|(_, a)| is_todo_plan(a));
    let (mut list, start) = match baseline {
        Some(i) => (parse_todos(calls[i].1).unwrap_or_default(), i + 1),
        None => (Vec::new(), 0),
    };
    for (_, a) in &calls[start..] {
        apply_todo_action(&mut list, a); // no-op unless the args carry an `action`
    }
    list
}

pub fn list_fully_completed(list: &[TodoItem]) -> bool {
    !list.is_empty() && list.iter().all(|item| item.status == TodoStatus::Completed)
}

fn is_real_user_message(message: &Message) -> bool {
    message.role == jeikcode_kernel::message::Role::User && !message.synthetic
}

fn closed_titles(closed: &[TodoItem]) -> std::collections::HashSet<String> {
    closed
        .iter()
        .map(|item| normalize_todo_content(&item.content))
        .filter(|title| !title.is_empty())
        .collect()
}

/// Every row is a title from the checklist that was already fully completed and closed.
fn replay_of_closed(list: &[TodoItem], closed: &[TodoItem]) -> bool {
    if closed.is_empty() || list.is_empty() {
        return false;
    }
    let titles = closed_titles(closed);
    list.iter()
        .all(|item| titles.contains(&normalize_todo_content(&item.content)))
}

fn args_have_explicit_add(args: &str) -> bool {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(args) else {
        return false;
    };
    canonicalize_todo_keys(&mut value);
    if action_kind(&value) == Some("add") {
        return true;
    }
    value
        .get("actions")
        .and_then(|actions| actions.as_array())
        .is_some_and(|actions| actions.iter().any(|item| action_kind(item) == Some("add")))
}

/// Fold one user turn onto the list carried from earlier turns.
/// A full `todos` plan replaces the carried list. Plain actions apply on top of an
/// unfinished list. After a completed list was closed, only a new plan or an explicit
/// `add` of a new title may start another list. Updates that merely restate the closed
/// rows are not a live checklist.
fn fold_turn_calls(
    carried: &mut Vec<TodoItem>,
    batch: &mut Vec<(&str, &str)>,
    closed: &mut Vec<TodoItem>,
) {
    if batch.is_empty() {
        return;
    }
    let has_plan = batch.iter().any(|(_, args)| is_todo_plan(args));
    if !closed.is_empty() && carried.is_empty() {
        let next = if has_plan {
            reduce_todos(batch.iter().copied())
        } else {
            let mut fresh = Vec::new();
            for (_, args) in batch.iter().copied() {
                if args_have_explicit_add(args) {
                    apply_todo_action(&mut fresh, args);
                }
            }
            fresh
        };
        if !replay_of_closed(&next, closed) {
            *carried = next;
            if !carried.is_empty() {
                closed.clear();
            }
        }
        batch.clear();
        return;
    }
    if has_plan || carried.is_empty() {
        *carried = reduce_todos(batch.iter().copied());
    } else {
        for (_, args) in batch.iter() {
            apply_todo_action(carried, args);
        }
    }
    batch.clear();
}

/// The live todo list (see [`reduce_todos`]).
///
/// Rounds inside one real user turn share one list, including a fully checked list:
/// a later `add` in that same turn appends. A fully checked list is dropped only when
/// the next real user message starts, after that turn's calls are already in the
/// transcript for the history canvas. A list that still has open items is carried
/// into the next turn.
pub fn derive_current_todos(messages: &[Message]) -> Vec<TodoItem> {
    let mut carried = Vec::new();
    let mut closed = Vec::new();
    let mut batch = Vec::new();
    for message in messages {
        if is_real_user_message(message) {
            fold_turn_calls(&mut carried, &mut batch, &mut closed);
            if list_fully_completed(&carried) {
                closed = std::mem::take(&mut carried);
            }
            continue;
        }
        for call in &message.tool_calls {
            if is_todo_tool_name(&call.name) {
                batch.push((call.name.as_str(), call.arguments.as_str()));
            }
        }
    }
    fold_turn_calls(&mut carried, &mut batch, &mut closed);
    carried
}

/// Live panel exposed by the session API.
///
/// A finished checklist stays visible only while the turn that wrote it is still
/// running. A later user message starts a new turn; that turn does not inherit the
/// previous completed plan just because the session is busy again.
pub fn session_sticky_todos(messages: &[Message], turn_running: bool) -> Vec<TodoItem> {
    let todos = derive_current_todos(messages);
    if todos.is_empty() {
        return Vec::new();
    }
    if !todos
        .iter()
        .all(|item| item.status == TodoStatus::Completed)
    {
        return todos;
    }
    if turn_running && current_turn_wrote_todos(messages) {
        return todos;
    }
    Vec::new()
}

/// Todo calls after the latest real user message belong to the running turn.
/// Synthetic continuation nudges stay inside that same turn.
fn current_turn_wrote_todos(messages: &[Message]) -> bool {
    let start = messages
        .iter()
        .rposition(|message| {
            message.role == jeikcode_kernel::message::Role::User && !message.synthetic
        })
        .map(|index| index + 1)
        .unwrap_or(0);
    messages[start..].iter().any(|message| {
        message
            .tool_calls
            .iter()
            .any(|call| is_todo_tool_name(&call.name))
    })
}

/// Live list handle shared with the coding `TodoHook`.
/// The session [`TodoBoard`] is the stored checklist. This vec is the copy the
/// tool mutates while a turn is running.
pub type TodoLive = Arc<Mutex<Vec<TodoItem>>>;

/// One checklist bound to one session. `id` is the part id, `seq` is its cursor.
/// It is not part of the model payload.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TodoBoard {
    pub id: String,
    pub seq: u64,
    /// Persisted monotonic version of this session's checklist. Every commit,
    /// rebind, close and clear advances it, so clients can arbitrate snapshots
    /// by revision instead of comparing arrival order.
    #[serde(default)]
    pub revision: u64,
    pub items: Vec<TodoItem>,
}

struct TodoSlot {
    board: Option<TodoBoard>,
    /// Set when a completed board was closed after stop. Blocks reloading that file.
    closed: bool,
    /// Survives `clear`, so a reopened board never reuses an older revision.
    revision: u64,
}

fn todo_registry() -> &'static std::sync::RwLock<std::collections::HashMap<String, TodoSlot>> {
    static REGISTRY: std::sync::OnceLock<
        std::sync::RwLock<std::collections::HashMap<String, TodoSlot>>,
    > = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::RwLock::new(std::collections::HashMap::new()))
}

/// A live handle's session binding.
///
/// The owner is a weak reference to the very allocation the key points at. That
/// weak reference pins the allocation, so the address can never be recycled onto
/// a different live handle while a binding exists — a bare address would alias
/// a freed handle onto a fresh one and hand it the previous session's checklist.
struct LiveBinding {
    owner: Weak<Mutex<Vec<TodoItem>>>,
    session_id: String,
}

fn live_bindings() -> &'static Mutex<std::collections::HashMap<usize, LiveBinding>> {
    static BINDINGS: std::sync::OnceLock<Mutex<std::collections::HashMap<usize, LiveBinding>>> =
        std::sync::OnceLock::new();
    BINDINGS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn live_key(live: &TodoLive) -> usize {
    Arc::as_ptr(live) as usize
}

/// Remember which session this tool instance is serving.
pub fn bind_todo_session(live: &TodoLive, session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    live_bindings()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(
            live_key(live),
            LiveBinding {
                owner: Arc::downgrade(live),
                session_id: session_id.to_string(),
            },
        );
}

pub fn todo_session_of(live: &TodoLive) -> Option<String> {
    let mut guard = live_bindings()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let key = live_key(live);
    match guard.get(&key) {
        Some(binding) if binding.owner.strong_count() > 0 => Some(binding.session_id.clone()),
        Some(_) => {
            // The owner died without unbinding (a panicking caller). The binding no
            // longer describes a live checklist, so it must not be handed out.
            guard.remove(&key);
            None
        }
        None => None,
    }
}

/// Remove the session binding for this tool instance.
pub fn unbind_todo_session(live: &TodoLive) {
    live_bindings()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&live_key(live));
}

/// The one live checklist for `session_id`. Readers take the read lock and
/// therefore observe a finished write.
pub fn read_todo_board(session_id: &str) -> Option<TodoBoard> {
    let guard = todo_registry()
        .read()
        .unwrap_or_else(|err| err.into_inner());
    guard.get(session_id).and_then(|slot| slot.board.clone())
}

pub fn todo_session_is_closed(session_id: &str) -> bool {
    let guard = todo_registry()
        .read()
        .unwrap_or_else(|err| err.into_inner());
    guard.get(session_id).is_some_and(|slot| slot.closed)
}

/// Install a board loaded from disk, unless this process already has a newer slot.
pub fn restore_todo_board(session_id: &str, board: TodoBoard) {
    if session_id.is_empty() || board.items.is_empty() || list_fully_completed(&board.items) {
        return;
    }
    let mut guard = todo_registry()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    if guard.contains_key(session_id) {
        return;
    }
    guard.insert(
        session_id.to_string(),
        TodoSlot {
            revision: board.revision,
            board: Some(board),
            closed: false,
        },
    );
}

/// Replace the session's single checklist. The same part id stays until it is closed.
pub fn commit_todo_board(session_id: &str, items: &[TodoItem]) -> TodoBoard {
    let mut guard = todo_registry()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    let slot = guard.entry(session_id.to_string()).or_insert(TodoSlot {
        board: None,
        closed: false,
        revision: 0,
    });
    slot.closed = false;
    slot.revision = slot.revision.saturating_add(1);
    let revision = slot.revision;
    let board = match slot.board.take() {
        Some(mut existing) => {
            existing.seq = existing.seq.saturating_add(1);
            existing.revision = revision;
            existing.items = items.to_vec();
            existing
        }
        None => TodoBoard {
            id: format!(
                "todo-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(1)
            ),
            seq: 1,
            revision,
            items: items.to_vec(),
        },
    };
    slot.board = Some(board.clone());
    board
}

/// 撤销/回溯后的清单重建：**保留板身份**（id 不变、seq 单调递增），
/// 只把 items 换成“剩余转录”的推导结果。
///
/// 与 `clear_todo_board` + `commit_todo_board` 的差别：
/// - `clear` 会把槽的 board 置空，重建后 id 漂移、seq 归 1；任何把 `(board_id, seq)`
///   当版本号的消费者（现在没有，但很容易出现）会把重建结果误判成“更旧/另起一板”；
/// - 这里 id 与 seq 都单调向前，撤销永远不会被看成回退。
///
/// - 推导为空（整轮被删干净）→ 板随之关闭（`closed = true`，磁盘 `.todo` 由
///   `persist_todo_board` 删除），下次真开新计划才是全新身份；
/// - 槽不存在（新进程尚未装载该会话）→ 返回 `None`，调用方退回 clear/commit。
pub fn rebind_todo_board(session_id: &str, items: &[TodoItem]) -> Option<TodoBoard> {
    if session_id.is_empty() {
        return None;
    }
    let mut guard = todo_registry()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    let slot = guard.get_mut(session_id)?;
    if items.is_empty() {
        // 整轮被删干净：板随之关闭（禁止旧槽/磁盘快照复活），身份到此结束。
        slot.board = None;
        slot.closed = true;
        slot.revision = slot.revision.saturating_add(1);
        return None;
    }
    slot.closed = false;
    slot.revision = slot.revision.saturating_add(1);
    let revision = slot.revision;
    let board = match slot.board.take() {
        Some(mut existing) => {
            existing.seq = existing.seq.saturating_add(1);
            existing.revision = revision;
            existing.items = items.to_vec();
            existing
        }
        None => TodoBoard {
            id: format!(
                "todo-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(1)
            ),
            seq: 1,
            revision,
            items: items.to_vec(),
        },
    };
    slot.board = Some(board.clone());
    Some(board)
}

/// Explicit wipe (`/todo clear`). Readers afterwards see no live checklist.
pub fn clear_todo_board(session_id: &str) {
    let mut guard = todo_registry()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    let revision = guard
        .get(session_id)
        .map(|slot| slot.revision)
        .unwrap_or(0)
        .saturating_add(1);
    guard.insert(
        session_id.to_string(),
        TodoSlot {
            board: None,
            closed: true,
            revision,
        },
    );
}

/// Fully purge the session slot and any associated live bindings when a session is deleted.
pub fn purge_todo_board(session_id: &str) {
    let mut guard = todo_registry()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    guard.remove(session_id);
    drop(guard);

    let mut bindings = live_bindings()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    bindings.retain(|_, b| b.session_id != session_id && b.owner.strong_count() > 0);
}

/// After streaming has stopped, drop the live board only when every item is checked.
/// Returns the closed board so the caller can keep it as history. Open items stay.
pub fn close_todo_board_if_complete(session_id: &str) -> Option<TodoBoard> {
    let mut guard = todo_registry()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    let Some(slot) = guard.get_mut(session_id) else {
        return None;
    };
    let Some(board) = slot.board.as_ref() else {
        return None;
    };
    if !list_fully_completed(&board.items) {
        return None;
    }
    let closed = slot.board.take()?;
    slot.closed = true;
    Some(closed)
}

/// Register (or replace) `todowrite` and return the live list for [`TodoHook`].
pub fn bind_todowrite(reg: &mut ToolRegistry) -> TodoLive {
    let tool = TodoTool::new();
    let live = tool.live();
    reg.register(Arc::new(tool));
    live
}

/// `todowrite` tool. Execute applies against the live snapshot (empty until the
/// hook syncs, or until earlier `execute`s on this instance). Transcript fold
/// via [`reduce_todos`] remains authoritative.
#[derive(Clone)]
pub struct TodoTool {
    live: TodoLive,
}

impl Drop for TodoTool {
    fn drop(&mut self) {
        unbind_todo_session(&self.live);
    }
}

impl Default for TodoTool {
    fn default() -> Self {
        Self::new()
    }
}

impl TodoTool {
    pub fn new() -> Self {
        Self {
            live: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn with_live(live: TodoLive) -> Self {
        Self { live }
    }

    pub fn live(&self) -> TodoLive {
        Arc::clone(&self.live)
    }

    /// 当前会话清单。已绑定会话时只读实例；读锁在写锁放开后才能拿到提交后的状态。
    fn board_items(&self) -> Vec<TodoItem> {
        if let Some(session_id) = todo_session_of(&self.live) {
            if let Some(board) = read_todo_board(&session_id) {
                return board.items;
            }
        }
        self.lock_live().clone()
    }

    /// 写入唯一清单，再读回提交后的条目，供工具输出使用。
    fn commit_and_read(&self, items: &[TodoItem]) -> Vec<TodoItem> {
        if let Some(session_id) = todo_session_of(&self.live) {
            let board = commit_todo_board(&session_id, items);
            *self.lock_live() = board.items.clone();
            return board.items;
        }
        *self.lock_live() = items.to_vec();
        items.to_vec()
    }

    fn lock_live(&self) -> std::sync::MutexGuard<'_, Vec<TodoItem>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }
}

const TODOWRITE_DESCRIPTION: &str = "Create or maintain a multi-step checklist for a task. \
Checklists are automatically cleared once all items are completed. \
Use to plan tasks, track progress, and improve delivery quality.";

/// Absorb stringified / single-object / hybrid `actions` payloads. Idempotent.
pub(crate) fn normalize_todo_write_args(args: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(args) else {
        return args.to_string();
    };
    crate::tools::repair::decode_lenient_array_field(&mut v, "actions", false);
    crate::tools::repair::decode_lenient_array_field(&mut v, "todos", false);
    canonicalize_todo_keys(&mut v);

    let usable_actions = v
        .get("actions")
        .and_then(|a| a.as_array())
        .is_some_and(|a| !a.is_empty() && a.iter().any(|item| action_kind(item).is_some()));
    // A non-array `actions` (truncated stringified field) yields to sibling
    // fields, matching the hybrid repair contract. A real array that failed
    // inference is NOT replaced: keeping it makes the error actionable.
    if !usable_actions
        && v.get("todos").is_none()
        && v.get("actions")
            .and_then(serde_json::Value::as_array)
            .is_none()
        && looks_like_single_action(&v)
    {
        let action = {
            let mut action = serde_json::Map::new();
            if let Some(obj) = v.as_object() {
                for key in TODO_ACTION_FIELD_KEYS {
                    if let Some(val) = obj.get(*key) {
                        if !val.is_array() && !val.is_object() {
                            action.insert((*key).to_string(), val.clone());
                        }
                    }
                }
            }
            action
        };
        if !action.is_empty() {
            if let Some(root) = v.as_object_mut() {
                root.insert(
                    "actions".into(),
                    serde_json::Value::Array(vec![serde_json::Value::Object(action)]),
                );
            }
        }
    }
    v.to_string()
}

fn collect_todo_actions(args: &str) -> Option<Vec<serde_json::Value>> {
    let normalized = normalize_todo_write_args(args);
    let v: serde_json::Value = serde_json::from_str(&normalized).ok()?;
    if v.get("todos").is_some() && v.get("actions").and_then(|a| a.as_array()).is_none() {
        return None;
    }
    if let Some(arr) = v.get("actions").and_then(|a| a.as_array()) {
        if arr.is_empty() || arr.iter().any(|item| action_kind(item).is_none()) {
            return None;
        }
        return Some(arr.clone());
    }
    if action_kind(&v).is_some() {
        return Some(vec![v]);
    }
    None
}

/// Concatenate same-batch `todo_write` payloads into one `actions` array so
/// mix validation / clear-first / id remap run. Illegal mixes stay independent
/// (sequential live-list updates handle id shifts that a merged batch would reject).
pub(crate) fn merge_todo_write_args(args_list: &[&str]) -> Option<String> {
    if args_list.len() < 2 {
        return None;
    }
    let mut actions = Vec::new();
    for args in args_list {
        let got = collect_todo_actions(args)?;
        actions.extend(got);
    }
    if actions.len() < 2 {
        return None;
    }
    validate_actions_mix(&actions).ok()?;
    Some(serde_json::json!({ "actions": actions }).to_string())
}

#[async_trait]
impl Tool for TodoTool {
    fn name(&self) -> &str {
        TODO_TOOL_NAME
    }
    fn aliases(&self) -> &'static [&'static str] {
        TODO_TOOL_ALIASES
    }
    fn description(&self) -> &str {
        TODOWRITE_DESCRIPTION
    }
    fn parallel_safe(&self, _args: &str) -> bool {
        // Writes the live list; same-batch todowrite calls must see each other.
        false
    }
    fn coalesce_group_key(&self, args: &str) -> Option<String> {
        let v = serde_json::from_str::<serde_json::Value>(args).ok()?;
        if v.get("todos").is_some() && v.get("actions").and_then(|a| a.as_array()).is_none() {
            return None;
        }
        Some(TODO_TOOL_NAME.to_string())
    }
    fn merge_coalesced_args(&self, args_list: &[&str]) -> Option<String> {
        merge_todo_write_args(args_list)
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "minItems": 1,
                    "description": "Batch of task changes, applied in order.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["delete", "clear"],
                                "description": "For destructive ops only: `clear` wipes the list (runs first); `delete` needs `id`."
                            },
                            "id": {
                                "type": "integer",
                                "minimum": 1,
                                "description": "1-based task number. With `status` or `content` → update; alone → delete."
                            },
                            "position": {
                                "type": "integer",
                                "minimum": 1,
                                "description": "1-based insert slot for `content`; omitted → append."
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "New status. At most one item stays in_progress; demoting the others is automatic."
                            },
                            "content": {
                                "type": "string",
                                "description": "Task text. Alone → add; with `position` → insert; with `id` → retitle that task."
                            }
                        },
                        "required": []
                    }
                }
            },
            "required": ["actions"]
        })
    }
    // Never touches the filesystem → risk() defaults to Safe.
    fn always_grant_scope(&self, _args: &str) -> String {
        // Tool-wide: planning is harmless; one grant covers all calls this session.
        String::new()
    }
    async fn execute(&self, args: &str, _ctx: &ToolContext) -> ToolResult {
        let args = normalize_todo_write_args(args);
        let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&args) else {
            return err(with_current_list_for_args(
                "todowrite: invalid JSON arguments.",
                &self.board_items(),
            ));
        };
        let mut list = self.board_items();

        // Legacy full-list replace (resume / old transcripts). Prefer `actions`.
        // `actions` wins if both fields are present (same as the fold).
        if v.get("actions").and_then(|a| a.as_array()).is_none() && v.get("todos").is_some() {
            return match parse_todos(&args) {
                Ok(todos) => {
                    let stored = self.commit_and_read(&todos);
                    ok(render_todos_numbered(&stored, false))
                }
                Err(e) => err(with_current_list_for_args(e, &self.board_items())),
            };
        }

        if v.get("actions").is_none() && v.get("todos").is_none() && action_kind(&v).is_some() {
            let single = v.clone();
            v = json!({ "actions": [single] });
        }

        // Read-only `list`: echo the CURRENT list and touch nothing. The name predates the
        // `actions` contract and is kept as a first-class read (old transcripts and models still
        // ask for it), so it answers with the numbered list instead of the mutation summary.
        if matches!(
            v.get("actions").and_then(|a| a.as_array()).map(Vec::as_slice),
            Some([only]) if action_kind(only) == Some("list")
        ) {
            let items = self.board_items();
            if list_fully_completed(&items) {
                if let Some(session_id) = todo_session_of(&self.live) {
                    let _ = close_todo_board_if_complete(&session_id);
                }
                *self.lock_live() = Vec::new();
                return ok("Current task list:\n\n(no tasks)".to_string());
            }
            return ok(format!(
                "Current task list:\n\n{}",
                render_todos_numbered(&items, false)
            ));
        }

        if v.get("actions").and_then(|a| a.as_array()).is_none() {
            return err(with_current_list_for_args(
                "todowrite: provide a non-empty `actions` array of task action objects.",
                &self.board_items(),
            ));
        }

        let summary = match todo_change_summary(&v) {
            Ok(s) => s,
            Err(e) => return err(with_current_list_for_args(e, &self.board_items())),
        };

        match try_apply_todo_args(&mut list, &args) {
            Ok(ApplyOutcome::Unchanged) => {
                let stored = self.board_items();
                ok(format!(
                    "No change — already in that state. Do not retry.\n\n{}",
                    render_todos_numbered(&stored, false)
                ))
            }
            Ok(ApplyOutcome::Changed) => {
                let stored = self.commit_and_read(&list);
                ok(format!(
                    "{summary}\n\n{}",
                    render_todos_numbered(&stored, false)
                ))
            }
            Err(e) => err(with_current_list(e, &self.board_items())),
        }
    }
}

fn with_current_list(msg: impl std::fmt::Display, list: &[TodoItem]) -> String {
    format!(
        "{msg}\n\nCurrent list (unchanged):\n{}\nUse these 1-based ids. Do not retry a failed id.",
        render_todos_numbered(list, false)
    )
}

/// Schema/shape failure: the call never named a valid action, so "do not retry
/// a failed id" is misleading and can make the model give up instead of fixing
/// the fields. The list stays visible so ids can still be derived correctly.
fn with_current_list_for_args(msg: impl std::fmt::Display, list: &[TodoItem]) -> String {
    format!(
        "{msg}\n\nCurrent list (unchanged):\n{}\nNo changes were applied. Correct the arguments and re-send the call.",
        render_todos_numbered(list, false)
    )
}

fn todo_change_summary(v: &serde_json::Value) -> Result<String, String> {
    if let Some(arr) = v.get("actions").and_then(|a| a.as_array()) {
        if arr.is_empty() {
            return Err("todowrite: `actions` must be a non-empty array.".into());
        }
        validate_actions_mix(arr)?;
        let mut lines = Vec::with_capacity(arr.len());
        for (i, item) in arr.iter().enumerate() {
            match summarize_todo_action(item) {
                Ok(line) => lines.push(line),
                Err(e) => {
                    return Err(format!(
                        "todowrite: actions[{i}] rejected; the list was NOT changed. {e}"
                    ));
                }
            }
        }
        return Ok(lines.join("\n"));
    }
    summarize_todo_action(v).map_err(|e| format!("todowrite: {e}"))
}

fn summarize_todo_action(v: &serde_json::Value) -> Result<String, String> {
    match action_kind(v) {
        Some("add") => match v.get("content").and_then(|c| c.as_str()) {
            Some(c) if !c.trim().is_empty() => Ok(format!("Added task: {}", c.trim())),
            _ => Err("adding a task needs non-empty `content`. Example: {\"content\": \"Implement feature X\"}".into()),
        },
        Some("insert") => {
            let content = v
                .get("content")
                .and_then(|c| c.as_str())
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "inserting needs non-empty `content`. Example: {\"content\": \"New task\", \"position\": 1}".to_string())?;
            let pos = insert_position(v).unwrap_or(1).max(1);
            Ok(format!("#{pos} \u{2192} inserted: {content}"))
        }
        Some("update") => {
            let id = json_id(v);
            let raw_status = v.get("status").and_then(|x| x.as_str());
            let parsed_status = raw_status.and_then(TodoStatus::parse);
            let has_content = v
                .get("content")
                .and_then(|c| c.as_str())
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .is_some();

            if id.is_none() {
                return Err("updating needs a valid `id` (1-based task number). Example: {\"id\": 1, \"status\": \"in_progress\"}".into());
            }
            let task_id = id.unwrap();
            if raw_status.is_some() && parsed_status.is_none() {
                return Err(format!(
                    "`update` has invalid `status`: `{}`. Must be `pending`, `in_progress`, or `completed`. Example: {{\"id\": {}, \"status\": \"in_progress\"}}",
                    raw_status.unwrap(),
                    task_id
                ));
            }
            if parsed_status.is_none() && !has_content {
                return Err(format!(
                    "updating needs at least one of `status` ('pending'|'in_progress'|'completed') or `content` (non-empty text). Example: {{\"id\": {}, \"status\": \"in_progress\"}}",
                    task_id
                ));
            }
            match (parsed_status, has_content) {
                (Some(st), true) => Ok(format!("#{task_id} \u{2192} {st} (content updated)")),
                (Some(st), false) => Ok(format!("#{task_id} \u{2192} {st}")),
                (None, true) => Ok(format!("#{task_id} \u{2192} content updated")),
                (None, false) => unreachable!(),
            }
        }
        Some("delete") => match json_id(v) {
            Some(id) if id >= 1 => Ok(format!("#{id} \u{2192} removed")),
            _ => Err("`delete` needs a valid `id` (1-based task number). Example: {\"action\": \"delete\", \"id\": 1}".into()),
        },
        Some("clear") => Ok("all tasks cleared".to_string()),
        // Reachable only through a direct call: `execute` short-circuits a lone `list` before
        // the summary runs and batching is rejected above. Kept total so a read-only kind can
        // never surface as "unknown action".
        Some("list") => Ok("listed the current tasks".to_string()),
        _ => Err(unknown_or_uninferable_action(v)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::message::Message;
    use jeikcode_kernel::tool::ToolCall;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            working_dir: std::path::PathBuf::from("."),
            cancel: CancellationToken::new(),
            progress: jeikcode_kernel::tool::ProgressSink::noop(),
            requester: None,
        }
    }

    /// 回溯/删除改写转录尾部后，daemon 依赖的语义：`clear_todo_board` 必须让读者看到空清单，
    /// 且禁止旧槽/磁盘快照复活（否则幽灵清单会被下一个回合继承，agent 状态错乱）。
    #[test]
    fn clear_todo_board_wipes_live_items_and_blocks_restore() {
        let sid = "clear-on-rewind";
        purge_todo_board(sid); // 隔离：不残留其他用例的槽
        commit_todo_board(
            sid,
            &[TodoItem {
                content: "残留步骤".into(),
                status: TodoStatus::InProgress,
            }],
        );
        assert!(
            read_todo_board(sid).is_some(),
            "board must be live before clear"
        );

        clear_todo_board(sid);
        assert!(
            read_todo_board(sid).is_none(),
            "readers must see no checklist after clear"
        );
        assert!(todo_session_is_closed(sid));

        // closed 之后即使有人拿着旧 board（磁盘/旧槽）来恢复，也必须被拒绝。
        restore_todo_board(
            sid,
            TodoBoard {
                id: "todo-ghost".into(),
                seq: 9,
                revision: 0,
                items: vec![TodoItem {
                    content: "幽灵步骤".into(),
                    status: TodoStatus::Pending,
                }],
            },
        );
        assert!(
            read_todo_board(sid).is_none(),
            "a closed session must not resurrect a ghost checklist"
        );
        purge_todo_board(sid);
    }

    /// 回溯重建：先 `clear` 关旧板（防旧槽/磁盘快照复活），再按“剩余转录”的推导结果
    /// `commit` 回去。这是跨轮次回溯的正确语义：只回退被删掉的那些动作，
    /// 更早轮次建立/修改过的项原样保留。
    #[test]
    fn rewound_board_recommits_the_remaining_transcript() {
        let sid = "rewind-rebuild";
        purge_todo_board(sid);
        commit_todo_board(
            sid,
            &[TodoItem {
                content: "A 轮计划".into(),
                status: TodoStatus::Completed,
            }],
        );

        // 回溯：旧板先关掉（禁止幽灵复活）……
        clear_todo_board(sid);
        assert!(read_todo_board(sid).is_none());

        // ……再按剩余转录重建（这些项来自更早的轮次，必须留住）。
        let rebuilt = vec![TodoItem {
            content: "A 轮计划".into(),
            status: TodoStatus::InProgress,
        }];
        let board = commit_todo_board(sid, &rebuilt);
        assert_eq!(board.items, rebuilt);
        assert_eq!(
            read_todo_board(sid).map(|b| b.items),
            Some(rebuilt),
            "rebuild after clear must be readable"
        );
        assert!(
            !todo_session_is_closed(sid),
            "重建后的板必须是活的，下一轮还能继续折叠动作"
        );
        purge_todo_board(sid);
    }

    /// 撤销重建走原地重绑：板身份（id）不变、seq 只增不减，
    /// 任何把 `(board_id, seq)` 当版本号的消费者都不会把撤销看成回退。
    #[test]
    fn rebind_keeps_board_identity_and_monotonic_seq() {
        let sid = "rewind-rebind";
        purge_todo_board(sid);
        let first = commit_todo_board(
            sid,
            &[TodoItem {
                content: "A 轮计划".into(),
                status: TodoStatus::InProgress,
            }],
        );

        // steer 轮只改了两项 → 回溯后用剩余转录推导出的状态重绑。
        let rebuilt = vec![
            TodoItem {
                content: "A 轮计划".into(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "A 轮补充项".into(),
                status: TodoStatus::Pending,
            },
        ];
        let board = rebind_todo_board(sid, &rebuilt).expect("live slot must rebind in place");
        assert_eq!(board.id, first.id, "板身份必须保留");
        assert_eq!(board.seq, first.seq + 1, "seq 只增不减");
        assert_eq!(read_todo_board(sid).map(|b| b.items), Some(rebuilt));
        assert!(!todo_session_is_closed(sid), "重建后的板是活的");

        // 再回溯一次：seq 继续前进，id 仍然不变。
        let again = rebind_todo_board(
            sid,
            &[TodoItem {
                content: "A 轮计划".into(),
                status: TodoStatus::Pending,
            }],
        )
        .expect("second rebind");
        assert_eq!(again.id, first.id);
        assert_eq!(again.seq, first.seq + 2);
        purge_todo_board(sid);
    }

    /// 整轮被删干净（推导为空）：板关闭且拒绝旧磁盘快照复活；
    /// 槽不存在时返回 None，让调用方退回 clear/commit 兜底。
    #[test]
    fn rebind_with_empty_fold_closes_the_board() {
        let sid = "rewind-rebind-empty";
        purge_todo_board(sid);
        assert!(
            rebind_todo_board(sid, &[]).is_none(),
            "no slot → caller falls back"
        );
        commit_todo_board(
            sid,
            &[TodoItem {
                content: "将被删光的计划".into(),
                status: TodoStatus::InProgress,
            }],
        );
        assert!(rebind_todo_board(sid, &[]).is_none());
        assert!(read_todo_board(sid).is_none(), "关闭后不得再有清单");
        assert!(todo_session_is_closed(sid));

        restore_todo_board(
            sid,
            TodoBoard {
                id: "todo-ghost-rebind".into(),
                seq: 7,
                revision: 0,
                items: vec![TodoItem {
                    content: "幽灵步骤".into(),
                    status: TodoStatus::Pending,
                }],
            },
        );
        assert!(
            read_todo_board(sid).is_none(),
            "撤销清空后旧板不得被磁盘/旧槽复活"
        );
        purge_todo_board(sid);
    }

    #[test]
    fn parse_valid_full_list() {
        let todos = parse_todos(r#"{"todos":[{"content":"a","status":"pending"},{"content":"b","status":"in_progress"}]}"#).unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "a");
        assert_eq!(todos[1].status, TodoStatus::InProgress);
    }

    #[test]
    fn parse_accepts_one_stringified_todos_layer() {
        let todos =
            parse_todos(r#"{"todos":"[{\"content\":\"a\",\"status\":\"in_progress\"}]"}"#).unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "a");
        assert_eq!(todos[0].status, TodoStatus::InProgress);
    }

    #[test]
    fn parse_rejects_double_stringified_todos() {
        let error = parse_todos(r#"{"todos":"\"[]\""}"#).unwrap_err();
        assert!(error.contains("invalid arguments"), "{error}");
    }

    #[test]
    fn parse_rejects_bad_status() {
        let e = parse_todos(r#"{"todos":[{"content":"a","status":"done"}]}"#).unwrap_err();
        assert!(e.contains("pending"), "{e}");
    }

    #[test]
    fn parse_coalesces_two_in_progress_to_the_last_one() {
        let todos = parse_todos(r#"{"todos":[{"content":"a","status":"in_progress"},{"content":"b","status":"in_progress"}]}"#).unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].status, TodoStatus::Pending);
        assert_eq!(todos[1].status, TodoStatus::InProgress);
    }

    #[test]
    fn parse_collapses_duplicate_titles() {
        let todos = parse_todos(r#"{"todos":[{"content":"导出Excel","status":"pending"},{"content":"  导出Excel  ","status":"in_progress"}]}"#).unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "导出Excel");
        assert_eq!(todos[0].status, TodoStatus::InProgress);
    }

    #[test]
    fn parse_rejects_empty_content() {
        let e = parse_todos(r#"{"todos":[{"content":"  ","status":"pending"}]}"#).unwrap_err();
        assert!(e.contains("content"), "{e}");
    }

    #[test]
    fn parse_empty_list_ok() {
        assert_eq!(parse_todos(r#"{"todos":[]}"#).unwrap().len(), 0);
    }

    #[test]
    fn glyph_unicode_vs_ascii() {
        assert_eq!(todo_glyph(TodoStatus::Pending, true), "[ ]");
        assert_eq!(todo_glyph(TodoStatus::InProgress, true), "[\u{2022}]"); // [•]
        assert_eq!(todo_glyph(TodoStatus::Completed, true), "[√]");
        assert_eq!(todo_glyph(TodoStatus::Pending, false), "[ ]");
        assert_eq!(todo_glyph(TodoStatus::InProgress, false), "[~]");
        assert_eq!(todo_glyph(TodoStatus::Completed, false), "[√]");
    }

    #[test]
    fn render_text_ascii() {
        let todos = vec![
            TodoItem {
                content: "first".into(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "second".into(),
                status: TodoStatus::InProgress,
            },
        ];
        let s = render_todos_text(&todos, false);
        assert!(s.contains("[√] first"), "{s}");
        assert!(s.contains("[~] second"), "{s}");
    }

    #[test]
    fn derive_finds_last_todowrite() {
        let msgs = vec![
            Message::user("hi"),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "1".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"old","status":"pending"}]}"#.into(),
                }],
            ),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "2".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"new","status":"in_progress"}]}"#.into(),
                }],
            ),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "new"); // LAST wins
        assert_eq!(todos[0].status, TodoStatus::InProgress);
    }

    /// 与 WebUI 的 `todoRewind.test.ts` 同一场景：跨轮次回溯只回退被删掉的动作，
    /// 更早轮次的计划必须留住（单轮内建了又整轮删干净才是空）。
    /// 这里锁住**生产折叠**（derive_current_todos）的输出。
    #[test]
    fn rewind_after_steer_keeps_the_earlier_turns_plan() {
        let call = |id: &str, args: &str| {
            Message::assistant(
                "",
                vec![ToolCall {
                    id: id.into(),
                    name: "todowrite".into(),
                    arguments: args.into(),
                }],
            )
        };
        let plan = r#"{"todos":[{"content":"读取项目结构","status":"in_progress"},{"content":"修复渲染","status":"pending"}]}"#;
        let advance = r#"{"action":"update","id":1,"status":"completed"}"#;
        let add = r#"{"action":"add","content":"补充单元测试"}"#;
        let promote = r#"{"action":"update","id":2,"status":"in_progress"}"#;

        let mut msgs = vec![
            Message::user("帮我把这个项目跑起来"),
            call("t1", plan),
            call("t2", advance),
            // steer 也是真实用户消息（非 synthetic），因此算轮次边界。
            Message::user("接下来帮我改渲染"),
            call("t3", add),
            call("t4", promote),
        ];
        let full = derive_current_todos(&msgs);
        assert_eq!(full.len(), 3);
        assert_eq!(full[0].status, TodoStatus::Completed);
        assert_eq!(full[1].status, TodoStatus::InProgress);
        assert_eq!(full[2].status, TodoStatus::Pending);

        // 删除 steer 整轮（提问 + 之后的消息）：A 轮状态原样保留。
        msgs.truncate(3);
        let rolled_back = derive_current_todos(&msgs);
        assert_eq!(rolled_back.len(), 2, "跨轮次回溯不得一刀切清空");
        assert_eq!(rolled_back[0].content, "读取项目结构");
        assert_eq!(rolled_back[0].status, TodoStatus::Completed);
        assert_eq!(rolled_back[1].content, "修复渲染");
        assert_eq!(rolled_back[1].status, TodoStatus::Pending);

        // 单轮内建了又整轮删干净 → 空（与旧行为等价）。
        assert!(derive_current_todos(&[]).is_empty());
        assert!(derive_current_todos(&msgs[0..1]).is_empty());
    }

    #[test]
    fn todo_board_stays_until_stop_closes_a_finished_list() {
        let session = format!("todo-board-{}", std::process::id());
        let open = vec![TodoItem {
            content: "still".into(),
            status: TodoStatus::Pending,
        }];
        let first = commit_todo_board(&session, &open);
        assert_eq!(read_todo_board(&session).unwrap().id, first.id);
        assert!(close_todo_board_if_complete(&session).is_none());
        assert_eq!(read_todo_board(&session).unwrap().items.len(), 1);
        let done = vec![TodoItem {
            content: "still".into(),
            status: TodoStatus::Completed,
        }];
        let updated = commit_todo_board(&session, &done);
        assert_eq!(updated.id, first.id);
        assert!(updated.seq > first.seq);
        let closed = close_todo_board_if_complete(&session).unwrap();
        assert_eq!(closed.items.len(), 1);
        assert!(read_todo_board(&session).is_none());
    }

    #[test]
    fn session_sticky_todos_hides_completed_plan_once_idle() {
        let msgs = vec![Message::assistant(
            "",
            vec![ToolCall {
                id: "1".into(),
                name: "todowrite".into(),
                arguments: r#"{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"completed"}]}"#.into(),
            }],
        )];
        assert!(
            session_sticky_todos(&msgs, false).is_empty(),
            "an idle completed plan must not be returned as the live panel"
        );
        assert_eq!(session_sticky_todos(&msgs, true).len(), 2);
    }

    #[test]
    fn session_sticky_todos_drops_completed_plan_when_a_new_user_turn_starts() {
        let done = Message::assistant(
            "",
            vec![ToolCall {
                id: "1".into(),
                name: "todowrite".into(),
                arguments: r#"{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"completed"}]}"#.into(),
            }],
        );
        let mut msgs = vec![Message::user("plan it"), done.clone()];
        assert_eq!(session_sticky_todos(&msgs, true).len(), 2);
        msgs.push(Message::synthetic_user("before you finish"));
        assert_eq!(
            session_sticky_todos(&msgs, true).len(),
            2,
            "a synthetic nudge is still the same turn"
        );
        msgs.push(Message::user("你好"));
        assert!(
            session_sticky_todos(&msgs, true).is_empty(),
            "a new user turn must not receive the previous completed checklist"
        );
        assert!(derive_current_todos(&msgs).is_empty());
        msgs.push(Message::assistant(
            "",
            vec![ToolCall {
                id: "2".into(),
                name: "todowrite".into(),
                arguments: r#"{"action":"add","content":"fresh"}"#.into(),
            }],
        ));
        let fresh = derive_current_todos(&msgs);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].content, "fresh");
        assert_eq!(fresh[0].status, TodoStatus::Pending);
    }

    #[test]
    fn closed_checklist_is_not_rebuilt_from_later_incremental_calls() {
        let msgs = vec![
            Message::user("plan it"),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "1".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"keep-a","status":"completed"},{"content":"keep-b","status":"completed"},{"content":"keep-c","status":"completed"}]}"#.into(),
                }],
            ),
            Message::user("next"),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "2".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"actions":[{"action":"update","id":2,"content":"keep-b","status":"pending"},{"action":"update","id":3,"content":"keep-c","status":"in_progress"}]}"#.into(),
                }],
            ),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "3".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"keep-b","status":"pending"},{"content":"keep-c","status":"in_progress"}]}"#.into(),
                }],
            ),
        ];
        assert!(
            derive_current_todos(&msgs).is_empty(),
            "a closed checklist must not come back as a shorter unfinished list"
        );
        assert!(session_sticky_todos(&msgs, false).is_empty());
        assert!(session_sticky_todos(&msgs, true).is_empty());
    }

    #[test]
    fn open_checklist_continues_into_the_next_user_turn() {
        let msgs = vec![
            Message::user("plan it"),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "1".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"keep","status":"pending"},{"content":"done","status":"completed"}]}"#.into(),
                }],
            ),
            Message::user("continue"),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "2".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"action":"add","content":"next"}"#.into(),
                }],
            ),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(
            todos
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["keep", "done", "next"]
        );
        assert_eq!(session_sticky_todos(&msgs, true).len(), 3);
    }

    #[test]
    fn derive_recovers_stringified_todowrite_from_transcript() {
        let msgs = vec![
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "1".into(),
                    name: "todowrite".into(),
                    arguments:
                        r#"{"todos":"[{\"content\":\"persisted\",\"status\":\"pending\"}]"}"#.into(),
                }],
            ),
            todo_call("2", r#"{"action":"update","id":1,"status":"completed"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "persisted");
        assert_eq!(todos[0].status, TodoStatus::Completed);
    }

    #[test]
    fn counts_completed_over_total() {
        let todos = parse_todos(
            r#"{"todos":[
                {"content":"a","status":"completed"},
                {"content":"b","status":"completed"},
                {"content":"c","status":"in_progress"},
                {"content":"d","status":"pending"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(todo_counts(&todos), (2, 1, 4));
        assert_eq!(todo_counts(&[]), (0, 0, 0));
    }

    #[test]
    fn derive_none_when_no_todowrite() {
        let msgs = vec![Message::user("hi"), Message::assistant("hello", vec![])];
        assert!(derive_current_todos(&msgs).is_empty());
    }

    #[test]
    fn derive_skips_invalid_and_returns_last_valid() {
        // The LAST todowrite has empty content (invalid); the earlier one is valid.
        let msgs = vec![
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "1".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"keep","status":"pending"}]}"#.into(),
                }],
            ),
            Message::assistant(
                "",
                vec![ToolCall {
                    id: "2".into(),
                    name: "todowrite".into(),
                    arguments: r#"{"todos":[{"content":"  ","status":"pending"}]}"#.into(),
                }],
            ),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(
            todos.len(),
            1,
            "should skip invalid call and return last valid list"
        );
        assert_eq!(todos[0].content, "keep");
        assert_eq!(todos[0].status, TodoStatus::Pending);
    }

    // ---- incremental `todo` action reducer ----------------------------------------------

    fn todo_call(id: &str, args: &str) -> Message {
        Message::assistant(
            "",
            vec![ToolCall {
                id: id.into(),
                name: "todo".into(),
                arguments: args.into(),
            }],
        )
    }
    fn write_call(id: &str, args: &str) -> Message {
        Message::assistant(
            "",
            vec![ToolCall {
                id: id.into(),
                name: "todowrite".into(),
                arguments: args.into(),
            }],
        )
    }
    const PLAN3: &str = r#"{"todos":[{"content":"a","status":"pending"},{"content":"b","status":"pending"},{"content":"c","status":"pending"}]}"#;

    #[test]
    fn reduce_add_appends_after_baseline() {
        let msgs = vec![
            write_call("1", PLAN3),
            todo_call("2", r#"{"action":"add","content":"d"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos.len(), 4);
        assert_eq!(todos[3].content, "d");
        assert_eq!(todos[3].status, TodoStatus::Pending);
    }

    #[test]
    fn reduce_update_flips_only_that_id() {
        let msgs = vec![
            write_call("1", PLAN3),
            todo_call("2", r#"{"action":"update","id":2,"status":"completed"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos[0].status, TodoStatus::Pending);
        assert_eq!(todos[1].status, TodoStatus::Completed); // #2 (1-based)
        assert_eq!(todos[2].status, TodoStatus::Pending);
    }

    #[test]
    fn reduce_in_progress_clears_previous_in_progress() {
        // Invariant enforced by the reducer: setting #3 in_progress clears #1.
        let msgs = vec![
            write_call("1", PLAN3),
            todo_call("2", r#"{"action":"update","id":1,"status":"in_progress"}"#),
            todo_call("3", r#"{"action":"update","id":3,"status":"in_progress"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(
            todos[0].status,
            TodoStatus::Pending,
            "#1 must revert to pending"
        );
        assert_eq!(
            todos[2].status,
            TodoStatus::InProgress,
            "#3 is the only in_progress"
        );
        assert_eq!(
            todos
                .iter()
                .filter(|t| t.status == TodoStatus::InProgress)
                .count(),
            1
        );
    }

    #[test]
    fn reduce_unknown_id_is_ignored() {
        let msgs = vec![
            write_call("1", PLAN3),
            todo_call("2", r#"{"action":"update","id":9,"status":"completed"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos.len(), 3);
        assert!(
            todos.iter().all(|t| t.status == TodoStatus::Pending),
            "unknown id must not change anything"
        );
    }

    #[test]
    fn reduce_replan_resets_ids_and_voids_stale_updates() {
        // An update BEFORE a re-plan is void; the re-plan is the new baseline.
        let msgs = vec![
            write_call("1", PLAN3),
            todo_call("2", r#"{"action":"update","id":1,"status":"completed"}"#), // pre-replan → void
            write_call(
                "3",
                r#"{"todos":[{"content":"x","status":"pending"},{"content":"y","status":"pending"}]}"#,
            ),
            todo_call("4", r#"{"action":"update","id":2,"status":"completed"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos.len(), 2, "list is the re-plan, not the old plan");
        assert_eq!(todos[0].content, "x");
        assert_eq!(
            todos[0].status,
            TodoStatus::Pending,
            "pre-replan update on old #1 is void"
        );
        assert_eq!(
            todos[1].status,
            TodoStatus::Completed,
            "post-replan update on new #2 applies"
        );
    }

    #[test]
    fn reduce_todo_only_from_empty() {
        // No todowrite at all — a session that plans purely with `todo add`.
        let msgs = vec![
            todo_call("1", r#"{"action":"add","content":"first"}"#),
            todo_call("2", r#"{"action":"add","content":"second"}"#),
            todo_call("3", r#"{"action":"update","id":1,"status":"in_progress"}"#),
        ];
        let todos = derive_current_todos(&msgs);
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "first");
        assert_eq!(todos[0].status, TodoStatus::InProgress);
        assert_eq!(todos[1].status, TodoStatus::Pending);
    }

    #[test]
    fn reduce_no_todo_events_matches_legacy_behavior() {
        // With zero `todo` events the reducer returns exactly the last todowrite list.
        let msgs = vec![write_call("1", PLAN3)];
        assert_eq!(derive_current_todos(&msgs).len(), 3);
    }

    #[tokio::test]
    async fn execute_echoes_normalized_list() {
        let t = TodoTool::new();
        let r = t
            .execute(
                r#"{"todos":[{"content":"task","status":"pending"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("task"), "{}", r.content);
    }

    #[tokio::test]
    async fn list_action_echoes_the_current_tasks_without_mutating_them() {
        let t = TodoTool::new();
        let seeded = t
            .execute(
                r#"{"actions":[{"action":"add","content":"alpha"},{"action":"add","content":"beta"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!seeded.is_error, "{}", seeded.content);

        // Both the bare legacy shape and the explicit `actions[]` shape answer with the list.
        let bare = t.execute(r#"{"action":"list"}"#, &ctx()).await;
        assert!(!bare.is_error, "list must not error: {}", bare.content);
        assert!(
            bare.content.contains("alpha") && bare.content.contains("beta"),
            "{}",
            bare.content
        );
        let explicit = t
            .execute(r#"{"actions":[{"action":"list"}]}"#, &ctx())
            .await;
        assert_eq!(
            explicit.content, bare.content,
            "list must not mutate the list"
        );

        // The fold sees the same no-op: a `list` call never changes derived state.
        let mut folded =
            parse_todos(r#"{"todos":[{"content":"kept","status":"pending"}]}"#).unwrap();
        let before = folded.clone();
        apply_todo_action(&mut folded, r#"{"action":"list"}"#);
        assert_eq!(folded, before);
    }

    #[tokio::test]
    async fn list_action_rejects_being_batched_with_a_mutation() {
        let t = TodoTool::new();
        let r = t
            .execute(
                r#"{"actions":[{"action":"list"},{"action":"add","content":"x"}]}"#,
                &ctx(),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("read-only"), "{}", r.content);
    }

    #[tokio::test]
    async fn execute_accepts_stringified_todos_from_provider() {
        let result = TodoTool::new()
            .execute(
                r#"{"todos":"[{\"content\":\"task\",\"status\":\"pending\"}]"}"#,
                &ctx(),
            )
            .await;
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("task"), "{}", result.content);
    }

    #[tokio::test]
    async fn execute_rejects_invalid() {
        let t = TodoTool::new();
        let r = t
            .execute(r#"{"todos":[{"content":"a","status":"nope"}]}"#, &ctx())
            .await;
        assert!(r.is_error);
        assert!(r.content.contains("pending"), "{}", r.content);
    }

    #[test]
    fn tool_name_is_todo_write() {
        assert_eq!(TodoTool::new().name(), TODO_TOOL_NAME);
        assert!(is_todo_tool_name("todo_write"));
        assert!(is_todo_tool_name("todowrite"));
        assert!(is_todo_tool_name("todo"));
        assert!(!is_todo_tool_name("read_file"));
    }

    #[test]
    fn todowrite_result_is_numbered_for_title_cache() {
        // The result must carry `<glyph> <id>. <content>` so the TUI title cache learns ids.
        let out = render_todos_numbered(&parse_todos(PLAN3).unwrap(), false);
        assert!(out.contains("] 1. a"), "{out}");
        assert!(out.contains("] 3. c"), "{out}");
    }

    #[tokio::test]
    async fn todowrite_accepts_full_list_shape() {
        let t = TodoTool::new();
        assert_eq!(t.name(), TODO_TOOL_NAME);
        let r = t.execute(PLAN3, &ctx()).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("1. a"),
            "numbered list echoed: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn todowrite_accepts_incremental_action_shape() {
        // The reported confusion is gone: the SAME `todowrite` tool takes the {action} shape too,
        // so a model that sends `{action}` no longer hits `action must be add or update`.
        let t = TodoTool::new();
        let add = t
            .execute(r#"{"action":"add","content":"write tests"}"#, &ctx())
            .await;
        assert!(
            !add.is_error && add.content.contains("write tests"),
            "{}",
            add.content
        );
        // `#<id> → <status>` is the exact base the TUI enrich step splices a title into.
        // Live list after the add has only #1.
        let upd = t
            .execute(r#"{"action":"update","id":1,"status":"completed"}"#, &ctx())
            .await;
        assert!(!upd.is_error, "{}", upd.content);
        assert!(
            upd.content.contains("#1 \u{2192} completed"),
            "{}",
            upd.content
        );
        assert!(upd.content.contains("1. write tests"), "{}", upd.content);
        let bad = t
            .execute(r#"{"action":"update","id":9,"status":"completed"}"#, &ctx())
            .await;
        assert!(bad.is_error, "unknown id must fail at execute");
        assert!(bad.content.contains("Current list"), "{}", bad.content);
        assert!(bad.content.contains("Do not retry"), "{}", bad.content);
    }

    #[tokio::test]
    async fn todowrite_execute_accepts_delete_remove_clear() {
        let t = TodoTool::new();
        let _ = t
            .execute(
                r#"{"todos":[{"content":"a","status":"pending"},{"content":"b","status":"pending"},{"content":"c","status":"pending"}]}"#,
                &ctx(),
            )
            .await;
        let del = t.execute(r#"{"action":"delete","id":2}"#, &ctx()).await;
        assert!(!del.is_error, "{}", del.content);
        assert!(
            del.content.contains("#2 \u{2192} removed"),
            "{}",
            del.content
        );
        assert!(del.content.contains("1. a"), "{}", del.content);
        let rm = t.execute(r#"{"action":"remove","id":1}"#, &ctx()).await;
        assert!(!rm.is_error, "{}", rm.content);
        assert!(rm.content.contains("#1 \u{2192} removed"), "{}", rm.content);
        let clr = t.execute(r#"{"action":"clear"}"#, &ctx()).await;
        assert!(!clr.is_error, "{}", clr.content);
        assert!(clr.content.contains("all tasks cleared"), "{}", clr.content);
        let bad = t.execute(r#"{"action":"delete"}"#, &ctx()).await;
        assert!(bad.is_error);
        let ghost = t.execute(r#"{"action":"delete","id":2}"#, &ctx()).await;
        assert!(ghost.is_error, "delete on empty list must fail");
        assert!(ghost.content.contains("Current list"), "{}", ghost.content);
    }

    #[tokio::test]
    async fn apply_todo_action_delete_remove_clear_preserves_state() {
        // Fold the transcript: plan → delete → remove → clear.
        let plan = r#"{"todos":[{"content":"a","status":"pending"},{"content":"b","status":"in_progress"},{"content":"c","status":"completed"}]}"#;
        let mut list = parse_todos(plan).unwrap();
        assert_eq!(list.len(), 3);

        apply_todo_action(&mut list, r#"{"action":"delete","id":2}"#);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].content, "a");
        assert_eq!(list[1].content, "c", "delete renumbers remaining items");

        apply_todo_action(&mut list, r#"{"action":"remove","id":1}"#);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].content, "c");

        apply_todo_action(&mut list, r#"{"action":"clear"}"#);
        assert!(list.is_empty());

        // Unknown id is ignored (list unchanged, no panic).
        let mut list2 = parse_todos(plan).unwrap();
        apply_todo_action(&mut list2, r#"{"action":"delete","id":99}"#);
        assert_eq!(list2.len(), 3);
    }

    #[tokio::test]
    async fn todowrite_rejects_bad_args() {
        let t = TodoTool::new();
        assert!(
            t.execute(r#"{"action":"add","content":"  "}"#, &ctx())
                .await
                .is_error,
            "empty add"
        );
        assert!(
            t.execute(r#"{"action":"update","status":"completed"}"#, &ctx())
                .await
                .is_error,
            "no id"
        );
        assert!(
            t.execute(r#"{"action":"update","id":2}"#, &ctx())
                .await
                .is_error,
            "no status"
        );
        assert!(
            t.execute(r#"{"action":"update","id":2,"status":"nope"}"#, &ctx())
                .await
                .is_error,
            "bad status"
        );
        assert!(
            t.execute(r#"{"action":"frobnicate"}"#, &ctx())
                .await
                .is_error,
            "bad action"
        );
        assert!(
            t.execute(r#"{}"#, &ctx()).await.is_error,
            "neither todos nor action"
        );
    }

    #[tokio::test]
    async fn todowrite_accepts_actions_batch() {
        let t = TodoTool::new();
        let r = t
            .execute(
                r#"{"actions":[{"action":"add","content":"one"},{"action":"add","content":"two"},{"action":"update","id":1,"status":"in_progress"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("Added task: one"), "{}", r.content);
        assert!(r.content.contains("#1"), "{}", r.content);
        assert!(
            r.content.contains("1. one"),
            "reprints numbered list: {}",
            r.content
        );
        let noop = t
            .execute(
                r#"{"actions":[{"action":"update","id":1,"status":"in_progress"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!noop.is_error, "{}", noop.content);
        assert!(noop.content.contains("No change"), "{}", noop.content);

        let mixed = t
            .execute(
                r#"{"actions":[{"action":"delete","id":1},{"action":"update","id":2,"status":"completed"}]}"#,
                &ctx(),
            )
            .await;
        assert!(
            mixed.is_error,
            "delete+update must be rejected: {}",
            mixed.content
        );
        assert!(mixed.content.contains("delete"), "{}", mixed.content);
    }

    #[test]
    fn apply_todo_actions_batch_is_transactional() {
        let mut list = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::Pending,
            },
        ];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"update","id":1,"status":"completed"},{"action":"update","id":99,"status":"in_progress"}]}"#,
        );
        assert_eq!(
            list[0].status,
            TodoStatus::Pending,
            "failed batch must not apply"
        );
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"update","id":1,"status":"completed"},{"action":"update","id":2,"status":"in_progress"}]}"#,
        );
        assert_eq!(list[0].status, TodoStatus::Completed);
        assert_eq!(list[1].status, TodoStatus::InProgress);
    }

    #[test]
    fn apply_todo_actions_updates_are_id_addressed_order_independent() {
        let mut list = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "c".into(),
                status: TodoStatus::Pending,
            },
        ];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"update","id":3,"status":"completed"},{"action":"update","id":1,"status":"completed"},{"action":"update","id":2,"status":"in_progress"}]}"#,
        );
        assert_eq!(list[0].status, TodoStatus::Completed);
        assert_eq!(list[1].status, TodoStatus::InProgress);
        assert_eq!(list[2].status, TodoStatus::Completed);
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"delete","id":3},{"action":"delete","id":1}]}"#,
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].content, "b");
        assert_eq!(list[0].status, TodoStatus::InProgress);
    }

    #[test]
    fn apply_todo_actions_rejects_mixed_id_shifting_kinds() {
        let mut list = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::Pending,
            },
        ];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"delete","id":1},{"action":"update","id":2,"status":"completed"}]}"#,
        );
        assert_eq!(list.len(), 2, "illegal mix must not apply");
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"insert","position":1,"content":"x"},{"action":"add","content":"y"}]}"#,
        );
        assert_eq!(list.len(), 2, "insert+add must not apply");
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"clear"},{"action":"delete","id":1}]}"#,
        );
        assert_eq!(list.len(), 2, "clear+delete must not apply");
    }

    #[test]
    fn apply_todo_actions_clear_then_add_update_replaces_plan() {
        let mut list = vec![
            TodoItem {
                content: "old-1".into(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "old-2".into(),
                status: TodoStatus::InProgress,
            },
        ];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"clear"},{"action":"add","content":"new-1"},{"action":"add","content":"new-2"},{"action":"update","id":1,"status":"in_progress"}]}"#,
        );
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].content, "new-1");
        assert_eq!(list[0].status, TodoStatus::InProgress);
        assert_eq!(list[1].content, "new-2");
        assert_eq!(list[1].status, TodoStatus::Pending);
    }

    #[test]
    fn add_on_finished_list_auto_clears_so_ids_restart() {
        let mut list = vec![
            TodoItem {
                content: "done-1".into(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "done-2".into(),
                status: TodoStatus::Completed,
            },
        ];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"add","content":"next-1"},{"action":"add","content":"next-2"},{"action":"update","id":3,"status":"in_progress"}]}"#,
        );
        assert_eq!(
            list.len(),
            4,
            "finished list must be appended without breaking chain"
        );
        assert_eq!(list[0].content, "done-1");
        assert_eq!(list[0].status, TodoStatus::Completed);
        assert_eq!(list[1].content, "done-2");
        assert_eq!(list[1].status, TodoStatus::Completed);
        assert_eq!(list[2].content, "next-1");
        assert_eq!(list[2].status, TodoStatus::InProgress);
        assert_eq!(list[3].content, "next-2");
    }

    #[test]
    fn add_update_on_finished_list_accepts_append_style_ids() {
        // The live failure: list is `[x] 1. 查询…`, model adds a follow-up as
        // id 2 and updates id 2. Completed list must smoothly append.
        let mut list = vec![TodoItem {
            content: "查询沉睡资源客户列表".into(),
            status: TodoStatus::Completed,
        }];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"add","content":"导出Excel","id":2},{"action":"update","id":2,"status":"in_progress"}]}"#,
        );
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].content, "查询沉睡资源客户列表");
        assert_eq!(list[0].status, TodoStatus::Completed);
        assert_eq!(list[1].content, "导出Excel");
        assert_eq!(list[1].status, TodoStatus::InProgress);
    }

    #[test]
    fn update_and_multiple_adds_on_in_progress_list_does_not_clear() {
        let mut list = (1..=6)
            .map(|i| TodoItem {
                content: format!("task-{i}"),
                status: if i == 6 {
                    TodoStatus::InProgress
                } else {
                    TodoStatus::Completed
                },
            })
            .collect::<Vec<_>>();

        apply_todo_action(
            &mut list,
            r#"{"actions":[
                {"action":"update","id":6,"status":"completed"},
                {"action":"add","content":"task-7"},
                {"action":"add","content":"task-8"},
                {"action":"add","content":"task-9"},
                {"action":"add","content":"task-10"}
            ]}"#,
        );

        assert_eq!(
            list.len(),
            10,
            "list must preserve original 6 tasks and append 4 new ones"
        );
        assert_eq!(list[5].content, "task-6");
        assert_eq!(list[5].status, TodoStatus::Completed);
        assert_eq!(list[6].content, "task-7");
        assert_eq!(list[9].content, "task-10");
    }

    #[test]
    fn reduce_todos_preserves_in_progress_list_when_batch_adds_multiple_items() {
        let initial = r#"{"actions":[
            {"action":"add","content":"task-1","status":"completed"},
            {"action":"add","content":"task-2","status":"completed"},
            {"action":"add","content":"task-3","status":"completed"},
            {"action":"add","content":"task-4","status":"completed"},
            {"action":"add","content":"task-5","status":"completed"},
            {"action":"add","content":"task-6","status":"in_progress"}
        ]}"#;
        let follow_up = r#"{"actions":[
            {"action":"update","id":6,"status":"completed"},
            {"action":"add","content":"task-7"},
            {"action":"add","content":"task-8"},
            {"action":"add","content":"task-9"},
            {"action":"add","content":"task-10"}
        ]}"#;

        let list = reduce_todos([("todo_write", initial), ("todo_write", follow_up)]);
        assert_eq!(
            list.len(),
            10,
            "reduce_todos must fold mid-turn batch adds incrementally without wiping existing tasks"
        );
        assert_eq!(list[0].content, "task-1");
        assert_eq!(list[5].content, "task-6");
        assert_eq!(list[5].status, TodoStatus::Completed);
        assert_eq!(list[6].content, "task-7");
        assert_eq!(list[9].content, "task-10");
    }

    #[test]
    fn add_duplicate_title_upserts_instead_of_duplicating() {
        let mut list = vec![TodoItem {
            content: "导出Excel".into(),
            status: TodoStatus::Pending,
        }];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"add","content":"导出Excel","status":"in_progress"}]}"#,
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, TodoStatus::InProgress);
    }

    #[test]
    fn insert_duplicate_title_re_ranks() {
        let mut list = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "c".into(),
                status: TodoStatus::Pending,
            },
        ];
        apply_todo_action(
            &mut list,
            r#"{"action":"insert","position":1,"content":"c"}"#,
        );
        assert_eq!(
            list.iter().map(|t| t.content.as_str()).collect::<Vec<_>>(),
            vec!["c", "a", "b"]
        );
    }

    #[test]
    fn add_on_unfinished_list_does_not_auto_clear() {
        let mut list = vec![
            TodoItem {
                content: "done".into(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "still-open".into(),
                status: TodoStatus::Pending,
            },
        ];
        apply_todo_action(&mut list, r#"{"action":"add","content":"extra"}"#);
        assert_eq!(list.len(), 3);
        assert_eq!(list[2].content, "extra");
    }

    #[test]
    fn apply_todo_insert_then_update_uses_post_insert_ids() {
        let mut list = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::Pending,
            },
        ];
        // insert at 1 → [x, a, b]; update id=2 is original `a` (after insert).
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"update","id":2,"status":"in_progress"},{"action":"insert","position":1,"content":"x"}]}"#,
        );
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].content, "x");
        assert_eq!(list[1].content, "a");
        assert_eq!(list[1].status, TodoStatus::InProgress);
        assert_eq!(list[2].content, "b");
    }

    #[test]
    fn mixed_actions_and_todos_is_not_a_plan_baseline() {
        // Leftover `todos` must not reset the fold when `actions` is present —
        // execute/apply prefer actions; is_todo_plan must agree.
        let mixed = r#"{"actions":[{"action":"add","content":"from-actions"}],"todos":[{"content":"from-todos","status":"pending"}]}"#;
        assert!(!is_todo_plan(mixed), "actions wins over leftover todos");
        assert!(is_todo_action_args(mixed));
        let list = reduce_todos([
            (
                "todowrite",
                r#"{"todos":[{"content":"keep","status":"pending"}]}"#,
            ),
            ("todowrite", mixed),
        ]);
        assert_eq!(
            list.len(),
            2,
            "must fold actions on top of prior plan, not replace with todos"
        );
        assert_eq!(list[0].content, "keep");
        assert_eq!(list[1].content, "from-actions");
    }

    #[test]
    fn apply_accepts_string_ids() {
        let mut list = vec![TodoItem {
            content: "a".into(),
            status: TodoStatus::Pending,
        }];
        apply_todo_action(
            &mut list,
            r#"{"actions":[{"action":"update","id":"1","status":"completed"}]}"#,
        );
        assert_eq!(list[0].status, TodoStatus::Completed);
    }

    #[test]
    fn reducer_folds_actions_array() {
        let list = reduce_todos([
            (
                "todowrite",
                r#"{"actions":[{"action":"add","content":"a"},{"action":"add","content":"b"}]}"#,
            ),
            (
                "todowrite",
                r#"{"actions":[{"action":"update","id":1,"status":"completed"},{"action":"update","id":2,"status":"in_progress"}]}"#,
            ),
        ]);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].status, TodoStatus::Completed);
        assert_eq!(list[1].status, TodoStatus::InProgress);
    }

    #[test]
    fn reducer_folds_action_shape_under_todowrite_name() {
        // Merge regression: an incremental {action} carried by the `todowrite` tool name (not the
        // legacy `todo` name) must still fold — the baseline/patch decision is by SHAPE, not name.
        let list = reduce_todos([
            (
                "todowrite",
                r#"{"todos":[{"content":"a","status":"pending"},{"content":"b","status":"pending"}]}"#,
            ),
            (
                "todowrite",
                r#"{"action":"update","id":1,"status":"completed"}"#,
            ),
            ("todowrite", r#"{"action":"add","content":"c"}"#),
        ]);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].status, TodoStatus::Completed);
        assert_eq!(list[2].content, "c");
        // Legacy `todo`-named action still folds too (resume compatibility).
        let legacy = reduce_todos([
            (
                "todowrite",
                r#"{"todos":[{"content":"a","status":"pending"}]}"#,
            ),
            (
                "todo",
                r#"{"action":"update","id":1,"status":"in_progress"}"#,
            ),
        ]);
        assert_eq!(legacy[0].status, TodoStatus::InProgress);
    }

    #[test]
    fn description_covers_both_plan_and_update_modes() {
        let t = TodoTool::new();
        let d = t.description();
        assert!(d.contains("checklist"), "covers checklist: {d}");
        assert!(d.contains("task"), "covers task: {d}");
    }

    /// Advertised surface: one array, two explicit verbs, everything else inferred.
    #[test]
    fn schema_advertises_only_destructive_verbs() {
        let t = TodoTool::new();
        let s = t.parameters_schema();
        let items = &s["properties"]["actions"]["items"]["properties"];
        assert_eq!(s["required"], serde_json::json!(["actions"]));
        assert_eq!(s["properties"]["actions"]["minItems"].as_u64(), Some(1));
        assert_eq!(
            items["action"]["enum"],
            serde_json::json!(["delete", "clear"])
        );
        assert_eq!(
            items["status"]["enum"],
            serde_json::json!(["pending", "in_progress", "completed"])
        );
        assert_eq!(items["id"]["minimum"].as_u64(), Some(1));
        assert_eq!(items["position"]["minimum"].as_u64(), Some(1));
    }

    #[tokio::test]
    async fn todowrite_execute_accepts_insert() {
        let t = TodoTool::new();
        let ins = t
            .execute(
                r#"{"action":"insert","position":2,"content":"intermediate step"}"#,
                &ctx(),
            )
            .await;
        assert!(!ins.is_error, "{}", ins.content);
        assert!(
            ins.content
                .contains("#2 \u{2192} inserted: intermediate step"),
            "{}",
            ins.content
        );

        let bad = t
            .execute(r#"{"action":"insert","content":""}"#, &ctx())
            .await;
        assert!(bad.is_error);
    }

    #[tokio::test]
    async fn apply_todo_action_insert_between_items() {
        let plan =
            r#"{"todos":[{"content":"a","status":"pending"},{"content":"c","status":"pending"}]}"#;
        let mut list = parse_todos(plan).unwrap();
        assert_eq!(list.len(), 2);

        // Insert at position 2 (between #1 'a' and #2 'c')
        apply_todo_action(
            &mut list,
            r#"{"action":"insert","position":2,"content":"b"}"#,
        );
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].content, "a");
        assert_eq!(list[1].content, "b");
        assert_eq!(list[2].content, "c");

        // Insert at position 1 (at head)
        apply_todo_action(
            &mut list,
            r#"{"action":"insert","position":1,"content":"head"}"#,
        );
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].content, "head");
        assert_eq!(list[1].content, "a");

        // Insert at position beyond length (appends)
        apply_todo_action(
            &mut list,
            r#"{"action":"insert","position":99,"content":"tail"}"#,
        );
        assert_eq!(list.len(), 5);
        assert_eq!(list[4].content, "tail");
    }

    #[tokio::test]
    async fn todowrite_rejects_add_without_content() {
        let t = TodoTool::new();
        let res = t.execute(r#"{"actions":[{"action":"add"}]}"#, &ctx()).await;
        assert!(res.is_error);
        assert!(
            res.content
                .contains("adding a task needs non-empty `content`"),
            "{}",
            res.content
        );
        assert!(
            res.content
                .contains("Example: {\"content\": \"Implement feature X\"}"),
            "{}",
            res.content
        );
    }

    #[tokio::test]
    async fn todowrite_rejects_update_without_id() {
        let t = TodoTool::new();
        let res = t
            .execute(
                r#"{"actions":[{"action":"update","status":"in_progress"}]}"#,
                &ctx(),
            )
            .await;
        assert!(res.is_error);
        assert!(
            res.content.contains("updating needs a valid `id`"),
            "{}",
            res.content
        );
        assert!(
            res.content
                .contains("Example: {\"id\": 1, \"status\": \"in_progress\"}"),
            "{}",
            res.content
        );
    }

    #[tokio::test]
    async fn todowrite_rejects_update_without_status_or_content() {
        let t = TodoTool::new();
        let _ = t
            .execute(
                r#"{"actions":[{"action":"add","content":"Step 1"}]}"#,
                &ctx(),
            )
            .await;
        let res = t
            .execute(r#"{"actions":[{"action":"update","id":1}]}"#, &ctx())
            .await;
        assert!(res.is_error);
        assert!(
            res.content
                .contains("updating needs at least one of `status`"),
            "{}",
            res.content
        );
    }

    #[tokio::test]
    async fn todowrite_accepts_update_with_content_only() {
        let t = TodoTool::new();
        let add_res = t
            .execute(
                r#"{"actions":[{"action":"add","content":"Original text"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!add_res.is_error, "{}", add_res.content);

        let update_res = t
            .execute(
                r#"{"actions":[{"action":"update","id":1,"content":"Updated text"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!update_res.is_error, "{}", update_res.content);
        assert!(
            update_res.content.contains("Updated text"),
            "{}",
            update_res.content
        );
    }

    #[test]
    fn infer_action_kind_from_fields() {
        assert_eq!(
            action_kind(&serde_json::json!({"content": "x"})),
            Some("add")
        );
        assert_eq!(
            action_kind(&serde_json::json!({"content": "x", "status": "in_progress"})),
            Some("add")
        );
        assert_eq!(
            action_kind(&serde_json::json!({"content": "x", "position": 2})),
            Some("insert")
        );
        assert_eq!(
            action_kind(&serde_json::json!({"id": 1, "status": "completed"})),
            Some("update")
        );
        assert_eq!(
            action_kind(&serde_json::json!({"id": 1, "content": "renamed"})),
            Some("update")
        );
        assert_eq!(action_kind(&serde_json::json!({"id": 1})), Some("delete"));
        assert_eq!(action_kind(&serde_json::json!({})), None);
        assert_eq!(
            action_kind(&serde_json::json!({"action": "clear"})),
            Some("clear")
        );
        // Explicit action always wins over field inference.
        assert_eq!(
            action_kind(&serde_json::json!({"action": "update", "id": 1})),
            Some("update")
        );
        assert_eq!(
            action_kind(&serde_json::json!({"action": "add", "content": "x", "id": 2})),
            Some("add")
        );
        assert_eq!(action_kind(&serde_json::json!({"action": "frob"})), None);
        // id+position+content is ambiguous without an explicit action.
        assert_eq!(
            action_kind(&serde_json::json!({
                "id": 1,
                "position": 2,
                "content": "x"
            })),
            None
        );
    }

    #[tokio::test]
    async fn execute_infers_omitted_action_in_a_status_batch() {
        let t = TodoTool::new();
        let plan = t
            .execute(
                r#"{"actions":[{"content":"one"},{"content":"two"},{"id":1,"status":"in_progress"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!plan.is_error, "{}", plan.content);
        assert!(plan.content.contains("1. one"), "{}", plan.content);
        assert!(plan.content.contains("in_progress"), "{}", plan.content);

        let upd = t
            .execute(
                r#"{"actions":[{"id":1,"status":"completed"},{"id":2,"status":"in_progress"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!upd.is_error, "{}", upd.content);
        assert!(upd.content.contains("#1"), "{}", upd.content);
        assert!(upd.content.contains("completed"), "{}", upd.content);

        let del = t.execute(r#"{"id":1}"#, &ctx()).await;
        assert!(!del.is_error, "{}", del.content);
        assert!(del.content.contains("#1"), "{}", del.content);
        assert!(!del.content.contains("1. one"), "{}", del.content);
    }

    #[tokio::test]
    async fn escaped_status_key_is_repaired_like_a_normal_update() {
        // The provider double-escaped the tail of the payload: after JSON parsing
        // the key is literally `"status"` (quotes included). It must repair to
        // `status`, not fall through to the bare-`id` delete rule.
        let t = TodoTool::new();
        let r = t
            .execute(
                r#"{"actions":[
                    {"content":"one"},
                    {"content":"two"},
                    {"\"status\"":"in_progress","id":1}
                ]}"#,
                &ctx(),
            )
            .await;
        assert!(
            !r.is_error,
            "escaped `status` key must be repaired: {}",
            r.content
        );
        assert!(r.content.contains("[~] 1. one"), "{}", r.content);
        assert!(r.content.contains("[ ] 2. two"), "{}", r.content);
    }

    #[test]
    fn escaped_status_key_folds_to_the_same_list_as_execute() {
        // Live execution normalizes at the tool boundary; replay/resume folds the
        // RAW transcript call, so the same repair must also live in
        // `try_apply_todo_args` or the two views diverge.
        let args = r#"{"actions":[{"content":"one"},{"content":"two"},{"\"status\"":"in_progress","id":1}]}"#;
        let folded = reduce_todos([("todo_write", args)]);
        assert_eq!(folded.len(), 2, "{folded:?}");
        assert_eq!(folded[0].content, "one");
        assert_eq!(folded[0].status, TodoStatus::InProgress);
        assert_eq!(folded[1].status, TodoStatus::Pending);
    }

    #[test]
    fn escaped_status_key_in_plan_is_repaired() {
        let plan = r#"{"todos":[{"content":"a","\"status\"":"in_progress"}]}"#;
        let parsed = parse_todos(plan).expect("plan with an escaped status key must parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].status, TodoStatus::InProgress);
    }

    #[test]
    fn escaped_root_actions_key_is_repaired() {
        let normalized = normalize_todo_write_args(r#"{"\"actions\"":[{"content":"a"}]}"#);
        let v: serde_json::Value = serde_json::from_str(&normalized).unwrap();
        assert!(v.get("actions").is_some(), "{normalized}");
        assert_eq!(v["actions"][0]["content"], "a");
    }

    #[tokio::test]
    async fn misspelled_status_key_is_reported_not_treated_as_delete() {
        let t = TodoTool::new();
        let seeded = t
            .execute(
                r#"{"actions":[{"content":"keep"},{"content":"also"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!seeded.is_error, "{}", seeded.content);

        let r = t
            .execute(r#"{"actions":[{"id":1,"stauts":"completed"}]}"#, &ctx())
            .await;
        assert!(r.is_error, "a typo must not be applied: {}", r.content);
        assert!(
            r.content.contains("unrecognized key(s) `stauts`"),
            "{}",
            r.content
        );
        assert!(
            r.content
                .contains("did you mean `status` instead of `stauts`"),
            "{}",
            r.content
        );
        assert!(
            r.content.contains("No changes were applied"),
            "{}",
            r.content
        );
        assert!(
            !r.content.contains("Do not retry a failed id"),
            "schema errors must not reuse the id-retry hint: {}",
            r.content
        );

        let list = t.execute(r#"{"action":"list"}"#, &ctx()).await;
        assert!(
            list.content.contains("1. keep") && list.content.contains("2. also"),
            "the typo must not delete anything: {}",
            list.content
        );
    }

    #[tokio::test]
    async fn bare_id_with_unknown_key_is_not_a_delete() {
        // Only an object whose sole field is `id` is destructive. Unknown keys
        // (here `note`) mean the payload is malformed, not a delete request.
        let t = TodoTool::new();
        let seeded = t
            .execute(r#"{"actions":[{"content":"a"},{"content":"b"}]}"#, &ctx())
            .await;
        assert!(!seeded.is_error, "{}", seeded.content);

        let r = t
            .execute(r#"{"actions":[{"id":1,"note":"x"}]}"#, &ctx())
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(
            r.content.contains("unrecognized key(s) `note`"),
            "{}",
            r.content
        );

        let list = t.execute(r#"{"action":"list"}"#, &ctx()).await;
        assert!(
            list.content.contains("1. a") && list.content.contains("2. b"),
            "an unknown key must never silently delete a task: {}",
            list.content
        );
    }

    #[tokio::test]
    async fn empty_object_is_not_inferred_as_clear() {
        let t = TodoTool::new();
        let _ = t
            .execute(r#"{"actions":[{"content":"keep me"}]}"#, &ctx())
            .await;
        let res = t.execute(r#"{}"#, &ctx()).await;
        assert!(res.is_error, "empty payload must not clear the list");
        let res = t.execute(r#"{"actions":[{}]}"#, &ctx()).await;
        assert!(res.is_error);
        assert!(res.content.contains("could not infer"), "{}", res.content);
    }

    #[tokio::test]
    async fn hybrid_truncated_actions_string_plus_sibling_fields_is_applied() {
        let t = TodoTool::new();
        let args = serde_json::json!({
            "actions": "[{invalid",
            "content": "from sibling",
            "status": "in_progress"
        })
        .to_string();
        let r = t.execute(&args, &ctx()).await;
        assert!(
            !r.is_error,
            "hybrid sibling action must apply: {}",
            r.content
        );
        assert!(r.content.contains("from sibling"), "{}", r.content);
    }

    #[test]
    fn merge_todo_write_args_concatenates_single_action_calls() {
        let a = r#"{"actions":[{"content":"one"}]}"#;
        let b = r#"{"id":1,"status":"in_progress"}"#;
        let merged = merge_todo_write_args(&[a, b]).expect("merge");
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["actions"].as_array().unwrap().len(), 2);
        assert_eq!(v["actions"][0]["content"], "one");
        assert_eq!(v["actions"][1]["id"], 1);
    }

    #[test]
    fn merge_todo_write_args_keeps_a_read_only_list_call_independent() {
        // `list` must never ride inside a merged batch: the mix is illegal, so the merge
        // declines and the kernel runs the two calls in order (list echoes, add applies).
        let list = r#"{"action":"list"}"#;
        let add = r#"{"action":"add","content":"one"}"#;
        assert!(merge_todo_write_args(&[list, add]).is_none());
        assert!(merge_todo_write_args(&[list, list]).is_none());
    }

    #[test]
    fn merge_todo_write_args_aborts_illegal_delete_plus_add_mix() {
        let del = r#"{"id":1}"#;
        let add = r#"{"content":"new"}"#;
        assert!(
            merge_todo_write_args(&[del, add]).is_none(),
            "delete+add must stay sequential, not a rejected merged batch"
        );
    }

    #[tokio::test]
    async fn empty_list_seeds_from_id_content_status_plan() {
        // Model new-plan shape: omitted action + sequential ids. Inferred as
        // update, but an empty list must absorb it as adds instead of
        // "unknown task id 1 (list has 0 items)".
        let t = TodoTool::new();
        let r = t
            .execute(
                r#"{"actions":[
                    {"content":"定位 session 标题异步生成与替换的完整链路","id":1,"status":"in_progress"},
                    {"content":"对比 Anthropic / Responses / ChatCompletions 三种协议的标题触发差异","id":2,"status":"pending"},
                    {"content":"修复 Responses 与 ChatCompletions 不生成/不替换标题的 BUG","id":3,"status":"pending"},
                    {"content":"用测试/编译验证修复","id":4,"status":"pending"}
                ]}"#,
                &ctx(),
            )
            .await;
        assert!(
            !r.is_error,
            "empty-list seed plan must apply: {}",
            r.content
        );
        assert!(r.content.contains("1. 定位 session"), "{}", r.content);
        assert!(r.content.contains("4. 用测试"), "{}", r.content);
        assert!(r.content.contains("in_progress"), "{}", r.content);
    }

    #[tokio::test]
    async fn status_only_update_on_empty_list_still_fails() {
        let t = TodoTool::new();
        let r = t
            .execute(r#"{"actions":[{"id":1,"status":"in_progress"}]}"#, &ctx())
            .await;
        assert!(
            r.is_error,
            "status-only update must not invent a task: {}",
            r.content
        );
        assert!(r.content.contains("unknown task id"), "{}", r.content);
    }

    #[tokio::test]
    async fn id_content_update_on_live_list_does_not_duplicate() {
        let t = TodoTool::new();
        let _ = t
            .execute(
                r#"{"actions":[{"content":"keep me"},{"content":"second"}]}"#,
                &ctx(),
            )
            .await;
        let r = t
            .execute(
                r#"{"actions":[{"id":1,"content":"renamed","status":"in_progress"}]}"#,
                &ctx(),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("1. renamed"), "{}", r.content);
        assert!(r.content.contains("2. second"), "{}", r.content);
        assert!(!r.content.contains("keep me"), "{}", r.content);
    }

    #[test]
    fn a_dead_live_handle_never_hands_its_session_to_a_fresh_one() {
        let live: TodoLive = Arc::new(Mutex::new(Vec::new()));
        let key = live_key(&live);
        bind_todo_session(&live, "dead-session");
        assert_eq!(todo_session_of(&live).as_deref(), Some("dead-session"));

        // The owner dies without unbinding (a panicking caller). The weak owner
        // keeps the allocation pinned, so the address cannot be recycled onto a
        // different live handle and alias the dead session onto it.
        drop(live);
        {
            let guard = live_bindings().lock().unwrap();
            let binding = guard.get(&key).expect("binding outlives its owner");
            assert_eq!(binding.owner.strong_count(), 0);
        }

        let fresh: TodoLive = Arc::new(Mutex::new(Vec::new()));
        assert_ne!(live_key(&fresh), key, "the dead allocation stays pinned");
        assert!(
            todo_session_of(&fresh).is_none(),
            "a fresh live handle must not inherit a dead session"
        );
    }

    #[test]
    fn a_dead_binding_is_cleared_on_lookup() {
        let live: TodoLive = Arc::new(Mutex::new(Vec::new()));
        let key = live_key(&live);
        // A binding whose owner is already dead — the owner was dropped without
        // unbinding, so the binding describes no live checklist any more.
        let dead_owner = {
            let dead: TodoLive = Arc::new(Mutex::new(Vec::new()));
            Arc::downgrade(&dead)
        };
        assert_eq!(dead_owner.strong_count(), 0);
        live_bindings().lock().unwrap().insert(
            key,
            LiveBinding {
                owner: dead_owner,
                session_id: "stale".into(),
            },
        );

        assert!(
            todo_session_of(&live).is_none(),
            "a dead binding must not be served"
        );
        assert!(
            !live_bindings().lock().unwrap().contains_key(&key),
            "the dead binding must be cleared on lookup"
        );
    }
}
