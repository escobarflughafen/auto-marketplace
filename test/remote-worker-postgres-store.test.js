const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRemoteWorkerPostgresStore,
  remoteBacklogIndexerPayloadItem,
} = require('../scripts/remote-worker-postgres-store');

function createFakePool(handler) {
  const calls = [];
  const client = {
    released: false,
    async query(sql, params = []) {
      calls.push({ sql, params, client: true });
      return { rows: handler(sql, params, calls.length) || [] };
    },
    release() {
      this.released = true;
    },
  };
  return {
    calls,
    client,
    ended: false,
    async connect() {
      calls.push({ sql: 'CONNECT', params: [], connect: true });
      return client;
    },
    async query(sql, params = []) {
      calls.push({ sql, params, pool: true });
      return { rows: handler(sql, params, calls.length) || [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

const sessionRow = {
  session_id: 'session-1',
  worker_id: 'worker-1',
  worker_type: 'backlog_indexer',
  strategy: 'resolved_metadata',
};

const listingRow = {
  listing_id: 'listing-1',
  href: 'https://example.test/listing-1',
  source: 'search',
  source_keyword: 'camera',
  card_title: 'Card title',
  card_text: 'Card text',
  detail_title: 'Detail title',
  detail_price: 'CA$ 100',
  detail_location: 'Vancouver',
  detail_condition: 'used',
  detail_listed_ago: '1 hour ago',
  detail_completed_at: '2026-01-01T00:00:00.000Z',
  detail_json: JSON.stringify({ listingContent: { description: 'indexed description' } }),
  snapshot_path: '/tmp/listing-1.md',
  first_seen_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-02T00:00:00.000Z',
};


test('registerRemoteWorkerSession writes PostgreSQL session and workflow run in one transaction', async () => {
  const pool = createFakePool(() => []);
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
    idFactory: {
      sessionId: () => 'session-created',
    },
  });

  const result = await store.registerRemoteWorkerSession({
    workerId: 'worker-1',
    workerType: 'collector',
    strategy: 'feed',
    workerVersion: 'v1',
    sourceId: 'host-a',
    capabilities: { commands: true },
    lastCheckpoint: { lastLocalSequence: 7, lastAckedSequence: 5 },
  });

  assert.equal(result.sessionId, 'session-created');
  assert.equal(result.hostCheckpoint.lastAcceptedSequence, 5);
  assert.ok(pool.calls.some((call) => call.sql === 'BEGIN'));
  assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
  const sessionInsert = pool.calls.find((call) => /INSERT INTO remote_worker_sessions/.test(call.sql));
  assert.ok(sessionInsert);
  assert.deepEqual(sessionInsert.params.slice(0, 7), [
    'session-created',
    'worker-1',
    'collector',
    'feed',
    'v1',
    'host-a',
    '{"commands":true}',
  ]);
  assert.deepEqual(sessionInsert.params.slice(7), [7, 5, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
  const workflowInsert = pool.calls.find((call) => /INSERT INTO workflow_runs/.test(call.sql));
  assert.ok(workflowInsert);
  assert.deepEqual(workflowInsert.params, [
    'session-created',
    'remote-collector',
    'Remote collector',
    '2026-01-03T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
  ]);
});

test('updateRemoteWorkerHeartbeat updates session liveness and workflow projection', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) {
      return [{ ...sessionRow, last_acked_sequence: 9 }];
    }
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const result = await store.updateRemoteWorkerHeartbeat('session-1', {
    workerId: 'worker-1',
    runtimeState: 'idle',
    lastLocalSequence: 12,
    pendingEventCount: 3,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.hostCheckpoint.lastAcceptedSequence, 9);
  const sessionUpdate = pool.calls.find((call) => /UPDATE remote_worker_sessions/.test(call.sql) && /runtime_state/.test(call.sql));
  assert.ok(sessionUpdate);
  assert.deepEqual(sessionUpdate.params, ['idle', 12, 3, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 'session-1']);
  const workflowUpdate = pool.calls.find((call) => /UPDATE workflow_runs/.test(call.sql));
  assert.ok(workflowUpdate);
  assert.deepEqual(workflowUpdate.params, ['2026-01-03T00:00:00.000Z', 'session-1']);
});

test('create, list, and ack remote worker commands through PostgreSQL', async () => {
  const commandRow = {
    command_id: 'command-1',
    session_id: 'session-1',
    worker_id: 'worker-1',
    worker_type: 'backlog_indexer',
    strategy: 'resolved_metadata',
    command_type: 'drain',
    payload_json: '{"reason":"test"}',
    priority: 10,
    created_at: '2026-01-02T00:00:00.000Z',
    delivered_at: '',
  };
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_commands/.test(sql)) return [commandRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
    idFactory: { commandId: () => 'command-created' },
  });

  const commandId = await store.createRemoteWorkerCommand({
    sessionId: 'session-1',
    workerId: 'worker-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    commandType: 'drain',
    payload: { reason: 'test' },
    priority: 10,
  });
  assert.equal(commandId, 'command-created');
  const insert = pool.calls.find((call) => /INSERT INTO remote_worker_commands/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params, [
    'command-created',
    'session-1',
    'worker-1',
    'backlog_indexer',
    'resolved_metadata',
    'drain',
    'drain',
    '{"reason":"test"}',
    10,
    '2026-01-03T00:00:00.000Z',
  ]);

  const listed = await store.listRemoteWorkerCommands('session-1', { limit: 5 });
  assert.equal(listed.commands.length, 1);
  assert.deepEqual(listed.commands[0], {
    commandId: 'command-1',
    commandType: 'drain',
    payload: { reason: 'test' },
    priority: 10,
    createdAt: '2026-01-02T00:00:00.000Z',
    deliveredAt: '2026-01-03T00:00:00.000Z',
  });
  assert.ok(pool.calls.some((call) => /SET delivered_at = CASE/.test(call.sql)));

  const acked = await store.ackRemoteWorkerCommand('session-1', 'command-1', {
    status: 'failed',
    payload: { retry: false },
    error: 'nope',
  });
  assert.equal(acked.status, 'failed');
  assert.equal(acked.ackStatus, 'failed');
  const update = pool.calls.find((call) => /ack_payload_json/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params, ['failed', 'failed', '{"retry":false}', '2026-01-03T00:00:00.000Z', 'nope', 'command-1']);
});

test('remoteBacklogIndexerPayloadItem normalizes listing rows for claim payloads', () => {
  const item = remoteBacklogIndexerPayloadItem(listingRow);
  assert.equal(item.listingId, 'listing-1');
  assert.equal(item.title, 'Detail title');
  assert.equal(item.description, 'indexed description');
  assert.equal(item.sourceKeyword, 'camera');
  assert.match(item.contentHash, /^[a-f0-9]{64}$/);
});

test('listRemoteBacklogIndexerCandidates uses PostgreSQL JSON active-claim exclusion', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM homepage_listings h/.test(sql)) return [listingRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const rows = await store.listRemoteBacklogIndexerCandidates({
    limit: 10,
    excludeListingIds: ['listing-x'],
  });

  assert.equal(rows.length, 1);
  const call = pool.calls.find((item) => /FROM homepage_listings h/.test(item.sql));
  assert.ok(call);
  assert.match(call.sql, /jsonb_array_elements/);
  assert.match(call.sql, /AS active_item\(item\)/);
  assert.match(call.sql, /active\.listing_id IS NULL/);
  assert.match(call.sql, /ANY\(\$3::text\[\]\)/);
  assert.doesNotMatch(call.sql, /LIKE '%' \|\|/);
  assert.deepEqual(call.params, [['claimed', 'renewed'], '2026-01-03T00:00:00.000Z', ['listing-x'], 10]);
});

test('claimRemoteWorkerWork creates PostgreSQL commands and claims in a transaction', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM homepage_listings h/.test(sql)) return [listingRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
    idFactory: {
      commandId: () => 'command-1',
      claimId: () => 'claim-1',
      leaseId: () => 'lease-1',
    },
  });

  const result = await store.claimRemoteWorkerWork('session-1', {
    workerId: 'worker-1',
    capacity: 1,
    batchSize: 5,
    leaseSeconds: 60,
  });

  assert.equal(result.reason, '');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claimId, 'claim-1');
  assert.equal(result.claims[0].leaseId, 'lease-1');
  assert.equal(result.claims[0].payload.items[0].listingId, 'listing-1');
  assert.ok(pool.calls.some((call) => call.sql === 'BEGIN'));
  assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
  assert.equal(pool.client.released, true);

  const commandInsert = pool.calls.find((call) => /INSERT INTO remote_worker_commands/.test(call.sql));
  assert.ok(commandInsert);
  assert.equal(commandInsert.params[0], 'command-1');
  assert.equal(commandInsert.params[1], 'session-1');
  assert.equal(commandInsert.params[8], 0);
  const commandPayload = JSON.parse(commandInsert.params[7]);
  assert.equal(commandPayload.items[0].listingId, 'listing-1');

  const claimInsert = pool.calls.find((call) => /INSERT INTO remote_worker_claims/.test(call.sql));
  assert.ok(claimInsert);
  assert.equal(claimInsert.params[0], 'claim-1');
  assert.equal(claimInsert.params[1], 'lease-1');
  assert.equal(claimInsert.params[8], commandInsert.params[7]);
});

