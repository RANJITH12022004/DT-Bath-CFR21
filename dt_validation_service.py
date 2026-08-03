#!/usr/bin/env python3
"""
dt_validation_service.py - Stroke rate and temperature hold validation.

Stroke: real ESP32 S1/S2 deltas over 60s; FAIL if no pulses; PASS if 29-32 /min.
Temp: 2-minute hold; pass if (maxTemp - minTemp) / 2 <= 0.5 °C.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

import dt_hardware_service as hw

_lock = threading.Lock()
_logger = None
_audit_fn: Optional[Callable] = None
_sessions: Dict[str, Dict[str, Any]] = {}

STROKE_DURATION_SEC = 60
# After START,STROKE the basket travels to the stroke start position before counting.
STROKE_TRAVEL_DELAY_SEC = 2.5
STROKE_MIN = 29
STROKE_MAX = 32
TEMP_HOLD_SEC = 120
TEMP_DEVIATION_LIMIT = 0.5


def init(logger=None, audit_fn: Optional[Callable] = None) -> None:
    global _logger, _audit_fn
    _logger = logger
    _audit_fn = audit_fn


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _audit(action: str, details: str = "", **extra) -> None:
    if not _audit_fn:
        return
    try:
        _audit_fn(action, details, **extra)
    except Exception:
        pass


def get_session(kind: str, basket: int) -> Optional[Dict[str, Any]]:
    key = f"{kind}:{basket}"
    with _lock:
        s = _sessions.get(key)
        if not s:
            return None
        out = dict(s)
    # Live remaining countdown for UI (1-min stroke / 2-min temp hold)
    state = out.get("state")
    if kind == "stroke" and state == "STARTING":
        # Travel-to-start delay — timer has not begun yet
        out["remainingSec"] = int(out.get("durationSec") or STROKE_DURATION_SEC)
        out["travelRemainingSec"] = max(
            0.0,
            float(out.get("travelDelaySec") or STROKE_TRAVEL_DELAY_SEC)
            - (time.time() - float(out.get("commandAtEpoch") or time.time())),
        )
    elif kind == "stroke" and state == "RUNNING":
        started = float(out.get("startedAtEpoch") or 0)
        dur = float(out.get("durationSec") or STROKE_DURATION_SEC)
        out["remainingSec"] = max(0, int(round(dur - (time.time() - started))))
    elif kind == "temp" and state == "HOLDING":
        started = float(out.get("holdStartedAtEpoch") or 0)
        dur = float(out.get("durationSec") or TEMP_HOLD_SEC)
        out["remainingSec"] = max(0, int(round(dur - (time.time() - started))))
    elif kind == "temp" and state == "PREHEAT":
        out["remainingSec"] = int(out.get("durationSec") or TEMP_HOLD_SEC)
    return out


def get_all() -> Dict[str, Any]:
    with _lock:
        return {"ok": True, "sessions": {k: dict(v) for k, v in _sessions.items()}, "mock": hw.is_mock_mode()}


# -------------------- Stroke validation --------------------

def start_stroke_validation(basket: int, operator: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    basket = int(basket)
    if basket not in (1, 2):
        return {"ok": False, "error": "basket must be 1 or 2"}
    key = f"stroke:{basket}"
    with _lock:
        existing = _sessions.get(key)
        if existing and existing.get("state") in ("STARTING", "RUNNING"):
            return {"ok": False, "error": "stroke validation already running"}

    # Dt_Dr_Reddy / setting up.md: START,STROKE,Bx,A (stroke-only, not test START)
    # Timer / pulse window starts only after STROKE_TRAVEL_DELAY_SEC (basket travels to start).
    command_at = time.time()
    hw_result = hw.cmd_start_stroke(basket)
    if not hw_result.get("ok"):
        return {"ok": False, "error": hw_result.get("error") or "failed to start stroke motor", "hardware": hw_result}

    session = {
        "kind": "stroke",
        "basket": basket,
        "state": "STARTING",
        "commandAt": _now_iso(),
        "commandAtEpoch": command_at,
        "travelDelaySec": STROKE_TRAVEL_DELAY_SEC,
        "startedAt": None,
        "startedAtEpoch": None,
        "durationSec": STROKE_DURATION_SEC,
        "baseline": None,
        "pulsesSeen": 0,
        "strokesPerMin": None,
        "remainingSec": STROKE_DURATION_SEC,
        "status": None,
        "passed": None,
        "sensorSilent": False,
        "mock": hw.is_mock_mode(),
        "operatorName": (operator or {}).get("name"),
        "operatorId": (operator or {}).get("employeeId") or (operator or {}).get("id"),
        "operatorUsername": (operator or {}).get("username"),
        "endedAt": None,
        "error": None,
    }
    with _lock:
        _sessions[key] = session
    _audit(
        "Validation started",
        f"Stroke validation | Beaker {basket} | travel {STROKE_TRAVEL_DELAY_SEC}s then 60 s count",
        entity_type="validation",
        entity_id=f"stroke-{basket}",
        extra={
            "basket": basket,
            "kind": "stroke",
            "travelDelaySec": STROKE_TRAVEL_DELAY_SEC,
            "mock": hw.is_mock_mode(),
        },
    )
    threading.Thread(
        target=_stroke_worker,
        args=(basket,),
        daemon=True,
        name=f"dt-stroke-val-{basket}",
    ).start()
    return {"ok": True, "session": dict(session), "hardware": hw_result}


def _build_stroke_report(session: Dict[str, Any], basket: int) -> Dict[str, Any]:
    status = session.get("status") or "FAILED"
    actual = session.get("pulsesSeen")
    if actual is None:
        actual = session.get("strokesPerMin")
    strokes_per_min = session.get("strokesPerMin")
    if strokes_per_min is None:
        strokes_per_min = actual
    return {
        "type": "validation",
        "validationSubtype": "stroke",
        "name": f"Validation Report – Stroke (Basket {basket})",
        "status": status,
        "strokesPerMin": strokes_per_min,
        "pulsesSeen": actual,
        "actualStrokes": actual,
        "requiredRange": f"{STROKE_MIN}-{STROKE_MAX}",
        "requiredMin": STROKE_MIN,
        "requiredMax": STROKE_MAX,
        "durationSec": session.get("durationSec") or STROKE_DURATION_SEC,
        "beaker": basket,
        "basket": basket,
        "operatorName": session.get("operatorName"),
        "operatorId": session.get("operatorId"),
        "operatorUsername": session.get("operatorUsername"),
        "employeeId": session.get("operatorId") or session.get("operatorUsername"),
        "operatedByUsername": session.get("operatorUsername") or session.get("operatorId"),
        "mock": session.get("mock"),
        "sensorSilent": session.get("sensorSilent"),
        "error": session.get("error"),
        "aborted": session.get("state") == "ABORTED" or status == "ABORTED",
        "createdAt": _now_iso(),
        "completedAt": session.get("endedAt"),
        "testStartTime": session.get("startedAt"),
        "testEndTime": session.get("endedAt"),
    }


def _stroke_worker(basket: int) -> None:
    key = f"stroke:{basket}"
    stroke_key = f"S{basket}"
    try:
        with _lock:
            session = _sessions.get(key) or {}
            command_at = float(session.get("commandAtEpoch") or time.time())
            travel_delay = float(session.get("travelDelaySec") or STROKE_TRAVEL_DELAY_SEC)

        # Wait for basket to reach stroke start position before counting.
        while True:
            with _lock:
                cur_sess = _sessions.get(key)
                if not cur_sess or cur_sess.get("state") == "ABORTED":
                    return
            elapsed = time.time() - command_at
            if elapsed >= travel_delay:
                break
            time.sleep(0.05)

        # Baseline AFTER travel so move-to-start pulses are not counted.
        baseline = hw.reset_stroke_baseline()
        measure_start = time.time()
        with _lock:
            cur_sess = _sessions.get(key)
            if not cur_sess or cur_sess.get("state") == "ABORTED":
                return
            _sessions[key].update({
                "state": "RUNNING",
                "baseline": baseline,
                "startedAt": _now_iso(),
                "startedAtEpoch": measure_start,
                "pulsesSeen": 0,
                "remainingSec": STROKE_DURATION_SEC,
            })
            started = measure_start

        deadline = started + STROKE_DURATION_SEC
        last_count = int((baseline or {}).get(stroke_key) or 0)
        pulses = 0
        saw_any_line = False
        while time.time() < deadline:
            with _lock:
                cur_sess = _sessions.get(key)
                if not cur_sess or cur_sess.get("state") == "ABORTED":
                    return
            counts = hw.get_stroke_counts()
            cur = int(counts.get(stroke_key) or 0)
            if cur > last_count:
                pulses += cur - last_count
                last_count = cur
                saw_any_line = True
            elif cur < last_count:
                # controller reset — re-baseline, do not add negative
                last_count = cur
            with _lock:
                if key in _sessions and _sessions[key].get("state") == "RUNNING":
                    _sessions[key]["pulsesSeen"] = pulses
                    _sessions[key]["currentCount"] = cur
                    rem = max(0, int(round(deadline - time.time())))
                    _sessions[key]["remainingSec"] = rem
            time.sleep(0.2)

        with _lock:
            cur_sess = _sessions.get(key)
            if not cur_sess or cur_sess.get("state") == "ABORTED":
                return

        # Final sample
        counts = hw.get_stroke_counts()
        cur = int(counts.get(stroke_key) or 0)
        if cur > last_count:
            pulses += cur - last_count
            saw_any_line = True

        hw.cmd_stop(basket)

        silent = not saw_any_line and pulses == 0
        strokes_per_min = pulses  # 60s window
        if silent:
            passed = False
            status = "FAILED"
            error = "Stroke sensor silent — no S1/S2 pulses received"
        else:
            passed = STROKE_MIN <= strokes_per_min <= STROKE_MAX
            status = "PASSED" if passed else "FAILED"
            error = None

        with _lock:
            if key not in _sessions or _sessions[key].get("state") == "ABORTED":
                return
            _sessions[key].update({
                "state": "COMPLETE",
                "endedAt": _now_iso(),
                "pulsesSeen": pulses,
                "strokesPerMin": strokes_per_min,
                "remainingSec": 0,
                "passed": passed,
                "status": status,
                "sensorSilent": silent,
                "error": error,
            })
            session = dict(_sessions[key])

        report = _build_stroke_report(session, basket)
        with _lock:
            if key in _sessions and _sessions[key].get("state") == "COMPLETE":
                _sessions[key]["report"] = report

        _audit(
            "Validation finished",
            f"Stroke validation | Beaker {basket} | result {status} | {strokes_per_min} strokes/min",
            entity_type="validation",
            entity_id=f"stroke-{basket}",
            outcome="success" if passed else "failure",
            extra={
                "basket": basket,
                "strokesPerMin": strokes_per_min,
                "status": status,
                "sensorSilent": silent,
                "travelDelaySec": STROKE_TRAVEL_DELAY_SEC,
                "mock": hw.is_mock_mode(),
            },
        )
    except Exception as e:
        hw.cmd_stop(basket)
        with _lock:
            if key in _sessions and _sessions[key].get("state") != "ABORTED":
                _sessions[key].update({
                    "state": "ABORTED",
                    "error": str(e),
                    "status": "FAILED",
                    "passed": False,
                    "endedAt": _now_iso(),
                })
                sess = dict(_sessions[key])
                _sessions[key]["report"] = _build_stroke_report(sess, basket)
        if _logger:
            _logger.exception("stroke validation failed")


def abort_stroke_validation(basket: int) -> Dict[str, Any]:
    basket = int(basket)
    key = f"stroke:{basket}"
    hw.cmd_stop(basket)
    with _lock:
        if key in _sessions:
            sess = _sessions[key]
            # Keep last pulses seen for aborted report
            pulses = sess.get("pulsesSeen")
            _sessions[key].update({
                "state": "ABORTED",
                "status": "ABORTED",
                "passed": False,
                "endedAt": _now_iso(),
                "remainingSec": 0,
                "error": "aborted by operator",
                "strokesPerMin": pulses if pulses is not None else sess.get("strokesPerMin"),
            })
            out = dict(_sessions[key])
            _sessions[key]["report"] = _build_stroke_report(out, basket)
            out = dict(_sessions[key])
        else:
            out = {}
    _audit("Validation aborted", f"Stroke validation | Beaker {basket} | aborted by operator", entity_type="validation", entity_id=f"stroke-{basket}", outcome="aborted")
    return {"ok": True, "session": out}


# -------------------- Temperature validation --------------------

def start_temp_validation(
    basket: int,
    set_temperature: float,
    operator: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    basket = int(basket)
    if basket not in (1, 2):
        return {"ok": False, "error": "basket must be 1 or 2"}
    try:
        temp = float(set_temperature)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid setTemperature"}
    if temp < 20 or temp > 55:
        return {"ok": False, "error": "setTemperature must be 20-55°C"}

    key = f"temp:{basket}"
    with _lock:
        existing = _sessions.get(key)
        if existing and existing.get("state") in ("PREHEAT", "HOLDING", "RUNNING"):
            return {"ok": False, "error": "temp validation already running"}

    heater = hw.get_heater_state()
    t1 = temp if basket == 1 else 0.0
    t2 = temp if basket == 2 else 0.0
    # Preserve other basket heater if needed — for validation isolate to selected beaker
    if basket == 1:
        t2 = 0.0
    else:
        t1 = 0.0
    hw_result = hw.cmd_preheat(t1=t1, t2=t2)
    if not hw_result.get("ok"):
        return {"ok": False, "error": hw_result.get("error") or "preheat failed", "hardware": hw_result}

    session = {
        "kind": "temp",
        "basket": basket,
        "state": "PREHEAT",
        "setTemperature": temp,
        "startedAt": _now_iso(),
        "holdStartedAt": None,
        "holdStartedAtEpoch": None,
        "durationSec": TEMP_HOLD_SEC,
        "minTemp": None,
        "maxTemp": None,
        "maxDeviation": None,
        "samples": [],
        "status": None,
        "passed": None,
        "mock": hw.is_mock_mode(),
        "operatorName": (operator or {}).get("name"),
        "operatorId": (operator or {}).get("employeeId") or (operator or {}).get("id"),
        "operatorUsername": (operator or {}).get("username"),
        "endedAt": None,
        "error": None,
    }
    with _lock:
        _sessions[key] = session
    _audit(
        "Validation started",
        f"Temperature validation | Beaker {basket} | setpoint {temp}°C | hold 120 s",
        entity_type="validation",
        entity_id=f"temp-{basket}",
        extra={"basket": basket, "kind": "temp", "setTemperature": temp, "mock": hw.is_mock_mode()},
    )
    threading.Thread(
        target=_temp_worker,
        args=(basket,),
        daemon=True,
        name=f"dt-temp-val-{basket}",
    ).start()
    return {"ok": True, "session": dict(session), "hardware": hw_result}


def _temp_worker(basket: int) -> None:
    key = f"temp:{basket}"
    ir_key = "IR1" if basket == 1 else "IR2"
    try:
        # Wait for TR ready (up to 10 minutes)
        ready_deadline = time.time() + 600
        while time.time() < ready_deadline:
            with _lock:
                session = _sessions.get(key)
                if not session or session.get("state") == "ABORTED":
                    return
            live = hw.get_live_state()
            temps = hw.get_latest_temps()
            # Also treat within ±3°C as ready for mock reliability
            set_t = None
            with _lock:
                set_t = (_sessions.get(key) or {}).get("setTemperature")
            ir = temps.get(ir_key)
            near = set_t is not None and ir is not None and abs(float(ir) - float(set_t)) <= 3.0
            if live.get(f"TR{basket}") or near:
                break
            time.sleep(0.5)
        else:
            with _lock:
                if key in _sessions:
                    _sessions[key].update({
                        "state": "ABORTED",
                        "status": "FAILED",
                        "passed": False,
                        "error": "timeout waiting for temperature ready",
                        "endedAt": _now_iso(),
                    })
            hw.cmd_stop(basket)
            return

        with _lock:
            if key not in _sessions or _sessions[key].get("state") == "ABORTED":
                return
            _sessions[key]["state"] = "HOLDING"
            _sessions[key]["holdStartedAt"] = _now_iso()
            _sessions[key]["holdStartedAtEpoch"] = time.time()

        hold_end = time.time() + TEMP_HOLD_SEC
        min_t = None
        max_t = None
        samples = []
        while time.time() < hold_end:
            with _lock:
                if key not in _sessions or _sessions[key].get("state") == "ABORTED":
                    hw.cmd_stop(basket)
                    return
            ir = hw.get_latest_temps().get(ir_key)
            if ir is not None:
                t = float(ir)
                samples.append({"t": _now_iso(), "temp": t})
                if min_t is None or t < min_t:
                    min_t = t
                if max_t is None or t > max_t:
                    max_t = t
                with _lock:
                    if key in _sessions:
                        _sessions[key]["minTemp"] = min_t
                        _sessions[key]["maxTemp"] = max_t
                        _sessions[key]["samples"] = samples[-200:]
                        if min_t is not None and max_t is not None:
                            _sessions[key]["maxDeviation"] = round((max_t - min_t) / 2.0, 3)
            time.sleep(0.5)

        hw.cmd_stop(basket)

        if min_t is None or max_t is None:
            passed = False
            status = "FAILED"
            max_dev = None
            error = "no temperature samples during hold"
        else:
            max_dev = round((max_t - min_t) / 2.0, 3)
            passed = max_dev <= TEMP_DEVIATION_LIMIT
            status = "PASSED" if passed else "FAILED"
            error = None

        with _lock:
            if key not in _sessions:
                return
            _sessions[key].update({
                "state": "COMPLETE",
                "endedAt": _now_iso(),
                "minTemp": min_t,
                "maxTemp": max_t,
                "maxDeviation": max_dev,
                "passed": passed,
                "status": status,
                "error": error,
            })
            session = dict(_sessions[key])

        report = {
            "type": "validation",
            "validationSubtype": "temp",
            "name": f"Validation Report – Temperature (Basket {basket})",
            "status": status,
            "setTemperature": session.get("setTemperature"),
            "minTemp": min_t,
            "maxTemp": max_t,
            "maxDeviation": max_dev,
            "requiredDeviation": TEMP_DEVIATION_LIMIT,
            "beaker": basket,
            "basket": basket,
            "operatorName": session.get("operatorName"),
            "operatorId": session.get("operatorId"),
            "operatorUsername": session.get("operatorUsername"),
            "employeeId": session.get("operatorId") or session.get("operatorUsername"),
            "operatedByUsername": session.get("operatorUsername") or session.get("operatorId"),
            "mock": session.get("mock"),
            "error": error,
            "createdAt": _now_iso(),
            "completedAt": session.get("endedAt"),
            "testStartTime": session.get("holdStartedAt") or session.get("startedAt"),
            "testEndTime": session.get("endedAt"),
        }
        with _lock:
            _sessions[key]["report"] = report

        _audit(
            "Validation finished",
            f"Temperature validation | Beaker {basket} | result {status} | deviation ±{max_dev}°C | range {min_t}–{max_t}°C",
            entity_type="validation",
            entity_id=f"temp-{basket}",
            outcome="success" if passed else "failure",
            extra={
                "basket": basket,
                "minTemp": min_t,
                "maxTemp": max_t,
                "maxDeviation": max_dev,
                "status": status,
                "mock": hw.is_mock_mode(),
            },
        )
    except Exception as e:
        hw.cmd_stop(basket)
        with _lock:
            if key in _sessions:
                _sessions[key].update({
                    "state": "ABORTED",
                    "error": str(e),
                    "status": "FAILED",
                    "passed": False,
                    "endedAt": _now_iso(),
                })
        if _logger:
            _logger.exception("temp validation failed")


def abort_temp_validation(basket: int) -> Dict[str, Any]:
    basket = int(basket)
    key = f"temp:{basket}"
    hw.cmd_stop(basket)
    with _lock:
        if key in _sessions:
            _sessions[key].update({
                "state": "ABORTED",
                "status": "ABORTED",
                "passed": False,
                "endedAt": _now_iso(),
                "error": "aborted by operator",
            })
            sess = dict(_sessions[key])
            report = {
                "type": "validation",
                "validationSubtype": "temp",
                "name": f"Validation Report – Temperature (Basket {basket})",
                "status": "ABORTED",
                "setTemperature": sess.get("setTemperature"),
                "minTemp": sess.get("minTemp"),
                "maxTemp": sess.get("maxTemp"),
                "maxDeviation": sess.get("maxDeviation"),
                "requiredDeviation": TEMP_DEVIATION_LIMIT,
                "beaker": basket,
                "basket": basket,
                "operatorName": sess.get("operatorName"),
                "operatorId": sess.get("operatorId"),
                "operatorUsername": sess.get("operatorUsername"),
                "mock": sess.get("mock"),
                "error": sess.get("error"),
                "aborted": True,
                "createdAt": _now_iso(),
                "completedAt": sess.get("endedAt"),
                "testStartTime": sess.get("holdStartedAt") or sess.get("startedAt"),
                "testEndTime": sess.get("endedAt"),
            }
            _sessions[key]["report"] = report
            out = dict(_sessions[key])
        else:
            out = {}
    _audit("Validation aborted", f"Temperature validation | Beaker {basket} | aborted by operator", entity_type="validation", entity_id=f"temp-{basket}", outcome="aborted")
    return {"ok": True, "session": out}


def consume_report(kind: str, basket: int) -> Optional[Dict[str, Any]]:
    """Return and clear the completed report payload for saving."""
    key = f"{kind}:{basket}"
    with _lock:
        session = _sessions.get(key)
        if not session:
            return None
        report = session.get("report")
        return dict(report) if report else None


def _stroke_run_from_payload(stroke: Dict[str, Any], basket: int) -> Dict[str, Any]:
    """Normalize a stroke result (session report or client snapshot) into a validationRuns entry."""
    s = dict(stroke or {})
    status = s.get("status") or "FAILED"
    pulses = s.get("pulsesSeen")
    if pulses is None:
        pulses = s.get("actualStrokes")
    if pulses is None:
        pulses = s.get("strokesPerMin")
    spm = s.get("strokesPerMin")
    if spm is None:
        spm = pulses
    return {
        "validationSubtype": "stroke",
        "usp": "Stroke",
        "status": status,
        "strokesPerMin": spm,
        "pulsesSeen": pulses,
        "actualStrokes": pulses,
        "actualTapCount": pulses,
        "requiredRange": s.get("requiredRange") or f"{STROKE_MIN}-{STROKE_MAX}",
        "requiredMin": s.get("requiredMin", STROKE_MIN),
        "requiredMax": s.get("requiredMax", STROKE_MAX),
        "durationSec": s.get("durationSec") or STROKE_DURATION_SEC,
        "beaker": basket,
        "basket": basket,
        "sensorSilent": s.get("sensorSilent"),
        "error": s.get("error"),
        "completedAt": s.get("completedAt") or s.get("testEndTime") or s.get("endedAt"),
        "testStartTime": s.get("testStartTime") or s.get("startedAt"),
        "testEndTime": s.get("testEndTime") or s.get("endedAt") or s.get("completedAt"),
    }


def _temp_run_from_payload(temp: Dict[str, Any], basket: int) -> Dict[str, Any]:
    t = dict(temp or {})
    return {
        "validationSubtype": "temp",
        "usp": "Temperature",
        "status": t.get("status") or "FAILED",
        "setTemperature": t.get("setTemperature"),
        "minTemp": t.get("minTemp"),
        "maxTemp": t.get("maxTemp"),
        "maxDeviation": t.get("maxDeviation"),
        "requiredDeviation": t.get("requiredDeviation", TEMP_DEVIATION_LIMIT),
        "beaker": basket,
        "basket": basket,
        "error": t.get("error"),
        "durationSec": t.get("durationSec") or TEMP_HOLD_SEC,
        "completedAt": t.get("completedAt") or t.get("testEndTime") or t.get("endedAt"),
        "testStartTime": t.get("testStartTime") or t.get("holdStartedAt") or t.get("startedAt"),
        "testEndTime": t.get("testEndTime") or t.get("endedAt") or t.get("completedAt"),
    }


def build_combined_validation_report(
    basket: int,
    *,
    stroke_payload: Optional[Dict[str, Any]] = None,
    temp_payload: Optional[Dict[str, Any]] = None,
    pending_due: Optional[Dict[str, Any]] = None,
    operator: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Build one pending validation report with stroke + temp runs.
    Consumes completed temp session report when temp_payload is omitted.
    """
    basket = int(basket)
    stroke_src = dict(stroke_payload or {})
    if not stroke_src:
        stroke_src = consume_report("stroke", basket) or {}
    temp_src = dict(temp_payload or {})
    if not temp_src:
        temp_src = consume_report("temp", basket) or {}
        # Also clear stroke if still present
        try:
            consume_report("stroke", basket)
        except Exception:
            pass

    stroke_run = _stroke_run_from_payload(stroke_src, basket)
    temp_run = _temp_run_from_payload(temp_src, basket)
    stroke_pass = str(stroke_run.get("status") or "").upper() == "PASSED"
    temp_pass = str(temp_run.get("status") or "").upper() == "PASSED"
    overall = "PASSED" if (stroke_pass and temp_pass) else "FAILED"

    op = operator or {}
    op_name = (
        stroke_src.get("operatorName")
        or temp_src.get("operatorName")
        or op.get("name")
    )
    op_id = (
        stroke_src.get("operatorId")
        or temp_src.get("operatorId")
        or op.get("employeeId")
        or op.get("id")
    )
    op_user = (
        stroke_src.get("operatorUsername")
        or temp_src.get("operatorUsername")
        or op.get("username")
    )

    due = dict(pending_due or {}) if isinstance(pending_due, dict) else {}
    if due:
        due.setdefault("dueKind", "validation")
        due.setdefault("beaker", basket)

    report = {
        "type": "validation",
        "validationSubtype": "combined",
        "name": f"Validation Report – Stroke & Temperature (Basket {basket})",
        "status": overall,
        "beaker": basket,
        "basket": basket,
        "validationRuns": [stroke_run, temp_run],
        # Flat convenience fields (stroke primary + temp)
        "strokesPerMin": stroke_run.get("strokesPerMin"),
        "pulsesSeen": stroke_run.get("pulsesSeen"),
        "actualStrokes": stroke_run.get("actualStrokes"),
        "requiredRange": stroke_run.get("requiredRange"),
        "setTemperature": temp_run.get("setTemperature"),
        "minTemp": temp_run.get("minTemp"),
        "maxTemp": temp_run.get("maxTemp"),
        "maxDeviation": temp_run.get("maxDeviation"),
        "requiredDeviation": temp_run.get("requiredDeviation"),
        "operatorName": op_name,
        "operatorId": op_id,
        "operatorUsername": op_user,
        "employeeId": op_id or op_user,
        "operatedByUsername": op_user or op_id,
        "mock": bool(stroke_src.get("mock") or temp_src.get("mock") or hw.is_mock_mode()),
        "pendingValidationDue": due or None,
        "createdAt": _now_iso(),
        "completedAt": temp_run.get("completedAt") or stroke_run.get("completedAt") or _now_iso(),
        "testStartTime": stroke_run.get("testStartTime"),
        "testEndTime": temp_run.get("testEndTime") or stroke_run.get("testEndTime"),
    }
    return report


