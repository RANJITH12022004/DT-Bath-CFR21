#!/usr/bin/env python3
"""
print_service.py - Printing operations service
Handles A4 and thermal printer communication via RS232.
"""

import logging
import os
import serial
import time
import pathlib
from datetime import datetime
from typing import Dict, Any, Optional

import report_service
import calculation_service

try:
    import bridge_services
except ImportError:
    bridge_services = None

A4_CANDIDATES = ["/dev/ttyAMA4", "/dev/ttyUSB0", "/dev/ttyUSB1"]
THERMAL_CANDIDATES = ["/dev/ttyAMA3", "/dev/ttyUSB0", "/dev/ttyUSB1"]


def _probe_port(port: str, candidates: list) -> str:
    """Return first existing port. Raises FileNotFoundError if none found."""
    cands = ([port] if port else []) + [c for c in candidates if c and c != port]
    if bridge_services:
        return bridge_services.probe_and_choose_port(port, candidates=cands)
    if port and os.path.exists(port):
        return port
    for p in candidates:
        if p and os.path.exists(p):
            return p
    raise FileNotFoundError(2, "Serial device not found", port or "no-config")

# Module-level state
_config = {}
_a4_port = None
_a4_baud = None
_thermal_port = None
_thermal_baud = None


def init(config):
    """Initialize print service with config"""
    global _config, _a4_port, _a4_baud, _thermal_port, _thermal_baud
    _config = dict(config)
    _a4_port = _config.get("A4_PORT", "/dev/ttyAMA4")
    _a4_baud = int(_config.get("A4_BAUD", 9600))
    _thermal_port = _config.get("THERMAL_PORT", "/dev/ttyAMA3")
    _thermal_baud = int(_config.get("THERMAL_BAUD", 9600))


def check_printer_status(printer_type: str = "a4") -> Dict[str, Any]:
    """
    Check printer availability and status.
    
    Args:
        printer_type: "a4" or "thermal"
    
    Returns:
        Dict with status information
    """
    port = _a4_port if printer_type == "a4" else _thermal_port
    baud = _a4_baud if printer_type == "a4" else _thermal_baud
    
    if not port or not os.path.exists(port):
        return {
            "available": False,
            "error": f"Printer port not found: {port}",
            "port": port
        }
    
    try:
        # Try to open serial port
        ser = serial.Serial(port=port, baudrate=baud, timeout=1.0)
        ser.close()
        return {
            "available": True,
            "port": port,
            "baud": baud
        }
    except Exception as e:
        return {
            "available": False,
            "error": str(e),
            "port": port
        }


# ESC @ - Reset printer (ESC/P and ESC/POS). Many dot-matrix and thermal printers need this.
_PRINTER_INIT_SEQ = b'\x1b\x40'

_log = logging.getLogger(__name__)


def _open_a4_serial(port: str, baud: int) -> serial.Serial:
    """Open A4 serial port with explicit parameters. Retries once on failure."""
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
        ser = serial.Serial(**params)
        return ser
    except Exception as e:
        _log.warning("A4 serial open failed (port=%s, baud=%d): %s: %s", port, baud, type(e).__name__, e)
        time.sleep(0.5)
        try:
            ser = serial.Serial(**params)
            return ser
        except Exception as e2:
            _log.error("A4 serial open retry failed (port=%s, baud=%d): %s: %s", port, baud, type(e2).__name__, e2, exc_info=True)
            raise


def _send_printer_init(ser: serial.Serial) -> None:
    """Send ESC/P reset before data so printer is in known state."""
    ser.write(_PRINTER_INIT_SEQ)
    ser.flush()
    time.sleep(0.05)


def _send_text_chunked(ser: serial.Serial, text: str, baud: int, chunk_size: int = 64) -> None:
    """
    Send text to serial port in chunks to avoid buffer overflow.
    Thermal and RS232 printers often have small buffers (256B-4KB).
    """
    try:
        data = text.encode('utf-8', errors='replace')
    except Exception:
        data = text.encode('latin-1', errors='replace')
    delay = 0.08 if baud <= 9600 else 0.04
    for i in range(0, len(data), chunk_size):
        chunk = data[i:i + chunk_size]
        ser.write(chunk)
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)
    time.sleep(0.1)  # Final pause for printer to process last chunk


def _send_text_to_a4(ser: serial.Serial, text: str, baud: int) -> int:
    """
    Send text to A4 printer with \\r\\n line endings and dt sample chunk parameters.
    Returns number of bytes written.
    """
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    try:
        data = text.encode("utf-8", errors="replace")
    except Exception:
        data = text.encode("latin-1", errors="replace")
    chunk_size, delay = 512, 0.06
    for i in range(0, len(data), chunk_size):
        chunk = data[i : i + chunk_size]
        ser.write(chunk)
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)
    time.sleep(0.1)
    return len(data)


def _send_bytes_chunked(ser: serial.Serial, data: bytes, baud: int, chunk_size: int = 64) -> None:
    """Send raw bytes to serial port in chunks. Content is sent unchanged."""
    delay = 0.08 if baud <= 9600 else 0.04
    for i in range(0, len(data), chunk_size):
        chunk = data[i:i + chunk_size]
        ser.write(chunk)
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)
    time.sleep(0.1)


