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

---

# SESSION 2026-10-10 (b) — branch `arena/f289f02e-supreme-lamp`

Continuation of the #222 repair line. This section records only what this
session **executed**; nothing here restates a prior session's claim as fact.

## B1. Failure registry (built BEFORE any code was changed)

Three red check runs were live on PR #222 head `b213fd42`.

| ID | revision / event | run / job | failing step | first actionable error | reproduction | cause confidence |
|---|---|---|---|---|---|---|
| GATES-01 | `b213fd42` / `pull_request` | run 38057454377 / job 114228734592 | `gates` step **32** "F37 telescope single-source + self-explaining lab gates" | `F37: the telescope startup scan is missing` | **REPRODUCED locally**: extracted the step verbatim to a script and ran it at repo root → identical message, exit 1 | **HIGH** |
| GATES-02 | `b213fd42` / `push` | run 38057418836 / job 114228631728 | same step | same annotation (`.github:217`) | same script | **HIGH** (same cause, different checkout) |
| E2E-01 | `b213fd42` / `pull_request` | run 38057454362 / job 114228734568 | `e2e-ui` step **8** "Run F78 + F79 E2E specs" | `F79-E2E-TALLY:: … f84-ux.spec.ts ✘=4 …` | **NOT reproducible here** — no browser binary and `cdn.playwright.dev` is egress-blocked | **LOW** (see B3) |

The two `gates` runs are the **same defect in two checkouts**, not two defects.
Neither is the earlier `windows-native`/F45 failure — `windows-native`
**passed** on both runs (job 114228734732 and 114228631588).

## B2. GATES-01/02 — cause, repair, regression proof

**Cause (HIGH).** Commit `b213fd42` ("F45 readiness repair") deliberately moved
the three startup scans (F28 logon, F30 conn-log, F37 telescope) to run
**after** the listener bind, so readiness is not held hostage by a synchronous
`Get-WinEvent` walk. That reworded the F37 comment from
`STARTUP SCAN: the telescope stamps BEFORE the first client can poll` to
`STARTUP SCAN: the telescope stamps promptly after the listener starts`.
`tests/f37-telescope.test.js` was updated to the new sentence; the **workflow
gate** at `launch-gates.yml:1905` was not. It grepped the old prose and failed.
The scan itself was intact — this was a prose-pin break, not a runtime defect.
This is exactly the class the brief warned about: a green `node --test` does
not cover a workflow shell step.

**Repair (deliberately NOT a prose swap).** Both surfaces now pin the
*behaviour* the sentence stood for, structurally:
- (a) the startup-scan **call** exists;
- (b) it runs **after** the `LISTENING` marker (readiness observable first);
- (c) it runs **before** the accept loop drains (the first client the loop
  serves cannot poll a never-attempted sample).

Verified anchors in `payloads/ghrdp-server.ps1`: marker line **9258** <
telescope startup scan **9274** < accept loop **9462**.

This is strictly stronger than the sentence: a reworded comment can no longer
break the gate, and deleting or reordering the scan still does. No assertion,
retry or timeout was loosened.

**Regression proof executed locally:**
| Check | Result | Tier |
|---|---|---|
| F37 gate step, extracted verbatim from the edited workflow and run | `F37 gates PASS`, exit 0 (was exit 1) | STATIC |
| `node --test tests/f37-telescope.test.js` (runs *inside* that gate) | 36/36 pass | COMPONENT |
| `node --test` over all `tests/**/*.test.js` | 832 tests, 806 pass, **0 fail**, 26 skip | COMPONENT |
| `npx vitest run` | 98 files, 1265/1265 pass | COMPONENT |
| `pnpm run build` (tsc + vite singlefile) | OK, `ui/dist/index.html` 1,153 kB | STATIC |
| YAML parse of both edited workflows | OK | STATIC |

## B3. E2E-01 — what the evidence does and does not support

