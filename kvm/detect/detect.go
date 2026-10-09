// Package detect finds the device nodes of the KVM hardware.
//
// The kernel hands out /dev/videoN, /dev/snd/pcmCxDyc and /dev/ttyUSBn in
// probe order, so the numbers shift whenever the machine boots with a
// different set of USB devices attached. Rather than hard coding them this
// walks sysfs and matches on the USB vendor/product IDs of the two chips a
// KVM board carries:
//
//   - MacroSilicon MS2109 / MS2109S / MS2130 HDMI capture card
//     (video capture + USB audio, exposed as one USB device)
//   - WCH CH340 / CH341 USB-serial bridge that fronts the CH9329 HID chip
//
// The capture card exposes both a video and an audio interface on the same
// USB device, so once the video node is found the matching PCM capture node
// is simply the sound card hanging off the same USB device directory. The
// serial bridge is a separate USB device, but on a KVM board it sits on the
// same internal hub as the capture card, which breaks ties when more than one
// bridge is plugged in.
//
// On systems without sysfs (Windows, macOS) nothing is found.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package detect

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"kvmconsole/kvm/capture"
)

const (
	sysClassVideo = "/sys/class/video4linux"
	sysClassSound = "/sys/class/sound"
	sysClassTTY   = "/sys/class/tty"
)

// USBID is a USB vendor/product pair, lowercase hex without the 0x prefix.
type USBID struct {
	VID string
	PID string
}

// KnownCaptureCards are the HDMI capture chips found on KVM boards. 345f is
// the VID MacroSilicon uses on newer (MS2109S / MS2130) silicon, 534d the
// one used by the original MS2109 batches.
var KnownCaptureCards = []USBID{
	{"345f", "2109"}, // MS2109S
	{"345f", "2130"}, // MS2130
	{"534d", "2109"}, // MS2109
	{"534d", "2130"}, // MS2130
}

// KnownSerialBridges are the WCH USB-serial chips that front the CH9329.
var KnownSerialBridges = []USBID{
	{"1a86", "7523"}, // CH340
	{"1a86", "5523"}, // CH341
	{"1a86", "7522"}, // CH340K
	{"1a86", "55d4"}, // CH9102
}

// Devices is the outcome of a detection pass. Each node either came from
// an explicit override or was discovered by walking sysfs; the *Source
// fields say which, for the logs and the settings panel.
type Devices struct {
	VideoNode  string
	AudioNode  string
	SerialNode string

	VideoSource  string
	AudioSource  string
	SerialSource string
}

