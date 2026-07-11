#!/usr/bin/env python3
"""
bridge_services.py - Wrapper over hardware_service for Tap Density kiosk.
"""

import errno
import os

import hardware_service


def init(app, config):
    return hardware_service.init(app, config)


def send_command(cmd, timeout=None, max_retries=None):
    return hardware_service.send_command(cmd, timeout=timeout, max_retries=max_retries)


def start_sse_stream():
    return hardware_service.start_sse_stream()


def probe_and_choose_port(configured_port, candidates=None):
    if configured_port and os.path.exists(configured_port):
        return configured_port
    if candidates is None:
        candidates = [
            "/dev/ttyAMA4", "/dev/ttyAMA3", "/dev/ttyUSB0", "/dev/ttyUSB1",
            "/dev/ttyAMA0", "/dev/serial0",
        ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    raise FileNotFoundError(errno.ENOENT, "Serial device not found", configured_port or "no-config")
