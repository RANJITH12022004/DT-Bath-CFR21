 #!/usr/bin/env python3
"""
app.py - Flask application for Tablet Disintegration Tester (DT-CFR)
Serves static files and REST API for data, auth, audit, reports, and print.
"""

import json
import os
import pathlib
import secrets
import atexit
import signal
import subprocess
import sys
import time
import threading
from datetime import datetime
from typing import Optional
from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

import data_service
import rbac_service
import audit_service
import calculation_service
import report_service
import print_service
import dt_hardware_service as hardware_service
import dt_test_service
import dt_validation_service
import dt_calibration_service
import biometric_service
import rtc_service
import network_service
import usb_export
import pdf_generator

# ======================= CONFIG ==========================

APP_ROOT = pathlib.Path(os.environ.get("APP_ROOT", os.path.dirname(os.path.abspath(__file__))))
INTERNAL_USB_PATH = pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal"))


def _default_storage_dir() -> pathlib.Path:
    """Prefer internal USB (sda1 at /media/usb_internal) when mounted; else APP_ROOT/storage."""
    if os.environ.get("STORAGE_DIR"):
        return pathlib.Path(os.environ["STORAGE_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "storage"
    return APP_ROOT / "storage"


def _default_reports_dir() -> pathlib.Path:
    """Prefer internal USB when mounted; else APP_ROOT/reports."""
    if os.environ.get("REPORTS_DIR"):
        return pathlib.Path(os.environ["REPORTS_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "reports"
    return APP_ROOT / "reports"


def _default_audit_db_dir() -> pathlib.Path:
    """Audit SQLite DB: sibling of storage/ on internal USB, else APP_ROOT/db."""
    if os.environ.get("AUDIT_DB_DIR"):
        return pathlib.Path(os.environ["AUDIT_DB_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "db"
    return APP_ROOT / "db"


STORAGE_DIR = _default_storage_dir()
REPORTS_DIR = _default_reports_dir()
AUDIT_DB_DIR = _default_audit_db_dir()
EXPORT_USB_PATH = os.environ.get("EXPORT_USB_PATH", str(APP_ROOT / "export"))
EXPORT_SUBFOLDER = os.environ.get("EXPORT_SUBFOLDER", "Disintegration-Reports-Exported")
ESP_PORT = os.environ.get("ESP_PORT", "/dev/serial0")
ESP_BAUD = int(os.environ.get("ESP_BAUD", "9600"))
DT_HARDWARE_MOCK = str(os.environ.get("DT_HARDWARE_MOCK", "0")).strip().lower() in ("1", "true", "yes", "on")
BIOMETRIC_PORT = os.environ.get("BIOMETRIC_PORT", "/dev/ttyAMA5")
BIOMETRIC_BAUD = int(os.environ.get("BIOMETRIC_BAUD", "57600"))
BIOMETRIC_ENROLL_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_ENROLL_TIMEOUT_SEC", "120"))
BIOMETRIC_LOGIN_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_LOGIN_TIMEOUT_SEC", "30"))
FLASK_HOST = os.environ.get("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))
DATETIME_STORAGE = STORAGE_DIR / "datetime.json"
APPROVAL_VERIFY_TTL_SECONDS = int(os.environ.get("APPROVAL_VERIFY_TTL_SECONDS", "180"))

# ==========================================================

app = Flask(__name__)
if CORS:
    CORS(app)

try:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    AUDIT_DB_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

config = {
    "APP_ROOT": APP_ROOT,
    "STORAGE_DIR": STORAGE_DIR,
    "REPORTS_DIR": REPORTS_DIR,
    "AUDIT_DB_DIR": AUDIT_DB_DIR,
    "A4_PORT": os.environ.get("A4_PORT", "/dev/ttyAMA4"),
    "A4_BAUD": int(os.environ.get("A4_BAUD", "9600")),
    "THERMAL_PORT": os.environ.get("THERMAL_PORT", "/dev/ttyAMA3"),
    "THERMAL_BAUD": int(os.environ.get("THERMAL_BAUD", "9600")),
    "ESP_PORT": ESP_PORT,
    "ESP_BAUD": ESP_BAUD,
    "DT_HARDWARE_MOCK": DT_HARDWARE_MOCK,
    "UART_LOG_PATH": os.environ.get("UART_LOG_PATH", str(APP_ROOT / "uart_communications.log")),
    "BIOMETRIC_PORT": BIOMETRIC_PORT,
    "BIOMETRIC_BAUD": BIOMETRIC_BAUD,
    "BIOMETRIC_ENROLL_TIMEOUT_SEC": BIOMETRIC_ENROLL_TIMEOUT_SEC,
    "BIOMETRIC_LOGIN_TIMEOUT_SEC": BIOMETRIC_LOGIN_TIMEOUT_SEC,
}

data_service.init(config)
audit_service.init(config)
calculation_service.init()
report_service.init(config)
print_service.init(config)
hardware_service.init(app, config)


def _dt_audit_bridge(action, details="", **kwargs):
    """Bridge for dt_* services to emit structured audit events."""
    try:
        outcome = kwargs.pop("outcome", None) or "success"
        _audit_event(
            action=action,
            outcome=outcome,
            details=details or "",
            **{k: v for k, v in kwargs.items() if v is not None},
        )
    except Exception:
        app.logger.exception("dt audit bridge failed")


def _dt_save_report(report: dict):
    """Persist report from dt_test_service (watchdog auto-stop / stop_test).

    Completed and operator-aborted runs stay pending approval (Pass/Fail gate).
    Power-interruption finals are handled by unclean-shutdown recovery, not here.
    """
    to_save = dict(report or {})
    try:
        to_save = _stamp_report_operator(to_save)
    except Exception:
        pass
    # Human abort → pending approval (not finalized as aborted-without-gate)
    if _report_is_aborted_payload(to_save):
        try:
            saved = _persist_operator_aborted_pending_report(to_save)
            return saved
        except Exception:
            app.logger.exception("save operator-aborted pending DT report failed; falling back to pending save")
    if to_save.get("reportApprovalStatus") is None:
        to_save["reportApprovalStatus"] = "pending"
    for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
        # Keep existing abort finalize fields if present
        if str(to_save.get("reportApprovalStatus") or "").strip().lower() == "aborted":
            break
        to_save.pop(k, None)
    rid = data_service.save_report(to_save)
    saved = data_service.get_report(rid) or to_save
    try:
        details = _format_report_audit_details(rid, saved if isinstance(saved, dict) else to_save)
        basket = (to_save or {}).get("basket")
        if basket is not None:
            details = "{} | basket {}".format(details, basket)
        status = (to_save or {}).get("status") or ""
        if status:
            details = "{} | {}".format(details, status)
        _audit_event(
            action="Report saved",
            outcome="success",
            details=details,
            entity_type="report",
            entity_id=str(rid or ""),
            entity_name=(saved or {}).get("name") if isinstance(saved, dict) else "",
            extra={"basket": basket, "mock": (to_save or {}).get("mock"), "auto": True},
        )
    except Exception:
        pass
    return saved


def _report_is_aborted_payload(report: dict) -> bool:
    """Detect aborted test/validation payloads before save."""
    if not isinstance(report, dict):
        return False
    if report.get("aborted") is True:
        return True
    st = str(report.get("status") or "").strip().lower()
    if st in ("aborted", "test aborted"):
        return True
    td = report.get("testData") if isinstance(report.get("testData"), dict) else {}
    if str((td or {}).get("status") or "").strip().lower() == "aborted":
        return True
    return False


dt_test_service.init(logger=app.logger, audit_fn=_dt_audit_bridge, save_report_fn=_dt_save_report)
dt_validation_service.init(logger=app.logger, audit_fn=_dt_audit_bridge)
dt_calibration_service.init(logger=app.logger, audit_fn=_dt_audit_bridge)

_enroll_sessions = {}
_enroll_sessions_lock = threading.Lock()
_audit_timestamp_lock = threading.Lock()
_last_audit_timestamp_ms = 0

biometric_service.init(app, config)
rtc_service.init(app.logger)
rtc_service.schedule_rtc_startup_sync()

import logging as _logging

_cfg_log = _logging.getLogger(__name__)
_cfg_log.info(
    "[CONFIG] INTERNAL_USB_PATH=%s STORAGE_DIR=%s REPORTS_DIR=%s AUDIT_DB_DIR=%s",
    INTERNAL_USB_PATH,
    STORAGE_DIR,
    REPORTS_DIR,
    AUDIT_DB_DIR,
)


def _audit(user, role, action, details=""):
    """Helper to log audit event (user/role from current user if not passed)."""
    u = user
    r = role
    if u is None or r is None:
        cur = data_service.get_current_user()
        if cur:
            u = u if u is not None else cur.get("username") or cur.get("name") or "--"
            r = r if r is not None else cur.get("role") or "--"
    audit_time = _audit_time_fields()
    audit_service.log_structured_event(
        user=u,
        role=r,
        action=action,
        details=details,
        event_type="legacy",
        outcome="success" if action else "",
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )


def _audit_time_fields():
    global _last_audit_timestamp_ms
    payload = rtc_service.get_device_wall_datetime_payload()
    dt_raw = (payload.get("datetime") or "").strip()
    dt_obj = None
    if dt_raw:
        try:
            dt_obj = datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
        except Exception:
            dt_obj = None
    if dt_obj is None:
        dt_obj = datetime.now()
    ts = int(dt_obj.timestamp() * 1000)
    with _audit_timestamp_lock:
        if ts <= _last_audit_timestamp_ms:
            ts = _last_audit_timestamp_ms + 1
        _last_audit_timestamp_ms = ts
    return {
        "timestamp_ms": ts,
        "date_time": dt_obj.strftime("%d/%m/%Y %H:%M:%S"),
    }


def _audit_request_source():
    return "{} {}".format(request.method, request.path)


def _audit_actor():
    cur = data_service.get_current_user() or {}
    cur_user = (cur.get("username") or "").strip() or (cur.get("name") or "").strip()
    cur_role = (cur.get("role") or "").strip()
    cur_name = (cur.get("name") or "").strip() or cur_user
    return {
        "user": cur_user or (request.headers.get("X-User-Username") or "").strip() or "--",
        "role": cur_role or (request.headers.get("X-User-Role") or "").strip() or "--",
        "name": cur_name or (request.headers.get("X-User-Name") or "").strip() or "--",
    }


def _sanitize_audit_payload(value):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if str(k).lower() in ("password",):
                out[k] = "***"
            else:
                out[k] = _sanitize_audit_payload(v)
        return out
    if isinstance(value, list):
        return [_sanitize_audit_payload(v) for v in value]
    return value


def _changed_fields(before_obj, after_obj):
    before_obj = before_obj or {}
    after_obj = after_obj or {}
    keys = sorted(set(before_obj.keys()) | set(after_obj.keys()))
    changed = []
    for key in keys:
        if before_obj.get(key) != after_obj.get(key):
            changed.append(key)
    return changed


def _audit_event(
    *,
    action,
    outcome,
    entity_type="",
    entity_id=None,
    entity_name="",
    details="",
    reason="",
    target_user="",
    before=None,
    after=None,
    signature=None,
    event_type="compliance",
    extra=None,
    actor_user=None,
    actor_role=None,
):
    actor = _audit_actor()
    # Optional overrides (e.g. failed login: show the User ID that was entered)
    user = (str(actor_user).strip() if actor_user is not None else "") or actor.get("user")
    role = (str(actor_role).strip() if actor_role is not None else "") or actor.get("role")
    audit_time = _audit_time_fields()
    signature = signature or {}
    before_clean = _sanitize_audit_payload(before)
    after_clean = _sanitize_audit_payload(after)
    audit_service.log_structured_event(
        user=user,
        role=role,
        action=action,
        details=details,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_name=entity_name,
        outcome=outcome,
        reason=reason,
        session_user=actor.get("user"),
        session_role=actor.get("role"),
        target_user=target_user,
        signature_mode=signature.get("mode") or "",
        signature_user=signature.get("username") or "",
        signature_role=signature.get("role") or "",
        changed_fields=_changed_fields(before_clean if isinstance(before_clean, dict) else {}, after_clean if isinstance(after_clean, dict) else {}),
        before=before_clean,
        after=after_clean,
        request_source=_audit_request_source(),
        extra=extra,
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )


def _login_attempt_actor(username, member=None):
    """Actor fields for pre-session login attempts — User column = entered User ID."""
    uname = str(username or "").strip() or "--"
    role = "--"
    if isinstance(member, dict):
        role = str(member.get("role") or "").strip() or "--"
        # Never attribute Factory role to a denied attempt (would suppress RLERLT audits)
        if uname.upper() == str(getattr(data_service, "FACTORY_USERNAME", "RLERLT")).upper():
            role = "--"
    return {"user": uname, "role": role}


def _member_admin_action_detail(verb, target_username, actor_username, verified_username=None):
    """Clear who-did-what text for disable / enable / unlock / restrict."""
    target = str(target_username or "").strip() or "--"
    actor = str(actor_username or "").strip() or "--"
    detail = "User ID {} {} by User ID {}".format(target, verb, actor)
    verifier = str(verified_username or "").strip()
    if verifier and verifier.lower() not in (actor.lower(), "--"):
        detail = "{} | verified by User ID {}".format(detail, verifier)
    return detail


def _heater_setpoint_on(temp) -> bool:
    try:
        return float(temp or 0) > 0
    except (TypeError, ValueError):
        return False


def _audit_heater_preheat_changes(*, before_heater, t1=None, t2=None, temp=None, source="settings", ok=True, error=None):
    """Emit a single Bath heater on/off audit row for the shared bath."""
    before = before_heater if isinstance(before_heater, dict) else {}
    try:
        old_t = float(before.get("t") or before.get("t1") or before.get("t2") or 0)
    except (TypeError, ValueError):
        old_t = 0.0
    if temp is not None:
        try:
            new_t = float(temp or 0)
        except (TypeError, ValueError):
            new_t = 0.0
    else:
        try:
            new_t = max(float(t1 or 0), float(t2 or 0))
        except (TypeError, ValueError):
            new_t = 0.0

    source = str(source or "settings").strip() or "settings"
    outcome = "success" if ok else "failed"
    old_on = _heater_setpoint_on(old_t)
    new_on = _heater_setpoint_on(new_t)
    setpoint_changed = abs(old_t - new_t) > 0.05
    if old_on == new_on and not (new_on and setpoint_changed) and ok:
        return
    if new_on:
        action = "Heater on"
        details = "Bath | setpoint {:.1f}°C | source {}".format(new_t, source)
    else:
        action = "Heater off"
        details = "Bath | source {}".format(source)
    if error:
        details = "{} | error {}".format(details, error)
    try:
        _audit_event(
            action=action,
            outcome=outcome,
            entity_type="heater",
            entity_id="bath",
            entity_name="Bath",
            details=details,
            event_type="lifecycle",
            before={"t": old_t},
            after={"t": new_t},
            extra={"source": source},
        )
    except Exception:
        app.logger.exception("heater audit failed for bath")


def _bath_conflict_status(result) -> int:
    """HTTP status for bath ownership conflicts."""
    if not isinstance(result, dict) or result.get("ok"):
        return 200
    code = str(result.get("code") or result.get("error") or "").strip().lower()
    if code in ("bath_temp_conflict", "bath_busy"):
        return 409
    return 400


POWER_INTERRUPTION_REMARKS = "power interruption"
OPERATOR_ABORT_REMARKS = "Aborted"
ABORT_CAUSE_OPERATOR = "operator"
ABORT_CAUSE_POWER = "power_interruption"


def _report_test_status(report: dict) -> str:
    td = report.get("testData") if isinstance((report or {}).get("testData"), dict) else {}
    return str((td or {}).get("status") or (report or {}).get("status") or "").strip().lower()


def _report_abort_cause(report: dict) -> str:
    """Return 'operator', 'power_interruption', or '' for a report/checkpoint payload.

    Explicit abortCause wins. Content already marked aborted (human Abort) is
    treated as operator unless power interruption was already stamped.
    """
    report = report or {}
    td = report.get("testData") if isinstance(report.get("testData"), dict) else {}
    cause = str(report.get("abortCause") or (td or {}).get("abortCause") or "").strip().lower()
    if cause in ("operator", "user"):
        return ABORT_CAUSE_OPERATOR
    if cause in ("power_interruption", "power_loss", "power"):
        return ABORT_CAUSE_POWER

    reason = str(
        report.get("abortReason")
        or (td or {}).get("abortReason")
        or report.get("reason")
        or ""
    ).strip().lower()
    if reason in (
        "operator_abort",
        "operator",
        "user",
        "nav_abort",
        "preheat_abort",
        "start_cancelled",
        "logout",
    ) or "operator" in reason:
        return ABORT_CAUSE_OPERATOR
    if reason in ("power_interruption", "power_loss", "power", "power_cut"):
        return ABORT_CAUSE_POWER

    remarks = str(
        report.get("approvalRemarks")
        or report.get("remarks")
        or (td or {}).get("remarks")
        or ""
    ).strip().lower()
    if POWER_INTERRUPTION_REMARKS in remarks:
        return ABORT_CAUSE_POWER
    approved_by = str(report.get("approvedBy") or "").strip().lower()
    if "power interruption" in approved_by:
        return ABORT_CAUSE_POWER

    # Human Abort already stamped on the payload (before unclean-shutdown finalize).
    if report.get("aborted") is True:
        return ABORT_CAUSE_OPERATOR
    st = _report_test_status(report)
    if st in ("aborted", "test aborted"):
        return ABORT_CAUSE_OPERATOR
    return ""


def _apply_unclean_shutdown_abort_fields(
    report: dict,
    *,
    remarks: str,
    approved_by: str,
    abort_cause: str,
    report_approval_status: str = "aborted",
) -> dict:
    """Shared finalize fields for unclean-shutdown abort (operator or power loss).

    Power interruption → system auto-approved (listed) with remarks \"power interruption\".
    Operator abort → reportApprovalStatus aborted (listed) without Pass/Fail.
    """
    report = dict(report or {})
    td = report.get("testData")
    if not isinstance(td, dict):
        td = {}
    else:
        td = dict(td)
    td["status"] = "aborted"
    td["remarks"] = remarks
    td["abortCause"] = abort_cause
    # Clear any draft pass/fail so recovery path never asks for approval of FAIL.
    for k in ("approvalPassFail", "drumPassFail"):
        td.pop(k, None)
    results = td.get("stepResults")
    if isinstance(results, list):
        for idx, row in enumerate(results):
            if not isinstance(row, dict):
                continue
            row = dict(row)
            row["resultText"] = "Aborted"
            row.pop("approvalPassFail", None)
            if not row.get("drumLabel"):
                row["drumLabel"] = "Drum {}".format(idx + 1)
            results[idx] = row
        td["stepResults"] = results
    val_runs = td.get("validationRuns")
    if isinstance(val_runs, list):
        for idx, run in enumerate(val_runs):
            if not isinstance(run, dict):
                continue
            run = dict(run)
            run["status"] = "Aborted"
            val_runs[idx] = run
        td["validationRuns"] = val_runs
    report["testData"] = td
    report["remarks"] = remarks
    report["status"] = "Aborted"
    report["approvalRemarks"] = remarks
    report["abortCause"] = abort_cause
    # Power loss: auto-approved by System (tapdensity-style remarks). Operator abort: aborted.
    approval_st = str(report_approval_status or "aborted").strip().lower()
    if approval_st not in ("approved", "aborted"):
        approval_st = "aborted"
    report["reportApprovalStatus"] = approval_st
    report["approvedBy"] = approved_by
    report["approvedByUsername"] = "system"
    report["approvedAt"] = _utc_now_iso()
    for k in ("approvalPassFail", "drumPassFail"):
        report.pop(k, None)
    val_runs_top = report.get("validationRuns")
    if isinstance(val_runs_top, list):
        for idx, run in enumerate(val_runs_top):
            if not isinstance(run, dict):
                continue
            run = dict(run)
            run["status"] = "Aborted"
            val_runs_top[idx] = run
        report["validationRuns"] = val_runs_top
    if not report.get("completedAt"):
        report["completedAt"] = _utc_now_iso()
    return report


def _apply_power_loss_abort_to_report(report: dict) -> dict:
    """Mark a report aborted after power loss; System auto-approves with power-interruption remarks.

    Used when power cuts mid-test or while a completed report awaits approval.
    No Pass/Fail is assigned — approval UI is not used for power-loss recovery.
    Matches tapdensity_rle auto remarks (\"power interruption\") with System as approver.
    """
    return _apply_unclean_shutdown_abort_fields(
        report,
        remarks=POWER_INTERRUPTION_REMARKS,
        approved_by="System (power interruption)",
        abort_cause=ABORT_CAUSE_POWER,
        report_approval_status="approved",
    )


def _apply_operator_abort_finalize_to_report(report: dict) -> dict:
    """Legacy finalize: operator abort without Pass/Fail (approval status aborted).

    Live operator aborts now stay pending via _persist_operator_aborted_pending_report.
    Kept for rare explicit finalize / migration paths.
    """
    td = report.get("testData") if isinstance((report or {}).get("testData"), dict) else {}
    existing = str(
        (report or {}).get("remarks")
        or (td or {}).get("remarks")
        or ""
    ).strip()
    if existing and POWER_INTERRUPTION_REMARKS not in existing.lower():
        remarks = existing
    else:
        remarks = OPERATOR_ABORT_REMARKS
    return _apply_unclean_shutdown_abort_fields(
        report,
        remarks=remarks,
        approved_by="System",
        abort_cause=ABORT_CAUSE_OPERATOR,
        report_approval_status="aborted",
    )


def _prepare_operator_aborted_pending_report(report: dict) -> dict:
    """Stamp operator-abort content but leave reportApprovalStatus=pending for Pass/Fail."""
    report = dict(report or {})
    td = report.get("testData")
    if not isinstance(td, dict):
        td = {}
    else:
        td = dict(td)
    existing = str(
        report.get("remarks")
        or td.get("remarks")
        or ""
    ).strip()
    if existing and POWER_INTERRUPTION_REMARKS not in existing.lower():
        remarks = existing
    else:
        remarks = OPERATOR_ABORT_REMARKS
    td["status"] = "aborted"
    td["remarks"] = remarks
    td["abortCause"] = ABORT_CAUSE_OPERATOR
    for k in ("approvalPassFail", "drumPassFail"):
        td.pop(k, None)
    results = td.get("stepResults")
    if isinstance(results, list):
        for idx, row in enumerate(results):
            if not isinstance(row, dict):
                continue
            row = dict(row)
            row["resultText"] = "Aborted"
            row.pop("approvalPassFail", None)
            if not row.get("drumLabel"):
                row["drumLabel"] = "Drum {}".format(idx + 1)
            results[idx] = row
        td["stepResults"] = results
    val_runs = td.get("validationRuns")
    if isinstance(val_runs, list):
        for idx, run in enumerate(val_runs):
            if not isinstance(run, dict):
                continue
            run = dict(run)
            run["status"] = "Aborted"
            val_runs[idx] = run
        td["validationRuns"] = val_runs
    report["testData"] = td
    report["remarks"] = remarks
    report["aborted"] = True
    report["abortCause"] = ABORT_CAUSE_OPERATOR
    rtype = str(report.get("type") or "").strip().lower()
    if rtype == "validation":
        report["status"] = "ABORTED"
    elif not str(report.get("status") or "").strip() or str(report.get("status") or "").strip().lower() in (
        "running",
        "completed",
        "complete",
    ):
        report["status"] = "Test Aborted"
    report["reportApprovalStatus"] = "pending"
    for k in (
        "approvalPassFail",
        "approvalRemarks",
        "approvedBy",
        "approvedAt",
        "approvedByUsername",
        "drumPassFail",
    ):
        report.pop(k, None)
    val_runs_top = report.get("validationRuns")
    if isinstance(val_runs_top, list):
        for idx, run in enumerate(val_runs_top):
            if not isinstance(run, dict):
                continue
            run = dict(run)
            run["status"] = "Aborted"
            val_runs_top[idx] = run
        report["validationRuns"] = val_runs_top
    if not report.get("completedAt"):
        report["completedAt"] = _utc_now_iso()
    return report


def _persist_operator_aborted_pending_report(report: dict) -> dict:
    """Save human-aborted report as pending approval (Pass/Fail + e-sign)."""
    report = _prepare_operator_aborted_pending_report(report)
    report_id = report.get("id")
    if report_id is None:
        report_id = data_service.save_report(report)
        report["id"] = report_id
    else:
        data_service.save_report(report)
    try:
        details = _format_report_audit_details(int(report_id), report)
        _audit_event(
            action="Report saved",
            outcome="success",
            details="{} | status: aborted | pending approval | remarks: {}".format(
                details,
                str(report.get("remarks") or OPERATOR_ABORT_REMARKS),
            ),
            entity_type="report",
            entity_id=str(report_id or ""),
            entity_name=(report or {}).get("name") or "",
            extra={"abortCause": ABORT_CAUSE_OPERATOR, "pendingApproval": True},
        )
    except Exception:
        app.logger.exception("audit operator-aborted pending report failed for id %s", report_id)
    return report


def _persist_unclean_shutdown_aborted_report(report: dict, *, force_power_interruption: bool = False) -> dict:
    """Save aborted report and write print artifacts (no Pass/Fail).

    Power interruption (auto) → remarks \"power interruption\", System auto-approved.
    Live operator aborts use _persist_operator_aborted_pending_report instead.

    When force_power_interruption is set (unclean restart recovery), always apply
    power-interruption System auto-approve — including pending human-aborted reports.
    """
    cause = _report_abort_cause(report)
    if force_power_interruption:
        report = _apply_power_loss_abort_to_report(report)
    elif cause == ABORT_CAUSE_OPERATOR:
        report = _apply_operator_abort_finalize_to_report(report)
    elif cause == ABORT_CAUSE_POWER:
        report = _apply_power_loss_abort_to_report(report)
    elif _report_is_aborted_payload(report):
        report = _apply_operator_abort_finalize_to_report(report)
    else:
        report = _apply_power_loss_abort_to_report(report)
    report_id = report.get("id")
    if report_id is None:
        report_id = data_service.save_report(report)
        report["id"] = report_id
    else:
        data_service.save_report(report)
    try:
        print_service.save_report_text_files(report, int(report_id), REPORTS_DIR)
    except Exception:
        app.logger.exception("Failed to save report text files after unclean-shutdown abort for id %s", report_id)
    try:
        _generate_report_pdf_file(int(report_id), write_audit=False)
    except Exception:
        app.logger.exception("Failed to generate PDF after unclean-shutdown abort for id %s", report_id)
    return report


def _persist_power_loss_aborted_report(report: dict) -> dict:
    """Backward-compatible alias: choose operator vs power-interruption labeling."""
    return _persist_unclean_shutdown_aborted_report(report)


def _audit_unclean_shutdown_aborted_report(report: dict) -> None:
    """Audit row for a finalized aborted report (operator Abort or power loss)."""
    rid = report.get("id")
    if rid is None:
        return
    ctx = _format_report_audit_details(int(rid), report)
    cause = _report_abort_cause(report) or ABORT_CAUSE_POWER
    remarks = str(report.get("approvalRemarks") or report.get("remarks") or "").strip()
    if cause == ABORT_CAUSE_OPERATOR:
        detail = "{} | status: aborted | remarks: {}".format(
            ctx,
            remarks or OPERATOR_ABORT_REMARKS,
        )
        _audit(None, None, "Report aborted", detail)
        return
    pl_detail = "{} | unclean shutdown | system auto-approved | remarks: {}".format(
        ctx,
        remarks or POWER_INTERRUPTION_REMARKS,
    )
    _audit(None, None, "Report aborted (power loss)", pl_detail)


def _audit_power_loss_aborted_report(report: dict) -> None:
    """Backward-compatible alias."""
    _audit_unclean_shutdown_aborted_report(report)


def _abort_pending_reports_after_power_loss(session_username=None):
    """Finalize pending reports after unclean shutdown via System auto-approve.

    Any pending test/validation/calibration report (completed or human-aborted
    awaiting approval) is System-approved with remarks \"power interruption\".
    """
    aborted = 0
    for report in data_service.list_reports("all", include_pending=True) or []:
        rtype = (report.get("type") or "").strip().lower()
        if rtype not in ("test", "validation", "calibration"):
            continue
        if (report.get("reportApprovalStatus") or "").strip().lower() != "pending":
            continue
        report = _persist_unclean_shutdown_aborted_report(
            report, force_power_interruption=True
        )
        _audit_unclean_shutdown_aborted_report(report)
        aborted += 1
    return aborted


def _normalize_pending_aborted_reports():
    """No-op: human-aborted reports stay pending for Pass/Fail approval."""
    return 0


def _normalize_power_interruption_auto_approvals():
    """Migrate older power-interruption finals from approval=aborted → System auto-approved.

    Tapdensity-style remarks stay \"power interruption\"; System is the approver.
    """
    fixed = 0
    for report in data_service.list_reports("all", include_pending=True) or []:
        rtype = (report.get("type") or "").strip().lower()
        if rtype not in ("test", "validation", "calibration"):
            continue
        st = str(report.get("reportApprovalStatus") or "").strip().lower()
        if st != "aborted":
            continue
        if _report_abort_cause(report) != ABORT_CAUSE_POWER:
            continue
        report = _apply_power_loss_abort_to_report(report)
        data_service.save_report(report)
        try:
            print_service.save_report_text_files(report, int(report.get("id")), REPORTS_DIR)
        except Exception:
            app.logger.exception(
                "Failed to refresh print files after power-interruption auto-approve migrate id %s",
                report.get("id"),
            )
        fixed += 1
    if fixed:
        app.logger.info(
            "Migrated %s power-interruption report(s) to System auto-approved",
            fixed,
        )
    return fixed



def _create_aborted_reports_from_dt_checkpoint(cp: dict, session_username=None) -> int:
    """Materialize one aborted test report per active DT basket from a dt_checkpoint."""
    created = 0
    reports = cp.get("reports") if isinstance(cp.get("reports"), list) else []
    baskets = cp.get("baskets") if isinstance(cp.get("baskets"), dict) else {}

    entries = []
    if reports:
        for rep in reports:
            if isinstance(rep, dict):
                entries.append(dict(rep))
    else:
        for bkey, run in baskets.items():
            if not isinstance(run, dict):
                continue
            st = str(run.get("state") or "").strip().upper()
            if st not in ("PREHEAT", "READY", "AWAIT_CONFIRM", "RUNNING"):
                continue
            try:
                import dt_test_service

                entries.append(dt_test_service._checkpoint_report_from_run(run))
            except Exception:
                # Minimal fallback if service import fails during early boot
                basket = int(run.get("basket") or bkey or 1)
                entries.append({
                    "type": "test",
                    "status": "running",
                    "beaker": basket,
                    "basket": basket,
                    "name": run.get("recipeName") or run.get("productName") or f"Basket {basket} Test",
                    "productName": run.get("productName") or "",
                    "batchNumber": run.get("batchNumber") or "",
                    "operatorUsername": run.get("operatorUsername"),
                    "operatorName": run.get("operatorName"),
                    "operatorId": run.get("operatorId"),
                    "_dtBasket": basket,
                    "_checkpointPhase": "running",
                })

    for entry in entries:
        # Skip if this basket already has a pending report (pending scan handles it)
        pending_id = entry.get("_pendingReportId") or entry.get("id")
        if pending_id is not None:
            try:
                existing = data_service.get_report(int(pending_id))
            except Exception:
                existing = None
            if existing and str(existing.get("reportApprovalStatus") or "").strip().lower() in (
                "pending",
                "aborted",
            ):
                continue

        report_data = dict(entry)
        for k in ("_checkpointAt", "_checkpointPhase", "_pendingReportId", "_dtBasket"):
            report_data.pop(k, None)
        report_data["type"] = "test"
        recipe = report_data.get("recipe")
        enriched = report_service.generate_report(
            report_data,
            recipe=recipe if isinstance(recipe, dict) else None,
            factory_settings=report_data.get("factorySettings"),
        )
        enriched = _stamp_report_operator(enriched)
        if session_username and not enriched.get("operatedByUsername") and not enriched.get("operatorUsername"):
            enriched["operatedByUsername"] = session_username
            enriched["operatorUsername"] = session_username
        force_power = True
        enriched = _persist_unclean_shutdown_aborted_report(
            enriched,
            force_power_interruption=force_power,
        )
        _audit_unclean_shutdown_aborted_report(enriched)
        created += 1
    return created


def _create_aborted_report_from_power_loss_checkpoint(session_username=None):
    """If a test/validation was in progress (checkpoint) but no pending report existed, save an aborted report.

    Mid-test power cut → power interruption.
    Checkpoint already marked operator-aborted → Aborted (not power interruption).
    DT mid-run checkpoints (type=dt_checkpoint / baskets) yield one report per active basket.
    """
    created = 0
    cp = data_service.get_test_run_data()
    if isinstance(cp, dict) and cp:
        # If checkpoint points at a still-pending report, abort it here (do not assume the
        # list-scan path already did — races can leave it pending).
        pending_id = cp.get("_pendingReportId") or cp.get("id")
        rtype = (cp.get("type") or "").strip().lower()
        is_dt = rtype == "dt_checkpoint" or isinstance(cp.get("baskets"), dict)

        if pending_id is not None and not is_dt:
            try:
                existing = data_service.get_report(int(pending_id))
            except Exception:
                existing = None
            handled_pending_ref = False
            if existing and str(existing.get("reportApprovalStatus") or "").strip().lower() == "pending":
                report = _persist_unclean_shutdown_aborted_report(existing)
                _audit_unclean_shutdown_aborted_report(report)
                created += 1
                handled_pending_ref = True
            elif existing and str(existing.get("reportApprovalStatus") or "").strip().lower() == "aborted":
                handled_pending_ref = True
            if handled_pending_ref:
                data_service.clear_test_run_data()
                created += _create_aborted_report_from_validation_checkpoint(session_username)
                return created

        if is_dt:
            created += _create_aborted_reports_from_dt_checkpoint(cp, session_username)
            data_service.clear_test_run_data()
            try:
                import dt_test_service

                dt_test_service.reset_all_runs_after_power_loss()
            except Exception:
                app.logger.exception("Failed to reset DT runs after power-loss recovery")
        elif rtype in ("test", "validation"):
            td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
            report_data = dict(cp)
            for k in ("_checkpointAt", "_checkpointPhase", "_pendingReportId"):
                report_data.pop(k, None)
            recipe = report_data.get("recipe") or (td.get("recipe") if isinstance(td, dict) else None)
            enriched = report_service.generate_report(
                report_data,
                recipe=recipe,
                factory_settings=report_data.get("factorySettings"),
            )
            enriched = _stamp_report_operator(enriched)
            enriched = _persist_unclean_shutdown_aborted_report(
                enriched,
                force_power_interruption=True,
            )
            _audit_unclean_shutdown_aborted_report(enriched)
            data_service.clear_test_run_data()
            created += 1
        else:
            # Unknown shape — clear to avoid sticky false recovery
            data_service.clear_test_run_data()

    created += _create_aborted_report_from_validation_checkpoint(session_username)
    return created


def _create_aborted_report_from_validation_checkpoint(session_username=None) -> int:
    """Synthesize an aborted combined validation report from validation_run.json."""
    if not hasattr(data_service, "get_validation_run_data"):
        return 0
    cp = data_service.get_validation_run_data()
    if not isinstance(cp, dict) or not cp:
        return 0
    try:
        basket = int(cp.get("beaker") or cp.get("basket") or 1)
    except (TypeError, ValueError):
        basket = 1
    if basket not in (1, 2):
        basket = 1

    stroke = cp.get("stroke") if isinstance(cp.get("stroke"), dict) else {}
    temp = cp.get("temp") if isinstance(cp.get("temp"), dict) else {}
    phase = cp.get("_checkpointPhase") or cp.get("phase") or "stroke"

    try:
        import dt_validation_service

        report = dt_validation_service.build_aborted_combined_validation_report(
            basket,
            stroke_payload=stroke or None,
            temp_payload=temp or None,
            phase=phase,
            operator={
                "name": cp.get("operatorName"),
                "username": cp.get("operatorUsername") or session_username,
                "employeeId": cp.get("operatorId"),
                "id": cp.get("operatorId"),
            },
        )
    except Exception:
        app.logger.exception("Failed to build aborted validation report from checkpoint")
        data_service.clear_validation_run_data()
        return 0

    report = dict(report)
    report["reportApprovalStatus"] = "pending"
    report = _stamp_report_operator(report)
    if session_username and not report.get("operatedByUsername"):
        report["operatedByUsername"] = session_username
        report["operatorUsername"] = session_username
    # Mid-validation cut is always power interruption (not operator abort finalize)
    report = _persist_unclean_shutdown_aborted_report(report, force_power_interruption=True)
    _audit_unclean_shutdown_aborted_report(report)
    data_service.clear_validation_run_data()
    try:
        import dt_validation_service

        if hasattr(dt_validation_service, "clear_all_sessions"):
            dt_validation_service.clear_all_sessions()
    except Exception:
        pass
    return 1


def _startup_session_power_audit():
    """If the last run ended without a clean stop while a session was active, log one power-interruption row."""
    try:
        # Always repair stuck pending+aborted drafts (even after a clean service restart).
        try:
            _normalize_pending_aborted_reports()
        except Exception:
            app.logger.exception("Normalize pending aborted reports failed")
        try:
            _normalize_power_interruption_auto_approvals()
        except Exception:
            app.logger.exception("Normalize power-interruption auto-approvals failed")
        had_clean_shutdown = data_service.consume_app_clean_stop_flag()
        pending = data_service.read_session_power_audit_pending()
        if pending and not had_clean_shutdown:
            un = (pending.get("username") or "").strip()
            # Always recover pending test/validation reports on unclean restart,
            # even if the power-interruption audit row was already written.
            try:
                _abort_pending_reports_after_power_loss(None)
                _create_aborted_report_from_power_loss_checkpoint(None)
            except Exception:
                app.logger.exception("Abort pending reports after power loss failed")
            if not pending.get("powerAuditLogged"):
                role = (pending.get("role") or "").strip()
                audit_time = _audit_time_fields()
                if audit_service.is_hidden_factory_actor(un, role):
                    pi_details = "Privileged factory session was active when power was interrupted or the system restarted."
                elif un:
                    pi_details = "Unclean shutdown while {} was logged in".format(un)
                else:
                    pi_details = "Unclean shutdown during active session"
                audit_service.log_structured_event(
                    user="--",
                    role="--",
                    action="Power interruption logout",
                    outcome="success",
                    entity_type="session",
                    entity_name="power",
                    details=pi_details,
                    event_type="compliance",
                    target_user=un,
                    extra={"lastKnownRole": role} if role else None,
                    request_source="system/startup",
                    timestamp_ms=audit_time.get("timestamp_ms"),
                    date_time=audit_time.get("date_time"),
                )
                pending = dict(pending)
                pending["powerAuditLogged"] = True
                data_service.write_session_power_audit_pending(pending)
        elif pending and had_clean_shutdown and pending.get("powerAuditLogged"):
            pending = dict(pending)
            pending.pop("powerAuditLogged", None)
            data_service.write_session_power_audit_pending(pending)
        # Clean stop (service restart / orderly shutdown): leave pending reports alone.
        # They stay awaiting approval so a verifier can still sign after reboot.
        # Only unclean power loss (branch above) converts pending -> aborted.
        cur = data_service.get_current_user()
        if cur:
            if not pending:
                data_service.write_session_power_audit_pending(cur)
        else:
            data_service.delete_session_power_audit_pending()
        audit_service.prune_power_interruption_overflow(keep=10)
        # Kiosk always requires a fresh login after power-on or service restart.
        data_service.clear_current_user()
    except Exception:
        app.logger.exception("Startup session power audit failed")



def _register_clean_shutdown_atexit():
    """Mark clean shutdown on normal process exit (pending reports recovered on next start)."""

    def _on_exit():
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass

    try:
        atexit.register(_on_exit)
    except Exception:
        pass

def _register_clean_shutdown_signals():
    """Mark clean shutdown on SIGTERM/SIGINT (keep handler minimal to avoid stop deadlocks)."""

    def _handler(signum, frame):
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError, AttributeError):
            pass


def _require_user_admin_verification():
    return _consume_approval_verify_token("user_admin")


def _approval_verifier_member(verifier: dict) -> dict:
    """Resolve verifier to a member row with featureOverrides for permission checks."""
    if not verifier:
        return {}
    role = str(verifier.get("role") or "").strip().lower()
    if role == "factory":
        return verifier
    un = str(verifier.get("username") or "").strip()
    m = data_service.get_member_by_username(un) if un else None
    return m if m else verifier


def _approval_verifier_eligible_for_recipe(verifier: dict) -> bool:
    """Recipe approval: verifier must have recipe-approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "recipe-approve")


def _approval_verifier_eligible_for_recipe_disable(verifier: dict) -> bool:
    """Recipe disable: verifier must have recipe management permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "recipe-manage")


def _approval_verifier_eligible_for_recipe_enable(verifier: dict) -> bool:
    """Recipe enable: verifier must have recipe management permission (Factory bypass)."""
    return _approval_verifier_eligible_for_recipe_disable(verifier)


def _report_approval_internal_key(report_type: str) -> str:
    """Internal RBAC key for approving a report by type."""
    rtype = str(report_type or "").strip().lower()
    if rtype == "validation":
        return "validation-report-approve"
    if rtype == "calibration":
        return "calibration-report-approve"
    return "test-report-approve"


def _resolve_report_type_for_approval_verify(payload) -> str:
    """Resolve report type from approval-verify payload (reportId preferred)."""
    payload = payload or {}
    report_id = payload.get("reportId")
    if report_id is None:
        report_id = payload.get("report_id")
    if report_id is not None:
        try:
            report = data_service.get_report(int(report_id))
            if report:
                return str(report.get("type") or "test").strip().lower() or "test"
        except (TypeError, ValueError):
            pass
    report_type = payload.get("reportType")
    if report_type is None:
        report_type = payload.get("report_type")
    return str(report_type or "test").strip().lower() or "test"


def _approval_verifier_eligible_for_report(verifier: dict, report_type: str = None) -> bool:
    """Report approval: verifier must have type-specific approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, _report_approval_internal_key(report_type))


def _approval_verifier_eligible_for_export(verifier: dict) -> bool:
    """Export approval: verifier must have export-approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "export-approve")


def _approval_verifier_eligible_for_user_admin(verifier: dict) -> bool:
    """User disable / admin actions: verifier must have profile-management permission."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "user-manage")


def _approval_verifier_eligible_for_calibration(verifier: dict) -> bool:
    """Calibration e-sign: verifier must have calibration-menu permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "calibration-menu")


def _utc_now_iso():
    """Naive local ISO timestamp for reports/labels (hardware RTC wall time)."""
    dt = rtc_service.read_rtc_wall_datetime()
    if dt is not None:
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _norm_username(val):
    return str(val or "").strip().lower()


def _report_operated_by_username(report):
    td = report.get("testData") or {}
    if isinstance(td, dict):
        u = td.get("operatedByUsername") or td.get("employeeId")
        if u:
            return _norm_username(u)
    return _norm_username(report.get("operatedByUsername") or report.get("employeeId"))


def _stamp_report_operator(enriched):
    cur = data_service.get_current_user() or {}
    td = enriched.get("testData")
    if not isinstance(td, dict):
        td = {}
    un = _norm_username(
        enriched.get("operatedByUsername")
        or td.get("operatedByUsername")
        or enriched.get("operatorUsername")
        or td.get("operatorUsername")
        or td.get("employeeId")
        or enriched.get("employeeId")
        or enriched.get("operatorId")
        or td.get("operatorId")
        or cur.get("username")
        or cur.get("name")
    )
    name = (
        enriched.get("operatorName")
        or td.get("operatorName")
        or cur.get("name")
        or cur.get("username")
        or "—"
    )
    emp = (
        enriched.get("employeeId")
        or td.get("employeeId")
        or enriched.get("operatorId")
        or td.get("operatorId")
        or cur.get("employeeId")
        or cur.get("username")
        or un
    )
    emp = str(emp or "").strip() or un or "--"
    enriched["operatedByUsername"] = un
    enriched["operatorName"] = name
    enriched["employeeId"] = emp
    enriched["operatorId"] = enriched.get("operatorId") or emp
    enriched["operatorUsername"] = enriched.get("operatorUsername") or un
    td = dict(td)
    td["operatedByUsername"] = un
    td["operatorName"] = name
    td["employeeId"] = emp
    td["operatorId"] = td.get("operatorId") or emp
    td["operatorUsername"] = td.get("operatorUsername") or un
    enriched["testData"] = td
    return enriched


def _report_requires_approval(report):
    rtype = (report.get("type") or "").strip().lower()
    return rtype in ("test", "validation", "calibration")


def _check_report_approved_for_print_export(report=None, report_id=None, report_data=None):
    """Return (json_response, status_code) if blocked, else None."""
    if report is None and report_id is not None:
        report = data_service.get_report(report_id)
    if report is None and report_data:
        report = report_data
    if not report or not _report_requires_approval(report):
        return None
    st = (report.get("reportApprovalStatus") or "").strip().lower()
    if st == "approved":
        return None
    if st == "pending" and _effective_request_role() != "factory":
        body = {
            "ok": False,
            "success": False,
            "error": "Report must be approved before print or export.",
        }
        return jsonify(body), 403
    return None


def _display_role_label(role_str):
    """User-facing role in approval lines (stored role Supervisor → Reviewer)."""
    r = str(role_str or "").strip()
    if not r:
        return r
    if r.lower() == "supervisor":
        return "Reviewer"
    return r


PERMISSION_CARD_LABELS = {
    "perm_test_access": "Test access",
    "perm_test_report_approve": "Test report approval",
    "perm_recipe_manage": "Manage recipes",
    "perm_recipe_approve": "Recipe approval",
    "perm_profile_admin": "Profile management",
    "perm_validation_test": "Validation test access",
    "perm_validation_report_approve": "Validation report approval",
    "perm_calibration": "Calibration access",
    "perm_calibration_report_approve": "Calibration report approval",
    "perm_datetime": "Edit date and time",
    "perm_reports_view": "View and print reports",
    "perm_audit_view": "View audit trails only",
    "perm_export_usb": "Export reports and audit (USB)",
    "perm_export_approve": "Export approval",
}


def _member_permission_card_set(member: dict) -> set:
    raw = (member or {}).get("featureOverrides") or {}
    allow = raw.get("allow") if isinstance(raw, dict) else []
    if not isinstance(allow, list):
        return set()
    valid_cards = set(rbac_service.PERMISSION_CARD_KEYS)
    return {str(k or "").strip() for k in allow if str(k or "").strip() in valid_cards}


def _permission_card_labels(keys) -> list:
    ordered = []
    for key in rbac_service.PERMISSION_CARD_KEYS:
        if key in keys:
            ordered.append(PERMISSION_CARD_LABELS.get(key, key))
    return ordered


def _member_permission_initial_detail(member: dict, username: str, role: str = "") -> str:
    parts = [
        "Added new user: {} ({})".format(
            username or "--",
            _display_role_label(role) if role else "—",
        )
    ]
    labels = _permission_card_labels(_member_permission_card_set(member))
    if labels:
        parts.append("Permissions: {}".format(", ".join(labels)))
    return " | ".join(parts)


def _member_permission_change_detail(before_member: dict, after_member: dict, username: str) -> str:
    before_cards = _member_permission_card_set(before_member)
    after_cards = _member_permission_card_set(after_member)
    enabled = after_cards - before_cards
    disabled = before_cards - after_cards
    if not enabled and not disabled:
        return ""
    parts = ["Permissions updated for {}".format(username or "--")]
    enabled_labels = _permission_card_labels(enabled)
    disabled_labels = _permission_card_labels(disabled)
    if enabled_labels:
        parts.append("Enabled: {}".format(", ".join(enabled_labels)))
    if disabled_labels:
        parts.append("Disabled: {}".format(", ".join(disabled_labels)))
    return " | ".join(parts)


def _member_profile_change_detail(before_member: dict, after_member: dict, username: str) -> str:
    labels = {
        "name": "Full name",
        "username": "User ID",
        "role": "Role",
        "status": "Status",
    }
    changed = []
    for key, label in labels.items():
        before_val = str((before_member or {}).get(key) or "").strip()
        after_val = str((after_member or {}).get(key) or "").strip()
        if key == "role":
            before_val = _display_role_label(before_val)
            after_val = _display_role_label(after_val)
        if before_val != after_val:
            changed.append("{}: {} -> {}".format(label, before_val or "--", after_val or "--"))
    if not changed:
        return ""
    return "Profile updated for {} | {}".format(username or "--", " | ".join(changed))


def _rbac_member_from_session():
    """Member record (with normalized permissions) for RBAC, or factory stub user."""
    cur = data_service.get_current_user()
    if not cur:
        return None
    role = str((cur or {}).get("role") or "").strip().lower()
    un = str((cur or {}).get("username") or "").strip().upper()
    if role == "factory" or un == data_service.FACTORY_USERNAME.upper():
        return cur
    m = data_service.get_member_by_username(cur.get("username") or "")
    return m if m else cur


def _session_has_internal(internal_key: str) -> bool:
    m = _rbac_member_from_session()
    if not m:
        return False
    return rbac_service.member_has_internal(m, internal_key)


def _try_restore_session_from_request_headers() -> bool:
    """Rehydrate bridge session when the UI still has a user after service restart."""
    if data_service.get_current_user():
        return True
    username = (request.headers.get("X-User-Username") or "").strip()
    if not username:
        return False
    un_upper = username.upper()
    if un_upper == data_service.FACTORY_USERNAME.upper():
        role = (request.headers.get("X-User-Role") or "factory").strip().lower()
        if role != "factory":
            return False
        data_service.save_current_user(
            {
                "username": data_service.FACTORY_USERNAME,
                "role": "factory",
                "name": (request.headers.get("X-User-Name") or "").strip() or "Factory",
            }
        )
        return True
    member = data_service.get_member_by_username(username)
    if not member:
        return False
    status = str(member.get("status") or "active").strip().lower()
    if status in ("locked", "disabled"):
        return False
    user = data_service.sanitize_member_for_client(member) or dict(member)
    data_service.save_current_user(user)
    return True


def _require_auth():
    """Return 401 if no logged-in session."""
    if not data_service.get_current_user():
        _try_restore_session_from_request_headers()
    if not data_service.get_current_user():
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _session_member_id():
    """Logged-in member id from session, or None (e.g. factory stub)."""
    cur = data_service.get_current_user() or {}
    try:
        mid = cur.get("id")
        if mid is None:
            return None
        return int(mid)
    except (TypeError, ValueError):
        return None


def _is_self_member(member_id: int) -> bool:
    """True when the session user is updating/viewing their own member record."""
    try:
        target_id = int(member_id)
    except (TypeError, ValueError):
        return False
    sid = _session_member_id()
    if sid is not None and sid == target_id:
        return True
    cur = data_service.get_current_user() or {}
    member = data_service.get_member(target_id)
    if not member:
        return False
    un_cur = str(cur.get("username") or "").strip().lower()
    un_mem = str(member.get("username") or "").strip().lower()
    return bool(un_cur) and un_cur == un_mem


def _require_user_manage_or_self(member_id: int):
    """Allow user-manage admins or any user accessing their own profile."""
    err = _require_auth()
    if err:
        return err
    if _is_self_member(member_id):
        return None
    return _require_session_internal(
        "user-manage",
        "Forbidden. You do not have permission to manage users.",
    )


def _self_profile_payload_from_request(existing: dict, payload: dict) -> dict:
    """Self-service profile: only display name may change here.

    Password changes must use POST /api/data/auth/change-password (current + new).
    """
    out = dict(existing)
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if name:
            out["name"] = name
    if payload.get("password") is not None and str(payload.get("password") or "").strip():
        raise ValueError("Use Change Password (current password required) to update your password.")
    return out


@app.route("/api/data/auth/change-password", methods=["POST"])
def change_password():
    """Logged-in user changes password with current + new (profile Edit Password)."""
    try:
        gate = _require_auth()
        if gate:
            return gate
        payload = request.get_json(force=True, silent=True) or {}
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not old_password or not new_password:
            return jsonify({"ok": False, "error": "oldPassword and newPassword are required"}), 400
        member, cur = _resolve_session_member_record()
        if not member:
            return jsonify({"ok": False, "error": "Factory account cannot change password here."}), 403
        username = str(member.get("username") or cur.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "Not logged in"}), 401
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Current password is incorrect"}), 401
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from your current password."}), 400
        mid = int(member.get("id"))
        updated_member = data_service.set_member_password(mid, new_password)
        data_service.clear_mandatory_password_reset_flags(mid)
        updated_member = data_service.get_member(mid) or updated_member
        safe_member = data_service.sanitize_member_for_client(updated_member) or dict(updated_member)
        _audit_event(
            action="Password changed",
            outcome="success",
            entity_type="member",
            entity_id=updated_member.get("id"),
            entity_name=updated_member.get("username") or updated_member.get("name") or "",
            details="Password changed from profile",
            target_user=updated_member.get("username") or "",
        )
        return jsonify({"ok": True, "member": safe_member}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error changing password")
        return jsonify({"ok": False, "error": str(e)}), 500


def _resolve_session_member_record():
    """Member row for the logged-in user (not factory)."""
    data_service.refresh_current_user_from_member()
    cur = data_service.get_current_user() or {}
    un = str(cur.get("username") or "").strip()
    if un.upper() == data_service.FACTORY_USERNAME.upper():
        return None, cur
    mid = _session_member_id()
    member = data_service.get_member(mid) if mid is not None else None
    if not member and un:
        member = data_service.get_member_by_username(un)
    return member, cur


def _require_session_internal(internal_key: str, message: str = None):
    """Return Flask error response if session lacks internal permission, else None."""
    err = _require_auth()
    if err:
        return err
    data_service.refresh_current_user_from_member()
    if not _session_has_internal(internal_key):
        msg = message or "Forbidden. You do not have permission for this action."
        return jsonify({"error": msg}), 403
    return None


def _require_any_session_internal(internal_keys, message: str = None):
    """Return Flask error response if session lacks all listed permissions, else None."""
    err = _require_auth()
    if err:
        return err
    data_service.refresh_current_user_from_member()
    for key in internal_keys or []:
        if _session_has_internal(key):
            return None
    msg = message or "Forbidden. You do not have permission for this action."
    return jsonify({"error": msg}), 403


def _session_can_edit_datetime() -> bool:
    """True when the logged-in user may change system date/time (RBAC, not role name alone)."""
    data_service.refresh_current_user_from_member()
    m = _rbac_member_from_session()
    if not m:
        return False
    return rbac_service.member_has_internal(m, "edit-datetime")


def _require_edit_datetime():
    """Return a Flask error response if the session may not change date/time, else None."""
    if not data_service.get_current_user():
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    if not _session_can_edit_datetime():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Forbidden. You do not have permission to change date and time.",
                }
            ),
            403,
        )
    return None


