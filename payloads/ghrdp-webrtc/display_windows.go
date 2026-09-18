//go:build windows

package main

import (
	"log"
	"runtime"
	"time"
)

var (
	procSetThreadExecutionState = modKernel32.NewProc("SetThreadExecutionState")
	procSetLastError            = modKernel32.NewProc("SetLastError")
)

// setThreadExecutionState re-asserts the keepalive requirement on the CALLING
// thread. SetThreadExecutionState is per-thread: the requirement is held by the
// thread that set it and is dropped when that thread exits, so the caller must
// keep the thread alive and locked the whole time.
//
// The API returns the PREVIOUS execution state and NULL only on failure, so a
// successful first call legitimately returns 0. Last error is cleared first so a
// zero return can be told apart from a genuine failure instead of reporting the
// keepalive as broken on exactly the machine it is meant to fix.
func setThreadExecutionState() bool {
	procSetLastError.Call(0)
	r, _, err := procSetThreadExecutionState.Call(uintptr(keepAliveFlags))
	if !execStateOK(r, err) {
		log.Printf("SetThreadExecutionState(0x%x) failed: %v", keepAliveFlags, err)
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
		}
		displayAwake.Store(true)

		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			displayAwake.Store(setThreadExecutionState())
			sendMouseEvent(mousefMove, 0, 0, 0)
		}
	}()
}
