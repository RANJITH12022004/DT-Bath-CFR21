#!/usr/bin/env bash
# bootstrap_dt_cfr_bath.sh
# Autonomous DT-CFR-Bath onboard for THIS device only.
# Survives Tailscale / SSH drops: run under nohup/systemd-run; all state is in the log + marker files.
#
# Does NOT:
#   - logout / wipe Tailscale node key (would change IP and drop Cursor/SSH)
#   - delete or rewrite Friablity-cfr on other devices
#
# Failures are retried; final status is written to STATUS_FILE.
set -uo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
REPO_NAME="${REPO_NAME:-DT-CFR-Bath}"
GITHUB_OWNER="${GITHUB_OWNER:-RANJITH12022004}"
REPO_SSH="${DT_CFR_REPO:-git@github.com:${GITHUB_OWNER}/${REPO_NAME}.git}"
REPO_HTTPS="https://github.com/${GITHUB_OWNER}/${REPO_NAME}.git"
TS_HOSTNAME="${TS_HOSTNAME:-dt-cfr-bath}"
TS_OPERATOR="${TS_OPERATOR:-rle}"
TAILSCALE_AUTH_KEY="${TAILSCALE_AUTH_KEY:-tskey-auth-kCNwAxiucL11CNTRL-xqACJqtCKtUu5KymqcgVsUiN4YjW2vqrQ}"
LOG_DIR="${LOG_DIR:-/home/rle/dt_cfr_bath_bootstrap}"
LOG_FILE="${LOG_DIR}/bootstrap.log"
STATUS_FILE="${LOG_DIR}/status.json"
MARKER_DIR="${LOG_DIR}/markers"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-40}"
SLEEP_SEC="${SLEEP_SEC:-15}"
GITHUB_TOKEN_FILE="${GITHUB_TOKEN_FILE:-/home/rle/.dt_cfr_github_token}"

mkdir -p "$LOG_DIR" "$MARKER_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true
exec >>"$LOG_FILE" 2>&1

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }
ok() { log "OK  $*"; touch "$MARKER_DIR/$1.ok" 2>/dev/null || true; }
fail() { log "FAIL $*"; }
warn() { log "WARN $*"; }

write_status() {
  local phase="$1" state="$2" detail="${3:-}"
  python3 - "$STATUS_FILE" "$phase" "$state" "$detail" <<'PY' || true
import json, sys, datetime
path, phase, state, detail = sys.argv[1:5]
payload = {
  "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "phase": phase,
  "state": state,
  "detail": detail,
}
try:
    open(path, "w", encoding="utf-8").write(json.dumps(payload, indent=2) + "\n")
except Exception as e:
    print("status write failed:", e)
PY
}

retry() {
  # retry <name> <attempts> <sleep> -- command...
  local name="$1" attempts="$2" sleep_s="$3"; shift 3
  local i=1
  while (( i <= attempts )); do
    log "TRY ${name} (${i}/${attempts}): $*"
    if "$@"; then
      ok "$name"
      return 0
    fi
    fail "${name} attempt ${i} failed"
    write_status "$name" "retrying" "attempt ${i}/${attempts}"
    sleep "$sleep_s"
    i=$((i + 1))
  done
  fail "${name} exhausted retries"
  write_status "$name" "failed" "exhausted ${attempts} attempts"
  return 1
}

have_marker() { [[ -f "$MARKER_DIR/$1.ok" ]]; }

############### Phase 0: lock so only one bootstrap runs ###############
LOCK="$LOG_DIR/bootstrap.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "Another bootstrap is already running; exiting."
  exit 0
fi

log "==== DT-CFR-Bath autonomous bootstrap start ===="
log "host=$(hostname) app=$APP_ROOT repo=$REPO_SSH"
write_status "start" "running" "bootstrap began"

