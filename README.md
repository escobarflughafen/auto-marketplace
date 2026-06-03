# Auto Browser

Playwright-based Facebook Marketplace automation.

Current command surface:

- `marketplace`: interactive browser workflow, headed by default
- `marketplace:doctor`: headless readiness and DB preflight check
- `marketplace:help`: print the interactive Marketplace command help
- `marketplace:collect`: deprecated legacy keyword collector, headless by default
- `marketplace:poll`: deprecated legacy multi-keyword collector, headless by default
- `marketplace:capture`: deprecated legacy listing-detail capture helper
- `marketplace:auth:bootstrap`: refresh a persistent Facebook browser profile from credentials
- `marketplace:auth:headless-onboard`: headless credential/profile onboarding helper
- `marketplace:auth:profile-onboarder`: interactive dashboard-driven profile onboarding worker
- `marketplace:credentials:import`: import or update credential profiles for the monitor
- `marketplace:home:collect`: homepage collector backed by a SQLite queue
- `marketplace:search:explore`: search collector that reseeds from discovered titles
- `marketplace:home:process`: backlog worker that visits queued listings for details
- `marketplace:home:index`: non-browser backlog indexer for derived resolved-listing metadata
- `marketplace:home:backlog:indexes`: read-only backlog index/ordering preview tool
- `marketplace:home:db:maintain`: SQLite optimize/checkpoint/report command for scheduled maintenance
- `marketplace:home:db:merge`: merge another homepage SQLite database into the active store
- `marketplace:home:tier3:dry-run`: local verdict dry-run over resolved detail artifacts
- `marketplace:home:serve`: local Tabulator-based management UI for browsing rows and controlling workers
- `history:normalize-inventory`: normalize purchase-history inventory rows from the CSV schema

## Requirements

- Node.js
- npm dependencies installed:

```bash
npm install
```

- A reusable Facebook Marketplace browser profile at:

```bash
./profiles/facebook-marketplace
```

## Main Commands

Open Marketplace in a visible browser:

```bash
npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace
```

Open Marketplace, run a query, and keep the browser open:

```bash
npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace --query "zeiss ze 50 1.4"
```

Open Marketplace and switch the Marketplace location to Ottawa before browsing:

```bash
npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace --location "Ottawa, Ontario"
```

Open Marketplace around Bellingham with a 10-mile search radius:

```bash
npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace --location "Bellingham, Washington" --radius-miles 10
```

Run the same query continuously in the visible browser:

```bash
npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace --query "zeiss ze 50 1.4" --scrolls 5 --loop-seconds 60
```

Deprecated legacy: continuous headless collection for one keyword:

```bash
npm run marketplace:collect -- --query "zeiss ze 50 1.4" --area vancouver --max-items-per-cycle 100 --refresh-minutes 30
```

Continuous headless collection plus listing detail capture:

```bash
npm run marketplace:collect -- --query "zeiss ze 50 1.4" --area vancouver --max-items-per-cycle 100 --refresh-minutes 30 --detail-limit 20
```

Deprecated legacy: continuous multi-keyword collection with repeated query flags:

```bash
npm run marketplace:poll -- --query "zeiss ze 50 1.4" --query "contax 645" --query "pentax 67" --area vancouver --max-items-per-query-cycle 100 --refresh-minutes 30 --detail-limit 20
```

Deprecated legacy: continuous multi-keyword collection from a file:

```bash
npm run marketplace:poll -- --keywords-file keywords.marketplace.example.txt --area vancouver --max-items-per-query-cycle 100 --refresh-minutes 30 --detail-limit 20
```

Continuous homepage collection without keyword search:

```bash
npm run marketplace:home:collect -- --once
```

Homepage collection bootstrapped from `credentials.json`, polling the top `15` homepage items:

```bash
npm run marketplace:home:collect -- --use-credentials --max-items 15
```

Homepage collection with no top-N cap, collecting all visible homepage items until results stop growing or the runtime limit hits:

```bash
npm run marketplace:home:collect -- --use-credentials --collect-all --max-runtime-seconds 180
```

Homepage collection for just the first loaded homepage content, with no active scrolling:

```bash
npm run marketplace:home:collect -- --use-credentials --first-load-only --initial-load-wait-ms 5000 --max-items 15
```

Homepage collection from the Ottawa route slug:

