#!/usr/bin/env bash
# Auto-detect and mount the internal kiosk pendrive at /media/usb_internal,
# then ensure storage/reports/db folders exist.
#
# Usage:
#   sudo /opt/kiosk/scripts/mount_internal_usb.sh
#   sudo /opt/kiosk/scripts/mount_internal_usb.sh --fstab   # also refresh /etc/fstab
#
# Detection order:
#   1) LABEL=usb_internal
#   2) UUID from existing /etc/fstab entry for /media/usb_internal
#   3) First USB disk partition: /dev/sdX1 (prefers sda1)
set -euo pipefail

INTERNAL="${INTERNAL_USB_PATH:-/media/usb_internal}"
OWNER="${KIOSK_USB_OWNER:-rle:rle}"
UPDATE_FSTAB=0

for arg in "$@"; do
  case "$arg" in
    --fstab|-f) UPDATE_FSTAB=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --fstab)" >&2
      exit 2
      ;;
  esac
done

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root: sudo $0 $*" >&2
    exit 1
  fi
}

fstab_uuid() {
  awk '
    $1 !~ /^#/ && $2 == "/media/usb_internal" {
      if (match($1, /^UUID=/)) { print substr($1, 6); exit }
    }
  ' /etc/fstab 2>/dev/null || true
}

resolve_device() {
  local dev="" uuid=""

  # Prefer labeled kiosk stick
  if [[ -e /dev/disk/by-label/usb_internal ]]; then
    readlink -f /dev/disk/by-label/usb_internal
    return 0
  fi

  uuid="$(fstab_uuid)"
  if [[ -n "$uuid" && -e "/dev/disk/by-uuid/$uuid" ]]; then
    readlink -f "/dev/disk/by-uuid/$uuid"
    return 0
  fi

  # Prefer sda1 when present, else first sd*1 USB-style partition
  if [[ -b /dev/sda1 ]]; then
    echo /dev/sda1
    return 0
  fi

  for p in /dev/sd[a-z]1; do
    [[ -b "$p" ]] || continue
    echo "$p"
    return 0
  done

  return 1
}

ensure_dirs() {
  mkdir -p "$INTERNAL/storage" "$INTERNAL/reports" "$INTERNAL/db"
  if id -u "${OWNER%%:*}" >/dev/null 2>&1; then
    chown -R "$OWNER" "$INTERNAL/storage" "$INTERNAL/reports" "$INTERNAL/db" || true
    # Keep mount root writable by kiosk user when possible
    chown "$OWNER" "$INTERNAL" 2>/dev/null || true
  fi
  chmod 755 "$INTERNAL" "$INTERNAL/storage" "$INTERNAL/reports" "$INTERNAL/db" || true
}

update_fstab_entry() {
  local uuid="$1" fstype="$2" line tmp
  [[ -n "$uuid" ]] || return 0
  line="UUID=${uuid}  ${INTERNAL}  ${fstype}  defaults,nofail  0  2"
  tmp="$(mktemp)"
  if grep -qE '[[:space:]]/media/usb_internal[[:space:]]' /etc/fstab; then
    awk -v line="$line" '
      $1 ~ /^#/ || $2 != "/media/usb_internal" { print; next }
      !done { print line; done=1 }
      END { if (!done) print line }
    ' /etc/fstab >"$tmp"
  else
    cat /etc/fstab >"$tmp"
    printf '%s\n' "$line" >>"$tmp"
  fi
  cp -a /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
  cat "$tmp" >/etc/fstab
  rm -f "$tmp"
  systemctl daemon-reload 2>/dev/null || true
  echo "Updated /etc/fstab -> UUID=$uuid"
}

need_root "$@"

mkdir -p "$INTERNAL"

if mountpoint -q "$INTERNAL"; then
  src="$(findmnt -n -o SOURCE --target "$INTERNAL" 2>/dev/null || true)"
  echo "Already mounted: $INTERNAL <- ${src:-unknown}"
  ensure_dirs
  df -h "$INTERNAL" | tail -1
  exit 0
fi

# Wait briefly for USB enumeration after boot/hotplug
deadline=$((SECONDS + 20))
DEV=""
while (( SECONDS < deadline )); do
  if DEV="$(resolve_device)"; then
    break
  fi
  DEV=""
  sleep 1
done

if [[ -z "${DEV}" ]]; then
  echo "No internal pendrive partition found (looked for label usb_internal, fstab UUID, /dev/sdX1)." >&2
  exit 1
fi

FSTYPE="$(blkid -s TYPE -o value "$DEV" 2>/dev/null || true)"
UUID="$(blkid -s UUID -o value "$DEV" 2>/dev/null || true)"
LABEL="$(blkid -s LABEL -o value "$DEV" 2>/dev/null || true)"

if [[ -z "$FSTYPE" ]]; then
  echo "Cannot detect filesystem on $DEV" >&2
  exit 1
fi

echo "Mounting $DEV (type=$FSTYPE label=${LABEL:--} uuid=${UUID:--}) -> $INTERNAL"
mount -t "$FSTYPE" "$DEV" "$INTERNAL"
ensure_dirs

if [[ "$UPDATE_FSTAB" -eq 1 && -n "$UUID" ]]; then
  update_fstab_entry "$UUID" "$FSTYPE"
fi

echo "OK: $(findmnt -n -o TARGET,SOURCE,FSTYPE --target "$INTERNAL")"
echo "Folders: $INTERNAL/{storage,reports,db}"
df -h "$INTERNAL" | tail -1
ls -la "$INTERNAL"
