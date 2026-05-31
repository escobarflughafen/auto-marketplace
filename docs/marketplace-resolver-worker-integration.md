# Marketplace Resolver Worker Integration Handoff

## Purpose

This document describes how the listing detail resolver works today and what is needed to integrate it as a first-class worker that behaves like the other managed Marketplace workers.

The short version: the resolver logic already exists and is evented enough to become a durable worker, but it is not currently started automatically when the server starts. It runs as a managed child process only when the UI or CLI starts it.

This resolver worker is distinct from the `backlog_indexer` worker. The resolver is a browser worker that captures listing detail pages. The backlog indexer is a non-browser worker that computes derived metadata from resolved listings after capture.

## Current Behavior

The server starts only the monitor app:

```text
npm run marketplace:home:serve -- --host 0.0.0.0 --port 21435
```

The resolver is not started by `marketplace:home:serve`.

The resolver script is:

```text
npm run marketplace:home:process -- ...
```

The server can start it as a managed workflow through:

- `POST /api/workflows/start`
- `/api/listings/resolve` from the Listings UI
- `/api/resolve-queue/dispatch` style flows from the queue UI

Managed workflow startup lives in `scripts/serve-marketplace-homepage.js` in `startManagedWorkflow`. It spawns:

```text
npm run marketplace:home:process -- <validated args>
```

The resolver implementation lives in:

- `scripts/process-marketplace-homepage-backlog.js`
- `scripts/marketplace-homepage-db.js`

## Current Resolver Modes

### Bounded Drain

Workflow id:

```text
backlog-resolve
```

Purpose: process a bounded backlog set, then exit.

Important defaults from the UI workflow definition:

```text
--drain
--batch-size 5
--limit 50
--status-filter pending
--backlog-order priority
--seen-time-field last_seen
--max-attempts 5
--retry-delay-seconds 300
```

This is best for manual, operator-driven resolving.

### Continuous Queue Worker

Workflow id:

```text
backlog-worker
```

Purpose: keep running and poll for eligible backlog rows when idle.

Important defaults from the UI workflow definition:

```text
--batch-size 1
--poll-interval-seconds 30
--poll-jitter-min 0.5
--poll-jitter-max 1.5
--status-filter pending
--backlog-order priority
--seen-time-field last_seen
--max-attempts 5
--retry-delay-seconds 300
```

This is the mode that should become the daemon-style resolver worker.

## Backlog Scheduling Today

There is no separate scheduler table for resolver work.

The resolver calculates eligible work directly from `homepage_listings` every time it tries to claim a row. The claim path is:

```text
processBatch
  -> claimNextPendingHomepageListing
  -> buildBacklogCandidateQueryParts
```

Eligibility is based on:

- `detail_status`
- `detail_attempts < maxAttempts`
- retry delay for `error` rows
- stale timeout for `processing` rows
- optional source, keyword, seen-time, and explicit listing-id filters

Default priority order:

```text
pending first
error second
stale processing third
last_seen_rank ASC
last_seen_at DESC
first_seen_at ASC
```

When a row is claimed, the DB transaction updates:

```text
detail_status = processing
detail_attempts = detail_attempts + 1
detail_started_at = now
claimed_by = workerId
```

Then it appends `detail_capture_started`.

## Poll Frequency

For continuous UI-managed `backlog-worker`:

```text
base poll interval: 30 seconds
jitter: 0.5 to 1.5
actual idle poll: about 15 to 45 seconds
```

For direct CLI defaults:

```text
base poll interval: 15 seconds
jitter: 1.0 to 1.0
batch size: 3
status filter: all
```

When work exists, the worker does not wait for the poll interval. It processes a batch immediately. If configured, it sleeps between item batches using:

```text
--item-delay-seconds
--item-jitter-min
--item-jitter-max
```

The UI defaults are roughly 4 to 12 seconds around an 8 second item delay.

## Current Event Coverage

The resolver emits workflow lifecycle and listing events.

Important workflow events:

- `worker_started`
- `browser_context_launch_started`
- `browser_context_ready`
- `session_ready`
- `worker_sleeping`
- `worker_completed`
- `worker_failed`
- `shutdown_requested`

Important listing events:

- `detail_capture_started`
- `detail_capture_succeeded`
- `detail_capture_bypassed`
- `content_changed`
- `detail_capture_failed`
- `detail_capture_interrupted`
- `listing_unavailable`

The event registry source of truth is:

```text
scripts/marketplace-worker-events.js
```

## Recent DB Hook

Resolved rows now normalize `detail_listed_ago` into approximate Unix timestamp ranges in the DB layer.

