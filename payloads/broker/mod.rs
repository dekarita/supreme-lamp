//! The SYSTEM-session transport broker (plan Phase 2).
//!
//! Owns the localhost UDP peer to the in-session agent, the WebRTC peer
//! connection, congestion response, loss recovery, and the stats surface. It
//! runs in session 0 alongside `ghrdp-dash.exe` so it inherits the existing
//! build/launch/port/cleanup paths (section 7.2).
//!
//! Transport is behind the `Transport` trait (section 11) so the same controller,
//! queue, ladder, fallback machine and instrumentation are exercised by both the
//! real WebRTC implementation and the harness's loopback implementation.

pub mod ipc;
pub mod policy;
pub mod queue;
pub mod stats;
pub mod transport;
#[cfg(feature = "webrtc")]
pub mod webrtc_transport;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;

use crate::broker::ipc::{
    build, build_input_event, now_us, AgentStats, FrameAssembler, GapTracker, Header, InputEvent,
    KeyframeReq, LadderMsg, SeqCounter, MAX_DATAGRAM, T_CURSOR_POS, T_CURSOR_SHAPE, T_CURSOR_VIS,
    T_HELLO, T_HELLO_ACK, T_INPUT_ACK, T_INPUT_EVENT, T_KEYFRAME_REQ, T_LADDER, T_STATS,
    T_VIDEO_NALU,
};
use crate::broker::policy::{
    effective_fps_cap, ClientPath, PathType, PolicyController, PolicyEvent,
};
use crate::broker::queue::{
    fec_recover, FecGroup, FecParity, KeyframeLimiter, KeyframeReason, KeyframeRequester, SendQueue,
};
use crate::broker::stats::Stats;
use crate::broker::transport::Transport;

pub const DEFAULT_AGENT_RX_PORT: u16 = 7411;
pub const DEFAULT_BROKER_RX_PORT: u16 = 7412;

/// Published to the client so a reviewer can reconstruct a timeline without
/// guessing, and mirrored to disk for post-run analysis.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrokerStats {
    pub started_us: u64,
    pub frames_in: u64,
    pub frames_sent: u64,
    pub frames_dropped_unknown_peer: u64,
    pub input_events_out: u64,
    pub input_acks_in: u64,
    pub cursor_updates: u64,
    pub agent_hello: bool,
    pub agent_rx_addr: String,
    pub broker_rx_addr: String,
    pub ice_state: String,
    pub ice_pair_type: String,
    pub jitter_ms: f64,
    pub transport: String,
    pub ladder_sent: u64,
    pub keyframe_reqs_sent: u64,
    pub agent_rx_port: u16,
    pub broker_rx_port: u16,
}

impl BrokerStats {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "framesIn": self.frames_in,
            "framesSent": self.frames_sent,
            "framesDroppedUnknownPeer": self.frames_dropped_unknown_peer,
            "inputEventsOut": self.input_events_out,
            "inputAcksIn": self.input_acks_in,
            "cursorUpdates": self.cursor_updates,
            "agentHello": self.agent_hello,
            "iceState": self.ice_state,
            "icePairType": self.ice_pair_type,
            "jitterMs": self.jitter_ms,
            "transport": self.transport,
            "ladderSent": self.ladder_sent,
            "keyframeReqsSent": self.keyframe_reqs_sent,
        })
    }
}

/// The broker's single state object. All hot-path mutation is behind one mutex
/// because the critical sections are microseconds of bookkeeping; the depth-1
/// slot is what keeps them short.
pub struct Broker {
    pub stats: Arc<Mutex<Stats>>,
    pub policy: Arc<Mutex<PolicyController>>,
    pub queue: Arc<Mutex<SendQueue>>,
    pub keyframes: Arc<Mutex<KeyframeLimiter>>,
    pub keyframe_reqs: Arc<Mutex<KeyframeRequester>>,
    pub broker_stats: Arc<Mutex<BrokerStats>>,
    pub transport: Arc<dyn Transport>,
    pub encoder_available: AtomicBool,
    pub broker_ready: AtomicBool,
    pub seq: SeqCounter,
    gaps: GapTracker,
    assembler: Mutex<FrameAssembler>,
    fec_group: Mutex<FecGroup>,
    fec_pending: Mutex<HashMap<u64, FecParity>>,
    peer: Mutex<Option<SocketAddr>>,
    frame_counter: AtomicU64,
    /// Test seam: when set, the broker records every IPC message and
    /// instrumentation sample to this path as NDJSON.
    loopback_log: Mutex<Option<std::path::PathBuf>>,
}

