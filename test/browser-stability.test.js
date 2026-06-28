const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChromiumLaunchOptions,
  buildMarketplaceRadiusPatterns,
  resolveBrowserDisplayMode,
  defaultChromiumArgs,
  getKnownMarketplaceAreaFromLocation,
  getMarketplaceLocationOptions,
  inferMarketplaceAreaFromLocation,
  normalizeRadiusMiles,
  safeGotoWithOptions,
  setMarketplaceLocation,
  waitForPageReady,
  scrollMarketplaceResults,
  expandMarketplaceListingDetails,
  detectListingUnavailable,
  detectListingUnavailableUrl,
  detectListingUnavailablePage,
  detectListingAvailability,
  extractListingContent,
  readListingDetailPanelText,
  urlMatchesMarketplaceArea,
} = require('../scripts/marketplace-utils');

test('buildChromiumLaunchOptions appends configured Chromium args without duplicates', () => {
  const options = buildChromiumLaunchOptions(
    { args: ['--existing', '--disable-dev-shm-usage'] },
    { AUTO_BROWSER_CHROMIUM_ARGS: '--extra-flag --existing' },
  );

  assert.equal(options.args.filter((arg) => arg === '--existing').length, 1);
  assert.ok(options.args.includes('--extra-flag'));
});

test('defaultChromiumArgs reads AUTO_BROWSER_CHROMIUM_ARGS', () => {
  assert.ok(defaultChromiumArgs({ AUTO_BROWSER_CHROMIUM_ARGS: '--foo --bar' }).includes('--foo'));
  assert.ok(defaultChromiumArgs({ AUTO_BROWSER_CHROMIUM_ARGS: '--foo --bar' }).includes('--bar'));
});

test('resolveBrowserDisplayMode maps GUI mode to headed browser with managed Linux display when needed', () => {
  const resolved = resolveBrowserDisplayMode(
    { browserMode: 'gui', xvfbDisplay: ':77', xvfbScreen: '1600x1000x24' },
    {},
  );
  assert.equal(resolved.headless, false);
  assert.equal(resolved.browserMode, 'gui');
  assert.equal(resolved.useManagedXvfb, process.platform === 'linux');
  if (process.platform === 'linux') {
    assert.equal(resolved.display, ':77');
    assert.equal(resolved.xvfbScreen, '1600x1000x24');
  }

  const headedWithDisplay = resolveBrowserDisplayMode({ browserMode: 'gui' }, { DISPLAY: ':1' });
  assert.equal(headedWithDisplay.headless, false);
  assert.equal(headedWithDisplay.useManagedXvfb, false);
});

function createMockPage(name, behavior = {}) {
  const state = {
    name,
    gotoErrors: [...(behavior.gotoErrors || [])],
    visibleSelectors: new Set(behavior.visibleSelectors || ['body']),
    bodyLength: behavior.bodyLength ?? 200,
    evaluateResults: [...(behavior.evaluateResults || [])],
    calls: [],
  };

  const page = {
    state,
    isClosed() {
      return false;
    },
    async goto(url, options) {
      state.calls.push({ type: 'goto', url, options });
      const nextError = state.gotoErrors.shift();
      if (nextError) {
        throw nextError;
      }
    },
    async waitForLoadState(loadState, options) {
      state.calls.push({ type: 'waitForLoadState', loadState, options });
    },
    locator(selector) {
      state.calls.push({ type: 'locator', selector });
      return {
        first() {
          return {
            waitFor: async (options) => {
              state.calls.push({ type: 'waitForSelector', selector, options });
              if (!state.visibleSelectors.has(selector)) {
                throw new Error(`selector not visible: ${selector}`);
              }
            },
          };
        },
      };
    },
    async waitForFunction(fn, arg, options) {
      state.calls.push({ type: 'waitForFunction', arg, options });
      if (typeof arg === 'number' && state.bodyLength < arg) {
        throw new Error(`body text shorter than ${arg}`);
      }
    },
    async waitForTimeout(timeout) {
      state.calls.push({ type: 'waitForTimeout', timeout });
    },
    mouse: {
      wheel: async (x, y) => {
        state.calls.push({ type: 'mouseWheel', x, y });
      },
    },
    async evaluate(fn, arg) {
      state.calls.push({ type: 'evaluate', arg });
      if (state.evaluateResults.length > 0) {
        return state.evaluateResults.shift();
      }

      return null;
    },
  };

  return page;
}

