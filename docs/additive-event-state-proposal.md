# Additive Event State Proposal

## Goal

Make app state safe to merge across local runs, workers, and deployments by treating every durable action as an immutable event. Two valid event sets should be unioned without corrupting state, and the app should compute the current view from deterministic reducers.

This is not the same as blindly using the newest row everywhere. Some state can use latest-wins. Other state, such as queue membership, needs ordered event reduction.

## Current State

The current implementation already records useful event history:

- `listing_events` records listing resolver activity and screenshots.
- `workflow_events` records worker lifecycle activity.
- `resolve_queue_events` records queue actions.

The current implementation is not strict event sourcing yet:

- `homepage_listings` is the current listing projection and is updated directly.
- `workflow_runs` is the current workflow projection and is updated directly.
- `resolve_queue_items` is the current queue projection and is updated directly.
- Latest-event queries generally order by `event_at DESC`, which is ambiguous when timestamps tie.
- Event tables are append-only by application convention, but the database does not reject event updates or deletes.

This is acceptable for the MVP, but it is fragile for multi-process or multi-deployment merging.

## Target Invariants

1. Events are immutable.

   After insertion, event rows are never updated or deleted. Corrections are new events.

2. Event IDs are globally unique and idempotent.

   Merging the same event set twice should not duplicate effects.

3. Event-set merge is additive.

   The merge operation is a union by `event_id`. It must not depend on source order.

4. Projection state is derived.

   Tables such as `resolve_queue_items`, `workflow_runs`, and current listing state are projections. They may be cached for performance, but they must be rebuildable from events.

5. Current state is deterministic.

   The same event set must always produce the same current state.

6. Ordering is explicit.

   Reducers use a deterministic order, not just wall-clock timestamps.

## Event Envelope

All durable app events should converge on a shared envelope:

```json
{
  "event_id": "01J...",
  "event_seq": 12345,
  "event_type": "resolve_queue_added",
  "entity_type": "resolve_queue_item",
  "entity_id": "marketplace-listing-id",
  "event_at": "2026-05-13T18:40:00.000Z",
  "source_id": "macbook-local",
  "actor": "viewer",
  "workflow_run_id": "run-id",
  "causation_id": "command-id",
  "correlation_id": "ui-action-id",
  "schema_version": 1,
  "payload_json": {}
}
```

Recommended fields:

- `event_id`: globally unique, preferably ULID or UUIDv7.
- `event_seq`: local monotonic insert sequence for deterministic local ordering.
- `source_id`: stable deployment or process source.
- `entity_type` and `entity_id`: reducer target.
- `causation_id`: command/action that produced the event.
- `correlation_id`: user operation or workflow that groups events.
- `payload_json`: typed event payload.

For SQLite, `event_seq INTEGER PRIMARY KEY AUTOINCREMENT` can be added per event table, or a shared `app_events` table can own the sequence.

## Ordering Rule

Reducers should sort events by:

1. domain time if the event requires external observed ordering;
2. `event_at`;
3. `source_id`;
4. `event_id`;
5. local `event_seq` when reducing events from the same database.

For local SQLite projections, the common query should be:

```sql
ORDER BY event_at ASC, source_id ASC, event_id ASC
```

For "latest" reads:

```sql
ORDER BY event_at DESC, source_id DESC, event_id DESC
```

If we add ULID/UUIDv7 event IDs, `event_id` becomes a useful tie-breaker. If we keep random-suffix IDs, we should add `event_seq` and use it for local ordering.

## Reducer Rules

### Listing Resolver State

Use event reduction for resolver status:

- `detail_claimed` -> `processing`
- `detail_capture_succeeded` -> `done`
- `detail_capture_failed` -> `error`
- `detail_inactive_sold` -> `sold`
- `detail_inactive_pending_sale` -> `pending_sale`
- `detail_claim_released` -> `pending` or previous eligible state

Listing content fields can be latest-wins by successful content event:

- title
- price
- location
- description
- screenshot path
- snapshot path
- content hash

Reducer must ignore older content events after a newer successful content event.

### Resolve Queue State

Do not use simple latest-wins. Queue state is a state machine:

- `resolve_queue_added` or `resolve_queue_requeued` -> `queued`
- `resolve_queue_dispatched` -> `dispatched`
- `resolve_queue_completed` -> `completed`
- `resolve_queue_failed` -> `failed`
- `resolve_queue_cleared` -> `cleared`

Conflict policy:

- A later `requeued` can move `failed`, `cleared`, or `completed` back to `queued`.
- `dispatched` is valid only after `queued`.
- `completed` or `failed` is valid only after `dispatched`.
- `cleared` is valid from `queued` or `failed`.
- Invalid transitions are ignored by the projection and surfaced in an audit diagnostics view.

### Workflow State

Workflow lifecycle can mostly use ordered reduction:

- `worker_started` -> `running`
- `browser_context_ready` -> `running`
- `shutdown_requested` -> `stopping`
- `worker_completed` -> `exited`
- `worker_failed` -> `failed`
- OS liveness checks should be events too, not direct state-only updates.

The current `workflow_runs` table remains useful as a projection for UI performance.

## Storage Options

### Option A: Keep Separate Event Tables

Keep:

- `listing_events`
- `workflow_events`
- `resolve_queue_events`

Add common columns to each:

- `event_seq`
- `source_id`
- `entity_type`
- `entity_id`
- `causation_id`
- `correlation_id`
- `schema_version`

Pros:

- Smallest migration.
- Preserves current queries and UI.
- Lower implementation risk.

Cons:

- Reducer and merge logic is duplicated across tables.
- Cross-domain event ordering is harder.

### Option B: Add A Shared `app_events` Table

Introduce:

```sql
CREATE TABLE app_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_at TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT NOT NULL DEFAULT '',
  causation_id TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
```

Existing event tables can either become compatibility views/projections or remain as domain-specific detail tables keyed by `event_id`.

Pros:

- One merge protocol.
- One append-only enforcement path.
- Easier two-way worker/browser communication.

Cons:

- Larger migration.
- Existing API queries need adapters.

Recommendation: implement Option A first for this MVP, then move to Option B when worker/browser command separation lands.

## Database Enforcement

Add triggers that reject mutation on event tables:

```sql
CREATE TRIGGER IF NOT EXISTS prevent_listing_events_update
BEFORE UPDATE ON listing_events
BEGIN
  SELECT RAISE(ABORT, 'listing_events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_listing_events_delete
BEFORE DELETE ON listing_events
BEGIN
  SELECT RAISE(ABORT, 'listing_events are immutable');
END;
```

Repeat for `workflow_events` and `resolve_queue_events`.

Projection tables remain mutable, but only projection writers should mutate them.

## Merge Protocol

Merging two databases should:

1. Import event rows by `event_id`.
2. Skip existing event IDs.
3. Never overwrite existing events.
4. Rebuild affected projections from the merged event set.
5. Report invalid transitions and projection conflicts.

Current merge logic already inserts `listing_events` and `workflow_events` by `event_id`. It should be extended to:

- include `resolve_queue_events`;
- preserve ordering metadata;
- rebuild `resolve_queue_items`;
- optionally rebuild workflow/listing projections.

## Projection Rebuilds

Add explicit rebuild functions:

- `rebuildResolveQueueProjection(db)`
- `rebuildWorkflowRunProjection(db, workflowRunIds)`
- `rebuildListingDetailProjection(db, listingIds)`

The first production target should be `resolve_queue_items`, because queue state is the area most likely to break with multi-process actions.

Projection rebuilds should be safe to run after imports, during maintenance, and in tests.

## UI/API Impact

The UI can keep reading projection tables for speed:

- backlog tab reads `resolve_queue_items`;
- worker detail reads workflow/listing projections;
- audit panels read event tables.

Add diagnostics to show projection health:

- invalid queue transitions;
- duplicate causation IDs;
- event rows missing projection effects;
- projection rows whose current state does not match event reduction.

For user actions, API routes should append command/result events first, then update projections in the same transaction.

## Worker/Browser Two-Way Comms Fit

The same additive protocol can be used for browser-worker separation:

- UI writes command events.
- Worker claims command events.
- Worker writes progress/result events.
- UI watches projections and event logs.

Example command flow:

1. UI appends `resolve_queue_added`.
2. Dispatcher appends `worker_command_requested`.
3. Worker appends `worker_command_started`.
4. Worker appends listing events.
5. Worker appends `worker_command_completed` or `worker_command_failed`.
6. Projection reducer updates queue and workflow views.

This avoids a single master process owning all state transitions.

## Implementation Plan

### Phase 1: Harden Existing Event Tables

- Add `source_id`, `causation_id`, `correlation_id`, and `schema_version`.
- Add deterministic latest ordering.
- Add immutability triggers.
- Extend tests to prove event updates/deletes fail.
- Extend merge tests to include `resolve_queue_events`.

### Phase 2: Queue Projection From Events

- Implement `reduceResolveQueueEvents(events)`.
- Implement `rebuildResolveQueueProjection(db)`.
- Update queue mutations to append events and project through the reducer.
- Add tests for merge order independence:
  - A plus B equals B plus A.
  - duplicate import is idempotent.
  - requeue after failure works.
  - invalid dispatched-before-queued is ignored and reported.

### Phase 3: Workflow And Listing Projection Hardening

- Add reducers for workflow lifecycle state.
- Add deterministic latest listing content selection.
- Make `workflow_runs` and listing detail fields rebuildable enough for recovery.
- Add projection consistency checks to `marketplace:doctor`.

### Phase 4: Shared App Events Or Command Events

- Add `app_events` or a dedicated `worker_command_events` table.
- Move browser/worker communication onto command/result events.
- Keep current tables as projections for UI compatibility.

## MVP Acceptance Criteria

- All event tables reject `UPDATE` and `DELETE`.
- Latest-event reads use deterministic tie-breaking.
- Resolve queue projection can be rebuilt from `resolve_queue_events`.
- Merging event sets in either order produces identical `resolve_queue_items`.
- Importing the same event set twice is a no-op.
- Queue UI still reads fast projection rows.
- Audit UI shows every queue action with actor, time, and workflow linkage.

## Open Decisions

- Use ULID/UUIDv7 event IDs, or keep current IDs plus `event_seq`.
- Keep separate event tables for now, or introduce `app_events` immediately.
- Whether invalid transitions should be ignored, marked as diagnostics, or create explicit rejection events.
- How much of `homepage_listings` should be fully rebuildable in the first pass.
