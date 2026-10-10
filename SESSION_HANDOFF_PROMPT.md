# GHRDP — SESSION HANDOFF (E2E #203 + F45 readiness + contrast repair, 2026-10-10)

Sanitized continuation prompt. Safe to paste into a new Arena.ai worker session
or hand to the operator. Contains no secrets, tokens, credentials, raw
recordings, private chat content, secret-derived fingerprints, or personal
paths; every identity below is synthetic test data or public git metadata.

## State at handoff

- Branch (fixed): `arena/e491ab8c-supreme-lamp`. Base: `main` ==
  `179a25a8187f7a892da8d7b07833a4ae81e4e1c0`. This branch also carries the
  merged content of PR #221 head `008b754` (Mornye-inspired glass UI) via
  merge `3cfb8c6` — preserve it; do not revert the glass system.
- Working tree at handoff: **committed** (one session commit on the branch).
- Pipeline state: IMPLEMENTED → LOCALLY_VERIFIED (structural + component) →
  PR_READY. BROWSER (e2e-ui lane) and WINDOWS-NATIVE (pwsh lanes) evidence is
  **NOT_RUN** in-sandbox; the CI lanes own those proofs after an authorized
  push. A session never merges PRs and never dispatches/cancels `main.yml`
  without separate explicit authorization.

## What this session did

1. **E2E #203 root cause found and fixed.** Specs f86/f78/f84/f81/f91 asserted
   a window-open transport, but result surfaces use the F91 queue transport
   (`openMirrored` → POST `/api/launcher/queue`). Migrated specs to the
   queue-transport mirror contract (`isolateExternalNetwork`, `closeExtraPages`,
   MOCK-absolute fetches — never relative in-page fetches, which the vite
   preview SPA-fallback turns into index.html 200s). Mock backend: CORS `*` on
   live `/api/stream` branches. Gate: `tests/f203-e2e-lane.test.js` (11 rules).
