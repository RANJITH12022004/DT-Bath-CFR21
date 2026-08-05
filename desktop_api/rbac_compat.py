"""RBAC helpers that work across Tap Density, Friability, and future products."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import rbac_service

_DEFAULT_CARD_LABELS = {
    "perm_test_access": "Test access",
    "perm_test_report_approve": "Test report approval",
    "perm_recipe_manage": "Recipe management",
    "perm_recipe_approve": "Recipe approval",
    "perm_profile_admin": "Profile administration",
    "perm_validation_test": "Validation test",
    "perm_validation_report_approve": "Validation report approval",
    "perm_datetime": "Date & time",
    "perm_reports_view": "View reports",
    "perm_audit_view": "View audit",
    "perm_export_usb": "USB export",
    "perm_export_approve": "Export approval",
}


def permission_card_labels() -> Dict[str, str]:
    labels = getattr(rbac_service, "PERMISSION_CARD_LABELS", None)
    if isinstance(labels, dict) and labels:
        return labels
    return dict(_DEFAULT_CARD_LABELS)


def permission_allow_cards(member: Optional[Dict[str, Any]]) -> List[str]:
    fn = getattr(rbac_service, "permission_allow_cards", None)
    if callable(fn):
        return list(fn(member) or [])

    # Friability / older rbac: derive cards from expanded internals + PERM_CARD_EXPAND.
    expand = getattr(rbac_service, "PERM_CARD_EXPAND", {}) or {}
    try:
        internals = set(rbac_service.member_expanded_internal_keys(member or {}) or [])
    except Exception:
        internals = set()
    cards: List[str] = []
    for card, keys in expand.items():
        key_list = list(keys or [])
        if key_list and all(k in internals for k in key_list):
            cards.append(card)
    # Also honor explicit card keys stored in featureOverrides.allow
    raw = (member or {}).get("featureOverrides") or {}
    allow = raw.get("allow") if isinstance(raw, dict) else []
    if isinstance(allow, list):
        for item in allow:
            key = str(item or "").strip()
            if key.startswith("perm_") and key not in cards:
                cards.append(key)
    return sorted(set(cards))


def build_permission_change_audit(
    before_member: Optional[Dict[str, Any]] = None,
    after_member: Optional[Dict[str, Any]] = None,
    **kwargs,
):
    fn = getattr(rbac_service, "build_permission_change_audit", None)
    if callable(fn):
        return fn(before_member, after_member, **kwargs)
    before_cards = permission_allow_cards(before_member)
    after_cards = permission_allow_cards(after_member)
    return {
        "beforeCards": before_cards,
        "afterCards": after_cards,
        "added": sorted(set(after_cards) - set(before_cards)),
        "removed": sorted(set(before_cards) - set(after_cards)),
    }
