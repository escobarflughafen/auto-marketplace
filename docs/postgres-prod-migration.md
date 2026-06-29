# PostgreSQL Production Migration Plan

Goal: move the production marketplace database out of the in-process SQLite file and into a separate PostgreSQL setup without losing data or cutting runtime traffic over before the new store is verified.

## Current State

The application is still SQLite-first. `scripts/marketplace-homepage-db.js` owns schema creation and exports synchronous `DatabaseSync` helpers that are used by collectors, resolvers, the monitor server, maintenance jobs, and tests. The production SQLite DB is mounted at `/app/artifacts/marketplace-homepage/marketplace-homepage.db` and is currently several GB.

Because the runtime is not behind a database adapter yet, the first safe milestone is a PostgreSQL shadow copy: export SQLite schema/data, load it into PostgreSQL, verify counts and representative queries, then add the runtime adapter/cutover in a later step.

## Artifact Export

Generate migration artifacts from a SQLite DB:

```bash
npm run marketplace:postgres:export -- \
  --sqlite-db artifacts/marketplace-homepage/marketplace-homepage.db \
  --output-dir artifacts/postgres-migration/prod-$(date -u +%Y%m%dT%H%M%SZ) \
  --drop-existing
```

The exporter writes:

- `001_schema.sql`: PostgreSQL-compatible tables and indexes introspected from SQLite.
- `002_load.sql`: psql `\copy` commands for TSV data files.
- `003_verify.sql`: row-count verification queries.
- `data/*.tsv`: COPY text data for each exported table.
- `manifest.json`: expected table counts and artifact metadata.

The exporter is dependency-free and uses only `node:sqlite`, so it can run in the existing app image.

## PostgreSQL Load

Provision a separate PostgreSQL database first. Do not point app traffic at it until verification passes.

Example load flow from a host that has access to the artifact directory and `psql`:

```bash
export MARKETPLACE_DATABASE_URL='postgres://marketplace:...@postgres-host:5432/marketplace'
export MIGRATION_DIR=/path/to/artifacts/postgres-migration/prod-YYYYMMDDTHHMMSSZ

psql "$MARKETPLACE_DATABASE_URL" -f "$MIGRATION_DIR/001_schema.sql"
sed "s#:DATA_DIR#$MIGRATION_DIR/data#g" "$MIGRATION_DIR/002_load.sql" | psql "$MARKETPLACE_DATABASE_URL"
psql "$MARKETPLACE_DATABASE_URL" -f "$MIGRATION_DIR/003_verify.sql"
```

Every row in `003_verify.sql` must return `status = 'ok'` before the PostgreSQL store is considered a valid shadow copy.


## Production Shadow Migration Script

After the repo is synced to the production host, the reviewed script can perform the shadow migration end to end:

```bash
cd /srv/auto-browser/app
ops/postgres-prod-shadow-migration.sh --execute
```

The script:

1. Creates `.postgres-migration.env` with a generated local PostgreSQL password if it does not exist.
2. Starts `marketplace-postgres` from `docker-compose.postgres.yml` without changing the running app container.
3. Exports the current production SQLite DB into `artifacts/postgres-migration/<migration-name>`.
4. Loads schema and data into PostgreSQL.
5. Writes row-count verification output to `verify-output.txt`.

Use `--skip-load` to start PostgreSQL and export artifacts without loading, or `--skip-export --migration-name <name>` to retry loading an existing export.

## Cutover Gates

1. PostgreSQL service exists on separate storage with backups configured.
2. Full SQLite export completes without error.
3. PostgreSQL load completes without rejected rows.
4. Verification row counts match every exported table.
5. Representative dashboard/read queries are benchmarked against PostgreSQL.
6. Runtime code has a database adapter for monitor APIs and workers.
7. App can run in read-only PostgreSQL shadow mode for comparison.
8. Writes are cut over only after dual-read or shadow-read checks pass.
9. SQLite file is retained as rollback source until at least one successful backup/restore drill completes.

## Current Limitation

This repository does not yet include the PostgreSQL runtime adapter. The migration exporter creates a verified PostgreSQL shadow copy, but the production app will continue reading/writing SQLite until the adapter and deployment configuration are added and explicitly deployed.
