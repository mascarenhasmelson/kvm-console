package kvm

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"kvmconsole/kvm/audio"
	"kvmconsole/kvm/capture"
	"kvmconsole/kvm/demo"
	"kvmconsole/kvm/detect"
	"kvmconsole/kvm/hid"
	"kvmconsole/web"
)

// Server is one KVM: a capture hub, an optional audio hub and an optional
// HID controller behind an HTTP API.
type Server struct {
	cfg     Config
	log     *log.Logger
	devices detect.Devices
	video   *capture.Hub
	audio   *audio.Hub      // nil without an audio device
	hid     *hid.Controller // nil without a HID device
	auth    *authenticator
	started time.Time

	handler   http.Handler
	resMu     sync.Mutex
	typing    atomic.Bool
	closeOnce sync.Once
}

// New opens the hardware (or the demo stand-ins) and starts capturing.
func New(cfg Config) (*Server, error) {
	cfg.applyDefaults()
	s := &Server{cfg: cfg, log: cfg.Logger, started: time.Now(), auth: newAuthenticator(&cfg)}

	var src capture.Source
	hidOpts := hid.Options{ScrollStep: cfg.ScrollSensitivity, Logger: cfg.Logger}

	if cfg.Demo {
		st := demo.NewState()
		src = demo.NewSource(st)
		s.devices = detect.Devices{
			VideoNode:    "demo",
			VideoSource:  "demo mode (synthetic desktop)",
			AudioSource:  "not available in demo mode",
			SerialNode:   "demo",
			SerialSource: "demo mode (virtual HID chip)",
		}
		if !cfg.NoHID {
			s.hid = hid.NewController(demo.NewReporter(st), hidOpts)
		}
	} else {
		devices, err := detect.Detect(cfg.VideoDevice, cfg.AudioDevice, cfg.SerialDevice)
		if err != nil {
			return nil, fmt.Errorf("device detection failed: %w", err)
		}
		s.devices = *devices
		src = capture.NewV4L2Source(devices.VideoNode, cfg.Logger)
		if devices.AudioNode != "" {
			s.audio = audio.NewHub(devices.AudioNode, cfg.Logger)
		}
		switch {
		case cfg.NoHID:
			s.devices.SerialSource = "disabled (-no-hid)"
		case devices.SerialNode == "":
			s.log.Println("WARNING: no CH340/CH341 serial port found, keyboard and mouse control is disabled")
		default:
			chip, err := hid.OpenCH9329(devices.SerialNode, cfg.BaudRate, cfg.Logger)
			if err != nil {
				s.log.Printf("WARNING: failed to open %s: %v - keyboard and mouse control is disabled", devices.SerialNode, err)
			} else {
				s.hid = hid.NewController(chip, hidOpts)
				s.log.Printf("HID controller connected on %s @ %d baud", devices.SerialNode, cfg.BaudRate)
			}
		}
	}

	res, err := pickResolution(src, cfg.Width, cfg.Height, cfg.FPS)
	if err != nil {
		s.closeDevices()
		return nil, fmt.Errorf("failed to pick a capture resolution: %w", err)
	}
	s.video = capture.NewHub(src, cfg.JPEGQuality, cfg.Logger)
	if err := s.video.Start(res); err != nil {
		s.closeDevices()
		return nil, fmt.Errorf("failed to start video capture: %w", err)
	}
	s.log.Printf("Capturing %s", s.video.Status().Info.Description)

	ui, err := s.uiHandler()
	if err != nil {
		s.Close()
		return nil, err
	}
	s.handler = s.buildRouter(ui)
	return s, nil
}

// Devices returns the device nodes in use.
func (s *Server) Devices() detect.Devices { return s.devices }

// AuthRequired reports whether a password or API token is configured.
func (s *Server) AuthRequired() bool { return s.auth.required() }

// Handler returns the HTTP handler. It can be mounted under a prefix with
// http.StripPrefix; every URL the UI uses is relative.
func (s *Server) Handler() http.Handler { return s.handler }

// Close releases all hardware. Leaving the V4L2 device or the ALSA PCM open
// makes the next start fail with EBUSY.
func (s *Server) Close() error {
	var err error
	s.closeOnce.Do(func() {
		if s.video != nil {
			err = s.video.Close()
		}
		s.closeDevices()
	})
	return err
}

func (s *Server) closeDevices() {
	if s.audio != nil {
		s.audio.Close()
	}
	if s.hid != nil {
		s.hid.Close()
	}
}

func (s *Server) uiHandler() (http.Handler, error) {
	if s.cfg.DisableUI {
		return http.NotFoundHandler(), nil
	}
	var files fs.FS
	if s.cfg.WebDir != "" {
		s.log.Printf("Serving the web UI from %s", s.cfg.WebDir)
		files = osDirFS(s.cfg.WebDir)
	} else {
		files = web.FS()
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		s.log.Printf("WARNING: the web UI has no index.html (%v); only the API will be useful", err)
	}
	fileServer := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Revalidate on every load so an upgraded binary never runs a stale UI
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	}), nil
}

