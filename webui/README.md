# JeikCode webui

A local browser UI for JeikCode (Preact + Vite + PostCSS), served by the
`jeikcode-daemon` HTTP server. Launch it with `/webui` inside the TUI or
`jeikcode webui` from the CLI — both open a loopback-only page in your browser.

## Develop the frontend

```bash
cd webui
npm install
npm run dev          # vite dev server on http://localhost:5173
```

For hot reload against a running daemon, set `JEIKCODE_WEBUI_DEV` so the daemon
redirects page requests to the vite dev server instead of serving the embedded
bundle:

```bash
JEIKCODE_WEBUI_DEV=http://localhost:5173 jeikcode webui
# (or run the daemon directly)
JEIKCODE_WEBUI_DEV=http://localhost:5173 cargo run -p jeikcode-daemon -- --port 13456
```

API calls still hit the daemon; only the static page is redirected, so you keep
live HMR while talking to the real backend.

## Styling and dependency security

Application styles live in `src/styles/`. `src/index.css` preserves the previous
Tailwind 3 reset and legacy utility output, including its MIT notices. The
utility generator was removed to eliminate its unpatched `braces` dependency
without changing the CSS cascade or raising the browser requirements to
Tailwind 4's minimums. Add new styles explicitly instead of reintroducing
`@tailwind` or `@apply` directives.

The scoped Mermaid override in `package.json` shares the WebUI's patched KaTeX
renderer and bundled stylesheet while retaining Mermaid's current major.
Behavioral coverage lives in `src/lib/markdownMath.test.ts`,
`src/lib/markdownRender.test.ts`, `src/lib/mermaidMath.test.ts`, and
`src/lib/stylesheet.test.ts`.

## Build for release

Prefer the existing GitHub Actions WebUI quality job: it installs locked
dependencies, typechecks, tests, builds, and uploads `ci-webui-dist` for the
exact revision. The native CI job downloads that artifact before compiling
the daemon, so embedded assets include dependency security fixes.

For a source build that cannot use a matching artifact:

```bash
cd webui
npm ci
npm run build        # outputs webui/dist/
cd ..
cargo build          # embeds that generated bundle into the binary
```

## Build artifacts

`webui/dist/` is generated output, not the dependency source of truth. Do not
reuse an older bundle after changing the lockfile: rebuild it or download the
matching CI artifact before compiling a native binary. The daemon embeds
these assets through `rust-embed` in
`crates/jeikcode-daemon/src/webui.rs`.

This dependency remediation does not publish a release or update an installed
daemon. Use the repository's release pipeline when distributing new binaries.

