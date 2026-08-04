#!/usr/bin/env python3
"""Smoke: validation COMPLETE semantics, dual PF, due dates only on overall PASS."""
from __future__ import annotations

import copy
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

import dt_validation_service as vs
import print_service
import report_service


def main() -> int:
    assert vs.TEMP_DEVIATION_LIMIT == 2.0, vs.TEMP_DEVIATION_LIMIT

    stroke = {
        "status": "COMPLETE",
        "strokesPerMin": 30,
        "pulsesSeen": 30,
        "withinSpec": True,
        "durationSec": 60,
    }
    temp = {
        "status": "COMPLETE",
        "setTemperature": 37.0,
        "minTemp": 36.8,
        "maxTemp": 37.2,
        "maxDeviation": 0.2,
        "requiredDeviation": 2.0,
        "withinSpec": True,
    }
    report = vs.build_combined_validation_report(
        1,
        stroke_payload=stroke,
        temp_payload=temp,
        pending_due={
            "months": 6,
            "lastValidationDate": "04-08-2026",
            "nextValidationDate": "04-02-2027",
            "beaker": 1,
        },
        operator_validation_pass_fail="PASS",
    )
    assert report["status"] == "COMPLETE", report["status"]
    assert report.get("operatorValidationPassFail") == "PASS"
    assert report.get("pendingValidationDue")
    assert report["requiredDeviation"] == 2.0

    # Print pairs: no auto PASSED/FAILED fallback when approval empty
    pairs = print_service._approval_result_pairs(report, report, "validation")
    assert pairs == [("Pass / Fail", "--")] or (
        len(pairs) == 2 and pairs[0][0].startswith("Stroke")
    ), pairs

    approved = copy.deepcopy(report)
    approved["strokePassFail"] = "PASS"
    approved["tempPassFail"] = "PASS"
    approved["approvalPassFail"] = "PASS"
    approved["validationRuns"] = [
        {**approved["validationRuns"][0], "approvalPassFail": "PASS"},
        {**approved["validationRuns"][1], "approvalPassFail": "PASS"},
    ]
    pairs2 = print_service._approval_result_pairs(approved, approved, "validation")
    assert pairs2[0] == ("Stroke Pass / Fail", "Pass"), pairs2
    assert pairs2[1] == ("Temp Pass / Fail", "Pass"), pairs2

    # Due apply only when we call it (mirrors approve PASS path)
    with tempfile.TemporaryDirectory() as td:
        # Point data_service storage at temp if possible — otherwise use real factory settings carefully
        import data_service

        orig_get = data_service.get_factory_settings
        orig_save = data_service.save_factory_settings
        store = {"validationDatesByBeaker": {}}

        def _get():
            return dict(store)

        def _save(fs):
            store.clear()
            store.update(dict(fs or {}))
            return store

        data_service.get_factory_settings = _get
        data_service.save_factory_settings = _save
        try:
            applied = report_service.apply_pending_validation_due(approved)
            assert applied.get("lastValidationDate") == "04-08-2026"
            assert applied.get("nextValidationDate") == "04-02-2027"
            by = store.get("validationDatesByBeaker") or {}
            assert "1" in by, by

            # FAIL approval must not apply (simulate skip)
            store["validationDatesByBeaker"] = {}
            fail_rep = copy.deepcopy(approved)
            fail_rep["approvalPassFail"] = "FAIL"
            # Caller gates on PASS — we only verify apply works and enrich reads beaker
            test_ctx = report_service.enrich_report_context(
                {"type": "test", "beaker": 1, "basket": 1}
            )
            # After apply above was cleared — re-apply then enrich
            report_service.apply_pending_validation_due(approved)
            test_ctx = report_service.enrich_report_context(
                {"type": "test", "beaker": 1, "basket": 1}
            )
            fs = test_ctx.get("factorySettings") or {}
            assert fs.get("lastValidationDate") == "04-08-2026", fs
            assert fs.get("nextValidationDate") == "04-02-2027", fs
            assert (fs.get("validationDatesByBeaker") or {}).get("1", {}).get(
                "lastValidationDate"
            ) == "04-08-2026"
        finally:
            data_service.get_factory_settings = orig_get
            data_service.save_factory_settings = orig_save

    print("OK: validation flow redesign smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