test('safeGotoWithOptions returns a fresh page after interrupted navigation', async () => {
  const firstPage = createMockPage('first', {
    gotoErrors: [new Error('Navigation was interrupted by another navigation')],
  });
  const secondPage = createMockPage('second');
  const createdPages = [secondPage];
  const context = {
    async newPage() {
      return createdPages.shift();
    },
  };

  const page = await safeGotoWithOptions(context, firstPage, 'https://example.com/item/1', {
    attempts: 2,
    retryDelayMs: 0,
    readySelectors: ['body'],
    minBodyTextLength: 20,
  });

  assert.equal(page, secondPage);
  assert.equal(firstPage.state.calls.filter((call) => call.type === 'goto').length, 1);
  assert.equal(secondPage.state.calls.filter((call) => call.type === 'goto').length, 1);
});

test('safeGotoWithOptions retries transient timeout failures', async () => {
  const firstPage = createMockPage('first', {
    gotoErrors: [new Error('Timeout 60000ms exceeded')],
  });
  const secondPage = createMockPage('second');
  let newPageCount = 0;
  const context = {
    async newPage() {
      newPageCount += 1;
      return secondPage;
    },
  };

  const page = await safeGotoWithOptions(context, firstPage, 'https://example.com/search', {
    attempts: 2,
    retryDelayMs: 0,
    readySelectors: ['body'],
  });

  assert.equal(page, secondPage);
  assert.equal(newPageCount, 1);
});

test('waitForPageReady waits for load state, selector visibility, body text, and settle delay', async () => {
  const page = createMockPage('ready', {
    visibleSelectors: ['main'],
    bodyLength: 120,
  });

  await waitForPageReady(page, {
    selectors: ['main', 'body'],
    timeoutMs: 4321,
    settleTimeMs: 250,
    minBodyTextLength: 100,
  });

  assert.deepEqual(
    page.state.calls.map((call) => call.type),
    ['waitForLoadState', 'locator', 'waitForSelector', 'waitForFunction', 'waitForTimeout'],
  );
  assert.equal(page.state.calls[0].loadState, 'domcontentloaded');
  assert.equal(page.state.calls[2].selector, 'main');
  assert.equal(page.state.calls[3].arg, 100);
  assert.equal(page.state.calls[4].timeout, 250);
});

test('scrollMarketplaceResults logs progress and stops after stable iterations', async () => {
  const messages = [];
  const page = createMockPage('scroll', {
    visibleSelectors: ['main'],
    evaluateResults: [
      { itemCount: 5, scrollHeight: 1000, scrollTop: 0, viewportHeight: 800 },
      { itemCount: 8, scrollHeight: 1500, scrollTop: 600, viewportHeight: 800 },
      { itemCount: 8, scrollHeight: 1500, scrollTop: 600, viewportHeight: 800 },
      { itemCount: 8, scrollHeight: 1500, scrollTop: 600, viewportHeight: 800 },
    ],
  });

  const stats = await scrollMarketplaceResults(page, {
    scrolls: 4,
    maxStableIterations: 2,
    logger: (message) => messages.push(message),
  });

  assert.equal(stats.itemCount, 8);
  assert.equal(page.state.calls.filter((call) => call.type === 'mouseWheel').length, 3);
  assert.ok(messages.some((message) => message.includes('scroll_step step=1/4')));
  assert.ok(messages.some((message) => message.includes('scroll_stop reason=stable_results')));
});

