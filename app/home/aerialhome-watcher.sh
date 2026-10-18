#!/bin/sh
# Aerial Home watcher: show Aerial Home wherever LG's home screen would appear.
#
#   aerialhome-watcher.sh [--boot]   start (stopping a running watcher first)
#   aerialhome-watcher.sh --stop     stop the running watcher
#   aerialhome-watcher.sh --allow    leave LG's home alone until Aerial Home is back
#
# Started at boot by /var/lib/webosbrew/init.d/50-aerialhome (with --boot), or by
# the app when "Replace LG's home screen" is switched on. Runs as its own session
# (setsid) so it can be stopped as a group. Exits when the app is uninstalled.
APP=io.aerialhome
APPDIR=/media/developer/apps/usr/palm/applications/$APP
# State lives in a directory only root can write, never in world-writable /tmp.
if [ -d /run ]; then STATE=/run/aerialhome; else STATE=/var/run/aerialhome; fi
PIDFILE=$STATE/watcher.pid
ALLOW=$STATE/allow-lg-home # present while the user opened LG's home on purpose
LEGACY_PIDFILE=/tmp/aerialhome-watcher.pid # used by versions before 1.5.0

state_dir() {
  if [ -L "$STATE" ] || { [ -e "$STATE" ] && [ "$(stat -c %u "$STATE")" != 0 ]; }; then rm -rf "$STATE"; fi
  mkdir -p -m 700 "$STATE"
}

# Stop the watcher recorded in a pid file, but only if that pid really is one.
stop_from() {
  [ -f "$1" ] || return 0
  pid=$(cat "$1" 2>/dev/null)
  case "$pid" in '' | *[!0-9]* | 0 | 1) return 0 ;; esac
  [ "$pid" = $$ ] && return 0
  if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q aerialhome-watcher; then
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  fi
}

stop_all() {
  stop_from "$PIDFILE"
  rm -f "$PIDFILE"
  if [ -f "$LEGACY_PIDFILE" ] && [ ! -L "$LEGACY_PIDFILE" ]; then
    stop_from "$LEGACY_PIDFILE"
  fi
  rm -f "$LEGACY_PIDFILE"
}

case "$1" in
  --stop)
    stop_all
    exit 0
    ;;
  --allow)
    state_dir
    touch "$ALLOW"
    exit 0
    ;;
esac

[ -d "$APPDIR" ] || exit 0
state_dir
stop_all
echo $$ >"$PIDFILE"
exec >>"$STATE/watcher.log" 2>&1

launch() {
  luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$APP\"}" </dev/null 2>/dev/null |
    grep -q '"returnValue":true'
}

if [ "$1" = "--boot" ]; then
  # The app manager accepts launches a little while after boot.
  i=0
  while [ $i -lt 30 ]; do
    launch && break
    i=$((i + 1))
    sleep 2
  done
fi

while [ -d "$APPDIR" ]; do
  window=0
  count=0
  luna-send -n 1000000 luna://com.webos.applicationManager/getForegroundAppInfo '{"subscribe":true}' </dev/null 2>/dev/null |
    while read -r line; do
      case "$line" in
        *'"appId":"com.webos.app.home"'*)
          [ -f "$ALLOW" ] && continue
          now=$(date +%s)
          if [ $((now - window)) -gt 30 ]; then
            window=$now
            count=0
          fi
          count=$((count + 1))
          # At most three redirects per half minute, so nothing can loop the TV.
          [ $count -le 3 ] && launch
          ;;
        *"\"appId\":\"$APP\""*)
          rm -f "$ALLOW"
          ;;
      esac
    done
  # The subscription ended (e.g. the app manager restarted); resubscribe.
  sleep 5
done
rm -f "$PIDFILE"
