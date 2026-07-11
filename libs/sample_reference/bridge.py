#!/usr/bin/env python3
"""
bridge.py - Main entry point for Raspberry Pi kiosk automation.
Serves the Tablet Hardness Tester UI (app.html) and API.

Used by kiosk.service and start_kiosk.sh. Ensures APP_ROOT and other
env vars are set for production deployment at /opt/kiosk, then runs
the Flask app from app.py.
"""

import os
import pathlib

# Set APP_ROOT for production if not already set (kiosk.service runs from /opt/kiosk)
if "APP_ROOT" not in os.environ:
    _script_dir = pathlib.Path(__file__).resolve().parent
    # Use /opt/kiosk if we appear to be running from there, else use script directory
    if str(_script_dir).startswith("/opt/kiosk"):
        os.environ.setdefault("APP_ROOT", "/opt/kiosk")
    else:
        os.environ.setdefault("APP_ROOT", str(_script_dir))

# Import and run the Hardness app
from app import app

if __name__ == "__main__":
    # Run on 0.0.0.0 for kiosk (accessible from Chromium on same host)
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_PORT", "5000"))
    app.run(host=host, port=port, debug=False)
