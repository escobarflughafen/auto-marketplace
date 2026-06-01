# Marketplace Stability Issues

## Purpose

This document captures the current product stability issues observed in the Marketplace homepage monitor, collector, and resolver workflows. It is focused on near-term operational reliability, not future platform architecture.

## Current Assessment

The web monitor is generally stable enough to serve the UI and read the SQLite database. The higher stability risk is in browser-worker execution: collectors and resolvers share a Chromium profile by default, worker runs can become lost after restarts, and resolver throughput is far behind collector intake.

Recent remote checks showed:

- `auto-browser` container healthy and `/healthz` returning OK.
- Source code deployed on the remote includes worker screenshot support and workflow-start argument validation.
- Remote SQLite maintenance/checkpoint completed quickly.
- Worker screenshot artifacts exist remotely.
- Active browser workers can make the dashboard CPU-bound on the current 4-vCPU host.
- Recent DB state had a large pending backlog and several stale processing rows.

## Issues

### 1. Shared Chromium Profile Contention

Severity: High

Collector, search explorer, and resolver workers default to the same browser profile:

- `profiles/facebook-marketplace`

The server allows concurrent worker classes, including up to two resolver workers. When multiple browser processes use the same persistent Chromium profile, IndexedDB and browser profile files can lock. A recent resolver interruption showed repeated Facebook IndexedDB `LOCK` errors followed by a closed browser context.

Impact:

- Detail captures can fail or interrupt mid-run.
- Rows can remain in `processing`.
- Browser session reliability degrades.
- Restarting more workers can make the problem worse instead of improving throughput.

Recommended fix:

- Enforce one active owner per browser profile before any worker launches.
- Short-term: reduce browser-worker concurrency to one total worker for the shared profile.
- Medium-term: allocate unique profile directories per concurrent worker.
- Longer-term: move to an explicit profile lease table or browser-owner process.

### 2. Resolver Throughput Lags Collector Intake

Severity: Medium

Collectors are adding observations much faster than the resolver processes details. Recent remote counts showed a very large `pending` backlog compared with completed detail captures. In the recent 48-hour event window, collector `listing_observed` events were orders of magnitude higher than successful detail captures.

Impact:

- Listings remain unresolved for a long time.
- Recommendations and purchase-history matching rely heavily on card-level data.
- Error and stale-processing cleanup becomes more important as backlog age grows.

Recommended fix:

- Stabilize profile ownership before increasing resolver concurrency.
- Add queue age and resolver throughput metrics to the dashboard.
- Add a controlled resolver schedule that drains bounded batches.
- Prefer smaller, more frequent resolver runs over long ambiguous runs until profile isolation is fixed.

### 3. Lost And Terminated Workflow Runs

Severity: Medium

Recent workflow history included `lost`, `terminated`, and `failed` statuses. Some of this is expected across deploys and manual stops, but frequent `lost` status makes operator state ambiguous.

Impact:

- The UI can show stale or confusing run state.
- Operators may not know whether a worker is really dead, stopped intentionally, or disconnected by deploy.
- Run history is harder to interpret when diagnosing failures.

Recommended fix:

- Add explicit deploy-stop events before container restart when possible.
- On service startup, reconcile old active runs into a clearer terminal state with a reason such as `service_restarted`.
- Show the latest workflow event and process liveness side by side in the worker detail view.

### 4. Stale Processing Rows

Severity: Medium

Remote inspection showed rows still in `processing` from earlier dates. These rows may be claim leftovers from interrupted resolver runs.

Impact:

- Stale rows can be skipped by normal pending-only resolver runs.
- Queue counts overstate active work.
- Manual troubleshooting is required unless cleanup is automated.

Recommended fix:

- Run or schedule stale-processing recovery.
- Make resolver startup recover claims for the same worker id when safe.
- Add a dashboard indicator for oldest processing row age.

### 5. Event Vocabulary Still Has Edge-Case Drift

Severity: Low to Medium

The worker event registry covers the main happy path, but exception paths have previously emitted unregistered workflow event names such as `active_claim_interrupted` and `browser_context_failed`.

Impact:

- Audit tables are harder to group consistently.
- Registry-driven UI and validation can miss exceptional failures.
- Event-based projections become less reliable.

Recommended fix:

- Register all emitted event types or map exception paths to existing registered events with structured `reason` fields.
- Require all new worker-originated events to pass through the regulated event writer.
- Add tests that scan emitted literals against the registry.

### 6. Deployment Reproducibility

Severity: Low to Medium

Deploying from a dirty working directory can sync unrelated local files if the migration script runs directly from the workspace. A clean temporary worktree was used for the recent source-only deploy to avoid syncing untracked files.

Impact:

- Remote code can differ from the intended commit.
- Untracked artifacts can accidentally become part of deployment source.
- Debugging becomes harder when local, committed, and remote code diverge.

Recommended fix:

- Continue deploying from a clean worktree or committed checkout.
- Add a deploy preflight that refuses source sync when the local tree is dirty, unless explicitly overridden.
- Keep runtime sync separate from source-only deploys.

### 7. Remote Runtime Sizing And Dashboard Stats Cost

Severity: Medium

Remote inspection on `10.10.20.3` showed the host becoming CPU-bound while active browser workers and the dashboard were running together:

- current host shape: 4 vCPU, 7.7 GiB RAM;
- load average around 20 during inspection;
- memory and disk were not the immediate bottleneck;
- `auto-browser` was using roughly 110-125% CPU;
- `/api/listings?limit=50` could return quickly;
- `/api/workflows?stats=1` could exceed 20 seconds and block `/healthz`, because expensive workflow audit stats run synchronously on the Node server's main thread.

This is an operational/runtime sizing issue, not a local development runtime blocker. Do not track these remote host limits as dev-runtime requirements.

Planned host sizing:

- 8 vCPU;
- 16 GiB RAM.

Recommended software follow-up:

- keep `/api/workflows` lightweight by default;
- compute worker audit stats only for selected workers, or cache them in the background;
- add frontend timeout/backoff for worker polling;
- avoid large continuous resolver batches such as `--batch-size 1000` on small hosts.

## Good Signals

- Remote web service health check is passing.
- Docker container is healthy after restart.
- SQLite checkpoint and maintenance complete quickly.
- Live worker screenshot storage is present.
- Workflow-start argument validation is present in deployed source.
- Recent collector cycles completed normally before the last restart.

## Near-Term Stabilization Plan

1. Enforce browser profile ownership before launching any collector or resolver.
2. Reset or requeue stale `processing` rows after confirming no active resolver owns them.
3. Add dashboard metrics for backlog age, stale processing count, resolver success rate, and latest worker error.
4. Normalize exceptional worker event types through the registry.
5. Add deploy preflight checks for dirty source trees and remote rebuild health.
6. Move expensive workflow audit stats out of the default polling path.

## TypeScript Decision

TypeScript is not the immediate stability lever. The main problems are runtime coordination, process ownership, worker lifecycle, and operational hygiene. Runtime validation, profile locking, and better worker supervision should come first.

TypeScript may become useful later for shared event/API shapes, but an incremental path is preferable:

1. Add runtime schemas and event registry enforcement.
2. Add JSDoc typedefs for complex payloads.
3. Enable `checkJs` where useful.
4. Migrate shared schema/event modules only after runtime contracts are stable.