test('expandMarketplaceListingDetails clicks expandable controls across passes', async () => {
  const messages = [];
  const page = createMockPage('expand', {
    evaluateResults: [
      ['See more', 'Show more'],
      ['查看更多'],
      [],
    ],
  });

  const totalClicks = await expandMarketplaceListingDetails(page, {
    logger: (message) => messages.push(message),
  });

  assert.equal(totalClicks, 3);
  assert.equal(page.state.calls.filter((call) => call.type === 'evaluate').length, 3);
  assert.equal(page.state.calls.filter((call) => call.type === 'waitForTimeout').length, 2);
  assert.ok(messages.some((message) => message.includes('listing_expand pass=1/3')));
  assert.ok(messages.some((message) => message.includes('listing_expand_done clicks=3')));
});

test('inferMarketplaceAreaFromLocation normalizes city names for Marketplace route slugs', () => {
  assert.equal(inferMarketplaceAreaFromLocation('Ottawa, Ontario'), 'ottawa');
  assert.equal(inferMarketplaceAreaFromLocation(' North Vancouver, BC '), 'north-vancouver');
  assert.equal(inferMarketplaceAreaFromLocation('Montréal, Québec'), 'montreal');
  assert.equal(inferMarketplaceAreaFromLocation('Calgary, Alberta'), 'calgary');
  assert.equal(inferMarketplaceAreaFromLocation('Vancouver, WA'), 'vancouver-wa');
  assert.equal(inferMarketplaceAreaFromLocation('New York, NY'), 'nyc');
  assert.equal(inferMarketplaceAreaFromLocation('Brooklyn, New York'), 'nyc');
  assert.equal(inferMarketplaceAreaFromLocation('Seattle, Washington'), 'seattle');
  assert.equal(inferMarketplaceAreaFromLocation('Portland, Oregon'), 'portland');
  assert.equal(inferMarketplaceAreaFromLocation('Los Angeles, California'), 'los-angeles');
  assert.equal(inferMarketplaceAreaFromLocation('Sydney, NSW'), 'sydney');
  assert.equal(inferMarketplaceAreaFromLocation('Gold Coast, Queensland'), 'gold-coast');
  assert.equal(inferMarketplaceAreaFromLocation('Canberra, ACT'), 'canberra');
});

test('getKnownMarketplaceAreaFromLocation only returns configured city route slugs', () => {
  assert.equal(getKnownMarketplaceAreaFromLocation('Ottawa, Ontario'), 'ottawa');
  assert.equal(getKnownMarketplaceAreaFromLocation('Some Custom City, BC'), '');
  assert.equal(inferMarketplaceAreaFromLocation('Some Custom City, BC'), 'some-custom-city');
});

test('getMarketplaceLocationOptions exposes selectable city labels', () => {
  const options = getMarketplaceLocationOptions();
  const bySlug = new Map(options.map((option) => [option.slug, option]));

  assert.ok(options.length > 75);
  assert.equal(bySlug.get('vancouver')?.value, 'Vancouver');
  assert.equal(bySlug.get('vancouver-wa')?.value, 'Vancouver, WA');
  assert.equal(bySlug.get('ottawa')?.value, 'Ottawa, ON');
  assert.equal(bySlug.get('sydney')?.value, 'Sydney, NSW');
  assert.equal(bySlug.get('gold-coast')?.value, 'Gold Coast, QLD');
  assert.equal(bySlug.get('nyc')?.value, 'New York, NY');
});

test('setMarketplaceLocation skips picker when known route is already active', async () => {
  const messages = [];
  let pickerTouched = false;
  const page = {
    url: () => 'https://www.facebook.com/marketplace/vancouver/',
    getByRole() {
      pickerTouched = true;
      throw new Error('picker should not be touched');
    },
    locator() {
      pickerTouched = true;
      throw new Error('picker should not be touched');
    },
  };

  await setMarketplaceLocation(page, {
    location: 'Vancouver',
    fallbackArea: 'vancouver',
    allowMissingControl: true,
    logger: (message) => messages.push(message),
  });

  assert.equal(pickerTouched, false);
  assert.ok(messages.some((message) => message.includes('location_change_skip reason=area_route_match')));
});

