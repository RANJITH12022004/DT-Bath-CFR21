#!/usr/bin/env python3
"""
app.py - Main Flask application for Tablet Hardness Tester
Serves static files and provides REST API endpoints for hardware control, data management, and reporting.
"""

import base64
import errno
import json
import os
import pathlib
import re
import shutil
import subprocess
import threading
import uuid
import sys
import time
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

import hardware_service
import data_service
import calculation_service
import report_service
import print_formats
import print_service
import rtc_service

# ======================= CONFIG SECTION ==========================

ESP_PORT = os.environ.get("ESP_PORT", "/dev/serial0")
ESP_BAUD = int(os.environ.get("ESP_BAUD", "9600"))
A4_PORT = os.environ.get("A4_PORT", "/dev/ttyAMA4")
A4_BAUD = int(os.environ.get("A4_BAUD", "9600"))
THERMAL_PORT = os.environ.get("THERMAL_PORT", "/dev/ttyAMA3")
THERMAL_BAUD = int(os.environ.get("THERMAL_BAUD", "9600"))

INTERNAL_ROOT = pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal"))
STORAGE_DIR = INTERNAL_ROOT / "storage"
REPORTS_DIR = INTERNAL_ROOT / "reports"
EXPORT_ROOT = pathlib.Path(os.environ.get("EXPORT_USB_PATH", "/media/usb_export"))
MIN_FREE_GB = 4.0

# For development: current directory. For Pi kiosk: set APP_ROOT=/opt/kiosk (bridge.py sets this)
APP_ROOT = pathlib.Path(os.environ.get("APP_ROOT", os.path.dirname(os.path.abspath(__file__))))
STATIC_ROOT = APP_ROOT

FLASK_HOST = os.environ.get("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))

ALLOWED_DATETIME_ROLES = ('factory', 'admin')
DATETIME_STORAGE = STORAGE_DIR / "datetime.json"
EXPORT_SUBFOLDER = "Hardness-Reports-Exported"

# =================================================================

# SCSI USB mass storage: partition (sda1, sdaa1) or whole-disk (sda) when no partition table.
# sda/sdb/sdc/... are equivalent: [a-z]+ matches any drive letter after sd.
_RE_SD_PART = re.compile(r"^/dev/sd[a-z]+[0-9]+$")
_RE_SD_DISK = re.compile(r"^/dev/sd[a-z]+$")
# NVMe: /dev/nvme0n1p1 (partition) or /dev/nvme0n1 (namespace)
_RE_NVME_PART = re.compile(r"^/dev/nvme[0-9]+n[0-9]+p[0-9]+$")
_RE_NVME_NS = re.compile(r"^/dev/nvme[0-9]+n[0-9]+$")
# Virtio (VM / dev images)
_RE_VD_PART = re.compile(r"^/dev/vd[a-z]+[0-9]+$")
_RE_VD_DISK = re.compile(r"^/dev/vd[a-z]+$")


def _is_export_block_realpath(real: str) -> bool:
    if _RE_SD_PART.match(real) or _RE_SD_DISK.match(real):
        return True
    if _RE_NVME_PART.match(real) or _RE_NVME_NS.match(real):
        return True
    if _RE_VD_PART.match(real) or _RE_VD_DISK.match(real):
        return True
    return False


def _resolved_export_block_device(dev: str) -> Optional[str]:
    """
    Resolve a mount point source (e.g. from /proc/mounts or findmnt) to a canonical
    block device path: /dev/sd*, nvme*, or vd*. Handles /dev/disk/by-uuid/... and by-label/.
    """
    if not dev or not dev.startswith("/dev/"):
        return None
    try:
        real = os.path.realpath(dev)
    except OSError:
        return None
    if _is_export_block_realpath(real):
        return real
    return None


def _unescape_proc_mounts_field(field: str) -> str:
    """Decode \\ooo octal escapes used in /proc/mounts (e.g. \\040 -> space)."""
    if not field or "\\" not in field:
        return field
    out = []
    i = 0
    n = len(field)
    while i < n:
        if (
            field[i] == "\\"
            and i + 3 < n
            and all(c in "01234567" for c in field[i + 1 : i + 4])
        ):
            out.append(chr(int(field[i + 1 : i + 4], 8)))
            i += 4
        else:
            out.append(field[i])
            i += 1
    return "".join(out)


def _lsblk_name_removable():
    """
    Map lsblk NAME (e.g. sda1) -> True/False for RM.
    Returns {} if lsblk is missing or unparsable (caller uses stable sort only).
    """
    try:
        proc = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,RM"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            return {}

        def walk(nodes, acc):
            for node in nodes or []:
                name = node.get("name")
                if name:
                    rm = node.get("rm")
                    acc[name] = rm is True or rm == 1 or str(rm).strip() == "1"
                walk(node.get("children"), acc)

        data = json.loads(proc.stdout)
        acc = {}
        walk(data.get("blockdevices"), acc)
        return acc
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, TypeError, ValueError):
        return {}


def _export_candidate_mount_target(target: str) -> bool:
    """True if findmnt/GTK target is under /media, /run/media, or is EXPORT_ROOT."""
    t = target.rstrip("/") or "/"
    er = str(EXPORT_ROOT).rstrip("/")
    if t == er:
        return True
    if t.startswith("/media/") or t.startswith("/run/media/"):
        return True
    return False


def _candidates_from_proc_mounts(internal_dev: Optional[int]) -> Tuple[List[dict], int]:
    candidates: List[dict] = []
    lines_seen = 0
    try:
        with open("/proc/mounts", "r") as f:
            for line in f:
                lines_seen += 1
                parts = line.split()
                if len(parts) >= 2:
                    dev, mnt_raw = parts[0], parts[1]
                    mnt = _unescape_proc_mounts_field(mnt_raw)
                    resolved = _resolved_export_block_device(dev)
                    if not resolved:
                        continue
                    p = pathlib.Path(mnt)
                    try:
                        if p.exists() and p.is_dir():
                            if internal_dev is None or p.stat().st_dev != internal_dev:
                                candidates.append({"dev": resolved, "path": p})
                    except OSError:
                        pass
    except OSError:
        pass
    return candidates, lines_seen


