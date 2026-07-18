#!/usr/bin/env python3
"""
hardware_service.py - Serial communication to MCU for Friability Tester.
"""

import errno
import fcntl
import json
import os
import queue
import re
import threading
import time
from typing import Any, Dict, Optional
from flask import Response

try:
    import serial
except ImportError:
    serial = None

_logger = None
_config = {}
_esp_port = None
ser_lock = threading.Lock()
esp_ser = None
line_q = queue.Queue(maxsize=2000)
sse_clients = []
esp_read_buffer = ""
COMMAND_TIMEOUT = 2.0
TEST_COMMAND_TIMEOUT = 30.0
MAX_RETRIES = 3
_uart_log_lock = threading.Lock()
_live_state_lock = threading.Lock()
_uart_log_path = ""
_boot_marker_path = ""
_uart_owner_lock_path = "/tmp/friability_uart_owner.lock"
_uart_owner_lock_fd = None
_hardware_init_done = False
_hardware_owner_active = False
DEFAULT_UART_LOG = "/opt/kiosk/uart_communications.log"
_live_state = {
    "running": False,
    "rotationCount": 0,
    "rpm": None,
    "targetRpm": None,
    "lastLine": None,
    "updatedAt": None,
}


def normalize_line(line: str) -> str:
    s = str(line or "").strip()
    if s.endswith("*"):
        s = s[:-1].strip()
    return s


_VAL_PROGRESS_RE = re.compile(r"^(\d+),(--|\d+(?:\.\d+)?)$")


def parse_friability_progress_line(line: str) -> Dict[str, Any]:
    """Parse start-mode integers or val-mode count,rpm lines (e.g. 5,24.56 or 10,--)."""
    norm = normalize_line(line)
    if not norm:
        return {}
    m = _VAL_PROGRESS_RE.match(norm)
    if m:
        out: Dict[str, Any] = {"rotationCount": int(m.group(1))}
        rpm_part = m.group(2)
        if rpm_part == "--":
            out["rpm"] = None
            out["rpmPending"] = True
        else:
            try:
                out["rpm"] = float(rpm_part)
            except (TypeError, ValueError):
                pass
        return out
    if norm.isdigit():
        return {"rotationCount": int(norm)}
    rpm = extract_rpm(line)
    if rpm is not None:
        return {"rpm": rpm}
    rot = extract_rotation_count(line)
    if rot is not None:
        return {"rotationCount": rot}
    return {}


def is_stream_progress_line(line: str) -> bool:
    """Lines that are streamed during a run/dispense, not command acknowledgements."""
    norm = normalize_line(line)
    if not norm:
        return True
    if norm.isdigit():
        return True
    if _VAL_PROGRESS_RE.match(norm):
        return True
    if extract_rpm(line) is not None and extract_rotation_count(line) is None:
        return True
    return False


def classify_line(line: str) -> str:
    s = normalize_line(line).lower()
    if not s:
        return "empty"
    if s == "ok":
        return "ok"
    if s in ("completed", "complete", "complete.", "done"):
        return "completed"
    if s == "stopped":
        return "stopped"
    if s == "adapt,error":
        return "adapter_error"
    if s == "error" or s.startswith("error:"):
        return "error"
    if _VAL_PROGRESS_RE.match(normalize_line(line)):
        return "progress"
    if extract_rpm(line) is not None and extract_rotation_count(line) is None:
        return "rpm"
    if s.isdigit():
        return "progress"
    if extract_rotation_count(line) is not None:
        return "progress"
    return "info"


def extract_rpm(line: str) -> Optional[float]:
    """Parse live RPM from val lines (5,24.56), rpm,25 / rpm:25 / v,rpm,25."""
    norm = normalize_line(line)
    if not norm:
        return None
    m = _VAL_PROGRESS_RE.match(norm)
    if m:
        rpm_part = m.group(2)
        if rpm_part == "--":
            return None
        try:
            return float(rpm_part)
        except (TypeError, ValueError):
            return None
    norm_lower = norm.lower()
    m = re.match(r"^(?:v,)?rpm[,:\s]+(\d+(?:\.\d+)?)$", norm_lower)
    if m:
        try:
            return float(m.group(1))
        except (TypeError, ValueError):
            return None
    return None


