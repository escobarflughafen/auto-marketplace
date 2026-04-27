const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeGotoWithOptions,
  waitForPageReady,
  scrollMarketplaceResults,
  expandMarketplaceListingDetails,
} = require('../scripts/marketplace-utils');

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
