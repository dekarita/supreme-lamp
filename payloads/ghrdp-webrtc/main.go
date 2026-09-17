package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"
)

type signalMessage struct {
	Type      string  `json:"type"`
	SDP       string  `json:"sdp,omitempty"`
	Candidate string  `json:"candidate,omitempty"`
	SDPMid    *string `json:"sdpMid,omitempty"`
	SDPMLine  *uint16 `json:"sdpMLineIndex,omitempty"`
}

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var (
	activeMu     sync.Mutex
	activeCancel context.CancelFunc
)

// liveMode is the mode of the pipeline currently streaming, stored as an atomic
// pointer because handleStats/handleVersion run on other goroutines.
var liveMode atomic.Pointer[modeSpec]

func init() { liveMode.Store(&modeDefault) }

func currentModeSpec() modeSpec {
	if m := liveMode.Load(); m != nil {
		return *m
	}
	return modeDefault
}

var (
	capWv, capHv atomic.Int64
	srcWv, srcHv atomic.Int64
)

var stats struct {
	fpsEncoded   atomic.Int64
	drops        atomic.Int64
	kbpsSent     atomic.Int64
	idrCount     atomic.Int64
	startTime    time.Time
	captureMode  string
	framesSent   atomic.Int64
	bytesSent    atomic.Int64
	sizeMismatch atomic.Bool
	lastInputNs  atomic.Int64
	inputToFrame atomic.Int64
	guardTrip    atomic.Bool
}

