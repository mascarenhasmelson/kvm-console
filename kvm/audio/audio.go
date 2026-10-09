// Package audio streams the capture card's HDMI audio. One arecord process
// is shared by every listener: ALSA hw devices can only be opened once, so
// the old one-process-per-websocket design made a second tab kick the first.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package audio

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// SampleRate is what the card delivers; quality levels downsample it.
	SampleRate     = 48000
	Channels       = 2
	BytesPerSample = 2
	// FrameSamples per chunk: 1920 samples = 40ms at 48kHz. Divisible by 2
	// and 3, so the downsamplers always see whole frames.
	FrameSamples = 1920
	chunkBytes   = FrameSamples * Channels * BytesPerSample
	frameBytes   = Channels * BytesPerSample
)

// RateFor returns the sample rate a quality level is delivered at.
func RateFor(quality string) int {
	switch quality {
	case "high":
		return 48000
	case "low":
		return 16000
	}
	return 24000
}

// NormalizeQuality maps unknown values to "standard".
func NormalizeQuality(q string) string {
	switch q {
	case "low", "standard", "high":
		return q
	}
	return "standard"
}

// Listener receives PCM chunks (S16LE interleaved stereo).
type Listener struct {
	quality string
	c       chan []byte
	done    chan struct{}
	once    sync.Once
}

// Chunks delivers audio. A slow listener loses chunks instead of stalling
// the capture for everybody else.
func (l *Listener) Chunks() <-chan []byte { return l.c }

// Done is closed when the capture process ends unexpectedly or the hub
// shuts down; the client should reconnect.
func (l *Listener) Done() <-chan struct{} { return l.done }

// Quality returns the listener's quality level.
func (l *Listener) Quality() string { return l.quality }

func (l *Listener) close() { l.once.Do(func() { close(l.done) }) }

// Hub runs the capture process while at least one listener is attached.
type Hub struct {
	device string
	logger *log.Logger

	mu        sync.Mutex
	listeners map[*Listener]struct{}
	cancel    context.CancelFunc
	procDone  chan struct{}
	closed    bool

	// snapshot is a []*Listener read by the capture goroutine without
	// taking mu, so stopping and restarting never deadlocks against it.
	snapshot atomic.Value
}

// NewHub prepares a hub for an ALSA PCM capture node such as
// /dev/snd/pcmC3D0c.
func NewHub(device string, logger *log.Logger) *Hub {
	if logger == nil {
		logger = log.Default()
	}
	h := &Hub{device: device, logger: logger, listeners: map[*Listener]struct{}{}}
	h.snapshot.Store([]*Listener(nil))
	return h
}

// Device returns the PCM node.
func (h *Hub) Device() string { return h.device }

// Subscribe attaches a listener, starting capture if it is the first.
func (h *Hub) Subscribe(quality string) (*Listener, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, errors.New("audio hub is closed")
	}
	if h.cancel == nil {
		if err := h.startLocked(); err != nil {
			return nil, err
		}
	}
	l := &Listener{quality: NormalizeQuality(quality), c: make(chan []byte, 8), done: make(chan struct{})}
	h.listeners[l] = struct{}{}
	h.publishLocked()
	return l, nil
}

// Unsubscribe detaches a listener, stopping capture after the last one.
func (h *Hub) Unsubscribe(l *Listener) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.listeners[l]; !ok {
		return
	}
	delete(h.listeners, l)
	h.publishLocked()
	if len(h.listeners) == 0 && h.cancel != nil {
		h.cancel()
		h.cancel = nil
	}
}

// Count returns the number of listeners.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.listeners)
}

// Streaming reports whether the capture process is running.
func (h *Hub) Streaming() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cancel != nil
}

func (h *Hub) publishLocked() {
	list := make([]*Listener, 0, len(h.listeners))
	for l := range h.listeners {
		list = append(list, l)
	}
	h.snapshot.Store(list)
}

func (h *Hub) startLocked() error {
	// The previous arecord has to be fully gone, or opening the hw device
	// again fails with "Device or resource busy".
	if h.procDone != nil {
		select {
		case <-h.procDone:
		case <-time.After(2 * time.Second):
			h.logger.Println("audio: previous capture process did not exit in time")
		}
	}

	hw, err := PCMToHW(h.device)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "arecord",
		"-t", "raw", // without this arecord prepends a WAV header
		"-f", "S16_LE",
		"-r", fmt.Sprint(SampleRate),
		"-c", fmt.Sprint(Channels),
		"-D", hw,
		"-q",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("audio: %w", err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("failed to start arecord: %w", err)
	}
	h.logger.Printf("audio: capturing %s (%s)", h.device, hw)

	done := make(chan struct{})
	h.cancel = cancel
	h.procDone = done
	go h.run(ctx, cmd, stdout, done)
	return nil
}

func (h *Hub) run(ctx context.Context, cmd *exec.Cmd, stdout io.Reader, done chan struct{}) {
	buf := make([]byte, chunkBytes)
	var readErr error
	for {
		// ReadFull keeps every chunk frame aligned; a short read used to
		// split a stereo frame in half and garble the downsampled output.
		if _, readErr = io.ReadFull(stdout, buf); readErr != nil {
			break
		}
		for _, l := range h.snapshot.Load().([]*Listener) {
			chunk := Downsample(buf, l.quality)
			select {
			case l.c <- chunk:
			default:
			}
		}
	}
	cmd.Wait()
	close(done)

	if ctx.Err() != nil {
		return // stopped on purpose
	}
	h.logger.Printf("audio: capture process ended: %v", readErr)
	h.mu.Lock()
	if h.procDone == done {
		h.cancel = nil
		for l := range h.listeners {
			l.close()
		}
		h.listeners = map[*Listener]struct{}{}
		h.publishLocked()
	}
	h.mu.Unlock()
}

// Close stops capture and disconnects every listener.
func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	if h.cancel != nil {
		h.cancel()
		h.cancel = nil
	}
	for l := range h.listeners {
		l.close()
	}
	h.listeners = map[*Listener]struct{}{}
	h.publishLocked()
	done := h.procDone
	h.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}

// Downsample returns a new buffer at the listener's rate. It drops frames
// rather than filtering: cheap enough for a Pi and fine for KVM audio.
func Downsample(buf []byte, quality string) []byte {
	step := 1
	switch quality {
	case "standard":
		step = 2
	case "low":
		step = 3
	}
	usable := len(buf) - len(buf)%frameBytes
	out := make([]byte, 0, usable/step+frameBytes)
	for i := 0; i+frameBytes <= usable; i += frameBytes * step {
		out = append(out, buf[i:i+frameBytes]...)
	}
	return out
}

var pcmRegex = regexp.MustCompile(`pcmC(\d+)D(\d+)[cp]`)

// PCMToHW converts "pcmC1D0c" (or a /dev/snd path) to the ALSA name "hw:1,0".
func PCMToHW(dev string) (string, error) {
	m := pcmRegex.FindStringSubmatch(dev)
	if len(m) < 3 {
		return "", fmt.Errorf("invalid ALSA PCM device %q", dev)
	}
	return fmt.Sprintf("hw:%s,%s", m[1], m[2]), nil
}
