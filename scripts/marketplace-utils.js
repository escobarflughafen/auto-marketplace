const path = require('path');
const fs = require('fs');

const DEFAULT_GOTO_TIMEOUT_MS = 60000;
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_SETTLE_TIME_MS = 1200;
const DEFAULT_RETRY_DELAY_MS = 750;
const MARKETPLACE_EXPAND_TEXT_PATTERN = /see more|show more|read more|more details|show all|查看更多|显示更多|顯示更多|展开|展開|更多详情|更多詳情|阅读更多|閱讀更多/i;
const RETRYABLE_NAVIGATION_PATTERNS = [
  /interrupted by another navigation/i,
  /net::ERR_ABORTED/i,
  /timeout \d+ms exceeded/i,
  /page was closed/i,
  /Target page, context or browser has been closed/i,
];

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLogLine(prefix, message) {
  return `[${new Date().toISOString()}] ${prefix} ${message}`;
}

function createLogger(prefix, options = {}) {
  const {
    stream = process.stderr,
    enabled = true,
  } = options;

  return (message) => {
    if (!enabled) {
      return;
    }

    stream.write(`${formatLogLine(prefix, message)}\n`);
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferMarketplaceAreaFromLocation(location) {
  const normalized = cleanText(location).replace(/\s*,\s*/g, ', ');
  if (!normalized) {
    return '';
  }

  const primarySegment = normalized.split(',')[0].trim();
  return slugify(primarySegment);
}

function buildMarketplaceLocationPatterns(location) {
  const normalized = cleanText(location).replace(/\s*,\s*/g, ', ');
  if (!normalized) {
    return [];
  }

  const patterns = [
    new RegExp(`^${escapeRegExp(normalized)}$`, 'i'),
    new RegExp(escapeRegExp(normalized), 'i'),
  ];
  const primarySegment = normalized.split(',')[0].trim();
  if (primarySegment && primarySegment.toLowerCase() !== normalized.toLowerCase()) {
    patterns.push(new RegExp(`\\b${escapeRegExp(primarySegment)}\\b`, 'i'));
  }

  return patterns;
}

function normalizeRadiusMiles(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 0;
  }

  return parsed;
}

function buildMarketplaceRadiusPatterns(radiusMiles) {
  const miles = normalizeRadiusMiles(radiusMiles);
  if (miles < 1) {
    return [];
  }

  const kilometers = Math.max(1, Math.round(miles * 1.60934));
  return [
    new RegExp(`^${miles}\\s*(?:mi|mile|miles)$`, 'i'),
    new RegExp(`\\b${miles}\\s*(?:mi|mile|miles)\\b`, 'i'),
    new RegExp(`^${kilometers}\\s*(?:km|kilometer|kilometers)$`, 'i'),
    new RegExp(`\\b${kilometers}\\s*(?:km|kilometer|kilometers)\\b`, 'i'),
  ];
}

function urlMatchesMarketplaceArea(url, area) {
  const normalizedArea = inferMarketplaceAreaFromLocation(area) || slugify(area);
  if (!normalizedArea) {
    return false;
  }

  try {
    const parsed = new URL(String(url || ''));
    const match = parsed.pathname.match(/^\/marketplace\/([^/]+)(?:\/|$)/i);
    if (!match || !match[1]) {
      return false;
    }

    return slugify(match[1]) === normalizedArea;
  } catch (_) {
    return false;
  }
}

async function firstVisibleLocator(locatorFactories, timeout = DEFAULT_READY_TIMEOUT_MS) {
  for (const createLocator of locatorFactories) {
    const locator = createLocator().first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch (_) {
    }
  }

  return null;
}

async function safeGoto(context, page, url) {
  return safeGotoWithOptions(context, page, url);
}

function isRetryableNavigationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_NAVIGATION_PATTERNS.some((pattern) => pattern.test(message));
}

async function waitForAnyVisible(page, selectors, timeoutMs) {
  if (!selectors || selectors.length < 1) {
    return;
  }

  const perSelectorTimeout = Math.max(1000, Math.floor(timeoutMs / selectors.length));
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: 'visible',
        timeout: perSelectorTimeout,
      });
      return;
    } catch (_) {
    }
  }
}