Comparing the tally annotation across runs (the only readable channel; the step
log host `results-receiver.actions.githubusercontent.com` and the artifact host
`pipelines.actions.githubusercontent.com` are both egress-blocked here):

| spec | PR #221 / main (before) | #222 head `b213fd42` |
|---|---|---|
| `f86-ten-sites-deep` | ✘=13 ✓=1 | **✓=12 — fixed** |
| `f78-add-sites` | ✘=4 ✓=18 | outside the 400-char annotation window |
| `f84-ux` | ✘=2 ✓=5 | **✘=4 — regressed** |

So the mirror-transport migration **did** fix the large `f86` failure and
**did** regress `f84-ux` by one test (retries:1 ⇒ ✘=4 = 2 tests × 2 attempts).

**What was ruled out by execution, not by reading:**
- The mock's `/api/launcher/queue` fence was started locally and probed:
  `navigate`+https → **200**, `navigate`+`javascript:` → **400**,
  `explorer`+https → **400**. Both fallback branches of tests 4 and 5 assert
  exactly those, so **the mock fence is not the cause**.
- `/api/fx/list` serves the real 5000-row fixture (`files=5000`, `schema=2`).
- `"Opened locally ✓"` is present in `src/i18n/en.json`
  (`mirror.openedLocal` / `openedBoth` / `rdpOffline`), so the test-5 toast
  text is not the cause.
- `card-direct-url` is a `<button>`, not an anchor, so the click cannot
  navigate the page away from under the assertions.

**What is NOT established:** the actual failing assertion. Without a browser or
the step log, any named cause here would be a guess, and a guess shipped as a
"fix" is how this lane stayed red for ~100 runs.

**Instrument repair (deliberately paired with B2, not a substitute for it).**
`e2e-ui.yml` now emits `F79-E2E-FAILn` — one bounded annotation per failing
test carrying `spec:line › title :: first error line`. The tally named the
*file*; this names the *assertion*. Verified against a realistic Playwright
list-reporter log. Pinned by a new assertion in `tests/f203-e2e-lane.test.js`
(F203-f, 11/11 pass) so it cannot silently disappear. Sanitized by
construction: Playwright's own header and first error line only — never a
request body, response body or signed URL.

This is evidence tooling. **It does not fix the application**, and E2E-01
remains **OPEN**.

## B4. Evidence-class tallies for this session

| Class | Result |
|---|---|
| SOURCE_INSPECTED | `launch-gates.yml`, `e2e-ui.yml`, `payloads/ghrdp-server.ps1` (telescope/health/accept-loop regions), `src/lib/launchUrl.ts`, `src/pages/search/ResultsGrid.tsx`, `tests/e2e/f84-ux.spec.ts`, `tests/f203-e2e-lane.test.js`, `tests/e2e/fixtures/mock-backend.mjs` |
| STATIC_CHECK | F37 gate PASS · YAML parse OK · build OK · ps-balance-audit 0 failures |
| COMPONENT_BEHAVIOUR | node:test 832/806/0/26 · vitest 1265/1265 · F203 lane pins 11/11 |
| WINDOWS_NATIVE | **NOT_RUN** — no `pwsh` in this sandbox → `windows-native` / `autologin-lab` CI lanes |
| BROWSER_LAB | **NOT_RUN** — no browser binary; `cdn.playwright.dev` egress-blocked → `e2e-ui` CI lane |
| CI_VERIFIED | pending — see the run table in the PR body |
| LIVE_VERIFIED | **NOT_RUN** — production activation needs separate authorization |

## B5. Delivery constraint recorded honestly

This session's environment is fixed to branch `arena/f289f02e-supreme-lamp` and
cannot push to PR #222's branch (`arena/e491ab8c-supreme-lamp`). #222's commits
were therefore carried forward by fast-forward (verified: `main` `179a25a` is an
ancestor of `b213fd42`) and the repairs are published from the session branch as
a clearly linked continuation. **Nothing from #222 was dropped.**
#221 and #222 must not be merged independently of this line.
