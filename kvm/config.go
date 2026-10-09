// Package kvm is the embeddable IP KVM server: it serves the HDMI capture
// card (MJPEG video + USB audio) to browsers and forwards their keyboard and
// mouse to the CH9329 HID bridge. Use it standalone through cmd/kvm-server,
// or mount Server.Handler() inside another Go program:
//
//	srv, err := kvm.New(kvm.Config{APITokens: []string{"secret"}})
//	mux.Handle("/kvm/", http.StripPrefix("/kvm", srv.Handler()))
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package kvm

import (
	"log"
	"time"
)

// Version of the server and the bundled UI.
const Version = "2.0.0"

// Config configures a Server. The zero value auto-detects all hardware and
// runs without authentication.
type Config struct {
	// Name is shown in the UI title bar and returned by api/info.
	Name string `json:"name"`

	// Device nodes; empty means auto detect.
	VideoDevice  string `json:"video_device"`
	AudioDevice  string `json:"audio_device"`
	SerialDevice string `json:"serial_device"`

	// BaudRate of the CH9329 serial link (default 115200).
	BaudRate int `json:"baud_rate"`
	// Capture mode; zero width/height means the largest the card offers,
	// FPS is a maximum (default 30).
	Width  int `json:"width"`
	Height int `json:"height"`
	FPS    int `json:"fps"`
	// JPEGQuality 5-100 re-encodes frames to save bandwidth, 0 = off.
	JPEGQuality int `json:"jpeg_quality"`
	// ScrollSensitivity is the wheel step sent to the CH9329 (1-126, default 2).
	ScrollSensitivity int `json:"scroll_sensitivity"`
	// NoHID starts without keyboard/mouse control.
	NoHID bool `json:"no_hid"`
	// Demo replaces all hardware with a synthetic remote desktop.
	Demo bool `json:"demo"`

	// Password enables the login screen. APITokens are accepted as
	// "Authorization: Bearer <token>" or ?token=<token> for integrations.
	// With neither set the server is open to anyone who can reach it.
	Password  string   `json:"password"`
	APITokens []string `json:"api_tokens"`
	// SessionSecret signs login cookies; random per start when empty, which
	// logs everybody out on restart.
	SessionSecret string `json:"session_secret"`
	// SessionTTL is how long a login lasts (default 12h).
	SessionTTL time.Duration `json:"-"`
	// AllowedOrigins may use the API, websockets and cookies cross-origin
	// (e.g. the dashboard that embeds the UI). "*" allows any origin.
	AllowedOrigins []string `json:"allowed_origins"`

	// DisableUI serves only the API (for headless integrations).
	DisableUI bool `json:"disable_ui"`
	// WebDir serves the UI from disk instead of the embedded copy.
	WebDir string `json:"web_dir"`

	Logger *log.Logger `json:"-"`
}

func (c *Config) applyDefaults() {
	if c.Name == "" {
		c.Name = "KVM Console"
	}
	if c.BaudRate == 0 {
		c.BaudRate = 115200
	}
	if c.FPS <= 0 {
		c.FPS = 30
	}
	if c.ScrollSensitivity == 0 {
		c.ScrollSensitivity = 2
	}
	if c.SessionTTL <= 0 {
		c.SessionTTL = 12 * time.Hour
	}
	if c.Logger == nil {
		c.Logger = log.Default()
	}
	if c.JPEGQuality < 0 {
		c.JPEGQuality = 0
	}
	if c.JPEGQuality > 100 {
		c.JPEGQuality = 100
	}
}
