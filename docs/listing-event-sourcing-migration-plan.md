# Listing Event Sourcing Migration Plan

## Purpose

Move listing state from "mutable row plus audit trail" toward "immutable listing events plus deterministic latest-state projections" without disrupting the current Marketplace Monitor UI or workers.

This document focuses on `homepage_listings` and listing-related worker behavior. It complements `docs/additive-event-state-proposal.md`, which describes the broader event model.

## Current Model

The current system already has event tables and latest-state tables:

- `homepage_listings`: mutable latest listing projection used by the UI, query language, backlog resolver, and recommendation matching.
- `listing_events`: append-style listing event/audit history.
- `workflow_events`: worker lifecycle and status history.
- `resolve_queue_items`: mutable latest resolve queue projection.
- `resolve_queue_events`: queue action history.
- `purchase_history_match_queue`: mutable latest recommendation projection.

The current listing write path is not strict event sourcing yet:

- Collector upserts mutate `homepage_listings` directly.
- Resolver claim/success/failure/inactive updates mutate `homepage_listings` directly.
- Some events are emitted as audit side effects after the mutable state change.
- Some reducer policy is embedded in SQL, for example collector re-seeing an `error` listing resets `detail_status` to `pending`.

The practical current model is:

```text
worker action -> mutate latest-state table -> append audit/workflow events
```

The target model is:

```text
worker action -> append canonical event -> reducer updates latest-state projection
```

## Target Model

Use immutable listing events as the durable source for listing state transitions, while keeping `homepage_listings` as a fast materialized projection.

The UI and workers should continue to read `homepage_listings` for speed. The difference is that any state-changing write should first produce a canonical event, then apply a reducer to update `homepage_listings` in the same transaction.

Target invariants:

- Listing events are immutable after insertion.
- `homepage_listings` is a projection/cache, not the semantic source of truth.
- Listing status transitions are explainable from event history.
- Reducers are deterministic and tested.
- Projection rebuild is possible from canonical listing events.
- Existing UI queries and worker paths keep working during migration.

## Canonical Listing Events

These events should be enough for the first migration pass:

| Event | Producer | Meaning |
|---|---|---|
| `listing_observed` | collector | Collector saw a listing card. |
| `listing_card_updated` | collector/reducer | Collector saw materially changed card data. Optional if `listing_observed` includes before/after metadata. |
| `listing_detail_claimed` | resolver | Resolver claimed listing detail work. |
| `listing_detail_resolved` | resolver | Detail capture succeeded. |
| `listing_detail_failed` | resolver | Detail capture failed and needs review/retry. |
| `listing_claim_released` | resolver/maintenance | A stale/lost claim was released. |
| `listing_marked_sold` | resolver | Listing was detected as sold. |
| `listing_marked_pending_sale` | resolver | Listing was detected as pending sale. |
| `listing_status_reset` | collector/user/maintenance | Explicit reset, for example `error -> pending`. |

### Event Envelope

The first version can reuse the existing `listing_events` table shape, but the reducer should treat these fields as required:

- `event_id`
- `listing_id`
- `event_type`
- `event_at`
- `worker_id`
- `workflow_run_id`
- `status`
- `content_json`
- `content_hash`
- `screenshot_path`
- `snapshot_path`
- `error`

Future hardening can add:

- `event_seq`
- `source_id`
- `actor`
- `causation_id`
- `correlation_id`
- `schema_version`

## Projection Rules

The reducer should apply event payloads to a listing projection.

### Immutable Or First-Write Fields

| Field | Rule |
|---|---|
| `listing_id` | Identity. Never changes. |
| `first_seen_at` | Set by first observation only. |

### Collector-Owned Fields

| Field | Rule |
|---|---|
| `href` | Latest canonical URL from observation. |
| `source` | Latest observation source, such as `homepage`, `search`, or `manual`. |
| `source_keyword` | Latest observation keyword/source keyword. |
| `card_title` | Latest observed card title. |
| `card_text` | Latest observed card text. |
| `raw_card_json` | Latest raw card payload. |
| `last_seen_at` | Latest observation time. |
| `last_seen_rank` | Latest observed rank. |

### Resolver-Owned Fields

| Field | Rule |
|---|---|
| `detail_attempts` | Increment on `listing_detail_claimed`. |
| `detail_started_at` | Set on `listing_detail_claimed`. |
| `detail_completed_at` | Set on terminal detail result events. |
| `claimed_by` | Set on claim, cleared on terminal/release events. |
| `detail_title` | Set from resolved/inactive detail payload. |
| `detail_price` | Set from resolved/inactive detail payload. |
| `detail_location` | Set from resolved/inactive detail payload. |
| `detail_condition` | Set from resolved/inactive detail payload. |
| `detail_listed_ago` | Set from resolved/inactive detail payload. |
| `detail_seller_name` | Set from resolved/inactive detail payload. |
| `detail_json` | Set from resolved/inactive detail payload. |
| `screenshot_path` | Set from detail result event. |
| `snapshot_path` | Set from detail result event. |

### Status Rules

The reducer should own `detail_status`.

