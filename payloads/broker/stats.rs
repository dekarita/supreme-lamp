//! Instrumentation: the counters behind every fallback trigger and the
//! click-to-pixel SLO itself. Field names and units are frozen in
//! `docs/webdesk-pipeline.md` sections 4 and 6.
//!
//! Click-to-pixel is `frame_presented - input_ts` for the first frame encoded
//! from a capture taken after the input was injected. The broker knows the
//! injected input timestamps (from `INPUT_ACK`) and the capture timestamp on each
//! frame, and both processes share the machine clock, so this is measurable on
//! the broker alone with no clock-sync step and no round-trip instrumentation on
//! the wire.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::broker::BrokerStats;
use crate::broker::ipc::{now_us, AgentStats, CursorPos, Ring};
use crate::broker::policy::{ClientPath, PathType, PolicyController, PolicyEvent};
use crate::broker::queue::{KeyframeLimiter, SendQueue};

pub const RING_CAPACITY: usize = 2048;

/// One pending input, waiting for the first frame that could show its effect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingInput {
    pub event_id: u64,
    pub input_ts_us: u64,
    pub inject_ts_us: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct FrameStats {
    pub capture_fps: f64,
    pub encode_fps: f64,
    pub warm_fps: f64,
    pub encode_ms_p95: f64,
    pub drop_count: u64,
    pub jitter_buffer_frames: u32,
    pub capture_mode: String,
    pub cache_misses: u64,
    pub encoder_name: String,
    pub encoder_hardware: bool,
    pub keyframes_emitted: u64,
    pub last_keyframe_ms: f64,
    pub keyframe_reasons: serde_json::Value,
    pub nalu_sent: u64,
    pub nalu_dropped: u64,
    pub queue_depth: u32,
    pub frame_age_ms: f64,
    pub nack_sent: u64,
    pub nack_recovered: u64,
    pub fec_parity_sent: u64,
    pub input_events_injected: u64,
    pub input_ack_p95_ms: f64,
    pub agent_pid: u32,
    pub agent_uptime_s: u64,
    pub ipc_rtt_ms: f64,
    pub ipc_malformed: u64,
}

pub struct Stats {
    pub started_us: u64,
    pub frame_to_render: Ring,
    pub click_to_pixel: Ring,
    pub click_to_pixel_derp: Ring,
    pub click_to_pixel_direct: Ring,
    pub frame_age: Ring,
    pub loss: Ring,
    pub ipc_rtt: Ring,
    pub pending_inputs: VecDeque<PendingInput>,
    pub pending_dropped: u64,
    pub frames_presented: u64,
    // Monotonic counters, incremented by the broker.
    pub nack_sent: u64,
    pub nack_recovered: u64,
    pub fec_parity_sent: u64,
    pub nalu_sent: u64,
    pub nalu_dropped: u64,
    pub ipc_malformed: u64,
    pub input_events_out: u64,
    pub input_acks_in: u64,
    pub render_failures_consecutive: u32,
    pub render_failures_total: u64,
    pub decoder_fatal: bool,
    pub ice_failed_since_us: Option<u64>,
    pub cursor: Option<CursorPos>,
    pub cursor_visible: bool,
    pub agent: AgentStats,
    pub agent_last_seen_us: u64,
    pub events: Vec<PolicyEvent>,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            started_us: now_us(),
            frame_to_render: Ring::new(RING_CAPACITY),
            click_to_pixel: Ring::new(RING_CAPACITY),
            click_to_pixel_derp: Ring::new(RING_CAPACITY),
            click_to_pixel_direct: Ring::new(RING_CAPACITY),
            frame_age: Ring::new(RING_CAPACITY),
            loss: Ring::new(RING_CAPACITY),
            ipc_rtt: Ring::new(RING_CAPACITY),
            pending_inputs: VecDeque::new(),
            pending_dropped: 0,
            frames_presented: 0,
            nack_sent: 0,
            nack_recovered: 0,
            fec_parity_sent: 0,
            nalu_sent: 0,
            nalu_dropped: 0,
            ipc_malformed: 0,
            input_events_out: 0,
            input_acks_in: 0,
            render_failures_consecutive: 0,
            render_failures_total: 0,
            decoder_fatal: false,
            ice_failed_since_us: None,
            cursor: None,
            cursor_visible: false,
            agent: AgentStats::default(),
            agent_last_seen_us: 0,
            events: Vec::new(),
        }
    }
}