def save_report_text_files(report_data: Dict[str, Any], report_id: int, reports_dir: pathlib.Path) -> None:
    """
    Save full report as two text files: 70-char (A4/dot matrix) and 48-char (thermal).
    Does not raise; log and return on failure so report still saves to JSON.
    """
    if not report_data or report_id is None:
        return
    reports_dir = pathlib.Path(reports_dir)
    try:
        reports_dir.mkdir(parents=True, exist_ok=True)
        text_48 = _format_report_text(report_data, width=48)
        # A4 file: native 70-char format with ====, ---, and ** separators (not converted from thermal)
        text_70 = _format_report_text(report_data, width=70)
        text_70 = text_70.rstrip() + "\r\n\x0c"  # Form feed for A4 page eject
        path_a4 = reports_dir / f"report_{report_id}_a4.txt"
        path_thermal = reports_dir / f"report_{report_id}_thermal.txt"
        path_a4.write_text(text_70, encoding="utf-8")
        path_thermal.write_text(text_48, encoding="utf-8")
    except Exception as e:
        # Do not fail the API; report is already saved to JSON
        import logging
        logging.getLogger(__name__).warning("save_report_text_files failed: %s", e)


def print_report_from_file(txt_path: pathlib.Path, port: str, baud: int, printer_type: str = "a4") -> Dict[str, Any]:
    """
    Read report text file and send its exact contents (byte-for-byte) to the serial printer.
    No modification; same file content is sent in chunks to avoid buffer overflow.
    printer_type: "a4" or "thermal" - for A4 uses configured port only; for thermal uses port probing.
    """
    txt_path = pathlib.Path(txt_path)
    if not txt_path.exists() or not txt_path.is_file():
        return {"success": False, "error": f"Report file not found: {txt_path}", "port": port}
    if printer_type == "thermal":
        try:
            port = _probe_port(port, THERMAL_CANDIDATES)
        except FileNotFoundError as e:
            return {"success": False, "error": f"Printer port not found: {e.filename or port}", "port": port}
    elif printer_type == "a4":
        if not port or not os.path.exists(port):
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
                _log.info("A4 printer: wrote %d bytes to %s", len(data), port)
                return {"success": True, "port": port}
            finally:
                ser.close()
        else:
            ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
            try:
                _send_printer_init(ser)
                _send_bytes_chunked(ser, data, baud, chunk_size=64)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
    except Exception as e:
        if printer_type == "a4":
            _log.error("A4 serial open failed: %s (port=%s)", e, port, exc_info=True)
            # Provide more helpful error message for common issues
            error_msg = str(e)
            if "Permission denied" in error_msg or "Errno 13" in error_msg:
                error_msg = f"Permission denied. Ensure user is in 'dialout' group: {error_msg}"
            elif "No such file or directory" in error_msg or "Errno 2" in error_msg:
                error_msg = f"Port not found. Check A4_PORT configuration: {error_msg}"
            return {"success": False, "error": error_msg, "port": port}
        return {"success": False, "error": str(e), "port": port}


def print_a4_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    """
    Print report to A4 printer.
    
    Args:
        report_data: Report data to print
        printer_port: Optional printer port override
    
    Returns:
        Dict with success status
    """
    port = printer_port or _a4_port
    baud = _a4_baud
    if not port or not os.path.exists(port):
        return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
    try:
        formatted_text = format_for_a4_printer(report_data)
        formatted_text = formatted_text.rstrip() + '\r\n\x0c'  # Form feed for page eject
        ser = _open_a4_serial(port, baud)
        try:
            ser.reset_output_buffer()
            ser.flush()
            _send_printer_init(ser)
            n_bytes = _send_text_to_a4(ser, formatted_text, baud)
            time.sleep(0.5)
            _log.info("A4 printer: wrote %d bytes to %s", n_bytes, port)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        _log.error("A4 serial open failed: %s (port=%s)", e, port, exc_info=True)
        # Provide more helpful error message for common issues
        error_msg = str(e)
        if "Permission denied" in error_msg or "Errno 13" in error_msg:
            error_msg = f"Permission denied. Ensure user is in 'dialout' group: {error_msg}"
        elif "No such file or directory" in error_msg or "Errno 2" in error_msg:
            error_msg = f"Port not found. Check A4_PORT configuration: {error_msg}"
        return {"success": False, "error": error_msg, "port": port}


def print_thermal_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    """
    Print report to thermal printer.
    
    Args:
        report_data: Report data to print
        printer_port: Optional printer port override
    
    Returns:
        Dict with success status
    """
    port = printer_port or _thermal_port
    baud = _thermal_baud
    try:
        port = _probe_port(port, THERMAL_CANDIDATES)
    except FileNotFoundError as e:
        return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
    try:
        # Format report for thermal printer
        formatted_text = format_for_thermal_printer(report_data)
        formatted_text = formatted_text.rstrip("\n") + "\n\n"  # Trailing feed so printer flushes/ejects
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            _send_text_chunked(ser, formatted_text, baud, chunk_size=64)
            time.sleep(0.5)  # Allow printer to process
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "port": port
        }


def convert_thermal_to_a4_layout(text: str, width: int = 70) -> str:
    """
    Convert thermal layout text (48 chars) to A4 layout (70 chars).
    Merges wrapped lines and re-wraps at width. Inverse of convert_a4_to_thermal_layout.
    Same approach as dt sample: merge paragraphs, re-wrap at word boundaries.
    """
    if not text:
        return ""
    lines = text.splitlines()
    out = []
    paragraph = []
    prev_blank = False

    def flush_paragraph():
        if not paragraph:
            return
        merged = " ".join(p.strip() for p in paragraph if p.strip())
        paragraph.clear()
        if not merged:
            return
        # Wrap at width, prefer word boundaries (same logic as dt sample)
        while len(merged) > width:
            chunk = merged[:width]
            last_space = chunk.rfind(" ")
            if last_space > width // 2:
                out.append(merged[:last_space].rstrip())
                merged = merged[last_space:].lstrip()
            else:
                out.append(chunk)
                merged = merged[width:].lstrip() if merged[width:].strip() else merged[width:]
        if merged:
            out.append(merged)

    for line in lines:
        if not line.strip():
            flush_paragraph()
            if not prev_blank:
                out.append("")
                prev_blank = True
            continue
        prev_blank = False
        paragraph.append(line)

    flush_paragraph()
    return "\n".join(out)


def format_for_a4_printer(report_html: str) -> str:
    """
    Format report for A4 printer (70-char width).
    Uses native 70-char layout with ====, ---, and ** separators (same as saved A4 file).
    """
    # If input is report_data dict: use native 70-char format with separators
    if isinstance(report_html, dict):
        return _format_report_text(report_html, width=70)
    # If input is HTML string, basic conversion
    return report_html.replace('<br>', '\n').replace('</p>', '\n')


def format_for_thermal_printer(report_data: Dict[str, Any]) -> str:
    """
    Format report for thermal printer (48-char width).
    Converts report data to narrow thermal format.
    """
    return _format_report_text(report_data, width=48)


def _format_recipe_text(recipe_data: Dict[str, Any], width: int = 70) -> str:
    """
    Format recipe (tablet details only) for printing. Includes tolerances (T2-, T1-, NOM, T1+, T2+).
    """
    lines = []
    thermal = width < 70
    sep = "" if thermal else ("=" * width)
    decimals = 2

    def _param(r: dict, key: str) -> str:
        params = r.get("parameters") or {}
        key_lower = (key or "").lower()
        for k, v in params.items():
            if (k or "").lower() == key_lower and v is not None and v != "":
                return _non_negative_display(v, decimals)
        tol = r.get("parameterTolerances") or {}
        for k, t in tol.items():
            if (k or "").lower() == key_lower and isinstance(t, dict) and (t.get("nominal") not in (None, "")):
                return _non_negative_display(t["nominal"], decimals)
        return "--"

    product = recipe_data.get("productName") or recipe_data.get("name") or "N/A"
    batch = recipe_data.get("batchNumber") or recipe_data.get("batch") or "N/A"
    shape = str(recipe_data.get("shape") or "round").strip().lower()
    shape_cap = shape.capitalize()
    unit = recipe_data.get("unit") or "Newton (N)"
    sample_size = recipe_data.get("sampleSize") or 10
    distance_unit = recipe_data.get("distanceUnit") or "mm"

    lines.append(sep)
    lines.append("TABLET HARDNESS TESTER - RECIPE" if thermal else "TABLET HARDNESS TESTER - RECIPE".center(width))
    lines.append(sep)
    lines.append("")

    factory_settings = recipe_data.get("factorySettings", {}) or {}
    if factory_settings:
        lines.append(f"Company: {factory_settings.get('companyName', 'N/A')}")
        lines.append(f"Model No: {factory_settings.get('modelNo', 'N/A')}")
        lines.append(f"Serial No: {factory_settings.get('serialNo', 'N/A')}")
        lines.append(f"Location: {factory_settings.get('companyLocation') or factory_settings.get('location', 'N/A')}")
        lines.append(f"Instrument ID: {factory_settings.get('instrumentId', 'N/A')}")
        lines.append(f"Last Validation: {factory_settings.get('lastValidationDate', 'N/A')}")
        lines.append(f"Next Validation Due: {factory_settings.get('nextValidationDate', 'N/A')}")
        lines.append("")

    lines.append(f"Product: {product}")
    lines.append(f"Batch: {batch}")
    lines.append(f"Shape: {shape_cap}")
    lines.append(f"Thickness: {_param(recipe_data, 'Thickness')}")
    dim_key = "Length" if shape == "oblong" else "Diameter"
    lines.append(f"{dim_key}: {_param(recipe_data, dim_key)}")
    lines.append(f"Width: {_param(recipe_data, 'Width')}")
    if shape != "oblong":
        lines.append(f"Length: {_param(recipe_data, 'Length')}")
    lines.append(f"Hardness: {_param(recipe_data, 'Hardness')}")
    lines.append(f"Weight: {_param(recipe_data, 'Weight')}")
    lines.append(f"Unit: {unit}")
    lines.append(f"Sample Size: {sample_size}")
    lines.append("")

    # Tolerances: T2-, T1-, NOM, T1+, T2+ per parameter
    tolerances = recipe_data.get("parameterTolerances") or {}
    if tolerances:
        lines.append("TOLERANCES:" if thermal else "TOLERANCES".center(width))
        param_order = ["Thickness", "Diameter", "Length", "Width", "Hardness", "Weight"]
        for pkey in param_order:
            t = tolerances.get(pkey)
            if not isinstance(t, dict):
                continue
            t2_lo = _non_negative_display(t.get("lowerT2"), decimals)
            t1_lo = _non_negative_display(t.get("lowerT1"), decimals)
            params = recipe_data.get("parameters") or {}
            nom_val = t.get("nominal")
            if nom_val is None or nom_val == "":
                nom_val = params.get(pkey)
            nom = _non_negative_display(nom_val, decimals)
            t1_hi = _non_negative_display(t.get("upperT1"), decimals)
            t2_hi = _non_negative_display(t.get("upperT2"), decimals)
            weight_unit = recipe_data.get("weightUnit") or "gm"
            u = "mm" if pkey in ("Thickness", "Diameter", "Length", "Width") else (weight_unit if pkey == "Weight" else (unit.split()[0] if unit else "N"))
            if thermal:
                lines.append(f"  {pkey}: T2-={t2_lo} T1-={t1_lo}")
                lines.append(f"    NOM={nom} T1+={t1_hi} T2+={t2_hi} {u}")
            else:
                lines.append(f"  {pkey}: T2-={t2_lo} T1-={t1_lo} NOM={nom} T1+={t1_hi} T2+={t2_hi} {u}")
        lines.append("")

    lines.append(sep)

    if width < 70:
        wrapped = []
        for line in lines:
            if len(line) <= width:
                wrapped.append(line)
            else:
                words = line.split()
                current = ""
                for w in words:
                    if len(current + w) <= width:
                        current += (w + " " if current else w + " ")
                    else:
                        if current:
                            wrapped.append(current.rstrip())
                        current = w + " "
                if current:
                    wrapped.append(current.rstrip())
        lines = wrapped

    return "\n".join(lines)


