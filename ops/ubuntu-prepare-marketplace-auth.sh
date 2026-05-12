#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-auto-browser}"
SERVICE_GROUP="${SERVICE_GROUP:-auto-browser}"
PROJECT_DIR="${PROJECT_DIR:-/srv/auto-browser/app}"
CREDENTIALS_SOURCE="${CREDENTIALS_SOURCE:-}"
RUN_HEADLESS_BOOTSTRAP=0
RUN_HEADED_BOOTSTRAP=0

usage() {
  cat <<'USAGE'
Usage:
  sudo ops/ubuntu-prepare-marketplace-auth.sh [options]

Prepare the Ubuntu remote deployment for authenticated Facebook Marketplace
collection/resolution.

This script:
  - creates PROJECT_DIR/secrets with service-user ownership
  - installs secrets/credentials.json from an existing credentials file
  - fixes persistent profile ownership
  - optionally runs a headless auth bootstrap
  - prints the next commands for headless retry or headed verification

Options:
  --project-dir <path>           Project dir. Default: /srv/auto-browser/app.
  --user <name>                  Service user. Default: auto-browser.
  --group <name>                 Service group. Default: auto-browser.
  --credentials-source <path>    Source credentials JSON. Default: first existing:
                                 PROJECT_DIR/secrets/credentials.json,
                                 PROJECT_DIR/credentials.json.
  --bootstrap-headless           Run the headless credential bootstrap after setup.
  --bootstrap-headed             Run the headed credential bootstrap after setup.
                                 Use this from a desktop terminal with DISPLAY set.
  --help                         Show this help.

Notes:
  - Run this on the Ubuntu server as root/sudo.
  - It does not print credential contents.
  - If Facebook requires 2FA/checkpoint, the headless bootstrap will fail; use
    the printed headed command from a logged-in desktop session on the server.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
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
    --bootstrap-headless)
      RUN_HEADLESS_BOOTSTRAP=1
      shift
      ;;
    --bootstrap-headed)
      RUN_HEADED_BOOTSTRAP=1
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

clear_profile_locks() {
  if [[ -d "$PROFILE_DIR" ]]; then
    rm -f \
      "$PROFILE_DIR/SingletonCookie" \
      "$PROFILE_DIR/SingletonLock" \
      "$PROFILE_DIR/SingletonSocket"
  fi
}

quote() {
  printf '%q' "$1"
}

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user does not exist: ${SERVICE_USER}" >&2
  exit 1
fi

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  echo "Service group does not exist: ${SERVICE_GROUP}" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/package.json" || ! -f "$PROJECT_DIR/docker-compose.yml" ]]; then
  echo "Project dir is not an auto-browser Docker deployment: ${PROJECT_DIR}" >&2
  exit 1
fi

SECRETS_DIR="$PROJECT_DIR/secrets"
SECRET_CREDENTIALS="$SECRETS_DIR/credentials.json"
LEGACY_CREDENTIALS="$PROJECT_DIR/credentials.json"
PROFILE_DIR="$PROJECT_DIR/profiles/facebook-marketplace"

if [[ -z "$CREDENTIALS_SOURCE" ]]; then
  if [[ -f "$SECRET_CREDENTIALS" ]]; then
    CREDENTIALS_SOURCE="$SECRET_CREDENTIALS"
  elif [[ -f "$LEGACY_CREDENTIALS" ]]; then
    CREDENTIALS_SOURCE="$LEGACY_CREDENTIALS"
  fi
fi

log "project_dir=${PROJECT_DIR}"
log "service_user=${SERVICE_USER}"
log "creating secrets/profile directories"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$SECRETS_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$PROJECT_DIR/profiles" "$PROFILE_DIR"

if [[ -n "$CREDENTIALS_SOURCE" && -f "$CREDENTIALS_SOURCE" ]]; then
  SOURCE_REAL="$(readlink -f "$CREDENTIALS_SOURCE")"
  TARGET_REAL="$(readlink -f "$SECRET_CREDENTIALS" 2>/dev/null || true)"
  if [[ "$SOURCE_REAL" != "$TARGET_REAL" ]]; then
    log "installing credentials file to ${SECRET_CREDENTIALS}"
    install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0640 "$CREDENTIALS_SOURCE" "$SECRET_CREDENTIALS"
  else
    log "credentials file already installed at ${SECRET_CREDENTIALS}"
    chown "$SERVICE_USER:$SERVICE_GROUP" "$SECRET_CREDENTIALS"
    chmod 0640 "$SECRET_CREDENTIALS"
  fi
