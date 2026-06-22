# Ticket: Review Remote Worker API v1 Design

## Summary

Design a versioned host API that lets remote workers run outside the central app
process while preserving the current worker event semantics. The goal is to add
the new API beside the existing shared-DB worker implementation, not replace the
current production workers in one step.

The worker-side runtime, local state, outbox, ACK, recovery, and rollout design
is tracked in:

- `docs/remote-worker-outbox-runtime-design.md`
- `docs/remote-worker-implementation-design.md`
- `docs/remote-worker-liveness-and-offline-behavior.md`

## Context

The current system lets the central web app and browser workers write to the
same SQLite database. This caused a production failure mode where a dashboard
summary poll attempted workflow reconciliation writes while active workers were
writing listing and event data. The SQLite lock escaped the request handler,
the Node process exited, Docker restarted the app, and active worker child
processes were marked `lost`.

Long-term direction:

- central app owns the canonical database and reducers;
- workers keep local state/outbox in their own runtime database;
- workers communicate with the host over TCP/API;
- workers emit the same semantic events as today;
- the host validates, stores, acknowledges, and reduces events.

## Versioning Decision

Use explicit API versioning.

- Current app API remains version 1.
- Existing unversioned `/api/*` routes stay as compatibility aliases.
- Add explicit `/api/v1/*` aliases for current central app behavior.
- Add remote worker API under `/api/v1/remote-workers/*`.

Do not use `/api/v2` yet. The first remote-worker contract is still v1 because
it should host the same event model and reducers, only with a new transport.

## Proposed Route Shape

Current API aliases:

```text
/api/summary              -> /api/v1/summary
/api/workflows            -> /api/v1/workflows
/api/workflows/:id/events -> /api/v1/workflows/:id/events
```

Remote worker API:

```text
POST /api/v1/remote-workers/sessions
POST /api/v1/remote-workers/sessions/:sessionId/heartbeat
POST /api/v1/remote-workers/sessions/:sessionId/claims
POST /api/v1/remote-workers/sessions/:sessionId/leases/:leaseId/renew
POST /api/v1/remote-workers/sessions/:sessionId/events
POST /api/v1/remote-workers/sessions/:sessionId/artifacts
POST /api/v1/remote-workers/sessions/:sessionId/leases/:leaseId/complete
GET  /api/v1/remote-workers/sessions/:sessionId/commands
POST /api/v1/remote-workers/sessions/:sessionId/commands/:commandId/ack
```

## Auth Model

Use a dedicated worker token, not the dashboard admin token.

Initial MVP:

```text
MARKETPLACE_WORKER_TOKEN=...
Authorization: Bearer ...
```

Fallback for local development may allow:

```text
?workerToken=...
```

The worker token should only authorize remote-worker routes. It must not grant
dashboard admin actions such as deleting profiles, stopping local workflows, or
editing listings directly.

Host validation:

- token is present and matches configured worker token;
- worker id is non-empty and stable;
- worker type and strategy are registered;
- session id path param matches the stored session;
- request body `workerId` matches the session worker id when present.

Future hardening can add per-worker tokens, token ids, and rotation. The first
slice only needs one scoped worker token to avoid reusing admin credentials.

## Host API Contract

### Register Or Resume Session

```http
POST /api/v1/remote-workers/sessions
```

Request:

```json
{
  "sessionId": "",
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "workerVersion": "2026.06.16",
  "sourceId": "marketplace:remote:backlog-indexer",
  "profileId": "",
  "host": {
    "hostname": "ubuntu-dev-103",
    "pid": 12345,
    "runtime": "node"
  },
  "capabilities": {
    "apiVersion": "v1",
    "eventRegistryVersion": "marketplace-worker-events@1",
    "localOutbox": true,
    "artifactUpload": false,
    "profileLease": false,
    "browser": false,
    "maxEventBatchSize": 100
  },
  "lastCheckpoint": {
    "lastAckedSequence": 0,
    "lastAckedEventId": ""
  }
}
```

Response:

```json
{
  "sessionId": "remote-session-01J...",
  "status": "registered",
  "serverTime": "2026-06-16T12:00:00.000Z",
  "heartbeatSeconds": 15,
  "sessionLeaseSeconds": 90,
  "maxEventBatchSize": 100,
  "maxArtifactBytes": 5242880,
  "hostCheckpoint": {
    "lastAcceptedSequence": 0,
    "lastAcceptedEventId": "",
    "missingSequences": []
  },
  "config": {
    "workerType": "backlog_indexer",
    "strategy": "resolved_metadata",
    "adapter": {
      "limit": 100
    }
  }
}
```

Behavior:

- create a new `remote_worker_sessions` row if `sessionId` is empty;
- resume the existing session if `sessionId`, worker identity, and version are
  compatible;
