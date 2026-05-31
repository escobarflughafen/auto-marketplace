const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
  getHomepageListing,
  listWorkflowEvents,
} = require('../scripts/marketplace-homepage-db');
const {
  parseArgs,
  runIndexCycle,
} = require('../scripts/index-marketplace-resolved-listings');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-indexer-'));
  return path.join(tempDir, 'indexer.db');
}

test('parseArgs reads backlog indexer worker flags', () => {
  const options = parseArgs([
    '--db-path', 'custom.db',
    '--limit', '25',
    '--all',
    '--once',
    '--poll-interval-seconds', '60',
    '--poll-jitter-min', '0.5',
    '--poll-jitter-max', '1.5',
    '--worker-id', 'indexer-run-1',
    '--json',
  ]);

  assert.equal(options.dbPath, 'custom.db');
  assert.equal(options.limit, 25);
  assert.equal(options.staleOnly, false);
  assert.equal(options.once, true);
  assert.equal(options.pollIntervalSeconds, 60);
  assert.equal(options.pollJitterMin, 0.5);
  assert.equal(options.pollJitterMax, 1.5);
  assert.equal(options.workerId, 'indexer-run-1');
  assert.equal(options.json, true);
});

test('runIndexCycle normalizes resolved listing metadata and writes workflow events', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'indexer-listed-time',
      href: 'https://www.facebook.com/marketplace/item/8101/',
      title: 'Indexer row',
      text: 'CA$ 100 | Indexer row',
      rank: 1,
    }, {
      seenAt: '2026-05-09T10:40:45.000Z',
    });
    db.prepare(`
      UPDATE homepage_listings
      SET detail_status = 'done',
        detail_listed_ago = '2 days ago'
      WHERE listing_id = ?
    `).run('indexer-listed-time');

    const summary = runIndexCycle(db, {
      limit: 10,
      staleOnly: true,
    }, 'indexer-run-1');
    const row = getHomepageListing(db, 'indexer-listed-time');
    const eventTypes = listWorkflowEvents(db, 'indexer-run-1').map((event) => event.event_type);

    assert.equal(summary.scanned, 1);
    assert.equal(summary.normalized, 1);
    assert.equal(row.detail_listed_at_unit, 'day');
    assert.equal(row.detail_listed_at_value, 2);
    assert.ok(eventTypes.includes('backlog_index_started'));
    assert.ok(eventTypes.includes('backlog_index_completed'));
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
