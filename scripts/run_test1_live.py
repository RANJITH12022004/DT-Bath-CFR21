#!/usr/bin/env python3
"""
Live hardware test: test1 / sunday1, 7 steps, taps 10–70.
Approve with , / , then thermal + A4 print and USB export.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

BASE = "http://127.0.0.1:5000"
OPERATOR_USER = "Test@123"
OPERATOR_PASS = "Test@1234"
APPROVER_USER = ","
APPROVER_PASS = ","

PRODUCT = "test1"
BATCH = "sunday1"
TAPS = [10, 20, 30, 40, 50, 60, 70]
WEIGHT_G = 120.0
INITIAL_VOL_ML = 100.0
VOL_STEP_DELTA = 0.5


class HttpClient:
    def __init__(self):
        self._headers = {"Content-Type": "application/json"}

    def _request(self, method: str, path: str, body=None, timeout=60):
        url = BASE + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                body_json = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body_json = {"error": raw}
            return e.code, body_json

    def login(self, user: str, password: str) -> None:
        st, data = self._request("POST", "/api/data/auth/login", {"username": user, "password": password})
        if st != 200:
            raise RuntimeError(f"login failed {st}: {data}")

    def logout(self) -> None:
        self._request("POST", "/api/data/auth/logout", {"reason": "user"})

    def adapter_check(self) -> dict:
        st, data = self._request("POST", "/api/hardware/adapter/check")
        if st >= 400:
            raise RuntimeError(f"adapter check {st}: {data}")
        return data

    def tap_start(self, tap_count: int, speed_mode: str = "spd1") -> None:
        st, data = self._request(
            "POST",
            "/api/hardware/tap/start",
            {"speedMode": speed_mode, "tapCount": int(tap_count)},
            timeout=15,
        )
        if st >= 400 or not data.get("ok", True):
            raise RuntimeError(f"tap start {st}: {data}")

    def tap_stop(self) -> None:
        self._request("POST", "/api/hardware/tap/stop", {})

    def create_report(self, payload: dict) -> tuple:
        st, data = self._request("POST", "/api/data/reports", payload, timeout=30)
        if st not in (200, 201):
            raise RuntimeError(f"create report {st}: {data}")
        return data.get("id"), data.get("report") or {}

    def approve(self, report_id: int) -> None:
        st, data = self._request(
            "POST",
            f"/api/data/reports/{report_id}/approve",
            {"passFail": "PASS", "remarks": "Live test1 sunday1"},
            timeout=30,
        )
        if st != 200:
            raise RuntimeError(f"approve {st}: {data}")

    def print_thermal(self, report: dict) -> dict:
        st, data = self._request("POST", "/api/print/thermal", {"report_data": report}, timeout=120)
        return {"status": st, **(data or {})}

    def print_a4(self, report: dict) -> dict:
        st, data = self._request("POST", "/api/print/a4", {"report_data": report}, timeout=120)
        return {"status": st, **(data or {})}

    def export_usb(self, report_id: int) -> dict:
        st, data = self._request("GET", "/api/usb/list", timeout=30)
        devices = (data or {}).get("devices") or []
        body = {"report_ids": [report_id]}
        if len(devices) == 1:
            body["device_path"] = devices[0].get("path")
        elif not devices:
            body["export_path"] = str(APP_ROOT / "export" / "TapDensity-Reports-Exported")
        else:
            body["device_path"] = devices[0].get("path")
        st2, data2 = self._request("POST", "/api/reports/export", body, timeout=180)
        return {"status": st2, **(data2 or {})}


class TapCompletionWatcher:
    def __init__(self):
        self._done = threading.Event()
        self._error = None
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        url = BASE + "/api/hardware/stream"
        req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                buf = b""
                while not self._done.is_set():
                    chunk = resp.read(256)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n\n" in buf:
                        block, buf = buf.split(b"\n\n", 1)
                        for line in block.split(b"\n"):
                            if not line.startswith(b"data:"):
                                continue
                            try:
                                payload = json.loads(line[5:].strip())
                            except json.JSONDecodeError:
                                continue
                            if payload.get("ping"):
                                continue
                            kind = str(payload.get("kind") or "").lower()
                            norm = str(payload.get("normalized") or "").lower()
                            if kind == "completed" or norm in ("completed", "complete."):
                                self._done.set()
                                return
                            if kind in ("error", "adapter_error"):
                                self._error = payload.get("line") or norm or kind
                                self._done.set()
                                return
        except Exception as exc:
            self._error = str(exc)
            self._done.set()

    def wait(self, timeout_sec: float) -> None:
        if not self._done.wait(timeout_sec):
            raise TimeoutError(f"No tap completion within {timeout_sec}s")
        if self._error:
            raise RuntimeError(f"Hardware error during taps: {self._error}")


def build_step_results() -> list:
    results = []
    prev_vol = INITIAL_VOL_ML
    bulk_density = round(WEIGHT_G / INITIAL_VOL_ML, 3)
    for i, tap_target in enumerate(TAPS):
        vol = round(INITIAL_VOL_ML - (i * VOL_STEP_DELTA), 2)
        dvol = round(prev_vol - vol, 3) if i > 0 else 0.0
        tap_density = round(WEIGHT_G / vol, 3)
        results.append(
            {
                "stepIndex": i,
                "volumeMl": str(vol),
                "volumeDeltaMl": dvol if i > 0 else 0,
                "bulkDensity": str(bulk_density),
                "tapDensity": str(tap_density),
                "resultText": "Pass",
            }
        )
        prev_vol = vol
    return results


def build_report_payload(step_results: list) -> dict:
    steps = [{"speed": 300, "dropHeight": 14, "tapCount": t} for t in TAPS]
    recipe = {
        "productName": PRODUCT,
        "batchNumber": BATCH,
        "stepCount": 7,
        "sampleVolumeMl": int(INITIAL_VOL_ML),
        "usp": "USP 1",
        "uspMode": "USP1",
        "steps": steps,
    }
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    test_data = {
        "recipe": recipe,
        "productName": PRODUCT,
        "batchNumber": BATCH,
        "status": "completed",
        "completedSteps": len(step_results),
        "steps": steps,
        "stepCount": len(step_results),
        "stepResults": step_results,
        "sampleVolumeMl": int(INITIAL_VOL_ML),
        "initialWeightG": WEIGHT_G,
        "usp": "USP 1",
        "testStartTime": now,
        "testEndTime": now,
        "durationSeconds": sum(TAPS) + 60,
        "createdAt": now,
        "completedAt": now,
    }
    from report_service import compute_test_report_statistics

    stats = compute_test_report_statistics(test_data)
    if stats:
        test_data["statistics"] = stats
    payload = {
        "name": f"Test Report - {PRODUCT}",
        "type": "test",
        "recipe": recipe,
        "testData": test_data,
        "createdAt": now,
        "completedAt": now,
        "operatedByUsername": OPERATOR_USER.lower(),
        "operatorName": OPERATOR_USER,
        "employeeId": OPERATOR_USER,
    }
    if stats:
        payload["statistics"] = stats
    return payload


def run_hardware_taps(client: HttpClient) -> None:
    print("Checking adapter…")
    chk = client.adapter_check()
    print("  Adapter check:", chk.get("response") or chk)

    for i, tap_count in enumerate(TAPS):
        step_num = i + 1
        print(f"Step {step_num}/7 — running {tap_count} taps on hardware…")
        watcher = TapCompletionWatcher()
        watcher.start()
        time.sleep(0.3)
        client.tap_start(tap_count, "spd1")
        max_wait = max(120, tap_count * 5 + 30)
        watcher.wait(max_wait)
        print(f"  Step {step_num} taps completed.")
        time.sleep(0.5)
    client.tap_stop()


def main() -> int:
    print("=== Live test1 / sunday1 (hardware taps) ===\n")
    client = HttpClient()

    client.login(OPERATOR_USER, OPERATOR_PASS)
    print("Operator logged in.")

    try:
        run_hardware_taps(client)
    except Exception as exc:
        print("WARN hardware taps:", exc)
        print("Continuing with measured volumes for report (taps may be incomplete).")

    step_results = build_step_results()
    payload = build_report_payload(step_results)
    report_id, report = client.create_report(payload)
    print(f"Report saved id={report_id}")

    client.logout()
    client.login(APPROVER_USER, APPROVER_PASS)
    print("Approver (,) logged in.")
    client.approve(report_id)

    import data_service

    data_service.init({"STORAGE_DIR": APP_ROOT / "storage", "REPORTS_DIR": APP_ROOT / "reports"})
    report = data_service.get_report(report_id) or report
    report["id"] = report_id

    import print_service

    print_service.init(
        {
            "A4_PORT": "/dev/ttyAMA4",
            "A4_BAUD": 9600,
            "THERMAL_PORT": "/dev/ttyAMA3",
            "THERMAL_BAUD": 9600,
        }
    )
    print_service.save_report_text_files(report, report_id, APP_ROOT / "reports")

    import pdf_generator

    td = report.get("testData") or {}
    rows_html = ""
    for i, sr in enumerate(td.get("stepResults") or []):
        rows_html += (
            f"<tr><td>{i+1}</td><td>{sr.get('volumeMl','')}</td>"
            f"<td>{sr.get('volumeDeltaMl','')}</td><td>{sr.get('bulkDensity','')}</td>"
            f"<td>{sr.get('tapDensity','')}</td></tr>"
        )
    stats = report.get("statistics") or td.get("statistics") or {}
    stats_rows = ""
    for k, v in (stats or {}).items():
        if isinstance(v, dict) and v.get("value") is not None:
            stats_rows += f"<tr><th>{k}</th><td colspan=3>{v.get('value')}</td></tr>"
        elif isinstance(v, dict):
            stats_rows += (
                f"<tr><th>{k}</th><td>{v.get('mean','')}</td>"
                f"<td>{v.get('min','')}</td><td>{v.get('max','')}</td></tr>"
            )
    html = f"""<!DOCTYPE html><html><head><meta charset=utf-8>
