#!/usr/bin/env python3
"""
biometric_service.py - R307 fingerprint sensor service for Tap Density.
Implements enrollment, identification, and template management over UART.
"""

import errno
import os
import threading
import time

try:
    import serial
except ImportError:
    serial = None

_logger = None
_config = {}
_port = None
_ser = None
_lock = threading.Lock()

_PACKET_START = b"\xEF\x01"
_DEFAULT_ADDRESS = 0xFFFFFFFF
_DEFAULT_PASSWORD = 0x00000000

_CMD_GEN_IMAGE = 0x01
_CMD_IMAGE_2_TZ = 0x02
_CMD_SEARCH = 0x04
_CMD_REG_MODEL = 0x05
_CMD_STORE = 0x06
_CMD_DELETE = 0x0C
_CMD_EMPTY = 0x0D
_CMD_TEMPLATE_COUNT = 0x1D
_CMD_VERIFY_PASSWORD = 0x13
_CMD_AURA_LED = 0x35

_CONFIRM_OK = 0x00
_CONFIRM_NO_FINGER = 0x02
_CONFIRM_IMAGE_FAIL = 0x03
_CONFIRM_IMAGE_MESSY = 0x06
_CONFIRM_FEATURE_FAIL = 0x07
_CONFIRM_NO_MATCH = 0x09
_CONFIRM_NOT_FOUND = 0x0A
_CONFIRM_ENROLL_MISMATCH = 0x0A

_cancel_requested = threading.Event()
_scan_active = threading.Event()


def request_cancel():
    """Signal any in-progress finger wait/capture to stop ASAP (UI Cancel)."""
    _cancel_requested.set()


def clear_cancel():
    _cancel_requested.clear()


def is_cancel_requested():
    return _cancel_requested.is_set()


def _idle_sensor_led():
    """Best-effort turn off R307 Aura LED after cancel/timeout."""
    # AuraLedControl: control=0x04 off, speed=0, color=0x01 (ignored when off), times=0
    try:
        _exec(bytes([_CMD_AURA_LED, 0x04, 0x00, 0x01, 0x00]), timeout_sec=1.0)
    except Exception:
        pass
    # Fallback wake/idle nudge for modules without Aura LED support
    try:
        verify_sensor()
    except Exception:
        pass


def cancel_and_idle():
    """Stop active scan and turn sensor LED off."""
    request_cancel()
    # Wait briefly for in-flight GenImg to finish and release the lock
    deadline = time.time() + 2.5
    while _scan_active.is_set() and time.time() < deadline:
        time.sleep(0.05)
    try:
        _idle_sensor_led()
    except Exception:
        pass
    return {"ok": True, "cancelled": True}



def _configured_port():
    return _config.get("BIOMETRIC_PORT", "/dev/ttyAMA5")


def sensor_available():
    """True when pyserial is installed and the UART device node exists."""
    if not serial:
        return False
    port = _configured_port()
    return bool(port and os.path.exists(port))


def _hardware_unavailable_response():
    port = _configured_port()
    return {
        "ok": False,
        "hardwarePresent": False,
        "port": port,
        "error": "Biometric sensor not connected ({} not found). Connect the R307 sensor and restart.".format(port),
    }


def init(app, config):
    global _logger, _config, _port
    _logger = app.logger
    _config = dict(config or {})
    _port = _configured_port()
    if not sensor_available():
        if _logger:
            _logger.warning("[BIOMETRIC] Sensor port not present at startup: %s", _port)
        return
    try:
        _open_serial()
        if _logger:
            _logger.info("[BIOMETRIC] R307 serial initialized")
    except Exception as exc:
        if _logger:
            _logger.warning("[BIOMETRIC] Startup serial open failed: %s", exc)


def _checksum(pkt_type, payload):
    total = pkt_type + len(payload) + 2
    for b in payload:
        total += b
    return total & 0xFFFF


def _build_packet(payload):
    pkt_type = 0x01
    length = len(payload) + 2
    chk = _checksum(pkt_type, payload)
    body = bytes([pkt_type]) + length.to_bytes(2, "big") + payload + chk.to_bytes(2, "big")
    return _PACKET_START + _DEFAULT_ADDRESS.to_bytes(4, "big") + body


def _read_exact(ser, n, timeout_sec):
    deadline = time.time() + timeout_sec
    out = bytearray()
    while len(out) < n and time.time() < deadline:
        chunk = ser.read(n - len(out))
        if chunk:
            out.extend(chunk)
        else:
            time.sleep(0.01)
    if len(out) != n:
        raise TimeoutError("Timeout while reading fingerprint packet")
    return bytes(out)


