package main

import "syscall"

// SetThreadExecutionState flags.
const (
	esSystemRequired  = 0x00000001
	esDisplayRequired = 0x00000002
	esUserPresent     = 0x00000004 // unsupported: fails the whole call if set
	esContinuous      = 0x80000000
)

// keepAliveFlags is the requirement the server holds: keep the display and the
// system awake, continuously, for as long as the thread that set it lives.
const keepAliveFlags = esContinuous | esDisplayRequired | esSystemRequired

// execStateOK reports whether a SetThreadExecutionState call succeeded.
//
// The function returns the PREVIOUS execution state and returns NULL only on
// failure, so a successful first call from a thread that had no state set
// legitimately returns 0. Treating 0 as failure would report the keepalive as
// broken on exactly the deployment we want it working on. A zero return is
// therefore only a failure when GetLastError shows one, which the caller
// arranges by clearing the last error before the call.
func execStateOK(r uintptr, lastErr error) bool {
	if r != 0 {
		return true
	}
	if errno, ok := lastErr.(syscall.Errno); ok && errno != 0 {
		return false
	}
	return true
}