async function waitForPageReady(page, options = {}) {
  const {
    selectors = ['body'],
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
    minBodyTextLength = 0,
  } = options;

  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await waitForAnyVisible(page, selectors, timeoutMs);

  if (minBodyTextLength > 0) {
    await page.waitForFunction(
      (expectedLength) => {
        const text = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
        return text.length >= expectedLength;
      },
      minBodyTextLength,
      { timeout: timeoutMs },
    ).catch(() => {});
  }

  if (settleTimeMs > 0) {
    await page.waitForTimeout(settleTimeMs);
  }

  return page;
}

async function safeGotoWithOptions(context, page, url, options = {}) {
  const {
    attempts = 3,
    waitUntil = 'domcontentloaded',
    timeoutMs = DEFAULT_GOTO_TIMEOUT_MS,
    readySelectors = ['body'],
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
    minBodyTextLength = 0,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  let activePage = page;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!activePage || activePage.isClosed()) {
      activePage = await context.newPage();
    }

    try {
      await activePage.goto(url, {
        waitUntil,
        timeout: timeoutMs,
      });
      await waitForPageReady(activePage, {
        selectors: readySelectors,
        timeoutMs: readyTimeoutMs,
        settleTimeMs,
        minBodyTextLength,
      });
      return activePage;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableNavigationError(error)) {
        throw error;
      }

      activePage = await context.newPage();
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

async function waitForMarketplaceResults(page, options = {}) {
  const {
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
  } = options;

  await waitForPageReady(page, {
    selectors: ['a[href*="/marketplace/item/"]', 'div[role="main"]', 'main', 'body'],
    timeoutMs,
    settleTimeMs,
    minBodyTextLength: 50,
  });

  await page.waitForFunction(
    () => {
      const itemCount = document.querySelectorAll('a[href*="/marketplace/item/"]').length;
      const bodyText = document.body?.innerText || '';
      return itemCount > 0 || /No results|No listings found|We couldn't find anything|Marketplace/i.test(bodyText);
    },
    undefined,
    { timeout: timeoutMs },
  ).catch(() => {});

  return page;
}

async function waitForListingPage(page, options = {}) {
  const {
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
  } = options;

  return waitForPageReady(page, {
    selectors: ['div[role="main"] h1', 'main h1', 'h1', 'body'],
    timeoutMs,
    settleTimeMs,
    minBodyTextLength: 80,
  });
}

async function getMarketplaceResultStats(page) {
  return page.evaluate(() => {
    const hrefs = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
      .map((anchor) => anchor.href)
      .filter(Boolean);

    return {
      itemCount: new Set(hrefs).size,
      scrollHeight: Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
      ),
      scrollTop: window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0,
      viewportHeight: window.innerHeight || 0,
    };
  });
}

async function scrollMarketplaceResults(page, options = {}) {
  const {
    scrolls = 1,
    wheelDelta = 1600,
    timeoutMs = 5000,
    settleTimeMs = 800,
    maxStableIterations = 2,
    logger = null,
  } = options;

  let stats = await getMarketplaceResultStats(page).catch(() => ({
    itemCount: 0,
    scrollHeight: 0,
    scrollTop: 0,
    viewportHeight: 0,
  }));
  let stableIterations = 0;

  if (logger) {
    logger(`results_ready items=${stats.itemCount} scroll_top=${stats.scrollTop} scroll_height=${stats.scrollHeight}`);
  }

  for (let index = 0; index < scrolls; index += 1) {
    await page.mouse.wheel(0, wheelDelta);
    await waitForMarketplaceResults(page, { timeoutMs, settleTimeMs });

    const nextStats = await getMarketplaceResultStats(page).catch(() => stats);
    const progressed = nextStats.itemCount > stats.itemCount
      || nextStats.scrollHeight > stats.scrollHeight
      || nextStats.scrollTop > stats.scrollTop;

    if (logger) {
      logger(
        `scroll_step step=${index + 1}/${scrolls} items=${stats.itemCount}->${nextStats.itemCount} scroll_top=${stats.scrollTop}->${nextStats.scrollTop} scroll_height=${stats.scrollHeight}->${nextStats.scrollHeight}`,
      );
    }

    stableIterations = progressed ? 0 : stableIterations + 1;
    stats = nextStats;

    if (stableIterations >= maxStableIterations) {
      if (logger) {
        logger(`scroll_stop reason=stable_results stable_iterations=${stableIterations}`);
      }
      break;
    }
  }

  return stats;
}