def _verifier_payload_has_internal(verified, internal_key: str) -> bool:
    if not verified:
        return False
    vr = str((verified or {}).get("role") or "").strip().lower()
    if vr == "factory":
        return True
    un = (verified or {}).get("username") or ""
    vm = data_service.get_member_by_username(un) if un else None
    if not vm:
        return False
    return rbac_service.member_has_internal(vm, internal_key)


def _session_role_header():
    return (request.headers.get("X-User-Role") or "").strip().lower()


def _effective_request_role():
    """Role for this request: X-User-Role if present, else logged-in user from server session."""
    hr = _session_role_header()
    if hr:
        return hr
    cur = data_service.get_current_user()
    return str((cur or {}).get("role") or "").strip().lower()


def _is_biometric_enabled():
    settings = data_service.get_factory_settings() or {}
    val = settings.get("biometricEnabled", True)
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() not in ("false", "0", "off", "no", "disabled")


def _is_biometric_transient_error(message):
    """Errors expected during passive biometric polling (not true auth failures)."""
    msg = str(message or "").strip().lower()
    if not msg:
        return False
    transient_markers = (
        "timed out waiting for finger",
        "no finger detected",
        "image too messy",
    )
    return any(marker in msg for marker in transient_markers)


def _can_assign_feature_overrides():
    if _effective_request_role() == "factory":
        return True
    return _session_has_internal("user-add")


