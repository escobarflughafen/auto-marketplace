# Saved Query Count Cache Design

## Current Behavior

Saved queries are stored server-side in `saved_queries`. The overview bar asks
`/api/query/counts` to compute live counts for the saved queries currently shown
as cards.

This is exact, but it is expensive when:

- many saved queries are visible;
- each query scans a large result set;
- the dashboard polls frequently;
- workers are writing to the same database.

The UI has two different numbers:

- **saved query count**: how many saved query definitions exist;
- **result count**: how many listings currently match each saved query.

Those should not be treated as the same metric.

## Desired Model

Create a cached read model for saved-query result counts:

```sql
CREATE TABLE saved_query_count_cache (
  query_id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  query TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  data_version TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL,
  compute_elapsed_ms INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_saved_query_count_cache_stale
ON saved_query_count_cache (stale, computed_at);
```

`query_hash` should be a stable hash of the normalized query text. `data_version`
can initially be derived from a lightweight listing state watermark, such as
`MAX(updated_at)` or a maintained `listing_projection_version` value.

## Read Path

The overview bar should:

1. load saved query definitions from `saved_queries`;
2. load cached counts from `saved_query_count_cache`;
3. render cached values immediately;
4. mark stale values visually, for example `~12.4k`;
5. schedule background refresh for stale or missing cache rows.

The UI should not block on exact counts during normal polling.

## Refresh Path

Add an endpoint:

```text
POST /api/saved-queries/count-cache/refresh
```

Inputs:

- optional `queryIds`;
- optional `force`;
- optional `limit`.

Behavior:

- recompute only missing/stale rows by default;
- cap the number of refreshed queries per request;
- write `compute_elapsed_ms`;
- keep the previous count if recompute fails, but store `error`.

## Consistency Semantics

Cached count states:

- `fresh`: query hash and data version match current state;
- `stale`: query is valid but data version changed;
- `error`: last computation failed;
- `missing`: saved query has no cache row.

The UI should display:

- saved query definitions total;
- pinned saved query definitions total;
- cached result counts;
- stale/error indicators;
- last computed time.

## Invalidation

For MVP, invalidate by age and a coarse data watermark:

- stale after 5 minutes;
- stale when listing watermark changes;
- stale when saved query text changes.

Later, move to event-driven invalidation from listing projection updates.

## Why This Helps

The dashboard can stay responsive because it reads one small indexed cache table
instead of repeatedly executing full listing queries for each saved query card.
Exactness is preserved by background refresh, but the user does not wait for it
on every page refresh.
