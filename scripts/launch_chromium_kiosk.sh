#!/bin/bash
# Full-screen Chromium for the kiosk (called from labwc autostart or start_kiosk.sh).
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

# Wait until HTML, health, AND styles.css are actually servable.
kiosk_assets_ready() {
  curl -sf --connect-timeout 1 "${KIOSK_URL}" >/dev/null 2>&1 || return 1
  curl -sf --connect-timeout 1 "${KIOSK_URL}api/health" >/dev/null 2>&1 || return 1
  local css
  css="$(curl -sf --connect-timeout 2 "${KIOSK_URL}styles.css" 2>/dev/null || true)"
  [[ -n "$css" && ${#css} -gt 1000 ]]
}

wait_for_kiosk_assets() {
  local n=0
  until kiosk_assets_ready; do
    n=$((n + 1))
    if (( n % 15 == 0 )); then
      echo "launch_chromium_kiosk: still waiting for ${KIOSK_URL} (try ${n})" >&2
    fi
    sleep 1
  done
}

chrome_running() {
  pgrep -f -- "$CHROME_BIN.*--app=${KIOSK_URL%/}" >/dev/null 2>&1
}

# If API drops after power flaps, kill Chromium so the outer loop can reopen a healthy page.
watch_api_and_recycle_chrome() {
  local down=0
  while true; do
    if kiosk_assets_ready; then
      down=0
    else
      down=$((down + 1))
      if (( down >= 3 )) && chrome_running; then
        echo "launch_chromium_kiosk: API unreachable; recycling Chromium" >&2
        pkill -TERM -f -- "$CHROME_BIN.*--app=${KIOSK_URL%/}" >/dev/null 2>&1 || true
        sleep 1
        pkill -KILL -f -- "$CHROME_BIN.*--app=${KIOSK_URL%/}" >/dev/null 2>&1 || true
        down=0
      fi
    fi
    sleep 2
  done
}

# Avoid opening a stack of kiosk windows if the desktop autostart runs twice.
if chrome_running; then
  exit 0
fi

watch_api_and_recycle_chrome &
WATCH_PID=$!
trap 'kill "$WATCH_PID" 2>/dev/null || true' EXIT

# Keep reopening Chromium after API outages / chrome exits so the UI recovers after power cycles.
while true; do
  wait_for_kiosk_assets
  if chrome_running; then
    wait "$WATCH_PID" || true
    exit 0
  fi
  "$CHROME_BIN" \
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
    --password-store=basic \
    --ozone-platform="${CHROMIUM_OZONE_PLATFORM:-wayland}" \
    --window-size=1024,600 \
    --app="${KIOSK_URL%/}" || true
  sleep 1
done
