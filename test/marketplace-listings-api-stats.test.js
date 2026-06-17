const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createServer,
} = require('../scripts/serve-marketplace-homepage');
const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
} = require('../scripts/marketplace-homepage-db');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-listings-api-stats-'));
  return {
    tempDir,
    dbPath: path.join(tempDir, 'marketplace.db'),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function seedListing(db, listingId, price, status, source = 'search') {
  upsertHomepageListing(db, {
    listingId,
    href: `https://www.facebook.com/marketplace/item/${listingId}/`,
    title: `Pentax listing ${listingId}`,
    text: `CA$${price} | Pentax listing ${listingId}`,
    rank: price,
    source,
  }, {
    seenAt: `2026-06-17T00:00:${String(price / 100).padStart(2, '0')}.000Z`,
    source,
  });
  db.prepare(`
    UPDATE homepage_listings
    SET detail_status = ?, detail_price = ?
    WHERE listing_id = ?
  `).run(status, `CA$${price}`, listingId);
}

test('listings API result stats describe the full query result, not only the current page', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    seedListing(db, 'pentax-1000', 1000, 'pending');
    seedListing(db, 'pentax-2000', 2000, 'done');
    seedListing(db, 'pentax-3000', 3000, 'done');
    upsertHomepageListing(db, {
      listingId: 'leica-9000',
      href: 'https://www.facebook.com/marketplace/item/leica-9000/',
      title: 'Leica listing',
      text: 'CA$9000 | Leica listing',
      rank: 4,
      source: 'search',
    }, { source: 'search' });
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }

  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const response = await getJson(
      baseUrl,
      '/api/listings?token=admin-token&q=listings%20%7C%20where%20title%20contains%20%22Pentax%22%20%7C%20sort%20by%20price%20asc&limit=1&offset=0',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.rows.length, 1);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.stats.resultStatsDeferred, true);
    assert.equal(response.body.stats.resultStats, undefined);

    const statsResponse = await getJson(
      baseUrl,
      '/api/listings/stats?token=admin-token&q=listings%20%7C%20where%20title%20contains%20%22Pentax%22%20%7C%20sort%20by%20price%20asc',
    );
    assert.equal(statsResponse.status, 200);

    const resultStats = statsResponse.body.resultStats;
    assert.equal(resultStats.pricedCount, 3);
    assert.equal(resultStats.unpricedCount, 0);
    assert.equal(resultStats.priceMin, 1000);
    assert.equal(resultStats.priceMax, 3000);
    assert.equal(resultStats.priceMedian, 2000);
    assert.equal(resultStats.priceHistogram.reduce((sum, bin) => sum + bin.count, 0), 3);
    assert.deepEqual(resultStats.statusCounts, [['done', 2], ['pending', 1]]);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
