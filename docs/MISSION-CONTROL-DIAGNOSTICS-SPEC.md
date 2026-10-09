# Mission Control — Embedded Diagnostics Specification (PLANNING ARTIFACT)

Status: **SPECIFIED (planning)** — nothing here is implemented. Parent [#191](https://github.com/dekarita/supreme-lamp/issues/191).
Grounding: [capability/reuse matrix](mission-control/CAPABILITY-REUSE-MATRIX.md), [architecture](mission-control/ARCHITECTURE.md),
[census](mission-control/CONTROL-CENSUS.md). Work packages: WP-04 (Part B core), WP-05B (health model), WP-06
(attribution), WP-07 (UX), WP-10 (export), WP-13/WP-14 (defects this spec depends on being fixed).

---

## Part A — Operator experience

### A.1 Journey → existing surface → required change

| # | Operator step | Existing surface (reuse) | Required change | WP |
|---|---|---|---|---|
| 1 | Open Mission Control after authenticated access | `DashTokenGate` (chrome, blocks when runner-served and tokenless) | none; gate input must stop leaking into capture (MC-P8) | WP-13 |
| 2 | See a concise, truthful system summary | top-bar `#topbarChips` (Connection, Mirror, Watcher, WebSocket, Clock) | one **Summary chip** first in `#topbarChips`; existing chips keep ids but gain `unknown`/`stale` states; watcher chip uses heartbeat age (MC-P16) | WP-07, WP-14 |
| 3 | Open a feature and inspect its health/evidence | none per feature (FeatureBoundary has no slot — D1) | **"Diagnose this page"** button in the top bar; resolves the feature with `featureByRoute(location)`; opens the drawer scoped to that feature (registry `endpoints`, `stores`, `dependsOn`) | WP-07 |
| 4 | Perform an action | the feature's own control | none | — |
| 5 | See started / accepted / completed | toasts; Collector rows (only for instrumented controls) | **Action outcome strip** inside the drawer's Timeline: one row per correlated action with hop states (§A.4) | WP-06, WP-07 |
| 6 | If it fails, see where evidence stops | verdict text in Collector deep tabs | hop ladder marks the first hop with no evidence as "Evidence stops here" | WP-06 |
| 7 | Inspect confirmed causes or ranked hypotheses | `classifyFailure` strings | "Causes" tab lists `CONFIRMED_CAUSE` / `LIKELY_CAUSE` / `HYPOTHESIS` with the evidence ref and the discriminating next probe (Part B §B.7) | WP-04, WP-11 |
| 8 | Run appropriate safe checks | Collector "Click now" (mixed side effects), F92 self-test | "Checks" tab lists only `READ_ONLY` probes for one-click use; `SYNTHETIC` need a Lab context; `SIDE_EFFECTING` require explicit confirmation naming the effect; `OPERATOR_CONTROLLED` are never offered as buttons | WP-05B, WP-14 |
| 9 | Read the smallest justified next action | suggested-fix strings | one sentence, from the cause table; never "re-create secrets" without a demonstrated configuration failure | WP-11 |
| 10 | Open the GitHub issue and implementation state | `Verdict.relatedIssue` (string) | link from a static known-problems map (problem id → issue → delivery state); no network call to GitHub from the SPA | WP-11 |
| 11 | Export a sanitized evidence bundle on request | F96 bundle, `button-actions.json`, `.mcrec` v1/v2 | one "Export evidence" action: preview → redact → download; screenshots off by default | WP-10 |
| 12 | Verify a later fix on the current build | `ui-sha` badge, `VersionGate`, `#ghrdpBuild[data-build]` | every timeline row carries `buildSha`; "Verify on this build" re-runs the same READ_ONLY probe and shows the build it ran on | WP-04, WP-07 |

### A.2 Placement (real extension points only)

```
┌ TopBar (chrome "shell") ───────────────────────────────────────────────────────────────────────────────┐
│ ☰  GHRDP Mission Control  [● Summary: 2 issues ▾] [Connection: live] [Mirror: OFF] [Watcher: stale 41 s]│
│                           ^A                       ^existing chips gain unknown/stale        [🩺 Diagnose this page]^B │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 A  Summary chip  : worst-of(health read model), count of open problems; click → drawer "Overview" tab
 B  Diagnose page : featureByRoute(hash) → drawer scoped to the feature; keyboard: Alt+D (no conflict with Alt+E/Alt+F)

┌ Drawer (chrome "diag-drawer", existing ids drawer / drawerScrim / diagBox kept) ─────── [⟳] [Export] [✕] ┐
│ Scope: Search ▾        Build ui 823bcb6 · backend 823bcb6 · data 12 s old                                │
│ [Overview] [Timeline] [Dependencies] [Causes] [Checks] [Raw]                                             │
│ Overview: plain-language state per dependency (Server, Token, WebSocket, Watcher, Launcher, Mirror, Logon)│
│ Timeline: correlated actions (A.4 ladder), newest first, filter by feature                               │
│ Dependencies: registry dependsOn/endpoints/stores for the scoped feature with last check + freshness     │
│ Causes: classified causes with evidence refs and the next discriminating probe                           │
│ Checks: READ_ONLY probes (one click), others gated (A.1 step 8)                                          │
│ Raw: today's /diag JSON (progressive disclosure; redacted view)                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Why these hosts: the FeatureBoundary contract is zero DOM delta when healthy (F105 smoke gate) and must not grow a
header; ChromeBoundary renders `null` on failure, so the drawer needs an **internal** static fallback (A.6). The
drawer stays outside `AppShell`, so it survives a shell crash (same reason the HUD lives there). The Debug HUD
remains the developer view; the drawer links to it ("Technical detail: Shift+F12") instead of duplicating it.

### A.3 Global state table (Summary chip and dependency rows)

| State | Meaning (must be literally true) | Visual | EN label | SI label |
|---|---|---|---|---|
| `checking` | first probe in flight, no prior evidence | neutral + spinner | Checking… | පරීක්ෂා කරමින්… |
| `healthy` | all required evidence fresh and passing | success | Operational | ක්‍රියාත්මකයි |
| `degraded` | ≥1 optional dependency failing or a required one slow | warning | Partly working | අර්ධ වශයෙන් ක්‍රියාත්මකයි |
| `failed` | ≥1 required dependency failing with fresh evidence | danger | Failed | අසාර්ථකයි |
| `unreachable` | server gave no HTTP response (status 0) | danger | Server unreachable | සේවාදායකයට ළඟා විය නොහැක |
| `unauthorized` | 401/403 from a token-checked route | danger | Dashboard token refused | ඩෑෂ්බෝඩ් ටෝකනය ප්‍රතික්ෂේප විය |
| `stale` | last evidence older than its freshness budget | warning, shows age | Stale — last seen {age} ago | යල් පැන ගිය දත්ත — අවසන් වරට {age} පෙර |
| `unknown` | never measured in this tab | neutral outline | Unknown — not measured | නොදනී — මැන නැත |

Rules: `unknown` is never rendered as `failed`; `stale` never as `healthy`; Summary = worst of required rows;
optional rows (Mirror, Live Patch) can only degrade, never fail the summary.

### A.4 Action outcome ladder (per correlated action)

| Hop | Evidence that proves it | Display when absent |
|---|---|---|
| 1 Intent | trusted UI event on a census control id | (row not created) |
| 2 Handler started | instrumentation entered (explicit wrapper) or capture saw the click | "Handler not observed" |
| 3 Request sent | exchange tagged with this correlation id (EXPLICIT) or temporally attributed (TEMPORAL, shown as "possibly") | "No request sent (client-only or short-circuited)" |
| 4 Server received | HTTP status ≠ 0 | "No HTTP response" |
| 5 Accepted | 2xx/3xx and handler result `ok !== false` | "Rejected: {class}" |
| 6 Dependent operation | server-side job/queue evidence (e.g. launcher beacon, queue item, watcher heartbeat change) | "Server accepted; downstream not confirmed" |
| 7 Observable effect | journey-specific effect probe (file present, card rendered, session live) | "Effect not confirmed" |
| 8 UI acknowledged | toast/state change matching the effect | "UI did not acknowledge" |

The first absent hop is labelled **Evidence stops here** (SI: සාක්ෂි මෙතැනින් නතර වේ). HTTP success alone stops at
hop 5 — it is never displayed as "Completed" (SI: සම්පූර්ණයි — ප්‍රතිඵලය තහවුරු විය).

### A.5 Per-feature entry examples (first slice)

| Feature | Dependencies shown | First READ_ONLY checks |
|---|---|---|
| overview | server, token, native-status freshness, auth discriminator | `/health`, `/api/native-status` age |
| search | server, token, custom-sources list, preview endpoint | `GET /api/f58/sources` (count only) |
| sessions / connections | native-status, listener flags (`listenerOkOf`), handler beacon age | native-status age, `rdpListener` flags |
| files | fx client transport, queue store, CSRF readiness | NOT_YET_SPECIFIED (R6 unread) |
| mirror | `/api/mirror/status`, watcher heartbeat | mirror status (enabled/disabled/module-missing) |
| collector | store persistence (`persistError`), hydration source | local only |

### A.6 Failure handling of the diagnostic UI itself

| Failure | Required behaviour |
|---|---|
| Backend unreachable | Drawer renders from local evidence: "Server unreachable since {t}; last good data {age} ago"; Checks tab offers only local checks |
| Drawer component throws | ChromeBoundary would render `null` → the drawer must wrap its own panels in an inner boundary that renders a **static text card** (no data dependency) with "Diagnostics failed to render — Copy error"; the top-bar Summary chip still opens it |
| Store hydration failed / quota | show `persistError` verbatim + "rows will not survive refresh" |
| Translation key missing | EN fallback + `[missing:si]` marker counted by the i18n parity gate |
| Build mismatch (VersionGate) | Summary shows `failed: build mismatch`; drawer keeps working |

### A.7 Accessibility

Drawer: `role="dialog"` + `aria-modal="true"` while open, focus moves to the title on open and returns to the
invoker on close, `inert` (or `hidden`) when closed (fixes MC-P18), Escape closes (existing). Ladder rows are a list
with text states (colour is never the only signal). Summary chip is a button with `aria-expanded`. All strings in
`src/i18n/{en,si}.json` under `diag.*` (parity enforced by the existing `tests/f-i18n-parity.test.js`).

---

## Part B — Event, probe and redaction contract

### B.1 EXISTING → REQUIRED → DELTA

| Concern | EXISTING (`ButtonAction` family) | REQUIRED | DELTA (additive, optional fields) |
|---|---|---|---|
| Identity | `id` (`act_<ms36>_<seq>_<rand>`), `ts` | stable id + correlation across rows | add `correlationId` (reuse `mintTraceId` format `t<yyMMddHHmmss>-<src>-<hex>`), `parentId` |
| Provenance | `source` (`global-click-capture` / `feature-boundary` / `chrome-boundary` / undefined) | build + schema + run | add `schemaVersion` (absent ⇒ 1), `buildSha` (from `#ghrdpBuild[data-build]`), `backendSha` when known, `runId`/`runAttempt` only for status/CI evidence |
| Subject | `feature` (free text: "add-site", "global", "chrome:…"), `action` | registry feature + census control id | add `featureId` (registry id or `chrome:<surface>`), `controlId` (census stable id) |
| Expected vs observed | `verdict.reason`; `postCheck.sideEffects[].detected` (= global state diff) | explicit expectation and effect probe | add `expected: {hop, effect}`, `observed: {lastHop, effect, evidenceRefs[]}` |
| Outcome | `verdict.status` ok/warn/fail | lifecycle + outcome | add `lifecycle: started|in_flight|succeeded|failed|cancelled|timed_out` (monotonic, terminal states final) |
| Error | `error` string; `classifyFailure` | stable category/code | add `errorCategory` (`auth`, `network`, `http_4xx`, `http_5xx`, `rate_limit`, `route_missing`, `client_validation`, `handler_exception`, `effect_missing`, `unknown`) + `errorCode` |
| Attribution | implicit (temporal window) | confidence | add `attribution: explicit|temporal|none` per exchange |
| Timing | `elapsedMs` (wall clock; constant 10 000 for global rows) | monotonic duration + wall start | add `startedAtWall` (ISO), `durationMs` from `performance.now()`; `elapsedMs` kept for compatibility |
| Evidence | `request`/`response` (raw, 2000 chars) | bounded references | add `evidenceRefs[]` = `{kind, ref, confidence}`; bodies stored only as redacted excerpts |
| Redaction | header masking with token fingerprint | enforced before storage, no derived identifiers | add `redaction: {applied, rulesVersion}`; drop `sha=` fingerprints (MC-P13) |

Compatibility: every new field optional; readers treat missing `schemaVersion` as v1 and render as today. The 500-row
store key stays `f102-collector-actions-v1`; a one-time in-place redaction pass runs on hydration (WP-13).

### B.2 Hop trace model

`intent → handler → request → server receipt → dependent operation → observable effect → UI acknowledgement`
(Part A §A.4). Each hop is a record `{hop, at, durationMs, evidenceRef, confidence}`; a missing hop is
represented explicitly (`{hop, missing: true, reason}`), never omitted. Correlation propagation:
EXPLICIT = the API client adds `X-GHRDP-Correlation: <correlationId>` (new header; server may echo it in logs —
server side RESEARCH_PENDING), TEMPORAL = only window overlap (displayed as "possibly caused by").

### B.3 Redaction rules (applied before any persistence, export or clipboard)

| Data | Rule | Reuse |
|---|---|---|
| URL | keep origin-less path; drop query and fragment | `stripUrl` (F104) / `safeRoute` |
| Route (hash) | cut at `?` and at a non-leading `#` | `sanitizeBoundaryRoute` |
| Headers | names only for `authorization|cookie|token|key|secret|password`; value → `present(len)`; **no hash/fingerprint** | replaces `maskHeaders` `sha=` |
| Request/response bodies | not stored by default; allow-listed JSON keys only (status codes, counts, enum states) | new |
| Element description | never read `value`; `label` = `aria-label` → `title` → testid; inputs of type `password`, `email`, `search`, `text` record type only | replaces `describeClick` fallback |
| Free text (toasts, button text) | ≤80 chars, collapse whitespace, drop for controls inside `[data-diag-private]` subtrees | new attribute |
| Screenshots | excluded from sanitized export unless the operator ticks "include screenshots" | DVR-full |
| Identifiers | tailnet IP/FQDN shown locally, replaced by `<runner>` in exports | new |

Retention (targets): collector rows 500 (existing cap), DVR ring 30 s (existing), DVR sessions 30 days/5 MB
(existing). Local vs transmitted: nothing is transmitted automatically; exports are files the operator downloads.

### B.4 Probe catalog (READ_ONLY unless stated)

| Id | Purpose | Surface (existing) | Permission | Prereq | Timeout (target) | Budget | Output | Interpretation | Risk | Cleanup |
|---|---|---|---|---|---|---|---|---|---|---|
| PR-01 | server liveness | `GET /api/health` (collectorAgent probe) | none | — | 2.5 s (existing `PROBE_TIMEOUT_MS`) | 1 per 30 s | status, latency | 0 → unreachable; ≥400 → degraded | none | none |
| PR-02 | token acceptance | `GET /api/native-status` with header token | dash token | token present | 2.5 s | 1 per 30 s | status | 401/403 → unauthorized | none (never logs token) | none |
| PR-03 | launcher state | `GET /api/launcher/health` | dash token | — | 2.5 s | 1 per 60 s | `serviceRunning`, `heartbeatAge`, `taskExists` | stopped vs unreachable | none | none |
| PR-04 | watcher freshness | native-status `watcher.alive/heartbeatAgeSec` | dash token | — | reuse PR-02 | — | age | > freshness budget → stale | none | none |
| PR-05 | mirror availability | `GET /api/mirror/status` | dash token | — | 2.5 s | 1 per 60 s | enabled/disabled/module-missing | optional dependency | none | none |
| PR-06 | WebSocket state | telemetry store (`wsLive/wsDead/wsAttempts`) | local | — | n/a | n/a | state | dead → offer Reconnect (LOCAL_ONLY) | none | none |
| PR-07 | build provenance | `#ghrdpBuild[data-build]` + `/api/f92-selftest` | none | — | 3 s | on open | ui sha vs backend sha | mismatch → failed | none | none |
| PR-08 | storage health | collector `persistError`, `hydration` | local | — | n/a | n/a | strings | quota → degraded | none | none |
| PR-09 | journey effect (SYNTHETIC) | Feature Lab + mock backend | none | Lab route | 10 s | operator-initiated | hop ladder | proves wiring, not production | isolated | Lab reset |
| PR-10 | real action (SIDE_EFFECTING) | Collector Click-now (mutating targets) | operator confirmation naming the effect | confirmation | per target `maxWaitMs` | one at a time | row | effect may persist (e.g. a custom source) | changes runner state | documented manual undo |
| PR-11 | production workflow (OPERATOR_CONTROLLED) | Pages → Worker `/dispatch`/`/cancel` | operator only | runbook | — | — | — | never offered as a diagnostic button | production impact | runbook |

Budget justification: 2.5 s and 3 s are the timeouts the code already uses (collectorAgent, DiagnosticsDrawer); the
startup set is PR-01, PR-02, PR-06, PR-07, PR-08 (five checks, of which two are local) — a **target**, to be
measured in WP-05B, not a measured fact. Startup never runs PR-09…PR-11 and never uploads, deletes, dispatches,
rotates or sends data externally.

### B.5 Cause classification

| Class | Rule |
|---|---|
| `CONFIRMED_CAUSE` | a direct observation at the failing hop explains the failure (e.g. HTTP 401 at hop 5 with token present) |
| `LIKELY_CAUSE` | consistent evidence at adjacent hops, no contradicting observation, mechanism known from source |
| `HYPOTHESIS` | plausible from source or history but not observed; **must** name a discriminating probe |
| `INSUFFICIENT_EVIDENCE` | required hops unobserved (e.g. server logs unreadable) |
| `CONFLICTING_EVIDENCE` | two observations disagree (e.g. HTTP 200 but effect probe negative) — shown, never collapsed |

An old error string, temporal proximity or missing data is never a confirmed cause.
