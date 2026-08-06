#!/usr/bin/env python3
"""
dt_calibration_service.py - Shared-bath temperature sensor calibration with audit trail.

DT Bath CFR: one internal IR channel + EXT1 + EXT2. calibrate_bath() sends
CAL,IR / CAL,EXT1 / CAL,EXT2 with a single reference temperature.

Requires permission (calibration-menu) and an approval-verify token (purpose=calibration)
enforced at the route layer.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional
import time

import dt_hardware_service as hw

_logger = None
_audit_fn: Optional[Callable] = None

# Shared-bath sensors (firmware tokens)
BATH_SENSORS = ("IR", "EXT1", "EXT2")
# Legacy aliases still accepted by calibrate()
SENSORS = ("IR", "IR1", "IR2", "EXT1", "EXT2")


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


def _normalize_sensor(sensor: str) -> str:
    s = str(sensor or "").strip().upper()
    if s in ("IR1", "IR2"):
        return "IR"
    return s


def _before_key(sensor: str) -> str:
    """Map firmware sensor token to live-temps cache key."""
    s = _normalize_sensor(sensor)
    if s == "IR":
        return "IR1"
    return s


def sensor_for_beaker(beaker: int, probe: str = "IR") -> str:
    """Legacy helper — shared bath maps any beaker IR to IR, EXT to EXT{n}."""
    beaker = int(beaker)
    probe = str(probe or "IR").strip().upper()
    if beaker not in (1, 2):
        raise ValueError("beaker must be 1 or 2")
    if probe in ("IR", "IR1", "IR2"):
        return "IR"
    if probe in ("EXT", "EXT1", "EXT2", "EXTERNAL"):
        return f"EXT{beaker}"
    raise ValueError("probe must be IR or EXT")


def calibrate_bath(
    *,
    temperature: float,
    operator: Optional[Dict[str, Any]] = None,
    verifier: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Calibrate the shared bath: CAL,IR then CAL,EXT1 then CAL,EXT2.
    Claims the bath exclusively for the duration.
    """
    try:
        temperature = float(temperature)
    except (TypeError, ValueError) as e:
        return {"ok": False, "error": str(e)}
    if temperature < 0 or temperature > 55:
        return {"ok": False, "error": "temperature must be 0-55°C"}

    # Exclusive claim — refuse if a test / manual heater holds the bath
    claim = hw.request_bath("calibration", temperature, exclusive=True)
    if not claim.get("ok"):
        err = claim.get("error") or claim.get("code") or "bath_busy"
        return {
            "ok": False,
            "error": err,
            "code": claim.get("code") or err,
            "message": claim.get("message") or err,
            "currentTemp": claim.get("currentTemp"),
            "owners": claim.get("owners"),
            "hardware": claim,
        }

    channel_results: List[Dict[str, Any]] = []
    try:
        for sensor in BATH_SENSORS:
            result = calibrate(
                sensor=sensor,
                temperature=temperature,
                operator=operator,
                verifier=verifier,
            )
            if not result.get("ok"):
                return {
                    "ok": False,
                    "error": result.get("error") or f"{sensor} calibration failed",
                    "failedSensor": sensor,
                    "channels": channel_results,
                    "partial": result,
                }
            channel_results.append({
                "sensor": sensor,
                "beforeValue": result.get("beforeValue"),
                "afterValue": result.get("afterValue"),
                "calibrationOffset": result.get("calibrationOffset"),
            })
            time.sleep(0.4)

        # Primary offset vs bath IR
        ir_ch = channel_results[0] if channel_results else {}
        before_ir = ir_ch.get("beforeValue")
        after_ir = ir_ch.get("afterValue")
        offset = None
        if before_ir is not None:
            try:
                offset = round(float(temperature) - float(before_ir), 3)
            except (TypeError, ValueError):
                offset = None

        details_parts = []
        for ch in channel_results:
            details_parts.append(
                f"{ch['sensor']}: {ch.get('beforeValue')}→{ch.get('afterValue')}"
            )
        details = "; ".join(details_parts) + f" (set {temperature}°C)"

        payload = {
            "ok": True,
            "sensor": "IR+EXT1+EXT2",
            "probe": "BATH",
            "beaker": None,
            "basket": None,
            "setTemperature": float(temperature),
            "beforeValue": before_ir,
            "afterValue": after_ir,
            "measuredTemperature": after_ir,
            "calibrationOffset": offset,
            "deviation": None if before_ir is None or after_ir is None else round(float(after_ir) - float(before_ir), 3),
            "sensors": channel_results,
            "status": "CALIBRATED & PASSED",
            "mock": hw.is_mock_mode(),
            "calibratedAt": _now_iso(),
            "operatorName": (operator or {}).get("name"),
            "operatorId": (operator or {}).get("employeeId") or (operator or {}).get("id"),
            "operatorUsername": (operator or {}).get("username"),
            "verifierUsername": (verifier or {}).get("username"),
            "verifierName": (verifier or {}).get("name"),
            "verifierRole": (verifier or {}).get("role"),
        }

        report = {
            "type": "calibration",
            "name": "Calibration Report – Temperature",
            "status": "CALIBRATED",
            "procedure": "Temperature Calibration",
            "beaker": None,
            "basket": None,
            "probe": "BATH",
            "operatorName": payload["operatorName"],
            "operatorId": payload["operatorId"],
            "operatorUsername": payload["operatorUsername"],
            "employeeId": payload.get("operatorId") or payload.get("operatorUsername"),
            "operatedByUsername": payload.get("operatorUsername") or payload.get("operatorId"),
            "approvedBy": payload.get("verifierName"),
            "approvedByUsername": payload.get("verifierUsername"),
            "mock": payload["mock"],
            "createdAt": _now_iso(),
            "completedAt": payload["calibratedAt"],
        }
        payload["report"] = report

        _audit(
            "Calibration performed",
            f"Shared bath | {details}"
            + (f" | verified by {payload.get('verifierUsername')}" if payload.get("verifierUsername") else ""),
            entity_type="calibration",
            entity_id="bath",
            outcome="success",
            signature={
                "mode": "approval-verify",
                "username": (verifier or {}).get("username"),
                "role": (verifier or {}).get("role"),
            } if verifier else None,
            extra={
                "sensor": "IR+EXT1+EXT2",
                "sensors": channel_results,
                "setTemperature": temperature,
                "mock": hw.is_mock_mode(),
            },
        )
        return payload
    finally:
        try:
            hw.release_bath("calibration")
        except Exception:
            pass


