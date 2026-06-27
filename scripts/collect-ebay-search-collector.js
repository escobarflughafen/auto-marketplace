const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  createLogger,
  ensureDir,
  cleanText,
} = require('./marketplace-utils');
const {
  DEFAULT_DB_PATH,
  normalizeKeyword,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListingWithStatus,
  scanPurchaseHistoryMatchesForListings,
  getHomepageListingCounts,
} = require('./marketplace-homepage-db');
const {
  appendRegulatedListingEvent,
  appendRegulatedWorkflowEvent,
} = require('./marketplace-worker-event-writer');
const {
  applyWorkerScreenshotDefaults,
  normalizeWorkerScreenshotOptions,
  startWorkerScreenshotMonitor,
} = require('./marketplace-worker-screenshots');

const EBAY_SOURCE = 'ebay';
const DEFAULT_SEARCH_URL = 'https://www.ebay.com/sch/i.html';
const EBAY_HOME_URL = 'https://www.ebay.com/';
const EBAY_SEARCH_INPUT_SELECTOR = [
  'input[name="_nkw"]',
  '#gh-ac',
  'input[aria-label="Search for anything"]',
].join(', ');
const TERMINAL_ACCESS_STOP_REASONS = new Set([
  'auth_required',
  'browser_crashed',
  'challenge',
]);
const log = createLogger('collect-ebay-search-collector');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseIntegerFlag(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseOptionalIntegerFlag(value, flagName, minimum = 0) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseIntegerFlag(text, flagName, minimum);
}

function parseKeywordList(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map((item) => normalizeKeyword(item))
    .filter(Boolean);
}

function uniqueKeywords(keywords) {
  const seen = new Set();
  const result = [];
  for (const keyword of keywords.map((item) => normalizeKeyword(item)).filter(Boolean)) {
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
  }
  return result;
}

function parseSearchQueryTargets(value, flagName = '--query-targets') {
  const text = String(value || '').trim();
  if (!text) return [];
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected ${flagName} to be JSON: ${error.message}`);
  }
  if (!Array.isArray(rows)) {
    throw new Error(`Expected ${flagName} to be a JSON array`);
  }

  const seen = new Set();
  const targets = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Expected ${flagName} row ${index + 1} to be an object`);
    }
    const keyword = normalizeKeyword(row.keyword || row.query || '');
    if (!keyword) {
      throw new Error(`Expected ${flagName} row ${index + 1} to include keyword`);
    }
    const minPrice = parseOptionalIntegerFlag(row.minPrice ?? row.min_price ?? '', `${flagName} row ${index + 1} minPrice`, 0);
    const maxPrice = parseOptionalIntegerFlag(row.maxPrice ?? row.max_price ?? '', `${flagName} row ${index + 1} maxPrice`, 0);
    if (minPrice !== null && maxPrice !== null && maxPrice < minPrice) {
      throw new Error(`Expected ${flagName} row ${index + 1} maxPrice to be >= minPrice`);
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ keyword, minPrice, maxPrice });
  }
  return targets;
}

function queryTargetsFromKeywords(keywords) {
  return uniqueKeywords(keywords).map((keyword) => ({
    keyword,
    minPrice: null,
    maxPrice: null,
  }));
}

