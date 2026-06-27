const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
} = require('../scripts/marketplace-homepage-db');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-db-migration-'));
  return {
    tempDir,
    dbPath: path.join(tempDir, 'marketplace.db'),
  };
}

function columnNames(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

test('remote worker schema migrates older staging tables before creating indexes', () => {
  const { tempDir, dbPath } = createTempDbPath();
  const seedDb = new DatabaseSync(dbPath);
  try {
    seedDb.exec(`
      CREATE TABLE remote_worker_sessions (
        session_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL
      );
      CREATE TABLE remote_worker_event_ingest (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
      CREATE TABLE remote_worker_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
      CREATE TABLE remote_worker_commands (
        command_id TEXT PRIMARY KEY
      );
      CREATE TABLE remote_worker_claims (
        claim_id TEXT PRIMARY KEY
      );
    `);
  } finally {
    seedDb.close();
  }

  let db;
  try {
    ({ db } = openMarketplaceHomepageDatabase(dbPath));
    const sessionColumns = columnNames(db, 'remote_worker_sessions');
    assert.equal(sessionColumns.has('last_seen_at'), true);
    assert.equal(sessionColumns.has('pending_event_count'), true);

    const artifactColumns = columnNames(db, 'remote_worker_artifacts');
    assert.equal(artifactColumns.has('event_id'), true);
    assert.equal(artifactColumns.has('media_role'), true);
    assert.equal(artifactColumns.has('received_at'), true);

    const commandColumns = columnNames(db, 'remote_worker_commands');
    assert.equal(commandColumns.has('worker_id'), true);
    assert.equal(commandColumns.has('created_at'), true);

    const claimColumns = columnNames(db, 'remote_worker_claims');
    assert.equal(claimColumns.has('lease_id'), true);
    assert.equal(claimColumns.has('expires_at'), true);

    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_remote_worker_sessions_worker_seen',
        'idx_remote_worker_artifacts_event',
        'idx_remote_worker_commands_worker_status',
        'idx_remote_worker_claims_lease'
      )
    `).all();
    assert.equal(indexes.length, 4);
  } finally {
    if (db) closeMarketplaceHomepageDatabase(db);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
