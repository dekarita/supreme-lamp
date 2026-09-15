//! IPC contract v1 between the SYSTEM-session broker and the interactive-session
//! agent. Frozen in `docs/webdesk-pipeline.md` sections 2-3; any layout change
//! is a contract version bump and must be mirrored in
//! `payloads/in-session/GhrdpIpc.cs`.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::broker::queue::VideoFrame;

pub const MAGIC: u16 = 0x4748;
pub const VERSION: u16 = 1;
pub const HEADER_LEN: usize = 18;
pub const VIDEO_HEADER_LEN: usize = 12;
pub const MAX_DATAGRAM: usize = 1400;

pub const T_HELLO: u8 = 0x01;
pub const T_HELLO_ACK: u8 = 0x02;
pub const T_INPUT_EVENT: u8 = 0x10;
pub const T_INPUT_ACK: u8 = 0x11;
pub const T_CURSOR_POS: u8 = 0x21;
pub const T_CURSOR_SHAPE: u8 = 0x22;
pub const T_CURSOR_VIS: u8 = 0x23;
pub const T_VIDEO_NALU: u8 = 0x30;
pub const T_STATS: u8 = 0x40;
pub const T_KEYFRAME_REQ: u8 = 0x50;
pub const T_LADDER: u8 = 0x52;

pub const F_KEYFRAME: u8 = 0x01;
pub const F_SCENE_CUT: u8 = 0x02;
pub const F_FEC_PARITY: u8 = 0x04;
pub const F_RETRANSMIT: u8 = 0x08;

pub const CODEC_H264: u8 = 1;
pub const CODEC_JPEG: u8 = 2;
pub const TIER_NONE: u8 = 255;

/// Microseconds since the UNIX epoch. Both processes run on the same machine, so
/// this clock is shared and the broker can compute click-to-pixel without any
/// clock-sync step.
pub fn now_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub msg_type: u8,
    pub flags: u8,
    pub seq: u32,
    pub ts_us: u64,
}

impl Header {
    pub fn encode(&self, body: &[u8], out: &mut Vec<u8>) {
        out.clear();
        out.reserve(HEADER_LEN + body.len());
        out.extend_from_slice(&MAGIC.to_be_bytes());
        out.extend_from_slice(&VERSION.to_be_bytes());
        out.push(self.msg_type);
        out.push(self.flags);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.ts_us.to_be_bytes());
        out.extend_from_slice(body);
    }
}

pub fn build(msg_type: u8, flags: u8, seq: u32, ts_us: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + body.len());
    Header {
        msg_type,
        flags,
        seq,
        ts_us,
    }
    .encode(body, &mut out);
    out
}

/// Parse a datagram header. `None` for anything malformed; the caller counts it
/// as `ipcMalformed` rather than logging per-datagram (a malformed flood must
/// not become a logging flood).
pub fn parse(data: &[u8]) -> Option<(Header, &[u8])> {
    if data.len() < HEADER_LEN {
        return None;
    }
    if u16::from_be_bytes([data[0], data[1]]) != MAGIC {
        return None;
    }
    if u16::from_be_bytes([data[2], data[3]]) != VERSION {
        return None;
    }
    let msg_type = data[4];
    if !matches!(
        msg_type,
        T_HELLO
            | T_HELLO_ACK
            | T_INPUT_EVENT
            | T_INPUT_ACK
            | T_CURSOR_POS
            | T_CURSOR_SHAPE
            | T_CURSOR_VIS
            | T_VIDEO_NALU
            | T_STATS
            | T_KEYFRAME_REQ
            | T_LADDER
    ) {
        return None;
    }
    Some((
        Header {
            msg_type,
            flags: data[5],
            seq: u32::from_be_bytes([data[6], data[7], data[8], data[9]]),
            ts_us: u64::from_be_bytes([
                data[10], data[11], data[12], data[13], data[14], data[15], data[16], data[17],
            ]),
        },
        &data[HEADER_LEN..],
    ))
}

