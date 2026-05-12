#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-auto-browser}"
SERVICE_GROUP="${SERVICE_GROUP:-auto-browser}"
SERVICE_HOME="${SERVICE_HOME:-/srv/auto-browser}"
PROJECT_DIR="${PROJECT_DIR:-/srv/auto-browser/app}"
SOURCE_PROJECT_DIR="${SOURCE_PROJECT_DIR:-$PWD}"
SSH_AUTHORIZED_KEYS_SOURCE="${SSH_AUTHORIZED_KEYS_SOURCE:-}"
DOCKER_GROUP="${DOCKER_GROUP:-docker}"

usage() {
  cat <<'USAGE'
Usage:
  sudo ops/ubuntu-create-auto-browser-user.sh [options]

Creates a dedicated Ubuntu service user for running the auto-browser Docker
deployment without using root for day-to-day operation.

Options:
  --user <name>                 Service user. Default: auto-browser.
  --group <name>                Service group. Default: auto-browser.
  --home <path>                 Service home. Default: /srv/auto-browser.
  --project-dir <path>          Project path owned by the user. Default: /srv/auto-browser/app.
  --source-project-dir <path>   Existing project to copy from if project dir is empty.
                                Default: current working directory.
  --authorized-keys <path>      Copy SSH authorized_keys from this file.
  --no-authorized-keys          Do not copy SSH authorized_keys.
  --help                        Show this help.

Notes:
  - This script needs sudo/root because it creates users/groups and fixes ownership.
  - Docker access is granted by adding the user to the docker group. Members of the
    docker group can control Docker and should be treated as service operators.
  - It does not grant passwordless sudo.
USAGE
}

COPY_AUTHORIZED_KEYS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      SERVICE_USER="$2"
      shift 2
      ;;
    --group)
      SERVICE_GROUP="$2"
      shift 2
      ;;
    --home)
      SERVICE_HOME="$2"
      shift 2
      ;;
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --source-project-dir)
      SOURCE_PROJECT_DIR="$2"
      shift 2
      ;;
    --authorized-keys)
      SSH_AUTHORIZED_KEYS_SOURCE="$2"
      COPY_AUTHORIZED_KEYS=1
      shift 2
      ;;
    --no-authorized-keys)
      COPY_AUTHORIZED_KEYS=0
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

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo/root." >&2
  exit 1
fi

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  log "creating group ${SERVICE_GROUP}"
  groupadd --system "$SERVICE_GROUP"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating user ${SERVICE_USER}"
  useradd \
    --system \
    --create-home \
    --home-dir "$SERVICE_HOME" \
    --gid "$SERVICE_GROUP" \
    --shell /bin/bash \
    "$SERVICE_USER"
fi

if getent group "$DOCKER_GROUP" >/dev/null; then
  log "adding ${SERVICE_USER} to ${DOCKER_GROUP}"
  usermod -aG "$DOCKER_GROUP" "$SERVICE_USER"
else
  log "docker group ${DOCKER_GROUP} not found; install Docker first or add ${SERVICE_USER} later"
fi

mkdir -p "$PROJECT_DIR"

if [[ -d "$SOURCE_PROJECT_DIR" && ! -f "$PROJECT_DIR/package.json" ]]; then
  log "copying initial project files from ${SOURCE_PROJECT_DIR} to ${PROJECT_DIR}"
  rsync -a \
    --exclude .git \
    --exclude node_modules \
    --exclude .DS_Store \
    "$SOURCE_PROJECT_DIR/" "$PROJECT_DIR/"
fi

mkdir -p \
  "$PROJECT_DIR/artifacts" \
  "$PROJECT_DIR/profiles" \
  "$SERVICE_HOME/.ssh"

if [[ "$COPY_AUTHORIZED_KEYS" -eq 1 ]]; then
  if [[ -z "$SSH_AUTHORIZED_KEYS_SOURCE" ]]; then
    if [[ -n "${SUDO_USER:-}" && -f "/home/${SUDO_USER}/.ssh/authorized_keys" ]]; then
      SSH_AUTHORIZED_KEYS_SOURCE="/home/${SUDO_USER}/.ssh/authorized_keys"
    fi
  fi

  if [[ -n "$SSH_AUTHORIZED_KEYS_SOURCE" && -f "$SSH_AUTHORIZED_KEYS_SOURCE" ]]; then
    log "copying authorized_keys from ${SSH_AUTHORIZED_KEYS_SOURCE}"
    cp "$SSH_AUTHORIZED_KEYS_SOURCE" "$SERVICE_HOME/.ssh/authorized_keys"
  else
    log "no authorized_keys source found; skipping SSH key setup"
  fi
fi

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$SERVICE_HOME"
if [[ "$PROJECT_DIR" != "$SERVICE_HOME"* ]]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR"
fi
chmod 700 "$SERVICE_HOME/.ssh"
if [[ -f "$SERVICE_HOME/.ssh/authorized_keys" ]]; then
  chmod 600 "$SERVICE_HOME/.ssh/authorized_keys"
fi

log "service user ready"
log "user=${SERVICE_USER}"
log "project_dir=${PROJECT_DIR}"
log "test SSH with: ssh ${SERVICE_USER}@<host>"
log "test Docker with: sudo -iu ${SERVICE_USER} bash -lc 'cd ${PROJECT_DIR} && docker compose ps'"
