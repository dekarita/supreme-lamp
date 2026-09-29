# PROJECT CONTEXT v2 — CANONICAL (locked-rules mirror)

This file mirrors the operator's canonical project brief into the repository so
every rule it pins is auditable in-tree. Sections 1–5 of the canonical brief
(scope, lanes, landing protocol, output format, loop budget) live with the
operator; the section this repository OWNS and enforces is **Section 6 — Locked
Rules**, reproduced here verbatim. Where STATE.md and this file disagree,
STATE.md is the day-to-day ledger and this file is the rule text.

---

## Section 6 — Locked Rules (canonical, enforced by CI)

1. **NLA=1 only.** No `fPromptForPassword=0`, no `AuthLvlOverride`, no client
   `authentication level:i:0|3`, no `prompt for credentials:i:0`.
2. **No credential transit/store loosening.** No password URLs/logs/artifacts;
   the F27/F28 dash-authorized single-use ticket exception stays the ONLY
   sanctioned credential-return path.
3. **No evasion.** No MOTW/Zone.Identifier stripping, no
   SmartScreen/ClickFix/uBlock/publisher bypasses, no LocalDevices pre-trust
   arming, no UA/proxy/rotation/header spoofing on any host call.
4. **No C2 persistence.** Agent/enroll/launch/accept/diag endpoints stay 404;
   no anti-forensics.
5. **Rule 5 (text fixed by the 2026-09-29 operator-authorized brief
   override):** "Mirror is default-OFF, EXCEPT for the `Downloads` root which is Always-ON (Auto-upload)."
   - *Original text (superseded 2026-09-29):* "Mirror is default-OFF"
     (F11-5.2 lock, enforced since F46).
   - *Override scope:* the `Downloads` root ONLY (profile `Downloads`, the
     shell-known Downloads library, and Downloads-family subfolders such as
     `Downloads\qBittorrent`). Files there are queued for mirror upload
     automatically (F51) — no `mirror_enable` dispatch input and no F49
     runtime opt-in modal is consulted for them.
   - *Unchanged:* `Desktop`, `Documents`, `Temp`, `RDP-Storage` and every other
     root still require the full opt-in gate (`mirror_enable=true` or the F49
     one-click ConfirmModal). The shipped code default stays `enabled=false`;
     the F51 override is in-memory, this-run only, and never writes
     `config.json`. No token/credential exists anywhere (F48 guest contract).
6. **Fail-visible or fail-labeled.** Every mirror attempt is classified
   (phase/status/host message, F44 policy: fail-fast 401/403/413/415 = 1
   attempt, jittered backoff for transients, `Retry-After` a FLOOR capped at
   120s); the bare "failed after N tries" strings stay retired.
7. **The session never dispatches `main.yml`** and never force-pushes, amends,
   or pushes `main` from the cloud; landing is session-branch push → PR →
   merge (`merge_method=merge`).

Enforcement anchors (re-derive by search): `payloads/ghrdp-watcher.ps1`
(`Split-F51AutoQueue`, `New-F51AutoHost`, `[mirror] AUTO-UPLOAD:` ledger),
`payloads/ghrdp-mirror.ps1` (`Get-F46DefaultHost` keeps `enabled=false`),
`docs/MIRROR-HOSTS.md` §11, `tests/f50-f51-stream-auto.test.js`,
`.github/workflows/launch-gates.yml` ([F50]/[F51] gates).
