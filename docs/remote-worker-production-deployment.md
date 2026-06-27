# Remote Worker Production Deployment

## Current Production-Ready Shape

The first deployable remote worker is the remote backlog indexer. It uses the same host `/api/v2/remote-workers/*` contract as the prototype:

- local SQLite state and durable outbox on the worker device;
- session registration and resume;
- heartbeat snapshots;
- host-issued claims and leases;
- batched event upload with host ACKs;
- artifact manifest upload;
- lease completion after successful event sync.

The legacy direct-DB backlog indexer remains available in the worker setup UI, but it is marked as a legacy direct-DB worker. New deployments should prefer `Remote Backlog Indexer`.

## Prod Readiness Check

Before promoting the remote worker to prod:

1. Run local syntax and unit tests:

```bash
node --check scripts/serve-marketplace-homepage.js
node --check scripts/remote-worker-runtime.js
node --check scripts/remote-worker-api-client.js
bash -n ops/install-remote-worker-device.sh
node --test test/remote-worker-auth.test.js test/remote-worker-contracts.test.js test/worker-local-outbox.test.js test/remote-worker-scheduler.test.js test/remote-worker-host-api.test.js test/remote-worker-runtime.test.js
```

2. Deploy the app/server code to prod.

3. Run a prod smoke test using the worker token, preferably from outside the container when validating network access:

```bash
node scripts/remote-worker-smoke-client.js   --host-url http://10.10.20.3:21435   --worker-token "$MARKETPLACE_REMOTE_WORKER_TOKEN"   --worker-id prod-remote-worker-smoke   --worker-type backlog_indexer   --strategy resolved_metadata   --json
```

4. Run a one-cycle runtime check:

```bash
node scripts/remote-worker-runtime.js   --host-url http://10.10.20.3:21435   --worker-token "$MARKETPLACE_REMOTE_WORKER_TOKEN"   --worker-id prod-remote-backlog-indexer-check   --worker-type backlog_indexer   --strategy resolved_metadata   --local-db /tmp/prod-remote-backlog-indexer-check.db   --once   --json
```

A no-claim result is acceptable if no eligible resolved listings exist. The readiness signal is that registration, heartbeat, command polling, event sync, and claim API calls complete without auth or schema errors.

## Installing on Another Ubuntu Device

On the target device, clone or sync this repo, install Node.js compatible with `node:sqlite`, then run:

```bash
ops/install-remote-worker-device.sh   --host-url http://10.10.20.3:21435   --worker-id backlog-indexer-host103-01   --worker-token-file /etc/marketplace-remote-worker/backlog-indexer-host103-01.token
```

If you want the script to create the token file:

```bash
ops/install-remote-worker-device.sh   --host-url http://10.10.20.3:21435   --worker-id backlog-indexer-host103-01   --worker-token "$MARKETPLACE_REMOTE_WORKER_TOKEN"
```

Then start the service:

```bash
sudo systemctl enable --now marketplace-remote-worker@backlog-indexer-host103-01.service
sudo journalctl -u marketplace-remote-worker@backlog-indexer-host103-01.service -f
```

The worker stores local state under `/var/lib/marketplace-remote-worker/<worker-id>/worker.db` and logs under `/var/log/marketplace-remote-worker/<worker-id>.log`.

## Internet and Peer Communication

The preferred communication model is not arbitrary peer-to-peer. It is worker-to-host outbound HTTP(S):

```text
remote worker -> host /api/v2/remote-workers/* -> canonical reducer/database/UI
```

This works through NAT and home networks because only the host needs to be reachable. For internet use, put one of these in front of the host:

- WireGuard or Tailscale overlay network, recommended for trusted devices;
- Cloudflare Tunnel or another authenticated reverse tunnel;
- HTTPS reverse proxy with TLS and IP allowlisting;
- SSH tunnel for temporary development checks.

Raw inbound ports on every worker should be avoided. Workers should not need to accept inbound connections for normal operation. If future live-view or artifact transfer needs direct device access, use the overlay network and still keep host-issued tokens or mTLS in front of any worker endpoint.

## Artifact/CDN Space

The current runtime uploads artifact manifests, not inline binary payloads. That keeps event sync cheap and leaves room to move binaries from local filesystem storage to object storage/CDN later. The host should continue to serve compute and canonical metadata, while artifact bytes can be offloaded behind authenticated storage.
