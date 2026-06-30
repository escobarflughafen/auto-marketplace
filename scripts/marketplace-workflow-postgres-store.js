function serializeArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthyInteger(value) {
  return value === true || value === 1 || value === '1';
}

function normalizeWorkflowRunRow(row) {
  if (!row) return null;
  return {
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    label: row.label,
    script: row.script,
    args: parseJsonArray(row.args_json),
    pid: nullableInteger(row.pid),
    status: row.status,
    started_at: row.started_at,
    updated_at: row.updated_at,
    exited_at: row.exited_at,
    exit_code: nullableInteger(row.exit_code),
    signal: row.signal,
    os_checked_at: row.os_checked_at,
    os_alive: truthyInteger(row.os_alive),
    logs: parseJsonArray(row.logs_json),
  };
}

function normalizeWorkflowRunLiveRow(row) {
  if (!row) return null;
  return {
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    label: row.label,
    script: row.script,
    args: [],
    pid: nullableInteger(row.pid),
    status: row.status,
    started_at: row.started_at,
    updated_at: row.updated_at,
    exited_at: row.exited_at,
    exit_code: nullableInteger(row.exit_code),
    signal: row.signal,
    os_checked_at: row.os_checked_at,
    os_alive: truthyInteger(row.os_alive),
    logs: [],
    log_count: nullableInteger(row.log_count) || 0,
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL workflow store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_WORKFLOW_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_WORKFLOW_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

function boundedLimit(value, fallback = 25) {
  const parsed = Number.parseInt(value, 10);
  const limit = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(limit, 100));
}

function createMarketplaceWorkflowPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function'
    ? options.nowIso
    : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async insertWorkflowRun(run = {}) {
      const now = run.startedAt || nowIso();
      await pool.query(`
        INSERT INTO workflow_runs (
          run_id,
          workflow_id,
          label,
          script,
          args_json,
          pid,
          status,
          started_at,
          updated_at,
          os_alive,
          logs_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        run.runId,
        run.workflowId,
        run.label,
        run.script,
        serializeArray(run.args),
        Number.isFinite(run.pid) ? run.pid : null,
        run.status || 'starting',
        now,
        run.updatedAt || now,
        run.osAlive ? 1 : 0,
        serializeArray(run.logs),
      ]);
      return this.getWorkflowRun(run.runId);
    },

    async updateWorkflowRun(runId, changes = {}) {
      const previous = await this.getWorkflowRun(runId);
      if (!previous) return null;

      const next = {
        workflow_id: changes.workflowId ?? previous.workflow_id,
        label: changes.label ?? previous.label,
        script: changes.script ?? previous.script,
        args: changes.args ?? previous.args,
        pid: changes.pid ?? previous.pid,
        status: changes.status ?? previous.status,
        updated_at: changes.updatedAt ?? nowIso(),
        exited_at: changes.exitedAt ?? previous.exited_at,
        exit_code: changes.exitCode ?? previous.exit_code,
        signal: changes.signal ?? previous.signal,
        os_checked_at: changes.osCheckedAt ?? previous.os_checked_at,
        os_alive: changes.osAlive ?? previous.os_alive,
        logs: changes.logs ?? previous.logs,
      };

      await pool.query(`
        UPDATE workflow_runs
        SET
          workflow_id = $1,
          label = $2,
          script = $3,
          args_json = $4,
          pid = $5,
          status = $6,
          updated_at = $7,
          exited_at = $8,
          exit_code = $9,
          signal = $10,
          os_checked_at = $11,
          os_alive = $12,
          logs_json = $13
        WHERE run_id = $14
      `, [
        next.workflow_id,
        next.label,
        next.script,
        serializeArray(next.args),
        Number.isFinite(next.pid) ? next.pid : null,
        next.status,
        next.updated_at,
        next.exited_at,
        Number.isFinite(next.exit_code) ? next.exit_code : null,
        next.signal || '',
        next.os_checked_at || '',
        next.os_alive ? 1 : 0,
        serializeArray(next.logs),
        runId,
      ]);
      return this.getWorkflowRun(runId);
    },

    async getWorkflowRun(runId) {
      const row = await queryOne(pool, `
        SELECT *
        FROM workflow_runs
        WHERE run_id = $1
      `, [String(runId)]);
      return normalizeWorkflowRunRow(row);
    },

    async getWorkflowRunLive(runId) {
      const row = await queryOne(pool, `
        SELECT
          run_id,
          workflow_id,
          label,
          script,
          pid,
          status,
          started_at,
          updated_at,
          exited_at,
          exit_code,
          signal,
          os_checked_at,
          os_alive,
          CASE
            WHEN logs_json IS NULL OR logs_json = '' OR logs_json = '[]' THEN 0
            ELSE jsonb_array_length(logs_json::jsonb)
          END::BIGINT AS log_count
        FROM workflow_runs
        WHERE run_id = $1
      `, [String(runId)]);
      return normalizeWorkflowRunLiveRow(row);
    },

    async listWorkflowRuns(options = {}) {
      const limit = boundedLimit(options.limit, 25);
      const rows = await queryRows(pool, `
        SELECT *
        FROM workflow_runs
        ORDER BY started_at DESC
        LIMIT $1
      `, [limit]);
      return rows.map(normalizeWorkflowRunRow);
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceWorkflowPostgresStore,
  normalizeWorkflowRunRow,
  normalizeWorkflowRunLiveRow,
  boundedLimit,
};
