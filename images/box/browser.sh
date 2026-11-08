#!/bin/sh
set -eu
export HOME=/browser
mkdir -p /browser/profile
# Headless Chromium ignores --remote-debugging-address and binds CDP to loopback only.
# socat exposes it on the box network, which boxd limits to the broker.
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
exec chromium --headless --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/browser/profile "$@" about:blank
