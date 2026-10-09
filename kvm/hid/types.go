// Package hid turns browser keyboard/mouse events into HID reports for the
// CH9329 USB HID bridge (or the virtual device used by demo mode).
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package hid

// EventType is the "event" field of a HID websocket message. The numbering
// is the wire protocol shared with the web UI and must not change.
type EventType int

const (
	EventKeyPress     EventType = 0
	EventKeyRelease   EventType = 1
	EventMouseMove    EventType = 2
	EventMousePress   EventType = 3
	EventMouseRelease EventType = 4
	EventMouseScroll  EventType = 5
	EventHIDCommand   EventType = 6 // reserved
	EventReleaseAll   EventType = 7
	EventReset        EventType = 0xFF
)

// Button bits of Command.MoveButtons as sent by the browser. This is NOT the
// CH9329 ordering (which puts right before middle); see toReportButtons.
const (
	MoveButtonLeft   = 0x01
	MoveButtonMiddle = 0x02
	MoveButtonRight  = 0x04
)

// Mouse button numbers of Command.MouseButton.
const (
	ButtonLeft   = 1
	ButtonRight  = 2
	ButtonMiddle = 3
)

// Command is one HID websocket message.
type Command struct {
	Event   EventType `json:"event"`
	Rid     string    `json:"rid,omitempty"` // when set, the server replies with an ACK
	Keycode int       `json:"keycode,omitempty"`
	// IsRight marks the right-hand modifier, and turns keycode 13 into
	// numpad Enter.
	IsRight bool `json:"is_right_modifier_key,omitempty"`
	// Absolute position, 0-4095 on both axes. Pointers so that a move to
	// the very top-left corner (0,0) is not mistaken for "no position".
	MouseAbsX   *int `json:"mouse_x,omitempty"`
	MouseAbsY   *int `json:"mouse_y,omitempty"`
	MouseRelX   int  `json:"mouse_rel_x,omitempty"`
	MouseRelY   int  `json:"mouse_rel_y,omitempty"`
	MoveButtons int  `json:"mouse_move_button_state,omitempty"`
	MouseButton int  `json:"mouse_button,omitempty"`
	MouseScroll int  `json:"mouse_scroll,omitempty"` // <0 up, >0 down
}

// IsPlainMove reports whether the command is a mouse move that nobody is
// waiting on, i.e. one that may be coalesced or dropped under load.
func (c *Command) IsPlainMove() bool {
	return c.Event == EventMouseMove && c.Rid == ""
}

// IsAbsolute reports whether a move carries an absolute position.
func (c *Command) IsAbsolute() bool {
	return c.MouseAbsX != nil && c.MouseAbsY != nil
}

// Reporter is the low level device: it sends complete HID reports. The
// Controller owns all key/button state and hands the reporter the full
// picture every time, so a reporter is stateless.
type Reporter interface {
	// Keyboard sends a boot keyboard report (modifier bits + up to 6 keys).
	Keyboard(modifiers uint8, keys [6]uint8) error
	// MouseAbsolute sends an absolute pointer report, x/y in 0-4095.
	MouseAbsolute(buttons uint8, x, y uint16, wheel int8) error
	// MouseRelative sends a relative pointer report.
	MouseRelative(buttons uint8, dx, dy, wheel int8) error
	// SoftReset resets the HID chip.
	SoftReset() error
	// Close releases the device.
	Close() error
}

// Report button bits (CH9329 / USB boot mouse order).
const (
	reportLeft   = 0x01
	reportRight  = 0x02
	reportMiddle = 0x04
)

// Modifier bits of the keyboard report.
const (
	ModLeftCtrl   = 0x01
	ModLeftShift  = 0x02
	ModLeftAlt    = 0x04
	ModLeftGUI    = 0x08
	ModRightCtrl  = 0x10
	ModRightShift = 0x20
	ModRightAlt   = 0x40
	ModRightGUI   = 0x80
)