```bash
npm run marketplace:home:collect -- --use-credentials --location "Ottawa, Ontario" --once --max-items 15
```

Search-driven exploration starting from one seed keyword, collecting all visible results, then re-querying from discovered titles:

```bash
npm run marketplace:search:explore -- --use-credentials --query "leica m6" --collect-all
```

Search-driven exploration with bounded results and configurable reseed cadence:

```bash
npm run marketplace:search:explore -- --use-credentials --query "nikon d850" --max-items 100 --refresh-seconds 90 --reseed-round-min 10 --reseed-round-max 20
```

Search-driven exploration from a round-robin seed list, with two random-walk
queries between each seed:

```bash
npm run marketplace:search:explore -- --use-credentials --queries "leica m6, nikon d850, pentax 67" --random-walks-between-seeds 2 --collect-all
```

In round-robin mode, the worker searches one seed entry, collects listings,
then chooses each random-walk query from a random title collected in the
immediately previous round. If that round produced no usable title, it falls
back to the existing global title bag, then back to the next seed.

Search-driven exploration in Ottawa, using the Ottawa route slug and attempting the UI location picker when Facebook exposes it:

```bash
npm run marketplace:search:explore -- --use-credentials --query "nikon d850" --area ottawa --location "Ottawa, Ontario" --max-items 100 --once
```

Search-driven exploration around Bellingham, Washington within 10 miles:

```bash
npm run marketplace:search:explore -- --use-credentials --query "canon 85 1.4" --location "Bellingham, Washington" --radius-miles 10 --max-items 100 --once
```

Run a local preflight for the DB-backed headless pipeline:

```bash
npm run marketplace:doctor
```

Refresh the persistent Facebook session used by remote/headless workers:

```bash
npm run marketplace:auth:bootstrap -- --auth-mode credentials --headless
```

If Facebook requires notification approval, 2FA, or another checkpoint, run the
bootstrap in a headed browser on the Ubuntu host or refresh the mounted
`profiles/facebook-marketplace` profile before starting headless workers.

Run the interactive profile onboarding worker when login needs operator input
from the dashboard:

```bash
npm run marketplace:auth:profile-onboarder -- --credentials-profile default --headed --login-timeout-seconds 900
```

The profile onboarder is a managed worker type in the web monitor. It emits
login-step events and worker screenshots, then accepts dashboard commands for
verification-code submission, external checkpoint continuation, credential
retry, and cancel. Commands are appended under
`artifacts/marketplace-homepage/worker-commands/` for the worker to consume. It
uses the same browser profile as other browser workers and is intentionally
exclusive with collector/resolver runs while active.

Run collection without requiring Facebook authentication:

```bash
npm run marketplace:home:collect -- --auth-mode none --once --max-items 15
npm run marketplace:search:explore -- --auth-mode none --query "nikon d850" --max-items 50 --once
```

Auth modes shared by homepage collection, search exploration, and backlog
processing:

- `required`: reuse an already signed-in persistent profile; fail if logged out
- `credentials`: reuse the profile or log in from `credentials.json`; fail if still logged out
- `optional`: try profile/credentials, then continue unauthenticated if login fails
- `none`: skip login checks and browse as a public/unauthenticated session

Backlog processing for homepage-found listings:

```bash
npm run marketplace:home:process -- --once
```

Resolve the current eligible backlog and exit after pending/retryable rows are drained or the run limit is reached:

```bash
npm run marketplace:home:process -- --drain --batch-size 5 --limit 50
```

Run a continuous resolver for search-discovered pending rows, with jitter between listing detail visits:

```bash
npm run marketplace:home:process -- --status-filter pending --source-filter search --item-delay-seconds 8 --item-jitter-min 0.5 --item-jitter-max 1.5
```

Resolve the newest eligible rows first, using `last_seen_at` as the time index and a bounded seen-time window:

```bash
npm run marketplace:home:process -- --drain --backlog-order latest --seen-time-field last_seen --seen-after 2026-05-09T00:00:00.000Z --seen-before 2026-05-10T00:00:00.000Z
```

By default the resolver records sold or pending-sale Marketplace signals as `sold` / `pending_sale` and bypasses further processing for those rows. To manually revisit those rows:

```bash
npm run marketplace:home:process -- --status-filter sold --resolve-inactive --once
```

Preview the installed backlog indexes and the rows a resolver would claim for a selected ordering:

