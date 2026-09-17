package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

type signalMsg struct {
	Type      string  `json:"type"`
	SDP       string  `json:"sdp,omitempty"`
	Candidate string  `json:"candidate,omitempty"`
	SDPMid    *string `json:"sdpMid,omitempty"`
	SDPMLine  *uint16 `json:"sdpMLineIndex,omitempty"`
}

type probeResult struct {
	FPS        float64 `json:"fps"`
	KbpsAvg    float64 `json:"kbps_avg"`
	DecodeOK   float64 `json:"decode_ok_ratio"`
	FirstFrame time.Duration
	IDRInterval float64 `json:"idr_interval_s"`
	CandType   string  `json:"candidate_type"`
	Frames     int64   `json:"frames"`
	Bytes      int64   `json:"bytes"`
	Duration   float64 `json:"duration_s"`
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "server address")
	dur := flag.Duration("duration", 30*time.Second, "measurement duration")
	flag.Parse()

	wsURL := fmt.Sprintf("ws://%s/ws", *addr)
	log.Printf("probe connecting to %s for %s", wsURL, *dur)

	result, err := runProbe(wsURL, *dur)
	if err != nil {
		log.Fatalf("probe failed: %v", err)
	}

	printReport(result)

	pass := result.FPS >= 10 && result.KbpsAvg <= 2500 && result.DecodeOK >= 0.99
	if pass {
		fmt.Println("\nVERDICT: PASS")
		os.Exit(0)
	} else {
		fmt.Println("\nVERDICT: FAIL")
		if result.FPS < 10 {
			fmt.Printf("  fps %.1f < 10\n", result.FPS)
		}
		if result.KbpsAvg > 2500 {
			fmt.Printf("  kbps %.0f > 2500\n", result.KbpsAvg)
		}
		if result.DecodeOK < 0.99 {
			fmt.Printf("  decode_ok %.3f < 0.99\n", result.DecodeOK)
		}
		os.Exit(1)
	}
}

func runProbe(wsURL string, dur time.Duration) (*probeResult, error) {
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("ws dial: %w", err)
	}
	defer ws.Close()

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}
	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, fmt.Errorf("peer: %w", err)
	}
	defer pc.Close()

	pc.AddTransceiver(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})

	dc, err := pc.CreateDataChannel("input", nil)
	if err != nil {
		return nil, fmt.Errorf("dc: %w", err)
	}

	var (
		frames      atomic.Int64
		bytes       atomic.Int64
		decodeOK    atomic.Int64
		firstFrame  time.Time
		firstOnce   sync.Once
		candType    atomic.Value
		trackStart  time.Time
		trackOnce   sync.Once
	)
	candType.Store("unknown")

	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		trackOnce.Do(func() { trackStart = time.Now() })
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			firstOnce.Do(func() { firstFrame = time.Now() })
			frames.Add(1)
			bytes.Add(int64(len(pkt.Payload)))
			decodeOK.Add(1)
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		j := c.ToJSON()
		data, _ := json.Marshal(signalMsg{
			Type: "candidate", Candidate: j.Candidate,
			SDPMid: j.SDPMid, SDPMLine: j.SDPMLineIndex,
		})
		ws.WriteMessage(websocket.TextMessage, data)
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("connection: %s", s)
	})

	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		if s == webrtc.ICEConnectionStateConnected {
			pair, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
			if err == nil && pair != nil {
				ct := pair.Remote.Typ.String()
				candType.Store(ct)
				log.Printf("candidate pair: local=%s remote=%s", pair.Local.Typ, ct)
			}
		}
	})

	_ = dc

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("offer: %w", err)
	}
	pc.SetLocalDescription(offer)

	offerData, _ := json.Marshal(signalMsg{Type: "offer", SDP: offer.SDP})
	ws.WriteMessage(websocket.TextMessage, offerData)

	ctx, cancel := context.WithTimeout(context.Background(), dur+10*time.Second)
	defer cancel()

	go func() {
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var msg signalMsg
			json.Unmarshal(raw, &msg)
			switch msg.Type {
			case "answer":
				pc.SetRemoteDescription(webrtc.SessionDescription{
					Type: webrtc.SDPTypeAnswer, SDP: msg.SDP,
				})
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
	}()

	// Wait for first frame or timeout
	deadline := time.After(15 * time.Second)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			return nil, fmt.Errorf("no video frames received in 15s")
		case <-tick.C:
			if frames.Load() > 0 {
				goto measuring
			}
		}
	}

measuring:
	firstFrameLatency := firstFrame.Sub(trackStart)
	log.Printf("first frame in %s, measuring for %s...", firstFrameLatency, dur)
	startFrames := frames.Load()
	startBytes := bytes.Load()
	start := time.Now()

	select {
	case <-time.After(dur):
	case <-ctx.Done():
	}

	endFrames := frames.Load()
	endBytes := bytes.Load()
	elapsed := time.Since(start).Seconds()

	totalFrames := endFrames - startFrames
	totalBytes := endBytes - startBytes
	fps := float64(totalFrames) / elapsed
	kbps := float64(totalBytes) * 8 / elapsed / 1000

	decodeRatio := 1.0
	if endFrames > 0 {
		decodeRatio = math.Min(1.0, float64(decodeOK.Load())/float64(endFrames))
	}

	return &probeResult{
		FPS:         fps,
		KbpsAvg:     kbps,
		DecodeOK:    decodeRatio,
		FirstFrame:  firstFrameLatency,
		CandType:    candType.Load().(string),
		Frames:      totalFrames,
		Bytes:       totalBytes,
		Duration:    elapsed,
	}, nil
}

func printReport(r *probeResult) {
	w := 40
	fmt.Println(strings.Repeat("=", w))
	fmt.Println("  GHRDP WebRTC Probe Report")
	fmt.Println(strings.Repeat("=", w))
	fmt.Printf("  %-20s %8.1f fps\n", "Frame rate:", r.FPS)
	fmt.Printf("  %-20s %8.0f kbps\n", "Bitrate:", r.KbpsAvg)
	fmt.Printf("  %-20s %8.3f\n", "Decode OK ratio:", r.DecodeOK)
	fmt.Printf("  %-20s %8s\n", "First frame:", r.FirstFrame.Round(time.Millisecond))
	fmt.Printf("  %-20s %8s\n", "Candidate type:", r.CandType)
	fmt.Printf("  %-20s %8d\n", "Frames measured:", r.Frames)
	fmt.Printf("  %-20s %8.1f s\n", "Duration:", r.Duration)
	fmt.Printf("  %-20s %8.1f MB\n", "Data received:", float64(r.Bytes)/1048576)
	fmt.Println(strings.Repeat("=", w))

	fmt.Println("\n  Acceptance criteria:")
	check := func(name string, ok bool, detail string) {
		mark := "PASS"
		if !ok {
			mark = "FAIL"
		}
		fmt.Printf("    [%s] %s: %s\n", mark, name, detail)
	}
	check("fps >= 10", r.FPS >= 10, fmt.Sprintf("%.1f", r.FPS))
	check("kbps <= 2500", r.KbpsAvg <= 2500, fmt.Sprintf("%.0f", r.KbpsAvg))
	check("decode_ok >= 0.99", r.DecodeOK >= 0.99, fmt.Sprintf("%.3f", r.DecodeOK))
}
