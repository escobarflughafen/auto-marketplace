#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/srv/auto-browser/app}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/auto-browser/backups}"
RESTART_SERVICE=1
RUN_MAINTENANCE=1

usage() {
  cat <<'USAGE'
Usage:
  ops/ubuntu-migrate-marketplace-runtime-local.sh [options]

Run this on the Ubuntu server as the dedicated service user after the local
machine has rsynced source and artifacts into PROJECT_DIR.

Options:
  --project-dir <path>       Project dir. Default: /srv/auto-browser/app.
  --backup-root <path>       Backup root. Default: /srv/auto-browser/backups.
  --skip-restart             Do not rebuild/restart Docker Compose.
  --skip-maintenance         Do not run DB maintenance in the container.
  --help                     Show this help.

This script does not need sudo if PROJECT_DIR is owned by the service user and
the service user belongs to the docker group.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --backup-root)
      BACKUP_ROOT="$2"
      shift 2
      ;;
    --skip-restart)
      RESTART_SERVICE=0
      shift
      ;;
    --skip-maintenance)
      RUN_MAINTENANCE=0
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

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "Docker Compose is not available. Install the Docker Compose plugin or docker-compose." >&2
    return 127
  fi
}

if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo "Project dir does not contain package.json: ${PROJECT_DIR}" >&2
  exit 1
fi

cd "$PROJECT_DIR"

mkdir -p "$BACKUP_ROOT"
if [[ -d artifacts/marketplace-homepage ]]; then
  BACKUP_DIR="$BACKUP_ROOT/marketplace-homepage.$(date -u +%Y%m%dT%H%M%SZ)"
  log "creating backup ${BACKUP_DIR}"
  cp -a artifacts/marketplace-homepage "$BACKUP_DIR"
fi

if [[ "$RESTART_SERVICE" -eq 1 ]]; then
  log "rebuilding and restarting Docker Compose service"
  docker_compose build auto-browser
  docker_compose up -d auto-browser
fi

if [[ "$RUN_MAINTENANCE" -eq 1 ]]; then
  log "running DB maintenance inside container"
  docker_compose exec -T auto-browser npm run marketplace:home:db:maintain -- --json
fi

log "done"