def build_aborted_combined_validation_report(
    basket: int,
    *,
    stroke_payload: Optional[Dict[str, Any]] = None,
    temp_payload: Optional[Dict[str, Any]] = None,
    phase: Optional[str] = None,
    operator: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Build one pending aborted validation report for Beaker 1/2.
    Uses client stroke snapshot when provided; otherwise consumes session reports
    after abort_stroke/abort_temp have stamped them.
    """
    basket = int(basket)
    stroke_src = dict(stroke_payload or {}) if isinstance(stroke_payload, dict) else {}
    if not stroke_src:
        stroke_src = consume_report("stroke", basket) or {}
    temp_src = dict(temp_payload or {}) if isinstance(temp_payload, dict) else {}
    if not temp_src:
        temp_src = consume_report("temp", basket) or {}

    phase_l = str(phase or "").strip().lower()
    stroke_done = bool(stroke_src) and str(stroke_src.get("status") or "").upper() in (
        "PASSED",
        "FAILED",
        "ABORTED",
    )
    # Mid-stroke abort: force aborted stroke run even if session snapshot is partial
    if not stroke_src or phase_l == "stroke" or (
        phase_l in ("", "stroke") and not stroke_done
    ):
        if not stroke_src:
            stroke_src = {}
        stroke_src = dict(stroke_src)
        stroke_src["status"] = "ABORTED"
        stroke_src["aborted"] = True
        stroke_src.setdefault("error", "aborted by operator")
    elif str(stroke_src.get("status") or "").upper() not in ("PASSED", "FAILED", "ABORTED"):
        stroke_src = dict(stroke_src)
        stroke_src["status"] = "ABORTED"
        stroke_src["aborted"] = True
        stroke_src.setdefault("error", "aborted by operator")

    # Temp not started or in progress → aborted run
    temp_finished = str(temp_src.get("status") or "").upper() in ("PASSED", "FAILED")
    if not temp_src or not temp_finished:
        temp_src = dict(temp_src or {})
        temp_src["status"] = "ABORTED"
        temp_src["aborted"] = True
        if not temp_src.get("error"):
            temp_src["error"] = (
                "not started — session aborted"
                if phase_l in ("stroke", "between", "") and not temp_finished
                else "aborted by operator"
            )

    report = build_combined_validation_report(
        basket,
        stroke_payload=stroke_src,
        temp_payload=temp_src,
        pending_due=None,
        operator=operator,
    )
    report["status"] = "ABORTED"
    report["aborted"] = True
    report["abortCause"] = "operator"
    report["pendingValidationDue"] = None
    report["name"] = f"Validation Report – Stroke & Temperature (Basket {basket})"
    # Mark runs aborted where needed
    runs = []
    for run in report.get("validationRuns") or []:
        r = dict(run or {})
        if str(r.get("status") or "").upper() not in ("PASSED", "FAILED"):
            r["status"] = "ABORTED"
        runs.append(r)
    report["validationRuns"] = runs
    return report
