# External review — source appendices (NOT auto-applied)

Source: `C:\Users\Hansana\Downloads\REVIEW.md`. Verdict quoted verbatim:

> **NOT ALL PASS. Do not deploy this as a completed one-click repair.**

The 8 files below are the reviewer's complete source appendices. They are
saved here **unmodified** so a maintainer can apply them deliberately after
inspection. They have NOT been applied to `payloads/ghrdp-agent.ps1`,
`payloads/ghrdp-server.ps1`, or `payloads/ui.html` by this operation.

| File | Purpose |
|---|---|
| main.steps.yml | Workflow step replacements (not a whole workflow) |
| ghrdp-ci-gate.ps1 | D0: PSParser + AST parser over every `*.ps1` |
| ghrdp-d1-gate.ps1 | D1: synthetic tailnet API transport gate |
| ghrdp-payload-routes.ps1 | HttpListener route module (dot-sourced from server) |
| ghrdp-enroll.ps1 | D3 client bootstrap: hash-verify + atomic install |
| rdp-panel.html | UI component replacement (device select + honest stages) |
| apply-ui-fixes.ps1 | Patcher that removes legacy handlers + injects panel |
| apply-agent-fixes.ps1 | AST-based patcher for existing agent.ps1 |
| ghrdp-agent-replacements.ps1 | Function-level replacements for the patcher |
| client-verification.ps1 | D6 acceptance runner |

## Why not applied automatically

The patchers require exact-match anchors in the current `payloads/ghrdp-agent.ps1`
and `payloads/ui.html`. My working copies have drifted from the version the
reviewer read; the patchers will fail loudly at `Replace-Once` if anchors are
missing. That fail-loud behavior is intentional (per the review's contract) and
correct. Applying blindly could either fail-safe or, worse, succeed on a
wrong anchor.

## The one architectural fix applied inline

**N8 (runner-side logon proof) is now addressed in `ghrdp-server.ps1`.**
A new `GET /api/logon-status?user=<name>&since=<iso>` endpoint queries the
RUNNER's Security log for event 4624 with `Logon Type: 10` for the RDP account
newer than the baseline. This is genuine RDP-into-runner proof — the reviewer's
point that client-side LogonType=10 is inbound-to-client, not outbound-to-runner,
is correct and my prior code was broken on that axis.

Agent + UI still need to be rewritten to poll this endpoint. That's the
reviewer's patcher path — save this note and apply their `apply-*.ps1` patchers
against the exact `.ps1`/`.html` versions they were written for.

## Do not

- Do not run `apply-agent-fixes.ps1` against the current `ghrdp-agent.ps1`
  without confirming its content against the version the reviewer saw.
- Do not publish `.pre-review.bak` files — the review explicitly warns they
  contain the credential-bearing legacy templates.
- Do not label anything `RESULT: ALL PASS` until D0 + D1 + D2 (E1-E8) are
  pasted evidence from a live Windows client + runner.
