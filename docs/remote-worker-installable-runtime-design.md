# Remote Worker Installable Runtime Design

## Purpose

This document defines the installable remote-worker runtime: a worker package
that can run on any trusted machine, keep its own durable local state, and
report work to the central Marketplace host over outbound HTTP. TCP can be
added later as a transport adapter, but the first supported transport should be
HTTP(S) because it works behind NAT, inside home networks, and from machines
that cannot accept inbound connections.

Related docs:

- `docs/remote-worker-host-api-v2-design.md`
- `docs/remote-worker-api-v1-design-review-ticket.md`
- `docs/remote-worker-outbox-runtime-design.md`
- `docs/remote-worker-liveness-and-offline-behavior.md`
- `docs/remote-worker-implementation-design.md`

## Runtime Goals

The remote worker must be installable and safe to run independently:

- no direct writes to the central SQLite database;
- no dependency on the web app container filesystem;
- local durable cache and outbox for offline periods;
- batched event upload with host acknowledgements;
- self-paced scheduling based on backlog, host health, and worker capacity;
- heartbeat and health reporting;
- scoped worker authentication separate from dashboard admin tokens;
- same semantic event model as local managed workers.

The host remains the canonical reducer and database owner. The worker owns only
its local runtime database, browser profile, artifacts awaiting upload, process
logs, and unacknowledged outbox events.

## Package Shape

Recommended package layout:

```text
remote-worker/
  bin/marketplace-remote-worker
  config/worker.example.json
  scripts/install-systemd-service.sh
  src/runtime/
    config-loader.js
    local-store.js
    auth-client.js
    transport-http.js
    heartbeat-loop.js
    event-sync-loop.js
    scheduler.js
    artifact-spooler.js
    health-reporter.js
  src/adapters/
    backlog-indexer.js
    resolver-backlog.js
    collector-search.js
    profile-onboarder.js
```

The first production-ready adapter should be `backlog-indexer` because it does
not require a browser profile. Browser adapters should reuse the same runtime
after the non-browser path proves the auth, outbox, batching, and liveness
contract.

## Install Flow

1. Operator creates or approves a worker record in the host UI.
2. Host issues a one-time enrollment token or a scoped worker token.
3. Worker package is installed on a machine.
4. Worker runs:

```bash
marketplace-remote-worker enroll \
  --host-url http://10.10.20.3:21435 \
  --enrollment-token ... \
  --worker-id backlog-indexer-host103-01
```

5. Worker stores durable config locally with file permissions restricted to the
service user.
6. Worker registers or resumes a session through `/api/v2/remote-workers`.
7. Worker starts heartbeat, command polling, event sync, and scheduler loops.

Recommended runtime locations:

```text
/opt/marketplace-remote-worker/          installed code
/etc/marketplace-remote-worker/config.json
/var/lib/marketplace-remote-worker/{worker_id}/worker.db
/var/lib/marketplace-remote-worker/{worker_id}/artifacts/
/var/log/marketplace-remote-worker/{worker_id}.log
```

For developer machines, the same layout can live under the repo:

```text
artifacts/remote-workers/{worker_id}/worker.db
artifacts/remote-workers/{worker_id}/artifacts/
```

## Configuration

Example config:

```json
{
  "hostUrl": "http://10.10.20.3:21435",
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "workerVersion": "2026.06.26",
  "sourceId": "remote:ubuntu103:backlog-indexer",
  "profileId": "",
  "auth": {
    "tokenFile": "/etc/marketplace-remote-worker/worker.token",
    "tokenId": "wrk_tok_01J...",
    "signRequests": true
  },
  "storage": {
    "dbPath": "/var/lib/marketplace-remote-worker/backlog-indexer-host103-01/worker.db",
    "artifactDir": "/var/lib/marketplace-remote-worker/backlog-indexer-host103-01/artifacts"
  },
  "transport": {
    "kind": "http",
    "timeoutMs": 10000,
    "maxRetries": 5
  },
  "scheduler": {
    "mode": "self_paced",
    "maxConcurrentClaims": 1,
    "idlePollSeconds": 15,
    "maxLocalPendingEvents": 10000,
    "maxLocalArtifactBytes": 1073741824
  },
  "sync": {
    "eventFlushIntervalSeconds": 2,
    "maxEventBatchSize": 100,
    "maxEventBatchBytes": 524288,
    "artifactFlushIntervalSeconds": 10
  },
  "health": {
    "heartbeatSeconds": 15,
    "degradedAfterMissedHeartbeats": 2,
    "offlineAfterMissedHeartbeats": 4
  }
}
```