impl Broker {
    pub fn new(transport: Arc<dyn Transport>) -> Arc<Self> {
        Arc::new(Self {
            stats: Arc::new(Mutex::new(Stats::default())),
            policy: Arc::new(Mutex::new(PolicyController::new(ClientPath::Auto))),
            queue: Arc::new(Mutex::new(SendQueue::default())),
            keyframes: Arc::new(Mutex::new(KeyframeLimiter::default())),
            keyframe_reqs: Arc::new(Mutex::new(KeyframeRequester::default())),
            broker_stats: Arc::new(Mutex::new(BrokerStats::default())),
            transport,
            encoder_available: AtomicBool::new(true),
            broker_ready: AtomicBool::new(false),
            seq: SeqCounter::default(),
            gaps: GapTracker::default(),
            assembler: Mutex::new(FrameAssembler::default()),
            fec_group: Mutex::new(FecGroup::new(0)),
            fec_pending: Mutex::new(HashMap::new()),
            peer: Mutex::new(None),
            frame_counter: AtomicU64::new(0),
            loopback_log: Mutex::new(None),
        })
    }

    pub fn set_loopback_log(&self, path: Option<std::path::PathBuf>) {
        *self.loopback_log.lock().unwrap_or_else(|e| e.into_inner()) = path;
    }

    fn log_ipc(&self, direction: &str, msg_type: u8, seq: u32, ts_us: u64, extra: serde_json::Value) {
        let path = self
            .loopback_log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(p) = path {
            let line = serde_json::json!({
                "kind": "ipc",
                "dir": direction,
                "msgType": msg_type,
                "seq": seq,
                "tsUs": ts_us,
                "extra": extra,
                "wallUs": now_us(),
            });
            append_ndjson(&p, &line);
        }
    }

    fn log_sample(&self, tag: &str, sample: serde_json::Value) {
        let path = self
            .loopback_log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(p) = path {
            let line = serde_json::json!({
                "kind": "sample",
                "tag": tag,
                "sample": sample,
                "wallUs": now_us(),
            });
            append_ndjson(&p, &line);
        }
    }

