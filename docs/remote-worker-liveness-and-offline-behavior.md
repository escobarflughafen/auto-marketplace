# Remote Worker Liveness And Offline Behavior

## Purpose

This document defines how the central host and remote workers determine whether
the other side is online, degraded, offline, or lost. It also defines what each
side should do when the other party is not reachable.

This is part of the remote worker design based on the Transactional Outbox
Pattern. Liveness signals help scheduling and operator visibility, but they do
not replace durable outbox acknowledgements.

## Core Principle

Online state is a lease, not a permanent fact.

Both sides should infer liveness from recent successful communication and
explicit leases:

```text
worker heartbeat + host response + unexpired lease -> online
missed heartbeats inside grace window             -> degraded
expired heartbeat lease                           -> offline
expired work lease with no terminal event         -> lost/stale claim
```

The host never assumes a worker is dead from one missed request. The worker never
assumes a host accepted events unless it has persisted the host ACK locally.

## States

### Host View Of Worker

The host should classify each remote worker session as:

```text
registering
online
degraded
offline
lost
draining
stopped
failed
```

Meanings:

- `registering`: session was created but no stable heartbeat has been observed.
- `online`: heartbeat is fresh and the worker's session lease is unexpired.
- `degraded`: heartbeat is late, but still inside the grace window.
- `offline`: session lease expired; the worker may return and resume.
- `lost`: session is offline and had active leases that expired without terminal
  events.
- `draining`: host asked the worker to stop claiming new work.
- `stopped`: worker completed or shut down cleanly.
- `failed`: worker reported a terminal runtime failure.

### Worker View Of Host

The worker should classify the host connection as:

```text
connected
degraded
offline
unauthorized
incompatible
```

Meanings:

- `connected`: heartbeat/event upload recently succeeded.
- `degraded`: requests are slow, timing out, or intermittently failing.
- `offline`: host cannot be reached after retry/backoff.
- `unauthorized`: token rejected or session revoked; worker must stop claiming
  work and preserve local state.
- `incompatible`: host API version or capability negotiation failed; worker must
  stop before doing domain work.

## Liveness Signals

### Worker To Host

The worker sends periodic heartbeat requests:

```http
POST /api/v1/remote-workers/sessions/:sessionId/heartbeat
```

Heartbeat payload should include:

```json
{
  "workerId": "resolver-host103-01",
  "sessionId": "remote-session-01J...",
  "status": "active",
  "runtimeState": "working",
  "activeLeaseId": "lease-123",
  "activeEntityId": "973408764691929",
  "lastLocalSequence": 1302,
  "lastAckedSequence": 1294,
  "pendingEventCount": 8,
  "pendingArtifactCount": 1,
  "localClock": "2026-06-16T12:00:25.000Z",
  "metrics": {
    "eventFlushLagMs": 2400,
    "rssMb": 380
  }
}
```

The host response should include:

```json
{
  "status": "ok",
  "serverTime": "2026-06-16T12:00:25.100Z",
  "sessionLeaseExpiresAt": "2026-06-16T12:01:55.100Z",
  "heartbeatSeconds": 15,
  "shutdownRequested": false,
  "drainRequested": false,
  "commandsAvailable": true,
  "hostCheckpoint": {
    "lastAcceptedSequence": 1294
  }
}
```

The worker must persist successful heartbeat responses locally. This gives the
worker a clear last-known host state after restart.

### Host To Worker

The host does not need to open inbound connections to workers. It can signal the
worker through heartbeat responses and command polling:

```text
heartbeat response
- shutdownRequested
- drainRequested
- configRevision
- commandsAvailable
- hostCheckpoint

command poll
- stop
- drain
- retry
- submit_verification_code
- continue_after_external_approval
```

This keeps workers deployable behind NAT or on home-network machines without
requiring the host to reach worker ports.

## Timing Defaults

Recommended defaults:

```text
heartbeat_interval_seconds = 15
heartbeat_request_timeout_ms = 10000
degraded_after_missed_heartbeats = 2
offline_after_missed_heartbeats = 4
session_lease_seconds = 90
work_lease_seconds = 180
work_lease_renew_at_fraction = 0.5
event_flush_interval_seconds = 2
event_flush_backoff_min_seconds = 1
event_flush_backoff_max_seconds = 60
```

With these defaults:

- a worker becomes `degraded` after roughly 30 seconds without heartbeat;
- a worker becomes `offline` after roughly 60 seconds without heartbeat;
- work claims expire independently after their own lease window;
- browser work should renew leases before half the lease duration elapses.

The host should apply jitter when checking leases so many sessions do not update
state at the exact same moment.

## Host Behavior When Worker Is Not Online

### Worker Is Degraded

Host behavior:

- keep active leases assigned;
- do not immediately requeue work;
- show degraded status in the worker monitor;
- continue accepting late event batches;
- avoid starting duplicate work for the same lease.

The degraded state is an observation window, not a terminal state.

### Worker Is Offline

Host behavior:

- stop assigning new claims to that session;
- keep the session resumable;
- keep accepting idempotent event batches from that session;
- mark active leases as expired only when their work lease expires;
- show pending unsynced counts from the last heartbeat;
- do not mark a listing as failed only because the worker session is offline.

Offline means communication is missing. It does not prove the worker action
failed.

### Worker Is Lost

Host behavior:

- mark active leases from that session as stale or expired;
- requeue work only when no terminal event was durably accepted for the claim;
- preserve stale late events for audit;
- reject or ignore stale terminal events that do not match the current claim id;
- emit workflow/session audit events for `worker_lost` and lease recovery.

