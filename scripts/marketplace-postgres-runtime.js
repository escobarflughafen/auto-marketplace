const { createMarketplaceConfigPostgresStore } = require('./marketplace-config-postgres-store');
const { createMarketplaceEventRegistryPostgresStore } = require('./marketplace-event-registry-postgres-store');
const { createMarketplaceHomepageListingsPostgresStore } = require('./marketplace-homepage-listings-postgres-store');
const { createMarketplaceMaintenancePostgresStore } = require('./marketplace-maintenance-postgres-store');
const { createMarketplacePurchaseHistoryPostgresStore } = require('./marketplace-purchase-history-postgres-store');
const { createMarketplaceResolveQueuePostgresStore } = require('./marketplace-resolve-queue-postgres-store');
const { createMarketplaceSearchKeywordsPostgresStore } = require('./marketplace-search-keywords-postgres-store');
const { createMarketplaceWorkerEventsPostgresStore } = require('./marketplace-worker-events-postgres-store');
const { createMarketplaceWorkflowEventsPostgresStore } = require('./marketplace-workflow-events-postgres-store');
const { createMarketplaceWorkflowPostgresStore } = require('./marketplace-workflow-postgres-store');

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL runtime requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function normalizeMarketplaceDbDialect(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_-]+/g, '_');
  if (['postgres', 'postgresql', 'pg'].includes(normalized)) return 'postgres';
  if (['', 'sqlite', 'sqlite3', 'local'].includes(normalized)) return 'sqlite';
  throw new Error(`Unsupported marketplace DB dialect: ${value}`);
}

function resolveMarketplacePostgresConnectionString(options = {}) {
  return options.connectionString
    || options.postgresUrl
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
}

function createPool(options = {}) {
  if (options.pool) return { pool: options.pool, ownsPool: false };
  const connectionString = resolveMarketplacePostgresConnectionString(options);
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_POSTGRES_URL, DATABASE_URL, or pass connectionString.');
    error.code = 'missing_postgres_connection_string';
    throw error;
  }
  const Pool = requirePgPool();
  return {
    pool: new Pool({ connectionString }),
    ownsPool: true,
  };
}

function openMarketplacePostgresDatabase(options = {}) {
  const { pool, ownsPool } = createPool(options);
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();
  const sharedOptions = { pool, nowIso };
  const resolveQueue = createMarketplaceResolveQueuePostgresStore(sharedOptions);

  return {
    dialect: 'postgres',
    dbPath: 'postgres',
    pool,
    ownsPool,
    stores: {
      config: createMarketplaceConfigPostgresStore(sharedOptions),
      eventRegistry: createMarketplaceEventRegistryPostgresStore(sharedOptions),
      listings: createMarketplaceHomepageListingsPostgresStore(sharedOptions),
      maintenance: createMarketplaceMaintenancePostgresStore(sharedOptions),
      purchaseHistory: createMarketplacePurchaseHistoryPostgresStore({ ...sharedOptions, resolveQueueStore: resolveQueue }),
      resolveQueue,
      searchKeywords: createMarketplaceSearchKeywordsPostgresStore(sharedOptions),
      workerEvents: createMarketplaceWorkerEventsPostgresStore(sharedOptions),
      workflowEvents: createMarketplaceWorkflowEventsPostgresStore(sharedOptions),
      workflow: createMarketplaceWorkflowPostgresStore(sharedOptions),
    },
  };
}

function isMarketplacePostgresRuntime(db) {
  return Boolean(db && db.dialect === 'postgres' && db.pool);
}

async function closeMarketplacePostgresDatabase(db) {
  if (!isMarketplacePostgresRuntime(db)) return;
  if (db.ownsPool !== false && typeof db.pool.end === 'function') {
    await db.pool.end();
  }
}

async function runPostgresTransaction(db, callback) {
  const runtime = isMarketplacePostgresRuntime(db) ? db : { pool: db };
  const pool = runtime.pool;
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('PostgreSQL transaction requires a pool with connect().');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

module.exports = {
  normalizeMarketplaceDbDialect,
  resolveMarketplacePostgresConnectionString,
  openMarketplacePostgresDatabase,
  closeMarketplacePostgresDatabase,
  runPostgresTransaction,
  isMarketplacePostgresRuntime,
};