function parseArgs(argv) {
  const options = applyWorkerScreenshotDefaults({
    query: '',
    queryInputs: [],
    queriesRaw: '',
    queryTargetsRaw: '',
    seedQueries: [],
    seedQueryTargets: [],
    keywordListProvided: false,
    minPrice: null,
    maxPrice: null,
    searchUrl: DEFAULT_SEARCH_URL,
    userDataDir: path.join(process.cwd(), 'profiles', 'ebay-search-collector'),
    dbPath: DEFAULT_DB_PATH,
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'ebay-search-collector.log'),
    snapshotFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'ebay-search-collector-latest-cycle.json'),
    maxItems: 120,
    maxPages: 3,
    collectAll: true,
    pageDelaySeconds: 5,
    refreshSeconds: 5 * 60,
    refreshJitterMin: 0.5,
    refreshJitterMax: 1.5,
    maxRuntimeSeconds: 180,
    once: false,
    headless: true,
    workerId: `pid-${process.pid}`,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--query':
        options.query = readFlagValue(argv, index, arg);
        options.queryInputs.push(options.query);
        index += 1;
        break;
      case '--queries':
      case '--seed-queries':
        options.queriesRaw = readFlagValue(argv, index, arg);
        options.keywordListProvided = true;
        index += 1;
        break;
      case '--query-targets':
      case '--seed-query-targets':
        options.queryTargetsRaw = readFlagValue(argv, index, arg);
        options.keywordListProvided = true;
        index += 1;
        break;
      case '--min-price':
      case '--minPrice':
        options.minPrice = parseOptionalIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--max-price':
      case '--maxPrice':
        options.maxPrice = parseOptionalIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--search-url':
        options.searchUrl = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--user-data-dir':
        options.userDataDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--log-file':
        options.logFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--snapshot-file':
        options.snapshotFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--max-items':
        options.maxItems = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        options.collectAll = false;
        index += 1;
        break;
      case '--max-pages':
        options.maxPages = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--collect-all':
        options.collectAll = true;
        break;
      case '--no-collect-all':
        options.collectAll = false;
        break;
      case '--page-delay-seconds':
        options.pageDelaySeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--refresh-seconds':
        options.refreshSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--refresh-jitter-min':
        options.refreshJitterMin = Number.parseFloat(readFlagValue(argv, index, arg));
        if (!Number.isFinite(options.refreshJitterMin) || options.refreshJitterMin < 0) {
          throw new Error(`Expected ${arg} to be a number >= 0`);
        }
        index += 1;
        break;
      case '--refresh-jitter-max':
        options.refreshJitterMax = Number.parseFloat(readFlagValue(argv, index, arg));
        if (!Number.isFinite(options.refreshJitterMax) || options.refreshJitterMax < 0) {
          throw new Error(`Expected ${arg} to be a number >= 0`);
        }
        index += 1;
        break;
      case '--max-runtime-seconds':
        options.maxRuntimeSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      case '--worker-id':
        options.workerId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-screenshot-dir':
        options.workerScreenshotDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-screenshot-interval-seconds':
        options.workerScreenshotIntervalSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--worker-screenshot-history-limit':
        options.workerScreenshotHistoryLimit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--worker-screenshot-format':
        options.workerScreenshotFormat = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-screenshot-quality':
        options.workerScreenshotQuality = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--headless':
        options.headless = true;
        break;
      default:
        if (!arg.startsWith('--') && !options.query) {
          options.query = arg;
          options.queryInputs.push(options.query);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const explicitTargets = parseSearchQueryTargets(options.queryTargetsRaw);
  const explicitQueries = parseKeywordList(options.queriesRaw);
  const queryInputSeeds = uniqueKeywords(options.queryInputs);
  const targets = explicitTargets.length
    ? explicitTargets
    : queryTargetsFromKeywords(explicitQueries.length ? explicitQueries : queryInputSeeds);
  options.seedQueryTargets = targets;
  options.seedQueries = targets.map((target) => target.keyword);
  options.query = normalizeKeyword(options.seedQueries[0] || options.query);
  if (!options.query) {
    throw new Error('Missing required eBay search keyword. Pass --query, --queries, or --query-targets JSON.');
  }
  if (!options.seedQueries.length) {
    options.seedQueries = [options.query];
    options.seedQueryTargets = [{ keyword: options.query, minPrice: options.minPrice, maxPrice: options.maxPrice }];
  } else if (!explicitTargets.length && !explicitQueries.length) {
    options.seedQueryTargets = [{ keyword: options.query, minPrice: options.minPrice, maxPrice: options.maxPrice }];
  }

  if (options.minPrice !== null && options.maxPrice !== null && options.maxPrice < options.minPrice) {
    throw new Error('Expected --max-price to be >= --min-price');
  }
  if (options.refreshJitterMax < options.refreshJitterMin) {
    throw new Error('Expected --refresh-jitter-max to be >= --refresh-jitter-min');
  }
  normalizeWorkerScreenshotOptions(options);
  return options;
}

function ebayItemIdFromUrl(value) {
  const text = String(value || '');
  const match = text.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/i)
    || text.match(/[?&]item=(\d{9,})/i);
  return match ? match[1] : '';
}

function canonicalizeEbayItemUrl(value) {
  const itemId = ebayItemIdFromUrl(value);
  return itemId ? `https://www.ebay.com/itm/${itemId}` : String(value || '').trim();
}

function ebayListingId(itemId, href) {
  const id = String(itemId || ebayItemIdFromUrl(href) || '').trim();
  return id ? `ebay:${id}` : `ebay:${canonicalizeEbayItemUrl(href)}`;
}

