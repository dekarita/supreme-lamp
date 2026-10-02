# F64 baseline (production GitHub Actions API — not a Linux lab)

Pulled 2026-10-02 from `GET /repos/dekarita/supreme-lamp/actions/runs/{id}/jobs`
for the last 3 `main.yml` dispatches. Step duration = `completed_at - started_at`
(1-second API resolution). Critical path ends at **Start Mission Control
dashboard EARLY** (Mission Control `:7331` = READY).

F63 claimed 398s savings (140+72+120+66) in a Linux lab. Production move = ~0.
Those waits already early-exit on the green path (Tailscale up 3-4s inside a 90s
window; MagicDNS wait 0-1s inside a 15 min HOLD). Linux cannot model Windows C:
IOPS, PnP serialization, cache restore, or queue variance.

## Last 3 runs

| run | sha | conclusion | dashboard-reachable | notes |
|-----|-----|------------|---------------------|-------|
| 36999197717 | 4ae098e9 | in_progress (rdp live) | **432s / 7.20 min** | ui-prebuilt MISS (fallback build 20s); qbt 94s; webdesk 90s; F17 32s; cert 39s; prewarm 26s |
| 36990591537 | df297fa8 | cancelled after setup | **337s / 5.62 min** | ui-prebuilt HIT; qbt 74s; webdesk 54s; F17 16s; cert 36s; prewarm 13s |
| 36969981915 | 1296d871 | **failure** | n/a (rdp skipped) | **release-asset download FAILED** at `Download prebuilt UI bundle` (5s); fallback skipped |

Median of the two runs that reached the dashboard: **384.5s / 6.41 min**.
Spread 5.62-7.20 min on consecutive F59-era dispatches = the honest variance
band. Honest target: **7-8 min median** (not 6, not guaranteed). Gate margin:
**8m 30s**.

## Critical path (run 36999197717, 432s) — real numbers

Steps ≥8s before dashboard: Token 8, Checkout 6, caches 5, **prewarm 26**,
**Tailscale MSI 17**, **LE cert 39**, TLS 8, Enable RDP 8, aria2c 5,
**qBittorrent 94**, **stage 27**, **F17 32**, **webdesk 90**, **webdesk self-test 31**,
dashboard 5. Tailscale up 3s, MagicDNS wait 1s (NOT a floor).

After dashboard (NOT on READY): Rust dash 192s, WebRTC tests 127s, WebRTC build 83s,
plain qBittorrent app 41s, personalization 19s. Already after READY: Parsec, VDD,
bookmarks.

## Per-step optimizations (research-checked, not lab-as-prod)

| change | baseline | how it is faster | expected saving | verification |
|--------|----------|------------------|-----------------|--------------|
| Move qBittorrent transport AFTER dashboard | 74-94s ON path | READY does not need the torrent lane | **70-90s of dashboard-reachable** (not total setup) | pre-push: Windows-only; measure post-merge |
| Tailscale up 45×2s → 90×1s | 3-4s green | already early-exits; 1s poll is hygiene | **0-1s green** | code; F63 overclaim |
| MagicDNS wait 180×5s → 900×1s | 0-1s green | already early-exits; 15 min is the TIMEOUT | **0s green** (not a floor) | code; F63 overclaim |
| Drop aria2c 3s pre-sleep | 5-6s | poll immediately | **~3s** | code |
| Dashboard 30×2s → 60×1s | 5-9s | 1s poll, same 60s window | **~2-4s** | Windows-only |
| Webdesk self-test 5s retry → 1s | 31s | first 200 already `break`s | **0s green / ~8s retry** | code |
| Start-ThreadJob for pre-warm | 13-26s | 8× faster *startup*, not 8× wall | **1-4s** (NOT 8× total) | Windows-only (ThreadJob in pwsh) |
| D: install root | D: used for Fetched/aria2 | C:\ghrdp is pinned (F9k/F25) | **0s until measured** | log D: + image; do not relocate server root |
| Drop Go/choco caches | none on path | F59 already removed choco; F59 prebuilt cache is 0-1s **benefit** | **dropped the drop** | keep F59 cache |
| Pre-trust IddSample+VB-CABLE | both AFTER dashboard | off critical path | **dropped** | STOP: not on path |
| Defender | no disable in tree | log `Get-MpComputerStatus`; do not duplicate | **0s** | log only |

Net honest dashboard-reachable move: **~75-100s** on a similar runner
(7.20 → ~5.5-6.0 **if** qbt-move lands and variance cooperates). **Do not
promise sub-7 min reliable.** Failure modes: queue variance, C: IOPS, D:
missing, LE cert ~36s floor, webdesk 54-90s, F17 16-32s, ui-prebuilt miss.

F60 PARKED stays ($0/mo). 6 min reliable needs a persistent pre-provisioned VM.
