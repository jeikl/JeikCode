//! `grep` — regex content search under a directory, codegraphignore-aware.
//! Read-only ⇒ always `Safe`. `.gitignore` / `.ignore` are intentionally NOT
//! applied: VCS ignore rules describe what should be committed, not what the user
//! may ask us to search. The curated `.codegraphignore` / `.codegraignore` noise
//! rules are the search-visibility authority; `include_ignored=true` bypasses the
//! non-sensitive noise/log layers. Sensitive paths from `.codegraphignore.graph` are excluded by
//! default; `include_sensitive=true` is approval-gated (Build prompts, Auto continues).
//! Smart-case when `case_insensitive` is omitted (insensitive unless the pattern has
//! an uppercase letter); `true`/`false` force the mode. Regex mode treats a bare `{`
//! as a literal (PCRE / GNU ERE semantics) instead of failing the build; a pattern
//! that is still invalid falls back to a literal search. Build/VCS/cache dirs are
//! skipped by default; log files are included only with `include_ignored=true`.
//! A `path` pointing at a single file ignores `glob`/`type`
//! so models that pass both do not get a spurious "0 files searched".

use super::read::lenient_usize;
use super::{err, for_each_project_entry, not_found_hint, ok, resolve_path};
use crate::tool_feedback::{format_path_not_found, parse_tool_args};
use async_trait::async_trait;
use globset::{GlobBuilder, GlobMatcher};
use grep::matcher::Matcher as _;
use grep::regex::{RegexMatcher, RegexMatcherBuilder};
use grep::searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use jeikcode_kernel::tool::{Tool, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

const DEFAULT_MAX_RESULTS: usize = 200;
const DEFAULT_CONTEXT: usize = 0;
const MAX_CONTEXT: usize = 10;
const MAX_DISPLAY_LINE: usize = 1000;
/// Hard upper cap on `max_results` — bounds the in-memory result buffer even if a
/// caller sends an enormous value.
const MAX_RESULTS_CAP: usize = 10_000;
/// Per-file heap cap for the searcher's line buffer. Without it the searcher would
/// grow the buffer to hold the LONGEST single line — a multi-MB minified bundle or a
/// one-line giant log would still buffer whole and OOM a small machine. Past this, the
/// file's search errors and is skipped: the absolute memory guard, independent of the
/// per-line default.
const MAX_LINE_BUF_BYTES: usize = 10 * 1024 * 1024;

/// Grok default tool-output budget (40 KB). Remainder: narrow path/glob or raise max_results.
const MAX_OUTPUT_BYTES: usize = 40_000;

pub struct GrepTool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    #[default]
    Content,
    FilesWithMatches,
    Count,
}

#[derive(Deserialize)]
struct Args {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, alias = "head_limit", deserialize_with = "lenient_usize")]
    max_results: Option<usize>,
    #[serde(default, alias = "-C", deserialize_with = "lenient_usize")]
    context: Option<usize>,
    /// File-name glob (`*.rs`, `*.{ts,tsx}`, `src/**/*.go`). Ripgrep-style:
    /// a pattern with no `/` matches at any depth.
    #[serde(default)]
    glob: Option<String>,
    #[serde(default, alias = "file_type")]
    r#type: Option<String>,
    #[serde(
        default,
        alias = "i",
        alias = "ignore_case",
        alias = "-i",
        deserialize_with = "lenient_bool"
    )]
    case_insensitive: Option<bool>,
    #[serde(default, alias = "regex", deserialize_with = "lenient_bool")]
    is_regex: Option<bool>,
    #[serde(
        default,
        alias = "word",
        alias = "-w",
        alias = "whole_word",
        deserialize_with = "lenient_bool"
    )]
    word_match: Option<bool>,
    #[serde(default)]
    output_mode: OutputMode,
    /// Bypass `.codegraphignore` / `.codegraignore` and show files normally
    /// filtered from search. `.gitignore` is never applied to search.
    #[serde(
        default,
        alias = "no_ignore",
        alias = "show_filtered",
        alias = "include_filtered"
    )]
    include_ignored: bool,
    /// Include sensitive credential paths. Approval-gated outside Auto mode.
    #[serde(
        default,
        alias = "show_sensitive",
        alias = "include_filtered_sensitive"
    )]
    include_sensitive: bool,
}

fn lenient_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Visitor;

    struct LenientBoolVisitor;

    impl<'de> Visitor<'de> for LenientBoolVisitor {
        type Value = Option<bool>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a boolean or string representation of a boolean")
        }

        fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
            Ok(Some(v))
        }

        fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v != 0))
        }

        fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v != 0))
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            match v.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Ok(Some(true)),
                "false" | "0" | "no" | "off" => Ok(Some(false)),
                _ => Ok(None),
            }
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
    }

    deserializer.deserialize_any(LenientBoolVisitor)
}

/// 检测模式串中是否包含反斜杠转义的 ASCII 标点符号（如 `\.`、`\(`、`\)`` 等），
/// 这种模式通常来源于 LLM 在字面量匹配时的防卫性转义或正则残留。
fn has_escaped_punctuation(p: &str) -> bool {
    let mut chars = p.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(&next) = chars.peek() {
                if next.is_ascii_punctuation() {
                    return true;
                }
            }
        }
    }
    false
}

