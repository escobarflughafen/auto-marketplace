const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  createServer,
} = require('../scripts/serve-marketplace-homepage');
const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
} = require('../scripts/marketplace-homepage-db');
const {
  run,
  RemoteWorkerRuntime,
} = require('../scripts/remote-worker-runtime');
const {
  openRemoteWorkerLocalStore,
  setState,
  appendOutboxEvent,
} = require('../scripts/remote-worker-local-store');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-runtime-'));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function seedResolvedListing(dbPath, listingId = 'runtime-listing-1') {
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    upsertHomepageListing(db, {
      listingId,
      href: `https://www.facebook.com/marketplace/item/${listingId}/`,
      title: 'Runtime listing',
      text: 'CA$300 | Runtime listing',
      rank: 1,
    }, {
      seenAt: '2026-06-20T12:00:00.000Z',
    });
    db.prepare(`
      UPDATE homepage_listings
      SET
        detail_status = 'done',
        detail_title = 'Runtime listing resolved',
        detail_price = 'CA$300',
        detail_location = 'Vancouver, BC',
        detail_condition = 'Used - good',
        detail_listed_ago = '2 days ago',
        detail_completed_at = '2026-06-20T12:30:00.000Z',
        detail_json = ?
      WHERE listing_id = ?
    `).run(JSON.stringify({
      listingContent: {
        title: 'Runtime listing resolved',
        price: 'CA$300',
        description: 'Runtime resolved detail text',
      },
    }), listingId);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