test('urlMatchesMarketplaceArea recognizes Marketplace area routes', () => {
  assert.equal(urlMatchesMarketplaceArea('https://www.facebook.com/marketplace/ottawa/search/?query=canon', 'Ottawa, Ontario'), true);
  assert.equal(urlMatchesMarketplaceArea('https://www.facebook.com/marketplace/nyc/search/?query=canon', 'New York, NY'), true);
  assert.equal(urlMatchesMarketplaceArea('https://www.facebook.com/marketplace/vancouver-wa/', 'Vancouver, WA'), true);
  assert.equal(urlMatchesMarketplaceArea('https://www.facebook.com/marketplace/vancouver/', 'Ottawa, Ontario'), false);
});

test('radius helpers normalize miles and generate label patterns', () => {
  assert.equal(normalizeRadiusMiles('10'), 10);
  assert.equal(normalizeRadiusMiles(0), 0);

  const patterns = buildMarketplaceRadiusPatterns(10);
  assert.ok(patterns.some((pattern) => pattern.test('10 miles')));
  assert.ok(patterns.some((pattern) => pattern.test('10 mi')));
  assert.ok(patterns.some((pattern) => pattern.test('16 km')));
});

test('extractListingContent parses localized sold listing details without folding description into condition', () => {
  const text = [
    '商品交易小组 已售 · Plaubel Makina IIs 6x9cm Camera Outfit, Circa 1940 CA$ 1,950CA$ 2,100',
    '1 周前 · Vancouver, BC 公共场所见面 收藏 分享 详细信息',
    '商品状况 二手 - 成色好 A wonderful, large Makina kit, this one comes in its original case.',
    'This has been serviced, and is working flawlessly. 查看翻译 Vancouver, BC 我们只提供大概位置',
    '卖家信息 卖家详细信息 Randy Cole (63) 加入 Facebook 的时间：2009年',
  ].join(' ');

  const listing = extractListingContent(text);

  assert.equal(listing.title, 'Plaubel Makina IIs 6x9cm Camera Outfit, Circa 1940');
  assert.equal(listing.availabilityStatus, 'sold');
  assert.equal(listing.price, 'CA$ 1,950');
  assert.equal(listing.previousPrice, 'CA$ 2,100');
  assert.equal(listing.listedAgo, '1 周前');
  assert.equal(listing.location, 'Vancouver, BC');
  assert.equal(listing.condition, '二手 - 成色好');
  assert.equal(
    listing.description,
    'A wonderful, large Makina kit, this one comes in its original case. This has been serviced, and is working flawlessly.',
  );
  assert.equal(listing.sellerName, 'Randy Cole');
});

test('extractListingContent parses available localized listing location', () => {
  const text = [
    '商品交易小组 Vintage Eddie Bauer down jacket talon zipper CA$ 80 · 有货 · Vancouver, BC 发消息',
    '详细信息 商品状况 二手 - 成色好 Size medium. Fair bit of wear but it’s a great jacket.',
    '查看翻译 Vancouver, BC 我们只提供大概位置 卖家信息 卖家详细信息 Max Ke (9)',
    '加入 Facebook 的时间：2016年',
  ].join(' ');

  const listing = extractListingContent(text);

  assert.equal(listing.title, 'Vintage Eddie Bauer down jacket talon zipper');
  assert.equal(listing.availabilityStatus, 'available');
  assert.equal(listing.price, 'CA$ 80');
  assert.equal(listing.listedAgo, '');
  assert.equal(listing.location, 'Vancouver, BC');
  assert.equal(listing.condition, '二手 - 成色好');
  assert.equal(listing.description, 'Size medium. Fair bit of wear but it’s a great jacket.');
  assert.equal(listing.sellerName, 'Max Ke');
});

test('detectListingAvailability recognizes pending Marketplace listings', () => {
  const availability = detectListingAvailability('Marketplace Pending · Leica M6 CA$ 3,800 Vancouver, BC');
  assert.equal(availability.status, 'pending_sale');
  assert.equal(availability.reason, 'pending_marker');
});

