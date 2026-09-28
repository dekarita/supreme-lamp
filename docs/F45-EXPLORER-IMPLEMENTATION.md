# F45 Explorer — staged implementation ledger

## Contract and reading order

Read the user-supplied `rdp-dashboard-plan.md` first, then the binding
`rdp-file-explorer-plan.md`. Explorer wins conflicts; D1–D7 are pre-approved.
This ledger does not replace either plan or claim operator acceptance.

Session branches: S1/S2 landed from `arena/01a0e638-supreme-lamp`; S3 is
authored on `arena/01a0e650-supreme-lamp`; S4 is authored on
`arena/01a0e6c3-supreme-lamp`. No workflow dispatches by the agent.
Landing: session push → PR → all CI green → merge commit, never squash/rebase,
force-push, amend pushed history, or push main. Subsequent stages wait for the
previous stage's green lab/landing. Production dispatch is operator-only.

## Recon delta (published before code, 2026-09-28 UTC)

Checkout `4acc8c104cf46da3b35dfa8f6289f8173f538372`; remote main observed at
`de561152e8e2140af977285778314294848058b9`. Only `docs/status.json` differed.

| Contract | Verified source reality | Required delta |
|---|---|---|
| Parent F41/F42/F43 cutover | `$script:UiV2Default = $true`; `?ui=v1` fallback and missing-v2 banner retained | Preserve; live acceptance is not inferred from source |
| Ephemeral staging | `main.yml` build-ui → dist-ui → rdp staging to ui-v2.html; >51200B assertion | Preserve; later chunks need gated staging too |
| Route `/files`, lazy chunks | HashRouter in App.tsx, single-file Vite plugin, no router.tsx or Files page | Routing + bundle + gated server asset handling required before UI exposure |
| Parent primitives | Six consolidated primitive files, not every proposed file | Reuse, do not fork |
| 219 identifier lock | 219 actual IDs; source cross-check + landing DOM test | Freeze separately from fx namespace; route DOM proof at S5 |
| Legacy APIs | native-status/config/rdp-token/rdp-creds/handler-hello/purge-stale-creds present; extra telemetry/progress APIs | No fx endpoints yet; add by scheduled stage |
| Header auth, CSRF, no URL keys | Existing lib/api.ts reads `?key=`; parent security is not Explorer's contract | New safe exchange/transport required; do not copy URL auth into Explorer |
| No CORS / CSP | Send-ClientResponse emits wildcard CORS; required dashboard CSP absent | Must resolve before serving Explorer; compatibility tests required |
| Mirror OFF + gate | Existing launch-gates F11 MIRROR_INPUT gate requires explicit true | Preserve unchanged |
| F44 error visibility | PR #76 open; its diagnostic cell failed in run 36348826538; main lacks that implementation | Not a proven dependency; do not claim F44 compliance or merge its red lab |
| PS audit | tests/ps-balance-audit.py exists; scripts/ps-balance-audit.mjs does not | Keep structural audit; add redaction integration at S4 |
| Lab lanes | launch-gates gates + windows-native; autologin-lab proof push-triggered | Add stage annotations; no agent dispatch |
| Test paths | src/tests/smoke and src/tests/e2e | Follow actual test discovery, not a second unused tests tree |
| Preview isolation | Path/OAC is not a distinct origin; sandbox without allow-same-origin is opaque | Authenticated parent fetch + credential-free message/data bridge needs browser proof; never weaken sandbox/CORS |
| Preview crypto | Tailnet plain HTTP may lack SubtleCrypto secure-context support | Fail closed or require operator-accessible HTTPS; no insecure crypto fallback |
| Sinhala | Existing base has pending native review | S9 markers; S11 requires written reviewer sign-off |

### Plan ambiguities tracked (not silent implementation shortcuts)

- Explorer §11.2 lists **six** e2e specs despite brief saying five. Cover all six.
- D1/§1.4 z-45 is above z-40; keep drawer spatially below TopBar (`top-12`).
- §8 retry sketch permits too much: §5.2 plus brief require 401/403/413/415
  fail-fast and transient-only retries, including full untruncated host messages.
- §11.1 says all 219 IDs on `/files`; §12.1 says no F38 ID leaks. S5 must
  resolve preservation via existing shell/adapters, not invent invisible proof.
- Browser storage is not path-isolated; cookies scoped to `/dashboard` alone do
  not establish an authentication flow for root dashboard/API routes.