```bash
npm run marketplace:home:backlog:indexes -- --backlog-order earliest --seen-time-field first_seen --status-filter pending --limit 20
```

Run the non-browser backlog indexer that computes derived metadata for resolved
listings:

```bash
npm run marketplace:home:index -- --once --limit 250
```

Without `--once`, the backlog indexer loops with jittered sleeps. The first
implementation refreshes normalized listed-time fields from resolved listing
detail text; it does not open Facebook or lease the browser profile.

Run lightweight SQLite maintenance without starting any worker:

```bash
npm run marketplace:home:db:maintain
```

Use `--dry-run` for a DB/WAL/row-count report, `--analyze` for a statistics refresh, and reserve `--vacuum` for quiet manual maintenance windows. See `docs/marketplace-db-maintenance.md` for cron and macOS LaunchAgent examples.

Recover resolver claims left in `processing` after a deploy, crash, or manual
restart:

```bash
npm run marketplace:home:db:maintain -- --recover-stale-processing --stale-processing-seconds 1800 --dry-run
```

Run a Tier 3-style verdict dry run over resolved detail artifacts:

```bash
npm run marketplace:home:tier3:dry-run -- --listing-id 4444173605902543 --json
npm run marketplace:home:tier3:dry-run -- --history-csv examples/trading-history.example.csv --limit 5 --json
```

The dry run normalizes the resolved detail text, infers a product profile, checks artifact quality, scores fit/value/actionability/risk against a configurable history profile, and emits a structured `escalate` / `watch` / `skip` / `stale` verdict. Use `--history-csv trading-history.csv` for the preferred personal trading-history format, or `--history-profile profile.json` for the older JSON profile. The CSV schema lives at `schemas/trading-history.schema.csv`; see `docs/trading-history-csv.md`.

Migrate local source plus collected Marketplace runtime data to the remote server:

```bash
ops/migrate-marketplace-runtime-to-remote.sh
ops/migrate-marketplace-runtime-to-remote.sh --execute
```

The migration script defaults to dry-run. With `--execute`, it checkpoints the local SQLite DB, creates a timestamped remote backup of `artifacts/marketplace-homepage`, syncs source and runtime artifacts to `10.10.20.3:/srv/auto-browser/app`, rebuilds/restarts Docker Compose, and runs remote DB maintenance. It excludes credentials, browser profiles, `.git`, dependencies, and other non-runtime generated folders from the source sync.

For a least-privileged Ubuntu deployment user, copy and run this once on the server:

```bash
sudo ops/ubuntu-create-auto-browser-user.sh
```

That creates an `auto-browser` service user, grants Docker group access, owns `/srv/auto-browser/app`, and does not grant passwordless sudo.

For a fresh Ubuntu host, use the deployment bootstrap instead after the project
files are present on the server:

```bash
sudo ops/ubuntu-deploy-auto-browser.sh
```

It installs/verifies Docker Engine and the Compose plugin, creates the service
user and runtime directories, builds/starts the Compose service, waits for the
HTTP API, runs `marketplace:doctor` in the container, and runs SQLite
maintenance. Pass `--credentials-source /path/to/credentials.json` to install
the credential file into `secrets/credentials.json`.

Once the server bootstrap/user setup is complete, migrate from local as the
service user:

```bash
ops/migrate-marketplace-runtime-to-remote.sh --execute --remote-user auto-browser
```

The migration script also performs a remote preflight, `/healthz` health check, container
doctor, and DB maintenance after restart. See `docs/remote-migration.md` for the
full Ubuntu service-user migration process, including Docker container-name
conflict cleanup when moving from an older project path to
`/srv/auto-browser/app`.

Browse the homepage database in a local web UI:

```bash
npm run marketplace:home:serve
```

The management UI is served from `frontend/marketplace-monitor/`; `scripts/serve-marketplace-homepage.js` provides the API, static file serving, Tabulator assets, and managed worker process controls.
The UI keeps workflow drafts client-side, separates static workflow definitions from polling state, and exposes worker audit views from `listing_events`. Selecting a worker opens an exclusive detail view with a status table, event-type picker, grouped done/skipped/error/started event tables, interactive profile-onboarder controls when applicable, text history, and the latest worker POV screenshot when available.

