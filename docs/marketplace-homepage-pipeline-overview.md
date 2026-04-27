# Marketplace Homepage Pipeline Overview

## Short Description

This project now includes a Facebook Marketplace homepage collection pipeline that:

- opens Marketplace home without keyword search
- collects listing cards from the homepage
- extracts a stable listing identifier from the Marketplace item URL
- stores homepage discoveries in a SQLite-backed queue
- processes queued listing URLs asynchronously in a separate browser worker
- captures listing details, screenshots, and markdown snapshots

The design is intentionally minimal:

- one collector process for homepage discovery
- one backlog worker for detail extraction
- one SQLite database as the shared system of record

That keeps the current implementation easy to inspect, easy to modify, and easy to operate from the terminal.

## Main Features

### 1. Homepage-only collection

The collector does not require keyword search. It opens:

- `https://www.facebook.com/marketplace/`

and collects listing cards directly from the homepage feed.

Supported collection modes:

- top-N collection with `--max-items <n>`
- collect-all mode with `--collect-all`
- first-load-only mode with `--first-load-only` / `--no-scroll`

First-load-only mode is useful when the goal is to capture only the initial homepage payload and avoid active scrolling behavior.

### 2. Listing ID extraction

Each listing is normalized by extracting `/marketplace/item/<id>` from the URL.

This ID is used as the primary key in the queue database, which allows:

- deduplication across polling cycles
- stable referencing of records
- reliable backlog processing

### 3. SQLite queue and state store

The collector writes to a local SQLite database:

- `artifacts/marketplace-homepage/marketplace-homepage.db`

The primary table is:

- `homepage_listings`

It stores:

- homepage card data
- first-seen and last-seen timestamps
- last seen homepage rank
- queue processing status
- detail extraction results
- artifact paths for screenshots and markdown snapshots

### 4. Async backlog processing

The backlog processor is a separate long-running worker that:

- claims pending rows from the database
- opens each listing page in the browser
- expands detail sections
- extracts detail content
- writes processed results back to the database

This separation means homepage discovery and detail extraction do not block each other operationally, even though each individual process is still single-threaded.

### 5. Duplicate-status reporting

Each collector poll now reports whether a row was:

- `new`
- `existing_same`
- `existing_updated`

This is useful for understanding homepage churn and whether a poll is actually surfacing new inventory.

### 6. Session identity and DB status logging

At collector startup and around every poll cycle, the collector logs:

- loaded credential email from `credentials.json` if available
- signed-in Facebook `c_user` cookie value
- whether the current session appears logged in
- database queue counts before and after the cycle

This is mainly operational observability for debugging login/profile issues and backlog growth.

### 7. Jittered polling

Collector poll intervals are randomized by default between:

- `25%` and `150%` of `--refresh-seconds`

This reduces highly regular poll timing and makes the runtime schedule less deterministic.

## Main Commands

### Homepage collector

Top 15 items with credential bootstrap:

```bash
npm run marketplace:home:collect -- --use-credentials --max-items 15
```

First-load-only, no scrolling:

```bash
npm run marketplace:home:collect -- --use-credentials --first-load-only --initial-load-wait-ms 5000 --max-items 15
```

Collect all visible homepage items:

```bash
npm run marketplace:home:collect -- --use-credentials --collect-all --max-runtime-seconds 180
```

### Backlog worker

```bash
npm run marketplace:home:process
```

One-pass processing:

```bash
npm run marketplace:home:process -- --once
```

## Coding Logic and Implementation

## Collector logic

The collector implementation is in:

- `scripts/collect-marketplace-homepage.js`

The high-level flow is:

1. launch a persistent Playwright Chromium profile
2. ensure the Facebook Marketplace session is logged in
3. navigate to Marketplace home
4. collect visible homepage listing anchors
5. optionally wait for initial load only, or scroll and merge more results
6. normalize each listing into `(listing_id, href, card_title, card_text, rank)`
7. upsert each row into SQLite
8. classify the row as `new`, `existing_same`, or `existing_updated`
9. log cycle summary and sleep until next poll

### Homepage card extraction

The collector reads:

- anchors matching `a[href*="/marketplace/item/"]`

and derives:

- listing ID
- canonicalized URL
- card title
- combined card text

This approach is intentionally simple and DOM-driven rather than API-driven.

### No-scroll mode

In `--first-load-only` mode, the collector:

- reads the initial visible set
- waits `--initial-load-wait-ms`
- reads again
- stops without any active scroll input

This minimizes interactions with the feed.

## Queue DB logic

The DB implementation is in:

- `scripts/marketplace-homepage-db.js`

Key responsibilities:

- schema creation
- URL canonicalization
- listing ID extraction
- upsert behavior
- claim-next-job behavior for the worker
- processed/failed job status transitions

### Upsert behavior

On each collector cycle, a row is inserted or updated by `listing_id`.

The helper compares the new homepage card payload with the existing row and classifies the result:

- `new`: no existing row
- `existing_same`: same normalized URL, title, and card text
- `existing_updated`: same listing ID but changed card content or rank

This is a useful product metric because it separates inventory growth from homepage reshuffling.

## Backlog worker logic

The worker implementation is in:

- `scripts/process-marketplace-homepage-backlog.js`

The high-level flow is:

1. open the same SQLite DB
2. claim the next pending or retryable row
3. open the listing page in the browser
4. expand details
5. extract structured content from page text
6. capture screenshot and thumbnail artifacts
7. write listing detail results back to SQLite
8. repeat until idle, then sleep