- Iframe Escape events do not bubble to parent: S8/S9 require a validated message
  bridge/focus restoration test. Modern marked has no `sanitize=true` contract;
  DOMPurify remains mandatory.
- Singlefile inlining is incompatible with independent lazy chunk budgets.
  Measure shell separately from fonts; do not relabel an inlined renderer lazy.

## S1 — namespace + additive tokens only

Plan references: Explorer §§1, 2 adapter policy, 3.3, 11.3, 12.1(1–2), D1;
parent §§1, 8.2–8.3, 9.1. No UI, routes, server, Mirror state, or data changes.

- Frozen 10 stable IDs explicitly named by the plan, plus `fx-upload-wrapper`.
  Future stable hooks require an explicit lock amendment with plan references;
  per-file rows should use data attributes, not file-derived or repeated IDs.
- TypeScript AST gate checks production TSX (including page/layout adapters),
  ignores comments, checks literals/JSX string expressions, rejects dynamic IDs
  in Explorer adapters, unknown fx classes and duplicate static ID declarations.
  This is **source coverage**, not a claim of DOM coverage before S5. The later
  DOM test must also catch runtime duplication/props spread effects.
- Added all six light/dark colors, five spacing values and three z-index tokens
  with Tailwind aliases; parent token values and no-neon regex unchanged.
- Source lock + negative/CRLF tests and exact token/alias tests discovered by
  existing Vitest config. Gates wired into launch-gates and production build-ui.
- Stage-labelled annotations for the new gate and smoke failures.

### Local evidence

| Gate | Result |
|---|---|
| Frozen pnpm install | PASS; lockfile unchanged |
| tsc + Vite production build | PASS |
| Vitest | 33/33 PASS (17 new S1 assertions) |
| Parent regression lock | 219/219 PASS |
| fx namespace gate | 10 IDs + 1 class; collision-free PASS |
| No-neon-green / bottom-bar-time scripts | PASS |
| Node regression suites | 279/279 PASS |
| PowerShell structural audit (existing Python gate) | PASS, 0 failed; no .ps1 touched |
| Shell gzip, inlined font data excluded | 128397 bytes, below 180 KB; no Explorer JS imported |
| Local browser e2e | NOT RUN: Playwright Chromium download failed; hosted lab required |

Build/test output also includes existing CSS-minifier, React Router, javascript:
link, and jsdom canvas warnings; a green unit run is not an a11y claim.
No real gofile calls made.

### Hosted proof and landing

