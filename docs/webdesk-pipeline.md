# WebRTC-First Web Desk Pipeline — Frozen Contract (v1)

Status: **frozen v1**. This document is the single source of truth for the
session-split boundary, the metric definitions, and the two Phase-0 decisions.
Any change to a field name, a unit, or a message layout below is a **version
bump** and must be coordinated across the in-session agent
(`payloads/in-session/`), the SYSTEM-session broker (`payloads/broker.rs`), and
the browser client (`payloads/webdesk-client.js`).

The legacy MJPEG path (`frame.jpg` + `frame-ts.txt` + `input.ndjson`, served by
`ghrdp-webdesk.ps1` / `ghrdp-server.ps1` / `main.rs`) keeps working **unchanged**
and is the warm fallback. Nothing in this document changes its response shapes.

---

## 1. Session split

| Concern | Session | Where |
|---|---|---|
| Screen capture, encode, `SendInput`, cursor readback | interactive desktop session (the RDP user) | `payloads/ghrdp-webdesk.ps1` supervisor + `payloads/in-session/*` |
| WebRTC peer, ICE/DTLS/SRTP, congestion control, send queue | session 0 as SYSTEM | `payloads/broker.rs`, in-process with `ghrdp-dash.exe` on port 7332 |
| Browser client | tailnet | `payloads/webdesk-client.js`, served by the PS server |

The two Windows sessions do not share memory, so **all cross-session traffic is
localhost UDP datagrams** using only the message classes below. There is no
retry queue anywhere: a message that is late is dropped, never deferred.

An in-session browser is explicitly rejected (decision D1): the browser is
itself session-scoped, contaminates capture, and cannot be reached from the
tailnet while session 0 owns the socket.

## 2. Sockets

Two sockets, both on the loopback interface, so that a video flood cannot starve
control messages (per-class latest-only is enforceable on each independently):

| Role | Address | Direction | Message classes |
|---|---|---|---|
| `AGENT_RX` | `127.0.0.1:7411` (agent binds) | broker → agent | `INPUT_EVENT`, `KEYFRAME_REQ`, `LADDER`, `HELLO_ACK` |
| `BROKER_RX` | `127.0.0.1:7412` (broker binds) | agent → broker | `HELLO`, `VIDEO_NALU`, `CURSOR_*`, `INPUT_ACK`, `STATS` |

Both are configurable (`GHRDP_IPC_AGENT`, `GHRDP_IPC_BROKER`) and are bound
`127.0.0.1` only — never `0.0.0.0`. UDP is used (not TCP) because a dropped
`VIDEO_NALU` is by definition superseded and a queue would be the exact latency
bug Q1 exists to prevent.

## 3. Wire format

Every datagram is a fixed 18-byte big-endian header followed by a body whose
layout depends on `msg_type`.

```
off  size  field      type    notes
 0    2    magic      u16     0x4748 ('GH')
 2    2    version    u16     1
 4    1    msg_type   u8      see table
 5    1    flags      u8      bit0 = keyframe, bit1 = scene_cut,
                               bit2 = fec_parity, bit3 = retransmit
 6    4    seq        u32     per-sender monotonic, wraps at 2^32
10    8    ts_us      u64     IPC_TIMESTAMP_US (see §4)
18    N    body
```

Datagrams whose magic/version/`msg_type` do not parse are dropped and counted in
`status.ipcMalformed`. A datagram larger than 1400 bytes is truncated by the
sender, never fragmented (see `STATS.maxDatagramBytes` in §6).

`IPC_TIMESTAMP_US` is **microseconds since the UNIX epoch**. The agent and the
broker run on the same machine, so the clock is shared and no clock-sync step is
needed. This is what makes the top-level SLO measurable by the broker alone
(§5).

### 3.1 Message classes