def _payload_has_protected_feature_overrides(member_data):
    if not isinstance(member_data, dict):
        return False
    raw = member_data.get("featureOverrides")
    if not isinstance(raw, dict):
        return False
    protected = {"dashboard", "factory-settings", "factory-reset"}
    for k in (raw.get("allow") or []):
        if str(k or "").strip() in protected:
            return True
    for k in (raw.get("deny") or []):
        if str(k or "").strip() in protected:
            return True
    return False


def _apply_recipe_approval_for_session_creator(processed):
    """Factory saves: approve immediately (no QA/Admin verification). Others: pending."""
    if _effective_request_role() != "factory":
        processed["recipeApprovalStatus"] = "pending"
        for k in (
            "recipeApprovedAt",
            "recipeApprovedBy",
            "recipeApprovalRemarks",
            "recipeApprovedByUsername",
        ):
            processed.pop(k, None)
        return
    cur = data_service.get_current_user() or {}
    display_name = (request.headers.get("X-User-Name") or "").strip() or (
        request.headers.get("X-User-Username") or ""
    ).strip() or (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "Factory"
    username_raw = (
        (request.headers.get("X-User-Username") or "").strip()
        or (cur.get("username") or "").strip()
        or (cur.get("name") or "").strip()
        or display_name
    )
    username_key = _norm_username(username_raw)
    by_line = "{} ({})".format(display_name, _display_role_label("factory"))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso()
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = username_key
    processed["recipeApprovalRemarks"] = ""


def _apply_recipe_approval_verify_token(processed, remarks=""):
    """
    When X-Approval-Verify-Token is present, approve a pending recipe in the same save
    (avoids save-then-approve creating duplicate recipes or double writes).
    Returns (error_message or None, applied_via_token bool).
    """
    if (request.headers.get("X-Approval-Verify-Token") or "").strip() == "":
        return None, False
    if processed.get("recipeApprovalStatus") != "pending":
        return None, False
    verified, verify_err = _consume_approval_verify_token("recipe")
    if verify_err:
        return verify_err, False
    verified_name = (verified.get("name") or verified.get("username") or "—").strip()
    verified_role = (verified.get("role") or "").strip()
    verified_username = _norm_username(verified.get("username"))
    by_line = verified_name
    if verified_role:
        by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso()
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = verified_username
    processed["recipeApprovalRemarks"] = (remarks or "").strip()
    return None, True


_approval_verify_tokens = {}


def _cleanup_approval_verify_tokens():
    now = int(time.time())
    stale = [token for token, payload in _approval_verify_tokens.items() if int(payload.get("expiresAt", 0)) <= now]
    for token in stale:
        _approval_verify_tokens.pop(token, None)


def _issue_approval_verify_token(verifier_user, purpose, report_type=None):
    _cleanup_approval_verify_tokens()
    now = int(time.time())
    token = secrets.token_urlsafe(24)
    payload = {
        "username": verifier_user.get("username") or "",
        "name": verifier_user.get("name") or verifier_user.get("username") or "",
        "role": str(verifier_user.get("role") or "").strip().lower(),
        "purpose": str(purpose or "recipe").strip().lower(),
        "issuedAt": now,
        "expiresAt": now + APPROVAL_VERIFY_TTL_SECONDS,
    }
    if str(purpose or "").strip().lower() == "report":
        payload["reportType"] = str(report_type or "test").strip().lower() or "test"
    _approval_verify_tokens[token] = payload
    return token, payload


def _consume_approval_verify_token(expected_purpose):
    _cleanup_approval_verify_tokens()
    token = (request.headers.get("X-Approval-Verify-Token") or "").strip()
    if not token:
        return None, "Approval verification is required."
    payload = _approval_verify_tokens.pop(token, None)
    if not payload:
        return None, "Approval verification is invalid or expired."
    exp = str(expected_purpose or "").strip().lower()
    got = str(payload.get("purpose") or "").strip().lower()
    if got != exp:
        return None, "Approval verification was issued for a different action."
    if exp == "report":
        report_type = str(payload.get("reportType") or "test").strip().lower() or "test"
        perm_key = _report_approval_internal_key(report_type)
        if not _verifier_payload_has_internal(payload, perm_key):
            if perm_key == "validation-report-approve":
                return None, "Verifier does not have validation report approval permission."
            if perm_key == "calibration-report-approve":
                return None, "Verifier does not have calibration report approval permission."
            return None, "Verifier does not have test report approval permission."
    elif exp == "recipe":
        if not _verifier_payload_has_internal(payload, "recipe-approve"):
            return None, "Verifier does not have recipe approval permission."
    elif exp == "recipe_disable":
        if not _verifier_payload_has_internal(payload, "recipe-manage"):
            return None, "Verifier does not have recipe management permission."
    elif exp == "recipe_enable":
        if not _verifier_payload_has_internal(payload, "recipe-manage"):
            return None, "Verifier does not have recipe management permission."
    elif exp == "user_admin":
        if not _verifier_payload_has_internal(payload, "user-manage"):
            return None, "Verifier does not have profile management permission."
    elif exp == "export":
        if not _verifier_payload_has_internal(payload, "export-approve"):
            return None, "Verifier does not have export approval permission."
    elif exp == "calibration":
        if not _verifier_payload_has_internal(payload, "calibration-menu"):
            return None, "Verifier does not have calibration permission."
    else:
        return None, "Invalid approval purpose."
    return payload, None


def _audit_report_pdf_generated(report_id, report=None) -> None:
    """Audit row when a report PDF file is written (approved or aborted only)."""
    if report is None:
        report = data_service.get_report(report_id)
    rid = report_id if report_id is not None else (report or {}).get("id")
    st = str((report or {}).get("reportApprovalStatus") or "").strip().lower()
    if st == "approved":
        pf = str((report or {}).get("approvalPassFail") or "").strip().upper()
        detail = "Report id {}".format(rid)
        if pf:
            detail = "{} | {} | approved PDF".format(detail, pf)
        else:
            detail = "{} | approved PDF".format(detail)
    elif st == "aborted":
        detail = "Report id {} | aborted PDF".format(rid)
    else:
        return
    _audit(None, None, "Report PDF generated", detail)


def _format_report_audit_details(report_id, enriched):
    """Build audit trail details: saved report name, recipe, batch."""
    if not enriched:
        return str(report_id)
    parts = []
    name = enriched.get("name")
    if name:
        parts.append("saved as: {}".format(name))
    else:
        parts.append("report id {}".format(report_id))
    recipe = enriched.get("recipe") or {}
    test_data = enriched.get("testData") or {}
    recipe_inner = test_data.get("recipe") or {}
    rname = (
        recipe.get("productName")
        or recipe.get("name")
        or test_data.get("productName")
        or recipe_inner.get("productName")
        or recipe_inner.get("name")
        or enriched.get("productName")
    )
    if rname:
        parts.append("recipe: {}".format(rname))
    if report_id is not None:
        parts.append("report id {}".format(report_id))
    batch = recipe.get("batchNumber")
    if batch is None or (isinstance(batch, str) and not batch.strip()):
        batch = test_data.get("batchNumber")
    if batch is None or (isinstance(batch, str) and not batch.strip()):
        batch = recipe_inner.get("batchNumber")
    if batch is not None and str(batch).strip() != "":
        parts.append("batch: {}".format(batch))
    return " | ".join(parts)


def _format_recipe_audit_details(recipe, *, recipe_id=None, action_label=None):
    """
    Build audit details for recipe create/edit including parameters.

    Example:
      Recipe created: Paracetamol | temp 37.0°C | mode timer | duration 00:30:00 | media Water | mesh 10# | id 12
    """
    r = recipe if isinstance(recipe, dict) else {}
    rid = recipe_id if recipe_id is not None else r.get("id")
    name = (r.get("name") or r.get("productName") or "").strip()
    parts = []
    if action_label:
        if name:
            parts.append("{}: {}".format(action_label, name))
        elif rid is not None:
            parts.append("{}: id {}".format(action_label, rid))
        else:
            parts.append(str(action_label))
    elif name:
        parts.append(name)

    temp = r.get("temp")
    if temp is None:
        temp = r.get("setTemperature")
    try:
        if temp is not None and str(temp).strip() != "":
            parts.append("temp {:.1f}°C".format(float(temp)))
    except (TypeError, ValueError):
        pass

    mode = str(r.get("mode") or "").strip().lower()
    if mode:
        parts.append("mode {}".format(mode))

    if mode == "timer":
        dur_disp = (r.get("setDuration") or "").strip()
        if not dur_disp:
            try:
                minutes = float(r.get("duration"))
                total_sec = int(round(minutes * 60))
                hh, rem = divmod(max(0, total_sec), 3600)
                mm, ss = divmod(rem, 60)
                dur_disp = "{:02d}:{:02d}:{:02d}".format(hh, mm, ss)
            except (TypeError, ValueError):
                dur_disp = ""
        if dur_disp:
            parts.append("duration {}".format(dur_disp))

    media = (r.get("media") or "").strip()
    if media:
        parts.append("media {}".format(media))

    mesh = (r.get("mesh") or "").strip()
    if mesh:
        parts.append("mesh {}".format(mesh))

    if rid is not None and str(rid).strip() != "":
        # Avoid duplicating "id N" when that was already the only label
        id_bit = "id {}".format(rid)
        if not any(p == id_bit or p.endswith(": {}".format(id_bit)) for p in parts):
            parts.append(id_bit)

    return " | ".join(parts) if parts else (action_label or "recipe")


# =================== STATIC ==========================


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/")
def serve_index():
    return send_from_directory(APP_ROOT, "index.html")


@app.route("/<path:path>")
def serve_static(path):     
    return send_from_directory(APP_ROOT, path)


# =================== DATA: RECIPES ==========================


@app.route("/api/data/recipes", methods=["GET"])
def get_recipes():
    try:
        gate = _require_any_session_internal(
            ["recipe-list", "quick-test", "recipe-test", "recipe-edit"],
            "Forbidden. You do not have permission to view recipes.",
        )
        if gate:
            return gate
        recipes = data_service.list_recipes()
        return jsonify({"recipes": recipes}), 200
    except Exception as e:
        app.logger.exception("Error listing recipes")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes", methods=["POST"])
def create_recipe():
    try:
        gate = _require_session_internal(
            "recipe-manage",
            "Forbidden. You do not have permission to create recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
        tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks)
        if tok_err:
            return jsonify({"error": tok_err}), 401
        recipe_id = data_service.save_recipe(processed)
        rd = _format_recipe_audit_details(
            processed, recipe_id=recipe_id, action_label="Recipe created"
        )
        _audit(None, None, "Recipe created", rd)
        if processed.get("recipeApprovalStatus") == "approved":
            if via_token:
                v_user = processed.get("recipeApprovedByUsername") or "--"
                v_role = (request.headers.get("X-User-Role") or "").strip() or "--"
                _audit(v_user, v_role, "Recipe approved", rd)
            elif _effective_request_role() == "factory":
                au = (request.headers.get("X-User-Username") or "").strip() or "--"
                _audit(au, "factory", "Recipe approved", rd)
        return jsonify({"id": recipe_id, "recipe": processed}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/disabled", methods=["GET"])
def get_disabled_recipes():
    try:
        gate = _require_any_session_internal(
            ["disable-recipes", "recipe-manage", "recipe-enable", "recipe-delete"],
            "Forbidden. You do not have permission to view disabled recipes.",
        )
        if gate:
            return gate
        return jsonify({"recipes": data_service.list_disabled_recipes()}), 200
    except Exception as e:
        app.logger.exception("Error listing disabled recipes")
        return jsonify({"error": str(e), "recipes": []}), 500


@app.route("/api/data/recipes/<int:recipe_id>/enable", methods=["POST"])
def enable_recipe_route(recipe_id):
    """Restore a disabled recipe (requires recipe management permission + enable approval)."""
    try:
        gate = _require_any_session_internal(
            ["recipe-manage", "recipe-enable", "disable-recipes"],
            "Forbidden. You do not have permission to enable recipes.",
        )
        if gate:
            return gate
        archived = data_service.get_disabled_recipe(recipe_id)
        if not archived:
            return jsonify({"error": "Disabled recipe not found"}), 404
        body = request.get_json(force=True, silent=True) or {}
        remarks = (body.get("remarks") or body.get("enableApprovalRemarks") or "").strip()
        cur = data_service.get_current_user() or {}
        enabled_by = (cur.get("name") or cur.get("username") or "—").strip()
        enabled_by_username = _norm_username(cur.get("username") or cur.get("name"))
        role = _effective_request_role()
        if role == "factory":
            display_name = (request.headers.get("X-User-Name") or "").strip() or enabled_by
            username_raw = (
                (request.headers.get("X-User-Username") or "").strip()
                or (cur.get("username") or "").strip()
                or display_name
            )
            approver_line = "{} ({})".format(display_name, _display_role_label("factory"))
            approver_username = _norm_username(username_raw)
        else:
            verified, verify_err = _consume_approval_verify_token("recipe_enable")
            if verify_err:
                return jsonify({"error": verify_err}), 401
            verified_name = (verified.get("name") or verified.get("username") or "—").strip()
            verified_role = (verified.get("role") or "").strip()
            approver_line = verified_name
            if verified_role:
                approver_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
            approver_username = _norm_username(verified.get("username"))
        restored = data_service.enable_disabled_recipe(
            recipe_id,
            enabled_by=enabled_by,
            enabled_by_username=enabled_by_username,
            enable_approved_by=approver_line,
            enable_approved_by_username=approver_username,
            enable_approval_remarks=remarks,
        )
        if not restored:
            return jsonify({"error": "Disabled recipe not found"}), 404
        rlabel = restored.get("productName") or restored.get("name") or ""
        details = "Recipe id {}".format(recipe_id)
        if rlabel:
            details = "{}: {}".format(details, rlabel)
        if remarks:
            details = "{} | remarks: {}".format(details, remarks)
        details = "{} | approved by {}".format(details, approver_line)
        _audit(None, None, "Recipe enabled", details)
        _audit(approver_username or None, None, "Recipe enable approved", details)
        return jsonify({"success": True, "recipe": restored}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error enabling recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["GET"])
def get_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-list", "quick-test", "recipe-test", "recipe-edit"],
            "Forbidden. You do not have permission to view recipes.",
        )
        if gate:
            return gate
        recipe = data_service.get_recipe(recipe_id)
        if recipe:
            return jsonify({"recipe": recipe}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["PUT"])
def update_recipe(recipe_id):
    try:
        gate = _require_session_internal(
            "recipe-manage",
            "Forbidden. You do not have permission to edit recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        recipe_data["id"] = recipe_id
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
        tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks)
        if tok_err:
            return jsonify({"error": tok_err}), 401
        data_service.save_recipe(processed)
        rd = _format_recipe_audit_details(
            processed, recipe_id=recipe_id, action_label="Recipe edited"
        )
        _audit(None, None, "Recipe edited", rd)
        if processed.get("recipeApprovalStatus") == "approved":
            if via_token:
                v_user = processed.get("recipeApprovedByUsername") or "--"
                v_role = (request.headers.get("X-User-Role") or "").strip() or "--"
                _audit(v_user, v_role, "Recipe approved", rd)
            elif _effective_request_role() == "factory":
                au = (request.headers.get("X-User-Username") or "").strip() or "--"
                _audit(au, "factory", "Recipe approved", rd)
        return jsonify({"id": recipe_id, "recipe": processed}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["DELETE"])
def delete_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-manage", "recipe-delete", "disable-recipes", "recipe-enable"],
            "Forbidden. You do not have permission to disable recipes.",
        )
        if gate:
            return gate
        existing = data_service.get_recipe(recipe_id)
        if not existing:
            return jsonify({"error": "Recipe not found"}), 404
        body = request.get_json(force=True, silent=True) or {}
        remarks = (body.get("remarks") or body.get("disableApprovalRemarks") or "").strip()
        cur = data_service.get_current_user() or {}
        disabled_by = (cur.get("name") or cur.get("username") or "—").strip()
        disabled_by_username = _norm_username(cur.get("username") or cur.get("name"))
        role = _effective_request_role()
        if role == "factory":
            display_name = (request.headers.get("X-User-Name") or "").strip() or disabled_by
            username_raw = (
                (request.headers.get("X-User-Username") or "").strip()
                or (cur.get("username") or "").strip()
                or display_name
            )
            approver_line = "{} ({})".format(display_name, _display_role_label("factory"))
            approver_username = _norm_username(username_raw)
        else:
            verified, verify_err = _consume_approval_verify_token("recipe_disable")
            if verify_err:
                return jsonify({"error": verify_err}), 401
            verified_name = (verified.get("name") or verified.get("username") or "—").strip()
            verified_role = (verified.get("role") or "").strip()
            approver_line = verified_name
            if verified_role:
                approver_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
            approver_username = _norm_username(verified.get("username"))
        success = data_service.archive_disabled_recipe(
            existing,
            disabled_by=disabled_by,
            disabled_by_username=disabled_by_username,
            disable_approved_by=approver_line,
            disable_approved_by_username=approver_username,
            disable_approval_remarks=remarks,
        )
        if success:
            rlabel = existing.get("productName") or existing.get("name") or ""
            details = "Recipe id {}".format(recipe_id)
            if rlabel:
                details = "{}: {}".format(details, rlabel)
            if remarks:
                details = "{} | remarks: {}".format(details, remarks)
            details = "{} | approved by {}".format(details, approver_line)
            _audit(None, None, "Recipe disabled", details)
            _audit(approver_username or None, None, "Recipe disable approved", details)
            return jsonify({"success": True}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error disabling recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>/approve", methods=["POST"])
def approve_recipe(recipe_id):
    try:
        verified, verify_err = _consume_approval_verify_token("recipe")
        if verify_err:
            return jsonify({"ok": False, "error": verify_err}), 401
        body = request.get_json(force=True, silent=True) or {}
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        recipe = data_service.get_recipe(recipe_id)
        if not recipe:
            return jsonify({"ok": False, "error": "Recipe not found"}), 404
        verified_username = _norm_username(verified.get("username"))
        st = recipe.get("recipeApprovalStatus")
        if st == "approved":
            existing_approver = _norm_username(recipe.get("recipeApprovedByUsername"))
            if existing_approver and existing_approver == verified_username:
                return jsonify({"ok": False, "error": "Same person cannot approve twice"}), 409
            return jsonify({"ok": True, "recipe": recipe}), 200
        if st not in (None, "pending"):
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
        if st is None:
            return jsonify({"ok": False, "error": "Legacy recipe does not require approval"}), 400
        verified_name = (verified.get("name") or verified.get("username") or approver_name or "—").strip()
        verified_role = (verified.get("role") or role_header or "").strip()
        by_line = verified_name
        if verified_role:
            by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
        recipe["recipeApprovalStatus"] = "approved"
        recipe["recipeApprovedAt"] = _utc_now_iso()
        recipe["recipeApprovedBy"] = by_line
        recipe["recipeApprovedByUsername"] = verified_username
        recipe["recipeApprovalRemarks"] = remarks
        data_service.save_recipe(recipe)
        rname = (recipe.get("productName") or recipe.get("name") or "").strip()
        rdetail = "Recipe id {} | verified by {}".format(recipe_id, verified_name)
        if rname:
            rdetail = "{} | recipe: {}".format(rdetail, rname)
        batch = recipe.get("batchNumber")
        if batch is not None and str(batch).strip():
            rdetail = "{} | batch: {}".format(rdetail, str(batch).strip())
        v_audit_user = verified.get("username") or verified_username or verified_name
        v_audit_role = (verified.get("role") or "").strip() or "--"
        _audit(
            v_audit_user,
            v_audit_role,
            "Recipe approved",
            rdetail,
        )
        return jsonify({"ok": True, "recipe": recipe}), 200
    except Exception as e:
        app.logger.exception("Error approving recipe")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATA: TEST / VALIDATION RUN CHECKPOINT (power-loss recovery) ==========================


@app.route("/api/data/test-run/checkpoint", methods=["PUT"])
def put_test_run_checkpoint():
    """Persist in-progress test or validation run so a report can be saved after unclean shutdown."""
    try:
        gate = _require_auth()
        if gate:
            return gate
        gate = _require_any_session_internal(
            ["quick-test", "recipe-test", "validation-test"],
            "Forbidden. You do not have permission to run tests or validation.",
        )
        if gate:
            return gate
        body = request.get_json(force=True, silent=True) or {}
        if not body:
            return jsonify({"ok": False, "error": "Checkpoint body required"}), 400
        data_service.save_test_run_data(body)
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error saving test run checkpoint")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/test-run/checkpoint", methods=["DELETE"])
def delete_test_run_checkpoint():
    try:
        gate = _require_auth()
        if gate:
            return gate
        data_service.clear_test_run_data()
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error clearing test run checkpoint")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATA: REPORTS ==========================


@app.route("/api/data/reports", methods=["GET"])
def get_reports():
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        filter_type = request.args.get("filter", "all")
        include_pending = str(request.args.get("includePending") or request.args.get("include_pending") or "").strip().lower() in (
            "1", "true", "yes",
        )
        reports = data_service.list_reports(filter_type, include_pending=include_pending)
        return jsonify({"reports": reports}), 200
    except Exception as e:
        app.logger.exception("Error listing reports")
        return jsonify({"error": str(e)}), 500




def _audit_report_created(report_id, enriched):
    """Write audit row for a newly saved report/test/validation."""
    details = _format_report_audit_details(report_id, enriched)
    approval_st = str(enriched.get("reportApprovalStatus") or "").strip().lower()
    if approval_st == "pending":
        details = "{} | awaiting approval (not listed until approved)".format(details)
    elif approval_st == "aborted":
        details = "{} | aborted".format(details)
    rtype = (enriched.get("type") or "").strip().lower()
    if rtype == "test":
        td = enriched.get("testData") or {}
        recipe = enriched.get("recipe") or td.get("recipe") or {}
        pname = str(recipe.get("productName") or td.get("productName") or "").strip()
        recipe_id = recipe.get("id")
        is_quick = pname.lower() == "quick test" or (recipe_id is None and bool(pname))
        action = "Quick test performed" if is_quick else "Test performed"
        _audit(None, None, action, details)
    elif rtype == "validation":
        _audit(None, None, "Validation performed", details)
    else:
        _audit(None, None, "Report saved", details)

@app.route("/api/data/reports", methods=["POST"])
def create_report():
    try:
        report_data = request.get_json(force=True, silent=True) or {}
        rtype = (report_data.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden. You do not have permission to run validation.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test"],
                "Forbidden. You do not have permission to save test reports.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to save reports.")
        if gate:
            return gate
        recipe = report_data.get("recipe") or (report_data.get("testData") or {}).get("recipe")
        enriched = report_service.generate_report(
            report_data,
            recipe=recipe,
            factory_settings=report_data.get("factorySettings"),
        )
        if (enriched.get("type") or "").strip().lower() in ("test", "validation", "calibration"):
            enriched = _stamp_report_operator(enriched)
            for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
                enriched.pop(k, None)
            # Human abort → pending Pass/Fail approval (same as completed runs).
            if _report_is_aborted_payload(enriched):
                enriched = _persist_operator_aborted_pending_report(enriched)
                report_id = enriched.get("id")
                _audit_report_created(report_id, enriched)
                return jsonify({"id": report_id, "report": enriched}), 201
            enriched["reportApprovalStatus"] = "pending"
        report_id = data_service.save_report(enriched)
        enriched = report_service.enrich_report_context({**enriched, "id": report_id})
        data_service.save_report(enriched)
        approval_st = str(enriched.get("reportApprovalStatus") or "").strip().lower()
        if approval_st == "pending":
            _remove_report_pdf_file(report_id)
        else:
            try:
                print_service.save_report_text_files(enriched, report_id, REPORTS_DIR)
            except Exception:
                pass
        _audit_report_created(report_id, enriched)
        return jsonify({"id": report_id, "report": enriched}), 201
    except Exception as e:
        app.logger.exception("Error creating report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/approve", methods=["POST"])