// -- Agent -> broker bodies -------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct VideoMeta {
    pub width: u32,
    pub height: u32,
    pub codec: u8,
    pub tier: u8,
}

pub fn parse_video(body: &[u8]) -> Option<(VideoMeta, &[u8])> {
    if body.len() < VIDEO_HEADER_LEN {
        return None;
    }
    Some((
        VideoMeta {
            width: u32::from_be_bytes([body[0], body[1], body[2], body[3]]),
            height: u32::from_be_bytes([body[4], body[5], body[6], body[7]]),
            codec: body[8],
            tier: body[9],
        },
        &body[VIDEO_HEADER_LEN..],
    ))
}

#[derive(Debug, Clone, Copy)]
pub struct InputAck {
    pub event_id: u64,
    pub input_ts_us: u64,
    pub inject_ts_us: u64,
}

pub fn parse_input_ack(body: &[u8]) -> Option<InputAck> {
    if body.len() < 24 {
        return None;
    }
    let r = |o: usize| {
        u64::from_be_bytes([
            body[o],
            body[o + 1],
            body[o + 2],
            body[o + 3],
            body[o + 4],
            body[o + 5],
            body[o + 6],
            body[o + 7],
        ])
    };
    Some(InputAck {
        event_id: r(0),
        input_ts_us: r(8),
        inject_ts_us: r(16),
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
    pub screen_w: i32,
    pub screen_h: i32,
}

pub fn parse_cursor_pos(body: &[u8]) -> Option<CursorPos> {
    if body.len() < 16 {
        return None;
    }
    let r = |o: usize| i32::from_be_bytes([body[o], body[o + 1], body[o + 2], body[o + 3]]);
    Some(CursorPos {
        x: r(0),
        y: r(4),
        screen_w: r(8),
        screen_h: r(12),
    })
}

// -- Broker -> agent bodies -------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputEvent {
    pub kind: String,
    pub event_id: u64,
    pub input_ts_us: u64,
    pub event: serde_json::Value,
}

/// `1B kind tag + 8B eventId + 8B inputTsUs + JSON event`, per section 3.1.
pub fn build_input_event(ev: &InputEvent) -> Vec<u8> {
    let kind = kind_tag(&ev.kind);
    let payload = serde_json::to_vec(&ev.event).unwrap_or_else(|_| b"{}".to_vec());
    let mut body = Vec::with_capacity(17 + payload.len());
    body.push(kind);
    body.extend_from_slice(&ev.event_id.to_be_bytes());
    body.extend_from_slice(&ev.input_ts_us.to_be_bytes());
    body.extend_from_slice(&payload);
    body
}

/// One-byte tags for the input kinds. Written out as named constants because
/// `0x80 | b'l'` inside a match arm is an OR-pattern, not a bitwise or, and would
/// silently match the wrong values.
pub const K_MOVE: u8 = b'm';
pub const K_WHEEL: u8 = b'w';
pub const K_KEY: u8 = b'k';
pub const K_KEY_DOWN: u8 = b'd';
pub const K_KEY_UP: u8 = b'u';
pub const K_LEFT_DOWN: u8 = 0x80 | b'l';
pub const K_LEFT_UP: u8 = 0x40 | b'l';
pub const K_RIGHT_DOWN: u8 = 0x80 | b'r';
pub const K_RIGHT_UP: u8 = 0x40 | b'r';

/// Map a legacy NDJSON `t` value to the one-byte tag so the two input paths stay
/// interchangeable.
fn kind_tag(kind: &str) -> u8 {
    match kind {
        "m" => K_MOVE,
        "ld" => K_LEFT_DOWN,
        "lu" => K_LEFT_UP,
        "rd" => K_RIGHT_DOWN,
        "ru" => K_RIGHT_UP,
        "w" => K_WHEEL,
        "k" => K_KEY,
        "kd" => K_KEY_DOWN,
        "ku" => K_KEY_UP,
        _ => b'?',
    }
}

/// Inverse of `kind_tag`, used by the in-session agent (mirrored in C#) and by
/// the loopback harness.
pub fn kind_from_tag(tag: u8) -> &'static str {
    match tag {
        K_MOVE => "m",
        K_WHEEL => "w",
        K_KEY => "k",
        K_KEY_DOWN => "kd",
        K_KEY_UP => "ku",
        K_LEFT_DOWN => "ld",
        K_LEFT_UP => "lu",
        K_RIGHT_DOWN => "rd",
        K_RIGHT_UP => "ru",
        _ => "?",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyframeReq {
    pub reason: String,
    pub frame_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LadderMsg {
    pub tier: u8,
    pub quality: u8,
    pub scale: f64,
    pub fps_cap: u16,
    pub path: String,
    pub rtt_ms: f64,
}

/// Parsed `STATS` body, section 6. Unknown/absent fields default rather than
/// failing, so an older agent cannot take the broker down.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentStats {
    #[serde(default, rename = "captureFps")]
    pub capture_fps: f64,
    #[serde(default, rename = "encodeFps")]
    pub encode_fps: f64,
    #[serde(default, rename = "warmFps")]
    pub warm_fps: f64,
    #[serde(default, rename = "encodeMsP95")]
    pub encode_ms_p95: f64,
    #[serde(default, rename = "dropCount")]
    pub drop_count: u64,
    #[serde(default, rename = "jitterBufferFrames")]
    pub jitter_buffer_frames: u32,
    #[serde(default, rename = "captureMode")]
    pub capture_mode: String,
    #[serde(default, rename = "encoderName")]
    pub encoder_name: String,
    #[serde(default, rename = "encoderHardware")]
    pub encoder_hardware: bool,
    #[serde(default, rename = "keyframesEmitted")]
    pub keyframes_emitted: u64,
    #[serde(default, rename = "lastKeyframeMs")]
    pub last_keyframe_ms: f64,
    #[serde(default, rename = "naluSent")]
    pub nalu_sent: u64,
    #[serde(default, rename = "naluDropped")]
    pub nalu_dropped: u64,
    #[serde(default, rename = "cacheMisses")]
    pub cache_misses: u64,
    #[serde(default, rename = "inputEventsInjected")]
    pub input_events_injected: u64,
    #[serde(default, rename = "inputAckP95Ms")]
    pub input_ack_p95_ms: f64,
    #[serde(default, rename = "agentPid")]
    pub agent_pid: u32,
    #[serde(default, rename = "agentUptimeS")]
    pub agent_uptime_s: u64,
    #[serde(default)]
    pub keyframe_reasons: serde_json::Value,
}

// -- Shared sequence/counter plumbing ---------------------------------------

/// Per-sender monotonic sequence, wrapping at 2^32 with a jump to 1 so `0`
/// stays reserved for "unset" in heuristics that treat a gap as loss.
#[derive(Debug, Default)]
pub struct SeqCounter(AtomicU64);

impl SeqCounter {
    pub fn next(&self) -> u32 {
        let v = self.0.fetch_add(1, Ordering::Relaxed);
        ((v % u32::MAX as u64) + 1) as u32
    }
}

/// Nearest-rank percentile ring, matching `Ring` in `GhrdpIpc.cs` so the two
/// sides cannot disagree about what p95 means.
#[derive(Debug)]
pub struct Ring {
    values: Vec<f64>,
    next: usize,
    len: usize,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        Self {
            values: vec![0.0; capacity.max(1)],
            next: 0,
            len: 0,
        }
    }

    pub fn add(&mut self, x: f64) {
        self.values[self.next] = x;
        self.next = (self.next + 1) % self.values.len();
        if self.len < self.values.len() {
            self.len += 1;
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn percentile(&self, p: f64) -> f64 {
        if self.len == 0 {
            return 0.0;
        }
        let mut copy = self.values[..self.len].to_vec();
        copy.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx = ((p * copy.len() as f64).ceil() as isize - 1).max(0) as usize;
        copy[idx.min(copy.len() - 1)]
    }

    pub fn mean(&self) -> f64 {
        if self.len == 0 {
            return 0.0;
        }
        self.values[..self.len].iter().sum::<f64>() / self.len as f64
    }
}

/// Tracks which sequence numbers were seen so a gap can raise a NACK. Bounded:
/// retention is a small set, because a NACK is only useful inside the frame's
/// presentation deadline and anything older is superseded by the depth-1 slot.
#[derive(Debug, Default)]
pub struct GapTracker {
    seen: Mutex<HashSet<u32>>,
    last: AtomicU64,
}

impl GapTracker {
    pub fn observe(&self, seq: u32) -> Vec<u32> {
        let last = self.last.swap(seq as u64, Ordering::Relaxed) as u32;
        let mut gaps = Vec::new();
        if last != 0 && seq > last && seq - last < 64 {
            for s in (last + 1)..seq {
                gaps.push(s);
            }
        }
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.insert(seq);
        // Keep the set small: drop entries far behind the newest sequence.
        if seen.len() > 512 {
            let cutoff = seq.saturating_sub(256);
            seen.retain(|s| *s >= cutoff);
        }
        gaps
    }

    pub fn mark_recovered(&self, seq: u32) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.insert(seq)
    }
}

/// Reassembles one frame from the fragments the agent split it into.
///
/// One slot, not a map: the broker is only ever interested in the newest frame,
/// and a partial older frame is worthless once a newer one starts. A fragment
/// for a different frame discards the in-progress one rather than growing a
/// buffer — the same "latest-only" rule that governs the send queue applies on
/// the way in, or the pipeline would simply buffer at the other end.
#[derive(Debug, Default)]
pub struct FrameAssembler {
    slot: Option<PartialFrame>,
    pub completed: u64,
    pub superseded: u64,
    pub orphan_fragments: u64,
}

#[derive(Debug)]
struct PartialFrame {
    frame_id: u64,
    count: u16,
    meta: VideoMeta,
    flags: u8,
    capture_ts_us: u64,
    fragments: Vec<Option<Vec<u8>>>,
    have: u16,
}

impl FrameAssembler {
    pub fn push(
        &mut self,
        frame_id: u64,
        index: u16,
        count: u16,
        meta: VideoMeta,
        flags: u8,
        capture_ts_us: u64,
        payload: &[u8],
    ) -> Option<VideoFrame> {
        if count == 0 || index >= count {
            return None;
        }
        let is_new = match &self.slot {
            Some(p) => p.frame_id != frame_id,
            None => true,
        };
        if is_new {
            if self.slot.is_some() {
                self.superseded += 1;
            }
            self.slot = Some(PartialFrame {
                frame_id,
                count,
                meta,
                flags,
                capture_ts_us,
                fragments: vec![None; count as usize],
                have: 0,
            });
        }
        let complete = {
            let p = match self.slot.as_mut() {
                Some(p) => p,
                None => return None,
            };
            if p.fragments[index as usize].is_none() {
                p.fragments[index as usize] = Some(payload.to_vec());
                p.have += 1;
            }
            p.have == p.count
        };
        if !complete {
            return None;
        }
        let p = self.slot.take().expect("slot is present");
        let mut nalu = Vec::new();
        for frag in p.fragments.into_iter() {
            match frag {
                Some(f) => nalu.extend_from_slice(&f),
                None => {
                    // Cannot happen once `have == count`, but a dropped frame is
                    // better than a corrupt one.
                    self.orphan_fragments += 1;
                    return None;
                }
            }
        }
        self.completed += 1;
        Some(VideoFrame {
            frame_id: p.frame_id,
            capture_ts_us: p.capture_ts_us,
            meta: p.meta,
            nalu,
            keyframe: p.flags & F_KEYFRAME != 0,
            scene_cut: p.flags & F_SCENE_CUT != 0,
            seq: 0,
        })
    }

    pub fn pending(&self) -> usize {
        self.slot.as_ref().map(|p| p.count as usize).unwrap_or(0)
    }
}

/// `VIDEO_NALU` body layout:
///
/// ```text
/// off  size  field
///  0    4    width       u32
///  4    4    height      u32
///  8    1    codec       u8
///  9    1    tier        u8
/// 10    8    frameId     u64
/// 18    2    index       u16
/// 20    2    count       u16
/// 22    1    flags       u8   (keyframe / scene_cut)
/// 23    N    payload          (fragment bytes of the Annex-B frame)
/// ```
pub const FRAGMENT_HEADER_LEN: usize = 23;

/// Split an Annex-B frame into fragments that each fit in one datagram, and
/// describe each as a `VIDEO_NALU` body.
///
/// Splitting is unavoidable: a keyframe at native resolution exceeds one
/// datagram. `count` is carried explicitly so the receiver can tell "not yet
/// complete" from "complete but corrupt", and the reassembler keeps exactly one
/// in-progress frame so this cannot reintroduce buffering.
pub fn fragment_frame(
    frame_id: u64,
    meta: VideoMeta,
    flags: u8,
    nalu: &[u8],
) -> Vec<Vec<u8>> {
    let payload_cap = MAX_DATAGRAM - HEADER_LEN - FRAGMENT_HEADER_LEN;
    let chunks: Vec<&[u8]> = if nalu.is_empty() {
        vec![&[]]
    } else {
        nalu.chunks(payload_cap).collect()
    };
    let count = chunks.len().min(u16::MAX as usize) as u16;
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut body = Vec::with_capacity(FRAGMENT_HEADER_LEN + c.len());
            body.extend_from_slice(&meta.width.to_be_bytes());
            body.extend_from_slice(&meta.height.to_be_bytes());
            body.push(meta.codec);
            body.push(meta.tier);
            body.extend_from_slice(&frame_id.to_be_bytes());
            body.extend_from_slice(&(i as u16).to_be_bytes());
            body.extend_from_slice(&count.to_be_bytes());
            body.push(flags);
            body.extend_from_slice(c);
            body
        })
        .collect()
}

