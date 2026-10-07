# JeikCode webui

A local browser UI for JeikCode (Preact + Vite + Tailwind), served by the
`jeikcode-daemon` HTTP server. Launch it with `/webui` inside the TUI or
`jeikcode webui` from the CLI — both open a loopback-only page in your browser.

## Develop the frontend

```bash
cd webui
npm ci
npm run dev          # vite dev server on http://localhost:5173
```

Set `JEIKCODE_WEBUI_DEV` so the backend redirects static page requests to the
Vite dev server instead of serving the embedded bundle:

```bash
JEIKCODE_WEBUI_DEV=http://localhost:5173 jeikcode webui
# (or run the daemon directly from the repository root)
JEIKCODE_WEBUI_DEV=http://localhost:5173 cargo run -p jeikcode-daemon -- --port 13456
```

The redirect is already implemented in `crates/jeikcode-daemon/src/webui.rs`.
It redirects static paths, not API requests; it is not a reverse proxy. The
current Vite configuration has **no API proxy**, and the frontend uses same-origin
API URLs. Redirecting alone therefore does not create a working full-stack dev
environment: configure a development proxy for the backend API/WebSocket routes
before using HMR with live sessions. Standalone daemon defaults to port `13456`;
CLI/TUI WebUI defaults to `13457` with token authentication. If using CLI/TUI,
also preserve its authentication token; the static redirect does not retain
query parameters. Use the actual port printed by each server if a preferred
port is occupied.

## Build for release

From the repository root:

```bash
cd webui
npm ci
npm run build        # outputs webui/dist/
cd ..
cargo build --release --bin jeikcode
```

`webui/dist/` is generated and **not tracked** in Git. Build it before compiling
a binary that must include the WebUI. `rust-embed` embeds the local assets at
Rust compile time (see `crates/jeikcode-daemon/src/webui.rs`); changing frontend
source alone does not refresh the embedded bundle. Do not commit `dist/`.

An unchanged, already-built `dist/` can be reused for backend-only changes. A
clean checkout has no committed bundle to fall back to; with missing assets,
the backend static handler returns `404: webui not built` rather than a usable UI.

The official tag-triggered GitHub Actions workflow builds the frontend before
Rust binaries. See [the canonical build and release tutorial](../docs/release-tutorial.md)
for the supported release path. Legacy `release.sh` and `release-self-update.sh`
now fail immediately; `release-daemon.sh` remains a local IDE packaging helper,
not an official publishing pipeline.