def approve_report(report_id):
    try:
        token = (request.headers.get("X-Approval-Verify-Token") or "").strip()
        verified = None
        if token:
            verified, verify_err = _consume_approval_verify_token("report")
            if verify_err:
                return jsonify({"ok": False, "error": verify_err}), 401
        else:
            # Factory: no verifier modal — same trust model as recipe save (header + server session).
            if _effective_request_role() != "factory":
                return jsonify({"ok": False, "error": "Approval verification is required."}), 401
            cur = data_service.get_current_user() or {}
            display_name = (request.headers.get("X-User-Name") or "").strip() or (
                (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "Factory"
            )
            username_raw = (
                (request.headers.get("X-User-Username") or "").strip()
                or (cur.get("username") or "").strip()
                or (cur.get("name") or "").strip()
                or display_name
            )
            verified = {
                "username": username_raw,
                "name": display_name,
                "role": "factory",
            }
        body = request.get_json(force=True, silent=True) or {}
        pf = (body.get("passFail") or body.get("pass_fail") or "").strip().upper()
        drum_raw = body.get("drumPassFail") or body.get("drum_pass_fail") or {}
        drum1_pf = (drum_raw.get("drum1") or body.get("drum1PassFail") or body.get("drum1_pass_fail") or pf or "").strip().upper()
        drum2_pf = (drum_raw.get("drum2") or body.get("drum2PassFail") or body.get("drum2_pass_fail") or pf or "").strip().upper()
        stroke_pf = (body.get("strokePassFail") or body.get("stroke_pass_fail") or "").strip().upper()
        temp_pf = (body.get("tempPassFail") or body.get("temp_pass_fail") or "").strip().upper()
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        report_type_norm = str(report.get("type") or "test").strip().lower() or "test"
        is_validation = report_type_norm == "validation"
        if is_validation:
            if stroke_pf not in ("PASS", "FAIL") or temp_pf not in ("PASS", "FAIL"):
                return jsonify({"ok": False, "error": "Stroke and Temperature passFail must each be PASS or FAIL"}), 400
            pf = "FAIL" if ("FAIL" in (stroke_pf, temp_pf)) else "PASS"
            # Keep drum fields valid for shared persistence paths
            if drum1_pf not in ("PASS", "FAIL"):
                drum1_pf = pf
            if drum2_pf not in ("PASS", "FAIL"):
                drum2_pf = pf
        else:
            if drum1_pf not in ("PASS", "FAIL") or drum2_pf not in ("PASS", "FAIL"):
                return jsonify({"ok": False, "error": "Each drum passFail must be PASS or FAIL"}), 400
            if pf not in ("PASS", "FAIL"):
                pf = "FAIL" if ("FAIL" in (drum1_pf, drum2_pf)) else "PASS"
        if token and verified:
            token_report_type = str(verified.get("reportType") or "test").strip().lower() or "test"
            actual_report_type = str(report.get("type") or "test").strip().lower() or "test"
            if token_report_type != actual_report_type:
                return jsonify(
                    {"ok": False, "error": "Approval verification was issued for a different report type."}
                ), 401
        verified_username = _norm_username(verified.get("username"))
        verified_username_raw = str(verified.get("username") or "").strip()
        st_raw = report.get("reportApprovalStatus")
        st = str(st_raw or "").strip().lower()
        if st_raw is None:
            return jsonify({"ok": False, "error": "Report does not require approval"}), 400
        if st == "approved":
            existing_approver = _norm_username(report.get("approvedByUsername"))
            if existing_approver and existing_approver == verified_username:
                return jsonify({"ok": False, "error": "Same person cannot approve twice"}), 409
            return jsonify({"ok": True, "report": report, "preview": report_service.get_report_preview_data(report)}), 200
        if st != "pending":
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
        op_username = _report_operated_by_username(report)
        if op_username and verified_username == op_username and _effective_request_role() != "factory":
            return jsonify({"ok": False, "error": "Operator cannot approve their own report."}), 403
        verified_name = (verified.get("name") or verified.get("username") or approver_name or "—").strip()
        verified_role = (verified.get("role") or role_header or "").strip()
        by_line = verified_name
        if verified_role:
            by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
        report["reportApprovalStatus"] = "approved"
        report["approvalPassFail"] = pf
        report["drumPassFail"] = {"drum1": drum1_pf, "drum2": drum2_pf}
        if is_validation:
            report["strokePassFail"] = stroke_pf
            report["tempPassFail"] = temp_pf
            runs = report.get("validationRuns")
            if isinstance(runs, list):
                updated_runs = []
                for run in runs:
                    if not isinstance(run, dict):
                        updated_runs.append(run)
                        continue
                    r = dict(run)
                    sub = str(r.get("validationSubtype") or "").strip().lower()
                    if sub == "stroke":
                        r["approvalPassFail"] = stroke_pf
                    elif sub == "temp":
                        r["approvalPassFail"] = temp_pf
                    updated_runs.append(r)
                report["validationRuns"] = updated_runs
        report["approvalRemarks"] = remarks
        if remarks:
            report["remarks"] = remarks
        report["approvedBy"] = by_line
        # Preserve original username casing for display; comparisons use verified_username (lower).
        report["approvedByUsername"] = verified_username_raw or verified_username
        report["approvedAt"] = _utc_now_iso()
        td = report.get("testData")
        if isinstance(td, dict):
            results = td.get("stepResults")
            drum_pfs = [drum1_pf, drum2_pf]
            if isinstance(results, list):
                for idx, row in enumerate(results):
                    if isinstance(row, dict):
                        row_pf = drum_pfs[idx] if idx < len(drum_pfs) else pf
                        row["resultText"] = row_pf
                        row["approvalPassFail"] = row_pf
                        if not row.get("drumLabel"):
                            row["drumLabel"] = "Drum {}".format(idx + 1)
            td["approvalPassFail"] = pf
            td["drumPassFail"] = {"drum1": drum1_pf, "drum2": drum2_pf}
            if is_validation:
                td["strokePassFail"] = stroke_pf
                td["tempPassFail"] = temp_pf
                if isinstance(report.get("validationRuns"), list):
                    td["validationRuns"] = report["validationRuns"]
            if remarks:
                td["remarks"] = remarks
            report["testData"] = td
        data_service.save_report(report)
        try:
            print_service.save_report_text_files(report, report_id, REPORTS_DIR)
        except Exception:
            pass
        pdf_ok = False
        try:
            pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
        except Exception:
            app.logger.exception("Approved-report PDF generation failed for id %s", report_id)
        if is_validation:
            is_aborted_val = bool(report.get("aborted")) or str(report.get("status") or "").upper() == "ABORTED"
            if not is_aborted_val and pf == "PASS":
                try:
                    report_service.apply_pending_validation_due(report)
                except Exception:
                    app.logger.exception("Failed to apply pending validation due dates after approval")
                try:
                    # Keep legacy instrument-wide pair in sync when no pending due was present
                    if not isinstance(report.get("pendingValidationDue"), dict):
                        report_service.sync_factory_validation_dates()
                except Exception:
                    app.logger.exception("Failed to sync factory validation dates after validation approval")
        if pdf_ok:
            _audit_report_pdf_generated(report_id, report)
        ctx = _format_report_audit_details(report_id, report)
        appr_detail = "{} | {} | verified by {}".format(ctx, pf, verified_name)
        if is_validation:
            appr_detail = "{} | stroke={} temp={} | verified by {}".format(
                ctx, stroke_pf, temp_pf, verified_name
            )
        v_audit_user = verified.get("username") or verified_username or verified_name
        v_audit_role = (verified.get("role") or "").strip() or "--"
        rtype = str(report.get("type") or "test").strip().lower() or "test"
        if rtype == "validation":
            approve_action = "Validation report approved"
        elif rtype == "calibration":
            approve_action = "Calibration report approved"
        else:
            approve_action = "Test report approved"
        _audit(
            v_audit_user,
            v_audit_role,
            approve_action,
            appr_detail,
        )
        return jsonify({"ok": True, "report": report, "preview": report_service.get_report_preview_data(report)}), 200
    except Exception as e:
        app.logger.exception("Error approving report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/abort", methods=["POST"])
def abort_report(report_id):
    """Discard a pending report that was never approved (not listed until approved)."""
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        rtype = (report.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden. You do not have permission to abort validation reports.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test"],
                "Forbidden. You do not have permission to abort test reports.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden.")
        if gate:
            return gate
        if rtype not in ("test", "validation"):
            return jsonify({"ok": False, "error": "Report type cannot be aborted"}), 400
        st = (report.get("reportApprovalStatus") or "").strip().lower()
        if st != "pending":
            return jsonify({"ok": False, "error": "Only unapproved reports can be discarded"}), 400
        cur = data_service.get_current_user() or {}
        session_un = _norm_username(cur.get("username") or cur.get("name"))
        op_un = _report_operated_by_username(report)
        role = _effective_request_role()
        if role != "factory" and session_un != op_un:
            return jsonify({"ok": False, "error": "Only the operator or Factory can discard this report."}), 403
        ctx = _format_report_audit_details(report_id, report)
        data_service.delete_report(report_id)
        _remove_report_pdf_file(report_id)
        _audit(session_un or None, role or None, "Pending report discarded", ctx)
        return jsonify({"ok": True, "discarded": True}), 200
    except Exception as e:
        app.logger.exception("Error discarding pending report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/discard", methods=["POST"])
def discard_pending_report(report_id):
    """Remove an unapproved pending report when preview is closed without approval."""
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        st = (report.get("reportApprovalStatus") or "").strip().lower()
        if st != "pending":
            return jsonify({"ok": False, "error": "Only unapproved reports can be discarded"}), 400
        rtype = (report.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test", "reports-view"],
                "Forbidden.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden.")
        if gate:
            return gate
        ctx = _format_report_audit_details(report_id, report)
        data_service.delete_report(report_id)
        _remove_report_pdf_file(report_id)
        cur = data_service.get_current_user() or {}
        session_un = _norm_username(cur.get("username") or cur.get("name"))
        role = _effective_request_role()
        _audit(session_un or None, role or None, "Pending report discarded", ctx)
        return jsonify({"ok": True, "discarded": True}), 200
    except Exception as e:
        app.logger.exception("Error discarding pending report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["GET"])
def get_report(report_id):
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if report:
            return jsonify({"report": report}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["DELETE"])
def delete_report(report_id):
    try:
        gate = _require_session_internal("reports-delete", "Forbidden. You do not have permission to delete reports.")
        if gate:
            return gate
        existing = data_service.get_report(report_id)
        success = data_service.delete_report(report_id)
        if success:
            details = (
                _format_report_audit_details(report_id, existing)
                if existing
                else str(report_id)
            )
            _audit(None, None, "Report deleted", details)
            return jsonify({"success": True}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting report")
        return jsonify({"error": str(e)}), 500


# =================== DATA: MEMBERS ==========================


@app.route("/api/data/members", methods=["GET"])
def get_members():
    try:
        gate = _require_session_internal("user-manage", "Forbidden. You do not have permission to manage users.")
        if gate:
            return gate
        members = data_service.list_members()
        safe = [data_service.sanitize_member_for_client(m) or m for m in members]
        return jsonify({"members": safe}), 200
    except Exception as e:
        app.logger.exception("Error listing members")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members", methods=["POST"])
def create_member():
    try:
        gate = _require_session_internal("user-add", "Forbidden. You do not have permission to add users.")
        if gate:
            return gate
        member_data = request.get_json(force=True, silent=True) or {}
        if _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. You do not have permission to assign permission cards."}), 403
        member_id = data_service.save_member(member_data)
        created = data_service.get_member(member_id) or dict(member_data)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        uname = created.get("username") or created.get("name") or ""
        urole = created.get("role") or ""
        _audit_event(
            action="Added new user",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details=_member_permission_initial_detail(created, uname, urole),
            target_user=uname,
            after=data_service.sanitize_member_for_client(created) or created,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(created) or dict(created)
        return jsonify({"id": member_id, "member": safe}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["GET"])
def get_member(member_id):
    try:
        gate = _require_user_manage_or_self(member_id)
        if gate:
            return gate
        member = data_service.get_member(member_id)
        if member:
            return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["PUT"])
def update_member(member_id):
    try:
        gate = _require_user_manage_or_self(member_id)
        if gate:
            return gate
        member_data = request.get_json(force=True, silent=True) or {}
        before_member = data_service.get_member(member_id)
        if not before_member:
            return jsonify({"error": "Member not found"}), 404
        is_self = _is_self_member(member_id)
        if is_self:
            try:
                member_data = _self_profile_payload_from_request(before_member, member_data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
        elif _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if not is_self and data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. You do not have permission to assign permission cards."}), 403
        member_data["id"] = member_id
        # Empty password means "keep current" — never wipe credentials by accident.
        if "password" in member_data and not str(member_data.get("password") or "").strip():
            member_data.pop("password", None)
        cur = data_service.get_current_user() or {}
        acting_id = cur.get("id")
        old_password = str((before_member or {}).get("password") or "")
        new_password = str(member_data.get("password") or "")
        password_changed = "password" in member_data and new_password not in ("", old_password)
        if password_changed:
            if is_self:
                return jsonify({
                    "error": "Use Change Password (current password required) to update your password.",
                }), 400
            pwd_err = _password_strength_error(new_password)
            if pwd_err:
                return jsonify({"error": pwd_err}), 400
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or dict(member_data)
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        if password_changed:
            _audit_event(
                action="Password changed",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Password changed for user: {}".format(uname),
                target_user=uname,
                signature=sig,
            )
        permission_detail = _member_permission_change_detail(before_member, updated, uname)
        profile_detail = _member_profile_change_detail(before_member, updated, uname)
        update_details = permission_detail or profile_detail
        if not update_details and not password_changed:
            update_details = "Profile updated for {}".format(uname or "--")
        if update_details:
            _audit_event(
                action="User update",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details=update_details,
                target_user=uname,
                before=data_service.sanitize_member_for_client(before_member) if before_member else None,
                after=data_service.sanitize_member_for_client(updated) or updated,
                signature=sig,
            )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"id": member_id, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["DELETE"])
def delete_member(member_id):
    try:
        gate = _require_session_internal("user-delete", "Forbidden. You do not have permission to delete users.")
        if gate:
            return gate
        member = data_service.get_member(member_id)
        if not member:
            return jsonify({"error": "Member not found"}), 404
        verified, verify_err = _require_user_admin_verification()
        target_uname = member.get("username") or member.get("name") or ""
        cur = data_service.get_current_user() or {}
        actor_uname = (cur.get("username") or cur.get("name") or "").strip() or "--"
        if not verified:
            _audit_event(
                action="User disable",
                outcome="denied",
                entity_type="member",
                entity_id=member_id,
                entity_name=target_uname,
                details="Disable denied for User ID {} by User ID {} | {}".format(
                    target_uname or "--",
                    actor_uname,
                    verify_err or "Approval verification required",
                ),
                target_user=target_uname,
                before=member,
            )
            return jsonify({"error": verify_err}), 403
        before_member = dict(member)
        template_id = member.get("fingerprintTemplateId")
        verifier_uname = (verified.get("username") or "").strip() if isinstance(verified, dict) else ""
        if template_id is not None:
            deleted = biometric_service.delete_template(template_id)
            if not deleted.get("ok"):
                _audit_event(
                    action="User disable",
                    outcome="failed",
                    entity_type="member",
                    entity_id=member_id,
                    entity_name=target_uname,
                    details="Disable failed for User ID {} by User ID {} | {}{}".format(
                        target_uname or "--",
                        actor_uname,
                        deleted.get("error") or "Failed to delete fingerprint template from sensor",
                        (" | verified by User ID " + verifier_uname) if verifier_uname else "",
                    ),
                    target_user=target_uname,
                    before=before_member,
                    signature={"mode": "password_reconfirm", "username": verified.get("username"), "role": verified.get("role")},
                    extra={"templateId": template_id},
                )
                return jsonify({
                    "error": deleted.get("error") or "Failed to delete fingerprint template from sensor",
                    "templateId": int(template_id)
                }), 400
            data_service.clear_member_biometric(member_id)
        member = data_service.disable_member(member_id)
        _audit_event(
            action="User disable",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or target_uname,
            details=_member_admin_action_detail("disabled", target_uname, actor_uname, verifier_uname),
            target_user=member.get("username") or target_uname,
            before=before_member,
            after=member,
            signature={"mode": "password_reconfirm", "username": verified.get("username"), "role": verified.get("role")},
            extra={"templateIdFreed": template_id},
        )
        return jsonify({"success": True, "member": member}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error deleting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>/unlock", methods=["POST"])
def unlock_member_route(member_id):
    if not _session_has_internal("user-unlock"):
        return jsonify({"error": "Forbidden. Unlock requires profile management permission."}), 403
    try:
        before_member = data_service.get_member(member_id)
        cur = data_service.get_current_user() or {}
        actor_uname = (cur.get("username") or cur.get("name") or "").strip() or "--"
        target_uname = ""
        if before_member:
            target_uname = before_member.get("username") or before_member.get("name") or ""
        sig = {
            "mode": "session",
            "username": actor_uname,
            "role": (cur.get("role") or "").strip() or "--",
        }
        member = data_service.unlock_member(member_id)
        target_uname = member.get("username") or member.get("name") or target_uname
        _audit_event(
            action="User unlock",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=target_uname,
            details=_member_admin_action_detail("unlocked (restriction cleared)", target_uname, actor_uname),
            target_user=target_uname,
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(member) or member,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(member) or dict(member)
        return jsonify({"success": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error unlocking member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>/enable", methods=["POST"])
def enable_member_route(member_id):
    if not _session_has_internal("user-enable"):
        return jsonify({"error": "Forbidden. Enable requires profile management permission."}), 403
    try:
        before_member = data_service.get_member(member_id)
        cur = data_service.get_current_user() or {}
        actor_uname = (cur.get("username") or cur.get("name") or "").strip() or "--"
        target_uname = ""
        if before_member:
            target_uname = before_member.get("username") or before_member.get("name") or ""
        sig = {
            "mode": "session",
            "username": actor_uname,
            "role": (cur.get("role") or "").strip() or "--",
        }
        member = data_service.enable_member(member_id)
        target_uname = member.get("username") or member.get("name") or target_uname
        _audit_event(
            action="User enable",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=target_uname,
            details=_member_admin_action_detail("enabled", target_uname, actor_uname),
            target_user=target_uname,
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(member) or member,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(member) or dict(member)
        return jsonify({"success": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error enabling member")
        return jsonify({"error": str(e)}), 500


# =================== DATA: FACTORY SETTINGS ==========================


@app.route("/api/data/factory-settings", methods=["GET"])
def get_factory_settings():
    try:
        settings = data_service.get_factory_settings() or {}
        return jsonify({"settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error getting factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings", methods=["POST"])
def save_factory_settings():
    try:
        settings = request.get_json(force=True, silent=True) or {}
        if not isinstance(settings, dict):
            settings = {}
        before = data_service.get_factory_settings() or {}
        data_service.save_factory_settings(settings)
        saved = data_service.get_factory_settings() or {}
        date_keys = {"lastValidationDate", "nextValidationDate", "dueIntervalMonths", "dueKind"}
        changed = []
        for key in set(list(before.keys()) + list(saved.keys())):
            if before.get(key) != saved.get(key):
                changed.append(key)
        non_date_changed = [k for k in changed if k not in date_keys]
        # Hardness-Cfr: only log when non-date factory fields actually change.
        if non_date_changed:
            _audit(
                None,
                None,
                "Factory settings changed",
                "Changed: {}".format(", ".join(sorted(non_date_changed))),
            )
        return jsonify({"success": True, "settings": saved}), 200
    except Exception as e:
        app.logger.exception("Error saving factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-reset", methods=["POST"])
def factory_reset():
    try:
        user = data_service.get_current_user()
        if not user or (user.get("role") or "").strip().lower() != "factory":
            return jsonify({"error": "Forbidden. Factory role required."}), 403

        data_service.delete_session_power_audit_pending()
        result = data_service.factory_reset()
        data_service.touch_app_clean_stop_flag()

        audit_removed = audit_service.clear_all_entries()
        audit_remaining = audit_service.entry_count()
        if audit_remaining > 0:
            audit_removed += audit_service.clear_all_entries()
            audit_remaining = audit_service.entry_count()

        biometric_cleared = False
        biometric_remaining = None
        biometric_error = None
        try:
            # Stop any in-progress scan, then wipe all templates from the R307.
            try:
                biometric_service.cancel_and_idle()
            except Exception:
                pass
            with _enroll_sessions_lock:
                _enroll_sessions.clear()
            bio_result = biometric_service.clear_templates()
            biometric_cleared = bool(bio_result and bio_result.get("ok"))
            if bio_result:
                biometric_remaining = bio_result.get("templatesRemaining")
                if not biometric_cleared:
                    biometric_error = bio_result.get("error")
            if biometric_cleared and biometric_remaining not in (None, 0):
                # Retry once if sensor still reports templates
                bio_result = biometric_service.clear_templates()
                biometric_cleared = bool(bio_result and bio_result.get("ok"))
                biometric_remaining = (bio_result or {}).get("templatesRemaining")
        except Exception as bio_err:
            biometric_error = str(bio_err)
            app.logger.warning("Factory reset: biometric clear skipped: %s", bio_err)

        if DATETIME_STORAGE.exists():
            try:
                DATETIME_STORAGE.unlink()
            except Exception:
                pass

        return jsonify({
            "success": True,
            "deleted": result["deleted"],
            "auditRowsRemoved": audit_removed,
            "auditRowsRemaining": audit_remaining,
            "biometricTemplatesCleared": biometric_cleared,
            "biometricTemplatesRemaining": biometric_remaining,
            "biometricClearError": biometric_error,
            "requiresLogin": True,
        }), 200
    except Exception as e:
        app.logger.exception("Error during factory reset")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUTH ==========================


def _password_strength_error(password: str) -> str:
    pwd = str(password or "")
    if len(pwd) < 8:
        return "Password must be at least 8 characters."
    if not any(ch.isupper() for ch in pwd):
        return "Password must include at least one uppercase letter."
    if not any(ch.islower() for ch in pwd):
        return "Password must include at least one lowercase letter."
    if not any(ch.isdigit() for ch in pwd):
        return "Password must include at least one numeric digit."
    if pwd.isalnum():
        return "Password must include at least one special character."
    return ""


@app.route("/api/data/auth/login", methods=["POST"])
def login():
    try:
        credentials = request.get_json(force=True, silent=True) or {}
        if not isinstance(credentials, dict):
            credentials = {}
        username = (credentials.get("username") or "").strip()
        raw_pw = credentials.get("password")
        if isinstance(raw_pw, str):
            password = raw_pw
        elif raw_pw is None:
            password = ""
        else:
            password = str(raw_pw)
        # Factory user: special case, not subject to lockout
        if username.upper() == data_service.FACTORY_USERNAME.upper():
            user = data_service.authenticate_user(username, password)
            if user:
                data_service.save_current_user(user)
                data_service.write_session_power_audit_pending(user)
                _audit_event(
                    action="Login",
                    outcome="success",
                    entity_type="session",
                    entity_name="password",
                    details="User logged in: {}".format(username),
                    target_user=username,
                    after={"username": user.get("username"), "role": user.get("role")},
                )
                return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user}), 200
            _audit_event(
                action="Login",
                outcome="denied",
                entity_type="session",
                entity_name="password",
                details="Wrong password | User ID entered: {}".format(username or "--"),
                target_user=username,
                actor_user=username or "--",
                actor_role="--",
            )
            return jsonify({"error": "Invalid username or password"}), 401

        # Normal member: check status first
        member = data_service.get_member_by_username(username)
        if member:
            status = str(member.get("status") or "active").strip().lower()
            attempt = _login_attempt_actor(username, member)
            if status == "locked":
                _audit_event(
                    action="Login",
                    outcome="denied",
                    entity_type="session",
                    entity_name="password",
                    details="Account restricted (locked) | User ID entered: {}".format(username or "--"),
                    target_user=username,
                    actor_user=attempt["user"],
                    actor_role=attempt["role"],
                )
                return jsonify({"error": "Account locked. Contact admin."}), 403
            if status == "disabled":
                _audit_event(
                    action="Login",
                    outcome="denied",
                    entity_type="session",
                    entity_name="password",
                    details="Account disabled | User ID entered: {}".format(username or "--"),
                    target_user=username,
                    actor_user=attempt["user"],
                    actor_role=attempt["role"],
                )
                return jsonify({"error": "Account disabled by admin."}), 403

        # Try authenticate
        user = data_service.authenticate_user(username, password)
        if user:
            member = data_service.get_member_by_username(username)
            if member:
                attempt = _login_attempt_actor(username, member)
                if bool(member.get("mustChangePassword")):
                    _audit_event(
                        action="Login",
                        outcome="denied",
                        entity_type="session",
                        entity_name="password",
                        details="Mandatory password reset required | User ID entered: {}".format(username or "--"),
                        target_user=username,
                        actor_user=attempt["user"],
                        actor_role=attempt["role"],
                    )
                    return jsonify(
                        {
                            "error": "Password change required before login.",
                            "passwordChangeRequired": True,
                            "username": username,
                        }
                    ), 403
                expiry = data_service.get_member_password_expiry_state(member)
                if bool(expiry.get("expired")):
                    _audit_event(
                        action="Login",
                        outcome="denied",
                        entity_type="session",
                        entity_name="password",
                        details="Password expired - reset required | User ID entered: {}".format(username or "--"),
                        target_user=username,
                        actor_user=attempt["user"],
                        actor_role=attempt["role"],
                        extra={"passwordExpiry": expiry},
                    )
                    return jsonify({
                        "error": "Password expired. Reset required.",
                        "passwordExpired": True,
                        "username": username,
                        "expiry": expiry,
                    }), 403
            data_service.record_successful_login(username)
            data_service.save_current_user(user)
            data_service.refresh_current_user_from_member()
            data_service.write_session_power_audit_pending(data_service.get_current_user() or user)
            _audit_event(
                action="Login",
                outcome="success",
                entity_type="session",
                entity_name="password",
                details="User logged in: {}".format(username),
                target_user=username,
                after={"username": user.get("username"), "role": user.get("role")},
            )
            safe_user = data_service.sanitize_member_for_client(data_service.get_current_user() or user) or user
            return jsonify({"success": True, "user": safe_user}), 200

        # Wrong password: increment failedAttempts (may lock at 3)
        updated = data_service.record_failed_login(username)
        if updated:
            status = str(updated.get("status") or "").strip().lower()
            try:
                fa = int(updated.get("failedAttempts") or 0)
            except (TypeError, ValueError):
                fa = 0
            remaining = max(0, 3 - fa)
            attempt = _login_attempt_actor(username, updated)
            _audit_event(
                action="Login",
                outcome="denied",
                entity_type="session",
                entity_name="password",
                details="Wrong password | User ID entered: {} | attempt {}/3 | remaining: {}".format(
                    username or "--", fa, remaining
                ),
                target_user=username,
                actor_user=attempt["user"],
                actor_role=attempt["role"],
                extra={"remainingAttempts": remaining, "failedAttempts": fa},
            )
            # If this attempt caused the account to become locked, show lockout immediately
            if status == "locked" and fa >= 3:
                _audit_event(
                    action="User restrict",
                    outcome="success",
                    entity_type="member",
                    entity_id=updated.get("id"),
                    entity_name=username,
                    details="User ID {} restricted (locked) after {} failed password attempts".format(
                        username or "--", fa
                    ),
                    target_user=username,
                    actor_user=attempt["user"],
                    actor_role=attempt["role"],
                    after=data_service.sanitize_member_for_client(updated) or updated,
                    extra={"failedAttempts": fa, "status": "locked"},
                )
                return jsonify({
                    "error": "Account locked. Contact admin.",
                    "remainingAttempts": 0
                }), 403
            return jsonify({
                "error": "Invalid username or password.",
                "remainingAttempts": remaining
            }), 401
        # Unknown username (no member record) — still log the attempted User ID
        _audit_event(
            action="Login",
            outcome="denied",
            entity_type="session",
            entity_name="password",
            details="Wrong password | User ID entered: {}".format(username or "--"),
            target_user=username,
            actor_user=username or "--",
            actor_role="--",
        )
        return jsonify({"error": "Invalid username or password"}), 401
    except Exception as e:
        app.logger.exception("Error during login")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/password-expired-reset", methods=["POST"])
def password_expired_reset():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not username or not old_password or not new_password:
            return jsonify({"ok": False, "error": "username, oldPassword and newPassword are required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        if str(member.get("username", "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"ok": False, "error": "Factory account is excluded from this flow"}), 403
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        expiry = data_service.get_member_password_expiry_state(member)
        if not bool(expiry.get("expired")):
            return jsonify({"ok": False, "error": "Password is not expired for this account"}), 400
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from old password"}), 400
        updated_member = data_service.set_member_password(int(member.get("id")), new_password)
        data_service.clear_mandatory_password_reset_flags(int(member.get("id")))
        updated_member = data_service.get_member(int(member.get("id"))) or updated_member
        data_service.record_successful_login(username)
        safe_member = data_service.sanitize_member_for_client(updated_member) or dict(updated_member)
        _audit_event(
            action="Password reset",
            outcome="success",
            entity_type="member",
            entity_id=updated_member.get("id"),
            entity_name=updated_member.get("username") or updated_member.get("name") or "",
            details="Password reset after expiry",
            target_user=updated_member.get("username") or "",
        )
        return jsonify({"ok": True, "member": safe_member}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error resetting expired password")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/mandatory-password-reset", methods=["POST"])
def mandatory_password_reset():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not username or not old_password or not new_password:
            return jsonify({"ok": False, "error": "username, oldPassword and newPassword are required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        if str(member.get("username", "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"ok": False, "error": "Factory account is excluded from this flow"}), 403
        if not bool(member.get("mustChangePassword")):
            return jsonify({"ok": False, "error": "Password change is not required for this account"}), 400
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from your current password."}), 400
        if data_service.new_password_matches_creation_commitment(member, new_password):
            return jsonify(
                {"ok": False, "error": "New password must be different from the password set when your account was created."}
            ), 400
        data_service.complete_mandatory_password_reset(username, new_password)
        data_service.record_successful_login(username)
        refreshed = data_service.get_member(int(member.get("id")))
        user = dict(refreshed) if refreshed else dict(auth_user)
        user.pop("password", None)
        user.pop("creationPasswordSalt", None)
        user.pop("creationPasswordHash", None)
        data_service.save_current_user(user)
        data_service.write_session_power_audit_pending(user)
        safe_user = data_service.sanitize_member_for_client(user) or user
        _audit_event(
            action="Password reset",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=member.get("username") or member.get("name") or "",
            details="Mandatory first password change completed",
            target_user=member.get("username") or "",
        )
        return jsonify({"ok": True, "user": safe_user}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error during mandatory password reset")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/login-biometric", methods=["POST"])
def login_biometric():
    try:
        if not _is_biometric_enabled():
            return jsonify({"error": "Biometric login is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        timeout_sec = float(payload.get("timeoutSec") or BIOMETRIC_LOGIN_TIMEOUT_SEC)
        identified = biometric_service.identify(timeout_sec=timeout_sec)
        if not identified.get("ok"):
            if identified.get("cancelled"):
                return jsonify({"error": "cancelled", "cancelled": True}), 499
            return jsonify({"error": identified.get("error") or "Fingerprint not recognized"}), 401

        template_id = identified.get("templateId")
        member = data_service.get_member_by_fingerprint_template(template_id)
        if not member:
            return jsonify({"error": "Fingerprint is not linked to any member account"}), 404

        username = member.get("username") or ""
        status = str(member.get("status") or "active").strip().lower()
        attempt = _login_attempt_actor(username, member)
        if status == "locked":
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="Account restricted (locked) | User ID: {}".format(username or "--"),
                target_user=username,
                actor_user=attempt["user"],
                actor_role=attempt["role"],
                extra={"templateId": template_id},
            )
            return jsonify({"error": "Account locked. Contact admin."}), 403
        if status == "disabled":
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="Account disabled | User ID: {}".format(username or "--"),
                target_user=username,
                actor_user=attempt["user"],
                actor_role=attempt["role"],
                extra={"templateId": template_id},
            )
            return jsonify({"error": "Account disabled by admin."}), 403

        if not bool(member.get("biometricEnabled", True)):
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="Biometric disabled for member | User ID: {}".format(username or "--"),
                target_user=username,
                actor_user=attempt["user"],
                actor_role=attempt["role"],
                extra={"templateId": template_id},
            )
            return jsonify({"error": "Biometric login is disabled for this account"}), 403

        if bool(member.get("mustChangePassword")):
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="Mandatory password reset required | User ID: {}".format(username or "--"),
                target_user=username,
                actor_user=attempt["user"],
                actor_role=attempt["role"],
                extra={"templateId": template_id},
            )
            return jsonify(
                {
                    "error": "Password change required before login.",
                    "passwordChangeRequired": True,
                    "username": username,
                }
            ), 403

        user = dict(member)
        user.pop("password", None)
        user.pop("creationPasswordSalt", None)
        user.pop("creationPasswordHash", None)
        data_service.record_successful_login(username)
        data_service.save_current_user(user)
        data_service.write_session_power_audit_pending(user)
        _audit_event(
            action="Biometric login",
            outcome="success",
            entity_type="session",
            entity_name="biometric",
            details="User logged in (biometric): {}".format(username),
            target_user=username,
            after={"username": user.get("username"), "role": user.get("role")},
            extra={"templateId": template_id, "confidence": identified.get("confidence")},
        )
        return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user, "templateId": template_id, "confidence": identified.get("confidence")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric login")
        return jsonify({"error": str(e)}), 500


def _audit_session_logout(user, reason, *, request_source=None):
    """Write one session Logout row for the given user and logout reason."""
    if not user:
        return
    un = (user.get("username") or user.get("name") or "").strip()
    role = (user.get("role") or "").strip()
    reason = str(reason or "user").strip().lower()
    src = request_source or _audit_request_source()
    if audit_service.is_hidden_factory_actor(un, role):
        audit_time = _audit_time_fields()
        if reason == "power_interruption":
            details = (
                "Privileged factory session was active when power was interrupted "
                "or the browser session was refreshed."
            )
        else:
            details = "Privileged factory session ended"
        audit_service.log_structured_event(
            user="--",
            role="--",
            action="Power interruption logout" if reason == "power_interruption" else "Logout",
            outcome="success",
            entity_type="session",
            entity_name="logout",
            details=details,
            event_type="compliance",
            reason=POWER_INTERRUPTION_REMARKS if reason == "power_interruption" else "",
            request_source=src,
            timestamp_ms=audit_time.get("timestamp_ms"),
            date_time=audit_time.get("date_time"),
        )
        return
    if reason == "inactivity":
        fs = data_service.get_factory_settings() or {}
        mins = fs.get("autoLogoutMinutes")
        try:
            mins = int(mins) if mins is not None else 0
        except (TypeError, ValueError):
            mins = 0
        detail = "User logged out due to inactivity timeout: {}".format(un)
        _audit_event(
            action="Logout (inactivity timeout)",
            outcome="success",
            entity_type="session",
            entity_name="logout",
            details=detail,
            target_user=un,
            extra={"autoLogoutMinutes": mins} if mins > 0 else None,
        )
    elif reason == "power_interruption":
        _audit_event(
            action="Power interruption logout",
            outcome="success",
            entity_type="session",
            entity_name="logout",
            details="User logged out due to {}: {}".format(POWER_INTERRUPTION_REMARKS, un),
            reason=POWER_INTERRUPTION_REMARKS,
            target_user=un,
        )
    else:
        _audit_event(
            action="Logout",
            outcome="success",
            entity_type="session",
            entity_name="logout",
            details="User logged out: {}".format(un),
            target_user=un,
        )


def _halt_hardware_on_logout():
    """Abort active DT runs/validation and send global STOP to the ESP."""
    for basket in (1, 2):
        try:
            run = dt_test_service.get_run(basket) or {}
            state = str(run.get("state") or "IDLE").upper()
            if state not in ("IDLE", "COMPLETE", "ABORTED"):
                dt_test_service.stop_test(basket, aborted=True, reason="logout")
        except Exception:
            app.logger.exception("logout: stop_test basket %s failed", basket)
        try:
            stroke = dt_validation_service.get_session("stroke", basket)
            if stroke and str(stroke.get("state") or "").upper() not in ("IDLE", "COMPLETE", "ABORTED", ""):
                dt_validation_service.abort_stroke_validation(basket)
        except Exception:
            app.logger.exception("logout: abort stroke validation basket %s failed", basket)
        try:
            temp = dt_validation_service.get_session("temp", basket)
            if temp and str(temp.get("state") or "").upper() not in ("IDLE", "COMPLETE", "ABORTED", ""):
                dt_validation_service.abort_temp_validation(basket)
        except Exception:
            app.logger.exception("logout: abort temp validation basket %s failed", basket)
    try:
        # Global STOP — motors for all baskets
        result = hardware_service.cmd_stop(None)
        if not result.get("ok"):
            app.logger.warning("logout: global STOP returned not ok: %s", result)
    except Exception:
        app.logger.exception("logout: global STOP to ESP failed")
    try:
        # Force shared bath off
        for owner in list(hardware_service.get_bath_owners() or []):
            hardware_service.release_bath(owner, force_off=True)
        hardware_service.release_bath("manual", force_off=True)
    except Exception:
        app.logger.exception("logout: release bath failed")


@app.route("/api/data/auth/logout", methods=["POST"])
def logout():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        reason = str(payload.get("reason") or "user").strip().lower()
        user = data_service.get_current_user()
        if user:
            _audit_session_logout(user, reason, request_source="POST /api/data/auth/logout")
        _halt_hardware_on_logout()
        data_service.touch_app_clean_stop_flag()
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during logout")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/session-ui-reset", methods=["POST"])
def session_ui_reset():
    """Clear persisted kiosk session when the browser loads or refreshes.

    If a user was still logged in on the bridge, record Logout (power interruption)
    so audit trails do not show the prior session as still active after re-login.
    """
    try:
        user = data_service.get_current_user()
        if user:
            _audit_session_logout(
                user,
                "power_interruption",
                request_source="POST /api/data/auth/session-ui-reset",
            )
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during session UI reset")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/approval-verify", methods=["POST"])
def approval_verify():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        method = str(payload.get("method") or "credentials").strip().lower()
        purpose = str(payload.get("purpose") or "recipe").strip().lower()
        if purpose not in ("recipe", "report", "user_admin", "export", "recipe_disable", "recipe_enable", "calibration"):
            return jsonify({"ok": False, "error": "purpose must be recipe, report, user_admin, export, recipe_disable, recipe_enable, or calibration"}), 400
        verifier = None
        username = (payload.get("username") or "").strip()

        if method == "credentials":
            password = str(payload.get("password") or "").strip()
            if not username or not password:
                return jsonify({"ok": False, "error": "Username and password are required"}), 400
            verifier = data_service.authenticate_user(username, password)
            if not verifier:
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Invalid credentials",
                    target_user=username,
                    extra={"purpose": purpose, "attemptedUser": username, "method": "credentials"},
                )
                return jsonify({"ok": False, "error": "Invalid verifier username or password"}), 401
        elif method == "biometric":
            if not _is_biometric_enabled():
                return jsonify({"ok": False, "error": "Biometric login is disabled by Factory Settings."}), 403
            timeout_sec = float(payload.get("timeoutSec") or BIOMETRIC_LOGIN_TIMEOUT_SEC)
            identified = biometric_service.identify(timeout_sec=timeout_sec)
            if not identified.get("ok"):
                if identified.get("cancelled"):
                    return jsonify({"ok": False, "error": "cancelled", "cancelled": True}), 499
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details=identified.get("error") or "Biometric identify failed",
                    target_user="--",
                    extra={"purpose": purpose, "method": "biometric"},
                )
                return jsonify({"ok": False, "error": identified.get("error") or "Fingerprint not recognized"}), 401
            template_id = identified.get("templateId")
            member = data_service.get_member_by_fingerprint_template(template_id)
            if not member:
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details="No member mapped to fingerprint",
                    target_user="--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Fingerprint is not linked to any member account"}), 404
            status = str(member.get("status") or "active").strip().lower()
            if status != "active":
                _audit_event(
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier account not active",
                    target_user=member.get("username") or "--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Verifier account is not active"}), 403
            if not bool(member.get("biometricEnabled", True)):
                _audit_event(
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier biometric disabled",
                    target_user=member.get("username") or "--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Biometric login is disabled for this account"}), 403
            verifier = dict(member)
            username = verifier.get("username") or ""
        else:
            return jsonify({"ok": False, "error": "Unsupported verification method"}), 400

        verifier_role = str(verifier.get("role") or "").strip().lower()
        report_type_for_verify = None
        if purpose == "report":
            report_type_for_verify = _resolve_report_type_for_approval_verify(payload)
            eligible = _approval_verifier_eligible_for_report(verifier, report_type_for_verify)
        elif purpose == "recipe":
            eligible = _approval_verifier_eligible_for_recipe(verifier)
        elif purpose == "recipe_disable":
            eligible = _approval_verifier_eligible_for_recipe_disable(verifier)
        elif purpose == "recipe_enable":
            eligible = _approval_verifier_eligible_for_recipe_enable(verifier)
        elif purpose == "export":
            eligible = _approval_verifier_eligible_for_export(verifier)
            # Same person who is exporting cannot approve their own export.
            if eligible:
                cur = data_service.get_current_user() or {}
                exporter_un = _norm_username(cur.get("username") or cur.get("name"))
                verifier_un = _norm_username(verifier.get("username") or username)
                if exporter_un and verifier_un and exporter_un == verifier_un:
                    _audit_event(
                        action="Approval verification",
                        outcome="denied",
                        entity_type="verification",
                        entity_name=purpose,
                        details="Exporter cannot approve their own export",
                        target_user=verifier.get("username") or username,
                        extra={"purpose": purpose, "method": method},
                    )
                    return jsonify({
                        "ok": False,
                        "error": "You cannot approve your own export. Another user with export approval permission must verify.",
                    }), 403
        elif purpose == "calibration":
            eligible = _approval_verifier_eligible_for_calibration(verifier)
        else:
            eligible = _approval_verifier_eligible_for_user_admin(verifier)
        if not eligible:
            _audit_event(
                action="Approval verification",
                outcome="denied",
                entity_type="verification",
                entity_name=purpose,
                details="Verifier lacks required permission",
                target_user=verifier.get("username") or username,
                extra={"purpose": purpose, "verifierRole": verifier_role, "method": method},
            )
            return jsonify({"ok": False, "error": "Verifier does not have permission for this approval"}), 403

        if verifier_role != "factory":
            member = data_service.get_member_by_username(verifier.get("username") or username)
            if member:
                status = str(member.get("status") or "active").strip().lower()
                if status != "active":
                    _audit_event(
                        action="Approval verification",
                        outcome="denied",
                        entity_type="verification",
                        entity_name=purpose,
                        details="Verifier account not active",
                        target_user=verifier.get("username") or username,
                        extra={"purpose": purpose, "method": method},
                    )
                    return jsonify({"ok": False, "error": "Verifier account is not active"}), 403

        token, token_payload = _issue_approval_verify_token(
            verifier, purpose, report_type=report_type_for_verify if purpose == "report" else None
        )
        vname = verifier.get("username") or username
        _audit_event(
            action="Approval verification",
            outcome="success",
            entity_type="verification",
            entity_name=purpose,
            details="Verification token issued | issued by User ID: {}".format(vname or "--"),
            target_user=vname,
            signature={"mode": method, "username": vname, "role": verifier_role},
            extra={"purpose": purpose, "method": method},
        )
        return jsonify(
            {
                "ok": True,
                "token": token,
                "expiresInSec": APPROVAL_VERIFY_TTL_SECONDS,
                "verifier": {
                    "username": token_payload.get("username"),
                    "name": token_payload.get("name"),
                    "role": token_payload.get("role"),
                },
            }
        ), 200
    except Exception as e:
        app.logger.exception("Error during approval verification")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/current-user", methods=["GET"])