/// 剥离对 ASCII 标点符号的反斜杠转义（例如 `\.register\(` -> `.register(`），
/// 用于在默认字面量搜空时自动还原真实的检索意图。
fn unescape_punctuation_escapes(p: &str) -> String {
    let mut res = String::with_capacity(p.len());
    let mut chars = p.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(&next) = chars.peek() {
                if next.is_ascii_punctuation() {
                    res.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        res.push(ch);
    }
    res
}

/// 花括号宽容化：rust regex 会把任何未转义的 `{` 强制按计数重复解析，像
/// `.sidebar {`、`function foo() {` 这类极常见的选择器/代码片段会直接让整串构建
/// 失败；而 PCRE / GNU ERE / JS 都把这些「非合法量词」的 `{` 视为字面量。
/// 该语义在此补齐：合法量词 `{n}` / `{n,}` / `{n,m}` 原样保留，其余未转义 `{`
/// 一律转义为字面量 `\{`。反斜杠转义对整体搬运，`\{`、`\\` 不受影响。
/// （`}` 无需处理：rust regex 允许未转义的 `}` 直接作为字面量。）
fn escape_bare_braces(pat: &str) -> String {
    let cs: Vec<char> = pat.chars().collect();
    let mut out = String::with_capacity(pat.len() + 8);
    let mut i = 0;
    while i < cs.len() {
        match cs[i] {
            '\\' => {
                out.push(cs[i]);
                if i + 1 < cs.len() {
                    out.push(cs[i + 1]);
                    i += 2;
                } else {
                    i += 1;
                }
            }
            '{' => match counted_repetition_chars(&cs[i..]) {
                Some(len) => {
                    out.extend(cs[i..i + len].iter());
                    i += len;
                }
                None => {
                    out.push_str("\\{");
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `cs` 以 `{` 开头时，判断其能否构成 rust regex 认可的计数重复
/// （`{n}` / `{n,}` / `{n,m}`，数字紧贴花括号），是则返回子串字符数。
fn counted_repetition_chars(cs: &[char]) -> Option<usize> {
    debug_assert_eq!(cs.first(), Some(&'{'));
    let mut end = 1;
    let digits_start = end;
    while end < cs.len() && cs[end].is_ascii_digit() {
        end += 1;
    }
    if end == digits_start {
        return None; // `{}`、`{abc` 等非量词
    }
    if end < cs.len() && cs[end] == ',' {
        end += 1;
        while end < cs.len() && cs[end].is_ascii_digit() {
            end += 1;
        }
    }
    if end < cs.len() && cs[end] == '}' {
        Some(end + 1)
    } else {
        None
    }
}

/// 构建正则匹配器：raw 构建失败时，用 `escape_bare_braces` 修正后重试一次，
/// 仍失败则返回原始错误（由调用方决定是否再降级为全量字面量）。
fn build_regex_lenient(
    pat: &str,
    case_insensitive: bool,
) -> Result<RegexMatcher, grep::regex::Error> {
    match RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive)
        .build(pat)
    {
        Ok(m) => Ok(m),
        Err(orig) => {
            let fixed = escape_bare_braces(pat);
            if fixed == pat {
                return Err(orig);
            }
            RegexMatcherBuilder::new()
                .case_insensitive(case_insensitive)
                .build(&fixed)
        }
    }
}

/// 智能嗅探 pattern 是否包含明显的正则表达式复合语法特征
/// 用于在默认字面量搜空时触发同轮静默重试，绝不将单个点号或标点误判为正则
fn has_regex_indicators(p: &str) -> bool {
    has_escaped_punctuation(p)
        || p.contains(".*")
        || p.contains(".+")
        || p.contains(r"\d")
        || p.contains(r"\D")
        || p.contains(r"\w")
        || p.contains(r"\W")
        || p.contains(r"\s")
        || p.contains(r"\S")
        || p.contains(r"\b")
        || p.contains(r"\B")
        || p.contains('|')
        || p.contains("(?:")
        || p.contains("(?i")
        || p.contains("(?-i")
        || p.contains("(?=")
        || p.contains("(?!")
        || p.contains("(?<=")
        || p.contains("(?<!")
        || (p.contains('^') && !p.contains("^^"))
        || (p.contains('$') && !p.starts_with('$') && !p.contains("$$"))
        || (p.contains('[')
            && p.contains(']')
            && (p.contains("0-9") || p.contains("a-z") || p.contains("A-Z")))
}

/// 字面量搜索零命中、pattern 里带 `.` / `{` / `}` 这类「既像正则又像普通文本」的
/// 歧义字符、且不含任何显式正则特征时，附加一行引导（绝不自动按正则重试——
/// 单个点号必须按字面量处理，避免 v1.2.3 / file.txt 这类模式被误判）。
fn literal_metachar_hint(p: &str) -> Option<&'static str> {
    if has_regex_indicators(p) || !(p.contains('.') || p.contains('{') || p.contains('}')) {
        return None;
    }
    Some("[grep: exact-text search — `.` / `{` / `}` are literal characters here. Retry with is_regex=true for regex semantics.]")
}

fn file_type_to_glob(t: &str) -> String {
    match t.trim().to_ascii_lowercase().as_str() {
        "rust" | "rs" => "*.rs".to_string(),
        "typescript" | "ts" => "*.{ts,tsx,mts,cts}".to_string(),
        "javascript" | "js" => "*.{js,jsx,mjs,cjs}".to_string(),
        "react" | "jsx" | "tsx" => "*.{jsx,tsx,js,ts}".to_string(),
        "vue" => "*.vue".to_string(),
        "svelte" => "*.svelte".to_string(),
        "python" | "py" => "*.py".to_string(),
        "go" | "golang" => "*.go".to_string(),
        "c" => "*.{c,h}".to_string(),
        "cpp" | "c++" | "cxx" | "cc" => "*.{cpp,cc,cxx,hpp,h}".to_string(),
        "csharp" | "c#" | "c-sharp" | "cs" => "*.cs".to_string(),
        "java" => "*.java".to_string(),
        "kotlin" | "kt" => "*.{kt,kts}".to_string(),
        "scala" => "*.{scala,sc}".to_string(),
        "swift" => "*.swift".to_string(),
        "ruby" | "rb" => "*.rb".to_string(),
        "php" => "*.php".to_string(),
        "dart" => "*.dart".to_string(),
        "html" | "htm" => "*.{html,htm}".to_string(),
        "css" | "scss" | "sass" | "less" => "*.{css,scss,sass,less}".to_string(),
        "json" | "jsonc" => "*.{json,jsonc}".to_string(),
        "yaml" | "yml" => "*.{yaml,yml}".to_string(),
        "toml" => "*.toml".to_string(),
        "xml" => "*.xml".to_string(),
        "proto" | "protobuf" => "*.proto".to_string(),
        "markdown" | "md" => "*.md".to_string(),
        "sh" | "bash" | "zsh" => "*.{sh,bash,zsh}".to_string(),
        "sql" => "*.sql".to_string(),
        other => {
            let clean = other.trim_start_matches('.');
            format!("*.{clean}")
        }
    }
}

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    fn description(&self) -> &str {
        "Search file contents by keyword or regular expression. Defaults exclude build/cache/dependency paths and logs; include_ignored=true opens them. Sensitive credentials require include_sensitive=true (approval) or read."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Text or regex pattern to search for."
                },
                "path": {
                    "type": "string",
                    "default": ".",
                    "description": "Path to search: directory for recursive search, or single file path. Defaults to '.'."
                },
                "glob": {
                    "type": "string",
                    "description": "File glob pattern to filter search (e.g. '*.rs', '*.{ts,tsx}')."
                },
                "type": {
                    "type": "string",
                    "description": "File type shortcut to filter search (e.g. 'rust', 'ts', 'py', 'go')."
                },
                "word_match": {
                    "type": "boolean",
                    "default": false,
                    "description": "Match whole words only."
                },
                "is_regex": {
                    "type": "boolean",
                    "default": false,
                    "description": "Whether pattern is a regular expression (default false). A `{` that is not a valid quantifier (e.g. `.sidebar {`) is matched literally."
                },
                "case_insensitive": {
                    "type": "boolean",
                    "default": true,
                    "description": "Case-insensitive matching (default true)."
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "default": "content",
                    "description": "Output mode: 'content', 'files_with_matches', or 'count'."
                },
                "context": {
                    "type": "integer",
                    "description": "Number of lines of context before and after each match."
                },
                "max_results": {
                    "type": "integer",
                    "default": 200,
                    "description": "Maximum number of matching lines or files to return (default 200)."
                },
                "include_ignored": {
                    "type": "boolean",
                    "default": false,
                    "description": "Include non-sensitive paths filtered from search: build artifacts, caches, dependencies, and logs (default false)."
                },
                "include_sensitive": {
                    "type": "boolean",
                    "default": false,
                    "description": "Include sensitive credential paths (default false). Requires approval outside Auto mode."
                }
            },
            "required": ["pattern"]
        })
    }
    /// No side effects — a pure read. Makes it `parallel_safe` (concurrent
    /// execution) and allowed in plan mode.
    fn read_only_hint(&self) -> bool {
        true
    }

    // read-only → risk() defaults to Safe.
    async fn execute(&self, args: &str, ctx: &ToolContext) -> ToolResult {
        let (a, mut recovered) = match parse_grep_args(args) {
            Ok(v) => v,
            Err(e) => return e.into_tool_result(),
        };
        let raw = a
            .path
            .clone()
            .unwrap_or_else(|| ".".to_string())
            .replace('\\', "/");
        let mut root = resolve_path(&raw, &ctx.working_dir);
        // 路径落空时的兜底（避免“报错 → 模型再猜一轮”）：
        // ① 工作区内存在唯一同名条目 → 直接搜它；
        // ② 否则退到最近的、仍在工作区内的已存在祖先目录（同时列出 did-you-mean 候选）；
        // ③ 都不可用（工作区外等）→ 保持原有报错语义（含最近祖先提示）。
        if tokio::fs::metadata(&root).await.is_err() {
            match missing_path_fallback(&root, &ctx.working_dir).await {
                Some((fallback, notice)) => {
                    root = fallback;
                    recovered = Some(match recovered {
                        Some(prev) => format!("{prev}\n{notice}"),
                        None => notice,
                    });
                }
                None => {
                    let hint = not_found_hint(&root, &ctx.working_dir).await;
                    return err(format!(
                        "{}{hint}",
                        format_path_not_found("grep", &raw, &root, &ctx.working_dir)
                    ));
                }
            }
        }
        let root_meta = match tokio::fs::metadata(&root).await {
            Ok(m) => m,
            Err(_) => {
                let hint = not_found_hint(&root, &ctx.working_dir).await;
                return err(format!(
                    "{}{hint}",
                    format_path_not_found("grep", &raw, &root, &ctx.working_dir)
                ));
            }
        };
        let root_is_file = root_meta.is_file();
        let max = a
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, MAX_RESULTS_CAP);
        let context_lines = a.context.unwrap_or(DEFAULT_CONTEXT).min(MAX_CONTEXT);
        let before_ctx = context_lines;
        let after_ctx = context_lines;
        let effective_glob = a
            .glob
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                a.r#type
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(file_type_to_glob)
            });
        // A `path` that names a single file must still be searched even if the model
        // also sent `glob`/`type` (the common "path=file.rs + glob=*.rs" trap: the
        // walk root is the file, strip_prefix is empty, glob matches nothing →
        // "0 files searched"). Ignore the filter and tell the model to omit it next time.
        let glob_ignored_on_file = root_is_file && effective_glob.is_some();
        let glob_filter = if glob_ignored_on_file {
            None
        } else {
            match effective_glob.as_deref() {
                None => None,
                Some(g) => match GlobBuilder::new(g).literal_separator(true).build() {
                    Ok(glob) => Some((glob.compile_matcher(), g.to_string())),
                    Err(e) => return err(format!("grep: invalid glob '{g}': {e}")),
                },
            }
        };

        // Defaults to case-insensitive for agent exploration unless explicitly forced via false.
        let is_case_insensitive = a.case_insensitive.unwrap_or(true);
        let explicit_regex = a.is_regex.unwrap_or(false);
        let word_bounded = a.word_match.unwrap_or(false);
        let make_pat = move |raw: &str, is_escaped: bool| -> String {
            if word_bounded {
                if is_escaped {
                    format!(r"\b{}\b", raw)
                } else {
                    format!(r"\b(?:{})\b", raw)
                }
            } else {
                raw.to_string()
            }
        };

        let initial_matcher = if explicit_regex {
            let pat = make_pat(&a.pattern, false);
            // 花括号宽容构建：`.sidebar {` / `function foo() {` 里的裸 `{` 不再让整串
            // 正则构建失败（转而按字面量匹配），保住 `.`、`.*` 等真实正则语义。
            match build_regex_lenient(&pat, is_case_insensitive) {
                Ok(m) => m,
                Err(_) => {
                    let esc = regex::escape(&a.pattern);
                    let pat = make_pat(&esc, true);
                    match RegexMatcherBuilder::new()
                        .case_insensitive(is_case_insensitive)
                        .build(&pat)
                    {
                        Ok(m) => m,
                        Err(e) => {
                            return err(format!("grep: invalid pattern '{}': {e}", a.pattern))
                        }
                    }
                }
            }
        } else {
            let esc = regex::escape(&a.pattern);
            let pat = make_pat(&esc, true);
            match RegexMatcherBuilder::new()
                .case_insensitive(is_case_insensitive)
                .build(&pat)
            {
                Ok(m) => m,
                Err(e) => return err(format!("grep: invalid pattern '{}': {e}", a.pattern)),
            }
        };

        let base = ctx.working_dir.clone();
        let pattern = a.pattern.clone();
        let search_pattern = pattern.clone();
        let display_path = raw.clone();
        let search_secs = super::tool_timeouts().search_secs;
        let deadline = Instant::now() + Duration::from_secs(search_secs);
        let output_mode = a.output_mode;
        let include_ignored = a.include_ignored;
        let include_sensitive = a.include_sensitive;
        let res = tokio::task::spawn_blocking(move || {
            let mut result = search(
                &root,
                &initial_matcher,
                max,
                before_ctx,
                after_ctx,
                output_mode,
                &base,
                glob_filter.as_ref(),
                include_ignored,
                include_sensitive,
                deadline,
            );

            // 零额外交互静默自愈：若默认字面量搜索 0 匹配（lines 为空）且处于字面量模式（!explicit_regex），
            // 启动分层递进自愈机制：
            // 1. 优先尝试「去转义字面量重试」：模型常在字面量搜索中防卫性转义元字符（如 \.register\(、items\[0\]），
            //    剥离反斜杠转义后按字面量重新搜索，既精准又消除正则元字符副作用；
            // 2. 若仍未匹配，且具有明显正则表达式复合语法特征（如 .*、\s+、\d+、| 等），
            //    尝试作为「原生正则表达式」重试，实现免翻车救活。
            if result.0.is_empty() && !explicit_regex && Instant::now() < deadline {
                if has_escaped_punctuation(&search_pattern) {
                    let unescaped = unescape_punctuation_escapes(&search_pattern);
                    if unescaped != search_pattern {
                        let esc = regex::escape(&unescaped);
                        let pat = make_pat(&esc, true);
                        if let Ok(retry_matcher) = RegexMatcherBuilder::new()
                            .case_insensitive(is_case_insensitive)
                            .build(&pat)
                        {
                            let retry_res = search(
                                &root,
                                &retry_matcher,
                                max,
                                before_ctx,
                                after_ctx,
                                output_mode,
                                &base,
                                glob_filter.as_ref(),
                                include_ignored,
                                include_sensitive,
                                deadline,
                            );
                            if !retry_res.0.is_empty() {
                                result = retry_res;
                            }
                        }
                    }
                }

                if result.0.is_empty()
                    && has_regex_indicators(&search_pattern)
                    && Instant::now() < deadline
                {
                    // 花括号宽容构建：`side.*rail {` 这类含裸 `{` 的正则特征模式
                    // 此前会因构建失败被静默丢弃，现在可以正常救活。
                    if let Ok(retry_matcher) =
                        build_regex_lenient(&make_pat(&search_pattern, false), is_case_insensitive)
                    {
                        let retry_res = search(
                            &root,
                            &retry_matcher,
                            max,
                            before_ctx,
                            after_ctx,
                            output_mode,
                            &base,
                            glob_filter.as_ref(),
                            include_ignored,
                            include_sensitive,
                            deadline,
                        );
                        if !retry_res.0.is_empty() {
                            result = retry_res;
                        }
                    }
                }
            }

            // Zero matches: look for files hidden by `.codegraphignore` that
            // actually contain this pattern. Sensitive files are never read here;
            // their hint is a path-level hard-exclusion notice.
            let hint = result.0.is_empty().then(|| {
                super::search_visibility_hint(&root, include_sensitive, include_ignored, |path| {
                    file_matches_pattern(&initial_matcher, path)
                })
            });
            (result, hint)
        })
        .await;
        match res {
            Ok(((lines, _, files, timed_out), hint)) if lines.is_empty() => {
                let mut msg = format!(
                    "No matches found for '{pattern}' in {display_path} ({files} files searched)"
                );
                if timed_out {
                    msg.push_str(
                        "\n[Search timed out; narrow `path` / `glob` or use code_explore]",
                    );
                }
                let hint = hint.unwrap_or_default();
                let examples = |paths: &[std::path::PathBuf]| {
                    paths
                        .iter()
                        .take(3)
                        .map(|p| crate::pathnorm::to_display(p))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                if !hint.sensitive.is_empty() {
                    msg.push_str(&format!(
                        "\n[Sensitive path hint: {} credential file(s) under this path are excluded from search (e.g. {}). Use `read` with explicit approval, or retry with include_sensitive=true (approval required outside Auto mode).]",
                        hint.sensitive.len(),
                        examples(&hint.sensitive)
                    ));
                } else if !include_ignored && !hint.logs.is_empty() {
                    msg.push_str(&format!(
                        "\n[Log search hint: {} log file(s) under this path are excluded from grep by default (e.g. {}). If the target is one of them, retry with include_ignored=true; prefer output_mode=\"files_with_matches\" first.]",
                        hint.logs.len(),
                        examples(&hint.logs)
                    ));
                } else if !include_ignored && !hint.noise.is_empty() {
                    msg.push_str(&format!(
                        "\n[Search ignore hint: {} file(s) under this path are excluded by `.codegraphignore` (e.g. {}). If the target is one of them, retry with include_ignored=true.]",
                        hint.noise.len(),
                        examples(&hint.noise)
                    ));
                }
                if !explicit_regex {
                    if let Some(hint) = literal_metachar_hint(&pattern) {
                        msg.push('\n');
                        msg.push_str(hint);
                    }
                }
                if let Some(note) = recovered {
                    msg = format!("{note}\n{msg}");
                }
                ok(msg)
            }
            Ok(((lines, matches, _, timed_out), _)) => {
                let mut out = match a.output_mode {
                    OutputMode::FilesWithMatches => {
                        format!("{} files with matches:\n{}", lines.len(), lines.join("\n"))
                    }
                    OutputMode::Count | OutputMode::Content => lines.join("\n"),
                };
                let byte_overflow = out.len() > MAX_OUTPUT_BYTES;
                let hint = grep_overflow_hint(&GrepOverflow {
                    matches,
                    max,
                    lines: &lines,
                    mode: a.output_mode,
                    timed_out,
                    byte_overflow,
                    include_ignored,
                    has_context: before_ctx > 0 || after_ctx > 0,
                });
                if byte_overflow {
                    out = truncate_grep_output(&lines, a.output_mode, &hint);
                } else if !hint.is_empty() {
                    out.push_str("\n\n");
                    out.push_str(&hint);
                }
                if let Some(note) = recovered {
                    out = format!("{note}\n{out}");
                }
                ok(out)
            }
            Err(_) => err("grep: search task failed".to_string()),
        }
    }
}

