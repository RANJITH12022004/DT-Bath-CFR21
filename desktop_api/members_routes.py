"""Desktop API — member/profile management routes."""

from __future__ import annotations

from flask import jsonify, request

import data_service
import rbac_service

from desktop_api import auth_store
from desktop_api import rbac_compat
from desktop_api.desktop_helpers import (
    audit_event,
    audit_member_permissions_if_changed,
    can_assign_feature_overrides,
    display_role_label,
    password_strength_error,
    payload_has_protected_feature_overrides,
    prepare_desktop_created_member,
    self_profile_payload_from_request,
)


def register_members_routes(bp, kiosk):

    @bp.route("/members", methods=["GET"])
    @auth_store.require_internal("user-manage")
    def desktop_members_list(user):
        try:
            members = data_service.list_members()
            safe = [data_service.sanitize_member_for_client(m) or m for m in members]
            return jsonify({"members": safe}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/members", methods=["POST"])
    @auth_store.require_internal("user-add")
    def desktop_members_create(user):
        try:
            member_data = request.get_json(force=True, silent=True) or {}
            if payload_has_protected_feature_overrides(member_data):
                return jsonify({"error": "Protected features cannot be overridden."}), 400
            if data_service.has_non_empty_feature_overrides(member_data) and not can_assign_feature_overrides(user):
                return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
            pwd = str(member_data.get("password") or "").strip()
            if not pwd:
                return jsonify({"error": "Password is required when adding a user."}), 400
            pwd_err = password_strength_error(pwd)
            if pwd_err:
                return jsonify({"error": pwd_err}), 400
            member_data["password"] = pwd
            member_id = data_service.save_member(member_data)
            prepare_desktop_created_member(member_id, pwd)
            created = data_service.get_member(member_id) or dict(member_data)
            sig = auth_store.desktop_signature(user)
            uname = created.get("username") or created.get("name") or ""
            urole = created.get("role") or ""
            audit_event(
                kiosk,
                user,
                action="Added new user",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Added new user: {} ({})".format(
                    uname, display_role_label(urole) if urole else "—"
                ),
                target_user=uname,
                after=data_service.sanitize_member_for_client(created) or created,
                signature=sig,
            )
            audit_member_permissions_if_changed(kiosk, user, None, created, member_id=member_id)
            safe = data_service.sanitize_member_for_client(created) or dict(created)
            return jsonify({"id": member_id, "member": safe}), 201
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/members/<int:member_id>", methods=["GET"])
    @auth_store.require_auth
    def desktop_members_get(user, member_id):
        try:
            if not auth_store.is_self_member(user, member_id) and not rbac_service.member_has_internal(
                user or {}, "user-manage"
            ):
                return jsonify({"error": "Forbidden. You do not have permission to manage users."}), 403
            member = data_service.get_member(member_id)
            if member:
                return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
            return jsonify({"error": "Member not found"}), 404
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    # Fix decorator - can't use string format in decorator factory easily; register routes manually below

    @bp.route("/members/<int:member_id>", methods=["PUT"])
    @auth_store.require_auth
    def desktop_members_update(user, member_id):
        try:
            if not auth_store.is_self_member(user, member_id) and not rbac_service.member_has_internal(
                user or {}, "user-manage"
            ):
                return jsonify({"error": "Forbidden. You do not have permission to manage users."}), 403
            member_data = request.get_json(force=True, silent=True) or {}
            before_member = data_service.get_member(member_id)
            if not before_member:
                return jsonify({"error": "Member not found"}), 404
            is_self = auth_store.is_self_member(user, member_id)
            if is_self:
                try:
                    member_data = self_profile_payload_from_request(before_member, member_data)
                except ValueError as e:
                    return jsonify({"error": str(e)}), 400
            elif payload_has_protected_feature_overrides(member_data):
                return jsonify({"error": "Protected features cannot be overridden."}), 400
            if (
                not is_self
                and data_service.has_non_empty_feature_overrides(member_data)
                and not can_assign_feature_overrides(user)
            ):
                return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
            member_data["id"] = member_id
            acting_id = user.get("id")
            password_changed = "password" in member_data and member_data.get("password") not in (None, "")
            data_service.save_member(member_data, acting_user_id=acting_id)
            updated = data_service.get_member(member_id) or dict(member_data)
            sig = auth_store.desktop_signature(user)
            uname = updated.get("username") or updated.get("name") or ""
            if password_changed:
                audit_event(
                    kiosk,
                    user,
                    action="Password changed",
                    outcome="success",
                    entity_type="member",
                    entity_id=member_id,
                    entity_name=uname,
                    details="Password changed for user: {}".format(uname),
                    target_user=uname,
                    signature=sig,
                )
            audit_member_permissions_if_changed(
                kiosk, user, before_member, updated, member_id=member_id
            )
            audit_event(
                kiosk,
                user,
                action="User update",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Member updated",
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
            return jsonify({"error": str(e)}), 500

    @bp.route("/members/<int:member_id>", methods=["DELETE"])
    @auth_store.require_internal("user-delete")
    def desktop_members_delete(user, member_id):
        try:
            member = data_service.get_member(member_id)
            if not member:
                return jsonify({"error": "Member not found"}), 404
            verified, verify_err = auth_store.consume_approval_verify_token("user_admin")
            if not verified:
                audit_event(
                    kiosk,
                    user,
                    action="User disable",
                    outcome="denied",
                    entity_type="member",
                    entity_id=member_id,
                    entity_name=member.get("username") or member.get("name") or "",
                    details=verify_err or "Approval verification required",
                    target_user=member.get("username") or "",
                    before=member,
                )
                return jsonify({"error": verify_err}), 403
            before_member = dict(member)
            template_id = member.get("fingerprintTemplateId")
            if template_id is not None:
                try:
                    import biometric_service

                    deleted = biometric_service.delete_template(template_id)
                    if not deleted.get("ok"):
                        audit_event(
                            kiosk,
                            user,
                            action="User disable",
                            outcome="failed",
                            entity_type="member",
                            entity_id=member_id,
                            entity_name=member.get("username") or member.get("name") or "",
                            details=deleted.get("error")
                            or "Failed to delete fingerprint template from sensor",
                            target_user=member.get("username") or "",
                            before=before_member,
                            signature={
                                "mode": "password_reconfirm",
                                "username": verified.get("username"),
                                "role": verified.get("role"),
                            },
                            extra={"templateId": template_id},
                        )
                        return jsonify(
                            {
                                "error": deleted.get("error")
                                or "Failed to delete fingerprint template from sensor",
                                "templateId": int(template_id),
                            }
                        ), 400
                    data_service.clear_member_biometric(member_id)
                except ImportError:
                    pass
            member = data_service.disable_member(member_id)
            audit_event(
                kiosk,
                user,
                action="User disable",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=member.get("username") or member.get("name") or "",
                details="Member disabled",
                target_user=member.get("username") or "",
                before=before_member,
                after=member,
                signature={
                    "mode": "password_reconfirm",
                    "username": verified.get("username"),
                    "role": verified.get("role"),
                },
                extra={"templateIdFreed": template_id},
            )
            return jsonify({"success": True, "member": member}), 200
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/members/<int:member_id>/unlock", methods=["POST"])
    @auth_store.require_internal("user-unlock")
    def desktop_members_unlock(user, member_id):
        try:
            before_member = data_service.get_member(member_id)
            sig = auth_store.desktop_signature(user)
            member = data_service.unlock_member(member_id)
            audit_event(
                kiosk,
                user,
                action="User unlock",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=member.get("username") or member.get("name") or "",
                details="Member unlocked",
                target_user=member.get("username") or "",
                before=data_service.sanitize_member_for_client(before_member) if before_member else None,
                after=data_service.sanitize_member_for_client(member) or member,
                signature=sig,
            )
            safe = data_service.sanitize_member_for_client(member) or dict(member)
            return jsonify({"success": True, "member": safe}), 200
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/members/<int:member_id>/enable", methods=["POST"])
    @auth_store.require_internal("user-enable")
    def desktop_members_enable(user, member_id):
        try:
            before_member = data_service.get_member(member_id)
            sig = auth_store.desktop_signature(user)
            member = data_service.enable_member(member_id)
            audit_event(
                kiosk,
                user,
                action="User enable",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=member.get("username") or member.get("name") or "",
                details="Member enabled",
                target_user=member.get("username") or "",
                before=data_service.sanitize_member_for_client(before_member) if before_member else None,
                after=data_service.sanitize_member_for_client(member) or member,
                signature=sig,
            )
            safe = data_service.sanitize_member_for_client(member) or dict(member)
            return jsonify({"success": True, "member": safe}), 200
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/profile", methods=["GET"])
    @auth_store.require_auth
    def desktop_profile_get(user):
        try:
            username = str(user.get("username") or "").strip()
            if username.upper() == data_service.FACTORY_USERNAME.upper():
                return jsonify({"member": data_service.sanitize_member_for_client(user) or user}), 200
            member = None
            try:
                mid = int(user.get("id"))
                member = data_service.get_member(mid)
            except (TypeError, ValueError):
                pass
            if not member and username:
                member = data_service.get_member_by_username(username)
            if member:
                return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
            return jsonify({"member": data_service.sanitize_member_for_client(user) or user}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/profile", methods=["PUT"])
    @auth_store.require_auth
    def desktop_profile_update(user):
        try:
            username = str(user.get("username") or "").strip()
            if username.upper() == data_service.FACTORY_USERNAME.upper():
                return jsonify({"error": "Factory profile is managed locally on this device."}), 400
            member = None
            try:
                mid = int(user.get("id"))
                member = data_service.get_member(mid)
            except (TypeError, ValueError):
                pass
            if not member and username:
                member = data_service.get_member_by_username(username)
            if not member:
                return jsonify({"error": "Member not found"}), 404
            member_id = int(member.get("id"))
            before_member = dict(member)
            payload = request.get_json(force=True, silent=True) or {}
            try:
                member_data = self_profile_payload_from_request(before_member, payload)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            name_in = "name" in payload and str(payload.get("name") or "").strip()
            pwd_in = "password" in payload and str(payload.get("password") or "").strip()
            if not name_in and not pwd_in:
                return jsonify({"error": "Provide a name and/or new password to save."}), 400
            password_changed = pwd_in
            data_service.save_member(member_data, acting_user_id=user.get("id"))
            updated = data_service.get_member(member_id) or member_data
            sig = {"mode": "self", **auth_store.desktop_signature(user)}
            uname = updated.get("username") or updated.get("name") or ""
            if password_changed:
                audit_event(
                    kiosk,
                    user,
                    action="Password changed",
                    outcome="success",
                    entity_type="member",
                    entity_id=member_id,
                    entity_name=uname,
                    details="Password changed (self) for user: {}".format(uname),
                    target_user=uname,
                    signature=sig,
                )
            audit_event(
                kiosk,
                user,
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
            return jsonify({"error": str(e)}), 500

    @bp.route("/approval-verify", methods=["POST"])
    @auth_store.require_auth
    def desktop_approval_verify(user):
        try:
            payload = request.get_json(force=True, silent=True) or {}
            method = str(payload.get("method") or "credentials").strip().lower()
            purpose = str(payload.get("purpose") or "recipe").strip().lower()
            if purpose not in ("recipe", "report", "user_admin", "export"):
                return jsonify({"ok": False, "error": "purpose must be recipe, report, user_admin, or export"}), 400
            verifier = None
            username = (payload.get("username") or "").strip()

            if method == "credentials":
                password = str(payload.get("password") or "").strip()
                if not username or not password:
                    return jsonify({"ok": False, "error": "Username and password are required"}), 400
                verifier = data_service.authenticate_user(username, password)
                if not verifier:
                    audit_event(
                        kiosk,
                        user,
                        action="Approval verification",
                        outcome="failed",
                        entity_type="verification",
                        entity_name=purpose,
                        details="Invalid credentials",
                        target_user=username,
                        extra={"purpose": purpose, "attemptedUser": username, "method": "credentials"},
                    )
                    return jsonify({"ok": False, "error": "Invalid verifier username or password"}), 401
            else:
                return jsonify({"ok": False, "error": "Unsupported verification method"}), 400

            verifier_role = str(verifier.get("role") or "").strip().lower()
            eligible_fn = getattr(kiosk, "_approval_verifier_eligible_for_recipe", None)
            if purpose == "recipe":
                if eligible_fn:
                    eligible = eligible_fn(verifier)
                else:
                    eligible = auth_store._verifier_payload_has_internal(verifier, "recipe-approve")
            elif purpose == "report":
                fn = getattr(kiosk, "_approval_verifier_eligible_for_report", None)
                eligible = fn(verifier) if fn else auth_store._verifier_payload_has_internal(
                    verifier, "test-report-approve"
                )
            elif purpose == "export":
                eligible = auth_store._verifier_payload_has_internal(verifier, "export-approve")
            else:
                fn = getattr(kiosk, "_approval_verifier_eligible_for_user_admin", None)
                eligible = fn(verifier) if fn else auth_store._verifier_payload_has_internal(
                    verifier, "user-manage"
                )

            if not eligible:
                audit_event(
                    kiosk,
                    user,
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier lacks required permission",
                    target_user=verifier.get("username") or username,
                    extra={"purpose": purpose, "verifierRole": verifier_role, "method": method},
                )
                return jsonify(
                    {"ok": False, "error": "Verifier does not have permission for this approval"}
                ), 403

            if verifier_role != "factory":
                member = data_service.get_member_by_username(verifier.get("username") or username)
                if member:
                    status = str(member.get("status") or "active").strip().lower()
                    if status != "active":
                        audit_event(
                            kiosk,
                            user,
                            action="Approval verification",
                            outcome="denied",
                            entity_type="verification",
                            entity_name=purpose,
                            details="Verifier account not active",
                            target_user=verifier.get("username") or username,
                            extra={"purpose": purpose, "method": method},
                        )
                        return jsonify({"ok": False, "error": "Verifier account is not active"}), 403

            token, token_payload = auth_store.issue_approval_verify_token(verifier, purpose)
            vname = verifier.get("username") or username
            audit_event(
                kiosk,
                user,
                action="Approval verification",
                outcome="success",
                entity_type="verification",
                entity_name=purpose,
                details="Verification token issued",
                target_user=vname,
                signature={"mode": method, "username": vname, "role": verifier_role},
                extra={"purpose": purpose, "method": method},
            )
            return jsonify(
                {
                    "ok": True,
                    "token": token,
                    "expiresInSec": auth_store.APPROVAL_VERIFY_TTL_SECONDS,
                    "verifier": {
                        "username": token_payload.get("username"),
                        "name": token_payload.get("name"),
                        "role": token_payload.get("role"),
                    },
                }
            ), 200
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @bp.route("/permission-cards", methods=["GET"])
    @auth_store.require_auth
    def desktop_permission_cards(user):
        cards = []
        for key in rbac_service.PERMISSION_CARD_KEYS:
            cards.append(
                {
                    "key": key,
                    "label": rbac_compat.permission_card_labels().get(key, key),
                    "internalKeys": list(rbac_service.PERM_CARD_EXPAND.get(key, [])),
                }
            )
        return jsonify({"cards": cards}), 200
