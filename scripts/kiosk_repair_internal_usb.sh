#!/usr/bin/env bash
# Repair / remount internal kiosk storage after dirty power-off or remount-ro.
# Supports ext4 (this DT unit) and VFAT (Hardness-style sticks).
set -uo pipefail

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"
INTERNAL_USB_PARTITION="${INTERNAL_USB_PARTITION:-/dev/sda1}"
INTERNAL_USB_UUID="${INTERNAL_USB_UUID:-${INTERNAL_USB_UUIDS:-752a2820-c257-43cd-a2eb-fb52adca9fc2}}"
INTERNAL_USB_UUID="${INTERNAL_USB_UUID%%,*}"
INTERNAL_USB_UUID="${INTERNAL_USB_UUID%% *}"
LOG_TAG="kiosk_repair_internal_usb"

log() { echo "$LOG_TAG: $*" >&2; }

_run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

_resolve_partition() {
  local part="" uuid_dev=""
  if [[ -n "$INTERNAL_USB_UUID" ]] && command -v blkid >/dev/null 2>&1; then
    uuid_dev="$(blkid -U "$INTERNAL_USB_UUID" 2>/dev/null || true)"
    if [[ -n "$uuid_dev" && -b "$uuid_dev" ]]; then
      part="$uuid_dev"
    fi
  fi
  if [[ -z "$part" ]] && command -v blkid >/dev/null 2>&1; then
    part="$(blkid -L usb_internal 2>/dev/null || true)"
  fi
  if [[ -z "$part" && -b "$INTERNAL_USB_PARTITION" ]]; then
    part="$INTERNAL_USB_PARTITION"
  fi
  if [[ -z "$part" && -b /dev/sda1 ]]; then
    part=/dev/sda1
  fi
  printf '%s' "$part"
}

_fstype_of() {
  local part="$1"
  blkid -o value -s TYPE "$part" 2>/dev/null || true
}

_writable() {
  local base="${1:-$INTERNAL_USB_PATH}"
  touch "$base/.kiosk_write_test" 2>/dev/null || return 1
  rm -f "$base/.kiosk_write_test" 2>/dev/null || true
  return 0
}

_clean_orphan_tmps() {
  local d
  for d in "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"; do
    [[ -d "$d" ]] || continue
    find "$d" -maxdepth 1 -type f -name '*.tmp' -delete 2>/dev/null || true
  done
}

_ensure_dirs() {
  mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true
}

_umount_usb() {
  _run_root sync 2>/dev/null || true
  _run_root systemctl stop media-usb_internal.mount 2>/dev/null || true
  _run_root umount -f "$INTERNAL_USB_PATH" 2>/dev/null || true
  _run_root umount -l "$INTERNAL_USB_PATH" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5; do
    mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null || return 0
    sleep 0.3
  done
  return 1
}

_mount_usb() {
  _run_root systemctl start media-usb_internal.mount 2>/dev/null && return 0
  _run_root mount "$INTERNAL_USB_PATH" 2>/dev/null && return 0
  local part fst
  part="$(_resolve_partition)"
  [[ -n "$part" ]] || return 1
  fst="$(_fstype_of "$part")"
  case "$fst" in
    vfat|fat|fat32)
      _run_root mount -t vfat -o "rw,uid=1000,gid=1000,fmask=0133,dmask=0022,errors=remount-ro,flush" \
        "$part" "$INTERNAL_USB_PATH" 2>/dev/null && return 0
      ;;
    ext2|ext3|ext4|*)
      _run_root mount -t "${fst:-ext4}" -o "rw,errors=remount-ro" \
        "$part" "$INTERNAL_USB_PATH" 2>/dev/null && return 0
      _run_root mount "$part" "$INTERNAL_USB_PATH" 2>/dev/null && return 0
      ;;
  esac
  return 1
}

_fsck_partition() {
  local part="$1" fst rc=0
  [[ -n "$part" && -b "$part" ]] || return 1
  fst="$(_fstype_of "$part")"
  case "$fst" in
    vfat|fat|fat32)
      log "fsck.vfat -a $part"
      _run_root fsck.vfat -a "$part"
      rc=$?
      if [[ $rc -eq 0 || $rc -eq 1 ]]; then return 0; fi
      _run_root fsck.vfat -a -y "$part"
      rc=$?
      [[ $rc -eq 0 || $rc -eq 1 ]]
      ;;
    ext2|ext3|ext4|*)
      log "fsck.ext4 -p $part"
      _run_root fsck.ext4 -p "$part"
      rc=$?
      # 0=clean, 1=errors corrected
      [[ $rc -eq 0 || $rc -eq 1 ]]
      ;;
  esac
}

repair() {
  local part
  part="$(_resolve_partition)"
  if [[ -z "$part" ]]; then
    log "WARN no USB partition found (uuid=$INTERNAL_USB_UUID)"
    return 1
  fi
  log "repair start path=$INTERNAL_USB_PATH part=$part fstype=$(_fstype_of "$part")"

  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null && _writable; then
    _ensure_dirs
    _clean_orphan_tmps
    log "already writable"
    return 0
  fi

  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    log "attempt remount,rw"
    _run_root mount -o remount,rw "$INTERNAL_USB_PATH" 2>/dev/null || true
    if _writable; then
      _ensure_dirs
      _clean_orphan_tmps
      log "remount,rw ok"
      return 0
    fi
  fi

  log "umount + fsck + remount"
  _umount_usb || log "WARN umount incomplete (continuing)"
  _fsck_partition "$part" || log "WARN fsck failed"
  _mount_usb || {
    log "ERROR remount failed"
    return 1
  }

  if _writable; then
    _ensure_dirs
    _clean_orphan_tmps
    _run_root sync 2>/dev/null || true
    log "repair ok (writable)"
    return 0
  fi

  log "ERROR still read-only after repair"
  return 1
}

if [[ "${1:-}" == "sync" ]]; then
  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    sync 2>/dev/null || true
    _run_root sync 2>/dev/null || true
    if _writable; then
      touch "$INTERNAL_USB_PATH/.kiosk_clean_sync" 2>/dev/null && rm -f "$INTERNAL_USB_PATH/.kiosk_clean_sync" 2>/dev/null || true
    fi
    log "sync done"
  fi
  exit 0
fi

repair
exit $?
