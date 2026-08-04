#!/usr/bin/env python3
"""
dt_hardware_service.py - DT Bath CFR ESP32 UART protocol + mock backend.

TX: TE, TS, PHW,<t>, START,1|2|3,<t>, START,VAL,<n>,
    STOP/STOP1/STOP2, CAL,IR|EXT1|EXT2
RX: TE,<ir>,<ext1>,<ext2> (or TE,IR,x,E1,y,E2,z), bare TR ready,
    bare stroke integers during START,VAL

Single shared bath heater with ownership registry (manual / basket1 /
basket2 / validation / calibration). Bath IR is mirrored into IR1 & IR2;
EXT1/EXT2 remain per-beaker external probes.

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
from typing import Any, Dict, List, Optional, Set, Tuple

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

# Preheat cooldown — skip temp polling briefly after PHW
_last_preheat_time = 0.0
_preheat_cooldown = 1.0

_temp_cache_lock = threading.Lock()
_heater_lock = threading.Lock()
# Single bath setpoint mirrored as t1/t2 for legacy callers
_HEATER_STATE = {"t": 0.0, "t1": 0.0, "t2": 0.0}

# Bath ownership registry
_BATH_OWNERS: Set[str] = set()
_BATH_EXCLUSIVE_OWNERS = frozenset({"validation", "calibration"})
_BATH_OWNER_LABELS = {
    "manual": "manual heater",
    "basket1": "basket 1",
    "basket2": "basket 2",
    "validation": "temperature validation",
    "calibration": "calibration",
}

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
    "TR": False,
    "TR1": False,
    "TR2": False,
    "heater": {"t": 0.0, "t1": 0.0, "t2": 0.0},
    "bathOwners": [],
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
# While stroke validation runs, pause TE/TS so UART is free for bare stroke counts
_stroke_validation_active = False
_stroke_validation_basket = 1
_stroke_validation_lock = threading.Lock()
_last_stroke_count_emitted = -1
_STROKE_COUNT_MAX = 400
_STROKE_COUNT_MAX_JUMP = 64


# ---------------------------------------------------------------------------
# Mock detection
# ---------------------------------------------------------------------------

def is_mock_mode() -> bool:
    return bool(_mock_mode)


def set_mock_emit_strokes(enabled: bool) -> None:
    """Test hook: disable stroke emission so stroke validation fails."""
    global _mock_emit_strokes
    _mock_emit_strokes = bool(enabled)


def set_stroke_validation_active(active: bool, basket: Optional[int] = None) -> None:
    """Pause TE/TS polling while stroke validation needs a clean UART for counts."""
    global _stroke_validation_active, _stroke_validation_basket, _last_stroke_count_emitted
    with _stroke_validation_lock:
        _stroke_validation_active = bool(active)
        if basket is not None:
            _stroke_validation_basket = 1 if int(basket) != 2 else 2
        if not active:
            _last_stroke_count_emitted = -1
    if _logger:
        _logger.info(
            "[DT HW] stroke validation temp-poll %s (basket=%s)",
            "paused" if active else "resumed",
            _stroke_validation_basket if active else "-",
        )


def is_stroke_validation_active() -> bool:
    with _stroke_validation_lock:
        return bool(_stroke_validation_active)


def get_stroke_validation_basket() -> int:
    with _stroke_validation_lock:
        return int(_stroke_validation_basket or 1)


def _stroke_count_accept(n: int) -> bool:
    """True if n should be accepted as a stroke count (monotonic, bounded)."""
    global _last_stroke_count_emitted
    if n < 1 or n > _STROKE_COUNT_MAX:
        return False
    if _last_stroke_count_emitted >= 0:
        if n <= _last_stroke_count_emitted:
            return False
        if n - _last_stroke_count_emitted > _STROKE_COUNT_MAX_JUMP:
            if _logger:
                _logger.debug(
                    "[STROKE VAL] ignored bogus stroke jump %s -> %s",
                    _last_stroke_count_emitted,
                    n,
                )
            return False
    _last_stroke_count_emitted = n
    return True


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
# Protocol parsers (DT Bath CFR / DT_BATH)
# ---------------------------------------------------------------------------

def parse_te(line: str) -> Optional[Tuple[float, float, float]]:
    """
    Parse TE reply. Forms:
      TE,35.4,34.7,34.4          — compact: IR, EXT1, EXT2
      TE,IR,23.5,E1,24.5,E2,40.0
      TE ,IR,23.5,E1,24.5,E2,40.0
    Returns (ir, ext1, ext2) or None.
    """
    if not line or not str(line).strip():
        return None
    s = line.strip()
    if ":" in s and not s.upper().startswith("TE"):
        s = s.split(":", 1)[1].strip()
    m_compact = re.match(
        r"(?i)TE\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)",
        s,
    )
    if m_compact:
        try:
            return (
                float(m_compact.group(1)),
                float(m_compact.group(2)),
                float(m_compact.group(3)),
            )
        except ValueError:
            return None
    s2 = re.sub(r"^TE\s*[, ]?\s*", "", s, flags=re.I).strip()
    if not s2:
        return None
    parts = [p.strip() for p in s2.split(",") if p.strip() != ""]
    if parts and parts[0].upper() == "TE":
        parts = parts[1:]

    ir_v = e1_v = e2_v = None
    for i, p in enumerate(parts):
        pu = re.sub(r"[^A-Z0-9]+", "", p.upper())
        if pu == "IR" and i + 1 < len(parts):
            try:
                ir_v = float(parts[i + 1])
            except ValueError:
                return None
        elif pu in ("E1", "EXT1", "EX1") and i + 1 < len(parts):
            try:
                e1_v = float(parts[i + 1])
            except ValueError:
                pass
        elif pu in ("E2", "EXT2", "EX2") and i + 1 < len(parts):
            try:
                e2_v = float(parts[i + 1])
            except ValueError:
                pass

    if ir_v is None:
        m = re.search(r"(?:^|[,;])\s*IR\s*[,;]\s*([\d.+-]+)", line, re.I)
        if m:
            try:
                ir_v = float(m.group(1))
            except ValueError:
                return None
    if e1_v is None:
        m = re.search(r"(?:^|[,;])\s*(?:E1|EXT1)\s*[,;]\s*([\d.+-]+)", line, re.I)
        if m:
            try:
                e1_v = float(m.group(1))
            except ValueError:
                pass
    if e2_v is None:
        m = re.search(r"(?:^|[,;])\s*(?:E2|EXT2)\s*[,;]\s*([\d.+-]+)", line, re.I)
        if m:
            try:
                e2_v = float(m.group(1))
            except ValueError:
                pass

    if ir_v is None:
        return None
    return (ir_v, float(e1_v) if e1_v is not None else 0.0, float(e2_v) if e2_v is not None else 0.0)


# Legacy aliases kept for selftests / callers that still import them
def parse_t1_t2(line: str, expected_tag: str) -> Optional[Tuple[float, float]]:
    """Legacy dual-heater parser (unused by TE poller; kept for tests)."""
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
            return (float(parts[2]), float(parts[4]))
        except ValueError:
            return None
    return None


def parse_temp_bulk(line: str) -> Optional[Dict[str, float]]:
    """Legacy TEMP bulk parser (firmware no longer supports TEMP)."""
    s = str(line or "").strip()
    if not s:
        return None
    out: Dict[str, float] = {}
    for part in s.split(","):
        part = part.strip()
        if ":" not in part:
            continue
        key, val = part.split(":", 1)
        key_u = key.strip().upper()
        if key_u not in ("IR1", "IR2", "EXT1", "EXT2"):
            continue
        try:
            out[key_u] = float(val.strip())
        except ValueError:
            return None
    return out if len(out) >= 2 else None


def is_ts_response_line(line: str) -> bool:
    """True for bare TR, legacy TR1/TR2 pairs, or TS,TR1,TR2 style."""
    if not line or not str(line).strip():
        return False
    ls = line.lstrip()
    if ls.upper().startswith("TE"):
        return False
    compact = line.strip().upper().replace(" ", "")
    if compact == "TR" or compact.endswith(":TR"):
        return True
    parts = [p.strip().upper() for p in line.split(",") if p.strip()]
    if len(parts) < 2:
        return False
    left = parts[-2]
    right = parts[-1]
    return left in ("TR1", "0") and right in ("TR2", "0")


def parse_strokes(line: str) -> Dict[str, int]:
    """Legacy S1=/S2= parser (kept for compatibility). Prefer bare integers."""
    out: Dict[str, int] = {}
    m = re.search(
        r"S1[=:](\d+)\s*,\s*S2[=:](\d+)|S1[=:](\d+)|S2[=:](\d+)",
        str(line or ""),
        re.IGNORECASE,
    )
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
    if parse_te(s) is not None:
        return "temps_te"
    if su.startswith("T1") or su.startswith("T2"):
        return "temps"
    if parse_temp_bulk(s):
        return "temps_bulk"
    if is_ts_response_line(s):
        return "ts"
    if is_stroke_validation_active() and re.fullmatch(r"[0-9]{1,6}", s):
        return "stroke_count"
    if parse_strokes(s):
        return "stroke"
    if su in ("OK", "STOPPED", "COMPLETED", "COMPLETE", "DONE"):
        return su.lower()
    if su == "ERROR" or su.startswith("ERROR:"):
        return "error"
    return "info"


# ---------------------------------------------------------------------------
# Live state / temps / heater / bath ownership
# ---------------------------------------------------------------------------

def get_heater_state() -> Dict[str, float]:
    with _heater_lock:
        return dict(_HEATER_STATE)


def set_heater_state(
    t: Optional[float] = None,
    t1: Optional[float] = None,
    t2: Optional[float] = None,
) -> Dict[str, float]:
    """Set bath temperature. Prefer `t`; legacy t1/t2 collapse to max(t1,t2)."""
    with _heater_lock:
        if t is not None:
            val = float(t)
        elif t1 is not None or t2 is not None:
            a = float(t1) if t1 is not None else float(_HEATER_STATE.get("t") or 0.0)
            b = float(t2) if t2 is not None else float(_HEATER_STATE.get("t") or 0.0)
            # Prefer the non-zero side when only one is provided
            if t1 is not None and t2 is None:
                val = a
            elif t2 is not None and t1 is None:
                val = b
            else:
                val = max(a, b)
        else:
            return dict(_HEATER_STATE)
        _HEATER_STATE["t"] = val
        _HEATER_STATE["t1"] = val
        _HEATER_STATE["t2"] = val
        return dict(_HEATER_STATE)


def get_bath_owners() -> List[str]:
    with _heater_lock:
        return sorted(_BATH_OWNERS)


def _owner_label(owner: str) -> str:
    return _BATH_OWNER_LABELS.get(owner, owner)


def _bath_busy_payload_unlocked(owner: str, exclusive: bool, current: float, owners: List[str]) -> Dict[str, Any]:
    """Build conflict/busy payload without taking locks (caller holds _heater_lock)."""
    return {
        "ok": False,
        "error": "bath_busy" if exclusive else "bath_temp_conflict",
        "code": "bath_busy" if exclusive else "bath_temp_conflict",
        "currentTemp": current,
        "owners": list(owners),
        "ownerLabels": [_owner_label(o) for o in owners],
        "message": (
            f"Bath is in use by {', '.join(_owner_label(o) for o in owners)}. "
            f"Turn off preheating and retry."
            if exclusive
            else (
                f"Bath is already set to {current:.1f}°C "
                f"({', '.join(_owner_label(o) for o in owners)}). "
                f"Both baskets must use the same temperature."
            )
        ),
        "requestedOwner": owner,
    }


def _bath_busy_payload(owner: str, exclusive: bool = False) -> Dict[str, Any]:
    heater = get_heater_state()
    owners = get_bath_owners()
    current = float(heater.get("t") or 0.0)
    return _bath_busy_payload_unlocked(owner, exclusive, current, owners)


def request_bath(
    owner: str,
    temp: float,
    *,
    exclusive: bool = False,
) -> Dict[str, Any]:
    """
    Claim the shared bath at `temp` for `owner`.

    - If bath is off: send PHW,temp, clear TR, add owner.
    - If bath is on at the same setpoint: add owner (reuse heat).
    - If bath is on at a different setpoint: reject with bath_temp_conflict.
    - If exclusive and any other owner holds it: reject with bath_busy.
    """
    global _last_preheat_time
    owner = str(owner or "").strip().lower()
    if owner not in _BATH_OWNER_LABELS:
        return {"ok": False, "error": f"unknown bath owner: {owner}"}
    try:
        temp = _clamp_temp(float(temp))
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid temperature"}

    need_phw = False
    owners_after: List[str] = []
    with _heater_lock:
        current = float(_HEATER_STATE.get("t") or 0.0)
        owners = set(_BATH_OWNERS)
        others = owners - {owner}

        if exclusive and others:
            return _bath_busy_payload_unlocked(owner, True, current, sorted(owners))

        if current > 0 and abs(current - temp) > 0.05 and others:
            return _bath_busy_payload_unlocked(owner, False, current, sorted(owners))

        same_setpoint = current > 0 and abs(current - temp) <= 0.05
        need_phw = not same_setpoint or current <= 0

        _HEATER_STATE["t"] = temp
        _HEATER_STATE["t1"] = temp
        _HEATER_STATE["t2"] = temp
        _BATH_OWNERS.add(owner)
        owners_after = sorted(_BATH_OWNERS)

    with _live_state_lock:
        if need_phw:
            _live_state["TR"] = False
            _live_state["TR1"] = False
            _live_state["TR2"] = False
        _live_state["bathOwners"] = owners_after
        _live_state["heater"] = {"t": temp, "t1": temp, "t2": temp}

    result: Dict[str, Any]
    if need_phw:
        cmd = f"PHW,{temp:.1f}"
        result = send_command(cmd)
        _last_preheat_time = time.time()
        result["phwSent"] = True
        result["cmd"] = cmd
    else:
        result = {"ok": True, "phwSent": False, "cmd": None}

    result["heater"] = get_heater_state()
    result["owners"] = owners_after
    result["owner"] = owner
    result["temp"] = temp
    return result


def release_bath(owner: str, *, force_off: bool = False) -> Dict[str, Any]:
    """
    Release bath ownership. When no owners remain (or force_off), send PHW,0.0.
    """
    global _last_preheat_time
    owner = str(owner or "").strip().lower()
    with _heater_lock:
        _BATH_OWNERS.discard(owner)
        remaining = sorted(_BATH_OWNERS)
        turn_off = force_off or not remaining
        if turn_off:
            _BATH_OWNERS.clear()
            remaining = []
            _HEATER_STATE["t"] = 0.0
            _HEATER_STATE["t1"] = 0.0
            _HEATER_STATE["t2"] = 0.0

    with _live_state_lock:
        _live_state["bathOwners"] = remaining
        if turn_off:
            _live_state["TR"] = False
            _live_state["TR1"] = False
            _live_state["TR2"] = False
        _live_state["heater"] = get_heater_state()

    result: Dict[str, Any]
    if turn_off:
        result = send_command("PHW,0.0")
        _last_preheat_time = time.time()
        result["phwSent"] = True
        result["cmd"] = "PHW,0.0"
    else:
        result = {"ok": True, "phwSent": False, "cmd": None}

    result["heater"] = get_heater_state()
    result["owners"] = remaining
    result["owner"] = owner
    result["turnedOff"] = turn_off
    return result


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
        state["bathOwners"] = get_bath_owners()
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


def _update_bath_temps(ir: float, ext1: float, ext2: float) -> Dict[str, Any]:
    """Single bath IR mirrored into IR1 and IR2."""
    return _update_temps(ir1=ir, ir2=ir, ext1=ext1, ext2=ext2)


def _update_strokes(s1: Optional[int] = None, s2: Optional[int] = None) -> None:
    with _live_state_lock:
        if s1 is not None:
            _live_state["S1"] = int(s1)
        if s2 is not None:
            _live_state["S2"] = int(s2)
        _live_state["updatedAt"] = time.time()


def get_stroke_counts() -> Dict[str, int]:
    with _live_state_lock:
        return {"S1": int(_live_state.get("S1") or 0), "S2": int(_live_state.get("S2") or 0)}


def reset_stroke_baseline() -> Dict[str, int]:
    """Snapshot current counters as baseline for validation delta counting."""
    return dict(get_stroke_counts())


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


def _emit_tr(basket: Optional[int] = None) -> None:
    """
    Emit ready. basket=None means shared bath TR — set TR and both TR1/TR2,
    broadcast type=TR plus TR1/TR2 so existing consumers still work.
    """
    with _live_state_lock:
        _live_state["TR"] = True
        if basket is None:
            _live_state["TR1"] = True
            _live_state["TR2"] = True
        else:
            _live_state[f"TR{basket}"] = True
        _live_state["updatedAt"] = time.time()

    if basket is None:
        _broadcast_sse({"type": "TR", "kind": "tr", "mock": is_mock_mode()})
        _broadcast_sse({"type": "TR1", "kind": "tr", "basket": 1, "mock": is_mock_mode()})
        _broadcast_sse({"type": "TR2", "kind": "tr", "basket": 2, "mock": is_mock_mode()})
        if _logger:
            _logger.info("[TS] Emitted TR (shared bath ready, mock=%s)", is_mock_mode())
    else:
        _broadcast_sse({
            "type": f"TR{basket}",
            "kind": "tr",
            "basket": basket,
            "mock": is_mock_mode(),
        })
        if _logger:
            _logger.info("[TS] Emitted TR%s - basket %s ready (mock=%s)", basket, basket, is_mock_mode())


def _handle_ts_response(line: str) -> None:
    compact = line.strip().upper().replace(" ", "")
    if compact == "TR" or compact.endswith(":TR"):
        _emit_tr(None)
        return
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
    if kind == "temps_te":
        parsed = parse_te(line)
        if parsed:
            ir, e1, e2 = parsed
            payload.update({"IR1": ir, "IR2": ir, "EXT1": e1, "EXT2": e2, "type": "temps"})
    elif kind == "temps":
        tag = "T1" if normalize_line(line).upper().startswith("T1") else "T2"
        parsed = parse_t1_t2(line, tag)
        if parsed:
            ir, ext = parsed
            if tag == "T1":
                payload.update({"IR1": ir, "EXT1": ext})
            else:
                payload.update({"IR2": ir, "EXT2": ext})
    elif kind == "temps_bulk":
        bulk = parse_temp_bulk(line) or {}
        payload.update(bulk)
        payload["type"] = "temps"
    elif kind == "stroke_count":
        try:
            payload["count"] = int(normalize_line(line))
            payload["type"] = "stroke_count"
        except ValueError:
            pass
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
    if kind == "temps_te":
        cache = _update_bath_temps(
            float(payload["IR1"]),
            float(payload.get("EXT1") or 0.0),
            float(payload.get("EXT2") or 0.0),
        )
        _emit_temps_sse(cache)
        return payload
    if kind == "temps":
        if "IR1" in payload:
            cache = _update_temps(ir1=payload.get("IR1"), ext1=payload.get("EXT1"))
            _emit_temps_sse(cache)
            return payload
        if "IR2" in payload:
            cache = _update_temps(ir2=payload.get("IR2"), ext2=payload.get("EXT2"))
            _emit_temps_sse(cache)
            return payload
    if kind == "temps_bulk":
        cache = _update_temps(
            ir1=payload.get("IR1"),
            ir2=payload.get("IR2"),
            ext1=payload.get("EXT1"),
            ext2=payload.get("EXT2"),
        )
        _emit_temps_sse(cache)
        return payload
    if kind == "ts":
        _handle_ts_response(line)
        return payload
    if kind == "stroke_count":
        try:
            n = int(payload.get("count") or normalize_line(line))
        except (TypeError, ValueError):
            return payload
        if not _stroke_count_accept(n):
            return payload
        basket = get_stroke_validation_basket()
        if basket == 2:
            _update_strokes(s2=n)
        else:
            _update_strokes(s1=n)
        counts = get_stroke_counts()
        _broadcast_sse({
            "type": "stroke_count",
            "kind": "stroke_count",
            "count": n,
            "basket": basket,
            "S1": counts["S1"],
            "S2": counts["S2"],
            "mock": is_mock_mode(),
        })
        _broadcast_sse({
            "type": "stroke",
            "kind": "stroke",
            "S1": counts["S1"],
            "S2": counts["S2"],
            "mock": is_mock_mode(),
        })
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
# Serial open / write
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
    """Fire-and-forget style: write command; DT firmware often does not ack."""
    if not cmd:
        return {"ok": False, "error": "Empty command"}
    cmd = cmd.strip()
    if is_mock_mode():
        _append_uart_log("TX_MOCK", cmd)
        return {"ok": True, "response": "ok", "normalized": "ok", "kind": "ok", "cmd": cmd, "mock": True}
    ok = esp_write_line(cmd, max_retries=max_retries)
    if not ok:
        return {"ok": False, "error": "write failed", "cmd": cmd}
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


def _read_te_from_queue(timeout: float = 2.0) -> Optional[Tuple[float, float, float]]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            remaining = max(0.05, deadline - time.time())
            line = line_q.get(timeout=remaining)
        except queue.Empty:
            break
        if is_ts_response_line(line):
            _handle_ts_response(line)
            continue
        parsed = parse_te(line)
        if parsed is not None:
            return parsed
    return None


def _temperature_polling_thread() -> None:
    """Poll ESP32 with TE. Single shared bath: same IR in IR1 & IR2; E1/E2 -> EXT1/EXT2."""
    if "TEMP_POLL_INTERVAL" in _config:
        poll_interval = max(0.05, float(_config["TEMP_POLL_INTERVAL"]))
    else:
        poll_hz = float(_config.get("TEMP_POLL_HZ", 2.0))
        poll_interval = max(0.05, 1.0 / max(0.25, poll_hz))
    read_timeout = float(_config.get("TEMP_READ_TIMEOUT", 2.0))
    ts_interval = float(_config.get("TS_POLL_INTERVAL", 3.0))
    ts_tolerance = float(_config.get("TS_TEMP_TOLERANCE", 1.0))
    last_ts_time = 0.0
    if _logger:
        _logger.info(
            "[TEMP POLLER] TE single-bath poll: interval %.3fs; TS every %.1fs when within ±%.1f°C",
            poll_interval,
            ts_interval,
            ts_tolerance,
        )
    time.sleep(0.3)
    while True:
        try:
            if is_mock_mode():
                time.sleep(poll_interval)
                continue
            if _calibration_in_progress:
                time.sleep(1.0)
                continue
            if is_stroke_validation_active():
                time.sleep(0.5)
                continue
            if (time.time() - _last_preheat_time) < float(
                _config.get("PREHEAT_COOLDOWN", _preheat_cooldown)
            ):
                time.sleep(0.2)
                continue

            te_result = None
            if esp_write_line("TE"):
                te_result = _read_te_from_queue(timeout=read_timeout)

            if te_result is not None:
                ir_v, e1_v, e2_v = te_result
                cache = _update_bath_temps(ir_v, e1_v, e2_v)
                _emit_temps_sse(cache)

            heater = get_heater_state()
            cache = get_latest_temps()
            ir = cache.get("IR1")
            t_set = float(heater.get("t") or heater.get("t1") or 0.0)
            near = t_set > 0 and ir is not None and abs(float(ir) - t_set) <= ts_tolerance
            if near and (time.time() - last_ts_time >= ts_interval):
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
    """Simulate shared bath temps, TR ready, and stroke pulses."""
    last_stroke = 0.0
    last_temp = 0.0
    while True:
        try:
            if not is_mock_mode():
                time.sleep(0.5)
                continue
            now = time.time()
            heater = get_heater_state()
            target = float(heater.get("t") or heater.get("t1") or 0.0)
            with _mock_lock:
                cur = float(_mock_temps["IR1"])
                if target > 0:
                    step = 0.8 if cur < target else -0.4
                    if abs(cur - target) < 0.3:
                        cur = target + ((-1) ** int(now) * 0.05)
                    else:
                        cur = cur + step
                else:
                    cur = cur + (25.0 - cur) * 0.05
                _mock_temps["IR1"] = round(cur, 2)
                _mock_temps["IR2"] = round(cur, 2)
                _mock_temps["EXT1"] = round(cur - 0.4, 2)
                _mock_temps["EXT2"] = round(cur - 0.5, 2)

                if now - last_temp >= 0.5:
                    last_temp = now
                    cache = _update_bath_temps(
                        _mock_temps["IR1"],
                        _mock_temps["EXT1"],
                        _mock_temps["EXT2"],
                    )
                    _emit_temps_sse(cache)
                    # TR when within ±1°C of bath setpoint (match TS_TEMP_TOLERANCE)
                    if target > 0 and abs(float(_mock_temps["IR1"]) - target) <= 1.0:
                        with _live_state_lock:
                            already = bool(_live_state.get("TR"))
                        if not already:
                            _emit_tr(None)

                if _mock_emit_strokes and (now - last_stroke >= 2.0):
                    last_stroke = now
                    for b in (1, 2):
                        if _mock_running.get(str(b)):
                            sk = f"S{b}"
                            _mock_strokes[sk] = int(_mock_strokes.get(sk) or 0) + 1
                    _update_strokes(_mock_strokes["S1"], _mock_strokes["S2"])
                    if is_stroke_validation_active():
                        basket = get_stroke_validation_basket()
                        count = _mock_strokes[f"S{basket}"]
                        _broadcast_sse({
                            "type": "stroke_count",
                            "kind": "stroke_count",
                            "count": count,
                            "basket": basket,
                            "S1": _mock_strokes["S1"],
                            "S2": _mock_strokes["S2"],
                            "mock": True,
                        })
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


def cmd_preheat(t1: float = 0.0, t2: float = 0.0, temp: Optional[float] = None) -> Dict[str, Any]:
    """
    Send PHW,<t> for the shared bath.

    Prefer `temp`. Legacy t1/t2 collapse to max(t1, t2). Callers that need
    ownership semantics should use request_bath / release_bath instead.
    """
    global _last_preheat_time
    if temp is not None:
        t = _clamp_temp(temp)
    else:
        t = _clamp_temp(max(float(t1 or 0.0), float(t2 or 0.0)))
    set_heater_state(t=t)
    with _live_state_lock:
        _live_state["TR"] = False
        _live_state["TR1"] = False
        _live_state["TR2"] = False
    cmd = f"PHW,{t:.1f}"
    result = send_command(cmd)
    _last_preheat_time = time.time()
    result["heater"] = get_heater_state()
    return result


def cmd_start_b1(temp: float) -> Dict[str, Any]:
    temp = _clamp_temp(temp)
    set_heater_state(t=temp)
    if is_mock_mode():
        with _mock_lock:
            _mock_running["1"] = True
    with _live_state_lock:
        _live_state["running"] = True
    return send_command(f"START,1,{temp:.1f}")


def cmd_start_b2(temp: float) -> Dict[str, Any]:
    temp = _clamp_temp(temp)
    set_heater_state(t=temp)
    if is_mock_mode():
        with _mock_lock:
            _mock_running["2"] = True
    with _live_state_lock:
        _live_state["running"] = True
    return send_command(f"START,2,{temp:.1f}")


def cmd_start_b3(t1: float, t2: float) -> Dict[str, Any]:
    t1 = _clamp_temp(t1)
    t2 = _clamp_temp(t2)
    t = max(t1, t2)
    set_heater_state(t=t)
    if is_mock_mode():
        with _mock_lock:
            _mock_running["1"] = True
            _mock_running["2"] = True
    with _live_state_lock:
        _live_state["running"] = True
    return send_command(f"START,3,{t1:.1f},{t2:.1f}")


def cmd_start_stroke(basket: int = 1) -> Dict[str, Any]:
    """START,VAL,<n> — stroke-only start. Pauses TE/TS polling."""
    b = 1 if int(basket or 1) != 2 else 2
    set_stroke_validation_active(True, basket=b)
    time.sleep(0.5)
    if is_mock_mode():
        with _mock_lock:
            _mock_running[str(b)] = True
            # Reset mock stroke counter for this basket so delta counting starts clean
            _mock_strokes[f"S{b}"] = 0
    with _live_state_lock:
        _live_state["running"] = True
        if b == 1:
            _live_state["S1"] = 0
        else:
            _live_state["S2"] = 0
    result = send_command(f"START,VAL,{b}")
    if not result.get("ok"):
        set_stroke_validation_active(False)
        if is_mock_mode():
            with _mock_lock:
                _mock_running[str(b)] = False
    return result


def cmd_query_temps_bulk() -> Dict[str, Any]:
    """Legacy TEMP bulk query — firmware no longer supports it; use live TE cache."""
    cache = get_latest_temps()
    return {"ok": True, "temps": cache, "cmd": None, "note": "TE poller provides live temps"}


def cmd_stop(basket: Optional[int] = None) -> Dict[str, Any]:
    """Stop motors only. Heat is released via release_bath by callers.

    Some DT_BATH firmwares also clear the heater on STOP1/STOP2. When the
    shared bath still has owners, re-assert PHW after the stop so the peer
    basket (or manual/validation heat) keeps running.
    """
    if basket == 1:
        cmd = "STOP1"
        if is_mock_mode():
            with _mock_lock:
                _mock_running["1"] = False
    elif basket == 2:
        cmd = "STOP2"
        if is_mock_mode():
            with _mock_lock:
                _mock_running["2"] = False
    else:
        cmd = "STOP"
        if is_mock_mode():
            with _mock_lock:
                _mock_running["1"] = False
                _mock_running["2"] = False

    if is_stroke_validation_active():
        set_stroke_validation_active(False)

    with _mock_lock:
        any_mock = bool(_mock_running.get("1") or _mock_running.get("2"))
    if basket not in (1, 2) or not any_mock:
        owners = get_bath_owners()
        peer_owners = [o for o in owners if o.startswith("basket")]
        if basket == 1:
            peer_active = "basket2" in peer_owners or any_mock
        elif basket == 2:
            peer_active = "basket1" in peer_owners or any_mock
        else:
            peer_active = False
        if not peer_active:
            with _live_state_lock:
                _live_state["running"] = False
    result = send_command(cmd)

    # Re-assert bath heat after single-basket stop if anyone still owns it.
    if basket in (1, 2) and result.get("ok") is not False:
        heater = get_heater_state()
        bath_t = float(heater.get("t") or 0.0)
        if bath_t > 0 and get_bath_owners():
            reassert = send_command(f"PHW,{bath_t:.1f}")
            result["phwReasserted"] = True
            result["phwCmd"] = f"PHW,{bath_t:.1f}"
            if reassert.get("ok") is False:
                result["phwReassertOk"] = False
                result["phwReassertError"] = reassert.get("error") or reassert.get("response")
            else:
                result["phwReassertOk"] = True
    return result


def cmd_calibrate(sensor: str, temp: float) -> Dict[str, Any]:
    global _calibration_in_progress
    sensor = str(sensor or "").strip().upper()
    # Map legacy IR1/IR2 to shared IR channel
    if sensor in ("IR1", "IR2"):
        sensor = "IR"
    if sensor not in ("IR", "EXT1", "EXT2"):
        return {"ok": False, "error": "sensor must be IR, EXT1, or EXT2"}
    try:
        temp = float(temp)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid temperature"}
    if temp < 0 or temp > MAX_TEMP_C:
        return {"ok": False, "error": f"temperature must be 0-{MAX_TEMP_C}°C"}

    before_key = "IR1" if sensor == "IR" else sensor
    before = get_latest_temps().get(before_key)
    _calibration_in_progress = True
    try:
        result = send_command(f"CAL,{sensor},{temp:.1f}")
        result["sensor"] = sensor
        result["setTemperature"] = temp
        result["beforeValue"] = before
        result["afterValue"] = temp
        result["mock"] = is_mock_mode()
        if is_mock_mode():
            if sensor == "IR":
                _update_temps(ir1=temp, ir2=temp)
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
        "bathOwners": get_bath_owners(),
    }


def start_sse_stream():
    def gen():
        q: queue.Queue = queue.Queue(maxsize=100)
        sse_clients.append(q)
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
        _logger.info("[DT HW] Initialized single-bath TE protocol (mock=%s)", _mock_mode)
