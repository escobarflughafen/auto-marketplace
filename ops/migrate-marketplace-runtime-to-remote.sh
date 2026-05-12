#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-10.10.20.3}"
REMOTE_DIR="${REMOTE_DIR:-/srv/auto-browser/app}"
LOCAL_DIR="${LOCAL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REMOTE="${REMOTE_USER:+${REMOTE_USER}@}${REMOTE_HOST}"

EXECUTE=0
SYNC_SOURCE=1
SYNC_RUNTIME=1
RESTART_SERVICE=1
RUN_REMOTE_MAINTENANCE=1
REMOTE_BACKUP=1
RUN_REMOTE_PREFLIGHT=1
RUN_REMOTE_DOCTOR=1
RUN_REMOTE_HEALTHCHECK=1

usage() {
  cat <<'USAGE'
Usage:
  ops/migrate-marketplace-runtime-to-remote.sh [options]

Defaults to dry-run. Add --execute to actually write to the remote server.

Options:
  --execute                  Perform the migration. Without this, rsync uses --dry-run.
  --remote-host <host>        Remote host. Default: 10.10.20.3 or REMOTE_HOST.
  --remote-user <user>        Optional SSH user. Default: current SSH config.
  --remote-dir <path>         Remote project dir. Default: /srv/auto-browser/app.
  --skip-source               Do not sync source code.
  --skip-runtime              Do not sync artifacts/marketplace-homepage.
  --skip-restart              Do not rebuild/restart docker compose service.
  --skip-remote-preflight     Do not verify remote Docker/Compose/runtime dirs before restart.
  --skip-remote-doctor        Do not run marketplace:doctor in the remote container after restart.
  --skip-healthcheck          Do not wait for the remote HTTP health endpoint after restart.
  --skip-remote-maintenance   Do not run DB optimize/checkpoint on remote after restart.
  --no-remote-backup          Do not create a timestamped remote artifacts backup.
  --help                      Show this help.

Notes:
  - Runtime sync includes local artifacts/marketplace-homepage, including the SQLite DB,
    detail markdown, screenshots, thumbnails, logs, and batch files.
  - Source sync excludes credentials, profiles, artifacts, node_modules, output, and .git.
  - For the cleanest DB snapshot, stop local collectors/resolvers before running --execute.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE=1
      shift
      ;;
    --remote-host)
      REMOTE_HOST="$2"
      REMOTE="${REMOTE_USER:+${REMOTE_USER}@}${REMOTE_HOST}"
      shift 2
      ;;
    --remote-user)
      REMOTE_USER="$2"
      REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="$2"
      shift 2
      ;;
    --skip-source)
      SYNC_SOURCE=0
      shift
      ;;
    --skip-runtime)
      SYNC_RUNTIME=0
      shift
      ;;
    --skip-restart)
      RESTART_SERVICE=0
      shift
      ;;
    --skip-remote-preflight)
      RUN_REMOTE_PREFLIGHT=0
      shift
      ;;
    --skip-remote-doctor)
      RUN_REMOTE_DOCTOR=0
      shift
      ;;
    --skip-healthcheck)
      RUN_REMOTE_HEALTHCHECK=0
      shift
      ;;
    --skip-remote-maintenance)
      RUN_REMOTE_MAINTENANCE=0
      shift
      ;;
    --no-remote-backup)
      REMOTE_BACKUP=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$LOCAL_DIR"

RSYNC_ARGS=(-az --delete)
if [[ "$EXECUTE" -ne 1 ]]; then
  RSYNC_ARGS+=(--dry-run)
fi

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

run_or_print() {
  if [[ "$EXECUTE" -eq 1 ]]; then
    "$@"
  else
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  fi
}

if [[ ! -f package.json || ! -d artifacts/marketplace-homepage ]]; then
  echo "Run this script from the auto-browser repo, or set LOCAL_DIR." >&2
  exit 1
fi

log "remote=${REMOTE}:${REMOTE_DIR}"
log "mode=$([[ "$EXECUTE" -eq 1 ]] && echo execute || echo dry-run)"

if [[ "$SYNC_RUNTIME" -eq 1 && "$EXECUTE" -eq 1 ]]; then
  log "checkpointing local SQLite DB before runtime sync"
  npm run marketplace:home:db:maintain -- --json >/tmp/auto-browser-local-db-maintenance.json
fi

if [[ "$EXECUTE" -eq 1 ]]; then
  log "ensuring remote project/runtime directories exist"
  ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/artifacts/marketplace-homepage' '$REMOTE_DIR/profiles/facebook-marketplace' '$REMOTE_DIR/secrets'"
else
  run_or_print ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/artifacts/marketplace-homepage' '$REMOTE_DIR/profiles/facebook-marketplace' '$REMOTE_DIR/secrets'"
fi

