# F45 Explorer — staged implementation ledger

## Contract and reading order

Read the user-supplied `rdp-dashboard-plan.md` first, then the binding
`rdp-file-explorer-plan.md`. Explorer wins conflicts; D1–D7 are pre-approved.
This ledger does not replace either plan or claim operator acceptance.

Session branches: S1/S2 landed from `arena/01a0e638-supreme-lamp`; S3 is
authored on `arena/01a0e650-supreme-lamp`. No workflow dispatches by the agent.
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

## S4 — server routes only

Plan references: Explorer §§1.1–1.9, 5, 5.1, 5.2, 8.2, 11.1, 12.1(5). No UI
(S5+), no `/api/fx/upload/events` (S8), no Mirror write, no live gofile call, no
live runner call, no workflow dispatch. The whole Explorer server surface is ONE
delimited region inside `payloads/ghrdp-server.ps1`
(`# [F45 S4 fx-core-begin]` … `# [F45 S4 fx-core-end]`), reached from
`Invoke-ClientRequest` through a second marked block
(`# [F45 S4 fx-route-begin]`/`-end`) that runs BEFORE the parent gate; any other
path falls straight through to the parent routes, unchanged.

- `[1.1]` `GET /api/fx/list` — reads the F44 mirror index (`mirror-index.json`)
  when no Explorer index exists yet, migrates v1→v2 server-side (the port of
  `data/migrations/v1_to_v2.ts`, asserted byte-for-byte on the SHA-1 identity
  vectors in `data/fixtures/stable-id-vectors.json`, the fixture node:crypto and
  the shipped PowerShell both read as UTF-8), answers `schemaVersion: 2` + `gofileHosts`, 200 with an explicit
  `source: 'unscanned'` when nothing has been scanned, 401 `phase=auth` for a
  refused credential and 500 `phase=parse` for an unparsable index.
- `[1.2]` `GET /api/fx/meta?id=` — 200 FileEntry, 404 unknown/absent id.
- `[1.3]` `GET /api/fx/gofile/status?id=` — stored state, plus a fresh poll when
  a host token is configured; 404 unknown id, 502 (host status / unreachable),
  504 (transport) and 502 `phase=parse` for a non-JSON host reply.
- `[1.4]` `GET /api/fx/preview?id=` — local stream or an allowlisted gofile
  proxy; `Accept-Ranges: bytes`, exact `Content-Range`, 206 for a satisfied
  range, 416 + `bytes */total` when unsatisfiable, 413 `phase=size`,
  415 `phase=type`, 404 unknown, 401 unauthenticated, 502/504 for the proxy.
- `[1.5]` `POST /api/fx/op` — CSRF, in-memory application, atomic index write,
  `{applied, skipped}`; per-entry refusals are `skipped` rows
  (`unknown-id`/`no-change`/`trashed`), the REQUEST is what 400s. `hard` is a
  400 wherever it appears.
- `[1.6]` `POST /api/fx/upload` — CSRF, `%TEMP%\ghrdp\fx-upload-queue.json`
  (temp + rename), 202 `{jobs:[{id,uploadJobId}], skipped}`; the §8 worker runs
  as ONE bounded pass per 15s tick inside the server loop (single writer for
  both the queue and `fx-index.json`), with the attempt budget, the fail-fast
  set, the backoff deadline and the complete-but-redacted host message.
- `[1.7]` `/preview-sandbox/<nonce>[ /body]` — MIME-explicit HTML shell, nonce
  CSP (`default-src 'none'`, `sandbox allow-scripts`, `frame-ancestors 'self'`),
  `Origin-Agent-Cluster: ?1`, `Cross-Origin-Resource-Policy: same-site`, and a
  `SameSite=Strict` + `HttpOnly` cookie scoped to `/preview-sandbox`.
- `[1.8]` Credential redaction: `Write-FxLog` is the only log writer and every
  line passes `Protect-FxText` (known secret values first, then
  `token=…`/`Authorization: …`/`go_…` shapes). No response body interpolates a
  credential, no tokenised URL is logged, and the token can never reach the log,
  the index, the queue or a body — asserted over the wire, on disk and in the
  audit.
- `[1.9]` Every index write re-emits `schemaVersion: 2` + `gofileHosts` + the
  per-root counters, through a temp file in the same directory and a rename.

### Documented deltas (gaps in the plan text, not relaxations)

