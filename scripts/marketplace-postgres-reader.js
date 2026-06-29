const {
  buildListingsQuery,
  buildCountQuery,
  buildListingsStatsQueries,
} = require('./marketplace-homepage-query-postgres');

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCountRows(rows) {
  return (rows || [])
    .map((row) => [String(row.label || 'unknown'), Number.parseInt(row.count, 10) || 0])
    .filter((item) => item[1] > 0);
}

function buildPriceHistogramFromBuckets(bucketRows, histogramQuery, pricedCount) {
  const min = nullableNumber(histogramQuery.min);
  const max = nullableNumber(histogramQuery.max);
  const total = Number.parseInt(pricedCount, 10) || 0;
  if (!total || min === null || max === null) return [];
  if (min === max) return [{ min, max, count: total }];

  const binCount = Math.max(2, histogramQuery.binCount || 6);
  const width = Number(histogramQuery.width) > 0 ? Number(histogramQuery.width) : (max - min) / binCount;
  const counts = new Map((bucketRows || []).map((row) => [
    Number.parseInt(row.bucket, 10) || 0,
    Number.parseInt(row.count, 10) || 0,
  ]));
  return Array.from({ length: binCount }, (_item, index) => ({
    min: min + width * index,
    max: index === binCount - 1 ? max : min + width * (index + 1),
    count: counts.get(index) || 0,
  }));
}

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

function createMarketplacePostgresReader(options = {}) {
  const pool = options.pool || (() => {
    const connectionString = options.connectionString || process.env.MARKETPLACE_POSTGRES_URL || process.env.DATABASE_URL || '';
    if (!connectionString) {
      const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_POSTGRES_URL or pass connectionString.');
      error.code = 'missing_postgres_connection_string';
      throw error;
    }
    const Pool = requirePgPool();
    return new Pool({ connectionString });
  })();

  async function queryRows(spec) {
    const result = await pool.query(spec.sql, spec.params || []);
    return result.rows || [];
  }

  async function queryOne(spec) {
    const rows = await queryRows(spec);
    return rows[0] || null;
  }

  return {
    dialect: 'postgres',
    pool,
    async listListings(options = {}) {
      const listingsQuery = buildListingsQuery(options);
      const countQuery = buildCountQuery({
        query: options.query || '',
        excludeListingIds: options.excludeListingIds,
      });
      const [rows, count] = await Promise.all([
        queryRows(listingsQuery),
        queryOne(countQuery),
      ]);
      return {
        query: options.query || '',
        parsedQuery: listingsQuery.parsedQuery,
        sort: listingsQuery.parsedQuery.sort,
        sortDirection: listingsQuery.parsedQuery.sortDirection,
        limit: listingsQuery.limit,
        offset: listingsQuery.offset,
        total: Number.parseInt(count?.total, 10) || 0,
        rows,
      };
    },
    async readListingsResultStats(options = {}) {
      const queries = buildListingsStatsQueries(options);
      const summary = await queryOne(queries.priceSummary) || {};
      const pricedCount = Number.parseInt(summary.pricedCount, 10) || 0;
      const priceMin = nullableNumber(summary.priceMin);
      const priceMax = nullableNumber(summary.priceMax);
      const histogramQuery = queries.priceHistogram({
        min: priceMin,
        max: priceMax,
        binCount: 6,
      });
      const [histogramRows, median, statusRows, sourceRows] = await Promise.all([
        pricedCount > 0 ? queryRows(histogramQuery) : [],
        pricedCount > 0 ? queryOne(queries.priceMedian) : {},
        queryRows(queries.statusCounts),
        queryRows(queries.sourceCounts),
      ]);
      const totalRows = Number.parseInt(summary.totalRows, 10) || 0;
      return {
        pricedCount,
        unpricedCount: Math.max(0, totalRows - pricedCount),
        priceMin,
        priceMax,
        priceAverage: nullableNumber(summary.priceAverage),
        priceMedian: nullableNumber(median?.priceMedian),
        priceHistogram: buildPriceHistogramFromBuckets(histogramRows, histogramQuery, pricedCount),
        statusCounts: normalizeCountRows(statusRows),
        sourceCounts: normalizeCountRows(sourceRows),
      };
    },
    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplacePostgresReader,
  buildPriceHistogramFromBuckets,
  normalizeCountRows,
};
