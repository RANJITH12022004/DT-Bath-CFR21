"""External USB pendrive detection / mount / unmount for report export.

Identification rule (matches user policy):
  - "Internal" = the OS root device (mmcblk* or whatever hosts '/')
                 PLUS any device whose filesystem UUID is in INTERNAL_USB_UUIDS
                 PLUS the device mounted at INTERNAL_USB_PATH (auto-discovered fallback).
  - "External" = any removable block partition (sd*, nvme*p*, vd*) that is NOT internal.

Mounts unmounted external partitions via udisksctl (requires user to be in plugdev;
udisks2 service must be active). Works as a non-root user via polkit.

Public API:
  list_external_pendrives() -> List[Dict]
  ensure_pendrive_mounted(device_path) -> Dict           # mounts if needed; returns info
  sync_and_unmount_pendrive(device_path) -> Dict         # sync + udisksctl unmount + power-off
"""

from __future__ import annotations

import json
import logging
import os
import pathlib
import re
import subprocess
import time
from typing import Any, Dict, List, Optional, Set, Tuple


logger = logging.getLogger(__name__)


# ---- Device-name regexes (mass storage block partitions only) -----------

_RE_SD_PART = re.compile(r"^/dev/sd[a-z]+[0-9]+$")
_RE_SD_DISK = re.compile(r"^/dev/sd[a-z]+$")
_RE_NVME_PART = re.compile(r"^/dev/nvme[0-9]+n[0-9]+p[0-9]+$")
_RE_NVME_NS = re.compile(r"^/dev/nvme[0-9]+n[0-9]+$")
_RE_VD_PART = re.compile(r"^/dev/vd[a-z]+[0-9]+$")
_RE_VD_DISK = re.compile(r"^/dev/vd[a-z]+$")


def _is_export_block_path(path: str) -> bool:
    if not path:
        return False
    return bool(
        _RE_SD_PART.match(path) or _RE_SD_DISK.match(path)
        or _RE_NVME_PART.match(path) or _RE_NVME_NS.match(path)
        or _RE_VD_PART.match(path) or _RE_VD_DISK.match(path)
    )


# ---- Subprocess helpers --------------------------------------------------

