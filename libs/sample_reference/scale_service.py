#!/usr/bin/env python3
"""
scale_service.py - Dedicated UART for external weighing scale (separate from ESP32).
Supports either newline-delimited ASCII lines or fixed-size frames (e.g. 8-byte).
Used by /api/scale/* routes.
"""

import errno
import os
import queue
import re
import threading
import time

import serial

_logger = None
_config = {}

scale_ser = None
ser_lock = threading.Lock()
line_q = queue.Queue(maxsize=500)
read_buffer = ""
read_bytes_buffer = bytearray()
_last_error = None
_last_raw_line = None

# Default: first signed decimal in line
_DEFAULT_NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")

_line_regex = None
_weight_regex = None


def init(app, config):
    global _logger, _config, _line_regex, _weight_regex
    _logger = app.logger
    _config = dict(config)

    lr = os.environ.get("SCALE_LINE_REGEX", "").strip()
    wr = os.environ.get("SCALE_WEIGHT_REGEX", "").strip()
    _line_regex = re.compile(lr) if lr else None
    _weight_regex = re.compile(wr) if wr else None

    rm = (str(_config.get("SCALE_READ_MODE") or os.environ.get("SCALE_READ_MODE") or "frame")).strip().lower()
    fs = int(_config.get("SCALE_FRAME_SIZE") or os.environ.get("SCALE_FRAME_SIZE") or 8)
    if rm not in ("frame", "line"):
        rm = "frame"
    try:
        _open_scale_serial()
        if scale_ser and getattr(scale_ser, "is_open", False):
            _logger.info("[SCALE] UART opened at startup (read_mode=%s, frame_size=%s)", rm, fs if rm == "frame" else "n/a")
    except Exception as e:
        _logger.warning("[SCALE] UART not opened at startup: %s", e)

    threading.Thread(target=scale_reader_loop, daemon=True).start()
    _logger.info("[SCALE] Reader thread started")


def _parity_from_env(val):
    v = (val or "N").upper().strip()
    if v == "E":
        return serial.PARITY_EVEN
    if v == "O":
        return serial.PARITY_ODD
    return serial.PARITY_NONE


def _bytesize_from_env(val):
    try:
        n = int(val or 8)
    except (TypeError, ValueError):
        n = 8
    return serial.SEVENBITS if n == 7 else serial.EIGHTBITS


def _stopbits_from_env(val):
    try:
        n = int(val or 1)
    except (TypeError, ValueError):
        n = 1
    return serial.STOPBITS_TWO if n == 2 else serial.STOPBITS_ONE


def _scale_port_configured():
    port = (_config.get("SCALE_PORT") or "").strip()
    return bool(port)


def _open_scale_serial():
    global scale_ser, _last_error
    if not _scale_port_configured():
        _last_error = "SCALE_PORT not set"
        return None

    port = _config["SCALE_PORT"].strip()
    baud = int(_config.get("SCALE_BAUD") or 9600)
    bytesize = _bytesize_from_env(_config.get("SCALE_BYTESIZE"))
    parity = _parity_from_env(_config.get("SCALE_PARITY"))
    stopbits = _stopbits_from_env(_config.get("SCALE_STOPBITS"))

    with ser_lock:
        if scale_ser and getattr(scale_ser, "is_open", False):
            return scale_ser
        try:
            if not os.path.exists(port):
                raise FileNotFoundError(errno.ENOENT, "Scale serial device not found", port)
            if scale_ser:
                try:
                    scale_ser.close()
                except Exception:
                    pass
            scale_ser = serial.Serial(
                port=port,
                baudrate=baud,
                timeout=0.3,
                write_timeout=2.0,
                bytesize=bytesize,
                parity=parity,
                stopbits=stopbits,
                xonxoff=False,
                rtscts=False,
                dsrdtr=False,
            )
            scale_ser.reset_input_buffer()
            scale_ser.reset_output_buffer()
            _last_error = None
            _logger.info(
                "[SCALE] Opened %s baud=%d bytesize=%d parity=%s stopbits=%d",
                port,
                baud,
                7 if bytesize == serial.SEVENBITS else 8,
                _config.get("SCALE_PARITY") or "N",
                2 if stopbits == serial.STOPBITS_TWO else 1,
            )
            return scale_ser
        except Exception as e:
            _last_error = str(e)
            _logger.error("[SCALE] Failed to open serial: %s", e)
            scale_ser = None
            raise


def drain_queue():
    """Drop all buffered lines (call before starting a fresh wait)."""
    n = 0
    while True:
        try:
            line_q.get_nowait()
            n += 1
        except queue.Empty:
            break
    if n and _logger:
        _logger.debug("[SCALE] Drained %d queued line(s)", n)


def parse_weight_line(line: str):
    """
    Return (weight_float_or_none, raw_line).
    Applies SCALE_UNIT_MULTIPLIER if set.
    """
    global _last_raw_line
    if not line or not str(line).strip():
        return None, line
    line = str(line).strip()
    _last_raw_line = line

    mult = 1.0
    try:
        m = _config.get("SCALE_UNIT_MULTIPLIER")
        if m is not None and str(m).strip() != "":
            mult = float(m)
    except (TypeError, ValueError):
        mult = 1.0

    val = None
    if _line_regex:
        m = _line_regex.match(line)
        if not m:
            return None, line
        # If named or numbered groups, prefer group 1
        try:
            g = m.group(1)
            val = float(g)
        except (IndexError, TypeError, ValueError):
            try:
                val = float(m.group(0))
            except (TypeError, ValueError):
                return None, line
    elif _weight_regex:
        m = _weight_regex.search(line)
        if not m:
            return None, line
        try:
            val = float(m.group(1))
        except (IndexError, TypeError, ValueError):
            return None, line
    else:
        m = _DEFAULT_NUM_RE.search(line)
        if not m:
            return None, line
        try:
            val = float(m.group(0))
        except ValueError:
            return None, line

    if val is None:
        return None, line
    return val * mult, line


