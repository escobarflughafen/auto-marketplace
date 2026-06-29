const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  exportPostgresMigration,
  copyTextValue,
} = require('../scripts/export-marketplace-postgres-migration');

test('postgres migration exporter emits schema, copy data, and verification artifacts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-migration-export-'));
  const sqliteDb = path.join(tempDir, 'source.db');
  const outputDir = path.join(tempDir, 'out');
  const db = new DatabaseSync(sqliteDb);
  try {
    db.exec(`
      CREATE TABLE sample_items (
        item_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX idx_sample_items_title ON sample_items (title);
    `);
    db.prepare('INSERT INTO sample_items (item_id, title, attempt, note, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run('item-1', 'Leica\tM6', 2, 'line one\nline two\\tail', JSON.stringify({ ok: true }));
    db.prepare('INSERT INTO sample_items (item_id, title, attempt, note, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run('item-2', 'Nikon', 0, null, '{}');
  } finally {
    db.close();
  }

  const manifest = await exportPostgresMigration({
    sqliteDb,
    outputDir,
    tables: ['sample_items'],
    schemaOnly: false,
    dataOnly: false,
    dropExisting: true,
    batchSize: 1,
    json: true,
  });

  assert.equal(manifest.tables.length, 1);
  assert.equal(manifest.tables[0].rowCount, 2);
  assert.equal(manifest.tables[0].writtenRows, 2);

  const schemaSql = fs.readFileSync(path.join(outputDir, '001_schema.sql'), 'utf8');
  assert.match(schemaSql, /DROP TABLE IF EXISTS "sample_items" CASCADE/);
  assert.match(schemaSql, /"item_id" TEXT NOT NULL PRIMARY KEY/);
  assert.match(schemaSql, /"attempt" BIGINT NOT NULL DEFAULT 0/);
  assert.match(schemaSql, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_sample_items_title"/);

  const loadSql = fs.readFileSync(path.join(outputDir, '002_load.sql'), 'utf8');
  assert.match(loadSql, /\\copy "sample_items"/);
  assert.match(loadSql, /:DATA_DIR\/sample_items.tsv/);

  const data = fs.readFileSync(path.join(outputDir, 'data', 'sample_items.tsv'), 'utf8');
  assert.match(data, /Leica\\tM6/);
  assert.match(data, /line one\\nline two\\\\tail/);
  assert.match(data, /\t\\N\t/);

  const verifySql = fs.readFileSync(path.join(outputDir, '003_verify.sql'), 'utf8');
  assert.match(verifySql, /expected_count/);
  assert.match(verifySql, /WHEN 'sample_items' THEN \(SELECT COUNT\(\*\) FROM "sample_items"\)/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('postgres copy text escaping preserves null marker separately from strings', () => {
  assert.equal(copyTextValue(null), '\\N');
  assert.equal(copyTextValue('\\N'), '\\\\N');
  assert.equal(copyTextValue('a\tb\nc\rd\\e'), 'a\\tb\\nc\\rd\\\\e');
});
