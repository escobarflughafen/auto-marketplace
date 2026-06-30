const test = require('node:test');
const assert = require('node:assert/strict');

const {
  closeMarketplacePostgresDatabase,
  isMarketplacePostgresRuntime,
  normalizeMarketplaceDbDialect,
  openMarketplacePostgresDatabase,
  runPostgresTransaction,
} = require('../scripts/marketplace-postgres-runtime');
const {
  closeMarketplaceHomepageDatabase,
  openMarketplaceHomepageDatabase,
  runTransaction,
} = require('../scripts/marketplace-homepage-db');

function createFakePool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    calls,
    ended: false,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    async connect() {
      calls.push({ sql: 'CONNECT', params: [] });
      return client;
    },
    async end() {
      this.ended = true;
      calls.push({ sql: 'END', params: [] });
    },
  };
}

test('normalizeMarketplaceDbDialect accepts PostgreSQL aliases and SQLite defaults', () => {
  assert.equal(normalizeMarketplaceDbDialect('postgresql'), 'postgres');
  assert.equal(normalizeMarketplaceDbDialect('pg'), 'postgres');
  assert.equal(normalizeMarketplaceDbDialect(''), 'sqlite');
  assert.throws(() => normalizeMarketplaceDbDialect('mysql'), /Unsupported marketplace DB dialect/);
});

test('openMarketplacePostgresDatabase creates a shared runtime over injected pool', async () => {
  const pool = createFakePool();
  const db = openMarketplacePostgresDatabase({ pool });

  assert.equal(db.dialect, 'postgres');
  assert.equal(db.pool, pool);
  assert.equal(db.ownsPool, false);
  assert.equal(isMarketplacePostgresRuntime(db), true);
  assert.equal(db.stores.listings.dialect, 'postgres');
  assert.equal(db.stores.purchaseHistory.dialect, 'postgres');
  await closeMarketplacePostgresDatabase(db);
  assert.equal(pool.ended, false);
});

test('homepage DB lifecycle can explicitly open and close PostgreSQL runtime', async () => {
  const pool = createFakePool();
  const { db, dbPath, dialect } = openMarketplaceHomepageDatabase({ dialect: 'postgres', pool });

  assert.equal(dialect, 'postgres');
  assert.equal(dbPath, 'postgres');
  assert.equal(isMarketplacePostgresRuntime(db), true);
  await closeMarketplaceHomepageDatabase(db);
  assert.equal(pool.ended, false);
});

test('runPostgresTransaction commits, rolls back, and releases clients', async () => {
  const pool = createFakePool();
  const db = openMarketplacePostgresDatabase({ pool });

  const result = await runPostgresTransaction(db, async (client) => {
    await client.query('SELECT $1::int AS value', [3]);
    return 3;
  });
  assert.equal(result, 3);
  assert.deepEqual(pool.calls.map((call) => call.sql), ['CONNECT', 'BEGIN', 'SELECT $1::int AS value', 'COMMIT', 'RELEASE']);

  pool.calls.length = 0;
  await assert.rejects(
    () => runTransaction(db, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(pool.calls.map((call) => call.sql), ['CONNECT', 'BEGIN', 'ROLLBACK', 'RELEASE']);
});
