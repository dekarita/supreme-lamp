package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
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
	FPS          float64 `json:"fps"`
	KbpsAvg      float64 `json:"kbps"`
	KbpsDeclared int     `json:"kbps_declared"`
	DecodeOK     float64 `json:"decode_ok"`
	FirstFrame   float64 `json:"first_frame_ms"`
	IDRInterval  float64 `json:"idr_interval_s"`
	CandType     string  `json:"candidate"`
	Frames       int64   `json:"frames"`
	Bytes        int64   `json:"bytes"`
	Duration     float64 `json:"duration_s"`
	InputToFrame float64 `json:"input_to_frame_ms"`
	// MaxGapMS is the longest stall between consecutive frames. An average fps
	// hides a blackout: a 3s freeze in a 30s window still averages ~11fps at
	// 15fps nominal, so it reads as healthy while the viewer saw nothing.
	MaxGapMS float64 `json:"max_gap_ms"`
	// TerminalGapMS is the silence between the LAST frame received and the end of
	// the measurement window. Without it a stream that dies mid-probe is invisible:
	// the stall that matters produces no further packet, so no between-frames gap is
	// ever computed. Run 35258476317 lost the server ~13s in and still reported
	// 47.9fps / max_gap 171ms / PASS.
	TerminalGapMS float64 `json:"terminal_gap_ms"`
	// ActiveS is the window the frames actually arrived over (first to last), which
	// excludes the dead tail. ActiveFPS is measured over ActiveS alone.
	ActiveS   float64 `json:"active_s"`
	ActiveFPS float64 `json:"active_fps"`
	// DecodeOKCount/DecodeFailCount make decode_ok falsifiable. The old ratio was
	// decodeOK/endFrames where both were incremented together per received packet,
	// so it was structurally pinned at 1.000 and could never fail.
	DecodeOKCount   int64 `json:"decode_ok_count"`
	DecodeFailCount int64 `json:"decode_fail_count"`
}

// acceptance mirrors the P5 contract written next to the deploy.
type acceptance struct {
	FPS          float64 `json:"fps"`
	Kbps         float64 `json:"kbps"`
	DecodeOK     float64 `json:"decode_ok"`
	Candidate    string  `json:"candidate"`
	Verdict      string  `json:"verdict"`
	GitCommit    string  `json:"git_commit"`
	SessionID    int     `json:"session_id"`
	Capture      string  `json:"capture"`
	Mode         string  `json:"mode"`
	Encoder      string  `json:"encoder"`
	InputToFrame float64 `json:"input_to_frame_ms"`
	MaxGapMS     float64 `json:"max_gap_ms"`
	// TerminalGapMS is the silence from the last frame to the end of the window:
	// i.e. the stream was still alive when the probe finished. Recorded so a stream
	// that died mid-probe is visible in the artifact instead of only in ffmpeg's log.
	TerminalGapMS float64 `json:"terminal_gap_ms"`
	ActiveFPS     float64 `json:"active_fps"`
	ActiveS       float64 `json:"active_s"`
	ProbeAt       string  `json:"probe_at"`
	Addr          string  `json:"addr"`
	Error         string  `json:"error,omitempty"`
}

