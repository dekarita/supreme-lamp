//go:build windows

package main

import (
	"log"
	"runtime"
	"time"
)

var (
	procSetThreadExecutionState = modKernel32.NewProc("SetThreadExecutionState")
)

const (
	esSystemRequired  = 0x00000001
	esDisplayRequired = 0x00000002
	esContinuous      = 0x80000000
)

// SetThreadExecutionState is per-THREAD: the requirement is held by the calling
// thread and is dropped when that thread exits. The caller must therefore keep
// the thread alive and locked, which startDisplayKeepAlive does.
func setThreadExecutionState() bool {
	r, _, err := procSetThreadExecutionState.Call(uintptr(esContinuous | esDisplayRequired | esSystemRequired))
	if r == 0 {
		log.Printf("SetThreadExecutionState failed: %v", err)
		return false
	}
	return true
}

// startDisplayKeepAlive stops Windows from dimming or blanking the console during
// idle periods. Without it the captured desktop progressively darkens: the session
// stays "interactive" and GDI keeps returning frames, so nothing else notices.
//
// It holds one OS thread for the lifetime of the process because the execution
// state is thread-scoped; calls from a short-lived goroutine that migrates across
// threads would not keep the display awake.
func startDisplayKeepAlive() {
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		if setThreadExecutionState() {
			log.Println("display keepalive active (ES_CONTINUOUS|ES_DISPLAY_REQUIRED|ES_SYSTEM_REQUIRED)")
			displayAwake.Store(true)
		}

		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			// Re-assert: some power-policy changes clear the flag underneath us.
			displayAwake.Store(setThreadExecutionState())
		}
	}()
}
