package hid

import (
	"bytes"
	"context"
	"testing"
)

func TestParseReply(t *testing.T) {
	ok := buildReplyFrame(0x84, 0x00)                           // success reply to 0x04
	other := buildReplyFrame(0x82, 0x00)                        // reply to a different command
	errFrame := buildReplyFrame(0xC4, 0xE1)                     // error reply to 0x04
	garbage := []byte{0x57, 0xAB, 0x00, 0x84, 0x01, 0x00, 0x00} // bad checksum

	// Stale reply to another command, garbage, then ours
	buf := append(append(append([]byte{0x11}, other...), garbage...), ok...)
	data, rest, status := parseReply(buf, 0x04)
	if status != replyOK || !bytes.Equal(data, []byte{0x00}) || len(rest) != 0 {
		t.Fatalf("status %v data %x rest %x", status, data, rest)
	}

	// Split across two reads
	_, rest, status = parseReply(ok[:3], 0x04)
	if status != replyIncomplete {
		t.Fatal("partial frame reported complete")
	}
	_, _, status = parseReply(append(rest, ok[3:]...), 0x04)
	if status != replyOK {
		t.Fatal("frame completed by a second read not recognised")
	}

	if _, _, status = parseReply(errFrame, 0x04); status != replyError {
		t.Fatalf("error reply status %v", status)
	}

	// A lone trailing 0x57 must be kept for the next read
	if _, rest, _ = parseReply([]byte{0x01, 0x57}, 0x04); !bytes.Equal(rest, []byte{0x57}) {
		t.Fatalf("rest %x", rest)
	}
}

func buildReplyFrame(reply byte, data ...byte) []byte {
	f := append([]byte{0x57, 0xAB, 0x00, reply, byte(len(data))}, data...)
	return append(f, calcChecksum(f))
}

func TestBuildPacketMatchesKnownBytes(t *testing.T) {
	// Soft reset as documented: 57 AB 00 0F 00 11
	if got := buildPacket(cmdSoftReset); !bytes.Equal(got, []byte{0x57, 0xAB, 0x00, 0x0F, 0x00, 0x11}) {
		t.Fatalf("got %x", got)
	}
	if wheelByte(2) != 0x02 || wheelByte(-2) != 0xFD {
		t.Fatal("wheel encoding changed")
	}
}

func TestKeymaps(t *testing.T) {
	cases := map[int]uint8{65: 0x04, 90: 0x1D, 49: 0x1E, 48: 0x27, 112: 0x3A, 13: 0x28, 146: 0x58, 226: 0x64, 12: 0x5D, 999: 0}
	for code, want := range cases {
		if got := JSKeycodeToHID(code); got != want {
			t.Errorf("JSKeycodeToHID(%d) = 0x%02X, want 0x%02X", code, got, want)
		}
	}

	chars := []struct {
		r     rune
		code  int
		shift bool
	}{{'a', 65, false}, {'Z', 90, true}, {'7', 55, false}, {'&', 55, true}, {'\n', 13, false}, {'?', 191, true}, {' ', 32, false}}
	for _, c := range chars {
		code, shift, ok := CharToKey(c.r)
		if !ok || code != c.code || shift != c.shift {
			t.Errorf("CharToKey(%q) = %d,%v,%v", c.r, code, shift, ok)
		}
	}
	if _, _, ok := CharToKey('é'); ok {
		t.Error("non-US character should not be typeable")
	}
}

func TestParseKeyName(t *testing.T) {
	cases := map[string]KeySpec{
		"Ctrl": {KeyCtrl, false}, "RALT": {KeyAlt, true}, "delete": {46, false},
		"f12": {123, false}, "F1": {112, false}, "x": {88, false}, "9": {57, false}, "cmd": {KeyMeta, false},
	}
	for name, want := range cases {
		got, ok := ParseKeyName(name)
		if !ok || got != want {
			t.Errorf("ParseKeyName(%q) = %+v,%v want %+v", name, got, ok, want)
		}
	}
	for _, bad := range []string{"f13", "hyper", "", "f0"} {
		if _, ok := ParseKeyName(bad); ok {
			t.Errorf("ParseKeyName(%q) should fail", bad)
		}
	}
}

// recorder is a Reporter that keeps the last keyboard report.
type recorder struct {
	mods    uint8
	keys    [6]uint8
	buttons uint8
	resets  int
}

func (r *recorder) Keyboard(m uint8, k [6]uint8) error { r.mods, r.keys = m, k; return nil }
func (r *recorder) MouseAbsolute(b uint8, x, y uint16, w int8) error {
	r.buttons = b
	return nil
}
func (r *recorder) MouseRelative(b uint8, dx, dy, w int8) error { r.buttons = b; return nil }
func (r *recorder) SoftReset() error                            { r.resets++; return nil }
func (r *recorder) Close() error                                { return nil }

func TestControllerStateAndRelease(t *testing.T) {
	rec := &recorder{}
	c := NewController(rec, Options{ScrollStep: 2})

	c.KeyDown(KeyCtrl, false)
	c.KeyDown(KeyAlt, true)
	c.KeyDown(46, false)
	if rec.mods != ModLeftCtrl|ModRightAlt || rec.keys[0] != 0x4C {
		t.Fatalf("mods %02x keys %x", rec.mods, rec.keys)
	}
	c.MouseButton(ButtonRight, true)
	if rec.buttons != reportRight {
		t.Fatalf("buttons %02x", rec.buttons)
	}

	// Absolute move to the top-left corner must not be ignored, and the
	// browser's button bits (bit1 = middle) map to report bits (bit2)
	zero := 0
	if err := c.Execute(&Command{Event: EventMouseMove, MouseAbsX: &zero, MouseAbsY: &zero, MoveButtons: MoveButtonMiddle}); err != nil {
		t.Fatal(err)
	}
	if rec.buttons != reportMiddle {
		t.Fatalf("move buttons %02x", rec.buttons)
	}

	c.ReleaseAll()
	if rec.mods != 0 || rec.keys != ([6]uint8{}) || rec.buttons != 0 {
		t.Fatal("ReleaseAll left state behind")
	}

	typed, skipped, err := c.TypeText(context.Background(), "Hi!\r\né", 0)
	if err != nil || typed != 4 || skipped != 1 {
		t.Fatalf("typed %d skipped %d err %v", typed, skipped, err)
	}
	if rec.mods != 0 || rec.keys != ([6]uint8{}) {
		t.Fatal("typing left a key held")
	}
}