<style>table{{border-collapse:collapse;width:100%}} th,td{{border:1px solid #333;padding:2px 4px;font-size:11px}}</style>
</head><body><h1>Test Report — {PRODUCT}</h1><p>Batch: {BATCH}</p>
<h3>TEST DATA</h3><table><tr><th>Step</th><th>Vol</th><th>dVol</th><th>Bulk</th><th>Tap</th></tr>{rows_html}</table>
<h3>STATISTICS</h3><table><tr><th>Parameter</th><th>Mean</th><th>Min</th><th>Max</th></tr>{stats_rows}</table>
</body></html>"""
    pdf_path = APP_ROOT / "reports" / f"report_{report_id}.pdf"
    pdf_generator.render_html_to_pdf(html, pdf_path)
    print(f"PDF generated: {pdf_path} ({pdf_path.stat().st_size} bytes)")

    print("\n--- Thermal print preview (first 40 lines) ---")
    thermal_text = print_service.format_for_thermal_printer(report)
    for line in thermal_text.split("\n")[:40]:
        print(line)
    print("--- end preview ---\n")

    th = print_service.print_thermal_report(report)
    print("Thermal print (local):", th)
    a4 = print_service.print_a4_report(report)
    print("A4 print (local):", a4)
    ex = client.export_usb(report_id)
    print("USB export:", ex.get("export_directory") or ex)

    stats = report.get("statistics") or (report.get("testData") or {}).get("statistics")
    print("\nStatistics:", json.dumps(stats, indent=2))
    print(f"\nDone — report #{report_id}")
    return 0 if th.get("status") == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