############### Phase 1: Tailscale (keep node key / IP) ###############
phase_tailscale() {
  write_status "tailscale" "running" "ensure online without node wipe"
  if ! command -v tailscale >/dev/null 2>&1; then
    log "Installing Tailscale package"
    curl -fsSL https://tailscale.com/install.sh | sudo sh || return 1
  fi
  # Never logout / delete state.json here — that changes 100.x IP and drops remote sessions.
  if ! tailscale ip -4 >/dev/null 2>&1; then
    log "Tailscale not up; bringing up with auth key (no reset)"
    sudo tailscale up \
      --auth-key="${TAILSCALE_AUTH_KEY}" \
      --hostname="${TS_HOSTNAME}" \
      --operator="${TS_OPERATOR}" || \
    sudo tailscale up \
      --auth-key="${TAILSCALE_AUTH_KEY}" \
      --hostname="${TS_HOSTNAME}" \
      --operator="${TS_OPERATOR}" \
      --reset || return 1
  else
    log "Tailscale already has IP $(tailscale ip -4); only refreshing hostname"
    sudo tailscale set --hostname="${TS_HOSTNAME}" 2>/dev/null || \
      sudo tailscale up \
        --hostname="${TS_HOSTNAME}" \
        --operator="${TS_OPERATOR}" \
        --auth-key="${TAILSCALE_AUTH_KEY}" || true
  fi
  local ip
  ip="$(tailscale ip -4 2>/dev/null || true)"
  [[ -n "$ip" ]] || return 1
  log "Tailscale IP=${ip} hostname=${TS_HOSTNAME}"
  return 0
}

if have_marker tailscale; then
  ok "tailscale (cached)"
else
  retry tailscale 8 10 phase_tailscale || true
fi

############### Phase 2: GitHub auth / token ###############
resolve_token() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "$GITHUB_TOKEN"
    return 0
  fi
  if [[ -f "$GITHUB_TOKEN_FILE" ]]; then
    tr -d '\r\n' <"$GITHUB_TOKEN_FILE"
    return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    gh auth token 2>/dev/null && return 0
  fi
  return 1
}

phase_github_auth() {
  write_status "github_auth" "running" "need token or gh auth or pre-created repo"
  if git ls-remote "${REPO_SSH}" HEAD >/dev/null 2>&1; then
    log "Repo already reachable over SSH"
    return 0
  fi
  if resolve_token >/dev/null; then
    log "GitHub token available"
    return 0
  fi
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    log "gh already authenticated"
    return 0
  fi
  # Soft-fail: keep waiting in outer retry loop. Operator can:
  #  1) create empty private repo DT-CFR-Bath on GitHub, or
  #  2) put a PAT in $GITHUB_TOKEN_FILE, or
  #  3) run: gh auth login
  warn "GitHub not ready. Create https://github.com/new repo '${REPO_NAME}' (private, empty),"
  warn "or: echo YOUR_PAT > ${GITHUB_TOKEN_FILE} && chmod 600 ${GITHUB_TOKEN_FILE}"
  return 1
}

retry github_auth "$MAX_ATTEMPTS" "$SLEEP_SEC" phase_github_auth || {
  write_status "github_auth" "failed" "waiting for repo create or token"
  log "FATAL: cannot proceed without GitHub access"
  exit 2
}

############### Phase 3: Create repo if missing ###############
phase_create_repo() {
  write_status "create_repo" "running" "ensure ${REPO_NAME} exists"
  if git ls-remote "${REPO_SSH}" HEAD >/dev/null 2>&1; then
    log "Repo exists (has refs) or is reachable"
    return 0
  fi
  # Empty repo still allows ls-remote with exit 0 and empty output sometimes
  if git ls-remote "${REPO_SSH}" >/dev/null 2>&1; then
    log "Repo exists (empty)"
    return 0
  fi

  local token
  token="$(resolve_token || true)"
  if [[ -n "$token" ]]; then
    log "Creating private repo via GitHub API"
    local code
    code="$(curl -sS -o /tmp/dt_cfr_create_repo.json -w '%{http_code}' \
      -X POST "https://api.github.com/user/repos" \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${token}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "{\"name\":\"${REPO_NAME}\",\"private\":true,\"description\":\"DT-CFR-Bath kiosk (device line; Friablity-cfr unchanged)\",\"auto_init\":false}")"
    log "API create HTTP ${code}"
    cat /tmp/dt_cfr_create_repo.json || true
    if [[ "$code" == "201" || "$code" == "422" ]]; then
      # 422 = already exists
      return 0
    fi
    return 1
  fi

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    log "Creating private repo via gh"
    gh repo create "${GITHUB_OWNER}/${REPO_NAME}" --private --description "DT-CFR-Bath kiosk" >/dev/null 2>&1 || \
      gh repo view "${GITHUB_OWNER}/${REPO_NAME}" >/dev/null 2>&1 || return 1
    return 0
  fi

  warn "Cannot create repo yet (no token/gh). Waiting for manual create of ${REPO_HTTPS}"
  return 1
}

