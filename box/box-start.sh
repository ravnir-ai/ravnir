#!/bin/bash
# Main process of a Ravnir box (under tini). Keeps the bot's desktop up and
# starts the bot's own services from /root/.ravnir/autostart.sh, if it has one.
set -u

mkdir -p /root/.ravnir /var/log/ravnir
export DISPLAY=:1

keep() {
  # Restart a desktop process if it dies.
  local name="$1"; shift
  while true; do
    "$@" >>"/var/log/ravnir/${name}.log" 2>&1
    sleep 1
  done
}

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
keep xvfb Xvfb :1 -screen 0 "${RAVNIR_SCREEN:-1440x900x24}" -nolisten tcp -noreset &
for _ in $(seq 1 100); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done
keep openbox openbox --sm-disable &

if [ -x /root/.ravnir/autostart.sh ]; then
  /root/.ravnir/autostart.sh >>/var/log/ravnir/autostart.log 2>&1 &
fi

exec sleep infinity
