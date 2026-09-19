//! Library surface for the `jeikcode` binary.
//!
//! Exists so integration tests (e.g. `tests/script_parity.rs`) and the binary
//! share testable modules. The bulk of the CLI still lives in `main.rs`; only
//! modules that need to be reachable from `tests/` belong here.

// Redirect JEIKCODE_HOME to a temp dir before this lib crate's tests run, so they
// don't pollute the real ~/.jeikcode (mirrors the bin's ctor in main.rs).
#[cfg(test)]
#[ctor::ctor]
fn _isolate_jeikcode_home() {
    jeikcode_kernel::test_support::isolate_home();
}

#[cfg(unix)]
pub mod askpass;
pub mod config_sync;
pub mod host_service;
pub mod systemd;
pub mod uninstall;

/// ACP (Agent Client Protocol) stdio server — lets jeikcode be driven by Zed /
/// multi-agent orchestrators over stdin/stdout. Wired up by the `jeikcode acp`
/// subcommand in `main.rs`; the engine/dispatch/translate/permission internals
/// live here. Does not depend on `jeikcode-core` (v2 stack only).
pub mod acp;
