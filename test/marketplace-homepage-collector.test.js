const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMarketplaceKeywordSearchUrl,
  parseArgs,
  parseKeywordTargets,
} = require('../scripts/collect-marketplace-homepage');

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
