package hid

/*
	ch9329.go

	Serial protocol of the WCH CH9329 UART-to-USB-HID chip, reached through a
	CH340/CH341 USB-serial bridge. Every packet is

	  57 AB | addr 00 | cmd | len | data... | sum

	and the chip answers each one with the same layout, cmd|0x80 on success
	or cmd|0xC0 on error.
*/

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	tserial "github.com/tarm/serial"
)

const (
	cmdGetInfo          = 0x01
	cmdKeyboard         = 0x02
	cmdMouseAbsolute    = 0x04
	cmdMouseRelative    = 0x05
	cmdGetConfig        = 0x08
	cmdSetConfig        = 0x09
	cmdSetUSBString     = 0x0B
	cmdSoftReset        = 0x0F
	replyTimeout        = 400 * time.Millisecond
	serialReadTimeout   = 500 * time.Millisecond
	incomingQueueLength = 64
)

// CH9329 is a Reporter backed by the real chip.
type CH9329 struct {
	port   *tserial.Port
	logger *log.Logger

	mu      sync.Mutex // one transaction on the wire at a time
	rx      chan []byte
	pending []byte

	closed    chan struct{}
	closeOnce sync.Once
}

// OpenCH9329 opens the serial port and soft resets the chip.
func OpenCH9329(portName string, baud int, logger *log.Logger) (*CH9329, error) {
	if logger == nil {
		logger = log.Default()
	}
	port, err := tserial.OpenPort(&tserial.Config{
		Name:        portName,
		Baud:        baud,
		Size:        8,
		Parity:      tserial.ParityNone,
		ReadTimeout: serialReadTimeout,
	})
	if err != nil {
		return nil, err
	}
	d := &CH9329{
		port:   port,
		logger: logger,
		rx:     make(chan []byte, incomingQueueLength),
		closed: make(chan struct{}),
	}
	go d.readLoop()

	// Not every target is powered on when the server starts, so a missing
	// reply here is not an error worth failing over.
	if err := d.SoftReset(); err != nil {
		logger.Printf("hid: initial soft reset got no reply (%v); is the target machine on?", err)
	}
	return d, nil
}

func (d *CH9329) readLoop() {
	buf := make([]byte, 256)
	for {
		n, err := d.port.Read(buf)
		select {
		case <-d.closed:
			return
		default:
		}
		if n > 0 {
			// buf is reused by the next Read, so hand over a copy
			chunk := append([]byte(nil), buf[:n]...)
			select {
			case d.rx <- chunk:
			default:
				// Nobody is waiting for this much data; it can only be
				// stale replies, which the next transaction discards anyway.
			}
		}
		if err != nil && !errors.Is(err, io.EOF) {
			// Back off instead of spinning on a port that keeps failing
			// (for example a USB bridge that was unplugged).
			time.Sleep(100 * time.Millisecond)
		}
	}
}

// transact sends a packet and waits for the chip's reply to cmd.
func (d *CH9329) transact(packet []byte, cmd byte) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	select {
	case <-d.closed:
		return nil, errors.New("serial port is closed")
	default:
	}

	// Throw away anything left over, typically the late reply of a command
	// that already timed out. It would otherwise be matched to this one.
	d.pending = nil
	for drained := false; !drained; {
		select {
		case <-d.rx:
		default:
			drained = true
		}
	}

	if _, err := d.port.Write(packet); err != nil {
		return nil, fmt.Errorf("serial write failed: %w", err)
	}

	timer := time.NewTimer(replyTimeout)
	defer timer.Stop()
	for {
		data, rest, status := parseReply(d.pending, cmd)
		d.pending = rest
		switch status {
		case replyOK:
			return data, nil
		case replyError:
			code := byte(0xFF)
			if len(data) > 0 {
				code = data[0]
			}
			return nil, fmt.Errorf("HID chip returned error 0x%02X for command 0x%02X", code, cmd)
		}
		select {
		case chunk := <-d.rx:
			d.pending = append(d.pending, chunk...)
		case <-timer.C:
			return nil, fmt.Errorf("timeout waiting for the HID chip to answer command 0x%02X", cmd)
		case <-d.closed:
			return nil, errors.New("serial port is closed")
		}
	}
}

type replyStatus int

const (
	replyIncomplete replyStatus = iota
	replyOK
	replyError
)

// parseReply scans buf for a complete, checksummed reply to cmd. Frames for
// other commands and corrupt bytes are skipped. rest is what is left to keep
// for the next call.
func parseReply(buf []byte, cmd byte) (data []byte, rest []byte, status replyStatus) {
	header := []byte{0x57, 0xAB}
	i := 0
	for {
		idx := bytes.Index(buf[i:], header)
		if idx < 0 {
			// Keep a trailing 0x57: it may be the first half of a header
			if len(buf) > 0 && buf[len(buf)-1] == 0x57 {
				return nil, []byte{0x57}, replyIncomplete
			}
			return nil, nil, replyIncomplete
		}
		start := i + idx
		if len(buf)-start < 6 {
			return nil, buf[start:], replyIncomplete
		}
		length := int(buf[start+4])
		total := 5 + length + 1
		if len(buf)-start < total {
			return nil, buf[start:], replyIncomplete
		}
		frame := buf[start : start+total]
		if calcChecksum(frame[:total-1]) != frame[total-1] {
			i = start + 1 // not a real header after all
			continue
		}
		switch frame[3] {
		case cmd | 0x80:
			return frame[5 : 5+length], buf[start+total:], replyOK
		case cmd | 0xC0:
			return frame[5 : 5+length], buf[start+total:], replyError
		}
		i = start + total // a valid reply, but to some other command
	}
}

