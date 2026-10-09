# Mission Control — SOURCE_RESEARCH_LEDGER

Revision-aware read record. **READ** = the declared scope was read completely. **PARTIAL** = exact ranges listed;
the rest is unread. **GREP** = only search hits were inspected (never sufficient for a capability claim).
**NOT_READ** = not opened. Revision for every row: source `823bcb6` (identical at `9aa6051` and `main` = `580f231`
except `docs/status.json`). A later session may reuse a READ row only if `git diff 823bcb6 -- <path>` is empty.

Cluster legend: R1 UI shell/controls · R2 Collector/capture · R3 Observatory tools · R4 client/API/auth ·
R5 runner/Windows · R6 Explorer/Search/Mirror · R7 status/delivery · R8 tests/issues.

## 1. Read this session (2026-10-09)

| Path | Cl. | Scope / ranges | Status | Key mechanisms | Callers / consumers | Tests | Findings | Remaining questions | Next exact read |
|---|---|---|---|---|---|---|---|---|---|
| `src/App.tsx` | R1 | L1-159 | READ | 16 `Route`; `fence()` ×13; `chrome()` ×8; HashRouter | `main.tsx` | f105, m2 (static) | route denominators (B1) | — | — |
| `src/main.tsx` | R2 | L1-80 | READ | capture install behind `VITE_F104_GLOBAL_CAPTURE`; DVR decorator; F107; boundary reporter | entry | f104-f (static) | capture is on by default in builds | build env flags used in `main.yml` | `vite.config.ts`, `main.yml` build env |
| `src/lib/collectorAgent.ts` | R2 | L1-1616 | READ | persist store (500 rows, quota slimming, legacy migration, cross-tab rehydrate); `instrumentButton`; F101 fetch observer (ring 200); `captureServiceStates`; `classifyFailure`; Click-now runner; batch/replay | `withActionLog`, AddSiteQuick, AppShell, Connections, launchUrl, featureBoundary, main.tsx, Collector page | f101-residual, f102 (static); smoke f101/f102/f104 (not run) | MC-P8…P16, P19 | does any other module call `installFetchObserver` | — |
| `src/lib/globalClickCapture.ts` | R2 | L1-386 | READ | one capture-phase click listener; per-click fetch/open wrappers (10 s); dedup 500 ms; trust check; ignore list | `main.tsx` (via DVR decorator) | f104 (static, executed: pass) | MC-P8, P10, P11, P22 | browser keyboard-activation behaviour per control | — |
| `src/lib/withActionLog.ts` | R2 | L1-40 | READ | wrapper → `instrumentButton`, rethrows | **no production call-site** (census) | — | dead adapter | — | — |
| `src/pages/Collector.tsx` | R2 | L1-298, L610-720; grep of all `data-testid`/`onClick` | PARTIAL | run/report/download; Click now/all/replay; deep tabs; Global clicks section | route `/collector` | e2e f101/f102/f104 (lane timing out) | MC-P13, P15; non-i18n literals | rendering of deep tabs (masking on display) | L299-L609, L721-L847 |
| `src/components/domain/DiagSideDrawer.tsx` | R3 | L1-56 | READ | `/diag` drawer, Escape, refresh, copy | App chrome; opened by `runDiag` (MirrorCard, TelescopeTimeline) | none | MC-P14, P18 | — | — |
| `src/components/domain/DiagnosticsDrawer.tsx` | R3 | L1-241 | READ | copy-only connection diagnostics; 30 s no-cors DNS probe; auth discriminator; password `CopyLink` | Overview, Connections | none naming it | MC-P10 source; credential copy blind spot | — | — |
| `src/components/domain/DiagBundleCard.tsx` | R3 | L1-132 | READ | F96 bundle download + glance strip | Overview | smoke f-testid-dom | token in query (MC-P12) | bundle fields | `src/api/diag/index.ts` L1-252 |
| `src/components/domain/CollectorRunBridge.tsx` | R2 | L1-33 | READ | registers router navigate; overlay | App chrome | f-dvr (pins order) | — | — | — |
| `src/components/primitives/FeatureBoundary.tsx` | R3 | L1-216 | READ | zero-DOM-delta fence; mount ledger; disabled card; fallback Retry/Reload/Copy | `App.tsx fence()`, `LabRoute` | f105, smoke f105 | no header slot (D1) | — | — |
| `src/components/primitives/ChromeBoundary.tsx` | R3 | all code lines (comment lines filtered) | READ (code) | renders `null` on error; 3 retries × 2 s | App, AppShell | m2 | a diagnostics surface fenced here would blank | — | comment lines (rationale only) |
| `src/lib/chromeBoundaryCore.js` | R3 | all code lines | READ (code) | 10 `CHROME_SURFACES` with "lost" text | ChromeBoundary, featureBoundary | m2 | reusable "what is lost" vocabulary | — | — |
| `src/lib/featureBoundary.ts` | R3 | L1-271 | READ | window event channel; `sanitizeBoundaryRoute`; reporter (20 rows, 5 s dedup) | FeatureBoundary, ChromeBoundary, main.tsx | f105, m2 | best existing sanitizer | — | — |
| `src/lib/dvr.ts` | R3 | L1-394 (blank lines skipped) | READ | decorates recorder; 30 s ring; `safeRoute`; mutation counter; `.mcrec` v1 | main.tsx, DvrFab, session.ts | f-dvr-lite (static, pass) | stores `label` (MC-P8) | — | — |
| `src/lib/dvr/routeCore.js` | R3 | L1-27 | READ | `safeRoute` (cut at `?`) | dvr.ts | f107 | reuse for MC-P11 | — | — |
| `src/lib/dvr/screenshots.ts` | R3 | L1-90 | PARTIAL | foreignObject serialization → 320×240 PNG | session.ts | f107 | thumbnails carry page content (privacy note) | capture trigger, portal exclusion | L91-L136 |
| `src/lib/dvr/screenshotCore.js`, `mutationCore.js`, `exportCore.js` | R3 | L1-60, L1-50, L1-40 + grep | PARTIAL | caps; descriptor privacy; v2 bundle | session/export | f107 | — | v2 fields on export | remaining ranges |
| `src/lib/dvr/session.ts`, `storage.ts` | R3 | GREP | GREP | IndexedDB `ghrdp-dvr`, 30-day retention, 5 MB budget | DVR full | f107 | — | quota/retention behaviour | full files (274 + 226 lines) |
| `src/stores/sessionStore.ts` | R4 | L1-284 | READ | config/native-status state; passwords in store (F27); `runDiag`; auto-login/recred/check/diag protocol launches | polling hook, Overview, Keys, drawers | f27, f28 (not read) | MC-P14; launch success = "protocol dispatched" only | — | — |
| `src/lib/api.ts` | R4 | L1-111 | READ | `apiBase()`; `getJson` returns `null` on any failure; `?key=` in config/native-status URLs | most API callers | f84-same-host | swallowed error class; token in URL | — | — |
| `src/lib/dashToken.ts` | R4 | L1-156 | READ | query → hash → localStorage resolver; `isRunnerServed`; shape-only debug | api.ts, gate, collector | f94 | hash token form enables MC-P11 | — | — |
| `src/components/layout/AppShell.tsx` | R1 | L58-175, L369-493; grep | PARTIAL | top bar chips, ws-reconnect, bottom bar, Alt+E/Alt+F | App `chrome("shell")` | f38/f39, m2 | MC-P16 (watcher chip) | sidebar, toggles | L1-57, L176-368 |
| `src/stores/telemetryStore.ts` | R4 | L112-158; grep | PARTIAL | `setProgress` keeps `mirror` after loss | top bar, sessions | — | MC-P16 | WS state transitions | L1-111, L159-182 |
| `src/hooks/useDashboardPolling.ts` | R4 | GREP | GREP | intervals: config 15 s, native 15 s **and** 10 s, ping 5 s, health 30 s, diag 15 s, progress 3 s loop, WS ladder + 30 s ping watchdog | App | — | MC-P20; background poll density (MC-P12) | reconnect/stale-result handling | L1-408 |
| `src/components/search/AddSiteQuick.tsx` | R6 | L180-250; grep | PARTIAL | save → `instrumentButton` | Search page | many (census) | MC-P9 | modal lifecycle | L1-179, L251-409 |
| `src/stores/customSourcesStore.ts` | R6 | L60-103 | PARTIAL | `addSite` returns outcome (no throw) then `refresh()` | AddSiteQuick | — | MC-P9 mechanism | — | L1-59 |
| `src/api/lab/index.ts` | R6 | L100-230 | PARTIAL | create/list custom source; error keys | stores | f78 | 401/403 → `addSite.authMissing` | — | L1-99, L231-370 |
| `src/pages/Connections.tsx` | R1 | L25-61 | PARTIAL | `.rdp` download, mstsc copy | route | — | MC-P16 | — | L1-24 |
| `src/components/domain/DashTokenGate.tsx`, `src/pages/search/v2/OwnCredentialModal.tsx` | R4 | L150-170; L128-142 | PARTIAL | controlled password inputs with testid | gate; search | smoke f94; f56c | MC-P8 | — | remaining ranges |
| `src/components/primitives/{Button,Chip,Collapse,Copy,Data,Feedback}.tsx` | R1 | GREP | GREP | `Button`/`IconButton` spread rest; `Toggle` role=switch; `Drawer`=details/summary; `Tabs`; `CopyLink`=`<a>`; `Modal` portal with shared `modal-*` testids | everywhere | f-testid-e | portal + shared testid notes | exact keyboard behaviour | full files (98+109+111+86+309+190) |
| `src/lib/featureRegistry.ts` | R3 | GREP (exports) | GREP | `featureByRoute`, mount ledger | boundaries, HUD | f105 | placement primitive | — | L1-269 |
| `src/lib/feature-registry.json` | R3 | `features[]` complete (node dump); `evidence[]` not read | PARTIAL | 11 features with owns/stores/endpoints/edges | f105 gates | f105 | `endpoints` lists are partial (e.g. overview `[]` although DiagBundleCard calls `/api/diag/comprehensive`) — RUNTIME_UNVERIFIED | registry endpoint completeness | `evidence[]` |
| `src/lib/livePatch/keys.ts`, `channel.ts` | R3 | GREP | GREP | empty pin; `/ws` channel ingest | polling hook | f110/f110b | G1 | — | full files |
| `tests/f-testid-coverage.test.js` | R8 | L1-231 | READ | 5-tag char scanner | CI gates | executed (pass) | C1/C2, MC-P17 | — | — |
| `tests/f104-global-click.test.js` | R8 | L1-105 | READ | structural string pins only | CI gates | executed (pass) | I9 | — | — |
| `worker.js` | R5/R7 | code lines through L139 + route grep | PARTIAL | Pages-origin CORS, 30 s rate limit, access-code hash compare, `/dispatch`, `/cancel`, `/workflow`, `/ping`, `/proxy` 410 | Pages site | workflow-webdesk? (not read) | E1 | `/workflow` response shape | L139-end |
| `.github/workflows/main.yml` | R5/R7 | L4423-4520 (grep-guided), L4775-4850 | PARTIAL | Pages verify (non-asserting); watcher XML task for active user; AutoAdminLogon for active user with password sync | dispatch | m8 tests | I6, MC-P21 | status heartbeat writer, finalizer step body | M8 step + heartbeat writer ranges |
| `payloads/ghrdp-server.ps1` (9441 lines) | R5 | GREP (function locations: L415, L430, L483, L861, L9385) | GREP | WS upgrade, `Test-GhrdpDashToken`, `Invoke-F99WatcherDiagnose` exist | dashboard | f45, f53 | B1/B5 likely resolved | every route's validator use; `/diag`, `/api/diag/comprehensive`, `/health` fields | L400-L520 (WS), L850-L900 (token), route table |
| `.github/workflows/e2e-ui.yml` | R7/R8 | GREP (`timeout-minutes: 25` L14) | GREP | 25-minute job cap | CI | — | I4 | which spec hangs | full file + spec list |

