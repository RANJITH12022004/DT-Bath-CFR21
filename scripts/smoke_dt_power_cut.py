#!/usr/bin/env python3
"""Smoke: DT power-cut abort recovery (pending approval, mid-test, dual basket, validation, clean restart)."""
from __future__ import annotations

import copy
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        storage = td_path / "storage"
        reports = td_path / "reports"
        storage.mkdir()
        reports.mkdir()
        cfg = {"STORAGE_DIR": storage, "REPORTS_DIR": reports, "APP_ROOT": str(td_path)}

        import data_service
        import report_service
        import audit_service

        data_service.init(cfg)
        audit_service.init(cfg)

        # Import app helpers after storage is pointed at temp dir
        import app as app_mod

        # Re-bind app's data_service storage (app may have inited earlier against real path)
        data_service.init(cfg)
        if hasattr(app_mod, "REPORTS_DIR"):
            app_mod.REPORTS_DIR = reports

        # ---------- 1) Pending approval → unclean abort ----------
        pending_report = {
            "type": "test",
            "name": "DT pending approval smoke",
            "status": "Completed",
            "beaker": 1,
            "basket": 1,
            "productName": "SmokeProduct",
            "batchNumber": "B1",
            "reportApprovalStatus": "pending",
            "operatorUsername": "op1",
            "operatedByUsername": "op1",
            "operatorName": "Operator One",
        }
        rid = data_service.save_report(pending_report)
        assert rid is not None
        n = app_mod._abort_pending_reports_after_power_loss("op1")
        assert n >= 1, n
        saved = data_service.get_report(rid)
        assert str(saved.get("reportApprovalStatus") or "").lower() == "approved", saved
        assert "power interruption" in str(saved.get("remarks") or "").lower(), saved
        assert "system" in str(saved.get("approvedBy") or "").lower(), saved
        print("OK pending-approval abort")

        # ---------- 2) Mid DT test checkpoint → one aborted report ----------
        before_ids = {r.get("id") for r in (data_service.list_reports("all", include_pending=True) or [])}
        data_service.save_test_run_data(
            {
                "type": "dt_checkpoint",
                "baskets": {
                    "1": {
                        "basket": 1,
                        "state": "RUNNING",
                        "productName": "MidRun",
                        "batchNumber": "M1",
                        "mode": "manual",
                        "basketConfig": 6,
                        "setTemperature": 37.0,
                        "elapsedSeconds": 12,
                        "operatorUsername": "op1",
                        "operatorName": "Operator One",
                        "aborted": False,
                    }
                },
                "reports": [
                    {
                        "type": "test",
                        "status": "running",
                        "beaker": 1,
                        "basket": 1,
                        "name": "MidRun",
                        "productName": "MidRun",
                        "batchNumber": "M1",
                        "operatorUsername": "op1",
                        "operatorName": "Operator One",
                        "_checkpointPhase": "running",
                        "_dtBasket": 1,
                    }
                ],
            }
        )
        created = app_mod._create_aborted_report_from_power_loss_checkpoint("op1")
        assert created >= 1, created
        after = data_service.list_reports("all", include_pending=True) or []
        new_reps = [r for r in after if r.get("id") not in before_ids]
        mid = [r for r in new_reps if r.get("productName") == "MidRun" or r.get("name") == "MidRun"]
        assert mid, new_reps
        assert str(mid[0].get("reportApprovalStatus") or "").lower() == "approved"
        assert "power interruption" in str(mid[0].get("remarks") or "").lower()
        assert not data_service.get_test_run_data()
        print("OK mid-test checkpoint abort")

        # ---------- 3) Dual basket ----------
        before_ids = {r.get("id") for r in (data_service.list_reports("all", include_pending=True) or [])}
        data_service.save_test_run_data(
            {
                "type": "dt_checkpoint",
                "baskets": {
                    "1": {"basket": 1, "state": "RUNNING", "productName": "DualA", "operatorUsername": "op1"},
                    "2": {"basket": 2, "state": "PREHEAT", "productName": "DualB", "operatorUsername": "op1"},
                },
                "reports": [
                    {
                        "type": "test",
                        "status": "running",
                        "beaker": 1,
                        "basket": 1,
                        "productName": "DualA",
                        "name": "DualA",
                        "operatorUsername": "op1",
                        "_dtBasket": 1,
                    },
                    {
                        "type": "test",
                        "status": "running",
                        "beaker": 2,
                        "basket": 2,
                        "productName": "DualB",
                        "name": "DualB",
                        "operatorUsername": "op1",
                        "_dtBasket": 2,
                    },
                ],
            }
        )
        created = app_mod._create_aborted_report_from_power_loss_checkpoint("op1")
        assert created >= 2, created
        after = data_service.list_reports("all", include_pending=True) or []
        new_reps = [r for r in after if r.get("id") not in before_ids]
        products = {r.get("productName") or r.get("name") for r in new_reps}
        assert "DualA" in products and "DualB" in products, products
        print("OK dual-basket checkpoint abort")

        # ---------- 4) Mid validation ----------
        before_ids = {r.get("id") for r in (data_service.list_reports("all", include_pending=True) or [])}
        data_service.save_validation_run_data(
            {
                "type": "validation",
                "validationSubtype": "combined",
                "status": "running",
                "beaker": 1,
                "basket": 1,
                "_checkpointPhase": "temp",
                "phase": "temp",
                "stroke": {
                    "status": "COMPLETE",
                    "strokesPerMin": 30,
                    "pulsesSeen": 30,
                    "beaker": 1,
                },
                "temp": {
                    "status": "HOLDING",
                    "setTemperature": 37.0,
                    "beaker": 1,
                },
                "operatorUsername": "op1",
                "operatorName": "Operator One",
            }
        )
        created = app_mod._create_aborted_report_from_validation_checkpoint("op1")
        assert created == 1, created
        after = data_service.list_reports("all", include_pending=True) or []
        new_reps = [r for r in after if r.get("id") not in before_ids]
        val = [r for r in new_reps if str(r.get("type") or "").lower() == "validation"]
        assert val, new_reps
        assert str(val[0].get("reportApprovalStatus") or "").lower() == "approved"
        assert "power interruption" in str(val[0].get("remarks") or "").lower()
        assert "system" in str(val[0].get("approvedBy") or "").lower()
        assert not data_service.get_validation_run_data()
        print("OK mid-validation checkpoint abort")

        # ---------- 5) Clean restart leaves pending alone ----------
        pending2 = {
            "type": "test",
            "name": "Clean restart keep pending",
            "status": "Completed",
            "beaker": 1,
            "reportApprovalStatus": "pending",
            "operatorUsername": "op1",
            "operatedByUsername": "op1",
        }
        rid2 = data_service.save_report(pending2)
        data_service.write_session_power_audit_pending(
            {"username": "op1", "role": "User", "name": "Operator One"}
        )
        data_service.touch_app_clean_stop_flag()
        # Simulate clean branch of startup (consume flag → clean)
        had_clean = data_service.consume_app_clean_stop_flag()
        assert had_clean is True
        # Do NOT call abort when clean
        kept = data_service.get_report(rid2)
        assert str(kept.get("reportApprovalStatus") or "").lower() == "pending", kept
        print("OK clean restart preserves pending")

        # ---------- 6) Operator-abort pending stays Aborted (not power interruption) ----------
        op_abort = {
            "type": "test",
            "name": "Operator abort pending",
            "status": "aborted",
            "remarks": "Aborted",
            "abortCause": "operator",
            "beaker": 1,
            "reportApprovalStatus": "pending",
            "operatorUsername": "op1",
            "operatedByUsername": "op1",
            "testData": {"status": "aborted", "remarks": "Aborted", "abortCause": "operator"},
        }
        rid3 = data_service.save_report(op_abort)
        app_mod._abort_pending_reports_after_power_loss("op1")
        saved3 = data_service.get_report(rid3)
        assert str(saved3.get("reportApprovalStatus") or "").lower() == "aborted"
        rem = str(saved3.get("remarks") or saved3.get("approvalRemarks") or "").lower()
        assert "power interruption" not in rem, saved3
        assert str(saved3.get("abortCause") or "").lower() in ("operator", ""), saved3
        print("OK operator-abort preserve")

        # ---------- DT persist shape ----------
        import dt_test_service

        dt_test_service.init()
        dt_test_service._set_state(
            1,
            "RUNNING",
            productName="PersistShape",
            batchNumber="P1",
            operatorUsername="op1",
            startedAt="2026-08-04T10:00:00Z",
        )
        cp = data_service.get_test_run_data()
        assert cp.get("type") == "dt_checkpoint", cp
        assert isinstance(cp.get("reports"), list) and cp["reports"], cp
        assert cp["reports"][0].get("status") == "running"
        dt_test_service.clear_run(1)
        # Other basket idle → checkpoint cleared
        assert not data_service.get_test_run_data() or not (
            data_service.get_test_run_data() or {}
        ).get("reports"), data_service.get_test_run_data()
        print("OK dt_checkpoint persist shape")

    print("OK: smoke_dt_power_cut passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
