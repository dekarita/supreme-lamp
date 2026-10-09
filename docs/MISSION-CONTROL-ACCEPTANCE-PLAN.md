# Mission Control — Acceptance and Fault-Injection Plan (PLANNING ARTIFACT)

Status: **SPECIFIED (planning)**; no production test is added by this document. Verification classes are reported
separately and never merged: `SOURCE_REVIEW` · `STATIC_CHECK` · `CONTROLLED_BEHAVIOR` · `BROWSER_E2E` ·
`NATIVE_INTEGRATION` · `DEPLOYMENT` · `LIVE_ACCEPTANCE`. `NOT_MEASURED` is a result, not a failure and not an absence.

## 1. Current verification state (denominators defined)

| Class | Denominator | Measured now | Result | Notes |
|---|---|---|---|---|
| SOURCE_REVIEW | 301 static DOM control call-sites (census) | 24 handler bodies read | 24/301 HANDLER_READ | others SITE_ONLY |
| STATIC_CHECK | 11 existing node gates relevant to this cluster (f-testid, f104, f102, f101-residual, f105, m2, f-dvr-lite, f107, f109, f106, f96) | executed this session | **106/106 tests pass** | all structural/string pins for this cluster; F-TESTID blind spot MC-P17 |
| CONTROLLED_BEHAVIOR | isolated probes run this session | 1 (P-01, 3 cases) | mechanism confirmed | §3 |
| BROWSER_E2E | `e2e-ui` lane runs | latest 100 runs | **0 success** (92 cancelled @25 min, 8 failure) | last success 2026-10-05 run 37285114245 |
| NATIVE_INTEGRATION | windows-native lane on `823bcb6` | 1 | success (per v1, merge-SHA check) | M8 behavioural harness |
| DEPLOYMENT | run 37903915039 steps 1-58 | observed via API | completed success (step 40 is non-asserting) | MC-P7 |
| LIVE_ACCEPTANCE | M8 runbook stages A–D | A observed (operator dispatch) | B–D **LIVE_ACCEPTANCE_NOT_EVIDENCED** (run in progress) | WP-01 |
| Feature runtime diagnostics | 11 registry features | 0 measured | NOT_MEASURED | WP-05B/07 |

## 2. Required test cases (future implementation; each must first be shown to fail on a broken variant)

