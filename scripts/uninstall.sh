#!/usr/bin/env bash
#
# uninstall.sh - remove the KVM Console service installed by install-pi.sh.
#   sudo ./scripts/uninstall.sh            # keeps /etc/kvm-console.env
#   sudo ./scripts/uninstall.sh --purge    # also deletes the password file

set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Please run as root: sudo $0" >&2; exit 1; fi

systemctl disable --now kvm-console 2>/dev/null || true
rm -f /etc/systemd/system/kvm-console.service
systemctl daemon-reload
rm -rf /opt/kvm-console
if [ "${1:-}" = "--purge" ]; then rm -f /etc/kvm-console.env; fi
echo "KVM Console removed."
