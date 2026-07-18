#!/usr/bin/env python3
"""
rtc_service.py - RTC (DS1307) read/write.

On the Pi, ``/dev/rtc`` is a symlink to ``/dev/rtc0`` (one DS1307 chip). All kernel
hwclock access uses ``/dev/rtc0`` only.

When dtoverlay=i2c-rtc,ds1307 binds the chip, userspace I2C to 0x68 is EBUSY; use
hwclock(8). The hardware RTC is the source of truth: network/NTP must not override it.
"""

from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, List
import email.utils
import fcntl
import os
import re
import struct
import subprocess
import sys
import threading
import time as time_mod
import urllib.request

_logger = None
_smbus = None
DS1307_ADDR = 0x68
I2C_BUS = 1

# Single kernel RTC node (/dev/rtc -> rtc0 symlink; not a second chip).
KERNEL_RTC_DEVICE = "/dev/rtc0"
SYSFS_RTC_DIR = "/sys/class/rtc/rtc0"
# Linux ioctl RTC_SET_TIME (platform may use 0x4024700a or 0x4024700a on arm64)
_RTC_SET_TIME_IOCTLS = (0x4024700A, 0x4024700a, 0x4024700B)
_rtc_startup_done = False
_rtc_startup_lock = threading.Lock()
NETWORK_TIME_URLS = (
    "https://google.com",
    "https://example.com",
)


def init(logger=None):
    global _logger
    _logger = logger


def kernel_rtc_device_path() -> Optional[str]:
    if os.path.exists(KERNEL_RTC_DEVICE):
        return KERNEL_RTC_DEVICE
    return None


def _run_privileged(cmd: List[str], timeout_sec: int = 8) -> Tuple[bool, str]:
    """Run a command; try direct, sudo -n, then sudo."""
    for argv in (cmd, ["sudo", "-n"] + cmd, ["sudo"] + cmd):
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_sec)
            if proc.returncode == 0:
                return True, ""
            err = (proc.stderr or proc.stdout or "").strip() or ("exit %s" % proc.returncode)
        except Exception as ex:
            err = str(ex)
    return False, err


def disable_network_time_sync() -> bool:
    """Turn off NTP/systemd-timesyncd so the DS1307 is not overwritten by network time."""
    if os.name == "nt" or sys.platform == "win32":
        return True
    ok, err = _run_privileged(["timedatectl", "set-ntp", "false"], timeout_sec=10)
    if not ok and _logger:
        _logger.warning("timedatectl set-ntp false failed: %s", err)
    return ok


def _fetch_network_wall_datetime() -> Optional[datetime]:
    """Fetch trusted wall time from HTTP Date headers.

    This is a one-shot startup correction, not a continuous time source.
    It exists because the DS1307 can drift, and this kiosk currently disables NTP.
    """
    for url in NETWORK_TIME_URLS:
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=8) as resp:
                date_hdr = (resp.headers.get("Date") or "").strip()
            if not date_hdr:
                continue
            dt = email.utils.parsedate_to_datetime(date_hdr)
            if dt is None:
                continue
            if getattr(dt, "tzinfo", None) is not None:
                dt = dt.astimezone().replace(tzinfo=None)
            return dt
        except Exception:
            continue
    return None


def _read_rtc_sysfs_wall_datetime() -> Optional[datetime]:
    """Read DS1307 via kernel sysfs (works when util-linux hwclock cannot open /dev/rtc0)."""
    epoch_path = os.path.join(SYSFS_RTC_DIR, "since_epoch")
    if not os.path.exists(epoch_path):
        return None
    try:
        with open(epoch_path, encoding="utf-8") as f:
            sec = int(f.read().strip())
        return datetime.fromtimestamp(sec)
    except Exception as ex:
        if _logger:
            _logger.debug("RTC sysfs read failed: %s", ex)
        return None


