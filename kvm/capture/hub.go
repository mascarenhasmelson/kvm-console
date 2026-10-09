package capture

/*
	hub.go

	The capture card delivers frames on a single channel, which used to mean
	a single viewer: every new browser tab kicked out the previous one. The
	Hub is the only reader of that channel instead. It keeps the latest frame
	(for snapshots) and hands every frame to each subscriber through a
	one-slot mailbox, so a viewer on a slow link simply skips frames rather
	than holding back everybody else or the capture loop itself.

	Optional JPEG re-encoding also happens here, once per frame, instead of
	once per viewer.
*/

import (
	"bytes"
	"errors"
	"fmt"
	"image/jpeg"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Hub fans the frames of one Source out to any number of viewers.
type Hub struct {
	src     Source
	quality int // JPEG re-encode quality, 0 = pass frames through
	logger  *log.Logger

	// changeMu serialises Start/Stop/ChangeResolution: closing and reopening
	// a V4L2 device is not safe to run twice concurrently.
	changeMu sync.Mutex

	mu      sync.RWMutex
	running bool
	closed  bool
	res     Resolution
	info    StreamInfo
	latest  []byte
	subs    map[*Subscriber]struct{}
	stop    chan struct{}
	done    chan struct{}
	fps     float64
	kbps    float64

	statFrames atomic.Int64
	statBytes  atomic.Int64
	statsStop  chan struct{}
}

// Subscriber is one viewer of the hub.
type Subscriber struct {
	c    chan []byte
	done chan struct{}
	once sync.Once
}

// Frames delivers the newest frame whenever the viewer is ready for one.
func (s *Subscriber) Frames() <-chan []byte { return s.c }

// Done is closed when the hub shuts down.
func (s *Subscriber) Done() <-chan struct{} { return s.done }

func (s *Subscriber) close() { s.once.Do(func() { close(s.done) }) }

// deliver replaces whatever is waiting in the mailbox with frame. It never
// blocks: a viewer that has not picked up the previous frame loses it.
func (s *Subscriber) deliver(frame []byte) {
	select {
	case s.c <- frame:
		return
	default:
	}
	select {
	case <-s.c:
	default:
	}
	select {
	case s.c <- frame:
	default:
	}
}

// NewHub wraps a source. jpegQuality between 5 and 100 re-encodes every
// frame to cut bandwidth; 0 passes the card's frames through untouched.
func NewHub(src Source, jpegQuality int, logger *log.Logger) *Hub {
	if logger == nil {
		logger = log.Default()
	}
	h := &Hub{
		src:       src,
		quality:   jpegQuality,
		logger:    logger,
		subs:      make(map[*Subscriber]struct{}),
		statsStop: make(chan struct{}),
	}
	go h.statsLoop()
	return h
}

// Source returns the wrapped source.
func (h *Hub) Source() Source { return h.src }

// Start opens the source at res.
func (h *Hub) Start(res Resolution) error {
	h.changeMu.Lock()
	defer h.changeMu.Unlock()
	return h.startLocked(res)
}

func (h *Hub) startLocked(res Resolution) error {
	h.mu.RLock()
	running, closed := h.running, h.closed
	h.mu.RUnlock()
	if closed {
		return errors.New("capture hub is closed")
	}
	if running {
		return errors.New("video capture already started")
	}

	frames, info, err := h.src.Open(res)
	if err != nil {
		return err
	}
	stop := make(chan struct{})
	done := make(chan struct{})

	h.mu.Lock()
	h.running = true
	h.res = res
	h.info = info
	h.stop = stop
	h.done = done
	h.mu.Unlock()

	go h.pump(frames, stop, done)
	return nil
}

// Stop closes the source. Subscribers stay attached and resume receiving
// frames after the next Start.
func (h *Hub) Stop() error {
	h.changeMu.Lock()
	defer h.changeMu.Unlock()
	return h.stopLocked()
}

func (h *Hub) stopLocked() error {
	h.mu.Lock()
	if !h.running {
		h.mu.Unlock()
		return nil
	}
	stop, done := h.stop, h.done
	h.running = false
	h.mu.Unlock()

	close(stop)
	err := h.src.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		h.logger.Println("capture: frame pump did not exit within 3s")
	}
	return err
}

// ChangeResolution reopens the source at a new mode. Viewers are not
// disconnected; they see the last frame until the new mode starts.
func (h *Hub) ChangeResolution(res Resolution) error {
	h.changeMu.Lock()
	defer h.changeMu.Unlock()

	modes, err := h.src.Modes()
	if err != nil {
		return fmt.Errorf("failed to read supported modes: %w", err)
	}
	if !SupportsResolution(modes, res) {
		return fmt.Errorf("resolution %dx%d @ %d fps is not supported by this device", res.Width, res.Height, res.FPS)
	}

	h.mu.RLock()
	previous, wasRunning := h.res, h.running
	h.mu.RUnlock()

	if err := h.stopLocked(); err != nil {
		h.logger.Printf("capture: error while stopping for a resolution change: %v", err)
	}
	// Give the driver a moment to release its buffers before reopening.
	time.Sleep(300 * time.Millisecond)

	for attempt := 1; attempt <= 3; attempt++ {
		if err = h.startLocked(res); err == nil {
			return nil
		}
		h.logger.Printf("capture: starting %dx%d@%d failed (attempt %d/3): %v", res.Width, res.Height, res.FPS, attempt, err)
		time.Sleep(500 * time.Millisecond)
	}

	// Leave the device in the mode it was in rather than with no picture.
	if wasRunning {
		if restoreErr := h.startLocked(previous); restoreErr != nil {
			h.logger.Printf("capture: restoring the previous mode failed too: %v", restoreErr)
		}
	}
	return fmt.Errorf("failed to start capture at the new resolution: %w", err)
}

