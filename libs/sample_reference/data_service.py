#!/usr/bin/env python3
"""
data_service.py - Data storage and management service
Handles CRUD operations for recipes, reports, members, and factory settings.
All data stored as JSON files on internal USB storage.
"""

import json
import os
import pathlib
from datetime import datetime
from typing import Optional, Dict, List, Any

# Module-level state
_config = {}
_storage_dir = None
_reports_dir = None

# Session storage (in-memory for now, could be persisted)
_current_user = None

# Hidden hardcoded factory user - not stored, not visible, cannot be modified or deleted
FACTORY_USERNAME = "RLERLT"
FACTORY_PASSWORD = "Rahul"
FACTORY_USER = {
    "id": 0,
    "name": "Factory",
    "username": FACTORY_USERNAME,
    "role": "Factory",
}


def init(config):
    """Initialize data service with config"""
    global _config, _storage_dir, _reports_dir
    _config = dict(config)
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "/media/usb_internal/storage"))
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "/media/usb_internal/reports"))
    
    # Create directories if they don't exist
    _storage_dir.mkdir(parents=True, exist_ok=True)
    _reports_dir.mkdir(parents=True, exist_ok=True)


def _get_storage_path(filename: str) -> pathlib.Path:
    """Get full path for storage file"""
    safe_name = "".join(c for c in filename if c.isalnum() or c in "-_.")
    return _storage_dir / safe_name


def _load_json_file(filepath: pathlib.Path, default=None):
    """Load JSON file, return default if not found or invalid"""
    if default is None:
        default = []
    if not filepath.exists():
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if data is not None else default
    except Exception:
        return default


def _save_json_file(filepath: pathlib.Path, data):
    """Save data to JSON file"""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# =================== RECIPE OPERATIONS ==========================

def list_recipes(filter_type=None):
    """List all recipes, optionally filtered"""
    recipes_path = _get_storage_path("recipes.json")
    recipes = _load_json_file(recipes_path, default=[])
    if not isinstance(recipes, list):
        recipes = []
    
    if filter_type:
        recipes = [r for r in recipes if r.get("type") == filter_type]
    
    return recipes


def get_recipe(recipe_id: int):
    """Get recipe by ID"""
    recipes = list_recipes()
    for recipe in recipes:
        if recipe.get("id") == recipe_id:
            return recipe
    return None


def _hardness_to_newton(value: float, unit: str, conversion_factor: Optional[float] = None) -> float:
    """Convert hardness value to Newton for load cell range check."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    unit_lower = (unit or "").strip().lower()
    if "newton" in unit_lower or unit == "Newton (N)":
        return v
    if "kgf" in unit_lower or "kilogram" in unit_lower:
        return v * 9.80665
    if "strong" in unit_lower or "cobb" in unit_lower:
        return v * (1 / 0.1428)  # 1 N = 0.1428 SC, so SC to N: N = SC / 0.1428
    # User-defined or any custom unit: use conversion factor when provided
    if conversion_factor is not None and conversion_factor > 0:
        return v * conversion_factor
    return v


def save_recipe(recipe_data: Dict[str, Any]) -> int:
    """Save recipe (create or update). Enforces max recipe limit and load cell range."""
    recipes_path = _get_storage_path("recipes.json")
    recipes = list_recipes()

    # Check hardness nominal against valid range 0-500 N (after unit conversion)
    params = recipe_data.get("parameters") or {}
    hardness_val = params.get("Hardness") or params.get("hardness")
    if hardness_val is not None and str(hardness_val).strip():
        try:
            h = float(str(hardness_val).strip())
            unit = recipe_data.get("unit") or "Newton (N)"
            conv = recipe_data.get("conversionFactor")
            h_n = _hardness_to_newton(h, unit, conv)
            max_n = 500
            if h_n < 0 or h_n > max_n:
                raise ValueError("Enter the valid range 0-500 N")
        except ValueError as e:
            if "valid range" in str(e):
                raise
            pass

    recipe_id = recipe_data.get("id")
    is_update = recipe_id and any(r.get("id") == recipe_id for r in recipes)

    if not is_update:
        fs = get_factory_settings()
        max_recipes = int(fs.get("maxRecipes") or 150)
        if len(recipes) >= max_recipes:
            raise ValueError("Your limit for recipes reached. Contact support for upgrade.")

    if recipe_id and is_update:
        for i, r in enumerate(recipes):
            if r.get("id") == recipe_id:
                recipes[i] = recipe_data
                _save_json_file(recipes_path, recipes)
                return recipe_id

    if recipe_id and not is_update:
        recipe_data["id"] = recipe_id
        recipes.append(recipe_data)
    else:
        max_id = max([r.get("id", 0) for r in recipes], default=0)
        recipe_id = max_id + 1
        recipe_data["id"] = recipe_id
        recipes.append(recipe_data)

    _save_json_file(recipes_path, recipes)
    return recipe_id


def delete_recipe(recipe_id: int) -> bool:
    """Delete recipe by ID"""
    recipes_path = _get_storage_path("recipes.json")
    recipes = list_recipes()
    original_len = len(recipes)
    recipes = [r for r in recipes if r.get("id") != recipe_id]
    
    if len(recipes) < original_len:
        _save_json_file(recipes_path, recipes)
        return True
    return False


# =================== REPORT OPERATIONS ==========================

def list_reports(filter_type="all"):
    """List reports, optionally filtered by type"""
    reports_path = _get_storage_path("reports.json")
    reports = _load_json_file(reports_path, default=[])
    if not isinstance(reports, list):
        reports = []
    
    if filter_type and filter_type != "all":
        reports = [r for r in reports if r.get("type") == filter_type]
    
    # Sort by createdAt descending
    def sort_key(r):
        ts = r.get("createdAt") or r.get("completedAt") or ""
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            return dt
        except:
            return datetime.min
    
    reports.sort(key=sort_key, reverse=True)
    return reports


def get_report(report_id: int):
    """Get report by ID"""
    try:
        rid = int(report_id)
    except (TypeError, ValueError):
        return None
    reports = list_reports()
    for report in reports:
        if report.get("id") == rid:
            return report
    return None


def save_report(report_data: Dict[str, Any]) -> int:
    """Save report (create or update)"""
    reports_path = _get_storage_path("reports.json")
    reports = list_reports("all")
    
    report_id = report_data.get("id")
    if not report_id:
        # Generate new ID
        max_id = max([r.get("id", 0) for r in reports], default=0)
        report_id = max_id + 1
        report_data["id"] = report_id
    
    # Add timestamp if missing
    if not report_data.get("createdAt"):
        report_data["createdAt"] = datetime.utcnow().isoformat() + "Z"
    
    # Update existing or append new
    found = False
    for i, r in enumerate(reports):
        if r.get("id") == report_id:
            reports[i] = report_data
            found = True
            break
    
    if not found:
        reports.append(report_data)
    
    _save_json_file(reports_path, reports)
    return report_id


def delete_report(report_id: int) -> bool:
    """Delete report by ID"""
    reports_path = _get_storage_path("reports.json")
    reports = list_reports("all")
    original_len = len(reports)
    reports = [r for r in reports if r.get("id") != report_id]
    
    if len(reports) < original_len:
        _save_json_file(reports_path, reports)
        return True
    return False


# =================== MEMBER OPERATIONS ==========================

def list_members():
    """List all members/users. Excludes hidden factory user."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    # Hide the built-in factory user from the list
    return [m for m in members if str(m.get("username", "")).strip().upper() != FACTORY_USERNAME.upper()]


