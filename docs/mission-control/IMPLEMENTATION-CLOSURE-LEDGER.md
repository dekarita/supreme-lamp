# Mission Control — Implementation Closure Ledger

**Program**: GHRDP Mission Control repair program (parent issue #191, orchestrator F-OBSERVATORY-ORCHESTRATOR v22).
**Branch**: `arena/19dded16-supreme-lamp` (this ledger lives on the implementation branch; the plan docs on
PR #207 remain the planning snapshot of record — this ledger is the IMPLEMENTATION state of record and is
kept in lockstep with the code, the tests and the PRs).
**Application revision of record for the plan**: `823bcb6e` (PR #189 merge). Main has since advanced only via
`status update` heartbeat commits touching `docs/status.json` (J11: a status.json-only commit is not a new build).
**Ledger rule**: one row per problem ID / work package / acceptance case. Statuses: `DONE` (code+tests merged
or delivered in a PR), `IN_PROGRESS`, `BLOCKED` (with the blocker named), `OPEN`, `NOT_STARTED`, `N/A` (with reason).
Evidence classes: `SOURCE_REVIEW` / `STATIC_CHECK` / `CONTROLLED_BEHAVIOR` / `BROWSER_E2E` /
`NATIVE_INTEGRATION` / `DEPLOYMENT` / `LIVE_ACCEPTANCE`.

---

## 1. Evidence summary (this delivery: WP-13 + WP-13b)

| Evidence class | Pass | Fail | Skip | Notes |
|---|---|---|---|---|
| SOURCE_REVIEW | 1 | 0 | 0 | WP-13/WP-13b source verification complete (defect map + sink map; revision 823bcb6, lines drift ±few on main). |
| STATIC_CHECK | 796 | 0 | 26 | `node --test tests/*.test.js` — 822 tests, 26 pre-existing conditional skips. Includes the new `tests/wp13-privacy.test.js` (9 pins) and the in-place rewrites (F104-h extended to F104-h2, F101-N4 masking pin, M5-e, F109-j/F110-j/F110b-h/MH-c count-lock pins at 1033). |
| CONTROLLED_BEHAVIOR | 1181 | 0 | 0 | `vitest run` — 92 files / 1181 tests, jsdom, shipped code executed. Includes 24 new tests (`wp13-privacy-redaction` 18, `wp13b-dvr-shot-privacy` 6) and the in-place rewrites (f104 submit-label, f101 masked header, f107 consent). |
| BUILD | 1 | 0 | 0 | `pnpm run build` (tsc -p tsconfig.build.json + vite single-file) — clean; `check:no-neon-green` OK (1,114,101 bytes scanned). |
| REPO CHECK SCRIPTS | 4 | 0 | 0 | `check:regression-ids` (219===219), `check:bottom-bar`, `check:fx-ids`, `check:no-neon-green` — all OK. |
| FALSIFICATION (mutation) | 4 | 0 | 0 | Each removed path restored → its falsifier reddened, then reverted: (1) `g("value")` restored → 3 behavioral + F104-h2 static redden; (2) fingerprint restored → maskSecretHeaders unit test reddens (row-level self-heals via the write-sink scrub — defense in depth); (3) consent gate removed → 2 behavioral + WP13b-1 static redden; (4) observer URL sanitization removed → WP13-2 static reddens, and with the write-sink redaction also removed → 2 row-level behavioral tests redden (both layers proven necessary). |
| BROWSER_E2E | 0 | 0 | 1 | The e2e-ui lane is the WP-09 defect (0/100, 25-min timeout, #203) — not run, not claimed. |
| NATIVE_INTEGRATION | 0 | 0 | 1 | No runner/server exercised (operator policy: no production remote-exec/credential/launch/upload probes). |
| DEPLOYMENT | 0 | 0 | 1 | No deploy dispatched; main.yml sessions untouched. |
| LIVE_ACCEPTANCE | 0 | 0 | 1 | M8 (#188/#189) preserved as merged; WP-01 (#195) is operator live-acceptance — not waited for, not cancelled, status.json never hand-edited. |

**Session budget**: this delivery consumed one implementation session of the 20% cap; no telemetry was available
in-sandbox, so usage beyond the local gate counts above is UNKNOWN (reported as UNKNOWN, not estimated).

---

## 2. Problem registry (MC-P1…P24) — implementation status

Numbering follows the orchestrator v22 registry. NOTE: the #191 body (older planning snapshot) numbers the
status.json-publication observation as MC-P24; the v22 registry uses MC-P24 for the DVR v2 screenshot/IndexedDB
sinks (WP-13b). The status.json observation is tracked here as MC-P24b to keep both rows durable.

| ID | Problem (short) | WP | Status | Evidence |
|---|---|---|---|---|
| MC-P1 | no Live Patch producer on `/ws` | WP-08 | OPEN | SOURCE_REVIEW (confirmed); emitter not built (#181) |
| MC-P2 | #153/#156 duplicate issues | WP-02 | BLOCKED (operator decision) | SOURCE_REVIEW |
| MC-P3 | e2e-ui 0/100, 25-min timeout | WP-09 | OPEN | lane history; not re-run (WP-09 owns the repair) |
| MC-P4 | stale tracked status.json | WP-01 | OPEN (operator live acceptance) | M8 merged (#188/#189); live run is operator-owned |
| MC-P5 | handoff names old main | WP-00 | DONE (docs) | plan PRs #190/#192/#207 |
| MC-P6 | runtime diagnostic coverage | WP-03A | OPEN | census v1 done (301 static control sites); runtime census pending |
| MC-P7 | Pages verify step non-asserting | WP-05A | OPEN | SOURCE_REVIEW |
| MC-P8 | controlled password value captured as `label` | WP-13 | **DONE (this PR)** | CONTROLLED_BEHAVIOR (falsifier-proven) |
| MC-P9 | add-site row records follow-up GET; verdict ignores result | WP-06 | OPEN | SOURCE_REVIEW |
| MC-P10 | global capture fan-out / status 0 = failure / constant duration | WP-06 | OPEN | SOURCE_REVIEW |
| MC-P11 | raw hash route persisted | WP-13 | **DONE (this PR)** | CONTROLLED_BEHAVIOR (falsifier-proven) |
| MC-P12 | token-bearing URLs + bodies persisted; background poll attributable | WP-13 | **DONE (this PR)** | CONTROLLED_BEHAVIOR (falsifier-proven) |
| MC-P13 | raw `button-actions.json`; token fingerprints | WP-13 | **DONE (this PR)** | CONTROLLED_BEHAVIOR (falsifier-proven) |
| MC-P14 | `/diag` drawer misclassifies failures | WP-14 | OPEN | SOURCE_REVIEW |
| MC-P15 | batch clicks run 9 mutating targets unconfirmed | WP-14 | OPEN | SOURCE_REVIEW |
| MC-P16 | success without effect (`.rdp`, reconnect, watcher chip) | WP-14 | OPEN | SOURCE_REVIEW (J3 rule binds: `state:"requested", outcome:"unobserved"`) |
| MC-P17 | F-TESTID apostrophe blind spot | WP-03B | OPEN | SOURCE_REVIEW |
| MC-P18 | closed drawer focusable | WP-14 | OPEN (LIKELY) | SOURCE_REVIEW |
| MC-P19 | pre-probes delay instrumented handler | WP-06 | OPEN | SOURCE_REVIEW |
| MC-P20 | duplicate native-status pollers | WP-06 | OPEN | SOURCE_REVIEW |
| MC-P21 | RDP identity split / password sync | WP-02 | BLOCKED (operator decision) | J4: `.rdp` row stores `http://<ip>:7331/rdp` runner IP — assigned to WP-14 to store a route template + boolean flag |
| MC-P22 | dead fetch-wrapper layers | WP-06 | OPEN (LIKELY) | SOURCE_REVIEW |
| MC-P23 | registry `endpoints` incomplete | WP-03B | OPEN (LIKELY) | SOURCE_REVIEW |
| MC-P24 | `.mcrec` v2 `shots[]` + IndexedDB `ghrdp-dvr` capture credential pixels (XMLSerializer emits text + attribute values; fence claim unsound — J6) | WP-13b | **DONE (this PR)** | CONTROLLED_BEHAVIOR (falsifier-proven) |
| MC-P24b | public status.json publishes tailnet/egress addresses + Funnel URL (no token) — the #191-body numbering | WP-05A | OPEN (observation) | SOURCE_REVIEW; operator decision on publication scope |

---

## 3. Work packages (WP-01…WP-14 + WP-13b) — implementation status

| WP | Title | Type | Status | Issue | Notes |
|---|---|---|---|---|---|
| WP-00 | Plan reconciliation + documentation | planning | DONE (docs) | — | PRs #190/#192/#207 open (plan only) |
| WP-01 | M8 live acceptance evidence | VERIFICATION_INFRASTRUCTURE | OPEN (operator) | #195 | M8 preserved merged; live acceptance is operator-owned; not waited for |
| WP-02 | F99 issue reconciliation + RDP identity decision | VERIFIED_DEFECT_REPAIR | BLOCKED (operator) | — | MC-P2/MC-P21 decisions pending |
| WP-03A | Control and evidence census | CORE_DIAGNOSTICS (research) | OPEN | #196 | census v1 done; runtime census pending |
| WP-03B | Catalog generator + CI gate | VERIFICATION_INFRASTRUCTURE | OPEN | #197 | owns MC-P17/MC-P23 |
| WP-04 | Event contract + redaction core | CORE_DIAGNOSTICS | **STARTED by this PR** | #198 | `src/lib/diagRedact.ts` IS the shared redaction core WP-04 was specified to build; WP-04's remaining scope (event contract fields) is next |
| WP-05A | Server and runner endpoint research | CORE_DIAGNOSTICS (research) | OPEN | #199 | owns MC-P7/MC-P24b |
| WP-05B | Read-only dependency health model + bounded probes | CORE_DIAGNOSTICS | OPEN | #200 | — |
| WP-06 | Causal action attribution | CORE_DIAGNOSTICS | OPEN | #201 | this PR ships the WP-13 slice of it (background polls are never a button's request); MC-P9/P10/P16/P19/P20/P22 remain |
| WP-07 | Embedded diagnostics experience | CORE_DIAGNOSTICS | OPEN | #202 | J8 binds: the RDP-browser shortcut must NOT be Alt+D (browser-reserved) — pick e.g. Ctrl+Shift+D |
| WP-08 | F110c patch emitter | OPTIONAL_IMPROVEMENT | OPEN | #181 | — |
| WP-09 | e2e-ui systematic timeout | VERIFICATION_INFRASTRUCTURE | OPEN | #203 | lane not run by this delivery |
| WP-10 | Sanitized evidence export | CORE_DIAGNOSTICS | OPEN | #204 | will reuse `diagRedact`; F96 bundle (S11) is its scope |
| WP-11 | Guided troubleshooting in product | CORE_DIAGNOSTICS | OPEN | #205 | — |
| WP-12 | Live acceptance + rollout | VERIFICATION_INFRASTRUCTURE | OPEN | #206 | — |
| WP-13 | Collector privacy defects (MC-P8/P11/P12/P13) | VERIFIED_DEFECT_REPAIR | **DONE (this PR)** | #193 | see §4 acceptance cases |
| WP-13b | `.mcrec` v2 screenshot + IndexedDB sinks (MC-P24) | VERIFIED_DEFECT_REPAIR | **DONE (this PR)** | tracked in #193 + this ledger (issue creation attempted; see §7) | see §5 acceptance cases |
| WP-14 | Diagnostic truthfulness and safety (MC-P14/P15/P16/P18 + J3/J4) | VERIFIED_DEFECT_REPAIR | OPEN | #194 | next repair after this PR |

---

## 4. WP-13 acceptance cases (issue #193) — all must pass, in scope (S1–S5, S9, S10)

| # | Acceptance case | Status | Proof |
|---|---|---|---|
| A1 | No synthetic secret in `localStorage` collector rows (S1) | PASS | `wp13-privacy-redaction` hydration tests (initial + cross-tab) + write-sink test; falsifier-proven |
| A2 | No synthetic secret in the DVR ring (S3) | PASS | `wp13-privacy-redaction` ring/bundle test (row + ring entry + envelope text) |
| A3 | No synthetic secret in `.mcrec` v1 (S4) | PASS | same test — `dvrReport()` bundle entries + envelope text carry no secret |
| A4 | No synthetic secret in `.mcrec` v2 `timeline[]` (S5) | PASS | ring entries sanitized at production (upstream `describeClick`/`currentRoute` fixes); v2 timeline is built from the same ring entries |
| A5 | No synthetic secret in `button-actions.json` (S9) | PASS | `exportableActions` fence + Collector.tsx uses it; static pin WP13-4 |
| A6 | Both hydration paths redact (S2) | PASS | initial rehydrate + cross-tab `storage`-event rehydrate tests; idempotency pinned |
| A7 | Diagnostic clipboard export clean (S10) | PASS | the DVR v1 clipboard bundle (`dvrReport().text`) is asserted secret-free in the ring/bundle test |
| A8 | Existing gates green (F104/F102/F-DVR/F101/M5/i18n) | PASS | full vitest 1181/1181 + full node suite 796/0/26 |
| A9 | Falsifiers redden when each removed path is restored | PASS | 4 mutation checks, all reddened, all reverted (§1 FALSIFICATION row) |
| A10 | Pins rewritten in place, never deleted; row counts unchanged | PASS | F104-h extended to F104-h2; f104/f101/f107/m5 smoke pins rewritten; no test file deleted; KNOWN_BUTTONS still 18 |
| A11 | `.mcrec` v2 `mutations[]` needs no claim (verified content-free) | N/A (verified) | mutationCore.js never records attribute values/text — SOURCE_REVIEW |
| A12 | `.mcrec` v2 `shots[]` (S7) + IndexedDB (S8) NOT claimed by WP-13 | N/A (split) | tracked as WP-13b/MC-P24 — DONE in this PR, §5 |
| A13 | F96 bundle (S11) NOT claimed | N/A (split) | WP-10 scope |
| A14 | Irreversibility stated: hydration pass is lossy; reverted builds keep redacted rows | PASS (stated) | ledger + code comments; never preserve an unsafe value to keep a row byte-identical |
| A15 | Previously downloaded files are not retroactively cleanable | PASS (stated) | stated here and in the PR description; no unredacted backups created |
| A16 | Rollback disables unsafe capture/export (kill-switch), never silently restores raw exposure | PASS | build flags `VITE_F104_GLOBAL_CAPTURE` / `VITE_DVR_ENABLED` / `VITE_F107_FULL_DVR` unchanged and still honored; the WP-13b consent gate defaults OFF; no raw-data path was re-added |

---

## 5. WP-13b acceptance cases (MC-P24) — all must pass

| # | Acceptance case | Status | Proof |
|---|---|---|---|
| B1 | Credential/private surfaces never enter the capture path | PASS | `prepareShotClone` strips typed input values + clears textareas + removes `[data-dvr-exclude]` subtrees BEFORE serialization; MaskedField (the revealed-password surface) renders the attribute — mounted-primitive test |
| B2 | Capture/export consent is explicit | PASS | shots default OFF; `setShotsConsented` per-session opt-in; DvrFab `dvr-shots-toggle` (aria-pressed) + note; falsifier-proven |
| B3 | Safe capture cannot be fully established → the optional pixel path is disabled while non-image diagnostics are preserved | PASS | default-off tests: click lands the timeline entry + mutation descriptors, zero shots (f107 S2 new test + wp13b consent tests) |
| B4 | Idempotent migration/redaction of owned diagnostic records (stored sessions) | PASS | `migratePurgeLegacyShots` at DB-open: deletes pre-fix shots (never copies), zeroes metas, marker-record idempotency, post-consent shots untouched — fake-indexeddb test |
| B5 | Imported recordings | N/A (no in-app import path exists) | the only `.mcrec` readers are the operator-side replay viewer (docs) and the export writer; no in-app import sink exists to migrate — stated, not skipped silently |
| B6 | Malformed/legacy data + failed persistence handled explicitly | PASS | `redactButtonAction` never throws (cyclic/class-instance tests); migration resolves `{ok,reason}` and retries next open; storage layer keeps its honest-failure contract |
| B7 | Rollback disables unsafe capture, never restores raw exposure | PASS | consent defaults OFF; removing the gate reddens the falsifiers; no pixel path was left ungated |
| B8 | i18n parity for the new consent UI | PASS | 3 keys (dvr.shotsOff/shotsOn/shotsNote) in BOTH catalogs with Sinhala translations; count lock re-measured 1030→1033 at all four pin sites |

---

## 6. Explorer / upload workflow requirements — status

The original Explorer/upload workflow repairs are a later phase of the program (after WP-13/13b, WP-14,
WP-04/WP-06). Nothing in this delivery touches them. Recorded so the ledger covers the requirement:

| Requirement | Status | Notes |
|---|---|---|
| Explorer keymap `F2, Delete, Shift+Delete, mod+c/x/v/a/z, Enter` (keymap.ts L22-L32) | NOT_STARTED | WP-11/WP-14 phase; no changes made |
| Explorer/mirror server ops (R6) | NOT_STARTED | WP-05A research owns the endpoint questions |
| Upload workflow (F88/F56 own-credential path) | NOT_STARTED | no production upload endpoints exercised (operator policy) |
| `PrimaryActions.tsx`, `WebDesktopCard.tsx`, `MirrorCard.tsx`, `src/pages/file-explorer/*` reads | PARTIAL | WebDesktopCard read (vncPassInput marked `data-dvr-exclude`); the rest are WP-03A/WP-11 scope |

---

## 7. New defects / observations found during THIS implementation

| ID | Finding | Disposition |
|---|---|---|
| ND-1 | `/api/config` responses carry RAW passwords (`creds.windowsPass`, `creds.vncPass`) when dash-token/tailnet authenticated (server L8956-L8985), and `sessionStore` polls it — the old observer persisted up to 2000 chars of those bodies into rows attributed to clicks | CLOSED by WP-13 (body scrub + app-only attribution); server contract unchanged (the UI needs those fields for copy buttons) |
| ND-2 | `instrumentButton` attributed background polls to clicks (MC-P12 attribution half) — a poll landing inside the click window was persisted as the button's request/response | CLOSED by WP-13 (app-only attribution); two f101 smoke tests updated in place to drive an app-classified route |
| ND-3 | `MaskedField` renders the RAW password as visible text when revealed — the old screenshot fence rasterized it into PNGs | CLOSED by WP-13b (data-dvr-exclude + consent default-off) |
| ND-4 | React 18 reflects controlled input values into the `value` attribute — `cloneNode` + `XMLSerializer` carried typed passwords into screenshots (the "structure-only" fence claim was unsound, J6) | CLOSED by WP-13b (prepareShotClone strips typed values) |
| ND-5 | The i18n count lock is read literally by FOUR pin files (parity + F109-j + F110-j + F110b-h + MH-c) — a deliberate catalog addition must move all of them | handled in this PR (all four updated with dated notes); process note for future catalog additions |
| ND-6 | `scrubSecretText`'s assignment pattern needs `?`/`#` in the prefix class so `?key=…` / `#key=…` in free text (old verdict reasons) are redacted | CLOSED in this PR (pattern + test) |
| ND-7 | Issue/comment writes via the integration were previously denied ("Resource not accessible by integration") | probed again this session (see PR description); copy-ready artifacts delivered in the PR body instead of loop-retrying |

---

## 8. Delivery record

- **Branch**: `arena/19dded16-supreme-lamp` (all work committed here; pushed only here).
- **PR**: **#208** — "WP-13 + WP-13b: Collector privacy + DVR screenshot/IndexedDB privacy repair (#193)",
  base `main`, head `arena/19dded16-supreme-lamp`. Open, awaiting review. **Not merged** — separate merge
  authorization required.
- **Issues**: **#209** created (WP-13b child, linked to #191 in its body; creation is permitted).
  Issue **comment/edit writes are DENIED** to the integration ("Resource not accessible by integration" —
  probed once each on 2026-10-09, no loop-retry per standing constraint). Copy-ready artifacts delivered:
  the #193 comment text is in the PR #208 body; the full updated #193 body (with the implementation-update
  section) is preserved in the PR body's copy-ready block. **One operator publication action**: paste the
  comment from PR #208's body onto #193 (or grant the integration `issues: write` and the session will retry).
- **Commits**: see `git log` on the branch — one commit for the WP-13+WP-13b implementation (code + tests +
  pin rewrites + ledger).
- **CI on push**: `launch-gates.yml` (push trigger, contents:read + statuses:write — ordinary verification)
  and `build-ui.yml` (publishes a SHA-pinned `ui-dist-<sha>.zip` asset to the `ui-dist` release — the standard
  per-arena-branch artifact flow; production downloads are SHA-pinned and unaffected). `main.yml` (the
  operator-only production workflow) is `workflow_dispatch`-only — **not invoked** by this push. e2e-ui
  (push: main only) not triggered; it runs on the PR.
- **Not done (explicitly)**: no merge; no main.yml dispatch/cancel/rerun; no operator account/credential/
  secret changes; no production remote-exec/credential/launch/upload/deletion/action-batch endpoints
  exercised; no repository-protection bypass; no hand-edited status.json; no unredacted backups; no other
  branch touched; plan PRs #190/#192/#207 untouched.

## 9. Next repairs (priority order, per the orchestrator)

1. **WP-14** (#194): MC-P14 (`/diag` misclassification), MC-P15 (batch mutating targets unconfirmed),
   MC-P16 (success-without-effect: `.rdp` `ok:true` regardless of popup result — ship
   `state:"requested", outcome:"unobserved"` per J3; reconnect logs only `requested`; watcher chip ignores
   heartbeat age), MC-P18 (closed drawer focusable), + J4 (`.rdp` row stores `http://<ip>:7331/rdp` — store a
   route template + boolean flag instead of the runner IP).
2. **WP-04** (#198): event contract on top of the now-shipped `diagRedact` core + **WP-06** (#201): causal
   attribution (MC-P9/P10/P19/P20/P22).
3. Original Explorer/upload workflow repairs (§6).
4. Census/integrated diagnostics (WP-03A/B, WP-05A/B, WP-07, WP-10, WP-11), WP-09 (#203), WP-08 (#181),
   preserving M8 (#188/#189 merged).
