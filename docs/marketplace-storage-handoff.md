# Marketplace Storage Handoff

## Current State

- Local resolved artifacts are dominated by `artifacts/marketplace-homepage/details`.
- Recent measurement:
  - `details/`: about `5.5 GB`
  - main listing screenshots: `1,991` PNGs, about `4.76 GB`
  - thumbnail screenshots: `3,884` PNGs, about `864 MB`
  - markdown snapshots: about `11 MB`
- Target is roughly `200 KB` of visual artifact storage per resolved listing.

## Implemented Going Forward

New backlog resolver captures now default to storage-saving JPEG screenshots:

- screenshot format: `jpeg`
- screenshot extension: `.jpg`
- screenshot scope: viewport, not full-page
- JPEG quality: starts at `55`
- artifact budget: `200 KB`
- thumbnails: not saved by default

Relevant flags:

```bash
--screenshot-format jpeg|png
--screenshot-quality 55
--artifact-budget-kb 200
--screenshot-viewport
--screenshot-full-page
--capture-thumbnails
--no-capture-thumbnails
```

The capture metadata is stored in detail event content under:

```text
artifacts.screenshot
```

It includes format, quality, byte size, budget, and whether the capture fit the budget.

## Remaining Work

Existing artifacts have not been compacted. Recommended next step:

1. Add a dry-run compaction script.
2. Convert existing main listing PNGs to JPEG.
3. Update `homepage_listings.screenshot_path`.
4. Update listing event `screenshot_path` and artifact JSON paths.
5. Delete `*-thumb-*.png` files by default.
6. Optionally rewrite markdown links from `.png` to `.jpg`.
7. Run SQLite maintenance/checkpoint after DB updates.

Expected result after compaction:

- `details/` should drop from about `5.5 GB` to roughly `320-450 MB`.

## Verification Already Run

```bash
node --check scripts/process-marketplace-homepage-backlog.js
node --test test/marketplace-homepage-backlog.test.js
node --test test/*.test.js
```

