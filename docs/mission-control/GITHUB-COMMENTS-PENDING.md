# Copy-ready GitHub comments (not published — integration write denied)

Sanitized failure record (2026-10-09 ~08:52Z): `gh issue edit 191` (GraphQL) → "Resource not accessible by integration";
`PATCH /repos/dekarita/supreme-lamp/issues/191` (REST) → HTTP 403 same message; `gh issue comment 191` (GraphQL) → same.
Issue and PR **creation** succeeded (PR #192, issues #193–#206). Further edit/comment attempts were stopped to avoid
repeated denied writes. The operator (or a session with comment permission) can paste the blocks below verbatim.
Full #191 body: [ISSUE-191-BODY.md](ISSUE-191-BODY.md).

## For #191 (milestone update)

**Current state (2026-10-09 ~08:50Z)** — source `823bcb6` (= app code on `main` `c3322f8`) · stage **PLAN_PARTIAL** · docs: v1 #190, **v2 continuation #192** (contains #190's commits).

| Learned | Artifact changed | Next concrete task |
|---|---|---|
| v1 counts/absences wrong: 16 Route / 14 navigable (12+2) / 1 wildcard / 1 layout; ButtonAction family, service probes, drawers, F96 card, top-bar chips, F-TESTID scanner already exist (PARTIAL) | [correction ledger](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CORRECTION-LEDGER.md), [capability matrix](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CAPABILITY-REUSE-MATRIX.md) | — |
| Census v1: **301** static DOM control sites; only 3 explicitly instrumented; 18 Click-now targets; F-TESTID misses 2 sites (apostrophe blind spot) | [control census](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CONTROL-CENSUS.md) | #196 classify the 277 SITE_ONLY rows |
| Existing diagnostics can persist a controlled password value (probe-confirmed mechanism), raw hash routes and token-bearing URLs; export is raw | [work packages](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/WORK-PACKAGES.md#wp-13) | **#193 WP-13 — first implementation-ready package** (needs authorization) |
| Verdicts reflect HTTP/DOM proxies, not effects; add-site row records the follow-up GET; global capture fans every request out to every pending click | [spec](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-DIAGNOSTICS-SPEC.md), [troubleshooting](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-TROUBLESHOOTING.md) | #201 WP-06, #194 WP-14 |
| SPA talks to the runner directly; Worker is a separate Pages-origin dispatch/cancel plane | [architecture](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ARCHITECTURE.md) | #199 WP-05A |
| M8: run 37903915039 live — initial + heartbeat snapshots carry `runAttempt: 1`; finalizer pending | — | #195 WP-01 after the run ends (agents do not touch the run) |
| e2e-ui: systematic 25-min timeout, 0/100 recent successes (last 2026-10-05) | [acceptance plan](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-ACCEPTANCE-PLAN.md) | #203 WP-09 |
| #153/#156 differ (B2/B3/B4); PR #155 implemented #153's direction with a password sync; PR #154 proposes a third option | [reconciliation](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ISSUE-RECONCILIATION.md) | operator identity decision |

**Child issues:** #193 WP-13 · #194 WP-14 · #195 WP-01 · #196 WP-03A · #197 WP-03B · #198 WP-04 · #199 WP-05A · #200 WP-05B · #201 WP-06 · #202 WP-07 · #203 WP-09 · #204 WP-10 · #205 WP-11 · #206 WP-12 · existing #181 (WP-08, optional) · #153 (WP-02, recommended canonical).

**Operator actions (only these):** (1) reply **A / B / C** for the intended RDP application identity ([options](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ISSUE-RECONCILIATION.md#4-genuine-operator-decision-identity)); (2) optionally attach one `e2e-ui` step-8 log (run 37898544529). No secret re-creation, setup repeat or issue-number choice is requested.

## For #190 (pointer)

Plan v2 continues this PR in **#192** (this session could not push to this branch; #192 was fast-forwarded from `9aa6051` and contains both commits of this PR). v2 corrects the v1 claims listed in the [correction ledger](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CORRECTION-LEDGER.md) (route counts, absence claims, topology, M8 state). Either merge order works: merging #190 first shrinks #192's diff; merging #192 first also lands this PR's commits. Canonical issue remains #191.

## For #153 (reconciliation — recommended canonical)

Technical reconciliation with #156: [ISSUE-RECONCILIATION.md](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ISSUE-RECONCILIATION.md).
- Recommendation: keep **#153** canonical (file:line evidence; referenced by open PR #154 "Closes #153").
- Carried over from #156 (unique requirements): Collector EN + SI strings; first-login keeps Tailscale connected, hides (not minimizes) consoles, Edge app/kiosk with a validated URL, idempotent, no credential-bearing URLs/logs; keep deliberately type-10 RDP probes distinct from desktop-session verdicts; do not invent a Task Scheduler XML capture the runner cannot provide; no session dispatches main.yml or merges its PR.
- Code state at `823bcb6`: B1 resolved in code (WS upgrade), B3 cited lines resolved, B2 hardened registration present, B5 shared validator exists (per-route adoption unverified). **B4 is an open decision**: deployed main.yml resolves the active session user (fallback `runneradmin`), sets its password to the generated secret and arms AutoAdminLogon for it; #156 asks for the generated account; PR #154 proposes preserving the image's pair. Options A/B/C are listed in the reconciliation doc §4. Tracking: WP-02 in #191.

## For #156 (superseded recommendation)

Same title as #153 but a different body (B2/B3/B4 guidance differs). Technical recommendation: track in **#153**; this issue's unique requirements are carried over verbatim (see the #153 comment / [reconciliation doc](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ISSUE-RECONCILIATION.md)). Closing is left to the operator.

## For #181 (refresh at `9aa6051`)

Re-measured: `Send-F99WsText ` = 6 occurrences (1 definition + 5 sends); patch-emitter grep = 0; `PATCH_PUBLIC_KEY_B64 = ""`; `scripts/f110b-sign-patch.mjs` present; verifier fail-closed. The description above remains accurate. Plan v2 classifies Live Patch as an **optional improvement** (WP-08): no diagnostic view depends on it, and no other work package is blocked by it.

---

## Publication record — v21 session (2026-10-09T09:2xZ)

Permissions were re-checked rather than assumed, because the token's reported repository permission
**differs** from what the earlier 403 implied:

| Capability | Result |
|---|---|
| `gh api repos/dekarita/supreme-lamp` → `.permissions` | `{admin: true, maintain: true, push: true, pull: true, triage: true}` |
| Token type | fine-grained / integration (`X-Oauth-Scopes` empty) |
| push branch `arena/822ae03c-supreme-lamp` | **SUCCEEDED** (`50212199`) |
| create PR **#207** | **SUCCEEDED** |
| `gh issue comment 191` | **DENIED** — `Resource not accessible by integration` |

So `admin: true` on the repository **does not** imply issue-write permission for this integration. **One** comment
attempt was made to establish this; it was not retried, per the no-loop rule. Issue-body edits were not attempted
(the same resource class was already denied earlier today).

**PUBLICATION status: `PARTIALLY_PUBLISHED`.** The documentation PR (#207) is live and accessible; the #191 body and
the child-issue comments are still **`PUBLICATION_BLOCKED`**. Research completeness and publication status are
tracked separately — the plan artifacts above are complete for this session's scope regardless of this block.

### Single operator action, if a manual paste is wanted

Paste the block below as a comment on [#191](https://github.com/dekarita/supreme-lamp/issues/191). It is the exact
text that was denied. Nothing else is required, and no other research is blocked by it.

```markdown
**Milestone update — planning session v21 (2026-10-09T09:19Z).** Plan **v2.1** is open as PR #207, a
documentation-only continuation of #192 (based on its head `d077e57`, so the diff is only the corrections).

`application_changes=NONE` · `production_actions=NONE` · stage **PLAN_PARTIAL** (not PLAN_READY).

**Application revision unchanged** at `823bcb6` (PR #189 merge). `main` = `adffebc0`, advanced by **40 status-only
commits** touching only `docs/status.json` — no new application build exists.

### What this session corrected in the plan itself
| Row | The plan said | Source says | Why it mattered |
|---|---|---|---|
| **J1** | WP-01 accepts `runStatus ∈ {success, failure, cancelled}` | `main.yml` L6634-6639 maps `job.status` → `completed`/`failed`/`cancelled`, default `unknown`; terminal set (L6606) has **4** values; `finalizeReason` (L6702) keeps the GitHub word | **That acceptance could never pass** — it would have failed a *correct* finalizer. Confirmed by the repo's own gate `M8-d` (14 pass / 0 skipped) |
| **J2** | the finalizer "warns" when the snapshot stays stale | ownership step-aside emits `::notice::` and still exits 0 (L6662-6689) | **A newer run correctly taking ownership would have been scored as a failure.** Added an `action=` table to the runbook |
| **J3** | WP-14: "`.rdp` result reflects `window.open` return value" | `window.open(url,"_blank","noopener")` (Connections.tsx L41); per spec `noopener` returns **`null` on success** | **Rule rejected** — it would mark every successful download as a failure, worse than the defect it replaced |
| **J5–J7** | WP-13's 3-file scope satisfies "no secret in `.mcrec` v1/v2" | sink trace S1–S11: ring + v1 **are** covered (ring is downstream of the recorder, dvr.ts L216/L230); v2 `mutations[]` **verified content-free**; v2 `shots[]` + IndexedDB are **not** in the 3 files | **WP-13 could not meet its own acceptance.** Acceptance split; **downgraded to `SPECIFIED`**; new **WP-13b** |
| **J6 / MC-P24** | screenshots.ts: "cloneNode … reads STRUCTURE only" | `XMLSerializer().serializeToString()` (L46-47) serializes **text nodes and attribute values** | The stated fence is **unsound**; new problem **MC-P24** |
| **J7** | WP-10 implied screenshots were already opt-in | `void takeShot()` on every click (session.ts L138), env-flag gated only | Opt-**out**; WP-10's item is a behaviour change with a migration question |
| **J8** | WP-07 bound "Diagnose this page" to Alt+D | in-app bindings verified (Alt+E/Alt+F, Ctrl+K, Shift+F12, Explorer keymap) — **no in-app conflict** | But Alt+D is **browser-reserved** on Windows ⇒ expected dead in the RDP browser. Rejected; `NOT_MEASURED` |
| **J9** | (implicit) routes are individually token-protected | `Test-GhrdpDashToken` at **3** route groups only; connection guard accepts loopback + tailnet CGNAT with no token | A 401/403 must name a **layer**, never read as "the secret is wrong" |

### Verified vs not
- **Verified:** M8 finalizer mapping + ownership policy (and `node --test tests/m8-cancellation-finalizer.test.js`
  ⇒ **14 pass / 0 fail / 0 skipped**, incl. `M8-d` and `M8-f`); the two-layer server auth model; the full **76-route**
  inventory; **`/ws` is served by the PowerShell server on 7331** — this resolves a standing open question; the WP-13
  sink trace; the in-app shortcut set.
- **Bounded M8 observation (J10):** run 37903915039 on `823bcb6` was `in_progress` at 09:19:34Z (~63 min), tracked
  snapshot `runId=37903915039, runAttempt=1, runStatus=in_progress, finalizeReason=null, ts=09:12:52Z`
  ⇒ **Stage A = NOT_REACHED**; readiness only. Research continued rather than waiting the run out.
- **Not verified:** `tests/m8-finalizer-behavior.test.js` reported **15 pass / 26 SKIPPED (pwsh unavailable)** here;
  skipped scenarios are **not** passed, so the mapping is `STATIC_CHECK`, not `CONTROLLED_BEHAVIOR_VERIFIED`. Nothing
  here is `BROWSER_VERIFIED` or `LIVE_VERIFIED`. MC-P24 is a **confirmed mechanism**, not a confirmed production leak.

### Still unobserved
The 277 `SITE_ONLY` census rows, Explorer, and the upload/mirror path were **not** started — those are the original
user problems and remain open. **No work package is currently `READY_FOR_IMPLEMENTATION`**; both that claimed it were
downgraded on evidence.

### New artifacts
`docs/mission-control/PRIVACY-SINK-MAP.md` (WP-13 sink proof S1–S11) and
`docs/mission-control/ENDPOINT-CONTRACTS.md` (76-route inventory + two-layer auth model).

**Operator action (only one, unchanged):** the RDP application-identity choice A/B/C
(ISSUE-RECONCILIATION §4). It blocks no other research. No secret re-creation or setup repetition is requested.
The audit crosswalk (PROB/REQ/RC/GOLD) is **unavailable** — no audit document was supplied; contents not fabricated.
```