def print_recipe_a4(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    """Print recipe (tablet details only) to A4 printer."""
    port = printer_port or _a4_port
    baud = _a4_baud
    if not port or not os.path.exists(port):
        return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
    try:
        text = _format_recipe_text(recipe_data, width=48)
        text = convert_thermal_to_a4_layout(text, width=70)
        text = text.rstrip() + "\r\n\x0c"  # Form feed
        ser = _open_a4_serial(port, baud)
        try:
            ser.reset_output_buffer()
            ser.flush()
            _send_printer_init(ser)
            n_bytes = _send_text_to_a4(ser, text, baud)
            time.sleep(0.5)
            _log.info("A4 printer: wrote %d bytes to %s", n_bytes, port)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        _log.error("A4 serial open failed: %s (port=%s)", e, port, exc_info=True)
        # Provide more helpful error message for common issues
        error_msg = str(e)
        if "Permission denied" in error_msg or "Errno 13" in error_msg:
            error_msg = f"Permission denied. Ensure user is in 'dialout' group: {error_msg}"
        elif "No such file or directory" in error_msg or "Errno 2" in error_msg:
            error_msg = f"Port not found. Check A4_PORT configuration: {error_msg}"
        return {"success": False, "error": error_msg, "port": port}


def print_recipe_thermal(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    """Print recipe (tablet details only) to thermal printer."""
    port = printer_port or _thermal_port
    baud = _thermal_baud
    try:
        port = _probe_port(port, THERMAL_CANDIDATES)
    except FileNotFoundError as e:
        return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
    try:
        text = _format_recipe_text(recipe_data, width=48)
        text = text.rstrip("\n") + "\n\n"
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            _send_text_chunked(ser, text, baud, chunk_size=64)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def _non_negative_display(val: Any, decimals: Optional[int] = None) -> str:
    """Display value as string; show actual measured value (including negative) for Pass/Fail/T1-T2."""
    if val is None or val == "" or val == "--":
        return "--" if val == "--" else str(val) if val is not None else ""
    if isinstance(val, str) and val.upper() == "OL":
        return "OL"
    try:
        n = float(val) if not isinstance(val, (int, float)) else float(val)
        if decimals is not None:
            return f"{n:.{decimals}f}"
        return str(int(n)) if n == int(n) else str(n)
    except (TypeError, ValueError):
        return str(val)


def _format_ts_readable(ts: Any) -> str:
    """Format ISO timestamp to DD/MM/YYYY HH:MM:SS (local time if offset-aware), matching report preview."""
    if ts is None:
        return "--"
    if isinstance(ts, datetime):
        dt = ts
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    s = str(ts).strip()
    if not s:
        return "--"
    try:
        s_iso = s.replace("Z", "+00:00").replace("z", "+00:00")
        dt = datetime.fromisoformat(s_iso)
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _format_validation_calibration_text(report_data: Dict[str, Any], width: int = 70) -> str:
    """
    Format validation or calibration report as plain text for printing.
    Output: Company, factory settings, validation/calibration details, remarks, operated-by, approved-by.
    """
    lines = []
    thermal = width < 70
    sep = "" if thermal else ("=" * width)

    report_type = report_data.get("type", "validation")
    title = "TABLET HARDNESS TESTER - VALIDATION REPORT" if report_type == "validation" else "TABLET HARDNESS TESTER - CALIBRATION REPORT"

    if thermal:
        lines.append("RAISE LAB EQUIPMENT")
        lines.append("")

    lines.append(sep)
    lines.append(title if thermal else title.center(width))
    lines.append(sep)
    lines.append("")

    factory_settings = report_data.get("factorySettings", {}) or {}
    if factory_settings:
        lines.append(f"Company: {factory_settings.get('companyName', 'N/A')}")
        lines.append(f"Location: {factory_settings.get('companyLocation', 'N/A')}")
        lines.append(f"Model No: {factory_settings.get('modelNo', 'N/A')}")
        lines.append(f"Serial No: {factory_settings.get('serialNo', 'N/A')}")
        lines.append(f"Instrument ID: {factory_settings.get('instrumentId', 'N/A')}")
        lines.append(f"Last Validation: {factory_settings.get('lastValidationDate', 'N/A')}")
        lines.append(f"Next Validation Due: {factory_settings.get('nextValidationDate', 'N/A')}")
        lines.append("")

    # Use current OS date/time instead of stored timestamp
    current_time = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    lines.append(f"Date/Time: {current_time}")
    lines.append("")

    test_data = report_data.get("testData", {}) or {}
    if report_type == "validation":
        subtype = report_data.get("validationSubtype", "load")
        if subtype == "load":
            lines.append("Load Validation Details:")
            lines.append(f"  Expected Weight: {report_data.get('expectedWeight', '--')} g")
            lines.append(f"  Min: {_non_negative_display(report_data.get('min'), 2)} g")
            lines.append(f"  Max: {_non_negative_display(report_data.get('max'), 2)} g")
            lines.append(f"  Mean: {_non_negative_display(report_data.get('mean'), 2)} g")
            lines.append(f"  Validation Status: {report_data.get('status', '--')}")
        else:
            lines.append("Distance Validation Details:")
            lines.append(f"  Gauge Value: {_non_negative_display(report_data.get('expectedGaugeBlock'), 2)} mm")
            lines.append(f"  Measured Value: {_non_negative_display(report_data.get('distance'), 2)} mm")
            diff = report_data.get("difference")
            if diff is not None:
                lines.append(f"  Difference: {diff:.2f} mm")
            lines.append(f"  Validation Status: {report_data.get('status', '--')}")
    else:
        lines.append(f"Calibration Status: {report_data.get('status', test_data.get('status', 'Calibrated'))}")

    lines.append("")

    op_name = test_data.get("operatorName") or test_data.get("operatedBy") or "N/A"
    emp_id = test_data.get("employeeId") or test_data.get("operatorId") or "N/A"
    lines.append(f"Operated by: {op_name}")
    lines.append(f"Employee ID: {emp_id}")
    lines.append("")

    if thermal:
        lines.append("Remarks:")
        lines.append("")
        lines.append("Approved by:")
        lines.append("")

    lines.append(sep)
    lines.append(f"Generated: {current_time}")
    lines.append(sep)

    if width < 70:
        wrapped_lines = []
        for line in lines:
            if len(line) <= width:
                wrapped_lines.append(line)
            else:
                words = line.split()
                current_line = ""
                for word in words:
                    if len(current_line + word) <= width:
                        current_line += (word + " " if current_line else word + " ")
                    else:
                        if current_line:
                            wrapped_lines.append(current_line.rstrip())
                        current_line = word + " "
                if current_line:
                    wrapped_lines.append(current_line.rstrip())
        lines = wrapped_lines

    return "\n".join(lines)


def _get_ci(d: Dict[str, Any], key: str) -> Any:
    """Get value from dict with case-insensitive key match (for params/measurements from frontend)."""
    if not d or not key:
        return None
    key_lower = (key or "").lower()
    for k, v in d.items():
        if (k or "").lower() == key_lower:
            return v
    return None


def _wrap_text_lines(lines: list, width: int) -> list:
    """Word-wrap long lines so table rows (e.g. TEST DATA) are not truncated at width."""
    wrapped_lines = []
    for line in lines:
        if len(line) <= width:
            wrapped_lines.append(line)
            continue
        words = line.split()
        current_line = ""
        for word in words:
            if len(current_line + word) <= width:
                current_line += (word + " " if current_line else word + " ")
            else:
                if current_line:
                    wrapped_lines.append(current_line.rstrip())
                current_line = word + " "
        if current_line:
            wrapped_lines.append(current_line.rstrip())
    return wrapped_lines


def _format_report_text(report_data: Dict[str, Any], width: int = 70) -> str:
    """
    Format report data as plain text for printing (full data matching preview).
    Reads from top-level or testData so either saved structure works.
    """
    if report_data.get("type") in ("validation", "calibration"):
        return _format_validation_calibration_text(report_data, width)

    lines = []
    thermal = width < 70
    sep = "" if thermal else ("=" * width)
    dash_sep = "" if thermal else ("-" * width)
    star_sep = "" if thermal else ("*" * width)

    if thermal:
        lines.append("RAISE LAB EQUIPMENT")
        lines.append("")

    test_data = report_data.get("testData", {}) or {}
    if not isinstance(test_data, dict):
        test_data = {}
    is_quick_test = report_data.get("isQuickTest", False) or test_data.get("isQuickTest", False)

    # Merge recipe from top-level or testData (saved reports have recipe inside testData)
    recipe = report_data.get("recipe") or test_data
    if not isinstance(recipe, dict):
        recipe = {}
    params = recipe.get("parameters", {}) or test_data.get("parameters", {}) or {}
    if not isinstance(params, dict):
        params = {}
    tolerances = recipe.get("parameterTolerances", {}) or test_data.get("parameterTolerances", {}) or {}
    if not isinstance(tolerances, dict):
        tolerances = {}
    _shape = recipe.get("shape") or test_data.get("shape") or "round"
    shape = str(_shape).strip().lower() if _shape is not None else "round"
    unit = recipe.get("unit") or test_data.get("unit") or "Newton (N)"
    distance_unit = recipe.get("distanceUnit") or test_data.get("distanceUnit") or "mm"
    weight_unit = recipe.get("weightUnit") or test_data.get("weightUnit") or "gm"
    try:
        sample_size = int(recipe.get("sampleSize") or test_data.get("sampleSize") or 10)
    except (TypeError, ValueError):
        sample_size = 10
    sample_size = max(1, min(100, sample_size))
    measurements = report_data.get("measurements") or test_data.get("measurements") or {}
    if not isinstance(measurements, dict):
        measurements = {}
    statistics = report_data.get("statistics") or test_data.get("statistics") or {}
    if not isinstance(statistics, dict):
        statistics = {}

    # Header (thermal: no ===, title left-aligned)
    lines.append(sep)
    lines.append("TABLET HARDNESS TEST REPORT" if thermal else "TABLET HARDNESS TEST REPORT".center(width))
    lines.append(sep)
    lines.append("")

    # Factory settings
    factory_settings = report_data.get("factorySettings", {}) or {}
    if factory_settings:
        lines.append(f"Company: {factory_settings.get('companyName', 'N/A')}")
        lines.append(f"Location: {factory_settings.get('companyLocation', 'N/A')}")
        lines.append(f"Model No: {factory_settings.get('modelNo', 'N/A')}")
        lines.append(f"Serial No: {factory_settings.get('serialNo', 'N/A')}")
        lines.append(f"Instrument ID: {factory_settings.get('instrumentId', 'N/A')}")
        lines.append("")

    # Test information (match preview)
    product_name = recipe.get("productName") or test_data.get("productName") or "N/A"
    batch_number = recipe.get("batchNumber") or recipe.get("batch") or test_data.get("batchNumber") or test_data.get("batch") or "N/A"
    lines.append(f"Product: {product_name}")
    lines.append(f"Batch: {batch_number}")
    lines.append(f"Shape: {(shape or 'round').capitalize()}")
    lines.append(f"Hardness Unit: {unit}")
    lines.append(f"Distance Unit: {distance_unit}")
    lines.append(f"Weight Unit: {weight_unit}")
    mode_val = (test_data.get('mode') or 'auto').lower()
    lines.append(f"Mode: {'Manual' if mode_val == 'manual' else 'Auto'}")
    # Match report preview (script.js): testStartTime or createdAt; Generated: testEndTime or completedAt
    ts_start_raw = test_data.get("testStartTime") or report_data.get("createdAt")
    ts_end_raw = test_data.get("testEndTime") or report_data.get("completedAt") or report_data.get("createdAt")
    lines.append(f"Report/Test Start: {_format_ts_readable(ts_start_raw)}")
    lines.append(f"Generated: {_format_ts_readable(ts_end_raw)}")
    duration_sec = test_data.get("durationSeconds")
    if duration_sec is None and test_data.get("testStartTime") and test_data.get("testEndTime"):
        try:
            start = datetime.fromisoformat(str(test_data["testStartTime"]).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(test_data["testEndTime"]).replace("Z", "+00:00"))
            duration_sec = int((end - start).total_seconds())
        except Exception:
            pass
    if duration_sec is not None:
        total_s = int(duration_sec)
        m, s = divmod(total_s, 60)
        h, m = divmod(m, 60)
        lines.append(f"Test Duration: {h:02d}:{m:02d}:{s:02d}")
    report_type = report_data.get("type", "test")
    status_label = "Test Status" if report_type == "test" else ("Validation Status" if report_type == "validation" else "Calibration Status")
    _status_raw = str(test_data.get("status") or "").lower()
    status_display = "Aborted" if _status_raw == "aborted" else "Completed"
    lines.append(f"{status_label}: {status_display}")
    lines.append("")
    if not thermal:
        lines.append(star_sep)

    # Dynamic report columns: from params, or from measurements when params empty (e.g. quick test)
    length_key = "Diameter" if shape == "round" else "Length"
    _canonical = ["Thickness", "Width", "Weight", "Length", "Hardness"]
    _col_to_param = {"Weight": "Weight", "Thickness": "Thickness", "Width": "Width", "Length": length_key, "Hardness": "Hardness"}

    def _has_param(pkey: str) -> bool:
        return _get_ci(params, pkey) is not None

    report_param_cols = []
    for label in _canonical:
        pkey = _col_to_param.get(label, label)
        if _has_param(pkey):
            report_param_cols.append("Diameter" if (label == "Length" and shape == "round") else label)
    # Quick test / saved report may have measurements but empty params: derive columns from measurement keys
    if not report_param_cols and measurements:
        for label in _canonical:
            pkey = _col_to_param.get(label, label)
            m = _get_ci(measurements, pkey)
            if isinstance(m, list) and len(m) > 0:
                report_param_cols.append("Diameter" if (label == "Length" and shape == "round") else label)
    if not report_param_cols:
        report_param_cols = ["Thickness", "Width", "Weight", "Diameter" if shape == "round" else "Length", "Hardness"]

    # Settings table - compact table format for thermal (param | T2- T1- NOM T1+ T2+ | unit)
    if not is_quick_test and report_param_cols:
        lines.append("")
        if thermal:
            lines.append("Tolerances (T2- T1- NOM T1+ T2+):")
            for label in report_param_cols:
                pkey = label
                t = _get_ci(tolerances, pkey) or {}
                nom = _get_ci(params, pkey)
                if nom is None or (not isinstance(nom, (int, float)) and not isinstance(nom, str)):
                    nom = "N/A"
                weight_unit = recipe.get("weightUnit") or test_data.get("weightUnit") or "gm"
                u = "mm" if pkey in ("Thickness", "Diameter", "Length", "Width") else (weight_unit if pkey == "Weight" else (unit.split()[0] if unit else "N"))
                t2 = _non_negative_display(t.get('lowerT2', '--'))
                t1_l = _non_negative_display(t.get('lowerT1', '--'))
                t1_u = _non_negative_display(t.get('upperT1', '--'))
                t2_u = _non_negative_display(t.get('upperT2', '--'))
                nom_str = _non_negative_display(nom)
                # Remove indentation - start from left corner for thermal
                lines.append(f"{label}: {t2} {t1_l} {nom_str} {t1_u} {t2_u} {u}")
            lines.append("")
        else:
            # A4: Table format with ====, ---, and ** separators
            lines.append(star_sep)
            lines.append(sep)
            lines.append("TOLERANCES".center(width))
            lines.append(sep)
            lines.append("")
            # Header
            header = ["Param", "T2-", "T1-", "NOM", "T1+", "T2+", "Unit"]
            header_line = " | ".join(h.ljust(10) for h in header)
            lines.append(header_line)
            lines.append(dash_sep)
            # Data rows
            for label in report_param_cols:
                pkey = label
                t = _get_ci(tolerances, pkey) or {}
                nom = _get_ci(params, pkey)
                if nom is None or (not isinstance(nom, (int, float)) and not isinstance(nom, str)):
                    nom = "N/A"
                weight_unit = recipe.get("weightUnit") or test_data.get("weightUnit") or "gm"
                u = "mm" if pkey in ("Thickness", "Diameter", "Length", "Width") else (weight_unit if pkey == "Weight" else (unit.split()[0] if unit else "N"))
                t2 = _non_negative_display(t.get('lowerT2', '--'))
                t1_l = _non_negative_display(t.get('lowerT1', '--'))
                t1_u = _non_negative_display(t.get('upperT1', '--'))
                t2_u = _non_negative_display(t.get('upperT2', '--'))
                nom_str = _non_negative_display(nom)
                row = [label, t2, t1_l, nom_str, t1_u, t2_u, u]
                row_line = " | ".join(str(v).ljust(10) for v in row)
                lines.append(row_line)
            lines.append("")
            lines.append(sep)  # Separator line after tolerances
            lines.append("")

    # Test Data table: include when we have columns and any data (params or measurements; case-insensitive)
    has_measurement_data = any(
        isinstance(_get_ci(measurements, c), list) and len(_get_ci(measurements, c)) > 0
        for c in report_param_cols
    )
    has_any_param = any(_get_ci(params, c) is not None for c in report_param_cols)
    if report_param_cols and (has_measurement_data or has_any_param):
        lines.append("")
        if not thermal:
            lines.append(star_sep)
            lines.append(sep)
            lines.append("TEST DATA".center(width))
            lines.append(sep)
        else:
            lines.append("Test Data (S.No, " + ", ".join(report_param_cols) + ", Result):")
        lines.append("")
        # Header row
        if not thermal:
            header = ["S.No"] + report_param_cols + ["Result"]
            header_line = " | ".join(h.ljust(12) for h in header)
            lines.append(header_line)
            lines.append(dash_sep)

        test_aborted = str(test_data.get("status") or "").lower() == "aborted"

        def _cell_has_measurement(col: str, row_index: int) -> bool:
            if col == "Weight":
                wm = _get_ci(measurements, "Weight")
                return isinstance(wm, list) and row_index < len(wm) and wm[row_index] is not None
            _m = _get_ci(measurements, col)
            if col == "Length" and shape == "oblong" and _m is None:
                _m = _get_ci(measurements, "Diameter")
            return isinstance(_m, list) and row_index < len(_m) and _m[row_index] is not None

        def _row_sample_incomplete(row_index: int) -> bool:
            """Match script.js openReportPreview: aborted => incomplete unless ALL params measured; else incomplete if NONE."""
            if not measurements:
                return True
            if test_aborted:
                return any(not _cell_has_measurement(c, row_index) for c in report_param_cols)
            return not any(_cell_has_measurement(c, row_index) for c in report_param_cols)

        def _nominal_for_col(col: str) -> Any:
            nom = _get_ci(params, col)
            if nom is not None:
                return nom
            if col == "Diameter":
                return _get_ci(params, "Diameter")
            if col == "Length":
                return _get_ci(params, "Length")
            return None

        for i in range(sample_size):
            row_vals = [str(i + 1).zfill(2)]
            has_fail = False
            has_t2 = False
            sample_incomplete = _row_sample_incomplete(i)

            # Process sample: match preview — incomplete rows show all '--' and Result N/A
            for col in report_param_cols:
                if sample_incomplete:
                    row_vals.append("--")
                    continue
                _m = _get_ci(measurements, col)
                if col == "Length" and shape == "oblong" and _m is None:
                    _m = _get_ci(measurements, "Diameter")
                if isinstance(_m, list) and i < len(_m) and _m[i] is not None:
                    v = _m[i]
                    if v == "OL" or (isinstance(v, str) and str(v).upper() == "OL"):
                        row_vals.append("OL")
                        has_fail = True
                    else:
                        row_vals.append(_non_negative_display(v, 2))
                        try:
                            num_val = float(v) if isinstance(v, (int, float)) else float(v)
                            nom = _nominal_for_col(col)
                            if nom is not None:
                                nominal = float(nom) if isinstance(nom, (int, float)) else float(nom)
                                tc = _get_ci(tolerances, col) or {}
                                res = calculation_service.check_tolerance_t1_t2(num_val, nominal, tc)
                                if res.get("status") == "FAIL":
                                    has_fail = True
                                elif res.get("status") == "T2_DEVIATION":
                                    has_t2 = True
                        except (TypeError, ValueError):
                            pass
                else:
                    row_vals.append("--")

            # Calculate result for this sample row
            if sample_incomplete:
                result_str = "N/A"
            elif is_quick_test:
                result_str = "N/A"
            elif has_fail:
                result_str = "Fail"
            elif has_t2:
                result_str = "T1-T2"
            else:
                result_str = "Pass"
            
            row_vals.append(result_str)
            
            # Format as table for A4, simple format for thermal
            if thermal:
                lines.append(" | ".join(row_vals))
            else:
                # A4: Table format with aligned columns
                row_line = " | ".join(str(v).ljust(12) for v in row_vals)
                lines.append(row_line)
        lines.append("")
        if not thermal:
            lines.append(sep)  # Separator line after test data for A4
            lines.append("")

    # Statistics: only for params in report_param_cols that have stats (case-insensitive)
    stat_params = [p for p in report_param_cols if isinstance(_get_ci(statistics, p), dict)]
    if statistics and stat_params:
        lines.append("")
        if thermal:
            lines.append("Statistics:")
            for pname in stat_params:
                ps = _get_ci(statistics, pname) if isinstance(_get_ci(statistics, pname), dict) else None
                if not ps:
                    continue
                c = ps.get("count", "N/A")
                m = _non_negative_display(ps.get("mean"), 2) if ps.get("mean") is not None else "N/A"
                mx = _non_negative_display(ps.get("max"), 2) if ps.get("max") is not None else "N/A"
                mn = _non_negative_display(ps.get("min"), 2) if ps.get("min") is not None else "N/A"
                r = _non_negative_display(ps.get("range"), 2) if ps.get("range") is not None else "N/A"
                sabs = _non_negative_display(ps.get("std_dev"), 2) if ps.get("std_dev") is not None else "N/A"
                srel_val = ps.get("srel")
                srel = (_non_negative_display(srel_val, 2) + "%") if srel_val is not None else "N/A"
                # Remove indentation - start from left corner for thermal
                lines.append(f"{pname}: n={c} M={m} Max={mx} Min={mn}")
                lines.append(f"Rng={r} Sd={sabs} RSd={srel}")
        else:
            # A4: Table format with separators
            lines.append(star_sep)
            lines.append(sep)
            lines.append("STATISTICS".center(width))
            lines.append(sep)
            lines.append("")
            # Header
            header = ["Param", "n", "Mean", "Max", "Min", "Range", "Sd", "RSd"]
            header_line = " | ".join(h.ljust(10) for h in header)
            lines.append(header_line)
            lines.append(dash_sep)
            # Data rows
            for pname in stat_params:
                ps = _get_ci(statistics, pname) if isinstance(_get_ci(statistics, pname), dict) else None
                if not ps:
                    continue
                c = ps.get("count", "N/A")
                m = _non_negative_display(ps.get("mean"), 2) if ps.get("mean") is not None else "N/A"
                mx = _non_negative_display(ps.get("max"), 2) if ps.get("max") is not None else "N/A"
                mn = _non_negative_display(ps.get("min"), 2) if ps.get("min") is not None else "N/A"
                r = _non_negative_display(ps.get("range"), 2) if ps.get("range") is not None else "N/A"
                sabs = _non_negative_display(ps.get("std_dev"), 2) if ps.get("std_dev") is not None else "N/A"
                srel_val = ps.get("srel")
                srel = (_non_negative_display(srel_val, 2) + "%") if srel_val is not None else "N/A"
                row = [pname, c, m, mx, mn, r, sabs, srel]
                row_line = " | ".join(str(v).ljust(10) for v in row)
                lines.append(row_line)
            lines.append("")
            lines.append(sep)  # Separator line after statistics
        lines.append("")

    # Operator
    op_name = test_data.get("operatorName") or test_data.get("operatedBy") or "N/A"
    emp_id = test_data.get("employeeId") or test_data.get("operatorId") or "N/A"
    lines.append(f"Operated by: {op_name}")
    lines.append(f"Employee ID: {emp_id}")
    lines.append("")

    # Remarks section (thermal and A4)
    lines.append("Remarks:")
    lines.append("")
    lines.append("Approved by:")
    lines.append("")
    lines.append("")

    # Footer (same timestamp as preview "Generated" / test end)
    lines.append(sep)
    lines.append(f"Generated: {_format_ts_readable(ts_end_raw)}")
    lines.append(sep)

    if thermal:
        lines.append("")
        lines.append("")

    lines = _wrap_text_lines(lines, width)

    return "\n".join(lines)