// pump is the single reader of the source channel.
func (h *Hub) pump(frames <-chan []byte, stop, done chan struct{}) {
	defer close(done)
	// Chrome's MJPEG decoder cannot decode the first frame an MS2109 delivers
	// after the device is opened, so it is dropped here once per open.
	first := true
	for {
		select {
		case <-stop:
			return
		case frame, ok := <-frames:
			if !ok {
				return
			}
			if first {
				first = false
				continue
			}
			if !IsJPEG(frame) {
				continue // corrupted or empty frame
			}
			// The driver may reuse its buffer, and the hub holds on to frames
			// (latest, mailboxes), so take a private copy.
			frame = append([]byte(nil), frame...)
			if h.quality > 0 {
				reencoded, err := reencode(frame, h.quality)
				if err != nil {
					continue
				}
				frame = reencoded
			}
			h.Publish(frame)
		}
	}
}

// Publish hands a frame to every subscriber and records it as the latest.
func (h *Hub) Publish(frame []byte) {
	h.statFrames.Add(1)
	h.statBytes.Add(int64(len(frame)))

	h.mu.Lock()
	h.latest = frame
	subs := make([]*Subscriber, 0, len(h.subs))
	for s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.Unlock()

	for _, s := range subs {
		s.deliver(frame)
	}
}

// Subscribe attaches a new viewer.
func (h *Hub) Subscribe() *Subscriber {
	s := &Subscriber{c: make(chan []byte, 1), done: make(chan struct{})}
	h.mu.Lock()
	if h.closed {
		s.close()
	} else {
		h.subs[s] = struct{}{}
	}
	h.mu.Unlock()
	return s
}

// Unsubscribe detaches a viewer.
func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// Latest returns the most recent frame, or nil before the first one.
func (h *Hub) Latest() []byte {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.latest
}

// HubStatus is a snapshot of the hub for the status API.
type HubStatus struct {
	Capturing bool
	Info      StreamInfo
	Viewers   int
	FPS       float64
	Kbps      float64
}

// Status returns the current state and measured throughput.
func (h *Hub) Status() HubStatus {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return HubStatus{
		Capturing: h.running,
		Info:      h.info,
		Viewers:   len(h.subs),
		FPS:       h.fps,
		Kbps:      h.kbps,
	}
}

func (h *Hub) statsLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	last := time.Now()
	for {
		select {
		case <-h.statsStop:
			return
		case now := <-ticker.C:
			elapsed := now.Sub(last).Seconds()
			last = now
			frames := h.statFrames.Swap(0)
			sent := h.statBytes.Swap(0)
			if elapsed <= 0 {
				continue
			}
			h.mu.Lock()
			h.fps = float64(frames) / elapsed
			h.kbps = float64(sent) * 8 / 1000 / elapsed
			h.mu.Unlock()
		}
	}
}

// Close stops capturing and disconnects every viewer.
func (h *Hub) Close() error {
	h.changeMu.Lock()
	defer h.changeMu.Unlock()
	err := h.stopLocked()

	h.mu.Lock()
	if !h.closed {
		h.closed = true
		close(h.statsStop)
		for s := range h.subs {
			s.close()
		}
		h.subs = map[*Subscriber]struct{}{}
	}
	h.mu.Unlock()
	return err
}

// ServeStream writes a multipart/x-mixed-replace MJPEG stream until the
// client goes away. maxFPS > 0 thins the stream for this viewer only, which
// is handy for thumbnails in dashboards.
func (h *Hub) ServeStream(w http.ResponseWriter, r *http.Request, maxFPS int) {
	sub := h.Subscribe()
	defer h.Unsubscribe(sub)

	mw := multipart.NewWriter(w)
	header := w.Header()
	header.Set("Content-Type", "multipart/x-mixed-replace; boundary="+mw.Boundary())
	header.Set("Cache-Control", "no-store")
	// Tell nginx-style proxies not to buffer an endless response.
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	var minGap time.Duration
	if maxFPS > 0 {
		minGap = time.Second / time.Duration(maxFPS)
	}
	var lastSent time.Time

	send := func(frame []byte) error {
		part, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type":   {"image/jpeg"},
			"Content-Length": {strconv.Itoa(len(frame))},
		})
		if err != nil {
			return err
		}
		if _, err := part.Write(frame); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		lastSent = time.Now()
		return nil
	}

	// Show something straight away instead of waiting for the next frame,
	// which matters while the capture is paused for a resolution change.
	if frame := h.Latest(); frame != nil {
		if send(frame) != nil {
			return
		}
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.Done():
			return
		case frame := <-sub.Frames():
			if minGap > 0 && time.Since(lastSent) < minGap {
				continue
			}
			if send(frame) != nil {
				// Broken pipe: the browser went away
				return
			}
		}
	}
}

// IsJPEG does a cheap SOI/EOI sanity check on a frame.
func IsJPEG(frame []byte) bool {
	if len(frame) < 4 {
		return false
	}
	if bytes.HasPrefix(frame, []byte{0xFF, 0xD8}) && bytes.HasSuffix(frame, []byte{0xFF, 0xD9}) {
		return true
	}
	start := bytes.Index(frame, []byte{0xFF, 0xD8})
	end := bytes.LastIndex(frame, []byte{0xFF, 0xD9})
	return start >= 0 && end > start
}

// reencode trades CPU on the server for bandwidth on the wire. Measured on a
// 1080p25 stream: untouched ~56Mbps, quality 75 ~30Mbps, 50 ~24Mbps,
// 30 ~20Mbps, 10 ~12Mbps.
func reencode(frame []byte, quality int) ([]byte, error) {
	img, err := jpeg.Decode(bytes.NewReader(frame))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
