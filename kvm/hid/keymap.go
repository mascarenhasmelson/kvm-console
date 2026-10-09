package hid

import "strings"

// JS keyCodes of the modifier keys
const (
	KeyShift     = 16
	KeyCtrl      = 17
	KeyAlt       = 18
	KeyMeta      = 91
	KeyRightMeta = 92
	KeyEnter     = 13
	KeyNumEnter  = 146 // synthetic: Enter with the numpad location
)

// ModifierBit returns the report bit for a modifier keycode, or 0 when the
// keycode is not a modifier.
func ModifierBit(keycode int, isRight bool) uint8 {
	switch keycode {
	case KeyCtrl:
		if isRight {
			return ModRightCtrl
		}
		return ModLeftCtrl
	case KeyShift:
		if isRight {
			return ModRightShift
		}
		return ModLeftShift
	case KeyAlt:
		if isRight {
			return ModRightAlt
		}
		return ModLeftAlt
	case KeyMeta:
		if isRight {
			return ModRightGUI
		}
		return ModLeftGUI
	case KeyRightMeta:
		// Some browsers report the right Windows key as its own keycode
		return ModRightGUI
	}
	return 0
}

// JSKeycodeToHID converts a JavaScript KeyboardEvent.keyCode into a HID
// usage ID. 0 means unsupported.
func JSKeycodeToHID(keycode int) uint8 {
	// Letters A-Z
	if keycode >= 65 && keycode <= 90 {
		return uint8(keycode-65) + 0x04
	}
	// Numbers 1-9 (top row, not numpad)
	if keycode >= 49 && keycode <= 57 {
		return uint8(keycode-49) + 0x1E
	}
	// F1 to F12
	if keycode >= 112 && keycode <= 123 {
		return uint8(keycode-112) + 0x3A
	}

	switch keycode {
	case 8:
		return 0x2A // Backspace
	case 9:
		return 0x2B // Tab
	case 12:
		return 0x5D // Numpad 5 with NumLock off ("Clear")
	case 13:
		return 0x28 // Enter
	case 16:
		return 0xE1 // Left shift
	case 17:
		return 0xE0 // Left Ctrl
	case 18:
		return 0xE2 // Left Alt
	case 19:
		return 0x48 // Pause
	case 20:
		return 0x39 // Caps Lock
	case 27:
		return 0x29 // Escape
	case 32:
		return 0x2C // Spacebar
	case 33:
		return 0x4B // Page Up
	case 34:
		return 0x4E // Page Down
	case 35:
		return 0x4D // End
	case 36:
		return 0x4A // Home
	case 37:
		return 0x50 // Left Arrow
	case 38:
		return 0x52 // Up Arrow
	case 39:
		return 0x4F // Right Arrow
	case 40:
		return 0x51 // Down Arrow
	case 44:
		return 0x46 // Print Screen (F13 on Firefox)
	case 45:
		return 0x49 // Insert
	case 46:
		return 0x4C // Delete
	case 48:
		return 0x27 // 0 (not numpad)
	case 59:
		return 0x33 // ';' (Firefox)
	case 61:
		return 0x2E // '=' (Firefox)
	case 91:
		return 0xE3 // Left GUI (Windows / Command)
	case 92:
		return 0xE7 // Right GUI
	case 93:
		return 0x65 // Menu key
	case 96:
		return 0x62 // Numpad 0
	case 97:
		return 0x59 // Numpad 1
	case 98:
		return 0x5A // Numpad 2
	case 99:
		return 0x5B // Numpad 3
	case 100:
		return 0x5C // Numpad 4
	case 101:
		return 0x5D // Numpad 5
	case 102:
		return 0x5E // Numpad 6
	case 103:
		return 0x5F // Numpad 7
	case 104:
		return 0x60 // Numpad 8
	case 105:
		return 0x61 // Numpad 9
	case 106:
		return 0x55 // Numpad *
	case 107:
		return 0x57 // Numpad +
	case 109:
		return 0x56 // Numpad -
	case 110:
		return 0x63 // Numpad .
	case 111:
		return 0x54 // Numpad /
	case 144:
		return 0x53 // Num Lock
	case 145:
		return 0x47 // Scroll Lock
	case 146:
		return 0x58 // Numpad Enter
	case 173:
		return 0x2D // '-' (Firefox)
	case 186:
		return 0x33 // ';'
	case 187:
		return 0x2E // '='
	case 188:
		return 0x36 // ','
	case 189:
		return 0x2D // '-'
	case 190:
		return 0x37 // '.'
	case 191:
		return 0x38 // '/'
	case 192:
		return 0x35 // '`'
	case 219:
		return 0x2F // '['
	case 220:
		return 0x31 // backslash
	case 221:
		return 0x30 // ']'
	case 222:
		return 0x34 // '\''
	case 226:
		return 0x64 // ISO key between left Shift and Z
	}
	return 0x00
}

