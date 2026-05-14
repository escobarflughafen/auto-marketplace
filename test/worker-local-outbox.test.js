const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  openWorkerLocalStore,
  closeDatabase,
  ensureCentralWorkerEventSchema,
  setWorkerState,
  getWorkerState,
  appendWorkerOutboxEvent,
  listWorkerOutboxEvents,
  flushWorkerOutboxToCentral,
  listCentralWorkerEvents,
  ensureCentralWorkerCommandSchema,
  appendCentralBrowserCommand,
  claimNextBrowserCommand,
  listCentralBrowserCommands,
  recordWorkerHeartbeat,
  listWorkerHeartbeats,
  requeueCommandsForExpiredWorkerLeases,
  recoverClaimedBrowserCommandsForWorkerRestart,
  applyWorkerEventsToCommandProjection,
  requeueStaleBrowserCommands,
  runWorkerCommandOnce,
} = require('../scripts/worker-local-outbox');
const {
  createMockWorkerEvent,
  createMockCaptureEventSet,
  createMockBrowserCommand,
} = require('./helpers/worker-event-mocks');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worker-local-outbox-'));
}

function openCentralDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureCentralWorkerEventSchema(db);
  ensureCentralWorkerCommandSchema(db);
  return db;
}

test('worker local store keeps worker state and pending test events', () => {
  const tempDir = createTempDir();
  const { db } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    const state = setWorkerState(db, 'activeCommand', {
      commandId: 'test-command-1',
      listingId: 'test-listing-1',
    }, {
      updatedAt: '2026-05-13T20:00:00.000Z',
    });

    assert.deepEqual(state.value, {
      commandId: 'test-command-1',
      listingId: 'test-listing-1',
    });
    assert.deepEqual(getWorkerState(db, 'activeCommand'), state);

    const event = appendWorkerOutboxEvent(db, createMockWorkerEvent({
      eventId: 'test-event-local-pending',
      payload: {
        commandId: 'test-command-1',
        listingId: 'test-listing-1',
      },
    }));

    assert.equal(event.event_id, 'test-event-local-pending');
    assert.equal(event.status, 'pending');
    assert.ok(event.labels.includes('test_event'));
    assert.equal(event.payload.testEvent, true);

    const pending = listWorkerOutboxEvents(db, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event_id, 'test-event-local-pending');
  } finally {
    closeDatabase(db);
  }
});