def scale_reader_loop():
    global read_buffer, read_bytes_buffer, scale_ser, _last_error
    reopen_backoff = 1.0
    max_backoff = 30.0
    frame_size = int(_config.get("SCALE_FRAME_SIZE") or os.environ.get("SCALE_FRAME_SIZE") or 8)
    read_mode = (str(_config.get("SCALE_READ_MODE") or os.environ.get("SCALE_READ_MODE") or "frame")).strip().lower()
    if read_mode not in ("frame", "line"):
        read_mode = "frame"

    while True:
        try:
            if not _scale_port_configured():
                time.sleep(1.0)
                continue

            if not scale_ser or not getattr(scale_ser, "is_open", False):
                try:
                    _open_scale_serial()
                    reopen_backoff = 1.0
                except Exception as e:
                    _last_error = str(e)
                    time.sleep(reopen_backoff)
                    reopen_backoff = min(reopen_backoff * 2, max_backoff)
                    continue

            s = scale_ser
            with ser_lock:
                if not s or not getattr(s, "is_open", False):
                    time.sleep(0.1)
                    continue
                nw = getattr(s, "in_waiting", 0) or 0
                # For fixed-frame scales, readline() may never return. Prefer raw reads.
                to_read = min(nw, 1024) if nw > 0 else 64
                chunk = s.read(to_read)

            if not chunk:
                time.sleep(0.02)
                continue

            if read_mode == "line":
                try:
                    text = chunk.decode("ascii", errors="ignore")
                except Exception:
                    time.sleep(0.02)
                    continue

                read_buffer += text
                while "\n" in read_buffer or "\r" in read_buffer:
                    if "\n" in read_buffer:
                        line, read_buffer = read_buffer.split("\n", 1)
                    else:
                        line, read_buffer = read_buffer.split("\r", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        line_q.put_nowait(line)
                    except queue.Full:
                        try:
                            line_q.get_nowait()
                        except queue.Empty:
                            pass
                        try:
                            line_q.put_nowait(line)
                        except queue.Full:
                            pass

                if len(read_buffer) > 4096:
                    read_buffer = read_buffer[-2048:]
            else:
                # Fixed-size frames (default 8 bytes). Decode ASCII where possible.
                read_bytes_buffer.extend(chunk)
                if frame_size < 1:
                    frame_size = 8

                while len(read_bytes_buffer) >= frame_size:
                    frame = bytes(read_bytes_buffer[:frame_size])
                    del read_bytes_buffer[:frame_size]
                    try:
                        text = frame.decode("ascii", errors="ignore").strip()
                    except Exception:
                        text = ""

                    # Only enqueue frames that look numeric-ish (otherwise they just clog the queue).
                    if not _DEFAULT_NUM_RE.search(text or ""):
                        continue
                    try:
                        line_q.put_nowait(text)
                    except queue.Full:
                        try:
                            line_q.get_nowait()
                        except queue.Empty:
                            pass
                        try:
                            line_q.put_nowait(text)
                        except queue.Full:
                            pass

                if len(read_bytes_buffer) > 4096:
                    del read_bytes_buffer[:-2048]

            reopen_backoff = 1.0

        except OSError as e:
            _logger.error("[SCALE] reader OSError: %s", e)
            with ser_lock:
                if scale_ser:
                    try:
                        scale_ser.close()
                    except Exception:
                        pass
                scale_ser = None
            _last_error = str(e)
            time.sleep(reopen_backoff)
            reopen_backoff = min(reopen_backoff * 2, max_backoff)
        except Exception as e:
            _logger.error("[SCALE] reader error: %s", e, exc_info=True)
            time.sleep(1.0)


def get_status():
    """Dict for JSON response."""
    configured = _scale_port_configured()
    open_ok = bool(scale_ser and getattr(scale_ser, "is_open", False))
    frame_size = int(_config.get("SCALE_FRAME_SIZE") or os.environ.get("SCALE_FRAME_SIZE") or 8)
    read_mode = (str(_config.get("SCALE_READ_MODE") or os.environ.get("SCALE_READ_MODE") or "frame")).strip().lower()
    if read_mode not in ("frame", "line"):
        read_mode = "frame"
    return {
        "configured": configured,
        "open": open_ok,
        "port": (_config.get("SCALE_PORT") or "").strip() or None,
        "read_mode": read_mode,
        "frame_size": frame_size if read_mode == "frame" else None,
        "last_error": _last_error,
        "last_raw_line": _last_raw_line,
        "queue_size": line_q.qsize(),
    }


def read_weight_blocking(timeout_sec: float):
    """
    Drain stale lines, then wait up to timeout_sec for a line that parses to a weight.
    Returns dict ok/weight/raw/error.
    """
    global _last_error
    if not _scale_port_configured():
        return {"ok": False, "error": "Scale not configured (set SCALE_PORT)"}

    try:
        _open_scale_serial()
    except Exception as e:
        return {"ok": False, "error": str(e)}

    drain_queue()

    deadline = time.time() + max(0.1, float(timeout_sec))
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        try:
            line = line_q.get(timeout=min(0.25, remaining))
        except queue.Empty:
            continue
        w, raw = parse_weight_line(line)
        if w is not None:
            return {"ok": True, "weight": w, "raw": raw}
        # Unparseable line; keep waiting until timeout
    return {"ok": False, "error": "Timeout waiting for weight from scale"}
