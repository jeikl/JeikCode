#!/usr/bin/env bash
# Kiểm tra ranh giới feature độc lập; không thay đổi cấu hình CI.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-targetbeta-validation}"
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_INCREMENTAL=0
cargo check -p jeikcode-capabilities --no-default-features
for feature in provider tools session codeintel mcp cc-hooks memory setup plugin; do
    cargo check -p jeikcode-capabilities --no-default-features --features "$feature"
done
cargo test -p jeikcode-capabilities --no-default-features --features provider --lib
cargo test -p jeikcode-capabilities --no-default-features --features tools --lib argument_repair
cargo test -p jeikcode-capabilities --no-default-features --features session --lib session::context
