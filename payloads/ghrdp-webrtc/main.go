package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
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

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("ghrdp-webrtc starting")

	staticDir := "static"
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		staticDir = filepath.Join(filepath.Dir(os.Args[0]), "static")
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

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
	w, h := getScreenSize()
	log.Printf("screen: %dx%d", w, h)

	enc, err := newEncoder(w, h, 30)
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
					Duration: time.Second / 30,
				}); err != nil {
					log.Printf("writeSample: %v", err)
					return
				}
			}
		}
	}()

	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	frameSize := w * h * 4
	log.Printf("capture started: %dx%d (%d bytes/frame)", w, h, frameSize)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			frame, err := captureScreen(w, h)
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
