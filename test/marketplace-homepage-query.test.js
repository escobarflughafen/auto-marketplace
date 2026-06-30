const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseQuery,
  buildListingsQuery,
  buildListingIdsQuery,
  buildCountQuery,
  buildListingsStatsQueries,
} = require('../scripts/marketplace-homepage-query');
const {
  buildListingsQuery: buildPostgresListingsQuery,
  buildListingIdsQuery: buildPostgresListingIdsQuery,
  buildCountQuery: buildPostgresCountQuery,
  buildListingsStatsQueries: buildPostgresListingsStatsQueries,
} = require('../scripts/marketplace-homepage-query-postgres');

test('parseQuery extracts plain terms and field filters', () => {
  const parsed = parseQuery('nikon status:pending location:vancouver keyword:leica "m6 classic" sort:rank');
  assert.deepEqual(parsed.terms, ['nikon', 'm6 classic']);
  assert.deepEqual(parsed.filters, [
    { field: 'detail_status', value: 'pending' },
    { field: 'detail_location', value: 'vancouver' },
    { field: 'source_keyword', value: 'leica' },
  ]);
  assert.equal(parsed.sort, 'rank');
});

test('buildListingsQuery includes SQL params for free text and field filters', () => {
  const query = buildListingsQuery({
    query: 'leica status:done price:>500',
    limit: '25',
    offset: '10',
  });

  assert.match(query.sql, /FROM homepage_listings/);
  assert.match(query.sql, /detail_status = \?/);
  assert.match(query.sql, /LIMIT \? OFFSET \?/);
  assert.equal(query.limit, 25);
  assert.equal(query.offset, 10);
  assert.ok(query.params.length > 4);
});

test('parseQuery recognizes KQL-style field operators', () => {
  const parsed = parseQuery('title contains "pentax 67" and status != done or price >= 2000');

  assert.equal(parsed.expression.type, 'or');
  assert.equal(parsed.expression.left.type, 'and');
  assert.equal(parsed.expression.left.left.field, 'title');
  assert.equal(parsed.expression.left.left.operator, 'contains');
  assert.deepEqual(parsed.expression.left.left.values, ['pentax 67']);
  assert.equal(parsed.expression.left.right.field, 'detail_status');
  assert.equal(parsed.expression.left.right.operator, '!=');
  assert.equal(parsed.expression.right.field, 'price');
  assert.equal(parsed.expression.right.operator, '>=');
});

test('buildListingsQuery supports KQL contains, exact, numeric, in, and or clauses', () => {
  const query = buildListingsQuery({
    query: '(title contains "pentax 67" or source_keyword in ("nikon", "leica")) and status =~ pend and price >= 2000',
    limit: '25',
    offset: '10',
  });

  assert.match(query.sql, / OR /);
  assert.match(query.sql, /source_keyword IN \(\?, \?\)/);
  assert.match(query.sql, /detail_status LIKE \? ESCAPE/);
  assert.match(query.sql, />= \?/);
  assert.deepEqual(query.params.slice(0, 6), ['%pentax 67%', '%pentax 67%', 'nikon', 'leica', '%pend%', 2000]);
});