if [[ "$SYNC_RUNTIME" -eq 1 && "$REMOTE_BACKUP" -eq 1 ]]; then
  BACKUP_NAME="marketplace-homepage.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  log "remote runtime backup name=${BACKUP_NAME}"
  if [[ "$EXECUTE" -eq 1 ]]; then
    ssh "$REMOTE" "if [ -d '$REMOTE_DIR/artifacts/marketplace-homepage' ]; then mkdir -p '$REMOTE_DIR/artifacts/backups' && cp -a '$REMOTE_DIR/artifacts/marketplace-homepage' '$REMOTE_DIR/artifacts/backups/$BACKUP_NAME'; fi"
  else
    run_or_print ssh "$REMOTE" "if [ -d '$REMOTE_DIR/artifacts/marketplace-homepage' ]; then mkdir -p '$REMOTE_DIR/artifacts/backups' && cp -a '$REMOTE_DIR/artifacts/marketplace-homepage' '$REMOTE_DIR/artifacts/backups/$BACKUP_NAME'; fi"
  fi
fi

if [[ "$SYNC_SOURCE" -eq 1 ]]; then
  log "syncing source code"
  rsync "${RSYNC_ARGS[@]}" \
    --exclude .git \
    --exclude node_modules \
    --exclude artifacts \
    --exclude profiles \
    --exclude output \
    --exclude credentials.json \
    --exclude secrets \
    --exclude .DS_Store \
    ./ "$REMOTE:$REMOTE_DIR/"
fi

if [[ "$SYNC_RUNTIME" -eq 1 ]]; then
  log "syncing marketplace runtime artifacts"
  rsync "${RSYNC_ARGS[@]}" \
    --exclude .DS_Store \
    artifacts/marketplace-homepage/ "$REMOTE:$REMOTE_DIR/artifacts/marketplace-homepage/"
fi

if [[ "$RUN_REMOTE_PREFLIGHT" -eq 1 ]]; then
  log "running remote deployment preflight"
  run_or_print ssh "$REMOTE" "cd '$REMOTE_DIR' && test -f package.json && test -f Dockerfile && test -f docker-compose.yml && mkdir -p artifacts/marketplace-homepage profiles/facebook-marketplace secrets && if docker compose version >/dev/null 2>&1; then docker compose config --quiet; elif command -v docker-compose >/dev/null 2>&1; then docker-compose config --quiet; else echo 'Docker Compose is not available. Run sudo ops/ubuntu-deploy-auto-browser.sh on the server to install prerequisites.' >&2; exit 127; fi"
fi

if [[ "$RESTART_SERVICE" -eq 1 ]]; then
  log "rebuilding and restarting remote docker service"
  run_or_print ssh "$REMOTE" "cd '$REMOTE_DIR' && if docker compose version >/dev/null 2>&1; then docker compose build auto-browser && docker compose up -d auto-browser; elif command -v docker-compose >/dev/null 2>&1; then docker-compose build auto-browser && docker-compose up -d auto-browser; else echo 'Docker Compose is not available' >&2; exit 127; fi"
fi

if [[ "$RUN_REMOTE_HEALTHCHECK" -eq 1 && "$RESTART_SERVICE" -eq 1 ]]; then
  log "waiting for remote HTTP health endpoint"
  run_or_print ssh "$REMOTE" "if command -v curl >/dev/null 2>&1; then HEALTH_FETCH='curl -fsS'; elif command -v wget >/dev/null 2>&1; then HEALTH_FETCH='wget -qO-'; else echo 'curl or wget is required for the remote health check. Run sudo ops/ubuntu-deploy-auto-browser.sh on the server or pass --skip-healthcheck.' >&2; exit 127; fi; for i in \$(seq 1 30); do if \$HEALTH_FETCH 'http://127.0.0.1:21435/api/summary' >/dev/null; then exit 0; fi; sleep 2; done; cd '$REMOTE_DIR' && if docker compose version >/dev/null 2>&1; then docker compose logs --tail=120 auto-browser; elif command -v docker-compose >/dev/null 2>&1; then docker-compose logs --tail=120 auto-browser; fi; exit 1"
fi

if [[ "$RUN_REMOTE_DOCTOR" -eq 1 && "$RESTART_SERVICE" -eq 1 ]]; then
  log "running remote marketplace doctor inside container"
  run_or_print ssh "$REMOTE" "cd '$REMOTE_DIR' && if docker compose version >/dev/null 2>&1; then docker compose exec -T auto-browser npm run marketplace:doctor -- --json; elif command -v docker-compose >/dev/null 2>&1; then docker-compose exec -T auto-browser npm run marketplace:doctor -- --json; else echo 'Docker Compose is not available' >&2; exit 127; fi"
fi

if [[ "$RUN_REMOTE_MAINTENANCE" -eq 1 ]]; then
  log "running remote DB maintenance/checkpoint inside container"
  run_or_print ssh "$REMOTE" "cd '$REMOTE_DIR' && if docker compose version >/dev/null 2>&1; then docker compose exec -T auto-browser npm run marketplace:home:db:maintain -- --json; elif command -v docker-compose >/dev/null 2>&1; then docker-compose exec -T auto-browser npm run marketplace:home:db:maintain -- --json; else echo 'Docker Compose is not available' >&2; exit 127; fi"
fi

log "done"
