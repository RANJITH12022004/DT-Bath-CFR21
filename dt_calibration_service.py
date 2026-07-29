#!/usr/bin/env python3
"""
dt_calibration_service.py - Temperature sensor calibration with audit trail.

Requires permission (calibration-menu) and an approval-verify token (purpose=calibration)
enforced at the route layer. This module applies CAL and returns before/after values.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

import dt_hardware_service as hw

_logger = None
_audit_fn: Optional[Callable] = None

SENSORS = ("IR1", "IR2", "EXT1", "EXT2")


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


def sensor_for_beaker(beaker: int, probe: str = "IR") -> str:
    """Map beaker + probe type to sensor id."""
    beaker = int(beaker)
    probe = str(probe or "IR").strip().upper()
    if beaker not in (1, 2):
        raise ValueError("beaker must be 1 or 2")
    if probe in ("IR", "IR1", "IR2"):
        return f"IR{beaker}"
    if probe in ("EXT", "EXT1", "EXT2", "EXTERNAL"):
        return f"EXT{beaker}"
    raise ValueError("probe must be IR or EXT")


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
        sensor_id = str(sensor).strip().upper()
    else:
        try:
            sensor_id = sensor_for_beaker(int(beaker), probe)
        except (TypeError, ValueError) as e:
            return {"ok": False, "error": str(e)}

    if sensor_id not in SENSORS:
        return {"ok": False, "error": f"sensor must be one of {', '.join(SENSORS)}"}

    before = hw.get_latest_temps().get(sensor_id)
    result = hw.cmd_calibrate(sensor_id, temperature)
    if not result.get("ok"):
        _audit(
            "Calibration failed",
            f"{sensor_id} cal to {temperature}°C failed",
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
        "beaker": 1 if sensor_id.endswith("1") else 2,
        "probe": "IR" if sensor_id.startswith("IR") else "EXT",
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
        f"{sensor_id}: before={before} after={after} set={temperature}",
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

    # Optional calibration report payload for saving as validation report
    report = {
        "type": "validation",
        "validationSubtype": "calibration",
        "name": f"Calibration Report – {sensor_id}",
        "status": "CALIBRATED & PASSED",
        "setTemperature": float(temperature),
        "measuredTemperature": after,
        "beforeValue": before,
        "deviation": payload["deviation"],
        "calibrationOffset": payload["calibrationOffset"],
        "beaker": payload["beaker"],
        "basket": payload["beaker"],
        "sensor": sensor_id,
        "operatorName": payload["operatorName"],
        "operatorId": payload["operatorId"],
        "operatorUsername": payload["operatorUsername"],
        "approvedBy": payload.get("verifierName"),
        "approvedByUsername": payload.get("verifierUsername"),
        "mock": payload["mock"],
        "createdAt": _now_iso(),
        "completedAt": payload["calibratedAt"],
    }
    payload["report"] = report
    return payload