func readSysAttr(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// usbDeviceOf walks up from a sysfs path (usually a USB interface directory
// such as .../1-1.3.2:1.0) until it reaches the USB device directory that
// carries idVendor / idProduct.
func usbDeviceOf(sysPath string) string {
	current, err := filepath.EvalSymlinks(sysPath)
	if err != nil {
		return ""
	}
	for current != "/" && current != "." && current != "" {
		if readSysAttr(filepath.Join(current, "idVendor")) != "" &&
			readSysAttr(filepath.Join(current, "idProduct")) != "" {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return ""
}

func usbIDOf(usbDevPath string) USBID {
	return USBID{
		VID: strings.ToLower(readSysAttr(filepath.Join(usbDevPath, "idVendor"))),
		PID: strings.ToLower(readSysAttr(filepath.Join(usbDevPath, "idProduct"))),
	}
}

func (id USBID) matches(list []USBID) bool {
	for _, known := range list {
		if id == known {
			return true
		}
	}
	return false
}

func (id USBID) String() string {
	if id.VID == "" {
		return "unknown"
	}
	return id.VID + ":" + id.PID
}

// usbParentHub returns the hub a device is plugged into, "1-1.3.2" ->
// "1-1.3", or "" for a root port.
func usbParentHub(busPath string) string {
	idx := strings.LastIndex(busPath, ".")
	if idx < 0 {
		return ""
	}
	return busPath[:idx]
}

var (
	videoNodeRegex  = regexp.MustCompile(`^video(\d+)$`)
	soundCardRegex  = regexp.MustCompile(`^card(\d+)$`)
	pcmCaptureRegex = regexp.MustCompile(`^pcmC(\d+)D(\d+)c$`)
	ttyUSBRegex     = regexp.MustCompile(`^tty(USB|ACM)\d+$`)
)

type videoCandidate struct {
	Node    string
	Name    string
	USBPath string
	USBID   USBID
	IsKnown bool
}

// listVideoCandidates enumerates every /dev/videoN node that can deliver
// MJPEG frames. A UVC card exposes a streaming node and a metadata node;
// only the streaming one lists MJPEG, so this doubles as the filter.
func listVideoCandidates() []videoCandidate {
	entries, err := os.ReadDir(sysClassVideo)
	if err != nil {
		return nil
	}
	var candidates []videoCandidate
	for _, entry := range entries {
		if !videoNodeRegex.MatchString(entry.Name()) {
			continue
		}
		classPath := filepath.Join(sysClassVideo, entry.Name())
		node := "/dev/" + entry.Name()
		if _, err := os.Stat(node); err != nil {
			continue
		}
		c := videoCandidate{Node: node, Name: readSysAttr(filepath.Join(classPath, "name"))}
		if usbDev := usbDeviceOf(filepath.Join(classPath, "device")); usbDev != "" {
			c.USBPath = usbDev
			c.USBID = usbIDOf(usbDev)
			c.IsKnown = c.USBID.matches(KnownCaptureCards)
		}
		if !capture.NodeSupportsMJPEG(node) {
			continue
		}
		candidates = append(candidates, c)
	}
	sort.SliceStable(candidates, func(a, b int) bool {
		if candidates[a].IsKnown != candidates[b].IsKnown {
			return candidates[a].IsKnown
		}
		return candidates[a].Node < candidates[b].Node
	})
	return candidates
}

type audioCandidate struct {
	Node    string
	CardID  string
	USBPath string
	USBID   USBID
	IsKnown bool
}

func listAudioCandidates() []audioCandidate {
	entries, err := os.ReadDir(sysClassSound)
	if err != nil {
		return nil
	}
	var candidates []audioCandidate
	for _, entry := range entries {
		if !soundCardRegex.MatchString(entry.Name()) {
			continue
		}
		cardPath := filepath.Join(sysClassSound, entry.Name())
		pcms, err := os.ReadDir(cardPath)
		if err != nil {
			continue
		}
		for _, pcm := range pcms {
			if !pcmCaptureRegex.MatchString(pcm.Name()) {
				continue
			}
			node := "/dev/snd/" + pcm.Name()
			if _, err := os.Stat(node); err != nil {
				continue
			}
			c := audioCandidate{Node: node, CardID: readSysAttr(filepath.Join(cardPath, "id"))}
			if usbDev := usbDeviceOf(filepath.Join(cardPath, "device")); usbDev != "" {
				c.USBPath = usbDev
				c.USBID = usbIDOf(usbDev)
				c.IsKnown = c.USBID.matches(KnownCaptureCards)
			}
			candidates = append(candidates, c)
		}
	}
	sort.SliceStable(candidates, func(a, b int) bool {
		if candidates[a].IsKnown != candidates[b].IsKnown {
			return candidates[a].IsKnown
		}
		return candidates[a].Node < candidates[b].Node
	})
	return candidates
}

type serialCandidate struct {
	Node    string
	USBPath string
	USBID   USBID
	IsKnown bool
}

func listSerialCandidates() []serialCandidate {
	entries, err := os.ReadDir(sysClassTTY)
	if err != nil {
		return nil
	}
	var candidates []serialCandidate
	for _, entry := range entries {
		if !ttyUSBRegex.MatchString(entry.Name()) {
			continue
		}
		node := "/dev/" + entry.Name()
		if _, err := os.Stat(node); err != nil {
			continue
		}
		c := serialCandidate{Node: node}
		if usbDev := usbDeviceOf(filepath.Join(sysClassTTY, entry.Name(), "device")); usbDev != "" {
			c.USBPath = usbDev
			c.USBID = usbIDOf(usbDev)
			c.IsKnown = c.USBID.matches(KnownSerialBridges)
		}
		candidates = append(candidates, c)
	}
	sort.SliceStable(candidates, func(a, b int) bool {
		if candidates[a].IsKnown != candidates[b].IsKnown {
			return candidates[a].IsKnown
		}
		return candidates[a].Node < candidates[b].Node
	})
	return candidates
}

// Detect resolves the three device nodes. Non-empty overrides are taken
// as-is (they must exist); the rest are detected. Only the video node is
// mandatory.
func Detect(videoOverride, audioOverride, serialOverride string) (*Devices, error) {
	result := &Devices{}

	/* Video */
	var captureUSBPath string
	if videoOverride != "" {
		if _, err := os.Stat(videoOverride); err != nil {
			return nil, fmt.Errorf("video device %s not found: %w", videoOverride, err)
		}
		result.VideoNode = videoOverride
		result.VideoSource = "flag"
		// Still resolve the USB device so audio detection can be anchored to it
		if name := filepath.Base(videoOverride); videoNodeRegex.MatchString(name) {
			captureUSBPath = usbDeviceOf(filepath.Join(sysClassVideo, name, "device"))
		}
	} else {
		candidates := listVideoCandidates()
		if len(candidates) == 0 {
			return nil, fmt.Errorf("no MJPEG capable video capture device found; pass -video to select one manually, or run with -demo to try the UI without hardware")
		}
		picked := candidates[0]
		result.VideoNode = picked.Node
		captureUSBPath = picked.USBPath
		if picked.IsKnown {
			result.VideoSource = fmt.Sprintf("auto (capture card %s, %s)", picked.USBID, picked.Name)
		} else {
			result.VideoSource = fmt.Sprintf("auto (first MJPEG device %s, %s)", picked.USBID, picked.Name)
		}
	}

	/* Audio - prefer the sound card on the same USB device as the video node */
	if audioOverride != "" {
		if _, err := os.Stat(audioOverride); err != nil {
			return nil, fmt.Errorf("audio device %s not found: %w", audioOverride, err)
		}
		result.AudioNode = audioOverride
		result.AudioSource = "flag"
	} else {
		candidates := listAudioCandidates()
		for _, c := range candidates {
			if captureUSBPath != "" && c.USBPath == captureUSBPath {
				result.AudioNode = c.Node
				result.AudioSource = fmt.Sprintf("auto (same USB device as video, card %s)", c.CardID)
				break
			}
		}
		if result.AudioNode == "" && len(candidates) > 0 {
			picked := candidates[0]
			result.AudioNode = picked.Node
			if picked.IsKnown {
				result.AudioSource = fmt.Sprintf("auto (capture card %s, card %s)", picked.USBID, picked.CardID)
			} else {
				result.AudioSource = fmt.Sprintf("auto (first ALSA capture device, card %s)", picked.CardID)
			}
		}
		if result.AudioNode == "" {
			result.AudioSource = "not found"
		}
	}

	/* Serial - prefer a bridge on the same internal hub as the capture card */
	if serialOverride != "" {
		if _, err := os.Stat(serialOverride); err != nil {
			return nil, fmt.Errorf("serial device %s not found: %w", serialOverride, err)
		}
		result.SerialNode = serialOverride
		result.SerialSource = "flag"
	} else {
		candidates := listSerialCandidates()
		captureHub := ""
		if captureUSBPath != "" {
			captureHub = usbParentHub(filepath.Base(captureUSBPath))
		}
		for _, c := range candidates {
			if !c.IsKnown || captureHub == "" || c.USBPath == "" {
				continue
			}
			if usbParentHub(filepath.Base(c.USBPath)) == captureHub {
				result.SerialNode = c.Node
				result.SerialSource = fmt.Sprintf("auto (%s on the same hub as the capture card)", c.USBID)
				break
			}
		}
		if result.SerialNode == "" && len(candidates) > 0 {
			picked := candidates[0]
			result.SerialNode = picked.Node
			if picked.IsKnown {
				result.SerialSource = fmt.Sprintf("auto (USB-serial bridge %s)", picked.USBID)
			} else {
				result.SerialSource = fmt.Sprintf("auto (first USB serial port %s)", picked.USBID)
			}
		}
		if result.SerialNode == "" {
			result.SerialSource = "not found"
		}
	}
	return result, nil
}

// PrintReport writes every candidate node found on the system. Handy when
// the automatic pick is wrong and the user needs to know what to pass to
// -video / -audio / -tty.
func PrintReport(w io.Writer) {
	marker := func(known bool) string {
		if known {
			return "*"
		}
		return " "
	}
	fmt.Fprintln(w, "Video capture devices (MJPEG capable):")
	videos := listVideoCandidates()
	if len(videos) == 0 {
		fmt.Fprintln(w, "  (none)")
	}
	for _, c := range videos {
		fmt.Fprintf(w, "  %s %-14s %-12s %s\n", marker(c.IsKnown), c.Node, c.USBID, c.Name)
	}

	fmt.Fprintln(w, "\nAudio capture devices:")
	audios := listAudioCandidates()
	if len(audios) == 0 {
		fmt.Fprintln(w, "  (none)")
	}
	for _, c := range audios {
		fmt.Fprintf(w, "  %s %-22s %-12s %s\n", marker(c.IsKnown), c.Node, c.USBID, c.CardID)
	}

	fmt.Fprintln(w, "\nSerial ports:")
	serials := listSerialCandidates()
	if len(serials) == 0 {
		fmt.Fprintln(w, "  (none)")
	}
	for _, c := range serials {
		fmt.Fprintf(w, "  %s %-14s %s\n", marker(c.IsKnown), c.Node, c.USBID)
	}
	fmt.Fprintln(w, "\n  (* = recognised KVM hardware)")
}
