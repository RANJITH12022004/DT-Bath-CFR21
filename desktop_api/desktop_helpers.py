"""Shared helpers for desktop API audit and member validation."""

from __future__ import annotations

from flask import request

import audit_service
import data_service
import rbac_service

from desktop_api.auth_store import desktop_signature
from desktop_api import rbac_compat


def display_role_label(role_str):
    role = str(role_str or "").strip().lower()
    labels = {
        "factory": "Factory",
        "admin": "Admin",
        "supervisor": "Supervisor",
        "operator": "Operator",
        "qa": "QA",
    }
    return labels.get(role, role_str or "—")


def password_strength_error(password: str) -> str:
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


def self_profile_payload_from_request(existing: dict, payload: dict) -> dict:
    out = dict(existing)
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if name:
            out["name"] = name
    new_pwd = payload.get("password")
    if new_pwd is not None and str(new_pwd).strip():
        pwd_err = password_strength_error(str(new_pwd))
        if pwd_err:
            raise ValueError(pwd_err)
        out["password"] = str(new_pwd)
    return out


def can_assign_feature_overrides(user: dict) -> bool:
    role = str((user or {}).get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(user or {}, "user-add")


def payload_has_protected_feature_overrides(member_data) -> bool:
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


def _audit_time_fields(kiosk):
    fn = getattr(kiosk, "_audit_time_fields", None)
    if fn:
        return fn()
    from datetime import datetime

    now = datetime.now()
    return {
        "timestamp_ms": int(now.timestamp() * 1000),
        "date_time": now.strftime("%d/%m/%Y %H:%M:%S"),
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
    return [key for key in keys if before_obj.get(key) != after_obj.get(key)]


def audit_event(kiosk, user, **kwargs):
    """Structured audit attributed to the desktop Bearer user (not kiosk touchscreen session)."""
    audit_time = _audit_time_fields(kiosk)
    u = (user or {}).get("username") or (user or {}).get("name") or "--"
    r = (user or {}).get("role") or "--"
    sig = kwargs.get("signature") or desktop_signature(user)
    before_clean = _sanitize_audit_payload(kwargs.get("before"))
    after_clean = _sanitize_audit_payload(kwargs.get("after"))
    audit_service.log_structured_event(
        user=u,
        role=r,
        action=kwargs.get("action") or "",
        details=kwargs.get("details") or "",
        event_type=kwargs.get("event_type") or "compliance",
        entity_type=kwargs.get("entity_type") or "",
        entity_id=kwargs.get("entity_id"),
        entity_name=kwargs.get("entity_name") or "",
        outcome=kwargs.get("outcome") or "success",
        reason=kwargs.get("reason") or "",
        session_user=u,
        session_role=r,
        target_user=kwargs.get("target_user") or "",
        signature_mode=(sig or {}).get("mode") or "desktop",
        signature_user=(sig or {}).get("username") or u,
        signature_role=(sig or {}).get("role") or r,
        changed_fields=_changed_fields(
            before_clean if isinstance(before_clean, dict) else {},
            after_clean if isinstance(after_clean, dict) else {},
        ),
        before=before_clean,
        after=after_clean,
        request_source="{} {}".format(request.method, request.path),
        extra=kwargs.get("extra"),
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )


def audit_member_permissions_if_changed(kiosk, user, before_member, after_member, *, member_id):
    payload = rbac_compat.build_permission_change_audit(
        before_member,
        after_member,
        target_username=str(
            (after_member or {}).get("username") or (after_member or {}).get("name") or ""
        ).strip(),
    )
    if not payload:
        return
    uname = str(
        (after_member or {}).get("username") or (after_member or {}).get("name") or ""
    ).strip()
    audit_event(
        kiosk,
        user,
        action="User permissions updated",
        outcome="success",
        entity_type="member",
        entity_id=member_id,
        entity_name=uname,
        details=payload.get("details") or "User permissions updated",
        target_user=uname,
        before=payload.get("before"),
        after=payload.get("after"),
        extra=payload.get("extra"),
    )


def legacy_audit(kiosk, user, action, details=""):
    fn = getattr(kiosk, "_audit", None)
    if fn:
        u = (user or {}).get("username") or (user or {}).get("name") or "--"
        r = (user or {}).get("role") or "--"
        return fn(u, r, action, details)
    audit_event(kiosk, user, action=action, details=details, event_type="legacy")


def prepare_desktop_created_member(member_id: int, initial_password: str):
    """Admin-created users can sign in from the desktop client with the set password."""
    pwd = str(initial_password or "").strip()
    if not pwd:
        return None
    member = data_service.get_member(member_id)
    if not member:
        return None
    patch = dict(member)
    patch["mustChangePassword"] = False
    patch["failedAttempts"] = 0
    patch["status"] = "active"
    data_service._clear_creation_password_commitment(patch)
    data_service._save_member_record(patch)
    return patch
