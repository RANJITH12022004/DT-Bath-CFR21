#!/bin/bash
# RTC / hwclock diagnostics for Tap Density kiosk (run anytime; logs to stdout or file).
set +e
OUT="${1:-/tmp/kiosk-rtc-diag.log}"
{
  echo "======== $(date -Is) ========"
  echo "--- id / hostname ---"
  id
  hostname
  echo "--- /dev/rtc* ---"
  ls -la /dev/rtc /dev/rtc0 2>&1
  echo "--- timedatectl ---"
  timedatectl status 2>&1
  echo "--- rtc0 sysfs name ---"
  cat /sys/class/rtc/rtc0/name 2>&1
  echo "--- hwclock -r (root) ---"
  sudo hwclock -f /dev/rtc0 -r 2>&1
  echo "--- hwclock as rle (no sudo) ---"
  sudo -u rle hwclock -f /dev/rtc0 -r 2>&1
  echo "--- hwclock sudo -n as rle ---"
  sudo -u rle sudo -n hwclock -f /dev/rtc0 -r 2>&1
  echo "--- i2c read 0x68 (system python3-smbus) ---"
  /usr/bin/python3 - <<'PY' 2>&1
try:
    import smbus
    b = smbus.SMBus(1)
    try:
        b.read_byte_data(0x68, 0)
        print("read_byte 0x68: OK")
    except OSError as e:
        print("read_byte 0x68:", e)
    finally:
        b.close()
except Exception as e:
    print("smbus:", e)
PY
  echo "--- rtc_service.get_rtc_date (venv) ---"
  if [ -x /opt/kiosk/venv/bin/python3 ]; then
    /opt/kiosk/venv/bin/python3 -c "import rtc_service; rtc_service.init(None); print(rtc_service.get_rtc_date())" 2>&1
  fi
  echo "======== end ========"
} | tee -a "$OUT"
echo "Appended: $OUT (do not also redirect shell output to the same file)"
