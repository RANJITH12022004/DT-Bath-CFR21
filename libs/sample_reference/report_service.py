#!/usr/bin/env python3
"""
report_service.py - Report generation and formatting service
Handles report generation, PDF creation, and report context enrichment.
"""

import json
import pathlib
from datetime import datetime
from typing import Dict, Any, Optional, List

import data_service
import print_formats

# Module-level state
_config = {}
_reports_dir = None
_storage_dir = None


def init(config):
    """Initialize report service with config"""
    global _config, _reports_dir, _storage_dir
    _config = dict(config)
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "/media/usb_internal/reports"))
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "/media/usb_internal/storage"))
    
    _reports_dir.mkdir(parents=True, exist_ok=True)


def generate_report(test_data: Dict[str, Any], recipe: Optional[Dict[str, Any]] = None, 
                   factory_settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Generate complete report from test data.
    
    Args:
        test_data: Raw test data with measurements
        recipe: Recipe used for the test
        factory_settings: Factory settings for report header
    
    Returns:
        Complete report dict with enriched context
    """
    report = dict(test_data)
    
    # Add recipe information
    if recipe:
        report["recipe"] = {
            "id": recipe.get("id"),
            "name": recipe.get("name") or recipe.get("productName"),
            "productName": recipe.get("productName"),
            "batchNumber": recipe.get("batchNumber"),
            "unit": recipe.get("unit"),
            "shape": recipe.get("shape")
        }
    
    # Enrich with factory settings
    if not factory_settings:
        factory_settings = data_service.get_factory_settings()
    
    report["factorySettings"] = enrich_factory_settings(factory_settings)
    
    # Add timestamps
    if not report.get("createdAt"):
        report["createdAt"] = datetime.utcnow().isoformat() + "Z"
    
    if not report.get("completedAt"):
        report["completedAt"] = report["createdAt"]
    
    # Enrich report context (validation dates, etc.)
    report = enrich_report_context(report)
    
    return report


def enrich_factory_settings(factory_settings: Dict[str, Any]) -> Dict[str, Any]:
    """Enrich factory settings with defaults"""
    enriched = {
        "companyName": factory_settings.get("companyName") or "N/A",
        "modelNo": factory_settings.get("modelNo") or "N/A",
        "serialNo": factory_settings.get("serialNo") or "N/A",
        "companyLocation": factory_settings.get("companyLocation") or factory_settings.get("location") or "N/A",
        "instrumentId": factory_settings.get("instrumentId") or "N/A",
        "lastValidationDate": factory_settings.get("lastValidationDate") or "N/A",
        "nextValidationDate": factory_settings.get("nextValidationDate") or "N/A"
    }
    return enriched


def enrich_report_context(report_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Enrich report with factory settings and validation dates from storage.
    Similar to report_context.py functionality.
    """
    if not report_data:
        return report_data
    
    # Get factory settings
    factory_settings = data_service.get_factory_settings()
    fs = report_data.get("factorySettings") or {}
    
    # Fill missing factory settings
    if not fs.get("companyName"):
        fs["companyName"] = factory_settings.get("companyName") or "N/A"
    if not fs.get("modelNo"):
        fs["modelNo"] = factory_settings.get("modelNo") or "N/A"
    if not fs.get("serialNo"):
        fs["serialNo"] = factory_settings.get("serialNo") or "N/A"
    if not fs.get("companyLocation"):
        fs["companyLocation"] = factory_settings.get("companyLocation") or factory_settings.get("location") or "N/A"
    if not fs.get("instrumentId"):
        fs["instrumentId"] = factory_settings.get("instrumentId") or "N/A"
    
    # Prefer validation dates from factory settings (set by calibration due prompt)
    if factory_settings.get("lastValidationDate"):
        fs["lastValidationDate"] = factory_settings["lastValidationDate"]
    if factory_settings.get("nextValidationDate"):
        fs["nextValidationDate"] = factory_settings["nextValidationDate"]
    # Fallback: compute from reports
    if not fs.get("lastValidationDate") or not fs.get("nextValidationDate"):
        validation_dates = _compute_validation_dates()
        if not fs.get("lastValidationDate"):
            fs["lastValidationDate"] = validation_dates.get("lastValidationDate", "N/A")
        if not fs.get("nextValidationDate"):
            fs["nextValidationDate"] = validation_dates.get("nextValidationDate", "N/A")
    
    report_data["factorySettings"] = fs
    return report_data


def _compute_validation_dates() -> Dict[str, str]:
    """Compute last and next validation dates from reports"""
    reports = data_service.list_reports("validation")
    
    if not reports:
        return {"lastValidationDate": "", "nextValidationDate": ""}
    
    # Find most recent validation report
    validation_reports = [r for r in reports if r.get("type") == "validation" and r.get("createdAt")]
    if not validation_reports:
        return {"lastValidationDate": "", "nextValidationDate": ""}
    
    # Sort by createdAt descending
    validation_reports.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
    last_validation = validation_reports[0]
    
    created_at = last_validation.get("createdAt")
    if not created_at:
        return {"lastValidationDate": "", "nextValidationDate": ""}
    
    # Parse date
    try:
        dt_str = str(created_at).replace("Z", "+00:00").split(".")[0]
        dt = datetime.fromisoformat(dt_str)
        last_date_str = dt.strftime("%d-%m-%Y")
        # Next validation is 1 year later
        next_dt = dt.replace(year=dt.year + 1)
        next_date_str = next_dt.strftime("%d-%m-%Y")
        return {
            "lastValidationDate": last_date_str,
            "nextValidationDate": next_date_str
        }
    except Exception:
        return {"lastValidationDate": "", "nextValidationDate": ""}


def format_report_html(report_data: Dict[str, Any]) -> str:
    """
    Format report as HTML for display/preview.
    This is a simplified version - full implementation would use templates.
    """
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Test Report</title>
        <style>
            body {{ font-family: Arial, sans-serif; margin: 20px; }}
            .header {{ text-align: center; margin-bottom: 30px; }}
            .section {{ margin-bottom: 20px; }}
            table {{ width: 100%; border-collapse: collapse; }}
            th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
            th {{ background-color: #f2f2f2; }}
        </style>
    </head>
    <body>
        <div class="header">
            <h1>Tablet Hardness Test Report</h1>
        </div>
        <div class="section">
            <h2>Test Information</h2>
            <p><strong>Product:</strong> {report_data.get('recipe', {}).get('productName', 'N/A')}</p>
            <p><strong>Batch:</strong> {report_data.get('recipe', {}).get('batchNumber', 'N/A')}</p>
            <p><strong>Date:</strong> {report_data.get('createdAt', 'N/A')}</p>
        </div>
    </body>
    </html>
    """
    return html


def summary_pdf_path_for_id(report_id: int) -> pathlib.Path:
    """Stable on-disk path for server-generated summary PDF."""
    return _reports_dir / f"report_{int(report_id)}_summary.pdf"


def save_report_summary_pdf(report_data: Dict[str, Any], report_id: int) -> None:
    """
    Write report_{id}_summary.pdf from format_report_html. Does not raise;
    log on failure (report JSON and .txt files are already saved).
    """
    if report_id is None or not _reports_dir:
        return
    import logging

    log = logging.getLogger(__name__)
    try:
        pdf_path = summary_pdf_path_for_id(report_id)
        html = format_report_html(report_data)
        print_formats.render_html_to_a4_pdf(html, pdf_path)
    except Exception as e:
        log.warning("save_report_summary_pdf failed for report %s: %s", report_id, e)


def create_pdf_report(report_data: Dict[str, Any], template_type: str = "standard") -> Optional[pathlib.Path]:
    """
    Create a simple PDF from report data (summary HTML). For full preview layout,
    use USB export or POST /api/save_report_pdf with client-built HTML.
    When report_data includes id, writes report_{id}_summary.pdf (same as auto-save).
    """
    try:
        rid = report_data.get("id")
        if rid is not None:
            pdf_path = summary_pdf_path_for_id(int(rid))
        else:
            timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            recipe_name = report_data.get("recipe", {}).get("productName", "report")
            safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
            pdf_path = _reports_dir / f"{safe_name}_{timestamp}.pdf"
        html = format_report_html(report_data)
        print_formats.render_html_to_a4_pdf(html, pdf_path)
        return pdf_path
    except Exception as e:
        print(f"Error creating PDF report: {e}")
        return None


def get_report_preview_data(report: Dict[str, Any]) -> Dict[str, Any]:
    """Get formatted report preview data for display"""
    preview = {
        "id": report.get("id"),
        "type": report.get("type", "test"),
        "createdAt": report.get("createdAt"),
        "completedAt": report.get("completedAt"),
        "recipe": report.get("recipe", {}),
        "factorySettings": report.get("factorySettings", {}),
        "testData": report.get("testData", {}),
        "statistics": report.get("statistics", {}),
        "status": report.get("status", "PASS")
    }
    return preview


def filter_reports(reports: List[Dict[str, Any]], filter_type: str) -> List[Dict[str, Any]]:
    """Filter reports by type"""
    if filter_type == "all":
        return reports
    return [r for r in reports if r.get("type") == filter_type]


def export_reports_to_usb(
    report_ids: List[int],
    export_path: str,
    pdf_html_by_id: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Export reports to external USB drive as PDF files (preview HTML from client).

    Args:
        report_ids: List of report IDs to export
        export_path: Directory on the USB mount (e.g. .../Hardness-Reports-Exported)
        pdf_html_by_id: Map string report id -> full HTML document (required)
    """
    try:
        export_dir = pathlib.Path(export_path)
        try:
            export_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            err = e.errno
            if err in (5, 19):  # EIO, ENODEV
                return {
                    "success": False,
                    "error": (
                        "USB export path is not reachable (device removed or I/O error). "
                        "Reinsert the pendrive and try again."
                    ),
                }
            raise
        mapping = pdf_html_by_id or {}

        exported_files = []
        for report_id in report_ids:
            report = data_service.get_report(report_id)
            if not report:
                continue
            html = mapping.get(str(report_id))
            if not html or not str(html).strip():
                return {
                    "success": False,
                    "error": f"Missing pdf_html_by_id for report {report_id}",
                }

            timestamp = report.get("createdAt", datetime.utcnow().isoformat())
            safe_timestamp = timestamp.replace(":", "-").replace("Z", "").replace("+", "-")
            safe_timestamp = "".join(
                c for c in safe_timestamp if c.isalnum() or c in "-_.T"
            )
            recipe_name = report.get("recipe", {}).get("productName", "report")
            safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
            filename = f"{safe_name}_{report_id}_{safe_timestamp}.pdf"
            export_file = export_dir / filename
            print_formats.render_html_to_a4_pdf(html, export_file)
            exported_files.append(str(export_file))

        return {
            "success": True,
            "exported_files": exported_files,
            "count": len(exported_files),
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }
