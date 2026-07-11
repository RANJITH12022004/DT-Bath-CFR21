#!/bin/bash
# One-time copy of PDFs, audit DB, and JSON storage from /opt/kiosk to internal USB (sda1).
set -euo pipefail

INTERNAL="${INTERNAL_USB_PATH:-/media/usb_internal}"
APP_ROOT="${APP_ROOT:-/opt/kiosk}"

if [ ! -d "$INTERNAL" ]; then
  echo "Internal USB not mounted at $INTERNAL (is sda1 in fstab?)" >&2
  exit 1
fi

mkdir -p "$INTERNAL/storage" "$INTERNAL/reports" "$INTERNAL/db"

copy_if_newer() {
  local src="$1" dest="$2"
  if [ ! -e "$src" ]; then
    return 0
  fi
  if [ ! -e "$dest" ] || [ "$src" -nt "$dest" ]; then
    cp -a "$src" "$dest"
    echo "  copied $(basename "$src")"
  fi
}

echo "Migrating from $APP_ROOT to $INTERNAL ..."

if [ -f "$APP_ROOT/db/audit_log.db" ]; then
  dest_db="$INTERNAL/db/audit_log.db"
  if [ ! -f "$dest_db" ] || [ "$(stat -c%s "$APP_ROOT/db/audit_log.db")" -gt "$(stat -c%s "$dest_db" 2>/dev/null || echo 0)" ]; then
    cp -a "$APP_ROOT/db/audit_log.db" "$dest_db"
    echo "  copied audit_log.db ($(stat -c%s "$dest_db") bytes)"
  fi
fi

for f in "$APP_ROOT/reports/"*; do
  [ -e "$f" ] || continue
  copy_if_newer "$f" "$INTERNAL/reports/$(basename "$f")"
done

for f in "$APP_ROOT/storage/"*.json; do
  [ -e "$f" ] || continue
  copy_if_newer "$f" "$INTERNAL/storage/$(basename "$f")"
done

echo "Done. Restart kiosk-bridge: sudo systemctl restart kiosk-bridge.service"