| type | name | origin | body |
|---|---|---|---|
| `0x01` | `HELLO` | agent | JSON `{"agent":"1.0","pid":n,"warmFps":n}` |
| `0x02` | `HELLO_ACK` | broker | JSON `{"broker":"1.0","pid":n}` |
| `0x10` | `INPUT_EVENT` | broker | 1B `kind` + 8B `eventId` + 8B `inputTsUs` + JSON event |
| `0x11` | `INPUT_ACK` | agent | 8B `eventId` + 8B `inputTsUs` + 8B `injectTsUs` |
| `0x21` | `CURSOR_POS` | agent | 4B `x` + 4B `y` + 4B `screenW` + 4B `screenH` (all int32 BE) |
| `0x22` | `CURSOR_SHAPE` | agent | 2B `hotspotX` + 2B `hotspotY` + PNG bytes (≤64×64) |
| `0x23` | `CURSOR_VIS` | agent | 1B `visible` |
| `0x30` | `VIDEO_NALU` | agent | 4B `w` + 4B `h` + 1B `codec` + 1B `tier` + 2B reserved + Annex-B bytes |
| `0x40` | `STATS` | agent | JSON, fields fixed in §6 |
| `0x50` | `KEYFRAME_REQ` | broker | JSON `{"reason":"loss\|decoder\|scene_cut","frameId":n}` |
| `0x52` | `LADDER` | broker | JSON `{"tier":n,"quality":n,"scale":f,"fpsCap":n,"path":"derp\|direct","rttMs":f}` |

`kind` in `INPUT_EVENT` is the same one-byte tag used by the legacy NDJSON
contract so the two paths stay interchangeable:

```
'm' mousemove   'ld' left down   'lu' left up   'rd' right down
'ru' right up   'w' wheel        'k' key char   'kd' key down   'ku' key up
```

JSON bodies are UTF-8, compact, and must not contain a trailing newline (the
legacy NDJSON path *does* carry newlines; this path does not). `codec` is `1` for
H.264 Annex-B. `tier` is the ladder tier in force when the frame was encoded
(§7), or `255` for "not produced by the primary pipeline" — used when the
in-session agent echoes a captured frame it could not encode.

**Hot messages are binary, cold messages are JSON.** `INPUT_EVENT`,
`INPUT_ACK`, `CURSOR_*`, and `VIDEO_NALU` are on the interactive path and use
fixed layouts so neither side pays parse cost in the critical section.
`HELLO`/`STATS`/`KEYFRAME_REQ`/`LADDER` are 1 Hz or slower and use JSON so they
stay inspectable in logs.

### 3.2 Latest-only policies

| class | policy |
|---|---|
| `VIDEO_NALU` | depth-1 slot: a newer frame replaces any unsent predecessor (§7 Q1) |
| `CURSOR_POS` / `CURSOR_SHAPE` / `CURSOR_VIS` | coalesce to newest per class per broker tick; never queued |
| `INPUT_EVENT` | ordered by `eventId`; injected in order; a gap is logged, never replayed |
| `INPUT_ACK` / `STATS` | latest-only |
| `KEYFRAME_REQ` | coalesce; at most one outstanding request |

## 4. Metric definitions

All durations are milliseconds in the stats surface (converted from µs on the
wire). "p95" is the nearest-rank 95th percentile over the trailing report
window, computed from a ring buffer of the last 2048 samples unless stated
otherwise.

