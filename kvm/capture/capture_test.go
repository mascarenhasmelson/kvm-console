package capture

import (
	"reflect"
	"testing"
	"time"
)

const sampleV4L2 = `ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'MJPG' (Motion-JPEG, compressed)
		Size: Discrete 1920x1080
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.050s (20.000 fps)
		Size: Discrete 1280x720
			Interval: Discrete 0.017s (60.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 720x480
			Interval: Discrete 0.033s (30.000 fps)
	[1]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 1920x1080
			Interval: Discrete 0.200s (5.000 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.033s (30.000 fps)
`

func TestParseV4L2Formats(t *testing.T) {
	formats, err := ParseV4L2Formats(sampleV4L2)
	if err != nil {
		t.Fatal(err)
	}
	want := []FormatInfo{
		{Format: "MJPG", Sizes: []SizeInfo{
			{1920, 1080, []int{30, 20}},
			{1280, 720, []int{60, 30}},
			{720, 480, []int{30}},
		}},
		{Format: "YUYV", Sizes: []SizeInfo{
			{1920, 1080, []int{5}},
			{640, 480, []int{30}},
		}},
	}
	if !reflect.DeepEqual(formats, want) {
		t.Fatalf("got %+v\nwant %+v", formats, want)
	}

	sizes := MJPEGSizesFrom(formats)
	if len(sizes) != 3 || sizes[0].Width != 1920 || sizes[1].FPS[0] != 60 {
		t.Fatalf("unexpected MJPEG sizes %+v", sizes)
	}
	if !SupportsResolution(sizes, Resolution{1280, 720, 30}) || SupportsResolution(sizes, Resolution{1280, 720, 25}) {
		t.Fatal("SupportsResolution gave the wrong answer")
	}
}

func TestHubSlowSubscriberDoesNotBlock(t *testing.T) {
	h := NewHub(nil, 0, nil)
	defer h.Close()

	slow := h.Subscribe() // never reads
	fast := h.Subscribe()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			h.Publish([]byte{byte(i)})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a subscriber that is not reading")
	}

	// The slow subscriber's mailbox holds only the newest frame
	select {
	case f := <-slow.Frames():
		if f[0] != 99 {
			t.Fatalf("slow subscriber got frame %d, want the latest (99)", f[0])
		}
	default:
		t.Fatal("slow subscriber has no frame at all")
	}
	if f := <-fast.Frames(); f[0] != 99 {
		t.Fatalf("fast subscriber got %d", f[0])
	}
	if got := h.Latest(); got[0] != 99 {
		t.Fatalf("latest = %d", got[0])
	}
	if h.Status().Viewers != 2 {
		t.Fatalf("viewers = %d", h.Status().Viewers)
	}
	h.Unsubscribe(slow)
	if h.Status().Viewers != 1 {
		t.Fatal("unsubscribe did not remove the viewer")
	}
}

func TestIsJPEG(t *testing.T) {
	if !IsJPEG([]byte{0xFF, 0xD8, 0x00, 0xFF, 0xD9}) {
		t.Fatal("valid frame rejected")
	}
	if IsJPEG([]byte{0x00, 0x01, 0x02, 0x03}) {
		t.Fatal("garbage accepted")
	}
}
