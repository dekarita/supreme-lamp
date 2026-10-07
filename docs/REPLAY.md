# F108 · `.mcrec` Replay Viewer

**What it is.** A static page that reads a GHRDP diagnostic recording and replays it:
timeline, DOM-update descriptors, screenshots, the stored-session index and the feature
snapshot — plus a plain-text summary you can paste into a chat. It is operator tooling: no
account, no server, no upload.

**Where it lives.**

| path | role |
|---|---|
| `docs/replay/index.html` | the page (published by GitHub Pages) |
| `docs/replay/app.js` | the DOM half — no dependencies, no `innerHTML`, no network |
| `docs/replay/style.css` | styles (system fonts, no remote CSS) |
| `docs/replay/vendor/…` | **byte-identical copies** of the shipped reader cores (see below) |
| `docs/replay/sample.mcrec` | a 3 kB **synthetic** recording (no real session data) for verifying the page |
| `src/replay/replayCore.js` | the reader's source of truth (pure JS, no DOM, no I/O) |
| `scripts/sync-replay-vendor.mjs` | regenerates `docs/replay/vendor/…` from `src/` |
| `tests/f108-replay-core.test.js` | the gate: vendor bytes + envelope/parse/privacy/CSP pins |
| `src/tests/smoke/f108-replay-dom.test.tsx` | jsdom suite: rendering, hostile-bundle inertness, no network |

## Using it

1. Open the page (see §Publishing for the URL) — or serve the tree locally:
   `python3 -m http.server -d docs 8080` then
   `http://localhost:8080/replay/`. A local static server is required because
   `index.html` loads ES modules, and browsers refuse module loads from `file://`.
2. Give it a recording, one of three ways:
   - paste a clipboard line (`mcrec1:gzip:…` / `mcrec2:plain:…`) into the box — it reads on paste;
   - press **Read from clipboard**;
   - choose / drag the exported `.mcrec` file (F107's Export writes plain JSON).
   No recording handy? [download the synthetic sample](replay/sample.mcrec) and choose it — it exercises
   every tab and deliberately contains a `?token=…` route so you can watch the sanitizer strip it.
3. Read the tabs: **Timeline** (scrubber + per-event detail with the nearest screenshot),
   **Screenshots**, **DOM updates**, **Stored sessions**, **Features**, **Arena summary**
   (Ctrl/⌘-C-able text, one button to copy).

## The two formats it reads

| format | producer | shape |
|---|---|---|
| `mcrec` v1, `mcrec1:<codec>:<base64>` | step 3, DVR lite (the DVR FAB's **Copy**) | ring entries: `click` / `settle` / `route`, 30 s window |
| `mcrec` v2, `mcrec2:<codec>:<base64>` **or** raw JSON | step 6, F107 Full DVR (**Export**) | timeline + mutation descriptors + thumbnails + session index + feature snapshot |

Both are validated by the **shipped** validators (`validateBundleV2`, the ring's envelope
decoder) — the viewer has no parser of its own, so a recorder change cannot desynchronize it.
A bundle the recorder would refuse (out-of-order timeline, drifted byte total, a shot outside
the 320×240 / 200 kB fence) is refused here too, with the reason printed.

## Privacy, in one paragraph

The page is fenced by `<meta http-equiv="Content-Security-Policy">` with `default-src 'none'`,
`connect-src 'none'` and `img-src data:`, and its own source contains no `fetch`, no XHR, no
WebSocket, no beacon and no `innerHTML` (all asserted by the F108 gate and the jsdom suite).
Bundle text is rendered with `textContent` only — a `testId` containing `<script>` stays
visible characters, never an element. Screenshots render only from a fenced
`data:image/png;base64,` thumbnail, so opening somebody else's recording cannot beacon your IP
to their host. Routes are stripped of their query string at *display* time as well as at
record time (`routeCore.safeRoute`), so a `?token=` cannot reappear through a hand-edited file.
Nothing is uploaded, and there is no endpoint to upload to.

## Publishing (read this before touching Pages)

Measured 2026-10-07: **Pages is enabled but published nothing.** `build_type` is `workflow`,
`GET /pages/builds` is empty, the last `github-pages` deployment is 2026-10-01T16:42Z, and
`https://dekarita.github.io/supreme-lamp/` answers GitHub's *"There isn't a GitHub Pages site
here"* on `/`, `/status.json` and `/explorer.html`. The docs site is also the CORS origin the
Cloudflare Worker allows (`worker.js`, `CORS_ORIGIN`), so the outage is not cosmetic.

Two ways to publish. **Pick one — two publishers is how the docs tree starts serving
yesterday's files.**

- **A · Actions (what `.github/workflows/replay-viewer.yml` does).** It runs on
  `workflow_dispatch` (Actions ▸ *replay viewer (publish docs/ to Pages)* ▸ **Run workflow**)
  and on pushes to `main` that touch **only the viewer's own paths** (`docs/replay/**`,
  `docs/REPLAY.md`, `src/replay/**`, the vendor sync script, the workflow itself) — so the
  merge that adds the viewer publishes it, while the watchdog's `docs/status.json` heartbeat
  (every ~80 s) publishes nothing. It uploads `docs/` as-is (no build step: the tree in git
  *is* the artifact), refuses to run unless the viewer, its vendored core and the CSP lines
  are present, and then verifies that `<page_url>replay/` actually returns the viewer.
  If you want publishing to be **hand-run only**, delete the `push:` block: the F108 gate
  (`F108-h`) accepts either shape but always rejects an unfenced one.
- **B · Branch source (no workflow needed).** Settings ▸ Pages ▸ Source ▸ *Deploy from a
  branch* ▸ `main` / `docs`. Delete or disable `replay-viewer.yml` if you choose this; the
  F108 gate fails if a second deployer appears.

If the viewer is not reachable, that is a Pages-configuration fact, not an F108 bug: run the
verification below.

## Verifying it yourself (multi-method, no single endpoint)

```bash
gh api /repos/dekarita/supreme-lamp/pages    | jq '{build_type, source, public}'   # enabled?
gh api /repos/dekarita/supreme-lamp         | jq .has_pages                       # flag
gh api /repos/dekarita/supreme-lamp/pages/builds                                   # legacy builds
gh api /repos/dekarita/supreme-lamp/deployments --jq '.[0] | {created_at, sha}'    # last deploy
curl -sI "$(gh api /repos/dekarita/supreme-lamp/pages --jq .html_url)replay/"      # the page
```

`GET /pages` returning 200 proves *enabled*; only the last two lines prove *publishing*.

## Local development

```bash
node scripts/sync-replay-vendor.mjs          # refresh docs/replay/vendor/ after editing src/
node scripts/sync-replay-vendor.mjs --check  # what CI asserts
node --test tests/f108-replay-core.test.js   # the viewer gate
pnpm vitest run src/tests/smoke/f108-replay-dom.test.tsx
```

Never hand-edit a file under `docs/replay/vendor/`: it is generated, and the gate fails with
the pair's name if it drifts from `src/`.