test('worker outbox flush inserts test events centrally and marks local events flushed', () => {
  const tempDir = createTempDir();
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));

  try {
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-flush-1',
      eventType: 'listing_capture_succeeded',
      eventAt: '2026-05-13T20:00:01.000Z',
      payload: {
        commandId: 'test-command-1',
        listingId: 'test-listing-1',
        detailStatus: 'done',
      },
    }));

    const summary = flushWorkerOutboxToCentral(localDb, centralDb, {
      flushedAt: '2026-05-13T20:00:02.000Z',
    });

    assert.deepEqual(summary, {
      scanned: 1,
      inserted: 1,
      existing: 0,
      failed: 0,
      eventIds: ['test-event-flush-1'],
    });

    const localEvents = listWorkerOutboxEvents(localDb);
    assert.equal(localEvents.length, 1);
    assert.equal(localEvents[0].status, 'flushed');
    assert.equal(localEvents[0].flushed_at, '2026-05-13T20:00:02.000Z');

    const centralEvents = listCentralWorkerEvents(centralDb);
    assert.equal(centralEvents.length, 1);
    assert.equal(centralEvents[0].event_id, 'test-event-flush-1');
    assert.equal(centralEvents[0].event_type, 'listing_capture_succeeded');
    assert.ok(centralEvents[0].labels.includes('test_event'));
    assert.equal(centralEvents[0].payload.testEvent, true);
    assert.equal(centralEvents[0].payload.detailStatus, 'done');

    const secondSummary = flushWorkerOutboxToCentral(localDb, centralDb);
    assert.equal(secondSummary.scanned, 0);
    assert.equal(listCentralWorkerEvents(centralDb).length, 1);
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('mock capture event set flushes in deterministic event order', () => {
  const tempDir = createTempDir();
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));

  try {
    for (const event of createMockCaptureEventSet('test-worker-ordered')) {
      appendWorkerOutboxEvent(localDb, event);
    }

    const summary = flushWorkerOutboxToCentral(localDb, centralDb);
    assert.equal(summary.scanned, 2);
    assert.equal(summary.inserted, 2);

    const centralEvents = listCentralWorkerEvents(centralDb);
    assert.deepEqual(centralEvents.map((event) => event.event_id), [
      'test-event-command-started',
      'test-event-capture-succeeded',
    ]);
    assert.ok(centralEvents.every((event) => event.labels.includes('test_event')));
    assert.ok(centralEvents.every((event) => event.payload.testEvent === true));
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('central flush failure keeps test event pending in the worker outbox', () => {
  const tempDir = createTempDir();
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));

  try {
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-central-failure',
      eventType: 'listing_capture_failed',
      payload: {
        commandId: 'test-command-failure',
        listingId: 'test-listing-failure',
        error: 'central write intentionally rejected by test trigger',
      },
    }));
    centralDb.exec(`
      CREATE TRIGGER reject_test_worker_event_insert
      BEFORE INSERT ON worker_event_log
      BEGIN
        SELECT RAISE(ABORT, 'test central event write rejected');
      END;
    `);

    assert.throws(
      () => flushWorkerOutboxToCentral(localDb, centralDb),
      /test central event write rejected/,
    );

    const pending = listWorkerOutboxEvents(localDb, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event_id, 'test-event-central-failure');
    assert.equal(pending[0].flush_attempts, 1);
    assert.match(pending[0].last_error, /test central event write rejected/);
    assert.ok(pending[0].labels.includes('test_event'));
    assert.equal(listCentralWorkerEvents(centralDb).length, 0);
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('worker outbox flush limit batches test events without losing pending work', () => {
  const tempDir = createTempDir();
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));

  try {
    for (const index of [1, 2, 3]) {
      appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
        eventId: `test-event-batch-${index}`,
        eventType: 'worker_test_batch_event',
        eventAt: `2026-05-13T20:00:0${index}.000Z`,
        payload: {
          batchIndex: index,
        },
      }));
    }

    const firstFlush = flushWorkerOutboxToCentral(localDb, centralDb, { limit: 2 });
    assert.equal(firstFlush.scanned, 2);
    assert.equal(firstFlush.inserted, 2);
    assert.deepEqual(firstFlush.eventIds, ['test-event-batch-1', 'test-event-batch-2']);

    const remaining = listWorkerOutboxEvents(localDb, { status: 'pending' });
    assert.deepEqual(remaining.map((event) => event.event_id), ['test-event-batch-3']);
    assert.deepEqual(
      listCentralWorkerEvents(centralDb).map((event) => event.event_id),
      ['test-event-batch-1', 'test-event-batch-2'],
    );

    const secondFlush = flushWorkerOutboxToCentral(localDb, centralDb, { limit: 2 });
    assert.equal(secondFlush.scanned, 1);
    assert.equal(secondFlush.inserted, 1);
    assert.equal(listWorkerOutboxEvents(localDb, { status: 'pending' }).length, 0);
    assert.deepEqual(
      listCentralWorkerEvents(centralDb).map((event) => event.event_id),
      ['test-event-batch-1', 'test-event-batch-2', 'test-event-batch-3'],
    );
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('duplicate central test event ids with mismatched content are rejected and kept pending', () => {
  const tempDir = createTempDir();
  const { db: workerADb } = openWorkerLocalStore(path.join(tempDir, 'worker-a.db'));
  const { db: workerBDb } = openWorkerLocalStore(path.join(tempDir, 'worker-b.db'));
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));

  try {
    appendWorkerOutboxEvent(workerADb, createMockWorkerEvent({
      eventId: 'test-event-duplicate-mismatch',
      eventType: 'worker_test_event',
      workerId: 'test-worker-a',
      payload: {
        commandId: 'test-command-duplicate-mismatch',
        value: 'original',
      },
    }));
    const firstFlush = flushWorkerOutboxToCentral(workerADb, centralDb);
    assert.equal(firstFlush.inserted, 1);

    appendWorkerOutboxEvent(workerBDb, createMockWorkerEvent({
      eventId: 'test-event-duplicate-mismatch',
      eventType: 'worker_test_event',
      workerId: 'test-worker-b',
      payload: {
        commandId: 'test-command-duplicate-mismatch',
        value: 'conflicting',
      },
    }));

    assert.throws(
      () => flushWorkerOutboxToCentral(workerBDb, centralDb),
      /duplicate worker event mismatch/,
    );

    const pending = listWorkerOutboxEvents(workerBDb, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event_id, 'test-event-duplicate-mismatch');
    assert.equal(pending[0].flush_attempts, 1);
    assert.match(pending[0].last_error, /duplicate worker event mismatch/);

    const centralEvents = listCentralWorkerEvents(centralDb);
    assert.equal(centralEvents.length, 1);
    assert.equal(centralEvents[0].payload.value, 'original');
  } finally {
    closeDatabase(workerADb);
    closeDatabase(workerBDb);
    closeDatabase(centralDb);
  }
});