## 2. Carried from v1 (status corrected; no re-read this session)

| Path | v1 label | Corrected status | Next exact read |
|---|---|---|---|
| `STATE.md` | PARTIALLY_READ | PARTIAL (ranges not recorded) | full head + queue rows (60-line contract; do not edit) |
| `docs/OBSERVATORY-STATE.md` | PARTIALLY_READ | PARTIAL (headers, §OPERATOR-ASSERTIONS, tail) | none needed for planning |
| `docs/M8-LIVE-VERIFICATION.md` | "READ (§3–4 partially)" | PARTIAL (ranges not recorded) | full file before WP-01 evidence write-up |
| `SESSION_HANDOFF_PROMPT.md` | "READ (partial)" | PARTIAL; stale (`c6de5447`) | — |
| `PROJECT-CONTEXT-v2-CANONICAL.md` | PARTIALLY_READ | PARTIAL (§6 head) | full (3 KB) |
| `tests/f111-ci-inventory.test.js` | PARTIALLY_READ | PARTIAL (header) | — |
| `docs/status.json` | READ @823bcb6 | superseded by `main` `580f231` (identity fields only inspected) | after run 37903915039 ends |

## 3. Not read (bounded exclusions with next step)

| Cluster | Paths | Why it matters | Next exact read |
|---|---|---|---|
| R1 | `src/pages/{Overview,Sessions,Keys,Mirror,Telemetry,Settings,Health,Search,FileExplorer}.tsx`, `src/components/domain/{PrimaryActions,WebDesktopCard,MirrorCard,KeysCard,LogPanel,LogonGateBanner,LauncherBeaconViewer,TelescopeTimeline,F92VersionGate,InstallGuide,ManualVerifyDrawer,MirrorHostMatrix,ConnectionCard,DvrFab}.tsx`, `CommandPalette.tsx` | handler bodies for 277 `SITE_ONLY` census rows | `PrimaryActions.tsx` (326) → `WebDesktopCard.tsx` (382) → `MirrorCard.tsx` (410) |
| R3 | `src/components/DebugHUD.tsx`, `src/lib/debugHud*.{ts,js}`, `featureToggles.ts`, `src/components/lab/*`, `src/lib/lab/*`, `src/replay/replayCore.js`, `src/lib/dvr/{export,mutations,storage,session}.ts` | HUD/Lab/replay reuse decisions | `DebugHUD.tsx` + `debugHud.ts` |
| R4 | `src/api/{diag,fetch,search}/index.ts`, `src/components/explorer/api/*`, `src/lib/launchUrl.ts` (697) | error normalization, stale async, cancellation | `src/api/diag/index.ts` |
| R5 | `payloads/*.ps1` (server route table, watcher, launcher), `payloads/ghrdp-handler/*`, `main.yml` remaining | identity, task start/readiness, Tailscale | server route table + `/diag` handler |
| R6 | `src/lib/explorer/*`, `src/pages/file-explorer/*`, `src/lib/mirror.ts`, `src/search/*` | queue/progress/cancel/encrypted lengths | `src/lib/explorer/queue.ts`, `transport.ts` |
| R7 | `.github/workflows/*` (15), Pages deploy workflow | status writers, CI pins, stale assets | Pages workflow + `main.yml` M8 step |
| R8 | `src/tests/smoke/**` (81), `tests/e2e/**`, remaining `tests/*.js` | structural vs behavioural assertions | smoke f101/f102/f104 bodies |

