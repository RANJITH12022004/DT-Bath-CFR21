#!/usr/bin/env python3
"""
bridge.py - Kiosk entry point for RLE machines (Tap Density, Friability, etc.).
Sets APP_ROOT and runs Flask app. Registers the isolated RLE Desktop Client API
without modifying product app.py routes.
"""

import os
import pathlib

if "APP_ROOT" not in os.environ:
    _script_dir = pathlib.Path(__file__).resolve().parent
    if str(_script_dir).startswith("/opt/kiosk"):
        os.environ.setdefault("APP_ROOT", "/opt/kiosk")
    else:
        os.environ.setdefault("APP_ROOT", str(_script_dir))

# Optional product title for GET /api/desktop/v1/health (multi-product clients).
_name_file = pathlib.Path(os.environ["APP_ROOT"]) / "desktop_app_name"
if "DESKTOP_APP_NAME" not in os.environ and _name_file.is_file():
    try:
        _name = _name_file.read_text(encoding="utf-8").strip()
        if _name:
            os.environ["DESKTOP_APP_NAME"] = _name
    except OSError:
        pass

import app as kiosk_app
from app import app

try:
    from desktop_api import register as register_desktop_api

    register_desktop_api(app, kiosk_app)
except Exception as exc:
    app.logger.warning("Desktop API not loaded: %s", exc)

if __name__ == "__main__":
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_PORT", "5000"))
    app.run(host=host, port=port, debug=False, threaded=True)