test('central command queue stores pending test commands by priority and time', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-low',
      priority: 1,
      requestedAt: '2026-05-13T20:01:02.000Z',
    }));
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-high',
      priority: 10,
      requestedAt: '2026-05-13T20:01:01.000Z',
      payload: {
        listingId: 'test-listing-priority',
      },
    }));

    const commands = listCentralBrowserCommands(centralDb, { status: 'queued' });
    assert.deepEqual(commands.map((command) => command.command_id), [
      'test-command-high',
      'test-command-low',
    ]);
    assert.ok(commands.every((command) => command.labels.includes('test_event')));
    assert.ok(commands.every((command) => command.payload.testEvent === true));
  } finally {
    closeDatabase(centralDb);
  }
});

test('worker heartbeat profile lease drives expired-lease command recovery', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    const heartbeat = recordWorkerHeartbeat(centralDb, {
      workerId: 'test-worker-lease',
      profileId: 'test-profile-lease',
      heartbeatAt: '2026-05-13T20:01:00.000Z',
      leaseExpiresAt: '2026-05-13T20:01:30.000Z',
      labels: ['test_event'],
      metadata: {
        testEvent: true,
      },
    });
    assert.equal(heartbeat.worker_id, 'test-worker-lease');
    assert.equal(heartbeat.profile_id, 'test-profile-lease');
    assert.equal(heartbeat.lease_expires_at, '2026-05-13T20:01:30.000Z');
    assert.ok(heartbeat.labels.includes('test_event'));
    assert.equal(heartbeat.metadata.testEvent, true);
    assert.equal(listWorkerHeartbeats(centralDb).length, 1);

    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-expired-lease',
    }));
    claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-lease',
      claimedAt: '2026-05-13T20:01:05.000Z',
    });

    const freshLease = requeueCommandsForExpiredWorkerLeases(centralDb, {
      expiredBefore: '2026-05-13T20:01:20.000Z',
      requeuedAt: '2026-05-13T20:01:21.000Z',
    });
    assert.equal(freshLease.requeued, 0);
    assert.equal(listCentralBrowserCommands(centralDb)[0].status, 'claimed');

    const expiredLease = requeueCommandsForExpiredWorkerLeases(centralDb, {
      expiredBefore: '2026-05-13T20:01:31.000Z',
      requeuedAt: '2026-05-13T20:01:32.000Z',
    });
    assert.deepEqual(expiredLease.commandIds, ['test-command-expired-lease']);
    assert.equal(expiredLease.requeued, 1);

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'queued');
    assert.equal(command.claimed_by, '');
    assert.equal(command.claim_id, '');
    assert.equal(command.error, 'requeued expired worker lease from test-worker-lease');
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('claimed test commands have an explicit worker restart recovery path', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-worker-restart-recovery',
    }));
    claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-restarted',
      claimedAt: '2026-05-13T20:01:40.000Z',
    });

    const recovery = recoverClaimedBrowserCommandsForWorkerRestart(centralDb, {
      workerId: 'test-worker-restarted',
      restartedAt: '2026-05-13T20:02:00.000Z',
    });
    assert.deepEqual(recovery.commandIds, ['test-command-worker-restart-recovery']);
    assert.equal(recovery.recovered, 1);

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'queued');
    assert.equal(command.claimed_by, '');
    assert.equal(command.claim_id, '');
    assert.equal(command.error, 'requeued worker restart from test-worker-restarted');
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('worker claim mirrors test command into local state and outbox exactly once', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-claim-once',
      payload: {
        listingId: 'test-listing-claim-once',
      },
    }));

    const claimed = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-claim',
      claimedAt: '2026-05-13T20:01:03.000Z',
    });
    assert.equal(claimed.command_id, 'test-command-claim-once');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.claimed_by, 'test-worker-claim');
    assert.ok(claimed.labels.includes('test_event'));

    const state = getWorkerState(localDb, 'activeCommand');
    assert.equal(state.value.commandId, 'test-command-claim-once');
    assert.equal(state.value.workerId, 'test-worker-claim');
    assert.equal(state.value.status, 'claimed');
    assert.equal(state.value.testEvent, true);

    const localEvents = listWorkerOutboxEvents(localDb, { status: 'pending' });
    assert.equal(localEvents.length, 1);
    assert.equal(localEvents[0].event_type, 'browser_command_claimed');
    assert.equal(localEvents[0].payload.commandId, 'test-command-claim-once');
    assert.ok(localEvents[0].labels.includes('test_event'));
    assert.equal(localEvents[0].payload.testEvent, true);

    const secondClaim = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-claim-2',
    });
    assert.equal(secondClaim, null);

    const commands = listCentralBrowserCommands(centralDb);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].status, 'claimed');
    assert.equal(commands[0].claimed_by, 'test-worker-claim');
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('central command projection applies flushed test success events idempotently', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-success-projection',
      payload: {
        listingId: 'test-listing-success-projection',
      },
    }));
    const claim = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-success-projection',
      claimedAt: '2026-05-13T20:02:00.000Z',
    });
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-command-succeeded-projection',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:02:05.000Z',
      workerId: 'test-worker-success-projection',
      payload: {
        commandId: 'test-command-success-projection',
        claimId: claim.claim_id,
        result: {
          detailStatus: 'done',
          listingId: 'test-listing-success-projection',
        },
      },
    }));
    flushWorkerOutboxToCentral(localDb, centralDb);

    const firstApply = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(firstApply.applied, 1);
    assert.deepEqual(firstApply.commandIds, ['test-command-success-projection']);

    const command = listCentralBrowserCommands(centralDb)
      .find((item) => item.command_id === 'test-command-success-projection');
    assert.equal(command.status, 'succeeded');
    assert.equal(command.result.detailStatus, 'done');
    assert.equal(command.result.testEvent, true);
    assert.equal(command.error, '');

    const secondApply = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(secondApply.applied, 0);
    assert.deepEqual(secondApply.commandIds, []);
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('central command projection applies flushed test failure events', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-failure-projection',
      payload: {
        listingId: 'test-listing-failure-projection',
      },
    }));
    const claim = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-failure-projection',
      claimedAt: '2026-05-13T20:03:00.000Z',
    });
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-command-failed-projection',
      eventType: 'browser_command_failed',
      eventAt: '2026-05-13T20:03:05.000Z',
      workerId: 'test-worker-failure-projection',
      payload: {
        commandId: 'test-command-failure-projection',
        claimId: claim.claim_id,
        error: 'test event commanded failure',
      },
    }));
    flushWorkerOutboxToCentral(localDb, centralDb);

    const result = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(result.applied, 1);

    const command = listCentralBrowserCommands(centralDb)
      .find((item) => item.command_id === 'test-command-failure-projection');
    assert.equal(command.status, 'failed');
    assert.equal(command.error, 'test event commanded failure');
    assert.equal(command.result.testEvent, true);
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('projection race on a test event is idempotent and does not mutate command state twice', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-projection-race',
    }));
    const claim = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-projection-race',
      claimedAt: '2026-05-13T20:03:30.000Z',
    });
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-projection-race',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:03:35.000Z',
      workerId: 'test-worker-projection-race',
      payload: {
        commandId: 'test-command-projection-race',
        claimId: claim.claim_id,
        result: {
          detailStatus: 'done',
        },
      },
    }));
    flushWorkerOutboxToCentral(localDb, centralDb);
    centralDb.exec(`
      CREATE TRIGGER simulate_projection_race
      BEFORE INSERT ON browser_command_projection_events
      WHEN NEW.event_id = 'test-event-projection-race'
      BEGIN
        INSERT INTO browser_command_projection_events (
          event_id,
          command_id,
          applied_at
        ) VALUES (
          NEW.event_id,
          NEW.command_id,
          '2026-05-13T20:03:34.000Z'
        );
      END;
    `);

    const projection = applyWorkerEventsToCommandProjection(centralDb, {
      appliedAt: '2026-05-13T20:03:36.000Z',
    });
    assert.equal(projection.applied, 0);
    assert.equal(projection.skipped, 1);

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'claimed');
    assert.deepEqual(command.result, {});

    const projected = centralDb.prepare(`
      SELECT *
      FROM browser_command_projection_events
      WHERE event_id = ?
    `).get('test-event-projection-race');
    assert.equal(projected.command_id, 'test-command-projection-race');
    assert.equal(projected.applied_at, '2026-05-13T20:03:34.000Z');
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('stale claimed test commands can be requeued for another worker', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-stale-requeue',
      requestedAt: '2026-05-13T20:04:00.000Z',
    }));
    claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-stale',
      claimedAt: '2026-05-13T20:04:05.000Z',
    });

    const freshResult = requeueStaleBrowserCommands(centralDb, {
      staleBefore: '2026-05-13T20:04:04.000Z',
      requeuedAt: '2026-05-13T20:04:10.000Z',
    });
    assert.equal(freshResult.requeued, 0);
    assert.equal(listCentralBrowserCommands(centralDb)[0].status, 'claimed');

    const staleResult = requeueStaleBrowserCommands(centralDb, {
      staleBefore: '2026-05-13T20:04:06.000Z',
      requeuedAt: '2026-05-13T20:04:11.000Z',
    });
    assert.deepEqual(staleResult.commandIds, ['test-command-stale-requeue']);
    assert.equal(staleResult.requeued, 1);

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'queued');
    assert.equal(command.claimed_by, '');
    assert.equal(command.claimed_at, '');
    assert.equal(command.error, 'requeued stale claim from test-worker-stale');
    assert.ok(command.labels.includes('test_event'));
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('test command recovers from missing worker and completes through another worker outbox', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: workerADb } = openWorkerLocalStore(path.join(tempDir, 'worker-a.db'));
  const { db: workerBDb } = openWorkerLocalStore(path.join(tempDir, 'worker-b.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-worker-recovery',
      priority: 5,
      requestedAt: '2026-05-13T20:05:00.000Z',
      payload: {
        listingId: 'test-listing-worker-recovery',
      },
    }));

    const firstClaim = claimNextBrowserCommand(centralDb, workerADb, {
      workerId: 'test-worker-a',
      claimedAt: '2026-05-13T20:05:05.000Z',
    });
    assert.equal(firstClaim.claimed_by, 'test-worker-a');

    const requeue = requeueStaleBrowserCommands(centralDb, {
      staleBefore: '2026-05-13T20:05:06.000Z',
      requeuedAt: '2026-05-13T20:05:30.000Z',
    });
    assert.equal(requeue.requeued, 1);

    const secondClaim = claimNextBrowserCommand(centralDb, workerBDb, {
      workerId: 'test-worker-b',
      claimedAt: '2026-05-13T20:05:31.000Z',
    });
    assert.equal(secondClaim.command_id, 'test-command-worker-recovery');
    assert.equal(secondClaim.claimed_by, 'test-worker-b');

    appendWorkerOutboxEvent(workerBDb, createMockWorkerEvent({
      eventId: 'test-event-worker-recovery-succeeded',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:05:40.000Z',
      workerId: 'test-worker-b',
      payload: {
        commandId: 'test-command-worker-recovery',
        claimId: secondClaim.claim_id,
        result: {
          listingId: 'test-listing-worker-recovery',
          detailStatus: 'done',
          recoveredFromWorker: 'test-worker-a',
        },
      },
    }));
    flushWorkerOutboxToCentral(workerBDb, centralDb);
    const projection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(projection.applied, 1);

    const command = listCentralBrowserCommands(centralDb)
      .find((item) => item.command_id === 'test-command-worker-recovery');
    assert.equal(command.status, 'succeeded');
    assert.equal(command.claimed_by, 'test-worker-b');
    assert.equal(command.result.detailStatus, 'done');
    assert.equal(command.result.recoveredFromWorker, 'test-worker-a');
    assert.equal(command.result.testEvent, true);
  } finally {
    closeDatabase(workerADb);
    closeDatabase(workerBDb);
    closeDatabase(centralDb);
  }
});