CLI flags should bootstrap identity and config location only. Host-issued
config should own safety limits, claim strategy, adapter limits, and lease
durations so a remote worker cannot silently drift from central scheduling
policy.

## Authentication

Remote worker auth must be separate from dashboard auth.

Dashboard tokens:

- allow UI/API operator actions;
- must not be accepted by remote-worker routes.

Worker tokens:

- authorize only `/api/v2/remote-workers/*`;
- are scoped to worker identity, worker type, and allowed strategies;
- can be revoked without rotating dashboard access;
- should not allow direct listing edits or workflow management.

### Enrollment Token

Enrollment is optional but recommended for installable workers.

Enrollment token properties:

```text
one-time use
short TTL, for example 15 minutes
bound to worker_id, worker_type, strategy, and source_id
can issue a durable worker token
does not authorize event ingestion directly
```

Enrollment route:

```http
POST /api/v2/remote-workers/enroll
Authorization: Bearer <enrollment_token>
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "workerVersion": "2026.06.26",
  "host": {
    "hostname": "ubuntu-dev-103",
    "os": "linux",
    "runtime": "node"
  }
}
```

Response:

```json
{
  "workerToken": "wrk_secret_...",
  "tokenId": "wrk_tok_01J...",
  "expiresAt": "",
  "scopes": [
    "remote_worker:session",
    "remote_worker:heartbeat",
    "remote_worker:events",
    "remote_worker:claims"
  ]
}
```

For an MVP, the host can skip enrollment and manually provision
`MARKETPLACE_WORKER_TOKEN`, but the API should still be shaped so enrollment can
be added without redesign.

### Request Authentication

Minimum request auth:

```http
Authorization: Bearer <worker_token>
```

Recommended signed request auth:

```http
Authorization: Bearer <worker_token>
X-Worker-Id: backlog-indexer-host103-01
X-Worker-Token-Id: wrk_tok_01J...
X-Worker-Timestamp: 2026-06-26T12:00:00.000Z
X-Worker-Nonce: 01J...
X-Worker-Signature: base64url(hmac_sha256(token_secret, canonical_request))
```

Canonical request:

```text
METHOD
PATH_WITH_QUERY
X-Worker-Id
X-Worker-Timestamp
X-Worker-Nonce
SHA256(body)
```

Host validation:

- token exists and is active;
- token scope allows the route;
- `X-Worker-Id` matches token worker id;
- session id path param belongs to the same worker;
- timestamp is within clock-skew tolerance, for example 5 minutes;
- nonce has not been used recently by the same token;
- signature matches;
- body `workerId` matches token worker id when present.

MVP may accept Bearer-only auth on a trusted LAN. Signed requests should be the
target before workers are allowed outside the trusted network.

### Token Rotation

The host can return token rotation instructions in heartbeat responses:

```json
{
  "rotateToken": true,
  "rotationUrl": "/api/v2/remote-workers/sessions/session-01J/token-rotation"
}
```

Rotation behavior:

- worker requests a new token while the old one is still valid;
- worker persists the new token only after host confirms activation;
- host accepts both old and new token for a short overlap window;
- worker reports `tokenRotatedAt` in the next heartbeat;
- host revokes the old token after successful heartbeat with the new token.

### Authentication Failure Behavior

If auth fails:

- worker stops claiming new work immediately;
- worker keeps local outbox and artifacts;
- worker continues local log capture;
- worker marks host state as `unauthorized`;
- worker does not delete or compact pending events;
- operator must re-enroll or rotate token.

