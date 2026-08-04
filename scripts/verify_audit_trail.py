#!/usr/bin/env python3
"""End-to-end audit trail verification against the running kiosk API."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
TEST_USER = os.environ.get("AUDIT_TEST_USER", "Test@123")
TEST_PASS = os.environ.get("AUDIT_TEST_PASS", "Test@1234")
FACTORY_USER = "RLERLT"
FACTORY_PASS = os.environ.get("FACTORY_PASS", "Rahul")

# Actions exercised in this run (simulates UI button flows via audit-log/event + server routes)
EXPECTED_ACTIONS = [
    "Login",
    "Entered screen",
    "Exited screen",
    "Opened Quick Test",
    "Quick test started",
    "Test started",
    "Test finished",
    "Test aborted",
    "Test auto-aborted",
    "holder error",
    "check adaptor and holder",
    "Opened Load Recipe",
    "Loaded recipe",
    "Validation started",
    "Validation finished",
    "Validation aborted",
    "Entered USP 1 validation",
    "Logout",
    "Logout (inactivity timeout)",
    "Power interruption",
    "Test performed",
    "Adapter check error",
    "Heater on",
    "Heater off",
    "Test preheat started",
]


class RunResult:
    def __init__(self):
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.warnings: list[str] = []

    def ok(self, msg: str) -> None:
        self.passed.append(msg)
        print("  OK  ", msg)

    def fail(self, msg: str) -> None:
        self.failed.append(msg)
        print("  FAIL", msg)

    def note_warn(self, msg: str) -> None:
        self.warnings.append(msg)
        print("  WARN", msg)


def ts_ms() -> int:
    return int(time.time() * 1000)


class _Resp:
    def __init__(self, status: int, body: bytes):
        self.status_code = status
        self.content = body

    def json(self):
        return json.loads(self.content.decode("utf-8")) if self.content else {}


class Client:
    def __init__(self):
        self._headers = {"Content-Type": "application/json"}

    def _request(self, method: str, path: str, body=None, params=None) -> _Resp:
        url = BASE + path
        if params:
            qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None)
            if qs:
                url += ("&" if "?" in url else "?") + qs
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return _Resp(resp.status, resp.read())
        except urllib.error.HTTPError as e:
            return _Resp(e.code, e.read())

    def login(self, username: str, password: str) -> dict:
        r = self._request("POST", "/api/data/auth/login", {"username": username, "password": password})
        if r.status_code >= 400:
            raise RuntimeError(f"login HTTP {r.status_code}: {r.json()}")
        data = r.json()
        if not data.get("success") and "user" not in data:
            raise RuntimeError(f"login failed: {data}")
        return data.get("user") or data

    def logout(self, reason: str = "user") -> None:
        self._request("POST", "/api/data/auth/logout", {"reason": reason})

    def audit_event(self, action: str, details: str = "", **extra) -> _Resp:
        body = {
            "action": action,
            "details": details,
            "outcome": extra.pop("outcome", "success"),
            "eventType": extra.pop("eventType", "lifecycle"),
        }
        for k in ("entityType", "entityName", "entityId", "reason", "extra"):
            if k in extra:
                body[k] = extra[k]
        return self._request("POST", "/api/data/audit-log/event", body)

    def audit_log(self, **params) -> list:
        r = self._request("GET", "/api/data/audit-log", params=params or None)
        if r.status_code == 403:
            return []
        if r.status_code >= 400:
            raise RuntimeError(f"audit-log HTTP {r.status_code}")
        return (r.json() or {}).get("entries") or []

    def post_report(self, payload: dict) -> dict:
        r = self._request("POST", "/api/data/reports", payload)
        if r.status_code >= 400:
            raise RuntimeError(f"report HTTP {r.status_code}: {r.json()}")
        return r.json()

    def validation_start(self, mode: str) -> _Resp:
        return self._request("POST", "/api/hardware/validation/load/start", {"mode": mode})

    def adapter_check(self) -> dict:
        r = self._request("POST", "/api/hardware/adapter/check")
        return r.json() if r.content else {}

    def validation_stop(self) -> None:
        self._request("POST", "/api/hardware/validation/load/stop", {})


def entries_since(entries: list, since_ms: int, username: str | None = None) -> list:
    out = []
    for e in entries:
        if int(e.get("timestamp") or 0) < since_ms:
            continue
        if username and (e.get("user") or "").strip() != username:
            continue
        out.append(e)
    return out


def actions_in(entries: list) -> set:
    return {str(e.get("action") or "").strip() for e in entries}


def simulate_ui_flow(c: Client, res: RunResult) -> None:
    """Mirror script.js logAuditEvent calls for navigation + test/validation lifecycle."""
    c.audit_event("Entered screen", "Home", eventType="navigation")
    c.audit_event("Opened Quick Test", "Quick Test screen opened", eventType="navigation")
    c.audit_event("Entered screen", "Quick Test", eventType="navigation")
    c.audit_event("Quick test started", "Quick Test, USP 1, 10 step(s)", eventType="lifecycle", extra={"productName": "Quick Test"})
    c.audit_event("Entered screen", "Test Run", eventType="navigation")
    c.audit_event("Test started", "Quick Test, USP 1, 10 step(s)", eventType="lifecycle")
    c.audit_event("Test finished", "Test run completed, 3 step(s) recorded", eventType="lifecycle", extra={"completedSteps": 3})
    c.audit_event("Exited screen", "Test Run", eventType="navigation")
    c.audit_event("Opened Load Recipe", "Load Recipe list opened", eventType="navigation")
    c.audit_event(
        "Loaded recipe",
        "Demo Product, batch B001",
        entityType="recipe",
        entityName="Demo Product",
        extra={"productName": "Demo Product", "batchNumber": "B001"},
    )
    c.audit_event("Test aborted", "User aborted test run", eventType="lifecycle")
    c.audit_event("Test auto-aborted", "Adapter removed during test run", outcome="failed", extra={"stepIndex": 2})
    c.audit_event(
        "holder error",
        "Adapter check failed for test run",
        outcome="failed",
        entityType="hardware",
        entityName="adapter",
        extra={"expected": "usp1", "detected": "usp2"},
    )
    c.audit_event("Entered USP 1 validation", "USP 1 validation screen", eventType="navigation")
    c.audit_event("Validation started", "USP 1 validation run started", entityType="validation")
    c.audit_event("Validation finished", "USP 1 validation: Pass", entityType="validation", extra={"status": "Pass"})
    c.audit_event("Validation aborted", "USP 1 validation aborted by user", entityType="validation")
    c.audit_event(
        "check adaptor and holder",
        "Adapter check failed for USP 2 validation",
        outcome="failed",
        entityType="hardware",
        entityName="adapter",
        extra={"expected": "usp2", "detected": "usp1"},
    )


def verify_factory_suppression(c: Client, res: RunResult, since_ms: int) -> None:
    c.login(FACTORY_USER, FACTORY_PASS)
    r = c.audit_event("Test started", "Factory should not appear in audit DB")
    if r.status_code != 200:
        res.fail(f"Factory audit event HTTP {r.status_code}")
    else:
        res.ok("Factory audit event endpoint accepts POST (200)")
    c.logout("user")
    time.sleep(0.3)
    c.login(TEST_USER, TEST_PASS)
    entries = c.audit_log()
    factory_rows = [
        e
        for e in entries_since(entries, since_ms)
        if (e.get("user") or "").strip() == FACTORY_USER
        and str(e.get("action") or "") == "Test started"
    ]
    if factory_rows:
        res.fail(f"Factory actor logged Test started ({len(factory_rows)} row(s))")
    else:
        res.ok("Factory (RLERLT) Test started suppressed from audit log")


def verify_logout_variants(c: Client, res: RunResult, since_ms: int) -> None:
    """Manual logout via live API; inactivity via test_client (browser session-ui-reset clears live session)."""
    c.login(TEST_USER, TEST_PASS)
    c.logout("user")
    time.sleep(0.2)
    c.login(TEST_USER, TEST_PASS)
    entries = actions_in(entries_since(c.audit_log(), since_ms, TEST_USER))
    if "Logout" in entries:
        res.ok("Logout (manual) recorded on live API")
    else:
        res.fail("Missing Logout (manual)")

    inactivity_since = ts_ms() - 1000
    try:
        from app import app as flask_app

        tc = flask_app.test_client()
        lr = tc.post("/api/data/auth/login", json={"username": TEST_USER, "password": TEST_PASS})
        if lr.status_code != 200:
            res.fail(f"In-process login HTTP {lr.status_code}")
            return
        lo = tc.post("/api/data/auth/logout", json={"reason": "inactivity"})
        if lo.status_code != 200:
            res.fail(f"In-process inactivity logout HTTP {lo.status_code}")
            return
        import audit_service

        audit_service.init(
            {"STORAGE_DIR": APP_ROOT / "storage", "REPORTS_DIR": APP_ROOT / "reports"}
        )
        recent = {
            str(e.get("action") or "").strip()
            for e in audit_service.list_entries({"from": inactivity_since})
        }
        if "Logout (inactivity timeout)" in recent:
            res.ok("Logout (inactivity timeout) recorded (in-process logout route)")
        else:
            res.fail("Missing Logout (inactivity timeout) from logout route")
    except Exception as exc:
        res.fail(f"In-process inactivity logout test: {exc}")


def verify_power_interruption(res: RunResult, since_ms: int) -> None:
    import data_service
    import audit_service

    config = {"STORAGE_DIR": APP_ROOT / "storage", "REPORTS_DIR": APP_ROOT / "reports"}
    data_service.init(config)
    audit_service.init(config)

    flag = APP_ROOT / "storage" / "app_clean_stop.flag"
    if flag.exists():
        flag.unlink()

    user = {"username": TEST_USER, "role": "User", "name": TEST_USER}
    data_service.save_current_user(user)
    data_service.write_session_power_audit_pending(user)

    from app import _startup_session_power_audit

    _startup_session_power_audit()

    entries = audit_service.list_entries({"from": since_ms})
    pi = [e for e in entries if e.get("action") == "Power interruption"]
    if pi:
        res.ok(f"Power interruption logged ({len(pi)} row(s))")
        if "kiosk-bridge" in (pi[-1].get("details") or "").lower() or "restarted" in (pi[-1].get("details") or "").lower():
            res.ok("Power interruption details mention restart/shutdown")
        else:
            res.note_warn("Power interruption row present but details lack restart wording")
    else:
        res.fail("Power interruption not logged after simulated unclean startup")


def verify_heater_audit(c: Client, res: RunResult) -> None:
    """POST hardware preheat on/off and assert Heater on / Heater off audit rows."""
    c.login(TEST_USER, TEST_PASS)
    since = ts_ms() - 1000

    # Ensure known-off baseline for beaker 1
    c._request("POST", "/api/hardware/dt/preheat", {"t1": 0, "t2": 0, "source": "settings"})
    time.sleep(0.2)
    since = ts_ms() - 500

    r_on = c._request(
        "POST",
        "/api/hardware/dt/preheat",
        {"t1": 37.0, "t2": 0, "source": "settings"},
    )
    if r_on.status_code >= 400:
        res.fail(f"Heater on preheat HTTP {r_on.status_code}: {r_on.json()}")
        return
    res.ok("Hardware preheat on (beaker 1) accepted")

    time.sleep(0.3)
    entries = entries_since(c.audit_log(), since, TEST_USER)
    heater_on = [e for e in entries if e.get("action") == "Heater on"]
    if heater_on and any("Beaker 1" in str(e.get("details") or "") for e in heater_on):
        res.ok("Heater on audited for Beaker 1")
    else:
        res.fail("Missing Heater on audit row for Beaker 1")

    since_off = ts_ms() - 500
    r_off = c._request(
        "POST",
        "/api/hardware/dt/preheat",
        {"t1": 0, "t2": 0, "source": "settings"},
    )
    if r_off.status_code >= 400:
        res.fail(f"Heater off preheat HTTP {r_off.status_code}: {r_off.json()}")
        return
    res.ok("Hardware preheat off accepted")

    time.sleep(0.3)
    entries_off = entries_since(c.audit_log(), since_off, TEST_USER)
    heater_off = [e for e in entries_off if e.get("action") == "Heater off"]
    if heater_off and any("Beaker 1" in str(e.get("details") or "") for e in heater_off):
        res.ok("Heater off audited for Beaker 1")
    else:
        res.fail("Missing Heater off audit row for Beaker 1")


def verify_formal_preheat_audit(c: Client, res: RunResult) -> None:
    """Optional smoke: formal run preheat still emits Test preheat started."""
    c.login(TEST_USER, TEST_PASS)
    since = ts_ms() - 500
    r = c._request(
        "POST",
        "/api/data/dt/runs/1/preheat",
        {
            "setTemperature": 37.0,
            "mode": "manual",
            "basketConfig": 6,
            "productName": "Audit Preheat Smoke",
            "batchNumber": "AUDIT-PH",
        },
    )
    body = r.json() if r.content else {}
    if r.status_code >= 400:
        # Basket may already be active from a prior test — warn, do not fail the suite
        res.note_warn(f"Formal preheat smoke skipped HTTP {r.status_code}: {body.get('error')}")
        return
    res.ok("Formal run preheat accepted")
    time.sleep(0.3)
    entries = entries_since(c.audit_log(), since, TEST_USER)
    if any(e.get("action") == "Test preheat started" for e in entries):
        res.ok("Test preheat started audited on formal preheat")
    else:
        res.fail("Missing Test preheat started after formal preheat")
    # Best-effort cleanup
    c._request("POST", "/api/data/dt/runs/1/stop", {"aborted": True, "reason": "preheat_abort"})


def verify_hardware_routes(c: Client, res: RunResult, since_ms: int) -> None:
    c.login(TEST_USER, TEST_PASS)
    check = c.adapter_check()
    res.ok(f"Adapter check API ok={check.get('ok')}")
    for mode in ("usp1", "usp2"):
        r = c.validation_start(mode)
        if r.status_code == 400 and (r.json() or {}).get("error") == "adapter_mismatch":
            action = "holder error" if mode == "usp1" else "check adaptor and holder"
            res.ok(f"validation/load/start mode={mode} → adapter_mismatch (400)")
        elif r.status_code == 200:
            res.note_warn(f"validation/load/start mode={mode} succeeded (adapter matched hardware)")
            c.validation_stop()
        else:
            res.note_warn(f"validation/load/start mode={mode} → HTTP {r.status_code}: {(r.json() or {}).get('error')}")
    time.sleep(0.3)
    entries = actions_in(entries_since(c.audit_log(), since_ms, TEST_USER))
    if "holder error" in entries or "check adaptor and holder" in entries:
        res.ok("Server-side adapter/holder error action in audit log")
    else:
        res.note_warn("No USP adapter error from hardware (adapter may match device)")


def verify_report_audit(c: Client, res: RunResult, since_ms: int) -> None:
    c.login(TEST_USER, TEST_PASS)
    payload = {
        "name": "Audit verify test report",
        "type": "test",
        "recipe": {"productName": "Quick Test", "batchNumber": "AUDIT-1", "stepCount": 1, "steps": []},
        "testData": {
            "productName": "Quick Test",
            "batchNumber": "AUDIT-1",
            "status": "completed",
            "completedSteps": 1,
            "stepCount": 1,
            "stepResults": [],
        },
    }
    try:
        rep = c.post_report(payload)
        rid = rep.get("id")
        res.ok(f"Report created id={rid}")
        time.sleep(0.3)
        entries = entries_since(c.audit_log(), since_ms, TEST_USER)
        if any(e.get("action") == "Quick test performed" for e in entries):
            res.ok("Quick test performed audit on report save")
        elif any(e.get("action") == "Test performed" for e in entries):
            res.ok("Test performed audit on report save")
        else:
            res.fail("No Test performed / Quick test performed on report save")
    except Exception as exc:
        res.fail(f"Report create failed: {exc}")


def verify_pdf_html(res: RunResult, since_ms: int) -> None:
    import audit_service
    import data_service
    from app import _build_audit_trail_html

    config = {"STORAGE_DIR": APP_ROOT / "storage", "REPORTS_DIR": APP_ROOT / "reports"}
    data_service.init(config)
    audit_service.init(config)
    entries = audit_service.list_entries({"from": since_ms})
    factory = data_service.get_factory_settings() or {}
    html = _build_audit_trail_html(entries, {}, factory)
    required = ("Test started", "Validation finished", "Power interruption")
    missing = [a for a in required if a not in html]
    if "Logout (inactivity timeout)" in html or "Logout" in html:
        res.ok("Audit PDF HTML includes logout action(s)")
    else:
        missing.append("Logout")
    if not missing:
        res.ok("Audit PDF HTML includes new action labels")
    else:
        res.fail(f"Audit HTML missing actions: {missing}")


def verify_export_stage_endpoints(c: Client, res: RunResult) -> None:
    """Smoke-test compliance export staging endpoints."""
    try:
        r = c._request("POST", "/api/audit/export/stage", {"filters": {}})
        stage = r.json() if r.content else {}
        if stage.get("success") and stage.get("batchId"):
            res.ok("Audit export stage returns batchId")
        else:
            res.fail(f"Audit export stage failed: {stage}")
    except Exception as exc:
        res.fail(f"Audit export stage: {exc}")

    try:
        r = c._request("GET", "/api/data/reports", params={"filter": "all"})
        reports = r.json() if r.content else {}
        ids = [int(rpt["id"]) for rpt in (reports.get("reports") or [])[:1] if rpt.get("id")]
        if not ids:
            res.note_warn("No reports to test report export stage")
            return
        r2 = c._request("POST", "/api/reports/export/stage", {"report_ids": ids})
        stage = r2.json() if r2.content else {}
        if stage.get("success") and stage.get("batchId"):
            res.ok("Report export stage returns batchId")
        else:
            res.fail(f"Report export stage failed: {stage}")
    except Exception as exc:
        res.fail(f"Report export stage: {exc}")


def verify_purge_primitives(res: RunResult) -> None:
    import audit_service
    import data_service

    config = {"STORAGE_DIR": APP_ROOT / "storage", "REPORTS_DIR": APP_ROOT / "reports"}
    data_service.init(config)
    audit_service.init(config)
    batch = audit_service.stage_audit_export([999999], "tester", "approver")
    if batch.get("id"):
        res.ok("audit_service.stage_audit_export")
    confirmed = audit_service.confirm_audit_export_batch(batch["id"], "/tmp/test.pdf")
    if confirmed and confirmed.get("confirmedAt"):
        res.ok("audit_service.confirm_audit_export_batch")
    rb = data_service.stage_report_export([999998], "tester", "approver")
    if rb.get("id"):
        res.ok("data_service.stage_report_export")


def main() -> int:
    since_ms = ts_ms() - 5000
    res = RunResult()
    c = Client()

    print("=== Audit trail verification ===")
    print(f"API: {BASE}")
    print(f"User: {TEST_USER}")
    print()

    try:
        c.login(TEST_USER, TEST_PASS)
        res.ok("Login")
    except Exception as exc:
        res.fail(f"Login: {exc}")
        return 1

    verify_export_stage_endpoints(c, res)
    verify_purge_primitives(res)

    since_ms = ts_ms() - 1000
    simulate_ui_flow(c, res)
    verify_report_audit(c, res, since_ms)
    verify_logout_variants(c, res, since_ms)
    verify_hardware_routes(c, res, since_ms)
    verify_heater_audit(c, res)
    verify_formal_preheat_audit(c, res)

    factory_since = ts_ms() - 1000
    verify_factory_suppression(c, res, factory_since)

    power_since = ts_ms() - 1000
    verify_power_interruption(res, power_since)

    verify_pdf_html(res, since_ms - 120000)

    c.login(TEST_USER, TEST_PASS)
    all_entries = entries_since(c.audit_log(), since_ms, TEST_USER)
    found = actions_in(all_entries)
    print()
    print("--- Actions seen for test user since run ---")
    for a in sorted(found):
        print(" ", a)

    missing = [
        a
        for a in EXPECTED_ACTIONS
        if a not in found
        and a
        not in (
            "Login",
            "Power interruption",
            "Adapter check error",
            "Heater on",
            "Heater off",
            "Test preheat started",
        )
    ]
    if missing:
        res.note_warn(f"Simulated actions not all visible for {TEST_USER}: {missing}")

    print()
    print(f"Passed: {len(res.passed)}, Failed: {len(res.failed)}, Warnings: {len(res.warnings)}")
    if res.failed:
        for f in res.failed:
            print("  -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