- reject incompatible worker type, strategy, or capabilities before domain work;
- return host checkpoint so the worker can retry missing outbox events;
- do not create local `workflow_runs` child processes for remote sessions.

### Heartbeat

```http
POST /api/v1/remote-workers/sessions/:sessionId/heartbeat
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "runtimeState": "working",
  "activeLeaseId": "lease-01J...",
  "activeEntityId": "973408764691929",
  "lastLocalSequence": 42,
  "lastAckedSequence": 40,
  "pendingEventCount": 2,
  "pendingArtifactCount": 0,
  "metrics": {
    "rssMb": 180,
    "eventFlushLagMs": 2100
  },
  "lastError": ""
}
```

Response:

```json
{
  "status": "ok",
  "serverTime": "2026-06-16T12:00:15.000Z",
  "sessionLeaseExpiresAt": "2026-06-16T12:01:45.000Z",
  "shutdownRequested": false,
  "drainRequested": false,
  "commandsAvailable": true,
  "hostCheckpoint": {
    "lastAcceptedSequence": 40
  }
}
```

Behavior:

- update session liveness fields only;
- do not mark listing or command work completed from heartbeat;
- compute `online`, `degraded`, `offline`, and `lost` from heartbeat lease and
  work lease state;
- include host checkpoint to help worker detect sync drift.

### Claim Work

```http
POST /api/v1/remote-workers/sessions/:sessionId/claims
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "capacity": 1,
  "acceptedCommandTypes": ["index_resolved_listing_metadata_batch"]
}
```

Response:

```json
{
  "claims": [
    {
      "leaseId": "lease-01J...",
      "claimId": "claim-01J...",
      "commandId": "command-01J...",
      "commandType": "index_resolved_listing_metadata_batch",
      "entityType": "listing_batch",
      "entityId": "batch-01J...",
      "expiresAt": "2026-06-16T12:03:00.000Z",
      "payload": {
        "indexerVersion": "resolved-metadata-v1",
        "items": []
      }
    }
  ]
}
```

MVP command types:

- `index_resolved_listing_metadata_batch`
- `resolve_listing_detail` later, for backlog resolver queue mode only.

Behavior:

- claims are host leases, not permanent assignment;
- host must atomically mark commands/leasable work as claimed;
- host must not issue claims if the worker session is not online;
- host must not issue claims if the worker has unreconciled critical outbox
  events beyond configured limits;
- each claim gets a new `claimId` even for the same command after requeue.

### Renew Lease

```http
POST /api/v1/remote-workers/sessions/:sessionId/leases/:leaseId/renew
```

Request:

```json
{
  "claimId": "claim-01J...",
  "workerId": "backlog-indexer-host103-01",
  "lastLocalSequence": 45
}
```

Response:

```json
{
  "status": "renewed",
  "leaseId": "lease-01J...",
  "claimId": "claim-01J...",
  "expiresAt": "2026-06-16T12:04:30.000Z"
}
```

Behavior:

- renew only if the lease is active and belongs to the session;
- return `expired`, `released`, or `reassigned` if the lease is no longer valid;
- do not mutate canonical listing state from renewal.

### Upload Event Batch

```http
POST /api/v1/remote-workers/sessions/:sessionId/events
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "batchId": "batch-01J...",
  "events": []
}
```

Response:

```json
{
  "batchId": "batch-01J...",
  "status": "accepted",
  "accepted": [
    {
      "eventId": "event-1",
      "sequence": 1
    }
  ],
  "duplicates": [],
  "rejected": [],
  "checkpoint": {
    "lastAcceptedSequence": 1,
    "lastAcceptedEventId": "event-1"
  }
}
```

Behavior:

- insert every valid event into `remote_worker_event_ingest` in one transaction;
- duplicate identical events are ACK-equivalent;
- duplicate event ids with different canonical content are rejected;
- ACK means the host durably stored the event, not necessarily that every
  projection was already updated;
- for MVP, reduce synchronously inside the same transaction when practical;
- if reducer fails after durable ingest, return event-level `accepted` with
  `reduceStatus = failed` only if the event can be retried by host repair job;
- never ask the worker to drop a rejected/conflicting event.

### Upload Artifact

```http
POST /api/v1/remote-workers/sessions/:sessionId/artifacts
```

MVP may accept metadata-only artifact records first and binary multipart later.

Request metadata:

```json
{
  "artifactId": "artifact-01J...",
  "eventId": "event-1",
  "kind": "screenshot",
  "sha256": "hex",
  "sizeBytes": 123456,
  "contentType": "image/jpeg",
  "metadata": {
    "format": "jpeg",
    "quality": 25
  }
}
```

Response:

