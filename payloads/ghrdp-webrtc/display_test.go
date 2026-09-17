package main

import (
	"syscall"
	"testing"
)

// TestExecStateOKZeroIsSuccess is the regression test for the anti-idle
// keepalive. SetThreadExecutionState returns the PREVIOUS execution state and
// NULL only on failure, so the first successful call from a thread with no state
// set returns 0. An earlier version treated any 0 as failure, which reported the
// keepalive as broken and left /stats display_awake false on exactly the
// deployment the keepalive exists to fix.
func TestExecStateOKZeroIsSuccess(t *testing.T) {
	if !execStateOK(0, syscall.Errno(0)) {
		t.Fatal("zero return with no pending error must be treated as success")
	}
}

func TestExecStateOKNonZeroIsSuccess(t *testing.T) {
	if !execStateOK(uintptr(esContinuous|esDisplayRequired), syscall.Errno(0)) {
		t.Fatal("non-zero return (previous state) must be success")
	}
}

func TestExecStateOKErrorIsFailure(t *testing.T) {
	if execStateOK(0, syscall.Errno(87)) {
		t.Fatal("zero return with a pending error must be treated as failure")
	}
}

// TestKeepAliveFlags pins the documented flag combination. ES_USER_PRESENT (0x4)
// is explicitly unsupported and makes the whole call fail, so it must never be
// part of this mask.
func TestKeepAliveFlags(t *testing.T) {
	want := uintptr(0x80000000 | 0x00000002 | 0x00000001) // CONTINUOUS|DISPLAY_REQUIRED|SYSTEM_REQUIRED
	if keepAliveFlags != want {
		t.Fatalf("keepAliveFlags = 0x%x, want 0x%x", keepAliveFlags, want)
	}
	if keepAliveFlags&esUserPresent != 0 {
		t.Fatal("ES_USER_PRESENT is unsupported and fails the call; must not be set")
	}
}
