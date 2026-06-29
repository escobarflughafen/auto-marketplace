const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function serializeJson(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function ensureRemoteWorkerLocalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_outbox_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      worker_id TEXT NOT NULL,
      worker_type TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT '',
      sequence INTEGER NOT NULL,
      event_scope TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      listing_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      sync_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      acked_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_worker_outbox_pending_sequence
    ON worker_outbox_events (sync_status, sequence);

    CREATE TABLE IF NOT EXISTS worker_commands (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'received',
      received_at TEXT NOT NULL,
      acked_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS worker_artifact_spool (
      artifact_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL DEFAULT '',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      acked_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT ''
    );
  `);
  ensureColumn(db, 'worker_commands', 'ack_status', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'worker_commands', 'ack_payload_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'worker_commands', 'last_error', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'worker_commands', 'ack_error', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'worker_commands', 'completed_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'worker_artifact_spool', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'worker_artifact_spool', 'last_error', "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_artifact_spool_pending
    ON worker_artifact_spool (sync_status, created_at);

    CREATE INDEX IF NOT EXISTS idx_worker_commands_pending_ack
    ON worker_commands (acked_at, completed_at);
  `);
}

function listColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function ensureColumn(db, tableName, columnName, definition) {
  if (listColumns(db, tableName).has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function openRemoteWorkerLocalStore(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  ensureParentDir(resolvedPath);
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL');
  ensureRemoteWorkerLocalSchema(db);
  return {
    db,
    dbPath: resolvedPath,
  };
}

function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM worker_state WHERE key = ?').get(String(key));
  return row ? parseJson(row.value_json, fallback) : fallback;
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO worker_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(String(key), serializeJson(value), new Date().toISOString());
}

function nextSequence(db) {
  const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS nextSequence FROM worker_outbox_events').get();
  return row.nextSequence;
}

function appendOutboxEvent(db, event) {
  const now = new Date().toISOString();
  const sequence = Number.isInteger(event.sequence) ? event.sequence : nextSequence(db);
  db.prepare(`
    INSERT INTO worker_outbox_events (
      event_id,
      session_id,
      worker_id,
      worker_type,
      strategy,
      sequence,
      event_scope,
      event_type,
      event_at,
      listing_id,
      status,
      payload_json,
      sync_status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    String(event.eventId),
    String(event.sessionId || ''),
    String(event.workerId),
    String(event.workerType),
    String(event.strategy || ''),
    sequence,
    String(event.eventScope),
    String(event.eventType),
    event.eventAt || now,
    String(event.listingId || ''),
    String(event.status || ''),
    serializeJson(event.payload || {}),
    now,
  );
  return {
    ...event,
    sequence,
  };
}

function listPendingOutboxEvents(db, options = {}) {
  const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 500));
  return db.prepare(`
    SELECT *
    FROM worker_outbox_events
    WHERE sync_status = 'pending'
    ORDER BY sequence ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    eventId: row.event_id,
    sessionId: row.session_id,
    workerId: row.worker_id,
    workerType: row.worker_type,
    strategy: row.strategy,
    sequence: row.sequence,
    eventScope: row.event_scope,
    eventType: row.event_type,
    eventAt: row.event_at,
    listingId: row.listing_id,
    status: row.status,
    payload: parseJson(row.payload_json, {}),
  }));
}

function markOutboxEventsAcked(db, eventIds = []) {
  if (!eventIds.length) return;
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE worker_outbox_events
    SET sync_status = 'acked', acked_at = ?, last_error = ''
    WHERE event_id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const eventId of eventIds) {
      update.run(now, String(eventId));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function markOutboxEventsFailed(db, eventIds = [], error) {
  if (!eventIds.length) return;
  const update = db.prepare(`
    UPDATE worker_outbox_events
    SET last_error = ?
    WHERE event_id = ?
  `);
  const message = String(error?.message || error || '').trim();
  for (const eventId of eventIds) {
    update.run(message, String(eventId));
  }
}

function countPendingOutboxEvents(db) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM worker_outbox_events
    WHERE sync_status = 'pending'
  `).get().count || 0;
}

function appendLocalCommand(db, command) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worker_commands (
      command_id,
      command_type,
      payload_json,
      status,
      received_at
    ) VALUES (?, ?, ?, 'received', ?)
    ON CONFLICT(command_id) DO NOTHING
  `).run(
    String(command.commandId),
    String(command.commandType),
    serializeJson(command.payload || {}),
    now,
  );
}

function getLocalCommand(db, commandId) {
  const row = db.prepare('SELECT * FROM worker_commands WHERE command_id = ?').get(String(commandId));
  if (!row) return null;
  return {
    commandId: row.command_id,
    commandType: row.command_type,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    ackStatus: row.ack_status || '',
    ackPayload: parseJson(row.ack_payload_json, {}),
    lastError: row.last_error || '',
    ackError: row.ack_error || '',
    receivedAt: row.received_at || '',
    completedAt: row.completed_at || '',
    ackedAt: row.acked_at || '',
  };
}

