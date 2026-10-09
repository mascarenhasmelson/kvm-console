package hid

/*
	controller.go

	The Controller owns the keyboard and mouse state (held modifiers, the six
	key slots, the button mask) and turns events into complete reports for a
	Reporter. Every command runs under one mutex, so events from several
	browser tabs, the REST API and the mouse jiggler can no longer interleave
	their state updates or steal each other's serial replies.
*/

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// Options tune a Controller.
type Options struct {
	// ScrollStep is the wheel step sent per scroll event (1-126). Values
	// outside the range wrap into the opposite direction on the CH9329.
	ScrollStep int
	// InvertScroll reverses the wheel direction.
	InvertScroll bool
	Logger       *log.Logger
}

// minScrollInterval drops wheel events that arrive faster than the chip can
// usefully report them (touchpads fire hundreds per second).
const minScrollInterval = 25 * time.Millisecond

// Controller is a stateful keyboard + mouse on top of a Reporter.
type Controller struct {
	r      Reporter
	opts   Options
	logger *log.Logger

	mu         sync.Mutex
	modifiers  uint8
	keys       [6]uint8
	buttons    uint8 // report order
	absX, absY uint16
	lastScroll time.Time

	jiggler          jigglerState
	activityMu       sync.Mutex
	lastActivityTime time.Time
}

// NewController wraps a reporter.
func NewController(r Reporter, opts Options) *Controller {
	if opts.ScrollStep < 1 {
		opts.ScrollStep = 1
	}
	if opts.ScrollStep > 0x7E {
		opts.ScrollStep = 0x7E
	}
	if opts.Logger == nil {
		opts.Logger = log.Default()
	}
	return &Controller{r: r, opts: opts, logger: opts.Logger, lastActivityTime: time.Now()}
}

// Reporter returns the underlying device.
func (c *Controller) Reporter() Reporter { return c.r }

// Execute runs one websocket command.
func (c *Controller) Execute(cmd *Command) error {
	c.RecordActivity()
	switch cmd.Event {
	case EventKeyPress:
		return c.KeyDown(cmd.Keycode, cmd.IsRight)
	case EventKeyRelease:
		return c.KeyUp(cmd.Keycode, cmd.IsRight)
	case EventMouseMove:
		buttons := toReportButtons(cmd.MoveButtons)
		if cmd.IsAbsolute() {
			return c.moveAbsolute(clampAbs(*cmd.MouseAbsX), clampAbs(*cmd.MouseAbsY), &buttons)
		}
		if cmd.MouseRelX != 0 || cmd.MouseRelY != 0 {
			return c.moveRelative(cmd.MouseRelX, cmd.MouseRelY, &buttons)
		}
		// No movement at all: only the button state can have changed
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.buttons == buttons {
			return nil
		}
		c.buttons = buttons
		return c.r.MouseRelative(c.buttons, 0, 0, 0)
	case EventMousePress:
		return c.MouseButton(cmd.MouseButton, true)
	case EventMouseRelease:
		return c.MouseButton(cmd.MouseButton, false)
	case EventMouseScroll:
		return c.Scroll(cmd.MouseScroll)
	case EventReleaseAll:
		return c.ReleaseAll()
	case EventReset:
		return c.Reset()
	}
	return fmt.Errorf("unsupported HID event type %d", cmd.Event)
}

// toReportButtons converts the browser's mask (bit1 = middle) to the report
// order (bit1 = right).
func toReportButtons(mask int) uint8 {
	var b uint8
	if mask&MoveButtonLeft != 0 {
		b |= reportLeft
	}
	if mask&MoveButtonMiddle != 0 {
		b |= reportMiddle
	}
	if mask&MoveButtonRight != 0 {
		b |= reportRight
	}
	return b
}

func clampAbs(v int) uint16 {
	if v < 0 {
		return 0
	}
	if v > 4095 {
		return 4095
	}
	return uint16(v)
}

func clampRel(v int) int8 {
	// 0x80 (-128) is not a valid delta on the CH9329
	if v < -127 {
		return -127
	}
	if v > 127 {
		return 127
	}
	return int8(v)
}

/* --- Keyboard --------------------------------------------------------- */

// KeyDown presses a key by JS keycode.
func (c *Controller) KeyDown(keycode int, isRight bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if bit := ModifierBit(keycode, isRight); bit != 0 {
		c.modifiers |= bit
		return c.flushKeyboard()
	}
	usage, err := usageFor(keycode, isRight)
	if err != nil {
		return err
	}
	for _, held := range c.keys {
		if held == usage {
			return nil // auto-repeat, already down
		}
	}
	for i := range c.keys {
		if c.keys[i] == 0 {
			c.keys[i] = usage
			return c.flushKeyboard()
		}
	}
	return fmt.Errorf("cannot press keycode %d: six keys are already held", keycode)
}

// KeyUp releases a key by JS keycode.
func (c *Controller) KeyUp(keycode int, isRight bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if bit := ModifierBit(keycode, isRight); bit != 0 {
		c.modifiers &^= bit
		return c.flushKeyboard()
	}
	usage, err := usageFor(keycode, isRight)
	if err != nil {
		return err
	}
	for i := range c.keys {
		if c.keys[i] == usage {
			c.keys[i] = 0
			return c.flushKeyboard()
		}
	}
	return nil // was not pressed
}

func usageFor(keycode int, isRight bool) (uint8, error) {
	if keycode == KeyEnter && isRight {
		keycode = KeyNumEnter
	}
	usage := JSKeycodeToHID(keycode)
	if usage == 0 {
		return 0, fmt.Errorf("unsupported keycode %d", keycode)
	}
	return usage, nil
}

