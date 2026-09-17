//go:build !windows

package main

import (
	"fmt"
	"image"
	"image/color"
	"os"
	"time"
)

// Non-Windows build is only for local CI validation of the HTTP/signaling
// surface (the /version contract, mutex, session guard). There is no desktop to
// capture, so the capture path renders a deterministic test pattern that still
// exercises the exact same size assertion and ffmpeg pipe.

type stubCapturer struct{ width, height int }

var dxgi *stubCapturer

func getScreenSize() (int, int) { return 1024, 768 }

func initDXGI() error { return fmt.Errorf("DXGI unavailable on this platform") }

func captureDXGI() ([]byte, int, int, error) {
	return nil, 0, 0, fmt.Errorf("DXGI unavailable")
}

func closeDXGI() {}

func benchmarkCapture(srcW, srcH, capW, capH int) {}

func captureScreen(width, height int) ([]byte, error) {
	return captureScreenScaled(width, height, width, height)
}

func captureScreenScaled(srcW, srcH, dstW, dstH int) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for y := 0; y < dstH; y++ {
		for x := 0; x < dstW; x++ {
			img.Set(x, y, color.RGBA{
				R: uint8((x * 255) / max(1, dstW-1)),
				G: uint8((y * 255) / max(1, dstH-1)),
				B: uint8(((x + y) * 255) / max(1, dstW+dstH-2)),
				A: 255,
			})
		}
	}
	// BGRA byte order, matching the Windows capture path.
	buf := make([]byte, dstW*dstH*4)
	for i := 0; i < dstW*dstH; i++ {
		buf[i*4+0] = img.Pix[i*4+2]
		buf[i*4+1] = img.Pix[i*4+1]
		buf[i*4+2] = img.Pix[i*4+0]
		buf[i*4+3] = 255
	}
	return buf, nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func resolveSessionID() (int, error) {
	if v := os.Getenv("GHRDP_TEST_SESSION"); v != "" {
		var n int
		fmt.Sscanf(v, "%d", &n)
		return n, nil
	}
	return 2, nil
}

func acquireSingleton() (func(), error) {
	return func() {}, nil
}

func killStaleFFmpeg() {}

func killPortOwner(port int) {}

func startDisplayKeepAlive() {}

func handleInputMessage(data []byte) {
	stats.lastInputNs.Store(time.Now().UnixNano())
}