| Event | Status effect |
|---|---|
| first `listing_observed` | `pending` |
| `listing_observed` for existing `pending` | stays `pending` |
| `listing_observed` for existing `processing` | stays `processing` |
| `listing_observed` for existing `done` | stays `done` |
| `listing_observed` for existing `sold` | stays `sold` |
| `listing_observed` for existing `pending_sale` | stays `pending_sale` |
| `listing_observed` for existing `error` | stays `error` unless a reset event is emitted |
| `listing_status_reset` | status becomes event payload target, usually `pending` |
| `listing_detail_claimed` | `processing` |
| `listing_detail_resolved` | `done` |
| `listing_detail_failed` | `error` |
| `listing_claim_released` | `pending` or `error`, based on event payload |
| `listing_marked_sold` | `sold` |
| `listing_marked_pending_sale` | `pending_sale` |

This changes the current implicit collector rule. Today, collector re-observation of an `error` row silently resets it to `pending`. In the target model, that reset must be explicit via `listing_status_reset` with a reason such as `collector_reobserved_after_error`.

## Dispatchable Work Units

### 1. Event Contract

Workload: small-medium
Risk: low
Owner scope: docs and event constants.

Tasks:

- Define canonical listing event names.
- Define minimum payload for each event.
- Update `scripts/marketplace-worker-events.js` registry if needed.
- Document compatibility with existing `listing_events`.

Acceptance criteria:

- Event names and payload keys are documented.
- No runtime behavior changes.
- Existing workers still emit current events.

### 2. Pure Listing Reducer

Workload: medium
Risk: medium
Owner scope: new reducer module and tests.

Tasks:

- Add `reduceListingState(previousState, event)`.
- Add helper to normalize current `homepage_listings` rows into reducer state.
- Add tests for collector observation, resolver success/failure, sold/pending sale, claim release, and explicit reset.

Acceptance criteria:

- Reducer has deterministic results for all status transitions.
- `error -> pending` only happens through `listing_status_reset`.
- Tests cover first observation and repeated observation.

### 3. Collector Write Path Migration

Workload: medium-large
Risk: medium
Owner scope: collector upsert path in `scripts/marketplace-homepage-db.js` and collector scripts.

Tasks:

- Convert collector upsert to insert `listing_observed`.
- Apply reducer projection to `homepage_listings` in the same transaction.
- Emit `listing_status_reset` when policy chooses to requeue an error listing.
- Preserve current `new`, `existing_updated`, and `existing_same` event statuses for worker stats, or map them into canonical event metadata.

Acceptance criteria:

- UI still shows collected rows immediately.
- Query language results are unchanged except explicit reset semantics.
- Collector worker stats still distinguish done/skipped/error.
- Error/review reset is visible in event history.

### 4. Resolver Write Path Migration

Workload: medium-large
Risk: medium-high
Owner scope: resolver claim/result functions.

Tasks:

- Change claim to emit `listing_detail_claimed` then project.
- Change success to emit `listing_detail_resolved` then project.
- Change failure to emit `listing_detail_failed` then project.
- Change inactive detection to emit `listing_marked_sold` or `listing_marked_pending_sale`.
- Change claim release to emit `listing_claim_released`.

Acceptance criteria:

- Resolver queue behavior remains stable.
- `detail_attempts` increments once per claim.
- Lost/stale worker recovery remains visible and deterministic.
- Detail modal and listing table continue reading `homepage_listings`.

### 5. Projection Rebuild Tool

Workload: medium
Risk: medium
Owner scope: new maintenance script.

Tasks:

- Add a dry-run rebuild command for `homepage_listings` from canonical listing events.
- Compare rebuilt projection to current table.
- Report differences without writing by default.
- Add an execute mode after dry-run is trusted.

Example command:

```bash
npm run marketplace:home:rebuild-projections -- --dry-run
```

Acceptance criteria:

- Dry-run reports added/changed/missing projection rows.
- Rebuild order is deterministic.
- Tool can be used before remote migrations.

### 6. UI Audit Improvements

Workload: small-medium
Risk: low
Owner scope: web dashboard only.

Tasks:

- Show the latest canonical state event in listing/recommendation detail modals.
- Add status transition history to audit modal.
- Make explicit reset reasons visible.

Acceptance criteria:

- User can see why a listing is `pending`, `done`, `error`, `sold`, or `pending_sale`.
- Reset/retry decisions are visible without reading raw JSON.

## Recommended MVP Sequence

The safest first milestone is:

1. Event contract.
2. Pure reducer and tests.
3. Collector write-path migration only.
4. Explicit `error -> pending` reset event.
5. Deploy and observe.

Do not migrate resolver writes until collector behavior is stable. Resolver status drives worker coordination, so it has a higher blast radius.

## Parallel Dispatch Plan

These can run in parallel once the event contract is stable:

- Reducer implementation and tests.
- Projection rebuild dry-run skeleton.
- UI audit display using current event names.

These should be serialized:

- Collector migration after reducer tests pass.
- Resolver migration after collector migration has run in remote without regressions.

## Open Questions

- Should canonical events live in existing `listing_events`, or should a new shared `app_events` table be introduced first?
- Should `event_seq` be added before projection rebuild, or is `event_at + event_id` enough for the first pass?
- Should collector automatically reset `error -> pending`, or should that be controlled by a setting?
- Should `listing_card_updated` be a separate event, or should it be represented as `listing_observed` with `outcome=existing_updated`?
- Should recommendation matching consume canonical listing events directly, or continue consuming `homepage_listings` projection?

## Non-Goals For The First Migration

- Removing `homepage_listings`.
- Making UI queries replay events on read.
- Rebuilding every queue and workflow projection.
- Changing worker scheduling semantics.
- Changing recommendation matching behavior.

The first migration should improve auditability and reducer discipline while preserving current operational behavior.
