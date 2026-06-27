const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const {
  buildMarketplaceKeywordSearchUrl,
  parseArgs,
  parseKeywordTargets,
  runCycle,
} = require('../scripts/collect-marketplace-homepage');
const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  listListingMedia,
} = require('../scripts/marketplace-homepage-db');

function createTempDir(prefix = 'homepage-collector-regression-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFixtureServer() {
  const html = `<!doctype html>
    <html>
      <head><title>Marketplace Fixture</title></head>
      <body>
        <main role="main">
          <h1>Marketplace collector regression fixture with enough visible text for readiness checks</h1>
          <div role="article">
            <a href="https://www.facebook.com/marketplace/item/111111111111111/">
              <img src="/media/leica.jpg" alt="Leica camera front" width="640" height="480">
              <span>CA$ 1,250</span>
              <span>Mint Leica M6 classic rangefinder body</span>
              <span>Listed 2 hours ago</span>
            </a>
          </div>
          <div role="article">
            <a href="https://www.facebook.com/marketplace/item/222222222222222/?ref=search">
              <img src="/media/pentax.jpg" alt="Pentax lens boxed" width="800" height="600">
              <span>CA$ 450</span>
              <span>Pentax 67 105mm f2.4 lens boxed</span>
              <span>Today</span>
            </a>
          </div>
          <div role="article">
            <a href="https://www.facebook.com/marketplace/item/111111111111111/?duplicate=1">
              Duplicate Leica card should be ignored
            </a>
          </div>
        </main>
      </body>
    </html>`;
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGOSHzRgAAAAABJRU5ErkJggg==',
    'base64',
  );
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/media/')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(image);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  return server;
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

test('parseArgs reads homepage location flags', () => {
  const options = parseArgs([
    '--location', 'Ottawa, Ontario',
    '--radius-miles', '10',
    '--use-credentials',
    '--once',
    '--max-items', '5',
  ]);

  assert.equal(options.location, 'Ottawa, Ontario');
  assert.equal(options.radiusMiles, 10);
  assert.equal(options.useCredentials, true);
  assert.equal(options.authMode, 'credentials');
  assert.equal(options.once, true);
  assert.equal(options.maxItems, 5);
  assert.equal(options.startUrl, 'https://www.facebook.com/marketplace/ottawa/');
});

test('parseArgs supports unauthenticated homepage collection', () => {
  const options = parseArgs(['--unauthenticated', '--once']);

  assert.equal(options.authMode, 'none');
  assert.equal(options.useCredentials, false);
});

test('parseArgs reads homepage collector worker id', () => {
  const options = parseArgs(['--worker-id', 'collector-run-1', '--once']);

  assert.equal(options.workerId, 'collector-run-1');
});

test('parseArgs reads homepage collector live screenshot options', () => {
  const options = parseArgs([
    '--worker-screenshot-dir', 'tmp/screens',
    '--worker-screenshot-interval-seconds', '10',
    '--worker-screenshot-history-limit', '100',
    '--worker-screenshot-format', 'jpg',
    '--worker-screenshot-quality', '70',
  ]);

  assert.equal(options.workerScreenshotDir, 'tmp/screens');
  assert.equal(options.workerScreenshotIntervalSeconds, 10);
  assert.equal(options.workerScreenshotHistoryLimit, 100);
  assert.equal(options.workerScreenshotFormat, 'jpeg');
  assert.equal(options.workerScreenshotQuality, 70);
});

test('parseArgs builds homepage route URLs for major city locations', () => {
  assert.equal(
    parseArgs(['--location', 'Montreal, Quebec']).startUrl,
    'https://www.facebook.com/marketplace/montreal/',
  );
  assert.equal(
    parseArgs(['--location', 'Calgary, Alberta']).startUrl,
    'https://www.facebook.com/marketplace/calgary/',
  );
  assert.equal(
    parseArgs(['--location', 'New York, NY']).startUrl,
    'https://www.facebook.com/marketplace/nyc/',
  );
  assert.equal(
    parseArgs(['--location', 'Sydney, NSW']).startUrl,
    'https://www.facebook.com/marketplace/sydney/',
  );
  assert.equal(
    parseArgs(['--location', 'Gold Coast, Queensland']).startUrl,
    'https://www.facebook.com/marketplace/gold-coast/',
  );
});

test('parseArgs keeps custom homepage locations on the generic Marketplace URL', () => {
  const options = parseArgs(['--location', 'Some Custom City, BC']);

  assert.equal(options.location, 'Some Custom City, BC');
  assert.equal(options.startUrl, 'https://www.facebook.com/marketplace/');
});

