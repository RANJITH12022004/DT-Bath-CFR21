#!/usr/bin/env python3
"""
report_service.py - Friability Tester report generation and context.
"""

import html as html_module
import json
import pathlib
from datetime import datetime
from typing import Dict, Any, Optional, List

import data_service

_config = {}
_reports_dir = None
_storage_dir = None


def init(config):
    global _config, _reports_dir, _storage_dir
    _config = dict(config)
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "./reports"))
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "./storage"))
    _reports_dir.mkdir(parents=True, exist_ok=True)


def generate_report(
    test_data: Dict[str, Any],
    recipe: Optional[Dict[str, Any]] = None,
    factory_settings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    report = dict(test_data)
    if recipe:
        report["recipe"] = {
            "id": recipe.get("id"),
            "name": recipe.get("name") or recipe.get("productName"),
            "productName": recipe.get("productName"),
            "batchNumber": recipe.get("batchNumber"),
            "unit": recipe.get("unit"),
        }
    if not factory_settings:
        factory_settings = data_service.get_factory_settings()
    report["factorySettings"] = enrich_factory_settings(factory_settings or {})
    if not report.get("createdAt"):
        report["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if not report.get("completedAt"):
        report["completedAt"] = report["createdAt"]
    report = enrich_report_context(report)
    return report


def enrich_factory_settings(factory_settings: Dict[str, Any]) -> Dict[str, Any]:
    fs_in = factory_settings or {}
    enriched = {
        "companyName": fs_in.get("companyName") or "N/A",
        "modelNo": fs_in.get("modelNo") or "N/A",
        "serialNo": fs_in.get("serialNo") or "N/A",
        "companyLocation": fs_in.get("companyLocation") or fs_in.get("location") or "N/A",
        "instrumentId": fs_in.get("instrumentId") or "N/A",
        "lastValidationDate": fs_in.get("lastValidationDate") or "N/A",
        "nextValidationDate": fs_in.get("nextValidationDate") or "N/A",
    }
    dates = _resolve_validation_dates(fs_in)
    if dates.get("lastValidationDate"):
        enriched["lastValidationDate"] = dates["lastValidationDate"]
    if dates.get("nextValidationDate"):
        enriched["nextValidationDate"] = dates["nextValidationDate"]
    return enriched


def format_duration_hhmmss(seconds_val: Any) -> str:
    """Format elapsed seconds as HH:MM:SS for reports."""
    if seconds_val is None:
        return "--"
    try:
        total_s = int(seconds_val)
    except (TypeError, ValueError):
        return "--"
    if total_s < 0:
        return "--"
    h, rem = divmod(total_s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def test_duration_seconds(td: Dict[str, Any]) -> Optional[int]:
    """Resolve test duration in seconds from stored testData."""
    if not isinstance(td, dict):
        return None
    sec = td.get("durationSeconds")
    if sec is not None:
        try:
            return max(0, int(sec))
        except (TypeError, ValueError):
            pass
    start_raw = td.get("testStartTime")
    end_raw = td.get("testEndTime")
    if start_raw and end_raw:
        try:
            start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(end_raw).replace("Z", "+00:00"))
            return max(0, int((end - start).total_seconds()))
        except Exception:
            pass
    return None


def _parse_density_number(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _stat_display_value(val: Dict[str, Any]) -> Any:
    if val.get("value") is not None:
        return val.get("value")
    if val.get("mean") is not None:
        mean = val.get("mean")
        min_v = val.get("min")
        max_v = val.get("max")
        if min_v is not None or max_v is not None:
            return "Avg: {} | Min: {} | Max: {}".format(
                mean,
                min_v if min_v is not None else "--",
                max_v if max_v is not None else "--",
            )
        return mean
    if val.get("Mean") is not None:
        mean = val.get("Mean")
        min_v = val.get("Min")
        max_v = val.get("Max")
        if min_v is not None or max_v is not None:
            return "Avg: {} | Min: {} | Max: {}".format(
                mean,
                min_v if min_v is not None else "--",
                max_v if max_v is not None else "--",
            )
        return mean
    return None


def _recipe_total_tap_count(recipe: Dict[str, Any]) -> Optional[int]:
    if not isinstance(recipe, dict):
        return None
    ct = recipe.get("customTotalTaps")
    if ct is not None and ct != "":
        try:
            n = int(ct)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    steps = recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        return None
    total = 0
    for step in steps:
        if not isinstance(step, dict):
            continue
        try:
            total += int(step.get("tapCount") or 0)
        except (TypeError, ValueError):
            pass
    return total if total > 0 else None


def _agg_mean_min_max(values: List[float]) -> Dict[str, float]:
    if not values:
        return {}
    return {
        "mean": round(sum(values) / len(values), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
    }


def _parse_float(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _format_derived_number(val: Any, decimals: int = 3) -> str:
    if val is None:
        return "--"
    try:
        f = float(val)
        if decimals <= 0:
            return str(int(round(f)))
        fmt = f"{{:.{decimals}f}}"
        s = fmt.format(f)
        return s.rstrip("0").rstrip(".") if "." in s else s
    except (TypeError, ValueError):
        return str(val)


def _report_print_timestamp() -> Dict[str, str]:
    try:
        import rtc_service

        payload = rtc_service.get_device_wall_datetime_payload()
        return {
            "printDate": str(payload.get("date") or "--"),
            "printTime": str(payload.get("time") or "--"),
        }
    except Exception:
        now = datetime.now()
        return {
            "printDate": now.strftime("%d-%m-%Y"),
            "printTime": now.strftime("%H:%M:%S"),
        }


def _test_type_label(recipe: Dict[str, Any], td: Dict[str, Any]) -> str:
    recipe = recipe or {}
    td = td or {}
    mode = str(recipe.get("uspMode") or td.get("uspMode") or "").strip().upper()
    if mode == "USP1":
        return "USP 1"
    if mode == "USP2":
        return "USP 2"
    if mode == "CUSTOM":
        return "Custom"
    usp = str(recipe.get("usp") or td.get("usp") or "").strip()
    if not usp:
        return "--"
    u = usp.upper().replace("  ", " ")
    if u in ("USP1", "USP 1"):
        return "USP 1"
    if u in ("USP2", "USP 2"):
        return "USP 2"
    if "CUSTOM" in u:
        return "Custom"
    return usp


def _test_method_label(recipe: Dict[str, Any], td: Dict[str, Any], test_type: str) -> str:
    recipe = recipe or {}
    td = td or {}
    cyl = recipe.get("cylinder") if isinstance(recipe.get("cylinder"), dict) else {}
    cyl_ml = cyl.get("volume") or cyl.get("volumeMl") or td.get("sampleVolumeMl")
    parts = [test_type] if test_type and test_type != "--" else []
    if cyl_ml not in (None, "", "--"):
        parts.append(f"{cyl_ml} ml cylinder")
    return ", ".join(parts) if parts else "--"


def _drop_height_display(recipe: Dict[str, Any], td: Dict[str, Any]) -> str:
    recipe = recipe or {}
    td = td or {}
    dh = recipe.get("dropHeight")
    steps = recipe.get("steps") or td.get("steps") or []
    if dh is None and isinstance(steps, list) and steps and isinstance(steps[0], dict):
        dh = steps[0].get("dropHeight")
    if dh is None and isinstance(td, dict):
        dh = td.get("dropHeight")
    if dh is None or dh == "":
        return "--"
    try:
        mm = float(dh)
        return f"{_format_derived_number(mm, 0)} mm +/- 0.2 mm"
    except (TypeError, ValueError):
        return str(dh)


def build_test_report_derived(
    td: Optional[Dict[str, Any]],
    recipe: Optional[Dict[str, Any]] = None,
    report_id: Any = None,
) -> Dict[str, Any]:
    """Friability test report fields (weights, rotation, RPM, drums)."""
    td = td if isinstance(td, dict) else {}
    recipe = recipe if isinstance(recipe, dict) else {}
    if not recipe and isinstance(td.get("recipe"), dict):
        recipe = td.get("recipe") or {}

    speed = recipe.get("speed") or td.get("speed")
    if speed is None and isinstance(recipe.get("steps"), list) and recipe["steps"]:
        speed = recipe["steps"][0].get("speed") if isinstance(recipe["steps"][0], dict) else None

    drum_count = td.get("drumCount") or recipe.get("drumCount") or 2
    rotation_count = td.get("rotationCount")
    target_rot = td.get("targetRotations") or recipe.get("tabletCount") or recipe.get("customTotalTaps")
    duration_sec = test_duration_seconds(td)

    ts = _report_print_timestamp()
    return {
        **ts,
        "testType": recipe.get("usp") or td.get("usp") or "Friability",
        "testMethod": td.get("mode") or recipe.get("customCompletionMode") or "COUNT",
        "rpm": speed if speed is not None else "--",
        "drumCount": drum_count,
        "rotationCount": rotation_count if rotation_count is not None else "--",
        "targetRotations": target_rot if target_rot is not None else "--",
        "durationSeconds": duration_sec,
        "durationFormatted": format_duration_hhmmss(duration_sec),
        "initialWeight": td.get("initialWeight"),
        "initialWeight1": td.get("initialWeight1"),
        "initialWeight2": td.get("initialWeight2"),
        "finalWeight": td.get("finalWeight"),
        "weightLoss": td.get("weightLoss"),
        "weightDifference": td.get("weightDifference"),
        "friabilityPercent": td.get("friabilityPercent"),
        "weightTrend": td.get("weightTrend"),
        "batchNumber": td.get("batchNumber") or recipe.get("batchNumber"),
        "batchNumber1": td.get("batchNumber1"),
        "batchNumber2": td.get("batchNumber2"),
        "productName": recipe.get("productName") or td.get("productName"),
    }


def compute_test_report_statistics(test_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Friability statistics from testData."""
    if not isinstance(test_data, dict):
        return None

    stats: Dict[str, Any] = {}
    results = test_data.get("stepResults") or []
    if isinstance(results, list) and results:
        def nums(key: str) -> list:
            out = []
            for row in results:
                if not isinstance(row, dict):
                    continue
                n = _parse_density_number(row.get(key))
                if n is not None:
                    out.append(n)
            return out

        def summary(values: list) -> Optional[Dict[str, Any]]:
            if not values:
                return None
            return {
                "mean": round(sum(values) / len(values), 3),
                "min": round(min(values), 3),
                "max": round(max(values), 3),
            }

        fri_summary = summary(nums("friabilityPercent"))
        if fri_summary:
            stats["Friability (%)"] = fri_summary
        loss_summary = summary(nums("weightLoss"))
        if loss_summary:
            stats["Weight loss (g)"] = loss_summary

        iw = _parse_density_number(test_data.get("initialWeight"))
        fw = _parse_density_number(test_data.get("finalWeight"))
        wl = _parse_density_number(test_data.get("weightLoss"))
        fri = _parse_density_number(test_data.get("friabilityPercent"))
        if fri is not None:
            stats["Overall friability (%)"] = {"value": round(fri, 3)}
        if iw is not None:
            stats["Initial weight total (g)"] = {"value": round(iw, 3)}
        if fw is not None:
            stats["Final weight total (g)"] = {"value": round(fw, 3)}
        if wl is not None:
            stats["Total weight loss (g)"] = {"value": round(wl, 3)}
        drum_count = test_data.get("drumCount")
        if drum_count is not None:
            try:
                stats["Drum count"] = {"value": int(drum_count)}
            except (TypeError, ValueError):
                pass
        rot = test_data.get("rotationCount")
        if rot is not None:
            try:
                stats["Rotations completed"] = {"value": int(rot)}
            except (TypeError, ValueError):
                pass
        return stats if stats else None

    fri = _parse_density_number(test_data.get("friabilityPercent"))
    if fri is not None:
        stats["Friability (%)"] = {"value": round(fri, 3)}
    iw = _parse_density_number(test_data.get("initialWeight"))
    fw = _parse_density_number(test_data.get("finalWeight"))
    if iw is not None:
        stats["Initial weight (g)"] = {"value": round(iw, 3)}
    if fw is not None:
        stats["Final weight (g)"] = {"value": round(fw, 3)}
    wl = _parse_density_number(test_data.get("weightLoss"))
    if wl is not None:
        stats["Weight loss (g)"] = {"value": round(wl, 3)}
    rot = test_data.get("rotationCount")
    if rot is not None:
        try:
            stats["Rotations completed"] = {"value": int(rot)}
        except (TypeError, ValueError):
            pass

    return stats if stats else None


def enrich_report_context(report_data: Dict[str, Any]) -> Dict[str, Any]:
    if not report_data:
        return report_data
    factory_settings = data_service.get_factory_settings()
    fs = report_data.get("factorySettings") or {}
    for k, default in [
        ("companyName", "N/A"),
        ("modelNo", "N/A"),
        ("serialNo", "N/A"),
        ("companyLocation", "N/A"),
        ("instrumentId", "N/A"),
    ]:
        if not fs.get(k):
            fs[k] = factory_settings.get(k) or default
    dates = _resolve_validation_dates({**factory_settings, **fs})
    if dates.get("lastValidationDate"):
        fs["lastValidationDate"] = dates["lastValidationDate"]
    if dates.get("nextValidationDate"):
        fs["nextValidationDate"] = dates["nextValidationDate"]
    report_data["factorySettings"] = fs
    if str(report_data.get("type") or "").strip().lower() == "test":
        td = report_data.get("testData") if isinstance(report_data.get("testData"), dict) else report_data
        if isinstance(td, dict):
            td_remarks = td.get("remarks")
            if td_remarks not in (None, "") and not report_data.get("remarks"):
                report_data["remarks"] = td_remarks
        recipe = report_data.get("recipe") if isinstance(report_data.get("recipe"), dict) else {}
        report_data["reportDerived"] = build_test_report_derived(
            td if isinstance(td, dict) else {},
            recipe,
            report_data.get("id"),
        )
    return report_data


def _parse_report_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _parse_display_date(value: Any) -> Optional[datetime]:
    """Parse DD-MM-YYYY, DD/MM/YYYY, or ISO datetime strings."""
    s = str(value or "").strip()
    if not s or s.upper() == "N/A":
        return None
    for fmt in ("%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s[:10], fmt)
        except Exception:
            continue
    return _parse_report_datetime(value)


def _add_years(dt: datetime, years: int = 1) -> datetime:
    """Add calendar years; Feb 29 rolls to Feb 28 on non-leap years."""
    try:
        return dt.replace(year=dt.year + int(years or 1))
    except ValueError:
        return dt.replace(month=2, day=28, year=dt.year + int(years or 1))


def _validation_dates_from_last(dt: datetime) -> Dict[str, str]:
    """Last validation date and next due exactly one calendar year later."""
    next_dt = _add_years(dt, 1)
    return {
        "lastValidationDate": dt.strftime("%d-%m-%Y"),
        "nextValidationDate": next_dt.strftime("%d-%m-%Y"),
    }


def _resolve_validation_dates(factory_settings: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Single source for validation dates: latest validation report, else stored last; next always +1 year."""
    computed = _compute_validation_dates_from_reports()
    if computed.get("lastValidationDate"):
        return computed
    fs = factory_settings or {}
    last_dt = _parse_display_date(fs.get("lastValidationDate"))
    if last_dt:
        return _validation_dates_from_last(last_dt)
    return {}


def sync_factory_validation_dates() -> Dict[str, str]:
    """Persist resolved validation dates into factory settings storage."""
    stored = data_service.get_factory_settings() or {}
    dates = _resolve_validation_dates(stored)
    if not dates:
        return {}
    updated = dict(stored)
    updated["lastValidationDate"] = dates["lastValidationDate"]
    updated["nextValidationDate"] = dates["nextValidationDate"]
    data_service.save_factory_settings(updated)
    return dates


def _compute_validation_dates_from_reports() -> Dict[str, str]:
    reports = data_service.list_reports("validation")
    latest_dt = None
    for report in reports or []:
        if str(report.get("type") or "").strip().lower() != "validation":
            continue
        td = report.get("testData") or {}
        status_raw = str(td.get("status") or report.get("status") or "").strip().lower()
        if status_raw == "aborted":
            continue
        dt = _parse_report_datetime(
            td.get("completedAt")
            or report.get("completedAt")
            or td.get("createdAt")
            or report.get("createdAt")
        )
        if not dt:
            continue
        if latest_dt is None or dt > latest_dt:
            latest_dt = dt
    if latest_dt is None:
        return {}
    return _validation_dates_from_last(latest_dt)


def get_report_preview_data(report: Dict[str, Any]) -> Dict[str, Any]:
    report = enrich_report_context(dict(report or {}))
    td = report.get("testData") or report
    remarks = report.get("remarks")
    if remarks is None and isinstance(td, dict):
        remarks = td.get("remarks")
    preview = {
        "id": report.get("id"),
        "type": report.get("type", "test"),
        "createdAt": report.get("createdAt"),
        "completedAt": report.get("completedAt"),
        "recipe": report.get("recipe", {}),
        "factorySettings": report.get("factorySettings", {}),
        "testData": report.get("testData", report),
        "statistics": {},
        "status": report.get("status", "PASS"),
        "remarks": remarks,
        "approvedBy": report.get("approvedBy"),
        "approvedAt": report.get("approvedAt"),
        "reportApprovalStatus": report.get("reportApprovalStatus"),
        "approvalPassFail": report.get("approvalPassFail"),
        "drumPassFail": report.get("drumPassFail") or (td.get("drumPassFail") if isinstance(td, dict) else None),
        "approvalRemarks": report.get("approvalRemarks"),
        "operatedByUsername": report.get("operatedByUsername")
        or (td.get("operatedByUsername") if isinstance(td, dict) else None)
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "operatorName": report.get("operatorName")
        or (td.get("operatorName") if isinstance(td, dict) else None),
        "employeeId": report.get("employeeId")
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "reportDerived": report.get("reportDerived")
        or build_test_report_derived(
            td if isinstance(td, dict) else {},
            report.get("recipe") if isinstance(report.get("recipe"), dict) else {},
            report.get("id"),
        ),
    }
    if report.get("type") == "validation":
        preview["validationSubtype"] = report.get("validationSubtype")
        preview["usp"] = report.get("usp")
        preview["tapsMin"] = report.get("tapsMin")
        preview["dropHeight"] = report.get("dropHeight")
        preview["expectedTapCount"] = report.get("expectedTapCount")
        preview["actualTapCount"] = report.get("actualTapCount")
        runs = report.get("validationRuns")
        if not runs and isinstance(td, dict):
            runs = td.get("validationRuns")
        if runs:
            preview["validationRuns"] = runs
    try:
        import print_service

        preview["a4Text"] = print_service.format_for_a4_printer(
            report, include_printed_timestamp=False
        )
    except Exception:
        preview["a4Text"] = ""
    return preview


def _html_esc(value: Any) -> str:
    if value is None or value == "":
        return "N/A"
    return html_module.escape(str(value))


def _format_report_ts(value: Any) -> str:
    s = str(value or "").strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt = datetime.fromisoformat(clean)
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _report_step_row_count(td: Dict[str, Any]) -> int:
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    try:
        cs = int(td.get("completedSteps") or 0)
        return max(0, cs)
    except (TypeError, ValueError):
        return 0


def _validation_details_table_html(preview: Dict[str, Any]) -> str:
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else preview
    runs = preview.get("validationRuns")
    if not runs and isinstance(td, dict):
        runs = td.get("validationRuns")
    rows = []
    if isinstance(runs, list) and runs:
        for run in runs:
            if not isinstance(run, dict):
                continue
            usp = run.get("usp") or ("USP 2" if run.get("validationSubtype") == "load" else "USP 1")
            start_str = _format_report_ts(
                run.get("validationStartTime")
                or run.get("testStartTime")
                or preview.get("validationStartTime")
                or preview.get("createdAt")
            )
            date_str = _format_report_ts(
                run.get("validationEndTime")
                or run.get("testEndTime")
                or run.get("completedAt")
                or preview.get("completedAt")
                or preview.get("createdAt")
            )
            taps_min = run.get("tapsMin", "--")
            drop_h = run.get("dropHeight", "--")
            expected = run.get("expectedTapCount", "--")
            tol = run.get("expectedTolerance")
            expected_disp = (
                "{} (+/- {})".format(expected, tol)
                if tol is not None and expected not in (None, "", "--")
                else expected
            )
            actual = run.get("actualTapCount", "--")
            status = run.get("status", "--")
            rows.append('<tr><th colspan="4" class="usp-hdr">{} validation</th></tr>'.format(_html_esc(usp)))
            rows.append('<tr><th>Start Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(start_str)))
            rows.append('<tr><th>End Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
            rows.append(
                "<tr><th>USP</th><td>{}</td><th>Taps/Min</th><td>{}</td></tr>".format(
                    _html_esc(usp), _html_esc(taps_min)
                )
            )
            rows.append(
                "<tr><th>Drop Height (mm)</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                    _html_esc(drop_h), _html_esc(status)
                )
            )
            rows.append(
                "<tr><th>Expected Tap Count</th><td>{}</td><th>Actual Tap Count</th><td>{}</td></tr>".format(
                    _html_esc(expected_disp), _html_esc(actual)
                )
            )
    elif isinstance(td, dict):
        start_str = _format_report_ts(
            td.get("validationStartTime")
            or td.get("testStartTime")
            or preview.get("validationStartTime")
            or preview.get("createdAt")
        )
        date_str = _format_report_ts(
            td.get("validationEndTime")
            or td.get("testEndTime")
            or td.get("completedAt")
            or preview.get("completedAt")
            or preview.get("createdAt")
        )
        usp = td.get("usp") or preview.get("usp") or "--"
        taps_min = td.get("tapsMin", preview.get("tapsMin", "--"))
        drop_h = td.get("dropHeight", preview.get("dropHeight", "--"))
        expected = td.get("expectedTapCount", preview.get("expectedTapCount", "--"))
        tol = td.get("expectedTolerance", preview.get("expectedTolerance"))
        expected_disp = (
            "{} (+/- {})".format(expected, tol)
            if tol is not None and expected not in (None, "", "--")
            else expected
        )
        actual = td.get("actualTapCount", preview.get("actualTapCount", "--"))
        status = td.get("status") or preview.get("status") or "--"
        rows.append('<tr><th>Start Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(start_str)))
        rows.append('<tr><th>End Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
        rows.append(
            "<tr><th>USP</th><td>{}</td><th>Taps/Min</th><td>{}</td></tr>".format(
                _html_esc(usp), _html_esc(taps_min)
            )
        )
        rows.append(
            "<tr><th>Drop Height (mm)</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                _html_esc(drop_h), _html_esc(status)
            )
        )
        rows.append(
            "<tr><th>Expected Tap Count</th><td>{}</td><th>Actual Tap Count</th><td>{}</td></tr>".format(
                _html_esc(expected_disp), _html_esc(actual)
            )
        )
    return "".join(rows) if rows else '<tr><td colspan="4">No validation data</td></tr>'


def _derived_summary_html(derived: Dict[str, Any]) -> str:
    if not isinstance(derived, dict):
        return ""
    total_taps = derived.get("totalTaps")
    total_taps_str = str(total_taps) if total_taps is not None else "--"
    return (
        '<h3>TEST SUMMARY</h3>'
        '<table class="ident">'
        '<tr><th>Sample Weight (g)</th><td>{w}</td><th>Total No. of Drops</th><td>{drops}</td></tr>'
        '<tr><th>Initial Volume (V₀) (ml)</th><td>{v0}</td><th>Diff. of Last Two Volumes (ml)</th><td>{diff}</td></tr>'
        '</table>'
    ).format(
        w=_html_esc(_format_derived_number(derived.get("sampleWeightG"), 2)),
        drops=_html_esc(total_taps_str),
        v0=_html_esc(_format_derived_number(derived.get("initialVolumeMl"), 4)),
        diff=_html_esc(_format_derived_number(derived.get("diffLastTwoVolumesMl"), 4)),
    )


def _derived_test_result_html(derived: Dict[str, Any]) -> str:
    if not isinstance(derived, dict):
        return ""
    return (
        '<h3>TEST RESULT</h3>'
        '<table class="ident">'
        '<tr><th>Final Volume (Vf) (ml)</th><td>{vf}</td>'
        '<th>Initial Density (W/V₀) (g/mL)</th><td>{id}</td></tr>'
        '<tr><th>Tapped Density (W/Vf) (g/mL)</th><td>{td}</td>'
        '<th>Compressibility Index (%)</th><td>{ci}</td></tr>'
        '<tr><th>Hausner Ratio (V₀/Vf)</th><td colspan="3">{hr}</td></tr>'
        '</table>'
    ).format(
        vf=_html_esc(_format_derived_number(derived.get("finalVolumeMl"), 4)),
        id=_html_esc(_format_derived_number(derived.get("initialDensityGPerMl"), 3)),
        td=_html_esc(_format_derived_number(derived.get("tappedDensityGPerMl"), 3)),
        ci=_html_esc(_format_derived_number(derived.get("compressibilityIndexPct"), 2)),
        hr=_html_esc(_format_derived_number(derived.get("hausnerRatio"), 3)),
    )


def build_report_pdf_html(report: Dict[str, Any]) -> str:
    """
    Build PDF HTML from the A4 text formatter output (====, ----, ****).
    Omits the printed date/time footer used on dot-matrix A4 printouts.
    """
    import print_service

    enriched = enrich_report_context(dict(report or {}))
    a4_text = print_service.format_for_a4_printer(
        enriched, include_printed_timestamp=False
    ).rstrip()
    escaped = html_module.escape(a4_text)

    css = (
        "@page{size:A4;margin:8mm 8mm;}"
        "body{margin:0;color:#000;background:#fff;font-family:'Courier New',Courier,monospace;font-size:9.5pt;line-height:1.15;}"
        "pre{margin:0;white-space:pre;tab-size:4;letter-spacing:0;}"
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>'
        '<style>{}</style></head><body><pre>{}</pre></body></html>'
    ).format(css, escaped)


def create_pdf_report(report_data: Dict[str, Any], template_type: str = "standard") -> Optional[pathlib.Path]:
    try:
        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        recipe_name = report_data.get("recipe", {}).get("productName", "report")
        safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
        filename = f"{safe_name}_{timestamp}.json"
        pdf_path = _reports_dir / filename
        with open(pdf_path, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2, ensure_ascii=False)
        return pdf_path
    except Exception:
        return None


def export_reports_to_usb(report_ids: List[int], export_path: str) -> Dict[str, Any]:
    try:
        export_dir = pathlib.Path(export_path)
        export_dir.mkdir(parents=True, exist_ok=True)
        exported_files = []
        for report_id in report_ids:
            report = data_service.get_report(report_id)
            if not report:
                continue
            timestamp = report.get("createdAt", datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
            safe_ts = "".join(c for c in str(timestamp) if c.isalnum() or c in "-_.T")
            recipe_name = report.get("recipe", {}).get("productName", "report")
            safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
            filename = f"{safe_name}_{report_id}_{safe_ts}.json"
            export_file = export_dir / filename
            with open(export_file, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            exported_files.append(str(export_file))
        return {"success": True, "exported_files": exported_files, "count": len(exported_files)}
    except Exception as e:
        return {"success": False, "error": str(e)}