func calcChecksum(data []byte) byte {
	var sum byte
	for _, b := range data {
		sum += b
	}
	return sum
}

// buildPacket frames a command with header and checksum.
func buildPacket(cmd byte, payload ...byte) []byte {
	packet := make([]byte, 0, 6+len(payload))
	packet = append(packet, 0x57, 0xAB, 0x00, cmd, byte(len(payload)))
	packet = append(packet, payload...)
	return append(packet, calcChecksum(packet))
}

// Keyboard implements Reporter.
func (d *CH9329) Keyboard(modifiers uint8, keys [6]uint8) error {
	payload := []byte{modifiers, 0x00, keys[0], keys[1], keys[2], keys[3], keys[4], keys[5]}
	_, err := d.transact(buildPacket(cmdKeyboard, payload...), cmdKeyboard)
	return err
}

// MouseAbsolute implements Reporter.
func (d *CH9329) MouseAbsolute(buttons uint8, x, y uint16, wheel int8) error {
	payload := []byte{0x02, buttons, byte(x), byte(x >> 8), byte(y), byte(y >> 8), wheelByte(wheel)}
	_, err := d.transact(buildPacket(cmdMouseAbsolute, payload...), cmdMouseAbsolute)
	return err
}

// MouseRelative implements Reporter.
func (d *CH9329) MouseRelative(buttons uint8, dx, dy, wheel int8) error {
	payload := []byte{0x01, buttons, byte(dx), byte(dy), wheelByte(wheel)}
	_, err := d.transact(buildPacket(cmdMouseRelative, payload...), cmdMouseRelative)
	return err
}

// wheelByte encodes a wheel step the way the CH9329 expects: 0x01-0x7F
// scroll up, 0x81-0xFF scroll down.
func wheelByte(w int8) byte {
	if w >= 0 {
		return byte(w)
	}
	return 0xFF - byte(-w)
}

// SoftReset implements Reporter.
func (d *CH9329) SoftReset() error {
	_, err := d.transact(buildPacket(cmdSoftReset), cmdSoftReset)
	return err
}

// ChipInfo returns the raw reply of the "get info" command (version, USB
// enumeration state, lock LEDs).
func (d *CH9329) ChipInfo() ([]byte, error) {
	return d.transact(buildPacket(cmdGetInfo), cmdGetInfo)
}

// Configuration returns the 50 byte parameter block of the chip.
func (d *CH9329) Configuration() ([]byte, error) {
	resp, err := d.transact(buildPacket(cmdGetConfig), cmdGetConfig)
	if err != nil {
		return nil, err
	}
	if len(resp) < 50 {
		return nil, fmt.Errorf("invalid configuration length %d", len(resp))
	}
	return resp, nil
}

// ConfigureTo115200 switches the chip to mode 2 (keyboard + mouse) at
// 115200 baud. The new rate applies after the chip is power cycled.
func (d *CH9329) ConfigureTo115200() error {
	config, err := d.Configuration()
	if err != nil {
		return err
	}
	config[0] = 0x02 // mode 2, standard keyboard + mouse
	config[3], config[4], config[5], config[6] = 0x00, 0x01, 0xC2, 0x00
	_, err = d.transact(buildPacket(cmdSetConfig, config[:50]...), cmdSetConfig)
	return err
}

// SetUSBStrings sets the manufacturer and product strings the chip reports
// to the target machine.
func (d *CH9329) SetUSBStrings(manufacturer, product string) error {
	for i, s := range []string{manufacturer, product} {
		if len(s) > 23 {
			return fmt.Errorf("USB string %q is too long (max 23 bytes)", s)
		}
		payload := append([]byte{byte(i), byte(len(s))}, s...)
		if _, err := d.transact(buildPacket(cmdSetUSBString, payload...), cmdSetUSBString); err != nil {
			return err
		}
	}
	return nil
}

// WriteChipProperties brands the chip with neutral USB descriptor strings.
func (d *CH9329) WriteChipProperties() error {
	return d.SetUSBStrings("KVM", "KVMConsole")
}

// Close implements Reporter.
func (d *CH9329) Close() error {
	d.closeOnce.Do(func() {
		close(d.closed)
		done := make(chan struct{})
		go func() {
			d.port.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			d.logger.Println("hid: serial port close timed out")
		}
	})
	return nil
}