async function setMarketplaceLocation(page, options = {}) {
  const location = cleanText(options.location);
  if (!location) {
    return page;
  }

  const logger = typeof options.logger === 'function' ? options.logger : null;
  const dialogTimeoutMs = Number.isFinite(options.dialogTimeoutMs) ? options.dialogTimeoutMs : 6000;
  const settleTimeMs = Number.isFinite(options.settleTimeMs) ? options.settleTimeMs : 1500;
  const fallbackArea = cleanText(options.fallbackArea);
  const allowMissingControl = Boolean(options.allowMissingControl);

  logger?.(`location_change_start location="${location}"`);

  const locationControl = await firstVisibleLocator([
    () => page.getByRole('button', { name: /location/i }),
    () => page.getByRole('link', { name: /location/i }),
    () => page.locator('[aria-label*="Location" i]'),
    () => page.locator('button,[role="button"],a,[role="link"]').filter({ hasText: /location/i }),
  ], dialogTimeoutMs);

  if (!locationControl) {
    if (allowMissingControl && urlMatchesMarketplaceArea(page.url(), fallbackArea || location)) {
      logger?.(`location_change_skip reason=missing_control area_route_match=true location="${location}" url=${page.url()}`);
      return page;
    }
    throw new Error(`Could not find Marketplace location control for "${location}"`);
  }

  await locationControl.click({ timeout: 5000 });
  await page.waitForTimeout(750);

  const locationInput = await firstVisibleLocator([
    () => page.getByRole('combobox', { name: /location|search/i }),
    () => page.getByRole('textbox', { name: /location|search/i }),
    () => page.locator('input[placeholder*="Search" i]'),
    () => page.locator('input[placeholder*="location" i]'),
    () => page.locator('input[type="text"]'),
  ], dialogTimeoutMs);

  if (!locationInput) {
    throw new Error(`Could not find Marketplace location search input for "${location}"`);
  }

  await locationInput.click({ timeout: 3000 }).catch(() => {});
  await locationInput.fill('', { timeout: 3000 }).catch(() => {});
  await locationInput.fill(location, { timeout: 5000 });
  await page.waitForTimeout(1250);

  let suggestionSelected = false;
  for (const pattern of buildMarketplaceLocationPatterns(location)) {
    const suggestion = await firstVisibleLocator([
      () => page.getByRole('option', { name: pattern }),
      () => page.getByRole('button', { name: pattern }),
      () => page.getByRole('link', { name: pattern }),
      () => page.locator('[role="option"],li,button,[role="button"],a').filter({ hasText: pattern }),
    ], 1500);

    if (!suggestion) {
      continue;
    }

    await suggestion.click({ timeout: 3000 });
    suggestionSelected = true;
    break;
  }

  if (!suggestionSelected) {
    await locationInput.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(250);
    await locationInput.press('Enter').catch(() => {});
  }

  const applyButton = await firstVisibleLocator([
    () => page.getByRole('button', { name: /apply|save|done/i }),
    () => page.locator('button,[role="button"]').filter({ hasText: /apply|save|done/i }),
  ], 2500);

  if (applyButton) {
    await applyButton.click({ timeout: 3000 });
  } else {
    await locationInput.press('Enter').catch(() => {});
  }

  await waitForPageReady(page, {
    selectors: ['div[role="main"]', 'main', 'body'],
    timeoutMs: 10000,
    settleTimeMs,
    minBodyTextLength: 20,
  });
  logger?.(`location_change_done location="${location}" url=${page.url()}`);
  return page;
}