```json
{
  "artifactId": "artifact-01J...",
  "status": "accepted",
  "path": "artifacts/remote-workers/remote-session-01J/artifact-01J.jpeg"
}
```

Behavior:

- artifacts are not reducer inputs by themselves;
- event payloads may reference artifact ids or host paths;
- worker may compact local artifact only after artifact ACK and event ACK.

### Complete Lease

```http
POST /api/v1/remote-workers/sessions/:sessionId/leases/:leaseId/complete
```

Request:

```json
{
  "claimId": "claim-01J...",
  "commandId": "command-01J...",
  "terminalEventId": "event-terminal-01J..."
}
```

Response:

```json
{
  "status": "completed",
  "leaseId": "lease-01J...",
  "commandId": "command-01J..."
}
```

Behavior:

- complete only if the terminal event is already durably ingested;
- reject completion if `claimId` does not match active lease;
- completion is a convenience projection signal, not the source of truth.

### Commands

```http
GET /api/v1/remote-workers/sessions/:sessionId/commands
POST /api/v1/remote-workers/sessions/:sessionId/commands/:commandId/ack
```

These routes support interactive workers such as profile onboarder. For the
first backlog indexer and backlog resolver slices, use claim-based commands
instead.

Command ACK request:

```json
{
  "status": "received",
  "workerId": "profile-onboarder-host103-01",
  "localReceivedAt": "2026-06-16T12:00:00.000Z"
}
```

Behavior:

- command ACK means worker saw the host command;
- executing the command must still emit a semantic event such as
  `user_command_received`;
- operator-sensitive commands should not be delivered to workers that are
  offline or incompatible.

## Event Semantics Requirement

Remote workers must emit the same event semantics as local workers.

The host should accept a normalized event envelope:

```json
{
  "eventId": "worker-local-uuid",
  "eventAt": "2026-06-16T12:00:20.000Z",
  "eventScope": "listing",
  "eventType": "detail_capture_succeeded",
  "status": "done",
  "workflowRunId": "remote-session-id",
  "workerId": "remote-worker-id",
  "workerType": "resolver",
  "strategy": "queue",
  "entityId": "123",
  "listingId": "123",
  "leaseId": "remote-lease-id",
  "claimId": "remote-claim-id",
  "commandId": "host-command-id",
  "sourceUrl": "https://www.facebook.com/marketplace/item/123/",
  "attempt": 1,
  "payload": {},
  "contentHash": "",
  "screenshotPath": "",
  "snapshotPath": "",
  "error": ""
}
```

The host must validate events against the existing worker event registry before
acknowledging them.

Validation should check:

- `workerType + strategy + eventType` is registered;
- required event fields are present;
- listing-scope events have `listingId` or `entityId`;
- `workflowRunId` maps to the remote session;
- `eventId` is unique and idempotent;
- event status is valid for the event type.

Remote queue-driven work has additional envelope validation:

- terminal listing events for host-claimed work include `leaseId`, `claimId`,
  and `commandId` at the envelope level;
- command lifecycle events include `commandId` and `claimId`;
- reducers only apply terminal results to current projections when the claim
  still matches the active host lease;
- stale late events are stored for audit but skipped for projection mutation.

These identifiers are remote transport and reducer guards. They do not have to
be duplicated into every event payload definition in
`scripts/marketplace-worker-events.js`.

## Host Reducer Requirement

The host should reduce local and remote worker events through one semantic path.

```text
local worker event
  -> normalize
  -> reduceWorkerEvent
  -> listing_events / workflow events / canonical listing state

remote worker API event
  -> validate
  -> normalize
  -> reduceWorkerEvent
  -> same outputs
```

The remote worker API must not create a second event vocabulary or a parallel
state reducer.

## Proposed Host Tables

```text
remote_worker_sessions
- session_id
- worker_id
- worker_type
- strategy
- version
- host_json
- capabilities_json
- config_json
- status
- liveness_state
- registered_at
- last_heartbeat_at
- session_lease_expires_at
- last_seen_sequence
- last_acked_sequence
- pending_event_count
- pending_artifact_count
- active_lease_id
- active_entity_id
- drain_requested_at
- shutdown_requested_at
- disconnected_at
- resumed_at
- lost_at
- completed_at
- last_error

remote_worker_leases
- lease_id
- session_id
- command_id
- claim_id
- queue
- entity_type
- entity_id
- status
- claimed_at
- renew_after_at
- expires_at
- released_at
- completed_at
- stale_at
- reassigned_at
- payload_json

remote_worker_event_ingest
- event_id
- session_id
- worker_id
- sequence
- batch_id
- event_at
- event_scope
- event_type
- entity_id
- listing_id
- lease_id
- claim_id
- command_id
- status
- canonical_hash
- payload_json
- artifacts_json
- received_at
- reduced_at
- reduce_status
- reduce_error

remote_worker_artifacts
- artifact_id
- session_id
- event_id
- entity_id
- kind
- path
- sha256
- size_bytes
- created_at

remote_worker_commands
- command_id
- target_session_id
- type
- status
- entity_type
- entity_id
- priority
- payload_json
- created_at
- claimed_at
- claimed_by_session_id
- claim_id
- expires_at
- acknowledged_at
- completed_at
- terminal_event_id
- error
```