test('buildListingsQuery supports explicit table sort fields and direction', () => {
  const rankDesc = buildListingsQuery({
    query: 'status:pending',
    sort: 'rank',
    sortDirection: 'desc',
  });
  assert.equal(rankDesc.parsedQuery.sort, 'rank');
  assert.equal(rankDesc.parsedQuery.sortDirection, 'desc');
  assert.match(rankDesc.sql, /COALESCE\(last_seen_rank, 999999\) DESC/);

  const titleAsc = buildListingsQuery({
    sort: 'title',
    sortDirection: 'asc',
  });
  assert.equal(titleAsc.parsedQuery.sort, 'title');
  assert.equal(titleAsc.parsedQuery.sortDirection, 'asc');
  assert.match(titleAsc.sql, /LOWER\(COALESCE/);
  assert.match(titleAsc.sql, / ASC,/);

  const sellerSort = buildListingsQuery({
    sort: 'seller',
    sortDirection: 'asc',
  });
  assert.equal(sellerSort.parsedQuery.sort, 'seller');
  assert.match(sellerSort.sql, /detail_seller_name/);

  const attemptsSort = buildListingsQuery({
    sort: 'attempts',
    sortDirection: 'desc',
  });
  assert.equal(attemptsSort.parsedQuery.sort, 'attempts');
  assert.match(attemptsSort.sql, /detail_attempts DESC/);
});

test('buildListingIdsQuery returns backlog-only ids in viewer order', () => {
  const query = buildListingIdsQuery({
    query: 'status != done and title contains "nikon"',
    sort: 'latest',
    sortDirection: 'desc',
  });

  assert.match(query.sql, /SELECT listing_id/);
  assert.match(query.sql, /detail_status IN \('pending', 'error', 'processing'\)/);
  assert.match(query.sql, /ORDER BY last_seen_at DESC/);
  assert.deepEqual(query.params, ['done', '%nikon%', '%nikon%']);
});

test('listing queries can exclude staged resolve queue ids', () => {
  const listingsQuery = buildListingsQuery({
    query: 'status:pending',
    excludeListingIds: ['queued-a', 'queued-b', 'queued-a'],
  });
  assert.match(listingsQuery.sql, /listing_id NOT IN \(\?, \?\)/);
  assert.deepEqual(listingsQuery.params.slice(0, 3), ['pending', 'queued-a', 'queued-b']);

  const idsQuery = buildListingIdsQuery({
    query: 'status:pending',
    excludeListingIds: ['queued-a'],
  });
  assert.match(idsQuery.sql, /listing_id NOT IN \(\?\)/);
  assert.deepEqual(idsQuery.params, ['pending', 'queued-a']);

  const countQuery = buildCountQuery({
    query: 'status:pending',
    excludeListingIds: ['queued-a'],
  });
  assert.match(countQuery.sql, /listing_id NOT IN \(\?\)/);
  assert.deepEqual(countQuery.params, ['pending', 'queued-a']);
});

test('buildListingsStatsQueries aggregates the full filtered result without pagination', () => {
  const stats = buildListingsStatsQueries({
    query: 'title contains "pentax" and price >= 2000',
    excludeListingIds: ['queued-a'],
  });

  assert.match(stats.priceSummary.sql, /COUNT\(numeric_price\) AS pricedCount/);
  assert.doesNotMatch(stats.priceSummary.sql, /LIMIT \? OFFSET \?/);
  assert.match(stats.statusCounts.sql, /GROUP BY label/);
  assert.deepEqual(stats.priceSummary.params, ['%pentax%', '%pentax%', 2000, 'queued-a']);

  const histogram = stats.priceHistogram({ min: 2000, max: 5000, binCount: 6 });
  assert.match(histogram.sql, /GROUP BY bucket/);
  assert.equal(histogram.binCount, 6);
  assert.deepEqual(histogram.params.slice(0, 4), [5000, 5, 2000, 500]);
  assert.deepEqual(histogram.params.slice(4), stats.priceSummary.params);
});

test('buildListingsStatsQueries supports lite KQL filters', () => {
  const stats = buildListingsStatsQueries({
    query: 'listings | where title contains "leica" and price >= 1000',
    excludeListingIds: ['queued-b'],
  });

  assert.equal(stats.parsedQuery.mode, 'lite-kql');
  assert.match(stats.priceSummary.sql, /FROM homepage_listings/);
  assert.doesNotMatch(stats.priceSummary.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(stats.priceSummary.params, [1000, '%leica%', '%leica%', 'queued-b']);
});


test('PostgreSQL listing query compiles legacy filters with dollar placeholders', () => {
  const query = buildPostgresListingsQuery({
    query: 'leica status:done price:>500',
    limit: '25',
    offset: '10',
  });

  assert.equal(query.parsedQuery.dialect, 'postgres');
  assert.match(query.sql, /FROM homepage_listings/);
  assert.match(query.sql, /detail_status = \$11/);
  assert.ok(query.sql.includes("REPLACE(REPLACE(REPLACE(detail_price, 'CA$'"));
  assert.match(query.sql, /LIMIT \$13 OFFSET \$14/);
  assert.doesNotMatch(query.sql, /LIMIT \? OFFSET \?/);
  assert.equal(query.limit, 25);
  assert.equal(query.offset, 10);
  assert.deepEqual(query.params.slice(-4), ['done', 500, 25, 10]);
});

test('PostgreSQL query helpers compile ids, count, stats, and histogram shapes', () => {
  const ids = buildPostgresListingIdsQuery({
    query: 'status != done and title contains "nikon"',
    sort: 'latest',
    sortDirection: 'desc',
  });
  assert.match(ids.sql, /SELECT listing_id/);
  assert.match(ids.sql, /detail_status IN \('pending', 'error', 'processing'\)/);
  assert.match(ids.sql, /detail_status != \$1/);
  assert.match(ids.sql, /card_title ILIKE \$2/);
  assert.deepEqual(ids.params, ['done', '%nikon%', '%nikon%']);

  const count = buildPostgresCountQuery({
    query: 'status:pending',
    excludeListingIds: ['queued-a'],
  });
  assert.match(count.sql, /SELECT COUNT\(\*\) AS total/);
  assert.match(count.sql, /detail_status = \$1/);
  assert.match(count.sql, /listing_id NOT IN \(\$2\)/);
  assert.deepEqual(count.params, ['pending', 'queued-a']);

  const stats = buildPostgresListingsStatsQueries({
    query: 'title contains "pentax" and price >= 2000',
    excludeListingIds: ['queued-a'],
  });
  assert.match(stats.priceSummary.sql, /COUNT\(\*\) AS "totalRows"/);
  assert.ok(stats.priceSummary.sql.includes("REPLACE(REPLACE(REPLACE(detail_price, 'CA$'"));
  assert.deepEqual(stats.priceSummary.params, ['%pentax%', '%pentax%', 2000, 'queued-a']);

  const histogram = stats.priceHistogram({ min: 2000, max: 5000, binCount: 6 });
  assert.match(histogram.sql, /FLOOR\(\(numeric_price - \$7\) \/ \$8\)::BIGINT/);
  assert.doesNotMatch(histogram.sql, /CAST\(/);
  assert.deepEqual(histogram.params, ['%pentax%', '%pentax%', 2000, 'queued-a', 5000, 5, 2000, 500]);
});
