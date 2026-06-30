const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMarketplaceSqlDialect,
  getMarketplaceQueryBuilders,
} = require('../scripts/marketplace-query-builders');
const {
  createMarketplacePostgresReader,
} = require('../scripts/marketplace-postgres-reader');

function createFakePool(handler) {
  const calls = [];
  return {
    calls,
    ended: false,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: handler(sql, params, calls.length) || [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

test('getMarketplaceQueryBuilders selects SQLite by default and PostgreSQL by aliases', () => {
  assert.equal(normalizeMarketplaceSqlDialect(''), 'sqlite');
  assert.equal(normalizeMarketplaceSqlDialect('postgresql'), 'postgres');
  assert.equal(normalizeMarketplaceSqlDialect('pg'), 'postgres');

  const sqlite = getMarketplaceQueryBuilders({ dialect: 'sqlite' }).buildListingsQuery({ query: 'status:pending' });
  assert.match(sqlite.sql, /detail_status = \?/);

  const postgres = getMarketplaceQueryBuilders({ dialect: 'pg' }).buildListingsQuery({ query: 'status:pending' });
  assert.match(postgres.sql, /detail_status = \$1/);
});

test('createMarketplacePostgresReader executes listing and count queries through injected pool', async () => {
  const pool = createFakePool((sql) => {
    if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: '42' }];
    return [{ listing_id: 'listing-a', numeric_price: '1200' }];
  });
  const reader = createMarketplacePostgresReader({ pool });
  const result = await reader.listListings({
    query: 'status:done price:>500',
    limit: '10',
    offset: '5',
  });

  assert.equal(result.total, 42);
  assert.equal(result.rows[0].listing_id, 'listing-a');
  assert.equal(result.rows[0].numeric_price, 1200);
  assert.equal(result.parsedQuery.dialect, 'postgres');
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /LIMIT \$3 OFFSET \$4/);
  assert.deepEqual(pool.calls[0].params.slice(-2), [10, 5]);
  assert.match(pool.calls[1].sql, /SELECT COUNT\(\*\) AS total/);
  await reader.close();
  assert.equal(pool.ended, true);
});

test('createMarketplacePostgresReader reads result stats with pg camelCase aliases intact', async () => {
  const pool = createFakePool((sql) => {
    if (/AS "totalRows"/.test(sql)) {
      return [{ totalRows: '4', pricedCount: '3', priceMin: '100', priceMax: '700', priceAverage: '400' }];
    }
    if (/AS "priceMedian"/.test(sql)) return [{ priceMedian: '500' }];
    if (/GROUP BY bucket/.test(sql)) return [{ bucket: '0', count: '1' }, { bucket: '5', count: '2' }];
    if (/detail_status/.test(sql)) return [{ label: 'done', count: '3' }];
    if (/source/.test(sql)) return [{ label: 'search', count: '4' }];
    return [];
  });
  const reader = createMarketplacePostgresReader({ pool });
  const stats = await reader.readListingsResultStats({
    query: 'title contains "pentax" and price >= 100',
    excludeListingIds: ['queued-a'],
  });

  assert.equal(stats.pricedCount, 3);
  assert.equal(stats.unpricedCount, 1);
  assert.equal(stats.priceMin, 100);
  assert.equal(stats.priceMax, 700);
  assert.equal(stats.priceAverage, 400);
  assert.equal(stats.priceMedian, 500);
  assert.deepEqual(stats.statusCounts, [['done', 3]]);
  assert.deepEqual(stats.sourceCounts, [['search', 4]]);
  assert.equal(stats.priceHistogram.length, 6);
  assert.equal(pool.calls.length, 5);
  assert.match(pool.calls[0].sql, /COUNT\(\*\) AS "totalRows"/);
  assert.match(pool.calls[1].sql, /FLOOR\(\(numeric_price - \$7\) \/ \$8\)::BIGINT/);
});
