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
  parseKeywordList,
  parseSearchQueryTargets,
  buildSearchUrl,
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

test('parseArgs keeps custom search locations on the default area until UI location is applied', () => {
  const options = parseArgs([
    '--query', 'leica m6',
    '--location', 'Some Custom City, BC',
  ]);

  assert.equal(options.location, 'Some Custom City, BC');
  assert.equal(options.area, 'vancouver');
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

test('parseArgs reads search filter flags', () => {
  const options = parseArgs([
    '--query', 'leica m6',
    '--min-price', '1000',
    '--max-price', '4000',
    '--days-since-listed', '30',
    '--item-condition', 'used_like_new',
  ]);

  assert.equal(options.minPrice, 1000);
  assert.equal(options.maxPrice, 4000);
  assert.equal(options.daysSinceListed, 30);
  assert.equal(options.itemCondition, 'used_like_new');
});

test('parseArgs rejects inverted search price filters', () => {
  assert.throws(
    () => parseArgs(['--query', 'leica m6', '--min-price', '4000', '--max-price', '1000']),
    /--max-price to be >= --min-price/,
  );
});

test('parseArgs supports unauthenticated search exploration', () => {
  const options = parseArgs(['--query', 'nikon', '--auth-mode', 'none']);

  assert.equal(options.authMode, 'none');
});

test('parseKeywordList accepts comma, semicolon, and newline separated seeds', () => {
  assert.deepEqual(
    parseKeywordList(' leica m6, nikon d850\npentax 67; canon r5 '),
    ['leica m6', 'nikon d850', 'pentax 67', 'canon r5'],
  );
});

test('parseArgs reads round-robin seed queries and random walk count', () => {
  const options = parseArgs([
    '--query', 'fallback',
    '--queries', 'leica m6\nnikon d850\npentax 67',
    '--random-walks-between-seeds', '2',
  ]);

  assert.equal(options.query, 'leica m6');
  assert.deepEqual(options.seedQueries, ['leica m6', 'nikon d850', 'pentax 67']);
  assert.equal(options.randomWalksBetweenSeedsMin, 2);
  assert.equal(options.randomWalksBetweenSeedsMax, 2);
});

test('parseArgs reads per-keyword search query targets', () => {
  const targets = JSON.stringify([
    { keyword: 'leica m6', minPrice: '1000', maxPrice: '4000' },
    { keyword: 'nikon d850', minPrice: '200', maxPrice: '1200' },
  ]);
  const options = parseArgs([
    '--query-targets', targets,
    '--random-walks-between-seeds', '2',
    '--days-since-listed', '30',
    '--item-condition', 'used_like_new',
  ]);

  assert.equal(options.query, 'leica m6');
  assert.deepEqual(options.seedQueries, ['leica m6', 'nikon d850']);
  assert.deepEqual(options.seedQueryTargets, [
    { keyword: 'leica m6', minPrice: 1000, maxPrice: 4000 },
    { keyword: 'nikon d850', minPrice: 200, maxPrice: 1200 },
  ]);
  assert.equal(options.daysSinceListed, 30);
  assert.equal(options.itemCondition, 'used_like_new');
});

test('parseSearchQueryTargets rejects inverted per-keyword prices', () => {
  assert.throws(
    () => parseSearchQueryTargets('[{"keyword":"leica","minPrice":4000,"maxPrice":1000}]'),
    /maxPrice to be >= minPrice/,
  );
});

test('buildSearchUrl keeps filters for seed searches and strips them for random walks', () => {
  const template = 'https://www.facebook.com/marketplace/%AREA%/search?query=%QUERY%&minPrice=1000&maxPrice=4000&daysSinceListed=30&itemCondition=used_like_new&exact=false';
  const seedUrl = new URL(buildSearchUrl('vancouver', 'leica m6', template, {
    filters: {
      minPrice: 1200,
      maxPrice: 4200,
      daysSinceListed: 7,
      itemCondition: 'new',
    },
  }));
  assert.equal(seedUrl.searchParams.get('query'), 'leica m6');
  assert.equal(seedUrl.searchParams.get('minPrice'), '1200');
  assert.equal(seedUrl.searchParams.get('maxPrice'), '4200');
  assert.equal(seedUrl.searchParams.get('daysSinceListed'), '7');
  assert.equal(seedUrl.searchParams.get('itemCondition'), 'new');
  assert.equal(seedUrl.searchParams.get('exact'), 'false');

  const walkUrl = new URL(buildSearchUrl('vancouver', 'summicron lens', template, {
    filters: {
      minPrice: 1200,
      maxPrice: 4200,
      daysSinceListed: 7,
      itemCondition: 'new',
    },
    stripFilters: true,
  }));
  assert.equal(walkUrl.searchParams.get('query'), 'summicron lens');
  assert.equal(walkUrl.searchParams.has('minPrice'), false);
  assert.equal(walkUrl.searchParams.has('maxPrice'), false);
  assert.equal(walkUrl.searchParams.get('daysSinceListed'), '7');
  assert.equal(walkUrl.searchParams.get('itemCondition'), 'new');
  assert.equal(walkUrl.searchParams.get('exact'), 'false');
});

test('parseArgs reads search explorer worker id', () => {
  const options = parseArgs(['--query', 'nikon', '--worker-id', 'search-run-1']);

  assert.equal(options.workerId, 'search-run-1');
});

test('parseArgs reads search explorer live screenshot options', () => {
  const options = parseArgs([
    '--query', 'nikon',
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

test('parseArgs infers major city area slugs for search explorer', () => {
  assert.equal(parseArgs(['--query', 'nikon', '--location', 'Montreal, Quebec']).area, 'montreal');
  assert.equal(parseArgs(['--query', 'nikon', '--location', 'Calgary, Alberta']).area, 'calgary');
  assert.equal(parseArgs(['--query', 'nikon', '--location', 'New York, NY']).area, 'nyc');
  assert.equal(parseArgs(['--query', 'nikon', '--location', 'Vancouver, WA']).area, 'vancouver-wa');
  assert.equal(parseArgs(['--query', 'nikon', '--location', 'Sydney, NSW']).area, 'sydney');
  assert.equal(parseArgs(['--query', 'nikon', '--location', 'Gold Coast, Queensland']).area, 'gold-coast');
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

test('filterBagKeywordsFromItems cleans Marketplace card UI text', () => {
  const keywords = filterBagKeywordsFromItems([
    { title: '未读Lenovo ThinkPad X13 Gen 5 Ultra 7 165 上架了，价格：CA$ 949.00。2周·降价' },
    { title: 'CA$ 950 | AF-S NIKKOR 14-24MM f/2.8G ED | Vancouver' },
    { title: '未读Various Lenses 上架了，价格：CA$ 50.00。1周·附近' },
  ], {
    bagMinKeywordLength: 5,
    bagMaxKeywordLength: 160,
  });

  assert.deepEqual(keywords, [
    'Lenovo ThinkPad X13 Gen 5 Ultra 7 165',
    'AF-S NIKKOR 14-24MM f/2.8G ED',
    'Various Lenses',
  ]);
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

test('chooseRoundQuery rotates seed list with random walks from previous round candidates', async () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  const options = {
    query: 'leica m6',
    seedQueries: ['leica m6', 'nikon d850'],
    seedQueryTargets: [
      { keyword: 'leica m6', minPrice: 1000, maxPrice: 4000 },
      { keyword: 'nikon d850', minPrice: 200, maxPrice: 1200 },
    ],
    keywordListProvided: true,
    randomWalksBetweenSeedsMin: 2,
    randomWalksBetweenSeedsMax: 2,
    bagMinTimesSeen: 1,
  };
  const state = {
    roundNumber: 1,
    nextSeedRound: 1,
    seedIndex: 0,
    randomWalksRemaining: 0,
    randomWalkCandidates: [],
  };

  try {
    const firstSeed = await chooseRoundQuery(db, state, options);
    assert.equal(firstSeed.query, 'leica m6');
    assert.equal(firstSeed.querySource, 'seed_round_robin');
    assert.equal(firstSeed.seedIndex, 0);
    assert.equal(firstSeed.nextSeedIndex, 1);
    assert.equal(firstSeed.randomWalksRemaining, 2);
    assert.deepEqual(firstSeed.queryTarget, { keyword: 'leica m6', minPrice: 1000, maxPrice: 4000 });

    state.roundNumber += 1;
    state.randomWalkCandidates = ['Leica M6 Classic'];
    const firstWalk = await chooseRoundQuery(db, state, options);
    assert.equal(firstWalk.query, 'Leica M6 Classic');
    assert.equal(firstWalk.querySource, 'round_random_walk');
    assert.equal(firstWalk.randomWalkCandidateSource, 'previous_round_collected_titles');
    assert.equal(firstWalk.randomWalksRemaining, 1);
    assert.equal(firstWalk.queryTarget, null);

    state.roundNumber += 1;
    state.randomWalkCandidates = ['Leica M6 TTL'];
    const secondWalk = await chooseRoundQuery(db, state, options);
    assert.equal(secondWalk.query, 'Leica M6 TTL');
    assert.equal(secondWalk.querySource, 'round_random_walk');
    assert.equal(secondWalk.randomWalksRemaining, 0);

    state.roundNumber += 1;
    state.randomWalkCandidates = ['Ignored until next walk'];
    const secondSeed = await chooseRoundQuery(db, state, options);
    assert.equal(secondSeed.query, 'nikon d850');
    assert.equal(secondSeed.querySource, 'seed_round_robin');
    assert.equal(secondSeed.seedIndex, 1);
    assert.equal(secondSeed.nextSeedIndex, 0);
    assert.deepEqual(secondSeed.queryTarget, { keyword: 'nikon d850', minPrice: 200, maxPrice: 1200 });
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('chooseRoundQuery falls back to title bag when previous round has no random walk candidates', async () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  const options = {
    query: 'leica m6',
    seedQueries: ['leica m6', 'nikon d850'],
    keywordListProvided: true,
    randomWalksBetweenSeedsMin: 1,
    randomWalksBetweenSeedsMax: 1,
    bagMinTimesSeen: 1,
  };
  const state = {
    roundNumber: 2,
    nextSeedRound: 1,
    seedIndex: 1,
    randomWalksRemaining: 1,
    randomWalkCandidates: [],
  };

  try {
    upsertSearchTitleBagKeyword(db, 'Contax G2 kit', {
      sourceKeyword: 'contax',
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    const query = await chooseRoundQuery(db, state, options);
    assert.equal(query.query, 'Contax G2 kit');
    assert.equal(query.querySource, 'round_random_walk_bag_fallback');
    assert.equal(query.randomWalkCandidateSource, 'title_bag_fallback');
    assert.equal(query.randomWalksRemaining, 0);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