test('detectListingAvailability recognizes localized title status markers', () => {
  assert.deepEqual(
    detectListingAvailability('商品交易小组 交易中 · BMW 325e 1986 AUTO CA$ 6,600 Vancouver, BC'),
    { status: 'pending_sale', reason: 'pending_marker' },
  );
  assert.deepEqual(
    detectListingAvailability('Marketplace Vendu · Leica M6 CA$ 3,800 Montréal, QC'),
    { status: 'sold', reason: 'sold_marker' },
  );
  assert.deepEqual(
    detectListingAvailability('Marketplace En attente · Leica M6 CA$ 3,800 Montréal, QC'),
    { status: 'pending_sale', reason: 'pending_marker' },
  );
});

test('detectListingAvailability recognizes scoped listing status markers without whole-page prefix', () => {
  const availability = detectListingAvailability('Sold · Leica M6 CA$ 3,800 Vancouver, BC Details Seller information');
  assert.equal(availability.status, 'sold');
  assert.equal(availability.reason, 'sold_marker');
});

test('detectListingAvailability ignores sold signals in recommendations', () => {
  const text = [
    '商品交易小组 0:00 / 0:00 Leica SL2-S CA$ 2,999CA$ 3,300 5周前 · Montréal, QC 发消息',
    '详细信息 商品状况 二手 - 成色好 Disponible Plateau Mont Royal, Montréal',
    'Boîtier Leica SL2-S en bon état général. Tout fonctionne parfaitement.',
    '卖家信息 卖家详细信息 Kevin Fouillet (41) 加入 Facebook 的时间：2009年',
    '赞助内容 Jollibee Canada Joyful adventure awaits at Jollibee!',
    '今日精选 CA$ 80 Light Meters - Sekonic L-308X-U / Minolta Auto Meter III F SOLD SEPARATELY QCMontréal',
  ].join(' ');

  const availability = detectListingAvailability(text, 'Leica SL2-S');
  assert.equal(availability.status, 'unknown');
  assert.equal(availability.reason, 'no_signal');
});

test('detectListingAvailability does not treat sold separately as listing sold', () => {
  const availability = detectListingAvailability('Light Meters - Sekonic L-308X-U / Minolta Auto Meter III F SOLD SEPARATELY');
  assert.equal(availability.status, 'unknown');
  assert.equal(availability.reason, 'no_signal');
});

test('detectListingAvailability only trusts Marketplace status markers', () => {
  assert.deepEqual(
    detectListingAvailability('Marketplace Leica M6 Sold separately with accessories CA$ 3,800 Vancouver, BC'),
    { status: 'unknown', reason: 'no_signal' },
  );
  assert.deepEqual(
    detectListingAvailability('Marketplace Sold · Leica M6 CA$ 3,800 Vancouver, BC'),
    { status: 'sold', reason: 'sold_marker' },
  );
  assert.deepEqual(
    detectListingAvailability('Marketplace Pending · Leica M6 CA$ 3,800 Vancouver, BC'),
    { status: 'pending_sale', reason: 'pending_marker' },
  );
  assert.deepEqual(
    detectListingAvailability('Marketplace Leica M6 CA$ 3,800 · Available · Vancouver, BC'),
    { status: 'available', reason: 'available_marker' },
  );
});

test('detectListingUnavailable recognizes taken-off listing banner before recommendations', () => {
  const text = [
    '商品交易小组 无法购买这件商品 商品可能已售出或过期。看看下面的类似商品吧！',
    '今日精选 Ottawa · 72公里 CA$ 20 Figurine Jack Black (Minecraft) QCBlainville',
    'CA$ 100 Vintage French Provincial Wooden Dresser QCMontréal',
  ].join(' ');

  assert.deepEqual(
    detectListingUnavailable(text),
    { unavailable: true, reason: 'marketplace_unavailable_banner' },
  );
  assert.equal(detectListingAvailability(text).status, 'unknown');
});

test('detectListingUnavailableUrl recognizes marketplace unavailable redirects', () => {
  assert.deepEqual(
    detectListingUnavailableUrl('https://www.facebook.com/marketplace/ottawa/?unavailable_product=1'),
    { unavailable: true, reason: 'marketplace_unavailable_redirect' },
  );
  assert.equal(detectListingUnavailableUrl('https://www.facebook.com/marketplace/item/1716046416425552/'), null);
});

