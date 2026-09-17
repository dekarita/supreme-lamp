# GHRDP WebRTC server (port 8080)

Low-latency H.264 remote desktop for the ephemeral GitHub Actions Windows runner.
Built and deployed by `.github/workflows/main.yml`; every fresh runner must reach a
verified-working stream with zero manual steps.

## Two independent displays

| | WebRTC (:8080) | Legacy PS server (:7331) |
| --- | --- | --- |
| Transport | WebRTC (SRTP over ICE) | HTTP JPEG poll / webdesk |
| Latency | localhost ~5-15 ms; tailnet relay +50-200 ms | ~280 ms measured, DERP 655 ms immutable |
| Quality | H.264, dynamic bitrate | JPEG, quality locked at q=80 |
| Session | **must be SessionId 2** (Interactive) | works from any session |
| Use when | you need smooth motion / video | WebRTC is down, or you need the fallback |
| Client | `http://<host>:8080/` | `http://<host>:7331/` |

Rule of thumb: try **8080** first. Fall back to **7331** only when the WebRTC
probe fails, the badge shows a session warning, or you are on a lossy link where
JPEG polling degrades more gracefully than a video stream.

## Capture modes (`?mode=`)

| Mode | Capture | FPS | Bitrate | When |
| --- | --- | --- | --- | --- |
| default | 512x384 | 15 | 1200k | 2 vCPU Azure DS2_v2 ceiling; lowest latency |
| `?mode=640x480` | 640x480 | 15 | 1600k | text legibility matters; ~35% more pixels |

Append the query string to the page URL (`http://host:8080/?mode=640x480`) or use the
mode selector in the toolbar. The choice is persisted in `localStorage` and applied to
both the `/ws` stream and the `/version` stamp. `512x384` is half the 1024x768 console
resolution; an explicit mode overrides that.

## Endpoints

- `GET /` — client page (video, input, stats bar, commit/session badge)
- `GET /ws?mode=<m>` — signaling WebSocket; one pipeline per client
- `GET /health` — `ok` when the process is alive
- `GET /stats` — live pipeline telemetry (res, fps, drops, encoder, input_to_frame_ms);
  adds `size_mismatch` / `guard_tripped` only when a guard has fired, and
  `display_awake` for the anti-idle keepalive
- `GET /version` — deploy identity: `git_commit`, `build_time`, `capture`, `mode`,
  `encoder`, `session_id`, `exe_path`, `pid`, `required_session_id`, `default_mode`,
  `capture_mode`

## Failure handling

- **pipeline restart** — the capture pipeline is supervised, not run once. If capture,
  the encoder or ffmpeg dies (or the size assertion trips) it restarts after 1s..10s,
  gives up after 10 consecutive failures, and stops when the client disconnects.
- **session guard** — outside session 2 the process logs a FATAL and exits 42 rather
  than serving a black stream.
- **anti-idle** — the display is held awake with `SetThreadExecutionState` so a
  long-idle session does not dim into a dark stream.
- **stale owners** — a leftover server on :8080 and stale `ffmpeg.exe` are cleared at
  startup, after the singleton mutex is held.

## Deploy model

One script owns the deploy: `deploy-bootstrap.ps1`. It discovers rather than assumes:

- **workspace** — recursive search for `payloads\ghrdp-webrtc\go.mod` under `D:\a`
- **exe** — `(Get-ScheduledTask GhrdpWebRTC).Actions[0].Execute`
- **user** — the `Active` row from `quser.exe`

It then kills stale processes by the discovered exe name plus `ffmpeg.exe`, builds
synchronously with `-ldflags "-X main.gitCommit=... -X main.buildTime=..."`, swaps the
binary, re-registers the `GhrdpWebRTC` task with an Interactive principal, starts it,
and verifies `/version` reports `session_id == 2`.

`accept-webrtc.ps1` runs the headless probe (`cmd/probe`) for 30 s and writes
`C:\ghrdp\webrtc\acceptance.json`. The workflow fails loudly if the verdict is not
`PASS`, if `acceptance.json` is missing, or if its `git_commit` does not match the sha
the workflow deployed.

After the probe it also checks the deployed state, because a probe window alone cannot
prove the stream is still healthy: a tripped capture guard, `session_id != 2`, a
missing server or ffmpeg, or an `ffmpeg -video_size` that disagrees with `/version`
`res` (the v2 desync) all override a `PASS` to `FAIL`. A missing display keepalive is
reported as a warning only, since it degrades after minutes of idle rather than
stopping video.

## Failure signatures

| Symptom | Cause | Check |
| --- | --- | --- |
| top ~25% band is a grey gradient | capture size != encoder `-video_size` (v2 desync) | `ffmpeg.exe` CommandLine vs `/version` `res` |
| black canvas, `res=0x0`, `frames_sent=0` | server started in Session 0 | `/version` `session_id` |
| short blackout, then video returns | pipeline exited and the supervisor restarted it | `deploy.log` for `pipeline exited` / `pipeline restart` |
| blackout that never recovers | pipeline gave up after 10 consecutive failures | `deploy.log` for `pipeline gave up`, `ffmpeg-stderr.log` |
| stream darkens / goes black after minutes idle | display blanked, no keepalive holding it awake | `/stats` `display_awake` |
| stats frozen, one server but two ffmpeg | orphan ffmpeg from a previous run | `ffmpeg.exe` parent pid |
| stream refuses to start, exit 42 | session guard tripped (not session 2) | task principal, `quser` |
| `bind: address already in use` | leftover server still holding :8080 | `deploy.log` for `killed stale :8080 listener` |

## Honest limits

On 2 vCPU Azure with no GPU, 15 fps at 512x384 is the ceiling (640x480 trades a little
smoothness for legibility). DXGI Desktop Duplication cannot initialize without a GPU
(`DXGI_ERROR_NOT_FOUND`) so GDI StretchBlt is the real capture path; HW encoders
(NVENC/QSV/AMF) are absent, so `libx264 ultrafast` is used. Click-to-visual latency is
150-300 ms through the Tailscale relay because Azure blocks UDP 41641; sub-100 ms needs
a self-hosted runner. 1200k shows mild artifacts on motion-heavy screens; 640x480 at
1600k mitigates that at the cost of CPU.

## Local use

```powershell
cd payloads\ghrdp-webrtc
.\setup.ps1                # builds, deploys, registers the task, verifies /version
```

`setup.ps1` is a thin wrapper over `deploy-bootstrap.ps1`; there is exactly one deploy
path to trust.