test('late stale-worker terminal test event cannot overwrite a newer claim completion', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: workerADb } = openWorkerLocalStore(path.join(tempDir, 'worker-a.db'));
  const { db: workerBDb } = openWorkerLocalStore(path.join(tempDir, 'worker-b.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-late-stale-worker',
      priority: 5,
      requestedAt: '2026-05-13T20:05:00.000Z',
      payload: {
        listingId: 'test-listing-late-stale-worker',
      },
    }));

    const firstClaim = claimNextBrowserCommand(centralDb, workerADb, {
      workerId: 'test-worker-a',
      claimedAt: '2026-05-13T20:05:05.000Z',
    });
    assert.equal(firstClaim.claimed_by, 'test-worker-a');
    assert.ok(firstClaim.claim_id);

    requeueStaleBrowserCommands(centralDb, {
      staleBefore: '2026-05-13T20:05:06.000Z',
      requeuedAt: '2026-05-13T20:05:30.000Z',
    });

    const secondClaim = claimNextBrowserCommand(centralDb, workerBDb, {
      workerId: 'test-worker-b',
      claimedAt: '2026-05-13T20:05:31.000Z',
    });
    assert.equal(secondClaim.claimed_by, 'test-worker-b');
    assert.ok(secondClaim.claim_id);
    assert.notEqual(secondClaim.claim_id, firstClaim.claim_id);

    appendWorkerOutboxEvent(workerBDb, createMockWorkerEvent({
      eventId: 'test-event-newer-worker-succeeded',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:05:40.000Z',
      workerId: 'test-worker-b',
      payload: {
        commandId: 'test-command-late-stale-worker',
        claimId: secondClaim.claim_id,
        result: {
          listingId: 'test-listing-late-stale-worker',
          detailStatus: 'done',
          completedBy: 'test-worker-b',
        },
      },
    }));
    flushWorkerOutboxToCentral(workerBDb, centralDb);
    const newerProjection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(newerProjection.applied, 1);

    appendWorkerOutboxEvent(workerADb, createMockWorkerEvent({
      eventId: 'test-event-stale-worker-late-succeeded',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:05:45.000Z',
      workerId: 'test-worker-a',
      payload: {
        commandId: 'test-command-late-stale-worker',
        claimId: firstClaim.claim_id,
        result: {
          listingId: 'test-listing-late-stale-worker',
          detailStatus: 'done',
          completedBy: 'test-worker-a-stale',
        },
      },
    }));
    flushWorkerOutboxToCentral(workerADb, centralDb);
    const staleProjection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(staleProjection.applied, 0);
    assert.equal(staleProjection.skipped, 1);
    assert.deepEqual(staleProjection.commandIds, []);

    const command = listCentralBrowserCommands(centralDb)
      .find((item) => item.command_id === 'test-command-late-stale-worker');
    assert.equal(command.status, 'succeeded');
    assert.equal(command.claimed_by, 'test-worker-b');
    assert.equal(command.claim_id, secondClaim.claim_id);
    assert.equal(command.result.completedBy, 'test-worker-b');
    assert.notEqual(command.result.completedBy, 'test-worker-a-stale');
  } finally {
    closeDatabase(workerADb);
    closeDatabase(workerBDb);
    closeDatabase(centralDb);
  }
});