def _read_response(ser, timeout_sec=2.0):
    header = _read_exact(ser, 9, timeout_sec)
    if header[:2] != _PACKET_START:
        raise ValueError("Invalid fingerprint response header")
    pkt_type = header[6]
    length = int.from_bytes(header[7:9], "big")
    body = _read_exact(ser, length, timeout_sec)
    payload = body[:-2]
    recv_chk = int.from_bytes(body[-2:], "big")
    calc_chk = _checksum(pkt_type, payload)
    if recv_chk != calc_chk:
        raise ValueError("Invalid fingerprint response checksum")
    return pkt_type, payload


def _open_serial():
    global _ser, _port
    if not serial:
        raise FileNotFoundError(errno.ENOENT, "pyserial not installed", _port)
    port = _config.get("BIOMETRIC_PORT", "/dev/ttyAMA5")
    baud = int(_config.get("BIOMETRIC_BAUD", 57600))
    if not port or not os.path.exists(port):
        raise FileNotFoundError(errno.ENOENT, "Biometric UART device not found", port)
    # Caller owns _lock; do not re-acquire here to avoid deadlock.
    if _ser and getattr(_ser, "is_open", False):
        return _ser
    _ser = serial.Serial(
        port=port,
        baudrate=baud,
        timeout=1.0,
        write_timeout=1.0,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
    )
    _ser.reset_input_buffer()
    _ser.reset_output_buffer()
    _port = port
    return _ser


def _exec(cmd_payload, timeout_sec=2.0):
    if not sensor_available():
        return _hardware_unavailable_response()
    try:
        with _lock:
            ser = _open_serial()
            ser.reset_input_buffer()
            packet = _build_packet(cmd_payload)
            ser.write(packet)
            ser.flush()
            pkt_type, payload = _read_response(ser, timeout_sec=timeout_sec)
    except FileNotFoundError:
        return _hardware_unavailable_response()
    except OSError as exc:
        return {"ok": False, "hardwarePresent": sensor_available(), "error": str(exc), "code": None}
    if pkt_type != 0x07 or not payload:
        return {"ok": False, "error": "Invalid response packet", "code": None}
    code = payload[0]
    if code != _CONFIRM_OK:
        return {"ok": False, "error": _confirm_msg(code), "code": code}
    return {"ok": True, "code": code, "payload": payload}


def _confirm_msg(code):
    mapping = {
        _CONFIRM_NO_FINGER: "No finger detected",
        _CONFIRM_IMAGE_FAIL: "Image capture failed",
        _CONFIRM_IMAGE_MESSY: "Image too messy",
        _CONFIRM_FEATURE_FAIL: "Feature extraction failed",
        _CONFIRM_NO_MATCH: "Fingerprint mismatch",
        _CONFIRM_NOT_FOUND: "Fingerprint not found",
    }
    return mapping.get(code, "Fingerprint sensor error ({})".format(code))


def verify_sensor():
    pwd = int(_config.get("BIOMETRIC_PASSWORD", _DEFAULT_PASSWORD))
    payload = bytes([_CMD_VERIFY_PASSWORD]) + pwd.to_bytes(4, "big")
    return _exec(payload, timeout_sec=2.0)


def status():
    port = _port or _configured_port()
    if not sensor_available():
        return dict(_hardware_unavailable_response())
    verify = verify_sensor()
    if not verify.get("ok"):
        verify.setdefault("hardwarePresent", True)
        verify.setdefault("port", port)
        return verify
    count = get_template_count()
    return {
        "ok": True,
        "hardwarePresent": True,
        "port": port,
        "templates": count.get("count", 0) if count.get("ok") else None,
    }


def get_template_count():
    res = _exec(bytes([_CMD_TEMPLATE_COUNT]), timeout_sec=2.0)
    if not res.get("ok"):
        return res
    payload = res.get("payload", b"")
    if len(payload) < 3:
        return {"ok": False, "error": "Invalid template count response"}
    cnt = int.from_bytes(payload[1:3], "big")
    return {"ok": True, "count": cnt}


def _wait_for_finger(timeout_sec=10.0):
    end = time.time() + timeout_sec
    _scan_active.set()
    try:
        while time.time() < end:
            if _cancel_requested.is_set():
                return {"ok": False, "error": "cancelled", "cancelled": True, "code": None}
            got = _exec(bytes([_CMD_GEN_IMAGE]), timeout_sec=1.5)
            if _cancel_requested.is_set():
                return {"ok": False, "error": "cancelled", "cancelled": True, "code": None}
            if got.get("ok"):
                return {"ok": True}
            if got.get("code") in (_CONFIRM_NO_FINGER, _CONFIRM_IMAGE_MESSY):
                time.sleep(0.15)
                continue
            return got
        return {"ok": False, "error": "Timed out waiting for finger"}
    finally:
        _scan_active.clear()