type versionInfo struct {
	GitCommit   string `json:"git_commit"`
	BuildTime   string `json:"build_time"`
	Capture     string `json:"capture"`
	Mode        string `json:"mode"`
	Encoder     string `json:"encoder"`
	TargetFPS   int    `json:"target_fps"`
	BitrateKbps int    `json:"bitrate_kbps"`
	SessionID   int    `json:"session_id"`
	ExePath     string `json:"exe_path"`
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "server address")
	dur := flag.Duration("duration", 30*time.Second, "measurement duration")
	mode := flag.String("mode", "", "capture mode query (?mode=640x480)")
	out := flag.String("out", "", "write acceptance.json to this path")
	minFPS := flag.Float64("min-fps", 10, "minimum acceptable fps")
	flag.Parse()

	wsURL := fmt.Sprintf("ws://%s/ws", *addr)
	if *mode != "" {
		wsURL += "?mode=" + *mode
	}
	log.Printf("probe connecting to %s for %s", wsURL, *dur)

	ver, _ := fetchVersion(*addr, *mode)

	acc := acceptance{
		Verdict:   "FAIL",
		GitCommit: ver.GitCommit,
		SessionID: ver.SessionID,
		Capture:   ver.Capture,
		Mode:      ver.Mode,
		Encoder:   ver.Encoder,
		ProbeAt:   time.Now().UTC().Format(time.RFC3339),
		Addr:      *addr,
	}

	result, err := runProbe(wsURL, *dur)
	if err != nil {
		log.Printf("probe failed: %v", err)
		acc.Error = err.Error()
		writeAcceptance(*out, acc)
		os.Exit(1)
	}

	printReport(result, ver, *minFPS)

	acc.FPS = round1(result.FPS)
	acc.Kbps = math.Round(result.KbpsAvg)
	acc.DecodeOK = round3(result.DecodeOK)
	acc.Candidate = result.CandType
	acc.InputToFrame = result.InputToFrame
	acc.MaxGapMS = round1(result.MaxGapMS)
	acc.TerminalGapMS = round1(result.TerminalGapMS)
	acc.ActiveFPS = round1(result.ActiveFPS)
	acc.ActiveS = round1(result.ActiveS)
	if ver.Capture != "" {
		acc.Capture = ver.Capture
	}

	// B3 forbids a blackout longer than 2s. Average fps cannot see one, so the
	// verdict fails on the longest inter-frame gap as well.
	// Liveness is a first-class criterion. MaxGapMS already absorbs the terminal
	// silence, but state the requirement directly so the reason a stream failed is
	// never "the numbers looked fine".
	pass := result.FPS >= *minFPS && result.KbpsAvg <= 2500 && result.DecodeOK >= 0.99 &&
		result.CandType != "" && result.CandType != "unknown" && ver.SessionID == 2 &&
		result.MaxGapMS <= maxGapMSAllowed && result.TerminalGapMS <= maxGapMSAllowed
	if pass {
		acc.Verdict = "PASS"
		fmt.Println("\nVERDICT: PASS")
		writeAcceptance(*out, acc)
		os.Exit(0)
	}

	fmt.Println("\nVERDICT: FAIL")
	if result.FPS < *minFPS {
		fmt.Printf("  fps %.1f < %.1f\n", result.FPS, *minFPS)
	}
	if result.KbpsAvg > 2500 {
		fmt.Printf("  kbps %.0f > 2500\n", result.KbpsAvg)
	}
	if result.DecodeOK < 0.99 {
		fmt.Printf("  decode_ok %.3f < 0.99\n", result.DecodeOK)
	}
	if result.CandType == "" || result.CandType == "unknown" {
		fmt.Printf("  candidate type not resolved\n")
	}
	if ver.SessionID != 2 {
		fmt.Printf("  session_id %d != 2\n", ver.SessionID)
	}
	if result.MaxGapMS > maxGapMSAllowed {
		fmt.Printf("  max frame gap %.0fms > %.0fms (blackout)\n", result.MaxGapMS, maxGapMSAllowed)
	}
	if result.TerminalGapMS > maxGapMSAllowed {
		fmt.Printf("  stream stopped %.0fms before the probe ended (dead tail > %.0fms)\n", result.TerminalGapMS, maxGapMSAllowed)
	}
	writeAcceptance(*out, acc)
	os.Exit(1)
}

func writeAcceptance(path string, acc acceptance) {
	if path == "" {
		return
	}
	b, _ := json.MarshalIndent(acc, "", "  ")
	if err := os.WriteFile(path, append(b, '\n'), 0644); err != nil {
		log.Printf("write acceptance %s: %v", path, err)
		return
	}
	log.Printf("acceptance written: %s verdict=%s", path, acc.Verdict)
}

