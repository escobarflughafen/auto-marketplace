# Playwright Control Browser Workflow for Facebook Marketplace

This workspace now uses `marketplace.js` as the browsing workflow entrypoint.

## 1. Credentials

Create `credentials.json` with this structure:

```json
{
  "facebook-marketplace": {
    "email": "you@example.com",
    "password": "your-password"
  }
}
```

The first successful login stores a reusable Facebook session in `playwright/.auth/facebook-marketplace.json`.

## 2. Run the workflow

Open Marketplace and leave the browser available for manual browsing:

```bash
npm run marketplace
```

Launch with a persistent local browser profile so your session carries across runs:

```bash
npm run marketplace -- --user-data-dir ./profiles/facebook-marketplace
```

Open the browser but leave login fully manual:

```bash
npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace
```

In `--manual-login` mode, the script now behaves like a passive sign-in flow: it opens the browser once, waits for you to complete login yourself, and then continues using that browser session without autofilling credentials.

Attach to an already controlled Chromium browser over CDP:

```bash
npm run marketplace -- --cdp-url "http://127.0.0.1:9222"
```

Open Marketplace and run a search:

```bash
npm run marketplace -- --query "used office chair"
```

Open a specific Marketplace page or saved search URL:

```bash
npm run marketplace -- --start-url "https://www.facebook.com/marketplace/search/?query=bike"
```

Scroll the results page and save a screenshot:

```bash
npm run marketplace -- --query "desk" --scrolls 5 --screenshot artifacts/desk.png
```

Loop the same query every 60 seconds in the same persistent browser session:

```bash
npm run marketplace -- --user-data-dir ./profiles/facebook-marketplace --query "zeiss 50 1.4 ze" --scrolls 5 --loop-seconds 60
```

## 3. Supported options

```bash
npm run marketplace -- --help
```

Available flags:

- `--cdp-url "<url>"` attaches to an existing Chromium browser with remote debugging enabled.
- `--user-data-dir "<path>"` launches a persistent browser profile that keeps the prior login/session state.
- `--manual-login` skips reading and autofilling credentials.
- `--query "<text>"` searches Marketplace after login.
- `--start-url "<url>"` opens a specific Marketplace URL first.
- `--scrolls <count>` auto-scrolls the page to load more listings.
- `--screenshot "<path>"` saves a screenshot after navigation.
- `--slow-mo <ms>` changes Playwright interaction speed.
- `--login-timeout-seconds <secs>` increases or decreases the manual login window.
- `--loop-seconds <secs>` reruns the workflow on a timer in the same browser session.
- `--loop-count <n>` stops after a fixed number of loop cycles.
- `--headless` runs without a visible browser.
- `--exit-after-setup` closes the browser once the workflow completes.

## 4. Result extraction and posting screenshots

To extract Marketplace results from the signed-in persistent profile:

```bash
node scripts/extract-marketplace-results.js "pentax 67"
```

To open the first few postings and save a screenshot for each posting page:

```bash
node scripts/extract-marketplace-results.js "pentax 67" --capture-dir artifacts/pentax-67 --visit-limit 5
```

You can also set the area explicitly:

```bash
node scripts/extract-marketplace-results.js "nikon sp" --area whistler --capture-dir artifacts/nikon-sp-whistler --visit-limit 3
```

The script will:

- collect the current Marketplace search results
- visit the first `N` postings
- save one full-page screenshot per posting into the folder you provide
- save the listing thumbnail strip as separate image artifacts when thumbnails are visible
- save one Markdown snapshot record per visited posting
- return JSON that includes `screenshotPath` and `snapshotPath` for each captured item

If you already have exact posting URLs and want one screenshot per visited posting:

```bash
node scripts/capture-marketplace-posts.js \
  --capture-dir artifacts/pentax-67-posts \
  "https://www.facebook.com/marketplace/item/2440291986442891/" \
  "https://www.facebook.com/marketplace/item/2040898153527902/"
```

That URL-based capture also writes one `.md` snapshot file per posting alongside the `.png` screenshot.

## 5. Multi-keyword polling

To continuously process a list of keywords one by one using the same bounded collection logic as the single-keyword collector:

```bash
node scripts/poll-marketplace-keywords.js \
  --keywords-file keywords.marketplace.example.txt \
  --area vancouver \
  --capture-root artifacts/marketplace-poll \
  --log-file artifacts/marketplace-poll/poller.log \
  --max-items-per-query-cycle 100 \
  --refresh-minutes 30 \
  --detail-limit 20
```

You can also provide the keywords directly on the command line:

```bash
node scripts/poll-marketplace-keywords.js \
  --query "pentax 67" \
  --query "nikon sp" \
  --query "contax 645" \
  --area vancouver
```

For a single one-off round:

```bash
node scripts/poll-marketplace-keywords.js \
  --query "pentax 67" \
  --query "nikon sp" \
  --once
```

The poller will:

- load keywords from repeated `--query` flags and/or `--keywords-file`
- process keywords one by one in sequence
- collect up to the per-keyword cycle cap or stop earlier when the result set stops growing
- write per-keyword `results.json` and `summary.md` into a timestamped round folder
- keep `state.json` under the capture root so later rounds know which listing IDs were already seen
- optionally capture detail pages for the first `N` new listings per keyword with `--detail-limit`
- refresh immediately if any keyword hit the per-keyword item cap
- otherwise wait until the refresh timer before the next full round
- write timestamped progress logs to stdout and `poller.log`

There is also an npm shortcut:

```bash
npm run marketplace:poll -- --keywords-file keywords.marketplace.example.txt --max-items-per-query-cycle 100 --refresh-minutes 30
```

For a one-key `mamiya 645af` poller with preset defaults:

```bash
npm run marketplace:poll:mamiya-645af
```

That wrapper uses:

- query: `mamiya 645af`
- area: `vancouver`
- capture root: `artifacts/mamiya-645af-poll`
- refresh timer: `300` seconds

You can still pass extra flags through, for example:

```bash
npm run marketplace:poll:mamiya-645af -- --once
```

## 6. Robust single-keyword collection

For one keyword with deeper result collection and automatic refresh when either 100 listings are collected or 30 minutes have elapsed:

```bash
npm run marketplace:collect -- --query "zeiss 50 1.4 ze" --area vancouver --max-items-per-cycle 100 --refresh-minutes 30
```

That collector will:

- scroll and merge unique Marketplace result cards until it reaches the cycle limit or the result set stops growing
- write `results.json` and `summary.md` for each cycle
- keep a `state.json` file so repeated cycles know which listing IDs were already seen
- refresh immediately when it reaches the per-cycle item limit
- otherwise wait for the refresh timer before re-running the search
- optionally capture listing detail pages if you add `--detail-limit <n>`

## 7. Current DB-backed homepage workflow

The preferred local pipeline is now SQLite-backed:

```bash
npm run marketplace:home:collect
npm run marketplace:home:process
npm run marketplace:home:serve
```

Use `marketplace:home:collect` or `marketplace:search:explore` for discovery, and `marketplace:home:process` for asynchronous detail resolution. The resolver supports `--drain`, continuous mode, source/status/keyword filters, item and poll jitter, inactive sold/pending-sale bypass, and backlog start controls:

```bash
npm run marketplace:home:process -- --drain --backlog-order latest --seen-time-field last_seen --seen-after 2026-05-09T00:00:00.000Z
```

Before running a bounded resolver, preview candidate ordering and available SQLite indexes with:

```bash
npm run marketplace:home:backlog:indexes -- --backlog-order earliest --seen-time-field first_seen --status-filter pending --limit 20
```

The local management UI is served from `frontend/marketplace-monitor/` and opens at `http://127.0.0.1:3080` by default. It contains the Tabulator listings table, Worker Control, Worker Overview, and centered per-worker inspector with status, audit events, text history, and latest preview screenshot.

Homepage location is most reliable through the Marketplace route slug inferred from `--location`; tested homepage radius controls were not reliably visible, so treat `--radius-miles` as best-effort on homepage routes.

## 8. Expected behavior

- The browser runs in headed mode by default.
- If `--user-data-dir` is used, the browser profile is reused on the next run, so Facebook session data persists more naturally.
- If `--cdp-url` is used, the script connects to the existing browser session instead of launching a new browser.
- If Facebook requires 2FA or device approval, finish it in the visible browser window.
- If the saved session is still valid, the script reuses it and skips login.
- After setup, the browser stays open so you can continue browsing Marketplace manually.

## 9. Recommended hybrid workflow

For repeated use, prefer a dedicated persistent profile:

```bash
npm run marketplace -- --user-data-dir ./profiles/facebook-marketplace --query "pentax 67"
```

That gives you a stable browser profile that keeps cookies and Facebook state between runs.

Avoid pointing this at your main personal Chrome profile while that browser is already in use. A dedicated automation profile is safer.

## 10. Starting a browser for CDP control

On macOS, one common pattern is:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-marketplace
```

Then run:

```bash
npm run marketplace -- --cdp-url "http://127.0.0.1:9222"
```