def get_current_user_route():
    try:
        user = data_service.refresh_current_user_from_member() or data_service.get_current_user()
        if user:
            user = data_service.sanitize_member_for_client(user) or user
        return jsonify({"user": user}), 200
    except Exception as e:
        app.logger.exception("Error getting current user")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/profile", methods=["GET"])
def get_own_profile():
    """Any logged-in member may read their own profile (for the User Profile screen)."""
    try:
        err = _require_auth()
        if err:
            return err
        member, cur = _resolve_session_member_record()
        if member:
            return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
        if cur:
            return jsonify({"member": data_service.sanitize_member_for_client(cur) or cur}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting own profile")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/profile", methods=["PUT"])
def update_own_profile():
    """Any logged-in member may change their own display name and password."""
    try:
        err = _require_auth()
        if err:
            return err
        payload = request.get_json(force=True, silent=True) or {}
        member, cur = _resolve_session_member_record()
        if not member:
            if cur and str((cur.get("username") or "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
                return jsonify({"error": "Factory profile is managed locally on this device."}), 400
            return jsonify({"error": "Member not found"}), 404
        member_id = int(member.get("id"))
        before_member = dict(member)
        try:
            member_data = _self_profile_payload_from_request(before_member, payload)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        name_in = "name" in payload and str(payload.get("name") or "").strip()
        pwd_in = "password" in payload and str(payload.get("password") or "").strip()
        if not name_in and not pwd_in:
            return jsonify({"error": "Provide a name and/or new password to save."}), 400
        acting_id = _session_member_id()
        password_changed = pwd_in
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or member_data
        data_service.refresh_current_user_from_member()
        cur_after = data_service.get_current_user() or {}
        sig = {
            "mode": "self",
            "username": (cur_after.get("username") or cur_after.get("name") or "").strip() or "--",
            "role": (cur_after.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        if password_changed:
            _audit_event(
                action="Password changed",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Password changed (self) for user: {}".format(uname),
                target_user=uname,
                signature=sig,
            )
        _audit_event(
            action="Profile updated",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Profile updated (self)",
            target_user=uname,
            before=data_service.sanitize_member_for_client(before_member),
            after=data_service.sanitize_member_for_client(updated) or updated,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"ok": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating own profile")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUDIT LOG ==========================


def _require_export_usb_and_verification_json():
    """Return (error_response_or_None, export_approval_verifier_payload_or_None)."""
    cur = data_service.get_current_user()
    if not cur:
        return (jsonify({"success": False, "error": "Unauthorized"}), 401), None
    data_service.refresh_current_user_from_member()
    if not _session_has_internal("export-usb"):
        return (
            jsonify({"success": False, "error": "Forbidden. Export to USB is not permitted for this account."}),
            403,
        ), None
    role = str(cur.get("role") or "").strip().lower()
    verifier = None
    if role != "factory":
        _verified, verify_err = _consume_approval_verify_token("export")
        if verify_err:
            return (jsonify({"success": False, "error": verify_err}), 401), None
        # Same person who is exporting cannot approve their own export.
        exporter_un = _norm_username(cur.get("username") or cur.get("name"))
        verifier_un = _norm_username((_verified or {}).get("username") or (_verified or {}).get("name"))
        if exporter_un and verifier_un and exporter_un == verifier_un:
            return (
                jsonify({
                    "success": False,
                    "error": "You cannot approve your own export. Another user with export approval permission must verify.",
                }),
                403,
            ), None
        verifier = _verified
    return None, verifier


def _resolve_employee_id(username: str, role: str = "") -> str:
    uname = str(username or "").strip()
    if not uname:
        return "--"
    member = data_service.get_member_by_username(uname)
    if member:
        emp = member.get("employeeId") or member.get("employee_id")
        if emp is not None and str(emp).strip():
            return str(emp).strip()
    return uname


def _export_actor_snapshot(user_dict: dict) -> dict:
    username = str(user_dict.get("username") or user_dict.get("name") or "").strip() or "--"
    role = str(user_dict.get("role") or "").strip() or "--"
    return {
        "username": username,
        "employee_id": _resolve_employee_id(username, role),
        "role": role,
    }


def _export_actor_from_verifier(verifier: dict) -> dict:
    if not verifier:
        return {}
    return _export_actor_snapshot(
        {
            "username": verifier.get("username") or verifier.get("name"),
            "role": verifier.get("role"),
        }
    )


def _stage_report_usb_export(cur, verifier, exported_report_ids):
    ids = []
    for rid in exported_report_ids or []:
        try:
            n = int(rid)
            if n > 0:
                ids.append(n)
        except (TypeError, ValueError):
            continue
    if not ids:
        return None, None, None
    export_id = secrets.token_urlsafe(16)
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
    data_service.stage_report_export_pending(
        export_id=export_id,
        report_ids=ids,
        exported_by=exported_by,
        approved_by=approved_by,
    )
    return export_id, exported_by, approved_by


def _stage_audit_usb_export(cur, verifier, entry_ids, pdf_path=""):
    ids = []
    for eid in entry_ids or []:
        try:
            n = int(eid)
            if n > 0:
                ids.append(n)
        except (TypeError, ValueError):
            continue
    if not ids:
        return None, None, None
    export_id = secrets.token_urlsafe(16)
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
    audit_service.stage_audit_export_pending(
        export_id=export_id,
        entry_ids=ids,
        exported_by=exported_by,
        approved_by=approved_by,
        pdf_path=str(pdf_path or ""),
    )
    return export_id, exported_by, approved_by


def _format_export_actors_detail(exported_by, approved_by):
    ex_u = (exported_by or {}).get("username") or "--"
    ex_e = (exported_by or {}).get("employee_id") or "--"
    ap_u = (approved_by or {}).get("username") or "--"
    ap_e = (approved_by or {}).get("employee_id") or "--"
    return "exported by {} ({}) | approved by {} ({})".format(ex_u, ex_e, ap_u, ap_e)


def _maybe_purge_scheduled_report_export() -> None:
    try:
        purged = data_service.run_due_report_export_purge(REPORTS_DIR)
    except Exception:
        app.logger.exception("Report export purge check failed")
        return
    if not purged:
        return
    exported = purged.get("exported_by") if isinstance(purged.get("exported_by"), dict) else {}
    approved = purged.get("approved_by") if isinstance(purged.get("approved_by"), dict) else {}
    details = (
        "Report cycle started | Exported by: {} ({}) | Approved by: {} ({})"
    ).format(
        exported.get("username") or "--",
        exported.get("employee_id") or "--",
        approved.get("username") or "--",
        approved.get("employee_id") or "--",
    )
    _audit(None, None, "Report cycle started", details)


def _maybe_purge_scheduled_audit_export() -> None:
    try:
        purged = audit_service.run_due_audit_export_purge()
    except Exception:
        app.logger.exception("Audit export purge check failed")
        return
    if not purged:
        return
    exported = purged.get("exported_by") if isinstance(purged.get("exported_by"), dict) else {}
    approved = purged.get("approved_by") if isinstance(purged.get("approved_by"), dict) else {}
    details = (
        "Audit cycle started | Exported by: {} ({}) | Approved by: {} ({})"
    ).format(
        exported.get("username") or "--",
        exported.get("employee_id") or "--",
        approved.get("username") or "--",
        approved.get("employee_id") or "--",
    )
    _audit(None, None, "Audit cycle started", details)


def _maybe_purge_scheduled_exports() -> None:
    _maybe_purge_scheduled_audit_export()
    _maybe_purge_scheduled_report_export()


# =================== DATA: AUDIT LOG ==========================


def _legacy_require_export_usb_gate_only():
    """Deprecated single-value gate; prefer _require_export_usb_and_verification_json."""
    gate, _verifier = _require_export_usb_and_verification_json()
    return gate
@app.route("/api/data/audit-log", methods=["GET"])
def get_audit_log():
    """Return audit log entries. Requires audit-view permission (Factory bypass in RBAC)."""
    try:
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"error": "Unauthorized"}), 401
        if not _session_has_internal("audit-view"):
            return jsonify({"error": "Forbidden. You do not have permission to view the audit log."}), 403

        if str(request.args.get("log_view") or "").strip() == "1":
            _audit(
                cur.get("username") or cur.get("name"),
                cur.get("role"),
                "Audit log viewed",
                "Audit trails opened",
            )

        user = request.args.get("user")
        filter_role = request.args.get("role")
        action = request.args.get("action")
        from_ts = request.args.get("from")
        to_ts = request.args.get("to")
        filters = {}
        if user:
            filters["user"] = user
        if filter_role:
            filters["role"] = filter_role
        if action:
            filters["action"] = action
        if from_ts:
            try:
                filters["from"] = int(from_ts)
            except (TypeError, ValueError):
                pass
        if to_ts:
            try:
                filters["to"] = int(to_ts)
            except (TypeError, ValueError):
                pass
        entries = audit_service.list_entries(filters)
        return jsonify({"entries": _prepare_audit_entries_for_display(entries)}), 200
    except Exception as e:
        app.logger.exception("Error listing audit log")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/audit-log/event", methods=["POST"])
def create_client_audit_event():
    """Allow UI to emit lifecycle audit events for run navigation/actions."""
    try:
        cur = data_service.get_current_user()
        if not cur or not (cur.get("username") or cur.get("name")):
            return jsonify({"ok": False, "error": "Authentication required"}), 401
        payload = request.get_json(force=True, silent=True) or {}
        action = str(payload.get("action") or "").strip()
        details = str(payload.get("details") or "").strip()
        if not action:
            return jsonify({"ok": False, "error": "action is required"}), 400
        actor = _audit_actor()
        outcome = str(payload.get("outcome") or "success").strip() or "success"
        event_type = str(payload.get("eventType") or payload.get("event_type") or "lifecycle").strip() or "lifecycle"
        entity_type = str(payload.get("entityType") or payload.get("entity_type") or "").strip()
        entity_name = str(payload.get("entityName") or payload.get("entity_name") or "").strip()
        entity_id = payload.get("entityId", payload.get("entity_id"))
        reason = str(payload.get("reason") or "").strip()
        extra = payload.get("extra")
        if extra is None and payload.get("extraJson"):
            extra = payload.get("extraJson")
        audit_time = _audit_time_fields()
        audit_service.log_structured_event(
            user=actor.get("user"),
            role=actor.get("role"),
            action=action,
            details=details,
            event_type=event_type,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            outcome=outcome,
            reason=reason,
            session_user=actor.get("user"),
            session_role=actor.get("role"),
            request_source="POST /api/data/audit-log/event",
            extra=extra,
            timestamp_ms=audit_time.get("timestamp_ms"),
            date_time=audit_time.get("date_time"),
        )
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error creating client audit event")
        return jsonify({"ok": False, "error": str(e)}), 500


def _html_escape(value):
    """HTML-escape a value, treating None as empty."""
    if value is None:
        return ""
    s = str(value)
    return (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace('"', "&quot;")
         .replace("'", "&#39;")
    )


def _format_wall_datetime_for_audit(dt_value) -> str:
    """Human-readable date/time for audit details (dd/mm/yyyy HH:MM:SS)."""
    if dt_value is None:
        return "--"
    s = str(dt_value).strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt_obj = datetime.fromisoformat(clean)
        if getattr(dt_obj, "tzinfo", None) is not None:
            dt_obj = dt_obj.replace(tzinfo=None)
        return dt_obj.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _humanize_audit_details(action: str, details: str) -> str:
    """Normalize verbose/internal audit detail text for UI and PDF export."""
    action = str(action or "").strip()
    details = audit_service._details_audit_display(details)
    if not details:
        if action == "Factory settings changed":
            return "Factory settings updated"
        return details
    if action in ("Power interruption", "Power interruption logout"):
        import re
        if "privileged factory session" in details.lower():
            return "Unclean shutdown during factory session"
        m = re.search(r"User\s+([^\s]+)\s+was logged in", details, re.I)
        if m:
            return "Unclean shutdown while {} was logged in".format(m.group(1))
        m2 = re.search(r"Unclean shutdown while\s+([^\s]+)", details, re.I)
        if m2:
            return "Unclean shutdown while {} was logged in".format(m2.group(1))
        if "kiosk-bridge" in details.lower() or "clean shutdown" in details.lower():
            return "Unclean shutdown during active session"
        return details
    if action == "Reports exported":
        import re
        if details.lower().startswith("exported "):
            return details
        m = re.search(r"\bok=(\d+)", details)
        if m:
            n = int(m.group(1))
            return "Exported {} report{} to USB".format(n, "" if n == 1 else "s")
        return "Exported report(s) to USB"
    if action in ("Print thermal", "Print A4"):
        details = (
            details.replace(" | full data", "")
            .replace("| full data", "")
            .replace(" | inline", "")
            .replace("| inline", "")
            .strip()
        )
        import re
        m = re.search(r"report\s+id\s+(\d+)", details, re.I)
        if m:
            return "Report id {}".format(m.group(1))
        return details
    if action == "Report PDF generated":
        import re
        m = re.search(r"report\s+id\s+(\d+)", details, re.I)
        if not m:
            m = re.search(r"report\s+(\d+)", details, re.I)
        if m:
            rid = m.group(1)
            if "aborted PDF" in details:
                return "Report id {} | aborted PDF".format(rid)
            pf = re.search(r"\|\s*(PASS|FAIL)\s*\|", details, re.I)
            if pf and "approved PDF" in details:
                return "Report id {} | {} | approved PDF".format(rid, pf.group(1))
            if "approved PDF" in details:
                return "Report id {} | approved PDF".format(rid)
            return "Report id {}".format(rid)
        return "Report PDF saved"
    if action in ("Report aborted", "Report aborted (power loss)", "Report approved (power off)",
                  "Pending report discarded", "Report approved", "Test performed", "Quick test performed", "Validation performed"):
        import re
        details = re.sub(
            r"\s*\|\s*awaiting approval \(PDF after approval\)",
            " | awaiting approval",
            details,
            flags=re.I,
        )
        return details
    if action == "System date change":
        if details.lower().startswith("changed from"):
            return details
        import re
        if re.match(r"^\d{4}-\d{2}-\d{2}T", details):
            return "Set to {}".format(_format_wall_datetime_for_audit(details))
        return _format_wall_datetime_for_audit(details)
    # DT disintegration — clearer beaker/basket wording
    if action in (
        "Test preheat started", "Test ready", "Test started", "Test finished", "Test aborted",
        "Validation started", "Validation finished", "Validation aborted",
        "Calibration performed", "Calibration failed",
    ):
        import re
        details = re.sub(r"\bBasket\s+(\d)\b", r"Beaker \1", details, flags=re.I)
        details = re.sub(r"\bbasket\s+(\d)\b", r"beaker \1", details)
        details = re.sub(r"\bmode=([a-zA-Z]+)", r"mode \1", details)
        details = re.sub(r"\bpreheat to\s+", "setpoint ", details, flags=re.I)
        details = re.sub(r"\s*\(TR\d\)\s*", " ", details)
        details = re.sub(r"\s{2,}", " ", details).strip(" |")
        return details
    if action in ("Entered screen", "Exited screen"):
        return details
    if "/opt/kiosk/" in details or "/media/" in details:
        import re
        details = re.sub(
            r"report\s+(\d+)\s*->\s*\S+",
            r"Report id \1",
            details,
            flags=re.I,
        )
        details = re.sub(r"\s*\|\s*dir\s+\S+", "", details, flags=re.I)
    return details


def _audit_entry_should_omit(entry: dict) -> bool:
    """Drop noisy or sensitive rows from operator-facing audit views."""
    action = str(entry.get("action") or "").strip()
    details = str(entry.get("details") or "").strip().lower()
    if action == "Login" and "invalid username" in details:
        return True
    # Per-tube taps flood the trail; keep start/finish/abort only.
    if action == "Tube completed":
        return True
    return False


def _prepare_audit_entries_for_display(entries):
    out = []
    for entry in entries or []:
        if _audit_entry_should_omit(entry):
            continue
        row = dict(entry)
        row["role"] = _display_role_label(row.get("role"))
        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"))
        row["outcome"] = row.get("outcome") or ""
        out.append(row)
    return out


def _build_audit_trail_html(entries, filters, factory):
    """Build a printable A4 audit-trail HTML document.

    Layout: branded header (company/model/serial from factory settings),
    filter summary, then a wide rows-table. Long detail strings wrap. The
    document is rendered to PDF by pdf_generator.render_html_to_pdf, which
    produces an inherently write-protected file.
    """
    factory = factory or {}
    company = _html_escape(factory.get("companyName") or "")
    model = _html_escape(factory.get("modelNo") or "")
    serial = _html_escape(factory.get("serialNo") or "")
    location = _html_escape(factory.get("companyLocation") or factory.get("location") or "")
    instrument_no = _html_escape(factory.get("instrumentId") or "")
    generated_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

    def _fmt_ts(ts):
        try:
            ts_int = int(ts)
        except (TypeError, ValueError):
            return _html_escape(ts) if ts else ""
        if ts_int <= 0:
            return ""
        if ts_int > 10 ** 12:
            ts_int = ts_int // 1000
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts_int))

    def _split_date_time_cell(raw, timestamp_fallback):
        """Return (date_html, time_html). Splits any 'DATE TIME' string on the first space.

        Accepts the pre-formatted 'dateTime' string from the audit entry (preferred)
        or a numeric timestamp fallback. Either field is HTML-escaped before return.
        Empty inputs yield ('--', '').
        """
        raw_str = ""
        if raw:
            raw_str = str(raw).strip()
        elif timestamp_fallback is not None:
            raw_str = _fmt_ts(timestamp_fallback).strip()
        if not raw_str:
            return ("--", "")
        date_part, time_part = raw_str, ""
        idx = raw_str.find(" ")
        if idx > 0:
            date_part = raw_str[:idx].strip()
            time_part = raw_str[idx + 1:].strip()
        return (_html_escape(date_part), _html_escape(time_part))

    chips = []
    if filters.get("user"):
        chips.append("User = " + _html_escape(filters["user"]))
    if filters.get("role"):
        chips.append("Role = " + _html_escape(filters["role"]))
    if filters.get("action"):
        chips.append("Action = " + _html_escape(filters["action"]))
    if filters.get("from"):
        chips.append("From = " + _fmt_ts(filters["from"]))
    if filters.get("to"):
        chips.append("To = " + _fmt_ts(filters["to"]))
    chips_html = (
        '<div class="chips">' +
        "".join('<span class="chip">' + c + "</span>" for c in chips) +
        "</div>"
    ) if chips else '<div class="chips muted">No filters applied (all entries).</div>'

    if entries:
        rows = []
        for i, e in enumerate(entries, start=1):
            date_part, time_part = _split_date_time_cell(e.get("dateTime"), e.get("timestamp"))
            usr = _html_escape(e.get("user") or "--")
            rol = _html_escape(e.get("role") or "--")
            act = _html_escape(e.get("action") or "")
            det = _html_escape(e.get("details") or "")
            outcome = _html_escape(e.get("outcome") or "")
            rows.append(
                "<tr>"
                "<td class=\"col-sl\">{sl}</td>"
                "<td class=\"col-dt\">"
                  "<span class=\"dt-date\">{d}</span>"
                  "<span class=\"dt-time\">{t}</span>"
                "</td>"
                "<td>{usr}</td>"
                "<td>{rol}</td>"
                "<td>{act}</td>"
                "<td class=\"col-out\">{out}</td>"
                "<td class=\"col-det\">{det}</td>"
                "</tr>".format(sl=i, d=date_part, t=time_part, usr=usr, rol=rol, act=act, out=outcome, det=det)
            )
        rows_html = "".join(rows)
    else:
        rows_html = '<tr><td colspan="7" class="empty">No audit entries match the filters.</td></tr>'

    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Audit Trail Export</title>'
        '<style>'
        '@page { size: A4 portrait; margin: 10mm; }'
        'html, body { margin: 0; padding: 0; background:#ffffff; color:#111;'
        '   font-family: "Inter", "Segoe UI", Roboto, Arial, sans-serif; font-size: 9.5pt; }'
        'h1 { font-size: 14pt; margin: 0 0 4px 0; letter-spacing: 0.5px; }'
        'h2 { font-size: 11pt; margin: 0 0 8px 0; color:#444; font-weight: 600; }'
        '.brand { display:flex; justify-content:space-between; align-items:flex-end; '
        '         border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }'
        '.brand .meta { text-align: right; font-size: 9pt; color:#333; }'
        '.brand .meta div { line-height: 1.35; }'
        '.brand .meta strong { color:#111; }'
        '.chips { margin: 4px 0 8px 0; }'
        '.chip { display:inline-block; padding: 2px 8px; margin-right: 6px; margin-bottom: 4px;'
        '        background:#eef2ff; color:#1e3a8a; border-radius: 12px; font-size: 8.5pt; }'
        '.muted { color:#666; font-style: italic; font-size: 8.5pt; }'
        'table { width:100%; border-collapse: collapse; table-layout: fixed; }'
        'thead th { background:#111827; color:#fff; padding: 6px 6px; text-align: left;'
        '           font-weight:600; font-size: 9pt; border: 1px solid #111827; }'
        'tbody td { border: 1px solid #d1d5db; padding: 5px 6px; vertical-align: top;'
        '           word-wrap: break-word; overflow-wrap: break-word; }'
        'tbody tr:nth-child(even) td { background: #f9fafb; }'
        '.col-sl  { width: 4%; text-align: right; font-variant-numeric: tabular-nums; }'
        '.col-dt  { width: 11%; font-variant-numeric: tabular-nums; line-height: 1.25; }'
        '.col-dt .dt-date { display: block; white-space: nowrap; font-weight: 600; }'
        '.col-dt .dt-time { display: block; white-space: nowrap; font-size: 8.5pt; color: #444; }'
        '.col-out { width: 9%; }'
        '.col-det { width: 36%; }'
        '.empty { text-align: center; padding: 18px 0; color:#666; font-style: italic; }'
        '.footer { margin-top: 10px; font-size: 8pt; color:#555; '
        '          border-top: 1px solid #d1d5db; padding-top: 6px; }'
        '.footer .left  { float: left; }'
        '.footer .right { float: right; }'
        '.footer::after { content: ""; display: block; clear: both; }'
        '</style></head><body>'
        '<div class="brand">'
        '  <div>'
        '    <h1>AUDIT TRAIL EXPORT</h1>'
        '    <h2>' + (company or "Friability Tester") + '</h2>'
        '  </div>'
        '  <div class="meta">'
        '    <div><strong>Model:</strong> ' + (model or "--") + '</div>'
        '    <div><strong>Serial:</strong> ' + (serial or "--") + '</div>'
        '    <div><strong>Instrument:</strong> ' + (instrument_no or "--") + '</div>'
        '    <div><strong>Location:</strong> ' + (location or "--") + '</div>'
        '    <div><strong>Generated:</strong> ' + _html_escape(generated_at) + '</div>'
        '    <div><strong>Entries:</strong> ' + str(len(entries)) + '</div>'
        '  </div>'
        '</div>'
        + chips_html +
        '<table>'
        '  <thead><tr>'
        '    <th class="col-sl">#</th>'
        '    <th class="col-dt">Date &amp; Time</th>'
        '    <th>User</th>'
        '    <th>Role</th>'
        '    <th>Action</th>'
        '    <th class="col-out">Outcome</th>'
        '    <th class="col-det">Details</th>'
        '  </tr></thead>'
        '  <tbody>' + rows_html + '</tbody>'
        '</table>'
        '<div class="footer">'
        '  <span class="left">This document is auto-generated and write-protected (PDF).</span>'
        '  <span class="right">' + _html_escape(generated_at) + '</span>'
        '</div>'
        '</body></html>'
    )


