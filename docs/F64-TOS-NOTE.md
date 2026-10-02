# F64 ToS note (operator accepts risk)

GitHub Actions is provided for CI of the repository. Using a `workflow_dispatch`
Windows runner as a **personal RDP desktop** (plus qBittorrent on that runner)
may violate the GitHub Terms of Service (Actions acceptable use: no crypto
mining, no general-purpose compute / hosting unrelated to the repo). This
project already treats Actions as an ephemeral Mission Control host.

**F64 does not change that posture.** Speed work stays on the existing
`windows-latest` job. F60 (warm self-hosted Azure VM) stays PARKED at $0/mo.

The operator accepts this risk at their own discretion. This repository does
not hide the use, does not add evasion, and does not claim GitHub approved it.

## Path to real sub-5-minute + ToS-safe

A persistent VM you own (Oracle Cloud Always Free, a home box, F60 if unparked)
can keep Tailscale + the dashboard + drivers warm. That is the only honest way
to a **reliable** sub-5-minute "ready" time. GitHub-hosted cold start cannot
beat the measured floor (cert fetch ~36s, webdesk 54-90s, F17 16-32s, queue
variance) without lying about what "ready" means.

Oracle Free Tier VPS: provision with `payloads/Provision-GhrdpVps.ps1`
(MIGRATION.md §1.7), keep Actions as the fallback, and decommission Actions
only after G3 is live (STATE.md G4).
