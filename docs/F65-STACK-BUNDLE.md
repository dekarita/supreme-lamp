# F65 - PRE-STAGED STACK BUNDLE + IN-RUNNER CONCURRENCY

Status: **session branch, PR open, NOT merged.** Every claim below is either a
local/lab measurement or an explicitly labeled PENDING item; no number here is a
production median. The F65 telemetry artifact (`f65-telemetry`) is what a live
dispatch will be judged on, and the honest median/p90 lines are only emitted
after the operator confirms 3+ post-merge dispatches.

## 1. What is pre-staged

`.github/workflows/build-stack-bundle.yml` (ubuntu-latest, off every dispatch's
critical path) publishes ONE checksummed ZIP to the `stack-bundle` release:

| asset | what it is |
|---|---|
| `ghrdp-stack-<commit>.zip` | the bundle (see layout below) |
| `ghrdp-stack-<commit>.zip.sha256` | sidecar digest |
| `ghrdp-stack-latest.json` | pointer: `{asset, sha256, size, commit, built_at, manifest_sha256}` |

Trigger: **push** to `payloads/f65-bundle-manifest.json`,
`payloads/f65-personalization.json`, `payloads/f65-bookmarks.json`,
`scripts/f65-bundle-builder.mjs`, `tests/f65-bundle-manifest.test.js` or the
workflow file itself. A weekly cron (Sunday 02:00 UTC) is a **backup refresh
only** - cron-only pre-staging is refused (F65 §6).

Bundle layout:

```
manifest.json                      sha256 + size of EVERY file, vendor provenance
stack/tailscale-setup-1.102.4-amd64.msi
stack/ffmpeg-release-full.zip      (ffmpeg 9.0.2 full build)
stack/VBCABLE_Driver_Pack43.zip
stack/IddSampleDriver.zip          (0.0.1.4)
stack/uBlock0_1.75.0.chromium.crx
stack/uBlock0_1.75.0.firefox.signed.xpi
stack/ghrdp-webrtc-<sha>.zip       (+ .sha256 sidecar)
stack/ghrdp-webrtc-<sha>.zip.sha256
personalization/f65-personalization.json
personalization/f65-bookmarks.json
```

### Pins (official vendor sources, SHA-256)