def calibrate_both(
    *,
    beaker: int = 1,
    temperature: float,
    operator: Optional[Dict[str, Any]] = None,
    verifier: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Backward-compatible entry: shared bath calibrates all three channels."""
    return calibrate_bath(
        temperature=temperature,
        operator=operator,
        verifier=verifier,
    )


def calibrate(
    *,
    sensor: Optional[str] = None,
    beaker: Optional[int] = None,
    probe: str = "IR",
    temperature: float,
    operator: Optional[Dict[str, Any]] = None,
    verifier: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if sensor:
        sensor_id = _normalize_sensor(sensor)
    else:
        try:
            sensor_id = sensor_for_beaker(int(beaker or 1), probe)
        except (TypeError, ValueError) as e:
            return {"ok": False, "error": str(e)}

    if sensor_id not in ("IR", "EXT1", "EXT2"):
        return {"ok": False, "error": f"sensor must be one of IR, EXT1, EXT2"}

    before = hw.get_latest_temps().get(_before_key(sensor_id))
    result = hw.cmd_calibrate(sensor_id, temperature)
    if not result.get("ok"):
        _audit(
            "Calibration failed",
            f"Shared bath | sensor {sensor_id} | measured {temperature}°C | failed",
            entity_type="calibration",
            entity_id=sensor_id,
            outcome="failure",
            extra={
                "sensor": sensor_id,
                "beforeValue": before,
                "setTemperature": temperature,
                "error": result.get("error"),
                "mock": hw.is_mock_mode(),
            },
        )
        return result

    after = result.get("afterValue", temperature)
    payload = {
        "ok": True,
        "sensor": sensor_id,
        "beaker": None,
        "probe": "IR" if sensor_id == "IR" else sensor_id,
        "setTemperature": float(temperature),
        "beforeValue": before,
        "afterValue": after,
        "measuredTemperature": after,
        "deviation": None if before is None else round(float(after) - float(before), 3),
        "calibrationOffset": None if before is None else round(float(temperature) - float(before), 3),
        "status": "CALIBRATED & PASSED",
        "mock": hw.is_mock_mode(),
        "calibratedAt": _now_iso(),
        "operatorName": (operator or {}).get("name"),
        "operatorId": (operator or {}).get("employeeId") or (operator or {}).get("id"),
        "operatorUsername": (operator or {}).get("username"),
        "verifierUsername": (verifier or {}).get("username"),
        "verifierName": (verifier or {}).get("name"),
        "verifierRole": (verifier or {}).get("role"),
    }

    _audit(
        "Calibration performed",
        f"Shared bath | sensor {sensor_id} | before {before}°C → after {after}°C | measured {temperature}°C"
        + (f" | verified by {payload.get('verifierUsername')}" if payload.get("verifierUsername") else ""),
        entity_type="calibration",
        entity_id=sensor_id,
        outcome="success",
        signature={
            "mode": "approval-verify",
            "username": (verifier or {}).get("username"),
            "role": (verifier or {}).get("role"),
        } if verifier else None,
        extra={
            "sensor": sensor_id,
            "beforeValue": before,
            "afterValue": after,
            "setTemperature": temperature,
            "mock": hw.is_mock_mode(),
            "changedFields": ["calibrationOffset", sensor_id],
            "before": {sensor_id: before},
            "after": {sensor_id: after},
        },
    )

    report = {
        "type": "calibration",
        "name": "Calibration Report – Temperature",
        "status": "CALIBRATED",
        "procedure": "Temperature Calibration",
        "beaker": None,
        "basket": None,
        "operatorName": payload["operatorName"],
        "operatorId": payload["operatorId"],
        "operatorUsername": payload["operatorUsername"],
        "employeeId": payload.get("operatorId") or payload.get("operatorUsername"),
        "operatedByUsername": payload.get("operatorUsername") or payload.get("operatorId"),
        "approvedBy": payload.get("verifierName"),
        "approvedByUsername": payload.get("verifierUsername"),
        "mock": payload["mock"],
        "createdAt": _now_iso(),
        "completedAt": payload["calibratedAt"],
    }
    payload["report"] = report
    return payload
