#!/usr/bin/env python3
"""Smoke: USB list (whole-disk), mount, 24h export schedule stage→confirm→purge."""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    os.environ.setdefault("INTERNAL_USB_PATH", "/media/usb_internal")
    os.environ.setdefault("STORAGE_DIR", "/media/usb_internal/storage")
    os.environ.setdefault("INTERNAL_USB_UUIDS", "752a2820-c257-43cd-a2eb-fb52adca9fc2")

    import usb_export
    import data_service

    failed = 0

    def ok(msg: str) -> None:
        print("OK:", msg)

    def fail(msg: str) -> None:
        nonlocal failed
        failed += 1
        print("FAIL:", msg)

    # --- whole-disk / list ---
    devices = usb_export.list_external_pendrives()
    paths = [d.get("path") for d in devices]
    if "/dev/sdb" in paths or any(str(p).startswith("/dev/sd") for p in paths):
        ok("list_external_pendrives sees external stick: {}".format(paths))
    elif not paths:
        # Stick may be unplugged during CI — still assert internal excluded
        ok("no external stick present (empty list)")
    else:
        ok("external devices: {}".format(paths))

    # Internal must never appear
    for d in devices:
        if d.get("fs_uuid") == "752a2820-c257-43cd-a2eb-fb52adca9fc2":
            fail("internal USB listed as export target")
        if d.get("path") in ("/dev/sda1", "/dev/sda"):
            fail("internal disk path listed: {}".format(d.get("path")))

    assert usb_export._disk_parent_device("/dev/sdb") == "/dev/sdb"
    assert usb_export._disk_parent_device("/dev/sdb1") == "/dev/sdb"
    ok("power-off parent for disk/part")

    # Fixture: whole-disk vfat with no children must be listed
    fake_flat = [
        {"path": "/dev/sda", "name": "sda", "type": "disk", "fstype": "", "uuid": "", "pkname": "", "size": 0, "mountpoint": "", "rm": False, "label": ""},
        {"path": "/dev/sda1", "name": "sda1", "type": "part", "fstype": "ext4", "uuid": "752a2820-c257-43cd-a2eb-fb52adca9fc2", "pkname": "sda", "size": 1, "mountpoint": "/media/usb_internal", "rm": False, "label": "usb_internal"},
        {"path": "/dev/sdb", "name": "sdb", "type": "disk", "fstype": "vfat", "uuid": "AABB-CCDD", "pkname": "", "size": 1000, "mountpoint": "", "rm": True, "label": "PENDRIVE"},
        {"path": "/dev/mmcblk0", "name": "mmcblk0", "type": "disk", "fstype": "", "uuid": "", "pkname": "", "size": 0, "mountpoint": "", "rm": False, "label": ""},
        {"path": "/dev/mmcblk0p2", "name": "mmcblk0p2", "type": "part", "fstype": "ext4", "uuid": "root", "pkname": "mmcblk0", "size": 1, "mountpoint": "/", "rm": False, "label": "rootfs"},
    ]
    orig_lsblk = usb_export._lsblk_tree
    orig_root = usb_export._root_pkname
    try:
        usb_export._lsblk_tree = lambda: fake_flat  # type: ignore
        usb_export._root_pkname = lambda: "mmcblk0"  # type: ignore
        listed = usb_export.list_external_pendrives()
        listed_paths = [d["path"] for d in listed]
        if listed_paths == ["/dev/sdb"]:
            ok("fixture whole-disk vfat listed once")
        else:
            fail("fixture list expected ['/dev/sdb'], got {}".format(listed_paths))
    finally:
        usb_export._lsblk_tree = orig_lsblk  # type: ignore
        usb_export._root_pkname = orig_root  # type: ignore

    # --- 24h schedule stage → confirm → due purge ---
    with tempfile.TemporaryDirectory() as td:
        tdir = pathlib.Path(td)
        reports_dir = tdir / "reports"
        reports_dir.mkdir()
        storage = tdir / "storage"
        storage.mkdir()
        data_service.init({"STORAGE_DIR": str(storage), "REPORTS_DIR": str(reports_dir)})

        rid = 90001
        (reports_dir / "report_{}.pdf".format(rid)).write_bytes(b"%PDF-1.4 fake")
        (storage / "reports.json").write_text(
            json.dumps([{"id": rid, "name": "smoke-export", "status": "approved"}]),
            encoding="utf-8",
        )

        export_id = "smoke-" + uuid.uuid4().hex[:8]
        data_service.stage_report_export_pending(
            export_id=export_id,
            report_ids=[rid],
            exported_by={"username": "smoke"},
            approved_by={"username": "smoke"},
        )
        state = data_service._load_report_export_schedule()
        if not (state.get("staged") or {}).get("export_id"):
            fail("stage_report_export_pending did not write staged")
        else:
            ok("staged export {}".format(export_id))

        confirmed = data_service.confirm_report_export_verified(export_id, reports_dir=reports_dir)
        if not confirmed or not confirmed.get("purge_at_ms"):
            fail("confirm_report_export_verified missing purge_at_ms")
        else:
            ok("confirmed; purge_at_ms={}".format(confirmed.get("purge_at_ms")))

        # Still present before due
        if data_service.get_report(rid) is None:
            fail("report deleted before 24h buffer")
        else:
            ok("report retained during 24h buffer")

        # Force due
        state = data_service._load_report_export_schedule()
        sched = state.get("scheduled") or {}
        sched["purge_at_ms"] = int(time.time() * 1000) - 1000
        state["scheduled"] = sched
        data_service._save_report_export_schedule(state)

        purged = data_service.run_due_report_export_purge(reports_dir=reports_dir)
        pdf_gone = not (reports_dir / "report_{}.pdf".format(rid)).exists()
        report_gone = data_service.get_report(rid) is None
        if purged and pdf_gone and report_gone:
            ok("due purge removed report files (purged={})".format(purged.get("reports_removed")))
        else:
            fail("purge did not remove files purged={} pdf_gone={} report_gone={}".format(
                purged, pdf_gone, report_gone))

        # Legacy array schedule ignored
        (storage / "report_export_schedule.json").write_text(json.dumps([{"old": True}]), encoding="utf-8")
        loaded = data_service._load_report_export_schedule()
        if loaded == {}:
            ok("legacy array schedule ignored")
        else:
            fail("legacy array not ignored: {}".format(loaded))

    if failed:
        print("SMOKE FAILED: {} check(s)".format(failed))
        return 1
    print("ALL USB/export smoke checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
