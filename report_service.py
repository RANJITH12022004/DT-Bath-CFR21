#!/usr/bin/env python3
"""
report_service.py - Tap Density report generation and context.
"""

import html as html_module
import json
import pathlib
from datetime import datetime, timezone
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
    td = report.get("testData") if isinstance(report.get("testData"), dict) else {}
    if recipe:
        # Keep speed/USP/drums on the stub — print/preview derived RPM reads these.
        # Full recipe also remains under testData.recipe from the client payload.
        # Prefer non-null recipe fields; fall back to test_data so stubs never blank prints.
        report["recipe"] = {
            "id": recipe.get("id"),
            "name": recipe.get("name") or recipe.get("productName") or test_data.get("name") or test_data.get("productName"),
            "productName": recipe.get("productName") or test_data.get("productName") or test_data.get("name"),
            "batchNumber": recipe.get("batchNumber") or test_data.get("batchNumber"),
            "media": recipe.get("media") if recipe.get("media") is not None else test_data.get("media"),
            "mesh": recipe.get("mesh") if recipe.get("mesh") is not None else test_data.get("mesh"),
            "unit": recipe.get("unit"),
            "speed": recipe.get("speed"),
            "usp": recipe.get("usp"),
            "uspMode": recipe.get("uspMode"),
            "drumCount": recipe.get("drumCount"),
            "quickTest": recipe.get("quickTest"),
        }
    if not factory_settings:
        factory_settings = data_service.get_factory_settings()
    report["factorySettings"] = enrich_factory_settings(factory_settings or {})
    start_ts = (
        report.get("validationStartTime")
        or report.get("testStartTime")
        or td.get("validationStartTime")
        or td.get("testStartTime")
    )
    end_ts = (
        report.get("validationEndTime")
        or report.get("testEndTime")
        or td.get("validationEndTime")
        or td.get("testEndTime")
    )
    if not report.get("createdAt"):
        report["createdAt"] = start_ts or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if not report.get("completedAt") and end_ts:
        report["completedAt"] = end_ts
    report = enrich_report_context(report)
    return report