def _parse_audit_export_filters(data):
    filters_in = (data or {}).get("filters") or {}
    filters = {}
    if filters_in.get("user"):
        filters["user"] = filters_in.get("user")
    if filters_in.get("role"):
        filters["role"] = filters_in.get("role")
    if filters_in.get("action"):
        filters["action"] = filters_in.get("action")
    for key in ("from", "to"):
        if filters_in.get(key) is not None:
            try:
                filters[key] = int(filters_in.get(key))
            except (TypeError, ValueError):
                pass
    return filters


@app.route("/api/audit/export/stage", methods=["POST"])
def audit_export_stage():
    """Stage filtered audit entries for verified USB export (24h purge tracking)."""
    try:
        audit_gate = _require_session_internal(
            "audit-view",
            "Forbidden. You do not have permission to export audit trails.",
        )
        if audit_gate:
            return audit_gate
        cur = data_service.get_current_user()
        data = request.get_json(force=True, silent=True) or {}
        filters = _parse_audit_export_filters(data)
        entries = audit_service.list_entries(filters)
        entry_ids = [e.get("id") for e in entries if e.get("id") is not None]
        exporter = str((cur or {}).get("username") or (cur or {}).get("name") or "").strip()
        batch = audit_service.stage_audit_export(entry_ids, exporter, "")
        return jsonify({
            "success": True,
            "batchId": batch.get("id"),
            "entryCount": len(entry_ids),
            "entryIds": entry_ids,
        }), 200
    except Exception as e:
        app.logger.exception("Error staging audit export")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/reports/export/stage", methods=["POST"])
def reports_export_stage():
    """Stage report IDs for verified USB export (24h purge tracking)."""
    try:
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        if not _session_has_internal("export-usb"):
            return jsonify({"success": False, "error": "Forbidden. Export to USB is not permitted for this account."}), 403
        data = request.get_json(force=True, silent=True) or {}
        raw_ids = data.get("report_ids", [])
        report_ids = []
        for rid in raw_ids:
            try:
                report_ids.append(int(rid))
            except (TypeError, ValueError):
                continue
        if not report_ids:
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        exporter = str((cur or {}).get("username") or (cur or {}).get("name") or "").strip()
        batch = data_service.stage_report_export(report_ids, exporter, "")
        return jsonify({
            "success": True,
            "batchId": batch.get("id"),
            "reportCount": len(report_ids),
            "reportIds": report_ids,
        }), 200
    except Exception as e:
        app.logger.exception("Error staging report export")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/audit/export", methods=["POST"])
def export_audit_trails():
    """Export filtered audit entries as a write-protected PDF on the external pendrive.

    Restricted to factory/admin roles. The PDF is the read-only "preview" format that
    replaces the previous JSON dump (which was editable).
    """
    mounted_now = None
    try:
        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        audit_gate = _require_session_internal(
            "audit-view",
            "Forbidden. You do not have permission to export audit trails.",
        )
        if audit_gate:
            return audit_gate
        cur = data_service.get_current_user()

        data = request.get_json(force=True, silent=True) or {}
        filters_in = data.get("filters") or {}
        device_path = (data.get("device_path") or "").strip() or None
        export_path = (data.get("export_path") or "").strip() or None

        user = filters_in.get("user")
        filter_role = filters_in.get("role")
        action = filters_in.get("action")
        from_ts = filters_in.get("from")
        to_ts = filters_in.get("to")
        filters = {}
        if user:
            filters["user"] = user
        if filter_role:
            filters["role"] = filter_role
        if action:
            filters["action"] = action
        if from_ts:
            try:
                filters["from"] = int(from_ts)
            except (TypeError, ValueError):
                pass
        if to_ts:
            try:
                filters["to"] = int(to_ts)
            except (TypeError, ValueError):
                pass

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400
        export_dir.mkdir(parents=True, exist_ok=True)

        entries = _prepare_audit_entries_for_display(audit_service.list_entries(filters))
        try:
            factory = data_service.get_factory_settings() or {}
        except Exception:
            factory = {}
        html = _build_audit_trail_html(entries, filters, factory)
        timestamp = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
        out_path = export_dir / "audit_trail_{}.pdf".format(timestamp)
        pdf_generator.render_html_to_pdf(html, out_path)
        try:
            os.chmod(out_path, 0o444)
        except OSError:
            pass

        unmount_detail = None
        if mounted_now and not export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        entry_ids = []
        for e in entries or []:
            if isinstance(e, dict) and e.get("id") is not None:
                entry_ids.append(e.get("id"))
        export_id, exported_by, approved_by = _stage_audit_usb_export(
            cur, verifier, entry_ids, pdf_path=str(out_path)
        )
        actors = _format_export_actors_detail(exported_by, approved_by) if export_id else ""
        audit_detail = "pdf {} | entries {}".format(out_path, len(entries))
        if actors:
            audit_detail = "{} | {}".format(audit_detail, actors)
        _audit(
            cur.get("username") or cur.get("name") if cur else None,
            cur.get("role") if cur else None,
            "Audit trail exported",
            audit_detail,
        )
        return jsonify({
            "success": True,
            "path": str(out_path),
            "export_directory": str(export_dir),
            "format": "pdf",
            "entries": len(entries),
            "unmount_detail": unmount_detail,
            "export_id": export_id,
            "entries_staged": len(entry_ids) if export_id else 0,
            "retentionNote": "After you verify the USB copy, exported audit rows are purged from this device after 24 hours.",
        }), 200
    except Exception as e:
        if mounted_now:
            try:
                usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
            except Exception:
                pass
        app.logger.exception("Error exporting audit trails")
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500


@app.route("/api/audit/export/confirm", methods=["POST"])
def confirm_audit_export():
    """Operator confirmed USB audit export; starts 24h retention timer."""
    try:
        _maybe_purge_scheduled_audit_export()
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        if not _session_has_internal("export-usb"):
            return jsonify({"success": False, "error": "Forbidden."}), 403
        data = request.get_json(force=True, silent=True) or {}
        export_id = (data.get("export_id") or "").strip()
        verified = bool(data.get("verified"))
        if not verified:
            return jsonify({"success": True, "verified": False, "scheduled": False}), 200
        if not export_id:
            return jsonify({"success": False, "error": "Missing export_id"}), 400
        scheduled = audit_service.confirm_audit_export_verified(export_id)
        if not scheduled:
            return jsonify({"success": False, "error": "Export session expired or invalid. Export again."}), 400
        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit export verified",
            "USB export verified; {} entries scheduled for removal after 24 hours".format(
                len(scheduled.get("entry_ids") or [])
            ),
        )
        return jsonify({
            "success": True,
            "verified": True,
            "scheduled": True,
            "purge_at_ms": int(scheduled.get("purge_at_ms") or 0),
            "entries_scheduled": len(scheduled.get("entry_ids") or []),
        }), 200
    except Exception as e:
        app.logger.exception("Error confirming audit export")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/reports/export/confirm", methods=["POST"])
def confirm_report_export():
    """Operator confirmed USB report export; starts 24h retention timer."""
    try:
        _maybe_purge_scheduled_report_export()
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        if not _session_has_internal("export-usb"):
            return jsonify({"success": False, "error": "Forbidden."}), 403
        data = request.get_json(force=True, silent=True) or {}
        export_id = (data.get("export_id") or "").strip()
        verified = bool(data.get("verified"))
        if not verified:
            return jsonify({"success": True, "verified": False, "scheduled": False}), 200
        if not export_id:
            return jsonify({"success": False, "error": "Missing export_id"}), 400
        scheduled = data_service.confirm_report_export_verified(export_id)
        if not scheduled:
            return jsonify({"success": False, "error": "Export session expired or invalid. Export again."}), 400
        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Report export verified",
            "USB export verified; {} report(s) scheduled for removal after 24 hours".format(
                len(scheduled.get("report_ids") or [])
            ),
        )
        return jsonify({
            "success": True,
            "verified": True,
            "scheduled": True,
            "purge_at_ms": int(scheduled.get("purge_at_ms") or 0),
            "reports_scheduled": len(scheduled.get("report_ids") or []),
        }), 200
    except Exception as e:
        app.logger.exception("Error confirming report export")
        return jsonify({"success": False, "error": str(e)}), 500


# =================== CALCULATE ==========================


@app.route("/api/calculate/recipe-validate", methods=["POST"])
def validate_recipe_endpoint():
    try:
        gate = _require_any_session_internal(
            ["recipe-manage", "recipe-test", "quick-test"],
            "Forbidden. You do not have permission to manage recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        result = calculation_service.validate_recipe(recipe_data)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error validating recipe")
        return jsonify({"error": str(e)}), 500

    
# =================== REPORTS PREVIEW / EXPORT ==========================


@app.route("/api/reports/<int:report_id>/preview", methods=["GET"])
def get_report_preview(report_id):
    try:
        gate = _require_any_session_internal(
            [
                "reports-view",
                "recipe-test",
                "validation-test",
                "test-report-approve",
                "validation-report-approve",
            ],
            "Forbidden. You do not have permission to view reports.",
        )
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        # Only log intentional user opens (UI openReportPreview passes log_open=1).
        # Approval polls, silent PDF, and export preview fetches must not spam "Report opened".
        if str(request.args.get("log_open") or "").strip() == "1":
            rtype = (report.get("type") or "").strip().lower() or "report"
            detail = _format_report_audit_details(report_id, report)
            _audit(
                None,
                None,
                "Report opened",
                detail if detail else "Report id {} | type {}".format(report_id, rtype),
            )
        preview_data = report_service.get_report_preview_data(report)
        return jsonify({"preview": preview_data}), 200
    except Exception as e:
        app.logger.exception("Error getting report preview")
        return jsonify({"error": str(e)}), 500


@app.route("/api/usb/list", methods=["GET"])
def list_usb_pendrives():
    """List external pendrives suitable for export (excludes OS root + internal USB)."""
    try:
        gate = _require_session_internal("export-usb", "Forbidden. Export to USB is not permitted for this account.")
        if gate:
            return gate
        devices = usb_export.list_external_pendrives()
        return jsonify({"success": True, "devices": devices}), 200
    except Exception as e:
        app.logger.exception("Error listing USB devices")
        return jsonify({"success": False, "error": str(e), "devices": []}), 500


def _report_pdf_path(report_id):
    return REPORTS_DIR / "report_{}.pdf".format(int(report_id))


def _report_pdf_status_allowed(report: dict) -> bool:
    """PDF files are written only for approved or aborted test/validation reports."""
    if not report or not _report_requires_approval(report):
        return True
    st = str(report.get("reportApprovalStatus") or "").strip().lower()
    return st in ("approved", "aborted")


def _remove_report_pdf_file(report_id: int) -> None:
    try:
        path = _report_pdf_path(report_id)
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _generate_report_pdf_file(
    report_id: int,
    write_audit: bool = True,
    *,
    timestamp_kind: Optional[str] = None,
) -> bool:
    """Render report PDF from A4 plain-text layout (same as dot-matrix print). Overwrites any existing file.

    timestamp_kind=None → no Printed/Exported footer (preview/storage).
    timestamp_kind='printed'|'exported' → footer stamped at generation time.
    """
    report = data_service.get_report(report_id)
    if not report:
        return False
    if not _report_pdf_status_allowed(report):
        _remove_report_pdf_file(report_id)
        return False
    try:
        # CFR 21: always use server A4 text formatter (====, ----, ****), never UI preview HTML.
        include_ts = bool(timestamp_kind)
        html = report_service.build_report_pdf_html(
            report,
            include_printed_timestamp=include_ts,
            timestamp_kind=(timestamp_kind or "printed"),
        )
        out_path = _report_pdf_path(report_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_generator.render_html_to_pdf(html, out_path)
        ok = out_path.exists() and out_path.stat().st_size > 0
        if ok and write_audit:
            _audit_report_pdf_generated(report_id, report)
        return ok
    except Exception:
        app.logger.exception("Report PDF generation failed for id %s", report_id)
        return False


def _friendly_export_error(exc_or_msg):
    """Translate export failures into short operator-facing messages.

    Raw udisks/polkit/lsblk details are logged by the caller; this keeps the UI
    actionable without dumping dbus noise.
    """
    text = (str(exc_or_msg) if exc_or_msg is not None else "").lower()
    if "no external pendrive" in text or "not detected" in text or "no exportable" in text:
        return (
            "No exportable USB found. Connect a FAT32/exFAT pendrive and try again. "
            "Whole-disk formatted sticks (no partition table) are supported."
        )
    if "multiple pendrives" in text:
        return "Multiple pendrives detected. Please disconnect extras and try again."
    if "udisks2" in text and ("inactive" in text or "not running" in text or "dead" in text):
        return "USB disk service is not running. Restart the instrument and try again."
    if "could not mount" in text or "mount failed" in text or "not authorized" in text:
        return "Could not mount the pendrive. Reconnect it and try again."
    if "no space left" in text or "disk full" in text:
        return "Pendrive is full. Free space or use a different pendrive."
    if "selected pendrive" in text and "no longer" in text:
        return "Selected pendrive disconnected. Reconnect it and try again."
    return "Failed to export. Please format the pendrive (FAT32 or exFAT) and try again."


def _udisks2_active() -> bool:
    try:
        proc = subprocess.run(
            ["systemctl", "is-active", "--quiet", "udisks2.service"],
            capture_output=True,
            timeout=5,
            check=False,
        )
        return proc.returncode == 0
    except Exception:
        return False


@app.route("/api/reports/<int:report_id>/pdf", methods=["POST"])
def save_report_pdf(report_id):
    """Render report PDF from A4 plain-text layout (same as dot-matrix print).

    Body is optional (legacy ``html`` field is ignored).
    """
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"success": False, "error": "Report not found"}), 404
        if not _report_pdf_status_allowed(report):
            return jsonify({
                "success": False,
                "error": "PDF is available only after the report is approved or marked aborted.",
            }), 403
        if not _generate_report_pdf_file(report_id, write_audit=True):
            return jsonify({"success": False, "error": "PDF generation failed"}), 500
        out_path = _report_pdf_path(report_id)
        return jsonify({"success": True, "path": str(out_path), "size_bytes": out_path.stat().st_size}), 200
    except Exception as e:
        app.logger.exception("Error rendering report PDF")
        return jsonify({"success": False, "error": str(e)}), 500


