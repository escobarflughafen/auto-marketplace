# Remote Worker Outbox Runtime Design

## Purpose

This document defines the worker-side design for the remote worker model. The
chosen consistency mechanism is the Transactional Outbox Pattern.

The host-side API shape is tracked in:

- `docs/remote-worker-api-v1-design-review-ticket.md`
- `docs/remote-worker-installable-runtime-design.md`

The concrete worker implementation boundary is tracked in:

- `docs/remote-worker-implementation-design.md`

The mutual liveness and offline behavior contract is tracked in:

- `docs/remote-worker-liveness-and-offline-behavior.md`

The worker runtime must allow collector, resolver, profile onboarder, and
backlog indexer processes to run outside the central app container while still
preserving the same event semantics used by the current local workers.

## Core Invariant

A worker never treats work as safely reported until the host acknowledges the
durable event batch that describes that work.

Worker rule:

```text
perform action
  -> commit local state and local outbox event in one local transaction
  -> upload event batch to host
  -> persist host ACK/checkpoint locally
  -> only then compact/drop local outbox data
```

The central app owns canonical listing, queue, workflow, and recommendation
projections. Remote workers own only their local runtime state, local cache,
artifacts waiting for upload, and unsynced event outbox.

## Worker Process Roles

The worker runtime should be shared by all worker types. Worker-specific browser
logic should plug into this runtime through a small adapter.

```text
remote-worker-runtime
  - config loader
  - local SQLite store
  - session registration
  - heartbeat loop
  - command/lease loop
  - domain work adapter
  - local outbox appender
  - structured process logger
  - artifact spooler
  - event sync loop
  - shutdown/recovery handling
```

Worker adapters:

- collector: emits listing observation and collector cycle events;
- resolver: emits detail capture and queue/command lifecycle events;
- profile onboarder: emits onboarding events and receives operator commands;
- backlog indexer: emits post-resolution metadata events without browser state.

## Worker Local State Model

Each worker process has a local SQLite database. The default path should be
derived from worker id and profile id, for example:

```text
artifacts/remote-workers/{worker_id}/worker.db
```

The local database is the worker's source of truth during network failure,
host restart, process restart, and retry.

### State Values

`worker_state` stores coarse process state:

```text
identity
- worker_id
- worker_type
- strategy
- worker_version
- source_id
- profile_id

session
- session_id
- session_status
- host_base_url
- registered_at
- last_heartbeat_at
- lease_expires_at
- last_host_checkpoint

runtime
- active_command_id
- active_claim_id
- active_lease_id
- active_entity_id
- active_listing_id
- browser_profile_path
- shutdown_requested
```

Only small scalar or JSON state belongs here. Listing content, screenshots,
snapshots, and raw page captures belong in outbox events or artifact spool
tables.

### Local Tables

Minimum local worker schema:

```sql
CREATE TABLE worker_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worker_outbox_events (
  event_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  batch_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  event_scope TEXT NOT NULL,
  event_at TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  worker_type TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  listing_id TEXT NOT NULL DEFAULT '',
  lease_id TEXT NOT NULL DEFAULT '',
  claim_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL DEFAULT '',
  local_created_at TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT '',
  acked_at TEXT NOT NULL DEFAULT '',
  compacted_at TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_worker_outbox_status_sequence
ON worker_outbox_events (status, sequence ASC);

CREATE TABLE worker_artifact_spool (
  artifact_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  local_path TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  uploaded_at TEXT NOT NULL DEFAULT '',
  acked_at TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_worker_artifact_spool_status_sequence
ON worker_artifact_spool (status, sequence ASC);

CREATE TABLE worker_remote_commands (
  command_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL DEFAULT '',
  claim_id TEXT NOT NULL DEFAULT '',
  command_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received',
  payload_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  acked_at TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE worker_sync_checkpoints (
  checkpoint_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The existing `scripts/worker-local-outbox.js` prototype already covers the
first useful slice: local state, local outbox, idempotent event flush, command
claim identity, heartbeat records, and stale-claim protection. The production
remote runtime should reuse the same semantics and evolve the transport from
direct DB writes to HTTP.

Process logs do not belong in `worker_outbox_events`. The runtime should write
structured stdout/stderr logs and let Docker/systemd handle capture and
retention. If local log indexing is needed, add a bounded diagnostic table or
rolling file that is explicitly non-reducing.

## Outbox Event States

The worker must treat outbox status as a state machine:

```text
pending -> sending -> sent -> acked -> compacted
pending -> sending -> failed -> pending
pending -> rejected
sent -> acked
sent -> pending
```

Meanings:

- `pending`: locally committed and not yet included in an upload attempt.
- `sending`: selected for an in-flight batch.
- `sent`: host received the request but local ACK commit is not complete.
- `acked`: host durably accepted the event or confirmed it was a duplicate of
  identical content.
- `rejected`: host refused the event as invalid or conflicting; the worker must
  stop or quarantine the command instead of dropping the event.
- `compacted`: worker has retained only minimal audit metadata.

The worker may safely drop payload/artifact files only after `acked` and after
any artifact ACK required by the event.

## Event Identity And Ordering

Each worker event needs both a globally unique event id and a local monotonic
sequence.

Recommended event id:

```text
{worker_id}:{local_sequence}:{event_type}:{content_hash_prefix}
```

The worker should not use pure random ids for domain events. A deterministic
event id per local sequence makes retry, duplicate detection, and support
inspection easier.

Reducer order on the host should use:

```text
event_at ASC, worker_id ASC, sequence ASC, event_id ASC
```

The sequence is local to the worker session. It is not a global ordering source.

## Worker API From The Worker Point Of View

### Register Session

The worker starts by registering or resuming a session:

```http
POST /api/v1/remote-workers/sessions
```

Request:

```json
{
  "workerId": "resolver-host103-01",
  "workerType": "resolver",
  "strategy": "queue",
  "workerVersion": "2026.06.16",
  "sourceId": "marketplace:remote:resolver",
  "profileId": "fb-vancouver-main",
  "capabilities": {
    "eventOutbox": true,
    "artifactUpload": true,
    "commands": true,
    "browser": true
  },
  "lastCheckpoint": {
    "lastAckedSequence": 1240,
    "lastAckedEventId": "resolver-host103-01:1240:worker_heartbeat:..."
  }
}
```

Response:

```json
{
  "sessionId": "remote-session-01J...",
  "status": "registered",
  "heartbeatSeconds": 15,
  "leaseSeconds": 90,
  "maxEventBatchSize": 100,
  "maxArtifactBytes": 5242880,
  "hostCheckpoint": {
    "lastAcceptedSequence": 1240,
    "missingSequences": []
  },
  "serverTime": "2026-06-16T12:00:00.000Z"
}
```

If the worker already has a `session_id`, it should send it in the request and
the host should resume it when compatible.

### Heartbeat

```http
POST /api/v1/remote-workers/sessions/:sessionId/heartbeat
```

Request:

```json
{
  "workerId": "resolver-host103-01",
  "status": "active",
  "currentState": "working",
  "activeLeaseId": "lease-123",
  "activeEntityId": "973408764691929",
  "lastLocalSequence": 1302,
  "lastAckedSequence": 1294,
  "pendingEventCount": 8,
  "pendingArtifactCount": 1,
  "metrics": {
    "rssMb": 380,
    "eventFlushLagMs": 2400
  }
}
```

Response:

```json
{
  "status": "ok",
  "leaseExpiresAt": "2026-06-16T12:01:30.000Z",
  "commandsAvailable": true,
  "shutdownRequested": false
}
```

Heartbeats are liveness and observability signals. They are not a substitute for
outbox event ACK.

### Claim Work

```http
POST /api/v1/remote-workers/sessions/:sessionId/claims
```

Request:

```json
{
  "workerType": "resolver",
  "strategy": "queue",
  "capacity": 1,
  "acceptedCommandTypes": ["resolve_listing_detail"],
  "profileId": "fb-vancouver-main"
}
```

Response:

```json
{
  "claims": [
    {
      "leaseId": "lease-123",
      "claimId": "claim-456",
      "commandId": "command-789",
      "commandType": "resolve_listing_detail",
      "entityType": "listing",
      "entityId": "973408764691929",
      "expiresAt": "2026-06-16T12:02:00.000Z",
      "payload": {
        "listingId": "973408764691929",
        "url": "https://www.facebook.com/marketplace/item/973408764691929/"
      }
    }
  ]
}
```

The worker must persist the lease and claim locally before it starts the domain
action. Terminal events for that command must include `leaseId`, `claimId`, and
`commandId` in the normalized remote event envelope. The event payload still
follows `scripts/marketplace-worker-events.js`.

### Renew Lease

```http
POST /api/v1/remote-workers/sessions/:sessionId/leases/:leaseId/renew
```

The worker renews active work before expiry. If renewal fails with a terminal
lease status, the worker should stop the domain action if possible and emit an
interrupted event locally.

### Upload Artifacts

Artifacts can be uploaded before or after event upload, but an event that
references an artifact should not be compacted until both the event and artifact
are ACKed.

```http
POST /api/v1/remote-workers/sessions/:sessionId/artifacts
```

For MVP, use multipart upload for binary data and include:

```json
{
  "artifactId": "artifact-123",
  "eventId": "event-123",
  "kind": "screenshot",
  "sha256": "hex",
  "sizeBytes": 123456,
  "metadata": {
    "format": "jpeg",
    "quality": 25
  }
}
```

### Flush Events

```http
POST /api/v1/remote-workers/sessions/:sessionId/events
```

Request:

```json
{
  "workerId": "resolver-host103-01",
  "batchId": "batch-01J...",
  "events": [
    {
      "eventId": "resolver-host103-01:1301:detail_capture_started:2f3a",
      "sequence": 1301,
      "eventAt": "2026-06-16T12:00:20.000Z",
      "eventScope": "listing",
      "eventType": "detail_capture_started",
      "status": "started",
      "workerId": "resolver-host103-01",
      "workflowRunId": "remote-session-01J...",
      "workerType": "resolver",
      "strategy": "queue",
      "entityId": "973408764691929",
      "listingId": "973408764691929",
      "leaseId": "lease-123",
      "claimId": "claim-456",
      "commandId": "command-789",
      "payload": {
        "url": "https://www.facebook.com/marketplace/item/973408764691929/"
      }
    }
  ]
}
```

Response:

```json
{
  "batchId": "batch-01J...",
  "status": "accepted",
  "accepted": [
    {
      "eventId": "resolver-host103-01:1301:detail_capture_started:2f3a",
      "sequence": 1301
    }
  ],
  "duplicates": [],
  "rejected": [],
  "checkpoint": {
    "lastAcceptedSequence": 1301,
    "lastAcceptedEventId": "resolver-host103-01:1301:detail_capture_started:2f3a"
  },
  "ackToken": "opaque-host-token"
}
```

Duplicate events with identical canonical content are ACK-equivalent. Duplicate
event ids with different content must be rejected and surfaced as a worker error.

### Complete Lease

```http
POST /api/v1/remote-workers/sessions/:sessionId/leases/:leaseId/complete
```

This route is a convenience projection signal. The source of truth is still the
terminal outbox event. The host should reject lease completion if the matching
terminal event has not been durably ingested.

### Commands

Profile onboarder and future interactive workers poll commands:

```http
GET /api/v1/remote-workers/sessions/:sessionId/commands
POST /api/v1/remote-workers/sessions/:sessionId/commands/:commandId/ack
```

The worker must emit a `user_command_received` event into the outbox before
executing an accepted interactive command.

## Worker Runtime Loops

### Startup Loop

1. Open local SQLite store.
2. Load persisted identity and last session if present.
3. Register or resume host session.
4. Reconcile host checkpoint with local outbox.
5. Recover interrupted local command state.
6. Start heartbeat, sync, and command/claim loops.
7. Start worker adapter.

### Work Loop

1. Claim or receive work.
2. Persist active command/claim/lease locally.
3. Append `*_started` outbox event.
4. Execute domain action.
5. Append content/detail/observation events.
6. Append terminal success, bypass, unavailable, interrupted, or failure event.
7. Flush outbox.
8. Complete lease only after the terminal event is ACKed.
9. Clear active local state.

### Sync Loop

1. Select pending events by sequence.
2. Mark selected rows as `sending` with a `batch_id`.
3. POST the batch to host.
4. Mark accepted and duplicate rows as `acked`.
5. Mark rejected rows as `rejected`.
6. Store host checkpoint.
7. Retry transient failures with backoff.
8. Compact old ACKed rows after the retention window.

The sync loop should be independent from the domain work loop. Domain work must
continue only as far as local disk can safely record events. If local outbox
backlog grows past a configured threshold, browser work should pause until sync
catches up.

### Shutdown Loop

1. Mark shutdown requested in local state.
2. Stop accepting new claims.
3. Try to finish or interrupt active domain work.
4. Append `shutdown_requested` or `worker_completed`/`worker_failed`.
5. Flush pending events within a bounded timeout.
6. Leave unsynced local events in place for restart recovery.

## Recovery Rules

### Worker Restart

On restart, the worker loads local active state:

- If the active command has no terminal local event, emit
  `detail_capture_interrupted` or the equivalent worker-type event.
- If terminal local events exist but are not ACKed, retry sync before claiming
  more work.
- If the host says the lease was reassigned, keep old events for audit but do
  not emit a late terminal success for the stale claim.

### Host Restart

The worker keeps heartbeating and retrying event batches. The host uses
idempotent event ids and checkpoints to accept already-sent events safely.

### Network Partition

The worker continues only while local outbox backlog is under a configured
limit. Recommended defaults:

```text
max_pending_events = 10000
max_pending_artifact_bytes = 1024 MB
pause_when_event_flush_lag_seconds = 300
```

Once a threshold is crossed, the worker emits a local `worker_backpressure`
event and pauses browser actions until sync recovers.

## State Names For UI

Worker runtime state should be low-cardinality and semantic:

```text
starting
registering
idle
claiming
working
syncing
backpressure
waiting_for_user
sleeping
stopping
failed
completed
lost
```

Detailed event types should remain in the audit log. Dashboard columns should be
derived by reducer, not by ad hoc string matching in UI code.

Suggested counters:

- attempted: work items with a started event for this worker/session;
- done: work items with a successful terminal event;
- skipped: work items with bypass/unavailable/not-eligible terminal events;
- review: work items with failed, interrupted, rejected, or user-review-needed
  terminal events.

## Configuration

Worker config should be separated into transport, runtime, browser, and
adapter-specific sections.

```json
{
  "transport": {
    "hostBaseUrl": "http://10.10.20.3:21435",
    "apiVersion": "v1",
    "workerTokenEnv": "MARKETPLACE_WORKER_TOKEN",
    "heartbeatSeconds": 15,
    "eventFlushSeconds": 2,
    "maxEventBatchSize": 100,
    "requestTimeoutMs": 10000
  },
  "runtime": {
    "workerId": "resolver-host103-01",
    "workerType": "resolver",
    "strategy": "queue",
    "localDbPath": "artifacts/remote-workers/resolver-host103-01/worker.db",
    "maxPendingEvents": 10000,
    "maxPendingArtifactBytes": 1073741824,
    "ackedRetentionDays": 7
  },
  "browser": {
    "profileId": "fb-vancouver-main",
    "headless": true,
    "screenshotFormat": "jpeg",
    "screenshotQuality": 25
  },
  "adapter": {
    "claimCapacity": 1,
    "maxRuntimeSeconds": 300,
    "refreshSeconds": 90
  }
}
```

## First Implementation Slice

The first remote-worker slice should be intentionally small:

1. Keep current local workers and shared DB in production.
2. Add host API tables for remote sessions and event ingest.
3. Convert `scripts/worker-local-outbox.js` flush path from direct central DB
   writes to HTTP.
4. Add a mock remote worker that processes test commands only.
5. Validate event ids, claim ids, duplicate detection, and ACK checkpoints.
6. Add reducer integration for command lifecycle events.
7. Add dashboard read-only visibility for remote sessions beside local
   workflow runs.
8. Move one non-browser worker first, preferably `backlog_indexer`.
9. Move resolver after claim/lease and artifact upload are proven.
10. Move collector last because it can generate high event volume.

## Implementation Modules

Proposed modules:

```text
scripts/remote-worker-runtime.js
scripts/remote-worker-local-store.js
scripts/remote-worker-api-client.js
scripts/remote-worker-event-sync.js
scripts/remote-worker-artifact-sync.js
scripts/remote-worker-command-loop.js
scripts/remote-worker-state-machine.js
scripts/remote-worker-adapters/backlog-indexer.js
scripts/remote-worker-adapters/resolver.js
scripts/remote-worker-adapters/collector.js
scripts/remote-worker-adapters/profile-onboarder.js
test/remote-worker-runtime.test.js
test/remote-worker-api-contract.test.js
test/remote-worker-sync-recovery.test.js
```

The current `worker-local-outbox` prototype can either be renamed into these
modules or kept as the test fixture until the HTTP path is stable.

## Non-Goals For The First Slice

- Do not replace the production local worker launcher immediately.
- Do not introduce Kafka, NATS, or Temporal for the first HTTP outbox slice.
- Do not make workers write to the central SQLite database over a mounted path.
- Do not add a second event vocabulary for remote workers.
- Do not ACK events before the host has durably stored enough information to
  replay or reduce them.

## Acceptance Criteria

- Worker local state survives process restart.
- Events are always locally durable before network upload.
- Host ACK is required before local event compaction.
- Duplicate identical events are treated as accepted.
- Duplicate conflicting events are rejected and retained locally.
- Terminal command/listing events include `leaseId`, `claimId`, and
  `commandId` in the remote envelope when the work came from a host claim.
- Stale terminal events cannot overwrite a newer claim.
- Worker backpressure pauses new browser work when local sync falls behind.
- The same host reducer handles local and remote worker event semantics.
- First implementation is testable without Facebook or a real browser.