func fetchVersion(addr, mode string) (versionInfo, error) {
	url := "http://" + addr + "/version"
	if mode != "" {
		url += "?mode=" + mode
	}
	c := http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		log.Printf("version fetch failed: %v", err)
		return versionInfo{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var v versionInfo
	if err := json.Unmarshal(body, &v); err != nil {
		return versionInfo{}, err
	}
	log.Printf("server version: commit=%s session=%d capture=%s encoder=%s mode=%s",
		v.GitCommit, v.SessionID, v.Capture, v.Encoder, v.Mode)
	return v, nil
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

	pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})

	dc, err := pc.CreateDataChannel("input", nil)
	if err != nil {
		return nil, fmt.Errorf("dc: %w", err)
	}

	var (
		frames     atomic.Int64
		bytes      atomic.Int64
		decodeOK   atomic.Int64
		firstFrame time.Time
		firstOnce  sync.Once
		candType   atomic.Value
		trackStart time.Time
		trackOnce  sync.Once
		writeMu    sync.Mutex

		// Stall tracking. lastFrame/lastFrameNS are touched only from the single
		// OnTrack goroutine, so the gap can be computed in place; maxGapMS is
		// published atomically because the report reads it after the read loop
		// may still be draining.
		lastFrameNS atomic.Int64
		maxGapMS    atomic.Int64
		// firstFrameNS/lastFrameNSAbs bound the window frames actually arrived over,
		// so a dead tail cannot be averaged away.
		firstFrameNS   atomic.Int64
		lastFrameNSAbs atomic.Int64
		decodeFail     atomic.Int64
	)

	// OnICECandidate fires from Pion's gatherer goroutine while the main path
	// writes the offer, so every send goes through one lock (gorilla/websocket
	// permits only one concurrent writer).
	send := func(m signalMsg) {
		data, err := json.Marshal(m)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		ws.WriteMessage(websocket.TextMessage, data)
	}

	candType.Store("unknown")

	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		trackOnce.Do(func() { trackStart = time.Now() })
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			now := time.Now()
			if prev := lastFrameNS.Load(); prev > 0 {
				gap := now.UnixNano() - prev
				if gap > 0 && gap > maxGapMS.Load() {
					maxGapMS.Store(gap)
				}
			}
			lastFrameNS.Store(now.UnixNano())
			lastFrameNSAbs.Store(now.UnixNano())
			firstFrameNS.CompareAndSwap(0, now.UnixNano())
			firstOnce.Do(func() { firstFrame = now })
			frames.Add(1)
			bytes.Add(int64(len(pkt.Payload)))
			// A payload that cannot be split into access units is undecodable. The
			// old counter incremented unconditionally, so decode_ok was always 1.000.
			if len(pkt.Payload) > 0 {
				decodeOK.Add(1)
			} else {
				decodeFail.Add(1)
			}
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		j := c.ToJSON()
		send(signalMsg{
			Type: "candidate", Candidate: j.Candidate,
			SDPMid: j.SDPMid, SDPMLine: j.SDPMLineIndex,
		})
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

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("offer: %w", err)
	}
	pc.SetLocalDescription(offer)

	offerData, err := json.Marshal(signalMsg{Type: "offer", SDP: offer.SDP})
	if err != nil {
		return nil, fmt.Errorf("marshal offer: %w", err)
	}
	writeMu.Lock()
	err = ws.WriteMessage(websocket.TextMessage, offerData)
	writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("send offer: %w", err)
	}

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
	// Only stalls inside the measurement window count: reset before measuring so
	// the first-frame handshake gap is not reported as a blackout.
	lastFrameNS.Store(0)
	maxGapMS.Store(0)
	// Bound the arrival window: firstFrameNS stays 0 until a frame lands, and
	// lastFrameNSAbs is seeded at the window start so a stall that never ends is
	// still visible as a terminal gap.
	firstFrameNS.Store(0)
	lastFrameNSAbs.Store(start.UnixNano())

	// Input latency: wait for the data channel, send one move event, and measure
	// how long the next encoded frame takes to arrive (B4, <=120ms).
	var inputToFrame time.Duration = -1
	dcOpen := make(chan struct{})
	var dcOnce sync.Once
	dc.OnOpen(func() { dcOnce.Do(func() { close(dcOpen) }) })
	select {
	case <-dcOpen:
	case <-time.After(5 * time.Second):
	}
	if dc.ReadyState() == webrtc.DataChannelStateOpen {
		before := frames.Load()
		_ = dc.SendText(`{"t":"m","nx":0.5,"ny":0.5}`)
		waitStart := time.Now()
		for time.Since(waitStart) < 1500*time.Millisecond {
			if frames.Load() > before {
				inputToFrame = time.Since(waitStart)
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

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

	okCount := decodeOK.Load()
	failCount := decodeFail.Load()
	decodeRatio := decodeRatio(okCount, failCount)

	// The stall that matters is the one still in progress when the window ends:
	// it emits no further packet, so the between-frames scan cannot see it. Measure
	// the silence from the last frame to the end of the window and fold it into the
	// blackout check; otherwise a server that dies mid-probe reports healthy.
	end := time.Now()
	firstNS := firstFrameNS.Load()
	lastNS := lastFrameNSAbs.Load()
	var activeS, activeFPS float64
	if firstNS > 0 && lastNS >= firstNS {
		activeS = float64(lastNS-firstNS) / float64(time.Second)
		if activeS > 0 {
			activeFPS = float64(totalFrames) / activeS
		}
	}
	terminalGapMS := float64(livenessGap(end, time.Unix(0, lastNS))) / float64(time.Millisecond)
	if terminalGapMS > float64(maxGapMS.Load())/float64(time.Millisecond) {
		maxGapMS.Store(int64(terminalGapMS * float64(time.Millisecond)))
	}

	return &probeResult{
		FPS:             fps,
		KbpsAvg:         kbps,
		DecodeOK:        decodeRatio,
		FirstFrame:      firstFrameLatency.Seconds() * 1000,
		CandType:        candType.Load().(string),
		Frames:          totalFrames,
		Bytes:           totalBytes,
		Duration:        elapsed,
		InputToFrame:    float64(inputToFrame.Milliseconds()),
		MaxGapMS:        float64(maxGapMS.Load()) / float64(time.Millisecond),
		TerminalGapMS:   terminalGapMS,
		ActiveS:         activeS,
		ActiveFPS:       activeFPS,
		DecodeOKCount:   okCount,
		DecodeFailCount: failCount,
	}, nil
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// maxGapMSAllowed is the longest inter-frame stall B3 tolerates: a blackout
// longer than this fails acceptance even if every other metric looks healthy.
const maxGapMSAllowed = 2000.0

// livenessGap is the silence between the last frame received and the end of the
// measurement window. It exists because the between-frames scan cannot see a
// stream that stops and stays stopped: the terminal stall produces no further
// packet, so no gap is ever computed and a dead pipeline reports a healthy
// max_gap. Run 35258476317 lost the server 13s into a 30s window and still
// reported 47.9fps / 171ms / PASS.
//
// A zero last-frame timestamp means no frame ever arrived; there is no stall to
// measure, so the gap is 0 rather than a value derived from the zero time.
func livenessGap(end, lastFrame time.Time) time.Duration {
	if lastFrame.IsZero() || lastFrame.After(end) {
		return 0
	}
	return end.Sub(lastFrame)
}

// decodeRatio is ok/(ok+fail). The previous formula divided the packet count by
// itself, pinning the ratio at 1.000 so the >= 0.99 acceptance criterion could
// never fail; separating the counters makes the metric falsifiable.
func decodeRatio(ok, fail int64) float64 {
	if ok+fail == 0 {
		return 1.0
	}
	return float64(ok) / float64(ok+fail)
}

func printReport(r *probeResult, v versionInfo, minFPS float64) {
	w := 52
	fmt.Println(strings.Repeat("=", w))
	fmt.Println("  GHRDP WebRTC Probe Report")
	fmt.Println(strings.Repeat("=", w))
	fmt.Printf("  %-22s %8.1f fps\n", "Frame rate:", r.FPS)
	fmt.Printf("  %-22s %8.0f kbps\n", "Bitrate:", r.KbpsAvg)
	fmt.Printf("  %-22s %8.3f\n", "Decode OK ratio:", r.DecodeOK)
	fmt.Printf("  %-22s %8.0f ms\n", "First frame:", r.FirstFrame)
	fmt.Printf("  %-22s %8.0f ms\n", "Input to frame:", r.InputToFrame)
	fmt.Printf("  %-22s %8.0f ms\n", "Max frame gap:", r.MaxGapMS)
	fmt.Printf("  %-22s %8s\n", "Candidate type:", r.CandType)
	fmt.Printf("  %-22s %8.1f ms\n", "Terminal gap:", r.TerminalGapMS)
	fmt.Printf("  %-22s %8.1f fps\n", "Active-window fps:", r.ActiveFPS)
	fmt.Printf("  %-22s %8.1f s\n", "Active window:", r.ActiveS)
	fmt.Printf("  %-22s %8d\n", "Frames measured:", r.Frames)
	fmt.Printf("  %-22s %8.1f s\n", "Duration:", r.Duration)
	fmt.Printf("  %-22s %8.1f MB\n", "Data received:", float64(r.Bytes)/1048576)
	fmt.Printf("  %-22s %8s\n", "Server commit:", v.GitCommit)
	fmt.Printf("  %-22s %8d\n", "Server session_id:", v.SessionID)
	fmt.Printf("  %-22s %8s\n", "Server capture:", v.Capture)
	fmt.Println(strings.Repeat("=", w))

	fmt.Println("\n  Acceptance criteria:")
	check := func(name string, ok bool, detail string) {
		mark := "PASS"
		if !ok {
			mark = "FAIL"
		}
		fmt.Printf("    [%s] %s: %s\n", mark, name, detail)
	}
	check("fps >= min", r.FPS >= minFPS, fmt.Sprintf("%.1f", r.FPS))
	check("kbps <= 2500", r.KbpsAvg <= 2500, fmt.Sprintf("%.0f", r.KbpsAvg))
	check("decode_ok >= 0.99", r.DecodeOK >= 0.99, fmt.Sprintf("%.3f", r.DecodeOK))
	check("candidate resolved", r.CandType != "" && r.CandType != "unknown", r.CandType)
	check("session_id == 2", v.SessionID == 2, fmt.Sprintf("%d", v.SessionID))
	check("no blackout > 2s", r.MaxGapMS <= maxGapMSAllowed, fmt.Sprintf("%.0fms", r.MaxGapMS))
}