def _resolve_export_destination(device_path, requested_export_path):
    """Pick the destination directory on the external pendrive.

    Returns (pathlib.Path | None, error_str, devices_list, mounted_now_device_path | None).
    The caller may unmount mounted_now_device_path after writing.
    """
    if requested_export_path:
        # Caller forced a path (typically used by dev). No mount magic.
        return pathlib.Path(requested_export_path), None, [], None
    devices = usb_export.list_external_pendrives()
    if not devices:
        summary = ""
        try:
            summary = usb_export.summarize_block_devices_for_log()
        except Exception:
            summary = ""
        udisks_ok = _udisks2_active()
        app.logger.warning(
            "USB export: no external pendrive listed (udisks2_active=%s). block devices: %s",
            udisks_ok,
            summary or "(unavailable)",
        )
        if not udisks_ok:
            return (
                None,
                "USB disk service (udisks2) is not running. Restart the instrument and try again.",
                [],
                None,
            )
        return (
            None,
            "No exportable USB found. Connect a FAT32/exFAT pendrive and try again.",
            [],
            None,
        )
    if device_path:
        match = next((d for d in devices if d.get("path") == device_path), None)
        if not match:
            return None, "Selected pendrive '{}' is no longer connected.".format(device_path), devices, None
        chosen = match
    elif len(devices) == 1:
        chosen = devices[0]
    else:
        return None, "MULTIPLE_PENDRIVES", devices, None
    mounted_now = None
    if not chosen.get("mounted") or not chosen.get("mountpoint"):
        if not _udisks2_active():
            app.logger.warning("USB export: udisks2 inactive before mount of %s", chosen.get("path"))
            return (
                None,
                "USB disk service (udisks2) is not running. Restart the instrument and try again.",
                devices,
                None,
            )
        mount_res = usb_export.ensure_pendrive_mounted(chosen["path"])
        if not mount_res.get("ok"):
            raw = mount_res.get("error") or mount_res.get("raw") or "unknown"
            app.logger.warning(
                "USB export: mount failed for %s: %s",
                chosen.get("path"),
                raw,
            )
            return (
                None,
                "Could not mount {}: {}".format(chosen["path"], raw),
                devices,
                None,
            )
        chosen["mountpoint"] = mount_res.get("mountpoint")
        if not mount_res.get("already_mounted"):
            mounted_now = chosen["path"]
    mountpoint = chosen.get("mountpoint")
    if not mountpoint:
        return None, "Pendrive {} reported no mountpoint.".format(chosen.get("path")), devices, mounted_now
    subfolder_rel = usb_export.export_subfolder_name(EXPORT_SUBFOLDER)
    export_dir = pathlib.Path(mountpoint) / subfolder_rel
    return export_dir, None, devices, mounted_now


@app.route("/api/reports/export", methods=["POST"])
def export_reports():
    """Export selected reports (PDFs) to the connected external pendrive.

    Body:
      report_ids:        [int, ...]                       (required)
      device_path:       "/dev/sdb1"                      (optional; required if multiple pendrives)
      export_path:       "/abs/path"                      (optional; override mount detection for dev)

    PDFs are generated server-side from the A4 plain-text layout (same as dot-matrix print).

    Returns 409 with `devices` list when multiple pendrives are connected and none chosen.
    """
    mounted_now = None
    try:
        data = request.get_json(force=True, silent=True) or {}
        raw_ids = data.get("report_ids", [])
        report_ids = []
        for rid in raw_ids:
            try:
                report_ids.append(int(rid))
            except (TypeError, ValueError):
                continue
        if not report_ids:
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        cur = data_service.get_current_user()
        device_path = (data.get("device_path") or "").strip() or None
        requested_export_path = (data.get("export_path") or "").strip() or None

        # Regenerate PDFs from A4 plain-text layout (same as dot-matrix print).
        generated = []
        missing = []
        for rid in report_ids:
            report = data_service.get_report(rid) or {}
            if _report_requires_approval(report):
                st = str(report.get("reportApprovalStatus") or "").strip().lower()
                if st == "pending":
                    missing.append(rid)
                    continue
            if _generate_report_pdf_file(rid, timestamp_kind="exported"):
                generated.append(rid)
            else:
                missing.append(rid)
        if missing:
            return jsonify({
                "success": False,
                "error": (
                    "PDF unavailable for report(s): {}. Approve the report first, "
                    "or ensure aborted reports were saved correctly."
                ).format(", ".join(str(i) for i in missing)),
                "missing_pdfs": missing,
            }), 400

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400

        for rid in report_ids:
            blocked = _check_report_approved_for_print_export(report_id=rid)
            if blocked is not None:
                return blocked

        export_dir.mkdir(parents=True, exist_ok=True)

        exported_files = []
        exported_report_ids = []
        failed = []
        for rid in report_ids:
            src = _report_pdf_path(rid)
            if not src.exists():
                failed.append({"id": rid, "error": "PDF missing"})
                continue
            report = data_service.get_report(rid) or {}
            recipe = report.get("recipe") if isinstance(report.get("recipe"), dict) else {}
            product = (recipe.get("productName") or report.get("name") or "report")
            safe_name = "".join(c for c in str(product) if c.isalnum() or c in "-_") or "report"
            ts_raw = str(report.get("createdAt") or "")
            safe_ts = "".join(c for c in ts_raw if c.isalnum() or c in "-_.T") or "ts"
            dest = export_dir / "{}_{}_{}.pdf".format(safe_name, rid, safe_ts)
            try:
                with open(src, "rb") as fin, open(dest, "wb") as fout:
                    while True:
                        chunk = fin.read(1024 * 1024)
                        if not chunk:
                            break
                        fout.write(chunk)
                exported_files.append(str(dest))
                exported_report_ids.append(int(rid))
            except Exception as e:
                failed.append({"id": rid, "error": str(e)})

        # Best-effort sync + unmount (only if we mounted it here).
        # Default is power_off=False so repeat exports don't require re-plugging.
        unmount_detail = None
        if mounted_now and not requested_export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        ok_count = len(exported_files)
        export_id = None
        if exported_report_ids:
            export_id, exported_by, approved_by = _stage_report_usb_export(cur, verifier, exported_report_ids)
            actors = _format_export_actors_detail(exported_by, approved_by)
            ids_label = ", ".join(str(i) for i in exported_report_ids)
            audit_detail = "Exported {} report{} to USB (ids: {}) | {}".format(
                ok_count, "" if ok_count == 1 else "s", ids_label, actors
            )
        else:
            audit_detail = "Exported {} report{} to USB".format(
                ok_count, "" if ok_count == 1 else "s"
            )
        _audit(
            cur.get("username") or cur.get("name") if cur else None,
            cur.get("role") if cur else None,
            "Reports exported",
            audit_detail,
        )
        return jsonify({
            "success": (len(failed) == 0),
            "count": len(exported_files),
            "exported_files": exported_files,
            "failed": failed,
            "export_directory": str(export_dir),
            "generated_pdfs_now": generated,
            "unmount_detail": unmount_detail,
            "device_path": device_path or (devices[0]["path"] if len(devices) == 1 else None),
            "export_id": export_id,
            "reports_staged": len(exported_report_ids),
        }), 200
    except Exception as e:
        if mounted_now:
            try:
                usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
            except Exception:
                pass
        app.logger.exception("Error exporting reports")
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500


@app.route("/api/reports/export/stream", methods=["POST"])
def export_reports_stream():
    """NDJSON progress stream for bulk report export.

    Emits one JSON object per line. Events:
      {event:"start", total:N}
      {event:"stage", stage:"detect-usb"|"mount"|"copying"|"unmount", percent:int}
      {event:"report", current:i, total:N, percent:int, id:<rid>, status:"generating"|"copied"|"failed"}
      {event:"done", ok:bool, count:int, failed:[...], export_directory:str, percent:100}
      {event:"error", message:str}

    Why streaming: lets the UI show a real progress bar with percentage as each
    report PDF is rendered + copied, instead of a static spinner.
    """
    data = request.get_json(force=True, silent=True) or {}
    raw_ids = data.get("report_ids", [])
    report_ids = []
    for rid in raw_ids:
        try:
            report_ids.append(int(rid))
        except (TypeError, ValueError):
            continue
    if not report_ids:
        return jsonify({"success": False, "error": "No report IDs provided"}), 400
    device_path = (data.get("device_path") or "").strip() or None
    requested_export_path = (data.get("export_path") or "").strip() or None
    power_off = bool(data.get("power_off") or False)

    gate, verifier = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate
    cur = data_service.get_current_user()
    for rid in report_ids:
        blocked = _check_report_approved_for_print_export(report_id=rid)
        if blocked is not None:
            return blocked

    def _emit(obj):
        return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")

    def gen():
        total = len(report_ids)
        # Budget allocation (sums to 100):
        #   3% detect-usb, 7% mount, 80% per-report PDF + copy, 8% sync+unmount, 2% done
        gen_copy_budget = 80.0
        per_report_pct = (gen_copy_budget / total) if total else 0.0
        accumulated = 10.0  # after detect + mount stages
        mounted_now = None
        result = {
            "ok": False,
            "count": 0,
            "exported_files": [],
            "exported_report_ids": [],
            "failed": [],
            "export_directory": None,
            "device_path": None,
        }
        try:
            yield _emit({"event": "start", "total": total, "percent": 0})

            yield _emit({"event": "stage", "stage": "detect-usb", "percent": 3,
                         "message": "Detecting external pendrive..."})

            export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
            if err == "MULTIPLE_PENDRIVES":
                yield _emit({"event": "error", "code": "MULTIPLE_PENDRIVES",
                             "message": "Multiple pendrives detected. Choose one.",
                             "devices": devices})
                return
            if err:
                yield _emit({"event": "error", "message": _friendly_export_error(err), "devices": devices})
                return
            result["export_directory"] = str(export_dir)
            result["device_path"] = device_path or (devices[0]["path"] if devices and len(devices) == 1 else None)

            yield _emit({"event": "stage", "stage": "mount", "percent": 10,
                         "message": "Mounted pendrive. Preparing files..."})

            try:
                export_dir.mkdir(parents=True, exist_ok=True)
            except OSError as oe:
                yield _emit({"event": "error", "message": _friendly_export_error(oe)})
                return

            for i, rid in enumerate(report_ids, start=1):
                this_progress_at = accumulated + per_report_pct * (i - 1)
                next_progress_at = accumulated + per_report_pct * i
                report = data_service.get_report(rid) or {}
                if _report_requires_approval(report):
                    st = str(report.get("reportApprovalStatus") or "").strip().lower()
                    if st == "pending":
                        result["failed"].append({"id": rid, "reason": "pending"})
                        yield _emit({"event": "report", "current": i, "total": total,
                                     "percent": int(next_progress_at), "id": rid,
                                     "status": "failed"})
                        continue
                # 1) Regenerate PDF from A4 plain-text layout (same as dot-matrix print).
                pdf_src = _report_pdf_path(rid)
                yield _emit({"event": "report", "current": i, "total": total,
                             "percent": int(this_progress_at + per_report_pct * 0.3), "id": rid,
                             "status": "generating",
                             "message": "Generating PDF for report {} of {}...".format(i, total)})
                if not _generate_report_pdf_file(rid, timestamp_kind="exported"):
                    result["failed"].append({"id": rid, "reason": "render"})
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "failed"})
                    continue

                # 2) Copy to pendrive destination.
                recipe = report.get("recipe") if isinstance(report.get("recipe"), dict) else {}
                product = recipe.get("productName") or report.get("name") or "report"
                safe_name = "".join(c for c in str(product) if c.isalnum() or c in "-_") or "report"
                ts_raw = str(report.get("createdAt") or "")
                safe_ts = "".join(c for c in ts_raw if c.isalnum() or c in "-_.T") or "ts"
                dest = export_dir / "{}_{}_{}.pdf".format(safe_name, rid, safe_ts)
                yield _emit({"event": "report", "current": i, "total": total,
                             "percent": int(this_progress_at + per_report_pct * 0.7), "id": rid,
                             "status": "copying",
                             "message": "Writing report {} of {} to pendrive...".format(i, total)})
                try:
                    pdf_generator._copy_to_destination(pdf_src, dest)  # robust chunked copy
                    result["exported_files"].append(str(dest))
                    result["exported_report_ids"].append(int(rid))
                    result["count"] += 1
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "copied", "file": str(dest)})
                except Exception as e:
                    app.logger.warning("[EXPORT-STREAM] Copy failed for %s: %s", rid, e)
                    result["failed"].append({"id": rid, "reason": "copy"})
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "failed"})

            yield _emit({"event": "stage", "stage": "unmount", "percent": 95,
                         "message": "Syncing and unmounting pendrive..."})
            unmount_detail = None
            if mounted_now and not requested_export_path:
                unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)
                mounted_now = None

            ok_count = result["count"]
            export_id = None
            if result["exported_report_ids"]:
                export_id, exported_by, approved_by = _stage_report_usb_export(
                    cur, verifier, result["exported_report_ids"]
                )
                actors = _format_export_actors_detail(exported_by, approved_by)
                ids_label = ", ".join(str(i) for i in result["exported_report_ids"])
                audit_detail = "Exported {} report{} to USB (ids: {}) | {}".format(
                    ok_count, "" if ok_count == 1 else "s", ids_label, actors
                )
            else:
                audit_detail = "Exported {} report{} to USB".format(
                    ok_count, "" if ok_count == 1 else "s"
                )
            _audit(
                cur.get("username") or cur.get("name") if cur else None,
                cur.get("role") if cur else None,
                "Reports exported",
                audit_detail,
            )

            result["ok"] = (len(result["failed"]) == 0 and result["count"] > 0)
            yield _emit({
                "event": "done",
                "percent": 100,
                "ok": result["ok"],
                "count": result["count"],
                "failed": result["failed"],
                "exported_files": result["exported_files"],
                "export_directory": result["export_directory"],
                "device_path": result["device_path"],
                "unmount_detail": unmount_detail,
                "export_id": export_id,
                "reports_staged": len(result["exported_report_ids"]),
            })
        except Exception as e:
            app.logger.exception("[EXPORT-STREAM] Unexpected failure")
            try:
                yield _emit({"event": "error", "message": _friendly_export_error(e)})
            except Exception:
                pass
        finally:
            # Best-effort unmount on early exit.
            if mounted_now and not requested_export_path:
                try:
                    usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
                except Exception:
                    pass

    return Response(stream_with_context(gen()), mimetype="application/x-ndjson")



