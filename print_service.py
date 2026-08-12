#!/usr/bin/env python3
"""
print_service.py - Printing operations service
Reference-aligned A4 and thermal printing over serial.
"""

import logging
import os
import pathlib
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional

try:
    import serial
except ImportError:
    serial = None

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    import bridge_services
except ImportError:
    bridge_services = None

try:
    from report_service import (
        build_test_report_derived,
        format_duration_hhmmss,
        test_duration_seconds,
        _format_derived_number,
    )
except ImportError:
    def build_test_report_derived(td, recipe=None, report_id=None):
        return {}

    def _format_derived_number(val, decimals=3):
        return "--" if val is None else str(val)
    def format_duration_hhmmss(seconds_val):
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

    def test_duration_seconds(td):
        if not isinstance(td, dict):
            return None
        sec = td.get("durationSeconds")
        if sec is not None:
            try:
                return max(0, int(sec))
            except (TypeError, ValueError):
                pass
        return None

A4_CANDIDATES = ["/dev/ttyAMA4", "/dev/ttyUSB0", "/dev/ttyUSB1", "COM3", "COM4"]
THERMAL_CANDIDATES = ["/dev/ttyAMA3", "/dev/ttyUSB0", "/dev/ttyUSB1", "COM3", "COM4"]
THERMAL_WIDTH = 32
THERMAL_LINE_CHUNK = 32
A4_TEXT_WIDTH = 80
# Blank lines after printed date/time so footer clears the cutter (avoid half-cut).
THERMAL_POST_PRINT_FEED_LINES = 3
# ESC/POS raster width for 58mm thermal (must be multiple of 8).
THERMAL_RASTER_WIDTH = 384
THERMAL_LOGO_PRINT_WIDTH = 384  # full RLE mark + RAISE LAB EQUIPMENT across slip
_ASSETS_DIR = pathlib.Path(__file__).resolve().parent / "assets"
_THERMAL_LOGO_CANDIDATES = (
    _ASSETS_DIR / "rle_favicon.png",
    _ASSETS_DIR / "favicon-32.png",
    _ASSETS_DIR / "rle_logo.png",
)

_PRINTER_INIT_SEQ = b"\x1b\x40"
_log = logging.getLogger(__name__)

_config = {}
_a4_port = None
_a4_baud = None
_thermal_port = None
_thermal_baud = None
_print_locks = {
    "a4": threading.Lock(),
    "thermal": threading.Lock(),
}
_thermal_logo_raster_cache: Optional[bytes] = None
_thermal_logo_raster_mtime: Optional[float] = None


def init(config):
    global _config, _a4_port, _a4_baud, _thermal_port, _thermal_baud
    _config = dict(config)
    _a4_port = _config.get("A4_PORT", "/dev/ttyAMA4")
    _a4_baud = int(_config.get("A4_BAUD", 9600))
    _thermal_port = _config.get("THERMAL_PORT", "/dev/ttyAMA3")
    _thermal_baud = int(_config.get("THERMAL_BAUD", 9600))


def _is_windows_com_port(port: str) -> bool:
    return bool(port and str(port).strip().upper().startswith("COM"))


def _port_exists(port: str) -> bool:
    if not port:
        return False
    if _is_windows_com_port(port):
        return True
    return os.path.exists(port)


def _probe_port(port: str, candidates: list) -> str:
    cands = ([port] if port else []) + [c for c in candidates if c and c != port]
    if bridge_services:
        return bridge_services.probe_and_choose_port(port, candidates=cands)
    if port and _port_exists(port):
        return port
    for p in candidates:
        if p and _port_exists(p):
            return p
    raise FileNotFoundError(2, "Serial device not found", port or "no-config")


def check_printer_status(printer_type: str = "a4") -> Dict[str, Any]:
    port = _a4_port if printer_type == "a4" else _thermal_port
    baud = _a4_baud if printer_type == "a4" else _thermal_baud
    if not serial:
        return {"available": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"available": False, "error": f"Printer port not found: {port}", "port": port}
    try:
        ser = serial.Serial(port=port, baudrate=baud, timeout=1.0)
        ser.close()
        return {"available": True, "port": port, "baud": baud}
    except Exception as e:
        return {"available": False, "error": str(e), "port": port}


def _open_a4_serial(port: str, baud: int):
    params = dict(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=2,
        write_timeout=2,
    )
    try:
        return serial.Serial(**params)
    except Exception:
        time.sleep(0.5)
        return serial.Serial(**params)


def _send_printer_init(ser) -> None:
    ser.write(_PRINTER_INIT_SEQ)
    ser.flush()
    time.sleep(0.05)