| component | vendor | sha256 | how the pin was corroborated |
|---|---|---|---|
| tailscale 1.102.4 MSI | pkgs.tailscale.com | `80eb007e…675b7ef6` | mirror release-asset digest (versioned URL, re-asserted at build) |
| ffmpeg 9.0.2 full build | ffmpeg.org / GyanD | `759d0a98…d9206f6b` | **vendor release-asset digest** == pin == mirror digest |
| VB-CABLE pack 43 | vb-audio.com | `66fd0a4d…eedd1cdd` | mirror release-asset digest |
| IddSampleDriver 0.0.1.4 | github.com/ge9 | `e93b88f3…bfdd4eb7` | mirror digest (vendor asset predates GitHub's digest field; size 52582 matches) |
| uBlock crx 1.75.0 | github.com/gorhill (CWS build) | `d688ed3f…dfa7046` | **vendor release-asset digest** |
| uBlock xpi 1.75.0 | github.com/gorhill (AMO-signed) | `5b744158…7eaa5287` | **vendor release-asset digest** |
| ghrdp-webrtc `f46727fe` | this repo (`webrtc-dist`) | `0525eed6…2b13eb8` | release-asset digest (sidecar `2f8830cb…`) |

The builder downloads vendor-first, mirror-second, verifies sha256 **and** size
per component, and exits 1 on any miss/mismatch - **nothing is published
unverified**. `tests/f65-bundle-manifest.test.js` re-proves the pipeline offline
through `--fixtures` and covers the fail-closed cells (tampered fixture, empty
pin, missing source).

Deliberately NOT bundled: **Parsec** (main.yml intentionally does not install it)
and **qBittorrent/aria2c** (owned by the F59 `prebuilt-binaries` lane - one source
of truth per component).

## 2. How main.yml consumes it (additive, never a hard dependency)

1. `F65 scratch root + background stack-bundle prefetch` - D:\scratch when D:
   exists, else C:\scratch with a `::warning::` (`scripts/f65-detect-scratch.ps1`).
   The producer `payloads/f65-prefetch.ps1` is launched **detached**
   (`Start-Process -PassThru`, no `-Wait`) so the ~300 MB single download overlaps
   every other setup step.
2. The producer resolves the pointer, downloads + verifies the bundle against the
   pointer AND the `.sha256` sidecar, extracts to `<scratch>\stack`, verifies every
   file through `Invoke-F65ParallelMap` (ThreadJob -> `ForEach-Object -Parallel`
   -> Start-Job wave, throttle 4), stages the extensions + prebuilt WebRTC, and
   writes `<scratch>\stack-state.json`.
3. Consumers (`Get-F65StackState` / `Get-F65Component`, bounded rendezvous) use a
   verified component when it is ready and otherwise keep **their existing
   individual download path**: virtual-display driver (IddSampleDriver), VB-CABLE,
   FFmpeg (the old `choco install ffmpeg` is now only the fallback), and the
   extension artefacts (staged for manual install; the policies keep the
   live-resolved store ids).
4. `F65 rendezvous + parallel health probes` - one bounded map (4 threads, 60 s
   cap) over dashboard `/health`, MagicDNS resolution, RDP 3389, WebRTC 8443 and
   the Parsec service; WebRTC/Parsec are **informational** here (they start later
   on this lane).
5. `F65 telemetry report` - copies the jsonl and uploads the `f65-telemetry`
   artifact; prints `[F65-TELEMETRY-COUNT] points=<n> stack=<ready|failed|…>`.

A bundle miss/mismatch is **fail-open for the job, fail-closed for the bundle**:
consumers log `f65-prefetch-fallback` + their individual-download source in the
telemetry stream, and the dispatch proceeds.

## 3. Telemetry points (>=15)

Producer: `f65-prefetch-start`, `f65-pointer-fetch`, `f65-bundle-download`,
`f65-bundle-sha256-verify`, `f65-bundle-extract`, `f65-manifest-verify`,
`f65-parallel-legs`, `f65-stack-extensions-staged`, `f65-stack-webrtc-staged`,
`f65-stack-ready`, `f65-prefetch-fallback`, `f65-prefetch-<status>`.
Launcher/consumers/probes/report: `f65-scratch-detect`, `f65-prefetch-launch`,
`f65-tailscale-join-start`, `f65-consumer-idd`, `f65-consumer-vbcable`,
`f65-consumer-extensions`, `f65-consumer-ffmpeg`, `f65-dashboard-ready`,
`f65-rendezvous-stack`, `f65-probe-<name>` (5 legs), `f65-probe-rendezvous`.

`tests/f65-telemetry-parse.test.js` parses the artifact shape and asserts the
mandated anchors; with `F65_TELEMETRY_ARTIFACT` set it runs over a REAL artifact
(the windows-native lab already does this over a PowerShell-written file).

## 4. Honest status - what is NOT shipped in this loop

- **Second-0 background Tailscale join: NOT shipped.** The join is still
  synchronous and `f65-tailscale-join-start` records ~60-70 s (its real
  position). F64's own baseline measured the join at 3-4 s with a 1 s wait, so the
  theoretical gain is ~0-4 s while a wrong authkey would surface later in the run
  than today's fail-closed halt. The 0-2 s band in the F65 spec is therefore
  **reported as a flag, never claimed** (see the telemetry test).
- **Prebuilt WebRTC consumer swap: NOT shipped.** The verified zip is staged
  (`C:\ghrdp\webrtc-prebuilt\`); main.yml still builds WebRTC in-runner because
  that build is identity-proof/stamped/session-guarded and the swap needs a live
  dispatch to validate. F63/F64's lineage owns that swap.
- **No critical-path reordering.** Moving qBittorrent/webdesk/F17 behind the
  dashboard (F63/F64's lever, ~75-100 s) is deliberately untouched: those PRs are
  open and re-doing the move here would collide with them.
- The individual IddSampleDriver URL in main.yml (`v1.0.2`) 404s upstream - that
  is a **pre-existing latent bug** found while wiring the consumer. The bundle
  path (0.0.1.4) is the working source; the fallback URL was left byte-identical
  on purpose (changing the fallback is a separate, operator-visible decision).
- **No live numbers yet.** `median-before` is F64's documented pre-merge baseline
  (6.41 min median, n=2, 5.62-7.20 min spread on F59-era dispatches). The
  post-merge median/p90 for F65 can only be measured after the operator merges and
  dispatches 3+ times.

## 5. Gates

- `gates` (ubuntu): additive step *F65 pre-staged bundle + scratch + telemetry
  gates* - runs `tests/f65-bundle-manifest.test.js` + `tests/f65-telemetry-parse.test.js`,
  asserts the file set, the push-primary trigger, the §6 refusals (no
  matrix/workflow_run, no self-hosted, no cron-only), the detached launch, the
  consumer rendezvous, `>=15` static telemetry emission sites, and the pin/fallback
  shape of `payloads/f65-bundle-manifest.json`.
- `windows-native`: additive step *F65 stack lab* - parses the five PS surfaces,
  runs `tests/f65-stack-lab.ps1` (scratch fallback, real concurrency, error
  isolation, tamper refusal, rendezvous) and then feeds a PowerShell-written
  telemetry file through the same node parser.