async function setMarketplaceRadius(page, options = {}) {
  const radiusMiles = normalizeRadiusMiles(options.radiusMiles);
  if (radiusMiles < 1) {
    return page;
  }

  const logger = typeof options.logger === 'function' ? options.logger : null;
  const dialogTimeoutMs = Number.isFinite(options.dialogTimeoutMs) ? options.dialogTimeoutMs : 5000;
  const settleTimeMs = Number.isFinite(options.settleTimeMs) ? options.settleTimeMs : 1200;
  const radiusPatterns = buildMarketplaceRadiusPatterns(radiusMiles);

  logger?.(`radius_change_start miles=${radiusMiles}`);

  const radiusControl = await firstVisibleLocator([
    () => page.getByRole('button', { name: /radius|distance/i }),
    () => page.getByRole('combobox', { name: /radius|distance/i }),
    () => page.getByLabel(/radius|distance/i),
    () => page.locator('[aria-label*="Radius" i],[aria-label*="Distance" i]'),
    () => page.locator('button,[role="button"],a,[role="link"]').filter({ hasText: /radius|distance/i }),
  ], dialogTimeoutMs);

  if (!radiusControl) {
    throw new Error(`Could not find Marketplace radius control for ${radiusMiles} mile(s)`);
  }

  await radiusControl.click({ timeout: 4000 });
  await page.waitForTimeout(600);

  for (const pattern of radiusPatterns) {
    const option = await firstVisibleLocator([
      () => page.getByRole('option', { name: pattern }),
      () => page.getByRole('button', { name: pattern }),
      () => page.getByRole('link', { name: pattern }),
      () => page.locator('[role="option"],li,button,[role="button"],a,[role="link"]').filter({ hasText: pattern }),
    ], 1500);

    if (!option) {
      continue;
    }

    await option.click({ timeout: 3000 });

    const applyButton = await firstVisibleLocator([
      () => page.getByRole('button', { name: /apply|save|done/i }),
      () => page.locator('button,[role="button"]').filter({ hasText: /apply|save|done/i }),
    ], 1500);
    if (applyButton) {
      await applyButton.click({ timeout: 3000 });
    }

    await waitForPageReady(page, {
      selectors: ['div[role="main"]', 'main', 'body'],
      timeoutMs: 10000,
      settleTimeMs,
      minBodyTextLength: 20,
    });
    logger?.(`radius_change_done miles=${radiusMiles} url=${page.url()}`);
    return page;
  }

  const radiusInput = await firstVisibleLocator([
    () => page.getByRole('spinbutton', { name: /radius|distance/i }),
    () => page.locator('input[type="number"][aria-label*="Radius" i],input[type="number"][aria-label*="Distance" i]'),
  ], 1500);

  if (radiusInput) {
    await radiusInput.fill(String(radiusMiles), { timeout: 3000 }).catch(() => {});
    const applyButton = await firstVisibleLocator([
      () => page.getByRole('button', { name: /apply|save|done/i }),
      () => page.locator('button,[role="button"]').filter({ hasText: /apply|save|done/i }),
    ], 1500);
    if (applyButton) {
      await applyButton.click({ timeout: 3000 });
    } else {
      await radiusInput.press('Enter').catch(() => {});
    }

    await waitForPageReady(page, {
      selectors: ['div[role="main"]', 'main', 'body'],
      timeoutMs: 10000,
      settleTimeMs,
      minBodyTextLength: 20,
    });
    logger?.(`radius_change_done miles=${radiusMiles} url=${page.url()}`);
    return page;
  }

  throw new Error(`Could not find a Marketplace radius option for ${radiusMiles} mile(s)`);
}

async function expandMarketplaceListingDetails(page, options = {}) {
  const {
    maxPasses = 3,
    settleTimeMs = 500,
    logger = null,
  } = options;

  let totalClicks = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const clickedTexts = await page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, 'i');
      const seen = new Set();
      const clicked = [];
      const nodes = document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]');

      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      for (const element of nodes) {
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || !pattern.test(text)) {
          continue;
        }

        const normalizedText = text.toLowerCase();
        if (seen.has(normalizedText)) {
          continue;
        }

        if (!isVisible(element)) {
          continue;
        }

        if (element.getAttribute('aria-disabled') === 'true' || element.disabled) {
          continue;
        }

        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        element.click();
        clicked.push(text);
        seen.add(normalizedText);

        if (clicked.length >= 8) {
          break;
        }
      }

      return clicked;
    }, MARKETPLACE_EXPAND_TEXT_PATTERN.source).catch(() => []);

    totalClicks += clickedTexts.length;
    if (logger && clickedTexts.length > 0) {
      logger(`listing_expand pass=${pass + 1}/${maxPasses} clicked=${clickedTexts.join(' | ')}`);
    }

    if (clickedTexts.length < 1) {
      break;
    }

    await page.waitForTimeout(settleTimeMs);
  }

  if (logger) {
    logger(`listing_expand_done clicks=${totalClicks}`);
  }

  return totalClicks;
}