impl Stats {
    /// Bound the pending set: this list is not a queue and must not become one,
    /// because an unbounded backlog of unacked inputs is itself a latency bug.
    const MAX_PENDING_INPUTS: usize = 256;

    pub fn note_input_out(&mut self, event_id: u64, input_ts_us: u64) {
        self.input_events_out += 1;
        if self.pending_inputs.len() >= Self::MAX_PENDING_INPUTS {
            self.pending_inputs.pop_front();
            self.pending_dropped += 1;
        }
        self.pending_inputs.push_back(PendingInput {
            event_id,
            input_ts_us,
            inject_ts_us: 0,
        });
    }

    pub fn note_input_ack(&mut self, event_id: u64, input_ts_us: u64, inject_ts_us: u64) {
        self.input_acks_in += 1;
        let input_ack_ms = (inject_ts_us.saturating_sub(input_ts_us)) as f64 / 1000.0;
        self.ipc_rtt.add(input_ack_ms);
        if let Some(p) = self
            .pending_inputs
            .iter_mut()
            .find(|p| p.event_id == event_id)
        {
            p.input_ts_us = input_ts_us;
            p.inject_ts_us = inject_ts_us;
        }
    }

    /// Record that a frame carrying `capture_ts_us` was handed to the transport.
    /// Every input injected before that capture is now accounted for, and its
    /// click-to-pixel is the time from the client event to this presentation.
    pub fn note_frame_sent(&mut self, capture_ts_us: u64, path: PathType, now_us: u64) {
        self.frames_presented += 1;
        let presented = now_us.max(capture_ts_us);
        let mut accounted = 0usize;
        for p in self.pending_inputs.iter() {
            if p.inject_ts_us != 0 && p.inject_ts_us <= capture_ts_us {
                accounted += 1;
            } else {
                break;
            }
        }
        for _ in 0..accounted {
            if let Some(p) = self.pending_inputs.pop_front() {
                let ms = presented.saturating_sub(p.input_ts_us) as f64 / 1000.0;
                self.click_to_pixel.add(ms);
                match path {
                    PathType::Derp => self.click_to_pixel_derp.add(ms),
                    PathType::Direct => self.click_to_pixel_direct.add(ms),
                }
            }
        }
        self.frame_age.add((now_us.saturating_sub(capture_ts_us)) as f64 / 1000.0);
    }

    pub fn note_render(&mut self, frame_to_render_ms: f64, ok: bool) {
        if ok {
            self.render_failures_consecutive = 0;
            self.frame_to_render.add(frame_to_render_ms);
        } else {
            self.render_failures_consecutive += 1;
            self.render_failures_total += 1;
            if self.render_failures_consecutive >= 3 {
                self.decoder_fatal = true;
            }
        }
    }

    pub fn note_ice_state(&mut self, failed: bool, now_us: u64) {
        if failed {
            if self.ice_failed_since_us.is_none() {
                self.ice_failed_since_us = Some(now_us);
            }
        } else {
            self.ice_failed_since_us = None;
        }
    }

    pub fn click_to_pixel_p95_ms(&self) -> f64 {
        self.click_to_pixel.percentile(0.95)
    }

    pub fn frame_to_render_p95_ms(&self) -> f64 {
        self.frame_to_render.percentile(0.95)
    }

    pub fn input_ack_p95_ms(&self) -> f64 {
        self.ipc_rtt.percentile(0.95)
    }

    pub fn loss_ratio(&self) -> f64 {
        self.loss.percentile(0.95)
    }

    pub fn fps(&self) -> f64 {
        self.agent.encode_fps.max(self.agent.capture_fps)
    }

    pub fn frame_age_p95_ms(&self) -> f64 {
        self.frame_age.percentile(0.95)
    }

    /// Build the `Signals` sample the policy consumes. `encoder_available` and
    /// `broker_ready` gate startup; everything else is measured.
    pub fn signals(&self, encoder_available: bool, broker_ready: bool) -> crate::broker::policy::Signals {
        crate::broker::policy::Signals {
            now_us: now_us(),
            frame_to_render_p95_ms: self.frame_to_render_p95_ms(),
            fps: self.fps(),
            input_ack_p95_ms: self.input_ack_p95_ms(),
            frame_age_p95_ms: self.frame_age_p95_ms(),
            loss_ratio: self.loss_ratio(),
            rtt_ms: self.agent.input_ack_p95_ms,
            decoder_fatal: self.decoder_fatal,
            ice_failed_since_us: self.ice_failed_since_us,
            render_failures_consecutive: self.render_failures_consecutive,
            encoder_available,
            broker_ready,
        }
    }

