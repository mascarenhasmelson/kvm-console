// Package demo is a hardware-free stand-in for the capture card and the HID
// chip. The "remote machine" is a synthetic desktop rendered on the server:
// the pointer, the typed text and the held keys it shows all come from the
// HID events the browser sends, so the whole input path can be tested (and
// integrations developed) on any laptop.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package demo

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"kvmconsole/kvm/capture"
	"kvmconsole/kvm/hid"
)

// Modes are the resolutions the demo card pretends to support.
var Modes = []capture.SizeInfo{
	{Width: 1920, Height: 1080, FPS: []int{30, 25, 20, 10}},
	{Width: 1280, Height: 720, FPS: []int{30, 20, 10}},
	{Width: 800, Height: 600, FPS: []int{30}},
}

// State is the virtual remote machine shared by Source and Reporter.
type State struct {
	mu        sync.Mutex
	width     int
	height    int
	x, y      float64 // pointer position, 0-1
	buttons   uint8
	modifiers uint8
	keys      [6]uint8
	line      []rune // text being typed
	prevLine  string // last line finished with Enter
	lastEvent string
	events    int
	resets    int
	scroll    int
	started   time.Time
}

// NewState creates a desktop with the pointer in the middle.
func NewState() *State {
	return &State{width: 1280, height: 720, x: 0.5, y: 0.5, started: time.Now(), lastEvent: "waiting for input"}
}

func (s *State) setSize(w, h int) {
	s.mu.Lock()
	s.width, s.height = w, h
	s.mu.Unlock()
}

// snapshot is a copy of the state for the renderer.
type snapshot struct {
	x, y      float64
	buttons   uint8
	modifiers uint8
	keys      [6]uint8
	line      string
	prevLine  string
	lastEvent string
	events    int
	resets    int
	scroll    int
	uptime    time.Duration
}

func (s *State) snapshot() snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return snapshot{
		x: s.x, y: s.y, buttons: s.buttons, modifiers: s.modifiers, keys: s.keys,
		line: string(s.line), prevLine: s.prevLine, lastEvent: s.lastEvent,
		events: s.events, resets: s.resets, scroll: s.scroll, uptime: time.Since(s.started),
	}
}

/* --- Reporter ---------------------------------------------------------- */

// Reporter is a virtual HID chip that updates the demo desktop.
type Reporter struct {
	st *State
}

// NewReporter returns a hid.Reporter driving st.
func NewReporter(st *State) *Reporter { return &Reporter{st: st} }

var _ hid.Reporter = (*Reporter)(nil)

// Keyboard implements hid.Reporter. Newly pressed keys are turned back into
// characters so the desktop can show what was typed.
func (r *Reporter) Keyboard(modifiers uint8, keys [6]uint8) error {
	s := r.st
	s.mu.Lock()
	defer s.mu.Unlock()
	shift := modifiers&(hid.ModLeftShift|hid.ModRightShift) != 0
	for _, k := range keys {
		if k == 0 || containsKey(s.keys, k) {
			continue
		}
		switch {
		case k == 0x28 || k == 0x58: // Enter / numpad Enter
			s.prevLine = string(s.line)
			s.line = s.line[:0]
		case k == 0x2A: // Backspace
			if len(s.line) > 0 {
				s.line = s.line[:len(s.line)-1]
			}
		default:
			// Ctrl/Alt/GUI combinations are shortcuts, not text
			if modifiers&^(hid.ModLeftShift|hid.ModRightShift) == 0 {
				if c, ok := usageToChar(k, shift); ok {
					s.line = append(s.line, c)
					if len(s.line) > 60 {
						s.line = s.line[len(s.line)-60:]
					}
				}
			}
		}
		s.lastEvent = "key " + describeCombo(modifiers, k)
	}
	if modifiers != s.modifiers && keys == ([6]uint8{}) {
		s.lastEvent = "modifiers " + describeModifiers(modifiers)
	}
	s.modifiers = modifiers
	s.keys = keys
	s.events++
	return nil
}

// MouseAbsolute implements hid.Reporter.
func (r *Reporter) MouseAbsolute(buttons uint8, x, y uint16, wheel int8) error {
	s := r.st
	s.mu.Lock()
	defer s.mu.Unlock()
	s.x = float64(x) / 4095
	s.y = float64(y) / 4095
	r.updateButtons(buttons)
	s.scroll += int(wheel)
	s.events++
	return nil
}

// MouseRelative implements hid.Reporter.
func (r *Reporter) MouseRelative(buttons uint8, dx, dy, wheel int8) error {
	s := r.st
	s.mu.Lock()
	defer s.mu.Unlock()
	s.x = clamp01(s.x + float64(dx)/float64(s.width))
	s.y = clamp01(s.y + float64(dy)/float64(s.height))
	r.updateButtons(buttons)
	if wheel != 0 {
		s.scroll += int(wheel)
		if wheel > 0 {
			s.lastEvent = "scroll up"
		} else {
			s.lastEvent = "scroll down"
		}
	} else if dx != 0 || dy != 0 {
		s.lastEvent = fmt.Sprintf("relative move %+d,%+d", dx, dy)
	}
	s.events++
	return nil
}

