#!/bin/sh
set -eu
export HOME=/browser
mkdir -p /browser/profile
# Headless Chromium binds DevTools to loopback only; boxd reaches it with `podman exec socat`.
exec chromium --headless --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/browser/profile "$@" about:blank