test('late stale-worker failure test event cannot downgrade a newer success', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: workerADb } = openWorkerLocalStore(path.join(tempDir, 'worker-a.db'));
  const { db: workerBDb } = openWorkerLocalStore(path.join(tempDir, 'worker-b.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-late-stale-failure',
      requestedAt: '2026-05-13T20:05:00.000Z',
    }));

    const firstClaim = claimNextBrowserCommand(centralDb, workerADb, {
      workerId: 'test-worker-a',
      claimedAt: '2026-05-13T20:05:05.000Z',
    });
    requeueStaleBrowserCommands(centralDb, {
      staleBefore: '2026-05-13T20:05:06.000Z',
      requeuedAt: '2026-05-13T20:05:30.000Z',
    });
    const secondClaim = claimNextBrowserCommand(centralDb, workerBDb, {
      workerId: 'test-worker-b',
      claimedAt: '2026-05-13T20:05:31.000Z',
    });

    appendWorkerOutboxEvent(workerBDb, createMockWorkerEvent({
      eventId: 'test-event-newer-success-before-stale-failure',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:05:40.000Z',
      workerId: 'test-worker-b',
      payload: {
        commandId: 'test-command-late-stale-failure',
        claimId: secondClaim.claim_id,
        result: {
          detailStatus: 'done',
          completedBy: 'test-worker-b',
        },
      },
    }));
    flushWorkerOutboxToCentral(workerBDb, centralDb);
    applyWorkerEventsToCommandProjection(centralDb);

    appendWorkerOutboxEvent(workerADb, createMockWorkerEvent({
      eventId: 'test-event-stale-failure-after-newer-success',
      eventType: 'browser_command_failed',
      eventAt: '2026-05-13T20:05:45.000Z',
      workerId: 'test-worker-a',
      payload: {
        commandId: 'test-command-late-stale-failure',
        claimId: firstClaim.claim_id,
        error: 'stale worker failed after newer success',
      },
    }));
    flushWorkerOutboxToCentral(workerADb, centralDb);
    const staleProjection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(staleProjection.applied, 0);
    assert.equal(staleProjection.skipped, 1);

    const command = listCentralBrowserCommands(centralDb)
      .find((item) => item.command_id === 'test-command-late-stale-failure');
    assert.equal(command.status, 'succeeded');
    assert.equal(command.error, '');
    assert.equal(command.result.completedBy, 'test-worker-b');
    assert.equal(command.result.testEvent, true);
  } finally {
    closeDatabase(workerADb);
    closeDatabase(workerBDb);
    closeDatabase(centralDb);
  }
});