// pickResolution resolves the requested width/height/fps against what the
// source supports. Zero width or height means "largest available", and the
// frame rate is capped at maxFPS because anything above ~30fps at 1080p
// saturates both the USB bus and the browser's MJPEG decoder.
func pickResolution(src capture.Source, width, height, maxFPS int) (capture.Resolution, error) {
	sizes, err := src.Modes()
	if err != nil {
		return capture.Resolution{}, err
	}
	if len(sizes) == 0 {
		return capture.Resolution{}, errors.New("the capture device reports no MJPEG modes")
	}
	if width > 0 && height > 0 {
		var available []string
		for _, size := range sizes {
			if size.Width == width && size.Height == height {
				return capture.Resolution{Width: width, Height: height, FPS: bestFPS(size.FPS, maxFPS)}, nil
			}
			available = append(available, fmt.Sprintf("%dx%d", size.Width, size.Height))
		}
		// Explicit size requested: it has to exist, otherwise the user gets
		// a listing of what is on offer instead of a silent fallback.
		return capture.Resolution{}, fmt.Errorf("device does not support %dx%d (supported: %s)", width, height, strings.Join(available, ", "))
	}
	largest := sizes[0]
	return capture.Resolution{Width: largest.Width, Height: largest.Height, FPS: bestFPS(largest.FPS, maxFPS)}, nil
}

// bestFPS returns the highest supported rate not above maxFPS, falling back
// to the lowest available rate when every option is too fast.
func bestFPS(rates []int, maxFPS int) int {
	best, lowest := 0, 0
	for _, rate := range rates {
		if lowest == 0 || rate < lowest {
			lowest = rate
		}
		if rate <= maxFPS && rate > best {
			best = rate
		}
	}
	if best > 0 {
		return best
	}
	if lowest > 0 {
		return lowest
	}
	return maxFPS
}

// buildRouter wires the API. Auth-protected endpoints go through s.protect.
func (s *Server) buildRouter(ui http.Handler) http.Handler {
	mux := http.NewServeMux()

	/* Public */
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/info", s.handleInfo)
	mux.HandleFunc("/api/auth/session", s.handleSession)
	mux.HandleFunc("/api/auth/login", s.handleLogin)
	mux.HandleFunc("/api/auth/logout", s.handleLogout)

	/* Status */
	mux.Handle("/api/status", s.protect(s.handleStatus))
	mux.Handle("/api/events", s.protect(s.handleEvents))

	/* Video */
	mux.Handle("/api/video/stream", s.protect(s.handleStream))
	mux.Handle("/api/video/snapshot", s.protect(s.handleSnapshot))
	mux.Handle("/api/video/screenshot", s.protect(s.handleSnapshot))
	mux.Handle("/api/video/resolutions", s.protect(s.handleResolutions))
	mux.Handle("/api/video/resolution", s.protect(s.handleSetResolution))

	/* Audio */
	mux.Handle("/ws/audio", s.protect(s.handleAudioWS))

	/* HID */
	mux.Handle("/ws/hid", s.protect(s.handleHIDWS))
	mux.Handle("/api/hid/reset", s.protect(s.handleHIDReset))
	mux.Handle("/api/hid/release", s.protect(s.handleHIDRelease))
	mux.Handle("/api/hid/jiggler", s.protect(s.handleJiggler))
	mux.Handle("/api/hid/type", s.protect(s.handleType))
	mux.Handle("/api/hid/shortcut", s.protect(s.handleShortcut))
	mux.Handle("/api/hid/mouse", s.protect(s.handleMouse))

	/* Anything else under api/ or ws/ is a JSON 404, not the UI */
	notFound := func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, errors.New("no such endpoint"))
	}
	mux.HandleFunc("/api/", notFound)
	mux.HandleFunc("/ws/", notFound)

	mux.Handle("/", ui)

	return s.wrap(mux)
}

// wrap adds the cross-cutting behaviour: trailing-slash redirect when
// mounted under a prefix, CORS, and cache headers for the API.
func (s *Server) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mounted with http.StripPrefix("/kvm", h), a request for "/kvm"
		// arrives with an empty path. The UI uses relative URLs, which only
		// resolve correctly under "/kvm/", so redirect there.
		if r.URL.Path == "" {
			target := path.Base(r.URL.RawPath)
			if orig := strings.SplitN(r.RequestURI, "?", 2)[0]; orig != "" {
				target = path.Base(orig)
			}
			target += "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusMovedPermanently)
			return
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		if origin := r.Header.Get("Origin"); origin != "" && s.auth.explicitlyAllowed(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			// The UI polls a few of these and a cached status would freeze
			// the on-screen indicators.
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// protect enforces authentication. Cookie-authenticated requests from a
// browser must also come from an acceptable origin; token-authenticated
// requests are deliberate integrations and may come from anywhere.
func (s *Server) protect(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, ok := s.auth.identify(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, errors.New("authentication required"))
			return
		}
		if method != authToken && r.Method != http.MethodGet && !s.auth.originAllowed(r) {
			writeError(w, http.StatusForbidden, errors.New("cross-origin request rejected"))
			return
		}
		h(w, withAuthMethod(r, method))
	})
}

// wsOriginOK applies the origin rule to websocket handshakes, which are GET
// requests and therefore not covered by the check in protect.
func (s *Server) wsOriginOK(r *http.Request) bool {
	return authMethod(r) == authToken || s.auth.originAllowed(r)
}