async function captureListingThumbnails(page, captureDir, baseName, options = {}) {
  const {
    logger = null,
    minSize = 48,
    maxSize = 240,
    maxThumbnails = 20,
  } = options;

  const thumbnails = [];
  const seenSources = new Set();
  const imageLocator = page.locator('div[role="main"] img, main img, img');
  const imageCount = await imageLocator.count().catch(() => 0);

  for (let index = 0; index < imageCount && thumbnails.length < maxThumbnails; index += 1) {
    const locator = imageLocator.nth(index);
    const metadata = await locator.evaluate((element) => ({
      src: element.currentSrc || element.src || '',
      alt: element.alt || '',
      width: element.clientWidth || 0,
      height: element.clientHeight || 0,
    })).catch(() => null);

    if (!metadata || !metadata.src || seenSources.has(metadata.src)) {
      continue;
    }

    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    if (width < minSize || height < minSize || width > maxSize || height > maxSize) {
      continue;
    }

    const screenshotPath = path.join(
      captureDir,
      `${baseName}-thumb-${String(thumbnails.length + 1).padStart(2, '0')}.png`,
    );

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const screenshotResult = await locator.screenshot({ path: screenshotPath }).catch(() => null);
    if (!screenshotResult) {
      continue;
    }

    const thumbnail = {
      src: metadata.src,
      alt: cleanText(metadata.alt),
      width,
      height,
      screenshotPath,
    };
    thumbnails.push(thumbnail);
    seenSources.add(metadata.src);
  }

  if (logger) {
    logger(`listing_thumbnails count=${thumbnails.length}`);
  }

  return thumbnails;
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function extractTitleFromPageText(pageText) {
  const patterns = [
    /商品交易小组\s+(.+?)\s+CA\$/u,
    /Marketplace\s+(.+?)\s+CA\$/u,
  ];

  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match && match[1]) {
      return cleanText(match[1]);
    }
  }

  return '';
}

async function readListingTitle(page, pageText, fallbackTitle) {
  const candidates = [
    await page.locator('div[role="main"] h1').first().innerText().catch(() => ''),
    await page.locator('main h1').first().innerText().catch(() => ''),
    await page.locator('h1').first().innerText().catch(() => ''),
    extractTitleFromPageText(pageText),
    fallbackTitle,
  ];

  for (const candidate of candidates) {
    const title = cleanText(candidate);
    if (title && !['通知', 'Marketplace'].includes(title)) {
      return title;
    }
  }

  return 'item';
}

function extractByRegex(pageText, patterns) {
  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match && match[1]) {
      return cleanText(match[1]);
    }
  }

  return '';
}

function primaryListingTextForAvailability(pageText) {
  const text = cleanText(pageText || '');
  if (!text) {
    return '';
  }

  const cutoffPatterns = [
    /\s赞助内容\s/u,
    /\s发消息给卖家\s/u,
    /\s发送\s+今日精选\s/u,
    /\s今日精选\s/u,
    /\sSponsored\s/iu,
    /\sMessage seller\s/iu,
    /\sToday's picks\s/iu,
    /\sMore from seller\s/iu,
    /\sRelated listings\s/iu,
  ];

  const cutoff = cutoffPatterns.reduce((earliest, pattern) => {
    const match = pattern.exec(text);
    if (!match || match.index <= 0) {
      return earliest;
    }
    return earliest === -1 ? match.index : Math.min(earliest, match.index);
  }, -1);

  return cutoff === -1 ? text : text.slice(0, cutoff);
}

function extractMarketplaceStatusMarker(pageText) {
  const text = primaryListingTextForAvailability(pageText);
  if (!text) {
    return null;
  }

  const titleStatusPatterns = [
    /(?:^|\s)(?:Marketplace|商品交易小组)\s+(Sold|已售|售出|已卖)\s*·\s+/iu,
    /(?:^|\s)(?:Marketplace|商品交易小组)\s+(Pending|待处理|交易待定|待定)\s*·\s+/iu,
  ];

  for (const pattern of titleStatusPatterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const marker = cleanText(match[1]);
    if (/^(?:Sold|已售|售出|已卖)$/iu.test(marker)) {
      return { status: 'sold', reason: 'sold_marker' };
    }
    if (/^(?:Pending|待处理|交易待定|待定)$/iu.test(marker)) {
      return { status: 'pending_sale', reason: 'pending_marker' };
    }
  }

  if (/(?:^|\s|·)\s*(?:Available|Disponible|有货)\s*·/iu.test(text)) {
    return { status: 'available', reason: 'available_marker' };
  }

  return null;
}

