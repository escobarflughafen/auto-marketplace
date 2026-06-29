#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  test/postgres-shadow-migration-smoke.sh [--require-postgres-image]

Runs a disposable end-to-end smoke test of the PostgreSQL shadow migration
script. It creates a tiny SQLite DB, starts a temporary app container and a
temporary PostgreSQL container through the compose overlay, loads the export,
and verifies row counts.

The test skips by default if the postgres:16 image is not already available.
Use --require-postgres-image to fail instead of skipping.
USAGE
}

REQUIRE_IMAGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-postgres-image) REQUIRE_IMAGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! docker image inspect postgres:16 >/dev/null 2>&1; then
  if [[ "$REQUIRE_IMAGE" -eq 1 ]]; then
    echo "postgres:16 image is not available." >&2
    exit 1
  fi
  echo "SKIP postgres-shadow-migration-smoke: postgres:16 image is not available."
  exit 0
fi
if ! docker image inspect app-auto-browser >/dev/null 2>&1; then
  echo "app-auto-browser image is not available." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
project="$tmp/project"
app_container="migration-smoke-app-$$"
postgres_container="migration-smoke-postgres-$$"
project_name="migration-smoke-$$"
cleanup() {
  set +e
  (cd "$project" 2>/dev/null && docker compose --project-name "$project_name" --env-file .postgres-migration.env -f docker-compose.yml -f docker-compose.postgres.yml down -v >/dev/null 2>&1)
  docker rm -f "$app_container" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$project/scripts" "$project/ops" "$project/artifacts/marketplace-homepage" "$project/artifacts/postgres-migration"
cp "$repo_root/scripts/export-marketplace-postgres-migration.js" "$project/scripts/"
cp "$repo_root/ops/postgres-prod-shadow-migration.sh" "$project/ops/"
cp "$repo_root/docker-compose.postgres.yml" "$project/"
cat > "$project/package.json" <<'JSON'
{"scripts":{"marketplace:postgres:export":"node scripts/export-marketplace-postgres-migration.js"}}
JSON
cat > "$project/docker-compose.yml" <<YAML
services:
  auto-browser:
    image: app-auto-browser
    container_name: $app_container
    command: ["sleep", "3600"]
    volumes:
      - ./artifacts:/app/artifacts
      - ./scripts:/app/scripts
      - ./package.json:/app/package.json:ro
YAML
cat > "$project/.postgres-migration.env" <<EOF
MARKETPLACE_POSTGRES_DB=marketplace
MARKETPLACE_POSTGRES_USER=marketplace
MARKETPLACE_POSTGRES_PASSWORD=smoke-password
MARKETPLACE_POSTGRES_BIND=127.0.0.1
MARKETPLACE_POSTGRES_PORT=0
MARKETPLACE_POSTGRES_CONTAINER=$postgres_container
COMPOSE_PROJECT_NAME=$project_name
EOF

node - "$project/artifacts/marketplace-homepage/marketplace-homepage.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec(`
  CREATE TABLE smoke_items (
    item_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    attempt INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX idx_smoke_items_title ON smoke_items (title);
`);
const insert = db.prepare('INSERT INTO smoke_items (item_id, title, attempt, note, payload_json) VALUES (?, ?, ?, ?, ?)');
insert.run('item-1', 'Leica M6', 2, 'line one\nline two', JSON.stringify({ ok: true }));
insert.run('item-2', 'Nikon F3', 0, null, '{}');
db.close();
NODE

cd "$project"
docker compose --project-name "$project_name" --env-file .postgres-migration.env -f docker-compose.yml -f docker-compose.postgres.yml up -d auto-browser
ops/postgres-prod-shadow-migration.sh \
  --execute \
  --project-dir "$project" \
  --container "$app_container" \
  --postgres-container "$postgres_container" \
  --env-file .postgres-migration.env \
  --migration-name smoke \
  --sqlite-db /app/artifacts/marketplace-homepage/marketplace-homepage.db

grep -q 'smoke_items' artifacts/postgres-migration/smoke/verify-output.txt
grep -q 'ok' artifacts/postgres-migration/smoke/verify-output.txt
echo "postgres_shadow_migration_smoke_ok project=$project_name"
