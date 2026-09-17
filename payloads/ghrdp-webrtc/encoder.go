package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
)

type encoder struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	outCh  chan []byte
	mu     sync.Mutex
	closed bool
}

func newEncoder(width, height, fps int) (*encoder, error) {
	args := []string{
		"-f", "rawvideo",
		"-pixel_format", "bgra",
		"-video_size", fmt.Sprintf("%dx%d", width, height),
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", "pipe:0",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-profile:v", "baseline",
		"-level", "3.1",
		"-pix_fmt", "yuv420p",
		"-crf", "28",
		"-g", "60",
		"-sc_threshold", "0",
		"-x264-params", "repeat-headers=1",
		"-f", "h264",
		"-flush_packets", "1",
		"pipe:1",
	}

	cmd := exec.Command("ffmpeg", args...)
	cmd.Stderr = io.Discard

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ffmpeg start: %w", err)
	}

	e := &encoder{
		cmd:   cmd,
		stdin: stdin,
		outCh: make(chan []byte, 8),
	}

	go e.readLoop(stdout)
	return e, nil
}

func (e *encoder) writeFrame(bgra []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return fmt.Errorf("encoder closed")
	}
	_, err := e.stdin.Write(bgra)
	return err
}

func (e *encoder) output() <-chan []byte {
	return e.outCh
}

func (e *encoder) close() {
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
	e.stdin.Close()
	e.cmd.Wait()
}

func (e *encoder) readLoop(stdout io.ReadCloser) {
	defer close(e.outCh)

	reader := bufio.NewReaderSize(stdout, 512*1024)
	var pending []byte
	tmp := make([]byte, 128*1024)

	for {
		n, err := reader.Read(tmp)
		if n > 0 {
			pending = append(pending, tmp[:n]...)
			for {
				au, rest, ok := extractAccessUnit(pending)
				if !ok {
					break
				}
				cp := make([]byte, len(au))
				copy(cp, au)
				select {
				case e.outCh <- cp:
				default:
					log.Println("encoder: frame dropped (consumer slow)")
				}
				pending = append(pending[:0], rest...)
			}
		}
		if err != nil {
			if len(pending) > 4 {
				cp := make([]byte, len(pending))
				copy(cp, pending)
				e.outCh <- cp
			}
			return
		}
	}
}

// extractAccessUnit splits one H.264 access unit from Annex B data.
// An access unit boundary is where the next VCL NAL (type 1 or 5) begins
// after we already saw one, or where an SPS appears after a slice.
func extractAccessUnit(data []byte) (au, rest []byte, found bool) {
	positions := findStartCodes(data)
	if len(positions) < 2 {
		return nil, data, false
	}

	seenSlice := false
	for i, pos := range positions {
		nt := nalTypeAt(data, pos)
		isVCL := nt == 1 || nt == 5
		if isVCL {
			if seenSlice {
				return data[:positions[i]], data[positions[i]:], true
			}
			seenSlice = true
		} else if nt == 7 && seenSlice {
			return data[:positions[i]], data[positions[i]:], true
		}
	}

	return nil, data, false
}

func findStartCodes(data []byte) []int {
	var pos []int
	for i := 0; i < len(data)-3; i++ {
		if data[i] == 0 && data[i+1] == 0 {
			if data[i+2] == 1 {
				pos = append(pos, i)
				i += 2
			} else if i < len(data)-4 && data[i+2] == 0 && data[i+3] == 1 {
				pos = append(pos, i)
				i += 3
			}
		}
	}
	return pos
}

func nalTypeAt(data []byte, pos int) byte {
	off := pos + 3 // assume 3-byte start code
	if pos+3 < len(data) && data[pos+2] == 0 {
		off = pos + 4 // 4-byte start code
	}
	if off >= len(data) {
		return 0
	}
	return data[off] & 0x1F
}
