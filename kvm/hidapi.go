package kvm

/*
	hidapi.go

	Keyboard/mouse over a websocket for the UI, plus REST endpoints for
	integrations that want to type text or press a shortcut without speaking
	the event protocol.
*/

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"kvmconsole/kvm/audio"
	"kvmconsole/kvm/hid"
)

// Origins are checked in wsOriginOK before upgrading, where the auth method
// is known; the upgrader itself accepts whatever got that far.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

/* --- Command queue ------------------------------------------------------ */

// maxQueuedCommands bounds how far mouse movement may lag behind when the
// serial link cannot keep up (for example while the target reboots and
// every report times out).
const maxQueuedCommands = 64

// cmdQueue sits between the websocket reader and the HID executor. Mouse
// moves nobody waits for are coalesced or dropped under load; key, button,
// scroll and reset events are never dropped, because losing a key-up leaves
// that key stuck down on the remote machine.
type cmdQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	items  []*hid.Command
	closed bool
}

func newCmdQueue() *cmdQueue {
	q := &cmdQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *cmdQueue) push(cmd *hid.Command) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	if n := len(q.items); n > 0 && cmd.IsPlainMove() {
		last := q.items[n-1]
		if last.IsPlainMove() && last.MoveButtons == cmd.MoveButtons {
			switch {
			case cmd.IsAbsolute() && last.IsAbsolute():
				// Only the newest absolute position matters
				q.items[n-1] = cmd
				return
			case !cmd.IsAbsolute() && !last.IsAbsolute():
				// Relative deltas add up, as long as they fit in one report
				dx, dy := last.MouseRelX+cmd.MouseRelX, last.MouseRelY+cmd.MouseRelY
				if dx >= -127 && dx <= 127 && dy >= -127 && dy <= 127 {
					last.MouseRelX, last.MouseRelY = dx, dy
					return
				}
			}
		}
	}
	q.items = append(q.items, cmd)
	if len(q.items) > maxQueuedCommands {
		for i, item := range q.items {
			if item.IsPlainMove() {
				q.items = append(q.items[:i], q.items[i+1:]...)
				break
			}
		}
	}
	q.cond.Signal()
}

func (q *cmdQueue) pop() (*hid.Command, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.items) == 0 {
		return nil, false
	}
	cmd := q.items[0]
	q.items = q.items[1:]
	return cmd, true
}

// close stops the queue; what is already queued still drains.
func (q *cmdQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

/* --- HID websocket ------------------------------------------------------ */

type hidAck struct {
	Rid    string `json:"rid"`
	Status string `json:"status"` // "ok" or "error"
	Error  string `json:"error,omitempty"`
}

func (s *Server) handleHIDWS(w http.ResponseWriter, r *http.Request) {
	if s.hid == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("HID controller not available"))
		return
	}
	if !s.wsOriginOK(r) {
		writeError(w, http.StatusForbidden, errors.New("cross-origin websocket rejected"))
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already replied
	}
	defer conn.Close()
	conn.SetReadLimit(64 << 10)

	var writeMu sync.Mutex
	queue := newCmdQueue()
	done := make(chan struct{})

	go func() {
		defer close(done)
		var lastLogged time.Time
		for {
			cmd, ok := queue.pop()
			if !ok {
				return
			}
			err := s.hid.Execute(cmd)
			if cmd.Rid != "" {
				ack := hidAck{Rid: cmd.Rid, Status: "ok"}
				if err != nil {
					ack.Status, ack.Error = "error", err.Error()
				}
				writeMu.Lock()
				conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				conn.WriteJSON(ack)
				writeMu.Unlock()
			} else if err != nil && time.Since(lastLogged) > 5*time.Second {
				// Rate limited: with the target powered off every move fails
				lastLogged = time.Now()
				s.log.Printf("hid: %v", err)
			}
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var cmd hid.Command
		if err := json.Unmarshal(msg, &cmd); err != nil {
			continue
		}
		queue.push(&cmd)
	}

	queue.close()
	<-done
	// The browser is gone; whatever it was holding must not stay pressed
	if err := s.hid.ReleaseAll(); err != nil {
		s.log.Printf("hid: releasing keys after disconnect: %v", err)
	}
}

/* --- Audio websocket ---------------------------------------------------- */

func (s *Server) handleAudioWS(w http.ResponseWriter, r *http.Request) {
	if s.audio == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("no audio capture device available"))
		return
	}
	if !s.wsOriginOK(r) {
		writeError(w, http.StatusForbidden, errors.New("cross-origin websocket rejected"))
		return
	}
	quality := audio.NormalizeQuality(r.URL.Query().Get("quality"))
	listener, err := s.audio.Subscribe(quality)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer s.audio.Unsubscribe(listener)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	clientGone := make(chan struct{})
	go func() {
		defer close(clientGone)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil || string(msg) == "exit" {
				return
			}
		}
	}()

	for {
		select {
		case <-clientGone:
			return
		case <-listener.Done():
			conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseGoingAway, "audio capture stopped"),
				time.Now().Add(time.Second))
			return
		case chunk := <-listener.Chunks():
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				return
			}
		}
	}
}

/* --- REST HID ----------------------------------------------------------- */

func (s *Server) requireHID(w http.ResponseWriter) bool {
	if s.hid == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("HID controller not available"))
		return false
	}
	return true
}

