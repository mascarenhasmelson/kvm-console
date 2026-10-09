#!/usr/bin/env bash
#
# install-pi.sh - install KVM Console as a service on a Raspberry Pi or any
# Debian/Ubuntu based Linux machine.
#
# Run from an extracted source package (or a prebuilt linux-amd64 package):
#
#   sudo ./scripts/install-pi.sh                 # asks for a password
#   sudo KVM_PASSWORD='secret' ./scripts/install-pi.sh
#   sudo KVM_PORT=9000 ./scripts/install-pi.sh
#
# What it does:
#   1. installs v4l-utils, alsa-utils and build tools with apt
#   2. installs Go 1.22+ into /usr/local/go if the system Go is missing/older
#   3. builds kvm-server on this machine (needed for real video capture)
#   4. copies it to /opt/kvm-console and writes /etc/kvm-console.env
#   5. installs and starts the kvm-console systemd service
#
# Safe to run again: it upgrades the binary and keeps the existing password.

set -euo pipefail

GO_VERSION="1.22.12"
PREFIX="/opt/kvm-console"
ENV_FILE="/etc/kvm-console.env"
UNIT="/etc/systemd/system/kvm-console.service"
PORT="${KVM_PORT:-8080}"
RUN_USER="${KVM_USER:-${SUDO_USER:-pi}}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run as root: sudo $0" >&2
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
# Works both from <src>/scripts/ and from the root of a binary package
if [ -f "$HERE/../go.mod" ]; then SRC="$(cd "$HERE/.." && pwd)"; else SRC="$HERE"; fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
    echo "User '$RUN_USER' does not exist. Set KVM_USER=<user>." >&2
    exit 1
fi

go_ok() {
    command -v go >/dev/null 2>&1 || return 1
    local have
    have="$(go env GOVERSION | sed 's/^go//')"
    [ "$(printf '%s\n1.22\n' "$have" | sort -V | head -n1)" = "1.22" ]
}

echo "==> Installing system packages"
apt-get update -qq
apt-get install -y -qq v4l-utils alsa-utils ca-certificates curl tar gcc libc6-dev >/dev/null

# --- binary: prebuilt (linux-amd64 package) or build from source -----------
if [ -x "$SRC/kvm-server" ] && [ ! -f "$SRC/go.mod" ]; then
    echo "==> Using the prebuilt kvm-server"
    BIN="$SRC/kvm-server"
else
    export PATH="/usr/local/go/bin:$PATH"
    if ! go_ok; then
        case "$(uname -m)" in
            aarch64|arm64) goarch=arm64 ;;
            armv7l|armv6l) goarch=armv6l ;;
            x86_64)        goarch=amd64 ;;
            *) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;;
        esac
        echo "==> Installing Go $GO_VERSION ($goarch) into /usr/local/go"
        curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tgz
        rm -rf /usr/local/go
        tar -C /usr/local -xzf /tmp/go.tgz
        rm -f /tmp/go.tgz
    fi
    echo "==> Building kvm-server with $(go version | awk '{print $3}') (this takes a few minutes on a Pi)"
    cd "$SRC"
    export GOCACHE=/tmp/kvm-go-cache GOPATH=/tmp/kvm-gopath
    CGO_ENABLED=1 go build -trimpath -ldflags "-s -w" -o /tmp/kvm-server ./cmd/kvm-server
    BIN=/tmp/kvm-server
fi

echo "==> Installing to $PREFIX"
systemctl stop kvm-console 2>/dev/null || true
mkdir -p "$PREFIX"
install -m 0755 "$BIN" "$PREFIX/kvm-server"

# --- secrets ------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
    password="${KVM_PASSWORD:-}"
    if [ -z "$password" ] && [ -t 0 ]; then
        read -r -s -p "Choose a web UI password: " password; echo
    fi
    if [ -z "$password" ]; then
        password="$(head -c 12 /dev/urandom | base64 | tr -d '/+=')"
        echo "    Generated password: $password"
    fi
    token="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
    umask 077
    printf 'KVM_PASSWORD=%s\nKVM_TOKENS=%s\n' "$password" "$token" > "$ENV_FILE"
    echo "    Wrote $ENV_FILE (password + API token, readable by root only)"
else
    echo "    Keeping existing $ENV_FILE"
fi

# --- permissions + service ----------------------------------------------------
usermod -aG video,audio,dialout "$RUN_USER"

cat > "$UNIT" <<EOF
[Unit]
Description=KVM Console IP KVM
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
SupplementaryGroups=video audio dialout plugdev
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$PREFIX
ExecStartPre=/bin/sleep 5
ExecStart=$PREFIX/kvm-server -port :$PORT
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now kvm-console

sleep 7
echo
echo "==> Detected hardware"
sudo -u "$RUN_USER" "$PREFIX/kvm-server" -list-devices || true
echo
if systemctl is-active --quiet kvm-console; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "KVM Console is running:  http://${ip:-<this-machine>}:$PORT"
    echo "Password and API token:  sudo cat $ENV_FILE"
    echo "Logs:                    journalctl -u kvm-console -f"
else
    echo "The service did not start. Check: journalctl -u kvm-console -n 50" >&2
    exit 1
fi
