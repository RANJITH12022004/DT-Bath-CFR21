"""Recipe data helpers that work across Tap Density and Friability storage models."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import data_service


def list_recipes(status: str = "active") -> List[Dict[str, Any]]:
    status = str(status or "active").strip().lower()
    fn = getattr(data_service, "list_recipes", None)
    if not callable(fn):
        return []

    try:
        recipes = fn(status=status)
        return list(recipes or [])
    except TypeError:
        # Friability / older: list_recipes(filter_type=None) only.
        recipes = list(fn() or [])
        if status == "all":
            return recipes
        if status == "disabled":
            return [r for r in recipes if str(r.get("status") or "active").strip().lower() == "disabled"]
        return [r for r in recipes if str(r.get("status") or "active").strip().lower() != "disabled"]


def get_recipe(recipe_id: int, include_disabled: bool = False) -> Optional[Dict[str, Any]]:
    fn = getattr(data_service, "get_recipe", None)
    if not callable(fn):
        return None
    try:
        recipe = fn(recipe_id, include_disabled=include_disabled)
    except TypeError:
        recipe = fn(recipe_id)
    if not recipe:
        return None
    st = str(recipe.get("status") or "active").strip().lower()
    if st == "disabled" and not include_disabled:
        return None
    return recipe


def disable_recipe(recipe_id: int, disabled_by: str = "--", disabled_by_username: str = "--") -> Optional[Dict[str, Any]]:
    fn = getattr(data_service, "disable_recipe", None)
    if callable(fn):
        try:
            return fn(recipe_id, disabled_by=disabled_by, disabled_by_username=disabled_by_username)
        except TypeError:
            return fn(recipe_id)

    recipe = get_recipe(recipe_id, include_disabled=True)
    if not recipe:
        # Fallback direct load
        try:
            recipe = data_service.get_recipe(recipe_id)
        except Exception:
            recipe = None
    if not recipe:
        return None
    recipe = dict(recipe)
    recipe["status"] = "disabled"
    recipe["disabledBy"] = disabled_by
    recipe["disabledByUsername"] = disabled_by_username
    data_service.save_recipe(recipe)
    return recipe


def enable_recipe(recipe_id: int) -> Optional[Dict[str, Any]]:
    fn = getattr(data_service, "enable_recipe", None)
    if callable(fn):
        return fn(recipe_id)

    try:
        recipe = data_service.get_recipe(recipe_id)
    except Exception:
        recipe = None
    if not recipe:
        # Search including disabled in raw file via list
        for item in list_recipes(status="disabled"):
            if int(item.get("id") or 0) == int(recipe_id):
                recipe = item
                break
    if not recipe:
        return None
    recipe = dict(recipe)
    recipe["status"] = "active"
    for key in ("disabledBy", "disabledByUsername", "disabledAt"):
        recipe.pop(key, None)
    data_service.save_recipe(recipe)
    return recipe