test('terminal command projection requires exact test claimId', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-require-claim-id',
    }));
    const claim = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-require-claim-id',
      claimedAt: '2026-05-13T20:08:00.000Z',
    });
    assert.ok(claim.claim_id);

    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-terminal-missing-claim-id',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:08:05.000Z',
      workerId: 'test-worker-require-claim-id',
      payload: {
        commandId: 'test-command-require-claim-id',
        result: {
          detailStatus: 'done',
        },
      },
    }));
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-terminal-wrong-claim-id',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:08:06.000Z',
      workerId: 'test-worker-require-claim-id',
      payload: {
        commandId: 'test-command-require-claim-id',
        claimId: 'wrong-test-claim-id',
        result: {
          detailStatus: 'done',
        },
      },
    }));
    flushWorkerOutboxToCentral(localDb, centralDb);

    const projection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(projection.applied, 0);
    assert.equal(projection.skipped, 2);
    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'claimed');
    assert.equal(command.claim_id, claim.claim_id);
    assert.deepEqual(command.result, {});
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('terminal test commands are immutable after first matching claim completion', () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-terminal-immutable',
    }));
    const claim = claimNextBrowserCommand(centralDb, localDb, {
      workerId: 'test-worker-terminal-immutable',
      claimedAt: '2026-05-13T20:09:00.000Z',
    });
    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-terminal-first-success',
      eventType: 'browser_command_succeeded',
      eventAt: '2026-05-13T20:09:05.000Z',
      workerId: 'test-worker-terminal-immutable',
      payload: {
        commandId: 'test-command-terminal-immutable',
        claimId: claim.claim_id,
        result: {
          detailStatus: 'done',
          version: 'first',
        },
      },
    }));
    flushWorkerOutboxToCentral(localDb, centralDb);
    const firstProjection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(firstProjection.applied, 1);

    appendWorkerOutboxEvent(localDb, createMockWorkerEvent({
      eventId: 'test-event-terminal-late-failure-same-claim',
      eventType: 'browser_command_failed',
      eventAt: '2026-05-13T20:09:06.000Z',
      workerId: 'test-worker-terminal-immutable',
      payload: {
        commandId: 'test-command-terminal-immutable',
        claimId: claim.claim_id,
        error: 'late same-claim failure must not overwrite terminal success',
      },
    }));
    flushWorkerOutboxToCentral(localDb, centralDb);
    const secondProjection = applyWorkerEventsToCommandProjection(centralDb);
    assert.equal(secondProjection.applied, 0);
    assert.equal(secondProjection.skipped, 1);

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'succeeded');
    assert.equal(command.error, '');
    assert.equal(command.result.version, 'first');
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('worker command cycle test event IDs include claim identity', async () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-event-id-claim',
    }));

    const result = await runWorkerCommandOnce(centralDb, localDb, {
      workerId: 'test-worker-event-id-claim',
      now: '2026-05-13T20:10:00.000Z',
      handler: async () => ({
        detailStatus: 'done',
      }),
    });

    assert.ok(result.claimed.claim_id);
    const centralEvents = listCentralWorkerEvents(centralDb);
    assert.ok(centralEvents.length >= 3);
    assert.ok(centralEvents.every((event) => event.event_id.includes(result.claimed.claim_id)));
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('worker command cycle runs a mock test command through local outbox to central success', async () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-cycle-success',
      payload: {
        listingId: 'test-listing-cycle-success',
      },
    }));

    const result = await runWorkerCommandOnce(centralDb, localDb, {
      workerId: 'test-worker-cycle',
      now: '2026-05-13T20:06:00.000Z',
      handler: async (command) => ({
        listingId: command.payload.listingId,
        detailStatus: 'done',
        handledBy: 'mock-handler',
      }),
    });

    assert.equal(result.claimed.command_id, 'test-command-cycle-success');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.flush.inserted, 3);
    assert.equal(result.projection.applied, 1);

    const centralEvents = listCentralWorkerEvents(centralDb);
    assert.deepEqual(centralEvents.map((event) => event.event_type), [
      'browser_command_claimed',
      'browser_command_started',
      'browser_command_succeeded',
    ]);
    assert.ok(centralEvents.every((event) => event.labels.includes('test_event')));

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'succeeded');
    assert.equal(command.result.detailStatus, 'done');
    assert.equal(command.result.handledBy, 'mock-handler');
    assert.equal(command.result.testEvent, true);
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});