const GREP_SHAPE: &str = r#"{"pattern":"<regex>","path":"<dir>"}"#;

/// 目标路径不存在时的兜底搜索根（含写进输出的告示）。
///
/// 返回 `None` 表示不应兜底（例如最近祖先在工作区之外），调用方保留原有报错语义。
async fn missing_path_fallback(
    resolved: &Path,
    working_dir: &Path,
) -> Option<(std::path::PathBuf, String)> {
    let leaf = resolved.file_name()?.to_string_lossy().to_string();
    let display = crate::pathnorm::to_display(resolved);
    // ① 工作区内同名候选（最多列 5 个；唯一时才自动选中）。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(800);
    // The requested path is missing; include ignored files so a same-named
    // local doc is still discovered and reported as a fallback candidate. Keep
    // sensitive files out of the automatic fallback.
    for_each_project_entry(working_dir, false, true, true, false, |entry| {
        if Instant::now() >= deadline || candidates.len() >= 6 {
            return false;
        }
        if entry.file_name().to_string_lossy() == leaf {
            candidates.push(entry.path().to_path_buf());
        }
        true
    });
    if candidates.len() == 1 {
        let candidate = candidates.remove(0);
        return Some((
            candidate.clone(),
            format!(
                "⚠ grep: path not found: {display} \u{2014} searched the only same-named entry instead: {}",
                crate::pathnorm::to_display(&candidate)
            ),
        ));
    }
    let did_you_mean = if candidates.is_empty() {
        String::new()
    } else {
        let listed: Vec<String> = candidates
            .iter()
            .map(|path| crate::pathnorm::to_display(path))
            .collect();
        format!("\ndid you mean: {}", listed.join(", "))
    };
    // ② 最近的、仍在工作区内的已存在祖先目录。
    // 路径含 `..` 时必须 canonicalize 后再比：词法 `starts_with` 会把 `wd/..` 误判成在 wd 内。
    let mut ancestor = resolved.parent();
    while let Some(dir) = ancestor {
        if let Ok(canonical) = tokio::fs::canonicalize(dir).await {
            let base = tokio::fs::canonicalize(working_dir)
                .await
                .unwrap_or_else(|_| working_dir.to_path_buf());
            if canonical.starts_with(&base) {
                return Some((
                    canonical.clone(),
                    format!(
                        "⚠ grep: path not found: {display} \u{2014} searched from the nearest existing directory instead: {}{did_you_mean}",
                        crate::pathnorm::to_display(&canonical)
                    ),
                ));
            }
            break;
        }
        ancestor = dir.parent();
    }
    None
}

fn parse_grep_args(args: &str) -> Result<(Args, Option<String>), crate::tool_feedback::ParamError> {
    if let Ok(a) = parse_tool_args::<Args>("grep", args, GREP_SHAPE) {
        if !a.pattern.trim().is_empty() {
            return Ok((a, None));
        }
    }
    let mut v: Value = serde_json::from_str(args).unwrap_or_else(|_| json!({}));
    let note = recover_pattern_into(&mut v);
    let dumped = serde_json::to_string(&v).unwrap_or_else(|_| args.to_string());
    match parse_tool_args::<Args>("grep", &dumped, GREP_SHAPE) {
        Ok(a) if !a.pattern.trim().is_empty() => Ok((a, note)),
        _ => parse_tool_args::<Args>("grep", args, GREP_SHAPE).map(|a| (a, None)),
    }
}

/// Weak models put `pattern`/`path` inside `description` as
/// `[Constraint: path: foo.cs, pattern: Bar]` (or only `pattern:`) instead of
/// JSON fields. Recover both so grep does not bounce with `missing_field`.
fn recover_pattern_into(v: &mut Value) -> Option<String> {
    let obj = v.as_object_mut()?;
    let constraint = obj
        .get("description")
        .and_then(|p| p.as_str())
        .map(extract_constraint_fields)
        .unwrap_or_default();

    let mut recovered_from = Vec::new();
    let has_pattern = obj
        .get("pattern")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if !has_pattern {
        let mut found: Option<(String, String)> = None;
        for key in ["query", "regex", "search", "q"] {
            if let Some(s) = obj
                .get(key)
                .and_then(|p| p.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                found = Some((key.to_string(), s.to_string()));
                break;
            }
        }
        if found.is_none() {
            if let Some(p) = constraint.pattern.clone() {
                found = Some(("description".into(), p));
            }
        }
        if let Some((src, pat)) = found {
            obj.insert("pattern".into(), Value::String(pat.clone()));
            recovered_from.push(format!("pattern←{src}({pat})"));
        }
    }

    let has_path = obj
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if !has_path {
        if let Some(p) = constraint.path.clone() {
            obj.insert("path".into(), Value::String(p.clone()));
            recovered_from.push(format!("path←description({p})"));
        }
    }

    let has_glob = obj
        .get("glob")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if !has_glob {
        if let Some(g) = constraint.glob.clone() {
            obj.insert("glob".into(), Value::String(g));
        }
    }

    if recovered_from.is_empty() {
        return None;
    }
    let pat = obj
        .get("pattern")
        .and_then(|p| p.as_str())
        .unwrap_or("<regex>");
    let path = obj.get("path").and_then(|p| p.as_str()).unwrap_or("<dir>");
    Some(format!(
        "[grep: recovered {} — next call use {{\"pattern\":\"{pat}\",\"path\":\"{path}\"}}]",
        recovered_from.join(", ")
    ))
}

