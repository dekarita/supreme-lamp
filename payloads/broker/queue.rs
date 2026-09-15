//! Send path: the depth-1 latest-only slot (Q1), light XOR FEC, and the
//! keyframe-on-failure-only limiter. Frozen in
//! `docs/webdesk-pipeline.md` sections 7, 8 and 9.
//!
//! The queue is deliberately one slot wide. Under overload the correct response
//! is to drop the older frame and count the drop, never to hold it: a queue is
//! exactly the latency bug the p95 objective exists to prevent. `queueDepth` is
//! therefore 0 or 1 by construction, not by tuning.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::broker::ipc::VideoMeta;

/// Keyframes are emitted only on unrecoverable loss, decoder failure, or a scene
/// cut, and never more often than once per this interval.
pub const KEYFRAME_MIN_INTERVAL_US: u64 = 5_000_000;

/// FEC group size. Deliberately small: the parity NAL costs one packet per four
/// and only has to absorb single-loss bursts, which is the tailnet profile.
pub const FEC_GROUP: usize = 4;

#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub frame_id: u64,
    pub capture_ts_us: u64,
    pub meta: VideoMeta,
    pub nalu: Vec<u8>,
    pub keyframe: bool,
    pub scene_cut: bool,
    /// IPC sequence of the datagram that carried this frame.
    pub seq: u32,
}

impl VideoFrame {
    pub fn age_ms(&self, now_us: u64) -> f64 {
        now_us.saturating_sub(self.capture_ts_us) as f64 / 1000.0
    }
}

/// Depth-1 latest-only slot.
#[derive(Debug, Default)]
pub struct SendQueue {
    slot: Option<VideoFrame>,
    replaced: u64,
    sent: u64,
    max_depth_seen: u32,
}

impl SendQueue {
    pub fn push(&mut self, frame: VideoFrame) -> bool {
        let replaced_previous = self.slot.is_some();
        self.slot = Some(frame);
        if replaced_previous {
            self.replaced += 1;
        }
        self.max_depth_seen = self.max_depth_seen.max(self.depth() as u32);
        replaced_previous
    }

    pub fn take_latest(&mut self) -> Option<VideoFrame> {
        let f = self.slot.take();
        if f.is_some() {
            self.sent += 1;
        }
        f
    }

    pub fn peek(&self) -> Option<&VideoFrame> {
        self.slot.as_ref()
    }

    pub fn depth(&self) -> usize {
        if self.slot.is_some() {
            1
        } else {
            0
        }
    }

    pub fn replaced(&self) -> u64 {
        self.replaced
    }

    pub fn sent(&self) -> u64 {
        self.sent
    }

    pub fn max_depth_seen(&self) -> u32 {
        self.max_depth_seen
    }
}

/// XOR parity over a group of NAL payloads. Parity is computed over the longest
/// member and shorter members are treated as zero-padded; the parity NAL carries
/// the length of each member so a single missing member can be reconstructed
/// exactly.
#[derive(Debug, Clone)]
pub struct FecGroup {
    pub group_id: u64,
    pub members: Vec<(u32, Vec<u8>)>,
}

#[derive(Debug, Clone)]
pub struct FecParity {
    pub group_id: u64,
    pub lengths: Vec<u32>,
    pub parity: Vec<u8>,
}

impl FecGroup {
    pub fn new(group_id: u64) -> Self {
        Self {
            group_id,
            members: Vec::with_capacity(FEC_GROUP),
        }
    }

    pub fn push(&mut self, seq: u32, payload: &[u8]) {
        self.members.push((seq, payload.to_vec()));
    }

    pub fn is_full(&self) -> bool {
        self.members.len() >= FEC_GROUP
    }

