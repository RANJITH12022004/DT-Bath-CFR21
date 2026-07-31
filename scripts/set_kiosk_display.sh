#!/usr/bin/env bash
# Force WaveShare WS170120 (7" HDMI) to its native 1024x600 on the real panel output.
# Empty/broken EDID otherwise leaves the Pi at 1024x768 and/or enables a phantom
# HDMI-A-1 head — both break intermittent touch (labwc maps touch to one output).
set -euo pipefail

OUTPUT="${KIOSK_HDMI_OUTPUT:-HDMI-A-2}"
MODE="${KIOSK_DISPLAY_MODE:-1024x600@60Hz}"
WAIT_SEC="${KIOSK_DISPLAY_WAIT_SEC:-15}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
  if [[ -S "${XDG_RUNTIME_DIR}/wayland-0" ]]; then
    export WAYLAND_DISPLAY=wayland-0
  elif [[ -S "${XDG_RUNTIME_DIR}/wayland-1" ]]; then
    export WAYLAND_DISPLAY=wayland-1
  fi
fi

if ! command -v wlr-randr >/dev/null 2>&1; then
  echo "set_kiosk_display: wlr-randr not found" >&2
  exit 1
fi

deadline=$((SECONDS + WAIT_SEC))
ok=0
while (( SECONDS < deadline )); do
  if wlr-randr >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.5
done
if [[ "$ok" -ne 1 ]]; then
  echo "set_kiosk_display: no Wayland display yet" >&2
  exit 1
fi

# Prefer HDMI-A-2 (panel). Fall back to first connected HDMI-* only if needed.
if ! wlr-randr 2>/dev/null | grep -q "^${OUTPUT} "; then
  OUTPUT="$(wlr-randr 2>/dev/null | awk '/^HDMI-/{print $1; exit}')"
fi
if [[ -z "${OUTPUT}" ]]; then
  echo "set_kiosk_display: no HDMI output found" >&2
  exit 1
fi

# Disable every other HDMI head so touch cannot map off-screen.
while read -r other; do
  [[ -z "$other" || "$other" == "$OUTPUT" ]] && continue
  wlr-randr --output "$other" --off 2>/dev/null || true
done < <(wlr-randr 2>/dev/null | awk '/^HDMI-/{print $1}')

# Apply native mode (custom if EDID did not advertise it)
if ! wlr-randr --output "$OUTPUT" --custom-mode "$MODE" 2>/dev/null; then
  base="${MODE%@*}"
  wlr-randr --output "$OUTPUT" --custom-mode "${base}@60Hz" 2>/dev/null \
    || wlr-randr --output "$OUTPUT" --mode "$base" 2>/dev/null \
    || true
fi

wlr-randr --output "$OUTPUT" --on --pos 0,0 --transform normal --scale 1 2>/dev/null || true

cur="$(wlr-randr 2>/dev/null | awk -v o="$OUTPUT" '
  $1==o {hit=1}
  hit && /\(current\)/ {print; exit}
')"
echo "set_kiosk_display: $OUTPUT -> ${cur:-unknown}"

# One quick re-assert after kanshi settles (avoid long background loops)
(
  sleep 3
  wlr-randr --output "$OUTPUT" --custom-mode "$MODE" 2>/dev/null \
    || wlr-randr --output "$OUTPUT" --mode "${MODE%@*}" 2>/dev/null \
    || true
  while read -r other; do
    [[ -z "$other" || "$other" == "$OUTPUT" ]] && continue
    wlr-randr --output "$other" --off 2>/dev/null || true
  done < <(wlr-randr 2>/dev/null | awk '/^HDMI-/{print $1}')
) >>"${HOME}/kiosk_display.log" 2>&1 &
