function integerValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL maintenance store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_MAINTENANCE_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_MAINTENANCE_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
    error.code = 'missing_postgres_connection_string';
    throw error;
  }
  const Pool = requirePgPool();
  return new Pool({ connectionString });
}

async function queryRows(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows || [];
}

async function queryOne(pool, sql, params = []) {
  const rows = await queryRows(pool, sql, params);
  return rows[0] || null;
}

async function countRows(pool, tableName) {
  const row = await queryOne(pool, `SELECT COUNT(*)::BIGINT AS count FROM ${tableName}`);
  return integerValue(row && row.count, 0);
}

function createMarketplaceMaintenancePostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async getDatabaseMaintenanceReport() {
      const sizeRow = await queryOne(pool, 'SELECT current_database() AS database_name, pg_database_size(current_database())::BIGINT AS database_bytes');
      const listingRows = await countRows(pool, 'homepage_listings');
      const eventRows = await countRows(pool, 'listing_events');
      const workflowRows = await countRows(pool, 'workflow_runs');
      const databaseBytes = integerValue(sizeRow && sizeRow.database_bytes, 0);
      return {
        dbPath: sizeRow && sizeRow.database_name ? `postgres:${sizeRow.database_name}` : 'postgres',
        journalMode: 'postgres',
        pageCount: 0,
        pageSize: 0,
        freelistCount: 0,
        estimatedDbBytes: databaseBytes,
        files: {
          dbBytes: databaseBytes,
          walBytes: 0,
          shmBytes: 0,
        },
        rows: {
          homepageListings: listingRows,
          listingEvents: eventRows,
          workflowRuns: workflowRows,
        },
      };
    },

    async runDatabaseMaintenance(options = {}) {
      const startedAt = nowIso();
      const before = await this.getDatabaseMaintenanceReport();
      const actions = [];

      if (options.optimize !== false || options.analyze) {
        await pool.query('ANALYZE');
        actions.push('analyze');
      }

      if (options.checkpoint !== false) {
        actions.push({ checkpoint: 'postgres_not_applicable' });
      }

      if (options.vacuum) {
        await pool.query('VACUUM');
        actions.push('vacuum');
      }

      return {
        startedAt,
        completedAt: nowIso(),
        actions,
        before,
        after: await this.getDatabaseMaintenanceReport(),
      };
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceMaintenancePostgresStore,
  integerValue,
};