| metric | definition |
|---|---|
| `clickToPixelMs` | `frame_presented_ts − inputTsUs` where the frame is the **first frame whose NAL bytes were encoded from a capture taken after `injectTsUs`**. Because the broker knows `injectTsUs` (from `INPUT_ACK`) and the capture timestamp carried in the `VIDEO_NALU` header, this is computed on the broker with no clock sync. |
| `frameToRenderMs` | `frame_presented_ts − video_capture_ts` |
| `inputAckMs` | `injectTsUs − inputTsUs` (input path alone, no pixels) |
| `encodeMs` | encode end − capture ts, in-session |
| `sendMs` | bytes-on-wire ts − IPC receive ts, broker |
| `frameAgeMs` | `now − video_capture_ts` at the moment a frame is about to be sent; the "is this frame already stale" signal |
| `queueDepth` | unsent frames held by the broker. Structurally 0 or 1 (§7) |
| `jitterBufferFrames` | frames held in-session between capture and encode. Structurally 0 or 1 (§7) |
| `encodeFps` | encoded frames per second over the trailing 1 s |
| `captureFps` | frames captured per second over the trailing 1 s |
| `warmFps` | frames written to `frame.jpg` per second (the fallback rate) |
| `keyframesEmitted` | count of keyframes sent, with `keyframeReasons` histogram |
| `lastKeyframeMs` | time since the previous keyframe; the 1-per-5 s limiter reads this |
| `nackSent` / `nackRecovered` / `fecParitySent` | loss-recovery counters (§8) |
| `pathType` | `derp` or `direct`, from §9 |
| `ladderTier` | current rung of the fixed ladder (§7) |
| `clientPath` | `auto` / `webrtc` / `mjpeg` — the effective override in force |
| `fallbackReason` | last trigger that fired, or `""` |
| `fallbacks` / `upgrades` | monotonic counts |

### 4.1 SLO

`p95 clickToPixelMs` is the **single top-level objective**. Per-path targets
after laddering on a degraded path:

| path | p95 target |
|---|---|
| `derp` | ≈ 335 ms |
| `direct` | ≈ 120–160 ms |

Median FPS is informational and is expected to sit **at or below** the cap
(§7), never above. An fps number above the cap is a bug in the controller, not a
win.

## 5. SLO derivation (why 335 ms / 120–160 ms)

The pipeline adds no buffering, so the budget is dominated by RTT and tail
spread rather than by queueing:

```
direct:  0.5*RTT(~25ms) + jitter/retransmit headroom + capture/encode (~45ms)
         + send/present (~40ms)  ≈ 120–160 ms
derp:    0.5*RTT(~170ms) + DERP store-and-forward reorder tail (~120ms)
         + capture/encode (~45ms) + present (~40ms)  ≈ 335 ms
```

The DERP tail is the reason the DERP figure is roughly 2× the direct figure
rather than proportional to RTT alone: a relayed path re-orders and
store-and-forwards, so the *tail* of the path delay, not the median, sets p95.
This is also why the policy is expressed as a worst-case bound: on DERP the
median is fine while the p95 is what a user feels.

### 5.1 Open tension: warm-MJPEG staleness

The warm fallback runs at 2 fps, so the worst-case first frame after a switch is
~500 ms old. Two options were left open in the plan (§3 "Two tensions"):

* raise the warm rate to 5 fps (worst-case ~200 ms), or
* apply the p95 SLO formally to the WebRTC path only and give the fallback a
  looser SLO.

**Resolution adopted here: 5 fps warm rate (`GHRDP_WARM_FPS`, default 5).** The
cost is one extra `CopyFromScreen` + JPEG encode per 200 ms in a session that is
already running the loop; the benefit is that the fallback still behaves like an
interactive desktop, which is the whole point of keeping it warm. The fallback
still carries a looser SLO than WebRTC (`p95 click-to-pixel ≤ 2× the WebRTC
target`) and is not counted toward the primary SLO. The gate in §10 was
reconsidered: the warm path stays on `CopyFromScreen` because DDA cannot be held
open concurrently by two consumers without stalling each other; the fallback
therefore has an independent failure mode from the primary path, which is
desirable.

## 6. `STATS` field list (frozen)

Agent → broker, 1 Hz plus on-demand. All numbers are integers or floats; absent
counters must be sent as `0`, never omitted.