function detectListingUnavailable(pageText) {
  const text = primaryListingTextForAvailability(pageText);
  if (!text) {
    return null;
  }

  const patterns = [
    /无法购买这件商品/u,
    /商品可能已售出或过期/u,
    /看看下面的类似商品/u,
    /(?:this\s+)?(?:content|listing|item)\s+(?:isn't|is\s+not)\s+available/iu,
    /(?:this\s+)?item\s+may\s+have\s+been\s+sold\s+or\s+expired/iu,
    /see\s+similar\s+items\s+below/iu,
    /此内容目前无法查看/u,
    /商品不可用/u,
  ];

  if (patterns.some((pattern) => pattern.test(text))) {
    return {
      unavailable: true,
      reason: 'marketplace_unavailable_banner',
    };
  }

  return null;
}

function detectListingUnavailableUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      /(?:^|\.)facebook\.com$/iu.test(parsed.hostname)
      && parsed.pathname.includes('/marketplace/')
      && parsed.searchParams.get('unavailable_product') === '1'
    ) {
      return {
        unavailable: true,
        reason: 'marketplace_unavailable_redirect',
      };
    }
  } catch {
    if (/[?&]unavailable_product=1(?:&|$)/iu.test(value)) {
      return {
        unavailable: true,
        reason: 'marketplace_unavailable_redirect',
      };
    }
  }

  return null;
}

async function detectListingUnavailablePage(page, pageText = '') {
  const urlSignal = detectListingUnavailableUrl(typeof page?.url === 'function' ? page.url() : '');
  if (urlSignal) {
    return urlSignal;
  }

  if (typeof page?.evaluate === 'function') {
    const domSignal = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const titlePatterns = [
        /无法购买这件商品/u,
        /商品不可用/u,
        /(?:this\s+)?(?:content|listing|item)\s+(?:isn't|is\s+not)\s+available/iu,
        /can't\s+buy\s+this\s+item/iu,
      ];
      const detailPatterns = [
        /商品可能已售出或过期/u,
        /看看下面的类似商品/u,
        /item\s+may\s+have\s+been\s+sold\s+or\s+expired/iu,
        /see\s+similar\s+items\s+below/iu,
      ];
      const recommendationPatterns = [
        /今日精选/u,
        /today'?s\s+picks/iu,
        /赞助内容/u,
        /sponsored/iu,
      ];
      const rectSummary = (rect) => ({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      const className = (element) => {
        const raw = element?.className;
        if (!raw) {
          return '';
        }
        return typeof raw === 'string' ? raw : String(raw.baseVal || '');
      };
      const iconSummary = (element) => {
        const icons = Array.from(element.querySelectorAll('svg,[role="img"],i'));
        for (const icon of icons) {
          const rect = icon.getBoundingClientRect();
          if (rect.width > 0 && rect.width <= 80 && rect.height > 0 && rect.height <= 80) {
            return {
              tagName: icon.tagName.toLowerCase(),
              className: className(icon),
              id: icon.id || '',
              role: icon.getAttribute('role') || '',
              ariaLabel: icon.getAttribute('aria-label') || '',
              style: icon.getAttribute('style') || '',
              rect: rectSummary(rect),
            };
          }
        }
        return null;
      };

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        const text = normalize(walker.currentNode.nodeValue);
        if (titlePatterns.some((pattern) => pattern.test(text))) {
          textNodes.push(walker.currentNode);
        }
      }

      for (const node of textNodes) {
        let element = node.parentElement;
        for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
          const text = normalize(element.innerText || element.textContent);
          const rect = element.getBoundingClientRect();
          if (!text || rect.width < 200 || rect.height < 20 || rect.height > 180) {
            continue;
          }
          if (!titlePatterns.some((pattern) => pattern.test(text))) {
            continue;
          }
          if (recommendationPatterns.some((pattern) => pattern.test(text))) {
            continue;
          }

          const icon = iconSummary(element);
          if (!icon && !detailPatterns.some((pattern) => pattern.test(text))) {
            continue;
          }

          return {
            unavailable: true,
            reason: 'marketplace_unavailable_dom',
            signals: {
              bannerText: text.slice(0, 220),
              tagName: element.tagName.toLowerCase(),
              className: className(element),
              id: element.id || '',
              role: element.getAttribute('role') || '',
              rect: rectSummary(rect),
              icon,
            },
          };
        }
      }

      return null;
    }).catch(() => null);

    if (domSignal?.unavailable) {
      return domSignal;
    }
  }

  return detectListingUnavailable(pageText);
}

function detectListingAvailability(pageText, title = '') {
  void title;
  const marker = extractMarketplaceStatusMarker(pageText);
  if (marker) {
    return marker;
  }

  return {
    status: 'unknown',
    reason: 'no_signal',
  };
}

