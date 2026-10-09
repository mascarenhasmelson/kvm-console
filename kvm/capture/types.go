// Package capture owns the video side of the KVM: talking to the V4L2 capture
// card (Linux only), probing its formats through v4l2-ctl, and fanning the
// MJPEG frames out to every connected viewer through a Hub.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package capture

import "errors"

/*
	Bandwidth estimation for the MJPEG stream of an MS2109 class card

	1920 x 1080 30fps = 50Mbps
	1920 x 1080 25fps = 40Mbps
	1920 x 1080 20fps = 30Mbps
	1920 x 1080 10fps = 15Mbps

	1360 x 768 30fps = 25Mbps
	1360 x 768 25fps = 20Mbps
	1360 x 768 20fps = 18Mbps
	1360 x 768 10fps = 10Mbps

	60fps modes exist on the card but no browser MJPEG decoder keeps up with
	them, which is why the UI never offers anything above 30fps.
*/

// Resolution is a capture mode to open the device with.
type Resolution struct {
	Width  int
	Height int
	FPS    int
}

// FormatInfo is one pixel format block of `v4l2-ctl --list-formats-ext`.
type FormatInfo struct {
	Format string
	Sizes  []SizeInfo
}

// SizeInfo is one discrete frame size with every frame rate it supports.
type SizeInfo struct {
	Width  int
	Height int
	FPS    []int
}

// StreamInfo describes what a source actually opened, which can differ from
// what was asked for (drivers are allowed to round).
type StreamInfo struct {
	Description string
	Width       int
	Height      int
	FPS         int
}

// Source is anything that can produce a stream of JPEG frames: the real V4L2
// capture card, or the synthetic desktop used by demo mode.
type Source interface {
	// Modes lists the MJPEG sizes the source supports, largest first.
	Modes() ([]SizeInfo, error)
	// Open starts capturing. Frames arrive on the returned channel until
	// Close is called; the channel may or may not be closed at that point.
	Open(res Resolution) (<-chan []byte, StreamInfo, error)
	// Close stops capturing and releases the device.
	Close() error
}

// ErrUnsupportedPlatform is returned by the real capture source on systems
// without V4L2.
var ErrUnsupportedPlatform = errors.New("real video capture requires Linux (V4L2); run with -demo to try the UI without hardware")