else
  log "no credentials source found; expected ${SECRET_CREDENTIALS} or ${LEGACY_CREDENTIALS}"
  log "create ${SECRET_CREDENTIALS} before using --auth-mode credentials"
fi

log "repairing profile ownership"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR/profiles"
log "clearing stale Chromium profile locks"
clear_profile_locks

cd "$PROJECT_DIR"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is not available." >&2
  exit 1
fi

log "checking credentials visibility inside container"
if "${COMPOSE[@]}" run --rm auto-browser sh -lc 'test -r /app/secrets/credentials.json'; then
  log "container can read /app/secrets/credentials.json"
else
  echo "Container cannot read /app/secrets/credentials.json." >&2
  exit 1
fi

HEADLESS_CMD="cd $(quote "$PROJECT_DIR") && docker compose run --rm auto-browser npm run marketplace:auth:bootstrap -- --auth-mode credentials --headless --json"
HEADED_CMD="cd $(quote "$PROJECT_DIR") && docker compose run --rm -e DISPLAY=\"\${DISPLAY}\" -v /tmp/.X11-unix:/tmp/.X11-unix auto-browser npm run marketplace:auth:bootstrap -- --auth-mode credentials --headed --json"
RESOLVE_CMD="cd $(quote "$PROJECT_DIR") && docker compose exec -T auto-browser npm run marketplace:home:process -- --auth-mode required --drain --batch-size 3 --limit 10"

if [[ "$RUN_HEADLESS_BOOTSTRAP" -eq 1 ]]; then
  log "running headless auth bootstrap"
  set +e
  "${COMPOSE[@]}" run --rm auto-browser npm run marketplace:auth:bootstrap -- --auth-mode credentials --headless --json
  STATUS=$?
  set -e
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR/profiles"
  if [[ "$STATUS" -ne 0 ]]; then
    clear_profile_locks
    log "headless bootstrap failed; Facebook likely requires 2FA/checkpoint approval"
    log "from a desktop login on this server, run:"
    printf '  %s\n' "$HEADED_CMD"
    exit "$STATUS"
  fi
fi

if [[ "$RUN_HEADED_BOOTSTRAP" -eq 1 ]]; then
  if [[ -z "${DISPLAY:-}" ]]; then
    echo "--bootstrap-headed requires DISPLAY to be set. Run it from a desktop terminal, not a plain SSH session." >&2
    exit 1
  fi
  if [[ ! -d /tmp/.X11-unix ]]; then
    echo "--bootstrap-headed requires /tmp/.X11-unix from the desktop session." >&2
    exit 1
  fi

  log "running headed auth bootstrap display=${DISPLAY}"
  set +e
  "${COMPOSE[@]}" run --rm \
    -e "DISPLAY=${DISPLAY}" \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    auto-browser npm run marketplace:auth:bootstrap -- --auth-mode credentials --headed --json
  STATUS=$?
  set -e
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR/profiles"
  if [[ "$STATUS" -ne 0 ]]; then
    clear_profile_locks
    log "headed bootstrap failed"
    log "if the browser did not open, run from the desktop user session: xhost +SI:localuser:root"
    exit "$STATUS"
  fi
fi

log "auth prep complete"
cat <<EOF

Next commands:

1. Try/refresh headless auth:
   ${HEADLESS_CMD}

2. If Facebook asks for 2FA/checkpoint, run this from a desktop terminal on
   the Ubuntu server where DISPLAY is set:
   xhost +SI:localuser:root
   sudo -E bash /tmp/ubuntu-prepare-marketplace-auth.sh --bootstrap-headed

   Equivalent direct command:
   ${HEADED_CMD}

3. After auth succeeds, run authenticated resolution:
   ${RESOLVE_CMD}

EOF