At startup the monitor issues an admin URL and a read-only URL unless tokens are provided with `MARKETPLACE_MONITOR_ADMIN_TOKEN` and `MARKETPLACE_MONITOR_READONLY_TOKEN` or with `--admin-token` and `--read-only-token`. The frontend carries the `?token=...` query parameter into API calls. API clients may also use `X-API-Token` or `Authorization: Bearer <token>`.
If the page is opened without `token` or `apiToken`, the monitor shows an access warning banner and does not load token-protected data.

Export all homepage DB rows to JSON:

```bash
npm run marketplace:home:export
```

## Headed vs Headless

- `npm run marketplace` is headed by default unless you pass `--headless`
- `npm run marketplace:doctor` is local-only and checks headless Chromium startup unless you pass `--skip-browser-launch`
- `npm run marketplace:collect` is headless by default
- `npm run marketplace:poll` is headless by default
- `npm run marketplace:home:collect` is headless by default
- `npm run marketplace:search:explore` is headless by default
- `npm run marketplace:home:process` is headless by default
- `npm run marketplace:home:index` does not launch a browser
- `npm run marketplace:auth:profile-onboarder` is headless by default, but is commonly run headed from the dashboard when operator interaction is needed
- `scripts/extract-marketplace-results.js` is headless by default
- `scripts/capture-marketplace-posts.js` is headless by default

## Deprecated Legacy Modules

These commands are still available for compatibility, but they are now deprecated because they are file-based and do not write into the shared SQLite system:

- `npm run marketplace:collect`
- `npm run marketplace:poll`
- `npm run marketplace:capture`
- `node scripts/extract-marketplace-results.js`
- `npm run marketplace:poll:mamiya-645af`

Preferred DB-backed replacements:

- one seed keyword with iterative exploration: `npm run marketplace:search:explore -- --query "<seed keyword>"`
- homepage-only discovery: `npm run marketplace:home:collect`
- async detail processing: `npm run marketplace:home:process`

## What The Collector Does

For each cycle, the collector:

- searches Marketplace for the keyword
- scrolls and merges unique result cards
- keeps collecting until one of these happens:
  - `100` listings collected for the cycle
  - `30` minutes elapsed for the cycle
  - results stop growing after repeated passes
- refreshes immediately if it hit the item cap
- otherwise sleeps until the refresh timer and starts the next cycle

The default continuous command is:

```bash
npm run marketplace:collect -- --query "zeiss ze 50 1.4" --area vancouver --max-items-per-cycle 100 --refresh-minutes 30
```

## What The Multi-Keyword Poller Does

For each round, the poller:

- loads keywords from repeated `--query` flags and/or `--keywords-file`
- processes keywords one by one
- runs the same bounded collection flow used by the single-keyword collector for each keyword
- collects up to the per-keyword cycle cap, currently `100`
- writes per-keyword `results.json` and `summary.md`
- updates shared `state.json` so already-seen listing IDs are tracked across rounds
- refreshes immediately if any keyword hit the item cap
- otherwise sleeps until the refresh timer and starts the next round

## What The Homepage Pipeline Does

The homepage pipeline is split into two small pieces so detail capture can run asynchronously from collection:

- `marketplace:home:collect` opens Marketplace home without a query
- scrolls until it has the first `10` unique listing links or the result set stops growing
- can optionally collect all visible homepage items with `--collect-all`
- can optionally avoid scrolling entirely with `--first-load-only` and wait for the initial homepage payload to settle
- extracts the Marketplace listing ID from each link
- upserts those rows into a SQLite database and marks unseen or retryable rows as `pending`
- reports whether each polled row was `new`, `existing_same`, or `existing_updated`
- `marketplace:home:process` claims pending rows from the same database
- opens each listing URL in the browser, expands the page, captures details, and writes the results back into the database
- can run once, continuously, or in drain mode with `--drain` to resolve the eligible backlog and exit
- can restrict work by queue status, source, and keyword; continuous runs can add jittered polling and jittered delay between listing visits
- can start from the priority/rank order, latest seen rows, or earliest seen rows
- can bound eligible rows by `first_seen_at` or `last_seen_at` with `--seen-after` and `--seen-before`
- detects sold/pending-sale detail pages and moves them out of the default backlog unless `--resolve-inactive` is set
- records richer detail events including availability, seller rating, seller joined date, previous price, extraction completeness, screenshot paths, and snapshot paths
- compares stable detail content instead of volatile raw page text before writing `content_changed` events
- `marketplace:home:index` computes derived metadata from resolved rows, starting with normalized listed-time ranges
- purchase-history matching scans resolved and recently discovered rows incrementally, queues candidate matches below the purchase-price threshold, and records save/dismiss decisions as events
- collector sleep between polls is jittered by default between `25%` and `150%` of `--refresh-seconds`
- `marketplace:home:serve` exposes the same SQLite DB in a local browser UI with KQL-lite filtering, remote table sorting, worker controls, recommendations, and per-worker audit views

