# Remote Worker Performance Test Suite Design

## Purpose

Design a repeatable performance test suite for the marketplace monitor and the
remote-worker architecture.

The suite should answer four practical questions:

1. Can workers append local outbox events fast enough without blocking domain
   work?
2. Can the host ingest, validate, ACK, and reduce remote worker event batches
   without SQLite lock regressions?
3. Does dashboard polling stay responsive while workers are producing events?
4. How much worker concurrency can the current host shape safely support before
   backpressure, API latency, or database contention becomes visible?

This suite must avoid live Facebook dependency. Browser/Facebook tests belong in
separate stability or smoke runs. Performance tests should use deterministic
mock workers, generated listings, generated events, and local artifact metadata.

## Scope

In scope:

- local worker SQLite outbox append and flush behavior;
- remote worker session registration and heartbeat;
- remote event batch upload and ACK behavior;
- host reducer writes into compatibility tables;
- dashboard read APIs under concurrent ingest;
- local artifact metadata ingestion;
- duplicate event replay and stale event handling;
- soak behavior over minutes or hours.

Out of scope for the first suite:

- real Facebook navigation;
- real Playwright detail capture timing;
- browser profile contention tests;
- screenshot binary upload throughput beyond bounded artifact metadata;
- cloud-scale multi-host orchestration.

## Test Tiers

### Tier 0: Micro Benchmarks

Fast local tests for hot code paths. These should run against temporary SQLite
databases and finish in seconds.

Targets:

- local outbox append throughput;
- local outbox pending query latency;
- local outbox mark-acked/compaction latency;
- event registry validation cost;
- canonical hash/idempotency comparison cost;
- reducer write cost for workflow and listing events.

Suggested command:

```bash
node scripts/perf/remote-worker-microbench.js --json
```

Output:

```json
{
  "suite": "remote-worker-microbench",
  "timestamp": "2026-06-18T12:00:00.000Z",
  "cases": [
    {
      "name": "outbox_append_10000",
      "events": 10000,
      "elapsedMs": 820,
      "eventsPerSecond": 12195,
      "p95Ms": 0.4
    }
  ]
}
```

### Tier 1: Host API Batch Ingest

Start the local marketplace server against a generated temporary database, then
simulate remote workers uploading event batches.

Targets:

- `POST /api/v1/remote-workers/sessions`;
- `POST /api/v1/remote-workers/sessions/:sessionId/heartbeat`;
- `POST /api/v1/remote-workers/sessions/:sessionId/events`;
- duplicate batch replay;
- invalid event rejection;
- compatibility writes to `workflow_events` and `listing_events`.

Suggested command:

```bash
node scripts/perf/remote-worker-host-ingest.js \
  --workers 4 \
  --events-per-worker 10000 \
  --batch-size 100 \
  --json
```

Primary measurements:

- event batch p50/p95/p99 latency;
- accepted events per second;
- duplicate replay latency;
- rejected event latency;
- SQLite busy/lock errors;
- remote event ingest rows per second;
- reducer rows per second;
- server RSS and event-loop delay.

### Tier 2: Dashboard Under Worker Load

Run the host ingest load while polling dashboard APIs from another loop. This
protects against the prior failure mode where worker activity and dashboard stats
made the Node process CPU-bound.

Targets:

- `/healthz`;
- `/api/listings?limit=50`;
- `/api/workflows`;
- `/api/workflows?stats=1`;
- `/api/v1/remote-workers/sessions/:sessionId/ingest-events` when enabled for
  debug visibility.

Suggested command:

```bash
node scripts/perf/dashboard-under-ingest.js \
  --workers 4 \
  --events-per-second 200 \
  --duration-seconds 300 \
  --json
```

Primary measurements:

- dashboard API p50/p95/p99 latency;
- timeout count;
- health check latency while ingest is active;
- host event-loop delay;
- max RSS;
- database WAL growth;
- workflow stats query cost.

### Tier 3: Worker Concurrency And Backpressure

Simulate remote workers with realistic runtime loops: heartbeat, claim or command
polling, local outbox growth, event flush, retry, and host ACK checkpoint updates.

Targets:

- backpressure threshold behavior;
- pending event count growth;
- heartbeat freshness during event upload;
- host checkpoint lag;
- worker stop/drain behavior;
- resume after short network failure.

Suggested command:

```bash
node scripts/perf/remote-worker-soak.js \
  --workers 8 \
  --duration-seconds 1800 \
  --event-rate-per-worker 5 \
  --batch-size 50 \
  --host-outage-at-seconds 600 \
  --host-outage-duration-seconds 60 \
  --json
```

Primary measurements:

- max unacked local outbox rows;
- time to drain backlog after host returns;
- heartbeat miss count;
- session state transitions;
- duplicate replay count after reconnect;
- stale claim protection correctness;
- no event loss after restart/resume.

