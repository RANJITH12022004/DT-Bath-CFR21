"""
Server-side permission expansion (mirrors rbac.js card model).
Used by data_service normalization and app.py route guards.
"""

from __future__ import annotations

from typing import Any, Dict, List, Set

PERMISSIONS_VERSION = 2

PERMISSION_CARD_KEYS = [
    "perm_test_access",
    "perm_test_report_approve",
    "perm_recipe_manage",
    "perm_recipe_approve",
    "perm_profile_admin",
    "perm_validation_test",
    "perm_validation_report_approve",
    "perm_datetime",
    "perm_reports_view",
    "perm_audit_view",
    "perm_export_usb",
    "perm_export_approve",
]

PERM_CARD_EXPAND: Dict[str, List[str]] = {
    "perm_test_access": ["quick-test", "recipe-test"],
    "perm_test_report_approve": ["test-report-approve"],
    "perm_recipe_manage": [
        "recipe-manage",
        "recipe-list",
        "recipe-edit",
        "recipe-delete",
        "disable-recipes",
        "recipe-enable",
        "settings",
    ],
    "perm_recipe_approve": ["recipe-approve"],
    "perm_profile_admin": [
        "user-manage",
        "user-add",
        "user-delete",
        "user-unlock",
        "user-enable",
        "user-change-role",
        "settings",
    ],
    "perm_validation_test": ["validation-test", "validate-menu", "settings"],
    "perm_validation_report_approve": ["validation-report-approve"],
    "perm_datetime": ["edit-datetime", "settings"],
    "perm_reports_view": ["reports-view"],
    "perm_audit_view": ["audit-view"],
    "perm_export_usb": ["export-usb"],
    "perm_export_approve": ["export-approve"],
}

LEGACY_INTERNAL_KEYS = [
    "quick-test",
    "recipe-list",
    "recipe-manage",
    "recipe-edit",
    "recipe-delete",
    "reports-view",
    "reports-delete",
    "validate-menu",
    "settings",
    "edit-datetime",
    "profile",
    "user-manage",
    "user-add",
    "user-delete",
    "user-unlock",
    "user-enable",
    "user-change-role",
    "disable-recipes",
    "recipe-enable",
]

INTERNAL_PERMISSION_IMPLICATIONS: Dict[str, Set[str]] = {
    "recipe-manage": {"recipe-list", "recipe-edit", "recipe-delete", "disable-recipes", "recipe-enable"},
}

FEATURE_CATALOG_KEYS = sorted(set(PERMISSION_CARD_KEYS + LEGACY_INTERNAL_KEYS))

# --- Legacy role table (same semantics as rbac.js ROLE_RESTRICTIONS) ---

ROLE_RESTRICTIONS: Dict[str, Dict[str, str]] = {
    "admin": {
        "factory-settings": "no-access",
        "factory-reset": "no-access",
    },
    "supervisor": {
        "user-manage": "view-only",
        "user-add": "no-access",
        "user-delete": "no-access",
        "user-unlock": "no-access",
        "user-enable": "no-access",
        "user-change-role": "no-access",
        "factory-settings": "view-only",
        "factory-reset": "no-access",
        "edit-datetime": "no-access",
        "reports-delete": "no-access",
        "recipe-delete": "no-access",
    },
    "user": {
        "user-manage": "no-access",
        "user-add": "no-access",
        "user-delete": "no-access",
        "user-unlock": "no-access",
        "user-enable": "no-access",
        "user-change-role": "no-access",
        "factory-settings": "no-access",
        "factory-reset": "no-access",
        "edit-datetime": "no-access",
        "recipe-edit": "no-access",
        "recipe-delete": "no-access",
        "reports-delete": "no-access",
        "validate-menu": "no-access",
        "validation-test": "no-access",
    },
    "factory": {},
    "qa": {},
}

MASTER_INTERNAL_MIGRATION = [
    "quick-test",
    "recipe-list",
    "recipe-manage",
    "recipe-edit",
    "recipe-delete",
    "recipe-test",
    "reports-view",
    "reports-delete",
    "validate-menu",
    "validation-test",
    "calibration-menu",
    "settings",
    "edit-datetime",
    "profile",
    "user-manage",
    "user-add",
    "user-delete",
    "user-unlock",
    "user-enable",
    "user-change-role",
    "disable-recipes",
    "test-report-approve",
    "recipe-approve",
    "validation-report-approve",
    "audit-view",
    "export-usb",
    "export-approve",
]