function extractListingContent(pageText, fallbackTitle = '') {
  const text = cleanText(pageText);
  const rawTitle = extractByRegex(text, [
    /商品交易小组\s+(.+?)\s+CA\$/u,
    /Marketplace\s+(.+?)\s+CA\$/u,
  ]) || fallbackTitle || 'item';
  const title = cleanText(rawTitle.replace(/^(?:Sold|Pending|已售|售出|已卖|待处理|交易待定|待定)\s*·\s*/iu, '')) || rawTitle;

  const price = extractByRegex(text, [
    new RegExp(`${escapeForRegex(title)}\\s+(CA\\$\\s?[\\d,]+(?:\\.\\d{2})?)`, 'u'),
  ]);

  const priceMatches = Array.from(text.matchAll(/CA\$\s?[\d,]+(?:\.\d{2})?/g)).map((match) => cleanText(match[0]));
  const primaryPrice = price || priceMatches[0] || '';
  const previousPrice = priceMatches[1] || '';

  const location = extractByRegex(text, [
    /CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+(?:[^·]+?\s+·\s+)?(?:有货\s+·\s+)?([^·]+?)\s+(?:发消息|公共场所见面|收藏|分享)/u,
    /CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+(?:[^·]+?\s+·\s+)?(?:Available\s+·\s+)?([^·]+?)\s+(?:Message|Meet in a public place|Save|Share)/u,
    /(?:\d+\s*[分钟小时天周月年前]+\s*·\s*)([^·]+?)\s+发消息/u,
    /(?:\d+\s*[minuteshourdayweekmonthsyearsago]+\s*·\s*)([^·]+?)\s+Message/u,
    /查看翻译\s+([^·]+?)\s+·\s+我们只提供大概位置/u,
    /查看翻译\s+([^·]+?)\s+我们只提供大概位置/u,
    /See translation\s+([^·]+?)\s+·\s+Approximate location/u,
    /See translation\s+([^·]+?)\s+Approximate location/u,
  ]);

  const listedAgo = extractByRegex(text, [
    /(?:CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+)([^·]+?)\s+·\s+[^·]+?\s+发消息/u,
    /(?:CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+)([^·]+?)\s+·\s+[^·]+?\s+(?:公共场所见面|收藏|分享)/u,
    /(?:CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+)([^·]+?)\s+·\s+[^·]+?\s+Message/u,
    /(?:CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+)([^·]+?)\s+·\s+[^·]+?\s+(?:Meet in a public place|Save|Share)/u,
  ]);

  const conditionBlock = extractByRegex(text, [
    /商品状况\s+((?:.|\n)+?)\s+查看翻译/u,
    /Condition\s+((?:.|\n)+?)\s+See translation/u,
  ]);
  const parsedCondition = parseConditionBlock(conditionBlock);
  const condition = parsedCondition.condition || extractByRegex(text, [
    /商品状况\s+((?:二手|全新|Used|New)\s*-\s*(?:成色好|如新|一般|Good condition|Like new|Fair condition|Poor condition))/u,
    /Condition\s+((?:Used|New)\s*-\s*(?:Good condition|Like new|Fair condition|Poor condition))/u,
  ]);

  let description = parsedCondition.description || extractByRegex(text, [
    /详细信息\s+.+?\s+((?:.|\n)+?)\s+卖家信息/u,
    /Details\s+.+?\s+((?:.|\n)+?)\s+Seller information/u,
  ]);
  description = cleanDescriptionText(description);

  const sellerName = extractByRegex(text, [
    /卖家详细信息\s+(.+?)\s+\(\d+\)/u,
    /Seller details\s+(.+?)\s+\(\d+\)/u,
  ]);

  const sellerRating = extractByRegex(text, [
    /卖家详细信息\s+.+?\s+\((\d+)\)/u,
    /Seller details\s+.+?\s+\((\d+)\)/u,
  ]);

  const sellerJoined = extractByRegex(text, [
    /加入 Facebook 的时间：(.+?)\s+(?:赞助内容|发消息给卖家)/u,
    /Joined Facebook in (.+?)\s+(?:Sponsored|Message seller)/u,
  ]);
  const availability = detectListingAvailability(text, title);

  return {
    title,
    availabilityStatus: availability.status,
    availabilityReason: availability.reason,
    price: primaryPrice,
    previousPrice,
    listedAgo,
    location,
    condition,
    description,
    sellerName,
    sellerRating,
    sellerJoined,
    rawText: text,
  };
}

function parseConditionBlock(value) {
  const block = cleanText(value || '');
  if (!block) {
    return { condition: '', description: '' };
  }

  const patterns = [
    /^((?:二手|全新)\s*-\s*(?:成色好|如新|一般|成色较差))\s*(.*)$/u,
    /^((?:Used|New)\s*-\s*(?:Good condition|Like new|Fair condition|Poor condition))\s*(.*)$/iu,
  ];

  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match) {
      return {
        condition: cleanText(match[1]),
        description: cleanDescriptionText(match[2] || ''),
      };
    }
  }

  return {
    condition: block,
    description: '',
  };
}