def _run(cmd: List[str], timeout: float = 10.0) -> Tuple[int, str, str]:
    """Run a command. Returns (returncode, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
        return proc.returncode, (proc.stdout or ""), (proc.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.warning("usb_export: %s failed: %s", " ".join(cmd), e)
        return 127, "", str(e)


def _lsblk_tree() -> List[Dict[str, Any]]:
    """Flat list of all block devices (lsblk -J flattened)."""
    rc, out, err = _run(
        ["lsblk", "-J", "-b", "-o", "PATH,NAME,TYPE,RM,SIZE,MOUNTPOINT,FSTYPE,LABEL,UUID,PKNAME"]
    )
    if rc != 0 or not out.strip():
        logger.warning("usb_export: lsblk failed rc=%s err=%s", rc, err.strip()[:200])
        return []
    try:
        data = json.loads(out)
    except (json.JSONDecodeError, ValueError):
        return []
    flat: List[Dict[str, Any]] = []

    def walk(nodes: Any) -> None:
        for node in (nodes or []):
            if isinstance(node, dict):
                flat.append(node)
                walk(node.get("children"))

    walk(data.get("blockdevices"))
    return flat


def _root_pkname() -> Optional[str]:
    """Parent disk name of '/', e.g. 'mmcblk0' when root is mmcblk0p2."""
    rc, out, _ = _run(["findmnt", "-n", "-o", "SOURCE", "/"])
    if rc != 0 or not out.strip():
        return None
    src = out.strip()
    try:
        real = os.path.realpath(src)
    except OSError:
        real = src
    rc2, out2, _ = _run(["lsblk", "-no", "PKNAME", real])
    pk = (out2 or "").strip()
    if pk:
        return pk
    # Source itself is already a disk (e.g. /dev/mmcblk0). Strip prefix.
    return pathlib.Path(real).name or None


def _internal_uuids_from_env() -> Set[str]:
    raw = (os.environ.get("INTERNAL_USB_UUIDS") or "").strip()
    if not raw:
        return set()
    return {p.strip() for p in raw.split(",") if p.strip()}


def _internal_uuid_from_mount(mountpoint: str) -> Optional[str]:
    """UUID of whatever is currently mounted at `mountpoint` (e.g. /media/usb_internal)."""
    if not mountpoint:
        return None
    try:
        if not pathlib.Path(mountpoint).is_dir():
            return None
    except OSError:
        return None
    rc, out, _ = _run(["findmnt", "-n", "-o", "UUID", "--target", mountpoint])
    if rc == 0:
        uid = (out or "").strip()
        if uid:
            return uid
    rc2, out2, _ = _run(["findmnt", "-n", "-o", "SOURCE", "--target", mountpoint])
    if rc2 != 0:
        return None
    src = (out2 or "").strip()
    if not src:
        return None
    rc3, out3, _ = _run(["blkid", "-o", "value", "-s", "UUID", src])
    if rc3 == 0:
        uid = (out3 or "").strip()
        if uid:
            return uid
    return None


def _internal_uuids(env: Optional[Dict[str, str]] = None) -> Set[str]:
    """Combine env-configured UUIDs with the auto-detected internal mount UUID."""
    env = env if env is not None else os.environ  # type: ignore[assignment]
    uuids = set()
    uuids.update(_internal_uuids_from_env())
    internal_path = env.get("INTERNAL_USB_PATH", "/media/usb_internal")
    auto = _internal_uuid_from_mount(internal_path)
    if auto:
        uuids.add(auto)
    return uuids


_SKIP_FS = frozenset({"", "swap", "linux_raid_member", "crypto_luks", "lvm2_member"})
_EXPORT_FS = frozenset({
    "vfat", "fat", "fat32", "exfat", "ntfs", "ntfs3",
    "ext2", "ext3", "ext4", "btrfs", "xfs",
})


def _is_node_internal(node: Dict[str, Any], root_pk: Optional[str], internal_uuids: Set[str]) -> bool:
    path = node.get("path") or ""
    name = node.get("name") or ""
    pkname = (node.get("pkname") or "").strip()
    fs_uuid = (node.get("uuid") or "").strip()
    # Always exclude eMMC / SD card hosting OS
    if "mmcblk" in path or "mmcblk" in name:
        return True
    if root_pk:
        if pkname == root_pk:
            return True
        # If the node itself IS the root disk
        if name == root_pk:
            return True
    if fs_uuid and fs_uuid in internal_uuids:
        return True
    return False


def _is_disk_path(path: str) -> bool:
    """True for whole-disk nodes (/dev/sdb, /dev/nvme0n1) — not partitions."""
    if not path:
        return False
    return bool(
        _RE_SD_DISK.match(path) or _RE_VD_DISK.match(path) or _RE_NVME_NS.match(path)
    )


def _usable_fs(fs_type: str) -> bool:
    fs = (fs_type or "").strip().lower()
    if not fs or fs in _SKIP_FS:
        return False
    return True


def _node_has_fs_children(node: Dict[str, Any], flat: List[Dict[str, Any]]) -> bool:
    """True if this disk has child partitions that themselves have a filesystem."""
    name = (node.get("name") or "").strip()
    if not name:
        return False
    for child in flat:
        if (child.get("type") or "").lower() != "part":
            continue
        if (child.get("pkname") or "").strip() != name:
            continue
        cfs = (child.get("fstype") or "").strip().lower()
        if cfs and cfs not in _SKIP_FS:
            return True
    return False


def _pendrive_entry(node: Dict[str, Any]) -> Dict[str, Any]:
    path = node.get("path") or ""
    size_bytes_raw = node.get("size") or 0
    try:
        size_bytes = int(size_bytes_raw)
    except (TypeError, ValueError):
        size_bytes = 0
    mountpoint = (node.get("mountpoint") or "").strip()
    return {
        "path": path,
        "name": node.get("name") or pathlib.Path(path).name,
        "label": (node.get("label") or "").strip(),
        "fs_type": (node.get("fstype") or "").strip().lower(),
        "fs_uuid": (node.get("uuid") or "").strip(),
        "size_bytes": size_bytes,
        "size_human": _human_bytes(size_bytes),
        "removable": bool(node.get("rm")),
        "mounted": bool(mountpoint),
        "mountpoint": mountpoint,
    }


def list_external_pendrives() -> List[Dict[str, Any]]:
    """List external pendrive filesystems suitable for export.

    Accepts:
      - partitions (type=part) with a usable filesystem
      - whole-disk "superfloppy" devices (type=disk) that have a filesystem and
        no child partitions with a filesystem (e.g. /dev/sdb formatted as VFAT)

    Never lists both a parent disk and its partitions.
    """
    flat = _lsblk_tree()
    root_pk = _root_pkname()
    internal_uuids = _internal_uuids()
    out: List[Dict[str, Any]] = []
    parent_names_with_parts: Set[str] = set()

    # Pass 1: partitions
    for node in flat:
        node_type = (node.get("type") or "").lower()
        if node_type != "part":
            continue
        path = node.get("path") or ""
        if not _is_export_block_path(path):
            continue
        if _is_node_internal(node, root_pk, internal_uuids):
            continue
        fs_type = (node.get("fstype") or "").strip().lower()
        if not fs_type or fs_type in _SKIP_FS:
            continue
        if not _usable_fs(fs_type):
            continue
        pk = (node.get("pkname") or "").strip()
        if pk:
            parent_names_with_parts.add(pk)
        out.append(_pendrive_entry(node))

    # Pass 2: whole-disk FS with no usable child partitions (superfloppy)
    for node in flat:
        node_type = (node.get("type") or "").lower()
        if node_type != "disk":
            continue
        path = node.get("path") or ""
        if not _is_disk_path(path):
            continue
        name = (node.get("name") or pathlib.Path(path).name).strip()
        if name in parent_names_with_parts:
            continue
        if _node_has_fs_children(node, flat):
            continue
        if _is_node_internal(node, root_pk, internal_uuids):
            continue
        fs_type = (node.get("fstype") or "").strip().lower()
        if not fs_type or fs_type in _SKIP_FS:
            continue
        out.append(_pendrive_entry(node))

    out.sort(key=lambda d: d.get("path") or "")
    return out


def summarize_block_devices_for_log() -> str:
    """Compact lsblk summary for diagnostics when no exportable USB is found."""
    flat = _lsblk_tree()
    if not flat:
        return "lsblk empty/unavailable"
    bits = []
    for node in flat:
        path = node.get("path") or node.get("name") or "?"
        bits.append(
            "{path} type={t} fs={fs} uuid={u} mp={mp}".format(
                path=path,
                t=(node.get("type") or "-"),
                fs=(node.get("fstype") or "-") or "-",
                u=(node.get("uuid") or "-") or "-",
                mp=(node.get("mountpoint") or "-") or "-",
            )
        )
    return "; ".join(bits[:40])


def _human_bytes(n: int) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    f = float(n)
    for u in units:
        if f < 1024.0 or u == units[-1]:
            return ("%.1f %s" % (f, u)).replace(".0 ", " ")
        f /= 1024.0
    return "%d B" % n


# ---- Mount / unmount via udisksctl ---------------------------------------

def _udisksctl_mountpoint_of(device_path: str) -> Optional[str]:
    rc, out, _ = _run(["findmnt", "-n", "-o", "TARGET", device_path])
    if rc == 0 and out.strip():
        return out.strip().splitlines()[0]
    return None


def ensure_pendrive_mounted(device_path: str, timeout_sec: float = 20.0) -> Dict[str, Any]:
    """Mount the device if not already mounted. Returns {ok, mountpoint, ...}.

    Uses `udisksctl mount -b <dev>`. Requires udisks2 service + user in plugdev.
    """
    if not device_path or not device_path.startswith("/dev/"):
        return {"ok": False, "error": "Invalid device path"}
    existing = _udisksctl_mountpoint_of(device_path)
    if existing:
        return {"ok": True, "mountpoint": existing, "already_mounted": True}
    rc, out, err = _run(["udisksctl", "mount", "-b", device_path], timeout=timeout_sec)
    text = (out + "\n" + err).strip()
    if rc == 0:
        # Output looks like: "Mounted /dev/sdb1 at /media/rle/USB DISK."
        m = re.search(r"\sat\s+(.+?)\.?\s*$", out or "", flags=re.MULTILINE)
        mountpoint = m.group(1).strip() if m else _udisksctl_mountpoint_of(device_path)
        if mountpoint:
            return {"ok": True, "mountpoint": mountpoint, "already_mounted": False}
        return {"ok": False, "error": "Mount succeeded but mountpoint not found", "raw": text}
    # udisksctl reports "Error mounting ... already mounted at ..." with returncode != 0 in some versions
    if "already mounted" in text.lower():
        mp = _udisksctl_mountpoint_of(device_path)
        if mp:
            return {"ok": True, "mountpoint": mp, "already_mounted": True}
    return {"ok": False, "error": text or ("udisksctl rc=%s" % rc)}


def _disk_parent_device(part_device: str) -> Optional[str]:
    """Given /dev/sdb1 return /dev/sdb; given whole-disk /dev/sdb return itself."""
    if not part_device.startswith("/dev/"):
        return None
    name = part_device[len("/dev/"):]
    # sd* / vd* partitions: trailing digits
    m = re.match(r"^(sd[a-z]+|vd[a-z]+)([0-9]+)$", name)
    if m:
        return "/dev/" + m.group(1)
    # nvme0n1p1 -> nvme0n1
    m = re.match(r"^(nvme[0-9]+n[0-9]+)p([0-9]+)$", name)
    if m:
        return "/dev/" + m.group(1)
    # Already a whole disk — power-off the same node
    if _is_disk_path(part_device):
        return part_device
    return None


def sync_and_unmount_pendrive(device_path: str, power_off: bool = True, timeout_sec: float = 20.0) -> Dict[str, Any]:
    """sync; udisksctl unmount; (optional) udisksctl power-off the parent disk.

    Best-effort: returns details but never raises. Caller usually proceeds either way.
    """
    detail: Dict[str, Any] = {"device": device_path, "synced": False, "unmounted": False, "powered_off": False}
    if not device_path or not device_path.startswith("/dev/"):
        detail["error"] = "Invalid device path"
        return detail
    # Flush the kernel page cache to disk.
    rc_sync, _, _ = _run(["sync"], timeout=timeout_sec)
    detail["synced"] = (rc_sync == 0)
    mp = _udisksctl_mountpoint_of(device_path)
    if not mp:
        detail["unmounted"] = True
        detail["was_mounted"] = False
    else:
        rc_um, out_um, err_um = _run(["udisksctl", "unmount", "-b", device_path], timeout=timeout_sec)
        detail["unmount_output"] = (out_um + err_um).strip()
        detail["unmounted"] = (rc_um == 0)
        detail["was_mounted"] = True
    if power_off:
        parent = _disk_parent_device(device_path)
        if parent:
            rc_po, out_po, err_po = _run(["udisksctl", "power-off", "-b", parent], timeout=timeout_sec)
            detail["power_off_output"] = (out_po + err_po).strip()
            detail["powered_off"] = (rc_po == 0)
            detail["power_off_target"] = parent
    return detail


def export_subfolder_name(prefix: str) -> str:
    """e.g. 'TapDensity-Reports-Exported/2026-05-12_142503'."""
    stamp = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
    base = (prefix or "Reports-Exported").strip().strip("/")
    return "%s/%s" % (base, stamp)
