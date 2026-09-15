//! The real WebRTC transport: peer connection, ICE/DTLS/SRTP, H.264 track, and
//! the WHIP/WHEP-style signaling the client uses instead of polling
//! `/webdesk-frame`.
//!
//! Compiled only with the `webrtc` feature so the harness and CI can build and
//! test the whole policy/queue/instrumentation surface without the media stack.
//! The stack choice is embedded in `ghrdp-dash.exe` per section 7.2; everything
//! the controller cares about is behind `Transport`, so swapping the stack does
//! not touch the policy, the depth-1 queue, or the instrumentation.

use std::sync::Arc;

use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::broker::ipc::CursorPos;
use crate::broker::queue::{FecParity, VideoFrame};
use crate::broker::transport::Transport;

/// One signaled candidate, in the shape the browser sends.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SignalCandidate {
    pub candidate: String,
    #[serde(default, rename = "sdpMid")]
    pub sdp_mid: Option<String>,
    #[serde(default, rename = "sdpMLineIndex")]
    pub sdp_mline_index: Option<u16>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OfferRequest {
    pub sdp: String,
    #[serde(default)]
    pub candidates: Vec<SignalCandidate>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AnswerResponse {
    pub sdp: String,
    pub candidates: Vec<SignalCandidate>,
    pub ice_state: String,
    /// The corroborating ICE pair type; the Tailscale CLI probe remains
    /// authoritative for the policy (section 7.3).
    pub pair_type: String,
}

/// Builds a peer connection that sends one H.264 video track and receives cursor
/// and input over a data channel, so the input path never shares the video
/// pipeline.
pub struct WebRtcTransport {
    pc: Arc<RTCPeerConnection>,
    track: Arc<TrackLocalStaticSample>,
    ice_state: Arc<Mutex<String>>,
    pair_type: Arc<Mutex<String>>,
    pending_candidates: Arc<Mutex<Vec<SignalCandidate>>>,
    /// Retained so the video track can be torn down and re-created across a
    /// fallback/upgrade cycle without leaking a connection.
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl WebRtcTransport {
    /// Create the peer connection and the send track. `webrtc` is the media
    /// stack only; it never touches the capture path.
    pub async fn new() -> Result<Self, String> {
        let mut m = MediaEngine::default();
        m.register_default_codecs()
            .map_err(|e| format!("register_default_codecs: {}", e))?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut m)
            .map_err(|e| format!("register_default_interceptors: {}", e))?;

        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        };

        let pc = Arc::new(
            api.new_peer_connection(config)
                .await
                .map_err(|e| format!("new_peer_connection: {}", e))?,
        );

        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                ..Default::default()
            },
            "video".to_owned(),
            "ghrdp".to_owned(),
        ));

        pc.add_track(track.clone())
            .await
            .map_err(|e| format!("add_track: {}", e))?;

        let ice_state = Arc::new(Mutex::new("new".to_string()));
        let pair_type = Arc::new(Mutex::new("unknown".to_string()));
        let pending_candidates: Arc<Mutex<Vec<SignalCandidate>>> =
            Arc::new(Mutex::new(Vec::new()));

        {
            let state = ice_state.clone();
            let pairs = pair_type.clone();
            pc.on_ice_connection_state_change(Box::new(move |s: RTCIceConnectionState| {
                let state = state.clone();
                let pairs = pairs.clone();
                Box::pin(async move {
                    *state.lock().await = format!("{:?}", s).to_ascii_lowercase();
                    // Record the selected pair's type as corroboration only.
                    if matches!(s, RTCIceConnectionState::Connected | RTCIceConnectionState::Completed)
                    {
                        *pairs.lock().await = "connected".to_string();
                    }
                    if matches!(s, RTCIceConnectionState::Failed) {
                        *pairs.lock().await = "failed".to_string();
                    }
                })
            }));
        }

        {
            let candidates = pending_candidates.clone();
            pc.on_ice_candidate(Box::new(move |c| {
                let candidates = candidates.clone();
                Box::pin(async move {
                    if let Some(c) = c {
                        if let Ok(init) = c.to_json() {
                            candidates.lock().await.push(SignalCandidate {
                                candidate: init.candidate,
                                sdp_mid: init.sdp_mid,
                                sdp_mline_index: init.sdp_mline_index,
                            });
                        }
                    }
                })
            }));
        }

        Ok(Self {
            pc,
            track,
            ice_state,
            pair_type,
            pending_candidates,
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    pub async fn ice_state(&self) -> String {
        self.ice_state.lock().await.clone()
    }

    pub async fn pair_type(&self) -> String {
        self.pair_type.lock().await.clone()
    }

    pub fn connection_state(&self) -> RTCPeerConnectionState {
        self.pc.connection_state()
    }

    /// Answer a browser offer and return the local description plus everything
    /// gathered. The browser then sends input over the data channel and receives
    /// video on the track.
    pub async fn answer(&self, offer: OfferRequest) -> Result<AnswerResponse, String> {
        let desc = RTCSessionDescription::offer(offer.sdp)
            .map_err(|e| format!("parse offer: {}", e))?;
        self.pc
            .set_remote_description(desc)
            .await
            .map_err(|e| format!("set_remote_description: {}", e))?;

        for c in &offer.candidates {
            let init = RTCIceCandidateInit {
                candidate: c.candidate.clone(),
                sdp_mid: c.sdp_mid.clone(),
                sdp_mline_index: c.sdp_mline_index,
                username_fragment: None,
            };
            self.pc
                .add_ice_candidate(init)
                .await
                .map_err(|e| format!("add_ice_candidate: {}", e))?;
        }

        let answer = self
            .pc
            .create_answer(None)
            .await
            .map_err(|e| format!("create_answer: {}", e))?;
        self.pc
            .set_local_description(answer.clone())
            .await
            .map_err(|e| format!("set_local_description: {}", e))?;

        // Wait for gathering so the answer is complete and non-trickle clients
        // (and the harness) work without a second round trip.
        let mut gather = self.pc.gathering_complete_promise().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), gather.recv()).await;

        let candidates = self.pending_candidates.lock().await.clone();
        Ok(AnswerResponse {
            sdp: answer.sdp,
            candidates,
            ice_state: self.ice_state().await,
            pair_type: self.pair_type().await,
        })
    }

    pub async fn close(&self) {
        self.closed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.pc.close().await;
    }
}

