# Marketplace Worker Scheduling and Backlog Plan

## Current Scheduling Model

The central web app is the workflow launcher and monitor. It starts child processes through the managed workflow registry, records `workflow_runs`, exposes dashboard/API controls, and enforces worker-type concurrency limits.

Current worker-type limits:

- `search-explore`: 2 concurrent workflow runs
- `resolver`: 2 concurrent runs across resolver workflows
- `profile-onboarder`: 1 run, exclusive with other browser workers
- `collector`: one active run is the intended operating mode, but it is not currently capped as a separate workflow limit
- `backlog_indexer`: no browser-profile cap

The running worker process owns its own loop after launch. There is not yet one global scheduler or one global job queue.

## Worker Backlog Sources

### Homepage Collector

Workflow: `home-collect`

Scheduling model: timed browser collection loop.

Backlog model: no explicit task queue. The live Marketplace homepage feed is the input. Each collection cycle upserts observed listings into `homepage_listings`; unresolved or changed listings become resolver backlog through listing state.

Primary backlog signal produced:

- `homepage_listings.detail_status = 'pending'`

### Search Explorer

Workflow: `search-explore`

Scheduling model: timed browser search loop.

Backlog model: no explicit task queue. It alternates between a seed query and randomly selected keywords from `search_title_bag`. Search results are upserted into `homepage_listings` and linked to the search keyword.

Primary backlog signals produced:

- `homepage_listings.detail_status = 'pending'`
- `listing_search_keywords`
- `search_title_bag`

### Backlog Resolver

Workflows:

- `backlog-resolve`
- `backlog-worker`

Scheduling model: claim-based resolver loop.

Backlog model: the primary resolver backlog is `homepage_listings`, filtered by `detail_status`, attempts, retry delay, source, keyword, time range, and optional listing-id files. A resolver claims one listing at a time by atomically moving it to `processing`, incrementing `detail_attempts`, and setting `claimed_by`.

Primary backlog states:

- `pending`: ready to resolve
- `processing`: currently claimed by a resolver
- `error`: retryable after delay/attempt rules
- `done`: resolved
- `sold` / `pending_sale`: inactive listing outcome

The `resolve_queue_items` table is a user dispatch overlay, not the canonical resolver backlog. It lets the UI queue specific listings and dispatch a resolver run over those IDs.

### Backlog Indexer

Workflow: `backlog-indexer`

Scheduling model: timed non-browser metadata loop.

Backlog model: derived from resolved listing rows that have stale or missing computed metadata. The first implementation normalizes listed-time ranges from `detail_listed_ago`.

Primary backlog signal:

- stale or missing `detail_listed_at_*` derived fields

This worker should not lease a browser profile and should not open Facebook.

### Profile Onboarder

Workflow: `profile-onboarder`

Scheduling model: operator-guided browser session.

Backlog model: no listing backlog. It starts a Facebook profile login/checkpoint
session, emits workflow/listing-style audit events for each observed step, and
polls a file-backed command channel for dashboard commands.

Command channel:

- `artifacts/marketplace-homepage/worker-commands/<worker-id>.jsonl`

Supported dashboard commands:

- submit a verification code
- continue after external approval
- retry credentials
- cancel

It is exclusive with other browser workers because it manipulates the shared
browser profile and may wait for human action.

### Recommendation Matcher

Current scheduling model: embedded server timer plus opportunistic scans after collector/resolver updates.

Current backlog model:

- input cursor state in `purchase_history_match_scan_state`
- output recommendations in `purchase_history_match_queue`
- user decision events in `purchase_history_match_events`

This is operationally useful but architecturally inconsistent. It behaves like a background worker while living inside the web server.

## Target Scheduling Model

The central web app should own:

- UI and read APIs
- write APIs for user commands and decisions
- workflow dispatch
- worker lifecycle observation
- queue and event projections
- credential/profile administration

Workers should own:

- browser collection
- browser resolution
- post-resolution metadata indexing
- recommendation matching
- emitting workflow/listing/recommendation events

The central app should avoid doing long-running listing or recommendation computation directly inside request handlers or server timers.

## Migration Plan

1. Keep the current managed workflow launcher as the MVP scheduler.
2. Promote the embedded recommendation refresh into a dedicated `recommendation_indexer` or `match_indexer` worker.
3. Keep `purchase_history_match_scan_state` as the incremental cursor store for the matcher worker.
4. Keep `purchase_history_match_queue` as the recommendation review backlog.
5. Move the server-side timer behind the new worker, then remove it from server startup.
6. Keep manual refresh as a command that dispatches a one-shot matcher worker instead of scanning inside the HTTP handler.
7. Keep opportunistic scans from collector/resolver temporarily, but move them toward emitted listing-change events consumed by the matcher worker.
8. Preserve user decisions (`saved`, `dismissed`) as terminal statuses unless explicitly requeued.

## Near-Term MVP Rules

- Timed workers should use jitter to avoid synchronized load.
- Claim-based workers must use atomic state transitions.
- Cursor-based workers must update cursors only after a batch is selected and processed.
- UI queues are command overlays unless explicitly documented as canonical backlog.
- Derived metadata workers should be non-browser workers.
- Recommendation matching should become a first-class worker before adding more matching complexity.

## Open Design Questions

- Whether the long-term worker transport is direct shared SQLite, HTTP event intake, or a command/event outbox.
- Whether recommendation matching should be one worker type or a strategy of a broader `indexer` worker.
- Whether resolver retries should remain encoded on `homepage_listings` or move to a dedicated resolver job table.
- Whether collector-created listing observations should eventually become immutable events with listing state rebuilt by reducers.
