# AGENT_STATE — researched-upgrade implementation session

**Date**: 2026-10-10 · **Mode**: `IMPLEMENTATION_AND_VERIFICATION`
**Branch**: `arena/a50d3050-supreme-lamp` (base `main` @ `017f719c3d1f504732e2a994e5f3d0dcb33ffa4a`)
**PR**: [#220](https://github.com/dekarita/supreme-lamp/pull/220) — open, **not merged** (merging needs separate authorization)
**Ledger**: `docs/mission-control/IMPLEMENTATION-CLOSURE-LEDGER-ADDENDUM-R.md` (addendum to the ledger of record on PR #208's branch)

## Delivered (5 commits on the branch)

| Commit | Batch | State |
|---|---|---|
| `2c7311f8` + the second instrumentation pass | #203 e2e-ui lane repair | `IMPLEMENTED_UNVERIFIED` — **the lane is still red**; the bound worked and named the offender (see below) |
| `ede7a7c9` | i18n catalog + 5 count locks (20 keys, 1050/1050) | `VERIFIED_IN_TEST` |
| `c4b38783` | #211 / #212 metrics + clocks | `VERIFIED_IN_TEST` |
| `9700e8d2` | #216 zero-result explanation + #217 windowed Explorer | `VERIFIED_IN_TEST` |
| `ce755ce3` | #210 stage 1 download-rail honesty + ledger addendum | `VERIFIED_IN_TEST` (#210 stage 2 = `BLOCKED_WITH_EXACT_DEPENDENCY`) |

## Not delivered (recorded, not silently dropped)

- **#214** cross-device UX — `OPEN`, not started.
- **#213** glass design system — `OPEN`, not started.
- **#210 stage 2/3** — `BLOCKED_WITH_EXACT_DEPENDENCY` (a sanitized server-side status read on an existing route).
- **#217 server paging** — `OPTIONAL_NOT_ENABLED`, activation criterion defined.
- **yt-dlp lane** — `OPTIONAL_NOT_ENABLED`, five activation criteria; not installed.
- **BROWSER_E2E evidence** — **0**. No Chromium is obtainable in this sandbox (CDN and GitHub release hosts unreachable; the bundled binary needs `libnss3`, which cannot be apt-installed). The #203 fix is a mechanism argument with class-level evidence, not a reproduced hang.

## Defects found and closed this session

ND-8 (5h30 policy window rendered as a live countdown) · ND-9 (run start latched once, so a new run inherited the previous deadline) · ND-10 (`Number(null)` → a displayed `0`) · ND-11 (a stable react-window `itemData` freezes rows, because v1's `List` is a `PureComponent`) · ND-12 (rail keys by `resultId || fetchId`, store indexes by `resultId`) — **documented, not changed** · ND-13 (the e2e step log was unreadable on cancellation, which is why the hang stayed unidentified for ~100 runs).

## Where the next session should start

1. **#203 is NOT solved and must not be reported as solved.** Run **38024230807** on PR #220 failed at the new 18m step bound (04:29:17Z → 04:47:51Z) — the bound worked, and the annotation named the offender: `tests/e2e/f86-ten-sites-deep.spec.ts:101`, *"librivox.org: add → Lab ≥ 50 URLs → row opens in RDP (tier) → download"*, burning its 60s budget twice, as test #100. **The popup hypothesis that motivated the first fix is disproven**; the comment in `f91-mirror-mode.spec.ts` now says `DISPROVEN hypothesis` and names f86 (`F203-g` pins the correction). The remaining question is why the site-loop specs burn their per-test budgets. Next: read `F79-E2E-TALLY` from the run after the second instrumentation pass — it names every red spec file at once. Note that the step log itself is unreachable from this sandbox (`results-receiver.actions.githubusercontent.com` is not in the allowlist), so the check-run annotation is the only channel.
2. #210 stage 2: add `fetches[{fetchId, gid, status, bytes, total, speed, eta}]` to the existing `/api/progress` payload, pin the shape in `tests/*.test.js`, then flip `data-available="1"`.
3. #214 safe-area + 44px targets (no catalog change needed for that slice), then the EN/SI glossary slice (moves all five count locks).
4. #213 glass tokens + `GlassContainer` behind the existing quality setting, benchmark before changing any default.
5. Merge the addendum into `IMPLEMENTATION-CLOSURE-LEDGER.md` when #208 lands.

## Do not re-litigate (decisions with reasons recorded in code)

- react-window stays at **1.8.10**; v2 not adopted, no second virtualization library.
- `itemData` identity must **change** with its inputs; the row renderer must stay **stable**. Both matter, for opposite reasons (see the comment in `ExplorerResults.tsx`).
- No OpenTelemetry stack: the metric defect was wiring and labelling, not a missing tracing backend.
- Tailscale's wire RTT is **not** ICMP.
- The routed `FileExplorer`'s fixture-only data source was deliberately left alone: swapping it without reconciling with F45 would turn a rendering fix into a semantics change.
- The e2e lane fix stubs third-party page **loads** but keeps the popup **target** assertion; no spec was deleted and no timeout lowered.
