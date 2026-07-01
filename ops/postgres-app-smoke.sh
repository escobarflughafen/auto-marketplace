#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-.postgres-migration.env}"
IMAGE="${IMAGE:-app-auto-browser:latest}"
CONTAINER="${CONTAINER:-auto-browser-postgres-smoke}"
NETWORK="${NETWORK:-auto-marketplace_default}"
HOST_PORT="${HOST_PORT:-21439}"
ADMIN_TOKEN="${ADMIN_TOKEN:-postgres-smoke-admin}"
READ_TOKEN="${READ_TOKEN:-postgres-smoke-read}"
WORKER_TOKEN="${WORKER_TOKEN:-postgres-smoke-worker}"

cd "$PROJECT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

MARKETPLACE_POSTGRES_DB="${MARKETPLACE_POSTGRES_DB:-marketplace}"
MARKETPLACE_POSTGRES_USER="${MARKETPLACE_POSTGRES_USER:-marketplace}"
MARKETPLACE_POSTGRES_PASSWORD="${MARKETPLACE_POSTGRES_PASSWORD:?MARKETPLACE_POSTGRES_PASSWORD is required}"
MARKETPLACE_POSTGRES_HOST="${MARKETPLACE_POSTGRES_HOST:-marketplace-postgres}"
MARKETPLACE_POSTGRES_URL="${MARKETPLACE_POSTGRES_URL:-postgres://${MARKETPLACE_POSTGRES_USER}:${MARKETPLACE_POSTGRES_PASSWORD}@${MARKETPLACE_POSTGRES_HOST}:5432/${MARKETPLACE_POSTGRES_DB}}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  -p "127.0.0.1:${HOST_PORT}:21435" \
  -e MARKETPLACE_MONITOR_ADMIN_TOKEN="$ADMIN_TOKEN" \
  -e MARKETPLACE_MONITOR_READONLY_TOKEN="$READ_TOKEN" \
  -e MARKETPLACE_REMOTE_WORKER_TOKEN="$WORKER_TOKEN" \
  -e MARKETPLACE_POSTGRES_URL="$MARKETPLACE_POSTGRES_URL" \
  -e MARKETPLACE_DB_DIALECT=postgres \
  -e MARKETPLACE_REMOTE_WORKER_STORE=postgres \
  -e MARKETPLACE_LISTING_READ_STORE=postgres \
  "$IMAGE" \
  npm run marketplace:home:serve -- --host 0.0.0.0 --port 21435 >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)" == "exited" ]]; then
    docker logs --tail 120 "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done

probe() {
  local url="$1"
  if ! curl -fsS "$url" >/dev/null; then
    docker logs --tail 120 "$CONTAINER" >&2 || true
    return 1
  fi
}

probe "http://127.0.0.1:${HOST_PORT}/healthz"
probe "http://127.0.0.1:${HOST_PORT}/api/listings?token=${READ_TOKEN}&limit=1"
probe "http://127.0.0.1:${HOST_PORT}/api/workflows?token=${READ_TOKEN}&reconcile=0&stats=0&config=0"

echo "postgres_app_smoke ok image=${IMAGE} port=${HOST_PORT}"
