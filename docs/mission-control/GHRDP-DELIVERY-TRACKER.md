# GHRDP DELIVERY TRACKER — continuation index (session 2026-10-10, branch `arena/e491ab8c-supreme-lamp`)

**Why this file exists.** The previous canonical tracker lived only on repair
branches (`814e2b2`, `26a9764`/`e3acf15`) inside sandboxes that are gone:
**MISSING_COMMIT_ACCESS** — their contents cannot be recovered or re-verified,
so nothing below re-states their line items as fact. This file is the new
single index going forward; every row carries an evidence tier and a
publication status, and unexecuted work is never labelled PASS.

**Evidence tiers**: CLAIM (asserted, not checked) · INSPECTION (read the code,
not run) · REPRO (reproduced locally) · STATIC (structural gate executed) ·
COMPONENT (vitest/node:test executed) · WINDOWS-NATIVE (pwsh lane on Windows) ·
BROWSER (Playwright executed) · CI (GitHub Actions run) · DEPLOYMENT (live).
**Publication**: LOCAL_ONLY · PR_OPEN · MERGED · DEPLOYED.

## 1. This session — checkpoint

| Fact | Value | Tier |
|---|---|---|
| origin/main | `179a25a8187f7a892da8d7b07833a4ae81e4e1c0` | INSPECTION (git) |
| Session branch | `arena/e491ab8c-supreme-lamp`, base merge `3cfb8c6` (PR #221 head `008b754` merged INTO this branch, keeps its Mornye-inspired glass UI) | INSPECTION |
| PR index | #221 OPEN (head `008b754`), #220 MERGED, #219 OPEN, #208 OPEN | INSPECTION (gh) |
| Missing work | `814e2b2`, `26a9764`/`e3acf15` — MISSING_COMMIT_ACCESS; reconstructed below, not claimed | — |

## 2. E2E lane #203 — first real failure found, defect fixed

| Item | Detail | Tier | Status |
|---|---|---|---|
| Root cause | specs f86/f78/f84/f81/f91 asserted a window-open/launch-url transport, but every result surface uses the F91 queue transport (`openMirrored` → POST `/api/launcher/queue`); plus SPA-fallback traps (relative in-page fetches resolve against vite preview's index.html, not the mock) | REPRO (static analysis + gates) | LOCAL_ONLY |
| Fix A+C | specs migrated to the queue-transport mirror contract: `isolateExternalNetwork`, `closeExtraPages`, MOCK-absolute fetches (f91 stream fetches take `mock` into `page.evaluate`); mock CORS `*` on live `/api/stream` branches | COMPONENT (F203-a..k gates) | LOCAL_ONLY |
| Defect B | `openMirrored` passed `noopener,noreferrer` to `window.open`; the HTML spec forces a **null return whenever noopener is set** (MDN Window.open; whatwg/html#1851), so EVERY mirror click faked `popupBlocked` even when the tab opened. Fixed: open plainly (implicit noopener on all modern engines), then `win.opener = null` (spec's cross-origin-safe sever) — return value is truthful again; superseded pins carry dated comments | COMPONENT | LOCAL_ONLY |
| Gate | `tests/f203-e2e-lane.test.js` 11 tests incl. F203-k (pinned mirror-click spec list + same-line click detector) | STATIC | LOCAL_ONLY |
| Browser proof | **NOT_RUN** here (no browser in sandbox). Verification owner = the `e2e-ui.yml` CI lane after authorized push | — | NOT_RUN |

## 3. F45 — real server responsiveness (readiness repair, this session)

The synchronous `Get-WinEvent` startup scans previously ran **before**
`$listener.Start()`, so a slow event-log walk delayed the bind, the
`server-ok.txt` marker, and every harness waiting on it.

| Item | Detail | Tier | Status |
|---|---|---|---|
| §1 reorder | `payloads/ghrdp-server.ps1`: listener.Start() + LISTENING marker now precede the F28/F30/F37 startup scans; scans keep their exact call literals (lockstep greps in f28/f30/f37/launch-gates/autologin/f60 untouched) | STATIC | LOCAL_ONLY |
| §2 `/health` | new route before `/diag`: `{ok, app='ghrdp', pid, listenerBound, bind, port, serverStartedUtc, scans:{logon,connLog,telescope:{scanTs,probeError}}}` — readiness (instance identity) is separated from scanner FRESHNESS; a slow first scan reads as `scanTs:null`, never `ok:false`; loopback-only like `/diag`, no credentials | STATIC | LOCAL_ONLY |
| §3 pacing | accept-loop yield now `GHRDP_SCAN_DELAY_MS` (clamped 5..1000ms, default 50). Pacing knob only — it cannot shorten a scan running on the accept thread | STATIC | LOCAL_ONLY |
| Harnesses | `tests/f45-fx-server.ps1`, `tests/f49-mirror-runtime.ps1`, `.github/workflows/autologin-lab.yml` now require **marker + HTTP 200 `/health` + pid match** (marker pid vs `/health` pid vs started-process pid) — a stale marker over a recycled port fails loudly | STATIC (runtime = WINDOWS-NATIVE lane) | LOCAL_ONLY |
| Structural lock | new `tests/f45-readiness.test.js` (9 rules F45-R1..R9) | STATIC | LOCAL_ONLY |
| Windows-native runtime proof | **NOT_RUN** here (no PowerShell in sandbox). Verification owner = `windows-native` + `autologin-lab` CI lanes | — | NOT_RUN |

### F45-B work package (DEFERRED by design — not dropped)

The reorder fixes *readiness* but not mid-scan latency: a scan running on the
accept thread still pauses request draining while it executes. Moving scans
"after the drain" is insufficient (the user's explicit requirement). The real
fix is an **isolated bounded scan worker** (runspace or detached process) with
atomic state files and a `GHRDP_SCAN_GATE_FILE` seam so the Windows-native lane
can block a scanner at a real boundary and assert `/health` + authenticated
reads within budget, then exercise release/fail/timeout. It was NOT built in
this PR because the scan functions have cascading in-file dependencies in the
9.4k-line server, there is no PowerShell in this sandbox to verify any
concurrency, and shipping untested concurrency into the production server is
worse than an honest deferral. Owner: next Windows-capable session.

## 4. Glass UI / contrast (#213/#214 lineage, preserved from #221)

| Item | Detail | Tier | Status |
|---|---|---|---|
| Accent contrast (LIGHT) | `#0ea5e9` measured **2.77:1** on the white surface — below AA. Repaired to `#0369a1` (5.93:1 on surface, 5.42:1 raised), hover `#075985` (7.56:1), on-fill fg `#ffffff` (5.93:1), focus ring `#0369a1`; all measured locally (WCAG relative-luminance math) | REPRO (computed) | LOCAL_ONLY |
| fx selection border (LIGHT) | non-text boundary 2.77:1 → `#0284c7` (4.10:1 ≥ 3:1); pin updated with dated comment | REPRO (computed) | LOCAL_ONLY |
| Dark theme | unchanged (`#0ea5e9` = 5.28:1 / 6.44:1 on the slate surfaces) | REPRO (computed) | LOCAL_ONLY |
| Candidates flagged, NOT changed | tertiary `#64748b` = 4.34:1 on the raised tint (4.76:1 on white); warning `#d97706` = 3.19:1 on white (icon/UI sizes pass at 3:1). Composite glass ratios are browser-lab questions, not token math | INSPECTION | OPEN |
| Gates | build OK (tsc+vite singlefile 1.15 MB), no-neon-green, regression-ids 219/219, bottom-bar, fx-ids, ps-balance — all green after the repair | COMPONENT/STATIC | LOCAL_ONLY |

## 5. Full regression state at commit time (this tree)

| Suite | Result | Tier |
|---|---|---|
| `node --test tests/*.test.js` | 832 tests, 806 pass, 0 fail, 26 skip | COMPONENT |
| `npx vitest run` | 98 files, 1265/1265 pass | COMPONENT |
| `scripts/ps-balance-audit.mjs` | 0 surfaces failed | STATIC |
| `playwright --list` (e2e-ui config) | 136 tests / 22 files collect clean | STATIC |
| Browser E2E execution | NOT_RUN (sandbox has no browser) → CI lane | — |
| Windows-native execution | NOT_RUN (sandbox has no pwsh) → CI lane | — |

## 6. Standing backlog (issue index, preserved verbatim)

#191 hub · #193/#209/PR#208 Collector/DVR privacy · #194 truthfulness ·
#199/#200 contracts · #203 e2e (fixed this session, awaiting CI proof) ·
#210 downloads · #211/#212 metrics · #213/#214 glass/responsive · #215/#218
research · #216/#217 search/scale · PRs #219/#220/#221.

## 7. Honesty rules this tracker enforces

1. No PASS for anything unexecuted — it is NOT_RUN or BLOCKED, with the owner
   lane named.
2. Historical figures (contrast, perf, counts from earlier sessions) are
   CLAIMS until reproduced; this session reproduced only what it lists as
   REPRO/COMPONENT above.
3. Budget telemetry: **UNKNOWN** in this sandbox (no metering API reachable);
   see `BUDGET_LEDGER.md` (prior session) for the rule of record.
