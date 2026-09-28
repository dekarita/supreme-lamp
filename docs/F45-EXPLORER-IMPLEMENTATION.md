# F45 Explorer — staged implementation ledger

## Contract and reading order

Read the user-supplied `rdp-dashboard-plan.md` first, then the binding
`rdp-file-explorer-plan.md`. Explorer wins conflicts; D1–D7 are pre-approved.
This ledger does not replace either plan or claim operator acceptance.

Session branch: `arena/01a0e638-supreme-lamp`. No workflow dispatches by the agent.
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
