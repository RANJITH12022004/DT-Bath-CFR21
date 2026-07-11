#!/usr/bin/env bash
# Before kiosk starts: DS1307 is the clock source (not NTP). /dev/rtc is a symlink to rtc0.
set -euo pipefail
RTC_DEV="/dev/rtc0"
if [[ ! -e "$RTC_DEV" ]]; then
  exit 0
fi
sudo timedatectl set-ntp false 2>/dev/null || true
sudo hwclock -f "$RTC_DEV" --hctosys 2>/dev/null || true
