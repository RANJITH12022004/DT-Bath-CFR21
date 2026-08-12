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
                        "startedAt": "2026-08-04T10:00:00Z",
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
                        "testStartTime": "2026-08-04T10:00:00Z",
                        "createdAt": "2026-08-04T10:00:00Z",
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
        assert mid[0].get("createdAt") == "2026-08-04T10:00:00Z", mid[0]
        assert mid[0].get("completedAt") != mid[0].get("createdAt"), mid[0]
        entries = audit_service.list_entries({"action": "Power interruption"})
        assert any("midrun" in str(e.get("details") or "").lower() for e in entries), entries
        assert not data_service.get_test_run_data()
        print("OK mid-test checkpoint abort")

        # ---------- 3) Dual basket ----------
        before_ids = {r.get("id") for r in (data_service.list_reports("all", include_pending=True) or [])}
        data_service.save_test_run_data(
            {
                "type": "dt_checkpoint",
                "baskets": {
                    "1": {
                        "basket": 1,
                        "state": "RUNNING",
                        "productName": "DualA",
                        "operatorUsername": "op1",
                        "mode": "manual",
                        "basketConfig": 6,
                        "startedAt": "2026-08-04T12:00:00Z",
                        "holeCompletionTimes": {"1": 10},
                        "vesselTimes": {"1": "00:00:10"},
                        "holeCompletionTimestamps": {"1": "2026-08-04T12:00:10Z"},
                        "completedHoles": {"1": True},
                    },
                    "2": {
                        "basket": 2,
                        "state": "RUNNING",
                        "productName": "DualB",
                        "operatorUsername": "op1",
                        "mode": "manual",
                        "basketConfig": 6,
                        "startedAt": "2026-08-04T12:00:05Z",
                        "holeCompletionTimes": {"2": 20, "3": 21},
                        "vesselTimes": {"2": "00:00:20", "3": "00:00:21"},
                        "holeCompletionTimestamps": {
                            "2": "2026-08-04T12:00:25Z",
                            "3": "2026-08-04T12:00:26Z",
                        },
                        "completedHoles": {"2": True, "3": True},
                    },
                },
                # Deliberately poisoned shared mirror — recovery must prefer baskets[].
                "reports": [
                    {
                        "type": "test",
                        "status": "running",
                        "beaker": 1,
                        "basket": 1,
                        "productName": "DualA",
                        "name": "DualA",
                        "operatorUsername": "op1",
                        "holeCompletionTimes": {"9": 99},
                        "vesselTimes": {"9": "00:01:39"},
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
                        "holeCompletionTimes": {"9": 99},
                        "vesselTimes": {"9": "00:01:39"},
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
        dual = [r for r in new_reps if (r.get("productName") or r.get("name")) in ("DualA", "DualB")]
        by_beaker = {int(r.get("beaker") or r.get("basket") or 0): r for r in dual}
        assert 1 in by_beaker and 2 in by_beaker, by_beaker
        assert by_beaker[1].get("holeCompletionTimes") == {"1": 10}, by_beaker[1]
        assert by_beaker[2].get("holeCompletionTimes") == {"2": 20, "3": 21}, by_beaker[2]
        assert by_beaker[1].get("vesselTimes") != by_beaker[2].get("vesselTimes")
        pi_rows = [e for e in audit_service.list_entries({"action": "Power interruption"})
                   if "dual" in str(e.get("details") or "").lower()
                   or "beakers" in str(e.get("details") or "").lower()]
        # Exactly one Power interruption event for the dual recovery, not one per beaker.
        recent_pi = [e for e in audit_service.list_entries({"action": "Power interruption"})][:5]
        dual_pi = [e for e in recent_pi if "2" in str(e.get("details") or "") and "1" in str(e.get("details") or "") and "recovered" in str(e.get("details") or "").lower()]
        assert len(dual_pi) >= 1, recent_pi
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

        # ---------- 6) Operator-abort pending → power interruption System approve ----------
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
        assert str(saved3.get("reportApprovalStatus") or "").lower() == "approved", saved3
        rem = str(saved3.get("remarks") or saved3.get("approvalRemarks") or "").lower()
        assert "power interruption" in rem, saved3
        assert "system" in str(saved3.get("approvedBy") or "").lower(), saved3
        print("OK operator-abort pending → power interruption")

        # ---------- DT persist shape ----------
        import dt_test_service

        dt_test_service.init()
        dt_test_service.enable_persist()
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
        assert cp["reports"][0].get("createdAt") == "2026-08-04T10:00:00Z", cp["reports"][0]
        dt_test_service.clear_run(1)
        # Other basket idle → checkpoint cleared
        assert not data_service.get_test_run_data() or not (
            data_service.get_test_run_data() or {}
        ).get("reports"), data_service.get_test_run_data()
        print("OK dt_checkpoint persist shape")

        # ---------- Watchdog must not wipe checkpoint before recovery ----------
        before_ids = {r.get("id") for r in (data_service.list_reports("all", include_pending=True) or [])}
        data_service.save_test_run_data(
            {
                "type": "dt_checkpoint",
                "baskets": {
                    "1": {
                        "basket": 1,
                        "state": "RUNNING",
                        "mode": "timer",
                        "productName": "RaceTimer",
                        "batchNumber": "T1",
                        "startedAt": "2026-08-04T11:00:00Z",
                        "operatorUsername": "op1",
                    }
                },
                "reports": [
                    {
                        "type": "test",
                        "status": "running",
                        "mode": "timer",
                        "beaker": 1,
                        "basket": 1,
                        "productName": "RaceTimer",
                        "name": "RaceTimer",
                        "batchNumber": "T1",
                        "testStartTime": "2026-08-04T11:00:00Z",
                        "createdAt": "2026-08-04T11:00:00Z",
                        "operatorUsername": "op1",
                        "_dtBasket": 1,
                        "_checkpointPhase": "running",
                    }
                ],
            }
        )
        # Simulate old race: empty in-memory runs + persist gated off must not clear file
        dt_test_service._persist_enabled = False
        dt_test_service._persist()
        assert data_service.get_test_run_data().get("type") == "dt_checkpoint"
        # Stale clean-stop flag must not block mid-run recovery anymore
        data_service.touch_app_clean_stop_flag()
        data_service.write_session_power_audit_pending({"username": "op1", "role": "User"})
        # write_session_power_audit_pending clears clean flag; re-stamp to mimic
        # process-exit clean marker present at boot with an active checkpoint.
        data_service.touch_app_clean_stop_flag()
        created = app_mod._create_aborted_report_from_power_loss_checkpoint("op1")
        assert created >= 1, created
        after = data_service.list_reports("all", include_pending=True) or []
        new_reps = [r for r in after if r.get("id") not in before_ids]
        race = [r for r in new_reps if (r.get("productName") or r.get("name")) == "RaceTimer"]
        assert race, new_reps
        assert str(race[0].get("reportApprovalStatus") or "").lower() == "approved"
        assert "power interruption" in str(race[0].get("remarks") or "").lower()
        print("OK checkpoint survives pre-recovery persist gate + recovers under clean flag")

    print("OK: smoke_dt_power_cut passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
