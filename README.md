# supreme-lamp

Ephemeral Windows desktop in GitHub Actions. One manual dispatch gives you a
2 vCPU Azure runner (no GPU) reachable over Tailscale for ~5h30, plus a Go/Pion
WebRTC view of the same desktop in a browser.

Two things serve the same machine on different ports. Pick by what you need:

| | `:7331` legacy dashboard | `:8080` WebRTC |
|---|---|---|
| Transport | HTTP polling + JPEG frames | WebRTC (H.264) |
| Quality | locked `q=80` JPEG | 512x384@15, 1200k (or 640x480@1600k) |
| Latency (external) | DERP relay, ~655ms measured | 150-300ms external, ~80ms localhost |
| Input | form POST / relative coords | data channel, absolute coords |
| Best for | file browsing, fallback when WebRTC is blocked | interactive desktop |
| Failure mode | always available while the PS server runs | needs session 2 + capture |

Use `:7331` when you just need to look at the box or WebRTC will not connect.
Use `:8080` when you need to actually drive the desktop.

## Restore a session (zero manual steps on the runner)

1. Actions -> **Windows RDP - Tailscale Mission Control (6h ephemeral)** -> Run workflow.
   Leave `runner_target` on `windows-latest`. Leave `mirror_downloads_public` off
   unless you also want the download mirror.
2. Wait for the **Keep-alive 5h30** step to show as running. Acceptance runs
   before it and takes ~40s.
3. Get the address. Either read the job summary, or watch the step log for the
   line printed every 5th heartbeat:

   ```
   tailscale IP: 100.x.y.z | RDP: 100.x.y.z:3389 | web: http://100.x.y.z:8080/
   ```

   The public IP changes on every run; there are no hardcoded addresses.
4. Connect:
   - RDP: `100.x.y.z:3389`, user `RDP_USER`, password from the run's config.
   - WebRTC: `http://100.x.y.z:8080/` — add `?mode=640x480` for the higher
     bitrate mode when the link is good.
   - Legacy: `http://100.x.y.z:7331/`.
5. Stop early with `gh run cancel <run-id> -R <owner>/<repo>`. The emergency
   mirror pass still runs so the index is complete.

## What a healthy run looks like

Acceptance writes `acceptance.json` and prints a table. It is a diagnostic: it
can fail without ending the run, and it repairs a dead pipeline before judging
it. A PASS means:

- `fps >= 10`, `kbps <= 2500`, `decode_ok >= 0.99`
- `candidate` resolved (`host` on localhost, otherwise `srflx`/`relay`)
- `session_id == 2` — anything else means the server is in a session with no
  desktop and would stream black
- `max_gap_ms <= 2000` and `terminal_gap_ms <= 2000`

`terminal_gap_ms` is the silence from the last frame to the end of the probe
window. It exists because a stream that stops and stays stopped emits no further
packet, so a between-frames gap scan cannot see it. Run 35258476317 lost the
server 13s into a 30s window and still reported 47.9fps / PASS; the dead tail is
now a verdict criterion.

## Acceptance criteria (B1-B6)

| | Check | Where |
|---|---|---|
| B1 | `acceptance.json` PASS + table in the job summary | Auto-acceptance step |
| B2 | `/version` `session_id=2`, `git_commit` == workflow SHA | Stamp guard + probe |
| B3 | legible `:8080`, fps >= 10, no gradient, no blackout > 2s | probe `max_gap_ms` |
| B4 | `input_to_frame_ms <= 120` | probe |
| B5 | legacy `:7331` responds | keep-alive heartbeat |
| B6 | one server, one ffmpeg, `ffmpeg -video_size` == `/version` size | accept script |

## Why things break here

Known-answer list, so nobody re-diagnoses these:

- **Session 0 kills capture.** DXGI duplication returns `DXGI_ERROR_NOT_FOUND`
  and GDI capture yields a black desktop. The server checks its session at
  startup, logs FATAL and exits 42 rather than serving black.
- **No GPU.** No NVENC/QSV/AMF. libx264 ultrafast, software only. 15fps at
  512x384 is the ceiling on 2 vCPU.
- **The runner IP changes per run.** Never hardcode it; discover it from the
  heartbeat line or `tailscale ip -4`.
- **UDP 41641 is blocked by Azure.** External clients reach the box over
  STUN/TURN, which adds 50-200ms. Sub-100ms needs a self-hosted runner.
- **The binary name is not fixed.** Read it from the scheduled task's
  `Actions[0].Execute`. It is `webrtc-server.exe` today and the scripts discover
  it rather than assuming.
- **`terminal-exec` runs are one-shot.** `Start-Job` does not persist across
  runs, and the SYSTEM session has no runner env vars. Builds are synchronous.
- **The desync signature**: grey gradient over the top fraction of the frame
  means capture size != ffmpeg `-video_size`. Compare `/version` `capture` with
  `ffmpeg.exe`'s command line.

## Layout

```
payloads/ghrdp-webrtc/     Go WebRTC server (main, capture, encoder, modes)
payloads/ghrdp-webrtc/cmd/probe/  acceptance probe (RTP + data channel)
payloads/ghrdp-webrtc/static/index.html  browser client
payloads/ghrdp-webrtc/accept-webrtc.ps1  deploy acceptance + repair
.github/workflows/main.yml  the whole ephemeral runner
docs/                       GitHub Pages status view
```