The worker uses the browser, not raw HTTP fetches, for listing detail extraction.

## Session/bootstrap logic

Authentication support is in:

- `scripts/marketplace-profile-auth.js`

The collector can run in two ways:

- reuse an already signed-in persistent browser profile
- bootstrap login from `credentials.json` when `--use-credentials` is supplied

The signed-in runtime identity is inferred from:

- the `c_user` Facebook cookie

## Safety Evaluation

## Interaction model

This pipeline interacts with Facebook Marketplace using a real browser profile and DOM automation. The main interactions are:

- navigating to Marketplace home
- optionally submitting login credentials to Facebook login
- reading homepage card anchors
- optionally scrolling the homepage
- opening listing detail pages
- clicking expandable “see more” style elements on detail pages
- taking screenshots

There are no direct “message seller”, “save listing”, “like”, “purchase”, or posting actions in the current code.

## Extra interactions

The current implementation can produce extra interactions beyond passive page viewing:

- active mouse-wheel scrolling in normal collector mode
- clicks on expandable controls inside listing pages
- login form autofill and submit when `--use-credentials` is enabled

These are still low-risk compared with actions that mutate Marketplace state, but they are not purely read-only.

`--first-load-only` is the least interactive collector mode currently available.

## Safety strengths

- read-mostly product behavior
- no seller messaging logic
- no cart/checkout logic
- no posting/editing listing logic
- no direct write actions against Facebook beyond login form submission
- detail processing isolated from collection via SQLite queue
- jittered polling reduces perfectly regular scheduling

## Safety weaknesses and residual risk

- it still automates a consumer web product that may detect automation patterns
- the worker clicks UI controls to expand listing content
- repeated polling from a persistent profile can still accumulate behavioral signals
- the collector and worker currently reuse the same browser profile, which concentrates all activity into one session identity
- there is no built-in rate limiting based on observed page health, throttling, or challenge screens
- there is no explicit challenge-detection or automatic safe shutdown path if Facebook changes login or anti-abuse flows

## Product / Principal Engineer Assessment

## What is working well

- architecture is small and understandable
- queue ownership is explicit and easy to reason about
- SQLite is sufficient at this scale
- the separation between discovery and detail extraction is the right abstraction
- the feature set is already useful for homepage monitoring and backlog capture
- the code is easy to extend compared with the older keyword-only collector

## Main existing problems

### 1. Homepage extraction quality is still shallow

Homepage cards provide only partial information. For many rows:

- `card_title` is just a price
- text structure varies by language and category
- some semantic fields are not normalized

This is acceptable for queueing, but not enough for product-grade analytics.

### 2. Classification and parsing are heuristic

The system currently depends on:

- URL regex extraction
- DOM anchor scraping
- homepage card text concatenation
- regex parsing of listing detail page text

That makes it fragile to:

- Facebook DOM changes
- localization differences
- category-specific card layouts

### 3. There is no explicit health-state model

The collector does not yet distinguish between:

- homepage loaded normally
- homepage loaded partially
- login challenge/checkpoint state
- rate-limited or degraded session
- empty feed due to product issues vs true no-content

This limits safe unattended operation.

### 4. `collect-all` is bounded only by runtime and feed stability

That is intentionally simple, but product behavior is still rough:

- no per-cycle hard cap except runtime
- no memory or artifact growth guardrails
- no adaptive early stop based on low-value repeated duplicates

### 5. Session identity logging is useful but incomplete

The collector logs:

- loaded credential email
- `c_user` cookie value

But it does not yet log:

- resolved Facebook display name
- whether the credential email and signed-in account truly match
- whether the account is in a degraded or challenge state

### 6. Worker concurrency is minimal

The system is operationally async but computationally simple:

- collector and worker are separate processes
- each process is itself single-threaded
- no worker pool
- no configurable parallel detail capture

That is correct for a minimal build, but it will bottleneck if homepage volume rises.

### 7. No migration path from old JSON artifact workflows

The older keyword collectors still use artifact/state-file persistence. The homepage pipeline uses SQLite. There is no unified persistence story yet.

### 8. No dashboard or operator view

Right now, visibility depends on:

- log output
- direct DB queries
- ad hoc analysis

There is no lightweight admin view for:

- queue depth
- oldest pending item
- error rows
- session status
- recent detail completions

## Recommended TODOs

### Near-term

- add explicit challenge/rate-limit detection and safe-stop behavior
- add display-name/session verification after login
- improve multilingual parsing for rental/property cards
- add a hard maximum item cap for `--collect-all`
- add a small command that prints collector health and DB status
- add worker-side session status logging similar to collector logging

### Medium-term

- separate collector and worker browser profiles
- add configurable detail-worker concurrency
- normalize category-specific structured fields in the DB
- add migration/import tooling from prior artifact-based runs
- add an operator-facing overview report or lightweight local dashboard

### Longer-term

- introduce feed quality metrics
- add anomaly detection for sudden duplicate spikes or zero-yield polls
- define clearer product semantics for “same listing, changed content”
- unify keyword-search and homepage pipelines under one storage and queue model

## Current Recommendation

From a PM / principal engineer perspective, this is a good minimal V1 for homepage monitoring and queue-based detail extraction. It is already useful for exploratory collection and local operations.

It should not yet be treated as a hardened unattended production crawler without:

- stronger health detection
- stronger anti-regression tests around page structure
- clearer session safety handling
- better observability for failures and throttling
