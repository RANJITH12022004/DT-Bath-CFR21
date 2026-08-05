"""Bearer token store and decorators for desktop API."""

from __future__ import annotations

import os
import secrets
import threading
import time
from functools import wraps

from flask import jsonify, request

import data_service
import rbac_service

from desktop_api import rbac_compat

DESKTOP_TOKEN_TTL_SECONDS = int(os.environ.get("DESKTOP_TOKEN_TTL_SECONDS", str(8 * 60 * 60)))
APPROVAL_VERIFY_TTL_SECONDS = int(os.environ.get("APPROVAL_VERIFY_TTL_SECONDS", "180"))
EMBED_TICKET_TTL_SECONDS = int(os.environ.get("DESKTOP_EMBED_TICKET_TTL_SECONDS", str(30 * 60)))

_tokens: dict = {}
_tokens_lock = threading.Lock()
_approval_verify_tokens: dict = {}
_embed_tickets: dict = {}


def _now() -> int:
    return int(time.time())


def token_from_request() -> str:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.args.get("token") or "").strip()


def user_snapshot(user: dict) -> dict:
    safe = data_service.sanitize_member_for_client(user) or dict(user or {})
    try:
        permissions = sorted(rbac_service.member_expanded_internal_keys(safe))
    except Exception:
        permissions = []
    cards = rbac_compat.permission_allow_cards(safe)
    return {
        **safe,
        "permissions": sorted(set(permissions + cards)),
        "permissionCards": cards,
    }


def issue_token(user: dict) -> tuple[str, dict]:
    token = secrets.token_urlsafe(32)
    snapshot = user_snapshot(user)
    with _tokens_lock:
        _tokens[token] = {
            "user": snapshot,
            "expires_at": _now() + DESKTOP_TOKEN_TTL_SECONDS,
        }
    return token, snapshot


def revoke_token(token: str) -> None:
    if not token:
        return
    with _tokens_lock:
        _tokens.pop(token, None)


def current_user():
    token = token_from_request()
    if not token:
        return None, None
    with _tokens_lock:
        session = _tokens.get(token)
        if not session:
            return None, None
        if int(session.get("expires_at") or 0) < _now():
            _tokens.pop(token, None)
            return None, None
        user = dict(session.get("user") or {})
        username = str(user.get("username") or "").strip()
        if username and username.upper() != data_service.FACTORY_USERNAME.upper():
            member = data_service.get_member_by_username(username)
            if member:
                user = user_snapshot(member)
                session["user"] = user
        session["expires_at"] = _now() + DESKTOP_TOKEN_TTL_SECONDS
        return token, user


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        _token, user = current_user()
        if not user:
            return jsonify({"error": "Unauthorized"}), 401
        return fn(user, *args, **kwargs)
    return wrapper


def require_internal(internal_key: str):
    def decorator(fn):
        @wraps(fn)
        @require_auth
        def wrapper(user, *args, **kwargs):
            if not rbac_service.member_has_internal(user or {}, internal_key):
                return jsonify({"error": "Forbidden"}), 403
            return fn(user, *args, **kwargs)
        return wrapper
    return decorator


def require_any_internal(internal_keys):
    def decorator(fn):
        @wraps(fn)
        @require_auth
        def wrapper(user, *args, **kwargs):
            for key in internal_keys or []:
                if rbac_service.member_has_internal(user or {}, key):
                    return fn(user, *args, **kwargs)
            return jsonify({"error": "Forbidden"}), 403
        return wrapper
    return decorator


def _cleanup_approval_verify_tokens():
    now = _now()
    stale = [t for t, p in _approval_verify_tokens.items() if int(p.get("expiresAt", 0)) <= now]
    for token in stale:
        _approval_verify_tokens.pop(token, None)


def _verifier_payload_has_internal(payload: dict, internal_key: str) -> bool:
    role = str((payload or {}).get("role") or "").strip().lower()
    if role == "factory":
        return True
    un = (payload or {}).get("username") or ""
    vm = data_service.get_member_by_username(un) if un else None
    if not vm:
        return False
    return rbac_service.member_has_internal(vm, internal_key)


def issue_approval_verify_token(verifier_user: dict, purpose: str) -> tuple[str, dict]:
    _cleanup_approval_verify_tokens()
    now = _now()
    token = secrets.token_urlsafe(24)
    payload = {
        "username": verifier_user.get("username") or "",
        "name": verifier_user.get("name") or verifier_user.get("username") or "",
        "role": str(verifier_user.get("role") or "").strip().lower(),
        "purpose": str(purpose or "recipe").strip().lower(),
        "issuedAt": now,
        "expiresAt": now + APPROVAL_VERIFY_TTL_SECONDS,
    }
    _approval_verify_tokens[token] = payload
    return token, payload


def consume_approval_verify_token(expected_purpose: str):
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
    if exp == "recipe" and not _verifier_payload_has_internal(payload, "recipe-approve"):
        return None, "Verifier does not have recipe approval permission."
    if exp == "user_admin" and not _verifier_payload_has_internal(payload, "user-manage"):
        return None, "Verifier does not have profile management permission."
    if exp == "report" and not _verifier_payload_has_internal(payload, "test-report-approve"):
        return None, "Verifier does not have test report approval permission."
    if exp == "export" and not _verifier_payload_has_internal(payload, "export-approve"):
        return None, "Verifier does not have export approval permission."
    return payload, None


def is_self_member(user: dict, member_id: int) -> bool:
    try:
        target_id = int(member_id)
    except (TypeError, ValueError):
        return False
    try:
        sid = int(user.get("id"))
        if sid == target_id:
            return True
    except (TypeError, ValueError):
        pass
    member = data_service.get_member(target_id)
    if not member:
        return False
    un_cur = str(user.get("username") or "").strip().lower()
    un_mem = str(member.get("username") or "").strip().lower()
    return bool(un_cur) and un_cur == un_mem


def desktop_signature(user: dict) -> dict:
    return {
        "mode": "desktop",
        "username": (user.get("username") or user.get("name") or "").strip() or "--",
        "role": (user.get("role") or "").strip() or "--",
    }


def issue_embed_ticket(user: dict, bearer_token: str) -> str:
    ticket = secrets.token_urlsafe(24)
    with _tokens_lock:
        _embed_tickets[ticket] = {
            "user": dict(user or {}),
            "bearer": bearer_token,
            "expires_at": _now() + EMBED_TICKET_TTL_SECONDS,
        }
    return ticket


def consume_embed_ticket(ticket: str):
    if not ticket:
        return None
    with _tokens_lock:
        entry = _embed_tickets.get(ticket)
        if not entry:
            return None
        if int(entry.get("expires_at") or 0) < _now():
            _embed_tickets.pop(ticket, None)
            return None
        return dict(entry)
