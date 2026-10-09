//go:build !linux

package capture

import "log"

// V4L2Source is unavailable outside Linux; Open always fails with
// ErrUnsupportedPlatform so the rest of the program builds and demo mode
// can be used for development on any desktop OS.
type V4L2Source struct {
	node string
}

// NewV4L2Source returns a source that cannot be opened on this platform.
func NewV4L2Source(node string, _ *log.Logger) *V4L2Source {
	return &V4L2Source{node: node}
}

// Modes always fails on this platform.
func (s *V4L2Source) Modes() ([]SizeInfo, error) { return nil, ErrUnsupportedPlatform }

// Open always fails on this platform.
func (s *V4L2Source) Open(Resolution) (<-chan []byte, StreamInfo, error) {
	return nil, StreamInfo{}, ErrUnsupportedPlatform
}

// Close is a no-op.
func (s *V4L2Source) Close() error { return nil }
