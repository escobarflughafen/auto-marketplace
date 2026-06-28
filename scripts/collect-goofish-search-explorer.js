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

const GOOFISH_SOURCE = 'goofish';
const DEFAULT_SEARCH_URL = 'https://www.goofish.com/search';
const GOOFISH_HOME_URL = 'https://www.goofish.com/';
const GOOFISH_SEARCH_INPUT_SELECTOR = [
  'form input[type="text"]',
  'input[class*="search-input"]',
  'input[placeholder]',
].join(', ');
const GOOFISH_SEARCH_API_PATTERN = /mtop\.taobao\.idlemtopsearch\.pc\.search/i;
const TERMINAL_ACCESS_STOP_REASONS = new Set(['auth_required', 'browser_crashed', 'challenge']);
const log = createLogger('collect-goofish-search-explorer');

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
  return uniqueKeywords(keywords).map((keyword) => ({ keyword, minPrice: null, maxPrice: null }));
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
    userDataDir: path.join(process.cwd(), 'profiles', 'goofish-search-explorer'),
    dbPath: DEFAULT_DB_PATH,
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'goofish-search-explorer.log'),
    snapshotFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'goofish-search-explorer-latest-cycle.json'),
    apiResponseDir: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'goofish-search-api'),
    maxItems: 120,
    maxPages: 1,
    collectAll: true,
    pageDelaySeconds: 8,
    refreshSeconds: 5 * 60,
    refreshJitterMin: 0.5,
    refreshJitterMax: 1.5,
    maxRuntimeSeconds: 180,
    once: false,
    headless: true,
    preferHomepageSearch: true,
    saveApiResponses: false,
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
      case '--api-response-dir':
        options.apiResponseDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--save-api-responses':
        options.saveApiResponses = true;
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
      case '--direct-search':
        options.preferHomepageSearch = false;
        break;
      case '--homepage-search':
        options.preferHomepageSearch = true;
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
    throw new Error('Missing required Goofish search keyword. Pass --query, --queries, or --query-targets JSON.');
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