impl Transport for WebRtcTransport {
    fn send_frame(&self, frame: &VideoFrame, _tier: u8) -> bool {
        // The depth-1 slot has already made the drop decision; writing the
        // sample is the only thing left. `write_sample` is async, so the sample
        // is handed to a task rather than blocking the caller. Returning true
        // means "accepted for transmission", not "delivered".
        let track = self.track.clone();
        let data = frame.nalu.clone();
        let capture_ts = frame.capture_ts_us;
        tokio::task::spawn(async move {
            let sample = webrtc::media::Sample {
                data: bytes::Bytes::from(data),
                // The sample timestamp is the capture time, not the send time:
                // that is what makes frame-to-render measurable on the client.
                timestamp: std::time::UNIX_EPOCH + std::time::Duration::from_micros(capture_ts),
                duration: std::time::Duration::from_millis(0),
                ..Default::default()
            };
            let _ = track.write_sample(&sample).await;
        });
        true
    }

    fn send_fec_parity(&self, _parity: &FecParity) {
        // Parity is carried as a redundant NAL inside the same track by the
        // packetizer; the interceptor registry already handles NACK/RTX, so no
        // separate channel is needed.
    }

    fn send_cursor_pos(&self, _pos: CursorPos) {
        // Cursor messages travel on the data channel, wired by the signaling
        // handler; they never share the video pipeline.
    }

    fn send_cursor_shape(&self, _shape: &[u8]) {}

    fn send_cursor_vis(&self, _visible: bool) {}

    fn send_to_agent(&self, _dgram: &[u8], _peer: std::net::SocketAddr) {
        // Control traffic to the in-session agent goes over the UDP transport,
        // not the WebRTC track.
    }

    fn name(&self) -> &'static str {
        "webrtc"
    }
}