function cleanDescriptionText(value) {
  return cleanText(value || '')
    .replace(/^\s*-\s*/u, '')
    .replace(/^(?:二手|Used)\s*-\s*/u, '')
    .replace(/^(?:成色好|Good condition)\s*/u, '')
    .trim();
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSnapshotMarkdown({
  capturedAt,
  url,
  screenshotPath,
  markdownPath,
  query = '',
  area = '',
  listingContent,
  thumbnails = [],
}) {
  const screenshotName = path.basename(screenshotPath);
  const markdownName = path.basename(markdownPath);
  const excerpt = (listingContent.rawText || '').slice(0, 8000);

  return `# Marketplace Listing Snapshot

- Captured at: ${capturedAt}
${query ? `- Search query: ${query}\n` : ''}${area ? `- Search area: ${area}\n` : ''}- Listing URL: ${url}
- Title: ${listingContent.title || 'Unavailable'}
- Price: ${listingContent.price || 'Unavailable'}
${listingContent.previousPrice ? `- Previous price: ${listingContent.previousPrice}\n` : ''}${listingContent.listedAgo ? `- Listed: ${listingContent.listedAgo}\n` : ''}${listingContent.location ? `- Location: ${listingContent.location}\n` : ''}${listingContent.condition ? `- Condition: ${listingContent.condition}\n` : ''}${listingContent.sellerName ? `- Seller: ${listingContent.sellerName}\n` : ''}${listingContent.sellerRating ? `- Seller rating count: ${listingContent.sellerRating}\n` : ''}${listingContent.sellerJoined ? `- Seller joined: ${listingContent.sellerJoined}\n` : ''}- Screenshot: [${screenshotName}](./${screenshotName})
- Snapshot record: ${markdownName}

## Description

${listingContent.description || 'Unavailable'}

## Screenshot

![Listing screenshot](./${screenshotName})

## Thumbnails

${thumbnails.length > 0
    ? thumbnails.map((thumbnail) => `- [${path.basename(thumbnail.screenshotPath)}](./${path.basename(thumbnail.screenshotPath)})${thumbnail.alt ? ` (${thumbnail.alt})` : ''}\n  Source: ${thumbnail.src}`).join('\n')
    : 'Unavailable'}

## Extracted Content

\`\`\`json
${JSON.stringify({
    title: listingContent.title,
    price: listingContent.price,
    previousPrice: listingContent.previousPrice,
    listedAgo: listingContent.listedAgo,
    location: listingContent.location,
    condition: listingContent.condition,
    description: listingContent.description,
    sellerName: listingContent.sellerName,
    sellerRating: listingContent.sellerRating,
    sellerJoined: listingContent.sellerJoined,
  }, null, 2)}
\`\`\`

## Page Text Snapshot

\`\`\`text
${excerpt}
\`\`\`
`;
}

async function writeListingSnapshot({
  captureDir,
  baseName,
  url,
  screenshotPath,
  query,
  area,
  listingContent,
  thumbnails = [],
}) {
  const markdownPath = path.join(captureDir, `${baseName}.md`);
  const markdown = buildSnapshotMarkdown({
    capturedAt: new Date().toISOString(),
    url,
    screenshotPath,
    markdownPath,
    query,
    area,
    listingContent,
    thumbnails,
  });

  await fs.promises.writeFile(markdownPath, markdown, 'utf8');
  return markdownPath;
}

module.exports = {
  buildMarketplaceLocationPatterns,
  buildMarketplaceRadiusPatterns,
  createLogger,
  ensureDir,
  inferMarketplaceAreaFromLocation,
  normalizeRadiusMiles,
  slugify,
  safeGoto,
  safeGotoWithOptions,
  setMarketplaceLocation,
  setMarketplaceRadius,
  urlMatchesMarketplaceArea,
  waitForPageReady,
  waitForMarketplaceResults,
  waitForListingPage,
  getMarketplaceResultStats,
  scrollMarketplaceResults,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  readListingTitle,
  primaryListingTextForAvailability,
  extractMarketplaceStatusMarker,
  detectListingUnavailable,
  detectListingUnavailableUrl,
  detectListingUnavailablePage,
  detectListingAvailability,
  extractListingContent,
  writeListingSnapshot,
};
