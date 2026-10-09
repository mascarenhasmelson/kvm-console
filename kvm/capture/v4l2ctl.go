package capture

/*
	v4l2ctl.go

	Format probing through the v4l2-ctl tool. Shelling out keeps this part
	free of cgo, so it compiles (and simply finds nothing) on every platform.
*/

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	formatRegex   = regexp.MustCompile(`\[(\d+)\]: '(\S+)'`)
	sizeRegex     = regexp.MustCompile(`Size: Discrete (\d+)x(\d+)`)
	intervalRegex = regexp.MustCompile(`Interval: Discrete (\d+\.\d+)s \((\d+\.\d+) fps\)`)
)

// GetV4L2FormatInfo runs `v4l2-ctl --list-formats-ext` against a device node
// and parses its output.
func GetV4L2FormatInfo(devicePath string) ([]FormatInfo, error) {
	cmd := exec.Command("v4l2-ctl", "--list-formats-ext", "-d", devicePath)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("v4l2-ctl on %s: %w", devicePath, err)
	}
	return ParseV4L2Formats(out.String())
}

// ParseV4L2Formats parses the text printed by `v4l2-ctl --list-formats-ext`.
//
// Single pass over the output. An earlier version consumed the frame
// interval lines in a nested loop, which swallowed the line that ended that
// loop: every second "Size:" line and every "[n]: 'FMT'" header was lost, so
// alternating resolutions disappeared and the sizes of the next format were
// appended to the previous one. Tracking the current size alongside the
// current format keeps every line visible to every rule.
func ParseV4L2Formats(output string) ([]FormatInfo, error) {
	var formats []FormatInfo
	var currentFormat *FormatInfo
	var currentSize *SizeInfo

	flushSize := func() {
		if currentFormat != nil && currentSize != nil {
			currentFormat.Sizes = append(currentFormat.Sizes, *currentSize)
		}
		currentSize = nil
	}
	flushFormat := func() {
		flushSize()
		if currentFormat != nil {
			formats = append(formats, *currentFormat)
		}
		currentFormat = nil
	}

	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()

		if m := formatRegex.FindStringSubmatch(line); m != nil {
			flushFormat()
			currentFormat = &FormatInfo{Format: m[2]}
			continue
		}
		if m := sizeRegex.FindStringSubmatch(line); m != nil {
			flushSize()
			width, _ := strconv.Atoi(m[1])
			height, _ := strconv.Atoi(m[2])
			currentSize = &SizeInfo{Width: width, Height: height}
			continue
		}
		if m := intervalRegex.FindStringSubmatch(line); m != nil && currentSize != nil {
			fps, _ := strconv.ParseFloat(m[2], 64)
			// 29.970 fps style rates round to the nearest integer rate
			currentSize.FPS = append(currentSize.FPS, int(fps+0.5))
		}
	}
	flushFormat()
	return formats, scanner.Err()
}

// CheckVideoCaptureDevice reports whether a node advertises the Video
// Capture capability.
func CheckVideoCaptureDevice(device string) (bool, error) {
	output, err := exec.Command("v4l2-ctl", "--device", device, "--all").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("failed to execute v4l2-ctl: %w", err)
	}
	return strings.Contains(string(output), "Video Capture"), nil
}

// IsMJPEGFormat matches the fourcc names v4l2-ctl prints for motion JPEG.
// The card reports 'MJPG', which is why comparing against "mjpeg" (as the
// old screenshot path did) never matched anything.
func IsMJPEGFormat(name string) bool {
	switch strings.ToUpper(name) {
	case "MJPG", "MJPEG", "JPEG":
		return true
	}
	return false
}

// NodeSupportsMJPEG reports whether a /dev/videoN node advertises at least
// one discrete MJPEG size. UVC cards expose a second, metadata-only node
// alongside the streaming one; only the streaming node lists MJPEG, so this
// is what separates the two.
func NodeSupportsMJPEG(node string) bool {
	formats, err := GetV4L2FormatInfo(node)
	if err != nil {
		return false
	}
	return len(MJPEGSizesFrom(formats)) > 0
}

// MJPEGSizesFrom extracts every MJPEG size, largest area first, with the
// frame rates sorted descending.
func MJPEGSizesFrom(formats []FormatInfo) []SizeInfo {
	var sizes []SizeInfo
	for _, format := range formats {
		if !IsMJPEGFormat(format.Format) {
			continue
		}
		for _, size := range format.Sizes {
			rates := append([]int(nil), size.FPS...)
			sort.Sort(sort.Reverse(sort.IntSlice(rates)))
			sizes = append(sizes, SizeInfo{Width: size.Width, Height: size.Height, FPS: rates})
		}
	}
	sort.SliceStable(sizes, func(a, b int) bool {
		return sizes[a].Width*sizes[a].Height > sizes[b].Width*sizes[b].Height
	})
	return sizes
}

// MJPEGSizes probes a node and returns its MJPEG sizes.
func MJPEGSizes(node string) ([]SizeInfo, error) {
	formats, err := GetV4L2FormatInfo(node)
	if err != nil {
		return nil, err
	}
	sizes := MJPEGSizesFrom(formats)
	if len(sizes) == 0 {
		return nil, fmt.Errorf("device %s does not expose any MJPEG format", node)
	}
	return sizes, nil
}

// SupportsResolution reports whether a mode list contains the exact
// width/height/fps combination.
func SupportsResolution(modes []SizeInfo, res Resolution) bool {
	for _, size := range modes {
		if size.Width != res.Width || size.Height != res.Height {
			continue
		}
		for _, fps := range size.FPS {
			if fps == res.FPS {
				return true
			}
		}
	}
	return false
}
