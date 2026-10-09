package kvm

/*
	api.go

	The JSON API the web UI (and integrations) drive. Every response that is
	not a media stream is JSON; errors are {"error": "..."}.
*/

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"kvmconsole/kvm/capture"
)

func osDirFS(dir string) fs.FS { return os.DirFS(dir) }

/* --- Info & auth -------------------------------------------------------- */

type infoFeatures struct {
	Video      bool `json:"video"`
	Audio      bool `json:"audio"`
	HID        bool `json:"hid"`
	Resolution bool `json:"resolution"`
	Jiggler    bool `json:"jiggler"`
	TypeText   bool `json:"type_text"`
}

type infoResponse struct {
	Name         string       `json:"name"`
	Version      string       `json:"version"`
	Mode         string       `json:"mode"`
	Demo         bool         `json:"demo"`
	AuthRequired bool         `json:"auth_required"`
	Features     infoFeatures `json:"features"`
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, infoResponse{
		Name:         s.cfg.Name,
		Version:      Version,
		Mode:         "ip",
		Demo:         s.cfg.Demo,
		AuthRequired: s.auth.required(),
		Features: infoFeatures{
			Video:      true,
			Audio:      s.audio != nil,
			HID:        s.hid != nil,
			Resolution: true,
			Jiggler:    s.hid != nil,
			TypeText:   s.hid != nil,
		},
	})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	method, ok := s.auth.identify(r)
	if !ok {
		method = authNone
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": ok,
		"auth_required": s.auth.required(),
		"method":        method,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !s.auth.originAllowed(r) {
		writeError(w, http.StatusForbidden, errors.New("cross-origin request rejected"))
		return
	}
	ip := clientIP(r)
	if s.auth.loginBlocked(ip) {
		writeError(w, http.StatusTooManyRequests, errors.New("Too many failed attempts, try again in a minute"))
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	switch {
	case !s.auth.required():
		// Nothing to log in to; succeed so the UI can proceed.
	case !s.auth.hasPassword:
		// Only API tokens are configured: password login must not become a
		// way around them.
		writeError(w, http.StatusUnauthorized, errors.New("Password login is not enabled on this server; use an API token"))
		return
	case !s.auth.checkPassword(body.Password):
		s.auth.recordFailure(ip)
		s.log.Printf("auth: failed login from %s", ip)
		writeError(w, http.StatusUnauthorized, errors.New("Invalid password"))
		return
	}
	s.auth.clearFailures(ip)
	expiry := time.Now().Add(s.auth.ttl)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    s.auth.signSession(expiry),
		Path:     "/",
		Expires:  expiry,
		HttpOnly: true,
		Secure:   isSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

/* --- Status ------------------------------------------------------------- */

type statusResponse struct {
	VideoDevice    string  `json:"video_device"`
	AudioDevice    string  `json:"audio_device"`
	SerialDevice   string  `json:"serial_device"`
	VideoSource    string  `json:"video_source"`
	AudioSource    string  `json:"audio_source"`
	SerialSource   string  `json:"serial_source"`
	Capturing      bool    `json:"capturing"`
	AudioAvailable bool    `json:"audio_available"`
	AudioStreaming bool    `json:"audio_streaming"`
	HIDAvailable   bool    `json:"hid_available"`
	JigglerEnabled bool    `json:"jiggler_enabled"`
	StreamInfo     string  `json:"stream_info"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	FPS            int     `json:"fps"`
	Viewers        int     `json:"viewers"`
	AudioListeners int     `json:"audio_listeners"`
	MeasuredFPS    float64 `json:"measured_fps"`
	BitrateKbps    float64 `json:"bitrate_kbps"`
	UptimeS        int64   `json:"uptime_s"`
	Demo           bool    `json:"demo"`
	Name           string  `json:"name"`
}

func (s *Server) status() statusResponse {
	v := s.video.Status()
	st := statusResponse{
		VideoDevice:    s.devices.VideoNode,
		AudioDevice:    s.devices.AudioNode,
		SerialDevice:   s.devices.SerialNode,
		VideoSource:    s.devices.VideoSource,
		AudioSource:    s.devices.AudioSource,
		SerialSource:   s.devices.SerialSource,
		Capturing:      v.Capturing,
		AudioAvailable: s.audio != nil,
		HIDAvailable:   s.hid != nil,
		StreamInfo:     v.Info.Description,
		Width:          v.Info.Width,
		Height:         v.Info.Height,
		FPS:            v.Info.FPS,
		Viewers:        v.Viewers,
		MeasuredFPS:    round1(v.FPS),
		BitrateKbps:    round1(v.Kbps),
		UptimeS:        int64(time.Since(s.started).Seconds()),
		Demo:           s.cfg.Demo,
		Name:           s.cfg.Name,
	}
	if s.audio != nil {
		st.AudioStreaming = s.audio.Streaming()
		st.AudioListeners = s.audio.Count()
	}
	if s.hid != nil {
		st.JigglerEnabled = s.hid.IsMouseJigglerEnabled()
	}
	return st
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.status())
}

// handleEvents pushes the status as server-sent events, so dashboards and
// the UI do not have to poll.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming not supported"))
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func() error {
		data, err := json.Marshal(s.status())
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: status\ndata: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if send() != nil {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if send() != nil {
				return
			}
		}
	}
}

/* --- Video -------------------------------------------------------------- */

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	maxFPS, _ := strconv.Atoi(r.URL.Query().Get("fps"))
	if maxFPS < 0 {
		maxFPS = 0
	}
	s.video.ServeStream(w, r, maxFPS)
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	frame := s.video.Latest()
	if frame == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("no video frame available yet"))
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(frame)))
	w.Header().Set("Content-Disposition", `inline; filename="snapshot.jpg"`)
	w.Write(frame)
}

type resolutionEntry struct {
	Width  int   `json:"width"`
	Height int   `json:"height"`
	FPS    []int `json:"fps"`
}

// maxSelectableFPS caps what the resolution picker offers. The card
// advertises 50 and 60fps, but a browser's MJPEG decoder cannot keep up with
// either at useful resolutions and the bitrate saturates the link first.
// Those modes are hidden rather than removed: POSTing one still works.
const maxSelectableFPS = 30

func (s *Server) handleResolutions(w http.ResponseWriter, r *http.Request) {
	sizes, err := s.video.Source().Modes()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	entries := make([]resolutionEntry, 0, len(sizes))
	for _, size := range sizes {
		var rates []int
		for _, rate := range size.FPS {
			if rate <= maxSelectableFPS {
				rates = append(rates, rate)
			}
		}
		if len(rates) == 0 {
			continue
		}
		entries = append(entries, resolutionEntry{Width: size.Width, Height: size.Height, FPS: rates})
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleSetResolution(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var res capture.Resolution
	q := r.URL.Query()
	if q.Get("width") != "" || q.Get("height") != "" {
		var err error
		if res.Width, err = intParam(q.Get("width"), "width"); err == nil {
			if res.Height, err = intParam(q.Get("height"), "height"); err == nil {
				res.FPS, err = intParam(q.Get("fps"), "fps")
			}
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	} else {
		var body struct {
			Width  int `json:"width"`
			Height int `json:"height"`
			FPS    int `json:"fps"`
		}
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res = capture.Resolution{Width: body.Width, Height: body.Height, FPS: body.FPS}
	}
	if res.Width <= 0 || res.Height <= 0 || res.FPS <= 0 {
		writeError(w, http.StatusBadRequest, errors.New("width, height and fps must be positive"))
		return
	}

	s.resMu.Lock()
	defer s.resMu.Unlock()
	s.log.Printf("Changing capture resolution to %dx%d @ %dfps", res.Width, res.Height, res.FPS)
	if err := s.video.ChangeResolution(res); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stream_info": s.video.Status().Info.Description})
}

/* --- Helpers ------------------------------------------------------------ */

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("%s required", method))
	return false
}

func intParam(raw, name string) (int, error) {
	if raw == "" {
		return 0, fmt.Errorf("missing parameter %s", name)
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid value for %s: %s", name, raw)
	}
	return v, nil
}

// decodeJSON reads a JSON body of at most 1 MiB. An empty body decodes to
// the zero value so that optional-body endpoints accept bare POSTs.
func decodeJSON(r *http.Request, dst any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20+1))
	if err != nil {
		return err
	}
	if len(body) > 1<<20 {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
