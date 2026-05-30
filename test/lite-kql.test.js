const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLiteKql } = require('../scripts/lite-kql-parser');
const { planLiteKql } = require('../scripts/lite-kql-planner');
const { buildLiteListingsQuery } = require('../scripts/lite-kql-sqlite');
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

test('completeLiteKql suggests fields, operators, and enum values from cursor context', () => {
  const fieldCompletion = completeLiteKql({ query: 'listings | where sta', cursor: 'listings | where sta'.length });
  assert.ok(fieldCompletion.suggestions.some((item) => item.label === 'status'));

  const operatorCompletion = completeLiteKql({ query: 'listings | where status ', cursor: 'listings | where status '.length });
  assert.ok(operatorCompletion.suggestions.some((item) => item.label === '=='));

  const valueCompletion = completeLiteKql({ query: 'listings | where status == ', cursor: 'listings | where status == '.length });
  assert.ok(valueCompletion.suggestions.some((item) => item.label === 'pending'));
});
