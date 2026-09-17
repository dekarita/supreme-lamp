package main

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"time"
)

// Overridden at build time:
//
//	go build -ldflags "-s -w -X main.gitCommit=<sha> -X main.buildTime=<RFC3339>"
var (
	gitCommit = "unknown"
	buildTime = "unknown"
)

var serverStart = time.Now()

// sessionID is resolved once at startup; the server refuses to capture from a
// session other than requiredSessionID because GDI/desktop capture is dead there.
var sessionID = -1

const defaultSessionID = 2

// requiredSessionID is 2 on the Azure console session. GHRDP_REQUIRED_SESSION is
// an escape hatch for a runner whose interactive session numbering differs; the
// default keeps the acceptance contract (session_id == 2) intact.
var requiredSessionID = defaultSessionID

func resolveRequiredSession() {
	if v := os.Getenv("GHRDP_REQUIRED_SESSION"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			requiredSessionID = n
		}
	}
}

type versionInfo struct {
	GitCommit    string  `json:"git_commit"`
	BuildTime    string  `json:"build_time"`
	Capture      string  `json:"capture"`
	Mode         string  `json:"mode"`
	Encoder      string  `json:"encoder"`
	TargetFPS    int     `json:"target_fps"`
	BitrateKbps  int     `json:"bitrate_kbps"`
	SessionID    int     `json:"session_id"`
	ExePath      string  `json:"exe_path"`
	PID          int     `json:"pid"`
	GoVersion    string  `json:"go_version"`
	StartedAt    string  `json:"started_at"`
	UptimeS      float64 `json:"uptime_s"`
	ReqSessionID int     `json:"required_session_id"`
	DefaultMode  string  `json:"default_mode"`
	CaptureMode  string  `json:"capture_mode"`
}

// plannedCapture returns the capture size this server WILL use for a mode, so
// /version can state the truth before the first client attaches (B6 requires the
// advertised size to equal ffmpeg's -video_size).
func plannedCapture(m modeSpec) (int, int) {
	srcW, srcH := getScreenSize()
	return m.resolveSize(srcW, srcH)
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	exe, _ := os.Executable()
	m := modeFor(r.URL.Query().Get("mode"))
	enc := encoderName
	if enc == "" {
		enc = "unknown"
	}
	bitrate := m.BitrateKbps
	modeName := m.Name
	targetFPS := m.FPS
	pw, ph := plannedCapture(m)
	res := strconv.Itoa(pw) + "x" + strconv.Itoa(ph)
	if e := liveEncoder.Load(); e != nil {
		if e.width > 0 {
			res = strconv.Itoa(e.width) + "x" + strconv.Itoa(e.height)
		}
		bitrate = int(e.bitrate.Load())
		if e.encoder != "" {
			enc = e.encoder
		}
		// Advertise the live pipeline's mode, not the requested one.
		if e.mode != "" {
			modeName = e.mode
		}
		if e.fps > 0 {
			targetFPS = e.fps
		}
	}
	out := versionInfo{
		GitCommit:    gitCommit,
		BuildTime:    buildTime,
		Capture:      res,
		Mode:         modeName,
		Encoder:      enc,
		TargetFPS:    targetFPS,
		BitrateKbps:  bitrate,
		SessionID:    sessionID,
		ExePath:      exe,
		PID:          os.Getpid(),
		GoVersion:    runtime.Version(),
		StartedAt:    serverStart.UTC().Format(time.RFC3339),
		UptimeS:      time.Since(serverStart).Seconds(),
		ReqSessionID: requiredSessionID,
		DefaultMode:  modeDefault.Name,
		CaptureMode:  stats.captureMode,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
