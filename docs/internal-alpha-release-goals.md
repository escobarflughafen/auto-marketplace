# Internal Alpha Release Goals

## Release Target

Target: `v0.1.0-alpha.1`

Audience: trusted internal developers who can tolerate operational rough edges, read logs, run recovery commands, and give feedback on worker behavior, query UX, recommendations, and dashboard workflows.

This is not a public release and not a stable autonomous worker product.

## Alpha Definition

The project is alpha-ready when an internal developer can:

- start the dashboard from a documented command;
- access it with an admin token;
- inspect listings, queues, workers, audit logs, and recommendations;
- allow bounded browser worker concurrency while keeping interactive profile onboarding exclusive;
- run the non-browser backlog indexer;
- recover stale `processing` rows using documented steps;
- verify which Git commit is deployed remotely;
- understand known limitations before starting workers.

## Goals

### 1. Release Packaging

Purpose: make the alpha identifiable and reproducible.

Tasks:

- Add an `ALPHA.md` quickstart.
- Add a release checklist.
- Tag the exact release commit as `v0.1.0-alpha.1`.
- Record the deployed commit/image digest in release notes.
- Keep `raw/` and other local runtime artifacts out of the release.

Acceptance criteria:

- A developer can find one alpha guide from the repo root.
- `git status --short` is clean except intentionally ignored runtime paths before tagging.
- The remote service reports or documents the same commit/tag that was released.

### 2. Browser Worker Safety

Purpose: prevent the highest-risk alpha failure, operator-driven profile onboarding colliding with automated browser workers, while still allowing bounded collector/resolver throughput.

Tasks:

- Add workflow/type concurrency caps before starting worker workflows.
- Allow up to 2 Search Explorer runs.
- Allow up to 2 resolver runs across resolver modes.
- Treat `profile_onboarder` as an exclusive browser worker.
- Treat `backlog_indexer` as non-browser and do not cap it at the app level.
- Return a clear UI/API error if a configured cap or exclusive profile-onboarding rule blocks startup.
- Document how to override later only after profile isolation exists.

Acceptance criteria:

- Starting a second Search Explorer succeeds; starting a third fails with a clear message.
- Starting resolver workers succeeds until two resolver runs are active; starting a third fails with a clear message.
- Starting a profile onboarder while another browser worker is running fails with a clear message.
- Starting another browser worker while a profile onboarder is running fails with a clear message.
- Starting `backlog_indexer` while browser workers are running still works.
- Existing worker status UI shows why a launch was blocked.

### 3. Stale Processing Recovery

Purpose: make interrupted resolver state recoverable without manual SQL.

Tasks:

- Add a maintenance command or API action to list stale `processing` rows.
- Add a dry-run mode that reports affected listing IDs and ages.
- Add an execute mode that releases stale claims back to `pending` or `error`.
- Emit listing events for recovered claims.
- Add a dashboard action or documented CLI command for alpha operators.

Acceptance criteria:

- Dry run can be executed without changing DB state.
- Execute mode changes only rows older than the configured threshold.
- Recovered rows are visible in audit history.
- The alpha guide documents when and how to use it.

### 4. Worker Lifecycle Clarity

Purpose: make deploy/restart effects understandable.

Tasks:

- On server startup, reconcile previously active workflow runs.
- Mark old active runs as `lost` or `service_restarted` with a clear reason.
- Show process liveness and latest lifecycle event together in worker detail.
- Add release notes explaining that deploys terminate active child workers.

Acceptance criteria:

- Restarting the server does not leave ambiguous active runs in the UI.
- Worker detail distinguishes OS liveness from workflow status.
- Alpha users can tell whether a worker is alive, stopped, failed, or lost due to restart.

### 5. Recommendation Scheduler Boundary

Purpose: clarify that recommendation refresh is still transitional.

Tasks:

- Document current recommendation refresh behavior in `ALPHA.md`.
- Add a dedicated future task for `recommendation_indexer` / `match_indexer`.
- Keep manual scan visible as an operator action.
- Avoid adding more matcher complexity until it is promoted to a worker.

Acceptance criteria:

- Alpha users know recommendations can be refreshed by the embedded scheduler/manual scan.
- The release notes explicitly say recommendation refresh is not yet a first-class worker.

### 6. Deployment Reproducibility

Purpose: prevent accidental dirty deploys.

Tasks:

- Add a deploy preflight command or documented manual checklist.
- Refuse source deploy from dirty worktree unless explicitly overridden.
- Require tests and `git diff --check` before tagging.
- Record remote health checks after deploy.

Acceptance criteria:

- Release steps include clean tree, tests, tag, deploy, health check.
- Remote deployment can be traced back to a commit/tag.
- Local untracked runtime folders are not synced as source.

### 7. Internal Security Boundary

Purpose: state the trust model clearly.

Tasks:

- Document token-based auth as internal-only.
- Explain admin vs read-only token behavior.
- Document credential storage expectations.
- Warn that workers interact with a real Facebook session/profile.

Acceptance criteria:

- Alpha guide says trusted internal use only.
- Users know not to expose the dashboard publicly.
- Users know where credentials and browser profiles live.

## Suggested Implementation Order

1. Browser worker safety guard.
2. Stale processing recovery command/API.
3. `ALPHA.md` quickstart and release checklist.
4. Worker lifecycle startup reconciliation improvements.
5. Deployment preflight.
6. Tag `v0.1.0-alpha.1`.
7. Promote recommendation refresh to a dedicated worker in the next alpha.

## Release Checklist

- `node --check frontend/marketplace-monitor/app.js`
- `node --check scripts/serve-marketplace-homepage.js`
- `node test/marketplace-worker-events.test.js`
- `node test/marketplace-homepage-db.test.js`
- `node test/marketplace-resolved-listing-indexer.test.js`
- `node test/marketplace-listed-time-normalizer.test.js`
- `node test/marketplace-homepage-maintain-db.test.js`
- `git diff --check`
- `git status --short`
- remote `/healthz` returns OK
- container is healthy
- frontend cache key is updated
- release tag points at the deployed commit

## Explicit Non-Goals For `v0.1.0-alpha.1`

- Public authentication.
- Multiple concurrent browser workers on one profile.
- Full event sourcing.
- Dedicated recommendation worker.
- TypeScript migration.
- Automated cloud deployment.
- Production SLOs or uptime guarantees.
- Treating the current 4-vCPU remote performance ceiling as a dev-runtime requirement.

## Remote Runtime Note

The remote service can be CPU-bound on a 4-vCPU host when browser workers and workflow audit stats run concurrently. This is tracked as an operational/runtime sizing and dashboard-stats optimization issue, not a blocker for local development. The intended next host size is 8 vCPU and 16 GiB RAM.
