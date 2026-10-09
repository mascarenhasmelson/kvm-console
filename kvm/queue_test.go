package kvm

import (
	"testing"

	"kvmconsole/kvm/hid"
)

func TestQueueCoalescesMovesButKeepsKeys(t *testing.T) {
	q := newCmdQueue()
	x1, y1, x2, y2 := 10, 10, 20, 20
	q.push(&hid.Command{Event: hid.EventMouseMove, MouseAbsX: &x1, MouseAbsY: &y1})
	q.push(&hid.Command{Event: hid.EventMouseMove, MouseAbsX: &x2, MouseAbsY: &y2})
	q.push(&hid.Command{Event: hid.EventMouseMove, MouseRelX: 5})
	q.push(&hid.Command{Event: hid.EventMouseMove, MouseRelX: 7})
	for i := 0; i < 50; i++ {
		q.push(&hid.Command{Event: hid.EventKeyRelease, Keycode: 65})
	}
	q.close()

	first, _ := q.pop()
	if *first.MouseAbsX != 20 {
		t.Fatalf("absolute moves not coalesced to the newest position: %d", *first.MouseAbsX)
	}
	second, _ := q.pop()
	if second.MouseRelX != 12 {
		t.Fatalf("relative moves not summed: %d", second.MouseRelX)
	}
	releases := 0
	for {
		cmd, ok := q.pop()
		if !ok {
			break
		}
		if cmd.Event == hid.EventKeyRelease {
			releases++
		}
	}
	if releases != 50 {
		t.Fatalf("key releases dropped: %d of 50 left", releases)
	}
}

func TestQueueOverflowDropsMovesNeverKeys(t *testing.T) {
	q := newCmdQueue()
	x := 1
	q.push(&hid.Command{Event: hid.EventMouseMove, MouseAbsX: &x, MouseAbsY: &x})
	for i := 0; i < 200; i++ {
		q.push(&hid.Command{Event: hid.EventKeyRelease, Keycode: 65})
	}
	q.close()
	releases := 0
	for {
		cmd, ok := q.pop()
		if !ok {
			break
		}
		if cmd.Event != hid.EventKeyRelease {
			t.Fatal("the stale move should have been dropped first")
		}
		releases++
	}
	if releases != 200 {
		t.Fatalf("key releases dropped: %d of 200 left", releases)
	}
}
