package main

import (
	"testing"
	"time"
)

// The incident this guards against: run 35258476317 lost the server mid-probe.
// The probe had already made a healthy measurement window (47.9fps), the stream
// then stopped forever, and because a stall that never ends emits no further
// packet the between-frames scan saw a largest gap of 171ms and reported PASS
// while ffmpeg's own log ended at 13.94s of a 30s window.
//
// livenessGap folds the silence from the last frame to the end of the window into
// the blackout check, so a dead tail is indistinguishable from a blackout.
func TestTerminalGapCatchesDeadTail(t *testing.T) {
	const window = 30 * time.Second
	start := time.Now()

	// Frames arrived for 13s at a healthy rate, then nothing until the window ended.
	lastFrame := start.Add(13 * time.Second)
	end := start.Add(window)

	gap := livenessGap(end, lastFrame)
	if gap != 17*time.Second {
		t.Fatalf("dead tail gap = %v, want 17s", gap)
	}
	if gap <= maxGapMSAllowed*time.Millisecond {
		t.Fatalf("dead tail %v must exceed the %v blackout budget", gap, maxGapMSAllowed*time.Millisecond)
	}
}

// A stream that is still producing frames when the window closes has a terminal
// gap of about one frame interval, which must not be mistaken for a blackout.
func TestTerminalGapStaysSmallWhenStreamAlive(t *testing.T) {
	end := time.Now()
	lastFrame := end.Add(-time.Second / 15) // one frame at 15fps before the end

	gap := livenessGap(end, lastFrame)
	if gap > maxGapMSAllowed*time.Millisecond {
		t.Fatalf("live stream reported a terminal gap of %v, which would fail a healthy run", gap)
	}
}

// With no frames at all there is nothing to measure from; the gap must be zero
// rather than a huge number derived from a zero timestamp, or every probe that
// receives nothing would report a nonsense blackout.
func TestTerminalGapZeroWithoutFrames(t *testing.T) {
	if gap := livenessGap(time.Now(), time.Time{}); gap != 0 {
		t.Fatalf("gap with no frames = %v, want 0", gap)
	}
}

// decode_ok used to be decodeOK/endFrames where both counters incremented once
// per received packet, so the ratio was structurally pinned at 1.000 and the
// acceptance criterion could never fail. The ratio must be able to drop.
func TestDecodeRatioIsFalsifiable(t *testing.T) {
	if r := decodeRatio(10, 0); r != 1.0 {
		t.Fatalf("all-good ratio = %v, want 1.0", r)
	}
	// A payload too short to contain an access unit is undecodable; 2 of 10
	// failures must push the ratio below the 0.99 acceptance floor.
	if r := decodeRatio(8, 2); r >= 0.99 {
		t.Fatalf("ratio with 2/10 undecodable = %v, want < 0.99 so acceptance can fail", r)
	}
	if r := decodeRatio(0, 0); r != 1.0 {
		t.Fatalf("empty-window ratio = %v, want 1.0 (no evidence of failure)", r)
	}
}
