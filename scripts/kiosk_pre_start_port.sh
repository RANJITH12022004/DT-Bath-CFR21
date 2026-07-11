#!/usr/bin/env bash
# Release FLASK_PORT so the bridge can bind after unclean shutdown.
set -uo pipefail
PORT="${FLASK_PORT:-5000}"

if command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.5
  fuser -k -KILL "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.3
fi

# Orphan bridge.py (e.g. manual start) can keep port 5000 while systemd restarts fail silently.
pkill -TERM -f '/opt/kiosk/bridge\.py' 2>/dev/null || true
pkill -TERM -f '/opt/kiosk/venv/bin/python.*bridge\.py' 2>/dev/null || true
sleep 0.5
pkill -KILL -f '/opt/kiosk/bridge\.py' 2>/dev/null || true
pkill -KILL -f '/opt/kiosk/venv/bin/python.*bridge\.py' 2>/dev/null || true
sleep 0.3

exit 0
