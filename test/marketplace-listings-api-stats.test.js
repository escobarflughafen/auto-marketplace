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
  upsertSavedQuery,
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

test('summary API reuses projection and saved query count caches', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    seedListing(db, 'pentax-summary-1000', 1000, 'pending');
    seedListing(db, 'pentax-summary-2000', 2000, 'done');
    seedListing(db, 'leica-summary-3000', 3000, 'done');
    db.prepare(`
      UPDATE homepage_listings
      SET card_title = 'Leica listing leica-summary-3000',
          card_text = 'CA$3000 | Leica listing leica-summary-3000'
      WHERE listing_id = 'leica-summary-3000'
    `).run();
    upsertSavedQuery(db, {
      label: 'Pentax',
      query: 'listings | where title contains "Pentax"',
      showInOverview: true,
    });
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
    const first = await getJson(baseUrl, '/api/summary?token=admin-token');
    assert.equal(first.status, 200);
    assert.equal(first.body.cache.cached, false);
    assert.equal(first.body.totalRows, 3);
    assert.equal(first.body.savedQueryCards.length, 1);
    assert.equal(first.body.savedQueryCards[0].value, 2);
    assert.equal(first.body.savedQueryCards[0].cache.cached, false);

    const second = await getJson(baseUrl, '/api/summary?token=admin-token');
    assert.equal(second.status, 200);
    assert.equal(second.body.cache.cached, true);
    assert.equal(second.body.totalRows, 3);
    assert.equal(second.body.savedQueryCards[0].value, 2);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('listings API extracts localized card text prices for numeric filters', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    upsertHomepageListing(db, {
      listingId: 'localized-price-950',
      href: 'https://www.facebook.com/marketplace/item/localized-price-950/',
      title: 'AF-S NIKKOR 14-24MM f/2.8G ED',
      text: '未读AF-S NIKKOR 14-24MM f/2.8G ED 上架了，价格：CA$ 950.00。21小时·附近',
      rank: 1,
      source: 'search',
    }, { source: 'search' });
    upsertHomepageListing(db, {
      listingId: 'pipe-price-85',
      href: 'https://www.facebook.com/marketplace/item/pipe-price-85/',
      title: 'Nikon Nikkor Non-Ai 50mm f/2 F mount Lens',
      text: '刚刚上架 | CA$ 85 | Nikon Nikkor Non-Ai 50mm f/2 F mount Lens | BCVictoria',
      rank: 2,
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
      '/api/listings?token=admin-token&q=listings%20%7C%20where%20price%20%3E%3D%20900%20%7C%20sort%20by%20price%20desc&limit=10&offset=0',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.rows[0].listing_id, 'localized-price-950');
    assert.equal(response.body.rows[0].numeric_price, 950);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('listings APIs can read through an injected listing read store', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const calls = [];
  let closed = false;
  const listingReadStore = {
    dialect: 'postgres',
    async listListings(options = {}) {
      calls.push({ method: 'listListings', options });
      return {
        query: options.query || '',
        parsedQuery: { dialect: 'postgres', sort: 'recent', sortDirection: 'desc' },
        sort: 'recent',
        sortDirection: 'desc',
        limit: 2,
        offset: 1,
        total: 7,
        rows: [{
          listing_id: 'pg-listing-1',
          href: 'https://www.facebook.com/marketplace/item/pg-listing-1/',
          card_title: 'Postgres listing',
          card_text: 'CA$1200 | Postgres listing',
          detail_status: 'pending',
          numeric_price: '1200',
          screenshot_path: '',
          snapshot_path: '',
        }],
      };
    },
    async readListingsResultStats(options = {}) {
      calls.push({ method: 'readListingsResultStats', options });
      return {
        pricedCount: 6,
        unpricedCount: 1,
        priceMin: 100,
        priceMax: 1200,
        priceAverage: 400,
        priceMedian: 350,
        priceHistogram: [{ min: 100, max: 1200, count: 6 }],
        statusCounts: [['pending', 6]],
        sourceCounts: [['search', 7]],
      };
    },
    async close() {
      closed = true;
    },
  };

  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    listingReadStore,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const response = await getJson(
      baseUrl,
      '/api/listings?token=admin-token&q=status%3Apending&limit=2&offset=1&excludeListingId=skip-a',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 7);
    assert.equal(response.body.rows[0].listing_id, 'pg-listing-1');
    assert.equal(response.body.parsedQuery.dialect, 'postgres');
    assert.deepEqual(calls[0], {
      method: 'listListings',
      options: {
        query: 'status:pending',
        limit: '2',
        offset: '1',
        sort: '',
        sortDirection: '',
        excludeListingIds: ['skip-a'],
      },
    });

    const statsResponse = await getJson(
      baseUrl,
      '/api/listings/stats?token=admin-token&q=status%3Apending&excludeListingId=skip-a',
    );
    assert.equal(statsResponse.status, 200);
    assert.equal(statsResponse.body.resultStats.pricedCount, 6);
    assert.deepEqual(calls[1], {
      method: 'readListingsResultStats',
      options: {
        query: 'status:pending',
        excludeListingIds: ['skip-a'],
      },
    });
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(closed, true);
});