func (c *Controller) flushKeyboard() error {
	return c.r.Keyboard(c.modifiers, c.keys)
}

/* --- Mouse ------------------------------------------------------------ */

// MoveAbsolute moves the pointer to x/y in 0-4095 keeping the button state.
func (c *Controller) MoveAbsolute(x, y int) error {
	c.RecordActivity()
	return c.moveAbsolute(clampAbs(x), clampAbs(y), nil)
}

func (c *Controller) moveAbsolute(x, y uint16, buttons *uint8) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if buttons != nil {
		c.buttons = *buttons
	}
	c.absX, c.absY = x, y
	return c.r.MouseAbsolute(c.buttons, x, y, 0)
}

// MoveRelative moves the pointer by dx/dy keeping the button state.
func (c *Controller) MoveRelative(dx, dy int) error {
	c.RecordActivity()
	return c.moveRelative(dx, dy, nil)
}

func (c *Controller) moveRelative(dx, dy int, buttons *uint8) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if buttons != nil {
		c.buttons = *buttons
	}
	return c.r.MouseRelative(c.buttons, clampRel(dx), clampRel(dy), 0)
}

// MouseButton presses or releases ButtonLeft/Right/Middle.
func (c *Controller) MouseButton(button int, down bool) error {
	var bit uint8
	switch button {
	case ButtonLeft:
		bit = reportLeft
	case ButtonRight:
		bit = reportRight
	case ButtonMiddle:
		bit = reportMiddle
	default:
		return fmt.Errorf("invalid mouse button %d", button)
	}
	c.RecordActivity()
	c.mu.Lock()
	defer c.mu.Unlock()
	if down {
		c.buttons |= bit
	} else {
		c.buttons &^= bit
	}
	// A zero-delta relative report pushes the new button state out
	return c.r.MouseRelative(c.buttons, 0, 0, 0)
}

// Scroll sends one wheel step; tilt < 0 scrolls up, > 0 scrolls down.
func (c *Controller) Scroll(tilt int) error {
	if tilt == 0 {
		return nil
	}
	c.RecordActivity()
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if now.Sub(c.lastScroll) < minScrollInterval {
		return nil
	}
	c.lastScroll = now
	if c.opts.InvertScroll {
		tilt = -tilt
	}
	step := int8(c.opts.ScrollStep)
	if tilt > 0 {
		step = -step
	}
	return c.r.MouseRelative(c.buttons, 0, 0, step)
}

/* --- Whole device ----------------------------------------------------- */

// ReleaseAll lets go of every key and button. Called when a browser
// disconnects so a key held at that moment does not stay down forever.
func (c *Controller) ReleaseAll() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.releaseAllLocked()
}

func (c *Controller) releaseAllLocked() error {
	c.modifiers = 0
	c.keys = [6]uint8{}
	c.buttons = 0
	errKeyboard := c.flushKeyboard()
	errMouse := c.r.MouseRelative(0, 0, 0, 0)
	return errors.Join(errKeyboard, errMouse)
}

// Reset soft resets the chip, then clears every key and button. Right after
// a reset the chip may not answer yet, so the release is retried.
func (c *Controller) Reset() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.r.SoftReset(); err != nil {
		return fmt.Errorf("failed to reset the HID chip: %w", err)
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = c.releaseAllLocked(); err == nil {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("chip reset but releasing keys failed: %w", err)
}

// Close stops the jiggler and closes the device.
func (c *Controller) Close() error {
	c.StopMouseJiggler()
	return c.r.Close()
}

/* --- Higher level helpers used by the REST API ------------------------ */

// Tap presses and releases a key, optionally with Shift held.
func (c *Controller) Tap(keycode int, shift bool) error {
	if shift {
		if err := c.KeyDown(KeyShift, false); err != nil {
			return err
		}
	}
	errDown := c.KeyDown(keycode, false)
	errUp := c.KeyUp(keycode, false)
	if shift {
		errUp = errors.Join(errUp, c.KeyUp(KeyShift, false))
	}
	return errors.Join(errDown, errUp)
}

// TypeText types a string on a US layout. Characters that cannot be typed
// are counted in skipped; '\r' is dropped silently so CRLF text works.
func (c *Controller) TypeText(ctx context.Context, text string, delay time.Duration) (typed, skipped int, err error) {
	c.RecordActivity()
	for _, r := range text {
		if err := ctx.Err(); err != nil {
			return typed, skipped, err
		}
		if r == '\r' {
			continue
		}
		code, shift, ok := CharToKey(r)
		if !ok {
			skipped++
			continue
		}
		if err := c.Tap(code, shift); err != nil {
			return typed, skipped, err
		}
		typed++
		if delay > 0 {
			select {
			case <-ctx.Done():
				return typed, skipped, ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	return typed, skipped, nil
}

// Shortcut presses keys in order, holds them, and releases in reverse.
func (c *Controller) Shortcut(ctx context.Context, keys []KeySpec, hold time.Duration) error {
	c.RecordActivity()
	pressed := 0
	var err error
	for _, k := range keys {
		if err = c.KeyDown(k.Keycode, k.IsRight); err != nil {
			break
		}
		pressed++
	}
	if err == nil && hold > 0 {
		select {
		case <-ctx.Done():
		case <-time.After(hold):
		}
	}
	// Always release what was pressed, even after an error
	for i := pressed - 1; i >= 0; i-- {
		err = errors.Join(err, c.KeyUp(keys[i].Keycode, keys[i].IsRight))
	}
	return err
}
