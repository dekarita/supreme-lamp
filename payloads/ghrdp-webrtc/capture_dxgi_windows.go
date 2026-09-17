//go:build windows

package main

import (
	"fmt"
	"log"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	modD3D11 = syscall.NewLazyDLL("d3d11.dll")
	modDXGI  = syscall.NewLazyDLL("dxgi.dll")

	procD3D11CreateDevice = modD3D11.NewProc("D3D11CreateDevice")
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	iidIDXGIDevice     = guid{0x54ec77fa, 0x1377, 0x44e6, [8]byte{0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}}
	iidIDXGIOutput1    = guid{0x00cddea8, 0x939b, 0x4b83, [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	iidID3D11Texture2D = guid{0x6f15aaf2, 0xd208, 0x4e89, [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
)

const (
	d3dDriverTypeUnknown  = 0
	d3dDriverTypeHardware = 1
	d3d11SDKVersion       = 7
	d3d11UsageStaging     = 3
	d3d11CPUAccessRead    = 0x20000
	d3d11MapRead          = 1
	dxgiFormatB8G8R8A8    = 87
)

type d3d11Texture2DDesc struct {
	Width          uint32
	Height         uint32
	MipLevels      uint32
	ArraySize      uint32
	Format         uint32
	SampleDescCnt  uint32
	SampleDescQual uint32
	Usage          uint32
	BindFlags      uint32
	CPUAccessFlags uint32
	MiscFlags      uint32
}

type d3d11MappedSubresource struct {
	PData      uintptr
	RowPitch   uint32
	DepthPitch uint32
}

type dxgiFrameInfo struct {
	LastPresentTime     int64
	LastMouseUpdateTime int64
	AccumulatedFrames   uint32
	RectsCoalesced      int32
	ProtectedContent    int32
	PointerX            int32
	PointerY            int32
	PointerVisible      int32
	TotalMetadataSize   uint32
	PointerShapeSize    uint32
}

type dxgiCapturer struct {
	device      uintptr
	ctx         uintptr
	duplication uintptr
	staging     uintptr
	width       int
	height      int
	mu          sync.Mutex
}

var dxgi *dxgiCapturer

func comVtbl(obj uintptr, idx int) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	return *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
}

func comRelease(obj uintptr) {
	if obj != 0 {
		syscall.SyscallN(comVtbl(obj, 2), obj)
	}
}

func comQueryInterface(obj uintptr, iid *guid, out *uintptr) error {
	hr, _, _ := syscall.SyscallN(comVtbl(obj, 0), obj, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(out)))
	if hr != 0 {
		return fmt.Errorf("QueryInterface failed: 0x%08x", hr)
	}
	return nil
}

func initDXGI() error {
	var device, ctx uintptr
	featureLevel := uint32(0xb000) // D3D_FEATURE_LEVEL_11_0

	hr, _, _ := procD3D11CreateDevice.Call(
		0,                                      // pAdapter (NULL = default)
		d3dDriverTypeHardware,                  // DriverType
		0,                                      // Software
		0,                                      // Flags
		uintptr(unsafe.Pointer(&featureLevel)), // pFeatureLevels
		1,                                      // FeatureLevels
		d3d11SDKVersion,                        // SDKVersion
		uintptr(unsafe.Pointer(&device)),       // ppDevice
		0,                                      // pFeatureLevel (out, ignored)
		uintptr(unsafe.Pointer(&ctx)),          // ppImmediateContext
	)
	if hr != 0 {
		return fmt.Errorf("D3D11CreateDevice: 0x%08x", hr)
	}

	var dxgiDevice uintptr
	if err := comQueryInterface(device, &iidIDXGIDevice, &dxgiDevice); err != nil {
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("IDXGIDevice: %w", err)
	}
	defer comRelease(dxgiDevice)

	// IDXGIDevice::GetAdapter (vtable index 7)
	var adapter uintptr
	hr, _, _ = syscall.SyscallN(comVtbl(dxgiDevice, 7), dxgiDevice, uintptr(unsafe.Pointer(&adapter)))
	if hr != 0 {
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("GetAdapter: 0x%08x", hr)
	}
	defer comRelease(adapter)

	// IDXGIAdapter::EnumOutputs(0) (vtable index 7)
	var output uintptr
	hr, _, _ = syscall.SyscallN(comVtbl(adapter, 7), adapter, 0, uintptr(unsafe.Pointer(&output)))
	if hr != 0 {
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("EnumOutputs: 0x%08x", hr)
	}
	defer comRelease(output)

	// QueryInterface for IDXGIOutput1
	var output1 uintptr
	if err := comQueryInterface(output, &iidIDXGIOutput1, &output1); err != nil {
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("IDXGIOutput1: %w", err)
	}
	defer comRelease(output1)

	// IDXGIOutput1::DuplicateOutput (vtable index 22)
	var duplication uintptr
	hr, _, _ = syscall.SyscallN(comVtbl(output1, 22), output1, device, uintptr(unsafe.Pointer(&duplication)))
	if hr != 0 {
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("DuplicateOutput: 0x%08x", hr)
	}

	// Get duplication desc for dimensions (vtable index 7)
	type dxgiOutduplDesc struct {
		ModeDescWidth            uint32
		ModeDescHeight           uint32
		ModeDescRefreshNum       uint32
		ModeDescRefreshDen       uint32
		ModeDescFormat           uint32
		ModeDescScanlineOrdering uint32
		ModeDescScaling          uint32
		Rotation                 uint32
		DesktopImageInSysMem     int32
	}
	var desc dxgiOutduplDesc
	syscall.SyscallN(comVtbl(duplication, 7), duplication, uintptr(unsafe.Pointer(&desc)))

	w := int(desc.ModeDescWidth)
	h := int(desc.ModeDescHeight)
	if w == 0 || h == 0 {
		comRelease(duplication)
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("DXGI reported 0x0 desktop")
	}

	// Create staging texture for CPU readback
	stagingDesc := d3d11Texture2DDesc{
		Width:          uint32(w),
		Height:         uint32(h),
		MipLevels:      1,
		ArraySize:      1,
		Format:         dxgiFormatB8G8R8A8,
		SampleDescCnt:  1,
		SampleDescQual: 0,
		Usage:          d3d11UsageStaging,
		BindFlags:      0,
		CPUAccessFlags: d3d11CPUAccessRead,
		MiscFlags:      0,
	}
	var staging uintptr
	// ID3D11Device::CreateTexture2D (vtable index 5)
	hr, _, _ = syscall.SyscallN(comVtbl(device, 5), device,
		uintptr(unsafe.Pointer(&stagingDesc)), 0, uintptr(unsafe.Pointer(&staging)))
	if hr != 0 {
		comRelease(duplication)
		comRelease(ctx)
		comRelease(device)
		return fmt.Errorf("CreateTexture2D(staging): 0x%08x", hr)
	}

	dxgi = &dxgiCapturer{
		device:      device,
		ctx:         ctx,
		duplication: duplication,
		staging:     staging,
		width:       w,
		height:      h,
	}

	log.Printf("DXGI Desktop Duplication initialized: %dx%d", w, h)
	return nil
}

func captureDXGI() ([]byte, int, int, error) {
	if dxgi == nil {
		return nil, 0, 0, fmt.Errorf("DXGI not initialized")
	}
	dxgi.mu.Lock()
	defer dxgi.mu.Unlock()

	var frameInfo dxgiFrameInfo
	var desktopResource uintptr

	// AcquireNextFrame (vtable index 8), 100ms timeout
	hr, _, _ := syscall.SyscallN(comVtbl(dxgi.duplication, 8), dxgi.duplication,
		100, uintptr(unsafe.Pointer(&frameInfo)), uintptr(unsafe.Pointer(&desktopResource)))
	if hr != 0 {
		return nil, 0, 0, fmt.Errorf("AcquireNextFrame: 0x%08x", hr)
	}
	defer func() {
		comRelease(desktopResource)
		// ReleaseFrame (vtable index 14)
		syscall.SyscallN(comVtbl(dxgi.duplication, 14), dxgi.duplication)
	}()

	// QueryInterface for ID3D11Texture2D on the desktop resource
	var srcTexture uintptr
	if err := comQueryInterface(desktopResource, &iidID3D11Texture2D, &srcTexture); err != nil {
		return nil, 0, 0, fmt.Errorf("srcTexture QI: %w", err)
	}
	defer comRelease(srcTexture)

	// CopyResource: staging <- src (vtable index 46 on ID3D11DeviceContext)
	syscall.SyscallN(comVtbl(dxgi.ctx, 46), dxgi.ctx, dxgi.staging, srcTexture)

	// Map staging texture (vtable index 14 on ID3D11DeviceContext)
	var mapped d3d11MappedSubresource
	hr, _, _ = syscall.SyscallN(comVtbl(dxgi.ctx, 14), dxgi.ctx,
		dxgi.staging, 0, d3d11MapRead, 0, uintptr(unsafe.Pointer(&mapped)))
	if hr != 0 {
		return nil, 0, 0, fmt.Errorf("Map: 0x%08x", hr)
	}

	w := dxgi.width
	h := dxgi.height
	rowBytes := w * 4
	buf := make([]byte, w*h*4)

	srcPtr := mapped.PData
	pitch := int(mapped.RowPitch)
	for y := 0; y < h; y++ {
		src := unsafe.Slice((*byte)(unsafe.Pointer(srcPtr+uintptr(y*pitch))), rowBytes)
		copy(buf[y*rowBytes:(y+1)*rowBytes], src)
	}

	// Unmap (vtable index 15)
	syscall.SyscallN(comVtbl(dxgi.ctx, 15), dxgi.ctx, dxgi.staging, 0)

	return buf, w, h, nil
}

func closeDXGI() {
	if dxgi == nil {
		return
	}
	dxgi.mu.Lock()
	defer dxgi.mu.Unlock()
	comRelease(dxgi.staging)
	comRelease(dxgi.duplication)
	comRelease(dxgi.ctx)
	comRelease(dxgi.device)
	dxgi = nil
	log.Println("DXGI released")
}

func benchmarkCapture(srcW, srcH, capW, capH int) {
	const n = 200

	// Benchmark GDI
	gdiTimes := make([]time.Duration, 0, n)
	for i := 0; i < n; i++ {
		t := time.Now()
		_, err := captureScreenScaled(srcW, srcH, capW, capH)
		if err != nil {
			break
		}
		gdiTimes = append(gdiTimes, time.Since(t))
	}
	if len(gdiTimes) > 0 {
		var total time.Duration
		for _, d := range gdiTimes {
			total += d
		}
		avg := total / time.Duration(len(gdiTimes))
		log.Printf("BENCH GDI StretchBlt %dx%d→%dx%d: %d frames, avg %.2fms/frame (max %.0f fps)",
			srcW, srcH, capW, capH, len(gdiTimes), float64(avg.Microseconds())/1000.0,
			1000.0/float64(avg.Milliseconds()+1))
	}

	// Benchmark DXGI if available
	if dxgi != nil {
		dxgiTimes := make([]time.Duration, 0, n)
		for i := 0; i < n; i++ {
			t := time.Now()
			_, _, _, err := captureDXGI()
			if err != nil {
				break
			}
			dxgiTimes = append(dxgiTimes, time.Since(t))
		}
		if len(dxgiTimes) > 0 {
			var total time.Duration
			for _, d := range dxgiTimes {
				total += d
			}
			avg := total / time.Duration(len(dxgiTimes))
			log.Printf("BENCH DXGI %dx%d: %d frames, avg %.2fms/frame (max %.0f fps)",
				dxgi.width, dxgi.height, len(dxgiTimes), float64(avg.Microseconds())/1000.0,
				1000.0/float64(avg.Milliseconds()+1))
		}
	}
}
