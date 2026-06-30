const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceMaintenancePostgresStore,
  integerValue,
} = require('../scripts/marketplace-maintenance-postgres-store');

function createFakePool(handler) {
  const calls = [];
  return {
    calls,
    ended: false,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const response = handler(sql, params, calls.length);
      if (response && !Array.isArray(response) && (Object.prototype.hasOwnProperty.call(response, 'rows') || Object.prototype.hasOwnProperty.call(response, 'rowCount'))) {
        return { rows: response.rows || [], rowCount: response.rowCount || 0 };
      }
      return { rows: response || [], rowCount: Array.isArray(response) ? response.length : 0 };
    },
    async end() { this.ended = true; },
  };
}

test('normalizes integer values for PostgreSQL maintenance reports', () => {
  assert.equal(integerValue('42'), 42);
  assert.equal(integerValue('nope', 7), 7);
});

test('builds PostgreSQL maintenance report with row counts and database size', async () => {
  const pool = createFakePool((sql) => {
    if (/pg_database_size/.test(sql)) return [{ database_name: 'marketplace', database_bytes: '4096' }];
    if (/FROM homepage_listings/.test(sql)) return [{ count: '10' }];
    if (/FROM listing_events/.test(sql)) return [{ count: '20' }];
    if (/FROM workflow_runs/.test(sql)) return [{ count: '3' }];
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceMaintenancePostgresStore({ pool });
  const report = await store.getDatabaseMaintenanceReport();
  assert.equal(report.dbPath, 'postgres:marketplace');
  assert.equal(report.files.dbBytes, 4096);
  assert.deepEqual(report.rows, { homepageListings: 10, listingEvents: 20, workflowRuns: 3 });
});

test('runs PostgreSQL maintenance with analyze, checkpoint note, optional vacuum, and closes pool', async () => {
  const pool = createFakePool((sql) => {
    if (/pg_database_size/.test(sql)) return [{ database_name: 'marketplace', database_bytes: '4096' }];
    if (/FROM homepage_listings/.test(sql)) return [{ count: '10' }];
    if (/FROM listing_events/.test(sql)) return [{ count: '20' }];
    if (/FROM workflow_runs/.test(sql)) return [{ count: '3' }];
    if (sql === 'ANALYZE' || sql === 'VACUUM') return [];
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceMaintenancePostgresStore({ pool, nowIso: () => '2026-05-01T00:00:00.000Z' });
  const result = await store.runDatabaseMaintenance({ optimize: true, checkpoint: true, vacuum: true });
  await store.close();
  assert.deepEqual(result.actions, ['analyze', { checkpoint: 'postgres_not_applicable' }, 'vacuum']);
  assert.equal(result.before.rows.homepageListings, 10);
  assert.equal(result.after.rows.workflowRuns, 3);
  assert.equal(pool.ended, true);
});
