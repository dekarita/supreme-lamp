# Mission Control — Root-Cause Investigation and Troubleshooting Matrix (PLANNING ARTIFACT)

Status: **SPECIFIED (planning)**. Classes per [spec Part B §B.5](MISSION-CONTROL-DIAGNOSTICS-SPEC.md#b5-cause-classification).
Configuration posture: **OPERATOR_CONFIRMED_CONFIGURATION** — the operator reports secrets created and setup mostly
complete. Missing runtime evidence is never treated as a missing secret; no step below asks to re-create secrets
unless a concrete configuration failure is demonstrated at the failing hop.

## 1. Operator symptoms

| Symptom | Evidence available today | Investigation (smallest first) | Current classification | Discriminating next probe | Future acceptance |
|---|---|---|---|---|---|
| "Button does nothing" | F104 global row (if the control is `SELF`-eligible: 235/301 sites); 48 sites `NO(self)` and all keyboard/submit/drag paths are invisible | 1) find the census id; 2) check capture eligibility; 3) Collector Global row: fetch list; 4) for `add-site-save`, note the 4 pre-probes run **before** the handler (up to 2.5 s each, parallel) | HYPOTHESIS per control: (a) handler short-circuit on validation; (b) pre-probe delay perceived as no-op (MC-P19); (c) control not captured | controlled test: slow `/api/health` mock (2.4 s) and measure time-to-request for add-site | every census control shows hop 2 within 100 ms (target) or an explicit "not instrumented" label |
| "Loading never ends" | per-feature spinners (NOT_READ); progress loop + WS state in telemetry store | check `progressLost`, WS pill; check request timeouts in the feature's client (R4/R6 unread) | INSUFFICIENT_EVIDENCE | read `src/api/fetch/index.ts`, `src/lib/explorer/queue.ts` for timeout/cancel paths | every async view has a terminal state within its documented timeout; spinner ⇒ "still waiting since {t}" |
| "401 despite setup" | `classifyFailure` 401/403; `dashTokenDebug()` (shape only); B5 history (#153) | 1) token source (url/stored/none) and length; 2) which channel (header vs `?key=` vs Bearer) failed; 3) runner rotated `dash-token.txt` since page load? | LIKELY for history (B5: snapshot-only validator, fixed by `Test-GhrdpDashToken` per PR #155 — RUNTIME_UNVERIFIED); otherwise HYPOTHESIS | compare failing route's validator with `Test-GhrdpDashToken` usage (server read, WP-05A); probe PR-02 | 401 rows state the channel and token source; zero 401 with a valid token on all routes |
| "Connected desktop but failed logon diagnosis" | bottom-bar last-logon row; `rdpListener.authLast`; main.yml binds AutoAdminLogon + watcher ONLOGON task to the **active session user** (fallback `runneradmin`) and syncs its password ([main.yml L4795-L4835](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/.github/workflows/main.yml#L4795-L4835)) | 1) which user did the operator RDP as (generated `rdp…` vs `runneradmin`)? 2) task principal of `GhrdpWatcher`; 3) 4624 type/TargetUser in window | HYPOTHESIS: identity split (MC-P21) — tasks bound to one account while the operator signs in as another | read-only runner probe P-07 (acceptance plan) | `autologonUser`, `activeSessionUser`, `rdpLoginUser`, `taskPrincipal` published and equal, or a machine-readable mismatch warning |
| "Upload fails" | Explorer queue/transport (NOT_READ); fx client errors (`components/explorer/api/errors.ts`, NOT_READ) | R6 read: queue → transport → `/api/fx/op` + CSRF | INSUFFICIENT_EVIDENCE | read `src/lib/explorer/{queue,transport}.ts` | upload rows carry hop ladder through server receipt and file-present effect |
| "Progress lies" | `mirrorModel` progress; `encryptMode` in status; M6 envelope encryption history | compare wire bytes vs plaintext size (encrypted length) and server-reported totals | HYPOTHESIS (encrypted-length vs plaintext progress denominators) | read `src/lib/domain/mirrorBytes.ts`, `progress.ts`, M6 test | progress denominator labelled (plaintext vs wire) and monotonic |
| "Data disappears after refresh" | collector `persistError`, `hydration.source`; DVR IndexedDB retention | 1) `persistError` text; 2) quota slimming notice "kept the newest N rows"; 3) other stores' persistence (NOT_READ) | CONFIRMED mechanism exists for quota trimming (by design, surfaced); other stores INSUFFICIENT_EVIDENCE | inventory zustand `persist` users (F111 storage inventory) | every persisted store reports hydration source and write failure |
| "Stale status" | top-bar Watcher chip = `!!mirror` (true after any progress response, never reset) | compare chip with `native.watcher.heartbeatAgeSec` | **CONFIRMED (source, deterministic)**: chip ignores heartbeat age (MC-P16); RUNTIME_UNVERIFIED display | jsdom test: progress once, then `setProgress(null)` → chip must not read ACTIVE | chips show `stale` with age; never ACTIVE without fresh heartbeat |
| "Diagnostics reports success without the actual effect" | `connections-download-rdp` logs `result:{ok:true}` regardless of `window.open` result; `ws-reconnect` logs `requested:true`; `instrumentButton` verdict = last exchange 2xx (often the follow-up GET) | check row's `request.url` vs expected mutation | **CONFIRMED (source)**: MC-P9, MC-P16 | unit tests listed in acceptance plan F-06/F-07 | ladder never shows hop 7 without an effect probe |
| "Diagnostics drawer says server not reachable" | `runDiag` maps any non-OK HTTP to that text and fetches relative `/diag` | check HTTP status in Network panel | **CONFIRMED (source)**: MC-P14 | jsdom: mock `/diag` 500 → expect "HTTP 500", not "not reachable" | drawer distinguishes network/401/5xx |