def _load_report_data_for_print(report_id, report_data_fallback=None):
    """Load full saved report (including testData) for printing."""
    if report_id is not None:
        stored = data_service.get_report(int(report_id))
        if stored:
            return report_service.enrich_report_context(dict(stored))
    if report_data_fallback:
        rd = dict(report_data_fallback)
        if not rd.get("factorySettings"):
            try:
                rd["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        return report_service.enrich_report_context(rd)
    return None

# =================== PRINT ==========================


@app.route("/api/print/a4", methods=["POST"])
def print_a4():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            gate = _require_any_session_internal(
                ["recipe-list", "recipe-edit", "reports-view"],
                "Forbidden. You do not have permission to print recipes.",
            )
            if gate:
                return gate
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to print reports.")
            if gate:
                return gate
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            result = print_service.print_recipe_a4(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(None, None, "Print A4", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            blocked = _check_report_approved_for_print_export(report_id=report_id)
            if blocked is not None:
                return blocked
            loaded = _load_report_data_for_print(report_id, report_data)
            if loaded:
                report_data = loaded
                try:
                    print_service.save_report_text_files(report_data, int(report_id), REPORTS_DIR)
                except Exception:
                    pass
                result = print_service.print_a4_report(report_data)
                if result.get("success"):
                    _audit(None, None, "Print A4", "Report id {}".format(report_id))
                return jsonify(result), 200 if result.get("success") else 500
        blocked = _check_report_approved_for_print_export(report_data=report_data)
        if blocked is not None:
            return blocked
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        report_data = report_service.enrich_report_context(dict(report_data))
        result = print_service.print_a4_report(report_data)
        rid = report_data.get("id")
        _audit(
            None,
            None,
            "Print A4",
            "Report id {}".format(rid if rid is not None else "—"),
        )
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing A4")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/thermal", methods=["POST"])
def print_thermal():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            gate = _require_any_session_internal(
                ["recipe-list", "recipe-edit", "reports-view"],
                "Forbidden. You do not have permission to print recipes.",
            )
            if gate:
                return gate
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to print reports.")
            if gate:
                return gate
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            result = print_service.print_recipe_thermal(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(None, None, "Print thermal", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            blocked = _check_report_approved_for_print_export(report_id=report_id)
            if blocked is not None:
                return blocked
            loaded = _load_report_data_for_print(report_id, report_data)
            if loaded:
                report_data = loaded
                try:
                    print_service.save_report_text_files(report_data, int(report_id), REPORTS_DIR)
                except Exception:
                    pass
                result = print_service.print_thermal_report(report_data)
                if result.get("success"):
                    _audit(None, None, "Print thermal", "Report id {}".format(report_id))
                return jsonify(result), 200 if result.get("success") else 500
        blocked = _check_report_approved_for_print_export(report_data=report_data)
        if blocked is not None:
            return blocked
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        report_data = report_service.enrich_report_context(dict(report_data))
        result = print_service.print_thermal_report(report_data)
        rid = report_data.get("id")
        _audit(
            None,
            None,
            "Print thermal",
            "Report id {}".format(rid if rid is not None else "—"),
        )
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing thermal")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/status", methods=["GET"])
def print_status():
    try:
        printer_type = request.args.get("type", "a4")
        status = print_service.check_printer_status(printer_type)
        return jsonify(status), 200
    except Exception as e:
        app.logger.exception("Error checking printer status")
        return jsonify({"error": str(e)}), 500


# =================== HARDWARE (DT) ==========================


@app.route("/api/hardware/stream", methods=["GET"])
def hardware_stream():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    return hardware_service.start_sse_stream()


@app.route("/api/hardware/log", methods=["GET"])
def hardware_log_read():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    try:
        max_lines = int(request.args.get("lines", 500))
    except (TypeError, ValueError):
        max_lines = 500
    return jsonify(hardware_service.get_uart_log_tail(max_lines=max_lines))


@app.route("/api/hardware/log/reset", methods=["POST"])
def hardware_log_reset():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.reset_uart_log(reason="ui_refresh")
    code = 200 if result.get("ok") else 500
    return jsonify(result), code


@app.route("/api/hardware/command", methods=["POST"])
def hardware_command():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    cmd = data.get("command", "")
    if not cmd:
        return jsonify({"error": "No command provided"}), 400
    result = hardware_service.send_command(cmd)
    return jsonify(result)


@app.route("/api/hardware/status", methods=["GET"])
def hardware_status():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    return jsonify(hardware_service.cmd_status())


@app.route("/api/hardware/dt/temps", methods=["GET"])
@app.route("/api/hardware/dt/live", methods=["GET"])
def dt_live():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    return jsonify({
        "ok": True,
        "temps": hardware_service.get_latest_temps(),
        "live": hardware_service.get_live_state(),
        "heater": hardware_service.get_heater_state(),
        "mock": hardware_service.is_mock_mode(),
    })


@app.route("/api/hardware/dt/preheat", methods=["POST"])
def dt_preheat():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test"],
        "Forbidden. You do not have permission to run hardware tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    # Prefer single shared-bath temp; collapse legacy t1/t2
    if data.get("temp") is not None or data.get("setTemperature") is not None:
        temp = float(data.get("temp") or data.get("setTemperature") or 0)
    else:
        t1 = float(data.get("t1") or data.get("temp1") or 0)
        t2 = float(data.get("t2") or data.get("temp2") or 0)
        if data.get("basket") in (1, "1"):
            t1 = float(data.get("temp") or data.get("setTemperature") or t1)
            temp = t1
        elif data.get("basket") in (2, "2"):
            t2 = float(data.get("temp") or data.get("setTemperature") or t2)
            temp = t2
        else:
            temp = max(t1, t2)
    source = str(data.get("source") or "settings").strip() or "settings"
    before = hardware_service.get_heater_state() or {}
    if temp <= 0:
        result = hardware_service.release_bath("manual", force_off=True)
        # Also clear any lingering basket owners when operator forces heater off from settings
        for owner in list(hardware_service.get_bath_owners()):
            hardware_service.release_bath(owner, force_off=True)
        ok = bool(result.get("ok"))
        _audit_heater_preheat_changes(
            before_heater=before,
            temp=0.0,
            source=source,
            ok=ok,
            error=(result.get("error") if not ok else None),
        )
        return jsonify(result), (200 if ok else 400)

    result = hardware_service.request_bath("manual", temp)
    ok = bool(result.get("ok"))
    _audit_heater_preheat_changes(
        before_heater=before,
        temp=temp,
        source=source,
        ok=ok,
        error=(result.get("error") if not ok else None),
    )
    return jsonify(result), (_bath_conflict_status(result) if not ok else 200)


@app.route("/api/hardware/dt/start", methods=["POST"])
def dt_start():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test"],
        "Forbidden. You do not have permission to run hardware tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    basket = data.get("basket")
    # Dt_Dr_Reddy stroke-only start: START,STROKE,Bx,A
    if str(data.get("mode") or "").strip().lower() in ("stroke", "start-stroke"):
        result = hardware_service.cmd_start_stroke(int(basket) if basket in (1, 2, "1", "2") else 1)
        return jsonify(result), (200 if result.get("ok") else 400)
    temp = float(data.get("temp") or data.get("setTemperature") or 37.0)
    if basket in (3, "3", "both"):
        t1 = float(data.get("t1") or temp)
        t2 = float(data.get("t2") or temp)
        result = hardware_service.cmd_start_b3(t1, t2)
    elif basket in (2, "2"):
        result = hardware_service.cmd_start_b2(temp)
    else:
        result = hardware_service.cmd_start_b1(temp)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/dt/start-stroke", methods=["POST"])
def dt_start_stroke():
    """Compatibility with Dt_Dr_Reddy /api/start-stroke → START,STROKE,Bx,A."""
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test"],
        "Forbidden. You do not have permission to run hardware tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    basket = data.get("basket") or data.get("id") or 1
    result = hardware_service.cmd_start_stroke(int(basket) if str(basket) in ("1", "2") else 1)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/dt/temp", methods=["GET", "POST"])
def dt_temp_bulk():
    """Compatibility with Dt_Dr_Reddy GET /api/temp → send TEMP bulk query."""
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_query_temps_bulk()
    return jsonify({
        "ok": bool(result.get("ok")),
        "command": result,
        "temps": hardware_service.get_latest_temps(),
        "live": hardware_service.get_live_state(),
        "mock": hardware_service.is_mock_mode(),
    }), (200 if result.get("ok") else 400)


@app.route("/api/hardware/dt/stop", methods=["POST"])
def dt_stop():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to run hardware tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    basket = data.get("basket")
    b = int(basket) if basket in (1, 2, "1", "2") else None
    result = hardware_service.cmd_stop(b)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/dt/calibrate", methods=["POST"])
def dt_calibrate_raw():
    """Low-level CAL (prefer /api/data/calibration which requires e-sign)."""
    gate = _require_session_internal("calibration-menu", "Forbidden. You do not have permission to calibrate.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    sensor = data.get("sensor")
    temp = data.get("temp") or data.get("temperature") or data.get("setTemperature")
    result = hardware_service.cmd_calibrate(sensor, temp)
    return jsonify(result), (200 if result.get("ok") else 400)


# =================== DT TEST RUN ==========================


def _session_operator():
    cur = data_service.get_current_user() or {}
    username = str(cur.get("username") or "").strip()
    # On this kiosk the login ID is the Employee ID; prefer that over numeric member id.
    emp = (
        str(cur.get("employeeId") or "").strip()
        or username
        or str(cur.get("id") or "").strip()
    )
    return {
        "name": cur.get("name") or username or "",
        "employeeId": emp,
        "id": emp,
        "username": username,
    }


@app.route("/api/data/dt/instrument-settings", methods=["GET"])
def dt_instrument_settings_get():
    """Persistent beaker enablement + basket tube count (survives reboot)."""
    try:
        settings = data_service.get_dt_instrument_settings()
        return jsonify({"ok": True, "settings": settings}), 200
    except Exception as e:
        app.logger.exception("get dt instrument settings failed")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/dt/instrument-settings", methods=["POST"])
def dt_instrument_settings_save():
    """Save beaker / basket instrument settings to durable storage."""
    try:
        gate = _require_any_session_internal(
            ["settings", "quick-test", "recipe-test", "factory-settings"],
            "Forbidden. You do not have permission to change instrument settings.",
        )
        if gate:
            return gate
        data = request.get_json(force=True, silent=True) or {}
        # Accept either nested {settings:{...}} or flat body.
        payload = data.get("settings") if isinstance(data.get("settings"), dict) else data
        before = data_service.get_dt_instrument_settings() or {}
        saved = data_service.save_dt_instrument_settings(payload or {})
        _audit_dt_instrument_settings_changes(before, saved)
        return jsonify({"ok": True, "settings": saved}), 200
    except Exception as e:
        app.logger.exception("save dt instrument settings failed")
        return jsonify({"ok": False, "error": str(e)}), 500


def _audit_dt_instrument_settings_changes(before, after):
    """Audit beaker / basket / set-temp instrument setting changes."""
    before = before if isinstance(before, dict) else {}
    after = after if isinstance(after, dict) else {}

    conf_b = before.get("configuredBeakers") or {}
    conf_a = after.get("configuredBeakers") or {}
    b1_before = bool(conf_b.get("1") if conf_b.get("1") is not None else conf_b.get(1, True))
    b2_before = bool(conf_b.get("2") if conf_b.get("2") is not None else conf_b.get(2, True))
    b1_after = bool(conf_a.get("1") if conf_a.get("1") is not None else conf_a.get(1, True))
    b2_after = bool(conf_a.get("2") if conf_a.get("2") is not None else conf_a.get(2, True))
    if (b1_before, b2_before) != (b1_after, b2_after):
        details = "Beaker 1: {} | Beaker 2: {}".format(
            "on" if b1_after else "off",
            "on" if b2_after else "off",
        )
        try:
            _audit_event(
                action="Beaker configuration changed",
                outcome="success",
                entity_type="instrument_settings",
                entity_name="configuredBeakers",
                details=details,
                event_type="lifecycle",
                before={"1": b1_before, "2": b2_before},
                after={"1": b1_after, "2": b2_after},
            )
        except Exception:
            app.logger.exception("beaker configuration audit failed")

    try:
        cfg_before = int(before.get("basketConfig") or 6)
    except (TypeError, ValueError):
        cfg_before = 6
    try:
        cfg_after = int(after.get("basketConfig") or 6)
    except (TypeError, ValueError):
        cfg_after = 6
    if cfg_before != cfg_after:
        try:
            _audit_event(
                action="Basket configuration changed",
                outcome="success",
                entity_type="instrument_settings",
                entity_name="basketConfig",
                details="Tube count: {}".format(cfg_after),
                event_type="lifecycle",
                before={"basketConfig": cfg_before},
                after={"basketConfig": cfg_after},
            )
        except Exception:
            app.logger.exception("basket configuration audit failed")

    try:
        old_bath = float(before.get("bathSetTemp") if before.get("bathSetTemp") is not None else (before.get("setTemp") or {}).get("1", 37.0))
    except (TypeError, ValueError):
        old_bath = 37.0
    try:
        new_bath = float(after.get("bathSetTemp") if after.get("bathSetTemp") is not None else (after.get("setTemp") or {}).get("1", 37.0))
    except (TypeError, ValueError):
        new_bath = 37.0
    if abs(old_bath - new_bath) > 0.05:
        try:
            _audit_event(
                action="Set temperature changed",
                outcome="success",
                entity_type="instrument_settings",
                entity_id="bath",
                entity_name="Bath",
                details="Bath | {:.1f}°C".format(new_bath),
                event_type="lifecycle",
                before={"bathSetTemp": old_bath},
                after={"bathSetTemp": new_bath},
            )
        except Exception:
            app.logger.exception("bath set temperature audit failed")


@app.route("/api/data/dt/runs", methods=["GET"])
def dt_runs_get():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    return jsonify(dt_test_service.get_all_runs())


@app.route("/api/data/dt/runs/<int:basket>", methods=["GET"])
def dt_run_get(basket):
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    # consume_saved: one-shot handoff of auto-saved report id to the kiosk poller
    return jsonify({"ok": True, "run": dt_test_service.get_run(basket, consume_saved=True)})


@app.route("/api/data/dt/runs/<int:basket>/preheat", methods=["POST"])
def dt_run_preheat(basket):
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    op = _session_operator()
    result = dt_test_service.start_preheat(
        basket,
        set_temperature=data.get("setTemperature") or data.get("temp"),
        mode=data.get("mode") or "manual",
        duration_minutes=data.get("durationMinutes") or data.get("duration"),
        basket_config=data.get("basketConfig") or data.get("tubeCount") or 6,
        product_name=data.get("productName") or data.get("name") or "",
        batch_number=data.get("batchNumber") or data.get("batch") or "",
        recipe_id=data.get("recipeId"),
        recipe_name=data.get("recipeName") or data.get("productName") or "",
        media=data.get("media"),
        mesh=data.get("mesh"),
        operator_name=op["name"],
        operator_id=op["employeeId"],
        operator_username=op["username"],
    )
    return jsonify(result), (_bath_conflict_status(result) if not result.get("ok") else 200)


@app.route("/api/data/dt/runs/<int:basket>/setup", methods=["POST"])
def dt_run_setup(basket):
    """Apply quick-test product/batch/mode onto a preheated run before Start."""
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    result = dt_test_service.apply_run_setup(
        basket,
        product_name=data.get("productName") or data.get("name") or "",
        batch_number=data.get("batchNumber") or data.get("batch") or "",
        mode=data.get("mode"),
        duration_minutes=data.get("durationMinutes") or data.get("duration"),
        media=data.get("media"),
        mesh=data.get("mesh"),
        recipe_name=data.get("recipeName") or data.get("productName") or "",
        set_temperature=data.get("setTemperature") or data.get("temp"),
    )
    return jsonify(result), (_bath_conflict_status(result) if not result.get("ok") else 200)


@app.route("/api/data/dt/runs/<int:basket>/confirm", methods=["POST"])
def dt_run_confirm(basket):
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    result = dt_test_service.confirm_start(basket)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/data/dt/runs/<int:basket>/tap", methods=["POST"])
def dt_run_tap(basket):
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    vessel = data.get("vessel") or data.get("hole") or data.get("tube")
    result = dt_test_service.tap_vessel(basket, int(vessel))
    # If complete, auto-save pending report (skip if stop_test already saved one)
    if result.get("ok") and result.get("report") and not result.get("savedReport"):
        try:
            report = dict(result["report"])
            report["reportApprovalStatus"] = "pending"
            for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
                report.pop(k, None)
            report = _stamp_report_operator(report)
            saved_id = data_service.save_report(report)
            saved = data_service.get_report(saved_id) or report
            result["savedReport"] = saved
            _audit_event(
                action="Report saved",
                outcome="success",
                details=f"Pending test report basket {basket}",
                entity_type="report",
                entity_id=str(saved_id or ""),
                entity_name=(saved or {}).get("name") or "",
                extra={"basket": basket, "mock": report.get("mock")},
            )
            dt_test_service.clear_run(basket)
        except Exception as e:
            app.logger.exception("auto-save report failed")
            result["saveError"] = str(e)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/data/dt/runs/<int:basket>/stop", methods=["POST"])
def dt_run_stop(basket):
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    aborted = bool(data.get("aborted"))
    reason = str(data.get("reason") or ("operator_abort" if aborted else "completed"))
    result = dt_test_service.stop_test(basket, aborted=aborted, reason=reason)
    # stop_test already persists via _dt_save_report — do not create a duplicate
    if result.get("ok") and result.get("report") and not result.get("savedReport"):
        try:
            report = dict(result["report"])
            report = _stamp_report_operator(report)
            if aborted or _report_is_aborted_payload(report):
                saved = _persist_operator_aborted_pending_report(report)
            else:
                report["reportApprovalStatus"] = "pending"
                for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
                    report.pop(k, None)
                saved_id = data_service.save_report(report)
                saved = data_service.get_report(saved_id) or report
                _audit_event(
                    action="Report saved",
                    outcome="success",
                    details=f"Completed test report basket {basket}",
                    entity_type="report",
                    entity_id=str(saved_id or ""),
                    entity_name=(saved or {}).get("name") or "",
                    extra={"basket": basket, "aborted": False, "mock": report.get("mock")},
                )
            result["savedReport"] = saved
            dt_test_service.clear_run(basket)
        except Exception as e:
            app.logger.exception("save report on stop failed")
            result["saveError"] = str(e)
    return jsonify(result), (200 if result.get("ok") else 400)


# =================== DT VALIDATION ==========================


@app.route("/api/data/dt/validation", methods=["GET"])
def dt_validation_status():
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    return jsonify(dt_validation_service.get_all())


@app.route("/api/data/dt/validation/stroke/<int:basket>/start", methods=["POST"])
def dt_stroke_start(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    result = dt_validation_service.start_stroke_validation(basket, operator=_session_operator())
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/data/dt/validation/stroke/<int:basket>", methods=["GET"])
def dt_stroke_get(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    session = dt_validation_service.get_session("stroke", basket)
    return jsonify({"ok": True, "session": session})


@app.route("/api/data/dt/validation/stroke/<int:basket>/abort", methods=["POST"])
def dt_stroke_abort(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    return jsonify(dt_validation_service.abort_stroke_validation(basket))


@app.route("/api/data/dt/validation/stroke/<int:basket>/save", methods=["POST"])
def dt_stroke_save(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    report = dt_validation_service.consume_report("stroke", basket)
    if not report:
        session = dt_validation_service.get_session("stroke", basket)
        if session and session.get("report"):
            report = session["report"]
        else:
            return jsonify({"ok": False, "error": "No stroke validation report to save"}), 400
    report = dict(report)
    if report.get("aborted") or report.get("status") == "ABORTED":
        report["status"] = "ABORTED"
        report["aborted"] = True
    for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
        report.pop(k, None)
    report = _stamp_report_operator(report)
    if _report_is_aborted_payload(report):
        saved = _persist_operator_aborted_pending_report(report)
        return jsonify({"ok": True, "report": saved})
    report["reportApprovalStatus"] = "pending"
    saved_id = data_service.save_report(report)
    saved = data_service.get_report(saved_id) or report
    _audit_event(
        action="Report saved",
        outcome="success",
        details=f"Pending stroke validation basket {basket}",
        entity_type="report",
        entity_id=str(saved_id or ""),
        entity_name=(saved or {}).get("name") or "",
    )
    return jsonify({"ok": True, "report": saved})


@app.route("/api/data/dt/validation/temp/<int:basket>/arm", methods=["POST"])
def dt_temp_arm(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    result = dt_validation_service.arm_temp_validation(
        basket,
        set_temperature=data.get("setTemperature") or data.get("temp") or 37.0,
        operator=_session_operator(),
    )
    return jsonify(result), (_bath_conflict_status(result) if not result.get("ok") else 200)


@app.route("/api/data/dt/validation/temp/<int:basket>/start", methods=["POST"])
def dt_temp_start(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    # Hold start — setpoint must already be armed via /arm. Optional setTemperature ignored when armed.
    result = dt_validation_service.start_temp_validation(
        basket,
        set_temperature=data.get("setTemperature") or data.get("temp"),
        operator=_session_operator(),
    )
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/data/dt/validation/temp/<int:basket>", methods=["GET"])
def dt_temp_get(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    session = dt_validation_service.get_session("temp", basket)
    return jsonify({"ok": True, "session": session})


@app.route("/api/data/dt/validation/temp/<int:basket>/abort", methods=["POST"])
def dt_temp_abort(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    return jsonify(dt_validation_service.abort_temp_validation(basket))


@app.route("/api/data/dt/validation/temp/<int:basket>/save", methods=["POST"])
def dt_temp_save(basket):
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    report = dt_validation_service.consume_report("temp", basket)
    if not report:
        session = dt_validation_service.get_session("temp", basket)
        if session and session.get("report"):
            report = session["report"]
        else:
            return jsonify({"ok": False, "error": "No temp validation report to save"}), 400
    report = dict(report)
    if report.get("aborted") or report.get("status") == "ABORTED":
        report["status"] = "ABORTED"
        report["aborted"] = True
    for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
        report.pop(k, None)
    report = _stamp_report_operator(report)
    if _report_is_aborted_payload(report):
        saved = _persist_operator_aborted_pending_report(report)
        return jsonify({"ok": True, "report": saved})
    report["reportApprovalStatus"] = "pending"
    saved_id = data_service.save_report(report)
    saved = data_service.get_report(saved_id) or report
    _audit_event(
        action="Report saved",
        outcome="success",
        details=f"Pending temp validation basket {basket}",
        entity_type="report",
        entity_id=str(saved_id or ""),
        entity_name=(saved or {}).get("name") or "",
    )
    return jsonify({"ok": True, "report": saved})


@app.route("/api/data/dt/validation/<int:basket>/combined/abort", methods=["POST"])
def dt_combined_validation_abort(basket):
    """Abort in-progress Stroke→Temp validation; save pending for Pass/Fail approval."""
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    stroke_payload = data.get("stroke") if isinstance(data.get("stroke"), dict) else None
    temp_payload = data.get("temp") if isinstance(data.get("temp"), dict) else None
    phase = data.get("phase")
    # Stop hardware / mark sessions aborted (idempotent if already idle)
    try:
        dt_validation_service.abort_stroke_validation(basket)
    except Exception:
        app.logger.exception("combined abort: stroke abort failed for basket %s", basket)
    try:
        dt_validation_service.abort_temp_validation(basket)
    except Exception:
        app.logger.exception("combined abort: temp abort failed for basket %s", basket)
    report = dt_validation_service.build_aborted_combined_validation_report(
        basket,
        stroke_payload=stroke_payload,
        temp_payload=temp_payload,
        phase=phase,
        operator=_session_operator(),
    )
    report = dict(report)
    report["status"] = "ABORTED"
    report["aborted"] = True
    for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
        report.pop(k, None)
    report = _stamp_report_operator(report)
    saved = _persist_operator_aborted_pending_report(report)
    saved_id = saved.get("id")
    try:
        dt_validation_service.clear_validation_checkpoint(basket)
    except Exception:
        app.logger.exception("clear validation checkpoint after abort failed")
    _audit_event(
        action="Validation aborted",
        outcome="aborted",
        details=f"Aborted validation basket {basket} | pending approval",
        entity_type="report",
        entity_id=str(saved_id or ""),
        entity_name=(saved or {}).get("name") or "",
    )
    return jsonify({"ok": True, "report": saved})


@app.route("/api/data/dt/validation/<int:basket>/combined/save", methods=["POST"])
def dt_combined_validation_save(basket):
    """Save one pending validation report with stroke + temp runs and pending due interval."""
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    stroke_payload = data.get("stroke") if isinstance(data.get("stroke"), dict) else None
    temp_payload = data.get("temp") if isinstance(data.get("temp"), dict) else None
    pending_due = data.get("pendingValidationDue") if isinstance(data.get("pendingValidationDue"), dict) else None
    op_pf = (data.get("operatorValidationPassFail") or data.get("operator_validation_pass_fail") or "").strip().upper()
    if op_pf not in ("PASS", "FAIL"):
        op_pf = None
    report = dt_validation_service.build_combined_validation_report(
        basket,
        stroke_payload=stroke_payload,
        temp_payload=temp_payload,
        pending_due=pending_due,
        operator=_session_operator(),
        operator_validation_pass_fail=op_pf,
    )
    if not (report.get("validationRuns") or []):
        return jsonify({"ok": False, "error": "No stroke/temp validation results to save"}), 400
    stroke_ok = any(
        str((r or {}).get("validationSubtype") or "").lower() == "stroke"
        for r in (report.get("validationRuns") or [])
    )
    temp_ok = any(
        str((r or {}).get("validationSubtype") or "").lower() == "temp"
        for r in (report.get("validationRuns") or [])
    )
    if not stroke_ok or not temp_ok:
        return jsonify({"ok": False, "error": "Combined report requires both stroke and temperature results"}), 400
    report = dict(report)
    report["reportApprovalStatus"] = "pending"
    for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
        report.pop(k, None)
    report = _stamp_report_operator(report)
    saved_id = data_service.save_report(report)
    saved = data_service.get_report(saved_id) or report
    try:
        dt_validation_service.clear_validation_checkpoint(basket)
    except Exception:
        app.logger.exception("clear validation checkpoint after save failed")
    _audit_event(
        action="Report saved",
        outcome="success",
        details=f"Pending combined stroke+temp validation basket {basket}",
        entity_type="report",
        entity_id=str(saved_id or ""),
        entity_name=(saved or {}).get("name") or "",
        extra={"basket": basket, "subtype": "combined"},
    )
    return jsonify({"ok": True, "report": saved})


# =================== DT CALIBRATION ==========================


@app.route("/api/data/calibration", methods=["POST"])
def dt_calibration():
    """Calibrate shared bath — requires calibration-menu + X-Approval-Verify-Token."""
    gate = _require_session_internal("calibration-menu", "Forbidden. You do not have permission to calibrate.")
    if gate:
        return gate
    verified, verify_err = _consume_approval_verify_token("calibration")
    if verify_err:
        return jsonify({"ok": False, "error": verify_err}), 403
    data = request.get_json(force=True, silent=True) or {}
    probe = str(data.get("probe") or "BATH").strip().upper()
    temperature = data.get("temperature") or data.get("temp") or data.get("setTemperature")
    operator = _session_operator()
    # Shared bath: BOTH / BATH / ALL / default → calibrate all three channels
    if probe in ("BOTH", "ALL", "IR+EXT", "IR_EXT", "BATH", "SHARED", ""):
        result = dt_calibration_service.calibrate_bath(
            temperature=temperature,
            operator=operator,
            verifier=verified,
        )
    else:
        result = dt_calibration_service.calibrate(
            sensor=data.get("sensor"),
            beaker=data.get("beaker") or data.get("basket"),
            probe=probe,
            temperature=temperature,
            operator=operator,
            verifier=verified,
        )
    if result.get("ok") and result.get("report") and data.get("saveReport", True):
        try:
            report = dict(result["report"])
            report["reportApprovalStatus"] = "pending"
            for k in (
                "approvalPassFail",
                "approvalRemarks",
                "approvedBy",
                "approvedAt",
                "approvedByUsername",
            ):
                report.pop(k, None)
            report = _stamp_report_operator(report)
            saved_id = data_service.save_report(report)
            saved = data_service.get_report(saved_id) or report
            result["savedReport"] = saved
            result["report"] = saved
            _audit_event(
                action="Report saved",
                outcome="success",
                details="Pending calibration report",
                entity_type="report",
                entity_id=str(saved_id or ""),
                entity_name=(saved or {}).get("name") or "",
            )
        except Exception as e:
            app.logger.exception("save calibration report failed")
            result["saveError"] = str(e)
    return jsonify(result), (_bath_conflict_status(result) if not result.get("ok") else 200)


# =================== BIOMETRIC ==========================


@app.route("/api/biometric/status", methods=["GET"])
def biometric_status():
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric disabled by factory settings"}), 403
        result = biometric_service.status()
        return jsonify(result), 200 if result.get("ok") else 500
    except Exception as e:
        app.logger.exception("Error checking biometric status")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/enroll", methods=["POST"])
def biometric_enroll():
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric enrollment is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "username is required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            _audit_event(action="Biometric enroll", outcome="failed", entity_type="member", entity_name=username, details="Member not found for provided username", target_user=username)
            return jsonify({"ok": False, "error": "Member not found for the provided username"}), 404
        before_member = dict(member)
        status = str(member.get("status") or "active").strip().lower()
        if status != "active":
            _audit_event(action="Biometric enroll", outcome="denied", entity_type="member", entity_id=member.get("id"), entity_name=username, details="Member account is not active", target_user=username, before=before_member)
            return jsonify({"ok": False, "error": "Member account is not active"}), 403
        template_id_raw = payload.get("templateId")
        if template_id_raw is None:
            template_id = data_service.get_next_fingerprint_template_id()
        else:
            template_id = int(template_id_raw)
        timeout_sec = float(payload.get("captureTimeoutSec") or BIOMETRIC_ENROLL_TIMEOUT_SEC)
        enrolled = biometric_service.enroll(template_id, capture_timeout_sec=timeout_sec)
        if not enrolled.get("ok"):
            _audit_event(action="Biometric enroll", outcome="failed", entity_type="member", entity_id=member.get("id"), entity_name=username, details=enrolled.get("error") or "Unknown error", target_user=username, before=before_member, extra={"templateId": template_id})
            return jsonify(enrolled), 400
        previous_owner = data_service.get_member_by_fingerprint_template(template_id)
        if previous_owner and previous_owner.get("id") != member.get("id"):
            previous_owner["fingerprintTemplateId"] = None
            previous_owner["biometricEnrollmentStatus"] = "not_enrolled"
            previous_owner["biometricEnrolledAt"] = None
            data_service.save_member(previous_owner)
        member["fingerprintTemplateId"] = template_id
        member["biometricEnrollmentStatus"] = "enrolled"
        member["biometricEnrolledAt"] = int(time.time())
        member["biometricEnabled"] = True
        data_service.save_member(member)
        _audit_event(
            action="Biometric enroll",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=username,
            details="Fingerprint enrolled and linked",
            target_user=username,
            before=before_member,
            after=member,
            extra={"templateId": template_id},
        )
        return jsonify({"ok": True, "templateId": template_id, "linked": True, "memberId": member.get("id")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric enrollment")
        return jsonify({"ok": False, "error": str(e)}), 500




def _clear_enroll_session(username):
    key = str(username or "").strip().lower()
    if not key:
        return
    with _enroll_sessions_lock:
        _enroll_sessions.pop(key, None)


def _get_enroll_session(username):
    key = str(username or "").strip().lower()
    with _enroll_sessions_lock:
        return dict(_enroll_sessions.get(key) or {})


def _set_enroll_session(username, data):
    key = str(username or "").strip().lower()
    with _enroll_sessions_lock:
        _enroll_sessions[key] = dict(data or {})


@app.route("/api/biometric/enroll/capture", methods=["POST"])
def biometric_enroll_capture():
    """Step 1 or 2 of fingerprint enrollment (two scans of the same finger)."""
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric enrollment is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "username is required"}), 400
        try:
            step = int(payload.get("step") or 0)
        except (TypeError, ValueError):
            step = 0
        if step not in (1, 2):
            return jsonify({"ok": False, "error": "step must be 1 or 2"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Member not found for the provided username"}), 404
        status = str(member.get("status") or "active").strip().lower()
        if status != "active":
            return jsonify({"ok": False, "error": "Member account is not active"}), 403
        before_member = dict(member)
        timeout_sec = float(payload.get("captureTimeoutSec") or BIOMETRIC_ENROLL_TIMEOUT_SEC)

        if step == 1:
            template_id_raw = payload.get("templateId")
            if template_id_raw is None:
                template_id = data_service.get_next_fingerprint_template_id()
            else:
                template_id = int(template_id_raw)
            captured = biometric_service.capture_enroll_finger(0x01, timeout_sec=timeout_sec)
            if not captured.get("ok"):
                _clear_enroll_session(username)
                return jsonify(captured), 400
            _set_enroll_session(username, {"templateId": template_id, "step1Done": True, "startedAt": int(time.time())})
            return jsonify({
                "ok": True,
                "step": 1,
                "nextStep": 2,
                "templateId": template_id,
                "message": "First scan complete. Remove your finger from the scanner.",
                "nextMessage": "Place the same finger on the scanner again for the second scan.",
            }), 200

        session = _get_enroll_session(username)
        if not session.get("step1Done"):
            return jsonify({"ok": False, "error": "Complete capture step 1 before step 2."}), 400
        template_id = int(session.get("templateId") or 0)
        if template_id <= 0:
            _clear_enroll_session(username)
            return jsonify({"ok": False, "error": "Enrollment session expired. Start again."}), 400

        captured = biometric_service.capture_enroll_finger(0x02, timeout_sec=timeout_sec)
        if not captured.get("ok"):
            _clear_enroll_session(username)
            return jsonify(captured), 400

        finalized = biometric_service.finalize_enroll(template_id)
        _clear_enroll_session(username)
        if not finalized.get("ok"):
            _audit_event(
                action="Biometric enroll",
                outcome="failed",
                entity_type="member",
                entity_id=member.get("id"),
                entity_name=username,
                details=finalized.get("error") or "Unknown error",
                target_user=username,
                before=before_member,
                extra={"templateId": template_id},
            )
            return jsonify(finalized), 400

        previous_owner = data_service.get_member_by_fingerprint_template(template_id)
        if previous_owner and previous_owner.get("id") != member.get("id"):
            previous_owner["fingerprintTemplateId"] = None
            previous_owner["biometricEnrollmentStatus"] = "not_enrolled"
            previous_owner["biometricEnrolledAt"] = None
            data_service.save_member(previous_owner)
        member["fingerprintTemplateId"] = template_id
        member["biometricEnrollmentStatus"] = "enrolled"
        member["biometricEnrolledAt"] = int(time.time())
        member["biometricEnabled"] = True
        data_service.save_member(member)
        _audit_event(
            action="Biometric enroll",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=username,
            details="Fingerprint enrolled and linked (2 captures)",
            target_user=username,
            before=before_member,
            after=member,
            extra={"templateId": template_id},
        )
        return jsonify({
            "ok": True,
            "step": 2,
            "templateId": template_id,
            "linked": True,
            "memberId": member.get("id"),
            "message": "Fingerprint registered successfully.",
        }), 200
    except Exception as e:
        app.logger.exception("Error during biometric enroll capture")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/enroll/cancel", methods=["POST"])
def biometric_enroll_cancel():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if username:
            _clear_enroll_session(username)
        try:
            biometric_service.cancel_and_idle()
        except Exception as bio_err:
            app.logger.warning("Biometric enroll cancel idle failed: %s", bio_err)
        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/cancel", methods=["POST"])
def biometric_cancel():
    """Stop an in-progress login/verify/enroll scan and turn the sensor LED off."""
    try:
        result = biometric_service.cancel_and_idle()
        return jsonify(result if isinstance(result, dict) else {"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error cancelling biometric scan")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/delete", methods=["POST"])
def biometric_delete():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        template_id = payload.get("templateId")
        if template_id is None:
            return jsonify({"ok": False, "error": "templateId is required"}), 400
        result = biometric_service.delete_template(template_id)
        if result.get("ok"):
            _audit_event(action="Biometric template delete", outcome="success", entity_type="biometric_template", entity_id=template_id, entity_name="template {}".format(template_id), details="Template deleted from sensor", extra={"templateId": int(template_id)})
            return jsonify({"ok": True, "templateId": int(template_id)}), 200
        _audit_event(action="Biometric template delete", outcome="failed", entity_type="biometric_template", entity_id=template_id, entity_name="template {}".format(template_id), details=result.get("error") or "Delete failed", extra={"templateId": int(template_id)})
        return jsonify(result), 400
    except Exception as e:
        app.logger.exception("Error deleting biometric template")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATETIME / RTC ==========================


def _get_stored_datetime():
    """Return local wall time from the DS1307 (hwclock on /dev/rtc0), not NTP/network."""
    return rtc_service.get_device_wall_datetime_payload()


@app.route("/api/get_datetime", methods=["GET"])
def get_datetime():
    return jsonify(_get_stored_datetime())


@app.route("/api/system/network-addresses", methods=["GET"])
def get_network_addresses():
    denied = _require_auth()
    if denied:
        return denied
    try:
        payload = network_service.list_non_tailscale_addresses()
        return jsonify(payload), 200
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc), "wlan": None, "lan": None}), 500


def _set_datetime_common():
    denied = _require_edit_datetime()
    if denied:
        return denied
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"ok": False, "error": "datetime required"}), 400
    prev_payload = _get_stored_datetime()
    prev_raw = (prev_payload.get("datetime") or "").strip()
    try:
        clean = dt_str.strip().replace("Z", "")
        if "+" in clean:
            clean = clean.split("+", 1)[0]
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0]
        dt_obj = datetime.fromisoformat(clean)
        if getattr(dt_obj, "tzinfo", None) is not None:
            dt_obj = dt_obj.replace(tzinfo=None)
    except Exception:
        return jsonify({"ok": False, "error": "invalid datetime"}), 400
    rtc_ok, rtc_err = rtc_service.apply_user_wall_time(dt_obj)
    if not rtc_ok:
        return jsonify({"ok": False, "error": rtc_err or "Failed to set RTC time"}), 500
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        with open(DATETIME_STORAGE, "w", encoding="utf-8") as f:
            json.dump({"datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"), "last_tick": time.time()}, f)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    applied = rtc_service.get_device_wall_datetime_payload()
    new_raw = (applied.get("datetime") or dt_obj.strftime("%Y-%m-%dT%H:%M:%S")).strip()
    _audit(
        None,
        None,
        "System date change",
        "Changed from {} to {}".format(
            _format_wall_datetime_for_audit(prev_raw),
            _format_wall_datetime_for_audit(new_raw),
        ),
    )
    return jsonify({
        "ok": True,
        "datetime": applied.get("datetime") or dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": applied.get("source", "rtc"),
    })


@app.route("/api/set_datetime", methods=["POST"])
def set_datetime():
    # Backward-compatible route used by older frontend builds.
    return _set_datetime_common()


@app.route("/api/set_device_datetime", methods=["POST"])
def set_device_datetime():
    # Reference-project route used by updated frontend flow.
    return _set_datetime_common()


@app.route("/api/rtc/date", methods=["GET"])
def get_rtc_date():
    result = rtc_service.get_rtc_date()
    return jsonify(result), 200


@app.route("/api/rtc/date", methods=["POST"])
def set_rtc_date_route():
    denied = _require_edit_datetime()
    if denied:
        return denied
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"success": False, "error": "datetime required"}), 400
    try:
        from datetime import datetime
        dt_obj = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return jsonify({"success": False, "error": "invalid datetime"}), 400
    result = rtc_service.set_rtc_date(dt_obj)
    if result.get("success"):
        _audit(None, None, "RTC date set", dt_str)
    return jsonify(result), 200 if result.get("success") else 500


def _export_purge_loop():
    while True:
        try:
            _maybe_purge_scheduled_exports()
        except Exception:
            app.logger.exception("Export purge loop error")
        time.sleep(60)


def _start_export_purge_thread():
    t = threading.Thread(target=_export_purge_loop, daemon=True, name="export-purge")
    t.start()


_startup_session_power_audit()
_register_clean_shutdown_signals()
_register_clean_shutdown_atexit()
_start_export_purge_thread()


# =================== MAIN ==========================


if __name__ == "__main__":
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=False, threaded=True)
