//! Transport seam (section 11). The broker's sender is written against this
//! trait so the controller, depth-1 queue, ladder, fallback machine and
//! instrumentation are exercised unchanged by both the real WebRTC
//! implementation and the harness's loopback implementation.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::broker::ipc::CursorPos;
use crate::broker::queue::{FecParity, VideoFrame};

pub trait Transport: Send + Sync {
    /// Hand one encoded frame to the transport.
    ///
    /// Returns `false` when the transport could not take the frame (its send
    /// budget is spent, or the wire is down). The broker treats a refusal as
    /// "the newest frame is still the one worth sending", so the caller decides
    /// what to do with the frame rather than the transport queueing it. This is
    /// what keeps the pipeline latest-only end to end.
    fn send_frame(&self, frame: &VideoFrame, tier: u8) -> bool;
    fn send_fec_parity(&self, parity: &FecParity);
    fn send_cursor_pos(&self, pos: CursorPos);
    fn send_cursor_shape(&self, shape: &[u8]);
    fn send_cursor_vis(&self, visible: bool);
    /// Send a control datagram to the in-session agent.
    fn send_to_agent(&self, dgram: &[u8], peer: SocketAddr);
    fn name(&self) -> &'static str;
}

/// A datagram captured by `LoopbackTransport` for assertions.
#[derive(Debug, Clone)]
pub struct SentDatagram {
    pub msg_type: u8,
    pub seq: u32,
    pub ts_us: u64,
    pub body: Vec<u8>,
    pub bytes: usize,
}

/// In-memory transport used by the harness and the unit tests. It records what
/// the broker produced instead of putting it on a wire.
///
/// It also models send backpressure, because the depth-1 queue only *does*
/// anything when the transport is slower than the producer. That is the real
/// condition on a congested tailnet path, and a transport that always returned
/// instantly would make the queue look trivially correct without exercising the
/// replacement path at all.
#[derive(Default)]
pub struct LoopbackTransport {
    frames: Mutex<Vec<VideoFrame>>,
    parity: Mutex<Vec<FecParity>>,
    cursor_pos: Mutex<Vec<CursorPos>>,
    cursor_shape: Mutex<Vec<Vec<u8>>>,
    cursor_vis: Mutex<Vec<bool>>,
    sent: Mutex<Vec<SentDatagram>>,
    sent_bytes: AtomicU64,
    /// When set, frames are dropped to simulate a dead transport.
    pub drop_frames: std::sync::atomic::AtomicBool,
    /// Send-side rate limit (frames/second). Zero means unlimited. When the
    /// budget is spent, `send_frame` refuses the frame and the caller has to
    /// choose which one to keep.
    pub send_fps: AtomicU64,
    send_window_us: AtomicU64,
    send_window_count: AtomicU64,
    pub refused: AtomicU64,
}

impl LoopbackTransport {
    /// Limit sends to `fps` frames per second over a one-second window.
    pub fn set_send_fps(&self, fps: u64) {
        self.send_fps.store(fps, Ordering::Relaxed);
        self.send_window_us.store(0, Ordering::Relaxed);
        self.send_window_count.store(0, Ordering::Relaxed);
    }

    pub fn refused(&self) -> u64 {
        self.refused.load(Ordering::Relaxed)
    }

    fn budget_available(&self, now_us: u64) -> bool {
        let fps = self.send_fps.load(Ordering::Relaxed);
        if fps == 0 {
            return true;
        }
        let window_start = self.send_window_us.load(Ordering::Relaxed);
        if now_us.saturating_sub(window_start) >= 1_000_000 {
            self.send_window_us.store(now_us, Ordering::Relaxed);
            self.send_window_count.store(0, Ordering::Relaxed);
        }
        let count = self.send_window_count.load(Ordering::Relaxed);
        if count >= fps {
            return false;
        }
        self.send_window_count.store(count + 1, Ordering::Relaxed);
        true
    }

