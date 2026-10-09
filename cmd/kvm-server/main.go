// Command kvm-server is the IP KVM: run it on the machine (e.g. a Raspberry
// Pi) the capture card and HID bridge are plugged into, then open it from
// any browser on the network.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"kvmconsole/internal/tlsutil"
	"kvmconsole/kvm"
	"kvmconsole/kvm/detect"
)

var (
	flagConfig      = flag.String("config", "", "JSON config file; flags given explicitly override it")
	flagVideoDevice = flag.String("video", "", "Video capture device node, e.g. /dev/video0 (auto detected when empty)")
	flagAudioDevice = flag.String("audio", "", "ALSA capture PCM node, e.g. /dev/snd/pcmC3D0c (auto detected when empty)")
	flagSerialPort  = flag.String("tty", "", "CH9329 serial port, e.g. /dev/ttyUSB0 (auto detected when empty)")
	flagBaudRate    = flag.Int("baud", 115200, "CH9329 serial baud rate")
	flagListen      = flag.String("port", ":8080", "HTTP listening address")
	flagWidth       = flag.Int("width", 0, "Capture width, 0 to use the largest the device supports")
	flagHeight      = flag.Int("height", 0, "Capture height, 0 to use the largest the device supports")
	flagFPS         = flag.Int("fps", 30, "Maximum capture frame rate")
	flagJPEGQuality = flag.Int("jpeg-quality", 0, "Re-encode frames at this JPEG quality (5-100) to save bandwidth, 0 to pass frames through")
	flagScrollSens  = flag.Int("scroll-sensitivity", 2, "Mouse wheel step size sent to the CH9329 (1-126)")
	flagDevMode     = flag.Bool("dev", false, "Serve the web UI from web/static on disk instead of the embedded copy")
	flagNoHID       = flag.Bool("no-hid", false, "Start without the HID controller (video/audio only)")
	flagListDevices = flag.Bool("list-devices", false, "Print every detectable capture/serial device and exit")

	flagDemo           = flag.Bool("demo", false, "Run without hardware: a synthetic remote desktop driven by the HID events")
	flagName           = flag.String("name", "", "Display name shown in the UI (default \"KVM Console\")")
	flagPassword       = flag.String("password", "", "Password for the web UI (or set KVM_PASSWORD)")
	flagTokens         = flag.String("token", "", "Comma separated API tokens for integrations (or set KVM_TOKENS)")
	flagAllowedOrigins = flag.String("allowed-origins", "", "Comma separated origins allowed to call the API cross-origin, e.g. https://dash.example.com")
	flagBasePath       = flag.String("base-path", "", "Serve everything under this path prefix, e.g. /kvm")
	flagTLSCert        = flag.String("tls-cert", "", "TLS certificate file (enables HTTPS together with -tls-key)")
	flagTLSKey         = flag.String("tls-key", "", "TLS private key file")
	flagTLSSelfSigned  = flag.Bool("tls-self-signed", false, "Serve HTTPS with a generated self-signed certificate (cert.pem/key.pem)")
	flagSessionTTL     = flag.Duration("session-ttl", 12*time.Hour, "How long a UI login lasts")
)

// fileConfig is the JSON config file layout.
type fileConfig struct {
	kvm.Config
	Listen        string `json:"listen"`
	BasePath      string `json:"base_path"`
	TLSCert       string `json:"tls_cert"`
	TLSKey        string `json:"tls_key"`
	TLSSelfSigned bool   `json:"tls_self_signed"`
	SessionTTL    string `json:"session_ttl"`
}