| ID | Scenario | Class | Setup | Pass condition | Falsifier (must redden) |
|---|---|---|---|---|---|
| F-01 | Real handler + real effect | CONTROLLED_BEHAVIOR | jsdom, mock backend; add-site save | row `request` is the POST; ladder reaches hop 7 only when the list contains the new site | return list without the site → hop 7 missing |
| F-02 | Unsupported / disabled control | CONTROLLED_BEHAVIOR | disabled `search-cancel` | row "disabled" with reason; no request | enable via CSS only → still recorded disabled |
| F-03 | Empty / malformed / missing data | CONTROLLED_BEHAVIOR | `/diag` returns `{}`, invalid JSON, 204 | drawer shows "malformed" vs "empty" distinctly | collapse to one message |
| F-04 | Auth expiry / denied | CONTROLLED_BEHAVIOR | token rotated mid-session (401) | row names channel + token source; summary `unauthorized` | 401 shown as unreachable |
| F-05 | Network loss, slow response, reconnect | CONTROLLED_BEHAVIOR + BROWSER_E2E | drop `/ws`, delay `/api/progress` 10 s | WS ladder visible; terminal states within timeout; `stale` with age | spinner without bound |
| F-06 | Concurrent actions + background polling | CONTROLLED_BEHAVIOR | two clicks 1 s apart, `/ping` every 5 s | each row has only its EXPLICIT exchanges; TEMPORAL ones labelled | fan-out to both rows (today's MC-P10) |
| F-07 | False causal attribution | CONTROLLED_BEHAVIOR | add-site POST → 401, then `/api/progress` 200 inside the window | verdict fail on POST | today's last-exchange rule (MC-P9/P12) |
| F-08 | Refresh + failed persistence | CONTROLLED_BEHAVIOR | quota-throwing storage stub | `persistError` visible; rows kept in memory; banner after reload | silent drop |
| F-09 | Stale / out-of-order async | CONTROLLED_BEHAVIOR | response A (slow) after response B | UI keeps B; row marks A `superseded` | A overwrites B |
| F-10 | Cancellation + terminal monotonicity | CONTROLLED_BEHAVIOR | cancel search mid-flight | lifecycle `cancelled` final; later success ignored | terminal state flips |
| F-11 | Large file length / progress / partial transfer | NATIVE_INTEGRATION | encrypted upload 3 sizes | progress denominator labelled; partial transfer = failed with bytes | plaintext/wire mix |
| F-12 | Silent boundary failure + recovery | CONTROLLED_BEHAVIOR | throw in a chrome surface | collector row + drawer card; retries ≤ 3 | chrome null with no row |
| F-13 | Redaction before storage/export | CONTROLLED_BEHAVIOR | synthetic token in `?key=`, `#/x?key=`, `Authorization`, password input value | none of the synthetic values appears in localStorage, DVR ring, `button-actions.json`, `.mcrec` | remove one rule → test reddens |
| F-14 | Wrong build provenance | CONTROLLED_BEHAVIOR | `data-build` ≠ backend sha | summary `failed: build mismatch`; rows carry both shas | rows without sha |
| F-15 | Side-effect gating | CONTROLLED_BEHAVIOR | "Click every button" | mutating targets skipped unless confirmed per effect | batch runs all |
| F-16 | Drawer a11y | BROWSER_E2E | Tab through page with drawer closed | no focus inside closed drawer; focus returns on close | `aria-hidden` only |

M8 lessons applied to every case: pin actual use (not imports); execute shipped code (transpile, do not copy);
validate the harness (positive and negative controls); verify mutations apply; reject early-exit and
disabled-effect variants; restore controls after falsification; investigate nondeterminism; skipped/cancelled/not
run never counts as passed.

## 3. Probes

### P-01 (executed 2026-10-09, CONTROLLED_BEHAVIOR, isolated, synthetic value)

Question: does the shipped `describeClick()` record a React-controlled password value? Harness: `/tmp` only;
`typescript.transpileModule` of `src/lib/globalClickCapture.ts` (shipped code, not a copy), React 18.3.1 +
react-dom 18.3.1 + jsdom 25.0.1, value `SYNTHETIC-not-a-real-token-123`.

| Case | `value` attribute | `describeClick().label` | Leaks |
|---|---|---|---|
| A controlled, testid, no aria-label (shape of `dash-token-input`, `cred-password`) | synthetic value | synthetic value | **yes** |
| B controlled + `aria-label` (negative control) | synthetic value | "Dashboard token" | no |
| C uncontrolled (control) | null | "" | no |

Interpretation: mechanism CONFIRMED; the production path (trusted click on the filled field → collector row →
DVR ring → `.mcrec`) is RUNTIME_UNVERIFIED and is the F-13 browser case.

### P-07 (specified, READ_ONLY, OPERATOR_CONTROLLED execution on a live runner)

Purpose: decide MC-P21. Commands (read-only): `quser`; `Get-ScheduledTask GhrdpWatcher | Select -Expand Principal`;
`Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon,DefaultUserName`
(never `DefaultPassword`); last 20 Security 4624 events with `LogonType` and `TargetUserName` only. Timeout 30 s.
Output: four user names + logon types. Interpretation: all equal ⇒ no split; otherwise record which account the
operator signs in with. Risk: none (no writes). Cleanup: none.

### P-02…P-06 (specified, CONTROLLED_BEHAVIOR, jsdom/vitest)

P-02 add-site attribution (F-07); P-03 global fan-out with two clicks (F-06); P-04 raw-hash persistence with
`#/collector?key=SYNTH` (F-13); P-05 watcher chip after `setProgress(null)` (MC-P16); P-06 `runDiag` with HTTP 500.

## 4. Planning-artifact integrity checks (this PR)

Existing gates only: `node --test tests/f53-content-length.test.js tests/f111-ci-inventory.test.js
tests/m4-drift-fixed.test.js` (v1 baseline 17/17) plus the 11 cluster gates above. No production test is added.
