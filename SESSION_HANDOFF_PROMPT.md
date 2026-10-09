# GHRDP — SESSION HANDOFF (post-M8, 2026-10-09)

Sanitized continuation prompt. Safe to paste into a new Arena.ai worker session or
hand to the operator. Contains no secrets, tokens, or private conversation data.

## State at handoff

- Branch: `arena/374acee7-supreme-lamp` — M8 PR #188: `M8: cancellation-safe status.json finalizer (PROB-004)` — https://github.com/dekarita/supreme-lamp/pull/188.
- main HEAD at session start: `5ead8b29a7aae31d11e6b1bc1194ebb89ef2b3f4` (M7, PR #187 merged 2026-10-08T14:42:18Z). Branch was clean at that HEAD.
- M8 pipeline state: IMPLEMENTED → LOCALLY_VERIFIED → PR_READY. Operator merges; **a session never merges a PR and never dispatches main.yml**.
- Prior to M8: Observatory 10/10 shipped (F105-F111), maintenance M1-M7 shipped (#182-#187).

## What M8 does (one paragraph)

`main.yml`'s rdp job had a cancellation-finalization defect (PROB-004/PROB-005, RC-02):
the only terminal writer of `docs/status.json` was nested inside the Cleanup step, which
(1) wipes `C:\ghrdp\gh-pages-token.txt` before publishing, (2) never receives
`$env:GITHUB_TOKEN`, so `Publish-StatusToGhPages` silently returned, and (3) hardcoded
`runStatus='completed'`. Measured result: the run cancelled 2026-10-07T13:20:15Z left the
public Pages snapshot claiming `runStatus=in_progress` for 58h+. M8 adds a LAST step in
the rdp job (`Finalize status.json (M8 cancellation-safe terminal state)`) that runs on
every outcome (`if: always()`), maps the real `job.status` to a truthful terminal
`runStatus` (success→completed, cancelled→cancelled, failure→failed, else unknown),
publishes `docs/status.json` via the contents API with an explicit `GITHUB_TOKEN` env
(self-contained: no RUNNER_TEMP helper, no `C:\ghrdp` token file), adds an additive
`finalizeReason` field, carries the remote `overallPct`/`filesDone`/`filesTotal`, retries
the PUT at most 3 times with backoff, never fails the job, and refuses to clobber the
snapshot a NEWER run is heartbeating (ownership guard, re-checked before every PUT).

## Verify after merge (operator-only, ~5 min)

1. Dispatch `main.yml` (workflow_dispatch), wait ~2 min, then cancel the run.
2. `curl -s https://raw.githubusercontent.com/dekarita/supreme-lamp/main/docs/status.json | jq -r '.runStatus, .finalizeReason, .ts'`
   → expect `cancelled`, `job.status=cancelled`, fresh `ts`.
3. Next `replay-viewer.yml` deploy: the M7 freshness summary shows `runStatus=cancelled`
   and the `::warning::` about a stale `in_progress` stops firing for that snapshot.

## Rollback

Operator reverts the M8 PR via the GitHub UI. Pre-M8 behavior returns (an `in_progress`
snapshot can latch after cancellation); nothing else depends on M8. The change is
additive (+100 lines in main.yml, one new test file, doc appends); reverting restores
the exact prior bytes of every touched file except the appended ledger blocks.

## Next candidates (ranked)

1. **G7 / F110c emitter** (Issue #181): ship `Send-F99WsPatch` in `payloads/ghrdp-server.ps1`
   plus the Ed25519 public-key pin — TOGETHER. Do NOT pin a key before the emitter lands
   (pinning refuses every v1 HMAC frame while nothing can send v2 → patch outage).
2. **G11 / CF Worker cron fallback** (PROB-001): GitHub's scheduler delivers the
   `*/10` cron at ~2/day, not ~144/day. A Worker cron that POSTs `workflow_dispatch`
   on `replay-viewer.yml` when no scheduled run fired in 15 min. Free-tier compatible.
3. **G1 / M9 heartbeat TTL renewal** (RC-02 architectural fix): renew `runStatus` every
   heartbeat; consumers compute `(now-ts)>180s ⇒ orphaned`; self-healing without any
   finalizer. Complements M8 (M8 closes the common exit path; M9 closes the rest).
4. **Issue hygiene (operator, 15 min)**: close #164 (label probe), close #165 (stale
   roadmap mirror), fix #179 body (3 stale claims), label #179 + #181, decide on
   #161 (CONFLICTING, superseded F103).
5. **G18 / Actions budget monitor**: daily run summing monthly minutes vs the free tier.

## Constraints (unchanged, all hold)

- Session NEVER merges a PR; NEVER dispatches main.yml; operator is the sole merger.
- 7 locked security rules (`PROJECT-CONTEXT-v2-CANONICAL.md` §6): HTTPS-only strict
  allowlist; NLA=1 only; F27/F28 single-use 60s ticket exception; no MOTW/SmartScreen/
  publisher evasion; no C2 persistence / anti-forensics; F51 mirror default-OFF except
  Downloads Always-ON; fail-visible classification.
- cost=$0/mo (free tier only); 120-min Arena session cap; minimal footprint
  (0 new deps / i18n keys / workflows / routes / storage keys preferred).
- AGENTS.md discipline: 12 §PRE-STEP checks, §FALSIFY-3 (3+ mutations per new gate),
  §VACUITY-PROBES, §PIN-THE-USE-NOT-THE-MENTION, §BYTE-IDENTICAL-WRAP-PRESERVES-PINS.
- `replay-viewer.yml` is byte-fenced (F108-h SHA `2d5f87f464259d21370ad63b95d171ed3fa8c9371f9cda52e0b525ab37e8655d`)
  — never widen the push fence, never add a second publisher.
- `STATE.md` is capped at 60 lines (fold new entries into the last line);
  `docs/OBSERVATORY-STATE.md` is append-only.

## Key files

- Producer: `.github/workflows/main.yml` — initial write ~L325-350, helper gen ~L352-371,
  heartbeat ~L6255-6281, Cleanup + nested finalize ~L6423-6513, **M8 step L6515-6615**.
- Pages: `.github/workflows/replay-viewer.yml` — F108-h fence + M7 parity/freshness. DO NOT TOUCH.
- Gates: `tests/m8-cancellation-finalizer.test.js` (10 rules, `M8_MAIN_YML` override for
  falsification), `tests/m7-pages-freshness-verify.test.js`, `tests/m3-pages-freshness.test.js`,
  `tests/f111-ci-inventory.test.js`, `tests/merge-hygiene.test.js`.
- Structural audits: `node scripts/ps-balance-audit.mjs`, `python3 tests/ps-balance-audit.py`,
  `python3 tests/config-writer-audit.py .github/workflows/main.yml`, `npx -y js-yaml <wf>`.
- Fast lane: `node --test tests/*.test.js` (781/781 at M8 HEAD).

## Known residuals after M8

- Live dispatch+cancel verification is operator-only (session never dispatches main.yml).
- No pwsh in the sandbox: the finalize script is structurally audited (ps-balance,
  js-yaml) but not executed; first live run is the real proof.
- A job killed by `timeout-minutes` reports `job.status=failure` → `failed`; timeout is
  not distinguished from a generic failure (honest residual).
- The Cleanup step's nested finalize is superseded but left in place (removal is a
  separate RC-05-style dead-code cleanup).
- The ownership guard has a seconds-wide race (newer run starts between the guard's
  GET and PUT); it self-heals via the newer run's ~80s heartbeat.
- `docs/status.json` on main is STILL the frozen 2026-10-07 `in_progress` snapshot until
  the operator's verification dispatch overwrites it — expected, not a regression.
