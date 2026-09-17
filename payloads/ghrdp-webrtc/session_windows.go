//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var (
	modKernel32 = syscall.NewLazyDLL("kernel32.dll")

	procGetCurrentProcessId  = modKernel32.NewProc("GetCurrentProcessId")
	procProcessIdToSessionId = modKernel32.NewProc("ProcessIdToSessionId")
	procCreateMutexW         = modKernel32.NewProc("CreateMutexW")
	procCloseHandle          = modKernel32.NewProc("CloseHandle")
)

const errAlreadyExists = 183

// resolveSessionID returns the Terminal Services session of this process.
// Desktop capture only works from an interactive session; session 0 is the
// service session and yields a black/frozen desktop.
func resolveSessionID() (int, error) {
	pid, _, _ := procGetCurrentProcessId.Call()
	var sid uint32
	r, _, err := procProcessIdToSessionId.Call(pid, uintptr(unsafe.Pointer(&sid)))
	if r == 0 {
		return -1, fmt.Errorf("ProcessIdToSessionId: %v", err)
	}
	return int(sid), nil
}

// acquireSingleton takes the global mutex and returns a release func. Global\
// creation needs SeCreateGlobalPrivilege, so fall back to a per-session Local\
// mutex rather than failing the whole deploy on a locked-down runner.
func acquireSingleton() (func(), error) {
	handle, err := createMutex(`Global\GhrdpWebRTC`)
	if err == nil {
		return release(handle), nil
	}
	if err == errMutexExists {
		return nil, fmt.Errorf("another %s instance already holds Global\\GhrdpWebRTC", exeBaseName())
	}
	log.Printf("Global\\ mutex unavailable (%v); falling back to Local\\GhrdpWebRTC", err)
	handle, err = createMutex(`Local\GhrdpWebRTC`)
	if err == nil {
		return release(handle), nil
	}
	if err == errMutexExists {
		return nil, fmt.Errorf("another %s instance already holds Local\\GhrdpWebRTC", exeBaseName())
	}
	return nil, fmt.Errorf("cannot create singleton mutex: %w", err)
}

var errMutexExists = fmt.Errorf("mutex already exists")

func createMutex(name string) (uintptr, error) {
	n, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	h, _, callErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(n)))
	if h == 0 {
		return 0, fmt.Errorf("CreateMutexW %s: %v", name, callErr)
	}
	if callErr != nil {
		if errno, ok := callErr.(syscall.Errno); ok && errno == errAlreadyExists {
			procCloseHandle.Call(h)
			return 0, errMutexExists
		}
	}
	return h, nil
}

func release(h uintptr) func() {
	return func() { procCloseHandle.Call(h) }
}

func exeBaseName() string {
	if exe, err := os.Executable(); err == nil {
		if i := strings.LastIndexAny(exe, `\/`); i >= 0 {
			return exe[i+1:]
		}
		return exe
	}
	return "webrtc-server.exe"
}

// killStaleFFmpeg terminates ffmpeg processes that this server did not spawn.
// A rebooted/deployed runner frequently inherits an ffmpeg from a previous
// server instance; it keeps writing to a dead pipe and the stats stay frozen.
func killStaleFFmpeg() {
	const ps = `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)" }`
	out, err := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps).Output()
	if err != nil && len(out) == 0 {
		log.Printf("stale-ffmpeg scan skipped: %v", err)
		return
	}
	self := os.Getpid()
	live := map[int]bool{self: true}
	for _, pid := range processIDsByName("webrtc-server.exe") {
		if pid != self {
			live[pid] = true
		}
	}
	killed := 0
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		pid, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			continue
		}
		ppid := -1
		if len(parts) == 2 {
			ppid, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
		}
		if live[ppid] || pid == self {
			continue
		}
		if p, err := os.FindProcess(pid); err == nil {
			if err := p.Kill(); err == nil {
				killed++
				log.Printf("killed stale ffmpeg pid=%d (parent %d gone/foreign)", pid, ppid)
			}
		}
	}
	log.Printf("stale-ffmpeg scan complete: %d killed", killed)
}

func processIDsByName(name string) []int {
	out, err := exec.Command("tasklist.exe", "/FI", "IMAGENAME eq "+name, "/FO", "CSV", "/NH").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Split(line, ",")
		if len(fields) < 2 {
			continue
		}
		if pid, err := strconv.Atoi(strings.Trim(strings.TrimSpace(fields[1]), `"`)); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}
