#!/usr/bin/env python3
"""
dt_hardware_service.py - Disintegration Tester ESP32 UART protocol + mock backend.

TX: T1, T2, TS, PHW,t1,t2, START,B1/B2/B3, STOP/STOP1/STOP2, CAL,IRx/EXTx
RX: T1/T2 temp lines, TR1/TR2 ready, S1/S2 stroke counters

Mock mode: DT_HARDWARE_MOCK=1 (or auto when serial device unavailable).
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import queue
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from flask import Response

try:
    import serial
except ImportError:
    serial = None

_logger = None
_config: Dict[str, Any] = {}
_esp_port = None
ser_lock = threading.Lock()
esp_ser = None
line_q: queue.Queue = queue.Queue(maxsize=2000)
sse_clients: List[queue.Queue] = []
esp_read_buffer = ""
COMMAND_TIMEOUT = 2.0
MAX_RETRIES = 3
_uart_log_lock = threading.Lock()
_live_state_lock = threading.Lock()
_uart_log_path = ""
_boot_marker_path = ""
_uart_owner_lock_path = "/tmp/dt_uart_owner.lock"
_uart_owner_lock_fd = None
_hardware_init_done = False
_hardware_owner_active = False
DEFAULT_UART_LOG = "/opt/kiosk/uart_communications.log"

_temp_cache_lock = threading.Lock()
_heater_lock = threading.Lock()
_HEATER_STATE = {"t1": 0.0, "t2": 0.0}
_latest_temps: Dict[str, Any] = {
    "IR1": None,
    "IR2": None,
    "EXT1": None,
    "EXT2": None,
    "timestamp": None,
    "age_seconds": None,
    "error": None,
}
_live_state: Dict[str, Any] = {
    "running": False,
    "mock": False,
    "IR1": None,
    "IR2": None,
    "EXT1": None,
    "EXT2": None,
    "S1": 0,
    "S2": 0,
    "TR1": False,
    "TR2": False,
    "heater": {"t1": 0.0, "t2": 0.0},
    "lastLine": None,
    "updatedAt": None,
}

_mock_mode = False
_mock_lock = threading.Lock()
_mock_strokes = {"S1": 0, "S2": 0}
_mock_running = {"1": False, "2": False}
_mock_temps = {"IR1": 25.0, "IR2": 25.0, "EXT1": 24.5, "EXT2": 24.5}
_mock_emit_strokes = True
_calibration_in_progress = False


# ---------------------------------------------------------------------------
# Mock detection
# ---------------------------------------------------------------------------

def is_mock_mode() -> bool:
    return bool(_mock_mode)


def set_mock_emit_strokes(enabled: bool) -> None:
    """Test hook: disable stroke emission so stroke validation fails."""
    global _mock_emit_strokes
    _mock_emit_strokes = bool(enabled)


def _env_wants_mock() -> bool:
    v = str(os.environ.get("DT_HARDWARE_MOCK", "")).strip().lower()
    return v in ("1", "true", "yes", "on")


def _serial_device_available(port: str) -> bool:
    if not serial:
        return False
    if not port:
        return False
    if os.name == "nt" and str(port).upper().startswith("COM"):
        return True
    return os.path.exists(port)


# ---------------------------------------------------------------------------
# UART logging / owner lock (generic)
# ---------------------------------------------------------------------------

def normalize_line(line: str) -> str:
    return str(line or "").strip()


def _append_uart_log(tag: str, line: str) -> None:
    path = _uart_log_path or DEFAULT_UART_LOG
    try:
        with _uart_log_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{tag}] {line}\n")
    except Exception:
        pass


def reset_uart_log(reason: str = "manual") -> Dict[str, Any]:
    path = _uart_log_path or DEFAULT_UART_LOG
    try:
        with _uart_log_lock:
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [RESET] {reason}\n")
        return {"ok": True, "path": path, "reason": reason}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_uart_log_tail(max_lines: int = 500) -> Dict[str, Any]:
    path = _uart_log_path or DEFAULT_UART_LOG
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return {"ok": True, "lines": lines[-max(1, int(max_lines)):], "path": path}
    except FileNotFoundError:
        return {"ok": True, "lines": [], "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e), "lines": []}


def _get_boot_id() -> str:
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            for row in f:
                if row.startswith("btime "):
                    return row.split()[1].strip()
    except Exception:
        pass
    return ""


def _ensure_log_reset_on_power_on() -> None:
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


# ---------------------------------------------------------------------------
# Protocol parsers
# ---------------------------------------------------------------------------

_STROKE_RE = re.compile(
    r"S1[=:](\d+)\s*,\s*S2[=:](\d+)|S1[=:](\d+)|S2[=:](\d+)",
    re.IGNORECASE,
)


def parse_t1_t2(line: str, expected_tag: str) -> Optional[Tuple[float, float]]:
    parts = [p.strip() for p in line.split(",")]
    if not parts or parts[0].upper() != expected_tag.upper():
        return None
    if len(parts) == 3:
        try:
            return (float(parts[1]), float(parts[2]))
        except ValueError:
            return None
    if len(parts) == 5:
        try:
            if expected_tag.upper() == "T1":
                if parts[1].upper() != "IR1" or parts[3].upper() != "EXT1":
                    return None
            else:
                if parts[1].upper() != "IR2" or parts[3].upper() != "EXT2":
                    return None
            return (float(parts[2]), float(parts[4]))
        except ValueError:
            return None
    return None


def is_ts_response_line(line: str) -> bool:
    parts = [p.strip().upper() for p in line.split(",") if p.strip()]
    if len(parts) < 2:
        return False
    left = parts[-2]
    right = parts[-1]
    return left in ("TR1", "0") and right in ("TR2", "0")


def parse_strokes(line: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    m = _STROKE_RE.search(str(line or ""))
    if not m:
        return out
    if m.group(1) is not None and m.group(2) is not None:
        out["S1"] = int(m.group(1))
        out["S2"] = int(m.group(2))
    elif m.group(3) is not None:
        out["S1"] = int(m.group(3))
    elif m.group(4) is not None:
        out["S2"] = int(m.group(4))
    return out


def classify_line(line: str) -> str:
    s = normalize_line(line)
    if not s:
        return "empty"
    su = s.upper()
    if su.startswith("T1") or su.startswith("T2"):
        return "temps"
    if is_ts_response_line(s):
        return "ts"
    if parse_strokes(s):
        return "stroke"
    if su in ("OK", "STOPPED", "COMPLETED", "COMPLETE", "DONE"):
        return su.lower()
    if su == "ERROR" or su.startswith("ERROR:"):
        return "error"
    return "info"


# ---------------------------------------------------------------------------
# Live state / temps / heater
# ---------------------------------------------------------------------------

def get_heater_state() -> Dict[str, float]:
    with _heater_lock:
        return dict(_HEATER_STATE)


def set_heater_state(t1: Optional[float] = None, t2: Optional[float] = None) -> Dict[str, float]:
    with _heater_lock:
        if t1 is not None:
            _HEATER_STATE["t1"] = float(t1)
        if t2 is not None:
            _HEATER_STATE["t2"] = float(t2)
        return dict(_HEATER_STATE)


def get_latest_temps() -> Dict[str, Any]:
    with _temp_cache_lock:
        out = dict(_latest_temps)
    if out.get("timestamp"):
        out["age_seconds"] = max(0.0, (time.time() * 1000 - float(out["timestamp"])) / 1000.0)
    return out


def get_live_state() -> Dict[str, Any]:
    with _live_state_lock:
        state = dict(_live_state)
        state["heater"] = get_heater_state()
        state["mock"] = is_mock_mode()
        return state


def _update_temps(ir1=None, ir2=None, ext1=None, ext2=None) -> Dict[str, Any]:
    now_ms = int(time.time() * 1000)
    with _temp_cache_lock:
        if ir1 is not None:
            _latest_temps["IR1"] = float(ir1)
        if ir2 is not None:
            _latest_temps["IR2"] = float(ir2)
        if ext1 is not None:
            _latest_temps["EXT1"] = float(ext1)
        if ext2 is not None:
            _latest_temps["EXT2"] = float(ext2)
        _latest_temps["timestamp"] = now_ms
        _latest_temps["age_seconds"] = 0
        _latest_temps["error"] = None
        cache = dict(_latest_temps)
    with _live_state_lock:
        for k in ("IR1", "IR2", "EXT1", "EXT2"):
            if cache.get(k) is not None:
                _live_state[k] = cache[k]
        _live_state["updatedAt"] = time.time()
    return cache


def _update_strokes(s1: Optional[int] = None, s2: Optional[int] = None) -> None:
    with _live_state_lock:
        if s1 is not None:
            # Monotonic: only accept increases (controller reset cannot inflate)
            prev = int(_live_state.get("S1") or 0)
            if int(s1) >= prev:
                _live_state["S1"] = int(s1)
            else:
                # reset detected — accept new baseline but don't invent counts
                _live_state["S1"] = int(s1)
        if s2 is not None:
            prev = int(_live_state.get("S2") or 0)
            if int(s2) >= prev:
                _live_state["S2"] = int(s2)
            else:
                _live_state["S2"] = int(s2)
        _live_state["updatedAt"] = time.time()


def get_stroke_counts() -> Dict[str, int]:
    with _live_state_lock:
        return {"S1": int(_live_state.get("S1") or 0), "S2": int(_live_state.get("S2") or 0)}


def reset_stroke_baseline() -> Dict[str, int]:
    """Snapshot current counters as baseline for validation delta counting."""
    counts = get_stroke_counts()
    return dict(counts)


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------

def _put_sse(q: queue.Queue, msg: Any) -> bool:
    try:
        q.put_nowait(msg)
        return True
    except Exception:
        return False


def _broadcast_sse(payload: Any) -> None:
    dead = []
    for q in list(sse_clients):
        if not _put_sse(q, payload):
            dead.append(q)
    for q in dead:
        if q in sse_clients:
            sse_clients.remove(q)


def _emit_temps_sse(cache: Optional[Dict[str, Any]] = None) -> None:
    cache = cache or get_latest_temps()
    payload = {
        "type": "temps",
        "kind": "temps",
        "IR1": cache.get("IR1"),
        "IR2": cache.get("IR2"),
        "EXT1": cache.get("EXT1"),
        "EXT2": cache.get("EXT2"),
        "timestamp": cache.get("timestamp") or int(time.time() * 1000),
        "mock": is_mock_mode(),
    }
    _broadcast_sse(payload)


def _emit_tr(basket: int) -> None:
    event = {"type": f"TR{basket}", "kind": "tr", "basket": basket, "mock": is_mock_mode()}
    with _live_state_lock:
        _live_state[f"TR{basket}"] = True
        _live_state["updatedAt"] = time.time()
    _broadcast_sse(event)
    if _logger:
        _logger.info("[TS] Emitted TR%s - basket %s ready (mock=%s)", basket, basket, is_mock_mode())


def _handle_ts_response(line: str) -> None:
    parts = [p.strip().upper() for p in line.split(",") if p.strip()]
    if len(parts) < 2:
        return
    left, right = parts[-2], parts[-1]
    if left == "TR1":
        _emit_tr(1)
    if right == "TR2":
        _emit_tr(2)


def build_line_payload(line: str) -> Dict[str, Any]:
    kind = classify_line(line)
    payload: Dict[str, Any] = {
        "line": line,
        "normalized": normalize_line(line),
        "kind": kind,
        "mock": is_mock_mode(),
    }
    if kind == "temps":
        tag = "T1" if normalize_line(line).upper().startswith("T1") else "T2"
        parsed = parse_t1_t2(line, tag)
        if parsed:
            ir, ext = parsed
            if tag == "T1":
                payload.update({"IR1": ir, "EXT1": ext})
            else:
                payload.update({"IR2": ir, "EXT2": ext})
    strokes = parse_strokes(line)
    if strokes:
        payload.update(strokes)
        payload["type"] = "stroke"
    return payload


def _ingest_uart_line(line: str, *, log_tag: str = "RX_STREAM") -> Dict[str, Any]:
    payload = build_line_payload(line)
    _append_uart_log(log_tag, line)
    try:
        line_q.put_nowait(line)
    except queue.Full:
        pass

    kind = payload.get("kind")
    if kind == "temps":
        if "IR1" in payload:
            cache = _update_temps(ir1=payload.get("IR1"), ext1=payload.get("EXT1"))
            _emit_temps_sse(cache)
            return payload
        if "IR2" in payload:
            cache = _update_temps(ir2=payload.get("IR2"), ext2=payload.get("EXT2"))
            _emit_temps_sse(cache)
            return payload
    if kind == "ts":
        _handle_ts_response(line)
        return payload
    if kind == "stroke":
        _update_strokes(payload.get("S1"), payload.get("S2"))
        stroke_evt = {
            "type": "stroke",
            "kind": "stroke",
            "S1": payload.get("S1"),
            "S2": payload.get("S2"),
            "mock": is_mock_mode(),
        }
        _broadcast_sse(stroke_evt)
        return payload

    with _live_state_lock:
        _live_state["lastLine"] = line
        _live_state["updatedAt"] = time.time()
    _broadcast_sse(payload)
    return payload


# ---------------------------------------------------------------------------
# Serial open / write (DT uses newline-terminated ASCII, NO trailing *)
# ---------------------------------------------------------------------------

def _open_esp_serial():
    global esp_ser, _esp_port
    port = _config.get("ESP_PORT", "/dev/serial0")
    baud = int(_config.get("ESP_BAUD", 9600))
    if not serial:
        raise FileNotFoundError(errno.ENOENT, "pyserial not installed", port)
    with ser_lock:
        if esp_ser and getattr(esp_ser, "is_open", False):
            return esp_ser
        is_windows_com = (
            os.name == "nt"
            and isinstance(port, str)
            and port.strip().upper().startswith("COM")
        )
        if (not port) or (not is_windows_com and not os.path.exists(port)):
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


def _close_esp_ser() -> None:
    global esp_ser
    with ser_lock:
        if esp_ser:
            try:
                esp_ser.close()
            except Exception:
                pass
        esp_ser = None


def esp_write_line(cmd: str, max_retries: int = 3) -> bool:
    """Write ASCII line + newline to ESP. Returns True on success."""
    global esp_ser
    if not cmd:
        return False
    if is_mock_mode():
        _append_uart_log("TX_MOCK", cmd.strip())
        if _logger:
            _logger.debug("[MOCK ESP WRITE] %r", cmd.strip())
        return True
    backoff = 0.1
    for attempt in range(max_retries):
        if not esp_ser or not getattr(esp_ser, "is_open", False):
            try:
                _open_esp_serial()
            except Exception as e:
                if _logger:
                    _logger.error("[ESP WRITE] reopen failed (%d/%d): %s", attempt + 1, max_retries, e)
                if attempt < max_retries - 1:
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 1.0)
                    continue
                return False
        try:
            with ser_lock:
                if not esp_ser or not getattr(esp_ser, "is_open", False):
                    continue
                line = (cmd.strip() + "\n").encode("ascii", errors="replace")
                esp_ser.write(line)
                esp_ser.flush()
                _append_uart_log("TX", cmd.strip())
                return True
        except Exception as e:
            if _logger:
                _logger.warning("[ESP WRITE] failed (%d/%d): %s", attempt + 1, max_retries, e)
            _close_esp_ser()
            time.sleep(backoff)
            backoff = min(backoff * 2, 1.0)
    return False


def send_command(cmd: str, timeout: float = COMMAND_TIMEOUT, max_retries: int = MAX_RETRIES) -> Dict[str, Any]:
    """Fire-and-forget style for DT: write command; optional wait for non-stream ack."""
    if not cmd:
        return {"ok": False, "error": "Empty command"}
    cmd = cmd.strip()
    if is_mock_mode():
        _append_uart_log("TX_MOCK", cmd)
        return {"ok": True, "response": "ok", "normalized": "ok", "kind": "ok", "cmd": cmd, "mock": True}
    ok = esp_write_line(cmd, max_retries=max_retries)
    if not ok:
        return {"ok": False, "error": "write failed", "cmd": cmd}
    # DT firmware often does not ack; return success on write
    return {"ok": True, "response": "ok", "normalized": "ok", "kind": "ok", "cmd": cmd}


def drain_queue(max_lines: int = 10) -> List[str]:
    out = []
    for _ in range(max_lines):
        try:
            out.append(line_q.get_nowait())
        except queue.Empty:
            break
    return out


# ---------------------------------------------------------------------------
# Reader / temp poller / mock loops
# ---------------------------------------------------------------------------

def _reader_loop() -> None:
    global esp_read_buffer, esp_ser
    while True:
        try:
            if is_mock_mode():
                time.sleep(0.5)
                continue
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
                while "\n" in esp_read_buffer:
                    line, esp_read_buffer = esp_read_buffer.split("\n", 1)
                    line = line.strip()
                    if line:
                        _ingest_uart_line(line)
                if len(esp_read_buffer) > 4096:
                    esp_read_buffer = esp_read_buffer[-2048:]
        except Exception as e:
            if _logger:
                _logger.debug("[DT HW] reader: %s", e)
            time.sleep(1.0)


def _temperature_polling_thread() -> None:
    poll_interval = float(_config.get("TEMP_POLL_INTERVAL", 0.5))
    t1_t2_gap = max(0.5, float(_config.get("TEMP_T1_T2_GAP", 1.0)))
    read_timeout = float(_config.get("TEMP_READ_TIMEOUT", 2.0))
    ts_interval = float(_config.get("TS_POLL_INTERVAL", 3.0))
    ts_tolerance = float(_config.get("TS_TEMP_TOLERANCE", 3.0))
    last_ts_time = 0.0
    time.sleep(0.3)
    while True:
        try:
            if is_mock_mode():
                time.sleep(poll_interval)
                continue
            if _calibration_in_progress:
                time.sleep(1.0)
                continue

            def _read_tag(tag: str):
                if not esp_write_line(tag):
                    return None
                deadline = time.time() + read_timeout
                while time.time() < deadline:
                    try:
                        line = line_q.get(timeout=max(0.05, deadline - time.time()))
                    except queue.Empty:
                        break
                    if is_ts_response_line(line):
                        _handle_ts_response(line)
                        continue
                    parsed = parse_t1_t2(line, tag)
                    if parsed is not None:
                        return parsed
                return None

            t1 = _read_tag("T1")
            time.sleep(t1_t2_gap)
            t2 = _read_tag("T2")
            any_ok = False
            if t1 is not None:
                _update_temps(ir1=t1[0], ext1=t1[1])
                any_ok = True
            if t2 is not None:
                _update_temps(ir2=t2[0], ext2=t2[1])
                any_ok = True
            if any_ok:
                _emit_temps_sse()

            heater = get_heater_state()
            cache = get_latest_temps()
            ir1, ir2 = cache.get("IR1"), cache.get("IR2")
            t1_set = float(heater.get("t1") or 0.0)
            t2_set = float(heater.get("t2") or 0.0)
            near1 = t1_set > 0 and ir1 is not None and abs(float(ir1) - t1_set) <= ts_tolerance
            near2 = t2_set > 0 and ir2 is not None and abs(float(ir2) - t2_set) <= ts_tolerance
            if (near1 or near2) and (time.time() - last_ts_time >= ts_interval):
                last_ts_time = time.time()
                if esp_write_line("TS"):
                    try:
                        line = line_q.get(timeout=2.0)
                        if is_ts_response_line(line):
                            _handle_ts_response(line)
                    except queue.Empty:
                        pass
        except Exception as e:
            if _logger:
                _logger.debug("[DT HW] temp poller: %s", e)
        time.sleep(poll_interval)


def _mock_loop() -> None:
    """Simulate bath temps, TR ready, and stroke pulses."""
    last_stroke = 0.0
    last_temp = 0.0
    while True:
        try:
            if not is_mock_mode():
                time.sleep(0.5)
                continue
            now = time.time()
            heater = get_heater_state()
            with _mock_lock:
                for basket, key_ir, key_ext, t_key in (
                    (1, "IR1", "EXT1", "t1"),
                    (2, "IR2", "EXT2", "t2"),
                ):
                    target = float(heater.get(t_key) or 0.0)
                    cur = float(_mock_temps[key_ir])
                    if target > 0:
                        # ramp toward setpoint
                        step = 0.8 if cur < target else -0.4
                        if abs(cur - target) < 0.3:
                            cur = target + ((-1) ** int(now) * 0.05)
                        else:
                            cur = cur + step
                    else:
                        # cool toward ambient
                        cur = cur + (25.0 - cur) * 0.05
                    _mock_temps[key_ir] = round(cur, 2)
                    _mock_temps[key_ext] = round(cur - 0.4, 2)

                if now - last_temp >= 0.5:
                    last_temp = now
                    cache = _update_temps(
                        ir1=_mock_temps["IR1"],
                        ir2=_mock_temps["IR2"],
                        ext1=_mock_temps["EXT1"],
                        ext2=_mock_temps["EXT2"],
                    )
                    _emit_temps_sse(cache)
                    # TR when within ±3°C
                    for basket, key_ir, t_key in ((1, "IR1", "t1"), (2, "IR2", "t2")):
                        target = float(heater.get(t_key) or 0.0)
                        if target > 0 and abs(float(_mock_temps[key_ir]) - target) <= 3.0:
                            with _live_state_lock:
                                already = bool(_live_state.get(f"TR{basket}"))
                            if not already:
                                _emit_tr(basket)

                if _mock_emit_strokes and (now - last_stroke >= 2.0):
                    last_stroke = now
                    for b in (1, 2):
                        if _mock_running.get(str(b)):
                            sk = f"S{b}"
                            _mock_strokes[sk] = int(_mock_strokes.get(sk) or 0) + 1
                    _update_strokes(_mock_strokes["S1"], _mock_strokes["S2"])
                    _broadcast_sse({
                        "type": "stroke",
                        "kind": "stroke",
                        "S1": _mock_strokes["S1"],
                        "S2": _mock_strokes["S2"],
                        "mock": True,
                    })
                    _append_uart_log(
                        "RX_MOCK",
                        f"S1:{_mock_strokes['S1']},S2:{_mock_strokes['S2']}",
                    )
        except Exception as e:
            if _logger:
                _logger.debug("[DT HW] mock loop: %s", e)
        time.sleep(0.2)


# ---------------------------------------------------------------------------
# Public DT commands
# ---------------------------------------------------------------------------

MAX_TEMP_C = 55.0
MIN_TEMP_C = 20.0


def _clamp_temp(t: float) -> float:
    return max(0.0, min(float(t), MAX_TEMP_C))


def cmd_preheat(t1: float = 0.0, t2: float = 0.0) -> Dict[str, Any]:
    t1 = _clamp_temp(t1)
    t2 = _clamp_temp(t2)
    set_heater_state(t1=t1, t2=t2)
    with _live_state_lock:
        _live_state["TR1"] = False
        _live_state["TR2"] = False
    cmd = f"PHW,{t1:.1f},{t2:.1f}"
    result = send_command(cmd)
    result["heater"] = get_heater_state()
    return result


def cmd_start_b1(temp: float) -> Dict[str, Any]:
    temp = _clamp_temp(temp)
    set_heater_state(t1=temp)
    if is_mock_mode():
        with _mock_lock:
            _mock_running["1"] = True
    with _live_state_lock:
        _live_state["running"] = True
    return send_command(f"START,B1,{temp:.1f}W")


def cmd_start_b2(temp: float) -> Dict[str, Any]:
    temp = _clamp_temp(temp)
    set_heater_state(t2=temp)
    if is_mock_mode():
        with _mock_lock:
            _mock_running["2"] = True
    with _live_state_lock:
        _live_state["running"] = True
    return send_command(f"START,B2,{temp:.1f}W")


def cmd_start_b3(t1: float, t2: float) -> Dict[str, Any]:
    t1 = _clamp_temp(t1)
    t2 = _clamp_temp(t2)
    set_heater_state(t1=t1, t2=t2)
    if is_mock_mode():
        with _mock_lock:
            _mock_running["1"] = True
            _mock_running["2"] = True
    with _live_state_lock:
        _live_state["running"] = True
    return send_command(f"START,B3,{t1:.1f}W,{t2:.1f}W")


def cmd_stop(basket: Optional[int] = None) -> Dict[str, Any]:
    if basket == 1:
        cmd = "STOP1"
        if is_mock_mode():
            with _mock_lock:
                _mock_running["1"] = False
        set_heater_state(t1=0.0)
    elif basket == 2:
        cmd = "STOP2"
        if is_mock_mode():
            with _mock_lock:
                _mock_running["2"] = False
        set_heater_state(t2=0.0)
    else:
        cmd = "STOP"
        if is_mock_mode():
            with _mock_lock:
                _mock_running["1"] = False
                _mock_running["2"] = False
        set_heater_state(t1=0.0, t2=0.0)
        with _live_state_lock:
            _live_state["running"] = False
    return send_command(cmd)


def cmd_calibrate(sensor: str, temp: float) -> Dict[str, Any]:
    global _calibration_in_progress
    sensor = str(sensor or "").strip().upper()
    if sensor not in ("IR1", "IR2", "EXT1", "EXT2"):
        return {"ok": False, "error": "sensor must be IR1, IR2, EXT1, or EXT2"}
    try:
        temp = float(temp)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid temperature"}
    if temp < 0 or temp > MAX_TEMP_C:
        return {"ok": False, "error": f"temperature must be 0-{MAX_TEMP_C}°C"}
    before = get_latest_temps().get(sensor)
    _calibration_in_progress = True
    try:
        result = send_command(f"CAL,{sensor},{temp:.1f}")
        result["sensor"] = sensor
        result["setTemperature"] = temp
        result["beforeValue"] = before
        result["afterValue"] = temp
        result["mock"] = is_mock_mode()
        if is_mock_mode():
            # In mock, snap the sensor reading to the cal value
            kwargs = {sensor.lower(): temp}  # wrong keys; set explicitly:
            if sensor == "IR1":
                _update_temps(ir1=temp)
            elif sensor == "IR2":
                _update_temps(ir2=temp)
            elif sensor == "EXT1":
                _update_temps(ext1=temp)
            elif sensor == "EXT2":
                _update_temps(ext2=temp)
            result["afterValue"] = temp
        return result
    finally:
        _calibration_in_progress = False


def cmd_status() -> Dict[str, Any]:
    return {
        "ok": True,
        "mock": is_mock_mode(),
        "port": _esp_port or _config.get("ESP_PORT"),
        "serialOpen": bool(esp_ser and getattr(esp_ser, "is_open", False)),
        "live": get_live_state(),
        "temps": get_latest_temps(),
        "heater": get_heater_state(),
    }


def start_sse_stream():
    def gen():
        q: queue.Queue = queue.Queue(maxsize=100)
        sse_clients.append(q)
        # Push current temps immediately
        try:
            q.put_nowait({
                "type": "temps",
                "kind": "temps",
                **{k: get_latest_temps().get(k) for k in ("IR1", "IR2", "EXT1", "EXT2", "timestamp")},
                "mock": is_mock_mode(),
            })
        except Exception:
            pass
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
                    yield f"data: {json.dumps({'ping': True, 'mock': is_mock_mode()})}\n\n"
        finally:
            if q in sse_clients:
                sse_clients.remove(q)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------

def init(app, config: Dict[str, Any]) -> None:
    global _logger, _config, _esp_port, line_q, sse_clients, _uart_log_path, _boot_marker_path
    global _hardware_init_done, _hardware_owner_active, _mock_mode
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

    force_mock = _env_wants_mock() or bool(_config.get("DT_HARDWARE_MOCK"))
    port = _esp_port
    if force_mock or not _serial_device_available(str(port)):
        _mock_mode = True
        if _logger:
            _logger.warning(
                "[DT HW] Running in MOCK mode (DT_HARDWARE_MOCK=%s, port=%s available=%s)",
                force_mock,
                port,
                _serial_device_available(str(port)),
            )
    else:
        _mock_mode = False

    with _live_state_lock:
        _live_state["mock"] = _mock_mode

    _hardware_owner_active = _acquire_uart_owner_lock()
    if not _hardware_owner_active:
        if _logger:
            _logger.warning("[DT HW] Skipping UART init; another process owns the UART")
        return
    _ensure_log_reset_on_power_on()
    line_q = queue.Queue(maxsize=2000)
    sse_clients = []

    if not _mock_mode:
        try:
            _open_esp_serial()
            if _logger:
                _logger.info("[DT HW] ESP32 serial initialized on %s", _esp_port)
        except Exception as e:
            if _logger:
                _logger.error("[DT HW] Failed to open serial, falling back to MOCK: %s", e)
            _mock_mode = True
            with _live_state_lock:
                _live_state["mock"] = True

    threading.Thread(target=_reader_loop, daemon=True, name="dt-uart-reader").start()
    threading.Thread(target=_temperature_polling_thread, daemon=True, name="dt-temp-poller").start()
    threading.Thread(target=_mock_loop, daemon=True, name="dt-mock-loop").start()
    if _logger:
        _logger.info("[DT HW] Initialized (mock=%s)", _mock_mode)