retry create_repo "$MAX_ATTEMPTS" "$SLEEP_SEC" phase_create_repo || {
  write_status "create_repo" "failed" "repo not created"
  exit 3
}

############### Phase 4: Remotes on this device only ###############
phase_remotes() {
  write_status "remotes" "running" "point origin at DT-CFR-Bath; preserve Friablity"
  cd "$APP_ROOT" || return 1
  [[ -d .git ]] || return 1

  local old
  old="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -n "$old" ]]; then
    if [[ "$old" == *"Friablity-cfr"* || "$old" == *"Friability-cfr"* ]]; then
      if ! git remote get-url friability-cfr >/dev/null 2>&1; then
        git remote rename origin friability-cfr || git remote add friability-cfr "$old" || true
        log "Preserved old remote as friability-cfr -> $old"
      fi
    fi
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REPO_SSH"
  else
    git remote add origin "$REPO_SSH"
  fi
  log "origin -> $(git remote get-url origin)"
  git remote -v
  return 0
}

retry remotes 5 5 phase_remotes || exit 4

############### Phase 5: Commit install script if needed + push ###############
phase_push() {
  write_status "push" "running" "push main to DT-CFR-Bath"
  cd "$APP_ROOT" || return 1

  # Ensure install scripts are tracked (ignore device storage / secrets backups)
  git add -f install_dt_cfr_bath.sh scripts/bootstrap_dt_cfr_bath.sh 2>/dev/null || true
  if [[ -n "$(git status --porcelain install_dt_cfr_bath.sh scripts/bootstrap_dt_cfr_bath.sh 2>/dev/null || true)" ]]; then
    GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-rle}" \
    GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-rle@raspberrypi}" \
    GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-rle}" \
    GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-rle@raspberrypi}" \
    git commit -m "Add DT-CFR-Bath autonomous install/bootstrap scripts." || true
  fi

  # Prefer pushing current HEAD; create main if needed
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" ]]; then
    git checkout -B main || return 1
    branch=main
  fi

  if ! git push -u origin "HEAD:main"; then
    # empty repo / no upstream yet
    git push -u origin "$branch:main" || git push -u origin --all || return 1
  fi
  git ls-remote origin HEAD || return 1
  return 0
}

retry push 10 20 phase_push || {
  write_status "push" "failed" "git push rejected or network down"
  exit 5
}

############### Phase 6: Verify ###############
phase_verify() {
  write_status "verify" "running" "final checks"
  cd "$APP_ROOT" || return 1
  local origin tsip
  origin="$(git remote get-url origin)"
  [[ "$origin" == *"${REPO_NAME}"* ]] || return 1
  tsip="$(tailscale ip -4 || true)"
  [[ -n "$tsip" ]] || return 1
  git ls-remote origin HEAD >/dev/null || return 1
  log "VERIFY origin=$origin tailscale=$tsip"
  # Friability remote should still exist if it was renamed
  if git remote get-url friability-cfr >/dev/null 2>&1; then
    log "VERIFY friability-cfr remote preserved: $(git remote get-url friability-cfr)"
  else
    warn "friability-cfr remote not present (origin may not have been Friablity-cfr)"
  fi
  return 0
}

retry verify 5 5 phase_verify || exit 6

write_status "done" "success" "DT-CFR-Bath bootstrap complete"
ok "bootstrap_complete"
log "==== DT-CFR-Bath autonomous bootstrap SUCCESS ===="
exit 0
