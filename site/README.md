# JeikCode site

Standalone static landing / docs pages served as plain files (`index.html`,
`referral.html`, `docs/**`). All styling is hand-authored: `index.html` uses an
inline `<style>` block and the docs pages link `docs/docs.css`.

There is **no Tailwind build step**. The old `tailwindcss` generator chain was
removed because nothing referenced its output (`dist.css` was linked by no page)
while it pulled in an unpatched `braces` advisory — see PR #35 follow-up. The
generator inputs `input.css` / `tailwind.config.js` and the dead `dist.css` were
dropped with it. Add styles explicitly to the hand-authored CSS instead.

Search indexes are generated with `npm run build:search`. `puppeteer` only backs
the manual `export-pdf.mjs` launch-asset script.
