#!/usr/bin/env python3
"""
hardware_service.py — compatibility shim.

DT-CFR uses dt_hardware_service for the ESP32 bath protocol.
This module re-exports that API so legacy imports keep working.
"""

from dt_hardware_service import *  # noqa: F401,F403
from dt_hardware_service import init, start_sse_stream, send_command, cmd_status, get_live_state