No full-repository review is claimed.

## 4. Read in the v21 session (2026-10-09) — continuation

Same revision rule: every row is `823bcb6`; `git diff 823bcb6..HEAD` is docs-only, so these reads stay valid.
**Ancestry caveat (ledger J12):** this sandbox clone was **shallow** (`git rev-parse --is-shallow-repository` →
`true`). Ancestry claims made before `git fetch --unshallow` are invalid; after unshallowing, `main` = 13651 commits,
root `88f73e0e`, `merge-base(main, #192) = 823bcb6`.

| Path | Cl. | Scope / ranges | Status | Key mechanisms | Findings | Next exact read |
|---|---|---|---|---|---|---|
| `.github/workflows/main.yml` (finalizer) | R7 | L6500-L6745 read in full | **READ** (this range) | `$terminalStates` 4 values (L6606); `Get-TrackedStatus` discriminating reader with states `ok\|missing\|auth\|transient\|invalid\|invalid-identity`; `Resolve-FinalizeAction` ownership policy; `job.status`→`runStatus` map (L6634-L6639); `finalizeReason` (L6702); deadline 150 s / request 30 s / 3 attempts | **J1, J2** — vocabulary mismatch + notice-level ownership step-aside | heartbeat writer range; Pages deploy workflow |
| `src/pages/Connections.tsx` | R1 | L1-62 **full** | **READ** | `window.open(url,"_blank","noopener")` L41; hardcoded `result:{ok:true}` L46; `params:{url}` with runner IP L45 | **J3, J4** | — |
| `src/lib/dvr.ts` (DVR ring) | R3 | L200-L250 + grep | **READ** (this range) | `installDvr` **decorates** F104's recorder; copies `params.label` (L230) | ring is downstream ⇒ S3/S4 covered by WP-13's upstream fix | L1-199 |
| `src/lib/dvr/mutationCore.js` | R3 | L1-133 **full** | **READ** | descriptors = tag + attribute **NAME** only; no values, no characterData, no node text; batch cap 50, session cap 500 | **S6 verified content-free** — `.mcrec` v2 mutations need no redaction claim | — |
| `src/lib/dvr/exportCore.js` | R3 | L1-133 **full** | **READ** | `buildBundleV2` = timeline + mutations + shots + storage.sessions + features; `mcrec2:` envelope; strict `validateBundleV2` | v2's extra sinks are `shots` + `storage.sessions` (out of WP-13 scope) | — |
| `src/lib/dvr/screenshots.ts` | R3 | L1-90 | **READ** (this range) | `defaultRasterizer`: `XMLSerializer().serializeToString(root.cloneNode(true))` L46-47; 2.5 s image-load timeout; test seam `setShotRasterizer` | **MC-P24 / J6** — the "STRUCTURE only" comment is unsound; `XMLSerializer` emits text + attribute values | L91-L136 |
| `src/lib/dvr/screenshotCore.js` | R3 | L1-60 | **READ** (this range) | 320×240 thumb, `SHOT_MAX_BYTES=200_000`, `SHOT_SESSION_CAP=100`, `fitThumb` | pixel caps are weight controls, **not** content controls | remaining ranges |
| `src/lib/dvr/session.ts` | R3 | grep + L128-L145 | PARTIAL | `takeShot()` on **every** recorded click (L138); env-flag gating only | **J7** — screenshots are opt-**out** | L1-104, L146-L274 |
| `src/main.tsx` (DVR wiring) | R2 | L11-L61 | **READ** (this range) | `installGlobalClickCapture(installDvr(recorder, …))` L43; `installDvrFull()` behind two env flags L50-51 | confirms the single-recorder chain S1→S3→S4 | — |
| `payloads/ghrdp-server.ps1` | R5 | route inventory: **all 76** `path -eq/-like/StartsWith` literals extracted; handlers READ at L780-L845, L2286-L2305, L440-L470, L7085-L7107, L8179-L8201, L8596-L8618, L8698-L8720, L9220-L9225 | PARTIAL | two-layer auth (§1 of ENDPOINT-CONTRACTS); `/ws` = PowerShell `Invoke-F99WebSocketUpgrade`; port 7331 bind `0.0.0.0`; `Test-GhrdpDashToken` at 3 groups only | **J9**; resolves the HANDOFF `/ws` open question | `/diag` L2593, `/api/diag/comprehensive` L7568, `/terminal` guard L8542 |
| `src/components/primitives/Copy.tsx` | R1 | L1-68 | PARTIAL | `CopyButton`/`CopyLink`; `value: string \| (() => string)` (lazy resolution possible) | open question for MC-P24: does `CopyLink` render the value? | L69-end |
| `src/pages/file-explorer/keymap.ts` | R1 | L1-70 | **READ** (this range) | `EXPLORER_KEYMAP` = F2, Delete, Shift+Delete, mod+c/x/v/a/z, Enter; exact-modifier matching, form fields exempt | **J8** — no in-app Alt+D conflict | bindings table consumers |
| `src/components/layout/AppShell.tsx` (shortcuts) | R1 | L456-L459 + grep | PARTIAL | `Alt+E`, `Alt+F` | confirms the in-app binding set | L1-455 |
| `src/components/layout/CommandPalette.tsx` | R1 | L21 | PARTIAL | `Ctrl/Cmd+K`, `!altKey` | — | full file |
| `src/lib/debugHudCore.js` | R3 | L57 | PARTIAL | HUD = `Shift+F12` exactly | — | full file |

### Still unread — unchanged from §3, with the two highest-value entries promoted

1. `payloads/ghrdp-server.ps1` **L2593-L2692 (`/diag`)** — WP-14 MC-P14 cannot be implemented without it.
2. `payloads/ghrdp-server.ps1` **L7568-L7990 (`/api/diag/comprehensive`)** — F96 bundle fields for WP-10.
3. `src/components/domain/PrimaryActions.tsx` (326), `WebDesktopCard.tsx` (382), `MirrorCard.tsx` (410) — the 277
   `SITE_ONLY` census rows. **Not started this session.**
4. `src/lib/explorer/*`, `src/pages/file-explorer/*` — Explorer journey J4 (the original user problem).
   **Not started this session.**
5. `src/lib/mirror.ts`, upload path — the original upload problem. **Not started this session.**