test('remote worker runtime claims backlog indexer work, syncs events, and completes lease', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker.db');
  const workerToken = 'runtime-worker-token';
  seedResolvedListing(dbPath);
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);

  try {
    const result = await run({
      hostUrl: `http://${address.address}:${address.port}`,
      workerToken,
      localDbPath: workerDbPath,
      workerId: 'runtime-indexer-1',
      workerType: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sourceId: 'runtime-test',
      once: true,
      capacity: 1,
      batchSize: 1,
    });
    assert.equal(result.claims.length, 1);
    assert.equal(result.claimResults[0].processedCount, 1);
  } finally {
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const listing = db.prepare('SELECT * FROM homepage_listings WHERE listing_id = ?').get('runtime-listing-1');
    assert.equal(listing.detail_listed_at_unit, 'day');
    assert.equal(listing.detail_listed_at_value, 2);
    assert.equal(listing.detail_listed_at_confidence, 'range');
    assert.match(listing.detail_listed_at_source, /^remote:runtime-indexer-1:/);

    const claim = db.prepare('SELECT * FROM remote_worker_claims WHERE worker_id = ?').get('runtime-indexer-1');
    assert.equal(claim.status, 'completed');
    const listingEvent = db.prepare(`
      SELECT *
      FROM listing_events
      WHERE workflow_run_id = ? AND event_type = 'backlog_listing_metadata_indexed'
    `).get(claim.session_id);
    assert.equal(listingEvent.listing_id, 'runtime-listing-1');
    db.close();

    const workerDb = new DatabaseSync(workerDbPath);
    const pending = workerDb.prepare("SELECT COUNT(*) AS count FROM worker_outbox_events WHERE sync_status = 'pending'").get().count;
    const acked = workerDb.prepare("SELECT COUNT(*) AS count FROM worker_outbox_events WHERE sync_status = 'acked'").get().count;
    assert.equal(pending, 0);
    assert.ok(acked >= 3);
    workerDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime uploads pending local outbox events after restart', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker-retry.db');
  const workerToken = 'runtime-worker-token';
  seedResolvedListing(dbPath, 'runtime-retry-listing');
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const hostUrl = `http://${address.address}:${address.port}`;
  let runtime;

  try {
    runtime = new RemoteWorkerRuntime({
      hostUrl,
      workerToken,
      localDbPath: workerDbPath,
      workerId: 'runtime-retry-1',
      workerType: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sourceId: 'runtime-retry-test',
      once: true,
      capacity: 1,
      batchSize: 1,
    });
    await runtime.registerSession();
    const sessionId = runtime.sessionId;
    const { db: workerDb } = openRemoteWorkerLocalStore(workerDbPath);
    try {
      setState(workerDb, 'session', { sessionId });
      setState(workerDb, 'checkpoint', { lastLocalSequence: 1, lastAckedSequence: 0 });
      appendOutboxEvent(workerDb, {
        eventId: 'runtime-retry-event-1',
        sessionId,
        workerId: 'runtime-retry-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        sequence: 1,
        eventScope: 'workflow',
        eventType: 'worker_started',
        eventAt: '2026-06-20T12:00:01.000Z',
        status: 'running',
        payload: {
          workerType: 'backlog_indexer',
          strategy: 'resolved_metadata',
          mode: 'retry-test',
        },
      });
    } finally {
      workerDb.close();
    }
    runtime.close();
    runtime = null;

    const restarted = new RemoteWorkerRuntime({
      hostUrl,
      workerToken,
      localDbPath: workerDbPath,
      workerId: 'runtime-retry-1',
      workerType: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sourceId: 'runtime-retry-test',
      once: true,
      capacity: 1,
      batchSize: 1,
    });
    try {
      await restarted.registerSession();
      await restarted.uploadPendingEvents();
    } finally {
      restarted.close();
    }
  } finally {
    if (runtime) runtime.close();
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const event = db.prepare('SELECT * FROM workflow_events WHERE event_id = ?').get('runtime-retry-event-1');
    assert.equal(event.event_type, 'worker_started');
    db.close();

    const workerDb = new DatabaseSync(workerDbPath);
    const row = workerDb.prepare('SELECT sync_status FROM worker_outbox_events WHERE event_id = ?').get('runtime-retry-event-1');
    assert.equal(row.sync_status, 'acked');
    workerDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime uploads artifact manifests and persists local ACKs', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker-artifacts.db');
  const workerToken = 'runtime-worker-token';
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const runtime = new RemoteWorkerRuntime({
    hostUrl: `http://${address.address}:${address.port}`,
    workerToken,
    localDbPath: workerDbPath,
    workerId: 'runtime-artifacts-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sourceId: 'runtime-artifact-test',
    once: true,
    artifactBatchSize: 5,
  });

  try {
    await runtime.registerSession();
    runtime.appendArtifactManifest({
      exchangeType: 'artifact_manifest',
      schemaVersion: 'remote-worker-artifact@1',
      artifactId: 'runtime-artifact-1',
      eventId: 'runtime-artifact-event-1',
      artifactType: 'image',
      mediaRole: 'listing_photo',
      contentType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      sizeBytes: 2048,
      width: 640,
      height: 480,
      metadata: {
        listingId: 'runtime-artifact-listing',
        position: 0,
      },
    });
    const result = await runtime.uploadPendingArtifacts();
    assert.deepEqual(result.accepted.map((artifact) => artifact.artifactId), ['runtime-artifact-1']);
    assert.deepEqual(result.duplicates, []);
  } finally {
    runtime.close();
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const artifact = db.prepare('SELECT * FROM remote_worker_artifacts WHERE artifact_id = ?').get('runtime-artifact-1');
    assert.equal(artifact.worker_id, 'runtime-artifacts-1');
    assert.equal(artifact.event_id, 'runtime-artifact-event-1');
    assert.equal(artifact.upload_status, 'manifest_accepted');
    assert.equal(artifact.sha256, 'b'.repeat(64));
    db.close();

    const workerDb = new DatabaseSync(workerDbPath);
    const row = workerDb.prepare('SELECT sync_status, acked_at, last_error FROM worker_artifact_spool WHERE artifact_id = ?').get('runtime-artifact-1');
    assert.equal(row.sync_status, 'acked');
    assert.notEqual(row.acked_at, '');
    assert.equal(row.last_error, '');
    workerDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime applies artifact spool backpressure before claiming work', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker-artifact-backpressure.db');
  const workerToken = 'runtime-worker-token';
  seedResolvedListing(dbPath, 'runtime-backpressure-listing');
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const runtime = new RemoteWorkerRuntime({
    hostUrl: `http://${address.address}:${address.port}`,
    workerToken,
    localDbPath: workerDbPath,
    workerId: 'runtime-artifact-backpressure-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sourceId: 'runtime-artifact-test',
    once: true,
    capacity: 1,
    batchSize: 1,
    maxPendingArtifactBytes: 1024,
  });

  try {
    await runtime.registerSession();
    runtime.appendArtifactManifest({
      exchangeType: 'artifact_manifest',
      schemaVersion: 'remote-worker-artifact@1',
      artifactId: 'runtime-large-artifact-1',
      eventId: 'runtime-large-artifact-event-1',
      artifactType: 'image',
      mediaRole: 'listing_photo',
      contentType: 'image/jpeg',
      sha256: 'c'.repeat(64),
      sizeBytes: 2048,
      metadata: {
        listingId: 'runtime-backpressure-listing',
      },
    });
    const result = await runtime.claimWork();
    assert.deepEqual(result.claims, []);
    assert.equal(result.backpressure.reason, 'pending_artifact_bytes');
    assert.equal(result.backpressure.pendingArtifactBytes, 2048);
  } finally {
    runtime.close();
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
