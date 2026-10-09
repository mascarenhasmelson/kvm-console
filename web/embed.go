// Package web carries the browser UI so both binaries (and any program that
// imports the kvm package) ship as a single file with no www/ folder beside it.
//
// Part of KVM Console. Licensed under GPL-3.0-or-later.
// Derived from an upstream GPL-3.0 project; see NOTICE.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:static
var Static embed.FS

// FS returns the UI rooted at the static directory, ready for http.FS.
func FS() fs.FS {
	sub, err := fs.Sub(Static, "static")
	if err != nil {
		// fs.Sub only fails on an invalid path, and "static" is a constant.
		panic(err)
	}
	return sub
}