## What The Search Explorer Does

The search explorer uses the same SQLite DB and browser profile, but changes how discovery happens:

- `marketplace:search:explore` starts from a required seed query via `--query`
- can also start from a seed list via `--queries`, separated by commas, semicolons, or newlines
- when `--queries` or `--random-walks-between-seeds` is used, seed entries run round-robin
- `--random-walks-between-seeds <n>` controls how many collected-title random walks run before the next seed entry
- collects visible Marketplace search-result cards into the shared SQLite DB with `source='search'`
- stores the active search term on each row as `source_keyword`
- records listing-to-keyword associations in a separate keyword index table
- adds collected result titles into a reusable search-title bag
- in legacy single-query mode, later rounds still pick a random bag entry as the next query
- in legacy single-query mode, it automatically falls back to the seed query again every `--reseed-round-min` to `--reseed-round-max` rounds
- keeps all timing, scrolling, bag, and reseed behavior configurable through CLI arguments

## Location Behavior

Homepage location is controlled most reliably by the Marketplace route slug, for example `/marketplace/ottawa/`. A controlled homepage test on 2026-05-10 confirmed that `--location "Ottawa, Ontario"` reaches the Ottawa homepage route, while the homepage DOM did not expose a reliable location/radius picker and radius selection failed for `10` miles.

Operational guidance:

- use `--location "<city, region>"` for homepage collection so the collector navigates to the inferred route slug
- treat `--radius-miles` as best-effort on homepage routes
- search and interactive flows still attempt the UI location/radius controls when Facebook exposes them
- location test artifacts are written under `artifacts/marketplace-homepage/location-tests/`

Run them in separate terminals if you want continuous collection and continuous detail processing at the same time:

```bash
npm run marketplace:home:collect
npm run marketplace:home:process
```

## Output Files

Continuous collector output goes under:

```bash
artifacts/marketplace-keyword-collector/
```

Multi-keyword poller output goes under:

```bash
artifacts/marketplace-poll/
```

Homepage pipeline output goes under:

```bash
artifacts/marketplace-homepage/
```

Each cycle writes a timestamped folder like:

```text
artifacts/marketplace-keyword-collector/<timestamp>/<query-slug>/
```

Typical files:

- `results.json`
- `summary.md`
- `details/` if `--detail-limit` is used
- `state.json` under the collector root
- `collector.log` under the collector root

Homepage pipeline files:

- `marketplace-homepage.db`
- `latest-cycle.json`
- `homepage-collector.log`
- `search-explorer.log`
- `homepage-backlog.log`
- `details/`
- `resolve-batches/`
- `worker-screenshots/`
- `worker-commands/`
- `profile-onboarding/`

## Homepage Browser

Start the local browser UI with:

```bash
npm run marketplace:home:serve
```

Default address:

```text
http://127.0.0.1:3080
```

Supported server flags:

- `--host <host>`
- `--port <port>`
- `--db-path <file>`

Current UI layout:

- header summary with queue counts, refresh state, and one-row overview cells that navigate to matching panels
- one compact workspace surface below the header
- Listings view backed by Tabulator remote pagination and remote sorting over `/api/listings`
- Listings subtabs for result rows, resolve queue, and resolve queue audit
- KQL/query-builder filters plus shortcut filters, row-count controls, and URL-backed query routing
- backlog resolve actions from the Listings table: single-row Fetch, Resolve Selected, and Resolve All In View
- consistent listing row/card/detail components with resolver status, fetch/update actions, artifacts, and Markdown snapshot rendering
- Trade & Match view for purchase history plus a Recommendations subtab
- Recommendations table with paging, row-click detail modal, save/dismiss actions, rejection reasons, resolved-only filter, and randomized Match Mode cards with a preloaded queue
- Audit Logs view backed by Tabulator with paging plus detail modal output in JSON and syslog-style text
- Worker Control split into two columns: workflow settings on the left, command preview and action buttons on the right
- Worker type selector for collector, search explorer, resolver, backlog indexer, and profile onboarder
- Worker Overview table that stays fully viewable below the control panel
- centered worker inspector with current status, event category tables, text history, and latest screenshot preview