pub struct VideoFragment<'a> {
    pub meta: VideoMeta,
    pub frame_id: u64,
    pub index: u16,
    pub count: u16,
    pub flags: u8,
    pub payload: &'a [u8],
}

pub fn parse_video_fragment(body: &[u8]) -> Option<VideoFragment<'_>> {
    if body.len() < FRAGMENT_HEADER_LEN {
        return None;
    }
    let count = u16::from_be_bytes([body[20], body[21]]);
    if count == 0 {
        return None;
    }
    let index = u16::from_be_bytes([body[18], body[19]]);
    if index >= count {
        return None;
    }
    Some(VideoFragment {
        meta: VideoMeta {
            width: u32::from_be_bytes([body[0], body[1], body[2], body[3]]),
            height: u32::from_be_bytes([body[4], body[5], body[6], body[7]]),
            codec: body[8],
            tier: body[9],
        },
        frame_id: u64::from_be_bytes([
            body[10], body[11], body[12], body[13], body[14], body[15], body[16], body[17],
        ]),
        index,
        count,
        flags: body[22],
        payload: &body[FRAGMENT_HEADER_LEN..],
    })
}

/// A simple sliding-window rate meter (events per second) used for fps caps and
/// the sustained-window triggers.
#[derive(Debug)]
pub struct RateMeter {
    window: std::collections::VecDeque<u64>,
    span_us: u64,
}

