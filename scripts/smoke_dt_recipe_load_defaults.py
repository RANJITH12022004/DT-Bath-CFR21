#!/usr/bin/env python3
"""Smoke: same recipe on both beakers keeps matching mode + timer defaults.

Manual → elapsed 0 / remaining None (count up only while RUNNING).
Timer  → remaining = set duration (count down only while RUNNING).
Stale leftover timer params must not leak onto the other beaker.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["DT_HARDWARE_MOCK"] = "1"


def _fmt_sec(s) -> str:
    s = max(0, int(s or 0))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def dashboard_timer_from_run(run: dict, fallback_mode: str, fallback_dur) -> str:
    """Mirrors dt_client.js dashboardTimerFromRun."""
    mode = str(run.get("mode") or fallback_mode or "manual").strip().lower()
    if mode != "timer":
        mode = "manual"
    state = str(run.get("state") or "").upper()
    if mode == "timer":
        if state == "RUNNING" and run.get("remainingSeconds") is not None:
            return _fmt_sec(run.get("remainingSeconds"))
        dur = run.get("setDurationMinutes")
        if dur is None:
            dur = fallback_dur
        if dur is not None and float(dur) > 0:
            return _fmt_sec(round(float(dur) * 60))
        return "00:00:00"
    if state == "RUNNING":
        return _fmt_sec(run.get("elapsedSeconds"))
    return "00:00:00"


def main() -> int:
    import calculation_service
    import dt_test_service as dts

    # --- recipe storage defaults ---
    timer_recipe = calculation_service.process_recipe_form_data(
        {"name": "Para", "temp": 37, "mode": "TIMER", "setDuration": "00:30:00"}
    )
    assert timer_recipe["mode"] == "timer", timer_recipe
    assert abs(float(timer_recipe["duration"]) - 30.0) < 0.01, timer_recipe
    assert timer_recipe["setDuration"] == "00:30:00", timer_recipe

    manual_recipe = calculation_service.process_recipe_form_data(
        {"name": "Para", "temp": 37, "mode": "manual", "setDuration": "00:30:00", "duration": 30}
    )
    assert manual_recipe["mode"] == "manual", manual_recipe
    assert manual_recipe["duration"] is None, manual_recipe
    assert manual_recipe["setDuration"] is None, manual_recipe
    print("OK recipe form defaults (timer keeps duration, manual clears it)")

    assert dts._normalized_mode("TIMER") == "timer"
    assert dts._normalized_mode("Manual") == "manual"
    assert dts._remaining_seconds_for_timer("timer", 30) == 1800
    assert dts._remaining_seconds_for_timer("manual", 30) is None
    print("OK mode/remaining helpers")

    with tempfile.TemporaryDirectory() as td:
        storage = Path(td) / "storage"
        reports = Path(td) / "reports"
        storage.mkdir()
        reports.mkdir()
        import data_service

        data_service.init({"STORAGE_DIR": storage, "REPORTS_DIR": reports, "APP_ROOT": td})
        dts.init()
        dts.reset_all_runs_after_power_loss()

        # Same timer recipe loaded conceptually on both beakers (independent runs).
        for b in (1, 2):
            res = dts.start_preheat(
                b,
                set_temperature=37.0,
                mode="TIMER",
                duration_minutes=30,
                product_name="Para",
                batch_number="B1",
            )
            assert res.get("ok"), res
            run = res["run"]
            assert dts._normalized_mode(run.get("mode")) == "timer", run
            assert run.get("elapsedSeconds") == 0, run
            assert run.get("remainingSeconds") == 1800, run
            assert dashboard_timer_from_run(run, "timer", 30) == "00:30:00", run
        print("OK both beakers timer recipe: display 00:30:00, remaining=1800")

        # Stale leftover: basket 2 previously timer, reload as manual via setup
        setup = dts.apply_run_setup(2, mode="manual", product_name="Para", batch_number="B1")
        assert setup.get("ok"), setup
        run2 = setup["run"]
        assert dts._normalized_mode(run2.get("mode")) == "manual", run2
        assert run2.get("remainingSeconds") is None, run2
        assert dashboard_timer_from_run(run2, "manual", None) == "00:00:00", run2
        run1 = dts.get_run(1)
        assert dts._normalized_mode(run1.get("mode")) == "timer", run1
        assert dashboard_timer_from_run(run1, "timer", 30) == "00:30:00", run1
        print("OK leftover timer on B2 cleared to manual; B1 stays timer")

        dts.reset_all_runs_after_power_loss()
        r = dts.start_preheat(
            1, set_temperature=37.0, mode="manual", product_name="M1", batch_number="X"
        )
        assert r.get("ok"), r
        run = r["run"]
        assert run.get("remainingSeconds") is None, run
        assert dashboard_timer_from_run(run, "manual", None) == "00:00:00"
        # Confirm start: countdown/count-up begins at 0 / full duration
        # cmd_start may fail without ESP; still check fields if ok
        started = dts.confirm_start(1)
        if started.get("ok"):
            srun = started["run"]
            assert srun.get("elapsedSeconds") == 0, srun
            assert dashboard_timer_from_run(srun, "manual", None) == "00:00:00"
            print("OK manual confirm starts at 00:00:00")
        else:
            print("OK manual preheat defaults (confirm skipped: {})".format(started.get("error")))

        dts.reset_all_runs_after_power_loss()
        r = dts.start_preheat(
            1,
            set_temperature=37.0,
            mode="timer",
            duration_minutes=0.5,
            product_name="T1",
            batch_number="Y",
        )
        assert r.get("ok"), r
        assert r["run"].get("remainingSeconds") == 30, r["run"]
        started = dts.confirm_start(1)
        if started.get("ok"):
            srun = started["run"]
            assert srun.get("elapsedSeconds") == 0, srun
            assert srun.get("remainingSeconds") == 30, srun
            assert dashboard_timer_from_run(srun, "timer", 0.5) == "00:00:30"
            print("OK timer confirm starts at set duration (descending from 00:00:30)")
        else:
            print("OK timer preheat remaining=30 (confirm skipped: {})".format(started.get("error")))

    src = (ROOT / "dt_client.js").read_text(encoding="utf-8")
    for needle in (
        "function applyBasketTimerDisplay",
        "function dashboardTimerFromRun",
        "DT._runParams[b] = {",
        "Mode is set by the loaded recipe",
        "normalizeDtMode(recipe.mode)",
    ):
        assert needle in src, "missing client guard: {}".format(needle)
    print("OK dt_client.js recipe-load guards present")
    print("OK: smoke_dt_recipe_load_defaults passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
