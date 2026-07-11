#!/bin/bash
# Start bridge backend and optionally Chromium kiosk for Tablet Hardness Tester
# For production: copy project to /opt/kiosk and run this script

# Default to Tablet Hardness Tester tree (root /opt/kiosk is missing data_service et al.)
APP_ROOT="${APP_ROOT:-/opt/kiosk}"
cd "$APP_ROOT"

PYTHON="${PYTHON:-/opt/kiosk/venv/bin/python3}"
LOG="${KIOSK_LOG:-$HOME/kiosk_bridge.log}"

# Start bridge backend
nohup env APP_ROOT="$APP_ROOT" PYTHONUNBUFFERED=1 "$PYTHON" "$APP_ROOT/bridge.py" >> "$LOG" 2>&1 &

# Give backend a moment to start
sleep 2

# Start Chromium in kiosk mode (if X is available)
if [ -x "$APP_ROOT/scripts/launch_chromium_kiosk.sh" ]; then
  chmod +x "$APP_ROOT/scripts/launch_chromium_kiosk.sh" 2>/dev/null || true
  nohup env KIOSK_URL="${KIOSK_URL:-http://127.0.0.1:5000/}" "$APP_ROOT/scripts/launch_chromium_kiosk.sh" >> /var/log/kiosk_chrome.log 2>&1 &
fi
