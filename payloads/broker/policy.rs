//! The latency policy: the fixed degradation ladder (Q1) and the fallback /
//! upgrade state machine (Q3), exactly as frozen in
//! `docs/webdesk-pipeline.md` sections 9-10.
//!
//! Both halves are pure state machines over a signal sample, with time passed in
//! rather than read, so the harness can drive them deterministically and the
//! thresholds are testable without waiting in real time.
//!
//! Two consequences of "WebRTC-first" that are easy to get wrong, and are pinned
//! by tests here:
//!
//! * `Auto` starts on WebRTC (optimistic primary), and the *startup gate* is what
//!   moves a broken pipeline to MJPEG. It does not start on MJPEG and wait.
//! * The ladder's bottom rung caps fps at 6, which is below the 8 fps fallback
//!   trigger. That is deliberate (section 9.2): a bottomed-out ladder whose
//!   user-visible latency is still bad must fall back rather than sit on the
//!   floor. A bottomed-out ladder *alone*, with the SLO still met, does not.

use serde::{Deserialize, Serialize};

use crate::broker::ipc::Ring;

/// Path classification authority is the Tailscale CLI probe (section 7.3); the
/// ICE selected-pair type is corroborating only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathType {
    Derp,
    Direct,
}

impl PathType {
    pub fn as_str(self) -> &'static str {
        match self {
            PathType::Derp => "derp",
            PathType::Direct => "direct",
        }
    }

    /// Hard fps caps: 12 on DERP, 24 on direct. A cap is a ceiling belief, not a
    /// target — the controller may sit below it whenever the latency budget
    /// demands.
    pub fn fps_cap(self) -> u16 {
        match self {
            PathType::Derp => 12,
            PathType::Direct => 24,
        }
    }

    /// p95 click-to-pixel target for this path (section 4.1).
    pub fn p95_target_ms(self) -> f64 {
        match self {
            PathType::Derp => 335.0,
            PathType::Direct => 140.0,
        }
    }

    pub fn from_via(via: &str) -> PathType {
        if via.trim().to_ascii_uppercase().starts_with("DERP") {
            PathType::Derp
        } else {
            PathType::Direct
        }
    }
}

/// Hard floor. fps never falls below this without triggering fallback.
pub const FPS_FLOOR: u16 = 6;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rung {
    pub tier: u8,
    pub quality: u8,
    pub scale: f64,
    /// 0 means "use the path cap".
    pub fps_cap: u16,
}

/// Quality -> resolution -> fps, in that order. Never buffering: the ladder has
/// no rung that adds queue depth or jitter-buffer size, because there is nowhere
/// to buffer (sections 7 and 9.1).
pub const LADDER: [Rung; 6] = [
    Rung { tier: 0, quality: 60, scale: 1.00, fps_cap: 0 },
    Rung { tier: 1, quality: 50, scale: 1.00, fps_cap: 0 },
    Rung { tier: 2, quality: 42, scale: 0.85, fps_cap: 0 },
    Rung { tier: 3, quality: 35, scale: 0.70, fps_cap: 12 },
    Rung { tier: 4, quality: 30, scale: 0.60, fps_cap: 9 },
    Rung { tier: 5, quality: 25, scale: 0.50, fps_cap: FPS_FLOOR },
];

pub const BOTTOM_TIER: u8 = 5;

pub fn rung(tier: u8) -> Rung {
    LADDER[(tier as usize).min(LADDER.len() - 1)]
}

/// Effective fps cap: the rung's cap, itself never above the path cap.
pub fn effective_fps_cap(tier: u8, path: PathType) -> u16 {
    let r = rung(tier);
    let cap = if r.fps_cap == 0 { path.fps_cap() } else { r.fps_cap };
    cap.min(path.fps_cap()).max(FPS_FLOOR.min(path.fps_cap()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientPath {
    Auto,
    Webrtc,
    Mjpeg,
}

impl ClientPath {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientPath::Auto => "auto",
            ClientPath::Webrtc => "webrtc",
            ClientPath::Mjpeg => "mjpeg",
        }
    }

    pub fn parse(s: &str) -> Option<ClientPath> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(ClientPath::Auto),
            "webrtc" | "rtc" => Some(ClientPath::Webrtc),
            "mjpeg" | "fallback" => Some(ClientPath::Mjpeg),
            _ => None,
        }
    }
}