    pub fn peer_addr(&self) -> Option<SocketAddr> {
        *self.peer.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_encoder_available(&self, available: bool) {
        self.encoder_available.store(available, Ordering::Relaxed);
        // The gate is evaluated through the same policy tick as everything else,
        // so /webdesk-probe, the client, and the stats surface cannot disagree
        // about whether the pipeline is up.
        self.tick_policy();
    }

    pub fn set_override(&self, path: ClientPath) -> ClientPath {
        let mut p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
        p.set_override(path, now_us());
        p.effective_path()
    }

    pub fn set_path_type(&self, path: PathType) {
        let mut p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
        p.path = path;
    }

    pub fn tick_policy(&self) -> Vec<PolicyEvent> {
        let encoder = self.encoder_available.load(Ordering::Relaxed);
        let ready = self.broker_ready.load(Ordering::Relaxed);
        let signals = {
            let s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
            s.signals(encoder, ready)
        };
        let events = {
            let mut p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
            p.tick(&signals)
        };

        // A fallback or a ladder change must reach the agent: it is what actually
        // lowers quality/resolution/fps. Lock order is stats -> policy -> queue ->
        // keyframes -> broker_stats everywhere, so each guard is released before
        // the next helper acquires it.
        if !events.is_empty() {
            let ladder_changed = events.iter().any(|e| {
                matches!(
                    e,
                    PolicyEvent::LadderDown { .. }
                        | PolicyEvent::LadderUp { .. }
                        | PolicyEvent::Fallback { .. }
                        | PolicyEvent::UpgradeConfirmed { .. }
                )
            });
            {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.events = events.clone();
            }
            for e in &events {
                match e {
                    PolicyEvent::Fallback { reason, .. } => {
                        log_line(&format!("fallback -> mjpeg: {}", reason))
                    }
                    PolicyEvent::UpgradeConfirmed { healthy_windows } => log_line(&format!(
                        "upgraded -> webrtc after {} healthy windows",
                        healthy_windows
                    )),
                    _ => {}
                }
            }
            if ladder_changed {
                self.push_ladder();
            }
        }
        let snapshot = self.snapshot();
        self.log_sample("policy", snapshot);
        events
    }

    /// Send the current rung to the in-session agent. Best-effort: a dropped
    /// LADDER is superseded by the next one, so there is no retry.
    pub fn push_ladder(&self) {
        let (tier, path, cap) = {
            let p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
            (
                p.tier,
                p.path,
                effective_fps_cap(p.tier, p.path),
            )
        };
        let r = crate::broker::policy::rung(tier);
        let rtt_ms = {
            let s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
            s.agent.input_ack_p95_ms
        };
        let msg = LadderMsg {
            tier,
            quality: r.quality,
            scale: r.scale,
            fps_cap: cap,
            path: path.as_str().to_string(),
            rtt_ms,
        };
        let body = serde_json::to_vec(&msg).unwrap_or_default();
        self.send_to_agent(T_LADDER, 0, &body);
        {
            let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
            bs.ladder_sent += 1;
        }
    }

    fn send_to_agent(&self, msg_type: u8, flags: u8, body: &[u8]) {
        let peer = match self.peer_addr() {
            Some(p) => p,
            None => return,
        };
        let seq = self.seq.next();
        let ts = now_us();
        let dgram = build(msg_type, flags, seq, ts, body);
        let dgram = if dgram.len() > MAX_DATAGRAM {
            // Truncation, never fragmentation: a split datagram that arrives
            // half-complete is worse than a dropped one.
            dgram[..MAX_DATAGRAM].to_vec()
        } else {
            dgram
        };
        self.transport.send_to_agent(&dgram, peer);
        self.log_ipc("out", msg_type, seq, ts, serde_json::json!({ "bytes": dgram.len() }));
    }

    /// Enqueue a client input event for injection. Returns the event id used.
    pub fn push_input(&self, kind: &str, event: serde_json::Value, input_ts_us: Option<u64>) -> u64 {
        let event_id = self.seq.next() as u64;
        let ts = input_ts_us.unwrap_or_else(now_us);
        let ev = InputEvent {
            kind: kind.to_string(),
            event_id,
            input_ts_us: ts,
            event,
        };
        let body = build_input_event(&ev);
        {
            let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
            s.note_input_out(event_id, ts);
        }
        {
            let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
            bs.input_events_out += 1;
        }
        self.send_to_agent(T_INPUT_EVENT, 0, &body);
        event_id
    }

    /// Handle one inbound agent datagram. Returns true when it was consumed.
    pub fn handle_datagram(&self, data: &[u8]) -> bool {
        let (h, body) = match ipc::parse(data) {
            Some(v) => v,
            None => {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.ipc_malformed += 1;
                return false;
            }
        };
        self.log_ipc("in", h.msg_type, h.seq, h.ts_us, serde_json::json!({ "bytes": data.len() }));

        match h.msg_type {
            T_HELLO => {
                {
                    let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
                    bs.agent_hello = true;
                }
                // A HELLO proves the loopback is alive but says nothing about the
                // media path, so `broker_ready` is left alone: the first `STATS`
                // report is what marks the pipeline actually up (section 10).
                let ack = serde_json::json!({
                    "broker": "1.0",
                    "pid": std::process::id(),
                })
                .to_string();
                self.send_to_agent(T_HELLO_ACK, 0, ack.as_bytes());
                self.push_ladder();
            }
            T_VIDEO_NALU => self.on_video(&h, body),
            T_INPUT_ACK => {
                if let Some(ack) = ipc::parse_input_ack(body) {
                    let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    s.note_input_ack(ack.event_id, ack.input_ts_us, ack.inject_ts_us);
                    let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
                    bs.input_acks_in += 1;
                }
            }
            T_CURSOR_POS => {
                if let Some(p) = ipc::parse_cursor_pos(body) {
                    let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    s.cursor = Some(p);
                    let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
                    bs.cursor_updates += 1;
                    self.transport.send_cursor_pos(p);
                }
            }
            T_CURSOR_SHAPE => {
                self.transport.send_cursor_shape(body);
            }
            T_CURSOR_VIS => {
                if let Some(v) = body.first() {
                    let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    s.cursor_visible = *v != 0;
                }
                self.transport.send_cursor_vis(body.first().copied().unwrap_or(1) != 0);
            }
            T_STATS => {
                if let Ok(agent) = serde_json::from_slice::<AgentStats>(body) {
                    {
                        let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                        s.agent = agent;
                        s.agent_last_seen_us = now_us();
                    }
                    // An agent reporting in is what marks the pipeline ready; a
                    // HELLO alone does not (section 10).
                    let first = !self.broker_ready.swap(true, Ordering::Relaxed);
                    if first {
                        log_line("in-session agent is reporting: pipeline ready");
                    }
                }
            }
            _ => return false,
        }
        true
    }

    fn on_video(&self, h: &Header, body: &[u8]) {
        let frag = match ipc::parse_video_fragment(body) {
            Some(v) => v,
            None => {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.ipc_malformed += 1;
                return;
            }
        };

        // Loss recovery: a gap in the agent's sequence raises a NACK. Gaps are
        // only meaningful between fragments of the same frame (the assembler
        // discards an incomplete frame when a newer one starts), so a gap here
        // means the frame cannot complete and a keyframe is the honest response.
        let gaps = self.gaps.observe(h.seq);
        if !gaps.is_empty() {
            {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.nack_sent += gaps.len() as u64;
                s.note_loss_sample(gaps.len());
            }
            self.request_keyframe(KeyframeReason::Loss);
        }

        let frame = {
            let mut a = self.assembler.lock().unwrap_or_else(|e| e.into_inner());
            a.push(
                frag.frame_id,
                frag.index,
                frag.count,
                frag.meta,
                frag.flags,
                h.ts_us,
                frag.payload,
            )
        };
        let frame = match frame {
            Some(f) => f,
            // Still assembling, or superseded: nothing to send yet. This is not a
            // drop and must not be counted as one.
            None => return,
        };

        {
            let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
            bs.frames_in += 1;
        }

        // Depth-1 slot: a newer frame replaces an unsent predecessor.
        {
            let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            q.push(frame.clone());
        }

        // Scene cut forces a keyframe (rate-limited), independent of loss.
        if frame.scene_cut {
            self.request_keyframe(KeyframeReason::SceneCut);
        }

        // The send itself is a single non-blocking transport call. A refusal puts
        // the newest frame back in the slot, where the next arrival supersedes it,
        // so the receive path never waits on the wire and never accumulates.
        self.flush_send_queue(true);
        self.accumulate_fec(h.seq, &frame.nalu);
    }

    /// Take the newest frame and hand it to the transport.
    ///
    /// `keep_on_failure` decides what a transport refusal means:
    ///
    /// * `true` (the receive path) — put the frame back in the slot. A newer
    ///   frame will supersede it, so nothing older than the newest frame can ever
    ///   accumulate; the queue stays depth-1.
    /// * `false` (the send tick) — drop it. Keeping it across ticks would let the
    ///   slot hold a frame indefinitely, which is the latency bug the depth-1
    ///   design exists to prevent.
    pub fn flush_send_queue(&self, keep_on_failure: bool) -> bool {
        let (frame, depth, replaced) = {
            let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            let f = q.take_latest();
            (f, q.depth(), q.replaced())
        };
        let frame = match frame {
            Some(f) => f,
            None => return false,
        };
        let now = now_us();
        let (path, tier) = {
            let p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
            (p.path, p.tier)
        };
        if !self.transport.send_frame(&frame, tier) {
            {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.nalu_dropped += 1;
            }
            if keep_on_failure {
                let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
                q.push(frame);
            }
            return false;
        }
        {
            let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
            s.note_frame_sent(frame.capture_ts_us, path, now);
            s.nalu_sent += 1;
        }
        {
            let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
            bs.frames_sent += 1;
        }
        self.log_sample(
            "send",
            serde_json::json!({
                "frameId": frame.frame_id,
                "captureTsUs": frame.capture_ts_us,
                "sentTsUs": now,
                "frameAgeMs": (now.saturating_sub(frame.capture_ts_us)) as f64 / 1000.0,
                "queueDepth": depth,
                "queueReplaced": replaced,
                "keyframe": frame.keyframe,
                "tier": tier,
                "bytes": frame.nalu.len(),
            }),
        );
        true
    }

    fn accumulate_fec(&self, seq: u32, payload: &[u8]) {
        let mut parity_opt = None;
        {
            let mut g = self.fec_group.lock().unwrap_or_else(|e| e.into_inner());
            g.push(seq, payload);
            if g.is_full() {
                parity_opt = g.parity();
                *g = FecGroup::new(g.group_id + 1);
            }
        }
        if let Some(parity) = parity_opt {
            {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.fec_parity_sent += 1;
            }
            self.fec_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(parity.group_id, parity.clone());
            self.transport.send_fec_parity(&parity);
        }
    }

    /// Try to repair a single missing member of a group from its parity. Returns
    /// true when the member was reconstructed, which avoids a keyframe.
    pub fn try_fec_recover(
        &self,
        parity: &FecParity,
        present: &[Option<Vec<u8>>],
        missing_index: usize,
    ) -> bool {
        match fec_recover(parity, present, missing_index) {
            Some(_) => {
                let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                s.nack_recovered += 1;
                true
            }
            None => false,
        }
    }

    pub fn request_keyframe(&self, reason: KeyframeReason) {
        {
            let mut r = self.keyframe_reqs.lock().unwrap_or_else(|e| e.into_inner());
            r.request(reason);
        }
        let outstanding = {
            let mut r = self.keyframe_reqs.lock().unwrap_or_else(|e| e.into_inner());
            r.take()
        };
        let reason = match outstanding {
            Some(r) => r,
            None => return,
        };
        // Rate limit on the broker side too, so the limiter holds even if the
        // agent is restarted or misbehaving.
        {
            let mut k = self.keyframes.lock().unwrap_or_else(|e| e.into_inner());
            if !k.should_emit(reason, now_us()) {
                return;
            }
        }
        let req = KeyframeReq {
            reason: reason.as_str().to_string(),
            frame_id: self.frame_counter.load(Ordering::Relaxed),
        };
        let body = serde_json::to_vec(&req).unwrap_or_default();
        self.send_to_agent(T_KEYFRAME_REQ, 0, &body);
        {
            let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
            bs.keyframe_reqs_sent += 1;
        }
    }

    pub fn note_render(&self, frame_to_render_ms: f64, ok: bool) {
        let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        s.note_render(frame_to_render_ms, ok);
    }

    pub fn note_ice_state(&self, failed: bool) {
        let mut s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        s.note_ice_state(failed, now_us());
        let mut bs = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
        bs.ice_state = if failed { "failed".into() } else { "connected".into() };
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let s = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        let p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
        let q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let k = self.keyframes.lock().unwrap_or_else(|e| e.into_inner());
        let b = self.broker_stats.lock().unwrap_or_else(|e| e.into_inner());
        s.snapshot(&p, &q, &k, &b)
    }
}

fn append_ndjson(path: &std::path::Path, value: &serde_json::Value) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{}", value);
    }
}

