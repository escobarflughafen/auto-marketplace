#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy-marketplace.sh <static|app|full> [options]

Modes:
  static  Sync source and hot-copy frontend assets into the running container.
          No restart, no token rotation.
  app     Sync source, hot-copy app/server files, then restart the container.
          Use for server JS changes that do not need dependency/image rebuilds.
  full    Sync source and run docker compose up with build/recreate.
          Use for dependencies, Dockerfile, or runtime image changes.

Options:
  --allow-dirty       Allow deploy from a dirty worktree.
  --skip-sync         Do not rsync source before applying the mode.
  --config FILE       Deploy config. Default: MARKETPLACE_DEPLOY_CONFIG or .marketplace-deploy.env
  --host HOST         SSH target. Overrides MARKETPLACE_DEPLOY_HOST from config/env.
  --remote-dir DIR    Remote app directory. Overrides MARKETPLACE_DEPLOY_DIR from config/env.
  --container NAME    Docker container. Overrides MARKETPLACE_CONTAINER from config/env.
  --port PORT         Remote localhost port. Overrides MARKETPLACE_PORT from config/env.
  -h, --help          Show this help.
USAGE
}

MODE="${1:-}"
if [[ -z "$MODE" || "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

case "$MODE" in
  static|app|full) ;;
  *)
    echo "Unknown deploy mode: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac

ALLOW_DIRTY=0
SKIP_SYNC=0
CONFIG_FILE="${MARKETPLACE_DEPLOY_CONFIG:-.marketplace-deploy.env}"
CLI_REMOTE_HOST=""
CLI_REMOTE_DIR=""
CLI_CONTAINER=""
CLI_PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --skip-sync)
      SKIP_SYNC=1
      shift
      ;;
    --config)
      CONFIG_FILE="${2:?Missing value for --config}"
      shift 2
      ;;
    --host)
      CLI_REMOTE_HOST="${2:?Missing value for --host}"
      shift 2
      ;;
    --remote-dir)
      CLI_REMOTE_DIR="${2:?Missing value for --remote-dir}"
      shift 2
      ;;
    --container)
      CLI_CONTAINER="${2:?Missing value for --container}"
      shift 2
      ;;
    --port)
      CLI_PORT="${2:?Missing value for --port}"
      shift 2
      ;;
    -h|--help)
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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

REMOTE_HOST="${CLI_REMOTE_HOST:-${MARKETPLACE_DEPLOY_HOST:-}}"
REMOTE_DIR="${CLI_REMOTE_DIR:-${MARKETPLACE_DEPLOY_DIR:-}}"
CONTAINER="${CLI_CONTAINER:-${MARKETPLACE_CONTAINER:-auto-browser}}"
PORT="${CLI_PORT:-${MARKETPLACE_PORT:-21435}}"

if [[ -z "$REMOTE_HOST" || -z "$REMOTE_DIR" ]]; then
  echo "Missing deploy target." >&2
  echo "Set MARKETPLACE_DEPLOY_HOST and MARKETPLACE_DEPLOY_DIR in $CONFIG_FILE, export them, or pass --host and --remote-dir." >&2
  exit 1
fi

run_preflight() {
  echo "==> Running deploy preflight"
  git diff --check

  local status
  status="$(git status --porcelain --untracked-files=all)"
  if [[ -n "$status" && "$ALLOW_DIRTY" -ne 1 ]]; then
    echo "Refusing to deploy from a dirty worktree." >&2
    echo "Commit/stash changes or rerun with --allow-dirty for an intentional hot patch." >&2
    echo "$status" >&2
    exit 1
  fi
  if [[ -n "$status" ]]; then
    echo "Warning: deploying from a dirty worktree because --allow-dirty was set." >&2
    echo "$status" >&2
  fi

  node --check frontend/marketplace-monitor/app.js
  if [[ "$MODE" != "static" ]]; then
    node --check scripts/serve-marketplace-homepage.js
    node --check scripts/marketplace-homepage-db.js
    if [[ -f scripts/worker-scheduler.js ]]; then
      node --check scripts/worker-scheduler.js
    fi
  fi
}

sync_source() {
  if [[ "$SKIP_SYNC" -eq 1 ]]; then
    echo "==> Skipping source sync"
    return
  fi

  echo "==> Syncing source to $REMOTE_HOST:$REMOTE_DIR"
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude artifacts \
    --exclude profiles \
    --exclude output \
    --exclude credentials.json \
    --exclude secrets \
    --exclude .env \
    --exclude .DS_Store \
    --exclude raw \
    --exclude = \
    ./ "$REMOTE_HOST:$REMOTE_DIR/"
}

deploy_static() {
  echo "==> Hot-copying frontend assets into $CONTAINER"
  ssh "$REMOTE_HOST" "docker cp '$REMOTE_DIR/frontend/marketplace-monitor/.' '$CONTAINER:/app/frontend/marketplace-monitor/'"
}

deploy_app() {
  echo "==> Hot-copying app files into $CONTAINER"
  ssh "$REMOTE_HOST" "docker cp '$REMOTE_DIR/frontend/marketplace-monitor/.' '$CONTAINER:/app/frontend/marketplace-monitor/' && docker cp '$REMOTE_DIR/scripts/.' '$CONTAINER:/app/scripts/' && docker cp '$REMOTE_DIR/package.json' '$CONTAINER:/app/package.json' && if [ -f '$REMOTE_DIR/package-lock.json' ]; then docker cp '$REMOTE_DIR/package-lock.json' '$CONTAINER:/app/package-lock.json'; fi"
  echo "==> Restarting $CONTAINER"
  ssh "$REMOTE_HOST" "cd '$REMOTE_DIR' && docker compose restart '$CONTAINER'"
}

deploy_full() {
  echo "==> Rebuilding and recreating $CONTAINER"
  ssh "$REMOTE_HOST" "cd '$REMOTE_DIR' && docker compose up -d --build --force-recreate '$CONTAINER'"
}

verify_remote() {
  echo "==> Verifying remote service"
  ssh "$REMOTE_HOST" "curl -fsS 'http://127.0.0.1:$PORT/healthz' >/dev/null"
  ssh "$REMOTE_HOST" "curl -fsS 'http://127.0.0.1:$PORT/' | grep -q '<title>Marketplace Monitor</title>'"
  echo "Remote health check passed."
}

run_preflight
sync_source

case "$MODE" in
  static) deploy_static ;;
  app) deploy_app ;;
  full) deploy_full ;;
esac

verify_remote

if [[ "$MODE" == "static" ]]; then
  echo "Static deploy complete. Container was not restarted."
else
  echo "Deploy complete. If tokens are not set in the remote .env, restart-generated URLs may have changed."
  ssh "$REMOTE_HOST" "docker logs --tail 40 '$CONTAINER' 2>&1 | grep -E 'Admin URL|Read-only URL' | tail -2" || true
fi