function buildEbaySearchUrl(query, options = {}) {
  const url = new URL(options.searchUrl || DEFAULT_SEARCH_URL);
  url.searchParams.set('_nkw', query);
  if (options.page && Number(options.page) > 1) {
    url.searchParams.set('_pgn', String(options.page));
  } else {
    url.searchParams.delete('_pgn');
  }
  if (options.minPrice !== null && options.minPrice !== undefined) {
    url.searchParams.set('_udlo', String(options.minPrice));
  }
  if (options.maxPrice !== null && options.maxPrice !== undefined) {
    url.searchParams.set('_udhi', String(options.maxPrice));
  }
  return url.toString();
}

function detectEbayChallengeUrl(value) {
  const text = String(value || '');
  return /\/splashui\/challenge/i.test(text) || /\/captcha/i.test(text);
}

async function readEbayAccessStatus(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const title = document.title || '';
    const hasLoginInput = Boolean(
      document.querySelector('input[type="password"], input[name="userid"], input[name="pass"]'),
    );
    const isErrorPage = /error page/i.test(title)
      || /something went wrong on our end/i.test(text)
      || /please go back and try again/i.test(text);
    const isChallenge = /captcha|verify.*human|security check|splashui\/challenge/i.test(`${location.href} ${title} ${text}`);
    return {
      url: location.href,
      title,
      hasLoginInput,
      isErrorPage,
      isChallenge,
      textSample: text.slice(0, 240),
    };
  });
}

async function safeReadEbayAccessStatus(page) {
  try {
    return await readEbayAccessStatus(page);
  } catch (error) {
    return {
      url: page.url(),
      title: '',
      hasLoginInput: false,
      isErrorPage: false,
      isChallenge: detectEbayChallengeUrl(page.url()),
      browserCrashed: /target crashed|page crashed/i.test(String(error && error.message ? error.message : error)),
      error: String(error && error.message ? error.message : error),
      textSample: '',
    };
  }
}

function shouldRetryEbaySearchViaHomepage(accessStatus, pageNumber) {
  return Number(pageNumber) === 1
    && Boolean(accessStatus)
    && !accessStatus.hasLoginInput
    && accessStatus.isErrorPage
    && !accessStatus.isChallenge
    && !accessStatus.browserCrashed;
}