S1 PR [#77](https://github.com/dekarita/supreme-lamp/pull/77), head
`2516f583558d2707ca2d93c44f953e9690d4d2b1`, merged via merge commit
`a82ca95abbd6714a9b8ed2cba405397ce447551a` after all checks passed:

| Run | Lane | Result |
|---|---|---|
| 36377176728 | push launch-gates (gates + windows-native + hosted e2e) | PASS |
| 36377206695 | PR launch-gates (gates + windows-native + hosted e2e) | PASS |
| 36377176756 | push autologin-lab proof | PASS |

No dispatch. No operator quote required for S1. S2 began only after this merge.

### Operator checkpoints

- After S7: **PENDING — no written operator quote supplied**. Operator dispatches
  main.yml and checks exact phase/status/full error plus retry gating; enabling
  Mirror remains exclusively the operator's choice.
- S8 → S9: **BLOCKED until written confirmation** of the required checkpoint.
- After S10 / before S11: **PENDING — no written operator quote supplied**.
- Sinhala native review: **PENDING**.

Do not emit the final EXPLORER LIVE declaration before the required written
operator confirmation. This S1 change does not make Explorer live.


## S2 — data only

Plan references: Explorer §§4, 4.2, 11.1, 12.1(3). No UI, API clients or server
routes exposed. No live gofile calls. Schema v2 models all specified fields;
migration handles missing/partial nested data without mutation and preserves
complete host errors. 5000-file JSON plus a deterministic regeneration script,
41-case MIME map, archived v1 fixture, and MSW reserved-host handlers cover
success/processing/expired/403/413/415/502 (including recovery sequence).
MSW is dev-only and unhandled requests fail closed.

Migration safety notes are in `data/migrations/MIGRATIONS.md`: epoch fallback
rather than a fabricated current timestamp; unknown fields not copied (as in
plan sketch); credential-bearing direct URLs discarded; one configured host.
SHA-1 here is stable identity only, independently checked against Node crypto.
Fixtures/migration are not permission or filesystem-path validators, and cannot
enable destructive operations on archived data.

Local proof: 35 new data/mock assertions pass, including partial JSON,
idempotency, non-mutation, UTF-8 identity, exact full host errors and no network
fallback. Stage-specific annotations wired. Hosted proof/landing pending.
Operator checkpoints remain pending as above; S3 has not started.

## S3 — endpoint clients only

Plan references: Explorer §§5, 5.1, 5.2, 8.2, 11.1, 12.1(4). No server routes
(S4), no UI (S5+), no Mirror state change, no live gofile call, no live runner
call. Nothing in the production bundle imports this layer yet — asserted by a
new gate, not by inspection.

- `api/errors.ts` — §5.2 HTTP → F44 phase mapping, `FxError` carrying the
  COMPLETE host message, `Retry-After` parsing, and credential redaction.
- `api/retryPolicy.ts` — §8.2 transient-only gating: `dns|tcp|tls|http` retry,
  everything else is terminal; five attempts for a transient failure, one for
  anything else; jittered exponential backoff (500ms base, 8s cap, 100ms floor).
- `api/fxClient.ts` — dash-token transport. Token travels in `X-Dash-Token`
  only; a URL containing the token or a `key=`/`token=` parameter is refused
  before sending. POST requires `X-CSRF-Token` (§5.1/4) and fails closed
  without one. Cross-origin base refused (§5.1/8, D4). `cache: no-store`.
- `api/endpoints.ts` — typed clients for `/api/fx/list`, `/meta`,
  `/gofile/status`, `/op`, `/upload`, plus same-origin URL builders for
  `/preview` and `/upload/events` (their clients land with S4/S8). Every
  response is validated; anything unexpected is a `parse` FxError, so a v1 index
  is rejected (§12.5) rather than half-rendered.
- Smoke: `fx-retry-policy.test.ts` (table-driven over all 9 phases × 14
  statuses = 126 combinations, asserted three ways, with expectations
  transcribed from the plan text rather than from the implementation) and
  `fx-endpoint-client.test.ts` (offline MSW: header/CSRF/idempotency transport,
  fail-fast attempt counts, transient recovery, budget exhaustion, Retry-After
  floor, transport failure, v1 rejection, redaction, fail-closed on an
  unconfigured URL).

### Documented deltas (gaps in the plan text, not relaxations)

| # | Delta | Reason |
|---|---|---|
| 1 | Fail-fast set is 401/403/413/415, and `maxAttempts` agrees with `canRetry` for all four | §8.2's sketch listed `{403,413,415}` and only special-cased 403/413 in `maxAttempts`; §5.2 marks 401 non-retryable and the ledger requires fail-fast. |
| 2 | 400 (bad op) and 409 (concurrent scan) map to the non-retryable `parse` phase and `fx.err.parse` | §5.2 has no row for either. Reuses an existing key instead of inventing i18n before S10. |
| 3 | HTTP 504 → phase `tcp`; a request with NO HTTP response → phase `dns` | §5.2 writes 504's phase as "tcp/tls/dns", which is not a single `UploadPhase`. Both are transient, so retry behaviour is identical; the split is presentational. |
| 4 | `directUrl` must be null unless `gofile.status === 'uploaded'` | §4 invariant, enforced client-side so a fabricated or credential-bearing link can never be rendered or copied. |
| 5 | `/op` refuses a `hard` flag client-side | §5.1(3): no hard delete anywhere. The type cannot express it, and untyped JSON carrying one is rejected before the request is built. |
| 6 | `Retry-After` is a floor, clamped to 120s | The server hint must win when longer than the jittered delay, but a hostile or buggy header must not park the queue. |
| 7 | `canRetry(state)` kept faithful to the §8.2 sketch (classification only); `shouldRetryNow(state)` adds the attempt budget | Avoids silently redefining the sketch while giving S7 the correct call to make. |

## Ride-along: F42/F43 e2e timeout root cause (not an S2/S3 code defect)

Launch-gates 36377955417 (push, sha `5bc3412`) failed at
`f42-ui-routing.spec.ts:53` with "Test timeout of 60000ms exceeded" while the
pull_request run 36377980668 on the SAME sha passed. Run 36347561362 failed the
same way at `f43-default-v2.spec.ts:61` — the identical shape in the other spec,
on a branch that predates S2. Neither file is touched by S2 or S3.

Cause: both tests start a v1-only fixture inside the test body and await
`closeV1()` in a `finally` while their own page is still alive. The v1 payload
polls `/api/progress` every 3000ms (`payloads/ui.html:1114`), so at the instant
`server.close()` runs the browser keep-alive socket is often still carrying a
request. `server.close()` only reaps sockets idle at that moment (node ≥ 19);
the rest must be hung up by the browser first, so the promise never settles and
the test spends its whole 60s budget in `finally`. Measured against the real
`startFixture` on node 22.22.3: all sockets idle → `close()` settles in 1ms; one
in-flight request → `close()` never settles (8s watchdog). After the fix the
in-flight case settles in 0ms.

Fix (timing only — no assertion, selector or served byte changed):
`closeIdleConnections()` + `closeAllConnections()` (node ≥ 18.2, optional-called
for older runtimes) plus a 5s unref'd watchdog. Also `navigationTimeout: 30000`
so a stuck `page.goto` reports a named navigation timeout with its call log
instead of an opaque test timeout, and the `E2E-FAIL` annotation bridge now
emits the per-test block (where playwright prints the pending "Call log") rather
than `tail -c 2200` of the run summary, which is why this was un-diagnosable
from the annotation alone.

### Local evidence (S3 + ride-along)

| Gate | Result |
|---|---|
| Frozen pnpm install | PASS; lockfile unchanged |
| tsc, full project including `src/tests` | PASS, 0 errors |
| Vitest | 498/498 PASS (15 files; 430 new S3 assertions) |
| S2 data/mock subset | 35/35 PASS |
| Parent regression lock | 219/219 PASS |
| fx namespace gate | 10 IDs + 1 class; collision-free PASS (no `.tsx` added) |
| No-neon-green / bottom-bar-time scripts | PASS |
| F40 IA gate / Node regression suites | PASS / 279/279 PASS |
| PowerShell structural audit | PASS, 0 failed; no `.ps1` touched |
| S3 credential-in-URL guard | CLEAN over `src/components/explorer/api/` |
| S3 absent from shipped bundle | PASS: 0 hits for `X-Dash-Token`, `api/fx/list`, `fx.err.hostBadGateway` in `ui/dist/index.html` |
| Shell gzip (inlined font data excluded) | 127873 bytes, below the 180 KB budget; unchanged by S3 |
| Fixture teardown probe (node, real `startFixture`) | idle 1ms → 0ms; in-flight HANG → 0ms |
| Local browser e2e | NOT RUN: `cdn.playwright.dev` is unreachable from this sandbox (`ECONNRESET`); hosted lab required |

Unit green is not a live-functionality claim and not an a11y claim. No real
gofile call and no real runner call was made.

### Hosted proof and landing

Pending: this stage has not been pushed at the time of writing. Operator
checkpoints above remain unchanged and pending; S4 has not started.


## S4 — server-side Explorer routes (fx)

Plan references: Explorer §1.1–1.9, §3, §5 endpoint contract, §7 sandbox
isolation, §8 upload state machine; parent §§2, 8.2–8.3, 9.1. No UI (S5+), no
Mirror state change, no live gofile call, no live runner call. The
user-supplied `rdp-file-explorer-plan.md` is NOT in this checkout; the binding
contract used here is the S3 client (`src/components/explorer/api/endpoints.ts`
validators) plus the S2 data layer (`schema.ts`, `migrations/`), which the S3
ledger already records as the de-facto contract.

### What landed

- `payloads/ghrdp-fx.ps1` (NEW): the route implementation, deployed next to the
  server and DOT-SOURCED by `payloads/ghrdp-server.ps1` (never copied), so the
  server, the S4 test and any later stage execute ONE implementation. Routes:
  `/api/fx/list` (schemaVersion-2 emission + v1 migration), `/api/fx/meta`,
  `/api/fx/gofile/status` (cached; live poll only when a host token is
  configured), `/api/fx/preview` (Range/206, 416, 413 cap, 415 allowlist,
  credential-free direct links only), `/api/fx/op` (CSRF; atomic index write),
  `/api/fx/upload` (CSRF; durable queue at `%TEMP%\ghrdp\fx-upload-queue.json`;
  background worker per §8), `/preview-sandbox/<id>` (MIME-explicit shell; CSP,
  `Origin-Agent-Cluster: ?1`, `Cross-Origin-Resource-Policy: same-site`,
  SameSite=Strict CSRF cookie). One redaction funnel (`Protect-FxText` →
  `***REDACTED***`) guards every log line and every error body.
- `payloads/ghrdp-server.ps1`: module load with a fail-visible 503 when the
  module is missing, request-context translation, response passthrough through
  the single `Send-ClientResponse` writer (status text for 202/206/400/401/403/
  404/405/409/413/415/416/429/500/502/503/504), redacted 500 on a thrown route,
  per-process CSRF token, worker start after LISTENING.
- `.github/workflows/main.yml`: stages the module next to the server.
- `.github/workflows/launch-gates.yml`: parses the module + the new test in the
  windows-native language-parser step; runs `tests/f45-fx-server.ps1`; runs
  `scripts/ps-balance-audit.mjs` plus source-level F45 assertions in the gates job.
- `scripts/ps-balance-audit.mjs` (NEW): the node twin of the Python structural
  audit (same tokenizer) with the F45 contract checks; `tests/f45-fx-server.test.js`
  imports its `audit()` and proves the audit is not vacuous.
- `tests/f45-fx-server.ps1` (NEW): unit matrix (mock index + mock host through
  the injectable Fetch/Uploader seam) and the REAL server over loopback HTTP
  (dash-token 401, 200/206/416/413/415/404, CSRF 403/200, upload 202, sandbox
  headers, credential-redaction sweep over every log the run produced).
- `tests/f45-fx-server.test.js` (NEW): pins the route table, the 41-value MIME
  allowlist against `preview-mime-map.json`, the redaction funnel, atomic
  schemaVersion-2 emission with `gofileHosts`, the deployment staging and both
  lanes' wiring.
- `tests/ps-balance-audit.py`: audits the module and the new test too.

### Decisions and deltas (explicit, not silent)

| # | Decision | Why |
|---|---|---|
| 1 | Index path `%Root%\fx-index.json` (env `GHRDP_FX_INDEX_PATH` override) | F44's mirror index is not a proven dependency (PR #76 open and red); the route reads the runner-owned index next to the server. |
| 2 | Auth = `X-Dash-Token` (or `Authorization: Bearer`); a credential in the QUERY STRING is refused with 401 | S3 client sends the header only; `?key=` must never authorise an Explorer call. |
| 3 | POST requires `X-CSRF-Token` equal to the per-process token, delivered as the `ghrdp_fx_csrf` SameSite=Strict cookie | CSRF is not inferable from the dash token; the cookie is readable by the dashboard only. |
| 4 | 504 for a host timeout, 502 otherwise, both with `Retry-After` | Matches S3 `errors.ts` (retryable transients) and §5.2's phase split (504 → `tcp`). |
| 5 | `move` rewrites the stable id (SHA-1(root+path)); the response reports the REQUIRED id | Identity is content-addressed, so a moved file is a new id; the client must be able to correlate. |
| 6 | `hard=true` and unknown ops are refused 400 | §5.1(3): no hard delete anywhere, and an untyped op must not be a no-op. |
| 7 | No host token → the upload job is HELD (`queued`) with `phase=auth` recorded, never sent anonymously and never dropped | A silent drop is exactly the red-without-why failure mode this project keeps paying for. |
| 8 | Preview cap 64 MiB default (`fxPreviewMaxBytes` / `Options.PreviewMaxBytes`) | Fail-closed before reading a multi-GB file into memory; the lab lowers it to prove 413. |
| 9 | The sandbox shell is MIME-explicit, `script-src 'none'`, GET-only | §7: the renderer is chosen server-side; no script execution in the isolated surface. |

### Local evidence (S4)

| Gate | Result |
|---|---|
| Frozen pnpm install | PASS; lockfile unchanged |
| tsc + `vite build` | PASS (`ui/dist/index.html`, 557 kB) |
| Vitest | 498/498 PASS (15 files; unchanged by S4) |
| Node regression suites | 293/293 PASS (279 + 14 new S4 assertions) |
| PowerShell structural audits (py + mjs) | PASS, 0 surfaces failed |
| F45 S4 mjs contract surface | PASS (routes, statuses, CSRF, atomic write, MIME fixture, redaction, staging, lanes) |
| 219-ID lock / fx-* namespace | 219/219 PASS; 10 IDs + 1 class, collision-free |
| No-neon-green / bottom-bar-time | PASS / PASS |
| Browser e2e (10 specs) | NOT RUN locally: `cdn.playwright.dev` is unreachable from this sandbox; hosted lane required |
| PowerShell execution | NOT RUN locally: no `pwsh` in the sandbox and the download hosts are blocked; the real parse/execution proof is the hosted windows-native lane (`Parse native PowerShell scripts` + the F45 step) |

No operator confirmation and no live-functionality claim is made here. No real
gofile call, no real runner call, no workflow dispatch.

### Hosted proof and landing

Pending until the push/PR runs finish; see the stage report.