function markLocalCommandAckPending(db, commandId, ack) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE worker_commands
    SET
      status = ?,
      ack_status = ?,
      ack_payload_json = ?,
      last_error = ?,
      completed_at = CASE WHEN completed_at = '' THEN ? ELSE completed_at END
    WHERE command_id = ?
  `).run(
    String(ack.status || 'completed'),
    String(ack.status || 'completed'),
    serializeJson(ack.payload || {}),
    String(ack.error || ''),
    now,
    String(commandId),
  );
}

function listPendingCommandAcks(db, options = {}) {
  const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 25, 100));
  return db.prepare(`
    SELECT *
    FROM worker_commands
    WHERE completed_at != '' AND acked_at = '' AND ack_status != ''
    ORDER BY completed_at ASC, command_id ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    commandId: row.command_id,
    commandType: row.command_type,
    status: row.ack_status,
    payload: parseJson(row.ack_payload_json, {}),
    error: row.last_error || '',
  }));
}

function markLocalCommandAcked(db, commandId) {
  db.prepare(`
    UPDATE worker_commands
    SET acked_at = ?, ack_error = ''
    WHERE command_id = ?
  `).run(new Date().toISOString(), String(commandId));
}

function markLocalCommandAckFailed(db, commandId, error) {
  db.prepare(`
    UPDATE worker_commands
    SET ack_error = ?
    WHERE command_id = ?
  `).run(String(error?.message || error || '').trim(), String(commandId));
}

function appendArtifactManifest(db, manifest) {
  const now = new Date().toISOString();
  const artifactId = String(manifest.artifactId || '').trim();
  if (!artifactId) {
    throw new Error('artifactId is required');
  }
  db.prepare(`
    INSERT INTO worker_artifact_spool (
      artifact_id,
      event_id,
      manifest_json,
      size_bytes,
      sync_status,
      created_at
    ) VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(artifact_id) DO UPDATE SET
      event_id = excluded.event_id,
      manifest_json = excluded.manifest_json,
      size_bytes = excluded.size_bytes,
      sync_status = CASE
        WHEN worker_artifact_spool.sync_status = 'acked' THEN worker_artifact_spool.sync_status
        ELSE 'pending'
      END,
      last_error = ''
  `).run(
    artifactId,
    String(manifest.eventId || ''),
    serializeJson(manifest),
    Number.isFinite(Number(manifest.sizeBytes)) ? Number(manifest.sizeBytes) : 0,
    now,
  );
  return {
    ...manifest,
    artifactId,
  };
}

function listPendingArtifactManifests(db, options = {}) {
  const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 25, 100));
  return db.prepare(`
    SELECT *
    FROM worker_artifact_spool
    WHERE sync_status = 'pending'
    ORDER BY created_at ASC, artifact_id ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    artifactId: row.artifact_id,
    eventId: row.event_id,
    manifest: parseJson(row.manifest_json, {}),
    sizeBytes: Number(row.size_bytes || 0),
  }));
}

function markArtifactsAcked(db, artifactIds = []) {
  if (!artifactIds.length) return;
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE worker_artifact_spool
    SET sync_status = 'acked', acked_at = ?, last_error = ''
    WHERE artifact_id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const artifactId of artifactIds) {
      update.run(now, String(artifactId));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function markArtifactsFailed(db, artifactIds = [], error) {
  if (!artifactIds.length) return;
  const update = db.prepare(`
    UPDATE worker_artifact_spool
    SET last_error = ?
    WHERE artifact_id = ?
  `);
  const message = String(error?.message || error || '').trim();
  for (const artifactId of artifactIds) {
    update.run(message, String(artifactId));
  }
}

function countPendingArtifacts(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM worker_artifact_spool
    WHERE sync_status = 'pending'
  `).get();
  return {
    count: Number(row?.count || 0),
    bytes: Number(row?.bytes || 0),
  };
}

module.exports = {
  openRemoteWorkerLocalStore,
  ensureRemoteWorkerLocalSchema,
  getState,
  setState,
  appendOutboxEvent,
  listPendingOutboxEvents,
  markOutboxEventsAcked,
  markOutboxEventsFailed,
  countPendingOutboxEvents,
  appendLocalCommand,
  getLocalCommand,
  markLocalCommandAckPending,
  listPendingCommandAcks,
  markLocalCommandAcked,
  markLocalCommandAckFailed,
  appendArtifactManifest,
  listPendingArtifactManifests,
  markArtifactsAcked,
  markArtifactsFailed,
  countPendingArtifacts,
};
