//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	modUser32 = syscall.NewLazyDLL("user32.dll")
	modGdi32  = syscall.NewLazyDLL("gdi32.dll")

	procGetDC                  = modUser32.NewProc("GetDC")
	procReleaseDC              = modUser32.NewProc("ReleaseDC")
	procGetSystemMetrics       = modUser32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC     = modGdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = modGdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = modGdi32.NewProc("SelectObject")
	procBitBlt                 = modGdi32.NewProc("BitBlt")
	procGetDIBits              = modGdi32.NewProc("GetDIBits")
	procDeleteObject           = modGdi32.NewProc("DeleteObject")
	procDeleteDC               = modGdi32.NewProc("DeleteDC")
)

const (
	smCXScreen   = 0
	smCYScreen   = 1
	srcCopy      = 0x00CC0020
	biRGB        = 0
	dibRGBColors = 0
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

func getScreenSize() (int, int) {
	w, _, _ := procGetSystemMetrics.Call(uintptr(smCXScreen))
	h, _, _ := procGetSystemMetrics.Call(uintptr(smCYScreen))
	return int(w), int(h)
}

func captureScreen(width, height int) ([]byte, error) {
	hScreen, _, _ := procGetDC.Call(0)
	if hScreen == 0 {
		return nil, fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, hScreen)

	hMemDC, _, _ := procCreateCompatibleDC.Call(hScreen)
	if hMemDC == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(hMemDC)

	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hScreen, uintptr(width), uintptr(height))
	if hBitmap == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(hBitmap)

	hOld, _, _ := procSelectObject.Call(hMemDC, hBitmap)
	r, _, _ := procBitBlt.Call(hMemDC, 0, 0, uintptr(width), uintptr(height), hScreen, 0, 0, srcCopy)
	procSelectObject.Call(hMemDC, hOld)
	if r == 0 {
		return nil, fmt.Errorf("BitBlt failed")
	}

	bmi := bitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:       int32(width),
		Height:      -int32(height), // negative = top-down
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}

	buf := make([]byte, width*height*4)
	r, _, _ = procGetDIBits.Call(
		hMemDC, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&bmi)),
		dibRGBColors,
	)
	if r == 0 {
		return nil, fmt.Errorf("GetDIBits failed")
	}

	return buf, nil
}
