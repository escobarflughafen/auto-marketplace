#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-auto-browser}"
SERVICE_GROUP="${SERVICE_GROUP:-auto-browser}"
SERVICE_HOME="${SERVICE_HOME:-/srv/auto-browser}"
PROJECT_DIR="${PROJECT_DIR:-/srv/auto-browser/app}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/auto-browser/backups}"
CREDENTIALS_SOURCE="${CREDENTIALS_SOURCE:-}"

INSTALL_DOCKER=1
BUILD_IMAGE=1
START_SERVICE=1
RUN_DOCTOR=1
RUN_MAINTENANCE=1
WAIT_HEALTH=1

usage() {
  cat <<'USAGE'
Usage:
  sudo ops/ubuntu-deploy-auto-browser.sh [options]

Prepare an Ubuntu server to run the auto-browser Docker deployment, then build,
start, and verify the Marketplace management server.

Run this on the Ubuntu server as root/sudo after the project files have been
copied into PROJECT_DIR. For first-time source/runtime sync from a workstation,
use ops/migrate-marketplace-runtime-to-remote.sh after this script has prepared
Docker and the service user.

Options:
  --project-dir <path>          Project dir. Default: /srv/auto-browser/app.
  --home <path>                 Service home. Default: /srv/auto-browser.
  --backup-root <path>          Runtime backup root. Default: /srv/auto-browser/backups.
  --user <name>                 Service user. Default: auto-browser.
  --group <name>                Service group. Default: auto-browser.
  --credentials-source <path>   Install this credentials JSON to PROJECT_DIR/secrets/credentials.json.
  --no-install-docker           Do not install Docker/Compose; only verify they exist.
  --skip-build                  Do not run docker compose build.
  --skip-start                  Do not run docker compose up -d.
  --skip-doctor                 Do not run npm run marketplace:doctor inside the container.
  --skip-maintenance            Do not run SQLite maintenance inside the container.
  --skip-healthcheck            Do not wait for the HTTP health endpoint.
  --help                        Show this help.

This script installs/verifies:
  - Docker Engine and the Docker Compose plugin
  - the dedicated service user and docker group access
  - runtime directories: artifacts, profiles, secrets, backups
  - container build dependencies through the repo Dockerfile
  - Chromium/Playwright readiness through marketplace:doctor
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --home)
      SERVICE_HOME="$2"
      shift 2
      ;;
    --backup-root)
      BACKUP_ROOT="$2"
      shift 2
      ;;
    --user)
      SERVICE_USER="$2"
      shift 2
      ;;
    --group)
      SERVICE_GROUP="$2"
      shift 2
      ;;
    --credentials-source)
      CREDENTIALS_SOURCE="$2"
      shift 2
      ;;
    --no-install-docker)
      INSTALL_DOCKER=0
      shift
      ;;
    --skip-build)
      BUILD_IMAGE=0
      shift
      ;;
    --skip-start)
      START_SERVICE=0
      shift
      ;;
    --skip-doctor)
      RUN_DOCTOR=0
      shift
      ;;
    --skip-maintenance)
      RUN_MAINTENANCE=0
      shift
      ;;
    --skip-healthcheck)
      WAIT_HEALTH=0
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

