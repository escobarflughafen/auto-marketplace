const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  openMarketplaceHomepageDatabase,
  upsertHomepageListing,
  closeMarketplaceHomepageDatabase,
} = require('../scripts/marketplace-homepage-db');
const sqliteQueries = require('../scripts/marketplace-homepage-query');
const {
  postgresLiteral,
  inlinePostgresParams,
  wrapRowsJsonSql,
  normalizeRows,
  diffValues,
  compareShadow,
} = require('../scripts/compare-marketplace-postgres-shadow');

function createTempDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-shadow-compare-'));
  const dbPath = path.join(tempDir, 'marketplace.db');
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  upsertHomepageListing(db, {
    listing_id: 'listing-a',
    href: 'https://www.facebook.com/marketplace/item/1001/',
    source: 'search',
    source_keyword: 'leica',
    card_title: 'Leica M6 body',
    card_text: 'CA$ 2400 Vancouver',
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-03T00:00:00.000Z',
    detail_status: 'done',
    detail_completed_at: '2026-01-03T00:00:00.000Z',
    detail_title: 'Leica M6 body',
    detail_price: 'CA$ 2400',
    detail_location: 'Vancouver',
    detail_listed_ago: '2 hours ago',
    snapshot_path: '/tmp/listing-a.md',
  });
  upsertHomepageListing(db, {
    listing_id: 'listing-b',
    href: 'https://www.facebook.com/marketplace/item/1002/',
    source: 'search',
    source_keyword: 'pentax',
    card_title: 'Pentax 67 kit',
    card_text: 'CA$ 1200 Burnaby',
    first_seen_at: '2026-01-02T00:00:00.000Z',
    last_seen_at: '2026-01-04T00:00:00.000Z',
    detail_status: 'pending',
    detail_title: 'Pentax 67 kit',
    detail_price: 'CA$ 1200',
    detail_location: 'Burnaby',
  });
  closeMarketplaceHomepageDatabase(db);
  return { tempDir, dbPath };
}

function createSqliteBackedPsqlRunner(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    runner(_cmd, args) {
      const sql = args[args.indexOf('-c') + 1];
      const query = sql.includes("detail_status = 'pending'")
        ? 'status:pending'
        : sql.includes('pentax')
          ? 'listings | where title contains "pentax" and price >= 1000 | sort by price desc | take 10'
          : sql.includes('leica')
            ? 'title contains "leica" and price >= 500'
            : '';
      const limit = sql.includes('LIMIT 10') ? 10 : 10;
      let rows;
      if (/COUNT\(\*\) AS total/.test(sql)) {
        const spec = sqliteQueries.buildCountQuery({ query });
        rows = [db.prepare(spec.sql).get(...spec.params) || {}];
      } else if (/COUNT\(\*\) AS "totalRows"/.test(sql) || /COUNT\(\*\) AS totalRows/.test(sql)) {
        const spec = sqliteQueries.buildListingsStatsQueries({ query }).priceSummary;
        rows = [db.prepare(spec.sql).get(...spec.params) || {}];
      } else {
        const spec = sqliteQueries.buildListingsQuery({ query, limit, offset: 0, sort: query.includes('leica') ? 'price' : 'recent', sortDirection: query.includes('leica') ? 'desc' : '' });
        rows = db.prepare(spec.sql).all(...spec.params);
      }
      return {
        status: 0,
        stdout: `${JSON.stringify(normalizeRows(rows))}\n`,
        stderr: '',
      };
    },
    close() {
      db.close();
    },
  };
}

test('inlinePostgresParams safely renders PostgreSQL literals', () => {
  assert.equal(postgresLiteral("Bob's Camera"), "'Bob''s Camera'");
  assert.equal(postgresLiteral(42), '42');
  assert.equal(postgresLiteral(null), 'NULL');
  assert.equal(
    inlinePostgresParams('SELECT $1 AS a, $10 AS j, $2 AS b', ['x', "Bob's", 3, 4, 5, 6, 7, 8, 9, 'ten']),
    "SELECT 'x' AS a, 'ten' AS j, 'Bob''s' AS b",
  );
  assert.throws(() => inlinePostgresParams('SELECT $2', ['only-one']), /Missing PostgreSQL parameter/);
});

test('wrapRowsJsonSql creates a psql JSON row envelope', () => {
  assert.equal(
    wrapRowsJsonSql('SELECT listing_id FROM homepage_listings'),
    "SELECT COALESCE(json_agg(row_to_json(_shadow_rows)), '[]'::json) AS rows FROM (SELECT listing_id FROM homepage_listings) _shadow_rows",
  );
});

test('diffValues compares objects with stable key order', () => {
  assert.equal(diffValues({ b: 2, a: 1 }, { a: 1, b: 2 }), null);
  assert.deepEqual(diffValues({ a: 1 }, { a: 2 }), { expected: { a: 1 }, actual: { a: 2 } });
});

test('compareShadow reports matching SQLite and PostgreSQL shadow probes', () => {
  const { dbPath } = createTempDb();
  const fake = createSqliteBackedPsqlRunner(dbPath);
  try {
    const report = compareShadow({
      sqliteDb: dbPath,
      postgresUrl: 'postgres://shadow.example/marketplace',
      queries: ['status:pending'],
      limit: 10,
      failFast: true,
    }, fake.runner);
    assert.equal(report.ok, true);
    assert.equal(report.failed, 0);
    assert.equal(report.probes.length, 1);
    assert.ok(report.probes[0].checks.every((check) => check.ok));
  } finally {
    fake.close();
  }
});