def get_member(member_id: int):
    """Get member by ID"""
    members = list_members()
    for member in members:
        if member.get("id") == member_id:
            return member
    return None


def _check_member_limits(members: List[Dict], member_data: Dict[str, Any], existing_member: Optional[Dict] = None):
    """Check factory limits for users, admins, supervisors. Raise ValueError if exceeded."""
    fs = get_factory_settings()
    max_users = int(fs.get("maxUsers") or 10)
    max_admins = int(fs.get("maxAdmins") or 2)
    max_supervisors = int(fs.get("maxSupervisors") or 3)

    def count_role(ms: List, r: str) -> int:
        return sum(1 for m in ms if str(m.get("role", "")).strip().lower() == r)

    new_role = str(member_data.get("role", "User")).strip().lower()
    users = count_role(members, "user")
    admins = count_role(members, "admin")
    supervisors = count_role(members, "supervisor")

    if existing_member:
        old_role = str(existing_member.get("role", "")).strip().lower()
        if old_role == "user":
            users -= 1
        elif old_role == "admin":
            admins -= 1
        elif old_role == "supervisor":
            supervisors -= 1

    if new_role == "user":
        users += 1
    elif new_role == "admin":
        admins += 1
    elif new_role == "supervisor":
        supervisors += 1

    if users > max_users:
        raise ValueError("Your limit for users reached. Contact support for upgrade.")
    if admins > max_admins:
        raise ValueError("Your limit for admins reached. Contact support for upgrade.")
    if supervisors > max_supervisors:
        raise ValueError("Your limit for supervisors reached. Contact support for upgrade.")


def save_member(member_data: Dict[str, Any]) -> int:
    """Save member (create or update). Cannot create or modify factory user."""
    username = str(member_data.get("username", "")).strip().upper()
    if username == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be created or modified.")
    members_path = _get_storage_path("members.json")
    members = list_members()

    member_id = member_data.get("id")
    if member_id:
        # Update existing
        existing = next((m for m in members if m.get("id") == member_id), None)
        if existing:
            _check_member_limits(members, member_data, existing_member=existing)
            for i, m in enumerate(members):
                if m.get("id") == member_id:
                    members[i] = member_data
                    break
            _save_json_file(members_path, members)
            return member_id
        # ID not found - treat as create
    # Create new
    _check_member_limits(members, member_data)
    max_id = max([m.get("id", 0) for m in members], default=0)
    member_id = max_id + 1
    member_data["id"] = member_id
    members.append(member_data)
    _save_json_file(members_path, members)
    return member_id


