function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function integerValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeListingSearchKeywordRow(row) {
  if (!row) return null;
  return {
    listing_id: row.listing_id,
    normalized_keyword: row.normalized_keyword,
    keyword: row.keyword,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    times_seen: integerValue(row.times_seen, 1),
  };
}

function normalizeSearchTitleBagKeywordRow(row) {
  if (!row) return null;
  return {
    normalized_keyword: row.normalized_keyword,
    keyword: row.keyword,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    times_seen: integerValue(row.times_seen, 1),
    last_source_keyword: row.last_source_keyword || '',
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL search keyword store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_SEARCH_KEYWORDS_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_SEARCH_KEYWORDS_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

function createMarketplaceSearchKeywordsPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async upsertListingSearchKeyword(listingId, keyword, options = {}) {
      const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
      if (!listingId || !normalizedKeyword) return null;
      const now = options.seenAt || options.seen_at || nowIso();
      const canonicalKeyword = normalizeKeyword(keyword);
      await pool.query(`
        INSERT INTO listing_search_keywords (
          listing_id,
          normalized_keyword,
          keyword,
          first_seen_at,
          last_seen_at,
          times_seen
        ) VALUES ($1, $2, $3, $4, $5, 1)
        ON CONFLICT(listing_id, normalized_keyword) DO UPDATE SET
          keyword = excluded.keyword,
          last_seen_at = excluded.last_seen_at,
          times_seen = listing_search_keywords.times_seen + 1
      `, [String(listingId), normalizedKeyword, canonicalKeyword, now, now]);
      const row = await queryOne(pool, `
        SELECT *
        FROM listing_search_keywords
        WHERE listing_id = $1
          AND normalized_keyword = $2
      `, [String(listingId), normalizedKeyword]);
      return normalizeListingSearchKeywordRow(row);
    },

    async upsertSearchTitleBagKeyword(keyword, options = {}) {
      const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
      if (!normalizedKeyword) return null;
      const now = options.seenAt || options.seen_at || nowIso();
      const canonicalKeyword = normalizeKeyword(keyword);
      const sourceKeyword = normalizeKeyword(options.sourceKeyword || options.source_keyword || '');
      await pool.query(`
        INSERT INTO search_title_bag (
          normalized_keyword,
          keyword,
          first_seen_at,
          last_seen_at,
          times_seen,
          last_source_keyword
        ) VALUES ($1, $2, $3, $4, 1, $5)
        ON CONFLICT(normalized_keyword) DO UPDATE SET
          keyword = excluded.keyword,
          last_seen_at = excluded.last_seen_at,
          times_seen = search_title_bag.times_seen + 1,
          last_source_keyword = excluded.last_source_keyword
      `, [normalizedKeyword, canonicalKeyword, now, now, sourceKeyword]);
      return this.getSearchTitleBagKeyword(canonicalKeyword);
    },

    async getSearchTitleBagKeyword(keyword) {
      const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
      if (!normalizedKeyword) return null;
      const row = await queryOne(pool, `
        SELECT *
        FROM search_title_bag
        WHERE normalized_keyword = $1
      `, [normalizedKeyword]);
      return normalizeSearchTitleBagKeywordRow(row);
    },

    async pickRandomSearchTitleBagKeyword(options = {}) {
      const excludeKeywords = Array.isArray(options.excludeKeywords)
        ? options.excludeKeywords.map((value) => normalizeKeyword(value).toLowerCase()).filter(Boolean)
        : [];
      const minTimesSeen = Number.isFinite(options.minTimesSeen) ? Math.max(1, options.minTimesSeen) : 1;
      const params = [minTimesSeen];
      let exclusionSql = '';
      if (excludeKeywords.length > 0) {
        const placeholders = excludeKeywords.map((keyword) => {
          params.push(keyword);
          return `$${params.length}`;
        });
        exclusionSql = `AND normalized_keyword NOT IN (${placeholders.join(', ')})`;
      }
      const row = await queryOne(pool, `
        SELECT *
        FROM search_title_bag
        WHERE times_seen >= $1
          ${exclusionSql}
        ORDER BY RANDOM()
        LIMIT 1
      `, params);
      return normalizeSearchTitleBagKeywordRow(row);
    },

    async getSearchTitleBagCounts() {
      const row = await queryOne(pool, `
        SELECT
          COUNT(*)::BIGINT AS total_keywords,
          COALESCE(SUM(times_seen), 0)::BIGINT AS total_seen
        FROM search_title_bag
      `);
      return {
        totalKeywords: integerValue(row && row.total_keywords, 0),
        totalSeen: integerValue(row && row.total_seen, 0),
      };
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceSearchKeywordsPostgresStore,
  normalizeKeyword,
  normalizeListingSearchKeywordRow,
  normalizeSearchTitleBagKeywordRow,
};
