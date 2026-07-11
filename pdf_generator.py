"""HTML -> A4 PDF rendering for kiosk reports.

Uses headless Chromium (the only PDF-capable backend installed on the Pi).
Designed to be safe to call from the Flask process running as user 'rle'.

Public API:
    render_html_to_pdf(html: str, out_path: Path) -> None
        Writes the PDF at out_path. Raises RuntimeError on failure.
"""

from __future__ import annotations

import logging
import os
import pathlib
import shlex
import shutil
import subprocess
import tempfile
from typing import Optional


logger = logging.getLogger(__name__)


def _find_chromium() -> Optional[str]:
    return (
        shutil.which("chromium")
        or shutil.which("chromium-browser")
        or shutil.which("google-chrome")
    )


def render_html_to_pdf(html: str, out_path: pathlib.Path, timeout_sec: float = 90.0) -> None:
    """Render an HTML document string to an A4 PDF at ``out_path`` via headless Chromium.

    Strategy: render into a private temp directory under /tmp (always native ext4) and
    only then move the finished PDF to ``out_path``. This sidesteps two real-world
    problems that surface when Chromium writes directly to mounted USB pendrives:
      * FAT32 mount points often contain spaces (e.g. ``/media/rle/USB DISK``) which
        confuse some Chromium codepaths even though argv is passed as a list.
      * FAT32/exFAT have stricter rename / sync semantics that can leave a 0-byte file
        when Chromium signals success.
    The temp -> dest copy also makes the destination write atomic from the user's POV.
    """
    if not html or not isinstance(html, str):
        raise ValueError("render_html_to_pdf: html must be a non-empty string")
    out_path = pathlib.Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    chrome = _find_chromium()
    if not chrome:
        raise RuntimeError("PDF engine unavailable")
    full_html = _wrap_html_for_a4(html)
    tmp_dir = tempfile.mkdtemp(prefix="kiosk_pdf_")
    tmp_html = pathlib.Path(tmp_dir) / "page.html"
    tmp_pdf = pathlib.Path(tmp_dir) / "out.pdf"
    try:
        tmp_html.write_text(full_html, encoding="utf-8")
        tail = [
            "--disable-gpu",
            "--no-sandbox",
            "--disable-extensions",
            "--disable-software-rasterizer",
            "--allow-file-access-from-files",
            "--disable-web-security",
            "--no-pdf-header-footer",
            "--virtual-time-budget=4000",
            "--run-all-compositor-stages-before-draw",
            "--hide-scrollbars",
            "--print-to-pdf-no-header",
            "--print-to-pdf=" + str(tmp_pdf.resolve()),
            tmp_html.resolve().as_uri(),
        ]
        extra_env_args = os.environ.get("CHROMIUM_EXTRA_ARGS", "").strip()
        extra = shlex.split(extra_env_args) if extra_env_args else []
        chrome_env = os.environ.copy()
        chrome_env.pop("DISPLAY", None)
        # Suppress the harmless dbus-bus warnings that flood stderr on headless Pi runs.
        chrome_env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        chrome_env.pop("DBUS_SYSTEM_BUS_ADDRESS", None)
        profile_dir = pathlib.Path(tmp_dir) / "profile"
        profile_dir.mkdir(parents=True, exist_ok=True)
        last_err: Optional[str] = None
        for headless_flag in ("--headless=new", "--headless"):
            args = [
                chrome,
                headless_flag,
                "--user-data-dir=" + str(profile_dir),
            ] + extra + tail
            try:
                proc = subprocess.run(
                    args,
                    capture_output=True,
                    text=True,
                    timeout=timeout_sec,
                    check=False,
                    env=chrome_env,
                )
                if proc.returncode == 0 and tmp_pdf.exists() and tmp_pdf.stat().st_size > 0 and _looks_like_pdf(tmp_pdf):
                    # Atomic copy to destination (move where possible).
                    _copy_to_destination(tmp_pdf, out_path)
                    logger.info("[PDF] Wrote %s (%d bytes)", out_path, out_path.stat().st_size)
                    return
                last_err = "chromium rc={} (stderr suppressed)".format(proc.returncode)
            except (subprocess.TimeoutExpired, OSError) as e:
                last_err = "chromium subprocess failure: {}".format(e)
        raise RuntimeError("PDF engine failed: {}".format(last_err or "unknown"))
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except OSError:
            pass


def _looks_like_pdf(path: pathlib.Path) -> bool:
    """Verify the temp file actually starts with the %PDF- magic header."""
    try:
        with open(path, "rb") as f:
            head = f.read(5)
        return head == b"%PDF-"
    except OSError:
        return False


def _copy_to_destination(src: pathlib.Path, dest: pathlib.Path) -> None:
    """Copy src->dest robustly. Tries shutil.copyfile then a chunked fallback for
    FAT32 / network mounts that occasionally trip over sendfile."""
    try:
        shutil.copyfile(str(src), str(dest))
        return
    except (OSError, shutil.SameFileError):
        pass
    # Manual chunked copy (FAT32 / odd filesystems).
    with open(src, "rb") as fin, open(dest, "wb") as fout:
        while True:
            chunk = fin.read(1024 * 1024)
            if not chunk:
                break
            fout.write(chunk)
        try:
            fout.flush()
            os.fsync(fout.fileno())
        except OSError:
            pass


def _wrap_html_for_a4(html: str) -> str:
    """If the provided HTML is a complete document, return as-is with an A4 @page rule
    appended; otherwise wrap a fragment in a full document."""
    snippet = html.strip()
    looks_like_doc = snippet.lower().startswith("<!doctype") or snippet.lower().startswith("<html")
    a4_page_css = (
        "<style>"
        "@page { size: A4; margin: 6mm 5mm; }"
        "html, body { margin: 0; padding: 0; }"
        "body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }"
        "</style>"
    )
    if looks_like_doc:
        # Inject the print CSS as close to the end of <head> as possible.
        lower = snippet.lower()
        head_close = lower.find("</head>")
        if head_close != -1:
            return snippet[:head_close] + a4_page_css + snippet[head_close:]
        # No </head>: place the style at the start of the doc.
        return a4_page_css + snippet
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        + a4_page_css
        + "</head><body>" + html + "</body></html>"
    )
