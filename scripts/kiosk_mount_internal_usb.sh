#!/usr/bin/env bash
# Ensure internal pendrive is mounted at /media/usb_internal and project dirs exist.
# Delegates dirty/RO recovery to kiosk_repair_internal_usb.sh.
set -uo pipefail

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"
REPAIR_SCRIPT="${REPAIR_SCRIPT:-/opt/kiosk/scripts/kiosk_repair_internal_usb.sh}"

_run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@" 2>/dev/null || return 1
  fi
}

_writable() {
  touch "$INTERNAL_USB_PATH/.kiosk_write_test" 2>/dev/null || return 1
  rm -f "$INTERNAL_USB_PATH/.kiosk_write_test" 2>/dev/null || true
  return 0
}

_ensure_dirs() {
  mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true
}

_repair() {
  if [[ -x "$REPAIR_SCRIPT" ]]; then
    bash "$REPAIR_SCRIPT" || true
  fi
}

if ! mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
  echo "kiosk_mount_internal_usb: not mounted — mounting/repairing" >&2
  _run_root systemctl start media-usb_internal.mount 2>/dev/null || true
  _run_root mount "$INTERNAL_USB_PATH" 2>/dev/null || true
  for _i in 1 2 3 4 5 6 7 8; do
    if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
      break
    fi
    sleep 0.4
  done
fi

if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
  if ! _writable; then
    echo "kiosk_mount_internal_usb: read-only — running repair" >&2
    _repair
  fi
else
  echo "kiosk_mount_internal_usb: still not mounted — running repair" >&2
  _repair
fi

if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null && _writable; then
  _ensure_dirs
  exit 0
fi

echo "kiosk_mount_internal_usb: WARN $INTERNAL_USB_PATH not writable — API may use degraded mode" >&2
_ensure_dirs
exit 0