def _candidates_from_findmnt(internal_dev: Optional[int]) -> Tuple[List[dict], int, int]:
    """
    When /proc/mounts misses FUSE or odd sources, findmnt -J still reports a useful SOURCE
    for many mount points. Returns (candidates, findmnt_entries_scanned, findmnt_block_matches).
    """
    candidates: List[dict] = []
    entries_scanned = 0
    matched = 0
    try:
        proc = subprocess.run(
            ["findmnt", "-J", "-l"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            return candidates, entries_scanned, matched
        data = json.loads(proc.stdout)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError, TypeError, ValueError):
        return candidates, entries_scanned, matched

    seen_paths: set = set()
    for fs in data.get("filesystems", []):
        entries_scanned += 1
        target = fs.get("target") or fs.get("TARGET") or ""
        source = fs.get("source") or fs.get("SOURCE") or ""
        if not target or not source:
            continue
        if not _export_candidate_mount_target(target):
            continue
        resolved_dev = _resolved_export_block_device(source)
        if not resolved_dev:
            continue
        p = pathlib.Path(target)
        try:
            if not p.exists() or not p.is_dir():
                continue
            if internal_dev is not None and p.stat().st_dev == internal_dev:
                continue
        except OSError:
            continue
        key = str(p.resolve())
        if key in seen_paths:
            continue
        seen_paths.add(key)
        candidates.append({"dev": resolved_dev, "path": p})
        matched += 1
    return candidates, entries_scanned, matched


def _export_root_if_distinct(internal_dev: Optional[int]) -> Optional[pathlib.Path]:
    """Return EXPORT_ROOT if it exists as a mount distinct from parent and not internal storage."""
    try:
        if EXPORT_ROOT.exists() and EXPORT_ROOT.parent.exists():
            er_dev = EXPORT_ROOT.stat().st_dev
            parent_dev = EXPORT_ROOT.parent.stat().st_dev
            if er_dev != parent_dev:
                if internal_dev is None or er_dev != internal_dev:
                    return EXPORT_ROOT
    except OSError:
        pass
    return None


def _export_mount_block_device_alive(mount_path: pathlib.Path) -> bool:
    """
    False if findmnt SOURCE is a /dev path that no longer exists (unplugged USB:
    mount table can still list e.g. /dev/sdb1 while /dev/sdb is gone — mkdir then EIO).
    """
    try:
        proc = subprocess.run(
            ["findmnt", "-n", "-o", "SOURCE", "--target", str(mount_path)],
            capture_output=True,
            text=True,
            timeout=6,
            check=False,
        )
        if proc.returncode != 0:
            return True
        src = (proc.stdout or "").strip().split()[0]
        if not src.startswith("/dev/"):
            return True
        real = os.path.realpath(src)
        return os.path.exists(real)
    except OSError:
        return True


def _export_mount_accessible(mount_path: pathlib.Path) -> bool:
    """
    True only if the export tree is readable, backed by a live block device (if applicable),
    and can create+remove a directory (listdir alone is not enough for dead vfat mounts).
    """
    try:
        if not mount_path.is_dir():
            return False
        os.listdir(mount_path)
    except OSError:
        return False
    if not _export_mount_block_device_alive(mount_path):
        return False
    probe = mount_path / f".kiosk_export_wrprobe_{os.getpid()}_{uuid.uuid4().hex[:10]}"
    try:
        probe.mkdir()
        probe.rmdir()
        return True
    except OSError as e:
        # Full volume: still a live mount; export may fail later with ENOSPC — do not force lazy umount.
        if e.errno == errno.ENOSPC:
            return True
        return False


def _try_lazy_umount_export_root(mount_path: pathlib.Path) -> None:
    """Lazy-unmount a stale export tree so a new pendrive can mount at EXPORT_ROOT (root only)."""
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        return
    try:
        subprocess.run(
            ["umount", "-l", str(mount_path)],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    except OSError:
        pass


def _internal_partition_and_pkname() -> Tuple[Optional[str], Optional[str]]:
    """Block device and lsblk PKNAME for INTERNAL_ROOT mount (e.g. /dev/sda1, sda)."""
    try:
        if not INTERNAL_ROOT.exists():
            return None, None
        proc = subprocess.run(
            ["findmnt", "-n", "-o", "SOURCE", "--target", str(INTERNAL_ROOT)],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        if proc.returncode != 0:
            return None, None
        src = (proc.stdout or "").strip()
        if not src.startswith("/dev/"):
            return None, None
        real = os.path.realpath(src)
        pkp = subprocess.run(
            ["lsblk", "-no", "PKNAME", real],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        pk = ((pkp.stdout or "").strip()) or None
        return real, pk
    except OSError:
        return None, None


def _list_automount_partition_candidates(int_pk: Optional[str]) -> List[str]:
    """
    Unmounted export candidates: removable partitions, or any sd/nvme/vd partition
    if RM is wrongly false (common on some sticks). Whole-disk sticks (TYPE=disk, no
    part children) are included. Always exclude mmcblk/eMMC and internal PKNAME.
    """
    out: List[str] = []
    seen: set = set()

    def add_if_eligible(path: str) -> None:
        if not path or path in seen:
            return
        if not path.startswith("/dev/") or "mmcblk" in path:
            return
        try:
            pkp = subprocess.run(
                ["lsblk", "-no", "PKNAME", path],
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            pk = ((pkp.stdout or "").strip()) or ""
        except OSError:
            return
        if int_pk and pk == int_pk:
            return
        seen.add(path)
        out.append(path)

    try:
        proc = subprocess.run(
            ["lsblk", "-J", "-o", "PATH,MOUNTPOINT,TYPE,RM"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            return []
        roots = (json.loads(proc.stdout) or {}).get("blockdevices") or []
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, TypeError, ValueError):
        return []

    def is_rm_true(node: dict) -> bool:
        rm = node.get("rm")
        return rm is True or rm == 1 or str(rm).strip() == "1"

    flat: List[dict] = []

    def flatten(nodes):
        for node in nodes or []:
            flat.append(node)
            flatten(node.get("children") or [])

    flatten(roots)

    # lsblk -J often lists disk and partitions as flat siblings (no "children" link).
    # Never whole-disk mount /dev/sdb if any partition (e.g. sdb1) exists on that disk.
    disks_with_parts: set = set()
    for node in flat:
        if (node.get("type") or "").lower() != "part":
            continue
        pth = node.get("path")
        if not pth or "mmcblk" in pth:
            continue
        try:
            pkp = subprocess.run(
                ["lsblk", "-no", "PKNAME", pth],
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            pk = ((pkp.stdout or "").strip()) or ""
            if pk:
                disks_with_parts.add(pk)
        except OSError:
            pass

    for node in flat:
        path = node.get("path")
        mnt = node.get("mountpoint")
        typ = (node.get("type") or "").lower()

        if typ == "part" and path:
            busy = mnt and str(mnt).strip() and str(mnt) != "[SWAP]"
            if not busy and "mmcblk" not in path:
                rm_ok = is_rm_true(node)
                usb_named = bool(path) and _is_export_block_realpath(path)
                if rm_ok or usb_named:
                    add_if_eligible(path)

        if typ == "disk" and path and "mmcblk" not in path:
            disk_base = pathlib.Path(path).name
            busy = mnt and str(mnt).strip()
            if (
                disk_base not in disks_with_parts
                and not busy
                and (is_rm_true(node) or _is_export_block_realpath(path))
            ):
                add_if_eligible(path)

    def _automount_sort_key(p: str):
        prefer_part = bool(
            _RE_SD_PART.match(p)
            or _RE_NVME_PART.match(p)
            or _RE_VD_PART.match(p)
        )
        return (0 if prefer_part else 1, p)

    out.sort(key=_automount_sort_key)
    return out


def _mount_opts_for_export_usb(part: str) -> str:
    """
    mount(8) -o string for removable export volumes.
    FAT/exFAT/NTFS default to root-only directories on Linux; umask=0000 makes exports work
    when Flask runs as non-root (dev) and matches kiosk expectations for world-writable FAT roots.
    """
    opts = "rw"
    blkid = shutil.which("blkid") or "/usr/sbin/blkid"
    try:
        proc = subprocess.run(
            [blkid, "-o", "value", "-s", "TYPE", part],
            capture_output=True,
            text=True,
            timeout=6,
            check=False,
        )
        fst = (proc.stdout or "").strip().lower()
    except OSError:
        fst = ""
    if fst in ("vfat", "msdos", "exfat") or "fat" in fst or fst == "fuseblk":
        return "rw,umask=0000"
    if fst in ("ntfs", "ntfs-3g"):
        return "rw,umask=0000"
    return opts


def _try_automount_export_partition(internal_dev: Optional[int]) -> bool:
    """
    If a removable USB partition is connected but not mounted (udisks often fails headless),
    mount it to EXPORT_ROOT using mount(8). Requires euid 0 (kiosk.service runs as root).
    """
    if os.geteuid() != 0:
        return False
    if _export_root_if_distinct(internal_dev) is not None:
        return False
    try:
        EXPORT_ROOT.parent.mkdir(parents=True, exist_ok=True)
        EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    _, int_pk = _internal_partition_and_pkname()
    for part in _list_automount_partition_candidates(int_pk):
        try:
            mount_opts = _mount_opts_for_export_usb(part)
            r = subprocess.run(
                ["mount", "-t", "auto", "-o", mount_opts, part, str(EXPORT_ROOT)],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if r.returncode == 0:
                app.logger.info("[EXPORT] Auto-mounted %s -> %s", part, EXPORT_ROOT)
                return True
            app.logger.warning(
                "[EXPORT] mount %s -> %s failed (rc=%s): %s",
                part,
                EXPORT_ROOT,
                r.returncode,
                (r.stderr or r.stdout or "").strip(),
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            app.logger.warning("[EXPORT] mount %s exception: %s", part, e)
    return False


def _media_path_hints_for_log():
    """Counts for diagnostics: entries under /media and /run/media (shallow)."""
    media_n = 0
    run_media_n = 0
    try:
        mp = pathlib.Path("/media")
        if mp.is_dir():
            media_n = sum(1 for _ in mp.iterdir())
    except OSError:
        pass
    try:
        rmp = pathlib.Path("/run/media")
        if rmp.is_dir():
            run_media_n = sum(1 for _ in rmp.iterdir())
    except OSError:
        pass
    return media_n, run_media_n


def _sort_export_candidates(candidates: List[dict]) -> List[dict]:
    rm_map = _lsblk_name_removable()
    try:
        export_resolved = EXPORT_ROOT.resolve()
    except OSError:
        export_resolved = EXPORT_ROOT

    def sort_key(c):
        p = c["path"]
        try:
            pres = p.resolve()
            under_export = pres == export_resolved or export_resolved in pres.parents
        except OSError:
            under_export = False
        pref_rank = 0 if under_export else 1
        dev = c["dev"]
        name = pathlib.Path(dev).name
        if rm_map:
            is_rm = rm_map.get(name)
            rem_rank = 0 if is_rm is True else 1
        else:
            rem_rank = 0
        return (pref_rank, rem_rank, str(p), dev)

    out = list(candidates)
    out.sort(key=sort_key)
    return out


def find_export_mount(_retry: int = 0):
    """
    Find the export pendrive mount (block storage: sd*, nvme*, vd*), excluding internal.

    Prefer EXPORT_ROOT when it is a distinct mount and not internal storage, then
    /proc/mounts, then findmnt -J if no candidates (helps FUSE and odd sources).
    If still nothing, try auto-mounting an unmounted removable partition to EXPORT_ROOT
    (root only — matches kiosk.service).
    """
    if not sys.platform.startswith("linux"):
        return pathlib.Path(EXPORT_ROOT)
    internal_dev = None
    try:
        if INTERNAL_ROOT.exists():
            internal_dev = INTERNAL_ROOT.stat().st_dev
    except OSError:
        pass

    use_root = _export_root_if_distinct(internal_dev)
    if use_root is not None and _export_mount_accessible(use_root):
        app.logger.info("[EXPORT] Using configured export mount: %s", use_root)
        return use_root

    if use_root is not None and not _export_mount_accessible(use_root):
        app.logger.warning(
            "[EXPORT] %s is not accessible (USB removed or I/O error); lazy unmounting stale mount",
            use_root,
        )
        _try_lazy_umount_export_root(use_root)
        # Lazy umount detaches asynchronously; probing immediately often still sees EIO/stale state.
        time.sleep(0.35)

    candidates, lines_seen = _candidates_from_proc_mounts(internal_dev)
    findmnt_scanned = 0
    findmnt_block_matches = 0
    if not candidates:
        extra, findmnt_scanned, findmnt_block_matches = _candidates_from_findmnt(internal_dev)
        candidates = extra

    if not candidates and _try_automount_export_partition(internal_dev):
        use_root = _export_root_if_distinct(internal_dev)
        if use_root is not None and _export_mount_accessible(use_root):
            app.logger.info("[EXPORT] Using export mount after auto-mount: %s", use_root)
            return use_root
        candidates, lines_seen = _candidates_from_proc_mounts(internal_dev)
        if not candidates:
            extra, findmnt_scanned, findmnt_block_matches = _candidates_from_findmnt(internal_dev)
            candidates = extra

    if not candidates:
        er_mount = None
        try:
            if EXPORT_ROOT.exists() and EXPORT_ROOT.parent.exists():
                er_mount = EXPORT_ROOT.stat().st_dev != EXPORT_ROOT.parent.stat().st_dev
        except OSError:
            er_mount = None
        media_n, run_media_n = _media_path_hints_for_log()
        app.logger.warning(
            "[EXPORT] No export USB device: proc_mounts_lines=%s internal_st_dev=%s "
            "export_root=%s export_root_is_distinct_mount=%s findmnt_entries=%s "
            "findmnt_block_dev_hits=%s media_subdir_count=%s run_media_subdir_count=%s",
            lines_seen,
            internal_dev,
            EXPORT_ROOT,
            er_mount,
            findmnt_scanned,
            findmnt_block_matches,
            media_n,
            run_media_n,
        )
        if _retry < 1:
            app.logger.info("[EXPORT] Retrying mount discovery after delay (USB settle / lazy umount)")
            time.sleep(0.8)
            return find_export_mount(_retry=_retry + 1)
        raise RuntimeError("No export USB device found. Connect a USB drive and try again.")

    candidates = _sort_export_candidates(candidates)
    accessible = [c for c in candidates if _export_mount_accessible(c["path"])]
    if accessible:
        mount_path = accessible[0]["path"]
        app.logger.info(
            "[EXPORT] Detected export mount: %s (device %s)",
            mount_path,
            accessible[0]["dev"],
        )
        return mount_path

    app.logger.warning("[EXPORT] All candidate mounts failed listdir (stale); retrying auto-mount")
    if _try_automount_export_partition(internal_dev):
        use_root = _export_root_if_distinct(internal_dev)
        if use_root is not None and _export_mount_accessible(use_root):
            app.logger.info("[EXPORT] Using export mount after auto-mount: %s", use_root)
            return use_root

    if _retry < 1:
        app.logger.info("[EXPORT] Retrying mount discovery after I/O probe failure")
        time.sleep(0.8)
        return find_export_mount(_retry=_retry + 1)
    raise RuntimeError(
        "Export USB is not accessible (I/O error). Reinsert the drive, or as root run: "
        f"umount -l {EXPORT_ROOT}"
    )


_EXPORT_MOUNT_LOCK = threading.Lock()
_EXPORT_MOUNT_LAST_PROBE_TS = 0.0
_EXPORT_MOUNT_MIN_PROBE_GAP_SEC = 2.0


def ensure_export_mount_ready(reason: str = "manual") -> Optional[str]:
    """
    Best-effort mount/discovery call used by login/startup to reduce first-export failures.
    Returns mount path string when available, else None.
    """
    global _EXPORT_MOUNT_LAST_PROBE_TS
    now = time.time()
    with _EXPORT_MOUNT_LOCK:
        # Avoid storming mount utilities if UI triggers multiple auth calls quickly.
        if now - _EXPORT_MOUNT_LAST_PROBE_TS < _EXPORT_MOUNT_MIN_PROBE_GAP_SEC:
            return None
        _EXPORT_MOUNT_LAST_PROBE_TS = now
        try:
            mount_path = find_export_mount()
            app.logger.info("[EXPORT] Mount ready (%s): %s", reason, mount_path)
            return str(mount_path)
        except Exception as e:
            app.logger.warning("[EXPORT] Mount probe failed (%s): %s", reason, e)
            return None


def _load_reports_meta_list():
    meta_file = STORAGE_DIR / "reports.json"
    if not meta_file.exists():
        return [], meta_file
    try:
        with open(meta_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data, meta_file
    except Exception:
        pass
    return [], meta_file


def _append_export_pdf_unique(bucket: List[pathlib.Path], seen: set, pdf_path: pathlib.Path) -> None:
    try:
        if not pdf_path.is_file():
            return
        key = str(pdf_path.resolve())
    except OSError:
        return
    if key in seen:
        return
    seen.add(key)
    bucket.append(pdf_path)


def _copy_file_to_fat_friendly(dest: pathlib.Path, src: pathlib.Path) -> None:
    """Copy bytes only — shutil.copy2 chmods metadata which often raises EPERM on vfat/exfat."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(str(src), str(dest))


def _pdf_paths_for_usb_file_export(report_id, filter_type: str) -> Tuple[List[pathlib.Path], pathlib.Path]:
    """PDFs to copy for /api/export_reports (server-generated summary PDFs + metadata fallbacks)."""
    reports_meta, meta_file = _load_reports_meta_list()
    paths: List[pathlib.Path] = []
    seen: set = set()
    rid_key = None
    if report_id is not None and str(report_id).strip() != "":
        try:
            rid_key = int(report_id)
        except (TypeError, ValueError):
            rid_key = None
    if rid_key is not None:
        for r in reports_meta:
            if r.get("id") == rid_key or str(r.get("id")) == str(rid_key):
                _append_export_pdf_unique(paths, seen, REPORTS_DIR / f"report_{rid_key}_summary.pdf")
                for fk in ("file", "filename", "relative"):
                    if r.get(fk):
                        _append_export_pdf_unique(paths, seen, REPORTS_DIR / str(r[fk]))
                if not paths and r.get("name"):
                    safe_name = "".join(
                        c for c in str(r["name"]) if c.isalnum() or c in "-_."
                    )[:50]
                    for pattern in (f"{safe_name}.pdf", f"REPORT_{r.get('id', '')}.pdf"):
                        _append_export_pdf_unique(paths, seen, REPORTS_DIR / pattern)
                break
    elif filter_type in ("test", "validation"):
        for r in reports_meta:
            if r.get("type") != filter_type:
                continue
            rid = r.get("id")
            if rid is not None:
                try:
                    _append_export_pdf_unique(
                        paths, seen, REPORTS_DIR / f"report_{int(rid)}_summary.pdf"
                    )
                except (TypeError, ValueError):
                    pass
            for fk in ("file", "filename", "relative"):
                if r.get(fk):
                    _append_export_pdf_unique(paths, seen, REPORTS_DIR / str(r[fk]))
    else:
        for f in sorted(REPORTS_DIR.glob("*.pdf")):
            _append_export_pdf_unique(paths, seen, f)
    return paths, meta_file


app = Flask(__name__)
CORS(app)  # Enable CORS for localhost development

# Create storage directories
try:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
except Exception as e:
    pass  # Will log after app exists

config = {
    "ESP_PORT": ESP_PORT,
    "ESP_BAUD": ESP_BAUD,
    "A4_PORT": A4_PORT,
    "A4_BAUD": A4_BAUD,
    "THERMAL_PORT": THERMAL_PORT,
    "THERMAL_BAUD": THERMAL_BAUD,
    "REPORTS_DIR": REPORTS_DIR,
    "STORAGE_DIR": STORAGE_DIR,
    "MIN_FREE_GB": MIN_FREE_GB,
}

# Initialize services
hardware_service.init(app, config)
data_service.init(config)
calculation_service.init()
report_service.init(config)
print_service.init(config)
print_formats.init(app, config)
rtc_service.init(app.logger)


def _safe_unique_report_path(prefix: str = "report") -> pathlib.Path:
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    safe = "".join(c for c in prefix if c.isalnum() or c in "-_.")[:50] or "report"
    return REPORTS_DIR / f"{safe}_{ts}.pdf"


def _decode_base64_to_file(b64_data: str, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(b64_data))

app.logger.info("[CONFIG] ESP_PORT=%s, ESP_BAUD=%d", ESP_PORT, ESP_BAUD)
app.logger.info("[CONFIG] A4_PORT=%s, A4_BAUD=%d", A4_PORT, A4_BAUD)
app.logger.info("[CONFIG] THERMAL_PORT=%s, THERMAL_BAUD=%d", THERMAL_PORT, THERMAL_BAUD)
app.logger.info("[CONFIG] STORAGE_DIR=%s", STORAGE_DIR)
app.logger.info("[CONFIG] REPORTS_DIR=%s", REPORTS_DIR)
ensure_export_mount_ready(reason="startup")

# =================== STATIC FILES (UI) ==========================

@app.route("/api/health")
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok"}), 200


@app.route("/")
def serve_index():
    """Serve main HTML file"""
    return send_from_directory(STATIC_ROOT, "app.html")


# NOTE: Catch-all static route is registered at end of file so /api/* routes win.

# =================== HARDWARE ENDPOINTS ==========================

@app.route("/api/hardware/stream", methods=["GET"])
def hardware_stream():
    """SSE stream for real-time hardware data"""
    return hardware_service.start_sse_stream()


@app.route("/api/hardware/command", methods=["POST"])
def hardware_command():
    """Send generic hardware command"""
    data = request.get_json(force=True, silent=True) or {}
    cmd = data.get("command", "")
    if not cmd:
        return jsonify({"error": "No command provided"}), 400
    result = hardware_service.send_command(cmd)
    return jsonify(result)


@app.route("/api/hardware/calibrate/tare", methods=["POST"])
def calibrate_tare():
    """Tare load cell"""
    result = hardware_service.send_command("C,TARE*")
    return jsonify(result)


@app.route("/api/hardware/calibrate/load", methods=["POST"])
def calibrate_load():
    """Start load calibration"""
    result = hardware_service.send_command("C,LOAD*")
    return jsonify(result)


@app.route("/api/hardware/calibrate/distance/zero", methods=["POST"])
def calibrate_distance_zero():
    """Distance zero calibration: C,DZ* -> wait C,DZ,OK/ERR -> if OK wait T,HOME,OK"""
    result = hardware_service.send_command("C,DZ*", timeout=None)
    if not result.get("ok"):
        return jsonify(result)
    resp = (result.get("response") or "").upper()
    if "DZ,ERR" in resp:
        return jsonify({"ok": False, "error": "Distance zero failed", "response": result.get("response")})
    wait_result = hardware_service.wait_for_line_containing("T,HOME,OK", timeout=60.0)
    if not wait_result.get("ok"):
        return jsonify(wait_result)
    return jsonify({"ok": True})


@app.route("/api/hardware/calibrate/distance/span", methods=["POST"])
def calibrate_distance_span():
    """Distance span calibration - no timeout, wait for C,DS,OK"""
    result = hardware_service.send_command("C,DS*", timeout=None)
    if result.get("ok"):
        resp = (result.get("response") or "").upper()
        if "DS,ERR" in resp:
            return jsonify({"ok": False, "error": "Distance span failed", "response": result.get("response")})
    return jsonify(result)


@app.route("/api/hardware/test/dimension", methods=["POST"])
def test_dimension():
    """Start dimension test; noTimeout in body uses no timeout (e.g. distance validation)"""
    data = request.get_json(force=True, silent=True) or {}
    no_timeout = data.get("noTimeout", False)
    result = hardware_service.send_command(
        "T,DIM*", timeout=None if no_timeout else hardware_service.TEST_COMMAND_TIMEOUT
    )
    if not result.get("ok"):
        return jsonify(result), 503
    return jsonify(result)


@app.route("/api/hardware/test/hardness", methods=["POST"])
def test_hardness():
    """Start hardness test - allow 30s for ESP to measure"""
    result = hardware_service.send_command(
        "T,HARD*", timeout=hardware_service.TEST_COMMAND_TIMEOUT
    )
    if not result.get("ok"):
        return jsonify(result), 503
    return jsonify(result)


@app.route("/api/hardware/test/home", methods=["POST"])
def test_home():
    """Home axis"""
    result = hardware_service.send_command("T,HOME*")
    return jsonify(result)


@app.route("/api/hardware/test/backoff", methods=["POST"])
def test_backoff():
    """Backoff movement (adds addMm to user value; default +2 for test runs, +3 for distance validation)"""
    data = request.get_json(force=True, silent=True) or {}
    mm = data.get("mm", 0.0)
    add_mm = data.get("addMm", 2)
    no_timeout = data.get("noTimeout", False)
    try:
        mm = float(mm) + float(add_mm)
    except (ValueError, TypeError):
        mm = 2.0
    cmd = f"T,BO,{mm}*"
    result = hardware_service.send_command(cmd, timeout=None if no_timeout else hardware_service.COMMAND_TIMEOUT)
    return jsonify(result)


@app.route("/api/hardware/validation/load/start", methods=["POST"])
def validation_load_start():
    """Start load validation"""
    result = hardware_service.send_command("V,L,1*")
    return jsonify(result)


@app.route("/api/hardware/validation/load/stop", methods=["POST"])
def validation_load_stop():
    """Stop load validation"""
    result = hardware_service.send_command("V,L,0*")
    return jsonify(result)


@app.route("/api/hardware/status", methods=["GET"])
def hardware_status():
    """Get system status"""
    result = hardware_service.send_command("S,PING*")
    return jsonify(result)


# =================== BRIDGE DATETIME HELPERS ==========================

def _get_stored_datetime():
    """Read datetime from bridge storage, advance by elapsed time. Returns dict with date, time, time_12h, datetime."""
    now_ts = time.time()
    try:
        if DATETIME_STORAGE.exists():
            with open(DATETIME_STORAGE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            dt_str = data.get('datetime', '')
            last_tick = data.get('last_tick', now_ts)
            if dt_str:
                dt_obj = datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
                elapsed = max(0, now_ts - last_tick)
                dt_obj = dt_obj + timedelta(seconds=elapsed)
                try:
                    with open(DATETIME_STORAGE, 'w', encoding='utf-8') as f:
                        json.dump({
                            "datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
                            "last_tick": now_ts
                        }, f)
                except Exception:
                    pass
                h = dt_obj.hour
                h12 = 12 if (h % 12) == 0 else (h % 12)
                suffix = "PM" if h >= 12 else "AM"
                time_12h = f"{h12:02d}:{dt_obj.minute:02d} {suffix}"
                return {
                    "datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
                    "date": dt_obj.strftime("%d-%m-%Y"),
                    "time": dt_obj.strftime("%H:%M"),
                    "time_12h": time_12h,
                }
    except Exception as e:
        app.logger.warning("_get_stored_datetime read failed: %s", e)
    now = datetime.now()
    h = now.hour
    h12 = 12 if (h % 12) == 0 else (h % 12)
    suffix = "PM" if h >= 12 else "AM"
    time_12h = f"{h12:02d}:{now.minute:02d} {suffix}"
    out = {
        "datetime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "date": now.strftime("%d-%m-%Y"),
        "time": now.strftime("%H:%M"),
        "time_12h": time_12h,
    }
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        with open(DATETIME_STORAGE, 'w', encoding='utf-8') as f:
            json.dump({"datetime": out["datetime"], "last_tick": now_ts}, f)
    except Exception as e:
        app.logger.warning("_get_stored_datetime save init failed: %s", e)
    return out


def _save_datetime(dt_obj):
    """Save datetime to bridge storage (source of truth for display, DD-MM-YYYY format)."""
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    with open(DATETIME_STORAGE, 'w', encoding='utf-8') as f:
        json.dump({
            "datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
            "last_tick": time.time()
        }, f)


# =================== RTC ENDPOINTS ==========================

@app.route("/api/rtc/date", methods=["GET"])
def get_rtc_date():
    """Get current RTC date/time"""
    result = rtc_service.get_rtc_date()
    if result.get("success"):
        return jsonify(result), 200
    return jsonify(result), 500


@app.route("/api/get_datetime", methods=["GET"])
def get_datetime():
    """Return bridge-stored datetime (DD-MM-YYYY, no Pi regional dependency)."""
    out = _get_stored_datetime()
    return jsonify(out)


@app.route("/api/set_datetime", methods=["POST"])
def set_datetime():
    """Set datetime (bridge-compatible). Body: { "datetime": "2025-02-12T14:30:00" }. Bridge storage + system clock on Pi."""
    role = request.headers.get('X-User-Role', '').lower()
    if role not in ALLOWED_DATETIME_ROLES:
        return jsonify({"ok": False, "error": "forbidden"}), 403
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get('datetime', '')
    if not dt_str:
        return jsonify({"ok": False, "error": "Missing datetime parameter"}), 400
    try:
        dt_obj = datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        date_cmd_str = dt_obj.strftime('%Y-%m-%d %H:%M:%S')

        if sys.platform == 'win32':
            _save_datetime(dt_obj)
            return jsonify({"ok": True, "datetime": dt_str})

        try:
            subprocess.run(['sudo', 'date', '-s', date_cmd_str], capture_output=True, text=True, timeout=5, check=True)
            _save_datetime(dt_obj)
            # Sync system time to hardware clock (RTC) using hwclock with +5 hour offset
            # Offset is applied so after restart, RTC time displays correctly
            dt_rtc = dt_obj + timedelta(hours=5)
            rtc_cmd_str = dt_rtc.strftime('%Y-%m-%d %H:%M:%S')
            try:
                subprocess.run(['sudo', 'date', '-s', rtc_cmd_str], capture_output=True, text=True, timeout=5, check=True)
                subprocess.run(['sudo', 'hwclock', '--systohc'], capture_output=True, timeout=3, check=False)
                # Restore system time to user's input (without offset) for display
                subprocess.run(['sudo', 'date', '-s', date_cmd_str], capture_output=True, text=True, timeout=5, check=True)
            except Exception as hw_err:
                if app.logger:
                    app.logger.warning("set_datetime: RTC sync failed: %s", hw_err)
            return jsonify({"ok": True, "datetime": dt_str})
        except subprocess.CalledProcessError as e1:
            err_msg = (e1.stderr or e1.stdout or str(e1)).strip() or "Permission denied"
            result = subprocess.run(
                ['sudo', 'timedatectl', 'set-time', date_cmd_str],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                _save_datetime(dt_obj)
                # Sync system time to hardware clock (RTC) using hwclock with +5 hour offset
                dt_rtc = dt_obj + timedelta(hours=5)
                rtc_cmd_str = dt_rtc.strftime('%Y-%m-%d %H:%M:%S')
                try:
                    subprocess.run(['sudo', 'date', '-s', rtc_cmd_str], capture_output=True, text=True, timeout=5, check=True)
                    subprocess.run(['sudo', 'hwclock', '--systohc'], capture_output=True, timeout=3, check=False)
                    # Restore system time to user's input (without offset) for display
                    subprocess.run(['sudo', 'date', '-s', date_cmd_str], capture_output=True, text=True, timeout=5, check=True)
                except Exception as hw_err:
                    if app.logger:
                        app.logger.warning("set_datetime: RTC sync failed: %s", hw_err)
                return jsonify({"ok": True, "datetime": dt_str})
            try:
                subprocess.run(['sudo', 'timedatectl', 'set-time', date_cmd_str], capture_output=True, text=True, timeout=5, check=True)
                _save_datetime(dt_obj)
                # Sync system time to hardware clock (RTC) using hwclock with +5 hour offset
                dt_rtc = dt_obj + timedelta(hours=5)
                rtc_cmd_str = dt_rtc.strftime('%Y-%m-%d %H:%M:%S')
                try:
                    subprocess.run(['sudo', 'date', '-s', rtc_cmd_str], capture_output=True, text=True, timeout=5, check=True)
                    subprocess.run(['sudo', 'hwclock', '--systohc'], capture_output=True, timeout=3, check=False)
                    # Restore system time to user's input (without offset) for display
                    subprocess.run(['sudo', 'date', '-s', date_cmd_str], capture_output=True, text=True, timeout=5, check=True)
                except Exception as hw_err:
                    if app.logger:
                        app.logger.warning("set_datetime: RTC sync failed: %s", hw_err)
                return jsonify({"ok": True, "datetime": dt_str})
            except subprocess.CalledProcessError as e2:
                err2 = (e2.stderr or e2.stdout or str(e2)).strip() or "Failed to set system time"
                app.logger.warning("set_datetime: date failed (%s), timedatectl failed (%s)", err_msg, err2)
                return jsonify({"ok": False, "error": "Failed to set system time"}), 500
            except Exception as e2:
                app.logger.warning("set_datetime: date failed (%s), timedatectl failed: %s", err_msg, e2)
                return jsonify({"ok": False, "error": "Failed to set system time"}), 500
    except ValueError:
        return jsonify({"error": "Invalid datetime format"}), 400
    except Exception as e:
        app.logger.exception("set_datetime failed")
        return jsonify({"error": str(e)}), 500


@app.route("/api/rtc/date", methods=["POST"])
def set_rtc_date():
    """Set RTC date/time. Body: { "datetime": "2025-02-12T14:30:00" } (ISO format). Requires Admin or Factory role."""
    role = request.headers.get("X-User-Role", "").lower()
    if role not in ALLOWED_DATETIME_ROLES:
        return jsonify({"success": False, "error": "Forbidden. Admin or Factory role required to set RTC."}), 403
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime")
    dt = None
    if dt_str:
        try:
            dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        except ValueError:
            return jsonify({"success": False, "error": "Invalid datetime format"}), 400
    result = rtc_service.set_rtc_date(dt)
    if result.get("success"):
        return jsonify(result), 200
    return jsonify(result), 500


# =================== DATA ENDPOINTS ==========================

@app.route("/api/data/recipes", methods=["GET"])
def get_recipes():
    """List all recipes"""
    try:
        recipes = data_service.list_recipes()
        return jsonify({"recipes": recipes}), 200
    except Exception as e:
        app.logger.exception("Error listing recipes")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes", methods=["POST"])
def create_recipe():
    """Create new recipe"""
    try:
        recipe_data = request.get_json(force=True, silent=True) or {}
        # Validate recipe data
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        # Process recipe form data
        processed_recipe = calculation_service.process_recipe_form_data(recipe_data)
        recipe_id = data_service.save_recipe(processed_recipe)
        return jsonify({"id": recipe_id, "recipe": processed_recipe}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["GET"])
def get_recipe(recipe_id):
    """Get recipe by ID"""
    try:
        recipe = data_service.get_recipe(recipe_id)
        if recipe:
            return jsonify({"recipe": recipe}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["PUT"])
def update_recipe(recipe_id):
    """Update recipe"""
    try:
        recipe_data = request.get_json(force=True, silent=True) or {}
        recipe_data["id"] = recipe_id
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed_recipe = calculation_service.process_recipe_form_data(recipe_data)
        updated = data_service.save_recipe(processed_recipe)
        if updated:
            return jsonify({"id": recipe_id, "recipe": processed_recipe}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["DELETE"])
def delete_recipe(recipe_id):
    """Delete recipe"""
    try:
        success = data_service.delete_recipe(recipe_id)
        if success:
            return jsonify({"success": True}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports", methods=["GET"])
def get_reports():
    """List reports with optional filter"""
    try:
        filter_type = request.args.get("filter", "all")
        reports = data_service.list_reports(filter_type)
        return jsonify({"reports": reports}), 200
    except Exception as e:
        app.logger.exception("Error listing reports")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports", methods=["POST"])
def create_report():
    """Create new report"""
    try:
        report_data = request.get_json(force=True, silent=True) or {}
        # Generate report with calculations
        enriched_report = report_service.generate_report(report_data)
        report_id = data_service.save_report(enriched_report)
        # Save 70-char (A4) and 48-char (thermal) text files for print-from-file
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            print_service.save_report_text_files(enriched_report, report_id, REPORTS_DIR)
        except Exception:
            app.logger.warning("save_report_text_files failed (report saved to JSON)", exc_info=True)
        try:
            report_service.save_report_summary_pdf(enriched_report, report_id)
        except Exception:
            app.logger.warning(
                "save_report_summary_pdf failed (report saved to JSON)", exc_info=True
            )
        return jsonify({"id": report_id, "report": enriched_report}), 201
    except Exception as e:
        app.logger.exception("Error creating report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["GET"])
def get_report(report_id):
    """Get report by ID"""
    try:
        report = data_service.get_report(report_id)
        if report:
            return jsonify({"report": report}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["DELETE"])
def delete_report(report_id):
    """Delete report"""
    try:
        success = data_service.delete_report(report_id)
        if success:
            return jsonify({"success": True}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members", methods=["GET"])
def get_members():
    """List all members"""
    try:
        members = data_service.list_members()
        return jsonify({"members": members}), 200
    except Exception as e:
        app.logger.exception("Error listing members")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members", methods=["POST"])
def create_member():
    """Create new member"""
    try:
        member_data = request.get_json(force=True, silent=True) or {}
        member_id = data_service.save_member(member_data)
        return jsonify({"id": member_id, "member": member_data}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["GET"])
def get_member(member_id):
    """Get member by ID"""
    try:
        member = data_service.get_member(member_id)
        if member:
            return jsonify({"member": member}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["PUT"])
def update_member(member_id):
    """Update member"""
    try:
        member_data = request.get_json(force=True, silent=True) or {}
        member_data["id"] = member_id
        updated = data_service.save_member(member_data)
        if updated:
            return jsonify({"id": member_id, "member": member_data}), 200
        return jsonify({"error": "Member not found"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["DELETE"])
def delete_member(member_id):
    """Delete member"""
    try:
        success = data_service.delete_member(member_id)
        if success:
            return jsonify({"success": True}), 200
        return jsonify({"error": "Member not found"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error deleting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings", methods=["GET"])
def get_factory_settings():
    """Get factory settings"""
    try:
        settings = data_service.get_factory_settings()
        return jsonify({"settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error getting factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings", methods=["POST"])
def save_factory_settings():
    """Save factory settings"""
    try:
        settings = request.get_json(force=True, silent=True) or {}
        data_service.save_factory_settings(settings)
        return jsonify({"success": True, "settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error saving factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-reset", methods=["POST"])
def factory_reset():
    """Factory reset: delete all reports, recipes, and members. Requires Factory role."""
    try:
        user = data_service.get_current_user()
        if not user or (user.get("role") or "").lower() != "factory":
            return jsonify({"error": "Forbidden. Factory role required."}), 403
        result = data_service.factory_reset()
        return jsonify({"success": True, "deleted": result["deleted"]}), 200
    except Exception as e:
        app.logger.exception("Error during factory reset")
        return jsonify({"error": str(e)}), 500


# Factory support: kiosk user needs passwordless sudo for:
#   systemctl enable ssh
#   systemctl start ssh
# Example sudoers line (adjust user name):
#   kiosk ALL=(root) NOPASSWD: /bin/systemctl enable ssh, /bin/systemctl start ssh
_FACTORY_SUPPORT_USER = "raise@service"
_FACTORY_SUPPORT_PASSWORD = "raise@dev"


def _get_ipv4_addresses_for_display():
    """Best-effort global/LAN IPv4 addresses (hostname -I, then iproute2)."""
    try:
        proc = subprocess.run(
            ["hostname", "-I"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        raw = (proc.stdout or "").strip()
        if raw:
            parts = [p for p in raw.split() if p]
            non_lo = [p for p in parts if not p.startswith("127.")]
            return " ".join(non_lo if non_lo else parts)
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    for ip_cmd in (["ip", "-4", "-o", "addr", "show", "scope", "global"], ["/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"]):
        try:
            proc = subprocess.run(
                ip_cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if proc.returncode != 0:
                continue
            found = re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)/", proc.stdout or "")
            if found:
                return " ".join(found)
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            continue
    return ""


def _factory_support_run_systemctl_ssh():
    """Enable and start ssh; return list of error strings (empty if all ok)."""
    errors = []
    for cmd in (
        ["sudo", "systemctl", "enable", "ssh"],
        ["sudo", "systemctl", "start", "ssh"],
    ):
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
                errors.append(f"{' '.join(cmd)}: {err}")
                app.logger.warning("factory_support_run_systemctl_ssh: %s", err)
        except subprocess.TimeoutExpired:
            msg = f"{' '.join(cmd)}: timeout"
            errors.append(msg)
            app.logger.warning("factory_support_run_systemctl_ssh: %s", msg)
        except Exception as e:
            msg = f"{' '.join(cmd)}: {e}"
            errors.append(msg)
            app.logger.exception("factory_support_run_systemctl_ssh")
    return errors


# After editing routes in this file, restart the Flask process (e.g. sudo systemctl restart kiosk.service)
# or POST /api/support/factory/verify will 405: the old process has no POST rule and only the static catch-all matches.


@app.route("/api/support/factory/ping", methods=["GET"])
def factory_support_ping():
    """Sanity check that factory support API is loaded (avoids confusing 405 from stale server)."""
    return jsonify({"ok": True, "factory_support_api": True}), 200


@app.route("/api/support/factory/enable-ssh", methods=["POST"])
def factory_support_enable_ssh():
    """Enable and start SSH for remote support. Requires sudo (see comment above)."""
    errors = _factory_support_run_systemctl_ssh()
    if errors:
        return jsonify({"ok": False, "error": "; ".join(errors)}), 200
    return jsonify({"ok": True}), 200


@app.route("/api/support/factory/verify", methods=["POST"])
def factory_support_verify():
    """Validate credentials, run support system commands, return LAN IPv4 addresses."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if username != _FACTORY_SUPPORT_USER or password != _FACTORY_SUPPORT_PASSWORD:
            return jsonify({"error": "Invalid username or password"}), 401
        ssh_errors = _factory_support_run_systemctl_ssh()
        addresses = _get_ipv4_addresses_for_display()
        return jsonify(
            {
                "ok": True,
                "addresses": addresses,
                "ssh_ok": len(ssh_errors) == 0,
                "ssh_error": "; ".join(ssh_errors) if ssh_errors else "",
            }
        ), 200
    except Exception as e:
        app.logger.exception("factory_support_verify")
        return jsonify({"error": "Could not complete factory support request"}), 500


@app.route("/api/data/auth/login", methods=["POST"])
def login():
    """User login"""
    try:
        credentials = request.get_json(force=True, silent=True) or {}
        username = credentials.get("username", "").strip()
        password = credentials.get("password", "")
        
        # Authenticate user
        user = data_service.authenticate_user(username, password)
        if user:
            # Save current user session
            data_service.save_current_user(user)
            ensure_export_mount_ready(reason="login")
            return jsonify({"success": True, "user": user}), 200
        return jsonify({"error": "Invalid username or password"}), 401
    except Exception as e:
        app.logger.exception("Error during login")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/logout", methods=["POST"])
def logout():
    """User logout"""
    try:
        data_service.clear_current_user()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during logout")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/current-user", methods=["GET"])
def get_current_user():
    """Get current logged-in user"""
    try:
        user = data_service.get_current_user()
        if user:
            return jsonify({"user": user}), 200
        return jsonify({"user": None}), 200
    except Exception as e:
        app.logger.exception("Error getting current user")
        return jsonify({"error": str(e)}), 500


# =================== CALCULATION ENDPOINTS ==========================

@app.route("/api/calculate/recipe-validate", methods=["POST"])
def validate_recipe_endpoint():
    """Validate recipe data"""
    try:
        recipe_data = request.get_json(force=True, silent=True) or {}
        result = calculation_service.validate_recipe(recipe_data)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error validating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/calculate/unit-convert", methods=["POST"])
def convert_unit_endpoint():
    """Convert units"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        value = float(data.get("value", 0))
        from_unit = data.get("from_unit", "Newton (N)")
        to_unit = data.get("to_unit", "Newton (N)")
        conversion_factor = data.get("conversion_factor")
        result = calculation_service.convert_unit(value, from_unit, to_unit, conversion_factor)
        return jsonify({"value": result, "unit": to_unit}), 200
    except Exception as e:
        app.logger.exception("Error converting unit")
        return jsonify({"error": str(e)}), 500


@app.route("/api/calculate/statistics", methods=["POST"])
def calculate_statistics_endpoint():
    """Calculate statistics"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        data_points = data.get("data_points", [])
        result = calculation_service.calculate_statistics(data_points)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error calculating statistics")
        return jsonify({"error": str(e)}), 500


@app.route("/api/calculate/tolerance-check", methods=["POST"])
def check_tolerance_endpoint():
    """Check if value is within tolerance"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        value = float(data.get("value", 0))
        nominal = float(data.get("nominal", 0))
        tolerance_config = data.get("tolerance_config", {})
        result = calculation_service.check_tolerance(value, nominal, tolerance_config)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error checking tolerance")
        return jsonify({"error": str(e)}), 500


@app.route("/api/calculate/tolerance-check-t1t2", methods=["POST"])
def check_tolerance_t1t2_endpoint():
    """Check value against T1/T2 three-tier tolerance"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        value = float(data.get("value", 0))
        nominal = float(data.get("nominal", 0))
        tolerance_config = data.get("tolerance_config", {})
        result = calculation_service.check_tolerance_t1_t2(value, nominal, tolerance_config)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error checking T1/T2 tolerance")
        return jsonify({"error": str(e)}), 500


# =================== REPORT ENDPOINTS ==========================

@app.route("/api/reports/generate", methods=["POST"])
def generate_report_endpoint():
    """Generate report from test data"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        test_data = data.get("test_data", {})
        recipe = data.get("recipe", {})
        factory_settings = data.get("factory_settings")
        report = report_service.generate_report(test_data, recipe, factory_settings)
        return jsonify({"report": report}), 200
    except Exception as e:
        app.logger.exception("Error generating report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/<int:report_id>/preview", methods=["GET"])
def get_report_preview(report_id):
    """Get report preview data"""
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        preview_data = report_service.get_report_preview_data(report)
        return jsonify({"preview": preview_data}), 200
    except Exception as e:
        app.logger.exception("Error getting report preview")
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/<int:report_id>/pdf", methods=["GET"])
def download_report_pdf(report_id):
    """Download PDF report"""
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        pdf_path = report_service.create_pdf_report(report)
        if pdf_path and pdf_path.exists():
            from flask import send_file
            return send_file(str(pdf_path), mimetype='application/pdf', as_attachment=True)
        return jsonify({"error": "PDF generation failed"}), 500
    except Exception as e:
        app.logger.exception("Error downloading PDF")
        return jsonify({"error": str(e)}), 500


@app.route("/api/save_report_pdf", methods=["POST"])
def api_save_report_pdf():
    """Save report as PDF from client HTML (dt sample parity) or base64 PDF."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        if data.get("pdf_base64"):
            raw = data["pdf_base64"]
            pdf_size = len(raw) * 3 / 4
            if pdf_size > 50 * 1024 * 1024:
                return jsonify({"error": "E3004", "message": "PDF file too large (max 50 MB)"}), 400
            report_name = data.get("report_name", "report")
            safe_name = "".join(c for c in report_name if c.isalnum() or c in "-_.")[:50]
            p = _safe_unique_report_path(safe_name)
            _decode_base64_to_file(raw, p)
            txt_path = p.with_suffix(".txt")
            thermal_txt_path = pathlib.Path(str(p) + "_thermal.txt")
            report_data = data.get("report_data", {}) or {
                "name": safe_name,
                "createdAt": datetime.utcnow().isoformat(),
            }
            try:
                print_formats.generate_text_report(report_data, txt_path, layout="a4")
            except Exception:
                pass
            try:
                print_formats.generate_text_report(
                    report_data, thermal_txt_path, layout="thermal"
                )
            except Exception:
                pass
            print_formats.enforce_fifo_reports()
            return jsonify(
                {
                    "ok": True,
                    "filename": str(p),
                    "relative": str(p.name),
                    "text_file": str(txt_path.name) if txt_path.exists() else None,
                    "thermal_text_file": (
                        str(thermal_txt_path.name) if thermal_txt_path.exists() else None
                    ),
                }
            ), 200
        html = data.get("html")
        if html:
            report_name = data.get("report_name", "report")
            safe_name = "".join(c for c in report_name if c.isalnum() or c in "-_.")[:50]
            tmp_pdf = _safe_unique_report_path(safe_name)
            try:
                print_formats.render_html_to_a4_pdf(html, tmp_pdf)
            except Exception as e:
                app.logger.exception("[REPORT] PDF generation failed")
                return jsonify({"error": "E3002", "message": str(e)}), 500
            txt_path = tmp_pdf.with_suffix(".txt")
            thermal_txt_path = pathlib.Path(str(tmp_pdf) + "_thermal.txt")
            report_data = data.get("report_data", {}) or {
                "name": report_name,
                "createdAt": datetime.utcnow().isoformat(),
            }
            try:
                print_formats.generate_text_report(report_data, txt_path, layout="a4")
            except Exception:
                pass
            try:
                print_formats.generate_text_report(
                    report_data, thermal_txt_path, layout="thermal"
                )
            except Exception:
                pass
            print_formats.enforce_fifo_reports()
            return jsonify(
                {
                    "ok": True,
                    "filename": str(tmp_pdf),
                    "relative": str(tmp_pdf.name),
                    "text_file": str(txt_path.name) if txt_path.exists() else None,
                    "thermal_text_file": (
                        str(thermal_txt_path.name) if thermal_txt_path.exists() else None
                    ),
                }
            ), 200
        return (
            jsonify({"error": "E3001", "message": "Missing pdf_base64 or html"}),
            400,
        )
    except Exception as e:
        app.logger.exception("[REPORT] Error saving report PDF")
        return jsonify({"error": "E9999", "message": str(
            e)}), 500


@app.route("/api/reports/export", methods=["POST"])
def export_reports():
    """Export reports to USB as PDF (client supplies preview HTML per report)."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        report_ids_raw = data.get("report_ids", [])
        report_ids = []
        for rid in report_ids_raw:
            try:
                report_ids.append(int(rid))
            except (TypeError, ValueError):
                continue
        if not report_ids:
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        pdf_html_by_id = data.get("pdf_html_by_id") or {}
        if isinstance(pdf_html_by_id, dict):
            pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id.items()}
        else:
            pdf_html_by_id = {}
        for rid in report_ids:
            h = pdf_html_by_id.get(str(rid))
            if not h or not str(h).strip():
                return (
                    jsonify(
                        {
                            "success": False,
                            "error": (
                                f"Missing pdf_html_by_id for report {rid}. "
                                "Open preview from the app or ensure the UI sends HTML."
                            ),
                        }
                    ),
                    400,
                )
        export_path = data.get("export_path")
        if export_path:
            export_dir = pathlib.Path(export_path)
        else:
            try:
                mount_path = find_export_mount()
                export_dir = mount_path / EXPORT_SUBFOLDER
            except RuntimeError as e:
                return jsonify({"success": False, "error": str(e)}), 400
        result = report_service.export_reports_to_usb(
            report_ids, str(export_dir), pdf_html_by_id=pdf_html_by_id
        )
        if not result.get("success"):
            return jsonify(result), 500
        payload = dict(result)
        out_dir_resolved = str(export_dir.resolve())
        payload["export_directory"] = out_dir_resolved
        app.logger.info(
            "[EXPORT] Wrote %s report PDF(s) to %s",
            payload.get("count"),
            out_dir_resolved,
        )
        return jsonify(payload), 200
    except Exception as e:
        app.logger.exception("Error exporting reports")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/export_reports", methods=["POST"])
def api_export_reports():
    """
    Copy report PDFs from internal storage to the external USB mount (excludes internal
    device via find_export_mount). Matches the UI contract: ok, exported[], failed[], E4001.
    """
    try:
        try:
            mount_path = find_export_mount()
        except RuntimeError:
            return jsonify(
                {
                    "error": "E4001",
                    "message": (
                        "Pendrive not detected. Please connect the pendrive and restart the device."
                    ),
                }
            ), 400

        data = request.get_json(force=True, silent=True) or {}
        report_id = data.get("report_id")
        filter_type = (data.get("filter") or "all").strip().lower()
        if filter_type not in ("all", "test", "validation"):
            filter_type = "all"

        export_dir = mount_path / EXPORT_SUBFOLDER
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            export_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            if getattr(e, "errno", None) in (5, 19):
                return jsonify(
                    {
                        "error": "E4001",
                        "message": (
                            "Pendrive not detected. Please connect the pendrive and restart the device."
                        ),
                    }
                ), 400
            raise

        pdfs_to_export, meta_file = _pdf_paths_for_usb_file_export(report_id, filter_type)
        if report_id is not None and str(report_id).strip() != "" and not pdfs_to_export:
            return jsonify(
                {
                    "ok": False,
                    "error": "E3003",
                    "message": "No report PDF found to export. Save the report first.",
                }
            ), 400

        exported = []
        failed = []
        for pdf_path in pdfs_to_export:
            dest = export_dir / pdf_path.name
            try:
                _copy_file_to_fat_friendly(dest, pdf_path)
                exported.append(str(dest))
            except Exception as ex:
                failed.append({"file": str(pdf_path), "error": str(ex)})

        if report_id is None and meta_file.exists():
            try:
                dest_meta = export_dir / meta_file.name
                _copy_file_to_fat_friendly(dest_meta, meta_file)
                exported.append(str(dest_meta))
            except Exception as ex:
                failed.append({"file": "reports.json", "error": str(ex)})

        result: dict = {"ok": True, "exported": exported}
        if failed:
            result["failed"] = failed
        app.logger.info(
            "[EXPORT] api_export_reports copied %s file(s) to %s",
            len(exported),
            export_dir,
        )
        return jsonify(result)
    except Exception as e:
        app.logger.exception("api_export_reports failed")
        err_str = str(e).lower()
        pendrive_keywords = (
            "mount",
            "no such file",
            "no such device",
            "read-only",
            "permission denied",
            "input/output error",
            "pendrive",
            "i/o error",
        )
        if any(k in err_str for k in pendrive_keywords):
            return jsonify(
                {
                    "error": "E4001",
                    "message": (
                        "Pendrive not detected. Please connect the pendrive and restart the device."
                    ),
                }
            ), 400
        return jsonify({"error": "E9999", "message": "Unexpected system error"}), 500


# =================== PRINT ENDPOINTS ==========================

@app.route("/api/print/a4", methods=["POST"])
def print_a4():
    """Print to A4 printer (report or recipe)"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = data_service.get_factory_settings()
                except Exception:
                    pass
            result = print_service.print_recipe_a4(recipe_data, A4_PORT)
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            path_a4 = REPORTS_DIR / f"report_{report_id}_a4.txt"
            if path_a4.exists():
                result = print_service.print_report_from_file(path_a4, A4_PORT, A4_BAUD, printer_type="a4")
                return jsonify(result), 200 if result.get("success") else 500
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = data_service.get_factory_settings()
            except Exception:
                pass
        result = print_service.print_a4_report(report_data, A4_PORT)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing A4")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/thermal", methods=["POST"])
def print_thermal():
    """Print to thermal printer (report or recipe)"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = data_service.get_factory_settings()
                except Exception:
                    pass
            result = print_service.print_recipe_thermal(recipe_data, THERMAL_PORT)
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            path_thermal = REPORTS_DIR / f"report_{report_id}_thermal.txt"
            if path_thermal.exists():
                result = print_service.print_report_from_file(path_thermal, THERMAL_PORT, THERMAL_BAUD, printer_type="thermal")
                return jsonify(result), 200 if result.get("success") else 500
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = data_service.get_factory_settings()
            except Exception:
                pass
        result = print_service.print_thermal_report(report_data, THERMAL_PORT)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing thermal")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/status", methods=["GET"])
def print_status():
    """Get printer status"""
    try:
        printer_type = request.args.get("type", "a4")
        status = print_service.check_printer_status(printer_type)
        return jsonify(status), 200
    except Exception as e:
        app.logger.exception("Error checking printer status")
        return jsonify({"error": str(e)}), 500


# =================== STATIC FILES (catch-all; must be last among routes) =======
# Only GET/HEAD: if POST matched this rule, Flask would return 405 for /api/... URLs
# because the path overlaps API routes in the matcher. POST must not bind here.

@app.route("/<path:path>", methods=["GET", "HEAD"])
def serve_static(path):
    """Serve static files (CSS, JS, images, etc.)."""
    return send_from_directory(STATIC_ROOT, path)


# =================== ERROR HANDLERS ==========================

@app.errorhandler(405)
def method_not_allowed(error):
    """JSON for API paths (avoids opaque HTML 405 pages for fetch/XHR)."""
    if request.path.startswith("/api/"):
        return (
            jsonify(
                {
                    "error": "Method not allowed",
                    "path": request.path,
                    "method": request.method,
                }
            ),
            405,
        )
    if isinstance(error, HTTPException):
        return error.get_response()
    return jsonify({"error": "Method not allowed"}), 405


@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def internal_error(error):
    app.logger.exception("Internal server error")
    return jsonify({"error": "Internal server error"}), 500


# =================== MAIN ==========================

if __name__ == "__main__":
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=False)
