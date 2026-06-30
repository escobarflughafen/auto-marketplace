const crypto = require('crypto');

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeIdentifier(value, fallbackPrefix, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (normalized) return normalized;
  return fallback || `${fallbackPrefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeSummaryQueryCardId(value, fallback = '') {
  return normalizeIdentifier(value, 'summary-card', fallback);
}

function normalizeSavedQueryId(value, fallback = '') {
  return normalizeIdentifier(value, 'saved-query', fallback);
}

function normalizeWorkerParameterProfileId(value, fallback = '') {
  return normalizeIdentifier(value, 'worker-profile', fallback);
}

function serializeJsonObject(value) {
  return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : {}, null, 2);
}

function serializeJsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numericValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truthyOverview(value) {
  return value === true || value === 1 || value === '1';
}

function normalizeSummaryQueryCardRow(row) {
  if (!row) return null;
  return {
    card_id: row.card_id,
    label: row.label,
    query: row.query,
    position: numericValue(row.position, 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeWorkerParameterProfileRow(row) {
  if (!row) return null;
  return {
    profile_id: row.profile_id,
    workflow_id: row.workflow_id,
    worker_type: row.worker_type || '',
    label: row.label,
    params: parseJsonObject(row.params_json),
    args: parseJsonArray(row.args_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSavedQueryRow(row) {
  if (!row) return null;
  const showInOverview = truthyOverview(row.show_in_overview);
  return {
    id: row.query_id,
    query_id: row.query_id,
    label: row.label,
    query: row.query,
    showInOverview,
    show_in_overview: showInOverview,
    source: 'server',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL config store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_CONFIG_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_CONFIG_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

function createMarketplaceConfigPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function'
    ? options.nowIso
    : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async listWorkerParameterProfiles(options = {}) {
      const workflowId = String(options.workflowId || options.workflow_id || '').trim();
      const rows = workflowId
        ? await queryRows(pool, `
          SELECT *
          FROM worker_parameter_profiles
          WHERE workflow_id = $1
          ORDER BY updated_at DESC, label ASC
        `, [workflowId])
        : await queryRows(pool, `
          SELECT *
          FROM worker_parameter_profiles
          ORDER BY updated_at DESC, label ASC
        `);
      return rows.map(normalizeWorkerParameterProfileRow);
    },

    async getWorkerParameterProfile(profileId) {
      const row = await queryOne(pool, `
        SELECT *
        FROM worker_parameter_profiles
        WHERE profile_id = $1
      `, [String(profileId || '').trim()]);
      return normalizeWorkerParameterProfileRow(row);
    },

    async upsertWorkerParameterProfile(profile = {}) {
      const now = profile.updatedAt || profile.updated_at || nowIso();
      const workflowId = String(profile.workflowId || profile.workflow_id || '').trim();
      if (!workflowId) throw new Error('upsertWorkerParameterProfile requires workflowId');
      const label = normalizeKeyword(profile.label || profile.name || '');
      if (!label) throw new Error('upsertWorkerParameterProfile requires label');
      const profileId = normalizeWorkerParameterProfileId(
        profile.profileId || profile.profile_id,
        normalizeWorkerParameterProfileId(`${workflowId}-${label}`),
      );
      const previous = await this.getWorkerParameterProfile(profileId);
      const params = profile.params && typeof profile.params === 'object' && !Array.isArray(profile.params)
        ? profile.params
        : {};
      const args = Array.isArray(profile.args) ? profile.args : [];

      await pool.query(`
        INSERT INTO worker_parameter_profiles (
          profile_id,
          workflow_id,
          worker_type,
          label,
          params_json,
          args_json,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(profile_id) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          worker_type = excluded.worker_type,
          label = excluded.label,
          params_json = excluded.params_json,
          args_json = excluded.args_json,
          updated_at = excluded.updated_at
      `, [
        profileId,
        workflowId,
        String(profile.workerType || profile.worker_type || '').trim(),
        label,
        serializeJsonObject(params),
        serializeJsonArray(args),
        previous?.created_at || profile.createdAt || profile.created_at || now,
        now,
      ]);
      return this.getWorkerParameterProfile(profileId);
    },

    async deleteWorkerParameterProfile(profileId) {
      const id = String(profileId || '').trim();
      const previous = await this.getWorkerParameterProfile(id);
      if (!previous) return null;
      await pool.query(`
        DELETE FROM worker_parameter_profiles
        WHERE profile_id = $1
      `, [id]);
      return previous;
    },

    async listSummaryQueryCards() {
      const rows = await queryRows(pool, `
        SELECT *
        FROM summary_query_cards
        ORDER BY "position" ASC, updated_at DESC, label ASC
      `);
      return rows.map(normalizeSummaryQueryCardRow);
    },

    async getSummaryQueryCard(cardId) {
      const row = await queryOne(pool, `
        SELECT *
        FROM summary_query_cards
        WHERE card_id = $1
      `, [String(cardId || '').trim()]);
      return normalizeSummaryQueryCardRow(row);
    },

    async upsertSummaryQueryCard(card = {}) {
      const now = card.updatedAt || card.updated_at || nowIso();
      const label = normalizeKeyword(card.label || card.name || '');
      if (!label) throw new Error('upsertSummaryQueryCard requires label');
      const query = String(card.query || '').trim();
      if (!query) throw new Error('upsertSummaryQueryCard requires query');
      const cardId = normalizeSummaryQueryCardId(
        card.cardId || card.card_id,
        normalizeSummaryQueryCardId(`summary-${label}`),
      );
      const previous = await this.getSummaryQueryCard(cardId);
      const position = Number.isFinite(card.position)
        ? Math.max(0, Math.trunc(card.position))
        : previous?.position ?? 100;

      await pool.query(`
        INSERT INTO summary_query_cards (
          card_id,
          label,
          query,
          "position",
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(card_id) DO UPDATE SET
          label = excluded.label,
          query = excluded.query,
          "position" = excluded."position",
          updated_at = excluded.updated_at
      `, [
        cardId,
        label,
        query,
        position,
        previous?.created_at || card.createdAt || card.created_at || now,
        now,
      ]);
      return this.getSummaryQueryCard(cardId);
    },

    async deleteSummaryQueryCard(cardId) {
      const id = String(cardId || '').trim();
      const previous = await this.getSummaryQueryCard(id);
      if (!previous) return null;
      await pool.query(`
        DELETE FROM summary_query_cards
        WHERE card_id = $1
      `, [id]);
      return previous;
    },

    async listSavedQueries() {
      const rows = await queryRows(pool, `
        SELECT *
        FROM saved_queries
        ORDER BY updated_at DESC, label ASC
      `);
      return rows.map(normalizeSavedQueryRow);
    },

    async getSavedQuery(queryId) {
      const row = await queryOne(pool, `
        SELECT *
        FROM saved_queries
        WHERE query_id = $1
      `, [String(queryId || '').trim()]);
      return normalizeSavedQueryRow(row);
    },

    async upsertSavedQuery(query = {}) {
      const now = query.updatedAt || query.updated_at || nowIso();
      const label = normalizeKeyword(query.label || query.name || '');
      if (!label) throw new Error('upsertSavedQuery requires label');
      const queryText = String(query.query || '').trim();
      if (!queryText) throw new Error('upsertSavedQuery requires query');
      const queryId = normalizeSavedQueryId(
        query.id || query.queryId || query.query_id,
        normalizeSavedQueryId(`saved-${label}`),
      );
      const previous = await this.getSavedQuery(queryId);
      const showInOverview = query.showInOverview ?? query.show_in_overview ?? previous?.showInOverview ?? false;

      await pool.query(`
        INSERT INTO saved_queries (
          query_id,
          label,
          query,
          show_in_overview,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(query_id) DO UPDATE SET
          label = excluded.label,
          query = excluded.query,
          show_in_overview = excluded.show_in_overview,
          updated_at = excluded.updated_at
      `, [
        queryId,
        label,
        queryText,
        showInOverview ? 1 : 0,
        previous?.created_at || query.createdAt || query.created_at || now,
        now,
      ]);
      return this.getSavedQuery(queryId);
    },

    async setSavedQueryOverview(queryId, showInOverview) {
      const previous = await this.getSavedQuery(queryId);
      if (!previous) return null;
      await pool.query(`
        UPDATE saved_queries
        SET show_in_overview = $1, updated_at = $2
        WHERE query_id = $3
      `, [showInOverview ? 1 : 0, nowIso(), previous.query_id]);
      return this.getSavedQuery(previous.query_id);
    },

    async deleteSavedQuery(queryId) {
      const id = String(queryId || '').trim();
      const previous = await this.getSavedQuery(id);
      if (!previous) return null;
      await pool.query(`
        DELETE FROM saved_queries
        WHERE query_id = $1
      `, [id]);
      return previous;
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceConfigPostgresStore,
  normalizeWorkerParameterProfileId,
  normalizeWorkerParameterProfileRow,
  normalizeSummaryQueryCardId,
  normalizeSavedQueryId,
  normalizeSummaryQueryCardRow,
  normalizeSavedQueryRow,
};
