//! Offline, source-only repair candidates. Nothing here activates or updates JeikCode.
//!
//! The skill supplies a workflow; this module owns the path, snapshot, and export
//! checks. A detached worktree is not a security boundary. Only `runner` executes
//! a reproduction, and it refuses to fall back when its sandbox is unavailable.

mod git_objects;
mod packet;
mod runner;
mod sandbox_runtime;
mod webui;
mod workspace;

pub use webui::WebuiRepairBackend;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

use crate::build_info::BuildInfo;
use workspace::{read_json, Lock};

const SCHEMA_VERSION: u32 = 1;
const REPOSITORY: &str = "https://github.com/jeikl/JeikCode";
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Parser)]
#[command(
    name = "jeikcode repair",
    about = "Prepare and review a local JeikCode source repair; never apply it to the installed app"
)]
struct RepairCli {
    #[command(subcommand)]
    command: RepairCommand,
}

#[derive(Subcommand)]
enum RepairCommand {
    /// Inspect source and the currently running binary without reading app configuration.
    Info {
        #[arg(long)]
        source: PathBuf,
    },
    /// Create a detached candidate from committed HEAD, preserving the original checkout.
    Prepare {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        run: PathBuf,
        /// Exact relative text file that may change. Repeat for multiple files.
        #[arg(long, required = true)]
        allow: Vec<String>,
        /// An independent shell reproduction, captured once and mounted read-only.
        #[arg(long)]
        probe: Option<PathBuf>,
    },
    /// Verify the candidate's paths and detect source or candidate drift.
    Check {
        #[arg(long)]
        run: PathBuf,
    },
    /// Run the captured probe in a Linux namespace sandbox; no unsandboxed fallback.
    Run {
        #[arg(long)]
        run: PathBuf,
        #[arg(long, value_parser = ["baseline", "candidate"])]
        phase: String,
        #[arg(long, default_value_t = 60, value_parser = clap::value_parser!(u64).range(1..=600))]
        timeout_seconds: u64,
    },
    /// Build a frozen, allowlisted packet. Notes are plain data, never shell input.
    Collect {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        reproduction: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
    /// Display every byte of the frozen packet, as JSON strings, and its digest.
    Preview {
        #[arg(long)]
        run: PathBuf,
    },
    /// Export exactly the previewed payload to a new local directory. Does not send it.
    Export {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        accept: String,
        #[arg(long)]
        output: PathBuf,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceIdentity {
    repository: String,
    commit: String,
    tree: String,
    dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileIdentity {
    blob: String,
    sha256: String,
    executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Probe {
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    schema_version: u32,
    run_id: String,
    source_root: PathBuf,
    source: SourceIdentity,
    original_checkout_digest: String,
    files: BTreeMap<String, FileIdentity>,
    allowed_paths: Vec<String>,
    observer: BuildInfo,
    observer_binary_sha256: Option<String>,
    probe: Option<Probe>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    phase: String,
    status: String,
    source_digest: String,
    probe_sha256: String,
    argv: Vec<String>,
    cwd: String,
    started_at_unix_ms: u128,
    duration_ms: u128,
    exit_code: Option<i32>,
    stdout_sha256: String,
    stderr_sha256: String,
    output_truncated: bool,
    boundary: String,
    detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sandbox_runtime: Option<sandbox_runtime::Identity>,
}

pub fn run(args: &[OsString]) -> Result<()> {
    let cli = match RepairCli::try_parse_from(
        std::iter::once(OsString::from("jeikcode repair")).chain(args.iter().cloned()),
    ) {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            error.print()?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    match cli.command {
        RepairCommand::Info { source } => {
            let (root, identity, _, _) = workspace::inspect_source(&source)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "source_root": root,
                    "source": identity,
                    "observer": BuildInfo::current(),
                    "observer_binary_sha256": workspace::current_binary_digest(),
                    "installed_runtime_match": "unknown",
                    "note": "Build metadata is self-reported. No installed application, signed provenance, or dirty source snapshot has been matched."
                }))?
            );
        }
        RepairCommand::Prepare {
            source,
            run,
            allow,
            probe,
        } => {
            let run = workspace::prepare(&source, &run, allow, probe.as_deref())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "run": run,
                    "candidate": run.join("candidate"),
                    "candidate_status": "proposed",
                    "installed_runtime_match": "unknown",
                    "execution_boundary": "not_run"
                }))?
            );
        }
        RepairCommand::Check { run } => {
            let run = workspace::run_root(&run)?;
            let _lock = Lock::acquire(&run)?;
            let state = load_state(&run)?;
            let snapshot = workspace::candidate(&run, &state)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "source_digest": snapshot.digest,
                    "changed_paths": snapshot.changed,
                    "status": "scope_checked",
                    "verification": "not_implied"
                }))?
            );
        }
        RepairCommand::Run {
            run,
            phase,
            timeout_seconds,
        } => {
            let run = workspace::run_root(&run)?;
            let _lock = Lock::acquire(&run)?;
            let state = load_state(&run)?;
            archive_previous_attempt(&run, &phase)?;
            let receipt = runner::execute(&run, &state, &phase, timeout_seconds)?;
            let receipt_path = run.join(format!("{phase}-receipt.json"));
            workspace::replace_private(&receipt_path, &serde_json::to_vec_pretty(&receipt)?)?;
            println!("{}", serde_json::to_string_pretty(&receipt)?);
            if receipt.status != "checks_passed" {
                bail!(
                    "reproduction {} (receipt saved); no verification success claimed",
                    receipt.status
                );
            }
        }
        RepairCommand::Collect {
            run,
            reproduction,
            report,
        } => {
            let run = workspace::run_root(&run)?;
            let _lock = Lock::acquire(&run)?;
            let state = load_state(&run)?;
            let frozen = packet::collect(&run, &state, &reproduction, &report)?;
            workspace::replace_private(
                &run.join("preview.json"),
                &serde_json::to_vec_pretty(&frozen)?,
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "collected",
                    "sha256": frozen.sha256,
                    "next": "Run repair preview, inspect the complete payload, then use its digest with repair export --accept."
                }))?
            );
        }
        RepairCommand::Preview { run } => {
            let run = workspace::run_root(&run)?;
            let _lock = Lock::acquire(&run)?;
            let frozen = packet::load_frozen(&run)?;
            // JSON escaping keeps report text (including terminal control characters)
            // as data and displays the entire payload, not a truncated summary.
            println!("{}", serde_json::to_string_pretty(&frozen)?);
            packet::mark_previewed(&run, &frozen.sha256)?;
        }
        RepairCommand::Export {
            run,
            accept,
            output,
        } => {
            let run = workspace::run_root(&run)?;
            let _lock = Lock::acquire(&run)?;
            packet::export(&run, &accept, &output)?;
            println!(
                "Exported the previewed packet locally to {}. Nothing was sent.",
                output.display()
            );
        }
    }
    Ok(())
}