quote() {
  printf '%q' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

run_as_service_user() {
  local command_string="$1"
  if command_exists runuser; then
    runuser -u "$SERVICE_USER" -- bash -lc "$command_string"
  else
    su - "$SERVICE_USER" -c "$command_string"
  fi
}

docker_compose_available() {
  docker compose version >/dev/null 2>&1
}

install_docker_from_docker_repo() {
  . /etc/os-release
  local codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
  if [[ -z "$codename" ]]; then
    echo "Could not determine Ubuntu codename from /etc/os-release." >&2
    return 1
  fi

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi

  cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_from_ubuntu_repo() {
  apt-get update
  apt-get install -y docker.io
  if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
    apt-get install -y docker-compose-v2
  elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then
    apt-get install -y docker-compose-plugin
  else
    apt-get install -y docker-compose
  fi
}

install_or_verify_docker() {
  if [[ "$INSTALL_DOCKER" -eq 1 ]]; then
    log "installing host prerequisites"
    apt-get update
    apt-get install -y ca-certificates curl gnupg lsb-release rsync

    if ! command_exists docker || ! docker_compose_available; then
      log "installing Docker Engine and Compose plugin"
      if ! install_docker_from_docker_repo; then
        log "Docker repository install failed; falling back to Ubuntu packages"
        install_docker_from_ubuntu_repo
      fi
    else
      log "Docker and Compose are already installed"
    fi
  fi

  if [[ "$WAIT_HEALTH" -eq 1 ]] && ! command_exists curl; then
    if [[ "$INSTALL_DOCKER" -eq 1 ]]; then
      apt-get install -y curl
    else
      echo "curl is required for --skip-healthcheck=false. Install curl or pass --skip-healthcheck." >&2
      exit 1
    fi
  fi

  if command_exists systemctl; then
    systemctl enable --now docker
  elif command_exists service; then
    service docker start
  fi

  if ! command_exists docker; then
    echo "Docker is not installed." >&2
    exit 1
  fi

  if ! docker_compose_available; then
    echo "Docker Compose plugin is not available. Install docker-compose-plugin or rerun without --no-install-docker." >&2
    exit 1
  fi
}

ensure_service_user() {
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

  if getent group docker >/dev/null; then
    log "adding ${SERVICE_USER} to docker"
    usermod -aG docker "$SERVICE_USER"
  else
    echo "Docker group does not exist after Docker installation." >&2
    exit 1
  fi
}

ensure_runtime_dirs() {
  log "ensuring deployment directories"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$SERVICE_HOME" "$PROJECT_DIR" "$BACKUP_ROOT"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 \
    "$PROJECT_DIR/artifacts" \
    "$PROJECT_DIR/artifacts/marketplace-homepage" \
    "$PROJECT_DIR/profiles" \
    "$PROJECT_DIR/profiles/facebook-marketplace"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$PROJECT_DIR/secrets"

  if [[ -n "$CREDENTIALS_SOURCE" ]]; then
    if [[ ! -f "$CREDENTIALS_SOURCE" ]]; then
      echo "Credentials source does not exist: ${CREDENTIALS_SOURCE}" >&2
      exit 1
    fi
    log "installing credentials to ${PROJECT_DIR}/secrets/credentials.json"
    install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0640 \
      "$CREDENTIALS_SOURCE" \
      "$PROJECT_DIR/secrets/credentials.json"
  elif [[ -f "$PROJECT_DIR/credentials.json" && ! -f "$PROJECT_DIR/secrets/credentials.json" ]]; then
    log "moving legacy credentials.json into secrets"
    install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0640 \
      "$PROJECT_DIR/credentials.json" \
      "$PROJECT_DIR/secrets/credentials.json"
  fi

  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$SERVICE_HOME"
  if [[ "$PROJECT_DIR" != "$SERVICE_HOME"* ]]; then
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR"
  fi
  if [[ "$BACKUP_ROOT" != "$SERVICE_HOME"* ]]; then
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$BACKUP_ROOT"
  fi
}

validate_project() {
  local missing=0
  for file in package.json package-lock.json Dockerfile docker-compose.yml; do
    if [[ ! -f "$PROJECT_DIR/$file" ]]; then
      echo "Missing ${PROJECT_DIR}/${file}" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    echo "Copy the project into ${PROJECT_DIR}, then rerun this script." >&2
    exit 1
  fi
}

compose_cmd() {
  local quoted_project_dir
  quoted_project_dir="$(quote "$PROJECT_DIR")"
  run_as_service_user "cd ${quoted_project_dir} && docker compose $*"
}

wait_for_health() {
  local url="http://127.0.0.1:21435/healthz"
  log "waiting for ${url}"
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null; then
      log "health endpoint is ready"
      return 0
    fi
    sleep 2
  done

  echo "Service did not become healthy at ${url}" >&2
  compose_cmd "ps auto-browser" || true
  compose_cmd "logs --tail=120 auto-browser" || true
  exit 1
}

main() {
  log "project_dir=${PROJECT_DIR}"
  install_or_verify_docker
  ensure_service_user
  ensure_runtime_dirs
  validate_project

  if [[ "$BUILD_IMAGE" -eq 1 ]]; then
    log "building Docker image"
    compose_cmd "build auto-browser"
  fi

  if [[ "$START_SERVICE" -eq 1 ]]; then
    log "starting Docker Compose service"
    compose_cmd "up -d auto-browser"
  fi

  if [[ "$WAIT_HEALTH" -eq 1 && "$START_SERVICE" -eq 1 ]]; then
    wait_for_health
  fi

  if [[ "$RUN_DOCTOR" -eq 1 && "$START_SERVICE" -eq 1 ]]; then
    log "running marketplace doctor inside container"
    compose_cmd "exec -T auto-browser npm run marketplace:doctor -- --json"
  fi

  if [[ "$RUN_MAINTENANCE" -eq 1 && "$START_SERVICE" -eq 1 ]]; then
    log "running SQLite maintenance inside container"
    compose_cmd "exec -T auto-browser npm run marketplace:home:db:maintain -- --json"
  fi

  log "deployment ready"
  log "open http://<server-ip>:21435"
}

main
