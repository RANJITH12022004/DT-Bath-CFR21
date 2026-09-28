#!/usr/bin/env bash
# Ensure internal pendrive is mounted at /media/usb_internal and project dirs exist.
# Mounts the block device directly. Do NOT "systemctl start media-usb_internal.mount":
# that unit waits on fstab's by-uuid device (10s timeout) and is what left the
# kiosk on an empty desktop for ~25s every boot.
set -uo pipefail

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"
INTERNAL_USB_PARTITION="${INTERNAL_USB_PARTITION:-/dev/sda1}"
INTERNAL_USB_UUID="${INTERNAL_USB_UUID:-${INTERNAL_USB_UUIDS:-}}"
INTERNAL_USB_UUID="${INTERNAL_USB_UUID%%,*}"
INTERNAL_USB_UUID="${INTERNAL_USB_UUID%% *}"
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
  local owner="${KIOSK_USER:-rle}"
  mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true
  _run_root mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true
  # Flask runs as rle; root-owned db/storage dirs make sqlite fail with
  # "unable to open database file" and the API crash-loops.
  _run_root chown -R "$owner:$owner" "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true
  _run_root chmod u+rwx "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true
}

_resolve_src() {
  local uuid="${INTERNAL_USB_UUID:-}" src=""
  if [[ -n "$uuid" && -b "/dev/disk/by-uuid/$uuid" ]]; then
    printf '%s' "/dev/disk/by-uuid/$uuid"
    return 0
  fi
  if [[ -n "$uuid" ]] && command -v blkid >/dev/null 2>&1; then
    src="$(blkid -U "$uuid" 2>/dev/null || true)"
    if [[ -n "$src" && -b "$src" ]]; then
      printf '%s' "$src"
      return 0
    fi
  fi
  if [[ -b "$INTERNAL_USB_PARTITION" ]]; then
    printf '%s' "$INTERNAL_USB_PARTITION"
    return 0
  fi
  if [[ -b /dev/sda1 ]]; then
    printf '%s' /dev/sda1
    return 0
  fi
  return 1
}

# VFAT's kernel default is errors=remount-ro. After a power cut the dirty bit
# is set; the next FAT error then flips the whole stick read-only and login
# / reports writes fail. errors=continue keeps it writable. fsck.vfat -a
# (once per boot, volume unmounted) clears the dirty bit without wiping files.
_VFAT_OPTS="rw,uid=1000,gid=1000,fmask=0133,dmask=0022,flush,errors=continue"
_FSCK_STAMP="/run/kiosk-internal-usb-fsck.done"

_fstype_of() {
  blkid -o value -s TYPE "$1" 2>/dev/null || true
}

_mount_opts_ok() {
  local src fst
  src="$(_resolve_src)" || return 0
  fst="$(_fstype_of "$src")"
  case "$fst" in
    vfat|fat|fat32)
      findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null | grep -q 'errors=continue'
      ;;
    *)
      return 0
      ;;
  esac
}

_umount_for_fsck() {
  _run_root sync 2>/dev/null || true
  _run_root umount "$INTERNAL_USB_PATH" 2>/dev/null || \
    _run_root umount -l "$INTERNAL_USB_PATH" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8; do
    mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}

_fsck_vfat_unmounted() {
  local src="$1" rc=0
  [[ -b "$src" ]] || return 1
  mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null && return 1
  echo "kiosk_mount_internal_usb: fsck.vfat -a $src" >&2
  _run_root fsck.vfat -a "$src"
  rc=$?
  # dosfsck: 0 clean, 1 errors corrected
  [[ $rc -eq 0 || $rc -eq 1 ]]
}

_direct_mount() {
  local src fst
  src="$(_resolve_src)" || return 1
  mkdir -p "$INTERNAL_USB_PATH" 2>/dev/null || true
  fst="$(_fstype_of "$src")"
  case "$fst" in
    vfat|fat|fat32)
      _run_root mount -t vfat -o "$_VFAT_OPTS" "$src" "$INTERNAL_USB_PATH"
      ;;
    *)
      _run_root mount "$src" "$INTERNAL_USB_PATH" || \
        _run_root mount -t "${fst:-ext4}" -o rw "$src" "$INTERNAL_USB_PATH"
      ;;
  esac
}

# Once per boot, unmount + repair a VFAT stick so a dirty power-off cannot
# leave it read-only. Skipped on later service restarts after a successful fsck.
_ensure_vfat_clean() {
  local src fst
  src="$(_resolve_src)" || return 1
  fst="$(_fstype_of "$src")"
  case "$fst" in
    vfat|fat|fat32) ;;
    *) return 0 ;;
  esac
  if [[ -f "$_FSCK_STAMP" ]] && mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null \
      && _writable && _mount_opts_ok; then
    return 0
  fi
  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    echo "kiosk_mount_internal_usb: unmounting $src for fsck" >&2
    _umount_for_fsck || {
      echo "kiosk_mount_internal_usb: WARN could not unmount; skipping fsck" >&2
      return 1
    }
  fi
  _fsck_vfat_unmounted "$src" || echo "kiosk_mount_internal_usb: WARN fsck.vfat failed" >&2
  _direct_mount || return 1
  if _writable && _mount_opts_ok; then
    _run_root touch "$_FSCK_STAMP" 2>/dev/null || touch "$_FSCK_STAMP" 2>/dev/null || true
  fi
}

_repair() {
  if [[ -x "$REPAIR_SCRIPT" ]]; then
    bash "$REPAIR_SCRIPT" || true
  fi
}

# Always settle VFAT once per boot (dirty bit from power loss) before the
# "already writable" short-circuit. A tiny write can succeed on a dirty
# volume and the kernel will remount-ro only on the next metadata error.
_ensure_vfat_clean || true

if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null && _writable && _mount_opts_ok; then
  _ensure_dirs
  exit 0
fi

if ! mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
  echo "kiosk_mount_internal_usb: not mounted — mounting directly" >&2
  _direct_mount || true
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
