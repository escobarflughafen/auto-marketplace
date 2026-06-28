const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGoofishSearchUrl,
  canonicalizeGoofishItemUrl,
  classifyGoofishAccessStatus,
  extractGoofishApiItems,
  goofishItemIdFromUrl,
  goofishListingId,
  parseArgs,
  shouldRetryGoofishSearchViaHomepage,
} = require('../scripts/collect-goofish-search-explorer');

test('Goofish search explorer builds search URL params', () => {
  assert.equal(
    buildGoofishSearchUrl('pentax 67', {
      page: 2,
      minPrice: 2000,
      maxPrice: 8000,
    }),
    'https://www.goofish.com/search?q=pentax+67&page=2&minPrice=2000&maxPrice=8000',
  );
});

test('Goofish item URLs canonicalize to stable item IDs', () => {
  const url = 'https://www.goofish.com/item?spm=a21ybx.search&id=1057648990425&categoryId=126864790';
  assert.equal(goofishItemIdFromUrl(url), '1057648990425');
  assert.equal(
    canonicalizeGoofishItemUrl(url),
    'https://www.goofish.com/item?id=1057648990425&categoryId=126864790',
  );
  assert.equal(goofishListingId('', url), 'goofish:1057648990425');
});

test('Goofish search explorer defaults to homepage DOM submission', () => {
  const options = parseArgs(['--query', 'pentax 67', '--once', '--headed']);
  assert.equal(options.preferHomepageSearch, true);
  assert.equal(options.headless, false);
  assert.equal(options.browserMode, 'headed');
  assert.equal(options.query, 'pentax 67');
  assert.equal(options.once, true);
});

test('Goofish search explorer supports cross-platform GUI browser mode', () => {
  const gui = parseArgs(['--query', 'pentax 67', '--browser-mode', 'gui']);
  assert.equal(gui.browserMode, 'gui');
  assert.equal(gui.headless, false);

  const xvfb = parseArgs(['--query', 'pentax 67', '--xvfb', '--xvfb-screen', '1600x1000x24']);
  assert.equal(xvfb.browserMode, 'xvfb');
  assert.equal(xvfb.headless, false);
  assert.equal(xvfb.xvfbScreen, '1600x1000x24');

  const headless = parseArgs(['--query', 'pentax 67', '--browser-mode', 'headless']);
  assert.equal(headless.browserMode, 'headless');
  assert.equal(headless.headless, true);
});

test('Goofish access status classifies Xianyu illegal browser interstitial as blocked', () => {
  const status = classifyGoofishAccessStatus({
    url: 'https://www.goofish.com/search?q=%E7%9B%B8%E6%9C%BA',
    title: '相机_闲鱼',
    text: '非法访问 为了保障您的体验，请使用正常浏览器访问闲鱼~ 关闭 反馈问题',
    hasItemLink: false,
  });

  assert.equal(status.isAccessBlocked, true);
  assert.equal(status.isChallenge, true);
  assert.equal(status.isLoadingOnly, false);
});

test('Goofish search explorer parses query targets', () => {
  const targets = JSON.stringify([
    { keyword: 'pentax 67', minPrice: '2000', maxPrice: '8000' },
    { keyword: '宾得67' },
  ]);
  const options = parseArgs(['--query-targets', targets, '--max-items', '10']);
  assert.deepEqual(options.seedQueries, ['pentax 67', '宾得67']);
  assert.equal(options.seedQueryTargets[0].minPrice, 2000);
  assert.equal(options.seedQueryTargets[0].maxPrice, 8000);
  assert.equal(options.collectAll, false);
  assert.equal(options.maxItems, 10);
});

test('Goofish search explorer extracts MTop search cards', () => {
  const payload = {
    data: {
      resultList: [
        {
          data: {
            item: {
              main: {
                clickParam: {
                  args: {
                    item_id: '1057648990425',
                    cCatId: '126864790',
                    displayPrice: '6880',
                    publishTime: '1781236484000',
                  },
                },
                exContent: {
                  area: '上海',
                  itemId: '1057648990425',
                  picUrl: 'https://img.example/item.jpg',
                  picWidth: 164,
                  picHeight: 218,
                  detailParams: {
                    itemId: '1057648990425',
                    userNick: '宾得67发烧友',
                    soldPrice: '6880',
                    title: 'SS级宾得67后期单机身',
                  },
                  fishTags: {
                    r2: { tagList: [{ data: { content: '几乎全新' } }, { data: { content: 'Pentax/宾得' } }] },
                    r3: { tagList: [{ data: { content: '8人想要' } }] },
                    r5: { tagList: [{ data: { content: 'nfrIcon' } }] },
                  },
                },
                targetUrl: 'fleamarket://item?id=1057648990425',
              },
            },
          },
        },
      ],
    },
  };

  const items = extractGoofishApiItems(payload);
  assert.equal(items.length, 1);
  assert.equal(items[0].listingId, 'goofish:1057648990425');
  assert.equal(items[0].href, 'https://www.goofish.com/item?id=1057648990425&categoryId=126864790');
  assert.equal(items[0].title, 'SS级宾得67后期单机身');
  assert.equal(items[0].price, '¥6880');
  assert.equal(items[0].location, '上海');
  assert.equal(items[0].seller, '宾得67发烧友');
  assert.equal(items[0].wants, '8人想要');
  assert.deepEqual(items[0].tags, ['几乎全新', 'Pentax/宾得']);
  assert.equal(items[0].photos[0].source, 'goofish_search_card');
});

test('Goofish search explorer retries loading-only direct pages through homepage search', () => {
  assert.equal(shouldRetryGoofishSearchViaHomepage({ isLoadingOnly: true, isChallenge: false }, 1), true);
  assert.equal(shouldRetryGoofishSearchViaHomepage({ isErrorPage: true, isChallenge: false }, 1), true);
  assert.equal(shouldRetryGoofishSearchViaHomepage({ isLoadingOnly: true, isChallenge: true }, 1), false);
  assert.equal(shouldRetryGoofishSearchViaHomepage({ isLoadingOnly: true, isChallenge: false }, 2), false);
});
