const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseQuery,
  buildListingsQuery,
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