Worker Control polling is intentionally split from form state. The frontend loads static workflow definitions from `/api/workflows/config`, polls `/api/workflows?reconcile=0&stats=0` for lightweight runtime status, and only loads expensive per-worker stats/events when a worker detail pane is open. This keeps typing in fields from jumping the page and keeps the worker pane from doing full event/stat fetches before the operator asks for them.

Query examples:

- `listings | where title contains "m6" and price >= 500 | sort by last_seen_at desc`
- `listings | where status == "pending" and source == "search"`
- `recommendations | where status == "queued" and score >= 80`
- `events | where event_type contains "resolve" | sort by created_at desc`
- Legacy shortcut syntax is still accepted for listings, such as `status:pending leica`, `title:"m6 classic"`, `price:500-1500`, `before:<iso>`, `after:<iso>`, and `sort:rank`.

The query UI has a multiline KQL-lite editor with syntax highlighting and
autocomplete plus a compact one-line mode for other panels. Universal
suggestions, table names, operators, and table-specific fields are resolved in
the browser first; `/api/query/complete` remains available as a backend assist
for server-known fields. Query links can route directly to the relevant panel,
for example Listings, Trade & Match Recommendations, or Audit Logs.

Autocomplete currently knows these source schemas:

- `listings`: `id`, `status`, `source`, `keyword`, `title`, `text`, `seller`, `location`, `condition`, `price`, `rank`, `attempts`, `last_seen_at`, `first_seen_at`, `completed_at`
- `recommendations`: `status`, `score`, `created_at`
- `workers`: `status`, `worker_type`, `started_at`
- `events`: `worker_type`, `event_type`, `created_at`

Supported query fields:

- `status:`
- `title:`
- `text:`
- `seller:`
- `location:`
- `price:`
- `rank:`
- `before:`
- `after:`
- `sort:`

API endpoints used by the frontend:

