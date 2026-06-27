const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEbaySearchUrl,
  canonicalizeEbayItemUrl,
  ebayItemIdFromUrl,
  ebayListingId,
  parseArgs,
  shouldRetryEbaySearchViaHomepage,
} = require('../scripts/collect-ebay-search-collector');

test('eBay search collector builds keyword, page, and price URL params', () => {
  assert.equal(
    buildEbaySearchUrl('pentax 67 105', {
      page: 3,
      minPrice: 500,
      maxPrice: 2500,
    }),
    'https://www.ebay.com/sch/i.html?_nkw=pentax+67+105&_pgn=3&_udlo=500&_udhi=2500',
  );
});

test('eBay item URLs canonicalize to stable item IDs', () => {
  const url = 'https://www.ebay.com/itm/Leica-M6/358437497989?_skw=leica+m6&hash=abc';
  assert.equal(ebayItemIdFromUrl(url), '358437497989');
  assert.equal(canonicalizeEbayItemUrl(url), 'https://www.ebay.com/itm/358437497989');
  assert.equal(ebayListingId('', url), 'ebay:358437497989');
});

test('eBay search collector parses list query targets and options', () => {
  const targets = JSON.stringify([
    { keyword: 'pentax 67 105', minPrice: '500', maxPrice: '2500' },
    { keyword: 'leica m6' },
  ]);
  const options = parseArgs([
    '--query-targets', targets,
    '--max-pages', '4',
    '--no-collect-all',
    '--max-items', '25',
    '--once',
  ]);

  assert.deepEqual(options.seedQueries, ['pentax 67 105', 'leica m6']);
  assert.equal(options.seedQueryTargets[0].minPrice, 500);
  assert.equal(options.seedQueryTargets[0].maxPrice, 2500);
  assert.equal(options.maxPages, 4);
  assert.equal(options.collectAll, false);
  assert.equal(options.maxItems, 25);
  assert.equal(options.once, true);
});

test('eBay search collector retries direct access failures through homepage search', () => {
  assert.equal(shouldRetryEbaySearchViaHomepage({
    isErrorPage: true,
    isChallenge: false,
    hasLoginInput: false,
  }, 1), true);
  assert.equal(shouldRetryEbaySearchViaHomepage({
    isErrorPage: false,
    isChallenge: true,
    hasLoginInput: false,
  }, 1), false);
  assert.equal(shouldRetryEbaySearchViaHomepage({
    isErrorPage: true,
    isChallenge: false,
    hasLoginInput: true,
  }, 1), false);
  assert.equal(shouldRetryEbaySearchViaHomepage({
    isErrorPage: true,
    isChallenge: false,
    hasLoginInput: false,
  }, 2), false);
});