// shiftedSymbols maps the characters that need Shift on a US layout to the
// keycode of the key that produces them.
var shiftedSymbols = map[rune]int{
	'!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56,
	'(': 57, ')': 48, '_': 189, '+': 187, '{': 219, '}': 221, '|': 220,
	':': 186, '"': 222, '<': 188, '>': 190, '?': 191, '~': 192,
}

var plainSymbols = map[rune]int{
	' ': 32, '-': 189, '=': 187, '[': 219, ']': 221, '\\': 220, ';': 186,
	'\'': 222, ',': 188, '.': 190, '/': 191, '`': 192, '\n': 13, '\t': 9,
}

// CharToKey maps a character to the JS keycode that types it on a US
// keyboard layout, and whether Shift must be held.
func CharToKey(r rune) (keycode int, shift bool, ok bool) {
	switch {
	case r >= 'a' && r <= 'z':
		return int(r-'a') + 65, false, true
	case r >= 'A' && r <= 'Z':
		return int(r-'A') + 65, true, true
	case r >= '0' && r <= '9':
		return int(r-'0') + 48, false, true
	}
	if code, found := plainSymbols[r]; found {
		return code, false, true
	}
	if code, found := shiftedSymbols[r]; found {
		return code, true, true
	}
	return 0, false, false
}

// shortcutNames maps the names accepted by the shortcut API to keycodes.
var shortcutNames = map[string]KeySpec{
	"ctrl": {KeyCtrl, false}, "control": {KeyCtrl, false},
	"shift": {KeyShift, false},
	"alt":   {KeyAlt, false}, "option": {KeyAlt, false},
	"meta": {KeyMeta, false}, "win": {KeyMeta, false}, "cmd": {KeyMeta, false},
	"command": {KeyMeta, false}, "super": {KeyMeta, false}, "gui": {KeyMeta, false},
	"rctrl": {KeyCtrl, true}, "rshift": {KeyShift, true},
	"ralt": {KeyAlt, true}, "altgr": {KeyAlt, true}, "rmeta": {KeyMeta, true},
	"enter": {13, false}, "return": {13, false},
	"esc": {27, false}, "escape": {27, false},
	"tab": {9, false}, "space": {32, false}, "backspace": {8, false},
	"delete": {46, false}, "del": {46, false},
	"insert": {45, false}, "ins": {45, false},
	"home": {36, false}, "end": {35, false},
	"pageup": {33, false}, "pagedown": {34, false},
	"up": {38, false}, "down": {40, false}, "left": {37, false}, "right": {39, false},
	"printscreen": {44, false}, "prtsc": {44, false},
	"pause": {19, false}, "capslock": {20, false}, "numlock": {144, false},
	"scrolllock": {145, false}, "menu": {93, false},
	"minus": {189, false}, "equal": {187, false}, "comma": {188, false},
	"period": {190, false}, "slash": {191, false}, "backslash": {220, false},
	"semicolon": {186, false}, "quote": {222, false}, "backquote": {192, false},
	"bracketleft": {219, false}, "bracketright": {221, false},
}

// KeySpec is a keycode plus its left/right location.
type KeySpec struct {
	Keycode int
	IsRight bool
}

// ParseKeyName resolves a shortcut key name (case-insensitive).
func ParseKeyName(name string) (KeySpec, bool) {
	n := strings.ToLower(strings.TrimSpace(name))
	if spec, ok := shortcutNames[n]; ok {
		return spec, true
	}
	if len(n) == 1 {
		c := n[0]
		switch {
		case c >= 'a' && c <= 'z':
			return KeySpec{int(c-'a') + 65, false}, true
		case c >= '0' && c <= '9':
			return KeySpec{int(c-'0') + 48, false}, true
		}
	}
	if len(n) >= 2 && n[0] == 'f' {
		num := 0
		for _, c := range n[1:] {
			if c < '0' || c > '9' {
				return KeySpec{}, false
			}
			num = num*10 + int(c-'0')
		}
		if num >= 1 && num <= 12 {
			return KeySpec{111 + num, false}, true
		}
	}
	return KeySpec{}, false
}