The host should show the last auth failure reason in worker detail without
logging token secrets.

## Transport Model

### HTTP MVP

The worker opens outbound HTTP(S) connections to the host:

```text
register/resume session
heartbeat
claim work
renew lease
upload event batches
upload artifacts
poll commands
ack commands
complete lease
```

HTTP is pull-oriented from the worker side. The host does not need inbound
access to the worker.

### TCP Future Adapter

TCP can be added later as an adapter when low-latency streaming is needed:

```text
remote-worker-runtime
  transport-http
  transport-tcp
```

The transport must preserve the same logical messages, auth envelope,
idempotency keys, sequence ACKs, and host reducer behavior. TCP should not
change the event model.

## Batch Caching And Outbox Sync

The worker flushes events in batches from local SQLite.

Batch selection:

```text
status = pending
ORDER BY sequence ASC
LIMIT maxEventBatchSize
AND total serialized bytes <= maxEventBatchBytes
```

Upload request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "sessionId": "remote-session-01J...",
  "firstSequence": 1200,
  "lastSequence": 1299,
  "events": []
}
```

Host response:

```json
{
  "status": "accepted",
  "accepted": [
    { "eventId": "event-1", "sequence": 1200, "status": "acked" }
  ],
  "duplicates": [],
  "rejected": [],
  "hostCheckpoint": {
    "lastAcceptedSequence": 1299,
    "missingSequences": []
  }
}
```

Worker rules:

- mark rows `sending` inside a local transaction before upload;
- on timeout, return `sending` rows to `pending`;
- on ACK, persist ACK before compacting;
- on duplicate identical event, treat as ACK-equivalent;
- on rejection, quarantine the command and stop that adapter;
- never compact artifacts until artifact ACK is persisted.

## Self-Paced Scheduling

The worker scheduler is local and conservative. It should avoid taking new work
when local state indicates the host, disk, or adapter is unhealthy.

Inputs:

```text
host connection state
session lease status
active claim count
pending outbox event count
pending artifact byte count
event flush lag
adapter error rate
host drain/shutdown flags
local disk free space
configured max concurrency
```

Scheduling states:

```text
idle
claiming
working
flushing
backpressure
draining
offline
unauthorized
stopped
```

Claim rule:

```text
claim only if:
  host is connected
  no drain/shutdown requested
  pending outbox below threshold
  pending artifacts below threshold
  disk has minimum free space
  active claims < configured capacity
```

Backpressure rule:

```text
if pending outbox or artifact spool exceeds threshold:
  stop claiming new work
  continue flushing
  finish current claim only if local disk remains safe
  report worker_backpressure in heartbeat metrics
```

This lets the worker operate at the pace the host and network can actually
absorb.

## Health Checking

The worker reports health through heartbeat, local logs, and optional local
diagnostic commands.

Heartbeat metrics:

```json
{
  "runtimeState": "working",
  "hostState": "connected",
  "activeLeaseId": "lease-01J...",
  "lastLocalSequence": 1299,
  "lastAckedSequence": 1288,
  "pendingEventCount": 11,
  "pendingArtifactCount": 2,
  "pendingArtifactBytes": 1048576,
  "eventFlushLagMs": 2200,
  "rssMb": 380,
  "diskFreeMb": 42000,
  "adapter": {
    "name": "backlog-indexer",
    "state": "working",
    "lastError": ""
  }
}
```

Host health projection:

```text
online      heartbeat fresh, session lease valid
degraded    heartbeat late or high flush lag
offline     heartbeat lease expired
lost        offline with expired active work lease
blocked     unauthorized, incompatible, or local backpressure
draining    host requested no new claims
stopped     terminal clean shutdown
failed      terminal runtime failure
```

Local health command:

```bash
marketplace-remote-worker status --config /etc/marketplace-remote-worker/config.json
```

Output should include session id, host state, pending outbox count, last ACK,
active claim, and last error.

## Artifact Handling

Artifacts are uploaded separately from event batches when they are large.

Rules:

- event payload references artifact ids and hashes;
- artifact upload is idempotent by artifact id and sha256;
- host can ACK event before artifact is uploaded only if the event marks the
  artifact as pending;
- final projection that requires the artifact waits for artifact ACK;
- worker deletes local artifact files only after artifact ACK and retention
  policy allow it.

### Multimedia Consistency Without Transfer Overload

Images, screenshots, videos, traces, and raw HTML snapshots should use a
manifest-first flow:

```text
capture artifact locally
  -> compute sha256, size, dimensions, role
  -> create derivatives when useful
  -> commit ArtifactManifest + event reference locally
  -> upload event batch / manifest
  -> upload binary on artifact lane when budget allows
  -> persist host artifact ACK
  -> compact local binary after retention window