def delete_member(member_id: int) -> bool:
    """Delete member by ID. Cannot delete factory user."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    member_to_delete = next((m for m in members if m.get("id") == member_id), None)
    if member_to_delete and str(member_to_delete.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be deleted.")
    original_len = len(members)
    members = [m for m in members if m.get("id") != member_id]
    if len(members) < original_len:
        _save_json_file(members_path, members)
        return True
    return False


def authenticate_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    """Authenticate user by username and password. Hardcoded factory user always valid."""
    username_clean = username.strip()
    # Check hardcoded factory user first (case-insensitive username)
    if username_clean.upper() == FACTORY_USERNAME.upper() and password == FACTORY_PASSWORD:
        return dict(FACTORY_USER)

    members = list_members()
    username_lower = username_clean.lower()

    for member in members:
        member_username = str(member.get("username", "")).strip().lower()
        member_password = str(member.get("password", ""))

        if member_username == username_lower and member_password == password:
            user = dict(member)
            user.pop("password", None)
            return user

    return None


def factory_reset() -> Dict[str, Any]:
    """
    Delete all reports, recipes, and members. Preserves factory settings and factory user.
    Returns dict with deleted counts.
    """
    recipes_path = _get_storage_path("recipes.json")
    reports_path = _get_storage_path("reports.json")
    members_path = _get_storage_path("members.json")

    recipes = _load_json_file(recipes_path, default=[])
    reports = _load_json_file(reports_path, default=[])
    members = _load_json_file(members_path, default=[])

    n_recipes = len(recipes) if isinstance(recipes, list) else 0
    n_reports = len(reports) if isinstance(reports, list) else 0
    n_members = len(members) if isinstance(members, list) else 0

    _save_json_file(recipes_path, [])
    _save_json_file(reports_path, [])
    _save_json_file(members_path, [])

    # Delete report files from REPORTS_DIR
    n_report_files = 0
    if _reports_dir and _reports_dir.exists():
        for f in list(_reports_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in (".pdf", ".json"):
                try:
                    f.unlink()
                    n_report_files += 1
                except Exception:
                    pass

    return {
        "deleted": {
            "recipes": n_recipes,
            "reports": n_reports,
            "members": n_members,
            "reportFiles": n_report_files,
        }
    }


# =================== FACTORY SETTINGS OPERATIONS ==========================

def get_factory_settings() -> Dict[str, Any]:
    """Get factory settings"""
    settings_path = _get_storage_path("factorySettings.json")
    settings = _load_json_file(settings_path, default={})
    if not isinstance(settings, dict):
        settings = {}
    return settings


def save_factory_settings(settings: Dict[str, Any]):
    """Save factory settings with validation for limits and load cell range."""
    # Validate load cell range
    lcr = settings.get("loadCellRange")
    if lcr is not None:
        lcr = int(lcr) if isinstance(lcr, (int, float, str)) else 500
        if lcr not in (300, 500, 800):
            lcr = 500
        settings["loadCellRange"] = lcr

    # Validate and clamp numeric limits
    for key, default, min_val, max_val in [
        ("maxRecipes", 150, 1, 999),
        ("maxUsers", 10, 1, 999),
        ("maxAdmins", 2, 1, 99),
        ("maxSupervisors", 3, 1, 99),
    ]:
        val = settings.get(key)
        if val is not None:
            try:
                val = max(min_val, min(max_val, int(val)))
            except (ValueError, TypeError):
                val = default
            settings[key] = val

    settings_path = _get_storage_path("factorySettings.json")
    _save_json_file(settings_path, settings)


# =================== SESSION MANAGEMENT ==========================

def save_current_user(user: Dict[str, Any]):
    """Save current logged-in user session"""
    global _current_user
    _current_user = dict(user)
    # Also persist to file for session recovery
    session_path = _get_storage_path("current_user.json")
    _save_json_file(session_path, _current_user)


def get_current_user() -> Optional[Dict[str, Any]]:
    """Get current logged-in user"""
    global _current_user
    if _current_user:
        return _current_user
    
    # Try to load from file
    session_path = _get_storage_path("current_user.json")
    _current_user = _load_json_file(session_path, default=None)
    return _current_user


def clear_current_user():
    """Clear current user session"""
    global _current_user
    _current_user = None
    session_path = _get_storage_path("current_user.json")
    if session_path.exists():
        session_path.unlink()


# =================== TEST RUN DATA ==========================

def save_test_run_data(test_data: Dict[str, Any]):
    """Save quick test run data"""
    test_path = _get_storage_path("test_run.json")
    _save_json_file(test_path, test_data)


def get_test_run_data() -> Dict[str, Any]:
    """Get last test run data"""
    test_path = _get_storage_path("test_run.json")
    return _load_json_file(test_path, default={})
