package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v3"
)

// TestSupervisePipelineRestarts is the regression test for BUG 3: the pipeline
// used to be launched through sync.Once, so the first exit (encoder crash,
// ffmpeg death, size assertion) permanently stopped video while /health kept
// answering "ok". The supervisor must call the pipeline body again.
func TestSupervisePipelineRestarts(t *testing.T) {
	origRun := pipelineRun
	origBackoff := pipelineBackoff
	defer func() { pipelineRun = origRun; pipelineBackoff = origBackoff }()

	// Instant backoff so the test does not sleep through real 1s/3s/5s delays.
	pipelineBackoff = func(int) time.Duration { return time.Millisecond }

	var calls atomic.Int64
	pipelineRun = func(ctx context.Context, _ *webrtc.TrackLocalStaticSample, _ modeSpec) {
		n := calls.Add(1)
		if n == 3 {
			// Simulate a healthy stream that only ends when the client leaves.
			<-ctx.Done()
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() { supervisePipeline(ctx, nil, modeDefault); close(done) }()

	// Two failures then a long-lived third run.
	deadline := time.After(5 * time.Second)
	for calls.Load() < 3 {
		select {
		case <-deadline:
			t.Fatalf("pipeline was not restarted: only %d calls (BUG 3 regression)", calls.Load())
		case <-time.After(5 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("supervisor did not return after context cancellation")
	}
}

// TestSupervisePipelineGivesUp verifies the retry cap: a pipeline that can never
// start must not spin forever burning 2 vCPU.
func TestSupervisePipelineGivesUp(t *testing.T) {
	origRun := pipelineRun
	origBackoff := pipelineBackoff
	defer func() { pipelineRun = origRun; pipelineBackoff = origBackoff }()

	pipelineBackoff = func(int) time.Duration { return time.Millisecond }

	var calls atomic.Int64
	pipelineRun = func(context.Context, *webrtc.TrackLocalStaticSample, modeSpec) {
		calls.Add(1)
	}

	done := make(chan struct{})
	go func() { supervisePipeline(context.Background(), nil, modeDefault); close(done) }()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("supervisor never gave up")
	}

	if got := calls.Load(); got != maxPipelineRestarts {
		t.Fatalf("expected %d attempts before giving up, got %d", maxPipelineRestarts, got)
	}
}

// TestSupervisePipelineStopsOnCancel verifies a disconnected client does not
// leave a goroutine retrying forever.
func TestSupervisePipelineStopsOnCancel(t *testing.T) {
	origRun := pipelineRun
	origBackoff := pipelineBackoff
	defer func() { pipelineRun = origRun; pipelineBackoff = origBackoff }()

	pipelineBackoff = func(int) time.Duration { return time.Hour }

	var calls atomic.Int64
	pipelineRun = func(context.Context, *webrtc.TrackLocalStaticSample, modeSpec) {
		calls.Add(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { supervisePipeline(ctx, nil, modeDefault); close(done) }()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("supervisor ignored context cancellation during backoff")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("expected exactly 1 pipeline call before cancel, got %d", got)
	}
}

// TestPipelineBackoffIsCapped checks the documented 1s..10s ramp.
func TestPipelineBackoffIsCapped(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 1 * time.Second},
		{1, 3 * time.Second},
		{2, 5 * time.Second},
		{3, 7 * time.Second},
		{4, 9 * time.Second},
		{5, 10 * time.Second},
		{50, 10 * time.Second},
	}
	for _, c := range cases {
		if got := pipelineBackoff(c.attempt); got != c.want {
			t.Errorf("pipelineBackoff(%d) = %s, want %s", c.attempt, got, c.want)
		}
	}
}