```

The worker should generate bounded derivatives before upload:

```text
thumbnail: small table/card view, around 320px max edge
preview: modal/detail view, around 1280px max edge
original: retained locally and uploaded only if host requests it or task
          requires full fidelity
```

Artifact transfer policy is host-configurable:

```text
metadata_only
thumbnail
preview
original_on_demand
original_required
```

Backpressure rules:

- if pending artifact bytes exceed the local threshold, stop claiming new work;
- event upload may continue if events only reference pending artifacts;
- binary upload uses a separate retry/backoff loop from event upload;
- artifact failures should not rewrite domain events;
- large traces and videos require explicit task capability or operator command.

This gives consistency through manifests and hashes without forcing every image
or multimedia file through the latency-sensitive event path.

### CDN/Object Store Upload Flow

Workers should not hold broad third-party storage credentials. The worker
authenticates to the host, and the host issues scoped upload grants for accepted
artifact manifests.

Flow:

```text
worker captures binary locally
worker commits ArtifactManifest locally
worker uploads manifest/event to host
host validates manifest and returns upload grant
worker uploads binary to object store/CDN origin
worker reports upload completion to host
host marks artifact available
worker compacts local binary after ACK/retention
```

Worker rules:

- request upload grants only for accepted artifact manifests;
- verify upload grant matches artifact id, sha256, content type, and max bytes;
- upload thumbnail/preview before original unless host requires original;
- retry upload with artifact-specific backoff;
- do not block event ACK on binary upload unless the event requires immediate
  displayable media;
- never persist cloud provider secret keys in worker config;
- preserve local binary until host artifact ACK is durable.

This lets remote workers run on any trusted machine while the central host
keeps access control and the CDN/object store handles bandwidth.

## Host Responsibilities

The host must provide:

- scoped worker token validation;
- session registration/resume;
- heartbeat storage and liveness projection;
- command/claim issuance with leases;
- event registry validation;
- remote envelope validation;
- idempotent event ingestion;
- ACK/checkpoint response;
- reducer projection into canonical DB;
- stale lease recovery;
- operator UI for online/degraded/offline/lost/blocked workers.

The host should never trust a worker to directly mutate canonical listing state.
It should trust only validated, idempotent, auditable events.

## MVP Sequence

1. Implement host tables for remote sessions, tokens, event inbox, and ACKs.
2. Implement Bearer-token worker auth for `/api/v2/remote-workers/*`.
3. Implement remote session register/resume and heartbeat.
4. Implement event batch ingestion with idempotent ACKs.
5. Implement installable non-browser `backlog_indexer` runtime.
6. Add signed request auth and token rotation.
7. Add artifact upload.
8. Move browser backlog resolver to remote runtime.
9. Move collector/search workers only after browser profile lease isolation is
   proven.

## Open Decisions

- Whether signed requests are required before first LAN-only MVP.
- Whether host should issue worker tokens through UI or CLI only.
- How much per-worker config can be edited by the host after enrollment.
- Whether browser workers should use system Chrome instead of Playwright-bundled
  Chromium on remote machines where site challenge behavior differs.
- Whether TCP/WebSocket streaming is worth adding before the HTTP path is fully
  stable.
