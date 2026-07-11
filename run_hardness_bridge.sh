#!/usr/bin/env bash
# Launcher used by kiosk-bridge.service to start the Flask backend.
# Mirrors the manual flow in /opt/kiosk/start_kiosk.sh (backend only; no Chromium).

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
PYTHON="${PYTHON:-/opt/kiosk/venv/bin/python3}"

cd "$APP_ROOT"

exec env APP_ROOT="$APP_ROOT" PYTHONUNBUFFERED=1 \
    "$PYTHON" "$APP_ROOT/bridge.py"