func (s *Server) handleHIDReset(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !s.requireHID(w) {
		return
	}
	if err := s.hid.Reset(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleHIDRelease(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !s.requireHID(w) {
		return
	}
	if err := s.hid.ReleaseAll(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleJiggler reads (GET) or sets (POST) the server-side mouse jiggler.
// It runs on the server, so it keeps the target awake with no tab open.
func (s *Server) handleJiggler(w http.ResponseWriter, r *http.Request) {
	if !s.requireHID(w) {
		return
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var enable *bool
		if v := r.URL.Query().Get("enable"); v != "" {
			b := v == "true" || v == "1"
			enable = &b
		} else {
			var body struct {
				Enabled *bool `json:"enabled"`
			}
			if err := decodeJSON(r, &body); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			enable = body.Enabled
		}
		if enable == nil {
			writeError(w, http.StatusBadRequest, errors.New(`pass ?enable=true|false or {"enabled": bool}`))
			return
		}
		if *enable {
			s.hid.StartMouseJiggler()
		} else {
			s.hid.StopMouseJiggler()
		}
	default:
		requireMethod(w, r, http.MethodPost)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": s.hid.IsMouseJigglerEnabled()})
}

const maxTypeChars = 10000

func (s *Server) handleType(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !s.requireHID(w) {
		return
	}
	var body struct {
		Text    string `json:"text"`
		DelayMs *int   `json:"delay_ms"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if n := len([]rune(body.Text)); n > maxTypeChars {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Errorf("text is %d characters, the limit is %d", n, maxTypeChars))
		return
	}
	delay := 12
	if body.DelayMs != nil {
		delay = min(max(*body.DelayMs, 0), 1000)
	}
	// Two interleaved type jobs would produce garbage on the remote side
	if !s.typing.CompareAndSwap(false, true) {
		writeError(w, http.StatusConflict, errors.New("another text is still being typed"))
		return
	}
	defer s.typing.Store(false)

	typed, skipped, err := s.hid.TypeText(r.Context(), body.Text, time.Duration(delay)*time.Millisecond)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "typed": typed, "skipped": skipped})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "typed": typed, "skipped": skipped})
}

func (s *Server) handleShortcut(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !s.requireHID(w) {
		return
	}
	var body struct {
		Keys   []string `json:"keys"`
		HoldMs *int     `json:"hold_ms"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(body.Keys) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("keys must not be empty"))
		return
	}
	specs := make([]hid.KeySpec, 0, len(body.Keys))
	for _, name := range body.Keys {
		spec, ok := hid.ParseKeyName(name)
		if !ok {
			writeError(w, http.StatusBadRequest, fmt.Errorf("unknown key name %q", name))
			return
		}
		specs = append(specs, spec)
	}
	hold := 60
	if body.HoldMs != nil {
		hold = min(max(*body.HoldMs, 0), 5000)
	}
	if err := s.hid.Shortcut(r.Context(), specs, time.Duration(hold)*time.Millisecond); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleMouse(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !s.requireHID(w) {
		return
	}
	var body struct {
		Action string   `json:"action"`
		X      *float64 `json:"x"`
		Y      *float64 `json:"y"`
		Button string   `json:"button"`
		Scroll int      `json:"scroll"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	button := hid.ButtonLeft
	switch strings.ToLower(body.Button) {
	case "", "left":
	case "right":
		button = hid.ButtonRight
	case "middle":
		button = hid.ButtonMiddle
	default:
		writeError(w, http.StatusBadRequest, fmt.Errorf("unknown button %q", body.Button))
		return
	}

	hasPos := body.X != nil && body.Y != nil
	moveTo := func() error {
		if !hasPos {
			return nil
		}
		x := int(clampUnit(*body.X)*4095 + 0.5)
		y := int(clampUnit(*body.Y)*4095 + 0.5)
		return s.hid.MoveAbsolute(x, y)
	}

	var err error
	switch strings.ToLower(body.Action) {
	case "move":
		if !hasPos {
			writeError(w, http.StatusBadRequest, errors.New("move needs x and y (0..1)"))
			return
		}
		err = moveTo()
	case "click", "":
		if err = moveTo(); err == nil {
			if err = s.hid.MouseButton(button, true); err == nil {
				time.Sleep(40 * time.Millisecond)
			}
			err = errors.Join(err, s.hid.MouseButton(button, false))
		}
	case "down":
		if err = moveTo(); err == nil {
			err = s.hid.MouseButton(button, true)
		}
	case "up":
		if err = moveTo(); err == nil {
			err = s.hid.MouseButton(button, false)
		}
	case "scroll":
		if body.Scroll == 0 {
			writeError(w, http.StatusBadRequest, errors.New("scroll needs a non-zero scroll value (<0 up, >0 down)"))
			return
		}
		if err = moveTo(); err == nil {
			steps := min(abs(body.Scroll), 50)
			for i := 0; i < steps && err == nil; i++ {
				err = s.hid.Scroll(body.Scroll)
				// Wheel events closer than the controller's minimum interval
				// are dropped, so pace them.
				time.Sleep(30 * time.Millisecond)
			}
		}
	default:
		writeError(w, http.StatusBadRequest, fmt.Errorf("unknown action %q (move, click, down, up, scroll)", body.Action))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func clampUnit(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