impl RateMeter {
    pub fn new(span_us: u64) -> Self {
        Self {
            window: std::collections::VecDeque::new(),
            span_us,
        }
    }

    pub fn mark(&mut self, ts_us: u64) {
        self.window.push_back(ts_us);
        let cutoff = ts_us.saturating_sub(self.span_us);
        while let Some(front) = self.window.front() {
            if *front < cutoff {
                self.window.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn rate(&self, ts_us: u64) -> f64 {
        if self.span_us == 0 {
            return 0.0;
        }
        let cutoff = ts_us.saturating_sub(self.span_us);
        let n = self.window.iter().filter(|t| **t >= cutoff).count();
        n as f64 * 1_000_000.0 / self.span_us as f64
    }
}

pub fn loopback_addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrip() {
        let mut buf = Vec::new();
        Header {
            msg_type: T_VIDEO_NALU,
            flags: F_KEYFRAME | F_SCENE_CUT,
            seq: 42,
            ts_us: 1_700_000_000_000_000,
        }
        .encode(b"abc", &mut buf);
        let (h, body) = parse(&buf).expect("parses");
        assert_eq!(h.msg_type, T_VIDEO_NALU);
        assert_eq!(h.flags, F_KEYFRAME | F_SCENE_CUT);
        assert_eq!(h.seq, 42);
        assert_eq!(h.ts_us, 1_700_000_000_000_000);
        assert_eq!(body, b"abc");
    }

    #[test]
    fn malformed_is_rejected_not_panicking() {
        assert!(parse(&[]).is_none());
        assert!(parse(&[0u8; 17]).is_none());
        let mut bad = build(T_STATS, 0, 1, 1, b"{}");
        bad[0] = 0;
        assert!(parse(&bad).is_none());
        let mut bad_ver = build(T_STATS, 0, 1, 1, b"{}");
        bad_ver[3] = 9;
        assert!(parse(&bad_ver).is_none());
        let mut bad_type = build(T_STATS, 0, 1, 1, b"{}");
        bad_type[4] = 0xEE;
        assert!(parse(&bad_type).is_none());
    }

    #[test]
    fn video_meta_roundtrip() {
        let mut b = Vec::new();
        b.extend_from_slice(&1280u32.to_be_bytes());
        b.extend_from_slice(&720u32.to_be_bytes());
        b.push(CODEC_H264);
        b.push(2);
        b.extend_from_slice(&[0, 0]);
        b.extend_from_slice(&[0, 0, 0, 1]);
        b.extend_from_slice(b"nal");
        let (meta, payload) = parse_video(&b).unwrap();
        assert_eq!(meta.width, 1280);
        assert_eq!(meta.height, 720);
        assert_eq!(meta.codec, CODEC_H264);
        assert_eq!(meta.tier, 2);
        assert!(payload.starts_with(&[0, 0, 0, 1]));
    }

    #[test]
    fn input_event_and_ack_roundtrip() {
        let ev = InputEvent {
            kind: "ld".to_string(),
            event_id: 7,
            input_ts_us: 123,
            event: serde_json::json!({"nx": 0.25, "ny": 0.75}),
        };
        let body = build_input_event(&ev);
        assert_eq!(kind_from_tag(body[0]), "ld");
        assert_eq!(u64::from_be_bytes(body[1..9].try_into().unwrap()), 7);
        assert_eq!(u64::from_be_bytes(body[9..17].try_into().unwrap()), 123);

        let mut ack = Vec::new();
        ack.extend_from_slice(&7u64.to_be_bytes());
        ack.extend_from_slice(&123u64.to_be_bytes());
        ack.extend_from_slice(&456u64.to_be_bytes());
        let parsed = parse_input_ack(&ack).unwrap();
        assert_eq!(parsed.event_id, 7);
        assert_eq!(parsed.input_ts_us, 123);
        assert_eq!(parsed.inject_ts_us, 456);
    }

    #[test]
    fn every_kind_tag_roundtrips() {
        for kind in ["m", "ld", "lu", "rd", "ru", "w", "k", "kd", "ku"] {
            let ev = InputEvent {
                kind: kind.to_string(),
                event_id: 1,
                input_ts_us: 1,
                event: serde_json::json!({}),
            };
            let body = build_input_event(&ev);
            assert_eq!(kind_from_tag(body[0]), kind, "kind {} roundtrip", kind);
        }
    }

    #[test]
    fn cursor_pos_roundtrip() {
        let mut body = Vec::new();
        for v in [100i32, -5, 1920, 1080] {
            body.extend_from_slice(&v.to_be_bytes());
        }
        let p = parse_cursor_pos(&body).unwrap();
        assert_eq!(p.x, 100);
        assert_eq!(p.y, -5);
        assert_eq!(p.screen_w, 1920);
        assert_eq!(p.screen_h, 1080);
    }

    #[test]
    fn cursor_pos_rejects_short_body() {
        assert!(parse_cursor_pos(&[0u8; 15]).is_none());
    }

    #[test]
    fn ring_percentile_is_nearest_rank() {
        let mut r = Ring::new(2048);
        for i in 1..=100 {
            r.add(i as f64);
        }
        assert_eq!(r.len(), 100);
        assert_eq!(r.percentile(0.95), 95.0);
        assert_eq!(r.percentile(0.5), 50.0);
        assert_eq!(r.percentile(1.0), 100.0);
    }

    #[test]
    fn ring_wraps_and_keeps_capacity() {
        let mut r = Ring::new(4);
        for i in 1..=10 {
            r.add(i as f64);
        }
        assert_eq!(r.len(), 4);
        assert_eq!(r.percentile(1.0), 10.0);
        assert_eq!(r.percentile(0.0), 7.0);
    }

    #[test]
    fn gap_tracker_reports_missing_sequences() {
        let g = GapTracker::default();
        assert!(g.observe(1).is_empty());
        assert!(g.observe(2).is_empty());
        assert_eq!(g.observe(5), vec![3, 4]);
        assert!(g.mark_recovered(3));
        assert!(!g.mark_recovered(3));
    }

    #[test]
    fn gap_tracker_ignores_wrap_and_reorder() {
        let g = GapTracker::default();
        g.observe(10);
        // Reordered/duplicate datagrams must not synthesize a huge gap.
        assert!(g.observe(9).is_empty());
        assert!(g.observe(10).is_empty());
        assert!(g.observe(1).is_empty());
    }

    #[test]
    fn rate_meter_measures_per_second() {
        let mut m = RateMeter::new(1_000_000);
        for i in 0..10 {
            m.mark(i * 100_000);
        }
        assert!((m.rate(1_000_000) - 10.0).abs() < 0.001);
        assert!((m.rate(10_000_000) - 0.0).abs() < 0.001);
    }

    #[test]
    fn seq_counter_never_returns_zero() {
        // 0 is reserved for "unset" in the gap heuristics, so the counter starts
        // at 1 and wraps back to 1 rather than to 0.
        let c = SeqCounter::default();
        assert_eq!(c.next(), 1);
        assert_eq!(c.next(), 2);
        assert_eq!(c.next(), 3);
    }

    fn meta() -> VideoMeta {
        VideoMeta {
            width: 1920,
            height: 1080,
            codec: CODEC_H264,
            tier: 2,
        }
    }

    #[test]
    fn fragment_and_reassemble_roundtrip_for_a_single_fragment_frame() {
        let nalu = vec![0u8, 0, 0, 1, 0x65, 1, 2, 3];
        let frags = fragment_frame(9, meta(), F_KEYFRAME, &nalu);
        assert_eq!(frags.len(), 1);
        let f = parse_video_fragment(&frags[0]).unwrap();
        assert_eq!(f.frame_id, 9);
        assert_eq!(f.index, 0);
        assert_eq!(f.count, 1);
        assert_eq!(f.flags, F_KEYFRAME);
        assert_eq!(f.meta.width, 1920);
        assert_eq!(f.meta.tier, 2);

        let mut a = FrameAssembler::default();
        let out = a
            .push(f.frame_id, f.index, f.count, f.meta, f.flags, 1234, f.payload)
            .expect("single fragment completes");
        assert_eq!(out.nalu, nalu);
        assert_eq!(out.capture_ts_us, 1234);
        assert!(out.keyframe);
    }

    #[test]
    fn every_fragment_fits_in_one_datagram() {
        // A native-resolution keyframe is far larger than one datagram, so this
        // is the case that actually matters.
        let nalu = vec![7u8; 200_000];
        let frags = fragment_frame(1, meta(), F_KEYFRAME, &nalu);
        assert!(frags.len() > 1);
        for (i, body) in frags.iter().enumerate() {
            let dgram = build(T_VIDEO_NALU, F_KEYFRAME, i as u32 + 1, 5, body);
            assert!(
                dgram.len() <= MAX_DATAGRAM,
                "fragment {} produced {} bytes, above the {} cap",
                i,
                dgram.len(),
                MAX_DATAGRAM
            );
        }
    }

    #[test]
    fn reassembly_rebuilds_a_multi_fragment_frame_exactly() {
        let nalu: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let frags = fragment_frame(42, meta(), F_KEYFRAME, &nalu);
        assert!(frags.len() >= 2);

        let mut a = FrameAssembler::default();
        let mut out = None;
        for (i, body) in frags.iter().enumerate() {
            let f = parse_video_fragment(body).unwrap();
            assert_eq!(f.frame_id, 42);
            assert_eq!(f.index, i as u16);
            out = a.push(f.frame_id, f.index, f.count, f.meta, f.flags, 777, f.payload);
            if i + 1 < frags.len() {
                assert!(out.is_none(), "completed early at fragment {}", i);
            }
        }
        let out = out.expect("all fragments completes the frame");
        assert_eq!(out.nalu.len(), nalu.len());
        assert_eq!(out.nalu, nalu, "reassembled bytes must match exactly");
        assert_eq!(a.completed, 1);
    }

    #[test]
    fn reassembly_handles_out_of_order_fragments() {
        let nalu: Vec<u8> = (0..50_000u32).map(|i| (i % 97) as u8).collect();
        let frags = fragment_frame(1, meta(), 0, &nalu);
        let mut order: Vec<usize> = (0..frags.len()).collect();
        order.reverse();

        let mut a = FrameAssembler::default();
        let mut out = None;
        for i in order {
            let f = parse_video_fragment(&frags[i]).unwrap();
            if let Some(done) =
                a.push(f.frame_id, f.index, f.count, f.meta, f.flags, 5, f.payload)
            {
                out = Some(done);
            }
        }
        assert_eq!(out.unwrap().nalu, nalu);
    }

    #[test]
    fn a_newer_frame_supersedes_an_incomplete_one_instead_of_buffering() {
        let mut a = FrameAssembler::default();
        // Start a two-fragment frame, deliver only the first fragment.
        a.push(1, 0, 2, meta(), 0, 10, b"aaa");
        assert!(a.slot.is_some());
        // A newer frame begins: the partial older frame is discarded, not queued.
        let out = a.push(2, 0, 1, meta(), 0, 20, b"bbb");
        assert_eq!(out.unwrap().frame_id, 2);
        assert_eq!(a.superseded, 1);
        assert_eq!(a.pending(), 0);
        // Only one in-progress frame is ever retained.
        assert!(a.slot.is_none());
    }

    #[test]
    fn duplicate_fragments_do_not_inflate_the_progress() {
        let mut a = FrameAssembler::default();
        assert!(a.push(1, 0, 2, meta(), 0, 1, b"x").is_none());
        assert!(a.push(1, 0, 2, meta(), 0, 1, b"x").is_none());
        let out = a.push(1, 1, 2, meta(), 0, 1, b"y");
        assert_eq!(out.unwrap().nalu, b"xy");
    }

    #[test]
    fn malformed_fragment_headers_are_rejected() {
        assert!(parse_video_fragment(&[0u8; 5]).is_none());
        let mut body = vec![0u8; FRAGMENT_HEADER_LEN];
        body[20] = 0;
        body[21] = 0; // count = 0
        assert!(parse_video_fragment(&body).is_none());
        let mut body = vec![0u8; FRAGMENT_HEADER_LEN];
        body[20] = 0;
        body[21] = 1; // count = 1
        body[18] = 0;
        body[19] = 1; // index = 1, out of range
        assert!(parse_video_fragment(&body).is_none());
    }

    #[test]
    fn empty_payload_still_produces_one_fragment() {
        let frags = fragment_frame(1, meta(), 0, &[]);
        assert_eq!(frags.len(), 1);
        let f = parse_video_fragment(&frags[0]).unwrap();
        assert!(f.payload.is_empty());
    }
}