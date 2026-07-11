#!/bin/bash
# Start bridge backend and optionally Chromium kiosk for Tablet Hardness Tester
# For production: copy project to /opt/kiosk and run this script

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
cd "$APP_ROOT"

# Start bridge backend (log to /var/log/kiosk_bridge.log)
nohup /usr/bin/python3 "$APP_ROOT/bridge.py" >> /var/log/kiosk_bridge.log 2>&1 &

# Give backend a moment to start
sleep 2

# Start Chromium in kiosk mode (if X is available)
if command -v chromium-browser >/dev/null 2>&1; then
  nohup chromium-browser --kiosk --disable-infobars --disable-pinch --incognito http://localhost:5000/ >> /var/log/kiosk_chrome.log 2>&1 &
elif command -v chromium >/dev/null 2>&1; then
  nohup chromium --kiosk --disable-infobars --disable-pinch --incognito http://localhost:5000/ >> /var/log/kiosk_chrome.log 2>&1 &
fi
