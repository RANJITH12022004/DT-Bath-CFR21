"""Desktop API — recipe CRUD routes (Bearer auth, no kiosk session)."""

from __future__ import annotations

from flask import jsonify, request

import calculation_service
import data_service
import rbac_service

from desktop_api import auth_store
from desktop_api import recipes_compat
from desktop_api.desktop_helpers import display_role_label, legacy_audit


def _norm_username(val):
    return str(val or "").strip().lower()


def _utc_now_iso(kiosk):
    fn = getattr(kiosk, "_utc_now_iso", None)
    if fn:
        return fn()
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _apply_recipe_approval_for_desktop_creator(user, processed, kiosk):
    role = str((user or {}).get("role") or "").strip().lower()
    if role != "factory":
        processed["recipeApprovalStatus"] = "pending"
        for k in (
            "recipeApprovedAt",
            "recipeApprovedBy",
            "recipeApprovalRemarks",
            "recipeApprovedByUsername",
        ):
            processed.pop(k, None)
        return
    display_name = (
        (user.get("name") or "").strip()
        or (user.get("username") or "").strip()
        or "Factory"
    )
    username_key = _norm_username(user.get("username") or display_name)
    by_line = "{} ({})".format(display_name, display_role_label("factory"))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso(kiosk)
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = username_key
    processed["recipeApprovalRemarks"] = ""


def _apply_recipe_approval_verify_token(processed, remarks, kiosk):
    if (request.headers.get("X-Approval-Verify-Token") or "").strip() == "":
        return None, False
    if processed.get("recipeApprovalStatus") != "pending":
        return None, False
    verified, verify_err = auth_store.consume_approval_verify_token("recipe")
    if verify_err:
        return verify_err, False
    verified_name = (verified.get("name") or verified.get("username") or "—").strip()
    verified_role = (verified.get("role") or "").strip()
    verified_username = _norm_username(verified.get("username"))
    by_line = verified_name
    if verified_role:
        by_line = "{} ({})".format(verified_name, display_role_label(verified_role))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso(kiosk)
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = verified_username
    processed["recipeApprovalRemarks"] = (remarks or "").strip()
    return None, True


