# Internal Alpha Guide

Target release: `v0.1.0-alpha.1`

This alpha is for trusted internal developers. It is a developer preview of the Marketplace monitor, worker controls, listing review, audit views, recommendations, and early worker scheduling model. It is not a public release and not a stable autonomous worker product.

## Trust Boundary

- Do not expose the dashboard publicly.
- Use the admin token only with trusted operators.
- Workers use a real Facebook browser profile/session.
- Credentials should stay in `secrets/credentials.json` on deployed hosts or local `credentials.json` during development.
- Read-only tokens can inspect data, artifacts, logs, and audit history, but should still be treated as internal.

## Start Locally

```bash
npm run marketplace:home:serve -- --admin-token dev-admin --read-only-token dev-readonly
```

Open the printed admin URL. If no token is provided, the server generates ephemeral admin/read-only URLs at startup.

## Worker Safety Rule

For this alpha, browser concurrency is intentionally bounded but not globally single-worker.

Browser workers:

- `collector`
- `resolver`
- `profile_onboarder`

Non-browser worker:

- `backlog_indexer`

Current limits:

- Search Explorer: up to 2 concurrent runs.
- Resolver workers: up to 2 concurrent runs across resolver modes.
- Profile Onboarder: 1 run, exclusive with other browser workers.
- Other worker modes: no app-level concurrency cap unless their queue/claim logic says otherwise.

The profile onboarder is intentionally interactive: it opens the shared Facebook profile, emits login-step events, and accepts operator commands from the dashboard for verification codes, checkpoint continuation, retry, and cancel. It blocks other browser workers while active so operator-driven login/checkpoint state is not mixed with automated browsing. The backlog indexer can run alongside browser workers because it does not open Facebook or use a Chromium profile.

## Stale Processing Recovery

If a deploy, browser crash, or manual stop leaves rows in `processing`, first run a dry run:

```bash
npm run marketplace:home:db:maintain -- --recover-stale-processing --stale-processing-seconds 1800 --dry-run
```

If the listed rows are safe to release:

```bash
npm run marketplace:home:db:maintain -- --recover-stale-processing --stale-processing-seconds 1800
```

This releases stale claims back to `pending`, decrements the interrupted attempt, and appends `detail_capture_interrupted` audit events.

Use `--stale-processing-status error` if the rows should go to review instead of pending.

## Current Known Limitations

- Recommendation refresh is still partly an embedded server scheduler, not a dedicated worker.
- Listing state is still stored as mutable projections in SQLite; full event-sourced reducers are planned but not active.
- Deploying active browser workers will stop their child processes.
- Token auth is internal-only, not public multi-user auth.
- The browser profile model is intentionally conservative until profile leasing or separate profiles are added.

## Release Checklist

Before tagging an alpha:

```bash
node --check frontend/marketplace-monitor/app.js
node --check scripts/serve-marketplace-homepage.js
node --check scripts/onboard-marketplace-profile-worker.js
node test/marketplace-profile-onboarder-worker.test.js
node test/marketplace-worker-events.test.js
node test/marketplace-homepage-db.test.js
node test/marketplace-resolved-listing-indexer.test.js
node test/marketplace-listed-time-normalizer.test.js
node test/marketplace-homepage-maintain-db.test.js
git diff --check
git status --short
```

Before announcing a remote alpha:

- remote `/healthz` returns OK;
- container is healthy;
- frontend cache key reflects the deployed build;
- deployed image digest and Git commit/tag are recorded;
- no untracked runtime folders are synced as source.
