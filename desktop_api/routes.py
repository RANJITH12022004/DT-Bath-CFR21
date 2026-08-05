"""Bearer-token desktop API routes. Delegates PDF/audit rendering to existing app helpers."""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime

from flask import Blueprint, after_this_request, jsonify, request, send_file

import audit_service
import data_service
import pdf_generator
import rbac_service

from desktop_api import auth_store
from desktop_api.desktop_helpers import audit_event, legacy_audit
from desktop_api.members_routes import register_members_routes
from desktop_api.recipes_routes import register_recipes_routes


def _filter_range(filters: dict) -> dict:
    out = {}
    for key in ("user", "role", "action", "type", "range"):
        value = filters.get(key)
        if value:
            out[key] = value
    for key in ("from", "to"):
        value = filters.get(key)
        if not value:
            continue
        try:
            out[key] = int(value)
        except (TypeError, ValueError):
            out[key] = value
    return out


def _build_audit_html(kiosk, entries, filters, factory, user):
    """Call product `_build_audit_trail_html` with optional export_meta (TD only)."""
    import inspect

    build = getattr(kiosk, "_build_audit_trail_html", None)
    if not build:
        raise RuntimeError("Kiosk app is missing _build_audit_trail_html")
    export_meta = {"exported_by": user, "approved_by": user}
    try:
        params = inspect.signature(build).parameters
    except (TypeError, ValueError):
        params = {}
    if "export_meta" in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return build(entries, filters, factory, export_meta=export_meta)
    try:
        return build(entries, filters, factory, export_meta)
    except TypeError:
        return build(entries, filters, factory)


def _send_temp(path, download_name, mimetype):
    path = pathlib.Path(path)

    @after_this_request
    def _cleanup(response):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return response

    return send_file(path, mimetype=mimetype, as_attachment=True, download_name=download_name)


def _is_display_ipv4(ip: str) -> bool:
    value = str(ip or "").strip()
    if not value or value.startswith("127.") or value.startswith("100."):
        return False
    parts = value.split(".")
    if len(parts) != 4:
        return False
    try:
        return all(0 <= int(part) <= 255 for part in parts)
    except (TypeError, ValueError):
        return False


def _collect_ipv4_addresses():
    found = []
    seen = set()
    source = ""

    def add_ip(ip):
        if not _is_display_ipv4(ip):
            return
        if ip in seen:
            return
        seen.add(ip)
        found.append(ip)

    try:
        proc = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=10)
        raw = (proc.stdout or "").strip()
        if raw:
            source = "hostname -I"
            for part in raw.split():
                add_ip(part)
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        pass

    if not found:
        for ip_cmd in (
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            ["/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"],
        ):
            try:
                proc = subprocess.run(ip_cmd, capture_output=True, text=True, timeout=10)
                if proc.returncode != 0:
                    continue
                matches = re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)/", proc.stdout or "")
                if matches:
                    source = " ".join(ip_cmd)
                    for ip in matches:
                        add_ip(ip)
                    break
            except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
                continue

    return {"addresses": found, "source": source}


