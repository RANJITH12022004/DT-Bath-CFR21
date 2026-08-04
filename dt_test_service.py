#!/usr/bin/env python3
"""
dt_test_service.py - Server-authoritative per-beaker disintegration test state machine.

States: IDLE -> PREHEAT -> READY -> AWAIT_CONFIRM -> RUNNING -> COMPLETE | ABORTED

Persists checkpoint to storage/test_run.json via data_service so power-loss recovery works.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import dt_hardware_service as hw

try:
    import data_service
except ImportError:
    data_service = None

_lock = threading.Lock()
_logger = None
_audit_fn: Optional[Callable] = None
_save_report_fn: Optional[Callable] = None
_runs: Dict[int, Dict[str, Any]] = {}  # basket_id -> run state
_last_saved_reports: Dict[int, Dict[str, Any]] = {}  # basket_id -> last auto-saved report
_watchdog_started = False

STATES = ("IDLE", "PREHEAT", "READY", "AWAIT_CONFIRM", "RUNNING", "COMPLETE", "ABORTED")


def init(logger=None, audit_fn: Optional[Callable] = None, save_report_fn: Optional[Callable] = None) -> None:
    global _logger, _audit_fn, _save_report_fn, _watchdog_started
    _logger = logger
    _audit_fn = audit_fn
    if save_report_fn is not None:
        _save_report_fn = save_report_fn
    if not _watchdog_started:
        _watchdog_started = True
        threading.Thread(target=_watchdog_loop, daemon=True, name="dt-test-watchdog").start()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _audit(action: str, details: str = "", **extra) -> None:
    if not _audit_fn:
        return
    try:
        _audit_fn(action, details, **extra)
    except Exception:
        if _logger:
            _logger.exception("dt_test audit failed")


def _empty_run(basket: int) -> Dict[str, Any]:
    return {
        "basket": basket,
        "state": "IDLE",
        "mode": "manual",
        "setTemperature": None,
        "setDurationMinutes": None,
        "basketConfig": 6,
        "productName": "",
        "batchNumber": "",
        "media": None,
        "mesh": None,
        "recipeId": None,
        "recipeName": "",
        "preheatStartedAt": None,
        "readyAt": None,
        "startedAt": None,
        "endedAt": None,
        "elapsedSeconds": 0,
        "remainingSeconds": None,
        "minTemp": None,
        "maxTemp": None,
        "meanTemp": None,
        "recordedTemps": [],
        "vesselTimes": {},
        "holeCompletionTimes": {},
        "holeCompletionTimestamps": {},
        "completedHoles": {},
        "status": None,
        "aborted": False,
        "abortReason": None,
        "mock": hw.is_mock_mode(),
        "operatorName": None,
        "operatorId": None,
        "operatorUsername": None,
        "updatedAt": _now_iso(),
    }


def _persist() -> None:
    if not data_service:
        return
    try:
        with _lock:
            payload = {
                "updatedAt": _now_iso(),
                "mock": hw.is_mock_mode(),
                "baskets": {str(k): dict(v) for k, v in _runs.items()},
            }
        if hasattr(data_service, "save_test_run_data"):
            data_service.save_test_run_data(payload)
        elif hasattr(data_service, "save_test_run"):
            data_service.save_test_run(payload)
    except Exception as e:
        if _logger:
            _logger.debug("test_run persist: %s", e)


def get_run(basket: int, *, consume_saved: bool = False) -> Dict[str, Any]:
    """Return run snapshot.

    lastSavedReport is attached when present. Pass consume_saved=True only from the
    client-facing GET so a one-shot handoff still works; internal callers (watchdog)
    must not consume it or the UI never sees the report id.
    """
    basket = int(basket)
    with _lock:
        if basket not in _runs:
            _runs[basket] = _empty_run(basket)
        out = dict(_runs[basket])
        if consume_saved:
            saved = _last_saved_reports.pop(basket, None)
        else:
            saved = _last_saved_reports.get(basket)
    if saved:
        out["savedReport"] = dict(saved) if isinstance(saved, dict) else saved
        out["lastSavedReport"] = out["savedReport"]
    return out


def clear_last_saved_report(basket: int) -> None:
    basket = int(basket)
    with _lock:
        _last_saved_reports.pop(basket, None)


def get_all_runs() -> Dict[str, Any]:
    with _lock:
        for b in (1, 2):
            if b not in _runs:
                _runs[b] = _empty_run(b)
        return {"ok": True, "mock": hw.is_mock_mode(), "baskets": {str(k): dict(v) for k, v in _runs.items()}}


def _set_state(basket: int, state: str, **fields) -> Dict[str, Any]:
    with _lock:
        if basket not in _runs:
            _runs[basket] = _empty_run(basket)
        run = _runs[basket]
        run["state"] = state
        run["updatedAt"] = _now_iso()
        run["mock"] = hw.is_mock_mode()
        for k, v in fields.items():
            run[k] = v
        out = dict(run)
    _persist()
    return out


def start_preheat(
    basket: int,
    *,
    set_temperature: float,
    mode: str = "manual",
    duration_minutes: Optional[float] = None,
    basket_config: int = 6,
    product_name: str = "",
    batch_number: str = "",
    recipe_id=None,
    recipe_name: str = "",
    media: Optional[str] = None,
    mesh: Optional[str] = None,
    operator_name: str = "",
    operator_id: str = "",
    operator_username: str = "",
) -> Dict[str, Any]:
    basket = int(basket)
    if basket not in (1, 2):
        return {"ok": False, "error": "basket must be 1 or 2"}
    mode = str(mode or "manual").strip().lower()
    if mode not in ("manual", "timer"):
        return {"ok": False, "error": "mode must be manual or timer"}
    try:
        temp = float(set_temperature)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid setTemperature"}
    if temp < 20 or temp > 55:
        return {"ok": False, "error": "setTemperature must be 20-55°C"}
    try:
        cfg = int(basket_config)
    except (TypeError, ValueError):
        cfg = 6
    if cfg not in (1, 3, 6):
        return {"ok": False, "error": "basketConfig must be 1, 3, or 6"}

    current = get_run(basket)
    if current.get("state") in ("PREHEAT", "READY", "AWAIT_CONFIRM", "RUNNING"):
        return {"ok": False, "error": f"basket {basket} already in state {current.get('state')}"}

    clear_last_saved_report(basket)

    dur = None
    if mode == "timer":
        try:
            dur = float(duration_minutes)
            if dur <= 0:
                return {"ok": False, "error": "duration_minutes required for timer mode"}
        except (TypeError, ValueError):
            return {"ok": False, "error": "duration_minutes required for timer mode"}

    # Send PHW for this basket only (preserve other basket heater)
    heater = hw.get_heater_state()
    t1 = temp if basket == 1 else float(heater.get("t1") or 0.0)
    t2 = temp if basket == 2 else float(heater.get("t2") or 0.0)
    hw_result = hw.cmd_preheat(t1=t1, t2=t2)
    if not hw_result.get("ok"):
        return {"ok": False, "error": hw_result.get("error") or "preheat failed", "hardware": hw_result}

    media_val = str(media).strip() if media is not None else None
    if media_val == "":
        media_val = None
    mesh_val = str(mesh).strip() if mesh is not None else None
    if mesh_val == "":
        mesh_val = None

    run = _set_state(
        basket,
        "PREHEAT",
        mode=mode,
        setTemperature=temp,
        setDurationMinutes=dur,
        basketConfig=cfg,
        productName=str(product_name or ""),
        batchNumber=str(batch_number or ""),
        media=media_val,
        mesh=mesh_val,
        recipeId=recipe_id,
        recipeName=str(recipe_name or product_name or ""),
        preheatStartedAt=_now_iso(),
        readyAt=None,
        startedAt=None,
        endedAt=None,
        elapsedSeconds=0,
        remainingSeconds=int(dur * 60) if dur else None,
        minTemp=None,
        maxTemp=None,
        meanTemp=None,
        recordedTemps=[],
        vesselTimes={},
        holeCompletionTimes={},
        holeCompletionTimestamps={},
        completedHoles={},
        status=None,
        aborted=False,
        abortReason=None,
        operatorName=operator_name,
        operatorId=operator_id,
        operatorUsername=operator_username,
    )
    product = product_name or run.get("productName") or run.get("recipeName") or "--"
    batch = batch_number or run.get("batchNumber") or "--"
    _audit(
        "Test preheat started",
        f"Beaker {basket} | product {product} | batch {batch} | setpoint {temp}°C | mode {mode}"
        + (f" | duration {dur} min" if dur else ""),
        entity_type="test_run",
        entity_id=str(basket),
        extra={
            "basket": basket,
            "setTemperature": temp,
            "mode": mode,
            "basketConfig": cfg,
            "productName": product_name,
            "batchNumber": batch_number,
            "mock": hw.is_mock_mode(),
        },
    )
    return {"ok": True, "run": run, "hardware": hw_result}


def on_temp_ready(basket: int) -> Dict[str, Any]:
    """Called when TR1/TR2 arrives (or polled). Transitions PREHEAT -> READY/AWAIT_CONFIRM."""
    basket = int(basket)
    current = get_run(basket)
    if current.get("state") != "PREHEAT":
        return {"ok": False, "error": f"basket {basket} not in PREHEAT", "run": current}
    run = _set_state(basket, "AWAIT_CONFIRM", readyAt=_now_iso())
    # Also mark READY for clients that look for it
    run["state"] = "AWAIT_CONFIRM"
    _audit("Test ready", f"Beaker {basket} reached setpoint — awaiting confirm to start", entity_type="test_run", entity_id=str(basket))
    return {"ok": True, "run": run}


def apply_run_setup(
    basket: int,
    *,
    product_name: str = "",
    batch_number: str = "",
    mode: Optional[str] = None,
    duration_minutes: Optional[float] = None,
    media: Optional[str] = None,
    mesh: Optional[str] = None,
    recipe_name: Optional[str] = None,
    set_temperature: Optional[float] = None,
) -> Dict[str, Any]:
    """Update product/batch/mode/setpoint on an in-progress preheat/ready run (quick test)."""
    basket = int(basket)
    current = get_run(basket)
    if current.get("state") not in ("PREHEAT", "READY", "AWAIT_CONFIRM"):
        return {"ok": False, "error": f"basket {basket} not awaiting start (state={current.get('state')})"}

    fields: Dict[str, Any] = {}
    name = str(product_name or "").strip()
    if name:
        fields["productName"] = name
        fields["recipeName"] = str(recipe_name or name)
    batch = str(batch_number or "").strip()
    if batch:
        fields["batchNumber"] = batch
    if set_temperature is not None and str(set_temperature).strip() != "":
        try:
            temp = float(set_temperature)
            if 20 <= temp <= 55:
                fields["setTemperature"] = temp
        except (TypeError, ValueError):
            pass
    if mode is not None:
        mode_l = str(mode or "manual").strip().lower()
        if mode_l not in ("manual", "timer"):
            return {"ok": False, "error": "mode must be manual or timer"}
        fields["mode"] = mode_l
        if mode_l == "timer":
            try:
                dur = float(duration_minutes)
                if dur <= 0:
                    return {"ok": False, "error": "duration_minutes required for timer mode"}
            except (TypeError, ValueError):
                return {"ok": False, "error": "duration_minutes required for timer mode"}
            fields["setDurationMinutes"] = dur
            fields["remainingSeconds"] = int(dur * 60)
        else:
            fields["setDurationMinutes"] = None
            fields["remainingSeconds"] = None
    if media is not None:
        fields["media"] = str(media).strip() or None
    if mesh is not None:
        fields["mesh"] = str(mesh).strip() or None
    if not fields:
        return {"ok": False, "error": "no setup fields provided"}
    run = _set_state(basket, current.get("state") or "AWAIT_CONFIRM", **fields)
    return {"ok": True, "run": run}


def confirm_start(basket: int) -> Dict[str, Any]:
    basket = int(basket)
    current = get_run(basket)
    state = str(current.get("state") or "")
    if state not in ("READY", "AWAIT_CONFIRM", "PREHEAT"):
        return {
            "ok": False,
            "error": f"basket {basket} not ready to start (state={state or 'IDLE'})",
            "run": current,
        }

    temp = float(current.get("setTemperature") or 37.0)
    if basket == 1:
        hw_result = hw.cmd_start_b1(temp)
    else:
        hw_result = hw.cmd_start_b2(temp)
    if not hw_result.get("ok"):
        return {"ok": False, "error": hw_result.get("error") or "start failed", "hardware": hw_result}

    dur = current.get("setDurationMinutes")
    remaining = int(float(dur) * 60) if current.get("mode") == "timer" and dur else None
    run = _set_state(
        basket,
        "RUNNING",
        startedAt=_now_iso(),
        elapsedSeconds=0,
        remainingSeconds=remaining,
        minTemp=None,
        maxTemp=None,
        meanTemp=None,
        recordedTemps=[],
        vesselTimes={},
        holeCompletionTimes={},
        holeCompletionTimestamps={},
        completedHoles={},
    )
    product = run.get("productName") or run.get("recipeName") or "--"
    batch = run.get("batchNumber") or "--"
    mode = run.get("mode") or "manual"
    temp = run.get("setTemperature")
    detail_parts = [
        f"Beaker {basket}",
        f"product {product}",
        f"batch {batch}",
        f"mode {mode}",
    ]
    if temp is not None:
        detail_parts.append(f"setpoint {temp}°C")
    if mode == "timer" and run.get("setDurationMinutes") is not None:
        detail_parts.append(f"duration {run.get('setDurationMinutes')} min")
    _audit(
        "Test started",
        " | ".join(detail_parts),
        entity_type="test_run",
        entity_id=str(basket),
        extra={"basket": basket, "mock": hw.is_mock_mode()},
    )
    return {"ok": True, "run": run, "hardware": hw_result}


def record_temp_sample(basket: int, temp_c: float) -> None:
    basket = int(basket)
    try:
        t = float(temp_c)
    except (TypeError, ValueError):
        return
    with _lock:
        run = _runs.get(basket)
        if not run or run.get("state") != "RUNNING":
            return
        run["recordedTemps"].append({"t": _now_iso(), "temp": t})
        # Keep last 500 samples
        if len(run["recordedTemps"]) > 500:
            run["recordedTemps"] = run["recordedTemps"][-500:]
        if run["minTemp"] is None or t < float(run["minTemp"]):
            run["minTemp"] = t
        if run["maxTemp"] is None or t > float(run["maxTemp"]):
            run["maxTemp"] = t
        temps = []
        for sample in run.get("recordedTemps") or []:
            try:
                temps.append(float(sample.get("temp")))
            except (TypeError, ValueError, AttributeError):
                continue
        if temps:
            run["meanTemp"] = round(sum(temps) / len(temps), 2)
        run["updatedAt"] = _now_iso()


def tap_vessel(basket: int, vessel: int) -> Dict[str, Any]:
    """Operator marks a tube complete (manual mode). Server stamps RTC time."""
    basket = int(basket)
    vessel = int(vessel)
    current = get_run(basket)
    if current.get("state") != "RUNNING":
        return {"ok": False, "error": "test not running"}
    if current.get("mode") != "manual":
        return {"ok": False, "error": "hole tapping disabled in timer mode"}
    cfg = int(current.get("basketConfig") or 6)
    if vessel < 1 or vessel > cfg:
        return {"ok": False, "error": f"vessel must be 1..{cfg}"}

    started = current.get("startedAt")
    try:
        start_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
        elapsed = max(0, int((datetime.now(timezone.utc) - start_dt.astimezone(timezone.utc)).total_seconds()))
    except Exception:
        elapsed = int(current.get("elapsedSeconds") or 0)

    hh = elapsed // 3600
    mm = (elapsed % 3600) // 60
    ss = elapsed % 60
    formatted = f"{hh:02d}:{mm:02d}:{ss:02d}"

    with _lock:
        run = _runs[basket]
        holes = dict(run.get("completedHoles") or {})
        if holes.get(str(vessel)):
            out = dict(run)
            already = True
        else:
            already = False
            holes[str(vessel)] = True
            run["completedHoles"] = holes
            vt = dict(run.get("vesselTimes") or {})
            vt[str(vessel)] = formatted
            run["vesselTimes"] = vt
            hct = dict(run.get("holeCompletionTimes") or {})
            hct[str(vessel)] = elapsed
            run["holeCompletionTimes"] = hct
            hcts = dict(run.get("holeCompletionTimestamps") or {})
            hcts[str(vessel)] = _now_iso()
            run["holeCompletionTimestamps"] = hcts
            run["updatedAt"] = _now_iso()
            out = dict(run)
    if not already:
        _persist()
        # Intentionally no per-tube audit — trails stay readable (start / finish / abort only).
        pass

    # All vessels done? (also on re-tap of an already-marked tube so a missed
    # auto-stop cannot leave the stroke motor running.)
    if len(out.get("completedHoles") or {}) >= cfg and out.get("state") == "RUNNING":
        return stop_test(basket, aborted=False, reason="all_tubes_complete")
    return {"ok": True, "run": out, "already": already}


def stop_test(basket: int, *, aborted: bool = False, reason: str = "") -> Dict[str, Any]:
    basket = int(basket)
    current = get_run(basket)
    prior_state = str(current.get("state") or "")
    if prior_state not in ("RUNNING", "PREHEAT", "READY", "AWAIT_CONFIRM"):
        return {"ok": False, "error": f"basket {basket} not active", "run": current}

    hw.cmd_stop(basket)

    # Pure preheat / await-confirm stop (motor never started) — Hardness-style lifecycle audit
    preheat_phase = prior_state in ("PREHEAT", "READY", "AWAIT_CONFIRM")
    reason_l = str(reason or "").strip().lower()
    is_preheat_stop = preheat_phase and (
        aborted
        or reason_l in (
            "preheat_abort",
            "start_cancelled",
            "nav_abort",
            "operator_abort",
        )
    )

    started = current.get("startedAt")
    elapsed = int(current.get("elapsedSeconds") or 0)
    if started and prior_state == "RUNNING":
        try:
            start_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
            elapsed = max(0, int((datetime.now(timezone.utc) - start_dt.astimezone(timezone.utc)).total_seconds()))
        except Exception:
            pass

    status = "Test Aborted" if aborted else "Completed"
    final_state = "ABORTED" if aborted else "COMPLETE"
    run = _set_state(
        basket,
        final_state,
        endedAt=_now_iso(),
        elapsedSeconds=elapsed,
        status=status,
        aborted=bool(aborted),
        abortReason=reason or ("operator_abort" if aborted else ""),
    )
    report = build_report_payload(run)
    product = run.get("productName") or run.get("recipeName") or "--"
    batch = run.get("batchNumber") or "--"
    tubes = len(run.get("completedHoles") or {})
    cfg = int(run.get("basketConfig") or 6)
    mm, ss = (elapsed // 60), (elapsed % 60)
    elapsed_str = f"{mm:02d}:{ss:02d}"
    set_t = run.get("setTemperature")

    if is_preheat_stop:
        detail = (
            f"Beaker {basket} | product {product} | batch {batch} | preheat stopped"
            + (f" | setpoint {set_t}°C" if set_t is not None else "")
            + (f" | reason {reason}" if reason else "")
        )
        action = "Test preheat stopped"
        outcome = "aborted" if aborted else "success"
    elif aborted:
        reason_txt = reason or "operator_abort"
        detail = (
            f"Beaker {basket} | product {product} | batch {batch} | aborted ({reason_txt}) "
            f"| elapsed {elapsed_str} | tubes {tubes}/{cfg}"
        )
        action = "Test aborted"
        outcome = "aborted"
    else:
        detail = (
            f"Beaker {basket} | product {product} | batch {batch} | completed "
            f"| elapsed {elapsed_str} | tubes {tubes}/{cfg}"
        )
        action = "Test finished"
        outcome = "success"
    _audit(
        action,
        detail,
        entity_type="test_run",
        entity_id=str(basket),
        outcome=outcome,
        extra={
            "basket": basket,
            "status": status,
            "reason": reason,
            "priorState": prior_state,
            "mock": hw.is_mock_mode(),
        },
    )
    saved = None
    # Do not auto-save a pending report for preheat-only stop (operator never started the test)
    if is_preheat_stop:
        clear_run(basket)
        return {"ok": True, "run": run, "report": None, "savedReport": None, "preheatStopped": True}

    if _save_report_fn and report:
        try:
            to_save = dict(report)
            to_save["reportApprovalStatus"] = "pending"
            for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
                to_save.pop(k, None)
            saved = _save_report_fn(to_save)
            with _lock:
                if saved:
                    _last_saved_reports[basket] = dict(saved) if isinstance(saved, dict) else {"id": saved}
            clear_run(basket)
        except Exception as e:
            if _logger:
                _logger.exception("auto-save report from stop_test failed: %s", e)
    return {"ok": True, "run": run, "report": report, "savedReport": saved}


def build_report_payload(run: Dict[str, Any]) -> Dict[str, Any]:
    basket = int(run.get("basket") or 1)
    mode = run.get("mode") or "manual"
    set_dur = run.get("setDurationMinutes")
    set_dur_sec = int(float(set_dur) * 60) if set_dur is not None else None
    elapsed = int(run.get("elapsedSeconds") or 0)
    hh, mm, ss = elapsed // 3600, (elapsed % 3600) // 60, elapsed % 60
    duration_str = f"{hh:02d}:{mm:02d}:{ss:02d}"
    name = run.get("recipeName") or run.get("productName") or f"Basket {basket} Test"
    product = run.get("productName") or name
    batch = run.get("batchNumber") or ""
    media_val = run.get("media")
    mesh_val = run.get("mesh")
    mean_temp = run.get("meanTemp")
    if mean_temp is None:
        temps = []
        for sample in run.get("recordedTemps") or []:
            try:
                temps.append(float(sample.get("temp")))
            except (TypeError, ValueError, AttributeError):
                continue
        if temps:
            mean_temp = round(sum(temps) / len(temps), 2)
    op_name = run.get("operatorName") or ""
    op_user = str(run.get("operatorUsername") or "").strip()
    op_id = str(run.get("operatorId") or "").strip() or op_user
    emp_id = op_id or op_user
    report = {
        "type": "test",
        "validationSubtype": None,
        "name": name,
        "productName": product,
        "productName1": run.get("productName") if basket == 1 else None,
        "productName2": run.get("productName") if basket == 2 else None,
        "batch1": run.get("batchNumber") if basket == 1 else None,
        "batch2": run.get("batchNumber") if basket == 2 else None,
        "batchNumber": batch,
        "media": media_val,
        "mesh": mesh_val,
        "recipe": {
            "id": run.get("recipeId"),
            "name": name,
            "productName": product,
            "batchNumber": batch,
            "media": media_val,
            "mesh": mesh_val,
            "quickTest": not bool(run.get("recipeId")),
        },
        "mode": mode,
        "setTemperature": run.get("setTemperature"),
        "setDuration": set_dur_sec,
        "setDurationMinutes": set_dur,
        "duration": duration_str,
        "durationSeconds": elapsed,
        "status": run.get("status") or "Completed",
        "beaker": basket,
        "basket": basket,
        "basketConfig": run.get("basketConfig") or 6,
        "holeCompletionTimes": run.get("holeCompletionTimes") or {},
        "holeCompletionTimestamps": run.get("holeCompletionTimestamps") or {},
        "vesselTimes": run.get("vesselTimes") or {},
        "testStartTime": run.get("startedAt"),
        "testEndTime": run.get("endedAt"),
        "minTemp": run.get("minTemp"),
        "maxTemp": run.get("maxTemp"),
        "meanTemp": mean_temp,
        "operatorName": op_name,
        "operatorId": op_id,
        "operatorUsername": op_user,
        "operatedByUsername": op_user or op_id,
        "employeeId": emp_id,
        "mock": bool(run.get("mock")),
        "createdAt": _now_iso(),
        "completedAt": run.get("endedAt") or _now_iso(),
    }
    return report


def clear_run(basket: int) -> Dict[str, Any]:
    basket = int(basket)
    with _lock:
        _runs[basket] = _empty_run(basket)
        out = dict(_runs[basket])
    _persist()
    return {"ok": True, "run": out}


def _watchdog_loop() -> None:
    """Update elapsed time, accumulate temps, auto-stop timer mode, detect TR ready."""
    while True:
        try:
            live = hw.get_live_state()
            temps = hw.get_latest_temps()
            for basket in (1, 2):
                run = get_run(basket)
                state = run.get("state")
                # TR detection during preheat
                if state == "PREHEAT" and live.get(f"TR{basket}"):
                    on_temp_ready(basket)
                    continue
                if state != "RUNNING":
                    continue
                # Temp sample from IR
                ir_key = "IR1" if basket == 1 else "IR2"
                ir = temps.get(ir_key)
                if ir is not None:
                    record_temp_sample(basket, float(ir))
                # Elapsed / countdown
                started = run.get("startedAt")
                if not started:
                    continue
                try:
                    start_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                    elapsed = max(0, int((datetime.now(timezone.utc) - start_dt.astimezone(timezone.utc)).total_seconds()))
                except Exception:
                    elapsed = int(run.get("elapsedSeconds") or 0) + 1
                with _lock:
                    if basket in _runs and _runs[basket].get("state") == "RUNNING":
                        _runs[basket]["elapsedSeconds"] = elapsed
                        if _runs[basket].get("mode") == "timer":
                            dur = _runs[basket].get("setDurationMinutes")
                            total = int(float(dur) * 60) if dur else 0
                            remaining = max(0, total - elapsed)
                            _runs[basket]["remainingSeconds"] = remaining
                            _runs[basket]["updatedAt"] = _now_iso()
                            if remaining <= 0 and total > 0:
                                # auto stop outside lock
                                pass
                            else:
                                continue
                        else:
                            _runs[basket]["updatedAt"] = _now_iso()
                            continue
                # Timer expired
                if run.get("mode") == "timer":
                    dur = run.get("setDurationMinutes")
                    total = int(float(dur) * 60) if dur else 0
                    if total > 0 and elapsed >= total:
                        stop_test(basket, aborted=False, reason="timer_complete")
            # Persist occasionally
            _persist()
        except Exception as e:
            if _logger:
                _logger.debug("dt_test watchdog: %s", e)
        time.sleep(0.5)