```
captureTsUs, encodeTsUs, sendTsUs, presentedTsUs   u64  µs
captureFps, encodeFps, warmFps                     f64
encodeMsP95, dropCount, jitterBufferFrames         f64/u64/u32
cacheMisses, captureMode ("dda"|"gdi")             u64/str
encoderName, encoderHardware (bool)                str/bool
keyframesEmitted, lastKeyframeMs, keyframeReasons  u64/f64/obj
naluSent, naluDropped                              u64
queueDepth, frameAgeMs                             u32/f64
nackSent, nackRecovered, fecParitySent             u64
inputEventsInjected, inputAckP95Ms                 u64/f64
pathType, ladderTier, fpsCap, rttMs, jitterMs      str/u8/u16/f64/f64
agentPid, agentUptimeS, ipcRttMs                   u32/u64/f64
```

`keyframeReasons` is `{"scene_cut":n,"loss":n,"decoder":n,"request":n}`.

## 7. Decisions (Phase 0.2)

### 7.1 Encoder

**Decision: Media Foundation H.264 MFT when a hardware encoder is present, with
a deterministic fallback chain, and a scene-cut-forced keyframe policy.**

Probed availability on a `windows-latest` runner (see
`payloads/ghrdp-webdesk.ps1` / `payloads/in-session/GhrdpEncode.ps1` and the
`probe-encoder.ps1`-style enumeration in the workflow's webdesk step):

1. `MFT_ENUM_FLAG_HARDWARE` H.264 encoder MFT → preferred. On GitHub-hosted
   `windows-latest` (a Hyper-V guest without a virtualized GPU) this is
   **absent**; on a GPU-backed runner it is selected automatically.
2. `MFT_ENUM_FLAG_SYNCHRONOUS | MFT_ENUM_FLAG_ASYNCMFT` H.264 encoder MFT
   (software, the "H264 Encoder MFT" shipped with Windows) → used on the hosted
   runner.
3. `MFT_ENUM_FLAG_TRANSCODE` (`CODECAPI_AVEncCommonRateControlMode` /
   `-MFTrace`) → last resort.

If **no** H.264 MFT can be activated, the agent does not fail: it marks the
pipeline degraded, emits `captureMode="gdi"` with a null encoder, and the broker
keeps the client on MJPEG (§10). This is the honest-degradation convention the
repo already uses for the Rust build.

Consequence for the floor: the software MFT sustains 6 fps at 1280×720 and is
the binding constraint; the ladder's bottom rung is therefore pinned at
**≤1280×720 @ 6 fps**, and native-resolution floor-6 is only reachable when a
hardware MFT is selected. This is recorded here so the controller is not tuned
against an unreachable rung.

### 7.2 SYSTEM-side WebRTC stack

**Decision: embedded in the existing Rust service (`payloads/broker.rs`), built
into `ghrdp-dash.exe`.**

Rationale: the broker inherits the existing build (`cargo build --release`),
launch (`GhrdpRustDash`), port (7332), sentinel (`rust-ok.txt`), and cleanup
(`main.yml` wipe) paths with no new deployment surface, no extra binary to
stage, and no new firewall rule. Alternatives rejected: `pion` (a second
toolchain and a second binary to stage and supervise inside an ephemeral
357-minute job) and a `libdatachannel` helper (a native dependency to fetch and
pin). The peer/ICE/DTLS/SRTP work sits behind the `Transport` trait (§11) so the
stack choice is reversible without touching the controller, queue, or
instrumentation.

### 7.3 DERP/direct authority

**Decision: Tailscale CLI probe (`tailscale ping`) is authoritative**, via the
existing `probe_wire()` (`payloads/main.rs`); the ICE selected-pair type is
recorded as a corroborating field only.

Rationale: `probe_wire()` already exists, already reports `DERP(<region>)` vs
`DIRECT <ip>` with RTT, and is already surfaced through `/ping` and the
`/webdesk-probe` path (`ts-path.txt`). The ICE pair type describes the transport
the browser happened to negotiate, which on a tailnet can legitimately be a
direct path even when Tailscale is relaying, so disagreement is expected and
must not flip the policy.

### 7.4 Logging

**Decision: in-process log ring plus a periodic fully-rewritten snapshot file.**

`C:\ghrdp\in-session\agent.log` and `C:\ghrdp\broker.log` are never
read-modify-written (that is the pattern that races on Windows and has already
bitten this repo). Each writer keeps a bounded ring in memory and rewrites the
whole file every `GHRDP_LOG_FLUSH_MS` (default 1000), plus once on shutdown.

## 8. Loss recovery

* NACK: the broker tracks received `seq` per frame id; a gap raises a NACK
  request for the missing NAL units. `nackRecovered` counts gaps closed before
  the frame's presentation deadline.
* FEC: a small fixed-overhead XOR parity NAL per frame group of 4
  (`fecParitySent`). Deliberately "light": overhead is bounded and the parity is
  only useful for single-loss bursts, which is the tailnet profile.
* Keyframes: emitted **only** on unrecoverable loss, decoder failure, or
  scene-cut, rate-limited to **at most one per 5 s** (`lastKeyframeMs`).
  Steady-state keyframes are a bug.

## 9. Degradation and fallback policy

### 9.1 Ladder (Q1)

Quality → resolution → fps. Never buffering. Caps: **12 fps on DERP, 24 fps on
direct, hard floor 6 fps.**

| tier | quality | scale | fpsCap |
|---|---|---|---|
| 0 | 60 | 1.00 | path cap (12 / 24) |
| 1 | 50 | 1.00 | path cap |
| 2 | 42 | 0.85 | path cap |
| 3 | 35 | 0.70 | 12 |
| 4 | 30 | 0.60 | 9 |
| 5 | 25 | 0.50 | 6 |

The controller steps **down one rung** when the recent p95 frame age or loss
exceeds the rung's budget, and steps **up one rung** only after a healthy
window. `queueDepth` and `jitterBufferFrames` never change: there is nowhere to
buffer.

### 9.2 Fallback (Q3)

Two trigger classes, deliberately non-redundant:

*Immediate* — switch now:

| trigger | condition |
|---|---|
| decoder fatal | decoder reports a fatal error |
| ICE failure | ICE failure sustained > 3 s |
| render failures | 3 consecutive client render failures |

*Sustained, over a 5 s window* — catch the degraded-but-alive case:

| trigger | condition |
|---|---|
| frame-to-render | p95 > 1500 ms |
| fps | < 8 |
| input ack | p95 > 2000 ms |

On trigger: switch to the warm MJPEG path **immediately** (the path is already
warm, so this is a visibility toggle, not a pipeline start) and start a **30 s
cooldown**. After cooldown, attempt WebRTC again; declare the path restored only
after **two consecutive 10 s healthy windows**. Override: `auto | webrtc |
mjpeg`, persisted in `config.json` as `webdeskPath` and readable through
`/api/config`, with `POST /webdesk-rtc/config` to set it.

Interaction order (§3.3 of the plan): the ladder steps down **first**, on its
own faster timescale; the sustained-window triggers accumulate **in parallel**.
A bottomed-out ladder plus a sustained trigger falls back rather than holding
the floor. Ladder steps never cause a fallback on their own.

## 10. Startup gating

The pipeline is opt-in-safe. If the encoder or the broker fails to initialize,
the agent reports the failure through `/webdesk-probe` (`webdeskRtc`,
`webdeskRtcErr`) and the client stays on MJPEG. The `input.ndjson` contract
remains valid throughout, so fallback input is unaffected. A cold start with a
broken encoder must still yield a usable desktop.

## 11. Test seams

* `Transport` trait — the broker's sender is written against it, with a real
  WebRTC implementation and a `LoopbackTransport` used by the harness. The
  controller, queue, ladder, fallback state machine, and instrumentation are
  exercised unchanged by both.
* `C:\ghrdp\ipc-loopback.ndjson` — when `GHRDP_LOOPBACK=1`, the broker appends
  one JSON line per IPC message and per instrumentation sample. The Phase-4
  harness (`payloads/harness/`) consumes it.
* `payloads/in-session/agent-mock` is not a second implementation: the harness
  drives the real agent modules with synthetic sources.