def create_blueprint(kiosk):
    """Build blueprint; kiosk is the loaded app module for shared PDF/audit helpers."""
    bp = Blueprint("rle_desktop_api", __name__, url_prefix="/api/desktop/v1")

    def log_major(user, action, details, **kwargs):
        """Write a machine-style major audit row attributed to the desktop user."""
        try:
            audit_event(
                kiosk,
                user or {},
                action=action,
                details=details,
                outcome=kwargs.get("outcome") or "success",
                entity_type=kwargs.get("entity_type") or "desktop",
                entity_id=kwargs.get("entity_id"),
                entity_name=kwargs.get("entity_name") or "desktop-client",
                target_user=kwargs.get("target_user") or "",
                event_type=kwargs.get("event_type") or "compliance",
                reason=kwargs.get("reason") or "",
            )
        except Exception:
            # Fall back to legacy helper if structured write fails.
            try:
                legacy_audit(kiosk, user or {}, action, details)
            except Exception:
                pass

    def _desktop_app_name(factory):
        """Product-agnostic display name for multi-machine desktop clients."""
        env_name = (os.environ.get("DESKTOP_APP_NAME") or "").strip()
        if env_name:
            return env_name
        try:
            name_file = pathlib.Path(os.environ.get("APP_ROOT") or "/opt/kiosk") / "desktop_app_name"
            if name_file.is_file():
                file_name = name_file.read_text(encoding="utf-8").strip()
                if file_name:
                    return file_name
        except OSError:
            pass
        for key in (
            "appName",
            "productName",
            "instrumentName",
            "companyName",
            "company",
            "instrument",
        ):
            value = str((factory or {}).get(key) or "").strip()
            if value:
                return value
        return "RLE Kiosk"

    @bp.route("/health", methods=["GET"])
    def desktop_health():
        try:
            factory = data_service.get_factory_settings() or {}
        except Exception:
            factory = {}
        return jsonify({
            "ok": True,
            "status": "ok",
            "app": _desktop_app_name(factory),
            "model": factory.get("modelNo") or factory.get("model") or "",
            "serial": factory.get("serialNo") or factory.get("serial") or "",
            "time": datetime.now().isoformat(),
        }), 200

    @bp.route("/auth/login", methods=["POST"])
    def desktop_auth_login():
        try:
            credentials = request.get_json(force=True, silent=True) or {}
            username = " ".join(str(credentials.get("username") or "").split())
            password = credentials.get("password") if isinstance(credentials.get("password"), str) else str(credentials.get("password") or "")
            if not username:
                return jsonify({"error": "Username is required."}), 400
            member = data_service.get_member_by_username(username)
            if member:
                status = str(member.get("status") or "active").strip().lower()
                if status == "disabled":
                    return jsonify({"error": "Account disabled by admin."}), 403
            user = data_service.authenticate_user(username, password)
            if not user:
                try:
                    members = data_service.list_members() or []
                except Exception:
                    members = []
                if not members:
                    return jsonify({
                        "error": "No member accounts are configured on this machine (members list is empty). Factory login still works; restore members or create users on the kiosk.",
                        "membersEmpty": True,
                    }), 401
                log_major(
                    {"username": username, "role": "--"},
                    "Login",
                    "Desktop client | Wrong password | User ID entered: {}".format(username),
                    outcome="denied",
                    entity_type="session",
                    entity_name="password",
                    target_user=username,
                )
                body = {"error": "Invalid username or password."}
                return jsonify(body), 401
            if username.upper() != data_service.FACTORY_USERNAME.upper():
                member = data_service.get_member_by_username(username)
                if member:
                    expiry = data_service.get_member_password_expiry_state(member)
                    if bool(expiry.get("expired")):
                        log_major(
                            {"username": username, "role": member.get("role") or "--"},
                            "Login",
                            "Desktop client | Password expired. Reset required. | User ID entered: {}".format(username),
                            outcome="denied",
                            entity_type="session",
                            entity_name="password",
                            target_user=username,
                        )
                        return jsonify({"error": "Password expired. Reset required.", "passwordExpired": True, "expiry": expiry}), 403
            data_service.record_successful_login(username)
            member_after = data_service.get_member_by_username(username)
            if member_after and str(member_after.get("status") or "").strip().lower() == "locked":
                member_after["status"] = "active"
                member_after["failedAttempts"] = 0
                data_service._save_member_record(member_after)
            token, safe_user = auth_store.issue_token(user)
            log_major(
                safe_user,
                "Login",
                "Desktop client | User logged in: {}".format(username),
                entity_type="session",
                entity_name="desktop-client",
                target_user=username,
            )
            return jsonify({"success": True, "token": token, "user": safe_user}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/auth/me", methods=["GET"])
    @auth_store.require_auth
    def desktop_auth_me(user):
        return jsonify({"user": user}), 200

    @bp.route("/auth/logout", methods=["POST"])
    @auth_store.require_auth
    def desktop_auth_logout(user):
        uname = user.get("username") or user.get("name") or "--"
        auth_store.revoke_token(auth_store.token_from_request())
        log_major(
            user,
            "Logout",
            "Desktop client | User logged out: {}".format(uname),
            entity_type="session",
            entity_name="desktop-client",
            target_user=uname,
        )
        return jsonify({"success": True}), 200

    @bp.route("/reports", methods=["GET"])
    @auth_store.require_internal("reports-view")
    def desktop_reports(user):
        filter_type = (request.args.get("type") or "all").strip().lower() or "all"
        reports = data_service.list_reports(filter_type if filter_type in ("test", "validation") else "all")
        query_user = (request.args.get("user") or "").strip().lower()
        query_role = (request.args.get("role") or "").strip().lower()
        if query_user:
            reports = [r for r in reports if query_user in str(r.get("username") or r.get("operatorName") or r.get("employeeId") or "").lower()]
        if query_role:
            reports = [r for r in reports if query_role in str(r.get("role") or r.get("operatorRole") or "").lower()]
        return jsonify({"reports": reports}), 200

    @bp.route("/reports/<int:report_id>/pdf", methods=["GET"])
    @auth_store.require_internal("reports-view")
    def desktop_report_pdf(user, report_id):
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        if not kiosk._report_pdf_status_allowed(report):
            return jsonify({"error": "PDF is available only after the report is approved or marked aborted."}), 403
        path = kiosk._report_pdf_path(report_id)
        # Prefer cached PDF — regenerating every download stalls bulk ZIP/sync.
        if not (path.exists() and path.stat().st_size > 0):
            if not kiosk._generate_report_pdf_file(report_id, write_audit=True):
                return jsonify({"error": "PDF generation failed"}), 500
        purpose = str(request.args.get("purpose") or request.args.get("source") or "download").strip().lower()
        if purpose not in ("view", "download", "sync", "zip"):
            purpose = "download"
        uname = user.get("username") or user.get("name") or "--"
        role = user.get("role") or "--"
        log_major(
            user,
            "Reports exported",
            "Exported 1 report via desktop client ({}) | report-{}.pdf | exported by {} ({})".format(
                purpose, report_id, uname, role
            ),
            entity_type="report",
            entity_id=report_id,
            entity_name="report-{}".format(report_id),
            target_user=uname,
        )
        return send_file(path, mimetype="application/pdf", as_attachment=False, download_name="report-{}.pdf".format(report_id))

    @bp.route("/reports/download", methods=["POST"])
    @auth_store.require_internal("reports-view")
    def desktop_reports_download(user):
        payload = request.get_json(force=True, silent=True) or {}
        report_ids = payload.get("report_ids") or payload.get("reportIds")
        if report_ids:
            wanted = []
            for rid in report_ids:
                try:
                    wanted.append(int(rid))
                except (TypeError, ValueError):
                    pass
            reports = [data_service.get_report(rid) for rid in wanted]
            reports = [r for r in reports if r]
        else:
            filter_type = str(payload.get("type") or "all").strip().lower()
            reports = data_service.list_reports(filter_type if filter_type in ("test", "validation") else "all")
        if not reports:
            return jsonify({"error": "No reports found"}), 404
        tmp = pathlib.Path(tempfile.NamedTemporaryFile(delete=False, suffix=".zip").name)
        try:
            added = 0
            skipped = 0
            # STORED: PDFs are already compressed; regenerating every file made bulk ZIP hang.
            with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as zf:
                for report in reports:
                    rid = int(report.get("id"))
                    if not kiosk._report_pdf_status_allowed(report):
                        skipped += 1
                        continue
                    pdf = kiosk._report_pdf_path(rid)
                    if not (pdf.exists() and pdf.stat().st_size > 0):
                        kiosk._generate_report_pdf_file(rid, write_audit=False)
                    if pdf.exists() and pdf.stat().st_size > 0:
                        zf.write(pdf, "reports/report-{}.pdf".format(rid))
                        added += 1
                    else:
                        skipped += 1
            if added <= 0:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return jsonify({
                    "error": "No PDF files could be added to the ZIP. Reports must be approved or aborted before download.",
                    "skipped": skipped,
                }), 400
            uname = user.get("username") or user.get("name") or "--"
            role = user.get("role") or "--"
            log_major(
                user,
                "Reports exported",
                "Exported {} report{} via desktop client (ZIP) | exported by {} ({}){}".format(
                    added,
                    "" if added == 1 else "s",
                    uname,
                    role,
                    " | skipped {}".format(skipped) if skipped else "",
                ),
                entity_type="report",
                entity_name="reports-zip",
                target_user=uname,
            )
            return _send_temp(tmp, "reports-download.zip", "application/zip")
        except Exception:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    @bp.route("/audit", methods=["GET"])
    @auth_store.require_internal("audit-view")
    def desktop_audit(user):
        filters = _filter_range(dict(request.args))
        entries = kiosk._prepare_audit_entries_for_display(audit_service.list_entries(filters))
        return jsonify({"entries": entries}), 200

    @bp.route("/audit/download", methods=["POST"])
    @auth_store.require_internal("audit-view")
    def desktop_audit_download(user):
        payload = request.get_json(force=True, silent=True) or {}
        filters = _filter_range(payload.get("filters") or payload)
        entries = kiosk._prepare_audit_entries_for_display(audit_service.list_entries(filters))
        factory = data_service.get_factory_settings() or {}
        # Chunk large trails so Chromium can render stably, then merge into one PDF.
        chunk_size = 350
        html_chunks = []
        if not entries:
            html_chunks.append(_build_audit_html(kiosk, [], filters, factory, user))
        else:
            total = len(entries)
            for start in range(0, total, chunk_size):
                chunk = entries[start : start + chunk_size]
                html_chunks.append(_build_audit_html(kiosk, chunk, filters, factory, user))
        tmp = pathlib.Path(tempfile.NamedTemporaryFile(delete=False, suffix=".pdf").name)
        try:
            # Large exports can take several minutes on Pi hardware.
            per_chunk_timeout = 240.0 if len(html_chunks) > 1 else 180.0
            pdf_generator.render_html_chunks_to_pdf(
                html_chunks,
                tmp,
                timeout_sec=per_chunk_timeout,
            )
            uname = user.get("username") or user.get("name") or "--"
            role = user.get("role") or "--"
            log_major(
                user,
                "Audit trail exported",
                "Desktop client | entries {} | exported by {} ({})".format(len(entries), uname, role),
                entity_type="audit",
                entity_name="audit-download",
                target_user=uname,
            )
            return _send_temp(tmp, "audit-download.pdf", "application/pdf")
        except Exception:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    @bp.route("/network/ips", methods=["GET"])
    @auth_store.require_auth
    def desktop_network_ips(user):
        payload = _collect_ipv4_addresses()
        return jsonify({
            "ok": True,
            "addresses": payload.get("addresses") or [],
            "source": payload.get("source") or "",
        }), 200

    @bp.route("/factory-settings", methods=["GET"])
    @auth_store.require_any_internal(["recipe-list", "recipe-manage", "recipe-edit", "quick-test", "recipe-test"])
    def desktop_factory_settings(user):
        try:
            settings = getattr(kiosk, "report_service").enrich_factory_settings(data_service.get_factory_settings() or {})
        except Exception:
            settings = data_service.get_factory_settings() or {}
        return jsonify({"settings": settings}), 200

    register_members_routes(bp, kiosk)
    register_recipes_routes(bp, kiosk)

    return bp