#[derive(Default)]
struct ConstraintFields {
    pattern: Option<String>,
    path: Option<String>,
    glob: Option<String>,
}

fn extract_constraint_fields(desc: &str) -> ConstraintFields {
    let mut out = ConstraintFields::default();
    for key in ["pattern", "query", "regex", "path", "glob"] {
        if let Some(val) = extract_constraint_value(desc, key) {
            match key {
                "pattern" | "query" | "regex" if out.pattern.is_none() => {
                    out.pattern = Some(val);
                }
                "path" if out.path.is_none() => out.path = Some(val),
                "glob" if out.glob.is_none() => out.glob = Some(val),
                _ => {}
            }
        }
    }
    out
}

fn extract_constraint_value(desc: &str, key: &str) -> Option<String> {
    let lower = desc.to_ascii_lowercase();
    let needle = format!("{key}:");
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find(&needle) {
        let abs = search_from + rel;
        let boundary_ok = abs == 0
            || desc.as_bytes()[abs - 1].is_ascii_whitespace()
            || matches!(desc.as_bytes()[abs - 1], b'[' | b',' | b'{' | b'(');
        if !boundary_ok {
            search_from = abs + 1;
            continue;
        }
        let rest = desc[abs + needle.len()..].trim_start();
        let end = next_constraint_field_start(rest);
        let raw = rest.get(..end).unwrap_or(rest);
        let val = raw
            .trim()
            .trim_end_matches([']', '}', ')'])
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim();
        if !val.is_empty() {
            return Some(val.to_string());
        }
        search_from = abs + 1;
    }
    None
}

/// End of a Constraint value: next `, <known-key>:` or closing bracket.
fn next_constraint_field_start(rest: &str) -> usize {
    const KEYS: &[&str] = &["pattern:", "query:", "regex:", "path:", "glob:", "search:"];
    let mut cut = rest
        .find(']')
        .or_else(|| rest.find('}'))
        .unwrap_or(rest.len());
    for (i, ch) in rest.char_indices() {
        if i >= cut {
            break;
        }
        if ch != ',' {
            continue;
        }
        let after = rest[i + 1..].trim_start();
        let after_l = after.to_ascii_lowercase();
        if KEYS.iter().any(|k| after_l.starts_with(k)) {
            cut = i;
            break;
        }
    }
    cut
}

/// Shape of a grep result that filled the display window. The hint tells the
/// model which strategy to switch to instead of blindly raising `max_results`.
struct GrepOverflow<'a> {
    matches: usize,
    max: usize,
    lines: &'a [String],
    mode: OutputMode,
    timed_out: bool,
    byte_overflow: bool,
    include_ignored: bool,
    has_context: bool,
}

fn grep_overflow_hint(o: &GrepOverflow<'_>) -> String {
    let mut files: Vec<&str> = Vec::new();
    for line in o.lines {
        if let Some(path) = grep_match_path(line) {
            if !files.contains(&path) {
                files.push(path);
            }
        }
    }
    let file_count = files.len();
    let first = files.first().copied().unwrap_or("<file>");
    let broad_scan = if o.include_ignored {
        " include_ignored=true expanded the scan to logs/build artifacts; narrow path/glob (e.g. path=\"logs\") to keep it focused."
    } else {
        ""
    };

    if o.timed_out {
        return format!(
            "[Search timed out after the configured limit. Next: narrow path/glob{}, or use code_explore for a semantic query.]",
            if o.include_ignored {
                ", set include_ignored=false"
            } else {
                ""
            }
        );
    }

    if o.byte_overflow {
        if file_count <= 1 {
            return format!(
                "[Output exceeded 40KB in {first}. Next: grep(path=\"{first}\", max_results=50) or read(path=\"{first}\", keyword=\"...\", upward=20, downward=60); use output_mode=\"count\" to gauge volume.]{broad_scan}"
            );
        }
        return format!(
            "[Output exceeded 40KB across {file_count} files. Next: switch output_mode to \"files_with_matches\" or \"count\", then grep one path at a time; remove -C context if not needed.]{broad_scan}"
        );
    }

    if o.matches < o.max {
        return String::new();
    }

    let mode_hint = match o.mode {
        OutputMode::FilesWithMatches => {
            "The file list itself hit the cap; narrow path/glob or use output_mode=\"count\"."
        }
        OutputMode::Count => {
            "The count rows hit the cap; narrow path/glob or add a more specific pattern."
        }
        OutputMode::Content if file_count <= 1 => "",
        OutputMode::Content if file_count <= 3 => {
            "Next: switch output_mode=\"files_with_matches\" or \"count\", then grep one path at a time."
        }
        OutputMode::Content => {
            "Next: switch output_mode=\"files_with_matches\", pick 1-2 paths, and narrow with path/glob."
        }
    };

    let content_hint = if o.mode == OutputMode::Content && file_count <= 1 {
        format!(
            "Next: grep(path=\"{first}\", max_results=50) or read(path=\"{first}\", keyword=\"...\", upward=20, downward=60) for a focused window."
        )
    } else {
        mode_hint.to_string()
    };
    let context_hint = if o.has_context {
        " Drop -C context if not needed."
    } else {
        ""
    };
    format!(
        "[Output window full: {} matches across {file_count} files. {content_hint}{context_hint}{broad_scan}]",
        o.matches
    )
}

/// When content mode blows the 40KB display budget, return a file-list summary plus a
/// short prefix of matches. Raising `max_results` cannot increase this byte cap.
fn truncate_grep_output(lines: &[String], mode: OutputMode, hint: &str) -> String {
    let mut files: Vec<String> = Vec::new();
    for line in lines {
        if let Some(path) = grep_match_path(line) {
            if !files.iter().any(|f| f == path) {
                files.push(path.to_string());
            }
        }
    }
    let mut summary = if hint.is_empty() {
        format!(
            "[Content exceeded 40KB ({} output lines across {} files).]\nFiles with matches:\n",
            lines.len(),
            files.len()
        )
    } else {
        format!("{hint}\nFiles with matches:\n")
    };
    const FILE_LIST_CAP: usize = 80;
    for f in files.iter().take(FILE_LIST_CAP) {
        summary.push_str(f);
        summary.push('\n');
    }
    if files.len() > FILE_LIST_CAP {
        summary.push_str(&format!("… +{} more files\n", files.len() - FILE_LIST_CAP));
    }
    if mode == OutputMode::FilesWithMatches {
        return summary;
    }
    summary.push_str("\nFirst matches (byte-capped):\n");
    let budget = MAX_OUTPUT_BYTES.saturating_sub(summary.len().saturating_add(80));
    let mut body = String::new();
    for line in lines {
        if body.len().saturating_add(line.len()).saturating_add(1) > budget {
            break;
        }
        body.push_str(line);
        body.push('\n');
    }
    summary.push_str(&body);
    summary
}

/// Best-effort path extraction from a grep output line:
/// - `path:12:text` (match) / `path-12-text` (context) / `path: 3 matches` (count)
/// - `path` (files_with_matches)
fn grep_match_path(line: &str) -> Option<&str> {
    if line == "--" || line.is_empty() {
        return None;
    }
    if let Some(idx) = line.find(": ") {
        if line[idx + 2..].contains("match") {
            return Some(&line[..idx]);
        }
    }
    for (i, ch) in line.char_indices() {
        if ch != ':' && ch != '-' {
            continue;
        }
        let rest = &line[i + 1..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            continue;
        }
        let after = rest.get(digits..).unwrap_or("");
        let sep_ok = match (ch, after.chars().next()) {
            (':', Some(':')) | ('-', Some('-')) => true,
            (':', None) => true,
            _ => false,
        };
        if sep_ok {
            return Some(&line[..i]);
        }
    }
    Some(line)
}

/// Returns (formatted match+context lines, match count, files searched). Stops once
/// `max` matches are collected. Each file is searched by a STREAMING searcher (never
/// loads the whole file into memory; `heap_limit` caps the per-line buffer), so a huge
/// file — or a huge single line — can't OOM the process.
/// Ripgrep-style glob: `*.rs` matches at any depth; `src/**/*.rs` is path-relative.
fn grep_glob_matches(rel: &Path, matcher: &GlobMatcher, pattern: &str) -> bool {
    // WalkBuilder on a single-file root yields that file; strip_prefix is empty, and
    // `*.rs` would otherwise match nothing. An explicitly named file always searches.
    if rel.as_os_str().is_empty() {
        return true;
    }
    if matcher.is_match(rel) {
        return true;
    }
    if !pattern.contains('/') && !pattern.contains('\\') {
        if let Some(name) = rel.file_name() {
            return matcher.is_match(Path::new(name));
        }
    }
    false
}

