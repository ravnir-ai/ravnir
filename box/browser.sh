#!/bin/bash
# Starts Chromium on the box desktop. DevTools listens on the box's own
# loopback only; the server reaches it through `exec socat`, never a published port.
set -u
profile=/root/.config/ravnir-browser
mkdir -p "$profile"
# A lock left by a previous box start would make Chromium refuse the profile.
rm -f "$profile"/Singleton*
export DISPLAY=:1
exec ravnir-chromium \
  --user-data-dir="$profile" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --disable-dev-shm-usage \
  --window-position=0,0 \
  --window-size=1440,900 \
  --start-maximized \
  about:blank >>/var/log/ravnir/browser.log 2>&1
