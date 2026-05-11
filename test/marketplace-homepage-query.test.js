const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseQuery,
  buildListingsQuery,
  buildListingIdsQuery,
} = require('../scripts/marketplace-homepage-query');

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