def enrich_factory_settings(factory_settings: Dict[str, Any], beaker: Any = None) -> Dict[str, Any]:
    """Merge display defaults; keep policy fields (auto logout, password reset period, etc.)."""
    fs_in = dict(factory_settings or {})
    out = dict(fs_in)
    out.update(
        {
            "companyName": fs_in.get("companyName") or "N/A",
            "modelNo": fs_in.get("modelNo") or "N/A",
            "serialNo": fs_in.get("serialNo") or "N/A",
            "companyLocation": fs_in.get("companyLocation") or fs_in.get("location") or "N/A",
            "instrumentId": fs_in.get("instrumentId") or "N/A",
            "lastValidationDate": fs_in.get("lastValidationDate") or "N/A",
            "nextValidationDate": fs_in.get("nextValidationDate") or "N/A",
        }
    )
    # Prefer per-beaker dates when beaker is known
    beaker_dates = get_beaker_validation_dates(fs_in, beaker) if beaker is not None else {}
    if beaker_dates.get("lastValidationDate"):
        out["lastValidationDate"] = beaker_dates["lastValidationDate"]
    if beaker_dates.get("nextValidationDate"):
        out["nextValidationDate"] = beaker_dates["nextValidationDate"]
    if beaker is None:
        dates = _resolve_validation_dates(fs_in)
        if dates.get("lastValidationDate"):
            out["lastValidationDate"] = dates["lastValidationDate"]
        if dates.get("nextValidationDate"):
            out["nextValidationDate"] = dates["nextValidationDate"]
    if isinstance(fs_in.get("validationDatesByBeaker"), dict):
        out["validationDatesByBeaker"] = fs_in["validationDatesByBeaker"]
    return out


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
        return val.get("mean")
    if val.get("Mean") is not None:
        return val.get("Mean")
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
            "printDate": _format_display_date(payload.get("date")) if payload.get("date") else "--",
            "printTime": str(payload.get("time") or "--"),
        }
    except Exception:
        now = datetime.now()
        return {
            "printDate": now.strftime("%d/%m/%Y"),
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


def completed_step_count(td: Dict[str, Any]) -> int:
    """Number of recipe steps that actually ran (recorded in the report)."""
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    try:
        return max(0, int(td.get("completedSteps") or 0))
    except (TypeError, ValueError):
        return 0


def _recipe_steps_for_report(td: Dict[str, Any], recipe: Dict[str, Any]) -> list:
    steps = recipe.get("steps") if isinstance(recipe, dict) else []
    if not isinstance(steps, list) or not steps:
        steps = td.get("steps") if isinstance(td, dict) else []
    return steps if isinstance(steps, list) else []


def performed_total_drops(td: Dict[str, Any], recipe: Dict[str, Any]) -> Optional[int]:
    """Sum per-step drop counts for completed steps only (not planned recipe total)."""
    if not isinstance(td, dict):
        return None
    n = completed_step_count(td)
    if n <= 0:
        return None
    results = td.get("stepResults") or []
    if not isinstance(results, list):
        results = []
    steps = _recipe_steps_for_report(td, recipe if isinstance(recipe, dict) else {})
    total = 0
    found = False
    for i in range(n):
        step_taps = None
        if i < len(steps) and isinstance(steps[i], dict):
            step_taps = steps[i].get("tapCount")
        if step_taps in (None, "") and i < len(results) and isinstance(results[i], dict):
            step_taps = results[i].get("tapCount")
        try:
            val = int(step_taps)
            if val > 0:
                total += val
                found = True
        except (TypeError, ValueError):
            continue
    return total if found else None


def completed_step_drop_counts(td: Dict[str, Any], recipe: Dict[str, Any]) -> List[Any]:
    """Per-step drop counts for completed steps only."""
    n = completed_step_count(td)
    if n <= 0:
        return []
    steps = _recipe_steps_for_report(td, recipe if isinstance(recipe, dict) else {})
    counts: List[Any] = []
    results = td.get("stepResults") or []
    if not isinstance(results, list):
        results = []
    for i in range(n):
        step_taps = None
        if i < len(steps) and isinstance(steps[i], dict):
            step_taps = steps[i].get("tapCount")
        if step_taps in (None, "") and i < len(results) and isinstance(results[i], dict):
            step_taps = results[i].get("tapCount")
        if step_taps is not None:
            counts.append(step_taps)
    return counts


def resolve_initial_volume_ml(td: Dict[str, Any]) -> Optional[float]:
    """V₀ from weight-entry volume; not the first step reading unless legacy data lacks V₀."""
    if not isinstance(td, dict):
        return None
    initial_vol = _parse_float(td.get("initialVolumeMl"))
    if initial_vol is not None and initial_vol > 0:
        return initial_vol
    results = td.get("stepResults") or []
    if isinstance(results, list) and results and isinstance(results[0], dict):
        legacy = _parse_float(results[0].get("volumeMl"))
        if legacy is not None and legacy > 0:
            return legacy
    return None


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


def _merge_recipe_for_derived(
    td: Dict[str, Any], recipe: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Prefer full embedded testData.recipe when top-level recipe was stripped."""
    recipe = recipe if isinstance(recipe, dict) else {}
    td_recipe = td.get("recipe") if isinstance(td.get("recipe"), dict) else {}
    if td_recipe:
        merged = dict(td_recipe)
        for k, v in recipe.items():
            if v not in (None, ""):
                merged[k] = v
        return merged
    return dict(recipe)


def _resolve_report_rpm(recipe: Dict[str, Any], td: Dict[str, Any]) -> Any:
    """RPM from recipe.speed, testData.speed/rpm, or first step speed (quick + saved recipes)."""
    speed = recipe.get("speed")
    if speed in (None, ""):
        speed = td.get("speed")
    if speed in (None, ""):
        speed = td.get("rpm")
    steps = recipe.get("steps") or td.get("steps") or []
    if speed in (None, "") and isinstance(steps, list) and steps and isinstance(steps[0], dict):
        speed = steps[0].get("speed")
    return speed


def _resolve_basket_number(*sources: Any) -> Optional[int]:
    """First valid beaker/basket (1 or 2) found across report / testData dicts."""
    for src in sources:
        if not isinstance(src, dict):
            continue
        for key in ("beaker", "basket"):
            try:
                b = int(src.get(key))
                if b in (1, 2):
                    return b
            except (TypeError, ValueError):
                continue
    return None


def _resolve_set_temperature(*sources: Any) -> Any:
    """First non-empty set temperature from report / testData / recipe dicts."""
    for src in sources:
        if not isinstance(src, dict):
            continue
        for key in ("setTemperature", "temp", "temperature"):
            val = src.get(key)
            if val in (None, "", "--"):
                continue
            return val
    return None


def build_test_report_derived(
    td: Optional[Dict[str, Any]],
    recipe: Optional[Dict[str, Any]] = None,
    report_id: Any = None,
    report: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Disintegration test report fields (basket, temp, mode, vessel times)."""
    td = td if isinstance(td, dict) else {}
    report = report if isinstance(report, dict) else {}
    recipe = _merge_recipe_for_derived(td, recipe)

    basket = _resolve_basket_number(report, td) or 1
    mode = (
        report.get("mode")
        or td.get("mode")
        or recipe.get("mode")
        or "manual"
    )
    set_temp = _resolve_set_temperature(report, td, recipe)
    duration_sec = td.get("durationSeconds")
    if duration_sec in (None, ""):
        duration_sec = report.get("durationSeconds")
    if duration_sec in (None, ""):
        duration_sec = test_duration_seconds(td)
    set_dur = td.get("setDuration") or td.get("setDurationMinutes") or report.get("setDuration") or report.get("setDurationMinutes")
    if set_dur in (None, "") and recipe.get("duration") not in (None, ""):
        try:
            set_dur = float(recipe.get("duration")) * 60
        except (TypeError, ValueError):
            set_dur = recipe.get("duration")

    test_no = "--"
    if report_id is not None:
        try:
            test_no = f"{int(report_id):04d}"
        except (TypeError, ValueError):
            test_no = str(report_id)

    duration_formatted = td.get("duration") or report.get("duration") or format_duration_hhmmss(duration_sec)

    media = (
        report.get("media")
        or td.get("media")
        or recipe.get("media")
    )
    mesh = (
        report.get("mesh")
        or td.get("mesh")
        or recipe.get("mesh")
    )

    ts = _report_print_timestamp()
    return {
        **ts,
        "testNumber": test_no,
        "testType": "Disintegration",
        "testMethod": str(mode).upper(),
        "mode": mode,
        "basket": basket,
        "beaker": basket,
        "basketConfig": td.get("basketConfig") or report.get("basketConfig") or 6,
        "setTemperature": set_temp if set_temp not in (None, "") else "--",
        "minTemp": td.get("minTemp") if td.get("minTemp") is not None else report.get("minTemp"),
        "maxTemp": td.get("maxTemp") if td.get("maxTemp") is not None else report.get("maxTemp"),
        "meanTemp": td.get("meanTemp") if td.get("meanTemp") is not None else report.get("meanTemp"),
        "setDuration": set_dur,
        "durationSeconds": duration_sec,
        "durationFormatted": duration_formatted,
        "vesselTimes": td.get("vesselTimes") or report.get("vesselTimes") or {},
        "holeCompletionTimes": td.get("holeCompletionTimes") or report.get("holeCompletionTimes") or {},
        "batchNumber": (
            report.get("batchNumber")
            or td.get("batchNumber")
            or recipe.get("batchNumber")
            or td.get("batch1")
            or td.get("batch2")
            or report.get("batch1")
            or report.get("batch2")
        ),
        "productName": (
            report.get("productName")
            or report.get("name")
            or td.get("productName")
            or recipe.get("productName")
            or recipe.get("name")
            or td.get("name")
        ),
        "media": media,
        "mesh": mesh,
    }


def _format_elapsed_hhmmss(seconds: Any) -> str:
    try:
        sec = max(0, int(seconds))
    except (TypeError, ValueError):
        return "--"
    hh = sec // 3600
    mm = (sec % 3600) // 60
    ss = sec % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def _tap_times_seconds(test_data: Dict[str, Any]) -> list:
    """Ordered tube-tap elapsed times (seconds) from holeCompletionTimes or vesselTimes."""
    times: list = []
    hct = test_data.get("holeCompletionTimes") or {}
    if isinstance(hct, dict) and hct:
        for v in hct.values():
            try:
                times.append(int(v))
            except (TypeError, ValueError):
                continue
        times.sort()
        return times
    vt = test_data.get("vesselTimes") or {}
    if isinstance(vt, dict) and vt:
        parsed = []
        for v in vt.values():
            s = str(v or "").strip()
            parts = s.split(":")
            try:
                if len(parts) == 3:
                    parsed.append(int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2]))
                elif len(parts) == 2:
                    parsed.append(int(parts[0]) * 60 + int(parts[1]))
            except (TypeError, ValueError):
                continue
        parsed.sort()
        return parsed
    return times