def _resolve_thermal_logo_path() -> Optional[pathlib.Path]:
    for path in _THERMAL_LOGO_CANDIDATES:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def _pil_to_escpos_raster(img: "Image.Image", width_pixels: int) -> bytes:
    """Convert a PIL image to ESC/POS GS v 0 raster bytes (width multiple of 8)."""
    width_pixels = max(8, int(width_pixels) - (int(width_pixels) % 8))
    img = img.convert("L")
    w, h = img.size
    if w != width_pixels:
        new_h = max(1, int(round(h * (width_pixels / float(w)))))
        img = img.resize((width_pixels, new_h), Image.LANCZOS)
        w, h = img.size
    # Dark pixels print (1), light stay white (0)
    bw = img.point(lambda p: 0 if p > 160 else 1, "1")
    m = 0
    xL = (w // 8) & 0xFF
    xH = ((w // 8) >> 8) & 0xFF
    yL = h & 0xFF
    yH = (h >> 8) & 0xFF
    header = bytes([0x1D, 0x76, 0x30, m, xL, xH, yL, yH])
    row_bytes = w // 8
    raw = bw.tobytes()
    out = bytearray(header)
    for row in range(h):
        start = row * row_bytes
        out.extend(raw[start : start + row_bytes])
    return bytes(out)


def _build_centered_thermal_logo_raster(
    logo_path: pathlib.Path,
    *,
    paper_width: int = THERMAL_RASTER_WIDTH,
    logo_width: int = THERMAL_LOGO_PRINT_WIDTH,
) -> bytes:
    if Image is None:
        raise RuntimeError("Pillow (PIL) is required for thermal logo printing")
    paper_width = max(8, int(paper_width) - (int(paper_width) % 8))
    logo_width = max(8, int(logo_width) - (int(logo_width) % 8))
    logo_width = min(logo_width, paper_width)

    src = Image.open(logo_path)
    src.load()

    if src.mode in ("1", "L"):
        mono = src.convert("L")
    else:
        # Color brand art (navy bg + blue/orange mark) → mono for thermal
        rgba = src.convert("RGBA")
        gray = Image.new("L", rgba.size, 255)
        px = rgba.load()
        gp = gray.load()
        w0, h0 = rgba.size
        for y in range(h0):
            for x in range(w0):
                r, g, b, a = px[x, y]
                if a < 20:
                    continue
                if r < 50 and g < 55 and b < 70:
                    continue
                if (r + g + b) < 90:
                    continue
                # Any visible brand color → black
                if (r + g + b) > 120 or max(r, g, b) > 100:
                    gp[x, y] = 0
        mono = gray

    # Trim whitespace
    inv = Image.eval(mono, lambda p: 255 - p)
    bbox = inv.getbbox()
    if bbox:
        mono = mono.crop(bbox)

    new_h = max(1, int(round(mono.height * (logo_width / float(max(1, mono.width))))))
    mono = mono.resize((logo_width, new_h), Image.LANCZOS)
    # Hard threshold after scale
    mono = mono.point(lambda p: 0 if p < 160 else 255)

    canvas = Image.new("L", (paper_width, mono.height), 255)
    ox = max(0, (paper_width - logo_width) // 2)
    canvas.paste(mono, (ox, 0))
    return _pil_to_escpos_raster(canvas, paper_width)


def get_thermal_logo_raster() -> Optional[bytes]:
    """Cached ESC/POS raster for the RLE favicon printed at the top of thermal slips."""
    global _thermal_logo_raster_cache, _thermal_logo_raster_mtime
    path = _resolve_thermal_logo_path()
    if path is None or Image is None:
        return None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    if _thermal_logo_raster_cache is not None and _thermal_logo_raster_mtime == mtime:
        return _thermal_logo_raster_cache
    try:
        raster = _build_centered_thermal_logo_raster(path)
        _thermal_logo_raster_cache = raster
        _thermal_logo_raster_mtime = mtime
        return raster
    except Exception as e:
        _log.warning("thermal logo raster build failed: %s", e)
        return None


def _send_bytes_chunked_raw(ser, data: bytes, baud: int, chunk_size: int = 512) -> None:
    delay = 0.08 if baud <= 9600 else 0.04
    for i in range(0, len(data), chunk_size):
        ser.write(data[i : i + chunk_size])
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)


def _send_thermal_logo(ser, baud: int) -> bool:
    raster = get_thermal_logo_raster()
    if not raster:
        return False
    _send_bytes_chunked_raw(ser, raster, baud, chunk_size=512 if baud <= 9600 else 1024)
    ser.write(b"\n")
    ser.flush()
    time.sleep(0.05)
    return True


def _send_bytes_chunked(ser, data: bytes, baud: int, chunk_size: int = 64) -> None:
    delay = 0.08 if baud <= 9600 else 0.04
    for i in range(0, len(data), chunk_size):
        ser.write(data[i : i + chunk_size])
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)
    time.sleep(0.1)


def _send_text_chunked(ser, text: str, baud: int, chunk_size: int = 64) -> None:
    try:
        data = text.encode("utf-8", errors="replace")
    except Exception:
        data = text.encode("latin-1", errors="replace")
    _send_bytes_chunked(ser, data, baud, chunk_size=chunk_size)


def _thermal_sep(char: str, width: int = THERMAL_WIDTH) -> str:
    return (char * width)[:width]


def _fit_thermal_line(line: str, width: int = THERMAL_WIDTH) -> list:
    """Split or truncate a single logical line to at most `width` characters per row."""
    s = str(line) if line is not None else ""
    if not s.strip() and s == "":
        return [""]
    if len(s) <= width:
        return [s]
    out = []
    while s:
        out.append(s[:width])
        s = s[width:]
    return out


def _apply_thermal_line_spacing(lines: list, width: int = THERMAL_WIDTH) -> list:
    """Extra blank line after each printed row for readable line spacing."""
    out: list = []
    for line in lines:
        for part in _fit_thermal_line(line, width):
            out.append(part)
            if part.strip():
                out.append("")
    return out


def _compact_thermal_lines(lines: list, width: int = THERMAL_WIDTH) -> list:
    """Fit thermal lines without adding filler space between every row."""
    out: list = []
    previous_blank = False
    for line in lines:
        parts = _fit_thermal_line(line, width)
        for part in parts:
            is_blank = not str(part or "").strip()
            if is_blank and previous_blank:
                continue
            out.append(part)
            previous_blank = is_blank
    while out and not str(out[-1] or "").strip():
        out.pop()
    return out


def _send_text_to_thermal(ser, text: str, baud: int) -> None:
    """
    Send thermal text one line at a time (max THERMAL_WIDTH chars per row).
    Avoids buffer overrun that drops the start of long chunked writes.
    """
    line_delay = 0.06 if baud <= 9600 else 0.035
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for line in text.split("\n"):
        if line == "":
            ser.write(b"\n")
            ser.flush()
            time.sleep(0.02)
            continue
        for chunk in _fit_thermal_line(line, THERMAL_LINE_CHUNK):
            payload = (chunk + "\n").encode("latin-1", errors="replace")
            ser.write(payload)
            ser.flush()
            time.sleep(line_delay)
    # Trailing blank feed is already included in formatted thermal text.
    time.sleep(0.5)


def _send_text_to_a4(ser, text: str, baud: int) -> int:
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    data = text.encode("utf-8", errors="replace")
    _send_bytes_chunked(ser, data, baud, chunk_size=512)
    return len(data)


def _format_ts_readable(ts: Any) -> str:
    if ts is None:
        return "--"
    if isinstance(ts, datetime):
        dt = ts.astimezone() if ts.tzinfo is not None else ts
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    s = str(ts).strip()
    if not s:
        return "--"
    try:
        s = s[:-1] + "+00:00" if s[-1:] in ("Z", "z") else s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return str(ts)


def _split_ts_date_and_time(ts: Any) -> tuple:
    """Return (date, time) strings for separate thermal print lines."""
    full = _format_ts_readable(ts)
    if full == "--":
        return "--", "--"
    parts = full.split(" ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return full, "--"


_THERMAL_FRIABILITY_COL_WIDTHS = (3, 6, 6, 6, 6)


def _thermal_grid_line(
    cells: list,
    widths: tuple = _THERMAL_FRIABILITY_COL_WIDTHS,
    *,
    headers: bool = False,
) -> str:
    """Fixed-position thermal table row with single-space column gaps."""
    parts = []
    for i, (cell, width) in enumerate(zip(cells, widths)):
        s = str(cell if cell is not None else "")
        if len(s) > width:
            s = s[:width]
        parts.append(s.center(width) if headers else s.rjust(width))
        if i < len(cells) - 1:
            parts.append(" ")
    return "".join(parts)


def _thermal_grid_width(widths: tuple = _THERMAL_FRIABILITY_COL_WIDTHS) -> int:
    return sum(widths) + max(0, len(widths) - 1)


def _fmt_friability_thermal(val: Any, width: int = 6) -> str:
    """Friability percent sized for the thermal Fri column."""
    if val is None or val in ("", "__"):
        return "--"
    try:
        f = float(val)
        for prec in (3, 2, 1, 0):
            s = f"{f:.{prec}f}%"
            if len(s) <= width:
                return s
        return f"{f:.0f}%"[:width]
    except (TypeError, ValueError):
        s = str(val).strip()
        if s and not s.endswith("%"):
            s += "%"
        return s[:width] if s else "--"


def _fmt_weight_thermal(val: Any, width: int = 6) -> str:
    s = _fmt_weight_val(val)
    return s[:width] if len(s) > width else s


def _strip_approver_role_label(name: Any) -> str:
    """Remove trailing role label e.g. 'Admin (admin)' -> 'Admin'."""
    s = str(name or "").strip()
    if not s or s == "--":
        return "--"
    if "(" in s and s.endswith(")"):
        head = s.rsplit("(", 1)[0].strip()
        if head:
            return head
    return s


def _resolve_employee_id(report_data: Any = None, td: Any = None) -> str:
    """Employee ID for print/preview — accept DT operatorId aliases too."""
    for src in (report_data, td):
        if not isinstance(src, dict):
            continue
        for key in ("employeeId", "operatorId", "operatorUsername", "operatedByUsername"):
            val = src.get(key)
            if val is None:
                continue
            text = str(val).strip()
            if text and text != "--":
                return text
    return "--"


def _wrap_lines(lines: list, width: int) -> list:
    out = []
    for line in lines:
        if "\t" in line:
            out.append(line)
            continue
        if len(line) <= width:
            out.append(line)
            continue
        words = line.split()
        if not words:
            out.append("")
            continue
        cur = ""
        for w in words:
            nxt = w if not cur else (cur + " " + w)
            if len(nxt) <= width:
                cur = nxt
            else:
                if cur:
                    out.append(cur)
                cur = w
        if cur:
            out.append(cur)
    return out


def _truncate_with_ellipsis(value: Any, max_len: int) -> str:
    s = "" if value is None else str(value)
    if max_len <= 0:
        return ""
    if len(s) <= max_len:
        return s
    if max_len <= 3:
        return "." * max_len
    return s[: max_len - 3] + "..."


def _append_two_column_pairs(lines: list, pairs: list, width: int) -> None:
    """Append key/value pairs as two aligned columns for A4 text output."""
    if width < 40:
        for label, value in pairs:
            lines.append(f"{label}: {value}")
        return
    gap = 4
    col_w = max(18, (width - gap) // 2)
    value_w = max(8, col_w - 2)

    def _cell(label: Any, value: Any) -> str:
        lbl = _truncate_with_ellipsis(label, 22)
        val = _truncate_with_ellipsis(value, value_w)
        text = f"{lbl}: {val}".strip()
        return text.ljust(col_w)[:col_w]

    normalized = [(str(k or "--"), str(v if v not in (None, "") else "--")) for k, v in pairs]
    for i in range(0, len(normalized), 2):
        left = _cell(normalized[i][0], normalized[i][1])
        right = ""
        if i + 1 < len(normalized):
            right = _cell(normalized[i + 1][0], normalized[i + 1][1])
        lines.append(left + (" " * gap) + right)



def _fmt_density_val(val: Any) -> str:
    if val is None or val == "":
        return "--"
    try:
        f = float(val)
        return f"{f:.3f}".rstrip("0").rstrip(".") if f != int(f) else str(int(f))
    except (TypeError, ValueError):
        return str(val)


def _cell_str(val: Any) -> str:
    if val is None or val in ("", "__"):
        return "--"
    return str(val)


def _normalize_pass_fail(value: Any) -> str:
    s = str(value or "").strip()
    if not s:
        return ""
    low = s.lower()
    if low in ("pass", "passed"):
        return "Pass"
    if low in ("fail", "failed"):
        return "Fail"
    return s


def _effective_approval_result(report_data: Dict[str, Any], td: Dict[str, Any]) -> str:
    candidates = []
    if isinstance(report_data, dict):
        candidates.extend([
            report_data.get("approvalPassFail"),
            report_data.get("approvalResult"),
            report_data.get("passFail"),
        ])
    if isinstance(td, dict):
        candidates.extend([
            td.get("approvalPassFail"),
            td.get("approvalResult"),
            td.get("passFail"),
        ])
        for row in td.get("stepResults") or []:
            if not isinstance(row, dict):
                continue
            candidates.extend([row.get("resultText"), row.get("result")])
    for value in candidates:
        normalized = _normalize_pass_fail(value)
        if normalized and normalized.lower() not in ("pending", "pending approval", "--", "n/a"):
            return normalized
    return ""


def _drum_approval_results(report_data: Dict[str, Any], td: Dict[str, Any]) -> list:
    rows = td.get("stepResults") if isinstance(td, dict) else []
    rows = rows if isinstance(rows, list) else []
    drum_map = {}
    if isinstance(report_data, dict) and isinstance(report_data.get("drumPassFail"), dict):
        drum_map.update(report_data.get("drumPassFail"))
    if isinstance(td, dict) and isinstance(td.get("drumPassFail"), dict):
        drum_map.update(td.get("drumPassFail"))
    fallback = _effective_approval_result(report_data, td)
    count = max(1, len(rows))
    if isinstance(td, dict):
        try:
            count = max(count, int(td.get("drumCount") or 0))
        except (TypeError, ValueError):
            pass
    count = min(2, count)
    out = []
    for idx in range(count):
        row = rows[idx] if idx < len(rows) and isinstance(rows[idx], dict) else {}
        value = row.get("approvalPassFail") or row.get("resultText") or row.get("result")
        if not value or str(value).strip().lower() in ("pending", "pending approval", "--", "n/a"):
            value = drum_map.get("drum{}".format(idx + 1)) or fallback
        out.append(("Drum {} Pass/Fail".format(idx + 1), _normalize_pass_fail(value) or "--"))
    return out


def _approval_result_pairs(
    report_data: Dict[str, Any], td: Dict[str, Any], report_type: str = "test"
) -> list:
    """Approval pass/fail lines. Validation shows Stroke + Temp when present."""
    rtype = str(report_type or "test").strip().lower()
    if rtype == "validation":
        stroke_pf = None
        temp_pf = None
        if isinstance(report_data, dict):
            stroke_pf = report_data.get("strokePassFail")
            temp_pf = report_data.get("tempPassFail")
        if isinstance(td, dict):
            if not stroke_pf:
                stroke_pf = td.get("strokePassFail")
            if not temp_pf:
                temp_pf = td.get("tempPassFail")
        runs = []
        if isinstance(td, dict) and isinstance(td.get("validationRuns"), list):
            runs = td.get("validationRuns")
        elif isinstance(report_data, dict) and isinstance(report_data.get("validationRuns"), list):
            runs = report_data.get("validationRuns")
        for run in runs or []:
            if not isinstance(run, dict):
                continue
            sub = str(run.get("validationSubtype") or "").strip().lower()
            run_pf = run.get("approvalPassFail")
            if sub == "stroke" and not stroke_pf:
                stroke_pf = run_pf
            elif sub == "temp" and not temp_pf:
                temp_pf = run_pf
        stroke_n = _normalize_pass_fail(stroke_pf)
        temp_n = _normalize_pass_fail(temp_pf)
        if stroke_n or temp_n:
            return [
                ("Stroke Pass / Fail", stroke_n or "--"),
                ("Temp Pass / Fail", temp_n or "--"),
            ]
        # Do not fall back to auto hardware PASSED/FAILED status
        overall = _effective_approval_result(report_data, td)
        overall_n = _normalize_pass_fail(overall)
        return [("Pass / Fail", overall_n or "--")]
    result = _effective_approval_result(report_data, td)
    normalized = _normalize_pass_fail(result)
    return [("Pass / Fail", normalized or _cell_str(result) or "--")]


def _effective_step_row_count(td: Dict[str, Any]) -> int:
    """Rows to print: actual stepResults only (not recipe stepCount)."""
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    cs = td.get("completedSteps")
    if cs is not None:
        try:
            return max(0, int(cs))
        except (TypeError, ValueError):
            pass
    return 0


def _section_sep(char: str, width: int, thermal: bool) -> str:
    if thermal:
        return _thermal_sep(char, width)
    return char * width


def _thermal_test_data_row(sn: int, cnt: str, vol: str, dvol: str, bulk: str, tap: str) -> str:
    """Legacy tap-density row (kept for reference layouts)."""
    return f"{sn:>2} {str(cnt):>4} {str(vol):>5} {str(dvol):>4} {str(bulk):>4} {str(tap):>4}"


def _fmt_weight_val(val: Any) -> str:
    if val is None or val in ("", "__"):
        return "--"
    try:
        f = float(val)
        return f"{f:.3f}".rstrip("0").rstrip(".") if f != int(f) else str(int(f))
    except (TypeError, ValueError):
        return str(val)


def _fmt_friability_pct(val: Any) -> str:
    if val is None or val in ("", "__"):
        return "--"
    try:
        f = float(val)
        return f"{f:.3f}".rstrip("0").rstrip(".") + "%"
    except (TypeError, ValueError):
        return str(val)


def _effective_friability_step_count(td: Dict[str, Any]) -> int:
    """Rows to print: matches on-screen report preview."""
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    sc = td.get("stepCount")
    if sc is not None:
        try:
            n = int(sc)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    if td.get("initialWeight") is not None or td.get("finalWeight") is not None:
        return 1
    return _effective_step_row_count(td)


def _friability_step_row_values(td: Dict[str, Any], results: list, index: int) -> Dict[str, str]:
    r = results[index] if index < len(results) and isinstance(results[index], dict) else {}
    w1 = r.get("initialWeight")
    if w1 in (None, ""):
        w1 = td.get("initialWeight")
    w2 = r.get("finalWeight")
    if w2 in (None, ""):
        w2 = td.get("finalWeight")
    diff = r.get("weightDifference")
    if diff in (None, ""):
        diff = td.get("weightDifference")
    fri = r.get("friabilityPercent")
    if fri in (None, ""):
        fri = td.get("friabilityPercent")
    trend = r.get("weightTrend")
    if trend in (None, ""):
        trend = td.get("weightTrend")
    result = r.get("resultText")
    if result in (None, "") or str(result).strip().lower() == "pending approval":
        result = td.get("approvalPassFail") or "--"
    return {
        "w1": _fmt_weight_val(w1),
        "w2": _fmt_weight_val(w2),
        "diff": _fmt_weight_val(diff),
        "friability": _fmt_friability_pct(fri),
        "trend": _cell_str(trend),
        "result": _cell_str(result),
    }


_THERMAL_FRIABILITY_DATA_HEADER = _thermal_grid_line(
    ["#", "W1", "W2", "Diff", "Fri%"], _THERMAL_FRIABILITY_COL_WIDTHS, headers=True
)


def _format_thermal_friability_test_data_table(td: Dict[str, Any], width: int = THERMAL_WIDTH) -> list:
    """Compact friability step table for 32-char thermal paper."""
    w = width
    cols = _THERMAL_FRIABILITY_COL_WIDTHS
    grid_w = _thermal_grid_width(cols)
    dash = _section_sep("-", grid_w, True)
    results = td.get("stepResults") or []
    row_count = _effective_friability_step_count(td)
    lines = [
        _section_sep("=", w, True),
        "TEST DATA",
        dash,
        _THERMAL_FRIABILITY_DATA_HEADER,
        dash,
    ]
    indent = " " * (cols[0] + 1)
    for i in range(row_count):
        row = _friability_step_row_values(td, results, i)
        r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
        fri_raw = r.get("friabilityPercent")
        if fri_raw in (None, ""):
            fri_raw = td.get("friabilityPercent")
        lines.append(
            _thermal_grid_line(
                [
                    i + 1,
                    _fmt_weight_thermal(row["w1"]),
                    _fmt_weight_thermal(row["w2"]),
                    _fmt_weight_thermal(row["diff"]),
                    _fmt_friability_thermal(fri_raw),
                ],
                cols,
            )
        )
        lines.append(f"{indent}Trend: {row['trend']}"[:w])
        lines.append(f"{indent}Result: {row['result']}"[:w])
    lines.append(dash)
    return lines


_THERMAL_TEST_DATA_HEADER = f"{'#':>2} {'Cnt':>4} {'Vol':>5} {'dV':>4} {'Blk':>4} {'Tap':>4}"


def _format_thermal_test_data_table(
    row_count: int, results: list, steps: Optional[list] = None, width: int = THERMAL_WIDTH
) -> list:
    """Compact fixed-width step table for 32-char thermal paper."""
    w = width
    lines = [
        "",
        _section_sep("=", w, True),
        "TEST DATA",
        _section_sep("-", w, True),
        _THERMAL_TEST_DATA_HEADER,
        _section_sep("-", w, True),
    ]
    steps = steps if isinstance(steps, list) else []
    for i in range(row_count):
        r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
        cnt = "--"
        if i < len(steps) and isinstance(steps[i], dict):
            cnt = _cell_str(steps[i].get("tapCount"))
        vol = _cell_str(r.get("volumeMl"))
        dvol = r.get("volumeDeltaMl", "__")
        if dvol not in (None, "", "__"):
            dvol = _fmt_density_val(dvol)
        else:
            dvol = _cell_str(dvol)
        bulk = r.get("bulkDensity", "__")
        if bulk not in (None, "", "__"):
            bulk = _fmt_density_val(bulk)
        else:
            bulk = _cell_str(bulk)
        tap = r.get("tapDensity", "__")
        if tap not in (None, "", "__"):
            tap = _fmt_density_val(tap)
        else:
            tap = _cell_str(tap)
        lines.append(_thermal_test_data_row(i + 1, cnt, vol, dvol, bulk, tap))
    lines.extend(["", _section_sep("-", w, True), ""])
    return lines


def _stat_display_value(val: dict) -> Any:
    """Single statistic value for print (value field, else mean)."""
    if val.get("value") is not None:
        return val.get("value")
    if val.get("mean") is not None:
        mean = val.get("mean")
        min_v = val.get("min")
        max_v = val.get("max")
        if min_v is not None or max_v is not None:
            return f"Avg: {mean} | Min: {min_v if min_v is not None else '--'} | Max: {max_v if max_v is not None else '--'}"
        return mean
    if val.get("Mean") is not None:
        mean = val.get("Mean")
        min_v = val.get("Min")
        max_v = val.get("Max")
        if min_v is not None or max_v is not None:
            return f"Avg: {mean} | Min: {min_v if min_v is not None else '--'} | Max: {max_v if max_v is not None else '--'}"
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


def _recipe_total_taps_from_steps_only(recipe: Dict[str, Any]) -> Optional[int]:
    """A4 text report helper: sum only per-step taps, ignore custom total taps."""
    if not isinstance(recipe, dict):
        return None
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


def _performed_total_taps(td: Dict[str, Any], recipe: Dict[str, Any]) -> Optional[int]:
    """Sum taps only for steps that were actually performed."""
    if not isinstance(td, dict):
        return None
    results = td.get("stepResults") or []
    if not isinstance(results, list) or not results:
        return None
    steps = recipe.get("steps") if isinstance(recipe, dict) else []
    if not isinstance(steps, list):
        steps = []
    total = 0
    found = False
    for i in range(len(results)):
        step_taps = None
        if i < len(steps) and isinstance(steps[i], dict):
            step_taps = steps[i].get("tapCount")
        if step_taps in (None, "") and isinstance(results[i], dict):
            step_taps = results[i].get("tapCount")
        try:
            n = int(step_taps)
            if n > 0:
                total += n
                found = True
        except (TypeError, ValueError):
            continue
    return total if found else None


def _completed_steps_total_taps(td: Dict[str, Any], recipe: Dict[str, Any]) -> Optional[int]:
    """
    Fallback total taps from recipe steps limited to completed step count.
    Keeps totals aligned with "completed/performed" semantics.
    """
    if not isinstance(td, dict) or not isinstance(recipe, dict):
        return None
    steps = recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        return None
    try:
        completed = int(td.get("completedSteps"))
    except (TypeError, ValueError):
        return None
    if completed <= 0:
        return None
    count = min(completed, len(steps))
    total = 0
    found = False
    for i in range(count):
        step = steps[i] if i < len(steps) and isinstance(steps[i], dict) else {}
        try:
            n = int(step.get("tapCount") or 0)
            if n > 0:
                total += n
                found = True
        except (TypeError, ValueError):
            continue
    return total if found else None


def _performed_diff_last_two_steps(td: Dict[str, Any]) -> Any:
    """
    Difference between last two performed step volumes.
    If only one performed step exists, use its available volume delta.
    """
    if not isinstance(td, dict):
        return None
    results = td.get("stepResults") or []
    if not isinstance(results, list) or not results:
        return None
    if len(results) >= 2:
        try:
            v1 = float((results[-2] or {}).get("volumeMl"))
            v2 = float((results[-1] or {}).get("volumeMl"))
            return abs(v2 - v1)
        except Exception:
            return None
    one = results[0] if isinstance(results[0], dict) else {}
    try:
        dv = one.get("volumeDeltaMl")
        if dv in (None, ""):
            return None
        return abs(float(dv))
    except Exception:
        return None


def _append_derived_test_summary_and_result(
    lines: list, derived: Dict[str, Any], width: int, thermal: bool
) -> None:
    """Friability weight summary (optional block after TEST DATA)."""
    if not isinstance(derived, dict) or not derived:
        return
    has_any = any(
        derived.get(k) not in (None, "", "--")
        for k in (
            "initialWeight",
            "finalWeight",
            "weightDifference",
            "friabilityPercent",
            "weightTrend",
            "rotationCount",
        )
    )
    if not has_any:
        return
    eq = _section_sep("=", width, thermal)
    dash = _section_sep("-", width, thermal)
    pairs = [
        ("Initial Weight (gms)", _fmt_weight_val(derived.get("initialWeight"))),
        ("Final Weight (gms)", _fmt_weight_val(derived.get("finalWeight"))),
        ("Difference (W2-W1 gms)", _fmt_weight_val(derived.get("weightDifference"))),
        ("Friability (%)", _fmt_friability_pct(derived.get("friabilityPercent")).replace("%", "")),
        ("Trend", _cell_str(derived.get("weightTrend"))),
        ("Rotations", _cell_str(derived.get("rotationCount"))),
        ("Target Rotations", _cell_str(derived.get("targetRotations"))),
    ]
    if thermal:
        lines.extend(["", eq, "TEST SUMMARY", dash])
        for label, val in pairs:
            lines.append(f"{label}: {val}")
        lines.append("")
        return
    lines.extend(["", eq, "TEST SUMMARY", dash])
    _append_two_column_pairs(lines, pairs, width)
    lines.append("")


def _is_calibration_report(report_data: Dict[str, Any]) -> bool:
    """True for calibration reports (including legacy validation+calibration subtype)."""
    if not isinstance(report_data, dict):
        return False
    rtype = str(report_data.get("type") or "").strip().lower()
    if rtype == "calibration":
        return True
    if rtype != "validation":
        return False
    sub = str(report_data.get("validationSubtype") or "").strip().lower()
    if sub == "calibration":
        return True
    td = report_data.get("testData")
    if isinstance(td, dict):
        sub = str(td.get("validationSubtype") or "").strip().lower()
        if sub == "calibration":
            return True
    return False


def _calibration_status_label(td: Dict[str, Any], report_data: Dict[str, Any]) -> str:
    """Simple status for calibration reports — no sensor/temp readings."""
    overall = td.get("status") or report_data.get("status") or ""
    low = str(overall).strip().lower()
    if low == "fail" or "fail" in low:
        return "Failed"
    if low == "aborted":
        return "Aborted"
    # Default success wording for completed calibration
    return "Temperature Calibrated"


def _append_calibration_report_details(
    lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool
) -> None:
    """Calibration report body: procedure + status only (no temps/offsets)."""
    if not isinstance(td, dict):
        td = {}
    status_label = _calibration_status_label(td, report_data)
    ts_end = (
        report_data.get("completedAt")
        or td.get("completedAt")
        or report_data.get("createdAt")
        or td.get("createdAt")
    )
    remarks = report_data.get("approvalRemarks")
    if remarks in (None, ""):
        remarks = report_data.get("remarks")
    if remarks in (None, ""):
        remarks = td.get("remarks")
    dash = "" if thermal else ("-" * width)
    end_date, end_time = _split_ts_date_and_time(ts_end)

    if thermal:
        lines.extend(
            [
                "",
                "CALIBRATION INFORMATION",
                "Procedure: Temperature Calibration",
                f"Status: {status_label}",
                f"Date: {end_date}",
                f"Time: {end_time}",
                "",
            ]
        )
    else:
        lines.extend(["", "CALIBRATION INFORMATION", dash if dash else ""])
        _append_two_column_pairs(
            lines,
            [
                ("Procedure", "Temperature Calibration"),
                ("Status", status_label),
                ("Completed", _format_ts_readable(ts_end)),
            ],
            width,
        )
        lines.append("")

    if remarks not in (None, ""):
        if thermal:
            lines.extend(["", "REMARKS:", str(remarks), ""])
        else:
            lines.extend(["", "REMARKS", dash if dash else ""])
            _append_two_column_pairs(
                lines, [("Remarks", _truncate_with_ellipsis(remarks, max(16, width - 20)))], width
            )
            lines.append("")


def _normalize_validation_runs(td: Dict[str, Any], report_data: Dict[str, Any]) -> list:
    if not isinstance(td, dict):
        td = {}
    runs = td.get("validationRuns") or report_data.get("validationRuns")
    if runs and isinstance(runs, list) and len(runs) > 0:
        return [r if isinstance(r, dict) else {} for r in runs]
    return [
        {
            "usp": td.get("usp") or report_data.get("usp"),
            "validationSubtype": td.get("validationSubtype") or report_data.get("validationSubtype"),
            "rpm": td.get("rpm", report_data.get("rpm")),
            "timeMinutes": td.get("timeMinutes", report_data.get("timeMinutes")),
            "tapsMin": td.get("tapsMin", report_data.get("tapsMin")),
            "dropHeight": td.get("dropHeight", report_data.get("dropHeight")),
            "expectedTapCount": td.get("expectedTapCount", report_data.get("expectedTapCount")),
            "expectedTolerance": td.get("expectedTolerance", report_data.get("expectedTolerance")),
            "actualTapCount": td.get("actualTapCount", report_data.get("actualTapCount")),
            "validationDurationSec": td.get("validationDurationSec", report_data.get("validationDurationSec") or td.get("durationSeconds", report_data.get("durationSeconds"))),
            "durationSeconds": td.get("durationSeconds", report_data.get("durationSeconds")),
            "durationSec": td.get("durationSec", report_data.get("durationSec")),
            "status": td.get("status", report_data.get("status")),
            "validationStartTime": td.get("validationStartTime", report_data.get("validationStartTime") or td.get("testStartTime", report_data.get("testStartTime"))),
            "validationEndTime": td.get("validationEndTime", report_data.get("validationEndTime") or td.get("testEndTime", report_data.get("testEndTime"))),
            "completedAt": td.get("completedAt", report_data.get("completedAt")),
            "testStartTime": td.get("testStartTime", report_data.get("testStartTime")),
            "testEndTime": td.get("testEndTime", report_data.get("testEndTime")),
            # DT stroke / temp fields
            "basket": td.get("basket", report_data.get("basket")),
            "beaker": td.get("beaker", report_data.get("beaker")),
            "strokesPerMin": td.get("strokesPerMin", report_data.get("strokesPerMin")),
            "pulsesSeen": td.get("pulsesSeen", report_data.get("pulsesSeen")),
            "actualStrokes": td.get("actualStrokes", report_data.get("actualStrokes")),
            "requiredRange": td.get("requiredRange", report_data.get("requiredRange")),
            "setTemperature": td.get("setTemperature", report_data.get("setTemperature")),
            "minTemp": td.get("minTemp", report_data.get("minTemp")),
            "maxTemp": td.get("maxTemp", report_data.get("maxTemp")),
            "maxDeviation": td.get("maxDeviation", report_data.get("maxDeviation")),
            "requiredDeviation": td.get("requiredDeviation", report_data.get("requiredDeviation")),
            "sensorSilent": td.get("sensorSilent", report_data.get("sensorSilent")),
        }
    ]


def _is_friability_validation_run(run: Dict[str, Any]) -> bool:
    """Legacy name kept for call sites — true for DT stroke/temp/calibration validation."""
    sub = str(run.get("validationSubtype") or "").strip().lower()
    return sub in ("stroke", "temp", "temperature", "calibration", "usp") or bool(run.get("strokesPerMin") is not None)


def _validation_run_detail_pairs(run: Dict[str, Any]) -> list:
    pairs = [
        ("Start Time", _format_ts_readable(run.get("validationStartTime") or run.get("testStartTime"))),
        ("End Time", _format_ts_readable(run.get("validationEndTime") or run.get("testEndTime") or run.get("completedAt"))),
    ]
    sub = str(run.get("validationSubtype") or "").strip().lower()
    if sub == "stroke" or run.get("strokesPerMin") is not None or run.get("actualStrokes") is not None:
        actual = run.get("actualStrokes")
        if actual is None:
            actual = run.get("pulsesSeen")
        if actual is None:
            actual = run.get("strokesPerMin")
        pairs.extend([
            ("Basket", _cell_str(run.get("basket") or run.get("beaker"))),
            ("Actual Strokes", _cell_str(actual)),
            ("Strokes/Min", _cell_str(run.get("strokesPerMin") if run.get("strokesPerMin") is not None else actual)),
            ("Required Range", _cell_str(run.get("requiredRange") or "29-32") + " strokes/min"),
        ])
    elif sub in ("temp", "temperature"):
        pairs.extend([
            ("Basket", _cell_str(run.get("basket") or run.get("beaker"))),
            ("Set Temp (°C)", _cell_str(run.get("setTemperature"))),
            ("Min Temp (°C)", _cell_str(run.get("minTemp"))),
            ("Max Temp (°C)", _cell_str(run.get("maxTemp"))),
            ("Max Deviation", _cell_str(run.get("maxDeviation"))),
            ("Limit (±°C)", _cell_str(run.get("requiredDeviation") or "2.0")),
        ])
    elif sub == "calibration":
        # Calibration details are rendered via _append_calibration_report_details
        pairs.extend([
            ("Procedure", "Temperature Calibration"),
            ("Status", "Temperature Calibrated"),
        ])
    else:
        pairs.extend([
            ("Basket", _cell_str(run.get("basket") or run.get("beaker"))),
            ("Expected", _validation_expected_display(run)),
            ("Actual", _cell_str(_validation_actual_value(run))),
        ])
    # Intentionally omit Within Spec — operator Pass/Fail is the approval result.
    status = run.get("status")
    status_s = str(status or "").strip().upper()
    if status_s in ("PASSED", "FAILED") and run.get("approvalPassFail"):
        pairs.append(("Status", _cell_str(run.get("approvalPassFail"))))
    else:
        pairs.append(("Status", _cell_str(status)))
    return pairs


def _validation_usp_label(run: Dict[str, Any]) -> str:
    sub = str(run.get("validationSubtype") or "").strip().lower()
    if sub == "stroke":
        return "Stroke Rate"
    if sub in ("temp", "temperature"):
        return "Temperature Hold"
    if sub == "calibration":
        return "Calibration"
    usp = run.get("usp")
    if usp:
        return str(usp)
    return "Validation"


def _validation_overall_status_label(td: Dict[str, Any], report_data: Dict[str, Any]) -> str:
    overall = td.get("status") or report_data.get("status") or "--"
    s = str(overall).strip()
    low = s.lower()
    if low == "pass":
        return "Pass"
    if low == "fail":
        return "Fail"
    if low == "aborted":
        return "Aborted"
    return s or "--"


def _validation_duration_sec(run: Dict[str, Any]):
    """Seconds for a validation run, if available."""
    if not isinstance(run, dict):
        return None
    for key in ("validationDurationSec", "durationSeconds", "durationSec", "elapsedSeconds"):
        val = run.get(key)
        if val in (None, "", "--"):
            continue
        try:
            return float(val)
        except (TypeError, ValueError):
            continue
    return None


def _validation_time_minutes(run: Dict[str, Any]):
    """Duration in minutes for thermal display (legacy friability + DT)."""
    dur = _validation_duration_sec(run)
    if dur is not None:
        return round(dur / 60.0, 2) if dur >= 60 else round(dur / 60.0, 3)
    for key in ("durationMinutes", "setDurationMinutes", "timeMinutes"):
        val = run.get(key) if isinstance(run, dict) else None
        if val in (None, "", "--"):
            continue
        try:
            return float(val)
        except (TypeError, ValueError):
            continue
    return None


def _format_thermal_validation_runs_block(runs: list, width: int = THERMAL_WIDTH) -> list:
    """Thermal VALIDATION RESULTS — DT stroke / temperature / calibration."""
    w = width
    lines = ["", "VALIDATION RESULTS", _thermal_sep("-", w)]
    for idx, run in enumerate(runs or []):
        if not isinstance(run, dict):
            continue
        if idx > 0:
            lines.append("")
        lines.append(_validation_usp_label(run))
        for label, value in _validation_run_detail_pairs(run):
            lines.append(f"{label}: {_cell_str(value)}")
        dur = _validation_duration_sec(run)
        if dur is not None:
            try:
                lines.append(f"Duration: {int(dur)} s")
            except (TypeError, ValueError):
                pass
    if not any(isinstance(r, dict) for r in (runs or [])):
        lines.append("No validation data")
    lines.extend(["", _thermal_sep("-", w), ""])
    return lines


def _append_validation_report_details(
    lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool
) -> None:
    if not isinstance(td, dict):
        td = {}
    runs = _normalize_validation_runs(td, report_data)
    overall_label = _validation_overall_status_label(td, report_data)
    ts_end = (
        report_data.get("validationEndTime")
        or td.get("validationEndTime")
        or report_data.get("testEndTime")
        or td.get("testEndTime")
        or (runs[-1].get("validationEndTime") if runs else None)
        or (runs[-1].get("testEndTime") if runs else None)
        or report_data.get("completedAt")
        or td.get("completedAt")
        or (runs[-1].get("completedAt") if runs else None)
        or report_data.get("createdAt")
        or td.get("createdAt")
    )
    ts_start = (
        report_data.get("validationStartTime")
        or td.get("validationStartTime")
        or report_data.get("testStartTime")
        or td.get("testStartTime")
        or (runs[0].get("validationStartTime") if runs else None)
        or (runs[0].get("testStartTime") if runs else None)
        or report_data.get("createdAt")
        or td.get("createdAt")
    )
    remarks = report_data.get("approvalRemarks")
    if remarks in (None, ""):
        remarks = report_data.get("remarks")
    if remarks in (None, ""):
        remarks = td.get("remarks")
    dash = "" if thermal else ("-" * width)

    if thermal:
        start_date, start_time = _split_ts_date_and_time(ts_start)
        end_date, end_time = _split_ts_date_and_time(ts_end)
        lines.extend(
            [
                "",
                "VALIDATION INFORMATION",
                f"Overall Status: {overall_label}",
                f"Start Date: {start_date}",
                f"Start Time: {start_time}",
                f"Completed Date: {end_date}",
                f"Completed Time: {end_time}",
                "",
            ]
        )
        if runs:
            lines.extend(_format_thermal_validation_runs_block(runs, width))
        else:
            lines.extend(["", "VALIDATION RESULTS", "No validation data", ""])
    else:
        lines.extend(["", "VALIDATION INFORMATION", dash if dash else ""])
        _append_two_column_pairs(
            lines,
            [
                ("Overall Status", overall_label),
                ("Start Time", _format_ts_readable(ts_start)),
                ("Completed", _format_ts_readable(ts_end)),
            ],
            width,
        )
        lines.extend(["", "VALIDATION RESULTS", dash if dash else ""])
        if not runs:
            lines.append("No validation data")
        for idx, run in enumerate(runs):
            if idx > 0:
                lines.append("")
            lines.append(_validation_usp_label(run))
            _append_two_column_pairs(lines, _validation_run_detail_pairs(run), width)
        lines.append("")

    if remarks not in (None, ""):
        if thermal:
            lines.extend(["", "REMARKS:", str(remarks), ""])
        else:
            lines.extend(["", "REMARKS", dash if dash else ""])
            _append_two_column_pairs(lines, [("Remarks", _truncate_with_ellipsis(remarks, max(16, width - 20)))], width)
            lines.append("")


def _format_thermal_run_detail_lines(td: Dict[str, Any], run_details: Any, width: int = THERMAL_WIDTH) -> list:
    mode = _cell_str(td.get("mode")) if isinstance(td, dict) else "--"
    target = _cell_str(td.get("target")) if isinstance(td, dict) else "--"
    details = str(run_details or "").strip()
    prefix = details
    if details:
        marker = "Mode:"
        idx = details.find(marker)
        if idx >= 0:
            prefix = details[:idx].strip(" ,.")
            rest = details[idx:]
            target_idx = rest.find("Target:")
            if target_idx >= 0:
                mode = rest[len("Mode:"):target_idx].strip(" ,")
                target = rest[target_idx + len("Target:"):].strip(" ,")
            else:
                mode = rest[len("Mode:"):].strip(" ,")
    lines = ["Run Details:"]
    if prefix:
        lines.extend(_fit_thermal_line(prefix + ".", width))
    if mode and mode != "--":
        lines.append(f"Mode: {mode}")
    if target and target != "--":
        lines.append(f"Target: {target}")
    return lines


def _resolve_print_basket(td: Dict[str, Any], report_data: Dict[str, Any]):
    for src in (report_data, td, report_data.get("reportDerived") if isinstance(report_data.get("reportDerived"), dict) else {}):
        if not isinstance(src, dict):
            continue
        for key in ("beaker", "basket"):
            try:
                b = int(src.get(key))
                if b in (1, 2):
                    return b
            except (TypeError, ValueError):
                continue
    return "--"


def _resolve_print_set_temp(td: Dict[str, Any], report_data: Dict[str, Any]):
    derived = report_data.get("reportDerived") if isinstance(report_data.get("reportDerived"), dict) else {}
    for src in (td, report_data, derived):
        if not isinstance(src, dict):
            continue
        for key in ("setTemperature", "temp", "temperature"):
            val = src.get(key)
            if val not in (None, "", "--"):
                return val
    return "--"


def _disintegration_stat_pairs(stats: Any) -> list:
    """Normalize statistics to First / Last / Mean tube-completion rows."""
    if not isinstance(stats, dict) or not stats:
        return [("First", "N/A"), ("Last", "N/A"), ("Mean", "N/A")]
    def _val(row):
        if isinstance(row, dict):
            return row.get("value", "N/A")
        return row if row is not None else "N/A"
    if "First" in stats or "Last" in stats or "Mean" in stats:
        return [
            ("First", _val(stats.get("First"))),
            ("Last", _val(stats.get("Last"))),
            ("Mean", _val(stats.get("Mean"))),
        ]
    return [
        ("First", _val(stats.get("First Tap"))),
        ("Last", _val(stats.get("Last") or stats.get("Completion"))),
        ("Mean", _val(stats.get("Mean"))),
    ]


def _append_test_report_details(lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool) -> None:
    """Append DT run details, vessel times, then remarks/comments."""
    dash = "" if thermal else ("-" * width)
    remarks = report_data.get("approvalRemarks")
    if remarks in (None, ""):
        remarks = report_data.get("remarks")
    if remarks in (None, "") and isinstance(td, dict):
        remarks = td.get("remarks")

    # Only auto-fill power-interruption comments for true power-loss finals.
    # Operator Abort must show Aborted (or stay blank) — never invent power failure.
    if remarks in (None, ""):
        cause = str(
            report_data.get("abortCause")
            or (td.get("abortCause") if isinstance(td, dict) else "")
            or ""
        ).strip().lower()
        approved_by = str(report_data.get("approvedBy") or "").strip().lower()
        is_power = (
            cause in ("power_interruption", "power_loss", "power")
            or "power interruption" in approved_by
        )
        if is_power:
            remarks = "power interruption"
        elif report_data.get("aborted") or str(report_data.get("status") or "").strip().lower() in (
            "aborted",
            "test aborted",
        ):
            remarks = "Aborted"

    if not isinstance(td, dict):
        td = {}

    basket = _resolve_print_basket(td, report_data)
    mode = td.get("mode") or report_data.get("mode") or "--"
    cfg = td.get("basketConfig") or report_data.get("basketConfig") or "--"
    set_temp = _resolve_print_set_temp(td, report_data)
    min_temp = td.get("minTemp") if td.get("minTemp") is not None else report_data.get("minTemp")
    max_temp = td.get("maxTemp") if td.get("maxTemp") is not None else report_data.get("maxTemp")
    mode_l = str(mode).lower()
    derived = report_data.get("reportDerived") if isinstance(report_data.get("reportDerived"), dict) else {}
    duration = (
        td.get("duration")
        or report_data.get("duration")
        or derived.get("durationFormatted")
        or "--"
    )
    if duration in (None, "", "--", "N/A"):
        dur_sec = td.get("durationSeconds")
        if dur_sec in (None, ""):
            dur_sec = report_data.get("durationSeconds")
        if dur_sec in (None, ""):
            dur_sec = derived.get("durationSeconds")
        if dur_sec not in (None, ""):
            try:
                from report_service import format_duration_hhmmss

                duration = format_duration_hhmmss(dur_sec)
            except Exception:
                duration = str(dur_sec)
    status = td.get("status") or report_data.get("status") or "--"

    detail_pairs = [
        ("Basket/Beaker", basket),
        ("Mode", str(mode).upper() if mode else "--"),
        ("Tube Count", cfg),
        ("Set Temperature (°C)", set_temp if set_temp is not None else "--"),
        ("Min Temperature (°C)", min_temp if min_temp is not None else "--"),
        ("Max Temperature (°C)", max_temp if max_temp is not None else "--"),
        ("Test Duration", duration),
        ("Test Status", status),
    ]
    if mode_l == "timer":
        set_dur = td.get("setDuration") or td.get("setDurationMinutes")
        if set_dur is not None:
            detail_pairs.insert(4, ("Set Duration", set_dur))

    # STATISTICS: first / last tube completion (manual); omitted for timer
    stats = report_data.get("statistics") if isinstance(report_data.get("statistics"), dict) else None
    if not stats and isinstance(td.get("statistics"), dict):
        stats = td.get("statistics")
    if not stats:
        try:
            from report_service import compute_test_report_statistics

            stats_src = dict(td) if isinstance(td, dict) else {}
            for k in ("mode", "basketConfig", "holeCompletionTimes", "vesselTimes", "durationSeconds"):
                if not stats_src.get(k) and report_data.get(k) not in (None, ""):
                    stats_src[k] = report_data.get(k)
            stats = compute_test_report_statistics(stats_src) or {}
        except Exception:
            stats = {}
    show_stats = mode_l != "timer"
    stats_pairs = _disintegration_stat_pairs(stats) if show_stats else []

    if thermal:
        lines.extend(["", "TEST DETAILS"])
        for k, v in detail_pairs:
            lines.append(f"{k}: {_cell_str(v)}")
        if show_stats:
            lines.extend(["", "STATISTICS"])
            for k, v in stats_pairs:
                lines.append(f"{k}: {_cell_str(v)}")
    else:
        eq = _section_sep("=", width, False)
        lines.extend(["", eq, "TEST DETAILS", dash if dash else ""])
        _append_two_column_pairs(lines, [(k, _cell_str(v)) for k, v in detail_pairs], width)
        if show_stats:
            lines.extend(["", eq, "STATISTICS", dash if dash else ""])
            _append_two_column_pairs(lines, [(k, _cell_str(v)) for k, v in stats_pairs], width)

    vessel_times = td.get("vesselTimes") or report_data.get("vesselTimes") or {}
    if isinstance(vessel_times, dict) and vessel_times and str(mode).lower() == "manual":
        if thermal:
            lines.extend(["", "TUBE COMPLETION TIMES"])
            for n in sorted(vessel_times.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x)):
                lines.append(f"Tube {n}: {vessel_times[n]}")
        else:
            lines.extend(["", "TUBE COMPLETION TIMES", dash if dash else ""])
            pairs = [(f"Tube {n}", vessel_times[n]) for n in sorted(vessel_times.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x))]
            _append_two_column_pairs(lines, pairs, width)

    if remarks not in (None, ""):
        if thermal:
            lines.extend(["", "REMARKS:", str(remarks), ""])
        else:
            lines.extend(["", "REMARKS", dash if dash else ""])
            _append_two_column_pairs(lines, [("Comments", _truncate_with_ellipsis(remarks, max(16, width - 20)))], width)
            lines.append("")


def _validation_expected_value(run: Dict[str, Any]):
    if not isinstance(run, dict):
        return None
    for key in ("expectedTapCount", "expectedRotationCount", "requiredRange"):
        if run.get(key) not in (None, "", "--"):
            return run.get(key)
    return None


def _validation_actual_value(run: Dict[str, Any]):
    if not isinstance(run, dict):
        return None
    for key in ("actualTapCount", "actualRotationCount", "strokesPerMin", "maxDeviation"):
        if run.get(key) not in (None, "", "--"):
            return run.get(key)
    return None


def _validation_expected_display(run: Dict[str, Any]) -> str:
    expected = _validation_expected_value(run)
    if expected is None:
        expected = "--"
    return _cell_str(expected)


def _format_report_text(report_data: Dict[str, Any], width: int = A4_TEXT_WIDTH) -> str:
    thermal = width < 70
    sep = _thermal_sep("=", width) if thermal else ("=" * width)
    sep_dash = _thermal_sep("-", width) if thermal else ("-" * width)
    td = report_data.get("testData") or report_data
    approval_result = _effective_approval_result(report_data if isinstance(report_data, dict) else {}, td if isinstance(td, dict) else {})
    if isinstance(td, dict) and approval_result:
        td = dict(td)
        td["approvalPassFail"] = approval_result
    if isinstance(report_data, dict) and approval_result and not report_data.get("approvalPassFail"):
        report_data = dict(report_data)
        report_data["approvalPassFail"] = approval_result
    fs = report_data.get("factorySettings") or {}
    rtype = str(report_data.get("type") or "test").strip().lower()
    is_cal = _is_calibration_report(report_data)
    if is_cal:
        title = "DISINTEGRATION CALIBRATION REPORT"
    elif rtype == "validation":
        title = "DISINTEGRATION VALIDATION REPORT"
    else:
        title = "DISINTEGRATION TEST REPORT"
    lines: list = []
    if thermal:
        # Logo raster already includes RAISE LAB EQUIPMENT — do not repeat the brand line.
        lines.extend([sep, "Tablet Disintegration Tester", ""])
    else:
        lines.extend([sep, "RAISE LAB EQUIPMENT".center(width), "Tablet Disintegration Tester".center(width), ""])
    lines.append(title if thermal else title.center(width))
    if thermal:
        lines.append("")
    else:
        lines.append(sep)
    header_pairs = [
        ("Company", fs.get("companyName", "N/A")),
        ("Model No", fs.get("modelNo", "N/A")),
        ("Serial No", fs.get("serialNo", "N/A")),
        ("Location", fs.get("companyLocation", fs.get("location", "N/A"))),
        ("Instrument ID", fs.get("instrumentId", "N/A")),
    ]
    if not is_cal:
        header_pairs.extend([
            ("Last Val", fs.get("lastValidationDate", "N/A")),
            ("Next Val Due", fs.get("nextValidationDate", "N/A")),
        ])
    if thermal:
        for label, value in header_pairs:
            lines.append(f"{label}: {value}")
    else:
        _append_two_column_pairs(lines, header_pairs, width)
    if not thermal:
        lines.append("")
    if is_cal:
        _append_calibration_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    elif rtype == "validation":
        _append_validation_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    else:
        recipe = report_data.get("recipe") or td.get("recipe") or td
        if not isinstance(recipe, dict):
            recipe = {}
        status_raw = str(td.get("status", "")).lower() if isinstance(td, dict) else ""
        status_label = "Aborted" if status_raw == "aborted" else "Completed"
        derived = report_data.get("reportDerived")
        if not isinstance(derived, dict) or not derived:
            derived = build_test_report_derived(
                td if isinstance(td, dict) else {},
                recipe,
                report_data.get("id"),
                report=report_data if isinstance(report_data, dict) else None,
            )
        else:
            # Refresh basket / set temp from top-level fields when stale derived defaults to 1 / --
            try:
                derived = dict(derived)
                derived.update(
                    build_test_report_derived(
                        td if isinstance(td, dict) else {},
                        recipe,
                        report_data.get("id"),
                        report=report_data if isinstance(report_data, dict) else None,
                    )
                )
            except TypeError:
                pass
        ts_start = (
            td.get("testStartTime")
            or report_data.get("testStartTime")
            or report_data.get("createdAt")
            or td.get("createdAt")
        )
        ts_end = (
            td.get("testEndTime")
            or report_data.get("testEndTime")
            or report_data.get("completedAt")
            or td.get("completedAt")
            or report_data.get("createdAt")
            or td.get("createdAt")
        )
        start_date, start_time = _split_ts_date_and_time(ts_start)
        end_date, end_time = _split_ts_date_and_time(ts_end)
        batch_no = (
            derived.get("batchNumber")
            or report_data.get("batchNumber")
            or recipe.get("batchNumber")
            or (td.get("batchNumber") if isinstance(td, dict) else None)
            or report_data.get("batch1")
            or report_data.get("batch2")
            or (td.get("batch1") if isinstance(td, dict) else None)
            or (td.get("batch2") if isinstance(td, dict) else None)
            or "N/A"
        )
        if batch_no in (None, "", "N/A"):
            b1 = (td.get("batchNumber1") if isinstance(td, dict) else None) or recipe.get("batchNumber1")
            b2 = (td.get("batchNumber2") if isinstance(td, dict) else None) or recipe.get("batchNumber2")
            if b1 or b2:
                batch_no = f"D1: {b1 or '--'}" + (f" | D2: {b2}" if b2 else "")
        product_name = (
            derived.get("productName")
            or report_data.get("productName")
            or report_data.get("name")
            or recipe.get("productName")
            or recipe.get("name")
            or (td.get("productName") if isinstance(td, dict) else None)
            or (td.get("name") if isinstance(td, dict) else None)
            or "N/A"
        )
        media_val = (
            derived.get("media")
            or report_data.get("media")
            or recipe.get("media")
            or (td.get("media") if isinstance(td, dict) else None)
            or "--"
        )
        mesh_val = (
            derived.get("mesh")
            or report_data.get("mesh")
            or recipe.get("mesh")
            or (td.get("mesh") if isinstance(td, dict) else None)
            or "--"
        )
        info_basket = derived.get("basket")
        if info_basket in (None, "", "--"):
            info_basket = _resolve_print_basket(td if isinstance(td, dict) else {}, report_data if isinstance(report_data, dict) else {})
        info_set_temp = derived.get("setTemperature")
        if info_set_temp in (None, "", "--"):
            info_set_temp = _resolve_print_set_temp(td if isinstance(td, dict) else {}, report_data if isinstance(report_data, dict) else {})
        if thermal:
            info_lines = [
                sep,
                "TEST INFORMATION",
                f"Product: {product_name}",
                f"Batch No: {batch_no}",
                f"Media: {media_val}",
                f"Mesh: {mesh_val}",
                f"Basket: {info_basket}",
                f"Mode: {derived.get('mode', td.get('mode', '--'))}",
                f"Set Temp: {info_set_temp} C",
                f"Min Temp: {td.get('minTemp', report_data.get('minTemp', '--'))} C",
                f"Max Temp: {td.get('maxTemp', report_data.get('maxTemp', '--'))} C",
                f"Tubes: {derived.get('basketConfig', td.get('basketConfig', '--'))}",
                f"Test Start Date: {start_date}",
                f"Test Start Time: {start_time}",
                f"Completed Date: {end_date}",
                f"Completed Time: {end_time}",
                f"Status: {status_label}",
            ]
            lines.extend(info_lines)
        else:
            _append_two_column_pairs(
                lines,
                [
                    ("Product", product_name),
                    ("Batch No", batch_no),
                    ("Media", media_val),
                    ("Mesh", mesh_val),
                    ("Basket", info_basket),
                    ("Mode", derived.get("mode", td.get("mode", "--"))),
                    ("Set Temp (°C)", info_set_temp),
                    ("Min Temp (°C)", td.get("minTemp", report_data.get("minTemp", "--"))),
                    ("Max Temp (°C)", td.get("maxTemp", report_data.get("maxTemp", "--"))),
                    ("Tube Count", derived.get("basketConfig", td.get("basketConfig", "--"))),
                    ("Test Start Date", start_date),
                    ("Test Start Time", start_time),
                    ("Completed Date", end_date),
                    ("Completed Time", end_time),
                    ("Status", status_label),
                ],
                width,
            )
        _append_test_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    if thermal:
        lines.extend(["", "APPROVAL"])
    approval_pairs = _approval_result_pairs(
        report_data if isinstance(report_data, dict) else {},
        td if isinstance(td, dict) else {},
        rtype,
    )
    if thermal:
        lines.extend(
            [
                f"Operated by: {report_data.get('operatorName') or td.get('operatorName', '--')}",
                f"Employee ID: {_resolve_employee_id(report_data, td)}",
            ]
        )
        for label, value in approval_pairs:
            lines.append(f"{label}: {value}")
        approver_name = _strip_approver_role_label(report_data.get("approvedBy"))
        approver_id = report_data.get("approvedByUsername") or "--"
        approval_remarks = report_data.get("approvalRemarks")
        if approval_remarks in (None, ""):
            approval_remarks = report_data.get("remarks")
        if approval_remarks in (None, ""):
            approval_remarks = td.get("remarks") if isinstance(td, dict) else None
        lines.extend(
            [
                f"Approved By: {approver_name}",
                f"Approver ID: {approver_id}",
                f"Approved At: {_format_ts_readable(report_data.get('approvedAt'))}",
                f"Approval Remarks: {_cell_str(approval_remarks) if approval_remarks not in (None, '') else 'N/A'}",
            ]
        )
    else:
        approval_remarks = report_data.get("approvalRemarks")
        if approval_remarks in (None, ""):
            approval_remarks = report_data.get("remarks")
        if approval_remarks in (None, ""):
            approval_remarks = td.get("remarks") if isinstance(td, dict) else None
        lines.extend(["", "APPROVAL", sep_dash])
        _append_two_column_pairs(
            lines,
            [
                ("Operated by", report_data.get("operatorName") or td.get("operatorName", "--")),
                ("Employee ID", _resolve_employee_id(report_data, td)),
            ] + approval_pairs + [
                ("Approved By", _strip_approver_role_label(report_data.get("approvedBy"))),
                ("Approver ID", report_data.get("approvedByUsername", "--")),
                ("Approved At", _format_ts_readable(report_data.get("approvedAt"))),
                (
                    "Approval Remarks",
                    _truncate_with_ellipsis(
                        approval_remarks if approval_remarks not in (None, "") else "N/A",
                        max(16, A4_TEXT_WIDTH - 20),
                    ),
                ),
            ],
            width,
        )
    if thermal:
        lines.extend([sep, ""])
        flat: list = []
        for line in lines:
            flat.extend(_fit_thermal_line(line, width))
        lines = _compact_thermal_lines(flat, width)
        return "\n".join(lines)
    return "\n".join(_wrap_lines(lines, width))


def format_for_a4_printer(
    report_data: Dict[str, Any],
    *,
    include_printed_timestamp: bool = True,
    timestamp_kind: str = "printed",
) -> str:
    try:
        from report_service import enrich_report_context

        report_data = enrich_report_context(dict(report_data or {}))
    except Exception:
        pass
    text = _format_report_text(report_data, width=A4_TEXT_WIDTH).rstrip("\n")
    if not include_printed_timestamp:
        return text
    footer = "\n".join(_report_timestamp_footer_lines(timestamp_kind))
    return text + "\n\n" + footer


def _report_timestamp_footer_lines(kind: str = "printed") -> list:
    """Date/time footer from device RTC. kind: 'printed' | 'exported'."""
    try:
        import rtc_service

        payload = rtc_service.get_device_wall_datetime_payload()
        pdate = payload.get("date") or "--"
        ptime = payload.get("time") or "--"
    except Exception:
        now = datetime.now()
        pdate = now.strftime("%d-%m-%Y")
        ptime = now.strftime("%H:%M:%S")
    label = "Exported" if str(kind or "").strip().lower() == "exported" else "Printed"
    return ["", f"{label} Date: {pdate}", f"{label} Time: {ptime}"]


def _thermal_printed_timestamp_lines() -> list:
    """Printed date/time from device RTC at format time."""
    return _report_timestamp_footer_lines("printed")


def _thermal_trailing_feed() -> str:
    return "\n" * THERMAL_POST_PRINT_FEED_LINES


def format_for_thermal_printer(
    report_data: Dict[str, Any], *, timestamp_kind: str = "printed"
) -> str:
    try:
        from report_service import enrich_report_context

        report_data = enrich_report_context(dict(report_data or {}))
    except Exception:
        pass
    text = _format_report_text(report_data, width=THERMAL_WIDTH).rstrip("\n")
    footer = "\n".join(_report_timestamp_footer_lines(timestamp_kind))
    return text + "\n\n" + footer + _thermal_trailing_feed()


def format_for_export(report_data: Dict[str, Any], *, thermal: bool = False) -> str:
    """A4/thermal text with Exported Date/Time at the end (for USB/file export)."""
    if thermal:
        return format_for_thermal_printer(report_data, timestamp_kind="exported")
    return format_for_a4_printer(
        report_data, include_printed_timestamp=True, timestamp_kind="exported"
    )


def save_report_text_files(report_data: Dict[str, Any], report_id: int, reports_dir: pathlib.Path) -> None:
    if not report_data or report_id is None:
        return
    try:
        reports_dir = pathlib.Path(reports_dir)
        reports_dir.mkdir(parents=True, exist_ok=True)
        # Stored text matches preview: no Printed/Exported stamp (stamped at live print/export).
        text_48 = _format_report_text(report_data, width=THERMAL_WIDTH).rstrip("\n") + _thermal_trailing_feed()
        text_80 = format_for_a4_printer(report_data, include_printed_timestamp=False).rstrip() + "\r\n\x0c"
        (reports_dir / f"report_{report_id}_a4.txt").write_text(text_80, encoding="utf-8")
        (reports_dir / f"report_{report_id}_thermal.txt").write_text(text_48, encoding="utf-8")
    except Exception as e:
        _log.warning("save_report_text_files failed: %s", e)


def print_report_from_file(txt_path: pathlib.Path, port: str, baud: int, printer_type: str = "a4") -> Dict[str, Any]:
    kind = "thermal" if printer_type == "thermal" else "a4"
    lock = _print_locks[kind]
    if not lock.acquire(blocking=False):
        return {"success": False, "error": f"{kind.upper()} printer busy — wait for the current print to finish", "port": port}
    try:
        txt_path = pathlib.Path(txt_path)
        if not txt_path.exists() or not txt_path.is_file():
            return {"success": False, "error": f"Report file not found: {txt_path}", "port": port}
        if not serial:
            return {"success": False, "error": "pyserial not installed", "port": port}
        if printer_type == "thermal":
            try:
                port = _probe_port(port, THERMAL_CANDIDATES)
            except FileNotFoundError as e:
                return {"success": False, "error": f"Printer port not found: {e.filename or port}", "port": port}
        elif not _port_exists(port):
            return {"success": False, "error": f"Printer port not found: {port}", "port": port}
        try:
            data = txt_path.read_bytes()
            if printer_type == "a4":
                ser = _open_a4_serial(port, baud)
                try:
                    ser.reset_output_buffer()
                    ser.flush()
                    _send_printer_init(ser)
                    _send_bytes_chunked(ser, data, baud, chunk_size=512)
                    time.sleep(0.5)
                    return {"success": True, "port": port}
                finally:
                    ser.close()
            ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
            try:
                _send_printer_init(ser)
                time.sleep(0.2)
                _send_thermal_logo(ser, baud)
                _send_text_to_thermal(ser, data.decode("utf-8", errors="replace"), baud)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        except Exception as e:
            return {"success": False, "error": str(e), "port": port}
    finally:
        lock.release()


def print_a4_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    lock = _print_locks["a4"]
    if not lock.acquire(blocking=False):
        return {"success": False, "error": "A4 printer busy — wait for the current print to finish"}
    try:
        port = printer_port or _a4_port
        baud = _a4_baud
        if not serial:
            return {"success": False, "error": "pyserial not installed", "port": port}
        if not _port_exists(port):
            return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
        try:
            text = format_for_a4_printer(report_data).rstrip() + "\r\n\x0c"
            ser = _open_a4_serial(port, baud)
            try:
                ser.reset_output_buffer()
                ser.flush()
                _send_printer_init(ser)
                _send_text_to_a4(ser, text, baud)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        except Exception as e:
            return {"success": False, "error": str(e), "port": port}
    finally:
        lock.release()


def print_thermal_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    lock = _print_locks["thermal"]
    if not lock.acquire(blocking=False):
        return {"success": False, "error": "Thermal printer busy — wait for the current print to finish"}
    try:
        port = printer_port or _thermal_port
        baud = _thermal_baud
        if not serial:
            return {"success": False, "error": "pyserial not installed", "port": port}
        try:
            port = _probe_port(port, THERMAL_CANDIDATES)
        except FileNotFoundError as e:
            return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
        try:
            text = format_for_thermal_printer(report_data)
            ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
            try:
                _send_printer_init(ser)
                time.sleep(0.2)
                _send_thermal_logo(ser, baud)
                _send_text_to_thermal(ser, text, baud)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        except Exception as e:
            return {"success": False, "error": str(e), "port": port}
    finally:
        lock.release()


def _recipe_mode_label(recipe: Dict[str, Any]) -> str:
    mode = str(recipe.get("uspMode") or recipe.get("usp") or "").strip().upper()
    if mode == "USP":
        return "USP"
    if mode == "CUSTOM":
        comp = str(recipe.get("customCompletionMode") or "COUNT").strip().upper()
        if comp == "TIME":
            return "Custom (Time)"
        return "Custom (Count)"
    return "--"


def _recipe_rpm(recipe: Dict[str, Any]) -> Any:
    speed = recipe.get("speed")
    if speed not in (None, ""):
        return speed
    steps = recipe.get("steps") if isinstance(recipe.get("steps"), list) else []
    if steps and isinstance(steps[0], dict) and steps[0].get("speed") not in (None, ""):
        return steps[0].get("speed")
    return None


def _recipe_rotations(recipe: Dict[str, Any]) -> Any:
    for key in ("tabletCount", "customTotalTaps"):
        val = recipe.get(key)
        if val not in (None, ""):
            return val
    steps = recipe.get("steps") if isinstance(recipe.get("steps"), list) else []
    if len(steps) == 1 and isinstance(steps[0], dict):
        val = steps[0].get("tapCount")
        if val not in (None, ""):
            return val
    return None


def _recipe_time_display(recipe: Dict[str, Any]) -> str:
    time_seconds = recipe.get("timeSeconds")
    if time_seconds not in (None, ""):
        try:
            total = max(0, int(time_seconds))
            minutes, seconds = divmod(total, 60)
            return f"{minutes:02d}:{seconds:02d}"
        except (TypeError, ValueError):
            pass
    time_minutes = recipe.get("timeMinutes")
    if time_minutes not in (None, ""):
        try:
            total = max(0, int(round(float(time_minutes) * 60)))
            minutes, seconds = divmod(total, 60)
            return f"{minutes:02d}:{seconds:02d}"
        except (TypeError, ValueError):
            pass
    return "--"


def _append_recipe_detail_lines(lines: list, recipe: Dict[str, Any], thermal: bool) -> None:
    mode = str(recipe.get("uspMode") or recipe.get("usp") or "").strip().upper()
    completion = str(recipe.get("customCompletionMode") or "COUNT").strip().upper()
    name = recipe.get("productName") or recipe.get("name") or "N/A"
    batch = recipe.get("batchNumber") or recipe.get("batch")
    rpm = _recipe_rpm(recipe)
    rotations = _recipe_rotations(recipe)
    drum_count = recipe.get("drumCount")

    lines.append(f"Recipe Name: {name}")
    if batch not in (None, ""):
        lines.append(f"Batch No: {batch}")
    lines.append(f"Mode: {_recipe_mode_label(recipe)}")
    lines.append(f"RPM: {_cell_str(rpm)}")
    if mode == "USP":
        lines.append(f"Time: {_recipe_time_display(recipe)}")
        lines.append(f"Rotations: {_cell_str(rotations)}")
    elif mode == "CUSTOM":
        if completion == "TIME":
            lines.append(f"Time: {_recipe_time_display(recipe)}")
        else:
            lines.append(f"Rotations: {_cell_str(rotations)}")
    elif rotations not in (None, ""):
        lines.append(f"Rotations: {_cell_str(rotations)}")
    if drum_count not in (None, ""):
        lines.append(f"Drums: {_cell_str(drum_count)}")

    approved_by = recipe.get("recipeApprovedBy")
    if approved_by not in (None, ""):
        lines.append(f"Recipe Approved By: {_strip_approver_role_label(approved_by)}")
    approver_id = recipe.get("recipeApprovedByUsername")
    if approver_id not in (None, ""):
        lines.append(f"Approver ID: {approver_id}")


def _format_recipe_text(recipe_data: Dict[str, Any], width: int = A4_TEXT_WIDTH) -> str:
    thermal = width < 70
    sep = _thermal_sep("=", width) if thermal else ("=" * width)
    sep_dash = _thermal_sep("-", width) if thermal else ("-" * width)
    fs = recipe_data.get("factorySettings") or {}
    lines = [
        sep,
        "FRIABILITY RECIPE" if thermal else "FRIABILITY RECIPE".center(width),
        "",
        f"Company: {fs.get('companyName', 'N/A')}",
        f"Model No: {fs.get('modelNo', 'N/A')}",
        f"Serial No: {fs.get('serialNo', 'N/A')}",
        f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
        f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
        f"Last Val: {fs.get('lastValidationDate', 'N/A')}",
        f"Next Val Due: {fs.get('nextValidationDate', 'N/A')}",
        sep,
        "RECIPE DETAILS",
        sep_dash if thermal else "",
    ]
    _append_recipe_detail_lines(lines, recipe_data, thermal)
    lines.append(sep)
    if thermal:
        flat: list = []
        for line in lines:
            flat.extend(_fit_thermal_line(line, width))
        return "\n".join(_compact_thermal_lines(flat, width))
    return "\n".join(_wrap_lines(lines, width))


def print_recipe_a4(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    lock = _print_locks["a4"]
    if not lock.acquire(blocking=False):
        return {"success": False, "error": "A4 printer busy — wait for the current print to finish"}
    try:
        port = printer_port or _a4_port
        baud = _a4_baud
        if not serial:
            return {"success": False, "error": "pyserial not installed", "port": port}
        if not _port_exists(port):
            return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
        try:
            text = _format_recipe_text(recipe_data, width=A4_TEXT_WIDTH).rstrip() + "\r\n\x0c"
            ser = _open_a4_serial(port, baud)
            try:
                ser.reset_output_buffer()
                ser.flush()
                _send_printer_init(ser)
                _send_text_to_a4(ser, text, baud)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        except Exception as e:
            return {"success": False, "error": str(e), "port": port}
    finally:
        lock.release()


def print_recipe_thermal(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    lock = _print_locks["thermal"]
    if not lock.acquire(blocking=False):
        return {"success": False, "error": "Thermal printer busy — wait for the current print to finish"}
    try:
        port = printer_port or _thermal_port
        baud = _thermal_baud
        if not serial:
            return {"success": False, "error": "pyserial not installed", "port": port}
        try:
            port = _probe_port(port, THERMAL_CANDIDATES)
        except FileNotFoundError as e:
            return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
        try:
            text = _format_recipe_text(recipe_data, width=THERMAL_WIDTH).rstrip("\n")
            footer = "\n".join(_thermal_printed_timestamp_lines())
            text = text + "\n\n" + footer + _thermal_trailing_feed()
            ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
            try:
                _send_printer_init(ser)
                time.sleep(0.2)
                _send_thermal_logo(ser, baud)
                _send_text_to_thermal(ser, text, baud)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        except Exception as e:
            return {"success": False, "error": str(e), "port": port}
    finally:
        lock.release()