fn log_line(msg: &str) {
    crate::log_line(&format!("[broker] {}", msg));
}

/// Bind the two loopback sockets and return them. Both are bound 127.0.0.1
/// only; the broker must never expose the IPC surface on the tailnet.
pub async fn bind_ipc(agent_rx_port: u16, broker_rx_port: u16) -> std::io::Result<(UdpSocket, UdpSocket)> {
    let agent_rx = UdpSocket::bind(ipc::loopback_addr(agent_rx_port)).await?;
    let broker_rx = UdpSocket::bind(ipc::loopback_addr(broker_rx_port)).await?;
    Ok((agent_rx, broker_rx))
}

/// The agent-facing receive loop. Reads datagrams and hands them to the broker.
/// There is no read queue: a datagram that arrives while the previous is being
/// processed replaces nothing and waits in the kernel buffer, which is exactly
/// the depth-1 behaviour we want from the socket too.
pub async fn run_agent_rx(broker: Arc<Broker>, socket: Arc<UdpSocket>) {
    let mut buf = vec![0u8; MAX_DATAGRAM * 2];
    loop {
        match socket.recv_from(&mut buf).await {
            Ok((n, from)) => {
                {
                    let mut p = broker.peer.lock().unwrap_or_else(|e| e.into_inner());
                    if p.is_none() {
                        *p = Some(from);
                        log_line(&format!("[broker] in-session agent discovered at {}", from));
                        broker.broker_ready.store(true, Ordering::Relaxed);
                    }
                }
                let data = buf[..n].to_vec();
                broker.handle_datagram(&data);
            }
            Err(err) => {
                log_line(&format!("[broker] agent socket recv error: {}", err));
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

/// The send tick. Separate from the receive path on purpose: if the transport
/// refuses a frame (budget spent, wire down), the retry happens here and the
/// frame is dropped rather than held, so the slot can never turn into a backlog.
pub async fn run_send_tick(broker: Arc<Broker>, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        broker.flush_send_queue(false);
    }
}

/// The policy tick loop. It drives the ladder and the fallback machine on a
/// fixed cadence independent of frame arrival, so a stalled video path still
/// escalates.
pub async fn run_policy_tick(broker: Arc<Broker>, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        broker.tick_policy();
    }
}

/// The stats snapshot loop: publishes the surface and mirrors it to disk so
/// `/diag`-style inspection and post-run analysis both work.
pub async fn run_stats_tick(broker: Arc<Broker>, period: Duration, snapshot_path: std::path::PathBuf) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let snap = broker.snapshot();
        // Full rewrite, never read-modify-write: that pattern races on Windows.
        let _ = std::fs::write(&snapshot_path, snap.to_string());
    }
}

