package main

import "strings"

// modeSpec describes one capture/encode profile. A zero Width/Height means
// "half the source resolution" (the original GHRDP behaviour), which lands on
// 512x384 for the Azure DS2_v2 1024x768 console.
type modeSpec struct {
	Name        string
	Width       int
	Height      int
	FPS         int
	BitrateKbps int
	MaxRateKbps int
	BufSizeKbps int
}

var modeDefault = modeSpec{
	Name:        "512x384",
	Width:       0,
	Height:      0,
	FPS:         15,
	BitrateKbps: 1200,
	MaxRateKbps: 1500,
	BufSizeKbps: 1000,
}

var modeHiRes = modeSpec{
	Name:        "640x480",
	Width:       640,
	Height:      480,
	FPS:         15,
	BitrateKbps: 1600,
	MaxRateKbps: 2000,
	BufSizeKbps: 1400,
}

// modeFor maps a ?mode= query value to a profile. Unknown/empty values fall
// back to the default so a bad URL can never disable the stream.
func modeFor(q string) modeSpec {
	switch strings.ToLower(strings.TrimSpace(q)) {
	case "640x480", "hi", "high", "640":
		return modeHiRes
	default:
		return modeDefault
	}
}

// resolveSize returns the capture dimensions for this mode given the source.
func (m modeSpec) resolveSize(srcW, srcH int) (int, int) {
	if m.Width > 0 && m.Height > 0 {
		return m.Width, m.Height
	}
	return srcW / 2, srcH / 2
}