def _capture_to_buffer(buffer_id, timeout_sec=10.0):
    wait = _wait_for_finger(timeout_sec=timeout_sec)
    if not wait.get("ok"):
        return wait
    if _cancel_requested.is_set():
        return {"ok": False, "error": "cancelled", "cancelled": True, "code": None}
    return _exec(bytes([_CMD_IMAGE_2_TZ, buffer_id]), timeout_sec=2.0)



def capture_enroll_finger(buffer_id, timeout_sec=10.0):
    """Capture one fingerprint image into enroll buffer 1 or 2."""
    buffer_id = int(buffer_id)
    if buffer_id not in (0x01, 0x02):
        return {"ok": False, "error": "buffer_id must be 1 or 2"}
    clear_cancel()
    verify = verify_sensor()
    if not verify.get("ok"):
        return verify
    try:
        return _capture_to_buffer(buffer_id, timeout_sec=timeout_sec)
    finally:
        if _cancel_requested.is_set():
            _idle_sensor_led()


def finalize_enroll(template_id):
    """Merge buffers 1+2 and store template after both captures succeeded."""
    template_id = int(template_id)
    if template_id <= 0 or template_id > 1000:
        return {"ok": False, "error": "templateId must be between 1 and 1000"}
    verify = verify_sensor()
    if not verify.get("ok"):
        return verify
    model = _exec(bytes([_CMD_REG_MODEL]), timeout_sec=2.0)
    if not model.get("ok"):
        if model.get("code") == _CONFIRM_ENROLL_MISMATCH:
            return {"ok": False, "error": "Fingerprints do not match. Use the same finger for both scans.", "code": model.get("code")}
        return model
    store_payload = bytes([_CMD_STORE, 0x01]) + template_id.to_bytes(2, "big")
    stored = _exec(store_payload, timeout_sec=2.0)
    if not stored.get("ok"):
        return stored
    return {"ok": True, "templateId": template_id}


def enroll(template_id, capture_timeout_sec=10.0):
    template_id = int(template_id)
    if template_id <= 0 or template_id > 1000:
        return {"ok": False, "error": "templateId must be between 1 and 1000"}
    clear_cancel()
    verify = verify_sensor()
    if not verify.get("ok"):
        return verify

    first = capture_enroll_finger(0x01, timeout_sec=capture_timeout_sec)
    if not first.get("ok"):
        return first
    if _cancel_requested.is_set():
        return {"ok": False, "error": "cancelled", "cancelled": True}
    time.sleep(1.0)
    second = capture_enroll_finger(0x02, timeout_sec=capture_timeout_sec)
    if not second.get("ok"):
        return second
    return finalize_enroll(template_id)


def identify(timeout_sec=10.0):
    clear_cancel()
    verify = verify_sensor()
    if not verify.get("ok"):
        return verify
    try:
        cap = _capture_to_buffer(0x01, timeout_sec=timeout_sec)
        if not cap.get("ok"):
            return cap
        if _cancel_requested.is_set():
            return {"ok": False, "error": "cancelled", "cancelled": True, "code": None}
        # Search in sensor library page 0, count 1000
        search_payload = bytes([_CMD_SEARCH, 0x01]) + (0).to_bytes(2, "big") + (1000).to_bytes(2, "big")
        found = _exec(search_payload, timeout_sec=2.0)
        if not found.get("ok"):
            if found.get("code") in (_CONFIRM_NO_MATCH, _CONFIRM_NOT_FOUND):
                return {"ok": False, "error": "Fingerprint not recognized", "code": found.get("code")}
            return found
        payload = found.get("payload", b"")
        if len(payload) < 5:
            return {"ok": False, "error": "Invalid identify response"}
        template_id = int.from_bytes(payload[1:3], "big")
        confidence = int.from_bytes(payload[3:5], "big")
        return {"ok": True, "templateId": template_id, "confidence": confidence}
    finally:
        _idle_sensor_led()


def delete_template(template_id):
    template_id = int(template_id)
    payload = bytes([_CMD_DELETE]) + template_id.to_bytes(2, "big") + (1).to_bytes(2, "big")
    return _exec(payload, timeout_sec=2.0)


def clear_templates():
    """Delete all fingerprint templates on the sensor (factory reset)."""
    request_cancel()
    deadline = time.time() + 3.0
    while _scan_active.is_set() and time.time() < deadline:
        time.sleep(0.05)
    clear_cancel()
    emptied = _exec(bytes([_CMD_EMPTY]), timeout_sec=5.0)
    _idle_sensor_led()
    if not emptied.get("ok"):
        return emptied
    count = get_template_count()
    remaining = count.get("count") if count.get("ok") else None
    return {
        "ok": True,
        "cleared": True,
        "templatesRemaining": remaining if remaining is not None else 0,
    }