/// Loss ratio sample fed by the gap tracker. Kept as a helper so the ratio and
/// the NACK counter cannot drift apart.
impl Stats {
    pub fn note_loss_sample(&mut self, gaps: usize) {
        let ratio = (gaps as f64 / (gaps as f64 + 1.0)).min(1.0);
        self.loss.add(ratio);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::transport::LoopbackTransport;

    fn meta(w: u32, h: u32, tier: u8) -> ipc::VideoMeta {
        ipc::VideoMeta {
            width: w,
            height: h,
            codec: ipc::CODEC_H264,
            tier,
        }
    }

    /// One complete frame as a single datagram (small payloads only).
    fn frame_dgram(w: u32, h: u32, tier: u8, payload: &[u8], seq: u32, ts_us: u64) -> Vec<u8> {
        let bodies = ipc::fragment_frame(seq as u64, meta(w, h, tier), 0, payload);
        assert_eq!(bodies.len(), 1, "test payload must fit in one datagram");
        build(T_VIDEO_NALU, 0, seq, ts_us, &bodies[0])
    }

    fn datagram(msg_type: u8, flags: u8, seq: u32, ts_us: u64, body: &[u8]) -> Vec<u8> {
        build(msg_type, flags, seq, ts_us, body)
    }

    /// Pretend the in-session agent has already been discovered, so control
    /// datagrams are actually handed to the transport.
    fn with_peer(b: &Broker) {
        let mut p = b.peer.lock().unwrap();
        *p = Some(crate::broker::ipc::loopback_addr(9999));
    }

    #[test]
    fn agent_hello_is_acked_but_does_not_mark_the_pipeline_ready() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        assert!(!b.broker_ready.load(Ordering::Relaxed));

        let body = br#"{"agent":"1.0","pid":42,"warmFps":5}"#;
        assert!(b.handle_datagram(&datagram(T_HELLO, 0, 1, now_us(), body)));

        let sent = t.sent();
        assert!(sent.iter().any(|m| m.msg_type == T_HELLO_ACK));
        // The ladder is pushed immediately so the agent starts at a known rung.
        assert!(sent.iter().any(|m| m.msg_type == T_LADDER));
        // A HELLO only proves the loopback is alive; the media path is not up
        // until the agent actually reports (section 10).
        assert!(!b.broker_ready.load(Ordering::Relaxed));
    }

