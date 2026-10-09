#!/usr/bin/env bash
#
# package.sh - build every KVM Console release package into dist/
#
#   ./scripts/package.sh            # version from VERSION file
#   VERSION=2.1.0 ./scripts/package.sh
#
# Produces:
#   kvm-console-<v>-linux-amd64.tar.gz    full IP KVM server (real capture) + USB viewer
#   kvm-console-<v>-windows-amd64.zip     USB viewer + server in demo mode
#   kvm-console-<v>-macos-arm64.zip       USB viewer
#   kvm-console-<v>-macos-amd64.zip       USB viewer
#   kvm-console-<v>-source.tar.gz         source + installer, for Raspberry Pi / ARM
#   SHA256SUMS
#
# Real video capture needs cgo (the V4L2 library), so the full server can only
# be built for the machine running this script. Raspberry Pi users install
# from the source package with scripts/install-pi.sh, which builds on the Pi.
#
# Requirements: go >= 1.22, gcc (for the linux-amd64 build), zip, tar.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="${VERSION:-$(tr -d ' \r\n' < VERSION 2>/dev/null || echo dev)}"
DIST="$ROOT/dist"
WORK="$DIST/.work"
LDFLAGS="-s -w"

echo "==> KVM Console $VERSION"
rm -rf "$DIST"
mkdir -p "$WORK"

copy_docs() {
    local dest="$1"
    cp README.md LICENSE NOTICE VERSION "$dest/"
    mkdir -p "$dest/docs" "$dest/examples" "$dest/deploy"
    cp docs/*.md "$dest/docs/"
    cp -r examples/. "$dest/examples/"
    cp deploy/kvm-console.service "$dest/deploy/"
}

# build <goos> <goarch> <cgo> <outdir> <ext>
build() {
    local goos="$1" goarch="$2" cgo="$3" out="$4" ext="$5"
    # The serial library needs cgo on macOS, so a cross-built macOS package
    # carries the USB viewer only (a Mac is never the KVM host anyway).
    if [ "$goos" != darwin ]; then
        echo "    kvm-server ($goos/$goarch, cgo=$cgo)"
        CGO_ENABLED="$cgo" GOOS="$goos" GOARCH="$goarch" \
            go build -trimpath -ldflags "$LDFLAGS" -o "$out/kvm-server$ext" ./cmd/kvm-server
    fi
    echo "    kvm-usb    ($goos/$goarch)"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -ldflags "$LDFLAGS" -o "$out/kvm-usb$ext" ./cmd/kvm-usb
}

echo "==> Checks"
go vet ./...
go test ./... >/dev/null
echo "    vet + tests OK"

# --- linux-amd64: full server with real capture --------------------------
NAME="kvm-console-$VERSION-linux-amd64"
echo "==> $NAME"
mkdir -p "$WORK/$NAME"
build linux amd64 1 "$WORK/$NAME" ""
copy_docs "$WORK/$NAME"
cp scripts/install-pi.sh scripts/uninstall.sh "$WORK/$NAME/"
chmod +x "$WORK/$NAME/"*.sh "$WORK/$NAME/kvm-server" "$WORK/$NAME/kvm-usb"
tar -C "$WORK" -czf "$DIST/$NAME.tar.gz" "$NAME"

# --- desktop OSes: USB viewer + demo server ---------------------------------
for target in windows/amd64/.exe darwin/arm64/ darwin/amd64/; do
    IFS=/ read -r goos goarch ext <<<"$target"
    label="$goos"; [ "$goos" = darwin ] && label=macos
    NAME="kvm-console-$VERSION-$label-$goarch"
    echo "==> $NAME"
    mkdir -p "$WORK/$NAME"
    build "$goos" "$goarch" 0 "$WORK/$NAME" "$ext"
    copy_docs "$WORK/$NAME"
    (cd "$WORK" && zip -qr "$DIST/$NAME.zip" "$NAME")
done

# --- source package (Raspberry Pi / ARM / any Linux) ------------------------
NAME="kvm-console-$VERSION-source"
echo "==> $NAME"
mkdir -p "$WORK/$NAME"
tar --exclude=./dist --exclude=./.git --exclude='*.exe' --exclude=./cert.pem --exclude=./key.pem \
    -cf - . | tar -C "$WORK/$NAME" -xf -
chmod +x "$WORK/$NAME/scripts/"*.sh
tar -C "$WORK" -czf "$DIST/$NAME.tar.gz" "$NAME"

rm -rf "$WORK"
(cd "$DIST" && sha256sum ./* > SHA256SUMS)

echo "==> Done"
ls -lh "$DIST"