/// The single signal sample the policy consumes. Every field is a measurement
/// the broker already has (section 6); nothing here is inferred from FPS alone.
#[derive(Debug, Clone, Copy)]
pub struct Signals {
    pub now_us: u64,
    pub frame_to_render_p95_ms: f64,
    pub fps: f64,
    pub input_ack_p95_ms: f64,
    pub frame_age_p95_ms: f64,
    pub loss_ratio: f64,
    pub rtt_ms: f64,
    pub decoder_fatal: bool,
    /// `Some(since)` while ICE has been failed; `None` when ICE is healthy.
    pub ice_failed_since_us: Option<u64>,
    pub render_failures_consecutive: u32,
    pub encoder_available: bool,
    pub broker_ready: bool,
}

impl Default for Signals {
    fn default() -> Self {
        Self {
            now_us: 0,
            frame_to_render_p95_ms: 0.0,
            fps: 0.0,
            input_ack_p95_ms: 0.0,
            frame_age_p95_ms: 0.0,
            loss_ratio: 0.0,
            rtt_ms: 0.0,
            decoder_fatal: false,
            ice_failed_since_us: None,
            render_failures_consecutive: 0,
            encoder_available: true,
            broker_ready: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum PolicyEvent {
    LadderDown { tier: u8, reason: String },
    LadderUp { tier: u8 },
    Fallback { reason: String, immediate: bool },
    UpgradeAttempt { after_cooldown_s: f64 },
    UpgradeConfirmed { healthy_windows: u32 },
    TriggerSuppressed { reason: String, pinned: String },
    StartupGate { reason: String },
}

/// Thresholds, all frozen in section 9.2. Held as a struct rather than
/// scattered literals so the adversarial matrix can tighten them without
/// touching the logic.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    pub sustained_window_us: u64,
    pub frame_to_render_p95_ms: f64,
    pub fps_min: f64,
    pub input_ack_p95_ms: f64,
    pub ice_failure_grace_us: u64,
    pub render_failures: u32,
    pub cooldown_us: u64,
    pub healthy_window_us: u64,
    pub healthy_windows_required: u32,
    pub ladder_dwell_us: u64,
    pub loss_down: f64,
    pub loss_up: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            sustained_window_us: 5_000_000,
            frame_to_render_p95_ms: 1500.0,
            fps_min: 8.0,
            input_ack_p95_ms: 2000.0,
            ice_failure_grace_us: 3_000_000,
            render_failures: 3,
            cooldown_us: 30_000_000,
            healthy_window_us: 10_000_000,
            healthy_windows_required: 2,
            ladder_dwell_us: 2_000_000,
            loss_down: 0.02,
            loss_up: 0.005,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Active {
    Webrtc,
    Mjpeg,
}

#[derive(Debug, Default, Clone)]
struct Sustained {
    since_us: Option<u64>,
}

impl Sustained {
    /// Returns true exactly once, on the tick where the condition has held for
    /// the full window.
    fn update(&mut self, now_us: u64, holding: bool, window_us: u64) -> bool {
        if !holding {
            self.since_us = None;
            return false;
        }
        match self.since_us {
            None => {
                self.since_us = Some(now_us);
                false
            }
            Some(since) => now_us.saturating_sub(since) >= window_us,
        }
    }
}

/// Frame-age budget for a rung: the sender-side age that still leaves room for
/// the path's p95 target. Exceeding it means the rung is too expensive for the
/// current path, so the ladder steps down before latency grows.
fn frame_age_budget_ms(tier: u8, path: PathType) -> f64 {
    let base = match path {
        PathType::Derp => 300.0,
        PathType::Direct => 150.0,
    };
    base * (1.0 + 0.15 * tier as f64)
}

#[derive(Debug)]
pub struct PolicyController {
    pub thresholds: Thresholds,
    pub path: PathType,
    pub tier: u8,
    pub override_path: ClientPath,
    active: Active,
    fallback_reason: String,
    cooldown_until_us: Option<u64>,
    upgrade_attempted: bool,
    healthy: Sustained,
    healthy_windows: u32,
    last_ladder_change_us: u64,
    ladder_healthy: Sustained,
    trig_frame_to_render: Sustained,
    trig_fps: Sustained,
    trig_input_ack: Sustained,
    pub fallbacks: u64,
    pub upgrades: u64,
    pub frame_age_ring: Ring,
    pub loss_ring: Ring,
    pub decision_events: Vec<PolicyEvent>,
}

impl Default for PolicyController {
    fn default() -> Self {
        Self::new(ClientPath::Auto)
    }
}

impl PolicyController {
    pub fn new(override_path: ClientPath) -> Self {
        Self {
            thresholds: Thresholds::default(),
            path: PathType::Derp,
            tier: 0,
            override_path,
            active: Active::Webrtc,
            fallback_reason: String::new(),
            cooldown_until_us: None,
            upgrade_attempted: false,
            healthy: Sustained::default(),
            healthy_windows: 0,
            last_ladder_change_us: 0,
            ladder_healthy: Sustained::default(),
            trig_frame_to_render: Sustained::default(),
            trig_fps: Sustained::default(),
            trig_input_ack: Sustained::default(),
            fallbacks: 0,
            upgrades: 0,
            frame_age_ring: Ring::new(2048),
            loss_ring: Ring::new(2048),
            decision_events: Vec::new(),
        }
    }

    pub fn with_thresholds(mut self, t: Thresholds) -> Self {
        self.thresholds = t;
        self
    }

    /// Effective client path after applying the override. `auto` follows the
    /// state machine; the other two pin the path in both directions.
    pub fn effective_path(&self) -> ClientPath {
        match self.override_path {
            ClientPath::Auto => match self.active {
                Active::Webrtc => ClientPath::Webrtc,
                Active::Mjpeg => ClientPath::Mjpeg,
            },
            pinned => pinned,
        }
    }

    pub fn is_on_webrtc(&self) -> bool {
        self.effective_path() == ClientPath::Webrtc
    }

    pub fn fallback_reason(&self) -> &str {
        &self.fallback_reason
    }

    pub fn healthy_windows(&self) -> u32 {
        self.healthy_windows
    }

    pub fn cooldown_remaining_s(&self, now_us: u64) -> f64 {
        match self.cooldown_until_us {
            Some(until) if until > now_us => (until - now_us) as f64 / 1_000_000.0,
            _ => 0.0,
        }
    }

    pub fn set_override(&mut self, p: ClientPath, now_us: u64) {
        if self.override_path == p {
            return;
        }
        self.override_path = p;
        self.upgrade_attempted = false;
        match p {
            ClientPath::Mjpeg => {
                self.active = Active::Mjpeg;
                self.cooldown_until_us = None;
                self.fallback_reason = "override:mjpeg".to_string();
            }
            ClientPath::Webrtc => {
                self.active = Active::Webrtc;
                self.cooldown_until_us = None;
                self.fallback_reason.clear();
            }
            ClientPath::Auto => {
                // Returning to auto must not silently re-enable a primary path
                // that just failed: the cooldown is re-armed so the machine has to
                // earn its way back.
                self.cooldown_until_us = if self.active == Active::Mjpeg {
                    Some(now_us + self.thresholds.cooldown_us)
                } else {
                    self.cooldown_until_us
                };
            }
        }
    }

    /// One policy tick. Returns the events emitted on this tick, and the
    /// controller's state is advanced in place.
    pub fn tick(&mut self, s: &Signals) -> Vec<PolicyEvent> {
        self.decision_events.clear();

        self.frame_age_ring.add(s.frame_age_p95_ms);
        self.loss_ring.add(s.loss_ratio);

        if !s.encoder_available || !s.broker_ready {
            // Startup gating (section 10): a broken encoder or an unready broker
            // must come up on MJPEG with a clear reason, not on a dead pipeline.
            if self.override_path == ClientPath::Auto && self.active != Active::Mjpeg {
                self.active = Active::Mjpeg;
            }
            let reason = if !s.encoder_available {
                "encoder_unavailable"
            } else {
                "broker_not_ready"
            };
            if self.fallback_reason.is_empty() {
                self.fallback_reason = reason.to_string();
                self.push(PolicyEvent::StartupGate {
                    reason: reason.to_string(),
                });
            }
            return self.decision_events.clone();
        }

        // The ladder steps down first, on its own faster timescale; the
        // sustained-window triggers accumulate in parallel (section 9.2).
        self.step_ladder(s);

        let immediate = self.immediate_trigger(s);
        let sustained = self.sustained_trigger(s);

        if let Some(reason) = immediate.or(sustained) {
            match self.override_path {
                ClientPath::Webrtc => {
                    // Pinned to WebRTC: report the trigger, do not act on it, so
                    // a test can measure the pinned path under load.
                    self.push(PolicyEvent::TriggerSuppressed {
                        reason: reason.clone(),
                        pinned: "webrtc".to_string(),
                    });
                }
                ClientPath::Mjpeg => {
                    self.push(PolicyEvent::TriggerSuppressed {
                        reason: reason.clone(),
                        pinned: "mjpeg".to_string(),
                    });
                }
                ClientPath::Auto => {
                    let was_webrtc = self.active == Active::Webrtc;
                    self.active = Active::Mjpeg;
                    self.fallback_reason = reason.clone();
                    self.cooldown_until_us = Some(s.now_us + self.thresholds.cooldown_us);
                    self.upgrade_attempted = false;
                    self.healthy_windows = 0;
                    self.healthy = Sustained::default();
                    if was_webrtc {
                        self.fallbacks += 1;
                    }
                    self.push(PolicyEvent::Fallback {
                        reason,
                        immediate: immediate_is_immediate(&s, &self.thresholds),
                    });
                }
            }
            return self.decision_events.clone();
        }

        if self.override_path == ClientPath::Auto {
            self.maybe_upgrade(s);
        }

        self.decision_events.clone()
    }

    fn push(&mut self, e: PolicyEvent) {
        self.decision_events.push(e);
    }

    fn step_ladder(&mut self, s: &Signals) {
        let budget = frame_age_budget_ms(self.tier, self.path);
        let congested = s.frame_age_p95_ms > budget
            || s.loss_ratio > self.thresholds.loss_down
            || s.frame_to_render_p95_ms > self.thresholds.frame_to_render_p95_ms * 0.6;

        let roomy = s.frame_age_p95_ms < budget * 0.6
            && s.loss_ratio < self.thresholds.loss_up
            && s.frame_to_render_p95_ms < self.thresholds.frame_to_render_p95_ms * 0.3;

        let dwell_ok = s.now_us.saturating_sub(self.last_ladder_change_us)
            >= self.thresholds.ladder_dwell_us;

        if congested && self.tier < BOTTOM_TIER && dwell_ok {
            self.tier += 1;
            self.last_ladder_change_us = s.now_us;
            self.ladder_healthy = Sustained::default();
            let reason = if s.loss_ratio > self.thresholds.loss_down {
                "loss"
            } else if s.frame_age_p95_ms > budget {
                "frame_age"
            } else {
                "frame_to_render"
            };
            self.push(PolicyEvent::LadderDown {
                tier: self.tier,
                reason: reason.to_string(),
            });
            return;
        }

        // Recovery walks back up only after the healthy window, and never more
        // than one rung per window.
        if self.ladder_healthy.update(
            s.now_us,
            roomy,
            self.thresholds.sustained_window_us,
        ) && self.tier > 0
        {
            self.tier -= 1;
            self.last_ladder_change_us = s.now_us;
            self.ladder_healthy = Sustained::default();
            self.push(PolicyEvent::LadderUp { tier: self.tier });
        }
    }

    /// Immediate triggers (section 9.2). These are unambiguous and switch now.
    fn immediate_trigger(&self, s: &Signals) -> Option<String> {
        if s.decoder_fatal {
            return Some("decoder_fatal".to_string());
        }
        if let Some(since) = s.ice_failed_since_us {
            if s.now_us.saturating_sub(since) > self.thresholds.ice_failure_grace_us {
                return Some("ice_failure".to_string());
            }
        }
        if s.render_failures_consecutive >= self.thresholds.render_failures {
            return Some("render_failures".to_string());
        }
        None
    }

    /// Sustained-window triggers (section 9.2): each condition must hold
    /// continuously for the window before it fires.
    fn sustained_trigger(&mut self, s: &Signals) -> Option<String> {
        let w = self.thresholds.sustained_window_us;
        let a = self
            .trig_frame_to_render
            .update(s.now_us, s.frame_to_render_p95_ms > self.thresholds.frame_to_render_p95_ms, w);
        let b = self
            .trig_fps
            .update(s.now_us, s.fps < self.thresholds.fps_min, w);
        let c = self
            .trig_input_ack
            .update(s.now_us, s.input_ack_p95_ms > self.thresholds.input_ack_p95_ms, w);

        if a {
            return Some("frame_to_render_p95".to_string());
        }
        if b {
            return Some("fps_below_floor".to_string());
        }
        if c {
            return Some("input_ack_p95".to_string());
        }
        None
    }

    fn maybe_upgrade(&mut self, s: &Signals) {
        let in_cooldown = self.cooldown_remaining_s(s.now_us) > 0.0;
        if in_cooldown {
            return;
        }
        if self.active == Active::Webrtc {
            return;
        }
        if !self.upgrade_attempted {
            self.upgrade_attempted = true;
            self.push(PolicyEvent::UpgradeAttempt {
                after_cooldown_s: self.thresholds.cooldown_us as f64 / 1_000_000.0,
            });
        }

        // Recovery requires two consecutive 10 s healthy windows.
        let healthy_now = s.frame_to_render_p95_ms <= self.thresholds.frame_to_render_p95_ms * 0.5
            && s.fps >= self.thresholds.fps_min
            && s.input_ack_p95_ms <= self.thresholds.input_ack_p95_ms * 0.5;
        let window_done = self
            .healthy
            .update(s.now_us, healthy_now, self.thresholds.healthy_window_us);
        if window_done {
            self.healthy_windows += 1;
            self.healthy = Sustained::default();
            if self.healthy_windows >= self.thresholds.healthy_windows_required {
                self.active = Active::Webrtc;
                self.fallback_reason.clear();
                self.upgrades += 1;
                self.push(PolicyEvent::UpgradeConfirmed {
                    healthy_windows: self.healthy_windows,
                });
            }
        }
    }
}

fn immediate_is_immediate(s: &Signals, t: &Thresholds) -> bool {
    if s.decoder_fatal {
        return true;
    }
    if let Some(since) = s.ice_failed_since_us {
        if s.now_us.saturating_sub(since) > t.ice_failure_grace_us {
            return true;
        }
    }
    s.render_failures_consecutive >= t.render_failures
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy(now_us: u64) -> Signals {
        Signals {
            now_us,
            frame_to_render_p95_ms: 80.0,
            fps: 20.0,
            input_ack_p95_ms: 50.0,
            frame_age_p95_ms: 40.0,
            loss_ratio: 0.0,
            rtt_ms: 30.0,
            ..Signals::default()
        }
    }

    #[test]
    fn ladder_table_encodes_quality_then_resolution_then_fps() {
        // Quality must fall monotonically, resolution must not rise, and the fps
        // cap must not rise either: that is the whole ordering guarantee.
        for w in LADDER.windows(2) {
            assert!(w[1].quality <= w[0].quality, "quality rises at tier {}", w[1].tier);
            assert!(w[1].scale <= w[0].scale, "resolution rises at tier {}", w[1].tier);
            let a = if w[0].fps_cap == 0 { u16::MAX } else { w[0].fps_cap };
            let b = if w[1].fps_cap == 0 { u16::MAX } else { w[1].fps_cap };
            assert!(b <= a, "fps cap rises at tier {}", w[1].tier);
        }
        assert_eq!(LADDER[LADDER.len() - 1].fps_cap, FPS_FLOOR);
    }

    #[test]
    fn fps_cap_never_exceeds_path_cap() {
        for tier in 0..=BOTTOM_TIER {
            assert!(effective_fps_cap(tier, PathType::Derp) <= PathType::Derp.fps_cap());
            assert!(effective_fps_cap(tier, PathType::Direct) <= PathType::Direct.fps_cap());
        }
        assert_eq!(effective_fps_cap(0, PathType::Derp), 12);
        assert_eq!(effective_fps_cap(0, PathType::Direct), 24);
        assert_eq!(effective_fps_cap(BOTTOM_TIER, PathType::Direct), 6);
    }

    #[test]
    fn ladder_steps_down_in_order_under_sustained_congestion() {
        let mut c = PolicyController::new(ClientPath::Webrtc);
        let mut now = 1_000_000u64;
        let mut order = Vec::new();
        for _ in 0..12 {
            now += 3_000_000;
            let mut s = healthy(now);
            s.frame_age_p95_ms = 5000.0;
            s.loss_ratio = 0.2;
            let evs = c.tick(&s);
            for e in evs {
                if let PolicyEvent::LadderDown { tier, .. } = e {
                    order.push(tier);
                }
            }
        }
        assert_eq!(order, vec![1, 2, 3, 4, 5], "ladder walks down one rung at a time");
        // Bottomed out: it holds the floor rather than stepping past it, and it
        // does not silently start buffering.
        assert_eq!(c.tier, BOTTOM_TIER);
    }

    #[test]
    fn degradation_order_is_quality_then_resolution_then_fps() {
        // Tiers 0->2 shed quality only; 2->3 starts shedding resolution; fps only
        // drops at the last two rungs. Assert the transitions, not just the table.
        assert_eq!((rung(0).quality, rung(0).scale, effective_fps_cap(0, PathType::Direct)), (60, 1.00, 24));
        assert_eq!((rung(2).quality, rung(2).scale, effective_fps_cap(2, PathType::Direct)), (42, 0.85, 24));
        assert_eq!((rung(3).quality, rung(3).scale, effective_fps_cap(3, PathType::Direct)), (35, 0.70, 12));
        assert_eq!((rung(5).quality, rung(5).scale, effective_fps_cap(5, PathType::Direct)), (25, 0.50, 6));
    }

    #[test]
    fn ladder_recovers_only_after_a_healthy_window() {
        let mut c = PolicyController::new(ClientPath::Webrtc);
        let mut now = 0u64;
        c.tier = 3;
        c.last_ladder_change_us = now;

        // Brief calm must not step back up.
        for _ in 0..4 {
            now += 1_000_000;
            let evs = c.tick(&healthy(now));
            assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::LadderUp { .. })));
        }
        assert_eq!(c.tier, 3);

        // A full healthy window does.
        now += 6_000_000;
        let evs = c.tick(&healthy(now));
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::LadderUp { tier: 2 })));
        assert_eq!(c.tier, 2);
    }

    #[test]
    fn ladder_does_not_oscillate_within_dwell() {
        let mut c = PolicyController::new(ClientPath::Webrtc);
        let mut now = 0u64;
        let mut downs = 0;
        for i in 0..10 {
            now += 100_000;
            let mut s = healthy(now);
            s.frame_age_p95_ms = 5000.0;
            if i % 2 == 0 {
                s.frame_age_p95_ms = 10.0; // flaps back to calm
                s.loss_ratio = 0.0;
            } else {
                s.loss_ratio = 0.2;
            }
            for e in c.tick(&s) {
                if matches!(e, PolicyEvent::LadderDown { .. }) {
                    downs += 1;
                }
            }
        }
        // 1 s of flapping inside a 2 s dwell: at most one step, never a cascade.
        assert!(downs <= 1, "expected at most one ladder step, saw {}", downs);
    }

    #[test]
    fn sustained_frame_to_render_trigger_needs_the_full_window() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut now = 0u64;
        for _ in 0..5 {
            now += 900_000;
            let mut s = healthy(now);
            s.frame_to_render_p95_ms = 2000.0;
            let evs = c.tick(&s);
            assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::Fallback { .. })), "fired early at {:?}", evs);
        }
        now += 2_000_000; // crosses the 5 s window measured from the first bad tick
        let evs = c.tick(&healthy(now).with_frame_to_render(2000.0));
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::Fallback { ref reason, .. } if reason == "frame_to_render_p95")));
    }

    #[test]
    fn sustained_fps_trigger_fires_at_threshold() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut now = 0u64;
        let mut fired = false;
        for _ in 0..12 {
            now += 500_000;
            let mut s = healthy(now);
            s.fps = 7.9;
            for e in c.tick(&s) {
                if matches!(e, PolicyEvent::Fallback { ref reason, .. } if reason == "fps_below_floor") {
                    fired = true;
                }
            }
        }
        assert!(fired, "fps below 8 for 5 s must trigger fallback");
    }

    #[test]
    fn sustained_input_ack_trigger_fires_at_threshold() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut now = 0u64;
        let mut fired = false;
        for _ in 0..12 {
            now += 500_000;
            let mut s = healthy(now);
            s.input_ack_p95_ms = 2100.0;
            for e in c.tick(&s) {
                if matches!(e, PolicyEvent::Fallback { ref reason, .. } if reason == "input_ack_p95") {
                    fired = true;
                }
            }
        }
        assert!(fired, "INPUT_ACK p95 above 2 s for 5 s must trigger fallback");
    }

    #[test]
    fn healthy_fps_alone_does_not_trigger() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut now = 0u64;
        for _ in 0..40 {
            now += 500_000;
            let evs = c.tick(&healthy(now));
            assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::Fallback { .. })));
        }
        assert!(c.is_on_webrtc());
        assert_eq!(c.fallbacks, 0);
    }

    #[test]
    fn decoder_fatal_is_immediate() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut s = healthy(1_000_000);
        s.decoder_fatal = true;
        let evs = c.tick(&s);
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::Fallback { ref reason, immediate } if reason == "decoder_fatal" && *immediate)));
        assert_eq!(c.fallback_reason(), "decoder_fatal");
        assert!(!c.is_on_webrtc());
    }

    #[test]
    fn ice_failure_needs_three_seconds() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut s = healthy(0);
        s.ice_failed_since_us = Some(0);

        s.now_us = 2_500_000;
        let evs = c.tick(&s);
        assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::Fallback { .. })), "ICE failure under 3 s must not switch");

        s.now_us = 3_500_000;
        let evs = c.tick(&s);
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::Fallback { ref reason, immediate } if reason == "ice_failure" && *immediate)));
    }

    #[test]
    fn three_render_failures_is_immediate() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut s = healthy(0);
        s.render_failures_consecutive = 2;
        let evs = c.tick(&s);
        assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::Fallback { .. })));

        s.render_failures_consecutive = 3;
        s.now_us = 100_000;
        let evs = c.tick(&s);
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::Fallback { ref reason, .. } if reason == "render_failures")));
    }

    #[test]
    fn cooldown_is_enforced_then_two_healthy_windows_restore() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let t = Thresholds::default();

        let mut s = healthy(0);
        s.decoder_fatal = true;
        c.tick(&s);
        assert!(!c.is_on_webrtc());
        assert!((c.cooldown_remaining_s(0) - 30.0).abs() < 0.001);

        // Inside the cooldown, even a healthy path must not upgrade.
        let mut now = 0u64;
        for _ in 0..29 {
            now += 1_000_000;
            c.tick(&healthy(now));
            assert!(!c.is_on_webrtc(), "upgraded during cooldown at {}s", now / 1_000_000);
        }

        // After the cooldown, an attempt is announced.
        now += 2_000_000;
        let evs = c.tick(&healthy(now));
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::UpgradeAttempt { .. })));

        // One healthy window is not enough.
        for _ in 0..10 {
            now += 1_000_000;
            c.tick(&healthy(now));
        }
        assert!(!c.is_on_webrtc(), "one healthy window must not restore the path");
        assert_eq!(c.healthy_windows(), 1);

        // Two consecutive windows restore it.
        for _ in 0..11 {
            now += 1_000_000;
            c.tick(&healthy(now));
        }
        assert!(c.is_on_webrtc());
        assert_eq!(c.upgrades, 1);
        assert_eq!(c.healthy_windows(), 2);
        assert!(c.cooldown_remaining_s(now) <= t.cooldown_us as f64 / 1_000_000.0);
    }

    #[test]
    fn unhealthy_tick_resets_the_healthy_window() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut s = healthy(0);
        s.decoder_fatal = true;
        c.tick(&s);

        let mut now = 31_000_000u64;
        for _ in 0..9 {
            now += 1_000_000;
            c.tick(&healthy(now));
        }
        assert_eq!(c.healthy_windows(), 0);

        // A single bad tick in the middle must restart the window, not complete it.
        now += 1_000_000;
        let mut bad = healthy(now);
        bad.frame_to_render_p95_ms = 3000.0;
        c.tick(&bad);

        for _ in 0..9 {
            now += 1_000_000;
            c.tick(&healthy(now));
        }
        assert_eq!(c.healthy_windows(), 0, "the bad tick must have reset the window");

        for _ in 0..2 {
            now += 1_000_000;
            c.tick(&healthy(now));
        }
        assert_eq!(c.healthy_windows(), 1);
    }

    #[test]
    fn override_mjpeg_pins_the_path() {
        let mut c = PolicyController::new(ClientPath::Mjpeg);
        let evs = c.tick(&healthy(1_000_000));
        assert!(!c.is_on_webrtc());
        assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::UpgradeAttempt { .. })));
        for i in 0..60 {
            c.tick(&healthy(1_000_000 + i * 1_000_000));
        }
        assert!(!c.is_on_webrtc(), "mjpeg override must not auto-upgrade");
    }

    #[test]
    fn override_webrtc_pins_the_path_but_reports_triggers() {
        let mut c = PolicyController::new(ClientPath::Webrtc);
        let mut s = healthy(0);
        s.decoder_fatal = true;
        let evs = c.tick(&s);
        assert!(c.is_on_webrtc(), "webrtc override must keep the path");
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::TriggerSuppressed { ref pinned, .. } if pinned == "webrtc")));
        assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::Fallback { .. })));
    }

    #[test]
    fn auto_starts_on_the_primary_path() {
        // WebRTC-first: Auto is optimistic, and only the startup gate (or a
        // trigger) moves it off the primary path.
        let c = PolicyController::new(ClientPath::Auto);
        assert_eq!(c.effective_path(), ClientPath::Webrtc);
        assert!(c.is_on_webrtc());
    }

    #[test]
    fn override_transitions_are_honored() {
        let mut c = PolicyController::new(ClientPath::Auto);
        assert!(c.is_on_webrtc());

        c.set_override(ClientPath::Mjpeg, 0);
        assert_eq!(c.effective_path(), ClientPath::Mjpeg);
        assert_eq!(c.fallback_reason(), "override:mjpeg");

        c.set_override(ClientPath::Webrtc, 0);
        assert_eq!(c.effective_path(), ClientPath::Webrtc);

        // Pinning WebRTC on a healthy machine needs no cooldown.
        c.set_override(ClientPath::Auto, 0);
        assert_eq!(c.effective_path(), ClientPath::Webrtc);
        assert_eq!(c.cooldown_remaining_s(0), 0.0);
    }

    #[test]
    fn returning_to_auto_from_a_fallback_re_arms_the_cooldown() {
        let mut c = PolicyController::new(ClientPath::Auto);
        // Force a real fallback so the machine is on MJPEG for a reason.
        let mut s = healthy(0);
        s.decoder_fatal = true;
        c.tick(&s);
        assert!(!c.is_on_webrtc());

        // Pin MJPEG, then hand control back. The primary path must not be
        // re-enabled silently; the cooldown is re-armed.
        c.set_override(ClientPath::Mjpeg, 0);
        c.set_override(ClientPath::Auto, 0);
        assert!(!c.is_on_webrtc());
        assert_eq!(
            c.cooldown_remaining_s(0),
            Thresholds::default().cooldown_us as f64 / 1_000_000.0
        );
    }

    #[test]
    fn startup_gate_falls_back_when_encoder_is_missing() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut s = healthy(0);
        s.encoder_available = false;
        let evs = c.tick(&s);
        assert!(!c.is_on_webrtc());
        assert!(evs.iter().any(|e| matches!(e, PolicyEvent::StartupGate { ref reason } if reason == "encoder_unavailable")));
        // It must not thrash the reason on every tick.
        let evs2 = c.tick(&s);
        assert!(evs2.is_empty());
    }

    #[test]
    fn startup_gate_falls_back_when_broker_is_not_ready() {
        let mut c = PolicyController::new(ClientPath::Auto);
        let mut s = healthy(0);
        s.broker_ready = false;
        c.tick(&s);
        assert!(!c.is_on_webrtc());
        assert_eq!(c.fallback_reason(), "broker_not_ready");
    }

    #[test]
    fn path_classification_maps_via_strings() {
        assert_eq!(PathType::from_via("DERP(sin)"), PathType::Derp);
        assert_eq!(PathType::from_via("derp"), PathType::Derp);
        assert_eq!(PathType::from_via("DIRECT 100.64.0.1"), PathType::Direct);
        assert_eq!(PathType::from_via(""), PathType::Direct);
        assert_eq!(ClientPath::parse("webrtc"), Some(ClientPath::Webrtc));
        assert_eq!(ClientPath::parse("MJPEG"), Some(ClientPath::Mjpeg));
        assert_eq!(ClientPath::parse("nonsense"), None);
    }

    #[test]
    fn bottomed_out_ladder_with_sustained_trigger_falls_back() {
        // The precedence rule: a bottomed-out ladder must not hold the floor
        // forever while the user-visible latency is still bad.
        let mut c = PolicyController::new(ClientPath::Auto);
        c.tier = BOTTOM_TIER;
        let mut now = 0u64;
        let mut fired = false;
        for _ in 0..12 {
            now += 500_000;
            let mut s = healthy(now);
            s.frame_to_render_p95_ms = 1600.0;
            s.fps = 6.0;
            for e in c.tick(&s) {
                if matches!(e, PolicyEvent::Fallback { .. }) {
                    fired = true;
                }
            }
        }
        assert!(fired, "bottomed-out ladder plus sustained trigger must fall back");
    }

    #[test]
    fn a_bottomed_out_ladder_alone_does_not_fall_back() {
        // Holding the floor is correct while the SLO is still met. The bottom
        // rung's *cap* is 6 fps, but the measured rate here sits above the 8 fps
        // trigger threshold, so nothing escalates: this is the distinction
        // between a cap (a ceiling belief) and an achieved rate.
        let mut c = PolicyController::new(ClientPath::Auto);
        c.tier = BOTTOM_TIER;
        c.last_ladder_change_us = 0;
        let mut now = 0u64;
        for _ in 0..20 {
            now += 500_000;
            let mut s = healthy(now);
            s.fps = 9.5;
            s.frame_to_render_p95_ms = 200.0;
            let evs = c.tick(&s);
            assert!(evs.iter().all(|e| !matches!(e, PolicyEvent::Fallback { .. })));
        }
        assert!(c.is_on_webrtc());
        assert_eq!(c.fallbacks, 0);
    }

    #[test]
    fn bottom_rung_at_the_cap_rate_trips_the_fps_trigger() {
        // The same rung, but actually running at its 6 fps cap: below the 8 fps
        // floor, so the sustained trigger must fire. This is the case section 9.2
        // calls out explicitly.
        let mut c = PolicyController::new(ClientPath::Auto);
        c.tier = BOTTOM_TIER;
        let mut now = 0u64;
        let mut fired = false;
        for _ in 0..12 {
            now += 500_000;
            let mut s = healthy(now);
            s.fps = 6.0;
            s.frame_to_render_p95_ms = 200.0;
            for e in c.tick(&s) {
                if matches!(e, PolicyEvent::Fallback { .. }) {
                    fired = true;
                }
            }
        }
        assert!(fired, "a bottomed-out ladder at 6 fps must fall back, not hold the floor");
    }

    impl Signals {
        fn with_frame_to_render(mut self, ms: f64) -> Self {
            self.frame_to_render_p95_ms = ms;
            self
        }
    }
}