### Tier 4: Artifact Metadata And Storage Pressure

Exercise artifact metadata and bounded file creation without uploading large
screenshots by default.

Targets:

- artifact metadata ACK latency;
- event references to artifact ids;
- local artifact spool compaction only after event and artifact ACK;
- host storage path allocation;
- disk growth and cleanup.

Suggested command:

```bash
node scripts/perf/remote-worker-artifacts.js \
  --events 10000 \
  --artifact-ratio 0.25 \
  --artifact-bytes 102400 \
  --json
```

Binary artifact upload can be added after metadata-only artifacts are stable.

### Tier 5: Remote Host Capacity Run

Run a controlled version of Tier 2 or Tier 3 against the staging host. This
should be opt-in and never part of default CI.

Suggested command:

```bash
node scripts/perf/remote-host-capacity.js \
  --host http://10.10.20.3:21435 \
  --worker-token-env MARKETPLACE_WORKER_TOKEN \
  --workers 4 \
  --duration-seconds 600 \
  --json
```

Required safety controls:

- require explicit `--remote` flag;
- require worker token, never admin token;
- require generated test worker ids with a `perf-` prefix;
- cap duration and event rate unless `--unsafe-high-load` is provided;
- write a clear summary before starting the run.

## Data Sets

Use generated deterministic data sets. Store only summaries and optional seeds in
git; write generated SQLite files under `artifacts/perf/`.

### Tiny

- listings: 100
- workflow events: 1,000
- listing events: 5,000
- remote workers: 1
- purpose: local development and script correctness

### Baseline

- listings: 10,000
- workflow events: 20,000
- listing events: 100,000
- remote workers: 4
- purpose: expected MVP operating load

### Stress

- listings: 100,000
- workflow events: 200,000
- listing events: 1,000,000
- remote workers: 8 to 16
- purpose: find saturation points and lock regressions

### Soak

- duration: 30 minutes locally, 2 to 6 hours on staging
- workers: 4 to 8
- event rate: realistic steady rate plus burst windows
- purpose: catch memory growth, WAL growth, and latency drift

## Metrics

Every perf script should emit one JSON report and one human-readable summary.

Required top-level fields:

```json
{
  "suite": "remote-worker-host-ingest",
  "timestamp": "2026-06-18T12:00:00.000Z",
  "gitCommit": "",
  "host": {
    "platform": "darwin",
    "node": "v24.x",
    "cpuCount": 8
  },
  "config": {},
  "summary": {},
  "cases": []
}
```

Required metrics:

- elapsed wall time;
- total events attempted;
- accepted events;
- duplicate events;
- rejected events;
- failed requests;
- p50/p95/p99 request latency;
- p50/p95/p99 batch ACK latency;
- events per second;
- max event-loop delay;
- max RSS;
- SQLite busy/lock count;
- WAL size before and after;
- DB file size before and after;
- pending outbox high-water mark;
- host checkpoint lag.

Recommended Node APIs:

- `node:perf_hooks` for histograms and event-loop delay;
- `process.resourceUsage()` for CPU usage;
- `process.memoryUsage()` for RSS/heap;
- SQLite `PRAGMA wal_checkpoint(PASSIVE)` and file stats for WAL growth.

## Initial Performance Gates

These are starting gates, not permanent promises. Record baseline numbers from a
clean local run and adjust only with evidence.

### Local Development Gate

Run on a developer machine before merging remote-worker runtime changes:

```bash
node scripts/perf/remote-worker-microbench.js --profile tiny --json
node scripts/perf/remote-worker-host-ingest.js --profile tiny --json
```

Fail if:

- any request returns an unexpected 5xx;
- any valid event is lost;
- duplicate identical events are not ACK-equivalent;
- SQLite busy/lock errors occur in the tiny profile;
- p95 event batch ACK latency regresses by more than 50 percent from the stored
  baseline.

### CI Smoke Gate

Run only tiny profiles in CI:

```bash
node scripts/perf/remote-worker-host-ingest.js \
  --profile tiny \
  --workers 2 \
  --events-per-worker 1000 \
  --batch-size 100 \
  --json
```

CI should check correctness and large regressions. It should not fail on small
timing differences.

Fail if:

- accepted event count is wrong;
- duplicate replay count is wrong;
- reducer compatibility row count is wrong;
- p95 event batch ACK latency is more than 3x the checked-in baseline;
- max RSS is more than 2x the checked-in baseline.

### Staging Capacity Gate

Run manually before increasing worker concurrency or changing dashboard polling:

```bash
node scripts/perf/dashboard-under-ingest.js \
  --profile baseline \
  --duration-seconds 600 \
  --json
```

Fail if:

- `/healthz` p95 exceeds 250 ms;
- `/api/listings?limit=50` p95 exceeds 750 ms;
- `/api/workflows` without stats p95 exceeds 1000 ms;
- `/api/workflows?stats=1` p95 exceeds 5000 ms before stats caching exists;
- any dashboard request times out;
- worker event ingest p95 exceeds 1000 ms for 100-event batches;
- host process RSS grows continuously without stabilizing.

## Harness Layout

Recommended files:

```text
scripts/perf/
- perf-utils.js
- generate-marketplace-perf-db.js
- remote-worker-microbench.js
- remote-worker-host-ingest.js
- dashboard-under-ingest.js
- remote-worker-soak.js
- remote-worker-artifacts.js
- compare-perf-baseline.js

artifacts/perf/
- latest/
- baselines/
- runs/
```

Shared helper responsibilities:

- create temporary DBs;
- seed deterministic listings and events;
- start and stop the local server;
- create remote worker sessions;
- build valid event batches;
- collect latency histograms;
- write JSON reports;
- compare reports to baselines.

Do not add a heavy external benchmarking dependency for the first version. The
current project can do this with Node built-ins and the existing SQLite/runtime
helpers.

## Event Mixes

Use event mixes that match expected worker rollout order.

### Backlog Indexer Mix

- `worker_started`: 1 per session;
- `backlog_index_started`: 1 per batch;
- `backlog_listing_metadata_indexed`: many listing events;
- `backlog_listing_metadata_skipped`: 5 to 10 percent;
- `backlog_index_completed`: 1 per batch;
- `worker_heartbeat`: periodic.

This should be the default first suite because it avoids browser/profile state.

### Resolver Queue Mix

- `worker_started`: 1 per session;
- `profile_lease_acquired`: 1 per session;
- `detail_capture_started`: 1 per listing;
- `detail_capture_succeeded`: 70 to 85 percent;
- `detail_capture_bypassed` or `listing_unavailable`: 10 to 20 percent;
- `detail_capture_failed`: 1 to 5 percent;
- `content_changed`: low percentage;
- `worker_completed` or `worker_failed`: terminal.

Use this after claim/lease endpoints are implemented.

### Collector Burst Mix

- `collector_cycle_started`: 1 per cycle;
- `collector_query_selected`: for search/explorer;
- `listing_observed`: high volume bursts;
- `collector_cycle_completed`: 1 per cycle.

This mix should test batching and backpressure. It should not be the first remote
worker performance target.

## Baseline Management

Store baseline reports as JSON under:

```text
artifacts/perf/baselines/
```

Do not require baselines to be committed if they are host-specific. If a baseline
is committed, name it with environment details:

```text
remote-worker-host-ingest.tiny.macos-arm64.node24.json
remote-worker-host-ingest.baseline.remote-8vcpu-16gb.node24.json
```

Baseline comparison should support:

- absolute thresholds for correctness;
- relative thresholds for timing;
- warning-only mode for exploratory runs;
- fail-fast mode for CI.

## Reporting Format

Human summary example:

```text
remote-worker-host-ingest baseline
workers=4 events=40000 batch_size=100
accepted=40000 duplicates=0 rejected=0 failed_requests=0
event_ack_ms p50=92 p95=210 p99=380
throughput events_per_second=1850
healthz_ms p95=18
rss_mb max=284
sqlite_busy=0 wal_growth_mb=32
result=pass
```

JSON reports should be written to:

```text
artifacts/perf/runs/{timestamp}-{suite}.json
artifacts/perf/latest/{suite}.json
```

## Implementation Order

1. Add `scripts/perf/perf-utils.js` with timer, histogram, report, temp DB, and
   server helpers.
2. Add `generate-marketplace-perf-db.js` for tiny and baseline fixtures.
3. Add Tier 0 microbench for local outbox and event validation.
4. Add Tier 1 host ingest bench using the same API path as
   `test/remote-worker-host-api.test.js`.
5. Add baseline comparison in warning-only mode.
6. Add Tier 2 dashboard-under-ingest after host ingest is stable.
7. Add Tier 3 soak only after session resume and checkpoint repair behavior is
   implemented.
8. Add optional remote host capacity run with strict safety flags.

## Acceptance Criteria

- The suite can run locally without Facebook credentials or browser launch.
- The tiny profile completes in under 60 seconds on a developer machine.
- Every run writes a JSON report and a human summary.
- Correctness checks are enforced before timing comparisons.
- Duplicate event replay is measured separately from fresh ingest.
- Dashboard latency is measured concurrently with worker ingest.
- SQLite busy/lock errors are counted and fail the tiny profile.
- Remote/staging load tests require explicit opt-in and worker-token auth.
- Baselines can be compared without making timing noise block normal development.
