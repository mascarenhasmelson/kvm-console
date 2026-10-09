// Command kvm-usb serves the web UI over HTTPS for USB mode, where the
// browser itself drives the hardware (WebSerial for the CH9329, getUserMedia
// for the capture card). Browsers only allow those APIs in a secure context,
// hence HTTPS with a self-signed certificate by default.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"kvmconsole/internal/tlsutil"
	"kvmconsole/web"
)

func main() {
	dev := flag.Bool("dev", false, "Serve files from web/static on disk instead of the embedded copy")
	addr := flag.String("addr", ":8443", "HTTPS server address")
	certFile := flag.String("tls-cert", "cert.pem", "TLS certificate file (generated when missing)")
	keyFile := flag.String("tls-key", "key.pem", "TLS private key file (generated when missing)")
	flag.Parse()

	created, err := tlsutil.EnsureSelfSigned(*certFile, *keyFile, "KVM Console")
	if err != nil {
		log.Fatalf("failed to generate certificate: %v", err)
	}
	if created {
		log.Printf("Generated a self-signed certificate in %s / %s", *certFile, *keyFile)
	}

	var files http.FileSystem
	if *dev {
		log.Println("Development mode: serving web/static from disk")
		files = http.Dir("web/static")
	} else {
		files = http.FS(web.FS())
	}
	fileServer := http.FileServer(files)

	server := &http.Server{
		Addr: *addr,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache")
			fileServer.ServeHTTP(w, r)
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("KVM Console (USB mode) on https://localhost%s/ - open it in Chrome or Edge", *addr)
	log.Fatal(server.ListenAndServeTLS(*certFile, *keyFile))
}
