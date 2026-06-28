# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Playwright-based Facebook Marketplace automation. It scrapes Marketplace listings
(homepage feed and keyword search), stores them in a SQLite database, asynchronously
resolves listing details, and surfaces everything through a local web dashboard with
worker controls. There is also a remote-worker subsystem that lets a separate device
claim/resolve backlog work against a host API and stream results back.

Pure Node.js with almost no dependencies: `playwright` (browser automation) and
`tabulator-tables` (frontend grid). SQLite is the built-in `node:sqlite`
(`DatabaseSync`) — there is no external DB driver. Requires a recent Node (developed
on v25; `node:sqlite` requires Node >= 22). No build step; everything runs from source.

## Commands

```bash
npm install                      # install deps; Playwright Chromium must also be available

# Tests (Node's built-in test runner — there is no `npm test` script)
node --test                      # run the whole suite (test/*.test.js)
node --test test/marketplace-homepage-db.test.js   # run a single test file
npm run test:ui:mock             # UI integration test against a mock server

npm run marketplace:doctor       # local headless readiness + DB preflight
npm run marketplace:home:serve   # start the dashboard (default port 21435; see note)
```

There is no linter configured. The README is the authoritative, exhaustive reference
for the dozens of `marketplace:*` CLI subcommands and their flags — consult it rather
than duplicating flag lists.

Port note: `scripts/serve-marketplace-homepage.js` has a `3080` default in one options
object but the effective runtime default (and Docker/Compose) is **21435** via
`MARKETPLACE_PORT`. Don't trust the README's `3080` claim.

## Architecture

### Data pipeline (the core)
Collection and detail-resolution are deliberately decoupled through a shared SQLite DB
at `artifacts/marketplace-homepage/marketplace-homepage.db`:

1. **Collectors** open Marketplace, scroll, extract listing IDs, and upsert rows as
   `pending`. Three collector entrypoints share most logic:
   - `collect-marketplace-homepage.js` — feed, no query
   - `collect-marketplace-search-explorer.js` — seed query that reseeds from discovered
     titles (a "random walk" over result titles); writes `source='search'`
   - `collect-ebay-search-collector.js` / `collect-goofish-search-explorer.js` — other sites
2. **Resolver** (`process-marketplace-homepage-backlog.js`) claims `pending` rows,
   opens each listing, captures details + screenshots/snapshots, writes results back.
   Sold/pending-sale pages are moved out of the default backlog.
3. **Indexer** (`index-marketplace-resolved-listings.js`) computes derived metadata
   (e.g. normalized listed-time ranges) without launching a browser.
4. **Dashboard** (`serve-marketplace-homepage.js`) serves the API + static frontend and
   manages worker processes.

`scripts/marketplace-homepage-db.js` is the single source of truth for the schema and
all DB access (claim/upsert/status transitions, purchase-history tables, media). Every
script and test goes through its exported functions — do not write ad-hoc SQL elsewhere.

### Workers, events, and the dashboard
- `serve-marketplace-homepage.js` is both the HTTP API and a **process manager**: it
  spawns collector/resolver/indexer/profile-onboarder CLIs as child processes
  ("workflows") and reconciles their lifecycle. Concurrency is bounded per worker type
  (see `ALPHA.md`), not globally single-threaded.
- Worker definitions, types, strategies, and the event registry live in
  `scripts/marketplace-worker-events.js`. Events are written via
  `marketplace-worker-event-writer.js` and stored in the DB (`listing_events`), giving
  the dashboard its audit views. Treat the event registry as a contract — tests assert
  against it (`marketplace-event-registry.test.js`).
- Browser workers share one persistent profile (`./profiles/facebook-marketplace`), so
  the **profile onboarder** (`onboard-marketplace-profile-worker.js`) is intentionally
  exclusive with collectors/resolvers. Dashboard→worker commands flow through files
  under `artifacts/marketplace-homepage/worker-commands/` via
  `marketplace-worker-command-channel.js` (no direct IPC).
- Frontend (`frontend/marketplace-monitor/`) is vanilla JS + Tabulator. Critical design
  rule it already follows: worker-control polling is split from form state — it loads
  static workflow config once, polls lightweight status, and only fetches expensive
  per-worker stats/events when a detail pane is open. Preserve that separation.

### Auth
`scripts/marketplace-profile-auth.js` centralizes the four auth modes
(`required` / `credentials` / `optional` / `none`) shared by all browser commands.
Credentials come from `credentials.json` locally or `secrets/credentials.json` in
Docker. `marketplace-utils.js` holds the shared Playwright helpers (safe navigation
with retry on known transient errors, page-ready waits, "see more" expansion,
Chromium args).

### KQL-lite query language
The dashboard's filter box is a small KQL-like language implemented as a pipeline of
`scripts/lite-kql-*.js` modules: tokenizer → parser → planner → sqlite (with
`-fields` for schema and `-authoring` for autocomplete). Query strings are compiled to
parameterized SQL — keep that boundary; never string-interpolate user query input.

### Remote worker subsystem
`scripts/remote-worker-*.js` is a separable runtime: a device runs
`remote-worker-runtime.js`, authenticates to the host API
(`remote-worker-api-client.js` / `-auth.js`), claims listing batches, resolves them
locally, and ships events + artifacts back through a local outbox/spool
(`remote-worker-local-store.js`, `worker-local-outbox.js`) with ack/retry. Contracts
are pinned in `remote-worker-contracts.js` and covered by dedicated tests.

## Conventions

- Tests use `node:test` + `node:assert/strict`, one `*.test.js` per module, and operate
  on temp SQLite DBs / mock servers (no network, no real browser). New DB/worker
  behavior is expected to come with a test in this style.
- Scripts are flat CommonJS in `scripts/`, named `<verb>-marketplace-<thing>.js`, each
  with its own arg parser and `usage()`. Shared logic is factored into the non-`collect`/
  `process` modules (`marketplace-homepage-db.js`, `marketplace-utils.js`,
  `marketplace-profile-auth.js`, `marketplace-worker-events.js`).
- Generated/runtime data lives under `artifacts/` (DB, logs, screenshots, snapshots,
  worker-commands) and `output/`; these are not source.
- The `marketplace:collect` / `marketplace:poll` / `marketplace:capture` commands are
  **deprecated** file-based legacy collectors that bypass the SQLite system. Prefer the
  DB-backed `home:collect` / `search:explore` / `home:process` pipeline for new work.

## Deployment

Dockerized (`Dockerfile` on the Playwright base image; `docker-compose.yml` defines
`auto-browser` and `auto-browser-staging`). The container's default command is the
dashboard on `0.0.0.0:21435`. `ops/` holds Ubuntu host bootstrap, service-user setup,
and `migrate-marketplace-runtime-to-remote.sh` (dry-run by default; `--execute` to
sync source + runtime to the remote host and restart Compose). See
`docs/remote-migration.md` and `docs/marketplace-db-maintenance.md`.