Suggested indexes:

```text
remote_worker_sessions(worker_id, registered_at DESC)
remote_worker_sessions(liveness_state, session_lease_expires_at)
remote_worker_leases(status, expires_at)
remote_worker_leases(command_id, status)
remote_worker_event_ingest(session_id, sequence)
remote_worker_event_ingest(event_id UNIQUE)
remote_worker_event_ingest(lease_id, claim_id)
remote_worker_commands(status, priority DESC, created_at ASC)
remote_worker_commands(entity_type, entity_id, status)
```

Idempotency constraints:

```text
UNIQUE(remote_worker_event_ingest.event_id)
UNIQUE(remote_worker_event_ingest.session_id, remote_worker_event_ingest.sequence)
UNIQUE(remote_worker_artifacts.artifact_id)
UNIQUE(remote_worker_commands.command_id)
```

On duplicate event id:

- same canonical hash: return as duplicate/accepted;
- different canonical hash: reject as conflict and keep worker local event
  unacked.

## Host Reducer Detail

Reducer input:

```text
remote_worker_event_ingest row
  -> normalized worker event envelope
  -> registry validation
  -> domain reducer
```

Reducer destinations:

- workflow-scope events: append to `workflow_events` compatibility projection
  with `workflow_run_id = session_id`;
- listing-scope events: append to `listing_events` compatibility projection with
  `workflow_run_id = session_id` and `worker_id = worker_id`;
- command-scope events: update remote command projection only when `claimId`
  matches;
- backlog metadata indexed events: update the canonical listing metadata
  projection after the event is ingested;
- stale events: keep ingest row and compatibility event row when useful, but do
  not mutate current projection.

For the first implementation, a shared reducer function should accept both:

```text
local event writer input
remote event envelope
```

and produce the same compatibility table writes. Avoid adding UI code that reads
only `remote_worker_event_ingest`; the UI should be able to consume the existing
event views plus session metadata.

## Error Model

Use JSON errors:

```json
{
  "error": {
    "code": "invalid_event",
    "message": "Event detail_capture_succeeded missing listingId",
    "retryable": false,
    "details": {}
  }
}
```

HTTP status guidance:

- `200`: accepted or partially accepted batch with event-level details;
- `400`: malformed request or validation error;
- `401`: missing/invalid worker token;
- `403`: worker token valid but not allowed for this session;
- `404`: unknown session/lease/command;
- `409`: duplicate conflict, stale claim, incompatible session state;
- `413`: batch or artifact too large;
- `429`: worker should back off;
- `503`: host temporarily unavailable, retry with backoff.

Batch event failures should usually be reported inside the `rejected` array
rather than failing the whole batch after some events were durably stored.

## First Implementation Slice

Implement host support in this order:

1. Add schema helpers for remote sessions, leases, event ingest, artifacts, and
   commands.
2. Add worker-token auth scoped to `/api/v1/remote-workers/*`.
3. Add session register/resume and heartbeat.
4. Add event ingest with idempotency and registry validation.
5. Reduce workflow/listing events into existing compatibility event tables.
6. Register and reduce backlog indexer metadata result events.
7. Add claim endpoint for `index_resolved_listing_metadata_batch`.
8. Add a mock remote worker integration test using HTTP against a local server.
9. Add read-only dashboard visibility for remote sessions.
10. Add backlog resolver queue-mode claims after the indexer path is proven.

Do not implement selected/listed resolver mode in this slice.

## Open Design Questions

- Should reducer failure after durable event ingest block ACK, or should ACK
  durable ingest and leave failed reductions to a host repair job?
- What exact maximum event batch size should be enforced first: 50, 100, or
  another value?
- Should artifact binary upload be multipart in the first slice, or should the
  first slice accept metadata-only artifacts and add binary upload later?
- How should the UI represent legacy `workflow_runs` beside remote
  `remote_worker_sessions`?
- How much recent process-log excerpting should the host expose without turning
  Docker logs into canonical event storage?

## Acceptance Criteria

- API design document defines route contracts and payload shapes.
- Design explicitly preserves current event semantics.
- Design describes idempotency and ACK behavior.
- Design identifies reducer ownership in the host app.
- Design includes migration steps from direct DB workers.
- Design does not require replacing current workers immediately.
- Review identifies the smallest first implementation slice.