def sync_system_clock_from_rtc() -> bool:
    """Load hardware RTC into the system clock."""
    dt = read_rtc_wall_datetime()
    if dt is not None:
        date_cmd_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        ok, err = _run_privileged(["timedatectl", "set-time", date_cmd_str], timeout_sec=8)
        if ok:
            return True
        ok2, err2 = _run_privileged(["date", "-s", date_cmd_str], timeout_sec=5)
        if ok2:
            return True
        if _logger:
            _logger.warning("Could not set system time from RTC read: %s / %s", err, err2)
    rtc_dev = kernel_rtc_device_path()
    if not rtc_dev:
        return False
    ok, err = _run_privileged(["hwclock", "-f", rtc_dev, "--hctosys"], timeout_sec=8)
    if not ok and _logger:
        _logger.warning("hwclock --hctosys failed (%s): %s", rtc_dev, err)
    return ok


def _parse_hwclock_line(line: str) -> Optional[datetime]:
    line = (line or "").strip()
    m = re.match(r"(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}:\d{2})", line)
    if m:
        return datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M:%S")
    m2 = re.match(r"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})", line)
    if m2:
        return datetime.strptime(m2.group(1) + " " + m2.group(2), "%Y-%m-%d %H:%M:%S")
    return None


def read_rtc_wall_datetime() -> Optional[datetime]:
    """Read local wall time from the DS1307 (sysfs first — fast; hwclock as fallback)."""
    dt = _read_rtc_sysfs_wall_datetime()
    if dt is not None:
        return dt
    rtc_dev = kernel_rtc_device_path()
    if rtc_dev:
        cmd = ["hwclock", "-f", rtc_dev, "-r"]
        for argv in (["sudo", "-n"] + cmd, cmd, ["sudo"] + cmd):
            try:
                proc = subprocess.run(argv, capture_output=True, text=True, timeout=3)
                if proc.returncode != 0 or not (proc.stdout or "").strip():
                    continue
                line = (proc.stdout or "").strip().splitlines()[0].strip()
                parsed = _parse_hwclock_line(line)
                if parsed is not None:
                    return parsed
            except Exception:
                continue
    return None