    pub fn frames(&self) -> Vec<VideoFrame> {
        self.frames.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn parity(&self) -> Vec<FecParity> {
        self.parity.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn cursor_pos(&self) -> Vec<CursorPos> {
        self.cursor_pos.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn cursor_shape(&self) -> Vec<Vec<u8>> {
        self.cursor_shape.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn cursor_vis(&self) -> Vec<bool> {
        self.cursor_vis.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn sent(&self) -> Vec<SentDatagram> {
        self.sent.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn sent_bytes(&self) -> u64 {
        self.sent_bytes.load(Ordering::Relaxed)
    }

    pub fn frames_sent_count(&self) -> usize {
        self.frames.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Transport for LoopbackTransport {
    fn send_frame(&self, frame: &VideoFrame, _tier: u8) -> bool {
        if self.drop_frames.load(Ordering::Relaxed) {
            self.refused.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if !self.budget_available(crate::broker::ipc::now_us()) {
            self.refused.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        self.frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(frame.clone());
        true
    }

    fn send_fec_parity(&self, parity: &FecParity) {
        self.parity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(parity.clone());
    }

    fn send_cursor_pos(&self, pos: CursorPos) {
        self.cursor_pos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(pos);
    }

    fn send_cursor_shape(&self, shape: &[u8]) {
        self.cursor_shape
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(shape.to_vec());
    }

    fn send_cursor_vis(&self, visible: bool) {
        self.cursor_vis
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(visible);
    }

    fn send_to_agent(&self, dgram: &[u8], _peer: SocketAddr) {
        self.sent_bytes
            .fetch_add(dgram.len() as u64, Ordering::Relaxed);
        if let Some((h, body)) = crate::broker::ipc::parse(dgram) {
            self.sent
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(SentDatagram {
                    msg_type: h.msg_type,
                    seq: h.seq,
                    ts_us: h.ts_us,
                    body: body.to_vec(),
                    bytes: dgram.len(),
                });
        }
    }

    fn name(&self) -> &'static str {
        "loopback"
    }
}

/// Adapter that puts broker datagrams on a real UDP socket. The socket is shared
/// with the broker's receive loop.
pub struct UdpTransport {
    socket: Arc<tokio::net::UdpSocket>,
    inner: LoopbackTransport,
}

impl UdpTransport {
    pub fn new(socket: Arc<tokio::net::UdpSocket>) -> Self {
        Self {
            socket,
            inner: LoopbackTransport::default(),
        }
    }
}

impl Transport for UdpTransport {
    fn send_frame(&self, frame: &VideoFrame, tier: u8) -> bool {
        // Frames go out over WebRTC (or the loopback transport); the UDP
        // transport only carries control traffic, so record and forward.
        self.inner.send_frame(frame, tier)
    }

    fn send_fec_parity(&self, parity: &FecParity) {
        self.inner.send_fec_parity(parity);
    }

    fn send_cursor_pos(&self, pos: CursorPos) {
        self.inner.send_cursor_pos(pos);
    }

    fn send_cursor_shape(&self, shape: &[u8]) {
        self.inner.send_cursor_shape(shape);
    }

    fn send_cursor_vis(&self, visible: bool) {
        self.inner.send_cursor_vis(visible);
    }

    fn send_to_agent(&self, dgram: &[u8], peer: SocketAddr) {
        let socket = self.socket.clone();
        let owned = dgram.to_vec();
        // Fire-and-forget: a dropped control datagram is superseded, so there is
        // no retry and no queue. try_send on the socket would need a runtime
        // handle, so the datagram is handed to the socket directly.
        let _ = socket.try_send_to(&owned, peer);
        self.inner.send_to_agent(&owned, peer);
    }

    fn name(&self) -> &'static str {
        "udp"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::ipc::VideoMeta;

    fn frame(id: u64) -> VideoFrame {
        VideoFrame {
            frame_id: id,
            capture_ts_us: 1000,
            meta: VideoMeta {
                width: 1280,
                height: 720,
                codec: 1,
                tier: 0,
            },
            nalu: vec![1, 2, 3],
            keyframe: false,
            scene_cut: false,
            seq: id as u32,
        }
    }

    #[test]
    fn loopback_records_frames_and_control() {
        let t = LoopbackTransport::default();
        t.send_frame(&frame(1), 0);
        t.send_fec_parity(&FecParity {
            group_id: 0,
            lengths: vec![1],
            parity: vec![9],
        });
        t.send_cursor_pos(CursorPos {
            x: 1,
            y: 2,
            screen_w: 3,
            screen_h: 4,
        });
        t.send_cursor_shape(&[1, 2, 3]);
        t.send_cursor_vis(true);
        assert_eq!(t.frames_sent_count(), 1);
        assert_eq!(t.parity().len(), 1);
        assert_eq!(t.cursor_pos().len(), 1);
        assert_eq!(t.cursor_shape().len(), 1);
        assert_eq!(t.cursor_vis(), vec![true]);
        assert_eq!(t.name(), "loopback");
    }

    #[test]
    fn loopback_can_simulate_a_dead_transport() {
        let t = LoopbackTransport::default();
        t.drop_frames.store(true, Ordering::Relaxed);
        t.send_frame(&frame(1), 0);
        assert_eq!(t.frames_sent_count(), 0);
    }

    #[test]
    fn loopback_parses_control_datagrams_for_assertions() {
        let t = LoopbackTransport::default();
        let body = br#"{"reason":"loss","frame_id":3}"#;
        let dgram = crate::broker::ipc::build(crate::broker::ipc::T_KEYFRAME_REQ, 0, 5, 99, body);
        t.send_to_agent(&dgram, "127.0.0.1:7411".parse().unwrap());
        let sent = t.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].msg_type, crate::broker::ipc::T_KEYFRAME_REQ);
        assert_eq!(sent[0].seq, 5);
        assert_eq!(sent[0].body, body);
        assert_eq!(t.sent_bytes(), dgram.len() as u64);
    }

    #[test]
    fn loopback_ignores_unparseable_datagrams() {
        let t = LoopbackTransport::default();
        t.send_to_agent(&[1, 2, 3], "127.0.0.1:7411".parse().unwrap());
        assert!(t.sent().is_empty());
    }
}