test('worker command cycle records mock test command failure through local outbox', async () => {
  const tempDir = createTempDir();
  const centralDb = openCentralDb(path.join(tempDir, 'central.db'));
  const { db: localDb } = openWorkerLocalStore(path.join(tempDir, 'worker.db'));

  try {
    appendCentralBrowserCommand(centralDb, createMockBrowserCommand({
      commandId: 'test-command-cycle-failure',
      payload: {
        listingId: 'test-listing-cycle-failure',
      },
    }));

    const result = await runWorkerCommandOnce(centralDb, localDb, {
      workerId: 'test-worker-cycle',
      now: '2026-05-13T20:07:00.000Z',
      handler: async () => {
        throw new Error('mock handler failed for test event');
      },
    });

    assert.equal(result.claimed.command_id, 'test-command-cycle-failure');
    assert.equal(result.status, 'failed');
    assert.equal(result.flush.inserted, 3);
    assert.equal(result.projection.applied, 1);

    const centralEvents = listCentralWorkerEvents(centralDb);
    assert.deepEqual(centralEvents.map((event) => event.event_type), [
      'browser_command_claimed',
      'browser_command_started',
      'browser_command_failed',
    ]);
    assert.ok(centralEvents.every((event) => event.labels.includes('test_event')));

    const command = listCentralBrowserCommands(centralDb)[0];
    assert.equal(command.status, 'failed');
    assert.equal(command.error, 'mock handler failed for test event');
    assert.equal(command.result.testEvent, true);
  } finally {
    closeDatabase(localDb);
    closeDatabase(centralDb);
  }
});