func statsCapW() int { return int(capWv.Load()) }
func statsCapH() int { return int(capHv.Load()) }

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("ghrdp-webrtc starting")

	resolveRequiredSession()

	release, err := acquireSingleton()
	if err != nil {
		log.Printf("FATAL: %v", err)
		os.Exit(43)
	}
	defer release()

	sessionID, err = resolveSessionID()
	if err != nil {
		log.Printf("FATAL: cannot determine session id: %v", err)
		os.Exit(42)
	}
	if sessionID != requiredSessionID {
		log.Printf("FATAL: session %d != required %d - desktop capture is dead outside the interactive session; refusing to serve a black stream (exit 42)", sessionID, requiredSessionID)
		os.Exit(42)
	}
	log.Printf("session check PASS: session_id=%d (interactive)", sessionID)

	killStaleFFmpeg()

	// Detect the encoder once at boot so /version can name it before a client
	// connects; the per-stream encoder re-detects and publishes via liveEncoder.
	if enc, _ := detectHWEncoder(modeDefault); enc != "" {
		encoderName = enc
	} else {
		encoderName = "libx264"
	}
	pcw, pch := plannedCapture(modeDefault)
	log.Printf("encoder planned: %s, default capture %dx%d", encoderName, pcw, pch)

	staticDir := "static"
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		staticDir = filepath.Join(filepath.Dir(os.Args[0]), "static")
	}

	stats.startTime = time.Now()
	stats.captureMode = "gdi-stretchblt"

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/stats", handleStats)
	mux.HandleFunc("/version", handleVersion)

	srv := &http.Server{Addr: ":8080", Handler: mux}

	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
		<-ch
		log.Println("shutting down")
		srv.Shutdown(context.Background())
	}()

	log.Printf("commit=%s build=%s default_mode=%s listening on :8080", gitCommit, buildTime, modeDefault.Name)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	uptime := time.Since(stats.startTime).Seconds()
	sent := stats.framesSent.Load()
	var fps float64
	if uptime > 1 {
		fps = float64(sent) / uptime
	}
	enc := encoderName
	cur := currentModeSpec()
	bitrate := cur.BitrateKbps
	cw, ch := plannedCapture(cur)
	if e := liveEncoder.Load(); e != nil {
		if e.encoder != "" {
			enc = e.encoder
		}
		bitrate = int(e.bitrate.Load())
		if e.width > 0 {
			cw, ch = e.width, e.height
		}
	}
	if enc == "" {
		enc = "unknown"
	}
	out := map[string]interface{}{
		"res":               fmt.Sprintf("%dx%d", cw, ch),
		"src_res":           fmt.Sprintf("%dx%d", int(srcWv.Load()), int(srcHv.Load())),
		"fps_sent":          fmt.Sprintf("%.1f", fps),
		"frames_sent":       sent,
		"drops":             stats.drops.Load(),
		"idr_count":         stats.idrCount.Load(),
		"uptime_s":          fmt.Sprintf("%.0f", uptime),
		"capture_mode":      stats.captureMode,
		"encoder":           enc,
		"target_fps":        cur.FPS,
		"bitrate_kbps":      bitrate,
		"mode":              cur.Name,
		"session_id":        sessionID,
		"git_commit":        gitCommit,
		"input_to_frame_ms": stats.inputToFrame.Load(),
	}
	if stats.sizeMismatch.Load() {
		out["size_mismatch"] = true
	}
	if stats.guardTrip.Load() {
		out["guard_tripped"] = true
	}
	json.NewEncoder(w).Encode(out)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	defer ws.Close()
	log.Println("client connected")

	mode := modeFor(r.URL.Query().Get("mode"))
	log.Printf("client mode=%s", mode.Name)

	activeMu.Lock()
	if activeCancel != nil {
		activeCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	activeCancel = cancel
	activeMu.Unlock()
	defer cancel()

	pc, videoTrack, err := newPeerConnection()
	if err != nil {
		log.Printf("peer: %v", err)
		return
	}
	defer pc.Close()

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() {
			log.Printf("data channel open: %s", dc.Label())
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			handleInputMessage(msg.Data)
		})
	})

	var wsMu sync.Mutex
	wsSend := func(v interface{}) {
		data, _ := json.Marshal(v)
		wsMu.Lock()
		ws.WriteMessage(websocket.TextMessage, data)
		wsMu.Unlock()
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		j := c.ToJSON()
		wsSend(signalMessage{
			Type:      "candidate",
			Candidate: j.Candidate,
			SDPMid:    j.SDPMid,
			SDPMLine:  j.SDPMLineIndex,
		})
	})

	var pipelineOnce sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("connection: %s", s.String())
		switch s {
		case webrtc.PeerConnectionStateConnected:
			pipelineOnce.Do(func() {
				go runCapturePipeline(ctx, videoTrack, mode)
			})
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			cancel()
		}
	})

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			break
		}
		var msg signalMessage
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "offer":
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{
				Type: webrtc.SDPTypeOffer, SDP: msg.SDP,
			}); err != nil {
				log.Printf("setRemote: %v", err)
				continue
			}
			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				log.Printf("createAnswer: %v", err)
				continue
			}
			if err := pc.SetLocalDescription(answer); err != nil {
				log.Printf("setLocal: %v", err)
				continue
			}
			wsSend(signalMessage{Type: "answer", SDP: answer.SDP})

		case "candidate":
			if msg.Candidate != "" {
				pc.AddICECandidate(webrtc.ICECandidateInit{
					Candidate:     msg.Candidate,
					SDPMid:        msg.SDPMid,
					SDPMLineIndex: msg.SDPMLine,
				})
			}
		}
	}
	log.Println("client disconnected")
}