| # | Delta | Reason |
|---|---|---|
| 1 | `op: move` carries a destination DIRECTORY and keeps the file name | The plan says only "destination (relative to a root)". A full-path target would collapse every id in a multi-id request onto one path; a directory target is the only reading that can move several files. Empty/…-segments and `:|*?"<>` are refused with 400. |
| 2 | The CSRF token is derived, not stored: `sha256(dashToken + '|fx-csrf-v1')[:32]` | §5.1(4) requires CSRF but defines no derivation. The value never leaves a header, is compared in constant time, and is unavailable to a cross-site attacker. |
| 3 | `X-Idempotency-Key` is honoured server-side: identical replay returns the RECORDED response (`X-Idempotent-Replay: 1`), a key reused with a different body is 409 | §5.1(6) requires idempotency; without a recorded result a retried `op` would apply nothing and answer `applied: []`, which reads like a lost operation. Bounded ring of 50 keys, atomic write. |
| 4 | A satisfied `Range` is always 206 (even when it spans the whole file) | Media elements probe seek support with `bytes=0-`; a 200 there reads as "not seekable". |
| 5 | The sandbox cookie is NOT `Secure` | The dashboard is also served over plain tailnet HTTP; a `Secure` cookie would silently not be set there. `SameSite=Strict` + `HttpOnly` + path scope are the isolation that matters here. |
| 6 | 401 is answered for a MISSING token as well as a wrong one (the region fails closed even with no dash token configured) | The Explorer gate must not become the one surface that opens when configuration is absent. |
| 7 | A retry waits its own backoff deadline (`retryAt` on the queue row) instead of riding the 15s tick | §8.2's backoff is part of the state machine; the first retry must not be immediate just because the tick happens to fire. |
| 8 | `Send-FxResponse` is separate from `Send-ClientResponse` and DOES send reason phrases | The parent writer omits them for 206/413/415/416/502/504 (an old lab-contract choice); the Explorer response is its own contract, and the parent function is never edited. |
| 9 | `op` mutates the INDEX only — no filesystem move/delete happens on the runner from a browser request | §1.5 scopes the endpoint to CSRF + an atomic index write + the no-hard-delete rule. The runner-side action stays with the watcher/mirror lane, which already owns every disk mutation. |
| 10 | The log is append-only and the idempotency ring keeps the last 50 keys | The plan defines no retention for either; both are bounded by construction per request (the ring) or per line (the log), and S6/S7 own cleanup. |

### Windows PowerShell 5.1 compatibility (learned from the lane, pinned by a gate)

`payloads/ghrdp-server.ps1` is executed by `powershell.exe` 5.1 on the operator
host, and every row below cost a Windows-lane run before it was pinned:

| Rule | Why 5.1 needs it | Where it is enforced |
|---|---|---|
| The region and its proof stay ASCII; JSON fixtures are read as UTF-8 text | a BOM-less `.ps1` is decoded as ANSI, so a non-ASCII literal is mojibake before the script runs (the Sinhala stable-id vector hashed to the wrong digest) | `tests/f45-s4-fx-ps51.test.js` (ASCII rule) + the proof reads the fixture with `[IO.File]::ReadAllText` |
| Never pipe a document whose root is an ARRAY into `ConvertFrom-Json` | 5.1 sends a top-level JSON array through the pipeline as ONE object, so `.Count` reads 1 for a 6-vector fixture (PowerShell#3424; only 7.x enumerates). The fixture is an object (schemaVersion + vectors) and the array member is enumerated with `@($doc.vectors)` | the fixture shape and the proof reads, pinned by the gate |
| Never bind a read-only automatic variable | `param($Host ...)`, `param($Error ...)` and `foreach ($host in ...)` all throw "Cannot overwrite variable ..." BEFORE the body runs. The error envelope parameter is `-Message` (the JSON field is still `error`) and the upload host parameter is `-HostId` | the gate checks declarations, loop variables and assignments against the read-only list, in both call directions |
| Write into an ordered document with `Set-FxMember` or the indexer, never property syntax | 5.1 refuses `$ordered.NewKey = 1` ("the property cannot be found"); `$ordered['NewKey'] = 1` adds it | `Set-FxMember` is the only writer the region uses; the gate verifies every dot-write names a key its `[ordered]` literal already declares |
| Read array members through `Get-FxRows`, never `@(Get-FxMember ...)` | PowerShell drops an EMPTY array on return, so `@(Get-FxMember $o 'roots')` is a ONE-element array holding `$null`: the normalizer then fabricates a row (it produced a phantom `Temp` root and broke migration idempotency). `Get-FxRows` maps missing/null/empty to zero rows | the gate forbids `@(Get-FxMember ...)` on array members and requires every `Get-FxRows` call to stay inside `@( )` |
| Validate stored timestamps but return them VERBATIM | re-formatting a stored ISO string to 7 fractional digits made a re-normalized document differ from its input (the epoch fallback is millisecond-precision), so migration was not idempotent and every read rewrote `mtime` | `ConvertTo-FxIso` returns `$s` unchanged for a valid string and formats only a real `[datetime]`; the gate pins both halves |
| Wrap a command call in parentheses before `-and` / `-or` | `Test-FxMember $o 'k' -and $null -ne (Get-FxMember $o 'k')` is ONE command: `-and`, `$null`, `-ne` and the call become ARGUMENTS, so the right-hand condition never runs and the guard silently degrades to "the key exists". In the migration that turned `lastError: null` into `{"phase":"parse"}` on the second normalization and broke idempotency. `if ((Test-FxMember ...) -and ...)` is the only correct form | `tests/f45-s4-fx-ps51.test.js` PS1-10 walks every call site of a region helper and fails on any operator-shaped token that is not a declared parameter |
| Parenthesize every `+` expression that is an ELEMENT of an array literal | `,` binds TIGHTER than `+`, so `@('Content-Security-Policy: ' + $csp, 'Origin-Agent-Cluster: ?1', ...)` is ONE element: the sandbox shell sent a single space-joined header instead of six, which the lane reported as four separate missing-header failures | `tests/f45-s4-fx-ps51.test.js` PS1-11 fails on any array-element line that starts with a quoted string and concatenates |
| Advance the injected clock past the deadline a retry recorded | a retry sets `retryAt = clock + backoff`, so re-pinning the test clock to "now + 60s" leaves the very next pass inside the backoff window: the pass is SKIPPED and the attempt budget is never reached. The proof adds minutes per pass | the executed proof's U9 block (`$script:FxClock = (Get-FxClock).AddMinutes(5)`) |

`Add-Type -AssemblyName System.Net.Http` runs once behind a capability flag: 5.1
does not preload `System.Net.Http`, and when the assembly cannot be resolved the
transport reports the ordinary 502/504 phases instead of a type-load error.

### Local evidence (S4)

| Gate | Result |
|---|---|
| Frozen pnpm install | PASS; lockfile unchanged |
| tsc (build config + full project incl. `src/tests`) | PASS, 0 errors |
| Vitest (`pnpm test:smoke`) | 508/508 PASS, 16 files (S4 adds `fx-server-contract.test.ts`) |
| Node suites (`node --test tests/*.test.js`) | 301/301 PASS, incl. the new `tests/f45-s4-fx-routes.test.js` (10 S4 checks) and `tests/f45-s4-fx-ps51.test.js` (12 checks) |
| Every ubuntu bash gate, run verbatim (`tests/run-launch-gates.py`) | PASS 34/34, incl. the new `F45 S4 Explorer server contract + redaction gates` step (which also runs the 5.1 gate) |
| PowerShell structural + Explorer redaction audit (`tests/ps-balance-audit.py`) | PASS, 0 failed (6 shipped surfaces + the Explorer region + a shipped-surface token-literal scan) |
| Parent regression lock / fx namespace | 219/219 PASS; 10 IDs + 1 class, collision-free |
| No-neon-green / bottom-bar-time on the built bundle | PASS (557,308 bytes scanned) |
| Offline PowerShell parse of the edited surfaces (`tests/f45-s4-fx-server.ps1`, `ghrdp-server.ps1`) | both clean: 0 problem nodes each (the harness empty `Close` scriptblock, which tree-sitter reads as a MISSING node exactly like `tests/f27-windows.ps1`, is now `{ return }`) |
| Windows PowerShell 5.1 compatibility gate (`tests/f45-s4-fx-ps51.test.js`) | 12/12 PASS: read-only automatic variables, the `-Message`/`-HostId` names in both directions, PS7-only syntax, the top-level-array JSON trap, ASCII-only literals, property-vs-indexer writes on ordered documents, `Get-FxRows` for every array member, the verbatim-timestamp rule, the shared vector fixture, a bare command call that swallows `-and`/`-or` as an argument, and an unparenthesized `+` array element |
| Executed server proof (`tests/f45-s4-fx-server.ps1`) | NOT RUN LOCALLY: this sandbox has no PowerShell interpreter (no pwsh, and neither apt nor the GitHub release host is reachable). It runs as the LAST step of the windows-native job (halt-on-error), driving the shipped handler over in-memory sockets: 236 `Assert-Fx` call sites (U1-U12 unit, I1-I13 integration, some executed per case). A failed assertion is RECORDED and the run continues (capped at 60), so one lane run reports every failed site with its stage instead of only the first, and all of them reach the log as ONE compact annotation (GitHub silently caps per-site annotations); the in-memory request harness resolves offsets on an ISO-8859-1 view of the raw bytes - one char is one byte - and reports a malformed head, a request echo or a second response with an escaped byte preview instead of aborting inside a JSON parse |
| Local browser e2e | NOT RUN: `cdn.playwright.dev` is unreachable from this sandbox (`ECONNRESET`); hosted lab required |

Negative tests (the gate must be able to fail): injecting a `Write-Host` inside
the region, removing `Protect-FxText` from `Write-FxLog`, interpolating a token
into a response body, adding a wildcard CORS header, and dropping the forced
`gofileHosts`/`schemaVersion` write each make `tests/ps-balance-audit.py` (or
`tests/f45-s4-fx-routes.test.js`) fail, while each mutation was reverted.

Unit green is not a live-functionality claim. No real gofile call and no real
runner call was made; the Windows lane and the hosted lab remain the only
executed proofs for the server route cycles.

### Hosted proof and landing

Pending: this stage has not been pushed at the time of writing. Operator
checkpoints remain unchanged and pending; S5 has not started.

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