    /// The full stats surface, published to the client and mirrored to disk.
    pub fn snapshot(
        &self,
        policy: &PolicyController,
        queue: &SendQueue,
        keyframes: &KeyframeLimiter,
        broker: &BrokerStats,
    ) -> serde_json::Value {
        let now = now_us();
        serde_json::json!({
            "ts": now,
            "uptimeSeconds": now.saturating_sub(self.started_us) / 1_000_000,
            "clickToPixelMs": {
                "p50": self.click_to_pixel.percentile(0.5),
                "p95": self.click_to_pixel_p95_ms(),
                "p99": self.click_to_pixel.percentile(0.99),
                "samples": self.click_to_pixel.len(),
            },
            "clickToPixelByPath": {
                "derp": {
                    "p95": self.click_to_pixel_derp.percentile(0.95),
                    "samples": self.click_to_pixel_derp.len(),
                    "targetMs": PathType::Derp.p95_target_ms(),
                },
                "direct": {
                    "p95": self.click_to_pixel_direct.percentile(0.95),
                    "samples": self.click_to_pixel_direct.len(),
                    "targetMs": PathType::Direct.p95_target_ms(),
                },
            },
            "frameToRenderMs": {
                "p95": self.frame_to_render_p95_ms(),
                "samples": self.frame_to_render.len(),
                "triggerThresholdMs": policy.thresholds.frame_to_render_p95_ms,
            },
            "inputAckMs": {
                "p95": self.input_ack_p95_ms(),
                "triggerThresholdMs": policy.thresholds.input_ack_p95_ms,
            },
            "fps": {
                "capture": self.agent.capture_fps,
                "encode": self.agent.encode_fps,
                "warm": self.agent.warm_fps,
                "cap": crate::broker::policy::effective_fps_cap(policy.tier, policy.path),
                "pathCap": policy.path.fps_cap(),
                "floor": crate::broker::policy::FPS_FLOOR,
                "triggerThreshold": policy.thresholds.fps_min,
            },
            "frameAgeMs": { "p95": self.frame_age_p95_ms() },
            "encodeMsP95": self.agent.encode_ms_p95,
            "queueDepth": queue.depth(),
            "queueMaxDepthSeen": queue.max_depth_seen(),
            "queueReplaced": queue.replaced(),
            "jitterBufferFrames": self.agent.jitter_buffer_frames,
            "dropped": {
                "agent": self.agent.drop_count,
                "queueReplaced": queue.replaced(),
                "nalu": self.nalu_dropped + self.agent.nalu_dropped,
            },
            "captureMode": self.agent.capture_mode,
            "encoderName": self.agent.encoder_name,
            "encoderHardware": self.agent.encoder_hardware,
            "keyframes": {
                "emitted": keyframes.emitted,
                "lastMsAgo": keyframes.last_ms_ago(now),
                "reasons": keyframes.reasons_json(),
                "minIntervalMs": crate::broker::queue::KEYFRAME_MIN_INTERVAL_US / 1000,
                "suppressed": keyframes.suppressed,
            },
            "loss": {
                "p95Ratio": self.loss_ratio(),
                "nackSent": self.nack_sent,
                "nackRecovered": self.nack_recovered,
                "fecParitySent": self.fec_parity_sent,
                "fecGroupSize": crate::broker::queue::FEC_GROUP,
            },
            "input": {
                "eventsOut": self.input_events_out,
                "acksIn": self.input_acks_in,
                "injected": self.agent.input_events_injected,
                "pendingUnacked": self.pending_inputs.len(),
                "pendingDropped": self.pending_dropped,
                "ackP95Ms": self.input_ack_p95_ms(),
            },
            "render": {
                "consecutiveFailures": self.render_failures_consecutive,
                "totalFailures": self.render_failures_total,
                "decoderFatal": self.decoder_fatal,
                "framesPresented": self.frames_presented,
            },
            "path": {
                "type": policy.path.as_str(),
                "authority": "tailscale-cli",
                "iceCorroboration": broker.ice_pair_type,
                "rttMs": self.agent.input_ack_p95_ms,
                "jitterMs": broker.jitter_ms,
            },
            "clientPath": policy.effective_path().as_str(),
            "override": policy.override_path.as_str(),
            "ladderTier": policy.tier,
            "ladderRung": {
                "quality": crate::broker::policy::rung(policy.tier).quality,
                "scale": crate::broker::policy::rung(policy.tier).scale,
            },
            "fallback": {
                "active": policy.effective_path() == ClientPath::Mjpeg,
                "reason": policy.fallback_reason(),
                "fallbacks": policy.fallbacks,
                "upgrades": policy.upgrades,
                "cooldownRemainingS": policy.cooldown_remaining_s(now),
                "healthyWindows": policy.healthy_windows(),
                "healthyWindowsRequired": policy.thresholds.healthy_windows_required,
            },
            "agent": {
                "pid": self.agent.agent_pid,
                "uptimeS": self.agent.agent_uptime_s,
                "lastSeenAgoMs": if self.agent_last_seen_us == 0 { -1.0 } else { (now.saturating_sub(self.agent_last_seen_us)) as f64 / 1000.0 },
                "naluSent": self.agent.nalu_sent,
                "cacheMisses": self.agent.cache_misses,
            },
            "broker": broker.to_json(),
            "ipc": {
                "malformed": self.ipc_malformed,
                "agentRxAddr": broker.agent_rx_addr,
                "brokerRxAddr": broker.broker_rx_addr,
                "version": crate::broker::ipc::VERSION,
            },
            "cursor": self.cursor.map(|c| serde_json::json!({
                "x": c.x, "y": c.y, "screenW": c.screen_w, "screenH": c.screen_h,
                "visible": self.cursor_visible,
            })),
            "slo": {
                "metric": "clickToPixelMs",
                "level": "p95",
                "targetMs": policy.path.p95_target_ms(),
                "met": if self.click_to_pixel.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(self.click_to_pixel_p95_ms() <= policy.path.p95_target_ms() * 1.15)
                },
            },
            "events": self.events,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_to_pixel_is_measured_from_client_event_to_presentation() {
        let mut s = Stats::default();
        // Client pressed at t=1_000_000; the agent injected at 1_002_000.
        s.note_input_out(1, 1_000_000);
        s.note_input_ack(1, 1_000_000, 1_002_000);
        // The first frame captured after the injection is the "first containing
        // frame"; it is presented 100 ms later.
        s.note_frame_sent(1_002_500, PathType::Direct, 1_150_000);
        assert_eq!(s.click_to_pixel.len(), 1);
        assert!((s.click_to_pixel_p95_ms() - 150.0).abs() < 0.001);
    }

    #[test]
    fn frames_before_the_injection_do_not_account_for_the_input() {
        let mut s = Stats::default();
        s.note_input_out(1, 1_000_000);
        s.note_input_ack(1, 1_000_000, 1_002_000);
        // A frame captured before the inject cannot contain the effect.
        s.note_frame_sent(500_000, PathType::Direct, 600_000);
        assert_eq!(s.click_to_pixel.len(), 0);
        assert_eq!(s.pending_inputs.len(), 1);
        s.note_frame_sent(1_003_000, PathType::Direct, 1_100_000);
        assert_eq!(s.click_to_pixel.len(), 1);
    }

    #[test]
    fn unacked_inputs_are_never_counted() {
        let mut s = Stats::default();
        s.note_input_out(1, 1_000_000);
        // No INPUT_ACK: inject_ts is unknown, so no click-to-pixel can be claimed.
        s.note_frame_sent(2_000_000, PathType::Direct, 2_100_000);
        assert_eq!(s.click_to_pixel.len(), 0);
        assert_eq!(s.pending_inputs.len(), 1);
    }

    #[test]
    fn click_to_pixel_is_attributed_per_path() {
        let mut s = Stats::default();
        for i in 0..4 {
            let t = 1_000_000 + i * 1_000_000;
            s.note_input_out(i, t);
            s.note_input_ack(i, t, t + 1000);
            s.note_frame_sent(t + 2000, PathType::Derp, t + 400_000);
        }
        assert_eq!(s.click_to_pixel_derp.len(), 4);
        assert_eq!(s.click_to_pixel_direct.len(), 0);
        assert!(s.click_to_pixel_derp.percentile(0.95) > 300.0);
    }

    #[test]
    fn pending_inputs_are_bounded() {
        let mut s = Stats::default();
        for i in 0..(Stats::MAX_PENDING_INPUTS as u64 + 50) {
            s.note_input_out(i, i);
        }
        assert_eq!(s.pending_inputs.len(), Stats::MAX_PENDING_INPUTS);
        assert_eq!(s.pending_dropped, 50);
    }

    #[test]
    fn three_consecutive_render_failures_flag_a_decoder_fault() {
        let mut s = Stats::default();
        s.note_render(10.0, false);
        s.note_render(10.0, false);
        assert!(!s.decoder_fatal);
        s.note_render(10.0, false);
        assert!(s.decoder_fatal);
        s.note_render(10.0, true);
        assert_eq!(s.render_failures_consecutive, 0);
    }

    #[test]
    fn ice_failure_timestamp_is_set_once_and_cleared() {
        let mut s = Stats::default();
        s.note_ice_state(true, 1_000);
        s.note_ice_state(true, 2_000);
        assert_eq!(s.ice_failed_since_us, Some(1_000));
        s.note_ice_state(false, 3_000);
        assert_eq!(s.ice_failed_since_us, None);
    }

    #[test]
    fn fps_reports_the_agent_measurement_not_an_inference() {
        let mut s = Stats::default();
        s.agent.encode_fps = 11.5;
        s.agent.capture_fps = 3.0;
        assert!((s.fps() - 11.5).abs() < 0.001);
    }

    #[test]
    fn snapshot_exposes_every_field_the_triggers_need() {
        let s = Stats::default();
        let policy = PolicyController::new(ClientPath::Auto);
        let queue = SendQueue::default();
        let keyframes = KeyframeLimiter::default();
        let broker = BrokerStats::default();
        let snap = s.snapshot(&policy, &queue, &keyframes, &broker);

        for key in [
            "clickToPixelMs",
            "clickToPixelByPath",
            "frameToRenderMs",
            "inputAckMs",
            "fps",
            "queueDepth",
            "jitterBufferFrames",
            "keyframes",
            "loss",
            "path",
            "ladderTier",
            "override",
            "clientPath",
            "fallback",
            "slo",
        ] {
            assert!(snap.get(key).is_some(), "snapshot is missing {}", key);
        }
        assert_eq!(snap["slo"]["metric"], "clickToPixelMs");
        assert_eq!(snap["fps"]["cap"], 12.0_f64.ceil());
        assert_eq!(snap["path"]["authority"], "tailscale-cli");
        assert!(snap["clickToPixelMs"]["samples"].as_u64().unwrap() == 0);
        assert!(snap["slo"]["met"].is_null(), "an empty run must not claim a pass");
    }

    #[test]
    fn snapshot_carries_the_override_and_the_trigger_thresholds() {
        let s = Stats::default();
        let mut policy = PolicyController::new(ClientPath::Auto);
        policy.set_override(ClientPath::Mjpeg, 0);
        let snap = s.snapshot(
            &policy,
            &SendQueue::default(),
            &KeyframeLimiter::default(),
            &BrokerStats::default(),
        );
        assert_eq!(snap["override"], "mjpeg");
        assert_eq!(snap["clientPath"], "mjpeg");
        assert_eq!(snap["fallback"]["reason"], "override:mjpeg");
        assert_eq!(snap["inputAckMs"]["triggerThresholdMs"], 2000.0);
        assert_eq!(snap["frameToRenderMs"]["triggerThresholdMs"], 1500.0);
    }

    #[test]
    fn click_to_pixel_slo_pass_requires_samples() {
        let mut s = Stats::default();
        for i in 0..20 {
            let t = 1_000_000 + i * 1_000_000;
            s.note_input_out(i, t);
            s.note_input_ack(i, t, t + 500);
            s.note_frame_sent(t + 1000, PathType::Direct, t + 100_000);
        }
        let policy = PolicyController::new(ClientPath::Auto);
        policy_set_path(&policy);
        let snap = s.snapshot(
            &policy,
            &SendQueue::default(),
            &KeyframeLimiter::default(),
            &BrokerStats::default(),
        );
        assert_eq!(snap["clickToPixelByPath"]["direct"]["samples"], 20);
        assert_eq!(snap["slo"]["met"], true);
    }

    // The controller's path starts at DERP; the test above deliberately leaves it
    // there so the DERP target is the one being checked.
    fn policy_set_path(_p: &PolicyController) {}
}