def _legacy_key_allowed(role: str, feature_key: str) -> bool:
    r = str(role or "").strip().lower()
    rules = ROLE_RESTRICTIONS.get(r) or {}
    return rules.get(feature_key) != "no-access"


def expand_allow_list(allow: List[str]) -> Set[str]:
    out: Set[str] = set()
    for raw in allow or []:
        k = str(raw or "").strip()
        if not k:
            continue
        if k in PERM_CARD_EXPAND:
            out.update(PERM_CARD_EXPAND[k])
        elif k in LEGACY_INTERNAL_KEYS or k in (
            "recipe-test",
            "validation-test",
            "calibration-menu",
            "test-report-approve",
            "recipe-approve",
            "validation-report-approve",
            "audit-view",
            "export-usb",
            "export-approve",
        ):
            out.add(k)
        for implied in INTERNAL_PERMISSION_IMPLICATIONS.get(k, set()):
            out.add(implied)
    return out


def member_expanded_internal_keys(member: Dict[str, Any]) -> Set[str]:
    role = str((member or {}).get("role") or "").strip().lower()
    un = str((member or {}).get("username") or "").strip().upper()
    if role == "factory" or un == "RLERLT":
        return set(MASTER_INTERNAL_MIGRATION)  # factory bypass handled per-route for factory-settings
    raw = (member or {}).get("featureOverrides") or {}
    allow_in = raw.get("allow") if isinstance(raw.get("allow"), list) else []
    return expand_allow_list([str(x or "").strip() for x in allow_in])


def member_has_internal(member: Dict[str, Any], internal_key: str) -> bool:
    if not internal_key:
        return False
    role = str((member or {}).get("role") or "").strip().lower()
    un = str((member or {}).get("username") or "").strip().upper()
    if role == "factory" or un == "RLERLT":
        return True
    if internal_key in ("dashboard", "login", "profile", "ip-configure", "settings"):
        return True
    internal = member_expanded_internal_keys(member)
    if internal_key in internal:
        return True
    return any(internal_key in INTERNAL_PERMISSION_IMPLICATIONS.get(k, set()) for k in internal)


def _internal_to_perm_cards_strict(internal: Set[str]) -> List[str]:
    """Grant a permission card only if every expanded internal key is present."""
    cards: List[str] = []
    for card, keys in PERM_CARD_EXPAND.items():
        if keys and all(k in internal for k in keys):
            cards.append(card)
    return sorted(cards)


def migrate_member_permissions_v1_to_v2(member: Dict[str, Any]) -> None:
    """If permissionsVersion < 2, derive card allow-list from legacy role+overrides."""
    try:
        ver = int(member.get("permissionsVersion") or 0)
    except (TypeError, ValueError):
        ver = 0
    if ver >= PERMISSIONS_VERSION:
        return
    role = str(member.get("role") or "User").strip()
    role_l = role.lower()
    raw = member.get("featureOverrides")
    if not isinstance(raw, dict):
        raw = {}
    allow_old = [str(x).strip() for x in (raw.get("allow") or []) if str(x or "").strip()]
    deny_old = {str(x).strip() for x in (raw.get("deny") or []) if str(x or "").strip()}
    internal: Set[str] = set()
    for k in allow_old:
        if k == "validate-menu":
            internal.add("validation-test")
            internal.add("calibration-menu")
            continue
        if k in PERM_CARD_EXPAND:
            internal.update(PERM_CARD_EXPAND[k])
        elif k in MASTER_INTERNAL_MIGRATION:
            internal.add(k)
    internal -= deny_old
    if role_l == "factory":
        new_allow = list(PERMISSION_CARD_KEYS)
    else:
        new_allow = _internal_to_perm_cards_strict(internal)
    member["featureOverrides"] = {"allow": sorted(set(new_allow)), "deny": []}
    member["permissionsVersion"] = PERMISSIONS_VERSION