test('parseArgs reads homepage collector keyword targets', () => {
  const rawTargets = JSON.stringify([
    {
      keyword: 'leica m6',
      location: 'Sydney, NSW',
      minPrice: '1000',
      maxPrice: '4000',
      daysSinceListed: '30',
      itemCondition: 'used_like_new',
      maxItems: '12',
    },
    { keyword: 'nikon f3', maxPrice: 900 },
  ]);
  const options = parseArgs(['--keyword-targets', rawTargets, '--location', 'Vancouver, BC']);

  assert.equal(options.keywordTargets.length, 2);
  assert.deepEqual(options.keywordTargets[0], {
    keyword: 'leica m6',
    location: 'Sydney, NSW',
    minPrice: 1000,
    maxPrice: 4000,
    daysSinceListed: 30,
    itemCondition: 'used_like_new',
    maxItems: 12,
  });
  assert.equal(options.keywordTargets[1].keyword, 'nikon f3');
  assert.equal(options.keywordTargets[1].maxPrice, 900);
});

test('parseKeywordTargets rejects invalid per-keyword price ranges', () => {
  assert.throws(
    () => parseKeywordTargets(JSON.stringify([{ keyword: 'pentax', minPrice: 2000, maxPrice: 1000 }])),
    /maxPrice to be >= minPrice/,
  );
});

test('buildMarketplaceKeywordSearchUrl builds non-rental search URLs with per-keyword parameters', () => {
  const url = new URL(buildMarketplaceKeywordSearchUrl({
    keyword: 'mamiya rz67',
    location: 'Melbourne, VIC',
    minPrice: 500,
    maxPrice: 2500,
    daysSinceListed: 7,
    itemCondition: 'new,used_like_new',
  }));

  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/marketplace/melbourne/search');
  assert.equal(url.searchParams.get('query'), 'mamiya rz67');
  assert.equal(url.searchParams.get('minPrice'), '500');
  assert.equal(url.searchParams.get('maxPrice'), '2500');
  assert.equal(url.searchParams.get('daysSinceListed'), '7');
  assert.equal(url.searchParams.get('itemCondition'), 'new,used_like_new');
  assert.equal(url.searchParams.get('exact'), 'false');
});

test('homepage collector cycle stores real card rows, media, events, and snapshot', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'collector-regression.db');
  const logFile = path.join(tempDir, 'collector.log');
  const snapshotFile = path.join(tempDir, 'cycle.json');
  const server = createFixtureServer();
  const address = await listen(server);
  const startUrl = `http://${address.address}:${address.port}/marketplace/`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const options = parseArgs([
      '--start-url',
      startUrl,
      '--db-path',
      dbPath,
      '--log-file',
      logFile,
      '--snapshot-file',
      snapshotFile,
      '--worker-id',
      'homepage-collector-regression',
      '--max-items',
      '2',
      '--first-load-only',
      '--initial-load-wait-ms',
      '0',
      '--max-runtime-seconds',
      '5',
      '--once',
    ]);

    const { cycleSummary } = await runCycle(page, db, options);
    assert.equal(cycleSummary.totalCollected, 2);
    assert.equal(cycleSummary.outcomeCounts.new, 2);
    assert.equal(cycleSummary.collectionStats.stopReason, 'max_items');
    assert.deepEqual(
      cycleSummary.items.map((item) => item.listingId),
      ['111111111111111', '222222222222222'],
    );

    const rows = db.prepare(`
      SELECT listing_id, href, source, card_title, card_text, detail_status, last_seen_rank
      FROM homepage_listings
      ORDER BY last_seen_rank ASC
    `).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].listing_id, '111111111111111');
    assert.equal(rows[0].href, 'https://www.facebook.com/marketplace/item/111111111111111/');
    assert.equal(rows[0].source, 'homepage');
    assert.match(rows[0].card_title, /Leica M6/i);
    assert.match(rows[0].card_text, /CA\$ 1,250/);
    assert.equal(rows[0].detail_status, 'pending');
    assert.equal(rows[0].last_seen_rank, 1);

    const firstMedia = listListingMedia(db, '111111111111111');
    assert.equal(firstMedia.length, 1);
    assert.match(firstMedia[0].source_url, /\/media\/leica\.jpg$/);
    assert.equal(firstMedia[0].alt_text, 'Leica camera front');

    const listingEvents = db.prepare(`
      SELECT listing_id, event_type, status
      FROM listing_events
      WHERE workflow_run_id = ?
      ORDER BY listing_id ASC
    `).all('homepage-collector-regression').map((row) => ({ ...row }));
    assert.deepEqual(listingEvents, [
      { listing_id: '111111111111111', event_type: 'listing_observed', status: 'new' },
      { listing_id: '222222222222222', event_type: 'listing_observed', status: 'new' },
    ]);

    const workflowEvents = db.prepare(`
      SELECT event_type, status
      FROM workflow_events
      WHERE workflow_run_id = ?
      ORDER BY event_at ASC
    `).all('homepage-collector-regression');
    assert.deepEqual(workflowEvents.map((event) => event.event_type), [
      'collector_cycle_started',
      'collector_cycle_completed',
    ]);
    assert.equal(workflowEvents[1].status, 'completed');

    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    assert.equal(snapshot.totalCollected, 2);
    assert.equal(snapshot.counts.pending, 2);
    assert.match(fs.readFileSync(logFile, 'utf8'), /cycle_done collected=2/);
  } finally {
    closeMarketplaceHomepageDatabase(db);
    await browser.close();
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
