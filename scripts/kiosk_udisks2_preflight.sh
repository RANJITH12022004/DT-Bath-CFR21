#!/usr/bin/env bash
# Ensure udisks2 is available so export can auto-mount external pendrives via udisksctl.
set -uo pipefail

LOG_TAG="kiosk_udisks2_preflight"
log() { echo "$LOG_TAG: $*" >&2; }

_run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@" 2>/dev/null || return 1
  fi
}

if ! command -v udisksctl >/dev/null 2>&1; then
  log "WARN udisksctl not found — USB export mount will fail"
  exit 0
fi

# Do not systemctl enable/start from kiosk-bridge ExecStartPre — nested
# systemctl jobs deadlock or delay boot. Wants=udisks2.service pulls it in.

if systemctl is-active --quiet udisks2.service; then
  log "udisks2 active"
else
  log "WARN udisks2 still inactive — export mount may fail until it starts"
fi

# Soft check: current user should be in plugdev when running as rle
if id -nG 2>/dev/null | grep -qw plugdev; then
  :
elif [[ "$(id -un 2>/dev/null || true)" == "rle" ]]; then
  log "WARN user not in plugdev — udisksctl mount may be denied"
fi

exit 0
