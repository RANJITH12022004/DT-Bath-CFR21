#!/usr/bin/env bash
# Launch DT-CFR-Bath bootstrap so it keeps running if Tailscale/SSH drops.
set -euo pipefail
APP_ROOT="${APP_ROOT:-/opt/kiosk}"
LOG_DIR="${LOG_DIR:-/home/rle/dt_cfr_bath_bootstrap}"
BOOTSTRAP="${APP_ROOT}/scripts/bootstrap_dt_cfr_bath.sh"
mkdir -p "$LOG_DIR"
chmod +x "$BOOTSTRAP" "${APP_ROOT}/install_dt_cfr_bath.sh" 2>/dev/null || true

# Prefer systemd-run (survives logout); fall back to nohup.
if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --user --unit=dt-cfr-bath-bootstrap --collect \
    --working-directory="$APP_ROOT" \
    --property=Restart=on-failure \
    --property=RestartSec=20 \
    bash -lc "$BOOTSTRAP" \
    && echo "started via systemd-run --user (dt-cfr-bath-bootstrap.service)" \
    || {
      echo "systemd-run failed; using nohup"
      nohup bash "$BOOTSTRAP" >/dev/null 2>&1 &
      echo "started pid $!"
    }
else
  nohup bash "$BOOTSTRAP" >/dev/null 2>&1 &
  echo "started pid $!"
fi

echo "log:    $LOG_DIR/bootstrap.log"
echo "status: $LOG_DIR/status.json"
echo "follow: tail -f $LOG_DIR/bootstrap.log"
