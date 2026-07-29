#!/usr/bin/env bash
# install_dt_cfr_bath.sh — device install for DT-CFR-Bath only.
# Safe for remote sessions: does not wipe Tailscale node identity / IP.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
REPO_SSH="${DT_CFR_REPO:-git@github.com:RANJITH12022004/DT-CFR-Bath.git}"
TS_HOSTNAME="${TS_HOSTNAME:-dt-cfr-bath}"
TS_OPERATOR="${TS_OPERATOR:-rle}"
TAILSCALE_AUTH_KEY="${TAILSCALE_AUTH_KEY:-tskey-auth-kCNwAxiucL11CNTRL-xqACJqtCKtUu5KymqcgVsUiN4YjW2vqrQ}"
LOG="${DT_CFR_INSTALL_LOG:-/home/rle/dt_cfr_bath_bootstrap/install.log}"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

echo "==> DT-CFR-Bath install $(date -Is) on $(hostname)"
echo "    repo=${REPO_SSH} app=${APP_ROOT}"

if [[ "$(id -u)" -ne 0 ]]; then SUDO=sudo; else SUDO=""; fi

echo "==> Tailscale (keep existing node/IP if already online)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | $SUDO sh
fi

if tailscale ip -4 >/dev/null 2>&1; then
  echo "    already online: $(tailscale ip -4) — not logging out (avoids IP change / session drop)"
  $SUDO tailscale set --hostname="${TS_HOSTNAME}" 2>/dev/null || \
    $SUDO tailscale up --hostname="${TS_HOSTNAME}" --operator="${TS_OPERATOR}" --auth-key="${TAILSCALE_AUTH_KEY}" || true
else
  $SUDO tailscale up --auth-key="${TAILSCALE_AUTH_KEY}" --hostname="${TS_HOSTNAME}" --operator="${TS_OPERATOR}" || \
    $SUDO tailscale up --reset --auth-key="${TAILSCALE_AUTH_KEY}" --hostname="${TS_HOSTNAME}" --operator="${TS_OPERATOR}"
fi

echo "==> Tailscale status"
tailscale ip -4 || true
tailscale status | head -15 || true

echo "==> Git remotes (this device only; preserve Friablity-cfr)"
if [[ ! -d "${APP_ROOT}/.git" ]]; then
  echo "ERROR: ${APP_ROOT} is not a git checkout"
  echo "  $SUDO git clone ${REPO_SSH} ${APP_ROOT}"
  exit 1
fi
cd "${APP_ROOT}"
OLD_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ -n "${OLD_URL}" && ( "${OLD_URL}" == *Friablity-cfr* || "${OLD_URL}" == *Friability-cfr* ) ]]; then
  if ! git remote get-url friability-cfr >/dev/null 2>&1; then
    git remote rename origin friability-cfr || git remote add friability-cfr "${OLD_URL}" || true
    echo "    preserved friability-cfr -> ${OLD_URL}"
  fi
fi
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "${REPO_SSH}"
else
  git remote add origin "${REPO_SSH}"
fi
echo "    origin -> $(git remote get-url origin)"

echo "==> Done. For full autonomous create/push use:"
echo "    nohup ${APP_ROOT}/scripts/bootstrap_dt_cfr_bath.sh >/dev/null 2>&1 &"
echo "    tail -f /home/rle/dt_cfr_bath_bootstrap/bootstrap.log"
echo "Rotate the Tailscale auth key after sharing this script."