The host may reassign work after lease expiry. If the original worker later
returns, its late events must be reduced only if they are still valid for their
original claim.

### Worker Returns After Offline

Host behavior:

- allow session resume if worker identity, token, and API version match;
- return host checkpoint and missing sequence information;
- accept duplicate identical events as ACK-equivalent;
- reject duplicate conflicting events;
- tell the worker which leases are still valid, expired, or reassigned;
- do not give new claims until the worker reconciles critical pending events.

The host should prefer resuming the old session over creating a new session
unless the worker explicitly asks for a fresh identity.

## Worker Behavior When Host Is Not Online

### Host Is Degraded

Worker behavior:

- keep local outbox writes synchronous and durable;
- continue current work only while local backlog is below configured limits;
- increase heartbeat and event upload backoff gradually;
- avoid claiming new work if claim requests are slow or unstable;
- emit local `host_connection_degraded` or `worker_backpressure` events.

The worker may finish an already started browser action because it can still
record the result locally.

### Host Is Offline

Worker behavior:

- stop claiming new work;
- do not compact or delete unacked outbox events;
- keep retrying heartbeat and event upload with bounded backoff;
- pause browser work when pending event or artifact limits are reached;
- preserve screenshots, snapshots, and raw artifacts in local spool;
- surface `offline` state in local logs and heartbeats once the host returns.

For collector workers, offline behavior should be conservative because they can
generate many events. Once backlog limits are close, collectors should sleep
instead of continuing to scan.

For resolver workers, finishing the current listing is acceptable if local disk
can record all events and artifacts. Starting another claim while host is
offline is not acceptable.

For profile onboarder workers, host offline means operator commands cannot be
trusted to arrive. The worker should wait on the current screen and keep local
screenshots/artifacts, but should not auto-submit new user-sensitive inputs.

For backlog indexer workers, offline operation can continue longer because it
does not depend on external websites, but it must still pause when the outbox
backlog limit is reached.

### Host Says Unauthorized

Worker behavior:

- stop claiming work immediately;
- stop interactive/browser actions after recording an interruption event;
- keep all local outbox data;
- mark connection state as `unauthorized`;
- require operator intervention before retrying with a new token.

The worker should not drop events just because auth failed.

### Host Says Incompatible

Worker behavior:

- stop before domain work starts;
- persist the incompatibility response;
- emit local diagnostic logs;
- wait for deployment/config update.

No automatic downgrade should occur unless explicitly supported by capability
negotiation.

## Split Brain And Stale Claim Protection

The system must assume a worker can return after the host has reassigned its
work.

Protection rules:

- every claimed work item has a `leaseId`;
- every claim attempt has a `claimId`;
- terminal events for host-claimed work include `leaseId`, `claimId`, and
  `commandId` in the remote event envelope;
- host reducers update command/listing terminal state only if the terminal event
  matches the current claim;
- stale events are stored for audit but skipped for projection updates.

Example:

```text
T1 worker A claims listing 123 with claim A1
T2 worker A loses network
T3 host marks A degraded, then offline
T4 lease A1 expires
T5 host requeues listing 123
T6 worker B claims listing 123 with claim B1
T7 worker B succeeds; projection becomes done
T8 worker A returns and uploads stale success for A1
T9 host stores A1 event for audit, but does not overwrite B1 projection
```

This is why claim identity is part of the event contract, not just the command
table.

## Event ACK Is Stronger Than Heartbeat

Heartbeat answers "is the process recently reachable?"

Outbox ACK answers "has the host durably accepted this fact?"

Only outbox ACK can permit:

- local event compaction;
- local artifact deletion;
- lease completion;
- clearing active command state;
- assuming the central UI can eventually show the result.

Heartbeat success must not mark listing work as done.

## Suggested Host Tables

The host API design already proposes `remote_worker_sessions`,
`remote_worker_leases`, and `remote_worker_event_ingest`. Liveness fields should
include:

```text
remote_worker_sessions
- session_id
- worker_id
- status
- liveness_state
- registered_at
- last_heartbeat_at
- session_lease_expires_at
- last_seen_sequence
- last_acked_sequence
- pending_event_count
- pending_artifact_count
- disconnected_at
- lost_at
- resumed_at
- stopped_at
- last_error
```

Lease records should include:

```text
remote_worker_leases
- lease_id
- claim_id
- session_id
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
```

## UI Behavior

Worker monitor should show:

- host view: online, degraded, offline, lost, draining, stopped, failed;
- last heartbeat time;
- session lease expiry;
- active lease/listing;
- last local sequence;
- last ACKed sequence;
- pending event count;
- pending artifact count;
- event flush lag;
- last connection error.

Actions:

- `Drain`: ask worker to finish current work and stop claiming.
- `Stop`: ask worker to stop after recording a shutdown event.
- `Mark lost`: operator override after lease expiry.
- `Resume`: allow returning worker to reconcile, not force a new session.

The UI should avoid showing offline as failed. Offline is a connectivity state;
failed is a terminal worker/runtime state.

## Minimum MVP

The first implementation should include:

1. Session heartbeat with host-side lease expiry.
2. Worker local connection state persisted in `worker_state`.
3. Host status reducer: online, degraded, offline, lost.
4. Event upload ACK with checkpoint.
5. Worker retry/backoff and no compaction without ACK.
6. Claim/lease expiry with stale terminal event protection.
7. Dashboard display of liveness and pending sync counts.

This is enough to make remote workers debuggable without prematurely adding a
message broker.
