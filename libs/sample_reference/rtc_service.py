#!/usr/bin/env python3
"""
rtc_service.py - RTC (Real-Time Clock) service for DS1307 via I2C.
Uses direct I2C (smbus) to read/write DS1307; no hwclock. Requires dtoverlay=i2c-rtc,ds1307
and I2C enabled. User must be in group 'i2c' for access without root.
"""

from datetime import datetime
from typing import Dict, Any, Optional, Tuple

_logger = None
_smbus = None  # smbus2 or smbus module
DS1307_ADDR = 0x68
I2C_BUS = 1


def _get_smbus():
    """Import smbus2 or smbus (RPi). Returns module or None."""
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
    """Convert one BCD byte to integer."""
    return (b & 0x0f) + ((b >> 4) & 0x0f) * 10


def _int_to_bcd(n: int) -> int:
    """Convert integer 0-99 to BCD byte."""
    n = max(0, min(99, n))
    return (n % 10) | ((n // 10) << 4)


def init(logger=None):
    """Initialize RTC service."""
    global _logger
    _logger = logger


def _read_ds1307_i2c() -> Optional[datetime]:
    """Read date/time from DS1307 via I2C. Returns datetime or None."""
    bus_module = _get_smbus()
    if not bus_module:
        return None
    try:
        bus = bus_module.SMBus(I2C_BUS)
        try:
            # DS1307 registers 0-6: seconds, minutes, hours, day, date, month, year (BCD)
            data = bus.read_i2c_block_data(DS1307_ADDR, 0x00, 7)
        finally:
            bus.close()
        sec = _bcd_to_int(data[0] & 0x7f)  # bit 7 = CH
        minute = _bcd_to_int(data[1])
        hour = _bcd_to_int(data[2] & 0x3f)  # bit 6 = 12/24
        day_of_week = _bcd_to_int(data[3])
        date = _bcd_to_int(data[4])
        month = _bcd_to_int(data[5])
        year = _bcd_to_int(data[6]) + 2000  # DS1307 is 00-99, assume 20xx
        return datetime(year, month, date, hour, minute, sec)
    except Exception as e:
        if _logger:
            _logger.debug("RTC I2C read failed: %s", e)
        return None


def _write_ds1307_i2c(dt: datetime) -> bool:
    """Write date/time to DS1307 via I2C. Returns True on success."""
    if _logger:
        _logger.info("RTC write: %s", dt.strftime("%Y-%m-%d %H:%M:%S"))
    bus_module = _get_smbus()
    if not bus_module:
        return False
    try:
        bus = bus_module.SMBus(I2C_BUS)
        try:
            # Registers 0-6: seconds, minutes, hours, day of week, date, month, year (BCD)
            sec_bcd = _int_to_bcd(dt.second) & 0x7f  # clear CH so clock runs
            bus.write_byte_data(DS1307_ADDR, 0x00, sec_bcd)
            bus.write_byte_data(DS1307_ADDR, 0x01, _int_to_bcd(dt.minute))
            bus.write_byte_data(DS1307_ADDR, 0x02, _int_to_bcd(dt.hour))  # 24h
            bus.write_byte_data(DS1307_ADDR, 0x03, _int_to_bcd(dt.isoweekday() or 7))  # 1-7
            bus.write_byte_data(DS1307_ADDR, 0x04, _int_to_bcd(dt.day))
            bus.write_byte_data(DS1307_ADDR, 0x05, _int_to_bcd(dt.month))
            bus.write_byte_data(DS1307_ADDR, 0x06, _int_to_bcd(dt.year % 100))
        finally:
            bus.close()
        return True
    except Exception as e:
        if _logger:
            _logger.warning("RTC I2C write failed: %s", e, exc_info=True)
        return False


def get_rtc_date() -> Dict[str, Any]:
    """
    Read current date/time from RTC via I2C (DS1307). No hwclock.
    Returns:
        Dict with 'success', 'datetime' (ISO string), 'error' if failed
    """
    dt = _read_ds1307_i2c()
    if dt is not None:
        return {
            "success": True,
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "error": None
        }
    return {
        "success": False,
        "error": "RTC read failed. Check I2C (enable in raspi-config, add user to group i2c).",
        "datetime": None
    }


def set_rtc_date(dt: Optional[datetime] = None) -> Dict[str, Any]:
    """
    Set RTC date/time via I2C (DS1307). Only performs I2C write; no system date command.
    Requires dt to be provided.
    """
    if dt is None:
        return {"success": False, "error": "datetime required"}
    if _write_ds1307_i2c(dt):
        return {"success": True, "error": None}
    return {
        "success": False,
        "error": "RTC write failed. Add user to group i2c: sudo usermod -aG i2c rle"
    }
