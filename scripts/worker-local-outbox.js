const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function serializeJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function buildEventId(eventAt, workerId, eventType) {
  const stamp = String(eventAt || nowIso()).replace(/[^0-9A-Za-z]/g, '');
  const entropy = crypto.randomBytes(8).toString('hex');
  return [stamp, String(workerId || 'worker'), String(eventType || 'event'), entropy].join('-');
}

function buildClaimId(commandId, workerId, claimedAt) {
  const stamp = String(claimedAt || nowIso()).replace(/[^0-9A-Za-z]/g, '');
  const entropy = crypto.randomBytes(8).toString('hex');
  return [String(commandId || 'command'), String(workerId || 'worker'), stamp, entropy].join('-');
}

function normalizeLabels(labels = []) {
  return [...new Set((Array.isArray(labels) ? labels : [labels])
    .map((label) => String(label || '').trim())
    .filter(Boolean))];
}

function openWorkerLocalStore(dbPath) {
  const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureWorkerLocalSchema(db);
  return { db, dbPath: resolvedPath };
}

function ensureWorkerLocalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_outbox_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      worker_id TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      labels_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      local_created_at TEXT NOT NULL,
      flushed_at TEXT NOT NULL DEFAULT '',
      flush_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_outbox_status_time
    ON worker_outbox_events (status, event_at ASC);
  `);
}

function ensureCentralWorkerEventSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_event_log (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      worker_id TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      labels_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      ingested_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_event_log_worker_time
    ON worker_event_log (worker_id, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_event_log_type_time
    ON worker_event_log (event_type, event_at DESC);
  `);
}

function ensureCentralWorkerCommandSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_commands (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      entity_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT '',
      claimed_by TEXT NOT NULL DEFAULT '',
      claim_id TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      labels_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_browser_commands_status_priority
    ON browser_commands (status, priority DESC, requested_at ASC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_browser_commands_entity
    ON browser_commands (entity_id, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_command_projection_events (
      event_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function closeDatabase(db) {
  if (db && typeof db.close === 'function') {
    db.close();
  }
}

function normalizeCommandRow(row) {
  if (!row) {
    return null;
  }
  return {
    command_id: row.command_id,
    command_type: row.command_type,
    entity_id: row.entity_id,
    status: row.status,
    priority: row.priority,
    requested_at: row.requested_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    claimed_by: row.claimed_by,
    claim_id: row.claim_id || '',
    source_id: row.source_id,
    actor: row.actor,
    labels: parseJson(row.labels_json, []),
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, {}),
    error: row.error,
  };
}

function getCentralBrowserCommand(db, commandId) {
  ensureCentralWorkerCommandSchema(db);
  return normalizeCommandRow(db.prepare(`
    SELECT *
    FROM browser_commands
    WHERE command_id = ?
  `).get(String(commandId)));
}

function appendCentralBrowserCommand(db, command) {
  ensureCentralWorkerCommandSchema(db);
  const commandId = String(command.commandId || command.command_id || '').trim();
  const commandType = String(command.commandType || command.command_type || '').trim();
  if (!commandId) {
    throw new Error('appendCentralBrowserCommand requires commandId');
  }
  if (!commandType) {
    throw new Error('appendCentralBrowserCommand requires commandType');
  }
  const requestedAt = command.requestedAt || command.requested_at || nowIso();
  const labels = normalizeLabels(command.labels || command.label || []);
  const payload = command.payload || command.payloadJson || {};

  db.prepare(`
    INSERT INTO browser_commands (
      command_id,
      command_type,
      entity_id,
      status,
      priority,
      requested_at,
      updated_at,
      source_id,
      actor,
      labels_json,
      payload_json
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    commandId,
    commandType,
    String(command.entityId || command.entity_id || payload.listingId || payload.listing_id || '').trim(),
    Number.isFinite(command.priority) ? command.priority : 0,
    requestedAt,
    requestedAt,
    String(command.sourceId || command.source_id || '').trim(),
    String(command.actor || '').trim(),
    serializeJson(labels),
    serializeJson(payload),
  );

  return getCentralBrowserCommand(db, commandId);
}

function listCentralBrowserCommands(db, options = {}) {
  ensureCentralWorkerCommandSchema(db);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 100;
  const status = String(options.status || '').trim();
  if (status) {
    return db.prepare(`
      SELECT *
      FROM browser_commands
      WHERE status = ?
      ORDER BY priority DESC, requested_at ASC, command_id ASC
      LIMIT ?
    `).all(status, limit).map(normalizeCommandRow);
  }

  return db.prepare(`
    SELECT *
    FROM browser_commands
    ORDER BY requested_at ASC, command_id ASC
    LIMIT ?
  `).all(limit).map(normalizeCommandRow);
}

function claimNextBrowserCommand(centralDb, localDb, options = {}) {
  ensureCentralWorkerCommandSchema(centralDb);
  const workerId = String(options.workerId || options.worker_id || '').trim();
  if (!workerId) {
    throw new Error('claimNextBrowserCommand requires workerId');
  }
  const claimedAt = options.claimedAt || options.claimed_at || nowIso();
  let claimed = null;

  centralDb.exec('BEGIN IMMEDIATE');
  try {
    const candidate = centralDb.prepare(`
      SELECT *
      FROM browser_commands
      WHERE status = 'queued'
      ORDER BY priority DESC, requested_at ASC, command_id ASC
      LIMIT 1
    `).get();

    if (!candidate) {
      centralDb.exec('COMMIT');
      return null;
    }

    const claimId = buildClaimId(candidate.command_id, workerId, claimedAt);
    centralDb.prepare(`
      UPDATE browser_commands
      SET status = 'claimed',
        claimed_at = ?,
        claimed_by = ?,
        claim_id = ?,
        updated_at = ?
      WHERE command_id = ?
        AND status = 'queued'
    `).run(claimedAt, workerId, claimId, claimedAt, candidate.command_id);
    claimed = getCentralBrowserCommand(centralDb, candidate.command_id);
    centralDb.exec('COMMIT');
  } catch (error) {
    centralDb.exec('ROLLBACK');
    throw error;
  }

  if (localDb && claimed) {
    const testEvent = claimed.labels.includes('test_event') || claimed.payload.testEvent === true;
    setWorkerState(localDb, 'activeCommand', {
      commandId: claimed.command_id,
      claimId: claimed.claim_id,
      commandType: claimed.command_type,
      entityId: claimed.entity_id,
      workerId,
      status: claimed.status,
      claimedAt,
      payload: claimed.payload,
      testEvent,
    }, {
      updatedAt: claimedAt,
    });
    appendWorkerOutboxEvent(localDb, {
      eventId: `${claimed.command_id}-${claimed.claim_id}-claimed-${workerId}`,
      eventType: 'browser_command_claimed',
      eventAt: claimedAt,
      workerId,
      sourceId: claimed.source_id,
      labels: claimed.labels,
      payload: {
        commandId: claimed.command_id,
        claimId: claimed.claim_id,
        commandType: claimed.command_type,
        entityId: claimed.entity_id,
        status: claimed.status,
        testEvent,
      },
    });
  }

  return claimed;
}

function applyWorkerEventsToCommandProjection(db, options = {}) {
  ensureCentralWorkerEventSchema(db);
  ensureCentralWorkerCommandSchema(db);
  const appliedAt = options.appliedAt || nowIso();
  const rows = db.prepare(`
    SELECT e.*
    FROM worker_event_log e
    LEFT JOIN browser_command_projection_events p
      ON p.event_id = e.event_id
    WHERE p.event_id IS NULL
      AND e.event_type IN ('browser_command_succeeded', 'browser_command_failed')
    ORDER BY e.event_at ASC, e.event_id ASC
  `).all();
  const summary = {
    scanned: rows.length,
    applied: 0,
    skipped: 0,
    commandIds: [],
  };

  if (rows.length === 0) {
    return summary;
  }

  const updateCommand = db.prepare(`
    UPDATE browser_commands
    SET status = ?,
      updated_at = ?,
      result_json = ?,
      error = ?
    WHERE command_id = ?
  `);
  const markApplied = db.prepare(`
    INSERT INTO browser_command_projection_events (
      event_id,
      command_id,
      applied_at
    ) VALUES (?, ?, ?)
  `);
  const getCommand = db.prepare('SELECT * FROM browser_commands WHERE command_id = ?');

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const payload = parseJson(row.payload_json, {});
      const commandId = String(payload.commandId || payload.command_id || '').trim();
      const command = commandId ? getCommand.get(commandId) : null;
      if (!command) {
        summary.skipped += 1;
        markApplied.run(row.event_id, commandId || '', appliedAt);
        continue;
      }
      const eventClaimId = String(payload.claimId || payload.claim_id || '').trim();
      const currentClaimId = String(command.claim_id || '').trim();
      if (!eventClaimId || !currentClaimId || eventClaimId !== currentClaimId) {
        summary.skipped += 1;
        markApplied.run(row.event_id, commandId, appliedAt);
        continue;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(String(command.status || ''))) {
        summary.skipped += 1;
        markApplied.run(row.event_id, commandId, appliedAt);
        continue;
      }

      const testEvent = parseJson(row.labels_json, []).includes('test_event') || payload.testEvent === true;
      const nextStatus = row.event_type === 'browser_command_succeeded' ? 'succeeded' : 'failed';
      const result = {
        ...(payload.result && typeof payload.result === 'object' ? payload.result : {}),
        testEvent,
      };
      const error = row.event_type === 'browser_command_failed'
        ? String(payload.error || row.error || '').trim()
        : '';
      updateCommand.run(
        nextStatus,
        row.event_at,
        serializeJson(result),
        error,
        commandId,
      );
      markApplied.run(row.event_id, commandId, appliedAt);
      summary.applied += 1;
      summary.commandIds.push(commandId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return summary;
}

function requeueStaleBrowserCommands(db, options = {}) {
  ensureCentralWorkerCommandSchema(db);
  const staleBefore = options.staleBefore || options.stale_before || nowIso();
  const requeuedAt = options.requeuedAt || options.requeued_at || nowIso();
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 100;
  const rows = db.prepare(`
    SELECT command_id, claimed_by
    FROM browser_commands
    WHERE status = 'claimed'
      AND claimed_at != ''
      AND claimed_at < ?
    ORDER BY claimed_at ASC, command_id ASC
    LIMIT ?
  `).all(staleBefore, limit);
  const summary = {
    scanned: rows.length,
    requeued: 0,
    commandIds: [],
  };

  if (rows.length === 0) {
    return summary;
  }

  const update = db.prepare(`
    UPDATE browser_commands
    SET status = 'queued',
      updated_at = ?,
      claimed_at = '',
      claimed_by = '',
      claim_id = '',
      error = ?
    WHERE command_id = ?
      AND status = 'claimed'
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const result = update.run(
        requeuedAt,
        `requeued stale claim from ${row.claimed_by || 'unknown'}`,
        row.command_id,
      );
      if (result.changes > 0) {
        summary.requeued += 1;
        summary.commandIds.push(row.command_id);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return summary;
}

async function runWorkerCommandOnce(centralDb, localDb, options = {}) {
  const workerId = String(options.workerId || options.worker_id || '').trim();
  if (!workerId) {
    throw new Error('runWorkerCommandOnce requires workerId');
  }
  if (typeof options.handler !== 'function') {
    throw new Error('runWorkerCommandOnce requires handler');
  }
  const startedAt = options.now || options.startedAt || nowIso();
  const claimed = claimNextBrowserCommand(centralDb, localDb, {
    workerId,
    claimedAt: startedAt,
  });
  if (!claimed) {
    return {
      claimed: null,
      status: 'idle',
      flush: flushWorkerOutboxToCentral(localDb, centralDb),
      projection: applyWorkerEventsToCommandProjection(centralDb),
    };
  }

  const testEvent = claimed.labels.includes('test_event') || claimed.payload.testEvent === true;
  const labels = claimed.labels;
  appendWorkerOutboxEvent(localDb, {
    eventId: `${claimed.command_id}-${claimed.claim_id}-started-${workerId}`,
    eventType: 'browser_command_started',
    eventAt: startedAt,
    workerId,
    sourceId: claimed.source_id,
    labels,
      payload: {
        commandId: claimed.command_id,
        claimId: claimed.claim_id,
        commandType: claimed.command_type,
      entityId: claimed.entity_id,
      testEvent,
    },
  });

  let status = 'succeeded';
  try {
    const handlerResult = await options.handler(claimed);
    const completedAt = options.completedAt || nowIso();
    appendWorkerOutboxEvent(localDb, {
      eventId: `${claimed.command_id}-${claimed.claim_id}-succeeded-${workerId}`,
      eventType: 'browser_command_succeeded',
      eventAt: completedAt,
      workerId,
      sourceId: claimed.source_id,
      labels,
      payload: {
        commandId: claimed.command_id,
        claimId: claimed.claim_id,
        result: handlerResult || {},
        testEvent,
      },
    });
  } catch (error) {
    status = 'failed';
    const failedAt = options.failedAt || nowIso();
    appendWorkerOutboxEvent(localDb, {
      eventId: `${claimed.command_id}-${claimed.claim_id}-failed-${workerId}`,
      eventType: 'browser_command_failed',
      eventAt: failedAt,
      workerId,
      sourceId: claimed.source_id,
      labels,
      payload: {
        commandId: claimed.command_id,
        claimId: claimed.claim_id,
        error: error instanceof Error ? error.message : String(error),
        testEvent,
      },
    });
  }

  const flush = flushWorkerOutboxToCentral(localDb, centralDb, options.flush || {});
  const projection = applyWorkerEventsToCommandProjection(centralDb, options.projection || {});
  return {
    claimed,
    status,
    flush,
    projection,
  };
}

function setWorkerState(db, key, value, options = {}) {
  const updatedAt = options.updatedAt || nowIso();
  db.prepare(`
    INSERT INTO worker_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(String(key), serializeJson(value), updatedAt);
  return getWorkerState(db, key);
}

function getWorkerState(db, key) {
  const row = db.prepare('SELECT * FROM worker_state WHERE key = ?').get(String(key));
  if (!row) {
    return null;
  }
  return {
    key: row.key,
    value: parseJson(row.value_json, {}),
    updated_at: row.updated_at,
  };
}

function normalizeOutboxRow(row) {
  if (!row) {
    return null;
  }
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    event_at: row.event_at,
    worker_id: row.worker_id,
    source_id: row.source_id,
    status: row.status,
    labels: parseJson(row.labels_json, []),
    payload: parseJson(row.payload_json, {}),
    local_created_at: row.local_created_at,
    flushed_at: row.flushed_at,
    flush_attempts: row.flush_attempts,
    last_error: row.last_error,
  };
}

function appendWorkerOutboxEvent(db, event) {
  const eventType = String(event.eventType || event.event_type || '').trim();
  const workerId = String(event.workerId || event.worker_id || '').trim();
  if (!eventType) {
    throw new Error('appendWorkerOutboxEvent requires eventType');
  }
  if (!workerId) {
    throw new Error('appendWorkerOutboxEvent requires workerId');
  }

  const eventAt = event.eventAt || event.event_at || nowIso();
  const eventId = String(event.eventId || event.event_id || buildEventId(eventAt, workerId, eventType));
  const labels = normalizeLabels(event.labels || event.label || []);
  const payload = event.payload || event.payloadJson || {};
  const localCreatedAt = event.localCreatedAt || event.local_created_at || nowIso();

  db.prepare(`
    INSERT INTO worker_outbox_events (
      event_id,
      event_type,
      event_at,
      worker_id,
      source_id,
      status,
      labels_json,
      payload_json,
      local_created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    eventId,
    eventType,
    eventAt,
    workerId,
    String(event.sourceId || event.source_id || '').trim(),
    serializeJson(labels),
    serializeJson(payload),
    localCreatedAt,
  );

  return getOutboxEvent(db, eventId);
}

function getOutboxEvent(db, eventId) {
  return normalizeOutboxRow(db.prepare(`
    SELECT *
    FROM worker_outbox_events
    WHERE event_id = ?
  `).get(String(eventId)));
}

function listWorkerOutboxEvents(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 100;
  const status = String(options.status || '').trim();
  if (status) {
    return db.prepare(`
      SELECT *
      FROM worker_outbox_events
      WHERE status = ?
      ORDER BY event_at ASC, event_id ASC
      LIMIT ?
    `).all(status, limit).map(normalizeOutboxRow);
  }

  return db.prepare(`
    SELECT *
    FROM worker_outbox_events
    ORDER BY event_at ASC, event_id ASC
    LIMIT ?
  `).all(limit).map(normalizeOutboxRow);
}

function markOutboxEventFlushed(db, eventId, flushedAt) {
  db.prepare(`
    UPDATE worker_outbox_events
    SET status = 'flushed',
      flushed_at = ?,
      flush_attempts = flush_attempts + 1,
      last_error = ''
    WHERE event_id = ?
  `).run(flushedAt, String(eventId));
}

function markOutboxEventFlushFailed(db, eventId, error) {
  db.prepare(`
    UPDATE worker_outbox_events
    SET flush_attempts = flush_attempts + 1,
      last_error = ?
    WHERE event_id = ?
  `).run(error instanceof Error ? error.message : String(error || 'flush failed'), String(eventId));
}

function flushWorkerOutboxToCentral(localDb, centralDb, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 100;
  const pending = listWorkerOutboxEvents(localDb, { status: 'pending', limit });
  const flushedAt = options.flushedAt || nowIso();
  const summary = {
    scanned: pending.length,
    inserted: 0,
    existing: 0,
    failed: 0,
    eventIds: [],
  };

  if (pending.length === 0) {
    return summary;
  }

  ensureCentralWorkerEventSchema(centralDb);
  const insert = centralDb.prepare(`
    INSERT OR IGNORE INTO worker_event_log (
      event_id,
      event_type,
      event_at,
      worker_id,
      source_id,
      labels_json,
      payload_json,
      ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  centralDb.exec('BEGIN IMMEDIATE');
  try {
    for (const event of pending) {
      const result = insert.run(
        event.event_id,
        event.event_type,
        event.event_at,
        event.worker_id,
        event.source_id,
        serializeJson(event.labels),
        serializeJson(event.payload),
        flushedAt,
      );
      if (result.changes > 0) {
        summary.inserted += 1;
      } else {
        summary.existing += 1;
      }
      summary.eventIds.push(event.event_id);
    }
    centralDb.exec('COMMIT');
  } catch (error) {
    centralDb.exec('ROLLBACK');
    for (const event of pending) {
      markOutboxEventFlushFailed(localDb, event.event_id, error);
    }
    summary.failed = pending.length;
    throw error;
  }

  localDb.exec('BEGIN IMMEDIATE');
  try {
    for (const eventId of summary.eventIds) {
      markOutboxEventFlushed(localDb, eventId, flushedAt);
    }
    localDb.exec('COMMIT');
  } catch (error) {
    localDb.exec('ROLLBACK');
    throw error;
  }

  return summary;
}

function listCentralWorkerEvents(db, options = {}) {
  ensureCentralWorkerEventSchema(db);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 100;
  return db.prepare(`
    SELECT *
    FROM worker_event_log
    ORDER BY event_at ASC, event_id ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    event_id: row.event_id,
    event_type: row.event_type,
    event_at: row.event_at,
    worker_id: row.worker_id,
    source_id: row.source_id,
    labels: parseJson(row.labels_json, []),
    payload: parseJson(row.payload_json, {}),
    ingested_at: row.ingested_at,
  }));
}

module.exports = {
  openWorkerLocalStore,
  closeDatabase,
  ensureWorkerLocalSchema,
  ensureCentralWorkerEventSchema,
  ensureCentralWorkerCommandSchema,
  setWorkerState,
  getWorkerState,
  appendCentralBrowserCommand,
  getCentralBrowserCommand,
  listCentralBrowserCommands,
  claimNextBrowserCommand,
  applyWorkerEventsToCommandProjection,
  requeueStaleBrowserCommands,
  runWorkerCommandOnce,
  appendWorkerOutboxEvent,
  getOutboxEvent,
  listWorkerOutboxEvents,
  flushWorkerOutboxToCentral,
  listCentralWorkerEvents,
};