function goofishItemIdFromUrl(value) {
  const text = String(value || '');
  const match = text.match(/[?&]id=(\d{9,})/i)
    || text.match(/[?&]itemId=(\d{9,})/i)
    || text.match(/[?&]item_id=(\d{9,})/i)
    || text.match(/\/item\/(\d{9,})/i)
    || text.match(/fleamarket:\/\/item\?[^#]*[?&]?id=(\d{9,})/i);
  return match ? match[1] : '';
}

function canonicalizeGoofishItemUrl(value, item = {}) {
  const itemId = String(item.itemId || item.item_id || item.id || goofishItemIdFromUrl(value) || '').trim();
  if (!itemId) return String(value || '').trim();
  const categoryId = String(item.categoryId || item.cCatId || item.catId || extractQueryParam(value, 'categoryId') || extractQueryParam(value, 'catId') || '').trim();
  return `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ''}`;
}

function extractQueryParam(value, name) {
  try {
    return new URL(String(value || ''), GOOFISH_HOME_URL).searchParams.get(name) || '';
  } catch {
    const match = String(value || '').match(new RegExp(`[?&]${name}=([^&#]+)`, 'i'));
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function goofishListingId(itemId, href) {
  const id = String(itemId || goofishItemIdFromUrl(href) || '').trim();
  return id ? `goofish:${id}` : `goofish:${canonicalizeGoofishItemUrl(href)}`;
}

function buildGoofishSearchUrl(query, options = {}) {
  const url = new URL(options.searchUrl || DEFAULT_SEARCH_URL);
  url.searchParams.set('q', query);
  if (options.page && Number(options.page) > 1) {
    url.searchParams.set('page', String(options.page));
  } else {
    url.searchParams.delete('page');
  }
  if (options.minPrice !== null && options.minPrice !== undefined) {
    url.searchParams.set('minPrice', String(options.minPrice));
  }
  if (options.maxPrice !== null && options.maxPrice !== undefined) {
    url.searchParams.set('maxPrice', String(options.maxPrice));
  }
  return url.toString();
}

function detectGoofishChallengeUrl(value) {
  return /_____tmd_____|baxia|mini_login|qrcode|captcha|nocaptcha|passport\.goofish\.com/i.test(String(value || ''));
}

async function readGoofishAccessStatus(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const title = document.title || '';
    const hasItemLink = Boolean(document.querySelector('a[href*="/item"]'));
    const hasLoginInput = Boolean(document.querySelector('input[type="password"], input[name="loginId"], input[name="phone"]'))
      || /立即登录|手机扫码|短信登录|登录后可以更懂你/.test(text);
    const isLoadingOnly = /加载中/.test(text) && !hasItemLink;
    const isErrorPage = /error page|哎哟喂|被挤爆啦|网络繁忙|请稍后重试/i.test(`${title} ${text}`);
    const isChallenge = /captcha|verify.*human|security check|baxia|_____tmd_____|nocaptcha|滑块|安全验证|请完成验证/i.test(`${location.href} ${title} ${text}`);
    return {
      url: location.href,
      title,
      hasLoginInput,
      hasItemLink,
      isLoadingOnly,
      isErrorPage,
      isChallenge,
      textSample: text.slice(0, 240),
    };
  });
}

async function safeReadGoofishAccessStatus(page) {
  try {
    return await readGoofishAccessStatus(page);
  } catch (error) {
    return {
      url: page.url(),
      title: '',
      hasLoginInput: false,
      hasItemLink: false,
      isLoadingOnly: false,
      isErrorPage: false,
      isChallenge: detectGoofishChallengeUrl(page.url()),
      browserCrashed: /target crashed|page crashed/i.test(String(error && error.message ? error.message : error)),
      error: String(error && error.message ? error.message : error),
      textSample: '',
    };
  }
}

function shouldRetryGoofishSearchViaHomepage(accessStatus, pageNumber) {
  return Number(pageNumber) === 1
    && Boolean(accessStatus)
    && !accessStatus.isChallenge
    && !accessStatus.browserCrashed
    && (accessStatus.isErrorPage || accessStatus.isLoadingOnly);
}

function decodeMtopJson(raw) {
  const text = String(raw || '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function collectGoofishTags(fishTags) {
  const tags = [];
  for (const group of Object.values(fishTags || {})) {
    for (const tag of group?.tagList || []) {
      const content = String(tag?.data?.content || '').trim();
      if (!content || /Icon$/i.test(content) || tags.includes(content)) continue;
      tags.push(content);
    }
  }
  return tags;
}

function goofishPriceText(price, fallback) {
  const fallbackText = String(fallback || '').trim();
  if (fallbackText) return fallbackText.startsWith('¥') ? fallbackText : `¥${fallbackText}`;
  if (Array.isArray(price)) {
    const text = price.map((part) => part?.text || '').join('').trim();
    return text && /^\d/.test(text) ? `¥${text}` : text;
  }
  const text = String(price || '').trim();
  return text && /^\d/.test(text) ? `¥${text}` : text;
}

function normalizeGoofishApiCard(card) {
  const main = card?.data?.item?.main || card?.item?.main || card?.main || null;
  if (!main || !main.exContent) return null;
  const ex = main.exContent;
  const detailParams = ex.detailParams || {};
  const args = main.clickParam?.args || {};
  const itemId = String(ex.itemId || detailParams.itemId || args.item_id || args.id || '').trim();
  if (!itemId) return null;

  const tags = collectGoofishTags(ex.fishTags);
  const wants = tags.find((tag) => /人想要/.test(tag)) || (args.wantNum ? `${args.wantNum}人想要` : '');
  const filteredTags = tags.filter((tag) => !/人想要/.test(tag));
  const categoryId = String(args.cCatId || args.catId || detailParams.categoryId || '').trim();
  const title = cleanText(ex.title || detailParams.title || main.title || '');
  const price = goofishPriceText(ex.price, detailParams.soldPrice || args.displayPrice || args.price);
  const seller = cleanText(ex.userNickName || detailParams.userNick || '');
  const area = cleanText(ex.area || args.area || '');
  const publishMs = Number(args.publishTime || 0);
  const textParts = [
    price,
    title,
    area,
    seller,
    wants,
    ...filteredTags,
  ].filter(Boolean);

  const photos = [];
  if (ex.picUrl) {
    photos.push({
      source: 'goofish_search_card',
      sourceUrl: String(ex.picUrl),
      altText: title,
      width: Number(ex.picWidth || detailParams.picWidth || 0) || 0,
      height: Number(ex.picHeight || detailParams.picHeight || 0) || 0,
      position: 0,
      metadata: { itemId },
    });
  }

  return {
    listingId: goofishListingId(itemId),
    itemId,
    href: canonicalizeGoofishItemUrl('', { itemId, categoryId }),
    title,
    text: textParts.join(' | '),
    price,
    location: area,
    area,
    seller,
    wants,
    tags: filteredTags,
    publishTime: publishMs ? new Date(publishMs).toISOString() : '',
    categoryId,
    photos,
    raw: {
      source: 'goofish_search_api',
      targetUrl: main.targetUrl || '',
      clickArgs: args,
    },
  };
}

function extractGoofishApiItems(payload) {
  const resultList = Array.isArray(payload?.data?.resultList) ? payload.data.resultList : [];
  return resultList.map(normalizeGoofishApiCard).filter(Boolean);
}

function createGoofishApiCapture(options) {
  const responses = [];
  let sequence = 0;
  return {
    responses,
    async attach(page) {
      page.on('response', async (response) => {
        const url = response.url();
        if (!GOOFISH_SEARCH_API_PATTERN.test(url)) return;
        const contentType = response.headers()['content-type'] || '';
        if (/image\//i.test(contentType)) return;
        let raw = '';
        try {
          raw = await response.text();
        } catch (error) {
          responses.push({ url, error: String(error && error.message ? error.message : error), items: [] });
          return;
        }
        const payload = decodeMtopJson(raw);
        const ret = Array.isArray(payload?.ret) ? payload.ret.join(';') : '';
        const isChallenge = detectGoofishChallengeUrl(raw) || /RGV587_ERROR|FAIL_SYS_USER_VALIDATE|令牌|安全验证|请完成验证|被挤爆/.test(ret);
        const items = payload ? extractGoofishApiItems(payload) : [];
        sequence += 1;
        if (options.saveApiResponses) {
          await ensureDir(options.apiResponseDir);
          const filePath = path.join(options.apiResponseDir, `response-${Date.now()}-${sequence}.json`);
          await fs.promises.writeFile(filePath, raw, 'utf8').catch(() => null);
        }
        responses.push({ url, ret, isChallenge, items, rawBytes: Buffer.byteLength(raw) });
      });
    },
    drainItems() {
      const items = [];
      let challengeDetected = false;
      for (const response of responses.splice(0)) {
        if (response.isChallenge) challengeDetected = true;
        items.push(...(response.items || []));
      }
      return { items, challengeDetected };
    },
  };
}

async function dismissGoofishLoginModal(page) {
  await page.keyboard.press('Escape').catch(() => null);
  await page.locator('.ant-modal-close, button:has-text("X"), text=X').first().click({ timeout: 2000 }).catch(() => null);
  await page.evaluate(() => {
    document.querySelectorAll('.ant-modal-root, .ant-modal-wrap, .ant-modal-mask').forEach((node) => node.remove());
    if (document.body) document.body.style.overflow = 'auto';
  }).catch(() => null);
}

async function submitGoofishHomepageSearch(page, queryPlan, options, pageNumber) {
  await page.goto(GOOFISH_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
  let accessStatus = await safeReadGoofishAccessStatus(page);
  if (accessStatus.isChallenge || accessStatus.isErrorPage || accessStatus.browserCrashed) {
    return accessStatus;
  }

  await dismissGoofishLoginModal(page);
  await page.waitForSelector(GOOFISH_SEARCH_INPUT_SELECTOR, { timeout: 15000 });
  await page.evaluate((value) => {
    const input = document.querySelector('form input[type="text"], input[class*="search-input"], input[placeholder]');
    if (!input) throw new Error('Goofish search input not found');
    input.scrollIntoView({ block: 'center', inline: 'center' });
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, queryPlan.query);

  const submitted = await page.evaluate(() => {
    const input = document.querySelector('form input[type="text"], input[class*="search-input"], input[placeholder]');
    const form = input?.closest('form');
    const button = form?.querySelector('button[type="submit"], button, [role="button"]')
      || document.querySelector('button[type="submit"], button[class*="search"], [role="button"][class*="search"]');
    if (button) {
      button.click();
      return 'button_click';
    }
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      return 'form_submit';
    }
    return '';
  }).catch(() => '');
  if (!submitted) {
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);

  if (Number(pageNumber) > 1 || queryPlan.minPrice != null || queryPlan.maxPrice != null) {
    const url = new URL(page.url());
    url.searchParams.set('q', queryPlan.query);
    if (Number(pageNumber) > 1) url.searchParams.set('page', String(pageNumber));
    if (queryPlan.minPrice != null) url.searchParams.set('minPrice', String(queryPlan.minPrice));
    if (queryPlan.maxPrice != null) url.searchParams.set('maxPrice', String(queryPlan.maxPrice));
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
  }

  await page.waitForTimeout(Math.max(0, options.pageDelaySeconds) * 1000);
  return safeReadGoofishAccessStatus(page);
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
    log(`goofish_search_workflow_event_append_failed type=${eventType} error=${error.message}`);
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
        source: listing.source || GOOFISH_SOURCE,
        sourceKeyword: listing.source_keyword || '',
        outcome: event.outcome || event.status || '',
        rank: listing.last_seen_rank,
        cardTitle: listing.card_title || '',
        cardText: listing.card_text || '',
      },
    });
  } catch (error) {
    log(`goofish_search_listing_event_append_failed listing_id=${listing.listing_id || ''} error=${error.message}`);
    return null;
  }
}

async function readGoofishDomResultItems(page) {
  return page.evaluate(() => {
    const itemIdFromHref = (href) => {
      const match = String(href || '').match(/[?&]id=(\d{9,})/i)
        || String(href || '').match(/[?&]itemId=(\d{9,})/i)
        || String(href || '').match(/[?&]item_id=(\d{9,})/i);
      return match ? match[1] : '';
    };
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const chooseCardRoot = (anchor) => {
      let node = anchor;
      const candidates = [];
      for (let depth = 0; node && depth < 8; depth += 1) {
        candidates.push(node);
        node = node.parentElement;
      }
      return candidates.find((candidate) => /¥\s*\d/.test(clean(candidate.innerText || candidate.textContent)))
        || anchor.closest('[class*="feeds"], [class*="card"], [class*="item"]')
        || anchor.parentElement;
    };
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/item"], a[href*="item?id="]'))
      .map((anchor) => {
        const href = anchor.href || '';
        const itemId = itemIdFromHref(href);
        if (!itemId || seen.has(itemId)) return null;
        seen.add(itemId);
        const card = chooseCardRoot(anchor);
        const text = clean(card?.innerText || card?.textContent || anchor.textContent || '');
        const price = text.match(/¥\s*[0-9][0-9,.]*/)?.[0] || '';
        const wants = text.match(/[0-9]+人想要/)?.[0] || '';
        const title = clean((anchor.innerText || anchor.textContent || '').trim()) || text.replace(price, '').slice(0, 180).trim();
        const image = card?.querySelector('img');
        return {
          listingId: `goofish:${itemId}`,
          itemId,
          href,
          title,
          text,
          price,
          wants,
          photos: image ? [{
            source: 'goofish_search_dom_card',
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

function addCollectedItems(itemsByListingId, pageItems, options) {
  let added = 0;
  for (const item of pageItems) {
    const href = canonicalizeGoofishItemUrl(item.href, item);
    const listingId = item.listingId || goofishListingId(item.itemId, href);
    if (itemsByListingId.has(listingId)) continue;
    const text = cleanText(item.text || [item.price, item.title, item.location || item.area, item.seller, item.wants, ...(item.tags || [])].filter(Boolean).join(' | '));
    itemsByListingId.set(listingId, {
      ...item,
      source: GOOFISH_SOURCE,
      listingId,
      href,
      title: cleanText(item.title),
      text,
    });
    added += 1;
    if (!options.collectAll && itemsByListingId.size >= options.maxItems) break;
  }
  return added;
}

async function collectGoofishSearchItems(page, queryPlan, options, apiCapture) {
  const startedAt = Date.now();
  const itemsByListingId = new Map();
  const pageSummaries = [];
  let stopReason = 'unknown';
  let challengeDetected = false;

  for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber += 1) {
    if (!options.collectAll && itemsByListingId.size >= options.maxItems) {
      stopReason = 'max_items';
      break;
    }
    if ((Date.now() - startedAt) >= options.maxRuntimeSeconds * 1000) {
      stopReason = 'max_runtime';
      break;
    }

    const url = buildGoofishSearchUrl(queryPlan.query, {
      searchUrl: options.searchUrl,
      page: pageNumber,
      minPrice: queryPlan.minPrice,
      maxPrice: queryPlan.maxPrice,
    });
    let navigationMode = options.preferHomepageSearch && pageNumber === 1 ? 'homepage_search' : 'direct';
    let accessStatus;

    if (navigationMode === 'homepage_search') {
      accessStatus = await submitGoofishHomepageSearch(page, queryPlan, options, pageNumber);
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(Math.max(0, options.pageDelaySeconds) * 1000);
      accessStatus = await safeReadGoofishAccessStatus(page);
    }

    if (shouldRetryGoofishSearchViaHomepage(accessStatus, pageNumber) && navigationMode !== 'homepage_search') {
      await appendLog(options.logFile, `goofish_search_homepage_fallback page=${pageNumber} query="${queryPlan.query}" direct_url=${JSON.stringify(page.url())}`);
      navigationMode = 'homepage_search_fallback';
      accessStatus = await submitGoofishHomepageSearch(page, queryPlan, options, pageNumber);
    }

    await page.mouse.wheel(0, 1600).catch(() => null);
    await page.waitForTimeout(1000);
    await page.mouse.wheel(0, 1600).catch(() => null);
    await page.waitForTimeout(1000);

    const apiDrain = apiCapture.drainItems();
    if (apiDrain.challengeDetected) challengeDetected = true;
    const domItems = await readGoofishDomResultItems(page).catch(() => []);
    const pageItems = [...apiDrain.items, ...domItems];
    const added = addCollectedItems(itemsByListingId, pageItems, options);

    if ((detectGoofishChallengeUrl(page.url()) || accessStatus.isChallenge || challengeDetected) && added === 0) {
      stopReason = 'challenge';
      pageSummaries.push({
        page: pageNumber,
        url: page.url(),
        directUrl: url,
        items: pageItems.length,
        added,
        navigationMode,
        challenge: true,
        accessStatus,
      });
      break;
    }

    if (accessStatus.browserCrashed || (accessStatus.hasLoginInput && added === 0)) {
      stopReason = accessStatus.browserCrashed ? 'browser_crashed' : 'auth_required';
      pageSummaries.push({
        page: pageNumber,
        url: accessStatus.url,
        directUrl: url,
        items: pageItems.length,
        added,
        navigationMode,
        accessStatus,
      });
      break;
    }

    pageSummaries.push({
      page: pageNumber,
      url: page.url(),
      directUrl: url,
      items: pageItems.length,
      apiItems: apiDrain.items.length,
      domItems: domItems.length,
      added,
      navigationMode,
      accessStatus,
    });
    if (pageItems.length === 0) {
      stopReason = accessStatus.isLoadingOnly ? 'loading_without_results' : 'empty_page';
      break;
    }
    if (added === 0) {
      stopReason = 'repeated_page';
      break;
    }
  }

  if (stopReason === 'unknown') {
    stopReason = itemsByListingId.size >= options.maxItems && !options.collectAll ? 'max_items' : 'max_pages';
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
      challengeDetected: stopReason === 'challenge' || challengeDetected,
    },
  };
}

function summarizeUpsertOutcomes(results) {
  return results.reduce((summary, result) => {
    summary[result.outcome] += 1;
    return summary;
  }, { new: 0, existing_same: 0, existing_updated: 0 });
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
  const resolvedPath = path.isAbsolute(snapshotFile) ? snapshotFile : path.join(process.cwd(), snapshotFile);
  await ensureDir(path.dirname(resolvedPath));
  await fs.promises.writeFile(resolvedPath, JSON.stringify(cycleSummary, null, 2), 'utf8');
  return resolvedPath;
}

async function runRound(page, db, options, state, apiCapture) {
  const countsBefore = getHomepageListingCounts(db);
  const queryPlan = chooseQueryTarget(options, state);
  const targetLabel = options.collectAll ? 'all' : String(options.maxItems);
  const startUrl = buildGoofishSearchUrl(queryPlan.query, {
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
      source: GOOFISH_SOURCE,
      maxItems: targetLabel,
      collectAll: options.collectAll,
      dbCountsBefore: countsBefore,
    },
  });
  await appendLog(options.logFile, `goofish_round_start round=${state.roundNumber} query_source=${queryPlan.querySource} query="${queryPlan.query}" min_price=${queryPlan.minPrice ?? ''} max_price=${queryPlan.maxPrice ?? ''} max_pages=${options.maxPages} max_items=${targetLabel} collect_all=${options.collectAll} homepage_search=${options.preferHomepageSearch}`);

  const { items, stats: collectionStats } = await collectGoofishSearchItems(page, queryPlan, options, apiCapture);
  const seenAt = new Date().toISOString();
  const storedResults = items.map((item) => upsertHomepageListingWithStatus(db, item, {
    seenAt,
    source: GOOFISH_SOURCE,
    sourceKeyword: queryPlan.query,
  }));
  for (const result of storedResults) {
    appendCollectorListingEvent(db, options, result.row, { status: result.outcome, outcome: result.outcome });
  }
  scanPurchaseHistoryMatchesForListings(db, storedResults.map((result) => result.row.listing_id), {
    actor: 'goofish-search-explorer',
    matchedAt: seenAt,
  });

  const outcomeCounts = summarizeUpsertOutcomes(storedResults);
  const counts = getHomepageListingCounts(db);
  const cycleSummary = {
    capturedAt: seenAt,
    source: GOOFISH_SOURCE,
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
  await appendLog(options.logFile, `goofish_round_done round=${state.roundNumber} query="${queryPlan.query}" collected=${items.length} stop_reason=${collectionStats.stopReason} pages=${collectionStats.pagesVisited}/${options.maxPages} elapsed_seconds=${collectionStats.elapsedSeconds} new=${outcomeCounts.new} existing_same=${outcomeCounts.existing_same} existing_updated=${outcomeCounts.existing_updated} db_pending=${counts.pending} db_processing=${counts.processing} db_done=${counts.done} db_error=${counts.error} snapshot=${snapshotPath}`);
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
  return { multiplier, refreshMs: Math.max(0, Math.round(baseMs * multiplier)) };
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
  await appendLog(options.logFile, `goofish_search_explorer_start db_path=${options.dbPath} seed_query="${options.query}" seed_queries=${JSON.stringify(options.seedQueries)} max_pages=${options.maxPages} min_price=${options.minPrice ?? ''} max_price=${options.maxPrice ?? ''} refresh_seconds=${options.refreshSeconds} refresh_jitter_min=${options.refreshJitterMin} refresh_jitter_max=${options.refreshJitterMax} max_items=${options.collectAll ? 'all' : options.maxItems} collect_all=${options.collectAll} headless=${options.headless} homepage_search=${options.preferHomepageSearch} worker_id=${options.workerId} worker_screenshot_interval_seconds=${options.workerScreenshotIntervalSeconds} worker_screenshot_history_limit=${options.workerScreenshotHistoryLimit} worker_screenshot_format=${options.workerScreenshotFormat} worker_screenshot_quality=${options.workerScreenshotQuality}`);

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = path.isAbsolute(options.userDataDir) ? options.userDataDir : path.join(process.cwd(), options.userDataDir);
  appendCollectorWorkflowEvent(db, options, 'worker_started', {
    status: 'running',
    payload: {
      mode: options.once ? 'once' : 'continuous',
      source: GOOFISH_SOURCE,
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
    payload: { userDataDir: resolvedUserDataDir, headless: options.headless },
  });

  const context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
    headless: options.headless,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1200 },
  }));
  appendCollectorWorkflowEvent(db, options, 'browser_context_ready', {
    status: 'running',
    payload: { userDataDir: resolvedUserDataDir, headless: options.headless },
  });
  appendCollectorWorkflowEvent(db, options, 'session_ready', {
    status: 'ready',
    payload: { loggedIn: false, currentUrl: DEFAULT_SEARCH_URL },
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
    const apiCapture = createGoofishApiCapture(options);
    await apiCapture.attach(page);
    stopScreenshotMonitor = startWorkerScreenshotMonitor(options, lifecycle, {
      log: (message) => appendLog(options.logFile, message),
    });

    const state = { roundNumber: 1, seedIndex: 0 };
    process.on('SIGTERM', () => {
      lifecycle.shutdownRequested = true;
      appendCollectorWorkflowEvent(db, options, 'shutdown_requested', { status: 'stopping', payload: { signal: 'SIGTERM' } });
    });
    process.on('SIGINT', () => {
      lifecycle.shutdownRequested = true;
      appendCollectorWorkflowEvent(db, options, 'shutdown_requested', { status: 'stopping', payload: { signal: 'SIGINT' } });
    });

    while (!lifecycle.shutdownRequested) {
      lifecycle.screenshotPaused = true;
      const { cycleSummary } = await runRound(page, db, options, state, apiCapture);
      if (options.once || shouldStopWorkerAfterRound(cycleSummary)) {
        const stopReason = cycleSummary?.collectionStats?.stopReason || '';
        const exitMode = options.once ? 'once' : 'terminal_access_stop';
        await appendLog(options.logFile, `goofish_search_explorer_exit mode=${exitMode} stop_reason=${stopReason}`);
        if (!options.once) lifecycle.terminalStopReason = stopReason;
        break;
      }
      lifecycle.screenshotPaused = false;
      const { multiplier, refreshMs } = computeJitteredRefreshMs(options.refreshSeconds, options.refreshJitterMin, options.refreshJitterMax);
      appendCollectorWorkflowEvent(db, options, 'worker_sleeping', {
        status: 'sleeping',
        payload: {
          seconds: Math.ceil(refreshMs / 1000),
          reason: 'refresh_timer',
          jitterMultiplier: Number(multiplier.toFixed(3)),
        },
      });
      await appendLog(options.logFile, `goofish_search_explorer_sleep seconds=${Math.ceil(refreshMs / 1000)} base_refresh_seconds=${options.refreshSeconds} jitter_multiplier=${multiplier.toFixed(3)}`);
      await sleep(refreshMs);
      state.roundNumber += 1;
    }

    appendCollectorWorkflowEvent(db, options, 'worker_completed', {
      status: 'completed',
      payload: {
        reason: lifecycle.shutdownRequested ? 'shutdown_requested' : lifecycle.terminalStopReason ? 'terminal_access_stop' : 'complete',
        stopReason: lifecycle.terminalStopReason || '',
      },
    });
  } catch (error) {
    appendCollectorWorkflowEvent(db, options, 'collector_cycle_failed', {
      status: 'failed',
      payload: { reason: error.message, query: options.query, startUrl: buildGoofishSearchUrl(options.query, options) },
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
    process.stderr.write(`[${new Date().toISOString()}] collect_goofish_search_explorer_error ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  GOOFISH_SOURCE,
  buildGoofishSearchUrl,
  canonicalizeGoofishItemUrl,
  collectGoofishTags,
  decodeMtopJson,
  extractGoofishApiItems,
  goofishItemIdFromUrl,
  goofishListingId,
  normalizeGoofishApiCard,
  parseArgs,
  shouldRetryGoofishSearchViaHomepage,
};
