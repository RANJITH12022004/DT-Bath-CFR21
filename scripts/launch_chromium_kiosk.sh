#!/bin/bash
# Full-screen Chromium for the Friability Tester kiosk (called from ~/.xinitrc or start_kiosk.sh).
set -euo pipefail

KIOSK_URL="${KIOSK_URL:-http://127.0.0.1:5000/}"
KIOSK_URL="${KIOSK_URL%/}/"
CHROME_BIN=""
if command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="chromium"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="chromium-browser"
else
  echo "chromium not found" >&2
  exit 1
fi

for _ in $(seq 1 90); do
  if curl -sf --connect-timeout 1 "$KIOSK_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Avoid opening a stack of kiosk windows if the desktop autostart runs twice.
if pgrep -f -- "$CHROME_BIN.*--app=${KIOSK_URL%/}" >/dev/null 2>&1; then
  exit 0
fi

exec "$CHROME_BIN" \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --force-device-scale-factor=1 \
  --kiosk \
  --incognito \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --ozone-platform="${CHROMIUM_OZONE_PLATFORM:-wayland}" \
  --window-size=1024,600 \
  --app="${KIOSK_URL%/}"
