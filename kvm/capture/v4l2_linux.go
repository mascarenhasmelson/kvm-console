//go:build linux

package capture

/*
	v4l2_linux.go

	The real capture card, opened through go4vl. MS2109 / MS2109S / MS2130
	cards only offer MJPEG at useful sizes, so that is the only format used.
*/

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/vladimirvivien/go4vl/device"
	"github.com/vladimirvivien/go4vl/v4l2"
)

// V4L2Source captures MJPEG frames from a /dev/videoN node.
type V4L2Source struct {
	node   string
	logger *log.Logger

	mu     sync.Mutex
	camera *device.Device
	cancel context.CancelFunc
}

// NewV4L2Source prepares (but does not open) a capture node.
func NewV4L2Source(node string, logger *log.Logger) *V4L2Source {
	if logger == nil {
		logger = log.Default()
	}
	return &V4L2Source{node: node, logger: logger}
}

// Modes lists the node's MJPEG sizes.
func (s *V4L2Source) Modes() ([]SizeInfo, error) {
	return MJPEGSizes(s.node)
}

// Open starts streaming at res.
func (s *V4L2Source) Open(res Resolution) (<-chan []byte, StreamInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.camera != nil {
		return nil, StreamInfo{}, fmt.Errorf("video capture already started")
	}
	if res.FPS == 0 {
		res.FPS = 25
	}

	isCapture, err := CheckVideoCaptureDevice(s.node)
	if err != nil {
		return nil, StreamInfo{}, fmt.Errorf("failed to check video device: %w", err)
	}
	if !isCapture {
		return nil, StreamInfo{}, fmt.Errorf("device %s is not a video capture device", s.node)
	}
	modes, err := s.Modes()
	if err != nil {
		return nil, StreamInfo{}, err
	}
	if !SupportsResolution(modes, res) {
		return nil, StreamInfo{}, fmt.Errorf("device %s does not support %dx%d @ %d fps", s.node, res.Width, res.Height, res.FPS)
	}

	// A device that was just closed (resolution change, quick restart) can
	// report EBUSY for a moment, so retry with an increasing delay.
	var camera *device.Device
	const maxRetries = 5
	for attempt := 0; attempt < maxRetries; attempt++ {
		camera, err = device.Open(s.node,
			device.WithIOType(v4l2.IOTypeMMAP),
			device.WithPixFormat(v4l2.PixFormat{
				PixelFormat: v4l2.PixelFmtMJPEG,
				Width:       uint32(res.Width),
				Height:      uint32(res.Height),
				Field:       v4l2.FieldAny,
			}),
			device.WithFPS(uint32(res.FPS)),
			device.WithBufferSize(2),
		)
		if err == nil {
			break
		}
		if strings.Contains(err.Error(), "device or resource busy") && attempt < maxRetries-1 {
			s.logger.Printf("capture: %s busy, retrying in %ds (attempt %d/%d)", s.node, attempt+1, attempt+1, maxRetries)
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}
		return nil, StreamInfo{}, fmt.Errorf("failed to open video device: %w", err)
	}

	caps := camera.Capability()
	format, err := camera.GetPixFormat()
	if err != nil {
		camera.Close()
		return nil, StreamInfo{}, fmt.Errorf("failed to read the pixel format: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	if err := camera.Start(ctx); err != nil {
		cancel()
		camera.Close()
		// This used to log.Fatalf, taking the whole server down on a bad
		// resolution change. Returning lets the hub restore the old mode.
		return nil, StreamInfo{}, fmt.Errorf("failed to start streaming: %w", err)
	}

	s.camera = camera
	s.cancel = cancel

	info := StreamInfo{
		Description: fmt.Sprintf("%s - %s [%dx%d] %d fps", caps.Card, v4l2.PixelFormats[format.PixelFormat], format.Width, format.Height, res.FPS),
		Width:       int(format.Width),
		Height:      int(format.Height),
		FPS:         res.FPS,
	}
	s.logger.Printf("capture: %s opened, %s", s.node, info.Description)
	return camera.GetOutput(), info, nil
}

// Close stops streaming and releases the node. Leaving it open makes the
// next start fail with EBUSY.
func (s *V4L2Source) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.camera == nil {
		return nil
	}
	s.cancel()
	err := s.camera.Close()
	s.camera = nil
	s.cancel = nil
	time.Sleep(300 * time.Millisecond)
	return err
}
