#!/usr/bin/env python3
"""
calculation_service.py - Friability Tester recipe validation and form processing.
"""

from datetime import datetime
from typing import Dict, Any


def init():
    pass


def validate_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate friability recipe.
    Required: productName, drumCount (1|2), speed (RPM).
    Batch number is collected when loading a recipe for a test run.
    USP mode: 25 RPM, 4 min, 100 rotations.
    Custom mode: COUNT -> tabletCount; TIME -> timeMinutes.
    Returns { "valid": bool, "error": str }.
    """
    errors = []
    name = (recipe_data.get("productName") or recipe_data.get("name") or "").strip()
    if not name:
        errors.append("Product name is required")

    try:
        drum_count = int(recipe_data.get("drumCount", 2))
        if drum_count not in (1, 2):
            errors.append("Drum count must be 1 or 2")
    except (TypeError, ValueError):
        errors.append("Invalid drum count")

    mode = str(recipe_data.get("uspMode") or recipe_data.get("usp") or "").strip().upper()
    if "CUSTOM" in mode:
        mode = "CUSTOM"
    else:
        mode = "USP"

    speed = recipe_data.get("speed")
    if mode == "USP":
        speed = 25
    else:
        try:
            speed = int(speed)
            if speed < 20 or speed > 70:
                errors.append("Speed must be between 20 and 70 RPM")
        except (TypeError, ValueError):
            errors.append("Speed (RPM) is required for custom mode")

    completion = str(recipe_data.get("customCompletionMode") or "COUNT").strip().upper()
    if mode == "USP":
        completion = "COUNT"
    if completion == "TIME":
        ts = recipe_data.get("timeSeconds") or recipe_data.get("targetSeconds")
        tm = recipe_data.get("timeMinutes")
        if ts is None and tm is None:
            errors.append("Time (MM:SS) is required when completion mode is Time")
        else:
            try:
                seconds = int(float(ts)) if ts is not None else int(round(float(tm) * 60))
                if seconds < 1:
                    errors.append("Time (MM:SS) must be at least 00:01")
            except (TypeError, ValueError):
                errors.append("Invalid time (MM:SS)")
    else:
        count = recipe_data.get("tabletCount")
        if count is None and recipe_data.get("customTotalTaps") is not None:
            count = recipe_data.get("customTotalTaps")
        if mode == "USP":
            count = 100
        elif count is None:
            errors.append("Rotation count is required when completion mode is Count")
        else:
            try:
                n = int(count)
                if n < 1 or n > 10000:
                    errors.append("Rotation count must be between 1 and 10000")
            except (TypeError, ValueError):
                errors.append("Invalid rotation count")

    if errors:
        return {"valid": False, "error": "; ".join(errors)}
    return {"valid": True}


def process_recipe_form_data(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize recipe form data for storage."""
    recipe = dict(form_data)
    if "createdAt" not in recipe:
        recipe["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "lastUsed" not in recipe:
        recipe["lastUsed"] = recipe.get("createdAt", "")
    return recipe