test('claimRemoteWorkerWork touches unsupported sessions without claiming', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) {
      return [{ ...sessionRow, worker_type: 'collector', strategy: 'feed' }];
    }
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const result = await store.claimRemoteWorkerWork('session-1', { workerId: 'worker-1' });

  assert.equal(result.reason, 'unsupported_remote_claim_worker');
  assert.deepEqual(result.claims, []);
  const update = pool.calls.find((call) => /UPDATE remote_worker_sessions/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params, ['2026-01-03T00:00:00.000Z', 'session-1']);
});

test('renewRemoteWorkerLease and completeRemoteWorkerLease update PostgreSQL lease state', async () => {
  const leaseRow = {
    claim_id: 'claim-1',
    lease_id: 'lease-1',
    session_id: 'session-1',
    command_id: 'command-1',
    status: 'claimed',
    expires_at: '2999-01-01T00:00:00.000Z',
  };
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_claims/.test(sql)) return [leaseRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const renewed = await store.renewRemoteWorkerLease('session-1', 'lease-1', {
    expiresAt: '2026-01-03T00:03:00.000Z',
  });
  assert.equal(renewed.status, 'renewed');
  const renewUpdate = pool.calls.find((call) => /SET status = 'renewed'/.test(call.sql));
  assert.ok(renewUpdate);
  assert.deepEqual(renewUpdate.params, ['2026-01-03T00:00:00.000Z', '2026-01-03T00:03:00.000Z', 'claim-1']);

  const completed = await store.completeRemoteWorkerLease('session-1', 'lease-1', {
    status: 'failed',
    error: 'boom',
    result: { ok: false },
  });
  assert.equal(completed.status, 'failed');
  const claimUpdate = pool.calls.find((call) => /UPDATE remote_worker_claims/.test(call.sql) && /completed_at/.test(call.sql));
  assert.ok(claimUpdate);
  assert.deepEqual(claimUpdate.params, ['failed', '2026-01-03T00:00:00.000Z', '{"ok":false}', 'boom', 'claim-1']);
  const commandUpdate = pool.calls.find((call) => /UPDATE remote_worker_commands/.test(call.sql));
  assert.ok(commandUpdate);
  assert.deepEqual(commandUpdate.params, ['failed', 'failed', '{"ok":false}', '2026-01-03T00:00:00.000Z', 'boom', 'command-1']);
});
