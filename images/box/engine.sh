#!/bin/sh
set -eu
# The tmux server is the box's main process; the config opens session "main" in /work.
exec tmux -D -f /etc/bee/tmux.conf