test('readListingDetailPanelText returns scoped Marketplace detail panel text', async () => {
  const panel = await readListingDetailPanelText({
    evaluate: async () => ({
      text: '  Modular Capsule Home CA$ 42,000 Details Condition New Seller information  ',
      title: 'Modular Capsule Home',
      selector: 'div[aria-label="Marketplace item listing"]',
      score: 32,
      rect: { x: 0, y: 0, width: 420, height: 800 },
      html: '<!doctype html><main data-marketplace-listing-detail-capture="true"><div>Details Condition New</div></main>',
      htmlLength: 100,
      htmlText: 'Details Condition New',
      htmlSelector: 'div',
      htmlXPath: '/html[1]/body[1]/div[1]',
      htmlScore: 30,
      htmlRect: { x: 0, y: 120, width: 420, height: 220 },
      fullHtml: '<!doctype html><main data-marketplace-listing-detail-capture="full-detail-panel"><div>Modular Capsule Home CA$ 42,000 Details Condition New Seller information</div></main>',
      fullHtmlLength: 160,
      fullHtmlText: 'Modular Capsule Home CA$ 42,000 Details Condition New Seller information',
      fullHtmlSelector: 'div[aria-label="Marketplace item listing"]',
      fullHtmlXPath: '/html[1]/body[1]/div[2]',
      fullHtmlScore: 32,
      fullHtmlRect: { x: 0, y: 0, width: 420, height: 800 },
    }),
  });

  assert.equal(panel.text, 'Modular Capsule Home CA$ 42,000 Details Condition New Seller information');
  assert.equal(panel.title, 'Modular Capsule Home');
  assert.equal(panel.selector, 'div[aria-label="Marketplace item listing"]');
  assert.match(panel.html, /data-marketplace-listing-detail-capture/);
  assert.equal(panel.htmlText, 'Details Condition New');
  assert.equal(panel.htmlSelector, 'div');
  assert.equal(panel.htmlXPath, '/html[1]/body[1]/div[1]');
  assert.match(panel.fullHtml, /full-detail-panel/);
  assert.equal(panel.fullHtmlText, 'Modular Capsule Home CA$ 42,000 Details Condition New Seller information');
  assert.equal(panel.fullHtmlSelector, 'div[aria-label="Marketplace item listing"]');
  assert.equal(panel.fullHtmlXPath, '/html[1]/body[1]/div[2]');
});

test('readListingDetailPanelText fails when no scoped panel is found', async () => {
  await assert.rejects(
    readListingDetailPanelText({
      evaluate: async () => null,
    }),
    /Could not locate Marketplace listing detail panel/,
  );
});

test('detectListingUnavailablePage prefers redirect signal before DOM probing', async () => {
  let evaluated = false;
  const result = await detectListingUnavailablePage({
    url: () => 'https://www.facebook.com/marketplace/ottawa/?unavailable_product=1',
    evaluate: async () => {
      evaluated = true;
      throw new Error('should not evaluate');
    },
  });

  assert.deepEqual(result, { unavailable: true, reason: 'marketplace_unavailable_redirect' });
  assert.equal(evaluated, false);
});

test('detectListingUnavailablePage accepts compact DOM banner signals', async () => {
  const domSignal = {
    unavailable: true,
    reason: 'marketplace_unavailable_dom',
    signals: {
      bannerText: '无法购买这件商品 商品可能已售出或过期。看看下面的类似商品吧！',
      tagName: 'div',
      className: 'x9f619 x1n2onr6',
      id: '',
      role: '',
      rect: { x: 384, y: 82, width: 1024, height: 80 },
      icon: {
        tagName: 'svg',
        className: '',
        id: '',
        role: '',
        ariaLabel: '',
        style: '--x-color:var(--always-white)',
        rect: { x: 416, y: 96, width: 20, height: 20 },
      },
    },
  };
  const result = await detectListingUnavailablePage({
    url: () => 'https://www.facebook.com/marketplace/item/1716046416425552/',
    evaluate: async () => domSignal,
  });

  assert.deepEqual(result, domSignal);
});
