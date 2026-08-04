#!/usr/bin/env python3
"""
calculation_service.py - Disintegration Tester recipe validation and form processing.

Recipe fields (minimal, per plan):
  name, temp (set temperature °C), duration (minutes, timer mode only), mode (manual|timer)
"""

from datetime import datetime
from typing import Any, Dict, Optional

MAX_TEMP_C = 55.0
MIN_TEMP_C = 20.0


def init():
    pass


def _parse_duration_minutes(recipe_data: Dict[str, Any]) -> Optional[float]:
    """Accept duration as minutes (number) or MM:SS / HH:MM:SS string.

    Also accepts setDuration display strings used by the DT create-recipe UI.
    """
    for key in ("duration", "setDuration", "timeMinutes"):
        if key not in recipe_data or recipe_data.get(key) is None:
            continue
        d = recipe_data.get(key)
        if key == "duration" and isinstance(d, (int, float)):
            return float(d)
        s = str(d).strip()
        if not s:
            continue
        if ":" in s:
            parts = s.split(":")
            try:
                if len(parts) == 2:
                    return int(parts[0]) + int(parts[1]) / 60.0
                if len(parts) == 3:
                    return int(parts[0]) * 60 + int(parts[1]) + int(parts[2]) / 60.0
            except (TypeError, ValueError):
                continue
        try:
            return float(s)
        except (TypeError, ValueError):
            continue
    if recipe_data.get("timeSeconds") is not None:
        try:
            return float(recipe_data.get("timeSeconds")) / 60.0
        except (TypeError, ValueError):
            return None
    return None


def _format_hhmmss_from_minutes(duration_min: float) -> str:
    total_sec = max(0, int(round(float(duration_min) * 60)))
    hh, rem = divmod(total_sec, 3600)
    mm, ss = divmod(rem, 60)
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def validate_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate DT recipe.
    Required: name, temp, mode.
    Timer mode also requires duration > 0.
    Returns { "valid": bool, "error": str }.
    """
    errors = []
    name = (recipe_data.get("productName") or recipe_data.get("name") or "").strip()
    if not name:
        errors.append("Recipe name is required")

    mode = str(recipe_data.get("mode") or "manual").strip().lower()
    if mode not in ("manual", "timer"):
        errors.append("Mode must be 'manual' or 'timer'")
        mode = "manual"

    temp_raw = recipe_data.get("temp")
    if temp_raw is None:
        temp_raw = recipe_data.get("setTemperature")
    try:
        temp = float(temp_raw)
        if temp < MIN_TEMP_C or temp > MAX_TEMP_C:
            errors.append(f"Temperature must be between {MIN_TEMP_C:.0f} and {MAX_TEMP_C:.0f}°C")
    except (TypeError, ValueError):
        errors.append("Temperature is required")
        temp = None

    duration = None
    if mode == "timer":
        duration = _parse_duration_minutes(recipe_data)
        if duration is None or duration <= 0:
            errors.append("Duration is required for timer mode and must be greater than 0")

    if errors:
        return {"valid": False, "error": "; ".join(errors)}
    return {"valid": True}


def process_recipe_form_data(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize recipe form data for storage."""
    recipe = dict(form_data or {})
    name = (recipe.get("productName") or recipe.get("name") or "").strip()
    recipe["name"] = name
    recipe["productName"] = name

    mode = str(recipe.get("mode") or "manual").strip().lower()
    if mode not in ("manual", "timer"):
        mode = "manual"
    recipe["mode"] = mode

    temp_raw = recipe.get("temp")
    if temp_raw is None:
        temp_raw = recipe.get("setTemperature")
    try:
        temp = round(float(temp_raw), 1)
    except (TypeError, ValueError):
        temp = MIN_TEMP_C
    recipe["temp"] = temp
    recipe["setTemperature"] = temp

    if mode == "timer":
        duration = _parse_duration_minutes(recipe)
        recipe["duration"] = round(float(duration), 3) if duration is not None else None
        # Always normalize display string from parsed minutes (fixes "00:0:30")
        if duration is not None:
            recipe["setDuration"] = _format_hhmmss_from_minutes(duration)
        else:
            recipe["setDuration"] = None
    else:
        recipe["duration"] = None
        recipe["setDuration"] = None

    media = (recipe.get("media") or "").strip()
    mesh = (recipe.get("mesh") or "").strip()
    recipe["media"] = media or None
    recipe["mesh"] = mesh or None

    # Strip friability leftovers if present
    for k in (
        "drumCount", "speed", "uspMode", "usp", "customCompletionMode",
        "tabletCount", "customTotalTaps", "timeSeconds", "timeMinutes", "targetSeconds",
    ):
        recipe.pop(k, None)

    if "createdAt" not in recipe:
        recipe["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "lastUsed" not in recipe:
        recipe["lastUsed"] = recipe.get("createdAt", "")
    return recipe