/// Content check for a zero-match visibility hint. Only `.codegraphignore`
/// noise files reach this helper; sensitive files are never read for a hint.
fn file_matches_pattern(matcher: &RegexMatcher, path: &Path) -> bool {
    const MAX_HINT_FILE_BYTES: u64 = 2 * 1024 * 1024;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > MAX_HINT_FILE_BYTES {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes.contains(&0) {
        return false;
    }
    matcher.is_match(&bytes).unwrap_or(false)
}

fn search(
    root: &std::path::Path,
    matcher: &RegexMatcher,
    max: usize,
    before_ctx: usize,
    after_ctx: usize,
    output_mode: OutputMode,
    base: &std::path::Path,
    glob_filter: Option<&(GlobMatcher, String)>,
    include_ignored: bool,
    include_sensitive: bool,
    deadline: Instant,
) -> (Vec<String>, usize, usize, bool) {
    let mut out: Vec<String> = Vec::new();
    let mut match_count = 0usize;
    let mut files_searched = 0usize;
    let mut timed_out = false;

    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .before_context(before_ctx)
        .after_context(after_ctx)
        // Treat NUL-containing files as binary and stop (ripgrep-standard). Non-UTF-8
        // text is searched lossily rather than skipped, so ASCII patterns still match in
        // e.g. a GBK-encoded file (the old whole-file read skipped those entirely).
        .binary_detection(BinaryDetection::quit(b'\x00'))
        // Absolute memory guard: cap the per-file line buffer so a single huge line
        // (minified bundle / one-line log) can't grow the buffer without bound.
        .heap_limit(Some(MAX_LINE_BUF_BYTES))
        .build();

    // hidden=false: search must find dotfiles such as `.env` when explicitly asked.
    // `.jeikcode_store` is still visited even when gitignored, so uploaded
    // attachments stay searchable.
    for_each_project_entry(
        root,
        false,
        include_ignored,
        include_ignored,
        include_sensitive,
        |entry| {
            if Instant::now() >= deadline {
                timed_out = true;
                return false;
            }
            if match_count >= max {
                return false;
            }
            let path = entry.path();
            if !path.is_file() {
                return true;
            }
            if let Some((glob, pat)) = glob_filter {
                let rel = path.strip_prefix(root).unwrap_or(path);
                if !grep_glob_matches(rel, glob, pat) {
                    return true;
                }
            }
            // Log contents are high-cost and high-noise. `include_ignored=true` is
            // the explicit "search logs too" switch; it also ascends LOG_DIRS.
            if !include_ignored
                && path
                    .extension()
                    .map(|x| x.eq_ignore_ascii_case("log"))
                    .unwrap_or(false)
            {
                return true;
            }
            files_searched += 1;
            if files_searched % 64 == 0 {
                std::thread::yield_now();
            }
            let rel = crate::pathnorm::to_display(path.strip_prefix(base).unwrap_or(path));
            let mut file_matches = 0usize;
            {
                let mut sink = GrepSink {
                    rel: &rel,
                    out: &mut out,
                    match_count: &mut match_count,
                    max,
                    output_mode,
                    file_matches: &mut file_matches,
                };
                // io / binary / decode errors ⇒ skip the file (same as the old read failure).
                let _ = searcher.search_path(matcher, path, &mut sink);
            }
            if output_mode == OutputMode::Count && file_matches > 0 {
                out.push(format!("{}: {} matches", rel, file_matches));
            }
            true
        },
    );
    (out, match_count, files_searched, timed_out)
}

/// Render a raw line (bytes from the searcher) for display: strip the trailing line
/// ending, lossily decode, and truncate an over-long (e.g. minified) line.
fn render_line(bytes: &[u8]) -> String {
    let cow = String::from_utf8_lossy(bytes);
    let line = cow.strip_suffix('\n').unwrap_or(&cow);
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.chars().count() > MAX_DISPLAY_LINE {
        line.chars().take(MAX_DISPLAY_LINE).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

/// Sink that formats each match/context line:
/// - OutputMode::Content: `rel:num:content` for a match, `rel-num-content` for context, `--` between non-contiguous groups.
/// - OutputMode::FilesWithMatches: pushes `rel` once, stops file search immediately.
/// - OutputMode::Count: tallies matches in the file.
struct GrepSink<'a> {
    rel: &'a str,
    out: &'a mut Vec<String>,
    match_count: &'a mut usize,
    max: usize,
    output_mode: OutputMode,
    file_matches: &'a mut usize,
}

impl<'a> Sink for GrepSink<'a> {
    type Error = std::io::Error;

    fn matched(&mut self, _s: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, std::io::Error> {
        *self.file_matches += 1;
        match self.output_mode {
            OutputMode::FilesWithMatches => {
                self.out.push(self.rel.to_string());
                *self.match_count += 1;
                Ok(false) // stop searching this file immediately upon 1st match
            }
            OutputMode::Count => {
                *self.match_count += 1;
                Ok(*self.match_count < self.max)
            }
            OutputMode::Content => {
                let n = mat.line_number().unwrap_or(0);
                self.out
                    .push(format!("{}:{n}:{}", self.rel, render_line(mat.bytes())));
                *self.match_count += 1;
                Ok(*self.match_count < self.max) // stop this file at the cap
            }
        }
    }

    fn context(&mut self, _s: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, std::io::Error> {
        if self.output_mode == OutputMode::Content {
            let n = ctx.line_number().unwrap_or(0);
            self.out
                .push(format!("{}-{n}-{}", self.rel, render_line(ctx.bytes())));
        }
        Ok(true)
    }

    fn context_break(&mut self, _s: &Searcher) -> Result<bool, std::io::Error> {
        if self.output_mode == OutputMode::Content {
            self.out.push("--".to_string());
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::tool::ToolContext;
    use tokio_util::sync::CancellationToken;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext {
            working_dir: dir.to_path_buf(),
            cancel: CancellationToken::new(),
            progress: jeikcode_kernel::tool::ProgressSink::noop(),
            requester: None,
        }
    }

    #[tokio::test]
    async fn finds_matches_with_line_numbers() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("a.rs"),
            "fn main() {\n    let TODO = 1;\n    other();\n}\n",
        )
        .unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"TODO","path":"."}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("a.rs:2:"), "{}", r.content);
    }

    /// The real-world shape (a Windows user, 2026-08-05): a Gradle project whose `app/` has no
    /// `src/`. The model grepped `app/src`, got a bare "path not found", and spent the next
    /// three turns guessing deeper paths.
    ///
    /// 现在不再只是报错：目标路径落空时自动退到“最近的、仍在工作区内的已存在目录”（此处
    /// 即 `app/`）继续搜索，并把落空事实写进输出头部，一次调用就拿到信号。
    #[tokio::test]
    async fn missing_path_falls_back_to_the_nearest_existing_ancestor() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("app")).unwrap();
        std::fs::write(d.path().join("app/build.gradle"), "dependencies { Serial }").unwrap();
        let r = GrepTool
            .execute(
                r#"{"pattern":"Serial","path":"app/src/main/java"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("path not found"), "{}", r.content);
        assert!(
            r.content.contains("nearest existing directory"),
            "{}",
            r.content
        );
        // 兜底根是 app/，因此能搜到里面的文件。
        assert!(r.content.contains("build.gradle"), "{}", r.content);
    }

    /// 目标文件落空、但工作区内只有一个同名条目 → 直接搜它（did-you-mean 单命中）。
    #[tokio::test]
    async fn missing_file_path_searches_the_only_same_named_entry() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("nested/deep")).unwrap();
        std::fs::write(d.path().join("nested/deep/target.ts"), "NEEDLE here\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE","path":"target.ts"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("same-named entry"), "{}", r.content);
        assert!(r.content.contains("NEEDLE here"), "{}", r.content);
    }

    /// 工作区之外的落空路径不兜底（否则会搜整个盘）：保留原有报错语义。
    #[tokio::test]
    async fn missing_path_outside_the_workspace_still_errors() {
        let d = tempfile::tempdir().unwrap();
        let r = GrepTool
            .execute(
                r#"{"pattern":"x","path":"../outside-worktree"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("does not exist"), "{}", r.content);
    }

    // Issue #722 parity (v2): weak models send max_results/context as a string ("50")
    // or float (50.0 / "3.0") instead of an integer; the args must still deserialize.
    #[test]
    fn args_accept_lenient_numeric_max_results_and_context() {
        let a: Args = serde_json::from_str(r#"{"pattern":"x","max_results":"50","context":3.0}"#)
            .expect("string max_results + float context must deserialize");
        assert_eq!(a.max_results, Some(50));
        assert_eq!(a.context, Some(3));

        let b: Args = serde_json::from_str(r#"{"pattern":"x","max_results":"50.0"}"#)
            .expect("float-string max_results must deserialize");
        assert_eq!(b.max_results, Some(50));
    }

    #[tokio::test]
    async fn smart_case_is_insensitive_for_lowercase_pattern() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "Hello World\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"hello"}"#, &ctx(d.path()))
            .await;
        assert!(r.content.contains("a.txt:1:"), "{}", r.content);
    }

    #[tokio::test]
    async fn zero_matches_is_success() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "nothing here\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"absent_xyz"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "zero matches must be a success: {}", r.content);
        assert!(r.content.contains("No matches found"), "{}", r.content);
    }

    #[tokio::test]
    async fn invalid_regex_falls_back_to_literal() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "value = foo(bar)\n").unwrap();
        // "foo(bar" is an invalid regex (unbalanced paren) → literal fallback finds it.
        let r = GrepTool
            .execute(r#"{"pattern":"foo(bar"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("a.txt:1:"), "{}", r.content);
    }

    #[tokio::test]
    async fn code_symbols_with_parentheses_and_brackets_matched_by_default() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("code.rs"),
            "if status.is_success() {\n    let val = arr[0];\n}\n",
        )
        .unwrap();

        // 1. 默认精确字面量：带圆括号的代码调用绝不被捕获组吞掉
        let r1 = GrepTool
            .execute(r#"{"pattern":"status.is_success()"}"#, &ctx(d.path()))
            .await;
        assert!(!r1.is_error, "{}", r1.content);
        assert!(r1.content.contains("code.rs:1:"), "{}", r1.content);

        // 2. 默认精确字面量：带方括号的数组索引绝不被字符集匹配误杀
        let r2 = GrepTool
            .execute(r#"{"pattern":"arr[0]"}"#, &ctx(d.path()))
            .await;
        assert!(!r2.is_error, "{}", r2.content);
        assert!(r2.content.contains("code.rs:2:"), "{}", r2.content);
    }

    #[tokio::test]
    async fn auto_fallback_to_regex_when_literal_misses() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("log.rs"), "let log_fatal_error = true;\n").unwrap();

        // 未显式传 is_regex，但 pattern 包含明显的 .* 正则语法，字面量搜空后自动静默自愈
        let r = GrepTool
            .execute(r#"{"pattern":"log.*error"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("log.rs:1:"), "{}", r.content);
    }

    #[tokio::test]
    async fn lenient_bool_deserialization_test() {
        let a: Args =
            serde_json::from_str(r#"{"pattern":"x","is_regex":"true","case_insensitive":"false"}"#)
                .expect("string booleans must deserialize smoothly");
        assert_eq!(a.is_regex, Some(true));
        assert_eq!(a.case_insensitive, Some(false));
    }

    #[tokio::test]
    async fn context_lines_are_marked_and_groups_separated() {
        let d = tempfile::tempdir().unwrap();
        // 10 lines, matches on line 2 and line 8 → two non-contiguous groups at context 1.
        let content = (1..=10)
            .map(|i| match i {
                2 => "NEEDLE two".to_string(),
                8 => "NEEDLE eight".to_string(),
                _ => format!("line {i}"),
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("f.txt"), content + "\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE","context":1}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        // Match lines use `:`, context lines use `-`.
        assert!(
            r.content.contains("f.txt:2:NEEDLE two"),
            "match line: {}",
            r.content
        );
        assert!(
            r.content.contains("f.txt-1-line 1"),
            "before-context: {}",
            r.content
        );
        assert!(
            r.content.contains("f.txt-3-line 3"),
            "after-context: {}",
            r.content
        );
        assert!(
            r.content.contains("f.txt:8:NEEDLE eight"),
            "second match: {}",
            r.content
        );
        // Non-contiguous groups are separated by `--`.
        assert!(
            r.content.contains("\n--\n"),
            "group separator: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn searches_a_large_file_via_streaming_not_whole_read() {
        let d = tempfile::tempdir().unwrap();
        // ~3 MB of filler + one match near the end. The streaming searcher finds it
        // WITHOUT a whole-file `read_to_string` (which was the OOM/freeze risk).
        let mut big = "filler line\n".repeat(250_000); // ~3 MB
        big.push_str("HAYSTACK_NEEDLE at the end\n");
        std::fs::write(d.path().join("big.txt"), big).unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"HAYSTACK_NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("big.txt:250001:HAYSTACK_NEEDLE"),
            "{}",
            r.content
        );
    }

    #[tokio::test]
    async fn giant_single_line_file_is_skipped_not_buffered_whole() {
        let d = tempfile::tempdir().unwrap();
        // One line LARGER than the heap cap (e.g. a minified bundle). The searcher errors
        // on it and skips it, instead of buffering the whole line into memory (the OOM case).
        let mut giant = String::from("NEEDLE ");
        giant.push_str(&"x".repeat(MAX_LINE_BUF_BYTES + 1024)); // > cap, no newline
        std::fs::write(d.path().join("min.js"), &giant).unwrap();
        std::fs::write(d.path().join("ok.txt"), "NEEDLE\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "grep must not error/hang on a giant line");
        assert!(
            r.content.contains("ok.txt:1:"),
            "normal match found: {}",
            &r.content[..r.content.len().min(120)]
        );
        assert!(
            !r.content.contains("min.js"),
            "over-cap single-line file must be skipped"
        );
    }

    #[tokio::test]
    async fn capped_message_counts_matches_not_output_rows() {
        let d = tempfile::tempdir().unwrap();
        // 3 scattered matches at context 3 → ~23 output ROWS but only 3 MATCHES.
        let lines: Vec<String> = (1..=30)
            .map(|i| {
                if i % 10 == 5 {
                    format!("HIT {i}")
                } else {
                    format!("line {i}")
                }
            })
            .collect();
        std::fs::write(d.path().join("f.txt"), lines.join("\n") + "\n").unwrap();
        // max_results 10: output rows (23) >= 10 but matches (3) < 10 → must NOT report capped.
        let r = GrepTool
            .execute(
                r#"{"pattern":"HIT","max_results":10,"context":3}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            r.content.matches("HIT").count(),
            3,
            "exactly 3 matches: {}",
            r.content
        );
        assert!(
            !r.content.contains("Results capped"),
            "false 'capped' with only 3<10 matches: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn skips_binary_files() {
        let d = tempfile::tempdir().unwrap();
        // A NUL byte ⇒ binary ⇒ the searcher quits and reports nothing for it.
        std::fs::write(d.path().join("blob"), b"\x00 NEEDLE inside binary\n").unwrap();
        std::fs::write(d.path().join("text.txt"), "NEEDLE\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(
            r.content.contains("text.txt:1:"),
            "text match: {}",
            r.content
        );
        assert!(
            !r.content.contains("blob"),
            "binary file must be skipped: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn skips_gitignored_and_build_dirs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("target")).unwrap();
        std::fs::write(d.path().join("target/junk.rs"), "NEEDLE\n").unwrap();
        std::fs::write(d.path().join("keep.rs"), "NEEDLE\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(r.content.contains("keep.rs:1:"), "{}", r.content);
        assert!(
            !r.content.contains("junk.rs"),
            "target/ should be skipped: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn finds_gitignored_upload_store() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        std::fs::write(
            d.path().join(".gitignore"),
            ".jeikcode_store/\nhidden.txt\n",
        )
        .unwrap();
        std::fs::write(d.path().join("hidden.txt"), "NEEDLE hidden\n").unwrap();
        std::fs::write(d.path().join("keep.rs"), "NEEDLE keep\n").unwrap();
        std::fs::create_dir_all(d.path().join(".jeikcode_store")).unwrap();
        std::fs::write(
            d.path().join(".jeikcode_store/upload.txt"),
            "NEEDLE upload\n",
        )
        .unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("keep.rs"), "{}", r.content);
        assert!(
            r.content.contains("upload.txt"),
            "upload store must remain searchable: {}",
            r.content
        );
        assert!(
            r.content.contains("hidden.txt"),
            ".gitignore must not hide a searchable file: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn codegraphignore_filters_and_include_ignored_bypasses_it() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore"), "noise.txt\n").unwrap();
        std::fs::write(d.path().join("noise.txt"), "NEEDLE noise\n").unwrap();
        std::fs::write(d.path().join("keep.rs"), "NEEDLE keep\n").unwrap();

        let default = GrepTool
            .execute(r#"{"pattern":"NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(default.content.contains("keep.rs"), "{}", default.content);
        assert!(
            !default.content.contains("noise.txt"),
            "codegraphignore must filter noise by default: {}",
            default.content
        );

        let unfiltered = GrepTool
            .execute(
                r#"{"pattern":"NEEDLE","include_ignored":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            unfiltered.content.contains("noise.txt"),
            "include_ignored must bypass codegraphignore: {}",
            unfiltered.content
        );
    }

    #[tokio::test]
    async fn searches_hidden_dotfiles_by_default() {
        let d = tempfile::tempdir().unwrap();
        // Non-credential dotfile: sensitive paths remain hard-excluded below.
        std::fs::write(d.path().join(".hidden-notes"), "NEEDLE dotfile\n").unwrap();
        let r = GrepTool
            .execute(
                r#"{"pattern":"NEEDLE","include_ignored":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.content.contains(".hidden-notes"),
            "grep must search hidden files by default: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn zero_match_hints_codegraphignore() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore"), "noise.txt\n").unwrap();
        std::fs::write(d.path().join("noise.txt"), "NEEDLE_NOISE\n").unwrap();

        let noise = GrepTool
            .execute(r#"{"pattern":"NEEDLE_NOISE"}"#, &ctx(d.path()))
            .await;
        assert!(
            noise.content.contains("No matches found"),
            "{}",
            noise.content
        );
        assert!(
            noise.content.contains("Search ignore hint"),
            "noise zero-match must guide include_ignored: {}",
            noise.content
        );
        assert!(
            noise.content.contains("include_ignored=true"),
            "{}",
            noise.content
        );

        // Regex mode must also drive the hint through the real matcher.
        let regex = GrepTool
            .execute(
                r#"{"pattern":"NEEDLE_\\w+","is_regex":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            regex.content.contains("Search ignore hint"),
            "regex zero-match must use the same hint path: {}",
            regex.content
        );

        // A pattern that does not occur in the ignored file must NOT produce
        // the ignore hint: the response stays the ordinary zero-match message.
        let unrelated = GrepTool
            .execute(r#"{"pattern":"NO_SUCH_TOKEN_ANYWHERE"}"#, &ctx(d.path()))
            .await;
        assert!(
            !unrelated.content.contains("Search ignore hint"),
            "unrelated zero-match must keep the plain message: {}",
            unrelated.content
        );
    }

    #[tokio::test]
    async fn zero_match_hints_sensitive_paths() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore.graph"), ".env\n.env.*\n").unwrap();
        std::fs::write(d.path().join(".env.local"), "SECRET_TOKEN\n").unwrap();

        let sensitive = GrepTool
            .execute(r#"{"pattern":"SECRET_TOKEN"}"#, &ctx(d.path()))
            .await;
        assert!(
            sensitive.content.contains("Sensitive path hint"),
            "sensitive zero-match must explain the hard exclusion: {}",
            sensitive.content
        );
        assert!(
            sensitive.content.contains("read"),
            "sensitive hint must point to approval-based read: {}",
            sensitive.content
        );
        assert!(
            !sensitive
                .content
                .contains("retry with include_ignored=true"),
            "sensitive files must not be offered through include_ignored: {}",
            sensitive.content
        );

        let still_hidden = GrepTool
            .execute(
                r#"{"pattern":"SECRET_TOKEN","include_ignored":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            still_hidden.content.contains("Sensitive path hint"),
            "include_ignored must not expose sensitive files: {}",
            still_hidden.content
        );
    }

    #[tokio::test]
    async fn logs_are_default_skipped_and_include_ignored_opens_them() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("logs")).unwrap();
        std::fs::write(d.path().join("logs/app.log"), "NEEDLE_LOG\n").unwrap();
        std::fs::write(d.path().join("keep.rs"), "NEEDLE_LOG\n").unwrap();

        let default = GrepTool
            .execute(r#"{"pattern":"NEEDLE_LOG"}"#, &ctx(d.path()))
            .await;
        assert!(default.content.contains("keep.rs"), "{}", default.content);
        assert!(
            !default.content.contains("logs/app.log"),
            "log files are default-excluded from grep: {}",
            default.content
        );

        let opened = GrepTool
            .execute(
                r#"{"pattern":"NEEDLE_LOG","include_ignored":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            opened.content.contains("logs/app.log"),
            "include_ignored must open log files: {}",
            opened.content
        );
    }

    #[tokio::test]
    async fn zero_match_hints_logs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("logs")).unwrap();
        std::fs::write(d.path().join("logs/app.log"), "NEEDLE_LOG\n").unwrap();

        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE_LOG"}"#, &ctx(d.path()))
            .await;
        assert!(r.content.contains("No matches found"), "{}", r.content);
        assert!(
            r.content.contains("Log search hint"),
            "zero-match must explain the default log exclusion: {}",
            r.content
        );
        assert!(r.content.contains("include_ignored=true"), "{}", r.content);
    }

    #[tokio::test]
    async fn sensitive_paths_are_default_skipped_and_include_sensitive_opens_them() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore.graph"), ".env\n.env.*\n").unwrap();
        std::fs::write(d.path().join(".env.local"), "NEEDLE_SECRET\n").unwrap();
        std::fs::write(d.path().join("keep.rs"), "NEEDLE_SECRET\n").unwrap();

        let default = GrepTool
            .execute(r#"{"pattern":"NEEDLE_SECRET"}"#, &ctx(d.path()))
            .await;
        assert!(default.content.contains("keep.rs"), "{}", default.content);
        assert!(
            !default.content.contains(".env.local"),
            "sensitive files are default-excluded from grep: {}",
            default.content
        );

        let opened = GrepTool
            .execute(
                r#"{"pattern":"NEEDLE_SECRET","include_sensitive":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            opened.content.contains(".env.local"),
            "include_sensitive must open sensitive files: {}",
            opened.content
        );
    }

    #[test]
    fn grep_overflow_hint_shapes() {
        let many_files = vec![
            "a.rs:1:needle".to_string(),
            "b.rs:1:needle".to_string(),
            "c.rs:1:needle".to_string(),
        ];
        let many = grep_overflow_hint(&GrepOverflow {
            matches: 3,
            max: 3,
            lines: &many_files,
            mode: OutputMode::Content,
            timed_out: false,
            byte_overflow: false,
            include_ignored: false,
            has_context: false,
        });
        assert!(many.contains("files_with_matches"), "{many}");

        let one_file = vec!["a.rs:1:needle".to_string(), "a.rs:2:needle".to_string()];
        let single = grep_overflow_hint(&GrepOverflow {
            matches: 2,
            max: 2,
            lines: &one_file,
            mode: OutputMode::Content,
            timed_out: false,
            byte_overflow: false,
            include_ignored: false,
            has_context: false,
        });
        assert!(single.contains("read(path=\"a.rs\""), "{single}");

        let byte = grep_overflow_hint(&GrepOverflow {
            matches: 10,
            max: 200,
            lines: &many_files,
            mode: OutputMode::Content,
            timed_out: false,
            byte_overflow: true,
            include_ignored: true,
            has_context: true,
        });
        assert!(byte.contains("40KB"), "{byte}");
        assert!(byte.contains("include_ignored=true"), "{byte}");

        let timeout = grep_overflow_hint(&GrepOverflow {
            matches: 0,
            max: 200,
            lines: &[],
            mode: OutputMode::Content,
            timed_out: true,
            byte_overflow: false,
            include_ignored: false,
            has_context: false,
        });
        assert!(timeout.contains("timed out"), "{timeout}");
        assert!(timeout.contains("code_explore"), "{timeout}");
    }

    #[tokio::test]
    async fn glob_restricts_files_at_any_depth() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/a.rs"), "NEEDLE rust\n").unwrap();
        std::fs::write(d.path().join("src/a.txt"), "NEEDLE text\n").unwrap();
        std::fs::write(d.path().join("top.rs"), "NEEDLE top\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE","glob":"*.rs"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("a.rs"), "{}", r.content);
        assert!(r.content.contains("top.rs"), "{}", r.content);
        assert!(
            !r.content.contains("a.txt"),
            "*.rs must not match .txt: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn default_context_is_zero() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("f.txt"), "line 1\nNEEDLE two\nline 3\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE"}"#, &ctx(d.path()))
            .await;
        assert!(r.content.contains("f.txt:2:NEEDLE two"), "{}", r.content);
        assert!(
            !r.content.contains("f.txt-1-") && !r.content.contains("f.txt-3-"),
            "default context must be 0: {}",
            r.content
        );
    }

    #[test]
    fn description_and_schema_steer_to_code_explore() {
        let d = GrepTool.description();
        assert!(d.contains("Search file contents"), "{d}");
        let schema = GrepTool.parameters_schema();
        let pat = schema["properties"]["pattern"]["description"]
            .as_str()
            .unwrap_or("");
        assert!(pat.contains("regex pattern"), "{pat}");
    }

    #[tokio::test]
    async fn recovers_pattern_from_query_alias_and_constraint_description() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "首次运行 ok\n").unwrap();
        let r = GrepTool
            .execute(
                r#"{"path":".","description":" [Constraint: pattern: 首次运行]"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("recovered"), "{}", r.content);
        assert!(r.content.contains("a.txt:1:"), "{}", r.content);

        let r2 = GrepTool
            .execute(r#"{"path":".","query":"首次运行"}"#, &ctx(d.path()))
            .await;
        assert!(!r2.is_error, "{}", r2.content);
        assert!(r2.content.contains("query"), "{}", r2.content);

        // Weak-model payload: path+pattern both stuffed into description.
        std::fs::create_dir_all(d.path().join("Models/Service")).unwrap();
        std::fs::write(
            d.path().join("Models/Service/CustomerRelationService.cs"),
            "GetSalePostSettingData() {}\n",
        )
        .unwrap();
        let r3 = GrepTool
            .execute(
                r#"{"description":" [Constraint: path: Models/Service/CustomerRelationService.cs, pattern: GetSalePostSettingData]"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r3.is_error, "{}", r3.content);
        assert!(
            r3.content.contains("GetSalePostSettingData"),
            "{}",
            r3.content
        );
        assert!(
            r3.content.contains("CustomerRelationService.cs"),
            "{}",
            r3.content
        );

        // Weak-model payload: pattern-only Constraint, no top-level pattern.
        std::fs::write(d.path().join("track.txt"), "positionTracking here\n").unwrap();
        let r4 = GrepTool
            .execute(
                r#"{"description":" [Constraint: pattern: positionTracking]"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r4.is_error, "{}", r4.content);
        assert!(r4.content.contains("positionTracking"), "{}", r4.content);
    }

    #[tokio::test]
    async fn case_insensitive_flag_overrides_uppercase_pattern() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("file.txt"), "hello world\n").unwrap();

        // Pattern has uppercase; by default agent exploration is case-insensitive:
        let r1 = GrepTool
            .execute(r#"{"pattern":"HELLO"}"#, &ctx(d.path()))
            .await;
        assert!(r1.content.contains("hello world"), "{}", r1.content);

        // With case_insensitive: false, it is strictly case-sensitive:
        let r2 = GrepTool
            .execute(
                r#"{"pattern":"HELLO","case_insensitive":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r2.content.contains("No matches found"), "{}", r2.content);

        // Alias "i" also works:
        let r3 = GrepTool
            .execute(r#"{"pattern":"HELLO","i":true}"#, &ctx(d.path()))
            .await;
        assert!(!r3.is_error, "{}", r3.content);
        assert!(r3.content.contains("hello world"), "{}", r3.content);
    }

    #[tokio::test]
    async fn output_mode_files_with_matches() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "NEEDLE once\nNEEDLE twice\n").unwrap();
        std::fs::write(d.path().join("b.rs"), "no match\n").unwrap();
        std::fs::write(d.path().join("c.rs"), "NEEDLE here\n").unwrap();

        let r = GrepTool
            .execute(
                r#"{"pattern":"NEEDLE","output_mode":"files_with_matches"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("2 files with matches:"), "{}", r.content);
        assert!(r.content.contains("a.rs"), "{}", r.content);
        assert!(r.content.contains("c.rs"), "{}", r.content);
        assert!(!r.content.contains("b.rs"), "{}", r.content);
        // Must NOT contain line content
        assert!(!r.content.contains("once"), "{}", r.content);
        assert!(!r.content.contains("twice"), "{}", r.content);
    }

    #[tokio::test]
    async fn type_filter_matches_file_type() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("app.rs"), "TOKEN\n").unwrap();
        std::fs::write(d.path().join("app.txt"), "TOKEN\n").unwrap();

        let r = GrepTool
            .execute(r#"{"pattern":"TOKEN","type":"rust"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("app.rs"), "{}", r.content);
        assert!(!r.content.contains("app.txt"), "{}", r.content);
    }

    #[tokio::test]
    async fn type_filter_supports_extended_aliases() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Program.cs"), "COMMON_MARKER\n").unwrap();
        std::fs::write(d.path().join("App.vue"), "COMMON_MARKER\n").unwrap();
        std::fs::write(d.path().join("Component.tsx"), "COMMON_MARKER\n").unwrap();
        std::fs::write(d.path().join("Service.java"), "COMMON_MARKER\n").unwrap();
        std::fs::write(d.path().join("main.c"), "COMMON_MARKER\n").unwrap();
        std::fs::write(d.path().join("index.js"), "COMMON_MARKER\n").unwrap();
        std::fs::write(d.path().join("ignore.txt"), "COMMON_MARKER\n").unwrap();

        // c# / cs
        let r_csharp = GrepTool
            .execute(r#"{"pattern":"COMMON_MARKER","type":"c#"}"#, &ctx(d.path()))
            .await;
        assert!(
            r_csharp.content.contains("Program.cs"),
            "{}",
            r_csharp.content
        );
        assert!(
            !r_csharp.content.contains("App.vue"),
            "{}",
            r_csharp.content
        );

        // vue
        let r_vue = GrepTool
            .execute(
                r#"{"pattern":"COMMON_MARKER","type":"vue"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r_vue.content.contains("App.vue"), "{}", r_vue.content);
        assert!(!r_vue.content.contains("Program.cs"), "{}", r_vue.content);

        // react (tsx/jsx/ts/js)
        let r_react = GrepTool
            .execute(
                r#"{"pattern":"COMMON_MARKER","type":"react"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r_react.content.contains("Component.tsx"),
            "{}",
            r_react.content
        );
        assert!(
            !r_react.content.contains("Program.cs"),
            "{}",
            r_react.content
        );

        // java
        let r_java = GrepTool
            .execute(
                r#"{"pattern":"COMMON_MARKER","type":"java"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r_java.content.contains("Service.java"),
            "{}",
            r_java.content
        );
        assert!(!r_java.content.contains("Program.cs"), "{}", r_java.content);

        // c
        let r_c = GrepTool
            .execute(r#"{"pattern":"COMMON_MARKER","type":"c"}"#, &ctx(d.path()))
            .await;
        assert!(r_c.content.contains("main.c"), "{}", r_c.content);
        assert!(!r_c.content.contains("Program.cs"), "{}", r_c.content);

        let r_alias = GrepTool
            .execute(r#"{"pattern":"COMMON_MARKER","type":"js"}"#, &ctx(d.path()))
            .await;
        assert!(r_alias.content.contains("index.js"), "{}", r_alias.content);
    }

    /// P0: `path` naming a file + `glob` used to yield "0 files searched" because
    /// strip_prefix of the file against itself is empty and `*.rs` matches nothing.
    #[tokio::test]
    async fn file_path_with_glob_still_searches_the_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("event.rs"), "cached tokens here\n").unwrap();
        let r = GrepTool
            .execute(
                r#"{"pattern":"cached","path":"event.rs","glob":"*.rs"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("event.rs:1:"),
            "must search the named file: {}",
            r.content
        );
        assert!(
            !r.content.contains("0 files searched"),
            "must not report zero files: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn glob_matching_nothing_explains_zero_files() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "NEEDLE\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":"NEEDLE","glob":"*.zig"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("0 files searched"), "{}", r.content);
    }

    #[tokio::test]
    async fn explicit_case_sensitive_false_disables_smart_case() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "Hello\nhello\n").unwrap();
        let r_smart = GrepTool
            .execute(r#"{"pattern":"hello"}"#, &ctx(d.path()))
            .await;
        assert!(r_smart.content.contains("Hello"), "{}", r_smart.content);
        assert!(r_smart.content.contains("hello"), "{}", r_smart.content);
        let r_strict = GrepTool
            .execute(
                r#"{"pattern":"hello","case_insensitive":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r_strict.content.contains(":hello"), "{}", r_strict.content);
        assert!(
            !r_strict.content.contains("Hello"),
            "explicit false must not match Hello: {}",
            r_strict.content
        );
    }

    #[tokio::test]
    async fn explicit_path_under_skip_dirs_can_be_searched() {
        let d = tempfile::tempdir().unwrap();
        let nm = d.path().join("node_modules").join("my-lib");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("index.js"), "export const TARGET = 42;\n").unwrap();

        // Searching root directory ignores node_modules by default (zero noise):
        let r_root = GrepTool
            .execute(r#"{"pattern":"TARGET"}"#, &ctx(d.path()))
            .await;
        assert!(
            r_root.content.contains("No matches found"),
            "{}",
            r_root.content
        );

        // Explicitly targeting the sub-package path allows searching it:
        let r_pkg = GrepTool
            .execute(
                r#"{"pattern":"TARGET","path":"node_modules/my-lib"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r_pkg
                .content
                .contains("index.js:1:export const TARGET = 42;"),
            "{}",
            r_pkg.content
        );
    }

    #[test]
    fn grep_match_path_parses_content_context_and_count() {
        assert_eq!(grep_match_path("src/foo.rs:12:hello"), Some("src/foo.rs"));
        assert_eq!(grep_match_path("src/foo.rs-12-hello"), Some("src/foo.rs"));
        assert_eq!(grep_match_path("src/foo.rs: 3 matches"), Some("src/foo.rs"));
        assert_eq!(grep_match_path("src/foo.rs"), Some("src/foo.rs"));
        assert_eq!(grep_match_path("--"), None);
    }

    #[test]
    fn test_escaped_punctuation_and_unescape() {
        assert!(has_escaped_punctuation(r"\.register\("));
        assert_eq!(unescape_punctuation_escapes(r"\.register\("), ".register(");
        assert_eq!(
            unescape_punctuation_escapes(r"Foo\.bar\(baz\)"),
            "Foo.bar(baz)"
        );
        assert_eq!(unescape_punctuation_escapes(r"items\[0\]"), "items[0]");
        assert_eq!(
            unescape_punctuation_escapes(r"C:\\path\\file"),
            r"C:\path\file"
        );
        // \s 不是标点符号，保留原始转义
        assert_eq!(unescape_punctuation_escapes(r"fn\s+test"), r"fn\s+test");
    }

    #[tokio::test]
    async fn self_healing_escaped_punctuation_with_regex_false() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("commands.rs"),
            "custom.register(crate::custom_commands::CustomCommand {\n",
        )
        .unwrap();

        // 精确复现用户上报案例：模型习惯性对标点加转义并且传递 regex: false
        let r = GrepTool
            .execute(
                r#"{"pattern":"\\.register\\(","regex":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("commands.rs:1:custom.register("),
            "应通过去转义自愈成功匹配：{}",
            r.content
        );

        // 默认字面量模式（未传 regex 字段）时带有反斜杠转义，同样自愈救活
        let r_default = GrepTool
            .execute(r#"{"pattern":"\\.register\\("}"#, &ctx(d.path()))
            .await;
        assert!(!r_default.is_error, "{}", r_default.content);
        assert!(
            r_default.content.contains("commands.rs:1:custom.register("),
            "应在默认字面量模式下自愈匹配：{}",
            r_default.content
        );
    }

    #[tokio::test]
    async fn self_healing_unclosed_parenthesis_literal() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("app.ts"), "function setupApp(config) {\n").unwrap();

        // 模型传入 setupApp\(，未闭合括号在正则中是非法的，但去转义字面量能完美救活
        let r = GrepTool
            .execute(
                r#"{"pattern":"setupApp\\(","is_regex":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("app.ts:1:function setupApp(config) {"),
            "{}",
            r.content
        );
    }

    #[tokio::test]
    async fn self_healing_raw_regex_fallback() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("service.rs"),
            "pub fn    register_handler() {}\n",
        )
        .unwrap();

        // 模型在字面量模式下传递复合正则 fn\s+register
        let r = GrepTool
            .execute(
                r#"{"pattern":"fn\\s+register","regex":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content
                .contains("service.rs:1:pub fn    register_handler() {}"),
            "{}",
            r.content
        );
    }

    #[tokio::test]
    async fn preserve_literal_backslash_when_file_contains_it() {
        let d = tempfile::tempdir().unwrap();
        // 源码中字面上确实包含反斜杠 \.register\(
        std::fs::write(
            d.path().join("regex_util.rs"),
            r#"let pattern = "\.register\("; "#,
        )
        .unwrap();

        let r = GrepTool
            .execute(
                r#"{"pattern":"\\.register\\(","regex":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("regex_util.rs:1:"),
            "字面量命中优先，原样匹配：{}",
            r.content
        );
    }

    /// 用户上报回归：`.sidebar {`（CSS 选择器 / 代码片段形状）里的 `{` 不是合法量词，
    /// rust regex 会因它构建失败，曾被静默降级为字面量搜索 → 正则模式下也 0 命中。
    /// 现在按 PCRE / GNU ERE 语义把非法量词 `{` 当字面量，`.` 等正则语义保留。
    #[tokio::test]
    async fn regex_mode_tolerates_bare_brace_as_literal() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("app.css"),
            ".app-sidebar {\n  width: 12px;\n}\n",
        )
        .unwrap();
        let r = GrepTool
            .execute(
                r#"{"pattern":".sidebar {","is_regex":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        // `.` 保持通配：`-sidebar {` 命中 `.app-sidebar {`
        assert!(r.content.contains("app.css:1:"), "{}", r.content);

        // 合法量词不受影响，仍按重复语义工作
        std::fs::write(d.path().join("rep.txt"), "aab\n").unwrap();
        let r2 = GrepTool
            .execute(r#"{"pattern":"a{2}b","is_regex":true}"#, &ctx(d.path()))
            .await;
        assert!(!r2.is_error, "{}", r2.content);
        assert!(r2.content.contains("rep.txt:1:"), "{}", r2.content);
    }

    /// 自愈回归：默认字面量搜空 + 含 `.*` 正则特征 + 含裸 `{` 时，正则重试不再
    /// 因花括号构建失败而夭折（此前 `side.*rail {` 会静默失败收场）。
    #[tokio::test]
    async fn self_healing_brace_pattern_regex_retry_fires() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("app.css"),
            ".sidebar-rail {\n  width: 48px;\n}\n",
        )
        .unwrap();
        let r = GrepTool
            .execute(
                r#"{"pattern":"side.*rail {","regex":false}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("app.css:1:"), "{}", r.content);
    }

    /// 零命中且 pattern 带单点号/花括号（歧义字符）时，提示可改走 is_regex=true；
    /// 纯词搜零命中不附加该提示，保持原文案稳定。
    #[tokio::test]
    async fn zero_match_with_ambiguous_metachars_hints_is_regex() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.css"), ".other {\n}\n").unwrap();
        let r = GrepTool
            .execute(r#"{"pattern":".sidebar {","path":"a.css"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("No matches found"), "{}", r.content);
        assert!(r.content.contains("is_regex=true"), "{}", r.content);

        let plain = GrepTool
            .execute(r#"{"pattern":"absent_xyz"}"#, &ctx(d.path()))
            .await;
        assert!(!plain.content.contains("is_regex"), "{}", plain.content);
    }

    #[test]
    fn escape_bare_braces_keeps_valid_quantifiers() {
        assert_eq!(escape_bare_braces(".sidebar {"), ".sidebar \\{");
        assert_eq!(escape_bare_braces("a{2}b{2,}c{2,3}"), "a{2}b{2,}c{2,3}");
        assert_eq!(escape_bare_braces(r"foo\{bar{"), r"foo\{bar\{");
        assert_eq!(escape_bare_braces(".x{abc}"), ".x\\{abc}");
        assert_eq!(escape_bare_braces("{}"), "\\{}");
    }
}
