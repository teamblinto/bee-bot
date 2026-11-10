#!/bin/sh
# The browser role's computer: Xvfb, dbus and a view-only VNC server, then an Xfce desktop and
# headed Chromium, each started once the one before it is ready, and stopped in reverse. If Xvfb,
# dbus or the VNC server dies the rest are stopped and the container exits. The desktop's parts
# and Chromium are someone's to close, so they come back instead.
set -u
# The desktop's home sits beside Chromium's profile on the persistent volume, not around it.
export HOME=/browser/home DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/bee-runtime
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
kept=""

# Runs a command again a second after it exits, until the container stops. The loop's own
# TERM ends its current run first.
keep() {
  name=$1
  shift
  (
    child=
    trap 'kill -TERM $child 2>/dev/null; wait $child; exit 0' TERM
    while :; do
      "$@" &
      child=$!
      wait $child
      log "$name exited, restarting"
      sleep 1
    done
  ) &
  started "$name" $!
  kept="$kept $!"
}

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

mkdir -p /browser/profile "$HOME/Desktop" && mkdir -p -m 0700 "$display" "$XDG_RUNTIME_DIR" ||
  exit 1
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 "$display/view.sock"
# What the desktop opens, a terminal first, starts at home.
cd "$HOME" || exit 1

Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
started Xvfb $!
ready Xvfb xdotool getdisplaygeometry

eval "$(dbus-launch --sh-syntax)" || stop 1
started dbus "$DBUS_SESSION_BUS_PID"

# -rfbportv6 -1: with only -rfbport 0, libvncserver still listens on [::]:5900.
x11vnc -display :1 -unixsock "$display/view.sock" -rfbport 0 -rfbportv6 -1 -viewonly -shared \
  -forever -nosel -nopw -cursor arrow -nocursorshape &
started x11vnc $!
ready x11vnc test -S "$display/view.sock"

keep xfsettingsd xfsettingsd --replace --no-daemon
keep xfwm4 xfwm4 --replace
ready xfwm4 sh -c 'xprop -root _NET_SUPPORTING_WM_CHECK | grep -q "window id"'
keep xfce4-panel xfce4-panel
keep xfdesktop xfdesktop

# DevTools binds to loopback only; boxd reaches it with `podman exec socat`. The profile and the
# rest come from /etc/chromium.d/bee, which every Chromium on the desktop shares. A window, not
# the whole screen, so the desktop stays in sight.
keep chromium chromium --disable-gpu --remote-debugging-port=9222 --window-position=200,60 \
  --window-size=1000,640 "$@" about:blank
log ready

while :; do
  for proc in $procs; do
    case " $kept " in *" ${proc#*:} "*) continue ;; esac
    alive "${proc#*:}" || { log "${proc%%:*} exited"; stop 1; }
  done
  sleep 1 &
  wait $!
done