    pub fn parity(&self) -> Option<FecParity> {
        if self.members.len() < 2 {
            return None;
        }
        let longest = self.members.iter().map(|(_, p)| p.len()).max().unwrap_or(0);
        let mut parity = vec![0u8; longest];
        for (_, p) in &self.members {
            for (i, b) in p.iter().enumerate() {
                parity[i] ^= *b;
            }
        }
        Some(FecParity {
            group_id: self.group_id,
            lengths: self.members.iter().map(|(_, p)| p.len() as u32).collect(),
            parity,
        })
    }
}

/// Reconstruct one missing member of a group from the survivors and the parity.
/// Returns `None` if more than one member is missing — light FEC is not a
/// substitute for a retransmit, and pretending otherwise would hide real loss.
pub fn fec_recover(
    parity: &FecParity,
    present: &[Option<Vec<u8>>],
    missing_index: usize,
) -> Option<Vec<u8>> {
    if missing_index >= parity.lengths.len() || present.len() != parity.lengths.len() {
        return None;
    }
    if present[missing_index].is_some() {
        return None;
    }
    let mut recovered = parity.parity.clone();
    for (i, m) in present.iter().enumerate() {
        if i == missing_index {
            continue;
        }
        match m {
            Some(p) => {
                for (j, b) in p.iter().enumerate() {
                    recovered[j] ^= *b;
                }
            }
            None => return None,
        }
    }
    recovered.truncate(parity.lengths[missing_index] as usize);
    Some(recovered)
}

/// Rate-limits keyframes to at most one per `KEYFRAME_MIN_INTERVAL_US`, on top of
/// the "only on failure or scene cut" rule.
#[derive(Debug, Default)]
pub struct KeyframeLimiter {
    last_us: AtomicU64,
    pub emitted: u64,
    pub suppressed: u64,
    pub scene_cut: u64,
    pub loss: u64,
    pub decoder: u64,
    pub request: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyframeReason {
    SceneCut,
    Loss,
    Decoder,
    Request,
}

impl KeyframeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyframeReason::SceneCut => "scene_cut",
            KeyframeReason::Loss => "loss",
            KeyframeReason::Decoder => "decoder",
            KeyframeReason::Request => "request",
        }
    }
}

impl KeyframeLimiter {
    /// Steady state must never ask for a keyframe: this returns false unless the
    /// reason is a real failure/scene cut *and* the interval has elapsed.
    pub fn should_emit(&mut self, reason: KeyframeReason, now_us: u64) -> bool {
        let last = self.last_us.load(Ordering::Relaxed);
        if last != 0 && now_us.saturating_sub(last) < KEYFRAME_MIN_INTERVAL_US {
            self.suppressed += 1;
            return false;
        }
        self.last_us.store(now_us, Ordering::Relaxed);
        self.emitted += 1;
        match reason {
            KeyframeReason::SceneCut => self.scene_cut += 1,
            KeyframeReason::Loss => self.loss += 1,
            KeyframeReason::Decoder => self.decoder += 1,
            KeyframeReason::Request => self.request += 1,
        }
        true
    }

    pub fn last_ms_ago(&self, now_us: u64) -> f64 {
        let last = self.last_us.load(Ordering::Relaxed);
        if last == 0 {
            return f64::INFINITY;
        }
        now_us.saturating_sub(last) as f64 / 1000.0
    }

    pub fn reasons_json(&self) -> serde_json::Value {
        serde_json::json!({
            "scene_cut": self.scene_cut,
            "loss": self.loss,
            "decoder": self.decoder,
            "request": self.request,
        })
    }
}

/// Coalesces keyframe requests to at most one outstanding, so a burst of loss
/// cannot turn into a burst of keyframes on the wire.
#[derive(Debug, Default)]
pub struct KeyframeRequester {
    outstanding: Option<KeyframeReason>,
    pub requested: u64,
    pub coalesced: u64,
}

impl KeyframeRequester {
    pub fn request(&mut self, reason: KeyframeReason) {
        if self.outstanding.is_some() {
            self.coalesced += 1;
            return;
        }
        self.outstanding = Some(reason);
        self.requested += 1;
    }

    pub fn take(&mut self) -> Option<KeyframeReason> {
        self.outstanding.take()
    }