def register_recipes_routes(bp, kiosk):
    recipe_label = getattr(kiosk, "_recipe_label", lambda r: (r or {}).get("productName") or "")
    audit_created = getattr(kiosk, "_audit_recipe_created", None)
    audit_edited = getattr(kiosk, "_audit_recipe_edited", None)

    @bp.route("/recipes", methods=["GET"])
    @auth_store.require_any_internal(["recipe-list", "quick-test", "recipe-test", "recipe-edit", "recipe-manage"])
    def desktop_recipes_list(user):
        try:
            status = str(request.args.get("status") or "active").strip().lower()
            if status not in ("active", "disabled", "all"):
                status = "active"
            recipes = recipes_compat.list_recipes(status=status)
            return jsonify({"recipes": recipes}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/recipes", methods=["POST"])
    @auth_store.require_internal("recipe-manage")
    def desktop_recipes_create(user):
        try:
            recipe_data = request.get_json(force=True, silent=True) or {}
            validation_result = calculation_service.validate_recipe(recipe_data)
            if not validation_result.get("valid", False):
                return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
            processed = calculation_service.process_recipe_form_data(recipe_data)
            _apply_recipe_approval_for_desktop_creator(user, processed, kiosk)
            remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
            tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks, kiosk)
            if tok_err:
                return jsonify({"error": tok_err}), 401
            recipe_id = data_service.save_recipe(processed)
            if audit_created:
                audit_created(processed, recipe_id)
            rlabel = recipe_label(processed) or "id {}".format(recipe_id)
            rd = "Recipe created — {} (id {})".format(rlabel, recipe_id)
            if processed.get("recipeApprovalStatus") == "approved":
                if via_token:
                    v_user = processed.get("recipeApprovedByUsername") or "--"
                    v_role = (user.get("role") or "").strip() or "--"
                    legacy_audit(kiosk, {"username": v_user, "role": v_role}, "Recipe approved", rd)
                elif str(user.get("role") or "").strip().lower() == "factory":
                    legacy_audit(kiosk, user, "Recipe approved", rd)
            return jsonify({"id": recipe_id, "recipe": processed}), 201
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/recipes/<int:recipe_id>", methods=["GET"])
    @auth_store.require_any_internal(["recipe-list", "quick-test", "recipe-test", "recipe-edit", "recipe-manage"])
    def desktop_recipes_get(user, recipe_id):
        try:
            include_disabled = str(request.args.get("includeDisabled") or "").strip().lower() in ("1", "true", "yes")
            recipe = recipes_compat.get_recipe(recipe_id, include_disabled=include_disabled)
            if recipe:
                return jsonify({"recipe": recipe}), 200
            return jsonify({"error": "Recipe not found"}), 404
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/recipes/<int:recipe_id>", methods=["PUT"])
    @auth_store.require_internal("recipe-manage")
    def desktop_recipes_update(user, recipe_id):
        try:
            recipe_data = request.get_json(force=True, silent=True) or {}
            recipe_data["id"] = recipe_id
            before_recipe = recipes_compat.get_recipe(recipe_id)
            if not before_recipe:
                return jsonify({"error": "Recipe not found"}), 404
            validation_result = calculation_service.validate_recipe(recipe_data)
            if not validation_result.get("valid", False):
                return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
            processed = calculation_service.process_recipe_form_data(recipe_data)
            _apply_recipe_approval_for_desktop_creator(user, processed, kiosk)
            remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
            tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks, kiosk)
            if tok_err:
                return jsonify({"error": tok_err}), 401
            data_service.save_recipe(processed)
            if audit_edited:
                audit_edited(before_recipe, processed, recipe_id)
            rlabel = recipe_label(processed) or "id {}".format(recipe_id)
            rd = "Recipe edited — {} (id {})".format(rlabel, recipe_id)
            if processed.get("recipeApprovalStatus") == "approved":
                if via_token:
                    v_user = processed.get("recipeApprovedByUsername") or "--"
                    v_role = (user.get("role") or "").strip() or "--"
                    legacy_audit(kiosk, {"username": v_user, "role": v_role}, "Recipe approved", rd)
                elif str(user.get("role") or "").strip().lower() == "factory":
                    legacy_audit(kiosk, user, "Recipe approved", rd)
            return jsonify({"id": recipe_id, "recipe": processed}), 200
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/recipes/<int:recipe_id>", methods=["DELETE"])
    @auth_store.require_any_internal(["recipe-delete", "disable-recipes", "recipe-manage"])
    def desktop_recipes_delete(user, recipe_id):
        try:
            existing = recipes_compat.get_recipe(recipe_id, include_disabled=True)
            updated = recipes_compat.disable_recipe(
                recipe_id,
                disabled_by=(user.get("name") or user.get("username") or "--"),
                disabled_by_username=(user.get("username") or "--"),
            )
            if updated:
                rlabel = ""
                if existing:
                    rlabel = existing.get("productName") or existing.get("name") or ""
                details = "Recipe id {}".format(recipe_id)
                if rlabel:
                    details = "{}: {}".format(details, rlabel)
                legacy_audit(kiosk, user, "Disable Recipe", details)
                return jsonify({"success": True, "recipe": updated}), 200
            return jsonify({"error": "Recipe not found"}), 404
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/recipes/<int:recipe_id>/enable", methods=["POST"])
    @auth_store.require_any_internal(["recipe-delete", "disable-recipes", "recipe-manage"])
    def desktop_recipes_enable(user, recipe_id):
        try:
            updated = recipes_compat.enable_recipe(recipe_id)
            if updated:
                rlabel = updated.get("productName") or updated.get("name") or ""
                details = "Recipe id {}".format(recipe_id)
                if rlabel:
                    details = "{}: {}".format(details, rlabel)
                legacy_audit(kiosk, user, "Enable Recipe", details)
                return jsonify({"success": True, "recipe": updated}), 200
            return jsonify({"error": "Recipe not found"}), 404
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/recipes/<int:recipe_id>/approve", methods=["POST"])
    @auth_store.require_auth
    def desktop_recipes_approve(user, recipe_id):
        try:
            verified, verify_err = auth_store.consume_approval_verify_token("recipe")
            if verify_err:
                return jsonify({"ok": False, "error": verify_err}), 401
            body = request.get_json(force=True, silent=True) or {}
            remarks = (body.get("remarks") or "").strip()
            approver_name = (body.get("approverName") or "").strip()
            recipe = recipes_compat.get_recipe(recipe_id)
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
            verified_role = (verified.get("role") or "").strip()
            by_line = verified_name
            if verified_role:
                by_line = "{} ({})".format(verified_name, display_role_label(verified_role))
            recipe["recipeApprovalStatus"] = "approved"
            recipe["recipeApprovedAt"] = _utc_now_iso(kiosk)
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
            legacy_audit(
                kiosk,
                {"username": v_audit_user, "role": v_audit_role},
                "Recipe approved",
                rdetail,
            )
            return jsonify({"ok": True, "recipe": recipe}), 200
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @bp.route("/recipes/validate", methods=["POST"])
    @auth_store.require_any_internal(["recipe-manage", "recipe-edit", "recipe-list"])
    def desktop_recipes_validate(user):
        try:
            recipe_data = request.get_json(force=True, silent=True) or {}
            validation_result = calculation_service.validate_recipe(recipe_data)
            return jsonify(validation_result), 200
        except Exception as e:
            return jsonify({"valid": False, "error": str(e)}), 500

    @bp.route("/embed/issue", methods=["POST"])
    @auth_store.require_any_internal(["recipe-list", "recipe-manage", "recipe-edit"])
    def desktop_embed_issue(user):
        token, _ = auth_store.current_user()
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
        ticket = auth_store.issue_embed_ticket(user, token)
        base = request.url_root.rstrip("/")
        url = "{}/desktop/embed/recipes?ticket={}".format(base, ticket)
        return jsonify({"ok": True, "ticket": ticket, "url": url}), 200