def _write_rtc_ioctl(dt_local: datetime) -> bool:
    """Set DS1307 via /dev/rtc0 ioctl when hwclock(8) cannot access the device."""
    rtc_path = KERNEL_RTC_DEVICE
    if not os.path.exists(rtc_path):
        return False
    try:
        sec = int(time_mod.mktime(dt_local.timetuple()))
        dt_utc = datetime.fromtimestamp(sec, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return False
    try:
        fd = os.open(rtc_path, os.O_RDWR)
    except OSError:
        for argv in (["sudo", "-n", "chmod", "666", rtc_path], ["sudo", "chmod", "666", rtc_path]):
            _run_privileged(argv, timeout_sec=3)
        try:
            fd = os.open(rtc_path, os.O_RDWR)
        except OSError:
            return False
    try:
        buf = struct.pack(
            "9i",
            dt_utc.second,
            dt_utc.minute,
            dt_utc.hour,
            dt_utc.day,
            dt_utc.month - 1,
            dt_utc.year - 1900,
            -1,
            -1,
            -1,
        )
        for cmd in _RTC_SET_TIME_IOCTLS:
            try:
                fcntl.ioctl(fd, cmd, buf)
                return True
            except OSError:
                continue
        return False
    finally:
        os.close(fd)


def write_rtc_from_system() -> bool:
    """Copy current system clock to the hardware RTC (hwclock, then ioctl)."""
    rtc_dev = kernel_rtc_device_path()
    if rtc_dev:
        ok, _ = _run_privileged(["hwclock", "-f", rtc_dev, "-w"], timeout_sec=8)
        if ok:
            return True
        ok2, _ = _run_privileged(["hwclock", "-f", rtc_dev, "--systohc"], timeout_sec=8)
        if ok2:
            return True
    return _write_rtc_ioctl(datetime.now())


def _write_hwclock_set(rtc_dev: str, dt: datetime) -> bool:
    """Write local wall time to the DS1307 (chip stores UTC; --localtime interprets date as local)."""
    date_arg = dt.strftime("%Y-%m-%d %H:%M:%S")
    for extra in (["--localtime"], []):
        cmd = ["hwclock", "-f", rtc_dev, "--set", "--date=" + date_arg] + extra
        ok, _ = _run_privileged(cmd, timeout_sec=8)
        if ok:
            return True
    return False


def _wall_times_match(wanted: datetime, got: Optional[datetime], slack_sec: int = 3) -> bool:
    if got is None:
        return False
    delta = abs((got - wanted).total_seconds())
    return delta <= slack_sec


def apply_user_wall_time(dt: datetime) -> Tuple[bool, str]:
    """Apply user-entered local date/time: disable NTP, set system, write DS1307, verify."""
    if dt is None:
        return False, "datetime required"
    disable_network_time_sync()
    date_cmd_str = dt.strftime("%Y-%m-%d %H:%M:%S")
    ok_td, err_td = _run_privileged(
        ["timedatectl", "set-time", date_cmd_str], timeout_sec=8
    )
    if not ok_td:
        ok_date, err_date = _run_privileged(["date", "-s", date_cmd_str], timeout_sec=5)
        if not ok_date:
            return False, "timedatectl failed: {}; date failed: {}".format(err_td, err_date)
    disable_network_time_sync()
    rtc_written = write_rtc_from_system()
    if not rtc_written:
        rtc_written = _write_rtc_ioctl(dt)
    if not rtc_written:
        rtc_dev = kernel_rtc_device_path()
        rtc_written = bool(rtc_dev and _write_hwclock_set(rtc_dev, dt))
    if not rtc_written and _logger:
        _logger.warning(
            "hwclock/ioctl could not write DS1307; system time was set to %s",
            date_cmd_str,
        )
    read_back = read_rtc_wall_datetime()
    if read_back and not _wall_times_match(dt, read_back, slack_sec=8):
        if _logger:
            _logger.warning(
                "RTC readback mismatch: wanted %s, got %s",
                dt.strftime("%Y-%m-%d %H:%M:%S"),
                read_back.strftime("%Y-%m-%d %H:%M:%S"),
            )
    elif not _wall_times_match(dt, datetime.now(), slack_sec=3):
        return False, "Could not set or verify device time"
    return True, ""


def get_device_wall_datetime_payload() -> Dict[str, Any]:
    """Payload for /api/get_datetime — hardware RTC when available, else system clock."""
    dt = read_rtc_wall_datetime()
    source = "rtc" if dt is not None else "system-fallback"
    if dt is None:
        dt = datetime.now()
    return {
        "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "date": dt.strftime("%d-%m-%Y"),
        "time": dt.strftime("%H:%M:%S"),
        "source": source,
    }


def ensure_rtc_is_clock_authority() -> None:
    """On app/service start: prefer real network wall time, else fall back to DS1307.

    Exact root cause fixed here:
    - the service disabled NTP
    - then always loaded Linux time from the DS1307
    - if the DS1307 drifted behind real time, both system time and all Date.now()-based
      UI timers inherited that stale wall clock.
    """
    if os.name == "nt" or sys.platform == "win32":
        return
    try:
        disable_network_time_sync()
        net_dt = _fetch_network_wall_datetime()
        rtc_dt = read_rtc_wall_datetime()
        if net_dt is not None:
            # If RTC is absent or meaningfully behind/ahead, correct system time from network
            # and persist that correction back into the RTC.
            rtc_delta_ok = _wall_times_match(net_dt, rtc_dt, slack_sec=30)
            if not rtc_delta_ok:
                ok, err = apply_user_wall_time(net_dt)
                if ok:
                    if _logger:
                        _logger.info("System clock loaded from network time and persisted to RTC")
                    return
                if _logger:
                    _logger.warning("Could not set system time from network time: %s", err)
        if kernel_rtc_device_path() or os.path.exists(SYSFS_RTC_DIR):
            if sync_system_clock_from_rtc():
                if _logger:
                    _logger.info("System clock loaded from hardware RTC")
            elif _logger:
                _logger.warning("Could not load system time from hardware RTC")
    except Exception as ex:
        if _logger:
            _logger.warning("RTC startup sync skipped: %s", ex)


def schedule_rtc_startup_sync() -> None:
    """Run RTC bootstrap in a background thread so Flask can bind port 5000 immediately."""
    global _rtc_startup_done

    def _worker():
        global _rtc_startup_done
        try:
            ensure_rtc_is_clock_authority()
        finally:
            with _rtc_startup_lock:
                _rtc_startup_done = True

    with _rtc_startup_lock:
        if _rtc_startup_done:
            return
    threading.Thread(target=_worker, name="rtc-startup-sync", daemon=True).start()


# --- legacy I2C path (only when no kernel rtc node) ---

def _get_smbus():
    global _smbus
    if _smbus is not None:
        return _smbus
    try:
        import smbus2 as bus
        _smbus = bus
        return _smbus
    except ImportError:
        pass
    try:
        import smbus as bus
        _smbus = bus
        return _smbus
    except ImportError:
        pass
    return None


def _bcd_to_int(b: int) -> int:
    return (b & 0x0f) + ((b >> 4) & 0x0f) * 10


def _int_to_bcd(n: int) -> int:
    n = max(0, min(99, n))
    return (n % 10) | ((n // 10) << 4)


def _read_ds1307_i2c() -> Optional[datetime]:
    bus_module = _get_smbus()
    if not bus_module:
        return None
    try:
        bus = bus_module.SMBus(I2C_BUS)
        try:
            data = bus.read_i2c_block_data(DS1307_ADDR, 0x00, 7)
        finally:
            bus.close()
        sec = _bcd_to_int(data[0] & 0x7f)
        minute = _bcd_to_int(data[1])
        hour = _bcd_to_int(data[2] & 0x3f)
        date = _bcd_to_int(data[4])
        month = _bcd_to_int(data[5])
        year = _bcd_to_int(data[6]) + 2000
        return datetime(year, month, date, hour, minute, sec)
    except Exception as e:
        if _logger:
            _logger.debug("RTC I2C read failed: %s", e)
        return None


def _write_ds1307_i2c(dt: datetime) -> bool:
    bus_module = _get_smbus()
    if not bus_module:
        return False
    try:
        bus = bus_module.SMBus(I2C_BUS)
        try:
            bus.write_byte_data(DS1307_ADDR, 0x00, _int_to_bcd(dt.second) & 0x7f)
            bus.write_byte_data(DS1307_ADDR, 0x01, _int_to_bcd(dt.minute))
            bus.write_byte_data(DS1307_ADDR, 0x02, _int_to_bcd(dt.hour))
            bus.write_byte_data(DS1307_ADDR, 0x03, _int_to_bcd(dt.isoweekday() or 7))
            bus.write_byte_data(DS1307_ADDR, 0x04, _int_to_bcd(dt.day))
            bus.write_byte_data(DS1307_ADDR, 0x05, _int_to_bcd(dt.month))
            bus.write_byte_data(DS1307_ADDR, 0x06, _int_to_bcd(dt.year % 100))
        finally:
            bus.close()
        return True
    except Exception as e:
        if _logger:
            _logger.warning("RTC I2C write failed: %s", e)
        return False


def get_rtc_date() -> Dict[str, Any]:
    """Read RTC for /api/rtc/date — prefer hwclock on /dev/rtc0."""
    dt = read_rtc_wall_datetime()
    if dt is not None:
        return {
            "success": True,
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "error": None,
            "source": "hwclock",
            "device": KERNEL_RTC_DEVICE,
        }
    dt = _read_ds1307_i2c()
    if dt is not None:
        return {
            "success": True,
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "error": None,
            "source": "i2c",
        }
    now = datetime.now()
    return {
        "success": True,
        "datetime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "error": None,
        "fallback": "system",
    }


def set_rtc_date(dt: Optional[datetime] = None) -> Dict[str, Any]:
    if dt is None:
        return {"success": False, "error": "datetime required"}
    ok, err = apply_user_wall_time(dt)
    if ok:
        return {"success": True, "error": None, "method": "rtc-authority"}
    return {"success": False, "error": err or "RTC write failed"}
