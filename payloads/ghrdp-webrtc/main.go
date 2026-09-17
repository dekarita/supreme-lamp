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

const targetFPS = 15

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

var stats struct {
	capW, capH   int
	srcW, srcH   int
	fpsSent      atomic.Int64
	fpsEncoded   atomic.Int64
	drops        atomic.Int64
	kbpsSent     atomic.Int64
	idrCount     atomic.Int64
	startTime    time.Time
	captureMode  string
	framesSent   atomic.Int64
	bytesSent    atomic.Int64
	sizeMismatch atomic.Bool
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("ghrdp-webrtc starting")

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

	srv := &http.Server{Addr: ":8080", Handler: mux}

	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
		<-ch
		log.Println("shutting down")
		srv.Shutdown(context.Background())
	}()

	log.Println("listening on :8080")
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
	out := map[string]interface{}{
		"res":          fmt.Sprintf("%dx%d", stats.capW, stats.capH),
		"src_res":      fmt.Sprintf("%dx%d", stats.srcW, stats.srcH),
		"fps_sent":     fmt.Sprintf("%.1f", fps),
		"frames_sent":  sent,
		"drops":        stats.drops.Load(),
		"idr_count":    stats.idrCount.Load(),
		"uptime_s":     fmt.Sprintf("%.0f", uptime),
		"capture_mode": stats.captureMode,
		"target_fps":   targetFPS,
	}
	if stats.sizeMismatch.Load() {
		out["size_mismatch"] = true
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
				go runCapturePipeline(ctx, videoTrack)
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

func runCapturePipeline(ctx context.Context, track *webrtc.TrackLocalStaticSample) {
	srcW, srcH := getScreenSize()
	capW := srcW / 2
	capH := srcH / 2
	expectedBytes := capW * capH * 4

	stats.srcW = srcW
	stats.srcH = srcH
	stats.capW = capW
	stats.capH = capH

	log.Printf("screen: %dx%d → capture: %dx%d @ %dfps (%d bytes/frame, %.1f MB/s pipe)",
		srcW, srcH, capW, capH, targetFPS, expectedBytes, float64(expectedBytes*targetFPS)/1048576.0)

	enc, err := newEncoder(capW, capH, targetFPS)
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
					Duration: time.Second / time.Duration(targetFPS),
				}); err != nil {
					log.Printf("writeSample: %v", err)
					return
				}
				stats.framesSent.Add(1)
				stats.bytesSent.Add(int64(len(au)))
			}
		}
	}()

	ticker := time.NewTicker(time.Second / time.Duration(targetFPS))
	defer ticker.Stop()

	// verify first frame size
	testFrame, err := captureScreenScaled(srcW, srcH, capW, capH)
	if err != nil {
		log.Fatalf("first capture failed: %v", err)
	}
	if len(testFrame) != expectedBytes {
		stats.sizeMismatch.Store(true)
		log.Fatalf("SIZE MISMATCH: capture returned %d bytes, encoder expects %d (cap=%dx%d)",
			len(testFrame), expectedBytes, capW, capH)
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
			frame, err := captureScreenScaled(srcW, srcH, capW, capH)
			if err != nil {
				continue
			}
			if err := enc.writeFrame(frame); err != nil {
				log.Printf("writeFrame: %v", err)
				return
			}
		}
	}
}