async function submitEbayHomepageSearch(page, queryPlan, options, pageNumber) {
  await page.goto(EBAY_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
  let accessStatus = await safeReadEbayAccessStatus(page);
  if (accessStatus.isChallenge || accessStatus.isErrorPage || accessStatus.hasLoginInput || accessStatus.browserCrashed) {
    return accessStatus;
  }

  await page.waitForSelector(EBAY_SEARCH_INPUT_SELECTOR, { timeout: 15000 });
  const input = page.locator(EBAY_SEARCH_INPUT_SELECTOR).first();
  await input.fill(queryPlan.query);
  await input.press('Enter');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
  accessStatus = await safeReadEbayAccessStatus(page);
  if (accessStatus.isChallenge || accessStatus.hasLoginInput || accessStatus.browserCrashed) {
    return accessStatus;
  }

  if (Number(pageNumber) > 1 || queryPlan.minPrice != null || queryPlan.maxPrice != null) {
    const url = new URL(page.url());
    url.searchParams.set('_nkw', queryPlan.query);
    if (Number(pageNumber) > 1) {
      url.searchParams.set('_pgn', String(pageNumber));
    } else {
      url.searchParams.delete('_pgn');
    }
    if (queryPlan.minPrice != null) {
      url.searchParams.set('_udlo', String(queryPlan.minPrice));
    }
    if (queryPlan.maxPrice != null) {
      url.searchParams.set('_udhi', String(queryPlan.maxPrice));
    }
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
    accessStatus = await safeReadEbayAccessStatus(page);
    if (accessStatus.isChallenge || accessStatus.hasLoginInput || accessStatus.browserCrashed) {
      return accessStatus;
    }
  }

  await page.waitForTimeout(Math.max(0, options.pageDelaySeconds) * 1000);
  return safeReadEbayAccessStatus(page);
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

function collectorEventBase(options) {
  return {
    workflowRunId: options.workerId,
    workerId: options.workerId,
    workerType: 'collector',
    strategy: 'search',
  };
}

function appendCollectorWorkflowEvent(db, options, eventType, event = {}) {
  try {
    return appendRegulatedWorkflowEvent(db, {
      ...collectorEventBase(options),
      eventType,
      status: event.status || '',
      payload: event.payload || {},
      error: event.error instanceof Error ? event.error.message : String(event.error || ''),
    });
  } catch (error) {
    log(`ebay_search_workflow_event_append_failed type=${eventType} error=${error.message}`);
    return null;
  }
}

function appendCollectorListingEvent(db, options, listing, event = {}) {
  try {
    return appendRegulatedListingEvent(db, {
      ...collectorEventBase(options),
      eventType: 'listing_observed',
      listingId: listing.listing_id,
      sourceUrl: listing.href,
      status: event.status || '',
      payload: {
        listingId: listing.listing_id,
        href: listing.href,
        source: listing.source || EBAY_SOURCE,
        sourceKeyword: listing.source_keyword || '',
        outcome: event.outcome || event.status || '',
        rank: listing.last_seen_rank,
        cardTitle: listing.card_title || '',
        cardText: listing.card_text || '',
      },
    });
  } catch (error) {
    log(`ebay_search_listing_event_append_failed listing_id=${listing.listing_id || ''} error=${error.message}`);
    return null;
  }
}

async function readEbayResultItems(page) {
  return page.evaluate(() => {
    const textFrom = (root, selector) => (root.querySelector(selector)?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const allTextFrom = (root, selectors) => selectors
      .map((selector) => textFrom(root, selector))
      .find(Boolean) || '';
    const itemIdFromHref = (href) => {
      const match = String(href || '').match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/i)
        || String(href || '').match(/[?&]item=(\d{9,})/i);
      return match ? match[1] : '';
    };
    const cleanNodeText = (node) => (node?.innerText || node?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const chooseCardRoot = (anchor) => {
      const candidates = [];
      let node = anchor;
      for (let depth = 0; node && depth < 8; depth += 1) {
        candidates.push(node);
        node = node.parentElement;
      }
      const classRoot = anchor.closest('li.s-item, .s-item, [data-view*="mi:"]');
      if (classRoot) candidates.unshift(classRoot);
      const priced = candidates.find((candidate) => /(?:US|C|AU)?\s*\$\s*[\d,]+/i.test(cleanNodeText(candidate)));
      if (priced) return priced;
      return classRoot || anchor.closest('li') || anchor.parentElement;
    };
    const canonicalHref = (href) => {
      const itemId = itemIdFromHref(href);
      return itemId ? `https://www.ebay.com/itm/${itemId}` : href;
    };
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/itm/"]'))
      .map((anchor) => {
        const href = anchor.href || '';
        const itemId = itemIdFromHref(href);
        if (!itemId || seen.has(itemId)) return null;
        const card = chooseCardRoot(anchor);
        if (!card) return null;
        seen.add(itemId);

        const image = card.querySelector('img');
        const lines = (card.innerText || card.textContent || '')
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const title = allTextFrom(card, [
          '.s-item__title',
          '[role="heading"]',
          'h3',
        ]) || (image?.alt || anchor.textContent || lines[0] || '').replace(/\s+/g, ' ').trim();
        if (!title || /^shop on ebay$/i.test(title)) return null;
        const price = allTextFrom(card, ['.s-item__price', '[class*="price"]'])
          || lines.find((line) => /(?:US|C|AU)?\s*\$\s*[\d,]+/i.test(line)) || '';
        const shipping = allTextFrom(card, ['.s-item__shipping', '[class*="shipping"]'])
          || lines.find((line) => /\b(?:shipping|delivery)\b/i.test(line)) || '';
        const location = allTextFrom(card, ['.s-item__location', '[class*="location"]'])
          || lines.find((line) => /^from\s+/i.test(line)) || '';
        const condition = allTextFrom(card, ['.SECONDARY_INFO', '.s-item__subtitle']);
        const seller = allTextFrom(card, ['.s-item__seller-info-text', '.s-item__seller-info']);
        const bids = allTextFrom(card, ['.s-item__bids', '[class*="bids"]']);
        const timeLeft = allTextFrom(card, ['.s-item__time-left', '[class*="time-left"]']);
        const purchaseOptions = allTextFrom(card, ['.s-item__purchase-options', '[class*="purchase-options"]']);
        const watchCount = allTextFrom(card, ['.s-item__watchCount', '[class*="watch"]']);
        const itemUrl = canonicalHref(href);
        const fields = [
          price,
          title,
          condition,
          shipping,
          location,
          seller,
          bids,
          timeLeft,
          purchaseOptions,
          watchCount,
        ].filter(Boolean);
        const text = fields.length > 1 ? fields.join(' | ') : (lines.join(' | ') || title);
        return {
          listingId: `ebay:${itemId}`,
          itemId,
          href: itemUrl,
          title,
          text,
          lines,
          price,
          shipping,
          location,
          condition,
          seller,
          bids,
          timeLeft,
          purchaseOptions,
          watchCount,
          photos: image ? [{
            source: 'ebay_search_card',
            sourceUrl: image.currentSrc || image.src || image.getAttribute('data-src') || '',
            altText: image.alt || title,
            width: image.naturalWidth || image.clientWidth || 0,
            height: image.naturalHeight || image.clientHeight || 0,
            position: 0,
            metadata: { itemId },
          }].filter((photo) => photo.sourceUrl) : [],
        };
      })
      .filter(Boolean);
  });
}

async function collectEbaySearchItems(page, queryPlan, options) {
  const startedAt = Date.now();
  const itemsByListingId = new Map();
  const pageSummaries = [];
  let stopReason = 'unknown';

  for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber += 1) {
    if (!options.collectAll && itemsByListingId.size >= options.maxItems) {
      stopReason = 'max_items';
      break;
    }
    if ((Date.now() - startedAt) >= options.maxRuntimeSeconds * 1000) {
      stopReason = 'max_runtime';
      break;
    }

    const url = buildEbaySearchUrl(queryPlan.query, {
      searchUrl: options.searchUrl,
      page: pageNumber,
      minPrice: queryPlan.minPrice,
      maxPrice: queryPlan.maxPrice,
    });
    let navigationMode = 'direct';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
    let accessStatus = await safeReadEbayAccessStatus(page);

    if (detectEbayChallengeUrl(page.url()) || accessStatus.isChallenge) {
      stopReason = 'challenge';
      pageSummaries.push({
        page: pageNumber,
        url: page.url(),
        title: accessStatus.title,
        items: 0,
        challenge: true,
        navigationMode,
        accessStatus,
      });
      break;
    }

    if (shouldRetryEbaySearchViaHomepage(accessStatus, pageNumber)) {
      await appendLog(
        options.logFile,
        `ebay_search_homepage_fallback page=${pageNumber} query="${queryPlan.query}" direct_url=${JSON.stringify(page.url())} reason=ebay_error_page`,
      );
      navigationMode = 'homepage_search_fallback';
      accessStatus = await submitEbayHomepageSearch(page, queryPlan, options, pageNumber);
    }

    if (detectEbayChallengeUrl(page.url())) {
      stopReason = 'challenge';
      pageSummaries.push({
        page: pageNumber,
        url: page.url(),
        items: 0,
        challenge: true,
        navigationMode,
      });
      break;
    }

    if (accessStatus.isChallenge || accessStatus.isErrorPage || accessStatus.hasLoginInput) {
      stopReason = accessStatus.hasLoginInput
        ? 'auth_required'
        : accessStatus.isChallenge
          ? 'challenge'
          : 'ebay_error_page';
      pageSummaries.push({
        page: pageNumber,
        url: accessStatus.url,
        title: accessStatus.title,
        items: 0,
        navigationMode,
        accessStatus,
      });
      break;
    }
    await page.waitForTimeout(Math.max(0, options.pageDelaySeconds) * 1000);
    await page.mouse.wheel(0, 900).catch(() => null);
    await page.waitForTimeout(500);
    const pageItems = await readEbayResultItems(page);
    let added = 0;
    for (const item of pageItems) {
      const href = canonicalizeEbayItemUrl(item.href);
      const listingId = item.listingId || ebayListingId(item.itemId, href);
      if (itemsByListingId.has(listingId)) continue;
      itemsByListingId.set(listingId, {
        ...item,
        listingId,
        href,
        title: cleanText(item.title),
        text: cleanText(item.text),
      });
      added += 1;
      if (!options.collectAll && itemsByListingId.size >= options.maxItems) {
        break;
      }
    }
    pageSummaries.push({
      page: pageNumber,
      url: page.url(),
      directUrl: url,
      items: pageItems.length,
      added,
      navigationMode,
    });
    if (pageItems.length === 0) {
      stopReason = 'empty_page';
      break;
    }
    if (added === 0) {
      stopReason = 'repeated_page';
      break;
    }
  }

  if (stopReason === 'unknown') {
    stopReason = itemsByListingId.size >= options.maxItems && !options.collectAll
      ? 'max_items'
      : 'max_pages';
  }
  const elapsedMs = Date.now() - startedAt;
  const collectedItems = Array.from(itemsByListingId.values());
  const limitedItems = options.collectAll ? collectedItems : collectedItems.slice(0, options.maxItems);
  return {
    items: limitedItems.map((item, index) => ({ ...item, rank: index + 1 })),
    stats: {
      stopReason,
      elapsedMs,
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(3)),
      pagesVisited: pageSummaries.length,
      maxPages: options.maxPages,
      pageSummaries,
      totalUniqueItems: limitedItems.length,
      collectAll: options.collectAll,
      maxItemsTarget: options.collectAll ? null : options.maxItems,
      runtimeLimitSeconds: options.maxRuntimeSeconds,
      runtimeLimitReached: stopReason === 'max_runtime',
      challengeDetected: stopReason === 'challenge',
    },
  };
}

function summarizeUpsertOutcomes(results) {
  return results.reduce((summary, result) => {
    summary[result.outcome] += 1;
    return summary;
  }, {
    new: 0,
    existing_same: 0,
    existing_updated: 0,
  });
}

function chooseQueryTarget(options, state) {
  const targets = options.seedQueryTargets.length
    ? options.seedQueryTargets
    : [{ keyword: options.query, minPrice: options.minPrice, maxPrice: options.maxPrice }];
  const index = state.seedIndex % targets.length;
  const target = targets[index];
  state.seedIndex = (index + 1) % targets.length;
  return {
    query: target.keyword,
    querySource: targets.length > 1 ? 'seed_round_robin' : 'seed',
    seedIndex: index,
    nextSeedIndex: state.seedIndex,
    minPrice: target.minPrice ?? options.minPrice,
    maxPrice: target.maxPrice ?? options.maxPrice,
  };
}

async function writeCycleSnapshot(snapshotFile, cycleSummary) {
  const resolvedPath = path.isAbsolute(snapshotFile)
    ? snapshotFile
    : path.join(process.cwd(), snapshotFile);
  await ensureDir(path.dirname(resolvedPath));
  await fs.promises.writeFile(resolvedPath, JSON.stringify(cycleSummary, null, 2), 'utf8');
  return resolvedPath;
}

async function runRound(page, db, options, state) {
  const countsBefore = getHomepageListingCounts(db);
  const queryPlan = chooseQueryTarget(options, state);
  const targetLabel = options.collectAll ? 'all' : String(options.maxItems);
  const startUrl = buildEbaySearchUrl(queryPlan.query, {
    searchUrl: options.searchUrl,
    page: 1,
    minPrice: queryPlan.minPrice,
    maxPrice: queryPlan.maxPrice,
  });

  appendCollectorWorkflowEvent(db, options, 'collector_query_selected', {
    status: 'selected',
    payload: {
      query: queryPlan.query,
      querySource: queryPlan.querySource,
      roundNumber: state.roundNumber,
      seedIndex: queryPlan.seedIndex,
      nextSeedIndex: queryPlan.nextSeedIndex,
    },
  });
  appendCollectorWorkflowEvent(db, options, 'collector_cycle_started', {
    status: 'running',
    payload: {
      startUrl,
      query: queryPlan.query,
      source: EBAY_SOURCE,
      maxItems: targetLabel,
      collectAll: options.collectAll,
      dbCountsBefore: countsBefore,
    },
  });
  await appendLog(
    options.logFile,
    `ebay_round_start round=${state.roundNumber} query_source=${queryPlan.querySource} query="${queryPlan.query}" min_price=${queryPlan.minPrice ?? ''} max_price=${queryPlan.maxPrice ?? ''} max_pages=${options.maxPages} max_items=${targetLabel} collect_all=${options.collectAll}`,
  );

  const collection = await collectEbaySearchItems(page, queryPlan, options);
  const { items, stats: collectionStats } = collection;
  const seenAt = new Date().toISOString();
  const storedResults = items.map((item) => upsertHomepageListingWithStatus(db, item, {
    seenAt,
    source: EBAY_SOURCE,
    sourceKeyword: queryPlan.query,
  }));
  for (const result of storedResults) {
    appendCollectorListingEvent(db, options, result.row, {
      status: result.outcome,
      outcome: result.outcome,
    });
  }
  scanPurchaseHistoryMatchesForListings(db, storedResults.map((result) => result.row.listing_id), {
    actor: 'ebay-search-collector',
    matchedAt: seenAt,
  });

  const outcomeCounts = summarizeUpsertOutcomes(storedResults);
  const counts = getHomepageListingCounts(db);
  const cycleSummary = {
    capturedAt: seenAt,
    source: EBAY_SOURCE,
    sourceKeyword: queryPlan.query,
    querySource: queryPlan.querySource,
    seedQueries: options.seedQueries,
    roundNumber: state.roundNumber,
    seedIndex: queryPlan.seedIndex,
    nextSeedIndex: queryPlan.nextSeedIndex,
    priceFilters: {
      minPrice: queryPlan.minPrice ?? null,
      maxPrice: queryPlan.maxPrice ?? null,
    },
    collectAll: options.collectAll,
    dbCountsBefore: countsBefore,
    dbCountsAfter: counts,
    totalCollected: items.length,
    collectionStats,
    maxItemsTarget: targetLabel,
    outcomeCounts,
    items: storedResults.map((result) => ({
      outcome: result.outcome,
      listingId: result.row.listing_id,
      href: result.row.href,
      source: result.row.source,
      sourceKeyword: result.row.source_keyword,
      cardTitle: result.row.card_title,
      cardText: result.row.card_text,
      detailStatus: result.row.detail_status,
      lastSeenRank: result.row.last_seen_rank,
    })),
  };

  const snapshotPath = await writeCycleSnapshot(options.snapshotFile, cycleSummary);
  await appendLog(
    options.logFile,
    `ebay_round_done round=${state.roundNumber} query="${queryPlan.query}" collected=${items.length} stop_reason=${collectionStats.stopReason} pages=${collectionStats.pagesVisited}/${options.maxPages} elapsed_seconds=${collectionStats.elapsedSeconds} new=${outcomeCounts.new} existing_same=${outcomeCounts.existing_same} existing_updated=${outcomeCounts.existing_updated} db_pending=${counts.pending} db_processing=${counts.processing} db_done=${counts.done} db_error=${counts.error} snapshot=${snapshotPath}`,
  );
  appendCollectorWorkflowEvent(db, options, 'collector_cycle_completed', {
    status: 'completed',
    payload: {
      observedCount: items.length,
      newCount: outcomeCounts.new,
      existingSameCount: outcomeCounts.existing_same,
      existingUpdatedCount: outcomeCounts.existing_updated,
      snapshotPath,
      stopReason: collectionStats.stopReason,
      elapsedSeconds: collectionStats.elapsedSeconds,
      query: queryPlan.query,
      querySource: queryPlan.querySource,
      roundNumber: state.roundNumber,
      dbCountsAfter: counts,
    },
  });

  return { cycleSummary };
}

function computeJitteredRefreshMs(refreshSeconds, jitterMin, jitterMax) {
  const baseMs = refreshSeconds * 1000;
  const multiplier = jitterMin + (Math.random() * (jitterMax - jitterMin));
  return {
    multiplier,
    refreshMs: Math.max(0, Math.round(baseMs * multiplier)),
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldStopWorkerAfterRound(cycleSummary) {
  const stopReason = cycleSummary?.collectionStats?.stopReason || '';
  return TERMINAL_ACCESS_STOP_REASONS.has(stopReason);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(path.dirname(options.logFile));
  await ensureDir(options.workerScreenshotDir);
  await appendLog(
    options.logFile,
    `ebay_search_collector_start db_path=${options.dbPath} seed_query="${options.query}" seed_queries=${JSON.stringify(options.seedQueries)} max_pages=${options.maxPages} min_price=${options.minPrice ?? ''} max_price=${options.maxPrice ?? ''} refresh_seconds=${options.refreshSeconds} refresh_jitter_min=${options.refreshJitterMin} refresh_jitter_max=${options.refreshJitterMax} max_items=${options.collectAll ? 'all' : options.maxItems} collect_all=${options.collectAll} headless=${options.headless} worker_id=${options.workerId} worker_screenshot_interval_seconds=${options.workerScreenshotIntervalSeconds} worker_screenshot_history_limit=${options.workerScreenshotHistoryLimit} worker_screenshot_format=${options.workerScreenshotFormat} worker_screenshot_quality=${options.workerScreenshotQuality}`,
  );

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
    ? options.userDataDir
    : path.join(process.cwd(), options.userDataDir);
  appendCollectorWorkflowEvent(db, options, 'worker_started', {
    status: 'running',
    payload: {
      mode: options.once ? 'once' : 'continuous',
      source: EBAY_SOURCE,
      refreshSeconds: options.refreshSeconds,
      maxItems: options.collectAll ? 'all' : options.maxItems,
      maxPages: options.maxPages,
      collectAll: options.collectAll,
      query: options.query,
      seedQueries: options.seedQueries,
    },
  });
  appendCollectorWorkflowEvent(db, options, 'browser_context_launch_started', {
    status: 'starting',
    payload: {
      userDataDir: resolvedUserDataDir,
      headless: options.headless,
    },
  });

  const context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  }));
  appendCollectorWorkflowEvent(db, options, 'browser_context_ready', {
    status: 'running',
    payload: {
      userDataDir: resolvedUserDataDir,
      headless: options.headless,
    },
  });
  appendCollectorWorkflowEvent(db, options, 'session_ready', {
    status: 'ready',
    payload: {
      loggedIn: false,
      currentUrl: DEFAULT_SEARCH_URL,
    },
  });

  const lifecycle = {
    shutdownRequested: false,
    currentPage: null,
    terminalStopReason: '',
    screenshotPaused: false,
  };
  let stopScreenshotMonitor = () => {};
  try {
    const page = await context.newPage();
    lifecycle.currentPage = page;
    stopScreenshotMonitor = startWorkerScreenshotMonitor(options, lifecycle, {
      log: (message) => appendLog(options.logFile, message),
    });

    const state = {
      roundNumber: 1,
      seedIndex: 0,
    };
    process.on('SIGTERM', () => {
      lifecycle.shutdownRequested = true;
      appendCollectorWorkflowEvent(db, options, 'shutdown_requested', {
        status: 'stopping',
        payload: { signal: 'SIGTERM' },
      });
    });
    process.on('SIGINT', () => {
      lifecycle.shutdownRequested = true;
      appendCollectorWorkflowEvent(db, options, 'shutdown_requested', {
        status: 'stopping',
        payload: { signal: 'SIGINT' },
      });
    });

    while (!lifecycle.shutdownRequested) {
      lifecycle.screenshotPaused = true;
      const { cycleSummary } = await runRound(page, db, options, state);
      if (options.once || shouldStopWorkerAfterRound(cycleSummary)) {
        const stopReason = cycleSummary?.collectionStats?.stopReason || '';
        const exitMode = options.once ? 'once' : 'terminal_access_stop';
        await appendLog(
          options.logFile,
          `ebay_search_collector_exit mode=${exitMode} stop_reason=${stopReason}`,
        );
        if (!options.once) {
          lifecycle.terminalStopReason = stopReason;
        }
        break;
      }
      lifecycle.screenshotPaused = false;
      const { multiplier, refreshMs } = computeJitteredRefreshMs(
        options.refreshSeconds,
        options.refreshJitterMin,
        options.refreshJitterMax,
      );
      appendCollectorWorkflowEvent(db, options, 'worker_sleeping', {
        status: 'sleeping',
        payload: {
          seconds: Math.ceil(refreshMs / 1000),
          reason: 'refresh_timer',
          jitterMultiplier: Number(multiplier.toFixed(3)),
        },
      });
      await appendLog(
        options.logFile,
        `ebay_search_collector_sleep seconds=${Math.ceil(refreshMs / 1000)} base_refresh_seconds=${options.refreshSeconds} jitter_multiplier=${multiplier.toFixed(3)}`,
      );
      await sleep(refreshMs);
      state.roundNumber += 1;
    }

    appendCollectorWorkflowEvent(db, options, 'worker_completed', {
      status: 'completed',
      payload: {
        reason: lifecycle.shutdownRequested
          ? 'shutdown_requested'
          : lifecycle.terminalStopReason
            ? 'terminal_access_stop'
            : 'complete',
        stopReason: lifecycle.terminalStopReason || '',
      },
    });
  } catch (error) {
    appendCollectorWorkflowEvent(db, options, 'collector_cycle_failed', {
      status: 'failed',
      payload: {
        reason: error.message,
        query: options.query,
        startUrl: buildEbaySearchUrl(options.query, options),
      },
      error,
    });
    appendCollectorWorkflowEvent(db, options, 'worker_failed', {
      status: 'failed',
      payload: { reason: error.message },
      error,
    });
    throw error;
  } finally {
    stopScreenshotMonitor();
    appendCollectorWorkflowEvent(db, options, 'browser_context_closing', {
      status: 'closing',
      payload: { reason: lifecycle.shutdownRequested ? 'shutdown' : 'complete' },
    });
    await context.close().catch(() => {});
    appendCollectorWorkflowEvent(db, options, 'browser_context_closed', {
      status: 'closed',
      payload: { reason: lifecycle.shutdownRequested ? 'shutdown' : 'complete' },
    });
    closeMarketplaceHomepageDatabase(db);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.stack ? error.stack : String(error);
    process.stderr.write(`[${new Date().toISOString()}] collect_ebay_search_collector_error ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EBAY_SOURCE,
  buildEbaySearchUrl,
  canonicalizeEbayItemUrl,
  ebayItemIdFromUrl,
  ebayListingId,
  parseArgs,
  shouldRetryEbaySearchViaHomepage,
};
