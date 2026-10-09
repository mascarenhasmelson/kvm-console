package hid

import (
	"sync"
	"time"
)

const (
	jigglerIdleTimeout = 30 * time.Second
	jigglerMoveAmount  = 10 // pixels per nudge
)

type jigglerState struct {
	mu      sync.Mutex
	enabled bool
	stopCh  chan struct{}
}

// StartMouseJiggler nudges the pointer whenever no HID command has been sent
// for jigglerIdleTimeout, so the remote machine does not go to sleep. It runs
// on the server and keeps working with no browser connected.
func (c *Controller) StartMouseJiggler() {
	c.jiggler.mu.Lock()
	defer c.jiggler.mu.Unlock()
	if c.jiggler.enabled {
		return
	}
	c.jiggler.enabled = true
	c.jiggler.stopCh = make(chan struct{})
	stopCh := c.jiggler.stopCh

	go func() {
		moveRight := true
		ticker := time.NewTicker(jigglerIdleTimeout)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				if time.Since(c.lastActivity()) < jigglerIdleTimeout {
					continue
				}
				dx := jigglerMoveAmount
				if !moveRight {
					dx = -jigglerMoveAmount
				}
				moveRight = !moveRight
				// Not via MoveRelative: that would count as user activity
				if err := c.moveRelative(dx, 0, nil); err != nil {
					c.logger.Printf("hid: jiggler move failed: %v", err)
				}
			}
		}
	}()
}

// StopMouseJiggler disables the jiggler.
func (c *Controller) StopMouseJiggler() {
	c.jiggler.mu.Lock()
	defer c.jiggler.mu.Unlock()
	if !c.jiggler.enabled {
		return
	}
	c.jiggler.enabled = false
	close(c.jiggler.stopCh)
}

// IsMouseJigglerEnabled reports whether the jiggler is running.
func (c *Controller) IsMouseJigglerEnabled() bool {
	c.jiggler.mu.Lock()
	defer c.jiggler.mu.Unlock()
	return c.jiggler.enabled
}

// RecordActivity resets the jiggler's idle timer.
func (c *Controller) RecordActivity() {
	c.activityMu.Lock()
	c.lastActivityTime = time.Now()
	c.activityMu.Unlock()
}

func (c *Controller) lastActivity() time.Time {
	c.activityMu.Lock()
	defer c.activityMu.Unlock()
	return c.lastActivityTime
}
