#!/usr/bin/env bash
# Wait for internal USB (factory/recipe/report storage) before kiosk API starts.
set -euo pipefail

INTERNAL="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE="${STORAGE_DIR:-$INTERNAL/storage}"
WAIT_SEC="${KIOSK_USB_WAIT_SEC:-90}"

deadline=$((SECONDS + WAIT_SEC))
while (( SECONDS < deadline )); do
  if [[ -d "$INTERNAL" && -d "$STORAGE" ]]; then
    exit 0
  fi
  sleep 1
done

echo "kiosk_wait_internal_usb: timed out after ${WAIT_SEC}s waiting for $STORAGE" >&2
exit 1