- `GET /api/summary`
- `GET /api/query-fields`
- `POST /api/query/complete`
- `GET /api/listings?q=<query>&limit=<n>&offset=<n>&sort=<field>&sortDir=<asc|desc>`
- `POST /api/listings/manual`
- `POST /api/listings/resolve`
- `GET /api/listings/resolver-status?listingId=<id>`
- `GET /api/backlog`
- `GET /api/resolve-queue`
- `POST /api/resolve-queue`
- `DELETE /api/resolve-queue`
- `POST /api/resolve-queue/run`
- `GET /api/purchase-history`
- `POST /api/purchase-history`
- `GET /api/purchase-history/documents`
- `POST /api/purchase-history/documents`
- `GET /api/purchase-history/export`
- `POST /api/purchase-history/import`
- `POST /api/purchase-history/merge`
- `POST /api/purchase-history/listing-links`
- `GET /api/purchase-history/events`
- `GET /api/purchase-history-match-queue`
- `GET /api/purchase-history-match-queue/matches`
- `POST /api/purchase-history-match-queue/action`
- `POST /api/purchase-history-match-queue/scan`
- `GET /api/events`
- `GET /api/workflows/config`
- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows/start`
- `POST /api/workflows/stop`
- `POST /api/workflows/reconcile`
- `GET /api/workflows/:id/stats`
- `GET /api/workflows/:id/events?category=done|skipped|error|started|all&limit=50`
- `POST /api/workflows/:id/commands`
- `GET /api/credentials`
- `POST /api/credentials`
- `POST /api/credentials/active`
- `GET /files/<artifact-path>`

## Data Format

`results.json` contains a cycle summary like:

```json
{
  "query": "zeiss ze 50 1.4",
  "area": "vancouver",
  "capturedAt": "2026-03-30T12:34:56.000Z",
  "totalResults": 100,
  "newResults": 27,
  "detailCaptures": 20,
  "hitItemLimit": true,
  "items": [
    {
      "href": "https://www.facebook.com/marketplace/item/123",
      "text": "Zeiss ZE 50mm f/1.4 CA$800 Vancouver ..."
    }
  ],
  "freshItems": [
    "https://www.facebook.com/marketplace/item/123"
  ]
}
```

If listing detail capture is enabled, captured items can also include:

- `screenshotPath`
- `snapshotPath`
- `thumbnails`
- `listingContent`

Each `thumbnails` entry looks like:

```json
{
  "src": "https://...",
  "alt": "thumbnail alt text",
  "width": 96,
  "height": 96,
  "screenshotPath": "/abs/path/to/thumb.png"
}
```

## Listing Capture Artifacts

When listing detail capture runs, each listing can produce:

- one full-page listing screenshot
- multiple thumbnail screenshots from the listing gallery
- one Markdown snapshot record

## Logging

- `marketplace` prints progress to stdout/stderr
- extraction and capture scripts print timestamped activity logs to stderr
- collector logs are appended to `collector.log`

## Useful Flags

For `marketplace`:

- `--manual-login`
- `--user-data-dir ./profiles/facebook-marketplace`
- `--auth-mode required|credentials|optional|none` for DB-backed commands
- `--unauthenticated` / `--no-auth` as aliases for `--auth-mode none`
- `--query "<text>"`
- `--scrolls <count>`
- `--loop-seconds <secs>`
- `--loop-count <n>`
- `--headless`
- `--exit-after-setup`

For `marketplace:doctor`:

- `--db-path <file>`
- `--user-data-dir <dir>`
- `--credentials-path <file>`
- `--skip-browser-launch`
- `--json`

For `marketplace:collect`:

- deprecated; prefer `marketplace:search:explore`

- `--query "<text>"`
- `--area <area>`
- `--max-items-per-cycle 100`
- `--refresh-minutes 30`
- `--detail-limit <n>`
- `--once`

For `marketplace:poll`:

- deprecated; prefer `marketplace:search:explore`

- `--query "<text>"` repeated as needed
- `--keywords-file <file>`
- `--area <area>`
- `--max-items-per-query-cycle 100`
- `--refresh-minutes 30`
- `--detail-limit <n>`
- `--once`

For `marketplace:home:collect`:

- `--once`
- `--refresh-seconds <secs>`
- `--refresh-jitter-min <ratio>`
- `--refresh-jitter-max <ratio>`
- `--max-items <n>`
- `--collect-all`
- `--first-load-only`
- `--initial-load-wait-ms <ms>`
- `--max-runtime-seconds <secs>`
- `--stable-passes <n>`
- `--db-path <file>`
- `--location "<display name>"`
- `--radius-miles <n>`
- `--use-credentials`
- `--credentials-path <file>`
- `--login-timeout-seconds <secs>`
- `--headed`

For `marketplace:search:explore`:

- `--query "<text>"`; can be repeated for a round-robin seed list
- `--queries "<text1,text2,...>"`; accepts comma, semicolon, or newline separated seed entries
- `--random-walks-between-seeds <n>`
- `--random-walks-between-seeds-min <n>`
- `--random-walks-between-seeds-max <n>`
- `--reseed-round-min <n>` and `--reseed-round-max <n>` for legacy single-query reseeding
- `--bag-min-keyword-length <n>`
- `--bag-max-keyword-length <n>`
- `--bag-min-times-seen <n>`
- `--exclude-seed-from-bag`
- plus the same location, auth, collection, refresh, screenshot, and headed/headless flags as `marketplace:home:collect`

For `marketplace:home:process`:

- `--once`
- `--drain` / `--until-empty`
- `--poll-interval-seconds <secs>`
- `--poll-jitter-min <n>`
- `--poll-jitter-max <n>`
- `--item-delay-seconds <secs>`
- `--item-jitter-min <n>`
- `--item-jitter-max <n>`
- `--batch-size <n>`
- `--limit <n>`
- `--stale-after-seconds <secs>`
- `--retry-delay-seconds <secs>`
- `--max-attempts <n>`
- `--status-filter <all|pending|error|processing|sold|pending_sale|inactive>`
- `--backlog-order <priority|rank|latest|earliest>`
- `--seen-time-field <last_seen|first_seen>`
- `--seen-after <date-or-iso-timestamp>`
- `--seen-before <date-or-iso-timestamp>`
- `--resolve-inactive`
- `--source-filter <source>`
- `--keyword-filter <text>`
- `--listing-id <id>`
- `--listing-ids <id,id,...>`
- `--listing-id-file <json-or-text-file>`
- `--db-path <file>`
- `--capture-dir <dir>`
- `--headed`

For `marketplace:home:serve`:

- `--host <host>`
- `--port <port>`
- `--db-path <file>`
- `--admin-token <token>`
- `--read-only-token <token>`
- `--readonly-token <token>`

For `marketplace:auth:profile-onboarder`:

- `--db-path <file>`
- `--user-data-dir <dir>`
- `--credentials-path <file>`
- `--credentials-profile <id>`
- `--start-url <url>`
- `--worker-id <id>`
- `--login-timeout-seconds <secs>`
- `--poll-seconds <secs>`
- `--max-elements <n>`
- `--screenshot-dir <dir>`
- `--headed`
- `--headless`
- `--json`

For `marketplace:auth:headless-onboard`:

- `--user-data-dir <dir>`
- `--credentials-path <file>`
- `--credentials-profile <id>`
- `--start-url <url>`
- `--login-timeout-seconds <secs>`
- `--poll-seconds <secs>`
- `--max-elements <n>`
- `--no-interactive`
- `--json-events`

For `marketplace:credentials:import`:

- `--credentials-path <file>`
- `--source-file <file>`
- `--id <profile-id>`
- `--label <display-label>`
- `--activate`
- `--no-activate`

For `marketplace:home:index`:

- `--db-path <file>`
- `--limit <n>`
- `--all`
- `--once`
- `--poll-interval-seconds <secs>`
- `--poll-jitter-min <n>`
- `--poll-jitter-max <n>`
- `--worker-id <id>`
- `--json`

For `marketplace:home:backlog:indexes`:

- `--db-path <file>`
- `--status-filter <all|pending|error|processing|sold|pending_sale|inactive>`
- `--source-filter <source>`
- `--keyword-filter <text>`
- `--backlog-order <priority|rank|latest|earliest>`
- `--seen-time-field <last_seen|first_seen>`
- `--seen-after <date-or-iso-timestamp>`
- `--seen-before <date-or-iso-timestamp>`
- `--limit <n>`
- `--json`

For `marketplace:home:db:maintain`:

- `--db-path <file>`
- `--dry-run`
- `--json`
- `--checkpoint` / `--no-checkpoint`
- `--optimize` / `--no-optimize`
- `--analyze`
- `--vacuum`
- `--recover-stale-processing`
- `--stale-processing-seconds <secs>`
- `--stale-processing-status <pending|error>`

For `marketplace:home:db:merge`:

- `--source-db <file>`
- `--target-db <file>` / `--db-path <file>`
- `--statuses <done,sold,pending_sale>`
- `--execute`
- `--dry-run`
- `--no-resolved-listings`
- `--no-listing-events`
- `--no-workflow-events`
- `--preserve-media-paths`
- `--clear-media-paths`
- `--rewrite-prefix <from=to>`
- `--json`

For `marketplace:home:tier3:dry-run`:

- `--details-dir <dir>`
- `--listing-id <id>`
- `--limit <n>`
- `--history-profile <json-file>`
- `--history-csv <csv-file>`
- `--json`

For `marketplace:home:export`:

- `--db-path <file>`
- `--output <file>`
- `--stdout`
- `--pretty`
- `--compact`

## Notes

- If you already have a signed Facebook session in `./profiles/facebook-marketplace`, prefer `--manual-login --user-data-dir ./profiles/facebook-marketplace` for the visible workflow.
- The collector currently assumes the persistent Marketplace profile already has a usable Facebook session.
- The collector is better for unattended gathering; the interactive workflow is better for observing live behavior.
- The homepage collector and homepage backlog worker both assume `./profiles/facebook-marketplace` already contains a usable signed-in Marketplace session.
- The homepage collector can also bootstrap login from `credentials.json` if you pass `--use-credentials`. In Docker Compose, place that file at `secrets/credentials.json`.

## More Detail

For longer workflow notes, see [docs/marketplace-workflow-flowcharts.md](docs/marketplace-workflow-flowcharts.md) and [docs/marketplace-worker-scheduling-and-backlog-plan.md](docs/marketplace-worker-scheduling-and-backlog-plan.md).

For a product and engineering overview of the homepage pipeline, see [docs/marketplace-homepage-pipeline-overview.md](docs/marketplace-homepage-pipeline-overview.md).
