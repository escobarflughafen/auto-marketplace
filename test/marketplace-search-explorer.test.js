const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertSearchTitleBagKeyword,
} = require('../scripts/marketplace-homepage-db');
const {
  parseArgs,
  pickSearchCardTitle,
  filterBagKeywordsFromItems,
  computeNextSeedRound,
  chooseRoundQuery,
} = require('../scripts/collect-marketplace-search-explorer');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-search-explorer-'));
  return path.join(tempDir, 'queue.db');
}

test('parseArgs infers Ottawa area slug when location is provided', () => {
  const options = parseArgs([
    '--query', 'leica m6',
    '--location', 'Ottawa, Ontario',
    '--once',
  ]);

  assert.equal(options.query, 'leica m6');
  assert.equal(options.location, 'Ottawa, Ontario');
  assert.equal(options.area, 'ottawa');
  assert.equal(options.once, true);
});

test('parseArgs preserves explicit area when location is also provided', () => {
  const options = parseArgs([
    '--query', 'leica m6',
    '--location', 'Ottawa, Ontario',
    '--area', 'toronto',
  ]);

  assert.equal(options.area, 'toronto');
  assert.equal(options.location, 'Ottawa, Ontario');
});

test('parseArgs reads search radius miles', () => {
  const options = parseArgs([
    '--query', 'canon 85 1.4',
    '--location', 'Bellingham, Washington',
    '--radius-miles', '10',
  ]);

  assert.equal(options.location, 'Bellingham, Washington');
  assert.equal(options.area, 'bellingham');
  assert.equal(options.radiusMiles, 10);
});

test('pickSearchCardTitle skips freshness and price lines', () => {
  const title = pickSearchCardTitle([
    '刚刚上架',
    'CA$ 3,800',
    'Leica M6 Classic 0.72 Black',
    'Vancouver, BC',
  ]);

  assert.equal(title, 'Leica M6 Classic 0.72 Black');
});

test('filterBagKeywordsFromItems keeps titles within configured length', () => {
  const keywords = filterBagKeywordsFromItems([
    { title: 'Nikon D850 body' },
    { title: 'x' },
    { title: 'A'.repeat(200) },
  ], {
    bagMinKeywordLength: 5,
    bagMaxKeywordLength: 40,
  });

  assert.deepEqual(keywords, ['Nikon D850 body']);
});

test('computeNextSeedRound stays within configured reseed interval', () => {
  for (let index = 0; index < 20; index += 1) {
    const nextRound = computeNextSeedRound(5, 10, 20);
    assert.ok(nextRound >= 15);
    assert.ok(nextRound <= 25);
  }
});

test('chooseRoundQuery uses seed on first round and bag keywords on later rounds', async () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertSearchTitleBagKeyword(db, 'Pentax 67 body', {
      sourceKeyword: 'pentax 67',
      seenAt: '2026-04-29T00:00:00.000Z',
    });

    const seedQuery = await chooseRoundQuery(db, {
      roundNumber: 1,
      nextSeedRound: 1,
    }, {
      query: 'pentax 67',
      reseedRoundMin: 10,
      reseedRoundMax: 20,
      bagMinTimesSeen: 1,
    });
    assert.equal(seedQuery.query, 'pentax 67');
    assert.equal(seedQuery.querySource, 'seed');
    assert.ok(seedQuery.nextSeedRound >= 11);
    assert.ok(seedQuery.nextSeedRound <= 21);

    const bagQuery = await chooseRoundQuery(db, {
      roundNumber: 2,
      nextSeedRound: 15,
    }, {
      query: 'pentax 67',
      reseedRoundMin: 10,
      reseedRoundMax: 20,
      bagMinTimesSeen: 1,
    });
    assert.equal(bagQuery.query, 'Pentax 67 body');
    assert.equal(bagQuery.querySource, 'bag');
    assert.equal(bagQuery.nextSeedRound, 15);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