func main() {
	flag.Parse()
	if *flagListDevices {
		detect.PrintReport(os.Stdout)
		return
	}
	log.SetFlags(log.Ldate | log.Ltime)

	fc, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg := fc.Config
	cfg.Logger = log.Default()

	log.Printf("%s %s starting up", nameOr(cfg.Name), kvm.Version)
	srv, err := kvm.New(cfg)
	if err != nil {
		log.Fatalf("%v", err)
	}
	devices := srv.Devices()
	log.Printf("Video  : %s [%s]", orNone(devices.VideoNode), devices.VideoSource)
	log.Printf("Audio  : %s [%s]", orNone(devices.AudioNode), devices.AudioSource)
	log.Printf("Serial : %s [%s]", orNone(devices.SerialNode), devices.SerialSource)
	if !srv.AuthRequired() {
		log.Println("*****************************************************************")
		log.Println("WARNING: no -password or -token set. Anyone who can reach this")
		log.Println("port can see the screen and control the keyboard and mouse.")
		log.Println("*****************************************************************")
	}

	handler := srv.Handler()
	if base := strings.TrimRight(fc.BasePath, "/"); base != "" {
		if !strings.HasPrefix(base, "/") {
			base = "/" + base
		}
		mux := http.NewServeMux()
		mux.Handle(base+"/", http.StripPrefix(base, handler))
		mux.Handle(base, http.StripPrefix(base, handler)) // redirects to base+"/"
		mux.Handle("/", http.RedirectHandler(base+"/", http.StatusFound))
		handler = mux
		log.Printf("Mounted under %s/", base)
	}

	server := &http.Server{
		Addr:              fc.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the MJPEG stream and the event stream never end
	}

	certFile, keyFile := fc.TLSCert, fc.TLSKey
	if fc.TLSSelfSigned && certFile == "" {
		certFile, keyFile = "cert.pem", "key.pem"
		created, err := tlsutil.EnsureSelfSigned(certFile, keyFile, nameOr(cfg.Name))
		if err != nil {
			log.Fatalf("failed to generate a self-signed certificate: %v", err)
		}
		if created {
			log.Println("Generated a self-signed certificate in cert.pem / key.pem")
		}
	}
	useTLS := certFile != "" && keyFile != ""

	go func() {
		scheme := "http"
		if useTLS {
			scheme = "https"
		}
		log.Printf("Web interface listening on %s://%s%s/", scheme, displayAddr(fc.Listen), strings.TrimRight(fc.BasePath, "/"))
		var serveErr error
		if useTLS {
			serveErr = server.ListenAndServeTLS(certFile, keyFile)
		} else {
			serveErr = server.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Fatalf("http server error: %v", serveErr)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Streams never finish on their own, so do not wait for them for long
	server.Shutdown(ctx)
	srv.Close()
	log.Println("Bye")
}

// loadConfig merges the JSON file, environment variables and flags, with
// explicitly set flags winning.
func loadConfig() (*fileConfig, error) {
	fc := &fileConfig{Listen: ":8080"}
	if *flagConfig != "" {
		data, err := os.ReadFile(*flagConfig)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, fc); err != nil {
			return nil, fmt.Errorf("%s: %w", *flagConfig, err)
		}
		if fc.SessionTTL != "" {
			ttl, err := time.ParseDuration(fc.SessionTTL)
			if err != nil {
				return nil, fmt.Errorf("session_ttl: %w", err)
			}
			fc.Config.SessionTTL = ttl
		}
	} else {
		// Without a config file the flag defaults apply
		fc.BaudRate = *flagBaudRate
		fc.FPS = *flagFPS
		fc.ScrollSensitivity = *flagScrollSens
		fc.Config.SessionTTL = *flagSessionTTL
	}

	if v := os.Getenv("KVM_PASSWORD"); v != "" {
		fc.Password = v
	}
	if v := os.Getenv("KVM_TOKENS"); v != "" {
		fc.APITokens = splitList(v)
	}

	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "video":
			fc.VideoDevice = *flagVideoDevice
		case "audio":
			fc.AudioDevice = *flagAudioDevice
		case "tty":
			fc.SerialDevice = *flagSerialPort
		case "baud":
			fc.BaudRate = *flagBaudRate
		case "port":
			fc.Listen = *flagListen
		case "width":
			fc.Width = *flagWidth
		case "height":
			fc.Height = *flagHeight
		case "fps":
			fc.FPS = *flagFPS
		case "jpeg-quality":
			fc.JPEGQuality = *flagJPEGQuality
		case "scroll-sensitivity":
			fc.ScrollSensitivity = *flagScrollSens
		case "dev":
			if *flagDevMode {
				fc.WebDir = "web/static"
			}
		case "no-hid":
			fc.NoHID = *flagNoHID
		case "demo":
			fc.Demo = *flagDemo
		case "name":
			fc.Name = *flagName
		case "password":
			fc.Password = *flagPassword
		case "token":
			fc.APITokens = splitList(*flagTokens)
		case "allowed-origins":
			fc.AllowedOrigins = splitList(*flagAllowedOrigins)
		case "base-path":
			fc.BasePath = *flagBasePath
		case "tls-cert":
			fc.TLSCert = *flagTLSCert
		case "tls-key":
			fc.TLSKey = *flagTLSKey
		case "tls-self-signed":
			fc.TLSSelfSigned = *flagTLSSelfSigned
		case "session-ttl":
			fc.Config.SessionTTL = *flagSessionTTL
		}
	})
	if fc.Listen == "" {
		fc.Listen = ":8080"
	}
	return fc, nil
}

func splitList(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func orNone(v string) string {
	if v == "" {
		return "(none)"
	}
	return v
}

func nameOr(name string) string {
	if name == "" {
		return "KVM Console"
	}
	return name
}

func displayAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "<this-machine>" + addr
	}
	return addr
}
