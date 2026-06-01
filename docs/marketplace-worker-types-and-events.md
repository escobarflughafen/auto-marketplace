# Marketplace Worker Types And Events

## Purpose

The runtime should converge on explicit worker types by responsibility:

- `collector`
- `resolver`
- `profile_onboarder`
- `backlog_indexer`

Worker variants are strategies, not separate worker classes. This keeps browser launch, profile lease, auth/session handling, logging, command handling, and live event transport shared.

The event registry lives in:

- `scripts/marketplace-worker-events.js`

That file is the source of truth for allowed worker types, strategies, event names, event scopes, destination tables, and minimum payload keys.

## Worker Types

### Collector

Collector workers discover listing cards and update the listing observation projection.

Strategies:

- `feed`: browse the Marketplace feed without a keyword.
- `search`: collect listings for an explicit keyword/query.
- `explorer`: choose the next query from seed/title-bag state.

Collector workers should emit:

- workflow lifecycle events;
- profile/session events;
- collector cycle events;
- `listing_observed` events for every observed listing.

### Resolver

Resolver workers capture listing detail pages and update detail projections.

Strategies:

- `queue`: claim eligible backlog rows continuously.
- `selected`: resolve an explicit listing ID set.
- `filtered`: resolve rows matching status/source/keyword/time filters.

Resolver workers should emit:

- workflow lifecycle events;
- profile/session events;
- detail capture events;
- command lifecycle events when running under a dispatcher.

### Profile Onboarder

Profile onboarder workers establish or repair the shared Facebook browser profile. They are browser workers, but unlike collector and resolver workers they are interactive: the central app can send operator commands back to the running worker while it waits on login, two-factor verification, or checkpoint approval.

Strategies:

- `guided_login`: open the configured profile, submit configured credentials when a login form is present, emit step screenshots/prompts, and wait for operator commands when Facebook requires additional input.

Profile onboarder workers should emit:

- workflow lifecycle events;
- profile/session events;
- onboarding step events;
- `user_command_received` events for dashboard-submitted commands;
- terminal `profile_ready` or `profile_onboarding_failed` events.

Supported interactive commands today:

- `submit_verification_code`
- `continue_after_external_approval`
- `retry_credentials`
- `cancel`

The managed workflow server injects the profile onboarder worker ID. Operators should not set it manually, because the same ID is used for workflow events and the file-backed command channel.

Concurrency convention: profile onboarder is exclusive with other browser workers because it is operator-interactive. Collector and resolver workers are not globally blocked by the browser-worker category; they use narrower workflow/type caps.

### Backlog Indexer

Backlog indexer workers compute derived metadata from already resolved listings. They do not open Facebook, do not need a browser profile, and should not participate in browser profile leasing.

Strategies:

- `resolved_metadata`: normalize and index post-resolution fields, starting with listed-time ranges derived from `detail_listed_ago`.

Backlog indexer workers should emit:

- workflow lifecycle events;
- `backlog_index_started`;
- `backlog_index_completed`;
- `backlog_index_failed`.

## Event Scopes

### `workflow`

Run-level lifecycle and status events. Destination today: `workflow_events`.

Examples:

- `worker_started`
- `worker_heartbeat`
- `worker_sleeping`
- `worker_completed`
- `worker_failed`
- `shutdown_requested`
- `profile_lease_acquired`
- `profile_lease_rejected`
- `profile_lease_released`
- `browser_context_launch_started`
- `browser_context_ready`
- `browser_context_closing`
- `browser_context_closed`
- `session_ready`
- `auth_required`
- `profile_onboarding_started`
- `profile_onboarding_step`
- `credentials_submitted`
- `verification_required`
- `external_approval_required`
- `user_command_received`
- `profile_ready`
- `profile_onboarding_failed`
- `backlog_index_started`
- `backlog_index_completed`
- `backlog_index_failed`

### `listing`

Listing-level observation or detail events. Destination today: `listing_events`.

Collector examples:

- `listing_observed`

Resolver examples:

- `detail_capture_started`
- `detail_capture_succeeded`
- `detail_capture_bypassed`
- `content_changed`
- `detail_capture_failed`
- `detail_capture_interrupted`
- `listing_unavailable`

### `resolve_queue`

Queue-control events. Destination today: `resolve_queue_events`.

Examples:

- `resolve_queue_added`
- `resolve_queue_requeued`
- `resolve_queue_dispatched`
- `resolve_queue_completed`
- `resolve_queue_failed`
- `resolve_queue_cleared`

These are currently server/reducer events, not browser-worker events.

### `command`

Dispatcher command lifecycle events. Destination today: `worker_event_log` in the local-outbox prototype.

Examples:

- `browser_command_claimed`
- `browser_command_started`
- `browser_command_succeeded`
- `browser_command_failed`

Command terminal events must include `claimId` so stale workers cannot overwrite newer claims.

## Envelope

All new worker-originated events should be representable as:

```json
{
  "event_id": "generated-id",
  "event_type": "collector_cycle_completed",
  "event_at": "2026-05-23T12:00:00.000Z",
  "worker_type": "collector",
  "strategy": "feed",
  "workflow_run_id": "run-id",
  "worker_id": "run-id",
  "source_id": "marketplace:home:collect",
  "payload": {}
}
```

The existing tables do not all have identical columns, so adapters may map this envelope into the current destination table shape. The event name and payload contract should still come from the registry.

## Implementation Rules

- Do not add a new worker class when a strategy is enough.
- Do not add ad hoc event names directly in worker scripts; add them to `scripts/marketplace-worker-events.js` first.
- Workflow events describe run/session/browser state.
- Listing events describe one listing and must include a listing ID.
- Collector scripts should stop relying only on log lines for status; emit durable workflow and listing events.
- Resolver scripts should preserve `claimId` in every terminal detail/command event before multi-worker runtime rollout.
- Profile onboarder scripts may accept central-app commands, but every accepted command must also be emitted as `user_command_received`.
- Live UI transport should push the same events that are persisted, not a separate vocabulary.

## Migration Order

1. Keep the current worker scripts running as-is.
2. Add small event emit hooks to the collector and resolver loops.
3. Have each hook validate against `scripts/marketplace-worker-events.js`.
4. Persist through existing DB tables.
5. Mirror the same events to stdout JSONL or server push for real-time UI.
6. Move command/claim lifecycle onto the local-outbox model once dispatcher integration starts.

## Current Implementation Status

Implemented now:

- worker type/strategy metadata is defined for managed workflows in `scripts/serve-marketplace-homepage.js`;
- managed collector and resolver scripts receive `--worker-id` so events can attach to a workflow run;
- profile onboarder is a managed interactive browser worker with dashboard command controls;
- `scripts/marketplace-worker-event-writer.js` validates registry events and writes them to current DB tables;
- homepage collector emits workflow lifecycle, session, sleep, cycle, and `listing_observed` events;
- search explorer emits workflow lifecycle, session, sleep, query selection, cycle, and `listing_observed` events;
- resolver event names are registered and remain emitted by the existing backlog resolver path.

Still pending:

- migrate resolver event emission through the registry writer;
- add `claimId` to live resolver listing terminal events;
- mirror persisted events to a live SSE/WebSocket stream;
- collapse the two collector scripts behind one collector runner with `feed`, `search`, and `explorer` strategies.