func (r *Reporter) updateButtons(buttons uint8) {
	s := r.st
	if buttons != s.buttons {
		if pressed := buttons &^ s.buttons; pressed != 0 {
			s.lastEvent = describeButtons(pressed) + " button down"
		} else {
			s.lastEvent = describeButtons(s.buttons&^buttons) + " button up"
		}
	}
	s.buttons = buttons
}

// SoftReset implements hid.Reporter.
func (r *Reporter) SoftReset() error {
	s := r.st
	s.mu.Lock()
	s.resets++
	s.lastEvent = "HID chip reset"
	s.mu.Unlock()
	return nil
}

// Close implements hid.Reporter.
func (r *Reporter) Close() error { return nil }

func containsKey(keys [6]uint8, k uint8) bool {
	for _, held := range keys {
		if held == k {
			return true
		}
	}
	return false
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

const (
	usPlain   = "1234567890"
	usShifted = "!@#$%^&*()"
)

// usageToChar maps a HID usage to the character it types on a US layout.
func usageToChar(k uint8, shift bool) (rune, bool) {
	switch {
	case k >= 0x04 && k <= 0x1D:
		c := rune('a' + (k - 0x04))
		if shift {
			c -= 'a' - 'A'
		}
		return c, true
	case k >= 0x1E && k <= 0x27:
		if shift {
			return rune(usShifted[k-0x1E]), true
		}
		return rune(usPlain[k-0x1E]), true
	}
	symbols := map[uint8][2]rune{
		0x2C: {' ', ' '}, 0x2D: {'-', '_'}, 0x2E: {'=', '+'}, 0x2F: {'[', '{'},
		0x30: {']', '}'}, 0x31: {'\\', '|'}, 0x33: {';', ':'}, 0x34: {'\'', '"'},
		0x35: {'`', '~'}, 0x36: {',', '<'}, 0x37: {'.', '>'}, 0x38: {'/', '?'},
		0x2B: {' ', ' '},
	}
	if pair, ok := symbols[k]; ok {
		if shift {
			return pair[1], true
		}
		return pair[0], true
	}
	return 0, false
}

func describeModifiers(m uint8) string {
	var parts []string
	names := []struct {
		bit  uint8
		name string
	}{
		{hid.ModLeftCtrl, "Ctrl"}, {hid.ModLeftShift, "Shift"}, {hid.ModLeftAlt, "Alt"}, {hid.ModLeftGUI, "Win"},
		{hid.ModRightCtrl, "RCtrl"}, {hid.ModRightShift, "RShift"}, {hid.ModRightAlt, "RAlt"}, {hid.ModRightGUI, "RWin"},
	}
	for _, n := range names {
		if m&n.bit != 0 {
			parts = append(parts, n.name)
		}
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, "+")
}

func describeCombo(m uint8, k uint8) string {
	name := keyName(k)
	if m == 0 {
		return name
	}
	return describeModifiers(m) + "+" + name
}

func keyName(k uint8) string {
	named := map[uint8]string{
		0x28: "Enter", 0x29: "Esc", 0x2A: "Backspace", 0x2B: "Tab", 0x2C: "Space",
		0x39: "CapsLock", 0x46: "PrintScreen", 0x48: "Pause", 0x49: "Insert",
		0x4A: "Home", 0x4B: "PageUp", 0x4C: "Delete", 0x4D: "End", 0x4E: "PageDown",
		0x4F: "Right", 0x50: "Left", 0x51: "Down", 0x52: "Up", 0x58: "NumEnter", 0x65: "Menu",
	}
	if n, ok := named[k]; ok {
		return n
	}
	if k >= 0x3A && k <= 0x45 {
		return fmt.Sprintf("F%d", k-0x3A+1)
	}
	if c, ok := usageToChar(k, true); ok && k <= 0x1D {
		return string(c)
	}
	if c, ok := usageToChar(k, false); ok {
		return string(c)
	}
	return fmt.Sprintf("0x%02X", k)
}

func describeButtons(b uint8) string {
	var parts []string
	if b&0x01 != 0 {
		parts = append(parts, "left")
	}
	if b&0x04 != 0 {
		parts = append(parts, "middle")
	}
	if b&0x02 != 0 {
		parts = append(parts, "right")
	}
	return strings.Join(parts, "+")
}

func describeHeld(m uint8, keys [6]uint8) string {
	var parts []string
	if m != 0 {
		parts = append(parts, describeModifiers(m))
	}
	for _, k := range keys {
		if k != 0 {
			parts = append(parts, keyName(k))
		}
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, " + ")
}
