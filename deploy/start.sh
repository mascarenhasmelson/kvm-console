#!/bin/bash
# Starts the IP KVM server from a source checkout. Device nodes are detected
# automatically; any extra flags are passed through, e.g.
#   ./deploy/start.sh -password secret
#   ./deploy/start.sh -demo            (no hardware needed)
#   ./deploy/start.sh -list-devices    (show what can be detected)
cd "$(dirname "$0")/.." || exit 1
echo "KVM Console - IP KVM mode"
echo "Open http://<this-machine>:8080 in a browser once it is running."
echo "-------------------------------------------"
exec go run ./cmd/kvm-server "$@"