    #[test]
    fn the_first_agent_stats_report_marks_the_pipeline_ready() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        assert!(!b.broker_ready.load(Ordering::Relaxed));
        let body = br#"{"captureFps":11.0,"encodeFps":11.0}"#;
        b.handle_datagram(&datagram(T_STATS, 0, 1, now_us(), body));
        assert!(b.broker_ready.load(Ordering::Relaxed));
    }

    #[test]
    fn malformed_datagrams_are_counted_not_fatal() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        assert!(!b.handle_datagram(&[1, 2, 3]));
        assert!(!b.handle_datagram(&[0u8; 40]));
        let s = b.stats.lock().unwrap();
        assert_eq!(s.ipc_malformed, 2);
    }

    #[test]
    fn a_video_frame_reaches_the_transport_with_its_metadata() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        let ts = now_us();
        let bodies = ipc::fragment_frame(1, meta(1280, 720, 0), ipc::F_KEYFRAME, &[0, 0, 0, 1, 0x67]);
        for (i, body) in bodies.iter().enumerate() {
            b.handle_datagram(&datagram(T_VIDEO_NALU, ipc::F_KEYFRAME, i as u32 + 1, ts, body));
        }
        let sent = t.frames();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].meta.width, 1280);
        assert_eq!(sent[0].meta.height, 720);
        assert!(sent[0].keyframe);
    }

    #[test]
    fn queue_depth_stays_at_one_when_frames_arrive_faster_than_they_are_sent() {
        // Force the transport to be the slow side, which is the only condition
        // under which the depth-1 queue does anything. Without backpressure the
        // queue would drain instantly and the replacement path would not be
        // exercised at all.
        let t = Arc::new(LoopbackTransport::default());
        t.set_send_fps(1);
        let b = Broker::new(t.clone());
        let ts = now_us();
        for i in 0..200 {
            let body = frame_dgram(640, 480, 0, &[0, 0, 0, 1, i as u8], i + 1, ts + i as u64 * 1000);
            b.handle_datagram(&body);
        }

        let q = b.queue.lock().unwrap();
        assert!(q.max_depth_seen() <= 1, "queue depth exceeded 1: {}", q.max_depth_seen());
        assert!(q.replaced() > 0, "expected replacements under overload");
        drop(q);
        assert!(t.refused() > 0, "transport should have refused frames under overload");

        // And the frame still in the slot is the newest one, not the oldest.
        let snap = b.snapshot();
        assert!(snap["queueDepth"].as_u64().unwrap() <= 1);
        assert!(snap["queueMaxDepthSeen"].as_u64().unwrap() <= 1);
    }

    #[test]
    fn a_refused_frame_in_the_send_tick_is_dropped_not_held() {
        // The send tick must not preserve a frame across ticks: holding it is how
        // a queue would sneak back in.
        let t = Arc::new(LoopbackTransport::default());
        t.drop_frames.store(true, Ordering::Relaxed);
        let b = Broker::new(t.clone());
        let ts = now_us();
        b.handle_datagram(&frame_dgram(640, 480, 0, &[1], 1, ts));
        assert_eq!(b.queue.lock().unwrap().depth(), 1);

        // The receive-path flush already refused it once (and kept it).
        assert_eq!(b.stats.lock().unwrap().nalu_dropped, 1);
        assert!(!b.flush_send_queue(false));
        assert_eq!(b.queue.lock().unwrap().depth(), 0, "the send tick must drop, not hold");
        assert_eq!(b.stats.lock().unwrap().nalu_dropped, 2);
    }

    #[test]
    fn a_refused_frame_on_the_receive_path_is_superseded_not_queued() {
        let t = Arc::new(LoopbackTransport::default());
        t.drop_frames.store(true, Ordering::Relaxed);
        let b = Broker::new(t.clone());
        let ts = now_us();
        b.handle_datagram(&frame_dgram(640, 480, 0, &[1], 1, ts));
        // The refusal put it back, still depth 1.
        assert_eq!(b.queue.lock().unwrap().depth(), 1);
        // The next arrival replaces it, so no backlog forms.
        b.handle_datagram(&frame_dgram(640, 480, 0, &[2], 2, ts + 1000));
        let q = b.queue.lock().unwrap();
        assert!(q.depth() <= 1);
        assert!(q.max_depth_seen() <= 1);
    }

    #[test]
    fn input_round_trip_produces_click_to_pixel_on_the_broker() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        let t0 = now_us();
        let id = b.push_input("ld", serde_json::json!({"nx": 0.5, "ny": 0.5}), Some(t0));
        assert!(t.sent().iter().any(|m| m.msg_type == T_INPUT_EVENT));

        // The agent injected it 2 ms later.
        let ack_body = {
            let mut v = Vec::new();
            v.extend_from_slice(&id.to_be_bytes());
            v.extend_from_slice(&t0.to_be_bytes());
            v.extend_from_slice(&(t0 + 2000).to_be_bytes());
            v
        };
        b.handle_datagram(&datagram(T_INPUT_ACK, 0, 2, t0 + 2000, &ack_body));

        // The first frame captured after the injection goes through the real
        // assembler and send path, so the accounting is exercised end to end.
        let body = frame_dgram(1280, 720, 0, &[0, 0, 0, 1], 3, t0 + 3000);
        b.handle_datagram(&body);

        let snap = b.snapshot();
        assert_eq!(snap["clickToPixelMs"]["samples"], 1);
        assert_eq!(snap["input"]["acksIn"], 1);
        // Production measures this on the wall clock, so the value is small but
        // non-negative. The exact arithmetic is pinned in `stats::tests`.
        let measured = snap["clickToPixelMs"]["p95"].as_f64().unwrap();
        assert!(measured >= 0.0 && measured < 1000.0, "implausible c2p: {}", measured);
    }

    #[test]
    fn an_unacked_input_produces_no_click_to_pixel() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        let t0 = now_us();
        let _ = b.push_input("ld", serde_json::json!({"nx": 0.5}), Some(t0));
        b.handle_datagram(&frame_dgram(1280, 720, 0, &[0, 0, 0, 1], 3, t0 + 3000));
        let snap = b.snapshot();
        assert_eq!(
            snap["clickToPixelMs"]["samples"], 0,
            "an input with no INPUT_ACK cannot claim a click-to-pixel"
        );
        assert_eq!(snap["input"]["pendingUnacked"], 1);
    }

    #[test]
    fn a_sequence_gap_raises_a_nack_and_can_trigger_a_keyframe() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        let ts = now_us();
        b.handle_datagram(&frame_dgram(640, 480, 0, &[1], 1, ts));
        b.handle_datagram(&frame_dgram(640, 480, 0, &[1], 4, ts));
        let s = b.stats.lock().unwrap();
        assert!(s.nack_sent >= 2, "expected NACKs for the gap, got {}", s.nack_sent);
        drop(s);
        assert!(t.sent().iter().any(|m| m.msg_type == T_KEYFRAME_REQ));
    }

    #[test]
    fn keyframe_requests_are_rate_limited_to_one_per_five_seconds() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        for _ in 0..10 {
            b.request_keyframe(KeyframeReason::Loss);
        }
        let reqs = t
            .sent()
            .iter()
            .filter(|m| m.msg_type == T_KEYFRAME_REQ)
            .count();
        assert_eq!(reqs, 1, "expected a single rate-limited keyframe request, got {}", reqs);
    }

    #[test]
    fn fec_parity_is_emitted_once_per_group() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        let ts = now_us();
        for i in 0..crate::broker::queue::FEC_GROUP as u32 {
            b.handle_datagram(&frame_dgram(640, 480, 0, &[i as u8; 4], i + 1, ts));
        }
        assert_eq!(t.parity().len(), 1, "one parity NAL per full group");
        let s = b.stats.lock().unwrap();
        assert_eq!(s.fec_parity_sent, 1);
    }

    #[test]
    fn fec_recovery_avoids_a_keyframe_for_a_single_loss() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        let mut g = FecGroup::new(1);
        let a = vec![1u8, 2, 3, 4];
        let bb = vec![5u8, 6, 7, 8];
        let c = vec![9u8, 9, 9, 9];
        g.push(1, &a);
        g.push(2, &bb);
        g.push(3, &c);
        let parity = g.parity().unwrap();
        let present = vec![Some(a.clone()), None, Some(c.clone())];
        assert!(b.try_fec_recover(&parity, &present, 1));
        let s = b.stats.lock().unwrap();
        assert_eq!(s.nack_recovered, 1);
    }

    #[test]
    fn cursor_messages_flow_independently_of_video() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        let mut body = Vec::new();
        for v in [500i32, 600, 1920, 1080] {
            body.extend_from_slice(&v.to_be_bytes());
        }
        b.handle_datagram(&datagram(T_CURSOR_POS, 0, 1, now_us(), &body));
        b.handle_datagram(&datagram(T_CURSOR_VIS, 0, 2, now_us(), &[1]));
        assert_eq!(t.cursor_pos().len(), 1);
        assert_eq!(t.cursor_vis().len(), 1);
        // No video frame was needed for either.
        assert!(t.frames().is_empty());
    }

    #[test]
    fn agent_stats_update_the_surface() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        let body = br#"{"captureFps":11.0,"encodeFps":11.0,"warmFps":5.0,"captureMode":"dda","encoderName":"H264 Encoder MFT","encoderHardware":false,"jitterBufferFrames":1,"inputEventsInjected":9,"agentPid":1234,"agentUptimeS":5}"#;
        b.handle_datagram(&datagram(T_STATS, 0, 1, now_us(), body));
        let snap = b.snapshot();
        assert_eq!(snap["fps"]["encode"], 11.0);
        assert_eq!(snap["captureMode"], "dda");
        assert_eq!(snap["jitterBufferFrames"], 1);
        assert_eq!(snap["agent"]["pid"], 1234);
    }

    #[test]
    fn override_is_honored_in_the_broker_surface() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        assert_eq!(b.set_override(ClientPath::Mjpeg), ClientPath::Mjpeg);
        let snap = b.snapshot();
        assert_eq!(snap["clientPath"], "mjpeg");
        assert_eq!(b.set_override(ClientPath::Webrtc), ClientPath::Webrtc);
        assert_eq!(b.snapshot()["clientPath"], "webrtc");
    }

    #[test]
    fn a_missing_encoder_comes_up_on_mjpeg() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        b.set_encoder_available(false);
        let snap = b.snapshot();
        assert_eq!(snap["clientPath"], "mjpeg");
        assert!(!snap["fallback"]["reason"].as_str().unwrap().is_empty());
    }

    #[test]
    fn policy_tick_emits_and_publishes_a_fallback_event() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        b.set_path_type(PathType::Direct);
        // Bring the pipeline up the way production does, so this exercises the
        // runtime trigger rather than the startup gate.
        b.handle_datagram(&datagram(
            T_STATS,
            0,
            1,
            now_us(),
            br#"{"captureFps":24.0,"encodeFps":24.0}"#,
        ));
        assert!(b.broker_ready.load(Ordering::Relaxed));
        b.note_ice_state(true);
        {
            let mut s = b.stats.lock().unwrap();
            s.ice_failed_since_us = Some(now_us() - 5_000_000);
        }
        let evs = b.tick_policy();
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::Fallback { .. })));
        let snap = b.snapshot();
        assert_eq!(snap["clientPath"], "mjpeg");
        assert_eq!(snap["fallback"]["fallbacks"], 1);
        // The agent must learn about the change so it can shed load.
        assert!(t.sent().iter().any(|m| m.msg_type == T_LADDER));
    }

    #[test]
    fn ladder_message_carries_the_rung_and_the_path_cap() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        b.set_path_type(PathType::Direct);
        {
            let mut p = b.policy.lock().unwrap();
            p.tier = 3;
        }
        b.push_ladder();
        let ladder = t
            .sent()
            .into_iter()
            .find(|m| m.msg_type == T_LADDER)
            .expect("ladder sent");
        let msg: LadderMsg = serde_json::from_slice(&ladder.body).unwrap();
        assert_eq!(msg.tier, 3);
        assert_eq!(msg.quality, 35);
        assert_eq!(msg.scale, 0.70);
        assert_eq!(msg.fps_cap, 12);
        assert_eq!(msg.path, "direct");
    }

    #[test]
    fn fps_cap_never_exceeds_the_path_cap_through_the_ladder() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        with_peer(&b);
        for path in [PathType::Derp, PathType::Direct] {
            b.set_path_type(path);
            for tier in 0..=crate::broker::policy::BOTTOM_TIER {
                {
                    let mut p = b.policy.lock().unwrap();
                    p.tier = tier;
                }
                b.push_ladder();
            }
        }
        for m in t.sent().iter().filter(|m| m.msg_type == T_LADDER) {
            let msg: LadderMsg = serde_json::from_slice(&m.body).unwrap();
            let cap = if msg.path == "derp" { 12 } else { 24 };
            assert!(msg.fps_cap <= cap, "fps cap {} above path cap {}", msg.fps_cap, cap);
        }
    }

    #[test]
    fn loopback_log_records_ipc_and_samples() {
        let dir = std::env::temp_dir().join(format!("ghrdp-broker-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ipc-loopback.ndjson");
        let _ = std::fs::remove_file(&path);
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t);
        b.set_loopback_log(Some(path.clone()));
        b.handle_datagram(&frame_dgram(640, 480, 0, &[1], 1, now_us()));
        b.tick_policy();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"kind\":\"ipc\""));
        assert!(text.contains("\"kind\":\"sample\""));
        assert!(text.contains("\"tag\":\"send\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversize_datagrams_are_truncated_never_fragmented() {
        let t = Arc::new(LoopbackTransport::default());
        let b = Broker::new(t.clone());
        // Pretend the agent is a peer.
        {
            let mut p = b.peer.lock().unwrap();
            *p = Some(ipc::loopback_addr(9999));
        }
        let big = vec![7u8; MAX_DATAGRAM * 3];
        b.send_to_agent(T_STATS, 0, &big);
        let sent = t.sent();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].bytes <= MAX_DATAGRAM, "datagram was not truncated: {}", sent[0].bytes);
    }
}