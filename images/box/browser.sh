#!/bin/sh
# The browser role's desktop: Xvfb, dbus, openbox, a view-only VNC server and headed Chromium,
# each started once the one before it is ready, and stopped in reverse. If any of them dies the
# rest are stopped and the container exits.
set -u
export HOME=/browser DISPLAY=:1
display=/tmp/bee-display
procs=""

log() { echo "bee-browser: $*" >&2; }

# Zombies still answer kill -0 until this shell reaps them.
alive() { kill -0 "$1" 2>/dev/null && ! grep -qs '^State:[[:space:]]*Z' "/proc/$1/status"; }

stop() {
  trap '' TERM INT
  ticks=0
  for proc in $procs; do
    log "stopping ${proc%%:*}"
    kill -TERM "${proc#*:}" 2>/dev/null
    while alive "${proc#*:}" && [ "$ticks" -lt 50 ]; do
      sleep 0.1
      ticks=$((ticks + 1))
    done
  done
  for proc in $procs; do
    alive "${proc#*:}" && log "killing ${proc%%:*}" && kill -KILL "${proc#*:}"
  done
  exit "$1"
}
trap 'stop 0' TERM INT

started() { procs="$1:$2 $procs"; }

ready() {
  what=$1
  shift
  i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 100 ] || { log "$what did not start"; stop 1; }
    sleep 0.1
  done
}

mkdir -p /browser/profile && mkdir -p -m 0700 "$display" || exit 1
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 "$display/view.sock" "$display/openbox.ready"

Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
started Xvfb $!
ready Xvfb xdotool getdisplaygeometry

eval "$(dbus-launch --sh-syntax)" || stop 1
started dbus "$DBUS_SESSION_BUS_PID"

openbox --startup "touch $display/openbox.ready" &
started openbox $!
ready openbox test -f "$display/openbox.ready"

# -rfbportv6 -1: with only -rfbport 0, libvncserver still listens on [::]:5900.
x11vnc -display :1 -unixsock "$display/view.sock" -rfbport 0 -rfbportv6 -1 -viewonly -shared \
  -forever -nosel -nopw -cursor arrow &
started x11vnc $!
ready x11vnc test -S "$display/view.sock"

# DevTools binds to loopback only; boxd reaches it with `podman exec socat`.
chromium --disable-gpu --remote-debugging-port=9222 --user-data-dir=/browser/profile \
  --no-first-run --window-position=0,0 --window-size=1280,800 --hide-crash-restore-bubble \
  "$@" about:blank &
started chromium $!
log ready

while :; do
  for proc in $procs; do
    alive "${proc#*:}" || { log "${proc%%:*} exited"; stop 1; }
  done
  sleep 1 &
  wait $!
done
