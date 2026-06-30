const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLiteKql } = require('../scripts/lite-kql-parser');
const { planLiteKql } = require('../scripts/lite-kql-planner');
const { buildLiteCountQuery, buildLiteListingsQuery } = require('../scripts/lite-kql-sqlite');
const {
  buildLiteListingsQuery: buildPostgresLiteListingsQuery,
  buildLiteCountQuery: buildPostgresLiteCountQuery,
  buildLiteListingsStatsQueries: buildPostgresLiteListingsStatsQueries,
} = require('../scripts/lite-kql-postgres');
const { completeLiteKql } = require('../scripts/lite-kql-authoring');

test('parseLiteKql reads source, where, sort, and take stages', () => {
  const parsed = parseLiteKql('listings | where status == "pending" and price <= 1200 | sort by rank asc | take 25');

  assert.equal(parsed.source, 'listings');
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.stages.length, 3);
  assert.equal(parsed.stages[0].type, 'where');
  assert.equal(parsed.stages[1].field, 'rank');
  assert.equal(parsed.stages[1].direction, 'asc');
  assert.equal(parsed.stages[2].value, 25);
});

test('planLiteKql validates fields and reorders top-level indexed filters before text scans', () => {
  const plan = planLiteKql(parseLiteKql('listings | where title contains "leica" and status == "pending"'));

  assert.equal(plan.diagnostics.length, 0);
  assert.equal(plan.expression.type, 'and');
  assert.equal(plan.expression.left.type, 'condition');
  assert.equal(plan.expression.left.field, 'status');
  assert.equal(plan.expression.right.field, 'title');
});

test('buildLiteListingsQuery compiles a parameterized SQLite query', () => {
  const query = buildLiteListingsQuery({
    query: 'listings | where (title contains "pentax 67" or keyword in ("nikon", "leica")) and price >= 2000 | sort by price desc | take 25',
    offset: '10',
  });

  assert.match(query.sql, /FROM homepage_listings/);
  assert.match(query.sql, /ORDER BY/);
  assert.match(query.sql, /LIMIT \? OFFSET \?/);
  assert.equal(query.limit, 25);
  assert.deepEqual(query.params.slice(0, 5), [2000, '%pentax 67%', '%pentax 67%', 'nikon', 'leica']);
});

test('lite KQL supports summarize count and count pipeline stages', () => {
  const summarized = parseLiteKql('listings | where status == "pending" | summarize count()');
  assert.equal(summarized.diagnostics.length, 0);
  assert.equal(summarized.stages.at(-1).type, 'summarize');
  assert.equal(planLiteKql(summarized).aggregate.type, 'count');

  const countQuery = buildLiteCountQuery({
    query: 'listings | where status == "pending" | count',
  });
  assert.match(countQuery.sql, /SELECT COUNT\(\*\) AS total/);
  assert.deepEqual(countQuery.params, ['pending']);
});

test('completeLiteKql suggests fields, operators, and enum values from cursor context', () => {
  const fieldCompletion = completeLiteKql({ query: 'listings | where sta', cursor: 'listings | where sta'.length });
  assert.ok(fieldCompletion.suggestions.some((item) => item.label === 'status'));

  const operatorCompletion = completeLiteKql({ query: 'listings | where status ', cursor: 'listings | where status '.length });
  assert.ok(operatorCompletion.suggestions.some((item) => item.label === '=='));

  const valueCompletion = completeLiteKql({ query: 'listings | where status == ', cursor: 'listings | where status == '.length });
  assert.ok(valueCompletion.suggestions.some((item) => item.label === 'pending'));
});

test('completeLiteKql supports trade history source fields and values', () => {
  const sourceCompletion = completeLiteKql({ query: 'his', cursor: 'his'.length });
  assert.ok(sourceCompletion.suggestions.some((item) => item.label === 'history'));

  const fieldCompletion = completeLiteKql({ query: 'history | where pro', cursor: 'history | where pro'.length });
  assert.ok(fieldCompletion.suggestions.some((item) => item.label === 'profit'));

  const valueCompletion = completeLiteKql({ query: 'history | where status == ', cursor: 'history | where status == '.length });
  assert.ok(valueCompletion.suggestions.some((item) => item.label === 'sold'));
});


test('buildPostgresLiteListingsQuery compiles PostgreSQL placeholders and price extraction', () => {
  const query = buildPostgresLiteListingsQuery({
    query: 'listings | where (title contains "pentax 67" or keyword in ("nikon", "leica")) and price >= 2000 | sort by price desc | take 25',
    offset: '10',
  });

  assert.match(query.sql, /FROM homepage_listings/);
  assert.ok(query.sql.includes("REPLACE(REPLACE(REPLACE(detail_price, 'CA$'"));
  assert.match(query.sql, /ESCAPE E'\\\\'/);
  assert.match(query.sql, /LIMIT \$6 OFFSET \$7/);
  assert.doesNotMatch(query.sql, /LIMIT \? OFFSET \?/);
  assert.equal(query.limit, 25);
  assert.deepEqual(query.params, [2000, '%pentax 67%', '%pentax 67%', 'nikon', 'leica', 25, 10]);
});

test('buildPostgresLiteCountQuery compiles count query with dollar parameters', () => {
  const query = buildPostgresLiteCountQuery({
    query: 'listings | where status == "pending" and title contains "leica" | count',
  });

  assert.match(query.sql, /SELECT COUNT\(\*\) AS total/);
  assert.match(query.sql, /detail_status = \$1/);
  assert.match(query.sql, /card_title ILIKE \$2/);
  assert.match(query.sql, /detail_title ILIKE \$3/);
  assert.doesNotMatch(query.sql, /ILIKE \?/);
  assert.deepEqual(query.params, ['pending', '%leica%', '%leica%']);
});

test('buildPostgresLiteListingsStatsQueries compiles histogram with PostgreSQL floor casts', () => {
  const stats = buildPostgresLiteListingsStatsQueries({
    query: 'listings | where title contains "pentax" and price >= 2000',
    excludeListingIds: ['queued-a'],
  });
  const histogram = stats.priceHistogram({ min: 2000, max: 5000, binCount: 6 });

  assert.ok(stats.priceSummary.sql.includes("REPLACE(REPLACE(REPLACE(detail_price, 'CA$'"));
  assert.match(stats.priceSummary.sql, /COUNT\(\*\) AS \"totalRows\"/);
  assert.match(histogram.sql, /FLOOR\(\(numeric_price - \$7\) \/ \$8\)::BIGINT/);
  assert.doesNotMatch(histogram.sql, /CAST\(/);
  assert.doesNotMatch(histogram.sql, /LIMIT \?/);
  assert.deepEqual(histogram.params, [2000, '%pentax%', '%pentax%', 'queued-a', 5000, 5, 2000, 500]);
});