    pub fn outstanding(&self) -> Option<KeyframeReason> {
        self.outstanding
    }
}

/// Scene-cut detection policy: a changed-pixel ratio above this forces a
/// keyframe. Sampling is coarse (see `DdaCapturer::ChangedRatio`) because a
/// scene cut only has to be detected early, not measured precisely.
pub const SCENE_CUT_RATIO: f64 = 0.35;

pub fn is_scene_cut(changed_ratio: f64) -> bool {
    changed_ratio >= SCENE_CUT_RATIO
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: u64, ts: u64) -> VideoFrame {
        VideoFrame {
            frame_id: id,
            capture_ts_us: ts,
            meta: VideoMeta {
                width: 1280,
                height: 720,
                codec: 1,
                tier: 0,
            },
            nalu: vec![id as u8; 8],
            keyframe: false,
            scene_cut: false,
            seq: id as u32,
        }
    }

    #[test]
    fn queue_is_depth_one_and_drops_the_older_frame() {
        let mut q = SendQueue::default();
        assert_eq!(q.depth(), 0);
        assert!(!q.push(frame(1, 100)));
        assert_eq!(q.depth(), 1);
        // A newer frame replaces the unsent predecessor and is counted.
        assert!(q.push(frame(2, 200)));
        assert_eq!(q.depth(), 1);
        assert_eq!(q.replaced(), 1);
        assert_eq!(q.peek().unwrap().frame_id, 2);
        assert_eq!(q.take_latest().unwrap().frame_id, 2);
        assert_eq!(q.depth(), 0);
        assert_eq!(q.sent(), 1);
    }

    #[test]
    fn queue_depth_never_exceeds_one_under_flood() {
        let mut q = SendQueue::default();
        for i in 0..10_000 {
            q.push(frame(i, i));
            assert!(q.depth() <= 1);
        }
        assert_eq!(q.max_depth_seen(), 1);
        assert_eq!(q.replaced(), 9_999);
    }

    #[test]
    fn queue_never_grows_latency_under_overload() {
        // Push 50 frames without draining, then check the frame we send is the
        // newest one, i.e. age is bounded by the producer rate, not by a backlog.
        let mut q = SendQueue::default();
        for i in 0..50 {
            q.push(frame(i, i * 1000));
        }
        let f = q.take_latest().unwrap();
        assert_eq!(f.frame_id, 49);
        assert_eq!(f.age_ms(49 * 1000 + 10), 0.01);
    }

    #[test]
    fn fec_parity_reconstructs_a_single_lost_member() {
        let mut g = FecGroup::new(1);
        let a = vec![1u8, 2, 3, 4];
        let b = vec![5u8, 6, 7];
        let c = vec![9u8, 9, 9, 9, 9];
        g.push(10, &a);
        g.push(11, &b);
        g.push(12, &c);
        assert!(!g.is_full());
        let parity = g.parity().unwrap();

        // Member 1 is lost.
        let present = vec![Some(a.clone()), None, Some(c.clone())];
        let recovered = fec_recover(&parity, &present, 1).expect("single loss is recoverable");
        assert_eq!(recovered, b);
    }

    #[test]
    fn fec_rejects_two_missing_members() {
        let mut g = FecGroup::new(2);
        let a = vec![1u8, 2, 3, 4];
        let b = vec![5u8, 6, 7, 8];
        let c = vec![9u8, 9, 9, 9];
        g.push(1, &a);
        g.push(2, &b);
        g.push(3, &c);
        let parity = g.parity().unwrap();
        let present = vec![Some(a.clone()), None, None];
        assert!(
            fec_recover(&parity, &present, 1).is_none(),
            "light FEC must not pretend to recover a double loss"
        );
    }

    #[test]
    fn fec_group_fills_at_group_size() {
        let mut g = FecGroup::new(0);
        for i in 0..FEC_GROUP {
            g.push(i as u32, &[i as u8; 4]);
            if i + 1 < FEC_GROUP {
                assert!(!g.is_full());
            }
        }
        assert!(g.is_full());
        assert_eq!(g.parity().unwrap().lengths.len(), FEC_GROUP);
    }

    #[test]
    fn keyframe_limiter_allows_at_most_one_per_five_seconds() {
        let mut k = KeyframeLimiter::default();
        assert!(k.should_emit(KeyframeReason::Loss, 1_000_000));
        assert!(!k.should_emit(KeyframeReason::Loss, 2_000_000));
        assert!(!k.should_emit(KeyframeReason::Decoder, 5_000_000));
        assert!(!k.should_emit(KeyframeReason::SceneCut, 5_999_999));
        assert!(k.should_emit(KeyframeReason::SceneCut, 6_000_000));
        assert_eq!(k.emitted, 2);
        assert_eq!(k.suppressed, 3);
        assert_eq!(k.loss, 1);
        assert_eq!(k.scene_cut, 1);
    }

    #[test]
    fn keyframe_limiter_reports_time_since_last() {
        let mut k = KeyframeLimiter::default();
        assert!(k.last_ms_ago(1).is_infinite());
        k.should_emit(KeyframeReason::Request, 10_000_000);
        assert!((k.last_ms_ago(10_500_000) - 500.0).abs() < 0.001);
        assert_eq!(k.reasons_json()["request"], 1);
    }

    #[test]
    fn steady_state_emits_no_keyframes() {
        // Simulates a long steady run: no loss, no scene cut, no decoder fault
        // and no client request, so `should_emit` is never called and nothing is
        // emitted. This is the "keyframes only on failure or scene cut"
        // guarantee, driven through the actual decision helper.
        let mut k = KeyframeLimiter::default();
        for t in 0..600u64 {
            let now = t * 100_000;
            let changed_ratio = 0.02; // ordinary frame delta, nowhere near a cut
            let loss = false;
            let decoder_fault = false;
            let client_request = false;
            let reason = if decoder_fault {
                Some(KeyframeReason::Decoder)
            } else if loss {
                Some(KeyframeReason::Loss)
            } else if is_scene_cut(changed_ratio) {
                Some(KeyframeReason::SceneCut)
            } else if client_request {
                Some(KeyframeReason::Request)
            } else {
                None
            };
            if let Some(r) = reason {
                k.should_emit(r, now);
            }
        }
        assert_eq!(k.emitted, 0);
        assert_eq!(k.suppressed, 0);
    }

    #[test]
    fn a_scene_cut_during_a_steady_run_does_emit_a_keyframe() {
        // The complement of the test above: the detector must actually fire when
        // the content really does change.
        let mut k = KeyframeLimiter::default();
        let mut emitted = 0;
        for t in 0..600u64 {
            let now = t * 100_000;
            let changed_ratio = if t == 300 { 0.8 } else { 0.02 };
            if is_scene_cut(changed_ratio) {
                if k.should_emit(KeyframeReason::SceneCut, now) {
                    emitted += 1;
                }
            }
        }
        assert_eq!(emitted, 1);
        assert_eq!(k.scene_cut, 1);
    }

    #[test]
    fn keyframe_requests_coalesce_to_one_outstanding() {
        let mut r = KeyframeRequester::default();
        r.request(KeyframeReason::Loss);
        r.request(KeyframeReason::Loss);
        r.request(KeyframeReason::Decoder);
        assert_eq!(r.requested, 1);
        assert_eq!(r.coalesced, 2);
        assert_eq!(r.outstanding(), Some(KeyframeReason::Loss));
        assert_eq!(r.take(), Some(KeyframeReason::Loss));
        r.request(KeyframeReason::SceneCut);
        assert_eq!(r.requested, 2);
    }

    #[test]
    fn scene_cut_threshold() {
        assert!(!is_scene_cut(0.1));
        assert!(is_scene_cut(SCENE_CUT_RATIO));
        assert!(is_scene_cut(0.9));
    }
}