def compute_test_report_statistics(test_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Manual-mode tube-completion statistics for disintegration reports.
    Timer mode → no statistics. First = earliest, Last = latest, Mean = average of tube times.
    """
    if not isinstance(test_data, dict):
        return None

    mode = str(test_data.get("mode") or "").strip().lower()
    if mode == "timer":
        return None

    times = _tap_times_seconds(test_data)
    # Also consider overall elapsed if no tube taps were recorded
    if not times:
        try:
            elapsed = int(test_data.get("durationSeconds"))
            if elapsed >= 0:
                times = [elapsed]
        except (TypeError, ValueError):
            pass

    first = _format_elapsed_hhmmss(times[0]) if len(times) >= 1 else "N/A"
    last = _format_elapsed_hhmmss(times[-1]) if times else "N/A"
    if times:
        mean_sec = int(round(sum(times) / float(len(times))))
        mean = _format_elapsed_hhmmss(mean_sec)
    else:
        mean = "N/A"
    return {
        "First": {"value": first},
        "Last": {"value": last},
        "Mean": {"value": mean},
    }


def enrich_report_context(report_data: Dict[str, Any]) -> Dict[str, Any]:
    if not report_data:
        return report_data
    factory_settings = data_service.get_factory_settings()
    fs = report_data.get("factorySettings") or {}
    beaker = _report_beaker_number(report_data)
    for k, default in [
        ("companyName", "N/A"),
        ("modelNo", "N/A"),
        ("serialNo", "N/A"),
        ("companyLocation", "N/A"),
        ("instrumentId", "N/A"),
    ]:
        if not fs.get(k):
            fs[k] = factory_settings.get(k) or default
    # Stamp beaker-specific last/next validation dates onto factorySettings for print/preview
    merged_fs = {**factory_settings, **fs}
    if isinstance(factory_settings.get("validationDatesByBeaker"), dict) and "validationDatesByBeaker" not in fs:
        merged_fs["validationDatesByBeaker"] = factory_settings["validationDatesByBeaker"]
    beaker_dates = get_beaker_validation_dates(merged_fs, beaker)
    if beaker_dates.get("lastValidationDate"):
        fs["lastValidationDate"] = beaker_dates["lastValidationDate"]
    if beaker_dates.get("nextValidationDate"):
        fs["nextValidationDate"] = beaker_dates["nextValidationDate"]
    if beaker is None:
        dates = _resolve_validation_dates(merged_fs)
        if dates.get("lastValidationDate") and not fs.get("lastValidationDate"):
            fs["lastValidationDate"] = dates["lastValidationDate"]
        if dates.get("nextValidationDate") and not fs.get("nextValidationDate"):
            fs["nextValidationDate"] = dates["nextValidationDate"]
    if isinstance(merged_fs.get("validationDatesByBeaker"), dict):
        fs["validationDatesByBeaker"] = merged_fs["validationDatesByBeaker"]
    report_data["factorySettings"] = fs
    if str(report_data.get("type") or "").strip().lower() == "test":
        td = report_data.get("testData") if isinstance(report_data.get("testData"), dict) else report_data
        if isinstance(td, dict):
            td_remarks = td.get("remarks")
            if td_remarks not in (None, "") and not report_data.get("remarks"):
                report_data["remarks"] = td_remarks
        # Prefer nested testData but merge top-level tube/elapsed fields when sparse
        stats_src = dict(td) if isinstance(td, dict) else {}
        if stats_src is not report_data:
            for k in ("mode", "basketConfig", "holeCompletionTimes", "vesselTimes", "durationSeconds"):
                if not stats_src.get(k) and report_data.get(k) not in (None, ""):
                    stats_src[k] = report_data.get(k)
        computed = compute_test_report_statistics(stats_src if stats_src else None)
        if computed:
            report_data["statistics"] = computed
            if isinstance(report_data.get("testData"), dict):
                report_data["testData"]["statistics"] = computed
        elif str((td or {}).get("mode") or "").strip().lower() == "timer":
            # Timer mode has no tap-time statistics
            report_data["statistics"] = {}
            if isinstance(report_data.get("testData"), dict):
                report_data["testData"]["statistics"] = {}
        recipe = report_data.get("recipe") if isinstance(report_data.get("recipe"), dict) else {}
        report_data["reportDerived"] = build_test_report_derived(
            td if isinstance(td, dict) else {},
            recipe,
            report_data.get("id"),
            report=report_data,
        )
    return report_data


def _as_naive_utc(dt: datetime) -> datetime:
    """Normalize aware/naive datetimes so comparisons never mix tzinfo."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _parse_report_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return _as_naive_utc(dt)
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


def _format_display_date(value: Any) -> str:
    """Normalize display dates to DD/MM/YYYY for all report outputs."""
    dt = _parse_display_date(value)
    if dt is None:
        s = str(value or "").strip()
        return s or "N/A"
    return dt.strftime("%d/%m/%Y")


def _add_years(dt: datetime, years: int = 1) -> datetime:
    """Add calendar years; Feb 29 rolls to Feb 28 on non-leap years."""
    try:
        return dt.replace(year=dt.year + int(years or 1))
    except ValueError:
        return dt.replace(month=2, day=28, year=dt.year + int(years or 1))


def _add_months(dt: datetime, months: int) -> datetime:
    """Add calendar months; day clamps to last day of target month."""
    months = int(months or 0)
    year = dt.year + (dt.month - 1 + months) // 12
    month = (dt.month - 1 + months) % 12 + 1
    day = dt.day
    # Clamp day for shorter months
    for d in range(day, 0, -1):
        try:
            return dt.replace(year=year, month=month, day=d)
        except ValueError:
            continue
    return dt.replace(year=year, month=month, day=1)


def _validation_dates_from_last(dt: datetime, months: int = 12) -> Dict[str, str]:
    """Last validation date and next due after N calendar months (default 12)."""
    try:
        m = int(months or 12)
    except (TypeError, ValueError):
        m = 12
    if m not in (3, 6, 12):
        m = 12
    next_dt = _add_months(dt, m)
    return {
        "lastValidationDate": dt.strftime("%d/%m/%Y"),
        "nextValidationDate": next_dt.strftime("%d/%m/%Y"),
        "dueIntervalMonths": m,
    }


def get_beaker_validation_dates(
    factory_settings: Optional[Dict[str, Any]] = None,
    beaker: Any = None,
) -> Dict[str, str]:
    """
    Return last/next validation dates.

    DT Bath CFR uses one instrument-wide due date. Historical reports that still
    carry a beaker may fall back to validationDatesByBeaker for display only.
    """
    fs = factory_settings if isinstance(factory_settings, dict) else (data_service.get_factory_settings() or {})
    # Prefer instrument-wide pair
    last = fs.get("lastValidationDate") or "N/A"
    nxt = fs.get("nextValidationDate") or "N/A"
    if last not in (None, "", "N/A") or nxt not in (None, "", "N/A"):
        out = {
            "lastValidationDate": _format_display_date(last) if last not in (None, "", "N/A") else "N/A",
            "nextValidationDate": _format_display_date(nxt) if nxt not in (None, "", "N/A") else "N/A",
        }
        if fs.get("dueIntervalMonths") is not None:
            out["dueIntervalMonths"] = fs.get("dueIntervalMonths")
        return out
    # Historical fallback: per-beaker entry
    by = fs.get("validationDatesByBeaker") if isinstance(fs.get("validationDatesByBeaker"), dict) else {}
    key = None
    try:
        b = int(beaker)
        if b in (1, 2):
            key = str(b)
    except (TypeError, ValueError):
        key = None
    entry = by.get(key) if key and isinstance(by.get(key), dict) else None
    if entry:
        out = {
            "lastValidationDate": _format_display_date(entry.get("lastValidationDate"))
            if entry.get("lastValidationDate") not in (None, "", "N/A")
            else "N/A",
            "nextValidationDate": _format_display_date(entry.get("nextValidationDate"))
            if entry.get("nextValidationDate") not in (None, "", "N/A")
            else "N/A",
        }
        if entry.get("dueIntervalMonths") is not None:
            out["dueIntervalMonths"] = entry.get("dueIntervalMonths")
        return out
    return {"lastValidationDate": "N/A", "nextValidationDate": "N/A"}


def apply_pending_validation_due(report: Dict[str, Any]) -> Dict[str, Any]:
    """
    On validation approval: apply report.pendingValidationDue as the
    instrument-wide last/next validation dates (shared bath).
    """
    if not isinstance(report, dict):
        return {}
    pending = report.get("pendingValidationDue")
    if not isinstance(pending, dict) or not pending:
        return {}
    last = str(pending.get("lastValidationDate") or "").strip()
    nxt = str(pending.get("nextValidationDate") or "").strip()
    try:
        months = int(pending.get("months") or pending.get("dueIntervalMonths") or 12)
    except (TypeError, ValueError):
        months = 12
    if months not in (3, 6, 12):
        months = 12
    if not last or not nxt:
        now = datetime.now()
        computed = _validation_dates_from_last(now, months)
        last = last or computed["lastValidationDate"]
        nxt = nxt or computed["nextValidationDate"]
    last = _format_display_date(last)
    nxt = _format_display_date(nxt)
    stored = dict(data_service.get_factory_settings() or {})
    stored["lastValidationDate"] = last
    stored["nextValidationDate"] = nxt
    stored["dueIntervalMonths"] = months
    # Keep a mirrored entry under both beaker keys for older report readers
    by = dict(stored.get("validationDatesByBeaker") or {}) if isinstance(stored.get("validationDatesByBeaker"), dict) else {}
    entry = {
        "lastValidationDate": last,
        "nextValidationDate": nxt,
        "dueIntervalMonths": months,
    }
    by["1"] = dict(entry)
    by["2"] = dict(entry)
    stored["validationDatesByBeaker"] = by
    data_service.save_factory_settings(stored)
    return dict(entry)


def _resolve_validation_dates(factory_settings: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Legacy instrument-wide resolve (used when no beaker context). Prefer stored pair."""
    fs = factory_settings or {}
    last_dt = _parse_display_date(fs.get("lastValidationDate"))
    if last_dt:
        months = fs.get("dueIntervalMonths") or 12
        try:
            months = int(months)
        except (TypeError, ValueError):
            months = 12
        if months not in (3, 6, 12):
            months = 12
        # If next already stored, keep it
        if fs.get("nextValidationDate"):
            return {
                "lastValidationDate": _format_display_date(fs.get("lastValidationDate")),
                "nextValidationDate": _format_display_date(fs.get("nextValidationDate")),
                "dueIntervalMonths": months,
            }
        return _validation_dates_from_last(last_dt, months)
    try:
        computed = _compute_validation_dates_from_reports()
        if computed.get("lastValidationDate"):
            return computed
    except Exception as exc:
        print(f"[REPORT] Validation date compute failed: {exc}")
    return {}


def sync_factory_validation_dates() -> Dict[str, str]:
    """Legacy sync: keep stored last/next if present; otherwise derive +12 months."""
    stored = data_service.get_factory_settings() or {}
    dates = _resolve_validation_dates(stored)
    if not dates:
        return {}
    updated = dict(stored)
    updated["lastValidationDate"] = dates["lastValidationDate"]
    updated["nextValidationDate"] = dates["nextValidationDate"]
    if dates.get("dueIntervalMonths") is not None:
        updated["dueIntervalMonths"] = dates["dueIntervalMonths"]
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
    return _validation_dates_from_last(latest_dt, 12)


def _report_beaker_number(report_data: Dict[str, Any]) -> Optional[int]:
    td = report_data.get("testData") if isinstance(report_data.get("testData"), dict) else {}
    derived = report_data.get("reportDerived") if isinstance(report_data.get("reportDerived"), dict) else {}
    return _resolve_basket_number(report_data, td, derived)


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
        "testStartTime": report.get("testStartTime")
        or (td.get("testStartTime") if isinstance(td, dict) else None),
        "testEndTime": report.get("testEndTime")
        or (td.get("testEndTime") if isinstance(td, dict) else None),
        "validationStartTime": report.get("validationStartTime")
        or (td.get("validationStartTime") if isinstance(td, dict) else None)
        or report.get("testStartTime")
        or (td.get("testStartTime") if isinstance(td, dict) else None),
        "validationEndTime": report.get("validationEndTime")
        or (td.get("validationEndTime") if isinstance(td, dict) else None)
        or report.get("testEndTime")
        or (td.get("testEndTime") if isinstance(td, dict) else None),
        "recipe": report.get("recipe", {}),
        "factorySettings": report.get("factorySettings", {}),
        "testData": report.get("testData", report),
        "statistics": report.get("statistics")
        or (td.get("statistics") if isinstance(td, dict) else {})
        or compute_test_report_statistics(td if isinstance(td, dict) else None)
        or {},
        "status": report.get("status", "PASS"),
        "remarks": remarks,
        "approvedBy": report.get("approvedBy"),
        "approvedAt": report.get("approvedAt"),
        "reportApprovalStatus": report.get("reportApprovalStatus"),
        "approvalPassFail": report.get("approvalPassFail"),
        "approvalRemarks": report.get("approvalRemarks"),
        "minTemp": report.get("minTemp")
        if report.get("minTemp") is not None
        else (td.get("minTemp") if isinstance(td, dict) else None),
        "maxTemp": report.get("maxTemp")
        if report.get("maxTemp") is not None
        else (td.get("maxTemp") if isinstance(td, dict) else None),
        "meanTemp": report.get("meanTemp")
        if report.get("meanTemp") is not None
        else (td.get("meanTemp") if isinstance(td, dict) else None),
        "abortCause": report.get("abortCause")
        or (td.get("abortCause") if isinstance(td, dict) else None),
        "mode": report.get("mode")
        or (td.get("mode") if isinstance(td, dict) else None),
        "basketConfig": report.get("basketConfig")
        if report.get("basketConfig") is not None
        else (td.get("basketConfig") if isinstance(td, dict) else None),
        "vesselTimes": report.get("vesselTimes")
        or (td.get("vesselTimes") if isinstance(td, dict) else None)
        or {},
        "holeCompletionTimes": report.get("holeCompletionTimes")
        or (td.get("holeCompletionTimes") if isinstance(td, dict) else None)
        or {},
        "operatedByUsername": report.get("operatedByUsername")
        or (td.get("operatedByUsername") if isinstance(td, dict) else None)
        or (td.get("employeeId") if isinstance(td, dict) else None)
        or report.get("operatorUsername")
        or (td.get("operatorUsername") if isinstance(td, dict) else None)
        or report.get("operatorId")
        or (td.get("operatorId") if isinstance(td, dict) else None),
        "operatorName": report.get("operatorName")
        or (td.get("operatorName") if isinstance(td, dict) else None),
        "employeeId": report.get("employeeId")
        or (td.get("employeeId") if isinstance(td, dict) else None)
        or report.get("operatorId")
        or (td.get("operatorId") if isinstance(td, dict) else None)
        or report.get("operatorUsername")
        or (td.get("operatorUsername") if isinstance(td, dict) else None)
        or report.get("operatedByUsername")
        or (td.get("operatedByUsername") if isinstance(td, dict) else None),
        "reportDerived": report.get("reportDerived")
        or build_test_report_derived(
            td if isinstance(td, dict) else {},
            report.get("recipe") if isinstance(report.get("recipe"), dict) else {},
            report.get("id"),
            report=report,
        ),
    }
    # Always rebuild derived for test reports so basket / set temp stay consistent
    if str(report.get("type") or "").strip().lower() == "test":
        preview["reportDerived"] = build_test_report_derived(
            td if isinstance(td, dict) else {},
            report.get("recipe") if isinstance(report.get("recipe"), dict) else {},
            report.get("id"),
            report=report,
        )
        preview["setTemperature"] = preview["reportDerived"].get("setTemperature")
        preview["basket"] = preview["reportDerived"].get("basket")
        preview["beaker"] = preview["reportDerived"].get("beaker")
        preview["mode"] = preview["reportDerived"].get("mode") or preview.get("mode")
        preview["productName"] = preview["reportDerived"].get("productName") or report.get("productName") or report.get("name")
        preview["batchNumber"] = preview["reportDerived"].get("batchNumber") or report.get("batchNumber")
        preview["media"] = preview["reportDerived"].get("media") if preview["reportDerived"].get("media") is not None else report.get("media")
        preview["mesh"] = preview["reportDerived"].get("mesh") if preview["reportDerived"].get("mesh") is not None else report.get("mesh")
        preview["durationSeconds"] = preview["reportDerived"].get("durationSeconds")
        if preview["durationSeconds"] in (None, ""):
            preview["durationSeconds"] = report.get("durationSeconds")
            if preview["durationSeconds"] in (None, "") and isinstance(td, dict):
                preview["durationSeconds"] = td.get("durationSeconds")
        preview["duration"] = preview["reportDerived"].get("durationFormatted") or report.get("duration")
        # Ensure statistics reflect top-level tube times when nested testData is sparse
        def _stat_blank(st):
            if not isinstance(st, dict) or not st:
                return True
            first = st.get("First")
            val = first.get("value") if isinstance(first, dict) else first
            return val in (None, "", "N/A", "--")
        if str(preview.get("mode") or "").strip().lower() != "timer" and _stat_blank(preview.get("statistics")):
            stats_src = dict(td) if isinstance(td, dict) else {}
            for k in ("mode", "basketConfig", "holeCompletionTimes", "vesselTimes", "durationSeconds"):
                if not stats_src.get(k) and report.get(k) not in (None, ""):
                    stats_src[k] = report.get(k)
            if preview.get("mode") and not stats_src.get("mode"):
                stats_src["mode"] = preview.get("mode")
            recomputed = compute_test_report_statistics(stats_src)
            if recomputed:
                preview["statistics"] = recomputed
    if report.get("type") == "validation":
        preview["validationSubtype"] = report.get("validationSubtype")
        preview["usp"] = report.get("usp")
        preview["tapsMin"] = report.get("tapsMin")
        preview["dropHeight"] = report.get("dropHeight")
        preview["expectedTapCount"] = report.get("expectedTapCount")
        if preview["expectedTapCount"] in (None, ""):
            preview["expectedTapCount"] = report.get("expectedRotationCount")
        if preview["expectedTapCount"] in (None, "") and isinstance(td, dict):
            preview["expectedTapCount"] = td.get("expectedTapCount") or td.get("expectedRotationCount")
        preview["actualTapCount"] = report.get("actualTapCount")
        if preview["actualTapCount"] in (None, ""):
            preview["actualTapCount"] = report.get("actualRotationCount")
        if preview["actualTapCount"] in (None, "") and isinstance(td, dict):
            preview["actualTapCount"] = td.get("actualTapCount") or td.get("actualRotationCount")
        preview["expectedRotationCount"] = report.get("expectedRotationCount") or preview.get("expectedTapCount")
        preview["actualRotationCount"] = report.get("actualRotationCount") or preview.get("actualTapCount")
        preview["validationStartTime"] = report.get("validationStartTime") or report.get("testStartTime")
        if preview["validationStartTime"] in (None, "") and isinstance(td, dict):
            preview["validationStartTime"] = td.get("validationStartTime") or td.get("testStartTime")
        # DT stroke / temp fields (flat report or nested testData)
        for key in (
            "strokesPerMin",
            "pulsesSeen",
            "actualStrokes",
            "requiredRange",
            "requiredMin",
            "requiredMax",
            "setTemperature",
            "minTemp",
            "maxTemp",
            "maxDeviation",
            "requiredDeviation",
            "basket",
            "beaker",
            "durationSec",
            "status",
            "sensorSilent",
        ):
            val = report.get(key)
            if val in (None, "") and isinstance(td, dict):
                val = td.get(key)
            if val not in (None, ""):
                preview[key] = val
        runs = report.get("validationRuns")
        if not runs and isinstance(td, dict):
            runs = td.get("validationRuns")
        if runs:
            preview["validationRuns"] = runs
    # Same monospace A4 text used by A4 print and PDF export (screen preview must match).
    try:
        import print_service

        preview["a4Text"] = print_service.format_for_a4_printer(
            report, include_printed_timestamp=False
        ).rstrip()
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


def _statistics_table_html(preview: Dict[str, Any], td: Dict[str, Any]) -> str:
    if str(td.get("status") or "").strip().lower() == "aborted":
        return '<tr><td colspan="2">N/A</td></tr>'
    stats = preview.get("statistics") or td.get("statistics") or {}
    if not isinstance(stats, dict) or not stats:
        return '<tr><td colspan="2">N/A</td></tr>'
    rows = []
    for key, val in stats.items():
        if not isinstance(val, dict):
            continue
        display = _stat_display_value(val)
        if display is None:
            continue
        rows.append(
            "<tr><th>{}</th><td>{}</td></tr>".format(
                _html_esc(key), _html_esc(display)
            )
        )
    return "".join(rows) if rows else '<tr><td colspan="2">N/A</td></tr>'


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
            date_str = _format_report_ts(run.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
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
            rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
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
        date_str = _format_report_ts(td.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
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
        rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
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
    total_drops = derived.get("totalDrops")
    if total_drops is None:
        total_drops = derived.get("totalTaps")
    total_taps_str = str(total_drops) if total_drops is not None else "--"
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


def build_report_pdf_html(
    report: Dict[str, Any],
    *,
    include_printed_timestamp: bool = False,
    timestamp_kind: str = "printed",
) -> str:
    """
    Build PDF HTML from the A4 text formatter output (====, ----, ****).
    Default has no Printed/Exported footer (preview/storage). Pass
    include_printed_timestamp=True with timestamp_kind printed|exported for live print/export.
    """
    import print_service

    enriched = enrich_report_context(dict(report or {}))
    a4_text = print_service.format_for_a4_printer(
        enriched,
        include_printed_timestamp=include_printed_timestamp,
        timestamp_kind=timestamp_kind,
    ).rstrip()
    escaped = html_module.escape(a4_text)

    css = (
        "@page{size:A4 portrait;margin:10mm;}"
        "body{margin:0;padding:3mm 0;color:#000;background:#fff;"
        "font-family:'Courier New',Courier,monospace;font-size:11pt;line-height:1.25;"
        "text-align:center;box-sizing:border-box;"
        "-webkit-print-color-adjust:exact;print-color-adjust:exact;}"
        ".a4-sheet{display:inline-block;width:190mm;max-width:190mm;text-align:left;vertical-align:top;}"
        "pre{margin:0;white-space:pre-wrap;tab-size:4;letter-spacing:0;font-size:inherit;line-height:inherit;}"
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>'
        '<style>{}</style></head><body><div class="a4-sheet"><pre>{}</pre></div></body></html>'
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
