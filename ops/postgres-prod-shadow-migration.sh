#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ops/postgres-prod-shadow-migration.sh --execute [options]

Run from the production project directory after syncing the repo. This starts a
separate PostgreSQL container, exports the current SQLite marketplace DB into
COPY artifacts, loads those artifacts into PostgreSQL, and verifies row counts.
It does not switch the app runtime to PostgreSQL.

Options:
  --execute                 Required. Prevents accidental production mutation.
  --project-dir DIR         Project dir. Default: current directory.
  --sqlite-db PATH          SQLite DB path inside auto-browser. Default: /app/artifacts/marketplace-homepage/marketplace-homepage.db
  --container NAME          App container. Default: auto-browser.
  --postgres-container NAME PostgreSQL container. Default: marketplace-postgres.
  --env-file FILE           PostgreSQL env file. Default: .postgres-migration.env.
  --migration-name NAME     Artifact directory under artifacts/postgres-migration.
  --skip-export             Reuse an existing artifact directory.
  --skip-load               Start PostgreSQL and export only.
  --skip-start              Do not start PostgreSQL.
  --drop-existing           Include DROP TABLE statements in generated schema. Default: on.
  --no-drop-existing        Do not include DROP TABLE statements.
  -h, --help                Show this help.
USAGE
}

EXECUTE=0
PROJECT_DIR="$(pwd)"
SQLITE_DB="/app/artifacts/marketplace-homepage/marketplace-homepage.db"
APP_CONTAINER="auto-browser"
POSTGRES_CONTAINER="marketplace-postgres"
ENV_FILE=".postgres-migration.env"
MIGRATION_NAME="prod-$(date -u +%Y%m%dT%H%M%SZ)"
SKIP_EXPORT=0
SKIP_LOAD=0
SKIP_START=0
DROP_EXISTING=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --project-dir) PROJECT_DIR="${2:?Missing value for --project-dir}"; shift 2 ;;
    --sqlite-db) SQLITE_DB="${2:?Missing value for --sqlite-db}"; shift 2 ;;
    --container) APP_CONTAINER="${2:?Missing value for --container}"; shift 2 ;;
    --postgres-container) POSTGRES_CONTAINER="${2:?Missing value for --postgres-container}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --migration-name) MIGRATION_NAME="${2:?Missing value for --migration-name}"; shift 2 ;;
    --skip-export) SKIP_EXPORT=1; shift ;;
    --skip-load) SKIP_LOAD=1; shift ;;
    --skip-start) SKIP_START=1; shift ;;
    --drop-existing) DROP_EXISTING=1; shift ;;
    --no-drop-existing) DROP_EXISTING=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "Refusing to mutate production without --execute." >&2
  usage >&2
  exit 2
fi

cd "$PROJECT_DIR"
if [[ ! -f docker-compose.postgres.yml ]]; then
  echo "Missing docker-compose.postgres.yml in $PROJECT_DIR" >&2
  exit 1
fi
if [[ ! -f scripts/export-marketplace-postgres-migration.js ]]; then
  echo "Missing scripts/export-marketplace-postgres-migration.js in $PROJECT_DIR" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  password="$(LC_ALL=C tr -dc 'A-Za-z0-9_+=' </dev/urandom | head -c 40)"
  cat > "$ENV_FILE" <<EOF
MARKETPLACE_POSTGRES_DB=marketplace
MARKETPLACE_POSTGRES_USER=marketplace
MARKETPLACE_POSTGRES_PASSWORD=$password
MARKETPLACE_POSTGRES_BIND=127.0.0.1
MARKETPLACE_POSTGRES_PORT=25432
MARKETPLACE_POSTGRES_CONTAINER=$POSTGRES_CONTAINER
EOF
  echo "Created $ENV_FILE with a generated local PostgreSQL password."
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
MARKETPLACE_POSTGRES_CONTAINER="${MARKETPLACE_POSTGRES_CONTAINER:-$POSTGRES_CONTAINER}"
export MARKETPLACE_POSTGRES_CONTAINER
set +a

compose() {
  docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.postgres.yml "$@"
}

if [[ "$SKIP_START" -ne 1 ]]; then
  echo "==> Starting separate PostgreSQL service"
  compose up -d marketplace-postgres
  echo "==> Waiting for PostgreSQL health"
  for _ in $(seq 1 60); do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U "$MARKETPLACE_POSTGRES_USER" -d "$MARKETPLACE_POSTGRES_DB" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  docker exec "$POSTGRES_CONTAINER" pg_isready -U "$MARKETPLACE_POSTGRES_USER" -d "$MARKETPLACE_POSTGRES_DB" >/dev/null
fi

MIGRATION_HOST_DIR="artifacts/postgres-migration/$MIGRATION_NAME"
MIGRATION_CONTAINER_DIR="/app/artifacts/postgres-migration/$MIGRATION_NAME"
POSTGRES_MIGRATION_DIR="/migration/$MIGRATION_NAME"

if [[ "$SKIP_EXPORT" -ne 1 ]]; then
  echo "==> Copying migration exporter into $APP_CONTAINER"
  docker cp scripts/export-marketplace-postgres-migration.js "$APP_CONTAINER:/app/scripts/export-marketplace-postgres-migration.js"
  docker cp package.json "$APP_CONTAINER:/app/package.json"
  echo "==> Exporting SQLite DB to $MIGRATION_HOST_DIR"
  export_args=(
    --sqlite-db "$SQLITE_DB"
    --output-dir "$MIGRATION_CONTAINER_DIR"
    --json
  )
  if [[ "$DROP_EXISTING" -eq 1 ]]; then
    export_args+=(--drop-existing)
  fi
  docker exec "$APP_CONTAINER" node /app/scripts/export-marketplace-postgres-migration.js "${export_args[@]}"
fi

if [[ "$SKIP_LOAD" -ne 1 ]]; then
  if [[ ! -f "$MIGRATION_HOST_DIR/001_schema.sql" || ! -f "$MIGRATION_HOST_DIR/002_load.sql" || ! -f "$MIGRATION_HOST_DIR/003_verify.sql" ]]; then
    echo "Migration artifacts are missing under $MIGRATION_HOST_DIR" >&2
    exit 1
  fi
  echo "==> Loading schema into PostgreSQL"
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$MARKETPLACE_POSTGRES_USER" -d "$MARKETPLACE_POSTGRES_DB" < "$MIGRATION_HOST_DIR/001_schema.sql"
  echo "==> Loading data into PostgreSQL"
  sed "s#:DATA_DIR#$POSTGRES_MIGRATION_DIR/data#g" "$MIGRATION_HOST_DIR/002_load.sql" \
    | docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$MARKETPLACE_POSTGRES_USER" -d "$MARKETPLACE_POSTGRES_DB"
  echo "==> Verifying row counts"
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$MARKETPLACE_POSTGRES_USER" -d "$MARKETPLACE_POSTGRES_DB" < "$MIGRATION_HOST_DIR/003_verify.sql" \
    | tee "$MIGRATION_HOST_DIR/verify-output.txt"
  if grep -q 'mismatch' "$MIGRATION_HOST_DIR/verify-output.txt"; then
    echo "PostgreSQL verification reported mismatches." >&2
    exit 1
  fi
fi

echo "postgres_shadow_migration_done migration_dir=$MIGRATION_HOST_DIR postgres_container=$POSTGRES_CONTAINER"