This happens when resolver detail writes call:

- `markHomepageListingProcessed`
- `markHomepageListingInactive`

The hook writes:

- `detail_listed_at_earliest_unix`
- `detail_listed_at_latest_unix`
- `detail_listed_at_anchor_unix`
- `detail_listed_at_language`
- `detail_listed_at_unit`
- `detail_listed_at_value`
- `detail_listed_at_confidence`
- `detail_listed_at_source`
- `detail_listed_at_normalized_at`

Backfill is available through:

```text
node scripts/marketplace-homepage-maintain-db.js --normalize-listed-at
```

This derived-data hook does not need browser access and can stay in DB maintenance even after resolver worker integration.

## Target Integration

The desired design is to run the resolver as a first-class managed worker, parallel to collector workers.

Recommended target behavior:

1. Server startup reconciles old workflow runs.
2. Server optionally starts one continuous resolver worker if configured.
3. The resolver worker uses a dedicated browser profile or a profile lease.
4. The worker appears in the same workflow UI as collectors.
5. Stop/restart/reconcile behavior uses the existing workflow APIs.
6. Detail capture events continue to write through the registry-compatible event names.
7. The DB normalization hook remains part of resolver success writes.

The same derived metadata work can also run through the `backlog_indexer` workflow for backfill and stale projection refresh. That worker should not share browser profile constraints because it does not launch Chromium.

## Proposed Server Configuration

Add explicit configuration. Do not silently start a browser worker by default.

Example environment variables:

```text
MARKETPLACE_RESOLVER_AUTOSTART=0
MARKETPLACE_RESOLVER_COUNT=1
MARKETPLACE_RESOLVER_BATCH_SIZE=1
MARKETPLACE_RESOLVER_POLL_INTERVAL_SECONDS=30
MARKETPLACE_RESOLVER_STATUS_FILTER=pending
MARKETPLACE_RESOLVER_BACKLOG_ORDER=priority
MARKETPLACE_RESOLVER_PROFILE_ID=resolver-1
```

The first MVP should default `MARKETPLACE_RESOLVER_AUTOSTART=0` to avoid unexpected Facebook/browser sessions after deploy.

## Proposed Implementation Steps

1. Add server startup autostart wiring.

   In `createServer` or nearby startup code, after DB open and workflow reconciliation, conditionally call `startManagedWorkflow(db, 'backlog-worker', args)`.

2. Add resolver autostart args builder.

   Build a narrow helper that converts env/config into validated workflow args:

   ```text
   --use-credentials
   --headless
   --batch-size <n>
   --poll-interval-seconds <n>
   --status-filter pending
   --backlog-order priority
   --worker-id <generated>
   ```

3. Ensure profile isolation.

   Current default browser profile is shared:

   ```text
   profiles/facebook-marketplace
   ```

   Do not run multiple browser workers on the same profile. Either:

   - allocate one dedicated profile per resolver worker, or
   - implement profile leases before autostarting multiple browser workers.

4. Reconcile old runs before autostart.

   If a previous `workflow_runs` row is `running` or `starting` but the OS process is gone, mark it `lost` or `failed` before starting a replacement.

5. Preserve manual workflow controls.

   Operator-started resolver runs should continue to work. The concurrency limit already allows two resolver workers, but this should be reviewed if autostart is enabled.

6. Add health and dashboard signals.

   Useful fields:

   - resolver worker running count
   - oldest pending `first_seen_at`
   - oldest pending `last_seen_at`
   - stale `processing` count
   - successful detail captures in last hour/day
   - latest resolver error

7. Add tests.

   Minimum tests:

   - autostart disabled by default
   - autostart builds safe args
   - autostart respects resolver concurrency limit
   - stale workflow reconciliation runs before autostart
   - no duplicate resolver when one is already running

## Risk Notes

The main risk is browser profile contention, not DB scheduling.

Known issue: collectors and resolvers can share the same persistent Chromium profile. Multiple Chromium processes using one profile can cause browser storage locks and unstable sessions.

Before enabling resolver autostart in production, choose one:

- single browser worker total;
- dedicated resolver profile;
- profile lease enforcement;
- separate runtime containers per browser worker.

## Recommended MVP

Recommended first integration:

```text
MARKETPLACE_RESOLVER_AUTOSTART=0 by default
one optional continuous backlog-worker
batch size 1
poll interval 30 seconds
dedicated resolver profile
status filter pending
priority order
```

This keeps the behavior close to today while making it operationally manageable as a worker.

After it is stable, increase throughput by adding more resolver profiles or moving toward a command-dispatcher model.
