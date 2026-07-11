#!/usr/bin/env python3
"""
bridge_services.py - Compatibility layer for Raspberry Pi kiosk automation.
Wraps hardware_service and exposes the interface expected by bridge.py.
"""

import errno
import os

import hardware_service


def init(app, config):
    """Initialize hardware bridge. Delegates to hardware_service."""
    return hardware_service.init(app, config)


def send_command(cmd, timeout=None, max_retries=None):
    """Send command to ESP32. Delegates to hardware_service."""
    return hardware_service.send_command(cmd, timeout=timeout, max_retries=max_retries)


def start_sse_stream():
    """Start SSE stream for browser. Delegates to hardware_service."""
    return hardware_service.start_sse_stream()


def create_sse_stream_generator():
    """Alias for compatibility with dt sample pattern. Returns SSE Response."""
    return hardware_service.start_sse_stream()


def drain_queue(max_lines=10):
    """Drain response queue for testing/debugging."""
    return hardware_service.drain_queue(max_lines=max_lines)


def probe_and_choose_port(configured_port, candidates=None):
    """
    Return first existing serial device.
    If configured_port exists, return it.
    Raises FileNotFoundError if none found.
    """
    if configured_port and os.path.exists(configured_port):
        return configured_port
    if candidates is None:
        candidates = [
            "/dev/ttyAMA4",
            "/dev/ttyAMA3",
            "/dev/ttyUSB0",
            "/dev/ttyUSB1",
            "/dev/ttyAMA0",
            "/dev/serial0",
        ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    raise FileNotFoundError(errno.ENOENT, "Serial device not found", configured_port or "no-config")
