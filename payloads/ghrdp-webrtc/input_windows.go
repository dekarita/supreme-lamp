//go:build windows

package main

import (
	"encoding/json"
	"time"
	"unsafe"
)

var procSendInput = modUser32.NewProc("SendInput")

const (
	inputMouse    = 0
	inputKeyboard = 1

	mousefMove     = 0x0001
	mousefAbsolute = 0x8000
	mousefVDesk    = 0x4000
	mousefLeftDown = 0x0002
	mousefLeftUp   = 0x0004
	mousefRightDown = 0x0008
	mousefRightUp   = 0x0010
	mousefWheel     = 0x0800

	kefUp      = 0x0002
	kefUnicode = 0x0004

	inputStructSize = 40 // sizeof(INPUT) on x64
)

type inputEvent struct {
	T  string  `json:"t"`
	NX float64 `json:"nx"`
	NY float64 `json:"ny"`
	D  int     `json:"d"`
	VK int     `json:"vk"`
	Ch string  `json:"ch"`
}

func sendMouseEvent(flags uint32, dx, dy int32, data uint32) {
	var inp [inputStructSize]byte
	*(*uint32)(unsafe.Pointer(&inp[0])) = inputMouse
	*(*int32)(unsafe.Pointer(&inp[8])) = dx
	*(*int32)(unsafe.Pointer(&inp[12])) = dy
	*(*uint32)(unsafe.Pointer(&inp[16])) = data
	*(*uint32)(unsafe.Pointer(&inp[20])) = flags
	procSendInput.Call(1, uintptr(unsafe.Pointer(&inp[0])), inputStructSize)
}

func sendKeyEvent(vk, scan uint16, flags uint32) {
	var inp [inputStructSize]byte
	*(*uint32)(unsafe.Pointer(&inp[0])) = inputKeyboard
	*(*uint16)(unsafe.Pointer(&inp[8])) = vk
	*(*uint16)(unsafe.Pointer(&inp[10])) = scan
	*(*uint32)(unsafe.Pointer(&inp[12])) = flags
	procSendInput.Call(1, uintptr(unsafe.Pointer(&inp[0])), inputStructSize)
}

func sendUnicodeChar(ch uint16) {
	sendKeyEvent(0, ch, kefUnicode)
	sendKeyEvent(0, ch, kefUnicode|kefUp)
}

func handleInputMessage(data []byte) {
	var ev inputEvent
	if json.Unmarshal(data, &ev) != nil {
		return
	}
	stats.lastInputNs.Store(time.Now().UnixNano())
	switch ev.T {
	case "m":
		nx := ev.NX
		ny := ev.NY
		if nx < 0 {
			nx = 0
		} else if nx > 1 {
			nx = 1
		}
		if ny < 0 {
			ny = 0
		} else if ny > 1 {
			ny = 1
		}
		sendMouseEvent(
			mousefMove|mousefAbsolute|mousefVDesk,
			int32(nx*65535), int32(ny*65535), 0,
		)
	case "ld":
		sendMouseEvent(mousefLeftDown, 0, 0, 0)
	case "lu":
		sendMouseEvent(mousefLeftUp, 0, 0, 0)
	case "rd":
		sendMouseEvent(mousefRightDown, 0, 0, 0)
	case "ru":
		sendMouseEvent(mousefRightUp, 0, 0, 0)
	case "w":
		d := ev.D
		if d == 0 {
			d = -1
		}
		sendMouseEvent(mousefWheel, 0, 0, uint32(int32(d*120)))
	case "kd":
		sendKeyEvent(uint16(ev.VK), 0, 0)
	case "ku":
		sendKeyEvent(uint16(ev.VK), 0, kefUp)
	case "k":
		if len(ev.Ch) > 0 {
			sendUnicodeChar(uint16(rune(ev.Ch[0])))
		}
	}
}
