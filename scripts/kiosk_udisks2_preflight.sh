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

if ! systemctl is-enabled udisks2.service >/dev/null 2>&1; then
  log "enabling udisks2.service"
  _run_root systemctl enable udisks2.service 2>/dev/null || true
fi

if ! systemctl is-active --quiet udisks2.service; then
  log "starting udisks2.service"
  _run_root systemctl start udisks2.service 2>/dev/null || true
  # Socket activation / settle
  for _i in 1 2 3 4 5 6 7 8; do
    if systemctl is-active --quiet udisks2.service; then
      break
    fi
    sleep 0.25
  done
fi

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
