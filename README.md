# Auto Browser

Playwright-based Facebook Marketplace automation.

This repo has two main modes:

- `marketplace`: interactive browser workflow, headed by default
- `marketplace:doctor`: headless readiness and DB preflight check
- `marketplace:collect`: deprecated legacy keyword collector, headless by default
- `marketplace:poll`: deprecated legacy multi-keyword collector, headless by default
- `marketplace:home:collect`: homepage collector backed by a SQLite queue
- `marketplace:search:explore`: search collector that reseeds from discovered titles
- `marketplace:home:process`: backlog worker that visits queued listings for details
- `marketplace:home:serve`: local web server for browsing homepage DB rows

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

Homepage collection after switching the Marketplace location to Ottawa, Ontario:

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

Search-driven exploration in Ottawa, using both the Ottawa route slug and the UI location picker:

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

Backlog processing for homepage-found listings:

```bash
npm run marketplace:home:process -- --once
```

Browse the homepage database in a local web UI:

```bash
npm run marketplace:home:serve
```

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
- `scripts/extract-marketplace-results.js` is headless by default
- `scripts/capture-marketplace-posts.js` is headless by default

## Deprecated Legacy Modules

These commands are still available for compatibility, but they are now deprecated because they are file-based and do not write into the shared SQLite system:

- `npm run marketplace:collect`
- `npm run marketplace:poll`
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
- collector sleep between polls is jittered by default between `25%` and `150%` of `--refresh-seconds`
- `marketplace:home:serve` exposes the same SQLite DB in a local browser UI with lightweight KQL-style filtering

## What The Search Explorer Does

The search explorer uses the same SQLite DB and browser profile, but changes how discovery happens:

- `marketplace:search:explore` starts from a required seed query via `--query`
- collects visible Marketplace search-result cards into the shared SQLite DB with `source='search'`
- stores the active search term on each row as `source_keyword`
- records listing-to-keyword associations in a separate keyword index table
- adds collected result titles into a reusable search-title bag
- on later rounds, picks a random bag entry as the next query
- automatically falls back to the seed query again every `--reseed-round-min` to `--reseed-round-max` rounds
- keeps all timing, scrolling, bag, and reseed behavior configurable through CLI arguments

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

Query examples:

- `nikon`
- `status:pending leica`
- `title:"m6 classic"`
- `location:vancouver`
- `price:>500`
- `price:500-1500`
- `rank:1`
- `before:2026-04-27T09:00:00Z`
- `after:2026-04-27T08:00:00Z`
- `sort:rank`

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

For `marketplace:home:process`:

- `--once`
- `--poll-interval-seconds <secs>`
- `--batch-size <n>`
- `--stale-after-seconds <secs>`
- `--db-path <file>`
- `--capture-dir <dir>`
- `--headed`

For `marketplace:home:serve`:

- `--host <host>`
- `--port <port>`
- `--db-path <file>`

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
- The homepage collector can also bootstrap login from `credentials.json` if you pass `--use-credentials`.

## More Detail

For the longer workflow notes, see [WORKFLOW.md](/Users/aoi/Workspaces/auto-browser/WORKFLOW.md).

For a product and engineering overview of the homepage pipeline, see [docs/marketplace-homepage-pipeline-overview.md](/Users/aoi/Workspaces/auto-browser/docs/marketplace-homepage-pipeline-overview.md).
