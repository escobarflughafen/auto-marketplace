# Code Review Ticket: Worker Local Outbox MVP

## Scope

Review the first tested slice of the safer worker communication model:

- `scripts/worker-local-outbox.js`
- `test/worker-local-outbox.test.js`
- `test/helpers/worker-event-mocks.js`

This slice is intentionally not wired into the live browser workers yet. It establishes the module boundary for local worker state, local event outbox, central command queue, event flush, projection, and stale-worker recovery.

## Goal

Move away from workers directly mutating shared central projections as their primary communication path.

Target model:

```text
central command queue
  -> worker claims command
  -> worker records local state
  -> worker appends local outbox events
  -> worker flushes events centrally
  -> reducer updates central command projection
```

## Review Focus

Check whether the module provides a sound foundation for:

- local worker cache/state;
- local durable outbox;
- idempotent central event ingestion;
- command claim semantics;
- claim identity that prevents late stale-worker terminal events from overwriting newer claims;
- exact `claim_id` matching for terminal command projection;
- terminal command immutability after first successful terminal projection;
- command lifecycle event IDs that include the claim identity;
- stale command recovery;
- test-labeled mock data;
- future integration into real browser workers.

## Current Behavior

The module provides:

- worker-local SQLite `worker_state`;
- worker-local SQLite `worker_outbox_events`;
- central `worker_event_log`;
- central `worker_heartbeats`;
- central `browser_commands`;
- command append/list/claim helpers;
- per-claim `claim_id` values;
- terminal event projection that requires exact `claim_id`;
- terminal command immutability for succeeded/failed/cancelled commands;
- claim-aware command lifecycle event IDs;
- batch-limited outbox flush;
- idempotent central inserts by `event_id`;
- duplicate `event_id` mismatch detection before a local outbox event is marked flushed;
- command projection from flushed worker events;
- idempotent projection event claiming before command mutation;
- heartbeat/profile lease records;
- expired-lease command recovery;
- explicit worker-restart command recovery;
- stale claimed-command requeue;
- `runWorkerCommandOnce()` for a complete mock command lifecycle.

All mock events and commands in tests are labeled with `test_event`.

## Tests

Run:

```bash
node --test test/worker-local-outbox.test.js
node --check scripts/worker-local-outbox.js
node --check test/helpers/worker-event-mocks.js
node --check test/worker-local-outbox.test.js
```

Current expected result:

- 22 tests pass.

## Reviewer Verdict Follow-Up

Initial review noted that stale-worker recovery was not integration-ready without claim identity. The current slice adds `claim_id` to command claims and requires terminal command events to match the current claim before they can update the command projection.

Regression coverage now includes:

- worker A claims a test command;
- worker A is treated as stale and the command is requeued;
- worker B claims the command with a different `claim_id`;
- worker B completes the command;
- worker A later flushes stale terminal events;
- stale success and stale failure events are skipped and cannot overwrite worker B's completed command state.

Follow-up review required stricter integration gates:

- terminal projections require exact `claimId`;
- terminal commands are immutable after the first matching completion/failure;
- command lifecycle event IDs include claim identity.

Those requirements are now covered by focused regression tests.

Prior review verdict:

- not prod-ready yet;
- solid MVP foundation for integration planning;
- `claim_id` is present;
- stale terminal events cannot overwrite newer claims;
- terminal projection is immutable;
- focused test suite passes.

Latest review verdict:

- integration-ready MVP at the module level;
- not production-ready runtime until integrated into the live worker lifecycle with profile lease enforcement;
- duplicate `event_id` mismatch detection is present;
- projection event claiming is idempotent;
- command projection updates require matching claim and non-terminal status;
- heartbeat/lease records exist;
- explicit worker restart recovery exists.

Verified by reviewer:

```bash
node --test test/worker-local-outbox.test.js
node --check scripts/worker-local-outbox.js
node --check test/helpers/worker-event-mocks.js
node --check test/worker-local-outbox.test.js
```

Current result:

- 22 of 22 focused tests pass.

Refinement follow-up now covers four of the latest review blockers:

- worker heartbeat/profile lease records and expired-lease requeue;
- projection race hardening through idempotent projection-event claiming and guarded command updates;
- duplicate central `event_id` mismatch detection;
- explicit requeue path for commands claimed by a restarted worker.

## Before Prod

Required before production runtime:

- integrate the module into the main DB/module boundary;
- add a live-worker smoke test with a real command lifecycle.
- enforce heartbeat/profile leases from the live worker lifecycle.

## Specific Questions

1. Should `worker_event_log` and `browser_commands` stay in this standalone module for now, or move into `marketplace-homepage-db.js` before integration?
2. Should command projection events use a generic applied-events table, or keep `browser_command_projection_events` scoped to browser commands?
3. Should `runWorkerCommandOnce()` flush immediately, or should flushing be controlled by a separate worker loop for better batching?
4. Should stale command recovery emit an explicit event before/after requeueing?
5. Is the current command ordering rule sufficient: `priority DESC, requested_at ASC, command_id ASC`?
6. Should local worker outbox use SQLite long-term, or should we also support JSONL spool files for easier manual recovery?
7. Should stale terminal events be retained only as applied/skipped projection records, or should they also generate explicit diagnostic events?
8. Should terminal command states include a dedicated `terminal_event_id` and `terminal_claim_id` for audit queries?

## Known Limitations

- Not integrated into live workers.
- Heartbeat/profile lease semantics are module-local and not yet enforced by live workers.
- No HTTP transport yet; workers still use direct DB handles in tests.
- Projection currently updates only command state, not listing/resolve queue projections.
- Central command/event schema is prototype-local and may need migration into the main DB schema.

## Acceptance Criteria For This Ticket

- Reviewer agrees the local outbox and command lifecycle semantics are correct enough for MVP integration, not production runtime rollout.
- Reviewer identifies whether schema should remain isolated or move into the main DB helper.
- Reviewer confirms failure preservation, exact `claim_id`, terminal immutability, and stale-worker recovery behavior are acceptable.
- Reviewer confirms all test data is clearly marked as `test_event`.