## 2. Domain coverage (every required domain)

| Domain | Source-backed requirement | Evidence state | WP |
|---|---|---|---|
| UI / rendering / routes / controls | census ids; boundary rows; capture eligibility per control | census v1 (301 sites) | WP-03A/B, WP-07 |
| Authentication / authorization | three auth shapes (header, `?key=`, Bearer); 401 rows name the channel; token never in rows | MC-P12 | WP-13, WP-05B |
| HTTP / WebSocket / reconnect | `getJson` collapses errors to `null`; WS ladder 1/3/10/30 s + 30 s ping watchdog; stale async results | R4 partly read | WP-05A, WP-06 |
| Worker / GitHub control | separate channel C4; dispatch/cancel are OPERATOR_CONTROLLED; Worker errors pass GitHub's text through | read | WP-05A (classification only) |
| PowerShell server / scheduled tasks | `Invoke-F99WatcherDiagnose` exists; task result codes; route validators | grep only | WP-05A |
| RDP session / first login | identity split (MC-P21); first-login UX requirements in #153/#156 | main.yml partial | WP-02, WP-05A |
| Tailscale / reachability | client DNS probe (copy-only guidance, F19/F20); runner FQDN self-test step | read (client) | WP-05B |
| File Explorer operations | queue/progress/cancel/retry, CSRF | NOT_READ | WP-05A (R6) |
| Search / custom sources / result quality | add-site attribution defect; F86/F87 banners | partial | WP-06 |
| Upload / mirror / encryption / large files | encrypted lengths, progress denominators | NOT_READ | WP-05A (R6) |
| Persistence / hydration / IndexedDB | collector store (read); DVR IndexedDB (grep) | partial | WP-13, WP-10 |
| Collector / HUD / boundaries | read (HUD not read) | MC-P8…P16 | WP-06, WP-13, WP-14 |
| DVR / replay / export | v1 read; v2/replay partial | partial | WP-10 |
| Live Patch producer / signature / consumer | producer absent, verifier fail-closed (#181) | re-measured | WP-08 (optional) |
| Status writers / cancellation / Pages | initial writer observed live (`runAttempt: 1`); finalizer pending; Pages verify non-asserting (MC-P7) | partial | WP-01, WP-05A |
| Build / deployment / asset provenance | `ui-sha` badge, `#ghrdpBuild`, VersionGate; workflow builds UI from prebuilt asset with SHA-256 verification (run step names) | partial | WP-04 (buildSha), WP-05B |
| CI and test blind spots | e2e-ui 0/100 recent successes; F104/F-TESTID structural; F-TESTID apostrophe blind spot | measured | WP-09, WP-03B |
| Privacy / security / configuration | MC-P8, P11, P12, P13; status.json sensitive-named fields empty in initial snapshot | measured | WP-13 |
| Performance / resource usage | 8 extra requests per instrumented click; duplicate native-status pollers (10 s + 15 s, MC-P20); per-click fetch wrappers may accumulate (MC-P22) | source | WP-06 |
| Services not present | none identified as N/A yet; Rust WS dashboard role unresolved (architecture §3) | — | WP-05A |

## 3. Problem registry (root-cause investigation)

| ID | Problem | Class | Evidence | Next discriminating step | WP / issue |
|---|---|---|---|---|---|
| MC-P1 | No Live Patch producer on `/ws` | CONFIRMED (grep scope) | 0 emitter hits; 6 `Send-F99WsText` | — | WP-08 / #181 |
| MC-P2 | #153/#156 duplicate-titled, divergent bodies | CONFIRMED | reconciliation doc | operator closure decision | WP-02 |
| MC-P3 | e2e-ui never passes since 2026-10-05 (25-min timeout) | CONFIRMED class; spec cause INSUFFICIENT_EVIDENCE | annotations; 0/100 | step log of one run (egress-blocked here) or local mock run | WP-09 |
| MC-P4 | tracked status snapshot stale (v1) | SUPERSEDED | `580f231` initial snapshot of run 37903915039 | finalizer evidence after run end | WP-01 |
| MC-P5 | `SESSION_HANDOFF_PROMPT.md` names old main | CONFIRMED | file text | edit in a docs task that owns the handoff | WP-00 |
| MC-P6 | runtime diagnostic coverage unmeasured | PARTIAL → census v1 | census | per-handler classification | WP-03A |
| MC-P7 | Pages verify step non-asserting; remediation text contradicts `build_type: workflow` | CONFIRMED (source + API) | main.yml L4430-L4431; Pages API | read Pages workflow | WP-05A |
| MC-P8 | controlled password value recorded as capture `label` | CONFIRMED mechanism (probe P-01 with controls); E2E RUNTIME_UNVERIFIED | probe; `describeClick` | browser E2E on `dash-token-input` | WP-13 |
| MC-P9 | `instrumentButton` records the last exchange (follow-up GET) and ignores handler result | CONFIRMED (source) | L805-L812, customSourcesStore L77-L82 | unit test with mocked POST 401 + GET 200 | WP-06 |
| MC-P10 | global capture appends every exchange to every pending row; status 0 = failure; constant `elapsedMs` | CONFIRMED (source) | globalClickCapture L178-L213 | two clicks within 10 s + background poll test | WP-06 |
| MC-P11 | raw `location.hash` persisted (global rows, Click-now `routeNow`, `describeEffects`) | CONFIRMED (source) | L100-L107, L1433, L1215 | unit test with `#/x?key=SYNTH` | WP-13 |
| MC-P12 | raw URLs (incl. `?key=`) and bodies kept; background polls can become "the button's request" in `instrumentButton` | CONFIRMED (source) | L541-L561, L805 | unit test: poll during action | WP-13 |
| MC-P13 | `button-actions.json` export unredacted; `maskHeaders` stores token fingerprint | CONFIRMED (source) | Collector L269-L283; L468-L475 | — | WP-13 |
| MC-P14 | `runDiag` relative `/diag`; HTTP errors shown as "not reachable" | CONFIRMED (source) | sessionStore L155-L178 | jsdom test | WP-14 |
| MC-P15 | "Click every button"/"Replay all" run 9 mutating targets without confirmation | CONFIRMED (source) | L1532-L1605; Collector L152-L179 | — | WP-14 |
| MC-P16 | success without effect: `.rdp` `ok:true`, reconnect `requested:true`, watcher chip `!!mirror` | CONFIRMED (source) | Connections L38-L49; AppShell L81, L144-L157 | jsdom tests | WP-14, WP-06 |
| MC-P17 | F-TESTID char scanner blind after a JSX-text apostrophe | CONFIRMED (differential count) | census §C.4 | AST scanner | WP-03B |
| MC-P18 | closed `DiagSideDrawer` remains focusable | LIKELY (source); RUNTIME_UNVERIFIED | `aria-hidden` without `inert` | Playwright tab-order check | WP-14 |
| MC-P19 | `instrumentButton` awaits 4 probes before the handler | CONFIRMED (source); impact HYPOTHESIS | L784 | timing test | WP-06 |
| MC-P20 | `pollNative` registered at 15 s and 10 s | CONFIRMED (source); intent unknown | polling hook L140-L141 | read hook comments | WP-06 |
| MC-P21 | RDP identity: autologon + watcher bound to active user (fallback `runneradmin`) with password sync, vs generated RDP account | CONFIRMED (source); product/security intent UNDECIDED | main.yml L4467-L4519, L4795-L4835; #156 vs #153 vs PR #154 | operator decision + probe P-07 | WP-02 |
| MC-P22 | per-click fetch wrappers can remain as dead forwarding layers when windows overlap | LIKELY (source logic); RUNTIME_UNVERIFIED | L291-L307 | unit test counting wrapper depth | WP-06 |
| MC-P23 | registry `endpoints` incomplete for some features (e.g. overview lists none though DiagBundleCard calls `/api/diag/comprehensive`) | LIKELY (source); gate semantics NOT_READ | registry JSON; DiagBundleCard | read f105 rule for endpoints | WP-03B |