def extract_rotation_count(line: str) -> Optional[int]:
    """Parse rotation index from ESP line (1, 2, 3 / 5,24.56 / rot,5 / count:5)."""
    norm = normalize_line(line)
    if not norm:
        return None
    m = _VAL_PROGRESS_RE.match(norm)
    if m:
        return int(m.group(1))
    if norm.isdigit():
        return int(norm)
    m = re.match(r"^(?:rot|count|rotation)[,:\s]+(\d+)$", norm, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r"(?:rot|count|rotation)[,:\s]+(\d+)", norm, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return None


def _ingest_uart_line(line: str, *, log_tag: str = "RX_STREAM") -> Dict[str, Any]:
    """Parse one RX line, update live state, log, queue, and SSE clients."""
    payload = build_line_payload(line)
    apply_stream_payload(payload)
    _append_uart_log(log_tag, line)
    try:
        line_q.put_nowait(line)
    except queue.Full:
        pass
    for q in list(sse_clients):
        try:
            q.put_nowait(payload)
        except Exception:
            if q in sse_clients:
                sse_clients.remove(q)
    return payload


def _pop_uart_line_from_buffer(buf: str):
    """Split one complete line using ESP line endings: newline and/or trailing *."""
    if not buf:
        return None, buf
    nl = buf.find("\n")
    star = buf.find("*")
    cuts = [i for i in (nl, star) if i >= 0]
    if not cuts:
        return None, buf
    cut = min(cuts)
    line = buf[:cut].strip()
    rest = buf[cut + 1 :]
    if rest.startswith("\r"):
        rest = rest[1:]
    return (line if line else None), rest


def _extract_uart_lines_from_buffer(buf: str):
    """Return (lines, remaining_buffer)."""
    lines = []
    while True:
        line, buf = _pop_uart_line_from_buffer(buf)
        if line is None:
            break
        lines.append(line)
    return lines, buf


def build_line_payload(line: str) -> Dict[str, Any]:
    kind = classify_line(line)
    norm = normalize_line(line)
    parsed = parse_friability_progress_line(line)
    rotation = parsed.get("rotationCount")
    rpm = parsed.get("rpm") if "rpm" in parsed else extract_rpm(line)
    payload: Dict[str, Any] = {
        "line": line,
        "normalized": norm,
        "kind": kind,
    }
    if rotation is not None:
        payload["rotationCount"] = rotation
    if "rpm" in parsed:
        payload["rpm"] = parsed.get("rpm")
        if parsed.get("rpmPending"):
            payload["rpmPending"] = True
    elif rpm is not None:
        payload["rpm"] = rpm
    return payload


def reset_live_state(target_rpm: Optional[int] = None):
    with _live_state_lock:
        _live_state.update({
            "running": True,
            "rotationCount": 0,
            "rpm": None,
            "targetRpm": target_rpm,
            "lastLine": None,
            "updatedAt": time.time(),
        })


def stop_live_state():
    with _live_state_lock:
        _live_state["running"] = False
        _live_state["updatedAt"] = time.time()


def pause_live_state():
    with _live_state_lock:
        _live_state["running"] = False
        _live_state["updatedAt"] = time.time()


def resume_live_state():
    with _live_state_lock:
        _live_state["running"] = True
        _live_state["updatedAt"] = time.time()


def apply_stream_payload(payload: Dict[str, Any]):
    """Track latest rotation/RPM from ESP stream for API + UI polling."""
    if not payload:
        return
    with _live_state_lock:
        _live_state["lastLine"] = payload.get("line")
        _live_state["updatedAt"] = time.time()
        rot = payload.get("rotationCount")
        if rot is not None:
            try:
                _live_state["rotationCount"] = int(rot)
            except (TypeError, ValueError):
                pass
        if payload.get("rpmPending"):
            _live_state["rpm"] = None
        else:
            rpm = payload.get("rpm")
            if rpm is not None:
                try:
                    _live_state["rpm"] = float(rpm)
                except (TypeError, ValueError):
                    pass


def get_live_state() -> Dict[str, Any]:
    with _live_state_lock:
        return dict(_live_state)


def _get_boot_id() -> str:
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            for row in f:
                if row.startswith("btime "):
                    return row.split()[1].strip()
    except Exception:
        pass
    return ""


def _ensure_log_reset_on_power_on():
    """Clear ESP↔Pi log once per power-on (Linux boot), not on every service restart."""
    global _boot_marker_path
    boot_id = _get_boot_id() or f"unknown-{int(time.time())}"
    marker = _boot_marker_path or os.path.join(
        os.path.dirname(_uart_log_path or DEFAULT_UART_LOG), ".esp_pi_log_boot_id"
    )
    prev = ""
    try:
        if os.path.exists(marker):
            with open(marker, "r", encoding="utf-8") as f:
                prev = f.read().strip()
    except Exception:
        prev = ""
    if prev != boot_id:
        reset_uart_log(reason="power_on")
        try:
            os.makedirs(os.path.dirname(marker), exist_ok=True)
            with open(marker, "w", encoding="utf-8") as f:
                f.write(boot_id)
        except Exception:
            pass


def _acquire_uart_owner_lock() -> bool:
    """Allow only one process to own UART init/reset for this boot.

    Root cause fixed here: `hardware_service.init()` runs at import time from `app.py`.
    If another Python process imports the app or manually launches `bridge.py`, it used
    to re-run the "power_on" log reset and reset UART buffers even without a real power cut.
    """
    global _uart_owner_lock_fd
    if _uart_owner_lock_fd is not None:
        return True
    lock_path = _config.get("UART_OWNER_LOCK_PATH", _uart_owner_lock_path) or _uart_owner_lock_path
    try:
        os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    except Exception:
        pass
    fd = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            fd.close()
        except Exception:
            pass
        return False
    try:
        fd.seek(0)
        fd.truncate()
        fd.write(str(os.getpid()))
        fd.flush()
    except Exception:
        pass
    _uart_owner_lock_fd = fd
    return True


def init(app, config):
    global _logger, _config, _esp_port, line_q, sse_clients, _uart_log_path, _boot_marker_path
    global _hardware_init_done, _hardware_owner_active
    _logger = app.logger
    _config = dict(config)
    _esp_port = _config.get("ESP_PORT", "/dev/serial0")
    _uart_log_path = _config.get("UART_LOG_PATH", DEFAULT_UART_LOG)
    _boot_marker_path = _config.get(
        "UART_LOG_BOOT_MARKER",
        os.path.join(os.path.dirname(_uart_log_path), ".esp_pi_log_boot_id"),
    )
    if _hardware_init_done:
        return
    _hardware_init_done = True
    _hardware_owner_active = _acquire_uart_owner_lock()
    if not _hardware_owner_active:
        if _logger:
            _logger.warning(
                "[HARDWARE] Skipping UART init in PID %s; another process already owns the UART",
                os.getpid(),
            )
        return
    _ensure_log_reset_on_power_on()
    line_q = queue.Queue(maxsize=2000)
    sse_clients = []
    try:
        _open_esp_serial()
        if _logger:
            _logger.info("[HARDWARE] MCU serial initialized")
    except Exception as e:
        if _logger:
            _logger.error("[HARDWARE] Failed to open serial at startup: %s", e)
    threading.Thread(target=_reader_loop, daemon=True).start()
    threading.Thread(target=_esp_post_boot_warmup, daemon=True).start()


def _esp_post_boot_warmup():
    """Let ESP finish boot and drain stale UART lines before the first user command."""
    time.sleep(2.5)
    try:
        drain_queue(max_lines=500)
        with ser_lock:
            if esp_ser and getattr(esp_ser, "is_open", False):
                esp_ser.reset_input_buffer()
        if _logger:
            _logger.info("[HARDWARE] ESP UART warmup complete")
    except Exception as e:
        if _logger:
            _logger.debug("[HARDWARE] ESP warmup: %s", e)


def _open_esp_serial():
    global esp_ser, _esp_port
    port = _config.get("ESP_PORT", "/dev/serial0")
    baud = int(_config.get("ESP_BAUD", 9600))
    if not serial:
        raise FileNotFoundError(errno.ENOENT, "pyserial not installed", port)
    with ser_lock:
        if esp_ser and getattr(esp_ser, "is_open", False):
            return esp_ser
        # On Windows, COM ports are not filesystem paths, so os.path.exists("COM3") is False.
        is_windows_com_port = (
            os.name == "nt"
            and isinstance(port, str)
            and port.strip() != ""
            and port.strip().upper().startswith("COM")
        )
        if (not port) or (not is_windows_com_port and not os.path.exists(port)):
            for c in ["/dev/serial0", "/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyAMA0"]:
                if os.path.exists(c):
                    port = c
                    _esp_port = c
                    break
            else:
                raise FileNotFoundError(errno.ENOENT, "Serial device not found", port)
        if esp_ser:
            try:
                esp_ser.close()
            except Exception:
                pass
        esp_ser = serial.Serial(
            port=port,
            baudrate=baud,
            timeout=2.0,
            write_timeout=2.0,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
        )
        esp_ser.reset_input_buffer()
        esp_ser.reset_output_buffer()
        _esp_port = port
        return esp_ser


FRIABILITY_RPM_MIN = 20
FRIABILITY_RPM_MAX = 70


def _friability_placeholder_response(cmd: str) -> Optional[dict]:
    """Ack friability drum commands when MCU is unavailable."""
    c = normalize_line(str(cmd or "")).lower()
    if c.startswith("start,") or c.startswith("val,"):
        rpm = 25
        parts = c.split(",")
        if len(parts) >= 2:
            try:
                rpm = int(parts[1])
            except (TypeError, ValueError):
                pass
        return {
            "ok": True,
            "response": "ok",
            "normalized": "ok",
            "kind": "ok",
            "rpm": rpm,
            "cmd": cmd,
            "placeholder": True,
        }
    if c in ("stop", "pause", "resume"):
        return {
            "ok": True,
            "response": "ok",
            "normalized": "ok",
            "kind": "ok",
            "cmd": cmd,
            "placeholder": True,
        }
    if c in ("dispense", "initialise", "initialize"):
        return {
            "ok": True,
            "response": "ok",
            "normalized": "ok",
            "kind": "ok",
            "cmd": cmd,
            "placeholder": True,
        }
    return None


def _ack_ok(result: dict) -> bool:
    norm = normalize_line(result.get("normalized") or result.get("response") or "").lower()
    return norm == "ok"


_COMPLETION_NORMALIZED = frozenset({"done", "complete", "complete.", "completed"})


def _is_completion_line(norm: str) -> bool:
    return normalize_line(norm or "").lower() in _COMPLETION_NORMALIZED


def _ingest_remaining_uart_lines(lines: list, start_index: int) -> None:
    """Queue UART lines after the one returned to the caller (avoids losing e.g. done after ok)."""
    for extra in lines[start_index + 1 :]:
        if extra and str(extra).strip():
            _ingest_uart_line(str(extra).strip(), log_tag="RX_STREAM")


def _wait_for_stream_event(
    accept_kinds: tuple,
    timeout_sec: float = 60.0,
    accept_normalized: Optional[tuple] = None,
) -> dict:
    """Wait for a streamed line matching kind or normalized value."""
    deadline = time.time() + max(0.5, float(timeout_sec or 60.0))
    accept_norm = tuple(n.lower() for n in (accept_normalized or ()))
    while time.time() < deadline:
        try:
            line = line_q.get(timeout=0.15)
        except queue.Empty:
            line = None
        if line and line.strip():
            raw = line.strip()
            payload = build_line_payload(raw)
            kind = str(payload.get("kind") or "").lower()
            norm = normalize_line(raw).lower()
            if kind in accept_kinds or norm in accept_norm:
                return {"ok": True, "response": raw, "normalized": norm, "kind": kind, **payload}
        time.sleep(0.02)
    return {"ok": False, "error": "Timeout waiting for stream event"}


def _hardware_error_result(result: dict) -> Optional[dict]:
    """Return error dict when MCU response is an error line."""
    if not result:
        return {"ok": False, "error": "No response"}
    kind = result.get("kind")
    norm = normalize_line(result.get("normalized") or result.get("response") or "").lower()
    if kind == "error" or norm == "error" or norm.startswith("error:"):
        return {
            "ok": False,
            "error": norm or "error",
            "response": result.get("response"),
            "normalized": norm,
            "kind": "error",
            "cmd": result.get("cmd"),
        }
    return None


def send_command(
    cmd: str,
    timeout=COMMAND_TIMEOUT,
    max_retries=MAX_RETRIES,
    ignore_numeric_response=False,
    drain_before=True,
    clear_input=True,
):
    """Send command to MCU and return normalized response metadata."""
    global esp_ser, esp_read_buffer
    if not cmd:
        return {"ok": False, "error": "Empty command"}
    cmd = cmd.strip()
    if not cmd.endswith("*"):
        cmd = cmd + "*"
    _append_uart_log("TX", cmd)
    placeholder = _friability_placeholder_response(cmd)
    serial_open = bool(esp_ser and getattr(esp_ser, "is_open", False))

    def _use_placeholder():
        return bool(placeholder) and not serial_open

    if not serial:
        if placeholder:
            _append_uart_log("RX", placeholder.get("response", ""))
            return placeholder
        return {"ok": False, "error": "pyserial not installed", "cmd": cmd}
    for attempt in range(max_retries):
        if not esp_ser or not getattr(esp_ser, "is_open", False):
            try:
                _open_esp_serial()
            except Exception as e:
                if attempt == max_retries - 1:
                    if _use_placeholder():
                        return placeholder
                    return {"ok": False, "error": str(e), "cmd": cmd}
                time.sleep(0.2)
                continue
        try:
            if drain_before:
                drain_queue(max_lines=200)
            with ser_lock:
                if esp_ser and esp_ser.is_open:
                    if clear_input:
                        esp_ser.reset_input_buffer()
                    esp_ser.write((cmd + "\n").encode("ascii", errors="replace"))
                    esp_ser.flush()
            deadline = time.time() + (timeout or COMMAND_TIMEOUT)
            while time.time() < deadline:
                try:
                    line = line_q.get(timeout=0.1)
                    if line and line.strip():
                        raw = line.strip()
                        if ignore_numeric_response and is_stream_progress_line(raw):
                            continue
                        kind = classify_line(raw)
                        rpm_val = extract_rpm(raw)
                        _append_uart_log("RX", raw)
                        norm = normalize_line(raw)
                        out = {"ok": True, "response": raw, "normalized": norm, "kind": kind, "cmd": cmd}
                        rot = extract_rotation_count(raw)
                        if rot is not None:
                            out["rotationCount"] = rot
                        if rpm_val is not None:
                            out["rpm"] = rpm_val
                        return out
                except queue.Empty:
                    pass
                with ser_lock:
                    if esp_ser and esp_ser.is_open and esp_ser.in_waiting > 0:
                        chunk = esp_ser.read(min(esp_ser.in_waiting, 256))
                    else:
                        chunk = b""
                if chunk:
                    global esp_read_buffer
                    try:
                        esp_read_buffer += chunk.decode("ascii", errors="ignore")
                    except Exception:
                        esp_read_buffer = ""
                    lines, esp_read_buffer = _extract_uart_lines_from_buffer(esp_read_buffer)
                    for line_idx, rx_line in enumerate(lines):
                        if ignore_numeric_response and is_stream_progress_line(rx_line):
                            _ingest_uart_line(rx_line, log_tag="RX_STREAM")
                            continue
                        kind = classify_line(rx_line)
                        rpm_val = extract_rpm(rx_line)
                        _append_uart_log("RX", rx_line)
                        norm = normalize_line(rx_line)
                        out = {
                            "ok": True,
                            "response": rx_line,
                            "normalized": norm,
                            "kind": kind,
                            "cmd": cmd,
                        }
                        rot = extract_rotation_count(rx_line)
                        if rot is not None:
                            out["rotationCount"] = rot
                        if rpm_val is not None:
                            out["rpm"] = rpm_val
                        _ingest_remaining_uart_lines(lines, line_idx)
                        return out
                time.sleep(0.05)
            if timeout is not None:
                if _use_placeholder():
                    return placeholder
                return {"ok": False, "error": "Timeout", "cmd": cmd}
        except Exception as e:
            if attempt == max_retries - 1:
                return {"ok": False, "error": str(e), "cmd": cmd}
            try:
                with ser_lock:
                    if esp_ser:
                        esp_ser.close()
                        esp_ser = None
                _open_esp_serial()
            except Exception:
                pass
            time.sleep(0.2)
    if _use_placeholder():
        return placeholder
    return {"ok": False, "error": "Max retries exceeded", "cmd": cmd}


def _reader_loop():
    global esp_read_buffer, esp_ser
    while True:
        try:
            if not esp_ser or not getattr(esp_ser, "is_open", False):
                try:
                    _open_esp_serial()
                except Exception:
                    time.sleep(2.0)
                    continue
            with ser_lock:
                if esp_ser and esp_ser.in_waiting > 0:
                    chunk = esp_ser.read(min(esp_ser.in_waiting, 1024))
                else:
                    time.sleep(0.05)
                    continue
            if chunk:
                try:
                    esp_read_buffer += chunk.decode("ascii", errors="ignore")
                except Exception:
                    continue
                lines, esp_read_buffer = _extract_uart_lines_from_buffer(esp_read_buffer)
                for line in lines:
                    _ingest_uart_line(line, log_tag="RX_STREAM")
                if len(esp_read_buffer) > 4096:
                    esp_read_buffer = esp_read_buffer[-2048:]
        except Exception as e:
            if _logger:
                _logger.debug("[HARDWARE] reader: %s", e)
            time.sleep(1.0)


def start_sse_stream():
    """SSE stream for real-time MCU data."""
    def gen():
        q = queue.Queue(maxsize=100)
        sse_clients.append(q)
        try:
            while True:
                try:
                    item = q.get(timeout=30.0)
                    if isinstance(item, dict):
                        payload = item
                    else:
                        payload = build_line_payload(str(item))
                    yield f"data: {json.dumps(payload)}\n\n"
                except queue.Empty:
                    yield "data: {\"ping\": true}\n\n"
        finally:
            if q in sse_clients:
                sse_clients.remove(q)
    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def drain_queue(max_lines=10):
    out = []
    for _ in range(max_lines):
        try:
            out.append(line_q.get_nowait())
        except queue.Empty:
            break
    return out


def cmd_start_friability(rpm: int):
    """Start test mode drum at RPM; returns after first ok (rotation stream via SSE)."""
    try:
        r = int(rpm)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid rpm"}
    if r < FRIABILITY_RPM_MIN or r > FRIABILITY_RPM_MAX:
        return {"ok": False, "error": f"rpm must be between {FRIABILITY_RPM_MIN} and {FRIABILITY_RPM_MAX}"}
    result = send_command(
        f"start,{r}*",
        ignore_numeric_response=True,
        drain_before=True,
        clear_input=False,
    )
    if not result.get("ok"):
        return result
    err = _hardware_error_result(result)
    if err:
        return err
    if not _ack_ok(result):
        norm = normalize_line(result.get("normalized") or "").lower()
        return {"ok": False, "error": norm or "unexpected response", **result}
    reset_live_state(target_rpm=r)
    result["rpm"] = r
    result["targetRpm"] = r
    result["mode"] = "start"
    return result


def cmd_start_validation(rpm: int):
    """Start validation (val) mode at RPM; streams count,rpm lines."""
    try:
        r = int(rpm)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid rpm"}
    if r < FRIABILITY_RPM_MIN or r > FRIABILITY_RPM_MAX:
        return {"ok": False, "error": f"rpm must be between {FRIABILITY_RPM_MIN} and {FRIABILITY_RPM_MAX}"}
    result = send_command(
        f"val,{r}*",
        ignore_numeric_response=True,
        drain_before=True,
        clear_input=False,
        timeout=8.0,
    )
    if not result.get("ok"):
        return result
    err = _hardware_error_result(result)
    if err:
        return err
    if not _ack_ok(result):
        norm = normalize_line(result.get("normalized") or "").lower()
        return {"ok": False, "error": norm or "unexpected response", **result}
    reset_live_state(target_rpm=r)
    result["rpm"] = r
    result["targetRpm"] = r
    result["mode"] = "val"
    return result


def cmd_pause_friability():
    """Pause drum; motor stops, count preserved for resume."""
    result = send_command(
        "pause*",
        ignore_numeric_response=True,
        drain_before=False,
        clear_input=False,
        timeout=5.0,
    )
    if not result.get("ok"):
        return result
    err = _hardware_error_result(result)
    if err:
        norm = err.get("error") or ""
        if "motor_not_running" in norm:
            pause_live_state()
            return {
                "ok": True,
                "response": result.get("response"),
                "normalized": norm,
                "kind": "ok",
                "already_paused": True,
                "cmd": result.get("cmd"),
            }
        return err
    if not _ack_ok(result):
        norm = normalize_line(result.get("normalized") or "").lower()
        return {"ok": False, "error": norm or "unexpected response", **result}
    pause_live_state()
    return result


def cmd_resume_friability():
    """Resume drum after pause; ESP continues count from last value."""
    result = send_command(
        "resume*",
        ignore_numeric_response=True,
        drain_before=False,
        clear_input=False,
        timeout=5.0,
    )
    if not result.get("ok"):
        return result
    err = _hardware_error_result(result)
    if err:
        return err
    if not _ack_ok(result):
        norm = normalize_line(result.get("normalized") or "").lower()
        return {"ok": False, "error": norm or "unexpected response", **result}
    resume_live_state()
    return result


def cmd_stop_friability():
    """Stop drum; tolerates motor_not_running as success. Retries stop* until ok."""
    last_result: Dict[str, Any] = {"ok": False, "error": "stop not acknowledged"}
    for attempt in range(5):
        result = send_command(
            "stop*",
            ignore_numeric_response=True,
            drain_before=attempt == 0,
            clear_input=False,
            timeout=5.0,
        )
        last_result = result
        if not result.get("ok"):
            continue
        err = _hardware_error_result(result)
        if err:
            norm = err.get("error") or ""
            if "motor_not_running" in norm:
                stop_live_state()
                return {
                    "ok": True,
                    "response": result.get("response"),
                    "normalized": norm,
                    "kind": "ok",
                    "already_stopped": True,
                    "cmd": result.get("cmd"),
                }
            continue
        norm = normalize_line(result.get("normalized") or result.get("response") or "").lower()
        if norm in ("ok", "stopped"):
            stop_live_state()
            return result
    return last_result


def cmd_initialise():
    """Send initialise*; retry quickly if the first ack is missed."""
    last_result: Dict[str, Any] = {"ok": False, "error": "initialize not acknowledged"}
    for attempt in range(3):
        if attempt > 0:
            time.sleep(1.5 * attempt)
            drain_queue(max_lines=200)
        result = send_command(
            "initialise*",
            # The first initialize after an idle period can be dropped by the MCU.
            # Retry quickly on a missed ack instead of blocking the UI for 90 seconds.
            timeout=6.0,
            ignore_numeric_response=True,
            drain_before=True,
            clear_input=False,
            max_retries=1,
        )
        last_result = result
        if not result.get("ok"):
            continue
        err = _hardware_error_result(result)
        if err:
            last_result = err
            continue
        norm = normalize_line(result.get("normalized") or result.get("response") or "").lower()
        if _is_completion_line(norm):
            result["initialized"] = True
            result["doneLine"] = result.get("response")
            return result
        if not _ack_ok(result):
            last_result = {"ok": False, "error": norm or "unexpected response", **result}
            continue
        if result.get("placeholder"):
            time.sleep(0.4)
            result["initialized"] = True
            result["doneLine"] = "done"
            return result
        done = _wait_for_stream_event(
            accept_kinds=("completed",),
            accept_normalized=tuple(_COMPLETION_NORMALIZED),
            timeout_sec=90.0,
        )
        if done.get("ok"):
            result["initialized"] = True
            result["doneLine"] = done.get("response")
            return result
        last_result = done
    return last_result


def cmd_dispense():
    """Reverse drum for auto-dispense; returns after ok then waits for complete."""
    result = send_command("dispense*", timeout=180.0, ignore_numeric_response=True)
    if not result.get("ok"):
        return result
    err = _hardware_error_result(result)
    if err:
        return err
    if not _ack_ok(result):
        norm = normalize_line(result.get("normalized") or "").lower()
        return {"ok": False, "error": norm or "unexpected response", **result}
    if result.get("placeholder"):
        time.sleep(0.6)
        result["completed"] = True
        result["completionLine"] = "complete"
        return result
    complete = _wait_for_stream_event(
        accept_kinds=("completed",),
        accept_normalized=("complete", "complete.", "completed", "done"),
        timeout_sec=240.0,
    )
    if not complete.get("ok"):
        return complete
    result["completed"] = True
    result["completionLine"] = complete.get("response")
    return result


def cmd_stop():
    return cmd_stop_friability()


def cmd_status():
    return send_command("status*")


def _append_uart_log(
    direction: str,
    payload: str,
    kind: Optional[str] = None,
    rotation: Optional[int] = None,
    rpm: Optional[float] = None,
    stream: bool = False,
):
    """Append one UART line to the communications log (default: uart_communications.log)."""
    path = _uart_log_path or DEFAULT_UART_LOG
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    raw = str(payload or "").strip()
    line = f"{ts} [{direction}] {raw}\n"
    try:
        log_dir = os.path.dirname(path)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        with _uart_log_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception as e:
        if _logger:
            _logger.warning("UART log write failed (%s): %s", path, e)


def get_uart_log_tail(max_lines: int = 500) -> dict:
    path = _uart_log_path or DEFAULT_UART_LOG
    max_lines = max(1, min(int(max_lines or 500), 5000))
    lines = []
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
    except Exception as e:
        return {"ok": False, "error": str(e), "path": path}
    tail = [ln.rstrip("\n") for ln in lines[-max_lines:]]
    return {"ok": True, "path": path, "lines": tail, "count": len(tail)}


def reset_uart_log(reason: str = "manual"):
    path = _uart_log_path or DEFAULT_UART_LOG
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    try:
        log_dir = os.path.dirname(path)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        with _uart_log_lock:
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"{ts} [SYSTEM] UART log reset ({reason})\n")
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e), "path": path}