2. **Defect B (demonstrated, spec-backed).** `openMirrored` passed
   `noopener,noreferrer` to `window.open`; per the HTML spec (MDN Window.open;
   whatwg/html#1851) a noopener feature forces the return value to null, so
   every mirror click faked `popupBlocked`. Fix: `window.open(url, "_blank")`
   (implicit noopener on all modern engines) + explicit `win.opener = null`
   sever; three superseded pins carry dated comments (f85-f84-symbols,
   f91-mirror-toast, f78-lab-inspector). Fire-and-forget opens elsewhere keep
   the literal features string — their return value is never inspected.
3. **F45 readiness repair** (`payloads/ghrdp-server.ps1`): (a) listener.Start()
   + LISTENING marker BEFORE the F28/F30/F37 startup scans (exact scan-call
   literals preserved for the lockstep greps); (b) new tokenless loopback
   `/health` route separating instance readiness (`ok/app/pid/listenerBound`)
   from scanner freshness (`scans.*.{scanTs,probeError}`, null = honest
   "not reported yet"); (c) accept-loop yield via `GHRDP_SCAN_DELAY_MS`
   (5..1000ms clamp); (d) harnesses `tests/f45-fx-server.ps1`,
   `tests/f49-mirror-runtime.ps1`, `.github/workflows/autologin-lab.yml` now
   require marker + HTTP 200 /health + matching pid; (e) structural lock
   `tests/f45-readiness.test.js` (F45-R1..R9). **F45-B** (isolated bounded scan
   worker with a gate-file seam) is the documented next work package — the
   reorder fixes readiness, not mid-scan latency, and that limitation is
   honestly labelled in the server comment and the tracker.
4. **Contrast repair (measured).** LIGHT accent `#0ea5e9` was 2.77:1 on the
   white surface (AA = 4.5:1). Now `#0369a1` text (5.93:1), hover `#075985`,
   on-fill fg white, focus ring `#0369a1`; LIGHT fx selection-border `#0284c7`
   (4.10:1 non-text). Dark theme unchanged. Candidates flagged, not changed:
   tertiary 4.34:1 on the raised tint; warning 3.19:1 (UI-component sizes).

## Local verification (all green at commit time)

- `node --test tests/*.test.js` → 832 tests, 806 pass, 0 fail, 26 skip.
- `npx vitest run` → 98 files, 1265/1265 pass.
- `node scripts/ps-balance-audit.mjs` → 0 surfaces failed.
- `npm run build` (tsc + vite singlefile) OK; `check:no-neon-green`,
  `check:regression-ids` (219/219), `check:bottom-bar`, `check:fx-ids` OK.
- `npx playwright test --config=playwright.e2e-ui.config.ts --list` → 136
  tests / 22 files collect clean (collection only — NOT execution).

## Where the next session should start

1. **GO BACKGROUND authorized?** If yes for scope "push
   `arena/e491ab8c-supreme-lamp` + open one PR + let the triggered CI lanes
   run once": push, open the PR against `main` with `--body-file`, read the
   body back, then watch ONLY the annotations channel (`gh run view --json
   jobs` + check-run annotations) — full logs/artifacts hosts are off the
   egress allowlist. Expected lanes: launch-gates, e2e-ui (~136 browser tests;
   the first real F203 proof), windows-native + autologin-lab (the F45
   readiness runtime proof incl. /health pid identity), build-ui.
2. If e2e-ui fails: read the F79-E2E-TALLY/F79-E2E-LAST annotations first;
   every spec already isolates external network and uses MOCK-absolute fetches,
   so a new failure is a real transport/locator regression, not isolation.
3. If windows-native/autologin fails on the /health or marker-pid checks: the
   pins live in `tests/f45-readiness.test.js` F45-R6..R8 and the harness files;
   do NOT weaken them — fix the server side.
4. F45-B work package (isolated scan worker) — see
   `docs/mission-control/GHRDP-DELIVERY-TRACKER.md` §3.
5. Contrast candidates from tracker §4 (tertiary/warning) need browser-lab
   composite measurement before any token change.

## MISSING_COMMIT_ACCESS (do not claim as delivered)

Commits `814e2b2`, `26a9764`/`e3acf15` lived in dead sandboxes; their changes
were reconstructed from evidence where possible (this session's repairs) but
their original diffs are unrecoverable. Historical reports about them are
claims, not proof.

## BACKGROUND_REGISTER

No persistent background jobs, scheduled tasks, monitors, or preview servers
are registered or authorized. The phrase "GO BACKGROUND" is NOT standing
authorization: push-triggered CI needs explicit task-scoped authorization, and
merging PRs / dispatching or cancelling `main.yml` / live RDP restarts /
credential changes each need their own. Nothing of that kind has been granted
as of this handoff.

## BUDGET_LEDGER

Session-budget telemetry is **UNKNOWN** in this sandbox (no metering API is
reachable; never fabricate a percentage). Rule of record: cap 20%, stop before
18% when measurable. CI minutes consumed so far by this branch: **0** (nothing
pushed yet). The prior session's ledger is
`docs/mission-control/BUDGET_LEDGER.md` (historical, PR #220 era).

---

# HANDOFF — session 2026-10-10 (b), branch `arena/f289f02e-supreme-lamp`

Supersedes the state above for the *repair line only*. The technical content of
the earlier section (E2E #203 migration, Defect B, contrast) is preserved and
carried forward unchanged.

## Current revision

- Branch (fixed for this session): `arena/f289f02e-supreme-lamp`
- Head: `5146952b2e1945bd3b20229fef2203e35f2dbf06`
- Base: `main` == `179a25a8187f7a892da8d7b07833a4ae81e4e1c0`
- Canonical PR: **#223** https://github.com/dekarita/supreme-lamp/pull/223
- Tracker: `docs/mission-control/GHRDP-DELIVERY-TRACKER.md` → section
  "SESSION 2026-10-10 (b)"

**Ancestry is verified, not assumed:** `main` `179a25a` is an ancestor of
`b213fd42` (#222 head), so #222 — and through it #221's glass UI (`008b754`,
merged as `3cfb8c6`) — is fully contained in this branch. Nothing was
re-implemented or dropped.

## Authorization boundary honoured

Task-scoped repair authorization: inspect, repair, test, commit, push, create
PRs, follow finite CI to terminal results. **Not** exercised: merging PRs,
closing superseded PRs, `main.yml` dispatch/cancel, refreshing a live RDP
session, credential/policy changes, recurring monitors. #221 and #222 were left
**open** — do not merge or close them without an explicit integration decision.

## Implementation state

| Item | State |
|---|---|
| GATES-01/02 (launch-gates step 32, F37 startup scan) | **REPAIRED, CI-verified** on the push context |
| E2E-01 (`f84-ux.spec.ts ✘=4`) | **OPEN** — instrument added, cause not yet named |
| F45-B (request responsiveness under a blocked scan) | **OPEN** — needs an isolated worker + Windows runtime proof |
| Glass UI / Mornye-inspired shell | carried forward from #221/#222, unchanged here |
| Light-theme contrast | carried forward; tertiary 4.34:1 / warning 3.19:1 still OPEN |

## Publication state

`LOCAL_ONLY` → `PR_OPEN` (#223). Not `MERGED`, not `DEPLOYED`. A green build
does **not** update the operator's running RDP session; activation still needs
separate authorization.

## Open failures and the next probe

**E2E-01 is the single open red.** Next probe, in order:

1. Read the new `F79-E2E-FAIL1..4` annotations on the `e2e-ui` check run for the
   current head. They now carry `spec:line › title :: first error line`, which
   the tally never did:
   ```
   gh api "repos/dekarita/supreme-lamp/commits/<HEAD>/check-runs?per_page=100" \
     --jq '.check_runs[] | select(.name=="e2e-ui") | .id'
   gh api "repos/dekarita/supreme-lamp/check-runs/<JOB_ID>/annotations" \
     --jq '.[] | .message'
   ```
2. Expect the offender in `tests/e2e/f84-ux.spec.ts`. The two candidates this
   session could not separate without a browser are tests 4 and 5
   (the popup path) — `retries:1` means `✘=4` is 2 tests × 2 attempts.
3. Already **ruled out by execution** (do not re-investigate): the mock's
   `/api/launcher/queue` fence (probed live → 200 / 400 / 400, exactly what
   both fallback branches assert), the `"Opened locally ✓"` toast string
   (present in `src/i18n/en.json`), and `card-direct-url` navigating the page
   (it is a `<button>`, `src/pages/search/ResultsGrid.tsx:241`).

## Reproduction commands

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile

# the gates failure, reproduced verbatim (extract the step, then run it):
python3 - <<'PY'   # see docs/mission-control/GHRDP-DELIVERY-TRACKER.md §B2
PY
bash /tmp/gates/step.sh          # expect: "F37 gates PASS", exit 0

node --test $(find tests -name '*.test.js' | sort)   # 832 / 806 pass / 0 fail / 26 skip
npx vitest run                                        # 98 files, 1265/1265
pnpm run build                                        # tsc + vite singlefile
node --test tests/f203-e2e-lane.test.js               # 11/11 lane pins
```

## Environment limitations (verified this session, not assumed)

| Limitation | Evidence |
|---|---|
| No browser binary | `npx playwright install chromium` fails; `~/.cache/ms-playwright` empty; no system chrome |
| `cdn.playwright.dev` egress-blocked | `curl: (35) SSL_ERROR_SYSCALL` |
| Step logs not retrievable | `results-receiver.actions.githubusercontent.com` → `EOF` / `SSL_ERROR_SYSCALL` |
| Artifacts not retrievable | `pipelines.actions.githubusercontent.com` → `SSL_ERROR_SYSCALL` |
| No `pwsh` | Windows-native proof must come from the CI lanes |
| Clone was shallow | `git rev-parse --is-shallow-repository` → `true`; deepened before ancestry conclusions |
| Budget telemetry | **UNKNOWN** — no metering API reachable from this sandbox |

Only `github.com`, `api.github.com`, `codeload.github.com`,
`registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org` are reachable.

## Deferred requirements (preserve; do not drop)

Standing backlog unchanged: #191 hub · #193/#209/PR#208 Collector/DVR privacy ·
#194 truthfulness · #199/#200 contracts · #203 e2e · #210 downloads ·
#211/#212 metrics · #213/#214 glass/responsive · #215/#218 research ·
#216/#217 search/scale · PRs #219/#220/#221/#222.

Explicitly still open and **not** claimed complete:
F45-B request starvation · full browser/native acceptance · tertiary-text
contrast (4.34:1 normal text) · popup security/duplicate-launch verification in
a real browser · the 5000-file Explorer journey · auto-login / search /
Explorer / DVR / glass user journeys · "Stream was too long" buffering
contract · M8 ownership/finalization fences.

## Cleanup status

No test-owned processes, ports, browser contexts or runspaces left behind: the
mock backend started for the queue-fence probe was killed in the same command,
and the build/vitest/node:test processes all exited. `ui/dist/` is
build output and is git-ignored.
