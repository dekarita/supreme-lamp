# BUDGET_LEDGER — researched-upgrade implementation session

**Date**: 2026-10-10 · **Branch**: `arena/a50d3050-supreme-lamp` · **PR**: #220
**Rule of record**: cap 20%; **stop before 18%** when real telemetry is available, otherwise report `UNKNOWN`.

## Axes that CAN be measured here — and their real numbers

| Axis | Meter | Reading | Verdict |
|---|---|---|---|
| GitHub Actions minutes, this branch | `gh run list --branch … --json startedAt,updatedAt,name` | **≈ 47 min** across 5 workflows × 2 heads (e2e-ui 18.6 + 18.6, launch-gates 10.1 + 10.0, autologin-lab 5.7, windows-native 10.0, build-ui 0.7, plus labs) | measured; the two `e2e-ui` runs are 74% of it, and both are the #203 investigation itself |
| Agent context window, this session | harness counter | **744,605 / 1,000,000 = 74.5%** as of the last reading, before the #203 second pass | measured; this is why #214/#213 were not started |
| Dependency delta | `git diff package.json` | **0** — byte-identical to `main` (8 runtime / 21 dev) | measured |
| Repository byte delta | `git diff --stat 017f719c..HEAD` | ~1.2 kB of build output growth; no new file type | measured |

## Axes that CANNOT be measured here — reported as UNKNOWN, not estimated

| Axis | Why it is unknown |
|---|---|
| Monetary spend / API-dollar cost | no billing or usage API is reachable from this sandbox; **UNKNOWN** |
| Per-model token accounting | not exposed; **UNKNOWN** |
| Total Actions minutes for the whole repository (other branches, `main`, scheduled runs) | out of scope and not attributable to this session; **UNKNOWN** |
| Wall-clock share of the *repo-wide* 20% budget | the cap has no published denominator; **UNKNOWN** |

**Bottom line**: against the only denominators I can actually read, this session is at
**74.5% of the session context budget** and **≈47 measured CI minutes**. Against the
20% programme cap the answer is **`UNKNOWN`** — I will not invent a denominator to
produce a number that looks compliant.

## What the budget went to

| Work | Share (qualitative) |
|---|---|
| #211/#212 metrics — 5 source modules, 35 tests, plus 4 defects found and closed | large |
| #216 search-failure explanation — pure module, component, wiring, 17 tests | medium |
| #217 Explorer windowing — rewrite, 13 tests, one subtle `PureComponent` trap | large |
| #210 stage 1 — rail honesty, 13 tests, and the blocked-dependency write-up | medium |
| #203 e2e lane — two instrumentation passes, 7 static pins, two CI runs read | medium-large |
| Ledger addendum + AGENT_STATE + this file | small |

## Deliberate stops (to stay inside the budget)

- **#214 (cross-device UX) and #213 (glass) were not started.** Both are recorded as
  `OPEN` with activation criteria rather than quietly dropped.
- **#210 stage 2 was not faked.** It is `BLOCKED_WITH_EXACT_DEPENDENCY` on a server-side
  status read that does not exist yet; shipping a client-side simulation of it would
  have been cheaper than writing the blocker down, and wrong.
- **No further #203 fix was attempted** after the tally identified the failure set:
  fixing a slow e2e step needs the step log or a browser, and neither is obtainable
  here. Reporting the finding beats guessing at a fix that cannot be verified.