func runCapturePipeline(ctx context.Context, track *webrtc.TrackLocalStaticSample, mode modeSpec) {
	liveMode.Store(&mode)
	srcW, srcH := getScreenSize()
	capW, capH := mode.resolveSize(srcW, srcH)
	expectedBytes := capW * capH * 4

	srcWv.Store(int64(srcW))
	srcHv.Store(int64(srcH))
	capWv.Store(int64(capW))
	capHv.Store(int64(capH))

	// Try DXGI Desktop Duplication, fall back to GDI StretchBlt. On the GPU-less
	// Azure DS2_v2 DXGI init returns DXGI_ERROR_NOT_FOUND and GDI is the real path.
	useDXGI := false
	if err := initDXGI(); err != nil {
		log.Printf("DXGI init failed (using GDI fallback): %v", err)
		stats.captureMode = "gdi-stretchblt"
	} else {
		useDXGI = true
		stats.captureMode = "dxgi"
		defer closeDXGI()
		log.Printf("DXGI Desktop Duplication active: %dx%d", dxgi.width, dxgi.height)
	}

	log.Printf("screen: %dx%d -> capture: %dx%d @ %dfps (%d bytes/frame, %.1f MB/s pipe) mode=%s",
		srcW, srcH, capW, capH, mode.FPS, expectedBytes, float64(expectedBytes*mode.FPS)/1048576.0, stats.captureMode)

	go benchmarkCapture(srcW, srcH, capW, capH)

	captureFunc := func() ([]byte, error) {
		if useDXGI {
			frame, dw, dh, err := captureDXGI()
			if err != nil {
				useDXGI = false
				stats.captureMode = "gdi-stretchblt"
				log.Printf("DXGI capture failed, switching to GDI: %v", err)
				return captureScreenScaled(srcW, srcH, capW, capH)
			}
			if dw == capW && dh == capH {
				return frame, nil
			}
			// DXGI gives full-res; scale via GDI instead of feeding a wrong-sized frame.
			_ = frame
			return captureScreenScaled(srcW, srcH, capW, capH)
		}
		return captureScreenScaled(srcW, srcH, capW, capH)
	}

	enc, err := newEncoder(capW, capH, mode)
	if err != nil {
		log.Printf("encoder: %v", err)
		return
	}
	defer enc.close()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case au, ok := <-enc.output():
				if !ok {
					return
				}
				if err := track.WriteSample(media.Sample{
					Data:     au,
					Duration: time.Second / time.Duration(mode.FPS),
				}); err != nil {
					log.Printf("writeSample: %v", err)
					return
				}
				stats.framesSent.Add(1)
				stats.bytesSent.Add(int64(len(au)))
				if lastIn := stats.lastInputNs.Load(); lastIn > 0 {
					delta := time.Now().UnixNano() - lastIn
					if delta > 0 && delta < int64(2*time.Second) {
						stats.inputToFrame.Store(delta / int64(time.Millisecond))
					}
				}
			}
		}
	}()

	ticker := time.NewTicker(time.Second / time.Duration(mode.FPS))
	defer ticker.Stop()

	// Size assertion: a frame whose length disagrees with the encoder's declared
	// input size is the v2 desync signature (grey top band, ~25% correct pixels).
	testFrame, err := captureFunc()
	if err != nil {
		log.Printf("first capture failed: %v", err)
		return
	}
	if len(testFrame) != expectedBytes {
		stats.sizeMismatch.Store(true)
		stats.guardTrip.Store(true)
		log.Printf("FATAL: SIZE MISMATCH: capture returned %d bytes, encoder expects %d (cap=%dx%d) - refusing to stream a desynced frame",
			len(testFrame), expectedBytes, capW, capH)
		return
	}
	log.Printf("size assertion PASS: %d bytes == %dx%dx4", len(testFrame), capW, capH)
	if err := enc.writeFrame(testFrame); err != nil {
		log.Printf("writeFrame[0]: %v", err)
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if len(enc.output()) >= cap(enc.output())-1 {
				stats.drops.Add(1)
				continue
			}
			frame, err := captureFunc()
			if err != nil {
				continue
			}
			if len(frame) != expectedBytes {
				stats.sizeMismatch.Store(true)
				stats.guardTrip.Store(true)
				log.Printf("FATAL: SIZE MISMATCH mid-stream: %d bytes != %d (cap=%dx%d) - stopping pipeline",
					len(frame), expectedBytes, capW, capH)
				return
			}
			if err := enc.writeFrame(frame); err != nil {
				log.Printf("writeFrame: %v", err)
				return
			}
		}
	}
}
