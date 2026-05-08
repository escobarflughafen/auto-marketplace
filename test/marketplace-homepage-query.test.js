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
