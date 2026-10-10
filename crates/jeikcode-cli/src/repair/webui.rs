//! Narrow host adapter for the developer-assisted WebUI repair pilot.
//!
//! Native repair remains the source/packet owner. HTTP never changes process
//! cwd, prepares candidates, runs probes, or accepts an arbitrary command.

use super::*;
use anyhow::ensure;
use jeikcode_daemon::api_repair::{RepairBackend, RepairRequest};
use serde_json::{json, Value};

pub struct WebuiRepairBackend;

fn absolute_path(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute(),
        "repair UI paths must be absolute host paths"
    );
    ensure!(
        !path.to_string_lossy().chars().any(char::is_control),
        "repair UI paths cannot contain control characters"
    );
    Ok(())
}

fn selected_source(source: &Path) -> Result<PathBuf> {
    absolute_path(source)?;
    workspace::no_links(source)?;
    let source = source.canonicalize().context("resolve selected source")?;
    ensure!(source.is_dir(), "selected source must be a directory");
    Ok(source)
}

fn bound_packet(run: &Path, state: &State) -> Result<packet::FrozenPacket> {
    let frozen = packet::load_frozen(run)?;
    let metadata: Value = serde_json::from_str(&frozen.files["repair.json"])
        .context("read frozen repair identity")?;
    ensure!(
        metadata["schema_version"] == SCHEMA_VERSION
            && metadata["run_id"] == state.run_id
            && metadata["repository"] == state.source.repository
            && metadata["base_commit"] == state.source.commit
            && metadata["base_tree"] == state.source.tree,
        "frozen packet identity differs from this repair run; collect and preview again"
    );
    Ok(frozen)
}

impl RepairBackend for WebuiRepairBackend {
    fn execute(&self, request: RepairRequest) -> Result<Value> {
        match request {
            RepairRequest::Info { source } => {
                absolute_path(&source)?;
                let (root, identity, _, _) = workspace::inspect_source(&source)?;
                Ok(json!({
                    "source_root": root,
                    "source": identity,
                    "observer": BuildInfo::current(),
                    "observer_binary_sha256": workspace::current_binary_digest(),
                    "installed_runtime_match": "unknown",
                    "note": "Build metadata is self-reported. No installed application, signed provenance, or dirty source snapshot has been matched."
                }))
            }
            RepairRequest::Preview { source, run } => {
                let source = selected_source(&source)?;
                absolute_path(&run)?;
                let run = workspace::run_root(&run)?;
                let _lock = Lock::acquire(&run)?;
                let state = load_state(&run)?;
                ensure!(
                    source == state.source_root,
                    "repair run belongs to a different source checkout"
                );
                let frozen = bound_packet(&run, &state)?;
                // Presentation marks exactly this digest. Human acknowledgment
                // is still required by the separate export request.
                packet::mark_previewed(&run, &frozen.sha256)?;
                Ok(json!({
                    "source_root": state.source_root,
                    "run_root": run,
                    "packet": frozen
                }))
            }
            RepairRequest::Export {
                source,
                run,
                accept,
                output,
            } => {
                let source = selected_source(&source)?;
                absolute_path(&run)?;
                absolute_path(&output)?;
                let run = workspace::run_root(&run)?;
                let _lock = Lock::acquire(&run)?;
                let state = load_state(&run)?;
                ensure!(
                    source == state.source_root,
                    "repair run belongs to a different source checkout"
                );
                // Revalidate the run/packet binding inside the same operation
                // lock; an earlier successful HTTP preview is insufficient.
                let frozen = bound_packet(&run, &state)?;
                ensure!(accept == frozen.sha256, "previewed packet digest changed");
                packet::export(&run, &accept, &output)?;
                Ok(json!({
                    "status": "exported_local",
                    "output": output.canonicalize()?,
                    "sha256": accept
                }))
            }
        }
    }
}
