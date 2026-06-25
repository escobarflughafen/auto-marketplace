# MVP Commit Review Notes - 2026-06-25

This note summarizes the MVP commits prepared for another developer review.
It intentionally excludes runtime artifacts and credentials.

## Commits

### `25e88c3` - Improve marketplace query and collector stats accuracy

Scope:
- Cleans noisy Marketplace card text before using collected titles as random-walk search keywords.
- Improves localized price extraction for listing query/stat paths.
- Keeps listing API statistics aligned with the full query result set rather than only the current page.

Primary files:
- `scripts/collect-marketplace-search-explorer.js`
- `scripts/lite-kql-fields.js`
- `scripts/marketplace-homepage-query.js`
- `test/marketplace-listings-api-stats.test.js`
- `test/marketplace-search-explorer.test.js`

Review focus:
- Price extraction SQL should not accidentally parse non-price card text.
- Search keyword cleanup should avoid over-filtering legitimate listing titles.
- Query stats should remain bounded on large result sets.

### `9fe3a0b` - Add cached summary and worker live metrics

Scope:
- Adds query-count and summary-projection caches for the dashboard summary path.
- Adds collector outcome buckets: observed, appended, updated, unchanged, rejected, and errors.
- Adds a lightweight worker live endpoint that can return cached stats and optionally reconcile one worker's OS health.
- Extends worker DB tests for collector outcome stats.

Primary files:
- `scripts/marketplace-homepage-db.js`
- `scripts/serve-marketplace-homepage.js`
- `test/marketplace-homepage-db.test.js`

Review focus:
- Cache invalidation/data-version logic should reflect listing and saved-query changes.
- Manual worker reconcile should not scan or reconcile all worker rows.
- `Appended` should mean actual new listing rows, not updated existing rows.

### `5df3cfd` - Refine marketplace monitor UI responsiveness

Scope:
- Updates the monitor UI around worker overview/detail responsiveness.
- Adds worker detail manual refresh and displays OS check/update timestamps.
- Shows worker metrics in a fit-to-container Tabulator layout.
- Continues the UI polish work for dark/light themes, table behavior, footer controls, and query/stat surfaces.

Primary files:
- `frontend/marketplace-monitor/app.js`
- `frontend/marketplace-monitor/index.html`
- `frontend/marketplace-monitor/listings-viewer.js`
- `frontend/marketplace-monitor/styles.css`

Review focus:
- Worker detail refresh should use the fast live path and only reconcile the selected worker on manual refresh.
- Worker overview table should fit its container without hiding important status/metric columns.
- Dark-mode badge/table contrast should remain readable.
- Existing listing/history table click behavior should not regress.

## Validation Already Run

- `node --check scripts/serve-marketplace-homepage.js`
- `node --check frontend/marketplace-monitor/app.js`
- `node --test test/marketplace-homepage-db.test.js`
- `node --test test/marketplace-workflow-lifecycle-reducer.test.js test/marketplace-homepage-db.test.js`
- `node --test test/marketplace-listings-api-stats.test.js test/marketplace-search-explorer.test.js`
- `npm run test:ui:mock`

The browser/API tests that bind localhost required the normal elevated local test permission.

## Deployment Notes

The code represented by these commits has been deployed to the production container during the MVP iteration and passed the remote health check.

Smoke checks performed during the iteration:
- `/api/summary` and `/api/listings` reported the same canonical listing count.
- `/api/workflows/:id/live?stats=1&reconcile=1` returned fresh `osCheckedAt`, cached `runtimeStats`, collector stats, and screenshots.

## Intentionally Uncommitted

These local artifacts were left out of the MVP commits:

- `=`: empty local artifact.
- `raw/`: temporary inventory CSV files.
- `test/remote-worker-host-api.test.js`: untracked remote-worker API test draft. It was not included because the matching tracked source implementation is not part of this current MVP commit set.