fn load_state(run: &Path) -> Result<State> {
    let state: State = read_json(&run.join("state.json"))?;
    if state.schema_version != SCHEMA_VERSION || state.source.repository != REPOSITORY {
        bail!("unsupported repair state");
    }
    if state.allowed_paths.is_empty() || state.files.is_empty() {
        bail!("repair state has no source files or allowed paths");
    }
    for path in &state.allowed_paths {
        workspace::validate_allowed(path)?;
    }
    workspace::validate_scope_spelling(&state.files, &state.allowed_paths)?;
    Ok(state)
}

fn read_receipt(run: &Path, phase: &str) -> Result<Option<Receipt>> {
    let path = run.join(format!("{phase}-receipt.json"));
    if !path.try_exists()? {
        return Ok(None);
    }
    let receipt: Receipt = read_json(&path)?;
    if receipt.phase != phase {
        bail!("receipt phase does not match filename");
    }
    Ok(Some(receipt))
}

fn archive_previous_attempt(run: &Path, phase: &str) -> Result<()> {
    // Archive the receipt first, then its sidecars. If a move fails, execution
    // stops before a new attempt; no old receipt can describe that new attempt.
    let mut previous = Vec::new();
    for suffix in [
        "receipt.json",
        "stdout.txt",
        "stderr.txt",
        "sandbox-error.txt",
    ] {
        let path = run.join(format!("{phase}-{suffix}"));
        workspace::no_links(&path)?;
        if path.try_exists()? {
            anyhow::ensure!(
                path.metadata()?.is_file(),
                "attempt artifact must be a regular file"
            );
            previous.push(path);
        }
    }
    if !previous.is_empty() {
        let history = run.join("receipt-history");
        workspace::no_links(&history)?;
        std::fs::create_dir_all(&history)?;
        let attempt = uuid::Uuid::new_v4();
        for path in previous {
            let name = path
                .file_name()
                .context("attempt artifact has no name")?
                .to_string_lossy();
            std::fs::rename(&path, history.join(format!("{attempt}-{name}")))?;
        }
    }
    Ok(())
}

fn read_note(path: &Path) -> Result<String> {
    workspace::no_links(path)?;
    let metadata = path.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES {
        bail!("note must be a regular UTF-8 file of at most 2 MiB");
    }
    std::fs::read_to_string(path).context("read note as plain UTF-8 data")
}

#[cfg(test)]
mod tests;
